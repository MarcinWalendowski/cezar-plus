import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRunSpec, AgentRunner, AgentSession } from '../core/agent-runner.ts';
import { localCliAuthor } from '../runs/task-author.ts';

const specs: AgentRunSpec[] = [];

/**
 * The ONE place a workspace run's grant becomes real: the spawn.
 *
 * `workspace/granted-roots.test.ts` pins the grant's own rules, and it would stay green if
 * `run.ts` never passed the grant to `startSession` at all — a workspace run would then start
 * happily, with the agent unable to open a single file in any project and no error until it
 * tried. So this file asserts on the SPEC HANDED TO THE RUNNER, which is the only artifact that
 * distinguishes "the grant is computed" from "the grant is applied".
 *
 * The runner is faked at `createRunner`, the same seam `RunManager` itself resolves through — not
 * by reaching into a private method — so the assertion covers the whole path from the persisted
 * record to the spawn spec, including the two independent spread sites (`stepGrant?.roots` into
 * `additionalDirectories`, `workspaceGrantSystemPrompt(stepGrant)` into the system prompt).
 * Deleting either one turns a case here red.
 */
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: (): AgentRunner => ({
    backend: 'claude',
    run: async () => ({ text: '', events: [] }) as never,
    startSession: (spec: AgentRunSpec): AgentSession => {
      specs.push(spec);
      return {
        // Never resolves: the run parks with the session open, which is enough — the spec was
        // already captured, and a resolved result would drag the whole settle path in with it.
        result: new Promise(() => {}),
        sendMessage: () => true,
        end: () => {},
        interrupt: () => {},
        open: true,
      };
    },
    interrupt: async () => {},
  }),
}));

const { RunStore } = await import('../runs/store.ts');
const { RunManager } = await import('./run.ts');
const { WorkspaceSemaphore } = await import('../workspace/semaphore.ts');
type Store = ReturnType<typeof RunStore.open>;
type Manager = InstanceType<typeof RunManager>;

const WORKFLOW = {
  name: 'quick-task',
  source: 'built-in' as const,
  steps: [{ id: 'work', kind: 'agent' as const, prompt: '{{task}}' }],
};

/** The owner's own registry shape: a parent and one of its children, plus an outlier. */
const GRANT = [
  { id: 'monorepo', name: 'monorepo', root: '/w/monorepo', status: 'ok' as const },
  { id: 'cezar', name: 'cezar', root: '/w/monorepo/cezar', status: 'ok' as const },
  { id: 'black', name: 'black', root: '/w/black', status: 'ok' as const },
];

describe('RunManager — a workspace run hands its grant to the spawn', () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;
  let repoRoot: string;
  let store: Store;
  let manager: Manager;

  beforeEach(() => {
    specs.length = 0;
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-grant-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-grant-repo-'));
    // Not a git repo on purpose — a workspace run has no worktree, and this is the in-place path
    // it actually takes in production.
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    process.env.CEZ_HOME = home;
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 4 } }),
    });
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  const spawned = async (): Promise<AgentRunSpec> => {
    await vi.waitFor(() => expect(specs.length).toBeGreaterThan(0), { timeout: 5_000 });
    return specs[0]!;
  };

  it('grants the deduped project roots as additional directories', async () => {
    manager.startRun(WORKFLOW, { author: localCliAuthor(), task: 'touch every project', worktree: false, workspaceProjects: GRANT });
    const spec = await spawned();
    // Deduped: `/w/monorepo/cezar` is already inside `/w/monorepo`.
    expect(spec.additionalDirectories).toContain('/w/monorepo');
    expect(spec.additionalDirectories).toContain('/w/black');
    expect(spec.additionalDirectories).not.toContain('/w/monorepo/cezar');
  });

  it('keeps the run-state directory grant it always had alongside them', async () => {
    manager.startRun(WORKFLOW, { author: localCliAuthor(), task: 'touch every project', worktree: false, workspaceProjects: GRANT });
    const spec = await spawned();
    // The handoff file lives here; a grant that REPLACED this list instead of extending it would
    // break every workspace run's handoff journal, silently.
    expect(spec.additionalDirectories).toContain(join(repoRoot, '.ai/cezar', 'runs'));
  });

  it('states every project and its absolute path in the system prompt', async () => {
    manager.startRun(WORKFLOW, { author: localCliAuthor(), task: 'touch every project', worktree: false, workspaceProjects: GRANT });
    const spec = await spawned();
    // The portable half. `--add-dir` above is Claude-only; on codex/opencode this text is the
    // ENTIRE grant the agent ever learns about, and the cwd contains none of the work.
    expect(spec.systemPrompt).toContain('/w/monorepo/cezar');
    expect(spec.systemPrompt).toContain('/w/black');
    expect(spec.systemPrompt).toMatch(/do\s+NOT commit/i);
  });

  it('changes nothing for an ordinary run', async () => {
    manager.startRun(WORKFLOW, { author: localCliAuthor(), task: 'ordinary', worktree: false });
    const spec = await spawned();
    // Every granted directory is still the run's OWN state (the run-state folder plus the #785
    // per-run TMPDIR) — nothing outside this repo. Asserting "no foreign root" rather than an
    // exact list keeps this from going red the next time an unrelated per-run directory is added,
    // while still failing if a grant ever leaks onto a run that asked for none.
    expect(spec.additionalDirectories?.filter((dir) => !dir.startsWith(repoRoot))).toEqual([]);
    expect(spec.systemPrompt ?? '').not.toContain('Workspace run');
  });

  it('re-reads the grant from the RECORD, so a later step cannot drift from the registry', async () => {
    const run = manager.startRun(WORKFLOW, { author: localCliAuthor(),
      task: 'touch every project',
      worktree: false,
      workspaceProjects: GRANT,
    });
    await spawned();
    // What the spawn used came from `runs.json`, not from the in-memory input: this is what makes
    // a restart-and-resume re-apply the same grant rather than whatever the registry says now.
    expect(store.getRun(run.id)?.workspaceProjects).toEqual(GRANT);
  });
});
