import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRunSpec, AgentRunner, AgentSession } from '../core/agent-runner.ts';
import { localCliAuthor } from '../runs/task-author.ts';

const specs: AgentRunSpec[] = [];

/**
 * `{{autoStart}}` reaching the agent (`.ai/specs/2026-08-25-workspace-scope-routes-tasks.md`, V5).
 *
 * `input-to-tasks`'s third step is optional, and the ONLY thing that makes it optional is a token
 * in its prompt. Nothing else gates it: the step always runs, reads whether the user ticked the
 * box, and does nothing when they did not. So a substitution that silently failed would render the
 * literal `{{autoStart}}`, the agent would guess, and "optional" would mean "sometimes". That is a
 * failure with no error and no red test anywhere else — `load.test.ts` proves the token is IN the
 * prompt, which stays true whether or not anything ever replaces it.
 *
 * Asserted at the spawn spec, the same seam and the same faked `createRunner` as
 * `workspace-grant-wiring.test.ts`, so it covers the whole path from the persisted record to the
 * process: the flag is read from `runs.json`, not from the in-memory input, precisely so a restart
 * and resume answer the same way.
 */
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: (): AgentRunner => ({
    backend: 'claude',
    run: async () => ({ text: '', events: [] }) as never,
    startSession: (spec: AgentRunSpec): AgentSession => {
      specs.push(spec);
      return {
        // Never resolves: the spec is already captured and the run parks with the session open.
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

/** Both tokens in one prompt: `{{task}}` already worked, and it is the control — if the whole
 *  substitution pass were skipped, BOTH would render literally and this fixture would say so. */
const WORKFLOW = {
  name: 'dispatch-probe',
  source: 'built-in' as const,
  steps: [
    { id: 'work', kind: 'agent' as const, prompt: 'task=[{{task}}] autoStart=[{{autoStart}}]' },
  ],
};

const GRANT = [{ id: 'chat', name: 'chat', root: '/w/chat', status: 'ok' as const }];

describe('RunManager renders {{autoStart}} from the RECORD', () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;
  let repoRoot: string;
  let store: Store;
  let manager: Manager;

  beforeEach(() => {
    specs.length = 0;
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-autostart-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-autostart-repo-'));
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

  it('renders "true" when the composer ticked the box', async () => {
    const run = manager.startRun(WORKFLOW, {
      author: localCliAuthor(),
      task: 'sweep the boards',
      worktree: false,
      workspaceProjects: GRANT,
      autoStart: true,
    });
    const spec = await spawned();
    expect(spec.userPrompt).toBe('task=[sweep the boards] autoStart=[true]');
    // What it rendered FROM: the record, which is what makes a resume answer identically.
    expect(store.getRun(run.id)?.autoStart).toBe(true);
  });

  it('renders "false" when it did not — never the literal token', async () => {
    // The off direction, without which a step that always fires reads exactly like a correct one.
    manager.startRun(WORKFLOW, {
      author: localCliAuthor(),
      task: 'sweep the boards',
      worktree: false,
      workspaceProjects: GRANT,
      autoStart: false,
    });
    const spec = await spawned();
    expect(spec.userPrompt).toBe('task=[sweep the boards] autoStart=[false]');
    expect(spec.userPrompt).not.toContain('{{');
  });

  it('renders "false" for a run that never mentioned autoStart at all', async () => {
    // The shape every pre-existing caller produces (`cezar run`, automations, notes continuations,
    // a reopen). Absent must read as off, not as undefined leaking into the prompt.
    manager.startRun(WORKFLOW, {
      author: localCliAuthor(),
      task: 'sweep the boards',
      worktree: false,
      workspaceProjects: GRANT,
    });
    const spec = await spawned();
    expect(spec.userPrompt).toBe('task=[sweep the boards] autoStart=[false]');
  });
});
