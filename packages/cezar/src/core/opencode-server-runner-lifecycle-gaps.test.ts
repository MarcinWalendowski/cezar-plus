import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './agent-runner.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';

const spawnHook = vi.hoisted(() => ({ override: null as null | (() => unknown) }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      spawnHook.override ? spawnHook.override() : actual.spawn(...args),
  };
});

function isError(e: AgentEvent): e is Extract<AgentEvent, { type: 'error' }> {
  return e.type === 'error';
}

/** A fake ChildProcess whose lifecycle the test drives directly by emitting on it — no real
 *  process, no real 'exit'/'close'/'error' unless the test fires one. `kill()` is recorded but
 *  otherwise a no-op: what these tests exercise is what the runner does around a child it never
 *  sees exit on its own terms, not the OS signal path (that's `opencode-server-runner.test.ts` and
 *  `opencode-server-runner-exit-gate.test.ts`'s job). */
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
    pid: 4343,
    kill: (signal: NodeJS.Signals) => {
      kills.push(signal);
      return true;
    },
  }) as unknown as ChildProcessWithoutNullStreams;
  return { child, stdout, kills };
}

/**
 * `opencode-server-runner.ts` — two lifecycle gaps found alongside the exit gate
 * (`opencode-server-runner-exit-gate.test.ts`) but distinct from it and from each other:
 *
 * 1. `child.on('error')` only ever set `spawnFailed`; it never resolved `this.exited`. Node makes
 *    no promise that a post-fork spawn error (EACCES, an exec that dies before assignment) is
 *    followed by an `'exit'` event, so `result`'s unconditional `await this.exited` after the
 *    try/catch/finally could hang forever, and every teardown path that awaits `this.exited` would
 *    hang with it — a permanent hang, not a wrong answer, and invisible in a way a bad result
 *    is not (no error, no timeout, no event).
 * 2. `bootstrap()` awaits `this.prompt(first)` unguarded. A teardown cezar itself initiates
 *    (`end()`/`interrupt()`) while that first-turn POST is still in flight turns the broken
 *    connection into a generic `fetch` rejection that propagated through `this.ready` and
 *    surfaced as an `opencode: <fetch error>` error event on a shutdown cezar asked for.
 */
describe('OpencodeServerRunner — child.on(error) without a following exit/close', () => {
  afterEach(() => {
    spawnHook.override = null;
    vi.unstubAllGlobals();
  });

  it("resolves this.exited from the 'error' handler so the result promise settles instead of hanging forever", async () => {
    const { child, stdout } = fakeChild();
    spawnHook.override = () => child;
    vi.stubGlobal('fetch', async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:1234');
    });

    const events: AgentEvent[] = [];
    const runner = new OpencodeServerRunner({ bin: 'opencode', timeoutMs: 60_000 });
    const session = runner.startSession(
      { userPrompt: 'do it', cwd: process.cwd() },
      (e) => events.push(e),
      { autoEndAfterFirstTurn: false },
    );

    // The server prints its banner (so urlReady resolves fast, not via its own 30s fallback) —
    // then a post-fork spawn error fires anyway, with no 'exit'/'close' behind it. That absence
    // is the point of this test.
    stdout.write('opencode server listening on http://127.0.0.1:1234\n');
    const emitter = child as unknown as EventEmitter;
    const spawnError = Object.assign(new Error('spawn opencode EACCES'), { code: 'EACCES' });
    emitter.emit('error', spawnError);

    // An explicit race, not a naive await: a promise that never settles would otherwise pass by
    // hanging until Vitest's own test timeout, which reads as a slow pass rather than a failure.
    const settled = session.result.then(
      (): { hung: false; ok: true } => ({ hung: false, ok: true }),
      (e: unknown): { hung: false; ok: false; message: string } => ({
        hung: false,
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      }),
    );
    const clock = new Promise<{ hung: true }>((resolve) => setTimeout(() => resolve({ hung: true }), 2000));
    const race = await Promise.race([settled, clock]);

    expect(race.hung).toBe(false);
    if (!race.hung) {
      expect(race.ok).toBe(false);
      if (!race.ok) expect(race.message).toMatch(/EACCES/);
    }
    // The catch in `result` ran before spawnFailed's throw superseded it — proves the emit path
    // that must still fire for a REAL failure (not suppressed the way a cezar-initiated teardown
    // is, per the sibling describe block below).
    expect(events.some((e) => isError(e) && /ECONNREFUSED/.test(e.message))).toBe(true);
  }, 10_000);
});

describe('OpencodeServerRunner — bootstrap teardown race', () => {
  afterEach(() => {
    spawnHook.override = null;
    vi.unstubAllGlobals();
  });

  it("a teardown that races bootstrap()'s unguarded first-turn POST does not surface as a run error", async () => {
    const { child, stdout } = fakeChild();
    spawnHook.override = () => child;

    let rejectMessagePost: ((err: unknown) => void) | undefined;
    let onMessagePosted: (() => void) | undefined;
    const messagePosted = new Promise<void>((resolve) => {
      onMessagePosted = resolve;
    });
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (url.endsWith('/event')) {
        return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }));
      }
      if (init?.method === 'POST' && url.endsWith('/session')) {
        return Promise.resolve(
          new Response(JSON.stringify({ id: 'ses_race_1' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      // POST /session/ses_race_1/message — bootstrap()'s unguarded `await this.prompt(first)`.
      // Never settles on its own; the test rejects it manually AFTER tearing the session down,
      // standing in for the connection breaking once the (real) server process the fetch was
      // talking to has actually been killed.
      return new Promise((_resolve, reject) => {
        rejectMessagePost = reject;
        onMessagePosted?.();
      });
    });

    const events: AgentEvent[] = [];
    const runner = new OpencodeServerRunner({ bin: 'opencode', timeoutMs: 60_000 });
    const session = runner.startSession(
      { userPrompt: 'do it', cwd: process.cwd() },
      (e) => events.push(e),
      { autoEndAfterFirstTurn: false },
    );
    stdout.write('opencode server listening on http://127.0.0.1:1234\n');

    await messagePosted;
    // Floor: this really is racing the in-flight first-turn POST — a session id came back and
    // the request the test is about to break has actually been sent, not merely scheduled.
    expect(events.some((e) => e.type === 'session' && e.sessionId === 'ses_race_1')).toBe(true);
    expect(events.some(isError)).toBe(false);

    session.end();
    // Simulate what a real kill does: the process dies (exit/close land on the child)...
    const emitter = child as unknown as EventEmitter;
    emitter.emit('exit', null, 'SIGTERM');
    emitter.emit('close', null, 'SIGTERM');
    // ...which is what breaks the in-flight connection the first-turn POST was waiting on.
    rejectMessagePost?.(Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') }));

    const result = await session.result;

    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(events.some(isError)).toBe(false);
    expect(result.sessionId).toBe('ses_race_1');
  }, 10_000);
});
