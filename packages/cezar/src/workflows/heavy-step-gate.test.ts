import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { localCliAuthor } from '../runs/task-author.ts';
import { RunManager } from './run.ts';
import { SPEC_TO_DEPLOY_WORKFLOW, type WorkflowDef } from './types.ts';

/**
 * The SECOND admission gate, wired (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D14;
 * plan package 0.6).
 *
 * `WorkspaceSemaphore.runHeavyStep` landed with nobody calling it, and `heavy?: boolean` landed on
 * the step schema with nobody reading it. This suite is about the wire between them: which steps
 * pass through the gate, which are untouched by it, and what "absent means unbounded" costs an
 * installed user who never opted in.
 *
 * The measurements the phase actually turns on (C1/C2) are a load test on the box, not this file.
 * What is testable here is that the gate holds when it is set, and — the half that would otherwise
 * ship silently — that it does NOTHING when it is not.
 */

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

function fixtureRepo(prefix: string, roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', [...GIT_ID, 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });
  return root;
}

async function waitFor(predicate: () => boolean, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const settled = ['done', 'failed', 'cancelled', 'review'];

/** A heavy step that occupies its slot long enough to observe. A CHECK step, so the gate is
 *  exercised with no agent process, no backend and no mock session in the way. */
const HEAVY_SLOW: WorkflowDef = {
  name: 'heavy-slow',
  source: 'built-in',
  steps: [{ id: 'gate', heavy: true, command: 'node -e "setTimeout(()=>{},2500)"' }],
};
/** The same shape and the same duration, minus the one flag under test. */
const PLAIN_SLOW: WorkflowDef = {
  name: 'plain-slow',
  source: 'built-in',
  steps: [{ id: 'nogate', command: 'node -e "setTimeout(()=>{},2500)"' }],
};
const PLAIN_INSTANT: WorkflowDef = {
  name: 'plain-instant',
  source: 'built-in',
  steps: [{ id: 'nogate', command: 'node -e ""' }],
};
const FAILING: WorkflowDef = {
  name: 'failing',
  source: 'built-in',
  steps: [{ id: 'boom', command: 'node -e "process.exit(1)"' }],
};

describe('heavy-step gate (D14) — wired into the step loop', () => {
  const roots: string[] = [];
  const managers: RunManager[] = [];
  const stores: RunStore[] = [];
  const savedDryRun = { value: undefined as string | undefined };

  function project(prefix: string, semaphore: WorkspaceSemaphore): { store: RunStore; manager: RunManager } {
    const root = fixtureRepo(prefix, roots);
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root, { semaphore });
    stores.push(store);
    managers.push(manager);
    return { store, manager };
  }

  /** Samples `heavyActive()` while `until` is false, so an assertion can be made about the PEAK
   *  rather than about whatever one late poll happened to catch. */
  async function watchHeavyActive(
    semaphore: WorkspaceSemaphore,
    until: () => boolean,
    ms = 20_000,
  ): Promise<number> {
    let peak = 0;
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !until()) {
      peak = Math.max(peak, semaphore.heavyActive());
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return peak;
  }

  beforeEach(() => {
    savedDryRun.value = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
  });

  afterEach(async () => {
    for (const store of stores) {
      const manager = managers[stores.indexOf(store)];
      for (const run of store.listRuns()) {
        if (!settled.includes(store.getRun(run.id)?.status ?? '')) manager?.cancel(run.id);
      }
    }
    for (const store of stores) {
      await waitFor(
        () => store.listRuns().every((r) => settled.includes(r.status)),
        'all runs to settle before teardown',
      ).catch(() => undefined);
      store.flush();
    }
    for (const manager of managers.splice(0)) manager.dispose();
    stores.length = 0;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    if (savedDryRun.value === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun.value;
  });

  it('the catalog declares `run-tests` heavy — on the definition, and nowhere else', () => {
    const runTests = SPEC_TO_DEPLOY_WORKFLOW.steps.find((step) => step.id === 'run-tests');
    // Floor first: if the step were renamed this assertion would otherwise pass vacuously on
    // `undefined?.heavy !== true`, and the gate would quietly cover nothing.
    expect(runTests).toBeDefined();
    expect(runTests?.heavy).toBe(true);
    // Exactly one heavy step in the chain. Not decoration: every other step of `spec-to-deploy`
    // (`implement` included, which also runs code) stays ungated, so the gate bounds the spike and
    // not the pipeline.
    expect(SPEC_TO_DEPLOY_WORKFLOW.steps.filter((step) => step.heavy === true)).toHaveLength(1);
  });

  it('holds the line at `maxHeavySteps`: both runs are admitted, only one is in the heavy step', async () => {
    // maxParallel is deliberately WIDER than maxHeavySteps — that separation is the whole point of
    // D14. Two runs admitted (the box is not idling at 1) while at most one spikes.
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 4, maxHeavySteps: 1 } });
    const a = project('cez-heavy-hold-a-', semaphore);

    const first = a.manager.startRun(HEAVY_SLOW, { author: localCliAuthor(), task: 'heavy 1' });
    const second = a.manager.startRun(HEAVY_SLOW, { author: localCliAuthor(), task: 'heavy 2' });

    // Both ADMITTED — neither is stuck in the run queue. If the heavy gate had been taken at run
    // admission instead of around the step, this is the assertion that would fail.
    await waitFor(
      () =>
        a.store.getRun(first.id)?.status === 'running' && a.store.getRun(second.id)?.status === 'running',
      'both runs to be admitted',
    );

    const peak = await watchHeavyActive(semaphore, () =>
      settled.includes(a.store.getRun(first.id)?.status ?? '') &&
      settled.includes(a.store.getRun(second.id)?.status ?? ''),
    );
    // The gate held...
    expect(peak).toBeLessThanOrEqual(1);
    // ...and it was genuinely exercised. Without this line the assertion above passes against a
    // gate that never admitted anybody at all.
    expect(peak).toBe(1);

    await waitFor(
      () =>
        a.store.getRun(first.id)?.status === 'done' && a.store.getRun(second.id)?.status === 'done',
      'both heavy runs to finish — queueing at the gate, not failing at it',
      30_000,
    );
    // The slot is given back: a step that finished must not leave the counter occupied, or the
    // next heavy step on this box waits behind a run that ended minutes ago.
    expect(semaphore.heavyActive()).toBe(0);
  }, 45_000);

  it('NEGATIVE CONTROL — a step that is not heavy is not gated, even with the gate saturated', async () => {
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 4, maxHeavySteps: 1 } });
    const a = project('cez-heavy-ungated-', semaphore);

    const heavy = a.manager.startRun(HEAVY_SLOW, { author: localCliAuthor(), task: 'saturate the gate' });
    await waitFor(() => semaphore.heavyActive() === 1, 'the heavy gate to be saturated');

    // Same manager, same moment, no `heavy` flag: it must run straight through while the gate is
    // full. A gate that leaked onto ordinary steps would make `commit-push` and every check step
    // queue behind whichever run happens to be testing.
    const plain = a.manager.startRun(PLAIN_INSTANT, { author: localCliAuthor(), task: 'must not be gated' });
    await waitFor(
      () => a.store.getRun(plain.id)?.status === 'done',
      'the non-heavy run to finish while the gate is saturated',
    );
    // ...and the heavy one really was still holding the slot the whole time.
    expect(a.store.getRun(heavy.id)?.status).toBe('running');
    expect(semaphore.heavyActive()).toBe(1);
  }, 45_000);

  it('NEGATIVE CONTROL — with `maxHeavySteps` absent nothing is gated: 4 heavy steps run at once', async () => {
    // `undefined` means UNBOUNDED, never 0/1/2. cezar ships on npm and `run-tests` is heavy, so a
    // schema default would cap every installed user's concurrent test steps on upgrade — felt as
    // "cezar got slower", with nothing in their own config to point at.
    //
    // FOUR, not two: at N=2 this case would pass just as happily against a hard-coded cap of 2,
    // which is exactly the wrong implementation it exists to rule out.
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 4 } });
    expect(semaphore.maxHeavySteps()).toBe(Infinity);
    const a = project('cez-heavy-unbounded-', semaphore);

    const ids = [1, 2, 3, 4].map(
      (n) => a.manager.startRun(HEAVY_SLOW, { author: localCliAuthor(), task: `heavy ${n}` }).id,
    );
    await waitFor(
      () => ids.every((id) => a.store.getRun(id)?.status === 'running'),
      'all four runs to be admitted',
    );
    await waitFor(() => semaphore.heavyActive() === 4, 'all four heavy steps to be inside the gate at once');
    expect(semaphore.heavyActive()).toBeGreaterThan(2);
  }, 45_000);

  it('a heavy step that FAILS still frees its slot', async () => {
    // The `finally` in `runHeavyStep`, observed through the wiring rather than in isolation: a
    // leaked slot wedges every future heavy step on the box behind a step that already died, and
    // the symptom (everything queues forever) points nowhere near the step that caused it.
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 4, maxHeavySteps: 1 } });
    const a = project('cez-heavy-finally-', semaphore);
    const failing: WorkflowDef = {
      name: 'heavy-failing',
      source: 'built-in',
      steps: [{ id: 'gate', heavy: true, command: 'node -e "process.exit(3)"' }],
    };

    const boom = a.manager.startRun(failing, { author: localCliAuthor(), task: 'heavy and doomed' });
    await waitFor(() => a.store.getRun(boom.id)?.status === 'failed', 'the heavy step to fail');
    expect(semaphore.heavyActive()).toBe(0);

    // Proof the counter is not merely reading zero: the next heavy run still gets in.
    const after = a.manager.startRun(HEAVY_SLOW, { author: localCliAuthor(), task: 'after the failure' });
    await waitFor(() => semaphore.heavyActive() === 1, 'a later heavy step to take the freed slot');
    expect(a.store.getRun(after.id)?.status).toBe('running');
  }, 45_000);

  it('a heavy run and a plain run of equal length both finish — the gate queues, it does not fail', async () => {
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 4, maxHeavySteps: 1 } });
    const a = project('cez-heavy-mixed-', semaphore);
    const heavy = a.manager.startRun(HEAVY_SLOW, { author: localCliAuthor(), task: 'heavy' });
    const plain = a.manager.startRun(PLAIN_SLOW, { author: localCliAuthor(), task: 'plain' });
    await waitFor(
      () =>
        a.store.getRun(heavy.id)?.status === 'done' && a.store.getRun(plain.id)?.status === 'done',
      'both to finish',
      30_000,
    );
  }, 45_000);
});

describe('resource kill on the run record (C3)', () => {
  const roots: string[] = [];
  const managers: RunManager[] = [];
  const stores: RunStore[] = [];

  function project(prefix: string): { store: RunStore; manager: RunManager } {
    const root = fixtureRepo(prefix, roots);
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 4 } }),
    });
    stores.push(store);
    managers.push(manager);
    return { store, manager };
  }

  afterEach(async () => {
    for (const store of stores) {
      await waitFor(
        () => store.listRuns().every((r) => settled.includes(r.status)),
        'runs to settle',
      ).catch(() => undefined);
      store.flush();
    }
    for (const manager of managers.splice(0)) manager.dispose();
    stores.length = 0;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('writes `resourceKill` onto the run and says so in the transcript', async () => {
    const a = project('cez-rk-write-');
    const run = a.manager.startRun(PLAIN_INSTANT, { author: localCliAuthor(), task: 'ordinary run' });
    await waitFor(() => settled.includes(a.store.getRun(run.id)?.status ?? ''), 'the run to settle');

    // The callback the broker hands its exit to, invoked directly: the spawn path itself needs a
    // BUILT tree (`brokerAvailable()` is false from source, by design), so the seam under test is
    // the one this package owns — what the run record and the transcript say once a kill is
    // reported. Whether a real cgroup breach produces it is C3's job, on the box.
    const kill = { limit: 'memory' as const, at: '2026-08-22T10:00:00.000Z', detail: 'MemoryMax=512M on the run scope' };
    (a.manager as unknown as { recordResourceKill(id: string, step: string | undefined, k: typeof kill): void })
      .recordResourceKill(run.id, 'nogate', kill);

    expect(a.store.getRun(run.id)?.resourceKill).toEqual(kill);
    const notes = a.store
      .readEvents(run.id)
      .filter((event) => event.type === 'note')
      .map((event) => String((event as { message?: unknown }).message ?? ''));
    // The reason has to be IN the transcript, not only in a field nobody reads: an agent that sees
    // a bare failure fixes the code that was running at the time.
    expect(notes.some((message) => message.includes('MemoryMax=512M'))).toBe(true);
    expect(notes.some((message) => message.includes('NOT a test or code failure'))).toBe(true);
  }, 30_000);

  it('NEGATIVE CONTROL — an ordinary non-zero exit leaves `resourceKill` absent', async () => {
    // The direction that keeps the field meaningful. Without it, a writer that stamped every
    // failure as a resource kill would satisfy the case above and turn every red gate on the box
    // into "the host killed it".
    const a = project('cez-rk-none-');
    const run = a.manager.startRun(FAILING, { author: localCliAuthor(), task: 'ordinary failure' });
    await waitFor(() => a.store.getRun(run.id)?.status === 'failed', 'the run to fail');
    expect(a.store.getRun(run.id)?.resourceKill).toBeUndefined();
    expect(a.store.getRun(run.id)?.error).toBeDefined();
  }, 30_000);
});
