import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { localCliAuthor } from '../runs/task-author.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { ensureBootRepo } from '../workspace/boot-repo.ts';
import { buildWorkspaceGrant, type WorkspaceGrant } from '../workspace/granted-roots.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

/**
 * V3 of `.ai/specs/2026-08-21-workspace-boot-repo-and-always-worktrees.md` — the `execute()` seam,
 * covered the way `run-isolation.test.ts` and `workspace-parallel.test.ts` already cover theirs:
 * real git fixtures, real check steps, no mocked worktree layer.
 *
 * The defect these guard is invisible to every other test in the suite, because it is not about
 * what the branches DO — each one is correct where it was written — but about which branch a run
 * homed at the boot scratch root falls into. Measured on the box on 2026-08-21: one such run held
 * the exclusive working-tree lease for 85 minutes while `maxParallel` read 5.
 *
 * The last case is the control. `not a git repository — running in place, one task at a time` and
 * the lease behind it are RIGHT for a genuinely non-git project, and must keep working there.
 */

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const SETTLED = ['done', 'failed', 'cancelled', 'review'];

const dirs: string[] = [];
const managers: RunManager[] = [];

const INSTANT: WorkflowDef = {
  name: 'instant',
  source: 'built-in',
  steps: [{ id: 'noop', command: 'node -e ""' }],
};

/** POSIX single-quote escaping — a check step is a string handed to `bash -lc`. */
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * A step that blocks until `gate` appears on disk, so the test can read the record while the run
 * is genuinely mid-flight. Needed because `workspaceWorktrees` is CLEARED when a workspace run
 * settles — the applied worktrees are removed — so a post-settle assertion could never see it.
 */
function gatedHold(gate: string): WorkflowDef {
  const hold = [
    'const fs = require("fs");',
    'const gate = process.argv[1];',
    'const deadline = Date.now() + 20000;',
    'const poll = () => { if (fs.existsSync(gate) || Date.now() > deadline) return; setTimeout(poll, 10); };',
    'poll();',
  ].join(' ');
  return {
    name: 'hold',
    source: 'built-in',
    steps: [{ id: 'hold', command: `node -e '${hold}' ${shellQuote(gate)}` }],
  };
}

async function waitFor(predicate: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/** The boot root as the box has it: cezar runtime state and nothing else, then made a repo. */
async function bootScratchRoot(): Promise<string> {
  const root = tempDir('cez-boot-scratch-');
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  const outcome = await ensureBootRepo(root);
  if ('error' in outcome) throw new Error(outcome.error);
  return root;
}

function gitProject(prefix: string): string {
  const root = tempDir(prefix);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'base.txt'), 'base\n');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
  return root;
}

function boot(
  root: string,
  options: { bootScratchRoot?: boolean; grant?: WorkspaceGrant } = {},
): { store: RunStore; manager: RunManager } {
  const store = RunStore.open(join(root, '.ai/cezar'));
  const manager = new RunManager(store, root, {
    semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 4 } }),
    ...(options.bootScratchRoot === undefined ? {} : { bootScratchRoot: options.bootScratchRoot }),
    // Never the real registry: a unit test must not read the developer's own workspace.
    loadGrant: () => Promise.resolve(options.grant ?? buildWorkspaceGrant([])),
  });
  managers.push(manager);
  return { store, manager };
}

async function settle(store: RunStore, ids: string[]): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (ids.every((id) => SETTLED.includes(store.getRun(id)?.status ?? ''))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`runs did not settle: ${ids.map((id) => `${id}=${store.getRun(id)?.status}`).join(', ')}`);
}

const notes = (store: RunStore, id: string): string[] =>
  store.readEvents(id).filter((e) => e.type === 'note').map((e) => String(e.message));

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('a run homed at the workspace boot root never runs in place', () => {
  it('overrides worktree:false and isolates instead of taking the lease (change B)', async () => {
    const root = await bootScratchRoot();
    const { store, manager } = boot(root, { bootScratchRoot: true });

    const run = manager.startRun(INSTANT, { author: localCliAuthor(), task: 'opted out', worktree: false });
    await settle(store, [run.id]);

    const record = store.getRun(run.id);
    expect(record?.status).toBe('done');
    expect(record?.worktreePath).toBeTruthy();
    expect(record?.worktreePath).toContain('.ai/cezar/worktrees/');
    // Cleared, or the session Git view would read the boot root while the agent worked elsewhere.
    expect(record?.worktree).toBeUndefined();
    expect(notes(store, run.id).some((m) => m.includes('worktree forced on'))).toBe(true);
    expect(notes(store, run.id).some((m) => m.includes('exclusive access'))).toBe(false);
    expect(notes(store, run.id).some((m) => m.includes('not a git repository'))).toBe(false);
  });

  it('adopts the workspace grant when the submitting route forgot one (change C)', async () => {
    const root = await bootScratchRoot();
    const project = gitProject('cez-boot-project-');
    const grant = buildWorkspaceGrant([{ id: 'p', name: 'p', root: project, status: 'ok' }]);
    const { store, manager } = boot(root, { bootScratchRoot: true, grant });
    const gate = join(root, 'gate');

    // No `workspaceProjects` — the shape nine of the ten `startRun` call sites produce.
    const run = manager.startRun(gatedHold(gate), { author: localCliAuthor(), task: 'ungranted' });
    try {
      // CHANGED 2026-08-25 (`.ai/specs/2026-08-25-workspace-scope-routes-tasks.md`, Phase 1): this
      // waited on `workspaceWorktrees` filling and asserted `project worktree(s) isolated`. The
      // adoption is unchanged — what it produces is not. A workspace run materializes nothing now,
      // so the observable the adoption lands on is the ROUTING note plus the grant on the record.
      await waitFor(
        () =>
          notes(store, run.id).some((m) => m.includes('reading every project, editing none')),
        'the adopted grant to put the run on the routing path',
      );
      const midflight = store.getRun(run.id);
      expect(midflight?.workspaceProjects?.map((p) => p.root)).toEqual([project]);
      expect(notes(store, run.id).some((m) => m.includes('adopted the workspace'))).toBe(true);
      expect(notes(store, run.id).some((m) => m.includes('exclusive access'))).toBe(false);
      // Nothing was cut in the project — neither on the record nor on disk. Asserting both, because
      // the record alone would stay empty for a materialize that ran and failed to persist.
      expect(midflight?.workspaceWorktrees ?? []).toEqual([]);
      expect(existsSync(join(project, '.ai/cezar/worktrees'))).toBe(false);
    } finally {
      writeFileSync(gate, '');
    }
    await settle(store, [run.id]);
    expect(store.getRun(run.id)?.status).toBe('done');
    // The grant survives on the record, which is what makes the run render as the workspace run
    // it behaved as (`workspace/run-index.ts` derives `workspace: true` from exactly this).
    expect(store.getRun(run.id)?.workspaceProjects?.length).toBe(1);
  });

  it('does NOT adopt the grant for a group variant (R4)', async () => {
    const root = await bootScratchRoot();
    const project = gitProject('cez-boot-variant-');
    const grant = buildWorkspaceGrant([{ id: 'p', name: 'p', root: project, status: 'ok' }]);
    const { store, manager } = boot(root, { bootScratchRoot: true, grant });

    const run = manager.startRun(INSTANT, { author: localCliAuthor(), task: 'variant' }, { groupId: 'g1', variant: 'A' });
    await settle(store, [run.id]);

    const record = store.getRun(run.id);
    // `startRun` drops the grant for variants on purpose — they exist to isolate. The variant
    // still isolates, in the BOOT repo's own worktree, which is the intended reading.
    expect(record?.workspaceProjects).toBeUndefined();
    expect(record?.workspaceWorktrees ?? []).toEqual([]);
    expect(record?.worktreePath).toBeTruthy();
    expect(notes(store, run.id).some((m) => m.includes('exclusive access'))).toBe(false);
  });

  it('leaves a genuinely non-git project on the in-place path it was written for', async () => {
    const root = tempDir('cez-nongit-project-'); // a project, not the boot root
    const { store, manager } = boot(root, { bootScratchRoot: false });

    const run = manager.startRun(INSTANT, { author: localCliAuthor(), task: 'in place' });
    await settle(store, [run.id]);

    expect(store.getRun(run.id)?.status).toBe('done');
    expect(notes(store, run.id).some((m) => m.includes('not a git repository — running in place, one task at a time'))).toBe(true);
    expect(notes(store, run.id).some((m) => m.includes('exclusive access'))).toBe(true);
    expect(store.getRun(run.id)?.workspaceProjects).toBeUndefined();
  });

  it('leaves worktree:false alone in a real repository that is not the boot root', async () => {
    const root = gitProject('cez-real-repo-');
    const { store, manager } = boot(root, { bootScratchRoot: false });

    const run = manager.startRun(INSTANT, { author: localCliAuthor(), task: 'opted out for real', worktree: false });
    await settle(store, [run.id]);

    expect(store.getRun(run.id)?.worktree).toBe(false);
    expect(store.getRun(run.id)?.worktreePath).toBeUndefined();
    expect(notes(store, run.id).some((m) => m.includes('worktree off'))).toBe(true);
    expect(notes(store, run.id).some((m) => m.includes('worktree forced on'))).toBe(false);
  });
});
