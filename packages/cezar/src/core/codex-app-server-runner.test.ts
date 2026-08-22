import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './agent-runner.js';
import { KILL_GRACE_MS } from './claude-cli-runner.js';
import { CodexAppServerRunner } from './codex-app-server-runner.js';

/** Only the escalation tests below swap the child out; every other test in this
 *  file keeps spawning the real mock app-server through the untouched `spawn`. */
const spawnHook = vi.hoisted(() => ({ override: null as null | (() => unknown) }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      spawnHook.override ? spawnHook.override() : actual.spawn(...args),
  };
});

/**
 * #703 backend parity — `claude-cli-runner.test.ts` proves the Claude half;
 * this is the same session-level shape for Codex. The fix only holds if BOTH
 * runners classify a cezar-initiated 128+signal exit as a teardown note rather
 * than an agent failure, so the Codex branch needs its own regression.
 */
describe('a teardown cezar initiated (codex app-server)', () => {
  const mockBin = fileURLToPath(
    new URL('./__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url),
  );

  it('settles the session instead of failing it when the app-server exits 143', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    let sawText: () => void = () => {};
    const firstText = new Promise<void>((resolve) => {
      sawText = resolve;
    });
    const session = runner.startSession(
      // MOCK_CODEX_IGNORE_EOF makes the mock stay deaf to stdin EOF and exit
      // 143 on SIGTERM — the real shape reported in #703.
      { userPrompt: 'check the working tree', cwd: process.cwd(), env: { MOCK_CODEX_IGNORE_EOF: '1' } },
      (event) => {
        events.push(event);
        if (event.type === 'text') sawText();
      },
    );
    await firstText;

    // The cancel path; the EOF watchdog reaches the same `terminatedByCezar`.
    session.interrupt();
    const result = await session.result;

    expect(result.text).toBe('Checking the working tree.');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(
      events.some((e) => e.type === 'note' && e.message.includes('terminated by cezar (code 143)')),
    ).toBe(true);
  }, 15_000);

  it('surfaces a failed turn as an AgentEvent error', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'mock:turn-failed', cwd: process.cwd() },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );

    await session.result;

    expect(events).toContainEqual({ type: 'error', message: 'model unavailable' });
    expect(events).toContainEqual({ type: 'turn-end' });
  }, 15_000);

  /**
   * The production regression (`.ai/specs/2026-08-22-failed-turn-reads-as-done.md`). The test
   * above only ever proved the `turn/failed` METHOD, which codex does not send for a provider
   * rejection: it sends `turn/completed` with `status: "failed"`, and the runner emitted no error
   * at all for it. Five runs on prod-host marked all eight steps `done` on the strength of
   * that, having produced zero tokens and an empty diff.
   */
  it('fails the turn when codex rejects the model, even though the method says completed', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'mock:provider-rejected', cwd: process.cwd() },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );

    await session.result;

    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    // The provider's verbatim reason reaches the thread, so the cause is readable without ssh.
    expect(errors[0]).toMatchObject({ message: expect.stringContaining('is not supported when using Codex') });
    // The warning that named the bad model id is kept as a note rather than dropped.
    expect(
      events.some((e) => e.type === 'note' && e.message.includes('Model metadata for `sonnet` not found')),
    ).toBe(true);
  }, 15_000);

  /**
   * Covers the `error` notification ON ITS OWN. Mutation-tested: deleting the `error` case while
   * keeping the turn-status fix left every other test in this file green, because a failed turn
   * reports itself. This is the shape that has no second channel — codex states the problem out
   * of band and the turn still ends `completed`, which is what a mid-turn stream drop looks like.
   */
  it('surfaces an out-of-band error even when the turn itself ends clean', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'mock:error-then-clean-turn', cwd: process.cwd() },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );

    await session.result;

    expect(events.filter((e) => e.type === 'error')).toEqual([
      { type: 'error', message: 'stream disconnected before completion' },
    ]);
  }, 15_000);

  /** `willRetry: true` is codex saying it is handling this itself. Failing the step on a blip it
   *  is about to retry would trade the old silent-success bug for a noisy-failure one. */
  it('records a retryable error as a note, not a step failure', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'mock:error-will-retry', cwd: process.cwd() },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );

    await session.result;

    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(events.some((e) => e.type === 'note' && e.message.includes('rate limited, retrying'))).toBe(true);
  }, 15_000);

  /** Negative control for the two tests above: a healthy turn emits no error. Without this, code
   *  that called every turn a failure would pass them both. */
  it('leaves a healthy turn clean', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'check the working tree', cwd: process.cwd() },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );

    await session.result;

    expect(events.filter((e) => e.type === 'error')).toEqual([]);
  }, 15_000);
});

/**
 * #844 — the runner's own SIGTERM sets `ChildProcess.killed`, so a watchdog
 * gated on `!child.killed` refused to escalate for exactly the app-server it
 * was written for: one that handles the signal and keeps running. The guard now
 * tracks real termination, and `terminatedByCezar` (#703) is still set before
 * every signal so the resulting 137/143 stays a teardown note, not a failure.
 */
describe('SIGTERM→SIGKILL escalation for an app-server that survives SIGTERM', () => {
  function signallableChild(): {
    child: ChildProcessWithoutNullStreams;
    signals: NodeJS.Signals[];
    exit: (code: number) => void;
  } {
    const signals: NodeJS.Signals[] = [];
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      pid: 4243,
      // Node's semantics: delivery flips `killed` whether or not the child dies.
      kill: (signal: NodeJS.Signals) => {
        signals.push(signal);
        Object.assign(child, { killed: true });
        return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    const exit = (code: number) => {
      Object.assign(child, { exitCode: code });
      emitter.emit('exit', code, null);
    };
    return { child, signals, exit };
  }

  function withFakeChild(run: (fake: ReturnType<typeof signallableChild>) => void): void {
    const fake = signallableChild();
    spawnHook.override = () => fake.child;
    vi.useFakeTimers();
    try {
      run(fake);
    } finally {
      vi.useRealTimers();
      spawnHook.override = null;
    }
  }

  it('escalates on the wall-clock timeout even after Node flagged the child as killed', () => {
    withFakeChild((fake) => {
      const session = new CodexAppServerRunner({ bin: 'codex', timeoutMs: 20 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);

      vi.advanceTimersByTime(20);
      expect(fake.signals).toEqual(['SIGTERM']);
      // Delivered, not dead — the state that used to disable the escalation.
      expect(fake.child.killed).toBe(true);
      expect(fake.child.exitCode).toBeNull();

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('stops escalating once the app-server really exits after SIGTERM', () => {
    withFakeChild((fake) => {
      const session = new CodexAppServerRunner({ bin: 'codex', timeoutMs: 20 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);

      vi.advanceTimersByTime(20);
      expect(fake.signals).toEqual(['SIGTERM']);
      fake.exit(143);

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
    });
  });

  it('does not signal a second time once interrupt() saw the child exit', () => {
    withFakeChild((fake) => {
      const session = new CodexAppServerRunner({ bin: 'codex', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);
      fake.exit(0);

      session.interrupt();
      expect(fake.signals).toEqual([]);
    });
  });
});

/**
 * A run whose agent was killed by an untrapped signal used to report `done`, and the workflow
 * continued as though the step had succeeded — the same defect fixed for the claude backend in
 * `claude-cli-runner.ts` (#703's follow-up). `waitForCodexAppServerExit` discarded the signal
 * before any branch could see it, so `code === null` alone read as a clean exit no matter who
 * sent the signal or why — the kernel OOM killer, a cgroup bound, or an operator's `kill -9`.
 */
describe('an external signal kills the agent process directly (OOM killer / operator kill -9)', () => {
  const mockBin = fileURLToPath(
    new URL('./__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url),
  );

  it('a real subprocess killed by an untrapped SIGKILL fails the run and names the signal', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      // MOCK_CODEX_SUICIDE_SIGKILL completes the real handshake, streams a bit of the turn to
      // prove the session is live, then kills itself — nothing cezar did caused this.
      { userPrompt: 'do it', cwd: process.cwd(), env: { MOCK_CODEX_SUICIDE_SIGKILL: '1' } },
      (event) => events.push(event),
    );

    await expect(session.result).rejects.toThrow(/SIGKILL/);
    expect(events.some((e) => e.type === 'error' && e.message.includes('SIGKILL'))).toBe(true);
    // The damaging property of the bug: a `done` landing right after the signal, which is what let
    // the run manager treat the step as finished.
    expect(events.some((e) => e.type === 'done')).toBe(false);
  }, 15_000);

  it.each([0, 1, 2])('floor: ordinary exit code %i with no signal is untouched by this fix', async (code) => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const session = runner.startSession(
      { userPrompt: 'do it', cwd: process.cwd(), env: { MOCK_CODEX_EXIT_CODE: String(code) } },
    );

    if (code === 0) {
      await expect(session.result).resolves.toMatchObject({ text: '' });
    } else {
      await expect(session.result).rejects.toThrow(`codex app-server exited with code ${code}`);
    }
  }, 15_000);

  /**
   * Negative control: cezar's own SIGTERM→SIGKILL escalation reaching an untrapped death produces
   * the IDENTICAL `code: null, signal: 'SIGKILL'` shape an external kill does — `terminatedByCezar`
   * is the only thing that tells them apart. Without this, "treat every signal as failure" would
   * pass the positive test above and break every cancel/EOF teardown that outlives its grace
   * window. Real subprocess, real ~12s EOF_TERM_GRACE_MS + EOF_KILL_GRACE_MS wait — deliberately
   * not faked, so the escalation genuinely has to punch through a live process's ignored SIGTERM.
   */
  it("negative control: cezar's own SIGTERM→SIGKILL escalation is NOT an external-kill failure", async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    let sawText: () => void = () => {};
    const firstText = new Promise<void>((resolve) => {
      sawText = resolve;
    });
    const session = runner.startSession(
      // MOCK_CODEX_IGNORE_SIGTERM stays alive through both EOF and SIGTERM — only the SIGKILL
      // cezar's own escalation ends with can end it.
      { userPrompt: 'check the working tree', cwd: process.cwd(), env: { MOCK_CODEX_IGNORE_SIGTERM: '1' } },
      (event) => {
        events.push(event);
        if (event.type === 'text') sawText();
      },
    );
    await firstText;

    session.end();
    const result = await session.result;

    // The untrapped-signal shape (`code: null, signal: 'SIGKILL'`) never matches
    // `isSignalTerminationExit` (that predicate is for the 128+signal codes a CLI that TRAPS the
    // signal reports), so this resolves via the plain fall-through path — no error, no note, just
    // the turn's own result, exactly as it did before this fix existed.
    expect(result.text).toBe('Checking the working tree.');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'done' });
  }, 20_000);
});
