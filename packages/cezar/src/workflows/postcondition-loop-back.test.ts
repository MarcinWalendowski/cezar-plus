import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { combineVerdicts, RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';
import { localCliAuthor } from '../runs/task-author.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * An AGENT step's failed post-condition may send the chain back to the step that can satisfy it.
 *
 * A check step has consulted `onFail` since it existed; an agent step never did, so its
 * post-condition was terminal no matter how the workflow was configured. That is fine while every
 * goal is one the step itself can meet ("you left files uncommitted" — commit them) and fatal for
 * one it cannot: `commit-push` merging a base that moved since the tests ran produces a diff
 * against the attested tree that is a fact about an EARLIER step's output. Re-entering the shipping
 * step recomputes it identically, forever.
 *
 * MEASURED — run `872b396a`, prod-host, 2026-08-29. `commit-push` failed
 * `tested-revision-shipped` naming 38 files, took its one same-step retry, produced the identical
 * verdict, and the run died. Its work was already on `origin/main`; `merge`, `document` and
 * `deploy` never ran.
 *
 * | Guard | Mutation that must turn it red |
 * |---|---|
 * | An agent step's post-condition loops back | delete the `canLoopBack(step)` branch in the agent arm |
 * | The loop-back is what rescues it | (negative control) the same chain without `onFail` still fails |
 * | The step's OWN retry still comes first | make the agent arm loop back before `retryAfterFailedPostcondition` |
 */
describe('an agent step whose post-condition it cannot satisfy alone', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  let argsFile: string;
  const savedEnv: Record<string, string | undefined> = {};

  /**
   * `run-tests` → `commit-push` → tail. The post-condition passes only on its Nth evaluation, which
   * is how a real re-test clears it: the gate is answered by work done UPSTREAM, never by this step.
   */
  const chain = (opts: { verifyMax: number; passOn: number; onFail: boolean }): WorkflowDef => ({
    name: 'ship-chain',
    description: 'x',
    source: 'built-in',
    steps: [
      { id: 'run-tests', name: 'Run the tests', prompt: 'test it: {{task}}' },
      {
        id: 'commit-push',
        name: 'Ship',
        prompt: 'ship it: {{task}}',
        verify: {
          command:
            `n=$(cat .attempts 2>/dev/null || echo 0); n=$((n+1)); printf %s "$n" > .attempts; [ "$n" -ge ${opts.passOn} ]`,
          max: opts.verifyMax,
        },
        ...(opts.onFail ? { onFail: { retry: 'run-tests', max: 1 } } : {}),
      },
      { id: 'tail', name: 'Tail', prompt: 'mock:done finish: {{task}}' },
    ],
  });

  const events = (runId: string): Array<Record<string, unknown>> =>
    readFileSync(join(repoRoot, '.ai/cezar', 'runs', `${runId}.ndjson`), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  const spawnsFor = (runId: string, stepId: string): number =>
    events(runId).filter((e) => e.type === 'session.started' && e.stepId === stepId).length;

  const settled = async (runId: string, ms = 60_000) => {
    const terminal = new Set(['done', 'review', 'failed', 'cancelled', 'waiting']);
    const deadline = Date.now() + ms;
    while (!terminal.has(store.getRun(runId)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error(`run did not settle: ${store.getRun(runId)?.status}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    return store.getRun(runId)!;
  };

  const start = (opts: { verifyMax: number; passOn: number; onFail: boolean }): string => {
    manager = new RunManager(store, repoRoot);
    return manager.startRun(chain(opts), {
      author: localCliAuthor(),
      task: 'do the thing',
      runner: 'claude',
      worktree: false,
    }).id;
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-pc-loopback-'));
    for (const key of ['CEZ_DRY_RUN', 'CLAUDE_CONFIG_DIR', 'CEZ_MOCK_ARGS_FILE']) savedEnv[key] = process.env[key];
    process.env.CEZ_DRY_RUN = '1';
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cez-pc-home-'));
    argsFile = join(mkdtempSync(join(tmpdir(), 'cez-pc-hooks-')), 'args.ndjson');
    process.env.CEZ_MOCK_ARGS_FILE = argsFile;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('goes back to the step that CAN satisfy it, and the chain finishes', async () => {
    // `verifyMax: 0` is the shape base drift produces: the gate itself says re-running is futile.
    const runId = start({ verifyMax: 0, passOn: 2, onFail: true });
    const finished = await settled(runId);

    expect(finished.status).not.toBe('failed');
    expect(finished.steps.find((s) => s.id === 'tail')?.status).toBe('done');

    const looped = events(runId).filter((e) => e.name === 'run.step.looped_back');
    expect(looped).toHaveLength(1);
    expect(looped[0]).toMatchObject({ stepId: 'commit-push', target: 'run-tests', attempt: 1 });

    // The proof the loop went BACKWARDS rather than just re-running the shipping step.
    expect(spawnsFor(runId, 'run-tests')).toBe(2);
    expect(spawnsFor(runId, 'commit-push')).toBe(2);
  }, 90_000);

  it('WITHOUT `onFail`, the identical chain still dies at the shipping step', async () => {
    // The negative control. Without it the test above cannot tell "the loop-back rescued this"
    // from "the counter would have passed on its own the second time round".
    const runId = start({ verifyMax: 0, passOn: 2, onFail: false });
    const finished = await settled(runId);

    expect(finished.status).toBe('failed');
    expect(finished.steps.find((s) => s.id === 'commit-push')?.status).toBe('failed');
    expect(finished.steps.find((s) => s.id === 'tail')?.status).toBe('pending');
    expect(events(runId).filter((e) => e.name === 'run.step.looped_back')).toHaveLength(0);
    expect(spawnsFor(runId, 'run-tests')).toBe(1);
  }, 90_000);

  it('still tries the step ITSELF first when the workflow budgets a retry', async () => {
    // The ordering matters and is easy to lose: most post-condition failures ARE the step's own job
    // ("you left files uncommitted"), and re-running the whole test suite for one is the expensive
    // wrong answer. `verifyMax: 1` must buy a same-step attempt BEFORE the chain rewinds — which is
    // also the half of `retryMax: first.retryMax ?? first.max` that keeps the workflow's own budget
    // governing whenever the gate states none.
    const runId = start({ verifyMax: 1, passOn: 3, onFail: true });
    const finished = await settled(runId);

    expect(finished.status).not.toBe('failed');
    // Three evaluations: first fails, the same-step retry fails, the post-rewind one passes.
    expect(readFileSync(join(repoRoot, '.attempts'), 'utf8')).toBe('3');
    expect(spawnsFor(runId, 'commit-push')).toBe(3);
    // …and the rewind still happened exactly once, after the step's own budget was spent.
    expect(events(runId).filter((e) => e.name === 'run.step.looped_back')).toHaveLength(1);
    expect(spawnsFor(runId, 'run-tests')).toBe(2);

    // The ORDER is the only thing separating "retry, then rewind" from "rewind, then retry": both
    // orders spend the same two budgets and produce the same three evaluations and the same spawn
    // counts, so every assertion above passes either way. Swapping them is a real regression — it
    // re-runs the whole test suite for a failure the shipping step could have fixed by itself.
    const order = events(runId)
      .map((e) => {
        if (e.name === 'run.step.looped_back') return 'rewind';
        if (String(e.message ?? '').includes('re-running "commit-push"')) return 'same-step';
        return undefined;
      })
      .filter(Boolean);
    expect(order).toEqual(['same-step', 'rewind']);
  }, 90_000);
});

/**
 * Which retry budget the engine acts on. Unreachable end-to-end: the branch that matters fires only
 * for a BUILT-IN post-condition, and every built-in passes under `CEZ_DRY_RUN=1`, which is what
 * selects the mock CLI those engine tests need.
 */
describe('combineVerdicts — the gate\'s own budget, or the workflow\'s', () => {
  const red = (detail: string, extra: Record<string, unknown> = {}) => ({ ok: false, detail, max: 1, ...extra });

  it('believes a gate that says re-running this step cannot help', () => {
    // `tested-revision-shipped` on base drift. The workflow budgets 1, the gate says 0, and 0 wins
    // — otherwise the run spends a whole agent turn recomputing a diff that cannot have changed.
    expect(combineVerdicts([red('base moved', { retryMax: 0 })]).retryMax).toBe(0);
  });

  it('keeps the workflow\'s budget for every gate that states none', () => {
    // The load-bearing other half: most failures ARE the step's own job, and silently zeroing
    // their budget would remove the same-step retry from every workflow at once.
    expect(combineVerdicts([red('you left files uncommitted')]).retryMax).toBe(1);
    expect(combineVerdicts([{ ...red('x'), max: 3 }]).retryMax).toBe(3);
  });

  it('reads the budget off the FIRST failure, not off a later one that happens to state one', () => {
    const combined = combineVerdicts([red('first, silent'), red('second', { retryMax: 0 })]);
    expect(combined.retryMax).toBe(1);
    // …while still reporting both, so nothing is lost from the step card.
    expect(combined.detail).toContain('first, silent');
    expect(combined.detail).toContain('second');
  });

  it('passes only when every post-condition passed', () => {
    expect(combineVerdicts([{ ok: true, detail: 'a', max: 1 }, { ok: true, detail: 'b', max: 1 }]).ok).toBe(true);
    expect(combineVerdicts([{ ok: true, detail: 'a', max: 1 }, red('b')]).ok).toBe(false);
  });

  it('carries the first failure\'s handoff through, so a manual-deploy park survives aggregation', () => {
    const handoff = { kind: 'manual-deploy' as const, reason: 'activate it', targets: ['cezar'] };
    expect(combineVerdicts([red('needs a person', { handoff })]).handoff).toEqual(handoff);
    expect(combineVerdicts([red('no handoff')]).handoff).toBeUndefined();
  });
});
