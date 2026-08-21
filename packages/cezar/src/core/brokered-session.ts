import { brokerRequest } from './broker-client.ts';
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

  constructor(opts: BrokeredSessionOptions) {
    this.opts = opts;
    this.spoolDir = opts.spoolDir;
    this.offset = opts.startOffset ?? 0;
    this.result = new Promise<AgentRunResult>((resolve) => {
      this.settle = resolve;
    });
    this.tick();
    this.timer = setInterval(() => this.tick(), opts.pollMs ?? SPOOL_POLL_MS);
    this.timer.unref?.();
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
    this.opts.onExit?.(exit);
    this.settle(this.opts.buildResult?.() ?? { text: '', toolCalls: [], tokensUsed: 0 });
  }

  sendMessage(content: ContentBlock[]): boolean {
    if (!this.open) return false;
    // Fire-and-forget by the interface's own shape (it returns boolean, not a promise). A failed
    // send surfaces as the backend simply not answering, exactly as a failed pipe write does today.
    void brokerRequest(this.spoolDir, { op: 'send', content }).catch(() => undefined);
    return true;
  }

  end(): void {
    if (!this.stdinOpen) return;
    this.stdinOpen = false;
    void brokerRequest(this.spoolDir, { op: 'end' }).catch(() => undefined);
  }

  interrupt(): void {
    this.stdinOpen = false;
    void brokerRequest(this.spoolDir, { op: 'interrupt' }).catch(() => undefined);
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
