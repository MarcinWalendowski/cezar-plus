import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLUSTER_PROTOCOL, type ClusterDownlinkFrame, type ClusterPresenceFrame, type ClusterUplinkFrame } from '@loki-labs/cezar-plus-contract';
import { collectRepoFreshness } from './peers.ts';
import { startSpokeRuntime, type OutboxDiscovery, type SpokeLink } from './spoke-runtime.ts';

/**
 * **The silent heartbeat wedge (2026-08-23).**
 *
 * `peers.ts#runGit` ran `git` with no `timeout`, so a `git` that never exits — a credential prompt
 * on stdin, a hung remote, an NFS/FUSE stall, `.git/index.lock` contention — left its promise
 * permanently unsettled. `spoke-runtime.ts#beat` guards against overlapping presence collections
 * with a flag cleared in a `finally`, and **a `finally` behind an await that never settles never
 * runs**, so that flag latched `true` forever and the node stopped beating. The early
 * `if (beatInFlight) return` logged nothing, counted nothing and stamped nothing, so there was no
 * detection path at all: the event loop stayed healthy, the websocket kept ponging, the hub's
 * `reap()` never fired, and the hub went on serving the node's LAST presence frame — almost always
 * `active: 0`, i.e. maximum headroom, which makes the wedged node the one `placement.ts` prefers.
 * A dead node the placer is attracted to, not merely a dead node.
 *
 * Two independent bounds are on trial here, and they are not redundant:
 *
 *  1. **`peers.ts` bounds every git it runs** — its own `execFile` AND the three `server/git.ts`
 *     helpers a presence beat calls, which have no `timeout` either. Closes today's instance.
 *  2. **`spoke-runtime.ts` bounds the whole beat** and owns the guard by GENERATION rather than by
 *     boolean. Closes the class: `collectPresence` is a caller-supplied dep and the beat body will
 *     grow awaits it does not have today.
 *
 * The traps this file is written against, in order of how easily they produce a green that means
 * nothing:
 *
 *  - **"no more beats happen" passes trivially against code that never beats.** Every wedge case
 *    below therefore asserts recovery POSITIVELY, on frames whose `capacity.active` identifies the
 *    exact `collectPresence` call that produced them, and on the count continuing to grow after
 *    recovery — never on an absence.
 *  - **a concurrency test over a path with no real await boundary cannot fail.** The hangs here are
 *    genuine never-settling promises and genuine unkillable child processes, not mocked rejections.
 *  - **a fixture that `execFile`'s own `timeout` can already handle would leave the outer deadline
 *    untested.** Measured on Node v22.12.0: `{ timeout, killSignal: 'SIGTERM' }` settles for a
 *    child that dies on the signal — even with a grandchild holding the inherited stdout pipe, so
 *    the "still-open pipe" hazard does not reproduce on this Node — but stays **pending forever**
 *    for a child that does NOT die, with `child.killed === true` and `child.exitCode === null`. The
 *    git fixture below is deliberately of that second kind, and `pins the fixture` below asserts it
 *    is, so the outer deadline is genuinely on trial rather than decorative.
 */

// ---------------------------------------------------------------------------------------------
// Part A — the class: any unsettled await inside beat() must not latch the guard
// ---------------------------------------------------------------------------------------------

/** Same plain fake as `spoke-runtime.test.ts` uses — no socket, no `ClusterLinkClient`. Kept local
 *  rather than exported from there because that file is owned by another session right now. */
function createFakeLink() {
  const listeners: Array<(frame: ClusterDownlinkFrame) => void> = [];
  const sent: ClusterUplinkFrame[] = [];
  const send = vi.fn((frame: ClusterUplinkFrame): boolean => {
    sent.push(frame);
    return true;
  });
  const on = vi.fn((_event: 'frame', listener: (frame: ClusterDownlinkFrame) => void) => {
    listeners.push(listener);
  });
  const off = vi.fn((_event: 'frame', listener: (frame: ClusterDownlinkFrame) => void) => {
    const idx = listeners.indexOf(listener);
    if (idx !== -1) listeners.splice(idx, 1);
  });
  const link: SpokeLink = { send, on, off };
  return { link, sent };
}

/** `capacity.active` carries the collection's call number, so every assertion below can name WHICH
 *  `collectPresence` call produced a frame. A frame is then positive evidence of a specific beat
 *  having run, not merely evidence that something was sent. */
function presenceWith(call: number): ClusterPresenceFrame {
  return {
    type: 'presence',
    protocol: CLUSTER_PROTOCOL,
    capacity: { maxParallel: 4, active: call, heavyActive: 0, enforcement: 'none' },
    repoDrift: [],
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const NOOP_OUTBOX = async (): Promise<OutboxDiscovery> => ({ nodeId: undefined, projects: [], acceptsDispatch: false });
const NOOP_RESOLVE_MANAGER = async (): Promise<undefined> => undefined;

function skipWarnings(warn: ReturnType<typeof vi.fn>): string[] {
  return warn.mock.calls.map(([m]) => m as string).filter((m) => m.includes('presence beat SKIPPED') || m.includes('presence beat has now SKIPPED'));
}

describe('spoke presence beat — an unsettled await must not latch the reentrancy guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('abandons a presence collection that never settles, releases the guard, and the NEXT beat really beats', async () => {
    const { link, sent } = createFakeLink();
    const warn = vi.fn();
    let call = 0;
    const collectPresence = vi.fn((): Promise<ClusterPresenceFrame> => {
      call += 1;
      // A GENUINE never-settling promise, not a rejection and not a long timer. This is the shape
      // an unbounded `execFile` produced, and it is the only shape that reaches the defect: a
      // rejection would run the `finally` and clear the flag, which is why the pre-existing
      // "collectPresence() rejection is warned and skipped" test never caught this.
      if (call === 1) return new Promise<ClusterPresenceFrame>(() => {});
      return Promise.resolve(presenceWith(call));
    });

    const handle = startSpokeRuntime({
      resolveDispatchManager: NOOP_RESOLVE_MANAGER,
      link,
      heartbeatMs: 1_000,
      // Deliberately NOT a multiple of `heartbeatMs`: at a coincident timestamp the deadline and
      // the interval tick are both due, and which runs first is a fake-timer scheduling detail
      // this test has no business depending on. 4_500 lands strictly between ticks, so each
      // assertion below is about one event.
      beatDeadlineMs: 4_500,
      collectPresence,
      collectOutboxProjects: NOOP_OUTBOX,
      warn,
    });

    await vi.advanceTimersByTimeAsync(0); // the immediate beat starts, and hangs
    expect(sent).toHaveLength(0);
    expect(handle.beatHealth().inFlight).toBe(true);
    expect(handle.beatHealth().lastCompletedAt).toBeUndefined();

    // Four ticks inside the deadline. Every one of them skips — that much is CORRECT behaviour
    // (the previous beat really is still in flight). Before the fix, so did every tick after them,
    // for the life of the process.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(collectPresence).toHaveBeenCalledTimes(1);
    expect(handle.beatHealth().consecutiveSkips).toBe(4);
    expect(sent).toHaveLength(0);

    // The deadline fires, between the t=4000 and t=5000 ticks.
    await vi.advanceTimersByTimeAsync(500);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exceeded its 4500ms deadline and was ABANDONED'));
    expect(handle.beatHealth().inFlight).toBe(false);
    expect(collectPresence).toHaveBeenCalledTimes(1); // abandoning does not itself start a beat

    // ---- the positive half: the loop does not merely stop being stuck, it RESUMES --------------
    await vi.advanceTimersByTimeAsync(500);
    expect(collectPresence).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(1);
    // Content-bearing, and attributable: `active: 2` can only have come from the SECOND collection.
    // "a frame was sent" would also pass against a replayed or fabricated one.
    expect((sent[0] as ClusterPresenceFrame).capacity.active).toBe(2);
    expect(handle.beatHealth().consecutiveSkips).toBe(0);
    expect(handle.beatHealth().lastCompletedAt).toEqual(expect.any(String));

    // And keeps beating — one unlatch is not recovery.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent.map((f) => (f as ClusterPresenceFrame).capacity.active)).toEqual([2, 3, 4, 5]);

    handle();
  });

  it('negative control: on the healthy path nothing above fires — no skip, no deadline, no recovery line', async () => {
    // Without this, every assertion in the test above could be passing because the runtime warns
    // and counts unconditionally, and "consecutiveSkips: 0" after recovery would be untested.
    const { link, sent } = createFakeLink();
    const warn = vi.fn();
    let call = 0;
    const collectPresence = vi.fn(async () => presenceWith(++call));

    const handle = startSpokeRuntime({
      resolveDispatchManager: NOOP_RESOLVE_MANAGER,
      link,
      heartbeatMs: 1_000,
      beatDeadlineMs: 5_000,
      collectPresence,
      collectOutboxProjects: NOOP_OUTBOX,
      warn,
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sent.map((f) => (f as ClusterPresenceFrame).capacity.active)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(skipWarnings(warn)).toEqual([]);
    expect(warn.mock.calls.filter(([m]) => (m as string).includes('deadline'))).toEqual([]);
    expect(warn.mock.calls.filter(([m]) => (m as string).includes('recovered'))).toEqual([]);
    expect(handle.beatHealth().consecutiveSkips).toBe(0);
    expect(handle.beatHealth().inFlight).toBe(false);

    handle();
  });

  it('an abandoned beat that settles LATE neither releases a newer beat’s guard nor sends its stale claim', async () => {
    // This is what a plain boolean flag cannot express, and it is the reason the guard is a
    // generation. Cleared from outside (a watchdog) or cleared by the zombie's own `finally`, a
    // boolean would let two presence collections run at once — exactly the hazard the guard exists
    // for — and would put a pre-stall capacity number on the wire, which the hub stamps with its
    // OWN arrival time and therefore presents as current.
    const { link, sent } = createFakeLink();
    const warn = vi.fn();
    const first = deferred<ClusterPresenceFrame>();
    const second = deferred<ClusterPresenceFrame>();
    let call = 0;
    const collectPresence = vi.fn((): Promise<ClusterPresenceFrame> => {
      call += 1;
      if (call === 1) return first.promise;
      if (call === 2) return second.promise;
      return Promise.resolve(presenceWith(call));
    });

    const handle = startSpokeRuntime({
      resolveDispatchManager: NOOP_RESOLVE_MANAGER,
      link,
      heartbeatMs: 1_000,
      // Off-tick for the same reason as the first case — see the comment there.
      beatDeadlineMs: 2_500,
      collectPresence,
      collectOutboxProjects: NOOP_OUTBOX,
      warn,
    });

    await vi.advanceTimersByTimeAsync(0); // beat 1 starts, hangs
    await vi.advanceTimersByTimeAsync(2_500); // its deadline fires; the guard is released
    expect(handle.beatHealth().inFlight).toBe(false);
    expect(collectPresence).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500); // t=3000: beat 2 starts, and also hangs
    expect(collectPresence).toHaveBeenCalledTimes(2);
    expect(handle.beatHealth().inFlight).toBe(true);

    // Beat 1 comes back from the dead, holding a capacity number computed before the stall.
    first.resolve(presenceWith(1));
    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toHaveLength(0); // the stale claim is dropped, not put on the wire
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('already been abandoned at its deadline settled late'));
    expect(handle.beatHealth().inFlight).toBe(true); // beat 2 still owns the loop

    // The decisive assertion: the next tick must still SKIP. If the zombie had cleared the flag,
    // this tick would start a THIRD concurrent collection.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(collectPresence).toHaveBeenCalledTimes(2);

    // ...and beat 2, when it finally answers, is the one that gets to speak.
    second.resolve(presenceWith(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect((sent[0] as ClusterPresenceFrame).capacity.active).toBe(2);

    handle();
  });

  it('reports a stall on the first skip and then every 10th, never once per tick, and recovers loudly', async () => {
    // Silence was the actual defect, so the counter and the log rate are both on trial. The rate
    // matters on this branch specifically: a permissive gate here once wrote 11 notes/sec.
    const { link, sent } = createFakeLink();
    const warn = vi.fn();
    const first = deferred<ClusterPresenceFrame>();
    let call = 0;
    const collectPresence = vi.fn((): Promise<ClusterPresenceFrame> => {
      call += 1;
      return call === 1 ? first.promise : Promise.resolve(presenceWith(call));
    });

    const handle = startSpokeRuntime({
      resolveDispatchManager: NOOP_RESOLVE_MANAGER,
      link,
      heartbeatMs: 1_000,
      // Far beyond the window this test drives, so the stall is held open by the hang itself and
      // the skip accounting is measured on its own, with no abandonment interfering.
      beatDeadlineMs: 10_000_000,
      collectPresence,
      collectOutboxProjects: NOOP_OUTBOX,
      warn,
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(25_000); // 25 ticks, every one of them a skip

    expect(handle.beatHealth().consecutiveSkips).toBe(25);
    expect(handle.beatHealth().msSinceLastCompleted).toBeUndefined(); // no beat has EVER completed

    // 25 skips produce 3 lines: the first, then the 10th and the 20th. One line per tick would be
    // 25 — at the shipped 30s cadence that is the difference between ~12 lines/hour and ~120.
    const lines = skipWarnings(warn);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('presence beat SKIPPED');
    expect(lines[1]).toContain('SKIPPED 10 consecutive ticks');
    expect(lines[2]).toContain('SKIPPED 20 consecutive ticks');

    // None of them may contain the phrase "presence heartbeat": `spoke-runtime.test.ts` counts
    // occurrences of exactly that string to prove the LINK-OUTAGE warning fires once per outage.
    // Two different conditions must not be greppable as one.
    expect(lines.filter((m) => m.includes('presence heartbeat'))).toEqual([]);

    // Recovery is reported, the counter resets, and the loop resumes with real frames.
    first.resolve(presenceWith(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('recovered after 25 skipped tick(s)'));
    expect(handle.beatHealth().consecutiveSkips).toBe(0);
    expect(sent.map((f) => (f as ClusterPresenceFrame).capacity.active)).toEqual([1]);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent.map((f) => (f as ClusterPresenceFrame).capacity.active)).toEqual([1, 2, 3]);

    handle();
  });
});

// ---------------------------------------------------------------------------------------------
// Part B — the instance: peers.ts must bound a real, genuinely unkillable git
// ---------------------------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

/**
 * Real child processes and real timers. An injected fake would prove the wrapper's arithmetic and
 * nothing about `execFile`'s actual settlement behaviour — which is the entire subject here, and
 * which turned out NOT to be what the obvious reading of the docs suggests.
 */
describe('peers.ts — every git it runs is bounded, including one that ignores the kill signal', () => {
  let dir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-git-wedge-'));
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A `git` that cannot be reaped by the default `killSignal`. `trap '' TERM` in the shell stands
   * in for the production shape — a process blocked in uninterruptible I/O on a stalled NFS/FUSE
   * mount, which ignores SIGKILL too, and which is why the outer deadline settles OUR promise
   * rather than merely escalating the signal and hoping.
   *
   * `sleep 8`, not `sleep infinity`: the escalation kills the shell but not the `sleep` it forked,
   * so a finite one lets the orphan clear itself a few seconds after the run instead of lingering
   * for the life of the machine. It must stay comfortably ABOVE the elapsed bound asserted below —
   * a fixture that self-terminates near it would let unbounded code pass on a technicality.
   */
  function installUnkillableGit(): string {
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, 'git');
    writeFileSync(fake, "#!/bin/sh\ntrap '' TERM\nsleep 8\n");
    chmodSync(fake, 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    return fake;
  }

  it(
    'pins the fixture: execFile’s own timeout does NOT settle for this child, so the outer deadline is genuinely on trial',
    async () => {
      // If this ever fails, the fixture has stopped exercising the outer deadline (a Node release
      // that escalates on its own, or a shell that no longer honours the trap) — it is NOT a
      // regression in `peers.ts`. Read it as "rebuild the fixture", not "the bound broke".
      const fake = installUnkillableGit();
      const pending = execFileAsync(fake, [], { timeout: 250, killSignal: 'SIGTERM', encoding: 'utf8' });
      const outcome = await Promise.race([
        pending.then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise<string>((r) => setTimeout(() => r('still-pending'), 1_500)),
      ]);
      expect(outcome).toBe('still-pending');
      expect(pending.child.killed).toBe(true); // the signal WAS sent...
      expect(pending.child.exitCode).toBeNull(); // ...and the process is still alive
      pending.child.kill('SIGKILL');
      pending.child.stdout?.destroy();
      pending.child.stderr?.destroy();
    },
    15_000,
  );

  it(
    'collectRepoFreshness returns instead of hanging when every git stalls, and says so',
    async () => {
      // Before the fix this call never resolves and the case fails as a vitest test timeout.
      installUnkillableGit();
      const warn = vi.fn();
      const started = Date.now();

      const freshness = await collectRepoFreshness('pk-wedged', dir, {
        env: { ...process.env, CEZ_CLUSTER_GIT_TIMEOUT_MS: '250' },
        warn,
      });
      const elapsed = Date.now() - started;

      // 250ms timeout + the 2s SIGKILL grace ≈ 2.25s, with headroom for a loaded box. THIS is the
      // assertion that means "it did not hang" — the fixture's git runs for 8s, so unbounded code
      // fails here rather than merely forgetting to warn. The lower bound catches the opposite
      // cheat: a "bound" that returns immediately without ever attempting the git.
      expect(elapsed).toBeGreaterThanOrEqual(2_000);
      expect(elapsed).toBeLessThan(4_500);

      // Degraded honestly, on the values this schema can express.
      expect(freshness.projectKey).toBe('pk-wedged');
      expect(freshness.headSha).toBe('0'.repeat(40));
      expect(freshness.ahead).toBe(0);
      expect(freshness.behind).toBe(0);
      expect(freshness.dirty).toBe(0);
      expect(freshness.merging).toBe(false);

      // ...and NOT silently. All four calls stalled — `runGit`'s two plus the two `server/git.ts`
      // helpers, which have no `timeout` of their own and would still hang if only `runGit` had
      // been fixed. That count is what proves the bound is at the right layer.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('4 of 4 git commands for "pk-wedged"'));
      expect(warn.mock.calls.filter(([m]) => (m as string).includes('git commands'))).toHaveLength(1);
    },
    15_000,
  );

  it(
    'negative control: with the real git and a real repo it reports real values and never claims a timeout',
    async () => {
      // Without this, the case above could pass against a `collectRepoFreshness` that had stopped
      // running git at all — every degraded value it asserts is also what "did nothing" produces.
      const work = join(dir, 'repo');
      mkdirSync(work, { recursive: true });
      const id = ['-c', 'user.email=t@test', '-c', 'user.name=t'];
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: work });
      writeFileSync(join(work, 'README.md'), 'hello\n');
      execFileSync('git', [...id, 'add', '-A'], { cwd: work });
      execFileSync('git', [...id, 'commit', '-q', '-m', 'seed'], { cwd: work });
      writeFileSync(join(work, 'scratch.txt'), 'uncommitted\n');

      const warn = vi.fn();
      const freshness = await collectRepoFreshness('pk-real', work, { env: process.env, warn });

      expect(freshness.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(freshness.headSha).not.toBe('0'.repeat(40));
      expect(freshness.dirty).toBeGreaterThan(0); // the untracked scratch file
      expect(freshness.merging).toBe(false);
      expect(warn.mock.calls.filter(([m]) => (m as string).includes('git commands'))).toEqual([]);
    },
    15_000,
  );
});
