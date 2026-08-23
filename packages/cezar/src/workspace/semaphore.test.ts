import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceSemaphore, type SemaphoreParticipant } from './semaphore.ts';

/** A promise the test resolves by hand, so a step's "work" can be paused at an exact,
 *  deterministic point instead of a `setTimeout` guess. */
function defer<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Drains every pending microtask, however deep the chain — a `setImmediate` macrotask only runs
 *  after all of them, unlike a fixed number of `await Promise.resolve()` hops. Same idiom as
 *  `core/codex-ui-mapper.test.ts`. Concurrency assertions below rely on this, never on elapsed
 *  time, per the workspace rule that a gate is proven by observed concurrency, not a timer. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Unit surface of the shared workspace semaphore (spec 2026-07-20, step 2.5).
 *  The cross-manager scheduling behavior (cap across projects, the #347
 *  waiting-resume exemption, refresh-without-restart) lives in
 *  src/workflows/workspace-semaphore.test.ts against real RunManagers. */
describe('WorkspaceSemaphore', () => {
  const participant = (
    busy: number,
    queuedAt: number | null = null,
  ): SemaphoreParticipant & { pumped: number[] } => {
    const p = {
      pumped: [] as number[],
      busySlots: () => busy,
      oldestQueuedAt: () => queuedAt,
      pump: () => {
        p.pumped.push(Date.now());
      },
    };
    return p;
  };

  it('defaults to the workspace schema defaults before any refresh', () => {
    const sem = new WorkspaceSemaphore();
    expect(sem.maxParallel()).toBe(2);
    expect(sem.memoryLimitMb()).toBeNull();
    expect(sem.monitoringWakeIntervalMinutes()).toBe(5); // #810 — monitoring must self-resume
    expect(sem.busy()).toBe(0);
  });

  /** #810 — the getter used to be `?? null`. Flipping the default to 5 made that a trap:
   *  `null ?? 5` is 5, which would have silently overridden every operator who chose
   *  "Park until resumed". Absent and null must therefore answer differently. */
  describe('monitoringWakeIntervalMinutes: absent vs. explicit null (#810)', () => {
    it('falls back to the shipped default only when the key is ABSENT', () => {
      const sem = new WorkspaceSemaphore({ initial: { maxParallel: 2, monitoringWakeIntervalMinutes: undefined } });
      expect(sem.monitoringWakeIntervalMinutes()).toBe(5);
    });

    it('preserves an explicit null (park until resumed)', () => {
      const sem = new WorkspaceSemaphore({ initial: { monitoringWakeIntervalMinutes: null } });
      expect(sem.monitoringWakeIntervalMinutes()).toBeNull();
    });

    it('preserves an explicit cadence', () => {
      const sem = new WorkspaceSemaphore({ initial: { monitoringWakeIntervalMinutes: 12 } });
      expect(sem.monitoringWakeIntervalMinutes()).toBe(12);
    });

    it('a refresh that reports null parks, and one that reports a number re-arms', async () => {
      let wake: number | null = null;
      const sem = new WorkspaceSemaphore({
        load: () => Promise.resolve({ maxParallel: 2, memoryLimitMb: null, monitoringWakeIntervalMinutes: wake }),
      });
      await sem.refresh();
      expect(sem.monitoringWakeIntervalMinutes()).toBeNull();
      wake = 9;
      await sem.refresh();
      expect(sem.monitoringWakeIntervalMinutes()).toBe(9);
    });
  });

  it('honors an initial override (test seam)', () => {
    const sem = new WorkspaceSemaphore({ initial: { maxParallel: 5, memoryLimitMb: 512 } });
    expect(sem.maxParallel()).toBe(5);
    expect(sem.memoryLimitMb()).toBe(512);
  });

  it('accountHolds() unions every participant by kind, and is empty for stubs that hold none', () => {
    // A usage limit closes an ACCOUNT, and one account can drive tasks in several projects, so
    // the hold spans managers the way the parallel cap does (spec
    // 2026-08-03-auto-resume-after-usage-limit). The two kinds bind different work, so they are
    // aggregated separately. `accountHolds` is optional on the participant, so a stub that
    // predates it — like the ones above — simply holds nothing.
    const sem = new WorkspaceSemaphore();
    expect(sem.accountHolds().deadline.size + sem.accountHolds().inFlight.size).toBe(0);

    sem.register(participant(0));
    const offA = sem.register({
      ...participant(0),
      accountHolds: () => ({ deadline: new Set(['claude:default']), inFlight: new Set<string>() }),
    });
    sem.register({
      ...participant(0),
      accountHolds: () => ({
        deadline: new Set(['codex:work']),
        inFlight: new Set(['claude:second']),
      }),
    });
    expect([...sem.accountHolds().deadline].sort()).toEqual(['claude:default', 'codex:work'])
    expect([...sem.accountHolds().inFlight]).toEqual(['claude:second'])

    // A torn-down project stops holding the workspace's queue with it.
    offA()
    expect([...sem.accountHolds().deadline]).toEqual(['codex:work'])
  })


  it('busy() sums every registered participant; unregister stops counting', () => {
    const sem = new WorkspaceSemaphore();
    const a = participant(2);
    const b = participant(1);
    const offA = sem.register(a);
    sem.register(b);
    expect(sem.busy()).toBe(3);
    offA();
    expect(sem.busy()).toBe(1);
  });

  it('refresh() swaps the cached limits and pumps every participant', async () => {
    let limits = { maxParallel: 1, memoryLimitMb: null as number | null };
    const sem = new WorkspaceSemaphore({ load: () => Promise.resolve({ ...limits }) });
    const a = participant(0);
    sem.register(a);
    limits = { maxParallel: 7, memoryLimitMb: 1024 };
    await sem.refresh();
    expect(sem.maxParallel()).toBe(7);
    expect(sem.memoryLimitMb()).toBe(1024);
    expect(a.pumped.length).toBe(1);
  });

  it('release() pumps EVERY participant, not just the one that freed the slot', async () => {
    const sem = new WorkspaceSemaphore();
    const a = participant(1);
    const b = participant(0, 1000);
    sem.register(a);
    sem.register(b);
    await sem.release();
    expect(a.pumped.length).toBe(1);
    expect(b.pumped.length).toBe(1); // the whole point: B's queue hears about A's freed slot
  });

  it('release() pumps the longest-waiting queue first; empty queues go last', async () => {
    const order: string[] = [];
    const named = (name: string, queuedAt: number | null): SemaphoreParticipant => ({
      busySlots: () => 0,
      oldestQueuedAt: () => queuedAt,
      pump: () => {
        order.push(name);
      },
    });
    const sem = new WorkspaceSemaphore();
    sem.register(named('idle', null));
    sem.register(named('newer', 2000));
    sem.register(named('older', 1000));
    await sem.release();
    expect(order).toEqual(['older', 'newer', 'idle']);
  });

  it('a release landing mid-sweep re-runs the sweep instead of being dropped', async () => {
    const sem = new WorkspaceSemaphore();
    let reentered = false;
    const a: SemaphoreParticipant & { pumped: number } = {
      pumped: 0,
      busySlots: () => 0,
      oldestQueuedAt: () => null,
      pump: async () => {
        a.pumped += 1;
        if (!reentered) {
          reentered = true;
          await sem.release(); // a run settles while the sweep is in flight
        }
      },
    };
    sem.register(a);
    await sem.release();
    expect(a.pumped).toBe(2); // the nested release replayed the sweep
  });

  it('projectMaxParallel returns the per-project value when set, else the workspace cap', async () => {
    // Key by realpath'd temp dirs so normalizeRootSync resolves them identically.
    const dirs = mkdtempSync(join(tmpdir(), 'cez-sema-'));
    const capped = join(dirs, 'capped');
    const open = join(dirs, 'open');
    mkdirSync(capped, { recursive: true });
    mkdirSync(open, { recursive: true });
    try {
      let projectLimits = new Map<string, number>([[realpathSync(capped), 1]]);
      const sem = new WorkspaceSemaphore({
        load: () => Promise.resolve({ maxParallel: 4, memoryLimitMb: null, projectLimits }),
      });
      await sem.refresh();
      // The registered project uses its own cap...
      expect(sem.projectMaxParallel(capped)).toBe(1);
      // ...a registered-but-unset project and an unknown root inherit the workspace cap.
      expect(sem.projectMaxParallel(open)).toBe(4);
      expect(sem.projectMaxParallel(join(dirs, 'never-registered'))).toBe(4);
      // A refresh that changes the value is reflected immediately.
      projectLimits = new Map<string, number>([[realpathSync(capped), 3]]);
      await sem.refresh();
      expect(sem.projectMaxParallel(capped)).toBe(3);
    } finally {
      rmSync(dirs, { recursive: true, force: true });
    }
  });

  it('projectMaxParallel inherits the workspace cap when no projectLimits map is provided', () => {
    // An older load stub (resource slice only) → every root inherits.
    const sem = new WorkspaceSemaphore({ initial: { maxParallel: 6 } });
    expect(sem.projectMaxParallel('/tmp/whatever')).toBe(6);
  });

  it('projectMaxParallel resolves a manager keyed by a symlinked root to the registry entry (spec Q7)', async () => {
    // The spec's normalization guard: the registry stores the realpath'd root,
    // but a manager may hold a *symlinked* spelling of the same directory. The
    // lookup must realpath both, or the override silently falls back to the
    // workspace cap. A real symlink is the only way to prove normalizeRootSync
    // actually canonicalizes — an all-`/tmp` test passes even as a no-op.
    const dirs = realpathSync(mkdtempSync(join(tmpdir(), 'cez-sema-link-')));
    const real = join(dirs, 'real-root');
    const link = join(dirs, 'link-root'); // a symlink pointing at real-root
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    try {
      // Registry keys by the realpath'd root (what registerProject stores)…
      const sem = new WorkspaceSemaphore({
        load: () => Promise.resolve({ maxParallel: 4, memoryLimitMb: null, projectLimits: new Map([[real, 1]]) }),
      });
      await sem.refresh();
      // …and a manager holding the symlinked spelling still resolves the cap.
      expect(link).not.toBe(real); // guard: the two spellings really differ
      expect(realpathSync(link)).toBe(real); // guard: the symlink resolves to it
      expect(sem.projectMaxParallel(link)).toBe(1);
      expect(sem.projectMaxParallel(real)).toBe(1);
    } finally {
      rmSync(dirs, { recursive: true, force: true });
    }
  });

  it('a failed load keeps the last good cache (never degrades to defaults) and still pumps', async () => {
    let fail = false;
    const sem = new WorkspaceSemaphore({
      load: () =>
        fail
          ? Promise.reject(new Error('unreadable'))
          : Promise.resolve({ maxParallel: 9, memoryLimitMb: 256 }),
    });
    const a = participant(0);
    sem.register(a);
    await sem.refresh();
    expect(sem.maxParallel()).toBe(9);
    fail = true;
    await sem.refresh();
    expect(sem.maxParallel()).toBe(9); // last good snapshot survives
    expect(sem.memoryLimitMb()).toBe(256);
    expect(a.pumped.length).toBe(2);
  });
});

/**
 * The SECOND gate (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D14; plan package
 * 0.4): taken and released around a STEP, not a run, so it can see two runs both inside
 * `run-tests` at once — which `maxParallel` (a run-count cap) structurally cannot. Which steps
 * count is declared on the step definition (`workflows/types.ts` `heavy`), never inferred here
 * from a name; this file only implements the gate itself.
 */
describe('WorkspaceSemaphore — heavy step gate (maxHeavySteps, D14)', () => {
  it('maxHeavySteps() defaults to Infinity when nothing set it — absent means unbounded, never 0/1/2', () => {
    const sem = new WorkspaceSemaphore();
    expect(sem.maxHeavySteps()).toBe(Infinity);
    expect(sem.heavyActive()).toBe(0);
  });

  it('an explicit maxHeavySteps is honored, and refresh() re-applies it — including back to absent', async () => {
    let heavy: number | undefined = 3;
    const sem = new WorkspaceSemaphore({
      load: () => Promise.resolve({ maxParallel: 2, memoryLimitMb: null, maxHeavySteps: heavy }),
    });
    await sem.refresh();
    expect(sem.maxHeavySteps()).toBe(3);
    heavy = undefined; // an upgrade whose config never opted in must land back on unbounded
    await sem.refresh();
    expect(sem.maxHeavySteps()).toBe(Infinity);
  });

  // Negative control 1/3 (team spec): unbounded really is unbounded. N > 2 must all proceed
  // together, or this test would also pass against a hardcoded default of 2.
  it('with maxHeavySteps absent, N > 2 concurrent heavy steps all hold a slot at once', async () => {
    const sem = new WorkspaceSemaphore();
    const gates = Array.from({ length: 5 }, () => defer());
    const started: number[] = [];
    const runs = gates.map((g, i) => sem.runHeavyStep(async () => {
      started.push(i);
      await g.promise;
    }));
    // Every call acquired SYNCHRONOUSLY — proof of concurrency, not a timing guess: an
    // implementation that queued anything here would leave heavyActive() below 5 right now.
    expect(sem.heavyActive()).toBe(5);
    await flush();
    expect(started).toEqual([0, 1, 2, 3, 4]);

    gates.forEach((g) => g.resolve());
    await Promise.all(runs);
    expect(sem.heavyActive()).toBe(0);
  });

  // Negative control 2/3: the gate really gates, and it queues rather than fails.
  it('with maxHeavySteps: 2, a third concurrent heavy step waits and proceeds only once one releases', async () => {
    const sem = new WorkspaceSemaphore({ initial: { maxHeavySteps: 2 } });
    const [gate0, gate1, gate2] = [defer(), defer(), defer()];
    const started: number[] = [];
    const [run0, run1, run2] = [gate0, gate1, gate2].map((g, i) => sem.runHeavyStep(async () => {
      started.push(i);
      await g.promise;
    }));

    expect(sem.heavyActive()).toBe(2); // two acquired synchronously; the third has no slot to take
    await flush();
    expect(started).toEqual([0, 1]); // #2 is queued, not started — and not failed either

    gate0.resolve();
    await run0;
    await flush();
    expect(started).toEqual([0, 1, 2]); // the freed slot went straight to the longest-waiting call
    expect(sem.heavyActive()).toBe(2); // still at the cap: #2 took the vacancy #0 left

    gate1.resolve();
    gate2.resolve();
    await Promise.all([run0, run1, run2]);
    expect(sem.heavyActive()).toBe(0);
  });

  // Negative control 3/3: a step that never calls the gate is unaffected by it, even fully
  // saturated with a backlog — proven by completion ORDER, not by the absence of an interaction.
  it('a non-heavy step is never gated, even while the heavy gate is full and backlogged', async () => {
    const sem = new WorkspaceSemaphore({ initial: { maxHeavySteps: 1 } });
    const heavyGate = defer();
    const order: string[] = [];

    const heldHeavy = sem.runHeavyStep(async () => {
      await heavyGate.promise;
      order.push('heavy-holder');
    });
    const queuedHeavy = sem.runHeavyStep(async () => {
      order.push('heavy-queued');
    });
    await flush();
    expect(sem.heavyActive()).toBe(1); // one holding, one backlogged behind it — fully saturated

    // Steps that never call runHeavyStep at all — i.e. any step a workflow did not declare heavy.
    const nonHeavy = Array.from({ length: 5 }, (_, i) =>
      Promise.resolve().then(() => order.push(`plain-${i}`)),
    );
    await Promise.all(nonHeavy);
    expect(order).toEqual(['plain-0', 'plain-1', 'plain-2', 'plain-3', 'plain-4']);
    expect(sem.heavyActive()).toBe(1); // unmoved — the plain steps never touched the gate

    heavyGate.resolve();
    await heldHeavy;
    await queuedHeavy;
    expect(order).toEqual([
      'plain-0', 'plain-1', 'plain-2', 'plain-3', 'plain-4', 'heavy-holder', 'heavy-queued',
    ]);
  });

  it('release is exception-safe: a step that throws still frees its slot and unblocks a queued waiter', async () => {
    const sem = new WorkspaceSemaphore({ initial: { maxHeavySteps: 1 } });
    const throwing = sem.runHeavyStep(async () => {
      throw new Error('boom');
    });
    let queuedRan = false;
    const queued = sem.runHeavyStep(async () => {
      queuedRan = true;
    });

    await expect(throwing).rejects.toThrow('boom');
    // If the throw had leaked the slot, `queued` would hang here forever instead of settling.
    await queued;
    expect(queuedRan).toBe(true);
    expect(sem.heavyActive()).toBe(0);
  });

  it('composes with the run-admission gate without deadlock: release() never waits on a queued heavy slot', async () => {
    const sem = new WorkspaceSemaphore({ initial: { maxHeavySteps: 1 } });
    const runParticipant: SemaphoreParticipant & { pumped: number } = {
      pumped: 0,
      busySlots: () => 1, // simulates a run holding a run-admission slot throughout
      oldestQueuedAt: () => null,
      pump: () => {
        runParticipant.pumped += 1;
      },
    };
    sem.register(runParticipant);

    // Occupy the one heavy slot, then queue a second behind it — as if another run were stuck
    // waiting to enter its own heavy step while THIS run holds a run slot and calls release().
    const heavyGate = defer();
    const heldHeavy = sem.runHeavyStep(() => heavyGate.promise);
    let queuedRan = false;
    const queuedHeavy = sem.runHeavyStep(async () => {
      queuedRan = true;
    });
    expect(sem.heavyActive()).toBe(1);

    // The run-admission broadcast must complete on its own terms — it must never block on the
    // heavy queue, or a run holding a run slot while waiting on a heavy slot could wedge every
    // other manager's pump.
    await sem.release();
    expect(runParticipant.pumped).toBe(1);
    expect(queuedRan).toBe(false); // still genuinely queued — release() did not leak it through

    heavyGate.resolve();
    await heldHeavy;
    await queuedHeavy;
    expect(queuedRan).toBe(true);
    expect(sem.busy()).toBe(1); // the run-admission counter never moved — the two gates are independent
  });
});
