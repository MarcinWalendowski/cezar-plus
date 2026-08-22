import { brokerRequest } from './broker-client.ts';
import type { BrokerRequest } from './run-broker.ts';
import type { AgentRunResult, AgentSession, ContentBlock } from './agent-runner.ts';
import { readSpoolExit, readSpoolFrom, readSpoolMeta, spoolPaths, type SpoolExit } from './run-spool.ts';

/**
 * `AgentSession` over a run broker (P4 of
 * `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`).
 *
 * The seam this preserves is the important part: `AgentSession` (`agent-runner.ts`) is the one
 * interface every layer above the runner already talks to — the UI mapper, step lifecycle,
 * autosave, telemetry. Satisfying it byte-for-byte means brokering is invisible above this line,
 * and none of `run.ts`'s 4 000 lines need to know a run is now out-of-process.
 *
 * Two halves, because the underlying transport genuinely has two:
 *  - reading is a FILE tail from a byte offset (durable, replayable, survives us dying);
 *  - writing is a control-socket round-trip (only the broker holds the backend's stdin).
 *
 * `consumedOffset` is the re-attach contract. It advances only past complete lines that have been
 * handed to the consumer, so persisting it and resuming there replays exactly the un-consumed
 * remainder: no gap, no duplicate. It is deliberately exposed rather than private — the run
 * manager must persist it on the run record for the next process to use.
 */

/** How often to poll the spool for new output. `fs.watch` is deliberately NOT used: it is
 *  unreliable across filesystems (and silently no-op on some network mounts), and the cost here is
 *  one `stat` per tick against a local file. Correctness over cleverness on the path that decides
 *  whether a user sees their agent's output. */
export const SPOOL_POLL_MS = 50;

/**
 * How many consecutive failed control round-trips before a queued send is abandoned.
 *
 * At `SPOOL_POLL_MS` this is a ~5 s window, which is generous for "the broker has been spawned but
 * has not bound its socket yet" and short enough that a broker that never came up does not leave
 * the cockpit believing a message is still on its way.
 */
export const PENDING_MAX_ATTEMPTS = 100;

export interface BrokeredSessionOptions {
  spoolDir: string;
  /** Byte offset to resume from — 0 for a fresh run, the persisted value when re-attaching. */
  startOffset?: number;
  /** Called for each complete NDJSON line, in order, exactly once. */
  onLine: (line: string) => void;
  /** Called when the backend has exited and the spool is fully drained. */
  onExit?: (exit: SpoolExit | null) => void;
  /** Called after each batch with the new offset, so the caller can persist it. */
  onOffset?: (offset: number) => void;
  /**
   * Produce the run's final result once the session ends.
   *
   * The session deliberately does NOT accumulate text/toolCalls itself: parsing a backend's
   * records is per-backend knowledge that already lives in the runner (`handleClaudeMessage` and
   * its siblings), and duplicating it here would be a second implementation to keep in sync — the
   * exact drift `AGENT_PROTOCOL.md`'s one-seam rule exists to prevent. The runner accumulates
   * while handling `onLine`, and this callback hands the totals back.
   */
  buildResult?: () => AgentRunResult;
  pollMs?: number;
  /**
   * Turn a user message into the exact line the backend expects on stdin.
   *
   * The generic `{op:'send'}` control op wraps content in the
   * `{type:'user', message:{role:'user', content}}` envelope, which is right for a backend that
   * needs nothing more. Claude needs `session_id` on every user frame, and a frame missing it is
   * not a slightly-different frame — it starts a different conversation. So the runner supplies the
   * encoder and the send goes out as `sendRaw`, byte-identical to what the in-process path writes
   * to the pipe. That byte-identity is the parity requirement `AGENT_PROTOCOL.md` imposes, and
   * this is the one place the brokered path could quietly have broken it.
   */
  encodeSend?: (content: ContentBlock[]) => string;
  /**
   * The broker child's own OS-level spawn error, if any (`proc.on('error', …)` in `spawnBroker`).
   * Consulted only when the control channel gives up after `PENDING_MAX_ATTEMPTS` — lets a
   * broker that failed to spawn at all surface its real cause instead of the generic
   * "did not respond" message that's all the connect-retry loop can see on its own.
   */
  spawnFailed?: () => Error | null;
}

export class BrokeredSession implements AgentSession {
  readonly result: Promise<AgentRunResult>;
  readonly spoolDir: string;

  private offset: number;
  private closed = false;
  private stdinOpen = true;
  private timer?: NodeJS.Timeout;
  private readonly opts: BrokeredSessionOptions;
  private settle!: (result: AgentRunResult) => void;
  private failWith!: (err: unknown) => void;
  private readonly pending: BrokerRequest[] = [];
  private sending = false;
  private attempts = 0;

  constructor(opts: BrokeredSessionOptions) {
    this.opts = opts;
    this.spoolDir = opts.spoolDir;
    this.offset = opts.startOffset ?? 0;
    this.result = new Promise<AgentRunResult>((resolve, reject) => {
      this.settle = resolve;
      this.failWith = reject;
    });
    this.tick();
    this.timer = setInterval(() => this.tick(), opts.pollMs ?? SPOOL_POLL_MS);
    // Deliberately ref'd (unlike every sibling unref'd timer in this codebase): this is the ONLY
    // handle that keeps a one-shot `cezar run` process alive while its session is genuinely open.
    // `finish()` and `detach()` both `clearInterval` it the moment the session reaches a terminal
    // state, so this only holds the process open for exactly as long as a run is in flight.
  }

  /** The BACKEND's pid (from the spool's meta), not the broker's — callers use this for the
   *  process-tree resource sampler, which wants the agent, not its babysitter. */
  get pid(): number | undefined {
    return readSpoolMeta(this.spoolDir)?.childPid;
  }

  get open(): boolean {
    return this.stdinOpen && !this.closed;
  }

  /** Bytes of the spool already handed to `onLine`. Persist this to make a restart lossless. */
  get consumedOffset(): number {
    return this.offset;
  }

  private drain(): void {
    const { out } = spoolPaths(this.spoolDir);
    const batch = readSpoolFrom(out, this.offset);
    if (batch.lines.length === 0) return;
    for (const line of batch.lines) {
      try {
        this.opts.onLine(line);
      } catch {
        // A consumer defect must not wedge the tail — the same belt-and-braces the in-process
        // runner applies around its own mapper.
      }
    }
    this.offset = batch.nextOffset;
    this.opts.onOffset?.(this.offset);
  }

  private tick(): void {
    if (this.closed) return;
    // Before reading: a queued opening message is the reason there is anything to read at all.
    void this.pumpPending();
    this.drain();
    const exit = readSpoolExit(this.spoolDir);
    if (!exit) return;
    // The broker writes exit.json strictly AFTER flushing its tees, so one final drain here is
    // guaranteed to see the whole transcript rather than racing the tail.
    this.drain();
    this.finish(exit);
  }

  private finish(exit: SpoolExit | null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdinOpen = false;
    if (this.timer) clearInterval(this.timer);
    try {
      this.opts.onExit?.(exit);
    } catch {
      // A consumer defect in the terminal callback must not strand `result` unsettled.
    }
    try {
      this.settle(this.opts.buildResult?.() ?? { text: '', toolCalls: [], tokensUsed: 0 });
    } catch (err) {
      this.failWith(err);
    }
  }

  /**
   * Queue a control request and start (or join) the drain.
   *
   * Everything goes through the queue, including sends issued long after the broker is up. A
   * "send now if ready, else queue" split would have needed a readiness TEST, and the obvious one
   * — does `ctl.sock` exist? — is wrong for a reason worth recording: libuv truncates an over-long
   * `sun_path`, so for a deep spool the socket works perfectly while the file is not at the path
   * anyone would stat (see `controlSocketPath`). Trying the send and believing the RESULT asks the
   * only question that matters, and it also covers the case the file test never could — the socket
   * exists but the broker has not called `accept` yet.
   */
  private dispatch(request: BrokerRequest): void {
    this.pending.push(request);
    void this.pumpPending();
  }

  /**
   * Send queued requests in order, stopping at the first failure so the next tick retries.
   *
   * Strictly one in flight: the broker writes each `send` straight to the backend's stdin, so two
   * concurrent sends could interleave turns. `attempts` bounds the retry so a broker that died
   * between spawn and bind cannot spin this forever — after the budget the queue is dropped and
   * the session reports itself closed, which is the truthful state.
   */
  private async pumpPending(): Promise<void> {
    if (this.sending || this.pending.length === 0 || this.closed) return;
    this.sending = true;
    try {
      while (this.pending.length) {
        const next = this.pending[0] as BrokerRequest;
        try {
          await brokerRequest(this.spoolDir, next);
        } catch {
          this.attempts += 1;
          if (this.attempts >= PENDING_MAX_ATTEMPTS) {
            this.pending.length = 0;
            const waitedMs = this.attempts * (this.opts.pollMs ?? SPOOL_POLL_MS);
            this.giveUp(
              this.opts.spawnFailed?.() ??
                new Error(`run broker for ${this.spoolDir} did not respond after ${waitedMs}ms — giving up`),
            );
          }
          return;
        }
        this.attempts = 0;
        this.pending.shift();
      }
    } finally {
      this.sending = false;
    }
  }

  /**
   * Terminal path for "the control channel never came up." Distinct from `finish()`: there is no
   * real backend exit to report (the backend may never even have started), so this deliberately
   * does not call `opts.onExit` — that callback's vocabulary is for a real `SpoolExit`, and calling
   * it here with nothing would read as a misleading `done`/`note` event ahead of the `failed`
   * status the rejected `result` produces.
   */
  private giveUp(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.stdinOpen = false;
    if (this.timer) clearInterval(this.timer);
    this.failWith(err);
  }

  sendMessage(content: ContentBlock[]): boolean {
    if (!this.open) return false;
    const encoded = this.opts.encodeSend?.(content);
    this.dispatch(encoded === undefined ? { op: 'send', content } : { op: 'sendRaw', line: encoded });
    return true;
  }

  end(): void {
    if (!this.stdinOpen) return;
    this.stdinOpen = false;
    this.dispatch({ op: 'end' });
  }

  interrupt(): void {
    this.stdinOpen = false;
    this.dispatch({ op: 'interrupt' });
  }

  /** Stop tailing without touching the backend — what a graceful server shutdown does. The broker
   *  and the agent keep running; the next process resumes at `consumedOffset`. */
  detach(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.settle(this.opts.buildResult?.() ?? { text: '', toolCalls: [], tokensUsed: 0 });
  }
}
