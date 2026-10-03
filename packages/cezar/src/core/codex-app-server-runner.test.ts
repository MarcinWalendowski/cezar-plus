import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './agent-runner.js';
import { KILL_GRACE_MS } from './claude-cli-runner.js';
import { CodexAppServerRunner } from './codex-app-server-runner.js';
import type { CodexResumeModel } from './codex-resume-model.js';

/** Only the escalation tests below swap the child out; every other test in this
 *  file keeps spawning the real mock app-server through the untouched `spawn`. */
const spawnHook = vi.hoisted(() => ({ override: null as null | (() => unknown) }));
/** Tees a spawned child's stderr into an array when set — the mock fixture echoes every
 *  `thread/start`/`thread/resume` request as `MOCK_RPC <method> <json>` (Phase 1b), and this is
 *  how a test reads the actual REQUEST rather than only the turn's outcome (spec Verification
 *  V3: "a passing turn does not prove the key was absent"). A tee, not a replacement — the
 *  runner's own stderr listener keeps working unmodified. */
const stderrHook = vi.hoisted(() => ({ capture: null as null | string[] }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = (spawnHook.override ? spawnHook.override() : actual.spawn(...args)) as ChildProcessWithoutNullStreams;
      if (stderrHook.capture) {
        const target = stderrHook.capture;
        child.stderr?.on('data', (chunk: Buffer | string) => target.push(chunk.toString()));
      }
      return child;
    },
  };
});

/** Starts capturing `MOCK_RPC` lines for the duration of one test; `stop()` returns the parsed
 *  `thread/start`/`thread/resume` requests seen so far, in order. */
function captureMockRpc(): { calls: () => Array<{ method: string; params: Record<string, unknown> }>; stop: () => void } {
  const chunks: string[] = [];
  stderrHook.capture = chunks;
  const parse = (): Array<{ method: string; params: Record<string, unknown> }> =>
    chunks
      .join('')
      .split('\n')
      .filter((line) => line.startsWith('MOCK_RPC '))
      .map((line) => {
        const rest = line.slice('MOCK_RPC '.length);
        const spaceIdx = rest.indexOf(' ');
        return { method: rest.slice(0, spaceIdx), params: JSON.parse(rest.slice(spaceIdx + 1)) };
      });
  return { calls: parse, stop: () => { stderrHook.capture = null; } };
}

/**
 * #703 backend parity — `claude-cli-runner.test.ts` proves the Claude half;
 * this is the same session-level shape for Codex. The fix only holds if BOTH
 * runners classify a cezar-initiated 128+signal exit as a teardown note rather
 * than an agent failure, so the Codex branch needs its own regression.
 */
describe('a teardown cezar initiated (codex app-server)', () => {
  const mockBin = fileURLToPath(
    new URL('../../scripts/mock-codex-app-server.mjs', import.meta.url),
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
      events.some((e) => e.type === 'note' && e.message.includes('terminated by cezar-plus (code 143)')),
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
 * #955 — a `contextCompaction` item is internal session maintenance, not the user being
 * handed the next action. The runner is the only layer that can tell the two apart, because
 * `turn/completed` looks identical either way by the time it reaches `RunManager`. These pin
 * the seam: the boundary rides out on the v1 `turn-end` as an ADDITIVE optional `reason`,
 * never as a new event type and never in place of the existing `contextCompaction` tool item.
 *
 * No redacted Luna trace was obtainable, so the fixture is built from the documented wire
 * contract — see the header of `mock-codex-app-server.mjs`.
 */
describe('a turn that ended at a context-compaction boundary (#955)', () => {
  const mockBin = fileURLToPath(
    new URL('./__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url),
  );

  /** Run one scripted prompt to completion and collect the v1 stream. */
  async function collect(userPrompt: string): Promise<AgentEvent[]> {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const session = runner.startSession({ userPrompt, cwd: process.cwd() }, (event) => events.push(event), {
      autoEndAfterFirstTurn: true,
    });
    await session.result;
    return events;
  }

  it('marks the turn-end as context-compaction and still emits the tool item', async () => {
    const events = await collect('mock:compaction-hold refactor the parser');
    // ADDITIVE, not a replacement: the "Compacted context" row still renders from the
    // unchanged tool-call/tool-result pair, so nothing that reads v1 today loses a frame.
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool-call', tool: 'contextCompaction' }),
    );
    expect(events.filter((e) => e.type === 'turn-end')).toEqual([
      { type: 'turn-end', reason: 'context-compaction' },
    ]);
  }, 15_000);

  it('leaves an ordinary turn-end bare, so old consumers see no new field', async () => {
    const events = await collect('check the working tree');
    expect(events.filter((e) => e.type === 'turn-end')).toEqual([{ type: 'turn-end' }]);
  }, 15_000);

  it('does not claim a compaction boundary when the model spoke after it', async () => {
    // `mock:compaction-done` compacts AFTER a `CEZ:DONE` message. The compaction is still
    // the last ITEM, which is exactly why the runner reports the boundary and `run.ts` —
    // not the runner — owns marker precedence. The text must survive intact either way.
    const events = await collect('mock:compaction-done wrap it up');
    expect(events.some((e) => e.type === 'text' && e.text.includes('CEZ:DONE'))).toBe(true);
  }, 15_000);

  it('never lets a CHILD thread compaction end the parent turn (#600 holds)', async () => {
    const events = await collect('mock:child-compaction fan out');
    // The child's own turn lifecycle is dropped, and its compaction item must not colour
    // the parent's boundary — the parent ended on its own message, so no reason at all.
    expect(events.filter((e) => e.type === 'turn-end')).toEqual([{ type: 'turn-end' }]);
    expect(events.some((e) => e.type === 'text' && e.text.includes('after the sub-agent compacted'))).toBe(true);
  }, 15_000);
});

/**
 * #955, second half — `sendMessage()` answers `true` the moment the frame is written to
 * stdin, long before the app-server's JSON-RPC response settles. `RunManager.deliverMessage`
 * takes that `true` as delivery, clears `waiting` and writes `running`; a later rejection
 * used to surface only as a quiet `note`, so the run sat there looking alive forever. The
 * rejection now speaks with the SAME authority `turn/failed` already has: an `error` event.
 */
describe('an asynchronous turn/start or turn/steer rejection (#955)', () => {
  const mockBin = fileURLToPath(
    new URL('./__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url),
  );

  it('surfaces a refused follow-up turn/start as an error, not a quiet note', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    let sawTurnEnd: () => void = () => {};
    const firstTurnEnd = new Promise<void>((resolve) => {
      sawTurnEnd = resolve;
    });
    const session = runner.startSession(
      { userPrompt: 'mock:compaction-reject refactor the parser', cwd: process.cwd() },
      (event) => {
        events.push(event);
        if (event.type === 'turn-end') sawTurnEnd();
      },
    );
    await firstTurnEnd;

    expect(session.sendMessage([{ type: 'text', text: 'Continue' }])).toBe(true);
    await expect
      .poll(() => events.some((e) => e.type === 'error'), { timeout: 10_000 })
      .toBe(true);
    const error = events.find((e) => e.type === 'error');
    expect(error).toMatchObject({ type: 'error', message: expect.stringContaining('busy compacting context') });
    session.end();
    await session.result.catch(() => undefined);
  }, 20_000);

  it('reports a refused turn/steer WITHOUT killing the turn still in flight', async () => {
    // The other half of the rule, and the reason it is not "escalate every rejection": a
    // refused steer leaves no zombie — the turn is genuinely running and `running` is
    // genuinely true. Escalating would interrupt it and throw away real work to report a
    // problem the run does not have. What was lost is the follow-up, and the note says so.
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    let sawText: () => void = () => {};
    const firstText = new Promise<void>((resolve) => {
      sawText = resolve;
    });
    const session = runner.startSession(
      // The turn stays OPEN, so the follow-up steers it instead of starting a new turn.
      { userPrompt: 'mock:steer-reject keep going', cwd: process.cwd() },
      (event) => {
        events.push(event);
        if (event.type === 'text') sawText();
      },
    );
    await firstText;

    expect(session.sendMessage([{ type: 'text', text: 'Continue' }])).toBe(true);
    await expect
      .poll(() => events.some((e) => e.type === 'note' && e.message.includes('did not reach the model')), {
        timeout: 10_000,
      })
      .toBe(true);
    expect(events.find((e) => e.type === 'note' && e.message.includes('did not reach the model'))).toMatchObject({
      message: expect.stringContaining('expectedTurnId'),
    });
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(session.open).toBe(true); // the live turn was NOT torn down
    session.end();
    await session.result.catch(() => undefined);
  }, 20_000);

  it("keeps cezar's OWN teardown a note, so cancelling never fails the run (#703 parity)", async () => {
    // The in-flight request the escalation must NOT fire on: `mock:steer-silent` never
    // answers the steer, so it is still pending when `interrupt()` tears the session down
    // and `rejectPending` settles it. Escalating that to `error` would turn every cancel
    // into a failed run — the exact class of self-inflicted failure #703 removed.
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    let sawText: () => void = () => {};
    const firstText = new Promise<void>((resolve) => {
      sawText = resolve;
    });
    const session = runner.startSession(
      { userPrompt: 'mock:steer-silent keep going', cwd: process.cwd() },
      (event) => {
        events.push(event);
        if (event.type === 'text') sawText();
      },
    );
    await firstText;

    expect(session.sendMessage([{ type: 'text', text: 'Continue' }])).toBe(true);
    session.interrupt();
    await session.result.catch(() => undefined);

    expect(events.some((e) => e.type === 'error')).toBe(false);
  }, 20_000);
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

  it('hard-stops a SIGTERM-ignoring app-server within the bounded grace', () => {
    withFakeChild((fake) => {
      const session = new CodexAppServerRunner({ bin: 'codex', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);

      session.hardStop?.();
      expect(fake.signals).toEqual(['SIGTERM']);
      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
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
    new URL('../../scripts/mock-codex-app-server.mjs', import.meta.url),
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

/**
 * `.ai/specs/2026-08-23-codex-resume-explicit-model.md`, Phase 1/1b/2 — a resumed thread must
 * state an explicit model rather than silently inheriting whatever codex persisted into
 * `thread_settings.model` when the thread was first created. Phase 1b taught the mock fixture to
 * reproduce that persisted-model fallback for real (`MOCK_CODEX_PERSISTED_MODEL`), so these tests
 * exercise the actual wire behaviour rather than asserting on prose.
 */
describe('thread/resume states an explicit model (codex resume poisoning)', () => {
  const mockBin = fileURLToPath(
    new URL('../../scripts/mock-codex-app-server.mjs', import.meta.url),
  );

  it('negative control: resume sends an explicit model even when the pin was dropped', async () => {
    const rpc = captureMockRpc();
    const runner = new CodexAppServerRunner({
      bin: mockBin,
      timeoutMs: 0,
      resumeModel: async () => ({ model: 'gpt-5.6-sol', source: 'catalog' }),
    });
    const session = runner.startSession(
      { userPrompt: 'continue', cwd: process.cwd(), resume: true, sessionId: 'th_mock_1' },
      undefined,
      { autoEndAfterFirstTurn: true },
    );
    await session.result;
    rpc.stop();

    const resume = rpc.calls().find((call) => call.method === 'thread/resume');
    expect(resume?.params.model).toBe('gpt-5.6-sol');
  }, 15_000);

  it('sends a live pin verbatim on resume, untouched by the resolver', async () => {
    const rpc = captureMockRpc();
    const runner = new CodexAppServerRunner({
      bin: mockBin,
      timeoutMs: 0,
      resumeModel: async (pinned) => ({ model: pinned, source: 'pinned' }),
    });
    const session = runner.startSession(
      {
        userPrompt: 'continue',
        cwd: process.cwd(),
        resume: true,
        sessionId: 'th_mock_1',
        model: 'gpt-5.6-terra',
      },
      undefined,
      { autoEndAfterFirstTurn: true },
    );
    await session.result;
    rpc.stop();

    const resume = rpc.calls().find((call) => call.method === 'thread/resume');
    expect(resume?.params.model).toBe('gpt-5.6-terra');
  }, 15_000);

  it('regression control: thread/start still sends no model key when the pin was dropped', async () => {
    const rpc = captureMockRpc();
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const session = runner.startSession(
      { userPrompt: 'check the working tree', cwd: process.cwd() },
      undefined,
      { autoEndAfterFirstTurn: true },
    );
    await session.result;
    rpc.stop();

    const start = rpc.calls().find((call) => call.method === 'thread/start');
    expect(start).toBeDefined();
    // Asserted on the RECORDED REQUEST, not the turn's outcome — a passing turn does not prove
    // the key was absent (spec Verification V3).
    expect('model' in (start?.params ?? {})).toBe(false);
  }, 15_000);

  it('omits the model and emits the unavailable note when the resolver cannot resolve one', async () => {
    const rpc = captureMockRpc();
    const runner = new CodexAppServerRunner({
      bin: mockBin,
      timeoutMs: 0,
      resumeModel: async () => ({ source: 'unavailable' }),
    });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'continue', cwd: process.cwd(), resume: true, sessionId: 'th_mock_1' },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );
    await session.result;
    rpc.stop();

    const resume = rpc.calls().find((call) => call.method === 'thread/resume');
    expect('model' in (resume?.params ?? {})).toBe(false);
    expect(
      events.some(
        (e) => e.type === 'note' && e.message.includes("could not read codex's model catalog"),
      ),
    ).toBe(true);
  }, 15_000);

  it('emits a note naming the source of the model it resumed on', async () => {
    const runner = new CodexAppServerRunner({
      bin: mockBin,
      timeoutMs: 0,
      resumeModel: async () => ({ model: 'gpt-5.6-sol', source: 'catalog' }),
    });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'continue', cwd: process.cwd(), resume: true, sessionId: 'th_mock_1' },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );
    await session.result;

    expect(
      events.some(
        (e) => e.type === 'note' && e.message === "resuming on gpt-5.6-sol (codex's current default)",
      ),
    ).toBe(true);
  }, 15_000);

  /**
   * Fixture control (Phase 1b): proves the mock's persisted-model fallback is real — a resume
   * that omits `model` inherits `MOCK_CODEX_PERSISTED_MODEL` and rejects, exactly like a real
   * poisoned `thread_settings.model` would. Without this, the remediation test below would prove
   * nothing: it would pass even if `model` were never sent.
   */
  it('fixture control: an omitted model resumes on the persisted one and fails', async () => {
    const runner = new CodexAppServerRunner({
      bin: mockBin,
      timeoutMs: 0,
      resumeModel: async () => ({ source: 'unavailable' }),
    });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      {
        userPrompt: 'continue',
        cwd: process.cwd(),
        resume: true,
        sessionId: 'th_mock_1',
        env: { MOCK_CODEX_PERSISTED_MODEL: 'sonnet' },
      },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );
    await session.result;

    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      message: expect.stringContaining('is not supported when using Codex'),
    });
  }, 15_000);

  it('remediates a thread poisoned with an unservable persisted model', async () => {
    const runner = new CodexAppServerRunner({
      bin: mockBin,
      timeoutMs: 0,
      resumeModel: async () => ({ model: 'gpt-5.6-sol', source: 'catalog' }),
    });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      {
        userPrompt: 'continue',
        cwd: process.cwd(),
        resume: true,
        sessionId: 'th_mock_1',
        // The exact persisted poison the incident's real threads carried — an explicit model
        // from the resolver overrides it, where an absent key (the control above) would not.
        env: { MOCK_CODEX_PERSISTED_MODEL: 'sonnet' },
      },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );
    await session.result;

    expect(events.filter((e) => e.type === 'error')).toEqual([]);
  }, 15_000);

  /** Phase 2 — the failure message names the model cezar actually sent, readable next to the
   *  Phase 1 note without cross-referencing it. */
  it('Phase 2 — names the model cezar sent when the first turn of a resume is rejected', async () => {
    const runner = new CodexAppServerRunner({
      bin: mockBin,
      timeoutMs: 0,
      resumeModel: async () => ({ model: 'not-a-real-model', source: 'pinned' }),
    });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'continue', cwd: process.cwd(), resume: true, sessionId: 'th_mock_1' },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );
    await session.result;

    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('resume sent model: not-a-real-model');
  }, 15_000);

  /** The annotation is scoped to the FIRST turn of a resume — a later turn's failure must not
   *  carry a stale "resume sent model" suffix naming a model that has nothing to do with it. */
  it('Phase 2 — a second, later turn failure carries no resume-model annotation', async () => {
    const runner = new CodexAppServerRunner({
      bin: mockBin,
      timeoutMs: 0,
      resumeModel: async () => ({ model: 'gpt-5.6-sol', source: 'catalog' }),
    });
    const events: AgentEvent[] = [];
    let turnEnds = 0;
    let resolveFirstTurnEnd: () => void = () => {};
    const firstTurnEnd = new Promise<void>((resolve) => { resolveFirstTurnEnd = resolve; });
    let resolveSecondTurnEnd: () => void = () => {};
    const secondTurnEnd = new Promise<void>((resolve) => { resolveSecondTurnEnd = resolve; });
    const session = runner.startSession(
      // The FIRST turn ('continue') succeeds — effective model 'gpt-5.6-sol' is servable — which
      // is what closes the resume window before the second turn is sent.
      { userPrompt: 'continue', cwd: process.cwd(), resume: true, sessionId: 'th_mock_1' },
      (event) => {
        events.push(event);
        if (event.type === 'turn-end') {
          turnEnds += 1;
          if (turnEnds === 1) resolveFirstTurnEnd();
          if (turnEnds === 2) resolveSecondTurnEnd();
        }
      },
      { autoEndAfterFirstTurn: false },
    );
    await firstTurnEnd;
    session.sendMessage([{ type: 'text', text: 'mock:turn-failed' }]);
    await secondTurnEnd;
    session.end();
    await session.result.catch(() => undefined);

    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({ type: 'error', message: 'model unavailable' });
  }, 15_000);
});

/**
 * Reasoning effort reaches codex (`.ai/specs/2026-08-24-codex-step-model-and-effort.md`, D3).
 *
 * The assertion is on the `turn/start` REQUEST rather than on the turn's outcome, and that is the
 * whole point: a turn succeeds identically whether the key was sent, omitted, or sent as `null`,
 * so an outcome test would be green against every wrong implementation.
 *
 * `thread/start` is the trap this guards. Measured against the real app-server on
 * `prod-host` (codex-cli 0.147.0): it accepts `effort`, `reasoningEffort`,
 * `modelReasoningEffort`, `model_reasoning_effort` and `reasoning_effort` on `thread/start`
 * WITHOUT error and applies none of them — the thread comes back `reasoningEffort: null` every
 * time, because unknown params are tolerated. Only `v2/TurnStartParams.json` declares the field.
 */
describe('reasoning effort rides on turn/start (codex)', () => {
  const mockBin = fileURLToPath(
    new URL('../../scripts/mock-codex-app-server.mjs', import.meta.url),
  );

  const turnStartParams = async (spec: { effort?: string; model?: string }): Promise<Record<string, unknown>> => {
    const rpc = captureMockRpc();
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const session = runner.startSession(
      { userPrompt: 'hello', cwd: process.cwd(), ...spec },
      undefined,
      { autoEndAfterFirstTurn: true },
    );
    await session.result;
    rpc.stop();
    const turn = rpc.calls().find((call) => call.method === 'turn/start');
    expect(turn, 'the mock server echoed no turn/start at all').toBeDefined();
    return turn!.params;
  };

  it('sends the resolved effort', async () => {
    expect((await turnStartParams({ effort: 'xhigh' })).effort).toBe('xhigh');
  }, 15_000);

  it('OMITS the key when no effort was resolved, rather than sending null', async () => {
    // The negative control on the test above. `toBeUndefined()` alone would pass against
    // `effort: null`, which is a DIFFERENT instruction to the app-server — it pins the turn to a
    // null override instead of leaving the model on its own default.
    const params = await turnStartParams({});
    expect('effort' in params).toBe(false);
  }, 15_000);

  it('does not put the effort on thread/start, where it would be silently ignored', async () => {
    const rpc = captureMockRpc();
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const session = runner.startSession(
      { userPrompt: 'hello', cwd: process.cwd(), effort: 'max' },
      undefined,
      { autoEndAfterFirstTurn: true },
    );
    await session.result;
    rpc.stop();

    const start = rpc.calls().find((call) => call.method === 'thread/start');
    expect(start, 'no thread/start was captured').toBeDefined();
    expect(start!.params.effort).toBeUndefined();
    expect(start!.params.reasoningEffort).toBeUndefined();
  }, 15_000);

  it('restates the effort on the first turn after a resume', async () => {
    // R2: `turn/start`'s override is documented as persisting "for this turn and subsequent
    // turns", which makes it thread state — so a resumed step that did not restate it would
    // inherit whatever the last turn set. It costs nothing here because every turn goes through
    // `turn/start`, and this asserts that the resume path is not an exception to that.
    const rpc = captureMockRpc();
    const runner = new CodexAppServerRunner({
      bin: mockBin,
      timeoutMs: 0,
      resumeModel: async () => ({ model: 'gpt-5.6-sol', source: 'catalog' }),
    });
    const session = runner.startSession(
      { userPrompt: 'continue', cwd: process.cwd(), resume: true, sessionId: 'th_mock_1', effort: 'high' },
      undefined,
      { autoEndAfterFirstTurn: true },
    );
    await session.result;
    rpc.stop();

    const turn = rpc.calls().find((call) => call.method === 'turn/start');
    expect(turn?.params.effort).toBe('high');
  }, 15_000);
});
