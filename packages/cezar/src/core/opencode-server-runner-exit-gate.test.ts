import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './agent-runner.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'opencode');
const MOCK_BIN = join(FIXTURES, 'mock-opencode-serve.mjs');
const MOCK_BIN_NONZERO_EXIT = join(FIXTURES, 'mock-opencode-serve-nonzero-exit.mjs');

// Only the "exit vs. close" describe below spawns a fake child; every other test in this file
// spawns the real bundled mock server, so `spawnHook.override` stays null for those and `spawn`
// passes straight through to the real implementation.
const spawnHook = vi.hoisted(() => ({ override: null as null | (() => unknown) }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      spawnHook.override ? spawnHook.override() : actual.spawn(...args),
  };
});

/** Polls a predicate against the accumulated v1 event log — the only externally visible proof of
 *  internal state this runner offers (no getters for `sessionId`/`terminatedByCezar`). */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function isError(e: AgentEvent): e is Extract<AgentEvent, { type: 'error' }> {
  return e.type === 'error';
}

/**
 * `opencode-server-runner.ts` — exit gate (found during SPEC multi-node-cluster implementation,
 * "opencode-server-runner.ts can still report an externally-killed run as done, by a different
 * mechanism" than the `waitForExit`-drops-the-signal bug fixed for `claude`/`pi`/`codex`).
 *
 * This runner has NO exit gate at all: success was decided purely by the SSE session status
 * (`completed`/`error`) plus `this.timedOut`, and the tail of `result` unconditionally emitted
 * `done`. A kill mid-session whose stream never produces a `session.error` frame fell straight
 * through to `done` with whatever prose had streamed so far.
 *
 * The fix has to tell apart TWO cases that both end with the child process dying by signal:
 * cezar tearing its own server down (the NORMAL case here — `end()`/`interrupt()`/the result's
 * own `finally` all reach `terminate()`) from an untrapped external kill or crash the child
 * suffered on its own. `terminatedByCezar` is set at the moment `terminate()` actually sends a
 * signal, and is what every case below turns on.
 *
 * Tests against `mock-opencode-serve.mjs` (a real subprocess, real HTTP+SSE, spawned for real —
 * `spawnHook.override` below stays null for all of these) exercise the end-to-end shape cezar
 * actually runs; the reordered `exit`/`close` pair further down is a fast, deterministic unit
 * test of the capture logic itself, against a fake child whose event order we control directly.
 */
describe('OpencodeServerRunner exit gate — externally-killed vs. cezar-torn-down', () => {
  it('a run externally killed while the session is still live is NOT reported as done', async () => {
    const runner = new OpencodeServerRunner({ bin: MOCK_BIN, timeoutMs: 60_000 });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'check the working tree', cwd: process.cwd() },
      (e) => events.push(e),
      { autoEndAfterFirstTurn: false },
    );
    const settled = session.result.then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }),
    );

    // Wait for the first turn to actually finish (not just for bootstrap to start): killing
    // mid-POST would race an unrelated, pre-existing gap (`bootstrap()`'s unguarded
    // `await this.prompt(first)`) that has nothing to do with the exit gate under test here.
    await waitFor(() => events.some((e) => e.type === 'turn-end'));
    // Floor: bootstrap really succeeded (a real session id came back), a full turn ran, and
    // nothing has concluded the run yet — this is "still live", not "never started" or
    // "already done". `autoEndAfterFirstTurn: false` means nothing else will end it either.
    expect(events.some((e) => e.type === 'session' && e.sessionId === 'ses_mock_1')).toBe(true);
    expect(events.some((e) => e.type === 'done' || isError(e))).toBe(false);
    const pid = session.pid;
    expect(pid).toBeGreaterThan(0);

    // An external, untrapped kill — cezar never called end()/interrupt(), and the mock's SSE
    // stream never emits a session-level error frame for this.
    process.kill(pid!, 'SIGKILL');

    const result = await settled;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/SIGKILL/);
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(events.some((e) => isError(e) && /SIGKILL/.test(e.message))).toBe(true);
  }, 15_000);

  it('negative control: a healthy run reaching completed still emits done with its text/toolCalls/tokens', async () => {
    const runner = new OpencodeServerRunner({ bin: MOCK_BIN, timeoutMs: 60_000 });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'check the working tree', cwd: process.cwd() },
      (e) => events.push(e),
      { autoEndAfterFirstTurn: true },
    );
    const result = await session.result;

    // Floor: the turn genuinely ran (real streamed text, a real tool call) rather than this
    // passing because nothing happened.
    expect(result.text).toContain('Checking the working tree.');
    expect(result.toolCalls.some((t) => t.name === 'bash')).toBe(true);
    expect(result.tokensUsed).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(events.some(isError)).toBe(false);
  }, 15_000);

  it('negative control: the inactivity timeout still emits error/reason:inactivity, never a signal-kill', async () => {
    const runner = new OpencodeServerRunner({ bin: MOCK_BIN, timeoutMs: 500 });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'check the working tree', cwd: process.cwd() },
      (e) => events.push(e),
      { autoEndAfterFirstTurn: false },
    );
    const result = await session.result;

    // Floor: the session was genuinely live and made real progress (bootstrapped, streamed
    // text) before silence tripped the bound — this is "went idle", not "never started".
    expect(events.some((e) => e.type === 'session')).toBe(true);
    expect(events.some((e) => e.type === 'text')).toBe(true);

    const errorEvents = events.filter(isError);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]?.reason).toBe('inactivity');
    expect(errorEvents[0]?.message).not.toMatch(/signal|SIGTERM|SIGKILL/i);
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(result.sessionId).toBe('ses_mock_1');
  }, 15_000);

  it('negative control: an explicit end() still resolves normally', async () => {
    const runner = new OpencodeServerRunner({ bin: MOCK_BIN, timeoutMs: 60_000 });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'check the working tree', cwd: process.cwd() },
      (e) => events.push(e),
      { autoEndAfterFirstTurn: false },
    );

    // Wait for the first turn to actually finish, not just for bootstrap to start: ending
    // mid-flight races an unrelated, pre-existing gap (`bootstrap()`'s unguarded
    // `await this.prompt(first)` — a server killed mid-POST turns the fetch rejection into a
    // spurious `opencode: …` error event) that has nothing to do with the exit gate this test
    // is checking.
    await waitFor(() => events.some((e) => e.type === 'turn-end'));
    // Floor: bootstrapped for real and the turn completed before cezar tears it down itself.
    expect(events.some((e) => e.type === 'session' && e.sessionId === 'ses_mock_1')).toBe(true);

    session.end();
    const result = await session.result;

    expect(result.sessionId).toBe('ses_mock_1');
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(events.some(isError)).toBe(false);
  }, 15_000);

  it('negative control: an ordinary non-zero exit after cezar tears down a completed session is still done', async () => {
    const runner = new OpencodeServerRunner({ bin: MOCK_BIN_NONZERO_EXIT, timeoutMs: 60_000 });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'wrap it up', cwd: process.cwd() },
      (e) => events.push(e),
      { autoEndAfterFirstTurn: true },
    );
    const result = await session.result;

    // Floor: the session actually completed (real streamed text) before the mock's SIGTERM
    // handler exits 7 on its way out — this proves cezar's own teardown, not a lucky non-fire.
    expect(result.text).toContain('All done.');
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(events.some(isError)).toBe(false);
  }, 15_000);
});

/**
 * Unit-level coverage for `captureExit`'s ordering: a real child process always fires `exit`
 * (`trackChildExit`'s own `hasExited()` depends on that — it listens to nothing else), usually
 * followed by `close` once its stdio streams drain, but the relative order of the two is not
 * guaranteed. `captureExit` is registered on both and keeps only the first — this proves that
 * whichever one happens to arrive first, the recorded code/signal is the same and the gate reads
 * it the same way. (An event log that fires `close` with no `exit` at all cannot happen for a
 * real process, and isn't exercised here — see `trackChildExit`.)
 */
describe('OpencodeServerRunner exit gate — exit vs. close, whichever arrives first', () => {
  function fakeChild(): { child: ChildProcessWithoutNullStreams; stdout: PassThrough; kills: NodeJS.Signals[] } {
    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const kills: NodeJS.Signals[] = [];
    const child = Object.assign(emitter, {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      pid: 4242,
      kill: (signal: NodeJS.Signals) => {
        kills.push(signal);
        return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    return { child, stdout, kills };
  }

  /** Bare-minimum fetch double: POST /session, GET /event (a stream that never closes on its
   *  own — the test kills the child directly instead), POST /session/:id/message. */
  function installFakeFetch(): void {
    vi.stubGlobal(
      'fetch',
      async (url: string, init?: RequestInit) => {
        if (url.endsWith('/event')) {
          const body = new ReadableStream<Uint8Array>({ start() {} });
          return new Response(body, { status: 200 });
        }
        if (init?.method === 'POST' && url.endsWith('/session')) {
          return new Response(JSON.stringify({ id: 'ses_fake_1' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        // .../session/ses_fake_1/message
        return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    );
  }

  afterEach(() => {
    spawnHook.override = null;
    vi.unstubAllGlobals();
  });

  async function startLiveFakeSession(): Promise<{
    session: ReturnType<OpencodeServerRunner['startSession']>;
    child: ChildProcessWithoutNullStreams;
    events: AgentEvent[];
    kills: NodeJS.Signals[];
  }> {
    installFakeFetch();
    const { child, stdout, kills } = fakeChild();
    spawnHook.override = () => child;

    const runner = new OpencodeServerRunner({ bin: 'opencode', timeoutMs: 60_000 });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'do it', cwd: process.cwd() },
      (e) => events.push(e),
      { autoEndAfterFirstTurn: false },
    );
    stdout.write('opencode server listening on http://127.0.0.1:9999\n');

    // Floor: bootstrap ran the whole way through (session id back, first turn posted and
    // answered) before either exit path fires — "still live", not "never started".
    await waitFor(() => events.some((e) => e.type === 'turn-end'));
    expect(events.some((e) => e.type === 'session' && e.sessionId === 'ses_fake_1')).toBe(true);
    expect(events.some((e) => e.type === 'done' || isError(e))).toBe(false);

    return { session, child, events, kills };
  }

  it(
    "the listener-order guarantee: cezar's own finally-block terminate() never re-signals an " +
      'already (externally-)dead child, so terminatedByCezar cannot be set for one',
    async () => {
      // `hasExited = trackChildExit(this.child)` registers ITS 'exit' listener before
      // `captureExit` (constructor order) — Node fires same-event listeners synchronously, in
      // registration order, so `hasExited()` flips true within the same `emit()` call that
      // `captureExit` observes, strictly before `resolveExit()` even runs. `await this.exited`
      // can only continue on a LATER microtask, by which point `hasExited()` is already true.
      // So when the result's own `finally` reaches `terminate()`, its `hasExited()` guard is
      // already true and it must return WITHOUT calling `child.kill()` again — proven here
      // directly, not inferred: if the ordering were reversed, `terminate()` would send a
      // redundant SIGTERM and (wrongly) flip `terminatedByCezar = true`, which would make the
      // sibling "close/exit arrives before the other" tests below pass for the WRONG reason.
      const { session, child, kills } = await startLiveFakeSession();

      const emitter = child as unknown as EventEmitter;
      emitter.emit('exit', null, 'SIGKILL');
      emitter.emit('close', null, 'SIGKILL');

      await session.result.catch(() => undefined);
      expect(kills).toEqual([]);
    },
  );

  it('close arrives before exit for an untrapped signal kill — still fails, not done', async () => {
    const { session, child, events } = await startLiveFakeSession();

    const emitter = child as unknown as EventEmitter;
    emitter.emit('close', null, 'SIGKILL');
    emitter.emit('exit', null, 'SIGKILL');

    await expect(session.result).rejects.toThrow(/SIGKILL/);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('exit arrives before close for an untrapped signal kill — still fails, not done', async () => {
    const { session, child, events } = await startLiveFakeSession();

    const emitter = child as unknown as EventEmitter;
    emitter.emit('exit', null, 'SIGKILL');
    emitter.emit('close', null, 'SIGKILL');

    await expect(session.result).rejects.toThrow(/SIGKILL/);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });
});
