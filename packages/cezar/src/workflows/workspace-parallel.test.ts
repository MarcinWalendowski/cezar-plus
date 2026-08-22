import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { branchFor } from '../git-worktree.ts';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';
import { localCliAuthor } from '../runs/task-author.ts';

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const SETTLED = ['done', 'failed', 'cancelled', 'review'];
const TEST_TIMEOUT_MS = 30_000;
const HOLD_SAFETY_MS = 20_000;

/**
 * The two scheduling exemptions that make PARALLEL WORKSPACE RUNS possible
 * (`.ai/specs/2026-08-19-parallel-workspace-runs-worktrees.md`, W3 — backfilled here per
 * `.ai/specs/2026-08-20-workspace-run-worktree-isolation.md` Phase 5).
 *
 * That spec shipped with neither seam covered: `nonWorkspaceInPlaceBusy` and `isWorkspaceRun`
 * appeared only in `run.ts`, with no case in `run.test.ts`, `run-lease.test.ts` or
 * `run-isolation.test.ts`. They are the whole guarantee — the owner's boot root
 * (`/var/lib/cezar/workspace`) is a non-git scratch directory, and BOTH gates are anchored on it:
 *
 *  1. `pump()`'s non-git degradation (`repo !== null || busySlots() < 1`) caps a non-git root at
 *     one concurrent run. A workspace run is exempt because it isolates each granted repo in its
 *     own worktree, so the scratch root it shares holds none of its work.
 *  2. The in-place repository-root lease. Same reason, same exemption.
 *
 * Restore either gate for workspace runs and every "Workspace" task serializes again — silently,
 * and with `maxParallel` still reading 10 in Settings. Both cases below use check steps and real
 * git fixtures: no agent process, no mock, and the worktrees genuinely materialize and apply back.
 */

/** POSIX single-quote escaping — a check step is a string handed to `bash -lc`. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** A step that blocks until `gate` appears on disk. A fixed sleep would make every assertion a
 *  bet that the rest of the test got there first (#797); this cannot lose that bet. */
function gatedHold(name: string, gate: string): WorkflowDef {
  const hold = [
    'const fs = require("fs");',
    'const gate = process.argv[1];',
    `const deadline = Date.now() + ${HOLD_SAFETY_MS};`,
    'const poll = () => { if (fs.existsSync(gate) || Date.now() > deadline) return; setTimeout(poll, 10); };',
    'poll();',
  ].join(' ');
  return {
    name,
    source: 'built-in',
    steps: [{ id: 'hold', command: `node -e '${hold}' ${shellQuote(gate)}` }],
  };
}

const INSTANT: WorkflowDef = {
  name: 'instant',
  source: 'built-in',
  steps: [{ id: 'noop', command: 'node -e ""' }],
};

const dirs: string[] = [];
const managers: RunManager[] = [];
const stores: RunStore[] = [];

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function gitRepo(prefix: string): string {
  const root = tempDir(prefix);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'base.txt'), 'base\n');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
  return root;
}

function boot(root: string, maxParallel: number): { store: RunStore; manager: RunManager } {
  const store = RunStore.open(join(root, '.ai/cezar'));
  const manager = new RunManager(store, root, {
    semaphore: new WorkspaceSemaphore({ initial: { maxParallel } }),
  });
  stores.push(store);
  managers.push(manager);
  return { store, manager };
}

/** The grant a workspace run carries — one real git project, so worktrees genuinely materialize. */
const grantOf = (root: string) => [{ id: 'p', name: 'p', root, status: 'ok' as const }];

async function waitFor(predicate: () => boolean, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Demonstrably INSIDE the hold step, so demonstrably holding whatever the step holds. */
function holding(store: RunStore, runId: string): boolean {
  return store.readEvents(runId).some((e) => e.type === 'step-start' && e.stepId === 'hold');
}

afterEach(async () => {
  // Open every gate first: a failed assertion skips the test's own release, and teardown must not
  // sit out HOLD_SAFETY_MS. Then settle everything before the fixtures are deleted underneath it.
  for (const dir of dirs) writeFileSync(join(dir, 'gate'), '');
  for (const store of stores) {
    const manager = managers[stores.indexOf(store)];
    const unsettled = () =>
      store.listRuns().filter((r) => !SETTLED.includes(store.getRun(r.id)?.status ?? ''));
    try {
      await waitFor(() => unsettled().length === 0, 'every run to settle');
    } catch {
      for (const r of unsettled()) manager?.cancel(r.id);
      await waitFor(() => unsettled().length === 0, 'the cancelled leftovers to settle');
    }
  }
  for (const manager of managers.splice(0)) manager.dispose();
  stores.splice(0);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, TEST_TIMEOUT_MS);

describe('workspace runs are exempt from the non-git single-slot cap (W3)', () => {
  it(
    'runs two at once on a NON-GIT boot root, where two ordinary in-place runs serialize',
    async () => {
      const bootRoot = tempDir('cez-ws-nongit-'); // deliberately not a git repo
      const project = gitRepo('cez-ws-project-');
      // maxParallel 4, not 2: the point is the NON-GIT cap, and a workspace-cap of 2 would stop
      // the control runs below for an unrelated reason (both slots spent on the two runs above).
      const { store, manager } = boot(bootRoot, 4);
      const gate = join(bootRoot, 'gate');
      const hold = gatedHold('hold', gate);

      const a = manager.startRun(hold, { author: localCliAuthor(), task: 'ws-a', worktree: false, workspaceProjects: grantOf(project) });
      const b = manager.startRun(hold, { author: localCliAuthor(), task: 'ws-b', worktree: false, workspaceProjects: grantOf(project) });

      // Both inside their hold step at the same instant. Under the un-exempted gate
      // (`repo !== null || busySlots() < 1`) the second would still be `queued` here.
      await waitFor(() => holding(store, a.id) && holding(store, b.id), 'both workspace runs to run');

      // The control, on the same non-git root at the same moment: an ORDINARY in-place run still
      // degrades to one at a time, so this third run cannot start while the other two hold.
      const ordinary = manager.startRun(hold, { author: localCliAuthor(), task: 'plain-1', worktree: false });
      const blocked = manager.startRun(INSTANT, { author: localCliAuthor(), task: 'plain-2', worktree: false });
      await waitFor(() => holding(store, ordinary.id), 'the ordinary in-place run to run');
      expect(store.getRun(blocked.id)?.status).toBe('queued');

      writeFileSync(gate, '');
      await waitFor(
        () => [a.id, b.id].every((id) => SETTLED.includes(store.getRun(id)?.status ?? '')),
        'the workspace runs to finish',
      );
      expect(store.getRun(a.id)?.status).toBe('done');
      expect(store.getRun(b.id)?.status).toBe('done');
      // Applied back and cleaned up: nothing is left pointing at a directory that is gone.
      expect(store.getRun(a.id)?.workspaceWorktrees ?? []).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('workspace runs do not take the repository-root lease (W3)', () => {
  it(
    'overtakes an ordinary in-place run that holds the tree — which still takes the lease itself',
    async () => {
      // A GIT boot root, so the non-git cap above is out of the picture and the lease is the only
      // thing under test.
      const bootRoot = gitRepo('cez-ws-lease-boot-');
      const project = gitRepo('cez-ws-lease-project-');
      const { store, manager } = boot(bootRoot, 2);
      const gate = join(bootRoot, 'gate');

      const holder = manager.startRun(gatedHold('hold', gate), { author: localCliAuthor(), task: 'holder', worktree: false });
      await waitFor(() => holding(store, holder.id), 'the ordinary run to take the lease');

      const workspace = manager.startRun(INSTANT, { author: localCliAuthor(),
        task: 'workspace',
        worktree: false,
        workspaceProjects: grantOf(project),
      });
      await waitFor(
        () => SETTLED.includes(store.getRun(workspace.id)?.status ?? ''),
        'the workspace run to finish',
      );

      // It got all the way through while the tree was still held by someone else.
      expect(store.getRun(workspace.id)?.status).toBe('done');
      expect(store.getRun(holder.id)?.status).toBe('running');
      // And it never even asked: the note is emitted immediately before the lease is awaited.
      const asked = store
        .readEvents(workspace.id)
        .some((e) => e.type === 'note' && String(e.message).includes('exclusive access'));
      expect(asked).toBe(false);

      // The exemption is for WORKSPACE runs only — an ordinary in-place run still queues on the
      // lease, which is what makes the assertion above a fact about the exemption.
      const ordinary = manager.startRun(INSTANT, { author: localCliAuthor(), task: 'ordinary', worktree: false });
      await waitFor(
        () =>
          store
            .readEvents(ordinary.id)
            .some((e) => e.type === 'note' && String(e.message).includes('exclusive access')),
        'the ordinary run to park on the lease',
      );
      expect(store.getRun(holder.id)?.status).toBe('running');

      writeFileSync(gate, '');
      await waitFor(
        () => [holder.id, ordinary.id].every((id) => SETTLED.includes(store.getRun(id)?.status ?? '')),
        'the in-place runs to finish',
      );
      expect(store.getRun(ordinary.id)?.status).toBe('done');
    },
    TEST_TIMEOUT_MS,
  );
});


/**
 * Cleanup on a non-success ending (spec 2026-08-20-workspace-run-worktree-isolation, X3).
 *
 * `applyWorkspaceRun` had exactly one call site — inside `settleSuccess` — so a workspace run that
 * ended `failed`, `cancelled` or stopped never applied back AND never removed anything. Twelve full
 * checkouts, per run, forever. Apply-on-success-only is still the rule (W7); leak-on-everything-
 * else was not.
 */
describe('a workspace run that does not succeed discards its worktrees and keeps its branches', () => {
  const FAILS: WorkflowDef = {
    name: 'fails',
    source: 'built-in',
    steps: [{ id: 'boom', command: 'node -e "process.exit(1)"' }],
  };

  it(
    'removes the directory, keeps cez/<id8>, and leaves no leftover entry on the record',
    async () => {
      const bootRoot = tempDir('cez-ws-discard-boot-');
      const project = gitRepo('cez-ws-discard-project-');
      const { store, manager } = boot(bootRoot, 2);

      const run = manager.startRun(FAILS, { author: localCliAuthor(),
        task: 'doomed',
        worktree: false,
        workspaceProjects: grantOf(project),
      });
      await waitFor(
        () => SETTLED.includes(store.getRun(run.id)?.status ?? ''),
        'the failing workspace run to settle',
      );
      expect(store.getRun(run.id)?.status).toBe('failed');
      // The status lands in the terminal block and the discard runs immediately after it, so
      // "settled" is not yet "cleaned up". Wait for the record to lose its entries — and swallow
      // the timeout, so a regression fails on the assertions below with a readable diff rather
      // than on a bare `timed out`.
      await waitFor(
        () => (store.getRun(run.id)?.workspaceWorktrees?.length ?? 0) === 0,
        'the discard to clear the record',
        10_000,
      ).catch(() => undefined);

      // The directory is gone — the gigabytes this fixes...
      expect(existsSync(join(project, '.ai/cezar/worktrees', run.id))).toBe(false);
      // ...and the branch is still there, which is what makes discarding safe.
      const branches = execFileSync('git', ['branch', '--list', branchFor(run.id)], {
        cwd: project,
        encoding: 'utf8',
      });
      expect(branches).toContain(branchFor(run.id));
      // No leftover entry pointing at a path that no longer exists — the shape three finished runs
      // (`ec6e8e06`, `be31d9e9`, `ef9901e3`) were measured carrying on 2026-08-20.
      expect(store.getRun(run.id)?.workspaceWorktrees ?? []).toEqual([]);
      // And nothing was applied into the real checkout: the run did not succeed.
      expect(
        execFileSync('git', ['status', '--porcelain'], { cwd: project, encoding: 'utf8' }).trim(),
      ).toBe('');
    },
    TEST_TIMEOUT_MS,
  );
});
