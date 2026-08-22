import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import type {
  AgentEvent,
  AgentRunResult,
  AgentRunSpec,
  AgentRunner,
  AgentSession,
  AgentToolCallRecord,
  ContentBlock,
  SessionOptions,
} from './agent-runner.ts';

// Re-exported for backends and the run manager that still import them from here.
export type { AgentSession, SessionOptions } from './agent-runner.ts';
import { isSignalTerminationExit, stopMessage, trackChildExit } from './agent-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import { costWeightedTokens, type RawUsage } from './usage.ts';
import { readNdjson } from './ndjson.ts';
import type { UiEvent } from './ui-events.ts';
import { BrokeredSession } from './brokered-session.ts';
import { brokerArgs, resolveBrokerCommand, type BrokerSessionRequest } from './broker-launch.ts';
import { buildBrokerLaunchArgv, userScopeEnv } from './broker-isolation.ts';
import { spoolPaths, type SpoolExit } from './run-spool.ts';
import {
  claudeTurnStarted,
  createClaudeUiState,
  mapClaudeMessage,
  stringifyToolResultContent,
  toolResultImageBlocks,
  type ClaudeUiMapping,
} from './claude-ui-mapper.ts';

/**
 * Default INACTIVITY cap for a single run before SIGTERM → SIGKILL: how long the agent may
 * produce nothing at all, not how long it may work
 * (spec 2026-08-20-agent-step-inactivity-timeout). Interactive sessions pass `timeoutMs: 0` to
 * disable it entirely.
 *
 * This was a wall clock armed once at spawn until 2026-08-20, which killed any step that took
 * longer than the limit however hard it was working. Harmless while `quick-task` was the default
 * (its single step IS the chain's last step, so it always got `timeoutMs: 0`); a real defect once
 * the six-step `spec-to-deploy` became the default and four of its steps became timed. Run
 * `9d09795a` lost `implement` and `run-tests` to it, both mid-work, both labelled `failed`.
 *
 * It stays a real bound: a non-interactive step is never parked at `waiting`, so `IDLE_TIMEOUT_MS`
 * does not cover it and this is the ONLY thing that reaps a wedged CLI holding a `maxParallel`
 * slot. Bounding silence keeps that guarantee and drops only the false positive.
 */
export const DEFAULT_RUN_IDLE_TIMEOUT_MS = 30 * 60_000;

/**
 * The inactivity bound a runner uses when its caller does not pass one: `CEZ_RUN_IDLE_TIMEOUT_MS`
 * (milliseconds, `0` disables), else `DEFAULT_RUN_IDLE_TIMEOUT_MS`.
 *
 * An operator seam, and the only one this bound had: until now 30 minutes was a hard-coded
 * constant, so a machine whose agents legitimately go quiet for longer — or a workspace that
 * wants a hung CLI reaped sooner — had to patch the source. Read at CONSTRUCTION, so it applies
 * per session rather than being frozen at import. An unparseable or negative value is treated as
 * unset rather than as `0`: a typo in a shell profile must not silently disable a safety bound.
 */
export function defaultIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CEZ_RUN_IDLE_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_RUN_IDLE_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_RUN_IDLE_TIMEOUT_MS;
}
/** Grace period between SIGTERM and SIGKILL when a timeout fires. */
export const KILL_GRACE_MS = 10_000;
/** After `end()` closes stdin: claude in stream-json mode can ignore EOF and
 *  hang (janitor-confirmed CLI bug) — escalate SIGTERM, then SIGKILL. */
export const EOF_TERM_GRACE_MS = 8_000;
export const EOF_KILL_GRACE_MS = 4_000;
/** Reopen window after a turn ends before an auto-ended session closes stdin. */
export const AUTO_END_DELAY_MS = 250;

export interface ClaudeCliRunnerOptions {
  /** Override the binary name/path; defaults to `claude` on PATH. */
  bin?: string;
  /** Inactivity timeout for a run (ms) — time with NO agent output, not total duration
   *  (spec 2026-08-20). Per-spec `timeoutMs` still wins; `0` disables the bound. */
  timeoutMs?: number;
}

/**
 * `AgentRunner` over the Claude Code CLI in headless stream-json mode. Auth =
 * the host's logged-in Pro/Max subscription (no API key needed).
 *
 * **CORRECTED 2026-08-15 — there is no tool sandbox.** This paragraph used to
 * read "Sandboxing is `--allowedTools` (default-deny for anything not listed)
 * + running inside the repo `cwd`", and the default-deny half is false:
 * measured against `claude` 2.1.224, `--allowedTools` only GRANTS additively,
 * it never restricts, so an empty or narrow list denies nothing. Only
 * `--disallowedTools` removes a tool from the surface. The `cwd` half still
 * holds, and it is now the only containment a run has, alongside the worktree
 * it runs in. `spec.allowedTools`/`bashAllowlist` (and so `buildAllowedTools`)
 * are therefore decorative on a Claude run today — see `buildClaudeArgs` below
 * and `.ai/specs/2026-08-15-bypass-permissions-claude-sessions.md`, which files
 * emitting the allow-list's complement as `--disallowedTools` as the fix. Any
 * caller relying on `allowedTools: []` to mean "no tools" is relying on
 * something this runner does not do.
 *
 * Session mechanics (multi-turn stdin, EOF watchdog, reopen window) follow
 * github-janitor's `claudeRunner.ts`; the original single-turn adaptation
 * came from @cezar/core's `ClaudeCodeCliRunner`.
 */
export class ClaudeCliRunner implements AgentRunner {
  readonly backend = 'claude' as const;

  private readonly bin: string;
  private readonly timeoutMs: number;
  private lastSession: AgentSession | null = null;

  constructor(opts: ClaudeCliRunnerOptions = {}) {
    // CEZ_DRY_RUN=1 swaps in the bundled mock so the cockpit / store /
    // GUI can be exercised without a logged-in claude or burning tokens.
    const defaultBin =
      process.env.CEZ_CLAUDE_BIN ??
      (process.env.CEZ_DRY_RUN === '1' ? mockClaudePath() : 'claude');
    this.bin = opts.bin ?? defaultBin;
    this.timeoutMs = opts.timeoutMs ?? defaultIdleTimeoutMs();
  }

  /** One-shot run: start a session and auto-end it after the first turn. */
  run(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    return this.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
  }

  async interrupt(): Promise<void> {
    this.lastSession?.interrupt();
  }

  startSession(
    spec: AgentRunSpec,
    onEvent?: (event: AgentEvent) => void,
    opts: SessionOptions = {},
  ): AgentSession {
    // P4: when the run manager asks for a broker, the backend is spawned by a detached second
    // process that owns its stdio and spools it to a file. Everything above this line — and
    // everything the returned `AgentSession` is used for — is unchanged.
    if (opts.broker) {
      const session = this.spawnBroker(spec, onEvent, opts, opts.broker);
      this.lastSession = session;
      return session;
    }
    const args = buildClaudeArgs(spec);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = nodeSpawn(this.bin, args, {
        cwd: spec.cwd,
        env: buildChildEnv({ backend: this.backend, extraEnv: spec.env }),
      });
    } catch (err) {
      throw wrapSpawnError(err, this.bin);
    }

    let stdinOpen = true;
    let autoEndTimer: NodeJS.Timeout | undefined;
    let eofTermTimer: NodeJS.Timeout | undefined;
    let eofKillTimer: NodeJS.Timeout | undefined;

    const sendMessage = (content: ContentBlock[]): boolean => {
      if (!stdinOpen) return false;
      // A follow-up inside the reopen window cancels the scheduled close.
      if (autoEndTimer) {
        clearTimeout(autoEndTimer);
        autoEndTimer = undefined;
      }
      const line = encodeClaudeUserMessage(content, spec.sessionId);
      try {
        child.stdin.write(`${line}\n`);
        // Each user message written to stdin begins a turn (§7.1).
        consumer.turnStarted();
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onEvent?.({ type: 'note', message: `claude: stdin write failed: ${message}` });
        return false;
      }
    };

    // Set the moment WE signal the child — the EOF watchdog, a cancel, or the
    // wall-clock kill switch. claude installs its own SIGTERM handler and exits
    // 143 instead of dying from the signal, so without this flag our own
    // teardown reads as an agent failure (#703).
    let terminatedByCezar = false;
    const signalChild = (signal: 'SIGTERM' | 'SIGKILL'): void => {
      terminatedByCezar = true;
      child.kill(signal);
    };
    // Every watchdog below asks "is the child still alive?" — and that question
    // is NOT `child.killed`, which only reports signal delivery. claude handles
    // SIGTERM itself, so `killed` is true while the process runs on; escalation
    // has to follow real termination or it never fires (#844).
    const hasExited = trackChildExit(child);

    const end = (): void => {
      if (!stdinOpen) return;
      stdinOpen = false;
      try {
        child.stdin.end();
      } catch {
        // already gone
      }
      eofTermTimer = setTimeout(() => {
        if (!hasExited()) signalChild('SIGTERM');
        eofKillTimer = setTimeout(() => {
          if (!hasExited()) signalChild('SIGKILL');
        }, EOF_KILL_GRACE_MS);
        eofKillTimer.unref?.();
      }, EOF_TERM_GRACE_MS);
      eofTermTimer.unref?.();
    };

    const interrupt = (): void => {
      stdinOpen = false;
      if (!hasExited()) signalChild('SIGTERM');
    };

    const consumer = createClaudeConsumer({
      spec,
      onEvent,
      onUiEvent: opts.onUiEvent,
      terminatedByCezar: () => terminatedByCezar,
      onActivity: () => bump(),
      onTurnEnd: () => {
        if (opts.autoEndAfterFirstTurn && stdinOpen && !autoEndTimer) {
          autoEndTimer = setTimeout(end, AUTO_END_DELAY_MS);
          autoEndTimer.unref?.();
        }
      },
    });

    // Seed the first user message — the same path every follow-up takes.
    // Pasted task screenshots (spec.images) ride along as leading blocks.
    sendMessage([...(spec.images ?? []), { type: 'text', text: spec.userPrompt }]);

    let spawnFailed: Error | null = null;

    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnFailed = wrapSpawnError(err, this.bin);
    });

    const stderrChunks: string[] = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk));

    // Optional INACTIVITY kill switch (disabled for interactive sessions). Re-armed by `bump()`
    // on every line the agent emits, so it bounds silence rather than duration — see
    // `DEFAULT_RUN_IDLE_TIMEOUT_MS`.
    const limitMs = spec.timeoutMs ?? this.timeoutMs;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    const bump = (): void => {
      if (limitMs <= 0 || timedOut) return; // nothing to arm, or already firing
      if (deadline) clearTimeout(deadline);
      deadline = setTimeout(() => {
        timedOut = true;
        interrupt();
        // stdout is deliberately NOT destroyed here. It used to be, which made the SIGTERM →
        // SIGKILL grace window below useless: everything the CLI emitted while winding down —
        // its final message, a handoff write, a `CEZ:SPEC_PATH` declaration — went on the floor.
        // The read loop keeps draining until the stream ends on its own, which the SIGKILL
        // guarantees it eventually does.
        killTimer = setTimeout(() => {
          if (!hasExited()) signalChild('SIGKILL');
        }, KILL_GRACE_MS);
        killTimer.unref?.();
      }, limitMs);
      deadline.unref?.();
    };
    bump();

    const result = (async (): Promise<AgentRunResult> => {
      try {
        for await (const line of readNdjson(child.stdout)) {
          // No `if (timedOut) break` here: frames that arrive during the grace window are the
          // agent's parting words and must still land (see the deadline handler above).
          consumer.handleLine(line);
        }
      } catch (err) {
        // A SIGKILLed child tears stdout down mid-frame, which surfaces here as a
        // premature-close error — expected once we stopped it; rethrow anything else.
        if (!timedOut) throw err;
      } finally {
        if (deadline) clearTimeout(deadline);
        if (killTimer) clearTimeout(killTimer);
        if (autoEndTimer) clearTimeout(autoEndTimer);
        stdinOpen = false;
      }

      const exitCode = await waitForExit(child);
      if (eofTermTimer) clearTimeout(eofTermTimer);
      if (eofKillTimer) clearTimeout(eofKillTimer);

      if (spawnFailed) throw spawnFailed;

      const { text, toolCalls, tokensUsed } = consumer.buildResult();

      if (timedOut) {
        // Not an agent failure: `reason` is what lets the run manager park the run at `review`
        // and keep the chain's later steps alive, instead of recording this as a failed step.
        onEvent?.({ type: 'error', message: stopMessage('inactivity', limitMs), reason: 'inactivity' });
        onEvent?.({ type: 'done' });
        return { text, toolCalls, tokensUsed, sessionId: spec.sessionId };
      }

      // A session cezar itself tore down (EOF watchdog after `end()`, or a
      // cancel) exits 143/137 — that is our own signal coming back, not an
      // agent failure, so it settles on the normal path with a note (#703).
      if (terminatedByCezar && isSignalTerminationExit(exitCode)) {
        onEvent?.({
          type: 'note',
          message: `claude CLI did not exit on its own after close; terminated by cezar (code ${exitCode})`,
        });
        onEvent?.({ type: 'done' });
        return { text, toolCalls, tokensUsed, sessionId: spec.sessionId };
      }

      if (exitCode !== 0 && exitCode !== null) {
        const stderr = stderrChunks.join('').trim();
        const detail = stderr ? ` — ${stderr.split('\n').slice(-3).join(' | ')}` : '';
        const msg = `claude CLI exited with code ${exitCode}${detail}`;
        onEvent?.({ type: 'error', message: msg });
        throw new Error(msg);
      }

      if (!consumer.sawUsage()) {
        onEvent?.({ type: 'note', message: 'token usage not reported by claude CLI' });
      }

      onEvent?.({ type: 'done' });
      return { text, toolCalls, tokensUsed, sessionId: spec.sessionId };
    })();

    const session: AgentSession = {
      result,
      sendMessage,
      end,
      interrupt,
      pid: child.pid,
      get open() {
        return stdinOpen;
      },
    };
    this.lastSession = session;
    return session;
  }

  /**
   * Re-open a session whose agent is still alive behind a broker, resuming its output at
   * `broker.startOffset` (P4 re-attach).
   *
   * The distinction from `startSession` is exactly one thing: nothing is spawned and no opening
   * message is sent. The agent is mid-turn and has already been told what to do — sending anything
   * here would inject a second instruction into a conversation that never stopped.
   */
  reattachSession(
    spec: AgentRunSpec,
    onEvent?: (event: AgentEvent) => void,
    opts: SessionOptions = {},
  ): AgentSession {
    const request = opts.broker;
    if (!request) throw new Error('reattachSession requires opts.broker');
    const session = this.attachBroker(spec, onEvent, opts, request, { seed: false });
    this.lastSession = session;
    return session;
  }

  /** Launch a detached broker for this spec, then tail its spool from byte 0. */
  private spawnBroker(
    spec: AgentRunSpec,
    onEvent: ((event: AgentEvent) => void) | undefined,
    opts: SessionOptions,
    request: BrokerSessionRequest,
  ): AgentSession {
    const brokerCommand = resolveBrokerCommand();
    if (!brokerCommand) {
      // Reachable only if a caller asks for a broker in a source tree. Loud rather than silent:
      // falling back here would make "is this run brokered?" unanswerable from the outside, and
      // the whole point of `brokerAvailable()` is that the caller decides that BEFORE spawning.
      throw new Error('run broker requested but this cezar has no built entry point to re-exec');
    }
    // A previous session's spool must never be mistaken for this one's. Removing it before the
    // broker writes `meta.json` also means `isSpoolLive` can never observe a half-replaced spool:
    // it either sees the old complete one, or nothing, or the new complete one.
    rmSync(request.spoolDir, { recursive: true, force: true });

    const argv = buildBrokerLaunchArgv({
      isolation: request.isolation ?? 'none',
      runId: request.runId,
      command: [
        ...brokerCommand,
        ...brokerArgs({
          spoolDir: request.spoolDir,
          runId: request.runId,
          stepId: request.stepId,
          backend: this.backend,
          cwd: spec.cwd,
          command: [this.bin, ...buildClaudeArgs(spec)],
        }),
      ],
    });

    let spawnFailed: Error | null = null;
    const [bin, ...rest] = argv;
    try {
      const proc = nodeSpawn(bin as string, rest, {
        cwd: spec.cwd,
        // The agent's environment, not ours: the broker execs the backend with its OWN
        // `process.env`, so `buildChildEnv`'s allowlist has to be applied here or the agent would
        // inherit the server's environment wholesale — the exact least-privilege regression #427
        // closed.
        // `buildChildEnv` is an ALLOWLIST, so it drops XDG_RUNTIME_DIR — and without that,
        // `systemd-run --user` cannot find the user bus, so the scope launch fails even where a
        // lingering user manager exists. Added only in `scope` mode, and only when the variable is
        // genuinely absent, so the allowlist stays as narrow as #427 made it.
        env: {
          ...buildChildEnv({ backend: this.backend, extraEnv: spec.env }),
          ...(request.isolation === 'scope' ? userScopeEnv() : {}),
        },
        // Detached + no stdio: the broker must not hold a pipe whose read end dies with us. That
        // pipe is the thing this entire phase exists to remove.
        detached: true,
        stdio: 'ignore',
      });
      proc.on('error', (err: NodeJS.ErrnoException) => {
        spawnFailed = wrapSpawnError(err, bin as string);
      });
      proc.unref();
    } catch (err) {
      throw wrapSpawnError(err, bin as string);
    }

    return this.attachBroker(spec, onEvent, opts, { ...request, startOffset: 0 }, {
      seed: true,
      spawnFailed: () => spawnFailed,
    });
  }

  /**
   * The half both brokered paths share: a `BrokeredSession` tailing the spool, wired to the same
   * consumer, the same inactivity bound and the same terminal-event vocabulary as the pipe path.
   */
  private attachBroker(
    spec: AgentRunSpec,
    onEvent: ((event: AgentEvent) => void) | undefined,
    opts: SessionOptions,
    request: BrokerSessionRequest,
    mode: { seed: boolean; spawnFailed?: () => Error | null },
  ): AgentSession {
    let terminatedByCezar = false;
    let timedOut = false;
    let deadline: NodeJS.Timeout | undefined;

    const consumer = createClaudeConsumer({
      spec,
      onEvent,
      onUiEvent: opts.onUiEvent,
      terminatedByCezar: () => terminatedByCezar,
      onActivity: () => bump(),
      onTurnEnd: () => {
        if (opts.autoEndAfterFirstTurn && session.open) {
          // No reopen window here, and that is deliberate: `AUTO_END_DELAY_MS` exists so a
          // follow-up typed within a quarter-second cancels the close on a LOCAL pipe. A control
          // socket round-trip is already slower than that, and a timer armed here would have to
          // survive a restart to mean anything. Ending promptly is the honest behaviour.
          session.end();
        }
      },
    });

    // Same INACTIVITY contract as the in-process path — a brokered run that goes silent must still
    // be reaped, or a wedged CLI would hold a `maxParallel` slot forever with nothing to stop it.
    const limitMs = spec.timeoutMs ?? this.timeoutMs;
    const bump = (): void => {
      if (limitMs <= 0 || timedOut) return;
      if (deadline) clearTimeout(deadline);
      deadline = setTimeout(() => {
        timedOut = true;
        terminatedByCezar = true;
        session.interrupt();
      }, limitMs);
      deadline.unref?.();
    };

    const session: BrokeredSession = new BrokeredSession({
      spoolDir: request.spoolDir,
      startOffset: request.startOffset ?? 0,
      onLine: (line) => consumer.handleLine(line),
      onOffset: request.onOffset,
      encodeSend: (content) => encodeClaudeUserMessage(content, spec.sessionId),
      spawnFailed: mode.spawnFailed,
      onExit: (exit) => {
        if (deadline) clearTimeout(deadline);
        emitBrokeredTerminalEvents({
          exit,
          onEvent,
          timedOut,
          limitMs,
          terminatedByCezar,
          sawUsage: consumer.sawUsage(),
        });
      },
      buildResult: () => {
        const failed = mode.spawnFailed?.();
        if (failed) throw failed;
        const totals = consumer.buildResult();
        const failure = brokeredExitFailure(request.spoolDir, timedOut, terminatedByCezar);
        if (failure) throw failure;
        return totals;
      },
    });

    // `interrupt`/`end` on a BrokeredSession are control-socket writes, so the flag has to be set
    // here rather than inside a `signalChild` the pipe path owns.
    const markTermination = <T extends 'end' | 'interrupt'>(op: T) => {
      const original = session[op].bind(session);
      return () => {
        terminatedByCezar = true;
        original();
      };
    };
    session.end = markTermination('end');
    session.interrupt = markTermination('interrupt');

    // Every user message written to stdin begins a turn (§7.1) — and that is true of the SECOND
    // one as much as the first. Emitting it only for the opening message (which is what an earlier
    // cut of this did) left every brokered follow-up without a `turn.started`, so the v2 stream
    // diverged from the in-process one the moment a run had two turns. `brokered-parity.test.ts`
    // is what caught it.
    const brokeredSend = session.sendMessage.bind(session);
    session.sendMessage = (content) => {
      const accepted = brokeredSend(content);
      if (accepted) consumer.turnStarted();
      return accepted;
    };

    bump();
    if (mode.seed) {
      session.sendMessage([...(spec.images ?? []), { type: 'text', text: spec.userPrompt }]);
    }
    return session;
  }
}

// ---- the stream consumer ---------------------------------------------------
//
// The single place a claude stream-json line becomes cezar events, extracted from the read loop
// so that BOTH transports can share it verbatim.
//
// This extraction is the whole reason the brokered path is safe to add. `AGENT_PROTOCOL.md`
// requires every backend's v1 `AgentEvent` and v2 `UiEvent` streams to be byte-identical
// regardless of how the bytes arrived; a second parser written for the spool would be a second
// thing to keep in sync, and the first divergence would show up as a run whose transcript looks
// subtly wrong rather than as a failing test. One consumer, two feeds: a pipe iterated in-process,
// or a file tailed from a byte offset.

export interface ClaudeConsumerOptions {
  spec: AgentRunSpec;
  onEvent?: (event: AgentEvent) => void;
  onUiEvent?: (event: UiEvent) => void;
  /** True once cezar itself signalled the backend — normalizes the teardown result frame. */
  terminatedByCezar?: () => boolean;
  /** A complete line arrived: proof of life for the inactivity clock. */
  onActivity?: () => void;
  /** A `result` frame closed a turn — where the auto-end timer is armed. */
  onTurnEnd?: () => void;
}

export interface ClaudeConsumer {
  /** Feed one raw NDJSON line. Never throws: a malformed frame becomes a note, as it always did. */
  handleLine(line: string): void;
  /** The run totals accumulated so far. Safe to call more than once. */
  buildResult(): AgentRunResult;
  /** Whether the backend ever reported usage — drives the "no token usage" note. */
  sawUsage(): boolean;
  /** A user message was written to stdin, which begins a turn (§7.1). */
  turnStarted(): void;
}

export function createClaudeConsumer(opts: ClaudeConsumerOptions): ClaudeConsumer {
  const { spec, onEvent } = opts;
  const toolCalls: AgentToolCallRecord[] = [];
  const textChunks: string[] = [];
  let tokensUsed = 0;
  let sawUsage = false;

  // Protocol v2 emission — additive alongside v1 (`onEvent` keeps flowing byte-identical). The
  // mapper never throws, but a defect in it must still never disturb the v1 stream — hence the
  // belt-and-braces try.
  let uiState = createClaudeUiState({ fallbackSessionId: spec.sessionId });
  const emitUi = (map: (state: typeof uiState) => ClaudeUiMapping): void => {
    try {
      const mapped = map(uiState);
      uiState = mapped.state;
      if (opts.onUiEvent) {
        for (const event of mapped.events) opts.onUiEvent(event);
      }
    } catch {
      // v2 mapping is best-effort; v1 consumers stay unaffected.
    }
  };

  return {
    turnStarted() {
      emitUi(claudeTurnStarted);
    },
    sawUsage: () => sawUsage,
    buildResult: () => ({
      text: textChunks.join('\n').trim(),
      toolCalls,
      tokensUsed,
      sessionId: spec.sessionId,
    }),
    handleLine(line: string) {
      opts.onActivity?.();
      let msg: ClaudeStreamMessage;
      try {
        msg = JSON.parse(line) as ClaudeStreamMessage;
      } catch {
        onEvent?.({ type: 'note', message: `claude: skipped unparseable stream line: ${truncate(line)}` });
        return;
      }

      // Claude reports `error_during_execution` while reacting to our teardown signal. Once cezar
      // has signalled the child, that frame describes the intentional stop rather than an agent
      // failure. Normalize only this precise wire shape so genuine result errors (authentication,
      // limits, malformed sessions) stay authoritative.
      const mappedMessage = normalizeIntentionalTeardownResult(msg, opts.terminatedByCezar?.() ?? false);
      emitUi((state) => mapClaudeMessage(mappedMessage, state));

      let delta = 0;
      try {
        delta = handleClaudeMessage(mappedMessage, { toolCalls, textChunks, onEvent });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onEvent?.({ type: 'note', message: `claude: skipped malformed event (${msg.type ?? 'unknown'}): ${message}` });
        return;
      }
      if (delta > 0) {
        sawUsage = true;
        tokensUsed += delta;
        onEvent?.({ type: 'token-usage', tokensUsed });
      }

      if (msg.type === 'result') {
        if (typeof msg.total_cost_usd === 'number' && msg.total_cost_usd > 0) {
          onEvent?.({ type: 'cost', usd: msg.total_cost_usd });
        }
        onEvent?.({ type: 'turn-end' });
        opts.onTurnEnd?.();
      }
    },
  };
}

/**
 * The exact stdin line a claude user message becomes.
 *
 * Shared by the pipe path and the brokered path deliberately — `session_id` is not decoration, it
 * is which conversation the frame belongs to, and a brokered send that omitted it would silently
 * start a second one.
 */
export function encodeClaudeUserMessage(content: ContentBlock[], sessionId?: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content }, session_id: sessionId });
}

/**
 * Build the headless argv. `--input-format stream-json` reads user messages
 * from stdin; `--output-format stream-json --verbose` gives per-event NDJSON;
 * `--permission-mode bypassPermissions` matches what cezar actually is —
 * unattended agents in isolated worktrees, with nobody in front of a run to
 * answer a prompt (spec `.ai/specs/2026-08-15-bypass-permissions-claude-sessions.md`).
 *
 * `--allowedTools` is still passed below, but measured against `claude`
 * 2.1.224 it only *grants* tools additively — it does not restrict. `default`
 * mode with `--allowedTools Read` still ran `Bash`; only `--disallowedTools`
 * removed the tool from the surface entirely. So `buildAllowedTools` and a
 * step's `allowedTools`/`bashAllowlist` are decorative on a Claude run today —
 * fixing that means emitting `--disallowedTools` for the allow-list's
 * complement, filed as a follow-up in the spec above, not done here.
 *
 * `env` stays an explicit, injectable parameter — unused by this function
 * now, but a test still exercises it to prove the mode no longer branches on
 * anything read from it.
 */
export function buildClaudeArgs(
  spec: AgentRunSpec,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const args: string[] = [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
  ];
  if (spec.systemPrompt) {
    args.push('--append-system-prompt', spec.systemPrompt);
  }
  // Pin the session so the user can `claude --resume <sessionId>` in the repo
  // to take over interactively after a run. With `resume` we reopen the
  // existing on-disk conversation instead.
  if (spec.sessionId) {
    if (spec.resume) {
      args.push('--resume', spec.sessionId);
    } else {
      args.push('--session-id', spec.sessionId);
    }
  }
  const allowed = buildAllowedTools(spec.allowedTools ?? [], spec.bashAllowlist);
  if (allowed.length > 0) {
    args.push('--allowedTools', allowed.join(','));
  }
  if (spec.model) {
    args.push('--model', spec.model);
  }
  if (spec.effort) {
    args.push('--effort', spec.effort);
  }
  for (const dir of spec.additionalDirectories ?? []) {
    args.push('--add-dir', dir);
  }
  return args;
}

/**
 * Map `allowedTools` onto claude's `--allowedTools` syntax. `Bash` with a
 * `bashAllowlist` becomes one `Bash(<prefix>:*)` entry per allowed prefix;
 * `Bash` with no allowlist stays plain `Bash`.
 */
export function buildAllowedTools(allowedTools: string[], bashAllowlist?: string[]): string[] {
  const out: string[] = [];
  for (const tool of allowedTools) {
    if (tool === 'Bash' && bashAllowlist && bashAllowlist.length > 0) {
      for (const prefix of bashAllowlist) {
        const p = prefix.trim();
        if (p) out.push(`Bash(${p}:*)`);
      }
    } else {
      out.push(tool);
    }
  }
  return out;
}

function truncate(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Path to the bundled mock (`scripts/mock-claude.mjs`), for CEZ_DRY_RUN=1. */
function mockClaudePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <pkg>/dist/core (built) or <pkg>/src/core (tsx dev).
  return resolvePath(here, '..', '..', 'scripts', 'mock-claude.mjs');
}

// ---- stream-json event handling -------------------------------------------

interface ClaudeStreamMessage {
  type?: string;
  subtype?: string;
  message?: {
    role?: string;
    content?: unknown[];
    usage?: RawUsage;
  };
  // `result` messages carry these at the top level.
  result?: string;
  usage?: RawUsage;
  is_error?: boolean;
  total_cost_usd?: number;
}

function normalizeIntentionalTeardownResult(
  msg: ClaudeStreamMessage,
  terminatedByCezar: boolean,
): ClaudeStreamMessage {
  if (
    terminatedByCezar
    && msg.type === 'result'
    && msg.is_error === true
    && msg.subtype === 'error_during_execution'
  ) {
    return { ...msg, subtype: 'success', is_error: false };
  }
  return msg;
}

function handleClaudeMessage(
  msg: ClaudeStreamMessage,
  ctx: {
    toolCalls: AgentToolCallRecord[];
    textChunks: string[];
    onEvent?: (e: AgentEvent) => void;
  },
): number {
  if (msg.type === 'assistant' && msg.message?.content) {
    for (const block of msg.message.content) {
      const b = block as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') {
        ctx.textChunks.push(b.text);
        ctx.onEvent?.({ type: 'text', text: b.text });
      } else if (b.type === 'tool_use' && b.id && b.name) {
        ctx.toolCalls.push({ id: b.id, name: b.name, input: b.input });
        ctx.onEvent?.({ type: 'tool-call', id: b.id, tool: b.name, input: b.input });
      }
    }
    // Assistant-frame usage belongs to the individual API calls inside this
    // agentic turn. Claude's terminal result frame already aggregates those
    // calls, so adding both sources inflates the run total (#716). Keep these
    // frames presentation-only; the result branch below is authoritative,
    // matching the v2 `usage.updated` mapping in AGENT_PROTOCOL.md.
    return 0;
  }

  if (msg.type === 'user' && msg.message?.content) {
    for (const block of msg.message.content) {
      const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        ctx.onEvent?.({
          type: 'tool-result',
          toolCallId: b.tool_use_id,
          result: stringifyToolResultContent(b.content),
          isError: b.is_error === true,
        });
        // Screenshots and other images inside the result get their own
        // events — the text path above renders them as a placeholder.
        for (const img of toolResultImageBlocks(b.content)) {
          ctx.onEvent?.({ type: 'image', mediaType: img.media_type, data: img.data });
        }
      }
    }
    return 0;
  }

  if (msg.type === 'result') {
    // Final message of a turn: `result` is the full assistant text; only fall
    // back to it if we never saw streamed assistant text blocks.
    if (typeof msg.result === 'string' && ctx.textChunks.length === 0) {
      ctx.textChunks.push(msg.result);
      ctx.onEvent?.({ type: 'text', text: msg.result });
    }
    if (msg.is_error) {
      ctx.onEvent?.({
        type: 'error',
        message: typeof msg.result === 'string' && msg.result.trim() !== ''
          ? msg.result
          : `claude reported result error${msg.subtype ? ` (${msg.subtype})` : ''}`,
      });
    }
    return costWeightedTokens(msg.usage);
  }

  // system/init and anything else: nothing actionable.
  return 0;
}

// stringify/image helpers moved to claude-ui-mapper.ts (shared by v1 and v2).

// ---- brokered terminal events ----------------------------------------------
//
// The pipe path's tail (exit code → note/error/done) expressed once, so a brokered run's last
// three events are the same three a piped run emits. They are what the cockpit renders as "the
// run ended", so a divergence here would be visible to a user rather than only to a test.

function emitBrokeredTerminalEvents(ctx: {
  exit: SpoolExit | null;
  onEvent?: (event: AgentEvent) => void;
  timedOut: boolean;
  limitMs: number;
  terminatedByCezar: boolean;
  sawUsage: boolean;
}): void {
  const { onEvent } = ctx;
  if (ctx.timedOut) {
    // Not an agent failure: `reason` is what lets the run manager park the run at `review` and
    // keep the chain's later steps alive.
    onEvent?.({ type: 'error', message: stopMessage('inactivity', ctx.limitMs), reason: 'inactivity' });
    onEvent?.({ type: 'done' });
    return;
  }
  const code = ctx.exit?.code ?? null;
  if (ctx.terminatedByCezar && isSignalTerminationExit(code)) {
    onEvent?.({
      type: 'note',
      message: `claude CLI did not exit on its own after close; terminated by cezar (code ${code})`,
    });
    onEvent?.({ type: 'done' });
    return;
  }
  if (code !== 0 && code !== null) {
    onEvent?.({ type: 'error', message: brokeredExitMessage(code, ctx.exit) });
    return;
  }
  if (!ctx.sawUsage) {
    onEvent?.({ type: 'note', message: 'token usage not reported by claude CLI' });
  }
  onEvent?.({ type: 'done' });
}

/** The `Error` a brokered run rejects with, or null when it ended acceptably. */
function brokeredExitFailure(spoolDir: string, timedOut: boolean, terminatedByCezar: boolean): Error | null {
  if (timedOut) return null;
  const exit = readSpoolExitSafe(spoolDir);
  const code = exit?.code ?? null;
  if (code === 0 || code === null) return null;
  if (terminatedByCezar && isSignalTerminationExit(code)) return null;
  return new Error(brokeredExitMessage(code, exit, spoolDir));
}

function brokeredExitMessage(code: number, exit: SpoolExit | null, spoolDir?: string): string {
  const stderr = spoolDir ? spooledStderrTail(spoolDir) : '';
  const detail = stderr ? ` — ${stderr}` : '';
  const signal = exit?.signal ? ` (signal ${exit.signal})` : '';
  return `claude CLI exited with code ${code}${signal}${detail}`;
}

function readSpoolExitSafe(spoolDir: string): SpoolExit | null {
  try {
    return JSON.parse(readFileSync(spoolPaths(spoolDir).exit, 'utf8')) as SpoolExit;
  } catch {
    return null;
  }
}

/** The last three lines of the broker's `err.log` — the brokered twin of the pipe path's
 *  `stderrChunks.slice(-3)`, which is what makes a failed run's cause visible in the transcript. */
function spooledStderrTail(spoolDir: string): string {
  try {
    return readFileSync(spoolPaths(spoolDir).err, 'utf8').trim().split('\n').slice(-3).join(' | ');
  } catch {
    return '';
  }
}

// ---- subprocess plumbing --------------------------------------------------

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode != null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    let done = false;
    const fin = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(safety);
      resolve(code);
    };
    child.once('close', (code) => fin(code));
    child.once('exit', (code) => fin(code));
    // Don't swallow a late error as a clean null exit — fall back to the
    // child's own exit code (which is non-null/non-zero on failure).
    child.once('error', () => fin(child.exitCode ?? null));
    // A SIGKILLed process may never emit 'close' through some edge cases.
    const safety = setTimeout(
      () => fin(child.exitCode ?? null),
      EOF_TERM_GRACE_MS + EOF_KILL_GRACE_MS + KILL_GRACE_MS + 5_000,
    );
    safety.unref?.();
  });
}

function wrapSpawnError(err: unknown, bin: string): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return new Error(
      `\`${bin}\` not found on PATH — install Claude Code (https://claude.com/claude-code) and run \`claude\` once to log in`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}
