import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from './runs/store.ts';
import { RunManager } from './workflows/run.ts';
import { appendReopenRequests, readReopenRequests } from './reopen-requests.ts';
import { reconcileReopenRequests } from './reopen-watch.ts';
import { localCliAuthor } from './runs/task-author.ts';

const git = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * The reopen inbox against the REAL engine, not a capturing stub
 * (`.ai/specs/2026-08-20-reopen-finished-tasks-merge-audit.md` § Verification, "Integration").
 *
 * What a stub cannot prove is that `continueRun`'s own preconditions are the ones this feature
 * relies on: that a finished run carrying a `sessionId` really does leave `done` for `queued`,
 * really does get a `continue-1` step appended, and that a run WITHOUT a session is refused with
 * the exact string that ends up stamped into the request row. `CEZ_DRY_RUN=1` keeps the deferred
 * continuation from ever spawning an agent — the same guard `continue-run.test.ts` uses.
 */
describe('a reopen request continues a real finished run', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  /** A settled run that carries a resumable agent session — `continueRun`'s hard precondition. */
  const seedDoneRun = (opts: { withSession: boolean }): string => {
    const run = store.createRun({ author: localCliAuthor(), title: 'ship it', workflow: 'quick-task', task: 'ship it', steps: [] });
    store.addStep(run.id, { id: 'work', name: 'Work', kind: 'agent' });
    store.updateStep(run.id, 'work', {
      status: 'done',
      ...(opts.withSession ? { sessionId: 'sess-abc', backend: 'claude' as const } : {}),
    });
    store.updateRun(run.id, { status: 'done', finishedAt: new Date().toISOString() });
    return run.id;
  };

  beforeEach(async () => {
    process.env.CEZ_DRY_RUN = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-reopen-int-'));
    dataDir = join(repoRoot, '.ai/cezar');
    await git('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await git('git', ['add', '-A'], { cwd: repoRoot });
    await git('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(dataDir);
    manager = new RunManager(store, repoRoot);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    vi.restoreAllMocks();
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('takes the run out of done into queued, appends continue-1, and stamps startedAt', async () => {
    const runId = seedDoneRun({ withSession: true });
    await appendReopenRequests(dataDir, [
      { runId, prompt: 'analyze if changes from this task were merged into main', source: 'cli' },
    ]);

    await reconcileReopenRequests({ dataDir, manager: manager! });

    const record = store.getRun(runId);
    expect(record?.status).toBe('queued');
    expect(record?.finishedAt).toBeUndefined();
    expect(record?.steps.map((s) => s.id)).toContain('continue-1');

    const [request] = await readReopenRequests(dataDir);
    expect(request?.startedAt).toBeTruthy();
    expect(request?.error).toBeUndefined();
  });

  it('a run with no agent session is refused, and the reason is stamped into the row', async () => {
    const runId = seedDoneRun({ withSession: false });
    await appendReopenRequests(dataDir, [{ runId }]);

    await reconcileReopenRequests({ dataDir, manager: manager! });

    expect(store.getRun(runId)?.status).toBe('done'); // untouched
    const [request] = await readReopenRequests(dataDir);
    expect(request?.error).toBe('no agent session to resume');
    expect(request?.startedAt).toBeUndefined();
  });

  it('a request naming a run this project does not have is stamped `not found`, not thrown', async () => {
    await appendReopenRequests(dataDir, [{ runId: 'belongs-to-another-project' }]);
    await reconcileReopenRequests({ dataDir, manager: manager! });
    expect((await readReopenRequests(dataDir))[0]?.error).toBe('not found');
  });

  it('a second reconcile after the run is queued does not continue it again', async () => {
    const runId = seedDoneRun({ withSession: true });
    await appendReopenRequests(dataDir, [{ runId }]);
    await reconcileReopenRequests({ dataDir, manager: manager! });
    await reconcileReopenRequests({ dataDir, manager: manager! });

    const steps = store.getRun(runId)?.steps.filter((s) => s.id.startsWith('continue-')) ?? [];
    expect(steps).toHaveLength(1);
  });
});
