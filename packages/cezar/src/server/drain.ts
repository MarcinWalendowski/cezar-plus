/**
 * Graceful drain (P3 of `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`).
 *
 * What this replaces: `serve`'s shutdown handler was
 *
 *     const shutdown = () => { store.flush(); process.exit(0); };
 *     process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
 *
 * `process.exit(0)` is immediate and unconditional — in-flight HTTP responses are cut mid-body,
 * SSE and WebSocket streams die without a word, and any client waiting on a request sees a reset
 * rather than an answer. Socket activation removes the *bind* gap; it does nothing for requests
 * already in flight on the outgoing process. This module is that second half.
 *
 * The contract, and the reason "gap = 0" is defined the way the spec defines it: an SSE stream is
 * unbounded, so no process replacement can avoid closing one. What it CAN avoid is losing a byte.
 * So on drain we stop accepting, let in-flight unary requests finish, and tell every live stream
 * to reconnect — handing SSE a resume cursor and closing WebSockets with 1012 (`Service Restart`),
 * the code whose entire meaning is "come back, I am being replaced".
 *
 * Deliberately transport-agnostic and dependency-free: it counts, it waits, it notifies. The
 * server wires it to Hono middleware and the socket hub; tests drive it directly.
 */

/** How long to wait for in-flight requests before giving up on them. */
export const DEFAULT_DRAIN_MS = 5_000;

/** WebSocket close code meaning "server is restarting" (RFC 6455 §7.4.2 / IANA). */
export const WS_CLOSE_SERVICE_RESTART = 1012;

/** The terminal SSE frame a draining server sends so the client reconnects at once instead of
 *  waiting out its backoff, and knows where to resume from. */
export const SSE_RELOAD_EVENT = 'reload';

/**
 * `CEZ_DRAIN_MS` — how long to wait for in-flight requests on shutdown.
 *
 * Must stay under the unit's `TimeoutStopSec` (30s in the generated drop-in) or systemd SIGKILLs
 * the process part-way through the drain, which would undo the whole point. Nonsense values fall
 * back to the default rather than becoming 0 (an instant, ungraceful exit) or NaN (a wait that
 * never resolves) — the two ways a typo here could silently reintroduce the bug.
 */
export function resolveDrainMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CEZ_DRAIN_MS;
  // An empty or whitespace-only value is UNSET, not zero. `Number('')` is 0, which is finite and
  // non-negative, so a bare `CEZ_DRAIN_MS=` in an EnvironmentFile would otherwise mean "skip the
  // drain entirely" — silently restoring the abrupt exit this module replaced.
  if (raw === undefined || raw.trim() === '') return DEFAULT_DRAIN_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_DRAIN_MS;
  return parsed;
}

export interface DrainOptions {
  drainMs?: number;
  /** Injectable clock/timer for tests. */
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface DrainReport {
  /** True when every in-flight request finished before the deadline. */
  clean: boolean;
  /** In-flight unary requests still outstanding when the wait ended. */
  outstanding: number;
  /** Live streams that were told to reconnect. */
  streamsNotified: number;
  waitedMs: number;
}

type StreamCloser = () => void;

/**
 * Tracks in-flight work and orchestrates the wind-down.
 *
 * Streams are registered with a closer rather than counted, because they are not something to
 * *wait* for — an SSE subscriber would keep the server alive forever. They are something to
 * actively end, once, at the top of the drain.
 */
export class DrainController {
  private inFlight = 0;
  private draining = false;
  private readonly streams = new Set<StreamCloser>();
  private readonly waiters: Array<() => void> = [];
  private readonly drainMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(options: DrainOptions = {}) {
    this.drainMs = options.drainMs ?? DEFAULT_DRAIN_MS;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  isDraining(): boolean {
    return this.draining;
  }

  inFlightCount(): number {
    return this.inFlight;
  }

  streamCount(): number {
    return this.streams.size;
  }

  /** Mark a unary request as started; the returned function marks it finished.
   *  Idempotent — a double `end()` (error path plus finally) must not drive the count negative
   *  and let the drain believe it is done while a response is still being written. */
  begin(): () => void {
    this.inFlight += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.inFlight -= 1;
      if (this.inFlight === 0) this.flushWaiters();
    };
  }

  /** Register a live stream (SSE or WS) and how to end it. Returns the unregister handle. */
  registerStream(close: StreamCloser): () => void {
    this.streams.add(close);
    return () => {
      this.streams.delete(close);
    };
  }

  private flushWaiters(): void {
    while (this.waiters.length) (this.waiters.pop() as () => void)();
  }

  /**
   * Begin draining: refuse new work, end every live stream, then wait for in-flight unary
   * requests to finish or the deadline to pass.
   *
   * Streams are closed FIRST and unary requests waited on second, and that order matters: a
   * client whose SSE stream is closed reconnects immediately, and if the new process is not yet
   * accepting that reconnect lands in the socket-activation backlog rather than failing. Waiting
   * first would hold the streams open across the whole drain window for no benefit.
   */
  async drain(): Promise<DrainReport> {
    const startedAt = this.now();
    this.draining = true;

    const streamsNotified = this.streams.size;
    for (const close of [...this.streams]) {
      try {
        close();
      } catch {
        // A stream that throws on close is already gone; it must never abort the drain.
      }
    }
    this.streams.clear();

    if (this.inFlight === 0) {
      return { clean: true, outstanding: 0, streamsNotified, waitedMs: this.now() - startedAt };
    }

    const clean = await new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = this.setTimer(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, this.drainMs);
      this.waiters.push(() => {
        if (settled) return;
        settled = true;
        this.clearTimer(timer);
        resolve(true);
      });
    });

    return { clean, outstanding: this.inFlight, streamsNotified, waitedMs: this.now() - startedAt };
  }
}
