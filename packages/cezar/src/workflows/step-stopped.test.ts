import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * What happens to a CHAIN when cezar stops one of its steps.
 *
 * The incident this regression-tests: on run `9d09795a` the `implement` step was stopped by the
 * runner's own bound with its code written, its gates green and its commit already made. Three
 * separate things then went wrong, and each is an assertion below:
 *   1. the step was recorded `failed`, indistinguishable from a real agent failure — the owner had
 *      to hand-annotate the handoff to say it was not one;
 *   2. the whole RUN was marked `failed`;
 *   3. the four remaining chain steps were abandoned, and the run degraded into `continue-N` chat.
 *
 * `.ai/specs/2026-08-20-agent-step-inactivity-timeout.md` fixed the CAUSE (a step is no longer
 * stopped for working hard). This suite covers the CONSEQUENCE, which that spec left untouched: a
 * stop that is genuinely warranted must still not read as a failure or destroy the chain.
 *
 * Driven end-to-end through the real engine under `CEZ_DRY_RUN=1` with a mock agent that HANGS,
 * rather than a stubbed runner: the defect lives in the seam between the runner's error event and
 * the step loop, so a stub on either side of that seam would not have caught it.
 */
describe('a step cezar stopped is not a step that failed', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  /**
   * NOTE on fixture shape: the workflow's LAST agent step is interactive and is spawned with
   * `timeoutMs: 0`, so it carries no inactivity bound at all — a deliberate part of the shipped
   * design (an interactive session is governed by `IDLE_TIMEOUT_MS` between turns instead). Every
   * fixture below therefore puts the hanging step somewhere OTHER than last, and gives the
   * trailing step a prompt that does not hang. A fixture that ignores this does not test the stop
   * path, it just waits forever.
   */
  const chain = (steps: Array<{ id: string; prompt?: string }>): WorkflowDef => ({
    name: 'spec-to-deploy',
    source: 'built-in',
    steps: steps.map((s) => ({ id: s.id, name: s.id, prompt: s.prompt ?? '{{task}}' })),
  });

  /** The runners read their default bound from `CEZ_RUN_IDLE_TIMEOUT_MS` at construction, so the
   *  suite tightens it there. 1.5s is long enough that a healthy mock turn (~250ms) is never
   *  mistaken for silence, short enough to keep the suite quick. */
  const STOP_MS = 1_500;

  const settled = async (runId: string, ms = 45_000) => {
    const terminal = new Set(['done', 'review', 'failed', 'cancelled', 'waiting']);
    const deadline = Date.now() + ms;
    while (!terminal.has(store.getRun(runId)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error(`run did not settle: ${store.getRun(runId)?.status}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    return store.getRun(runId)!;
  };

  const events = (runId: string): Array<Record<string, unknown>> =>
    readFileSync(join(repoRoot, '.ai/cezar', 'runs', `${runId}.ndjson`), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-step-stopped-'));
    for (const key of ['CEZ_DRY_RUN', 'CEZ_MOCK_HANG', 'CEZ_RUN_IDLE_TIMEOUT_MS']) {
      savedEnv[key] = process.env[key];
    }
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_RUN_IDLE_TIMEOUT_MS = String(STOP_MS);
    delete process.env.CEZ_MOCK_HANG;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    manager?.dispose();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('a permanently silent step parks the run at review, never failed, and leaves the chain pending', async () => {
    // Every turn hangs, so the one automatic re-entry hangs too and the stop is terminal.
    process.env.CEZ_MOCK_HANG = '1';
    const record = manager.startRun(
      chain([{ id: 'spec' }, { id: 'implement' }, { id: 'run-tests' }, { id: 'deploy' }]),
      { task: 'do the thing', worktree: false },
    );
    const finished = await settled(record.id);

    // (2) The run is NOT failed. `review` is the landing `stopReason: 'budget'` already used.
    expect(finished.status).toBe('review');
    expect(finished.stopReason).toBe('inactivity');
    expect(finished.error).toBeUndefined();

    const byId = new Map(finished.steps.map((s) => [s.id, s]));
    // (1) The stopped step carries the reason, so nothing reads it as an agent failure.
    expect(byId.get('spec')?.stopReason).toBe('inactivity');
    // (3) The rest of the chain is untouched and still runnable — not abandoned, and no
    // synthetic `continue-N` step was invented in its place.
    expect(byId.get('implement')?.status).toBe('pending');
    expect(byId.get('run-tests')?.status).toBe('pending');
    expect(byId.get('deploy')?.status).toBe('pending');
    expect(finished.steps.some((s) => s.id.startsWith('continue-'))).toBe(false);

    const lifecycle = events(record.id).filter((e) => e.type === 'lifecycle');
    expect(lifecycle.some((e) => String(e.message).includes('run failed'))).toBe(false);
    expect(lifecycle.some((e) => String(e.message).includes('run stopped'))).toBe(true);
  }, 70_000);

  it('re-enters the stopped step exactly once, and the chain carries on when the retry lands', async () => {
    // `mock:hang` rides in `{{task}}`, so the OPENING turn of each step hangs. The automatic
    // re-entry opens the same session with the stop prompt instead, which the mock answers — so
    // this exercises the whole path: stop → resume the same session → step completes → next step.
    // Only `spec` hangs: its prompt is `{{task}}`, which carries `mock:hang`. `implement` is the
    // interactive last step and gets a prompt that ends the run cleanly, so the assertion is
    // about the re-entry and not about how a wedged final step behaves.
    const record = manager.startRun(
      chain([{ id: 'spec' }, { id: 'implement', prompt: 'mock:done finish up' }]),
      { task: 'mock:hang do the thing', worktree: false },
    );
    const finished = await settled(record.id);

    const spec = finished.steps.find((s) => s.id === 'spec')!;
    expect(spec.status).toBe('done');
    expect(spec.stopReason).toBeUndefined(); // it recovered — the stop is not sticky
    expect(spec.iterations).toBe(2); // stopped once, re-entered once. Not three times.

    // The chain really continued past the stopped step — the point of the re-entry.
    expect(finished.steps.find((s) => s.id === 'implement')?.iterations).toBeGreaterThanOrEqual(1);
    expect(finished.status).not.toBe('failed');

    const metrics = events(record.id).filter((e) => e.type === 'metric');
    expect(metrics.filter((e) => e.name === 'run.step.stopped' && e.stepId === 'spec')).toHaveLength(1);
    expect(metrics.filter((e) => e.name === 'run.step.resumed_after_stop' && e.stepId === 'spec')).toHaveLength(1);
  }, 70_000);

  it('the stopped metric carries the numbers the next investigation will need', async () => {
    process.env.CEZ_MOCK_HANG = '1';
    // Two steps so `spec` is NOT the interactive last one and therefore actually carries a bound.
    const record = manager.startRun(chain([{ id: 'spec' }, { id: 'implement' }]), {
      task: 'do the thing',
      worktree: false,
    });
    await settled(record.id);

    const stopped = events(record.id).filter((e) => e.type === 'metric' && e.name === 'run.step.stopped');
    // Two: the first stop and the second, terminal one. `attempt` tells them apart.
    expect(stopped).toHaveLength(2);
    expect(stopped[0]).toMatchObject({ reason: 'inactivity', workflow: 'spec-to-deploy', stepId: 'spec', attempt: 1 });
    expect(stopped[1]).toMatchObject({ attempt: 2 });
    // Elapsed time is what makes "raise the bound or fix the hang?" answerable from the log alone.
    expect(Number(stopped[0]!.elapsedMs)).toBeGreaterThanOrEqual(STOP_MS);
  }, 70_000);

  it('a healthy run under the same bound is completely unaffected', async () => {
    const record = manager.startRun(chain([{ id: 'spec' }, { id: 'implement' }]), {
      task: 'mock:done do the thing',
      worktree: false,
    });
    const finished = await settled(record.id);

    expect(finished.stopReason).toBeUndefined();
    expect(finished.steps.every((s) => s.stopReason === undefined)).toBe(true);
    expect(finished.steps.every((s) => s.iterations === 1)).toBe(true);
    expect(finished.status).not.toBe('failed');
  }, 70_000);
});
