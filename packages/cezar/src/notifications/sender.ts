import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { transportHealthStatusSchema, type NotificationLogRow } from '@loki-labs/cezar-plus-contract';
import { atomicWriteJsonSync } from '../workspace/config.ts';
import { DueScheduler, type DueEntry } from '../scheduling/due-scheduler.ts';
import type { DeliveryResult, Notification, NotificationSink } from './types.ts';
import { NotificationOutbox } from './outbox.ts';

/**
 * The demand-driven sender (W2.5, spec "Architecture > Outbox and sender" and Data Model 2's
 * `state.json`). Drains `NotificationOutbox`'s pending rows on ONE `DueScheduler` timer
 * (`../scheduling/due-scheduler.ts`, extracted from `automations/scheduler.ts`'s
 * `WorkspaceAutomationScheduler`) that is `null` whenever nothing is due — "An idle cezar with
 * configured transports runs no notification timer" (spec) — and re-arms itself both from a
 * finished attempt (`DueScheduler`'s own re-arm-on-completion) and from a brand-new reservation
 * (`NotificationSender.reserve`, below, wakes it explicitly).
 *
 * `NotificationSender` — not `NotificationOutbox` — is the class that `implements
 * NotificationSink` and gets wired into `NotificationRegistry`'s `sink` option: reserving a row is
 * only half of "demand-driven," the other half is making sure something notices. The outbox has no
 * way to wake a scheduler it does not know about, so the sender composes it and owns that wake-up.
 *
 * What this file deliberately does NOT do: apply quiet hours, coalescing or the rate-limit token
 * bucket to a pending row before sending it. Those pure functions (`coalesce`, `applyQuietHours`,
 * `applyRateLimit`) live in `decider.ts` (W1.7, already landed) and are table-tested there in
 * isolation; nothing in this package's stated dependency (W1.7 only) or its acceptance criteria
 * wires them into a live send path against a persisted `TransportRoute`, and inventing that wiring
 * here would require config this file has no declared access to. That gap is flagged in the
 * implementation report for the orchestrator rather than guessed at silently.
 */

const STATE_FILE = 'state.json';
/** Cross-process lease staleness — mirrors `NotificationOutbox.acquireLease`'s own default so a
 *  dead sender's lock is reclaimed on the same horizon a dead outbox writer's would be. */
const DEFAULT_LEASE_STALE_MS = 10 * 60_000;
/** Restart recovery: a row still `reserved`/`sending` past this long has almost certainly outlived
 *  the process that was working it. */
const DEFAULT_ROW_STALE_MS = 10 * 60_000;
/** Staleness ceiling (Noise control #7) — a queued notification older than this closes
 *  `dropped:'stale'` rather than being delivered late. Matches `notifications/config.ts`'s own
 *  `DEFAULT_MAX_AGE_MS` value; not imported from there (W1.8 is not a declared dependency of W2.5),
 *  reproduced as the same literal so the zero-config default agrees without a package edge. */
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60_000;
/** Five consecutive hard failures trip the breaker (spec "Circuit breaker"). */
const CIRCUIT_BREAKER_THRESHOLD = 5;
/** "max 6 attempts" (spec "Retry"). */
const MAX_ATTEMPTS = 6;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 15 * 60_000;
const DEFAULT_SEND_TIMEOUT_MS = 10_000;

const transportHealthCountersFileSchema = z
  .object({
    sent: z.number().int().nonnegative().default(0).catch(0),
    failed: z.number().int().nonnegative().default(0).catch(0),
    dropped: z.number().int().nonnegative().default(0).catch(0),
    suppressed: z.number().int().nonnegative().default(0).catch(0),
    leaseReclaimed: z.number().int().nonnegative().default(0).catch(0),
    requeued: z.number().int().nonnegative().default(0).catch(0),
  })
  .passthrough();

const ZERO_COUNTERS = {
  sent: 0,
  failed: 0,
  dropped: 0,
  suppressed: 0,
  leaseReclaimed: 0,
  requeued: 0,
} as const;

/**
 * Named explicitly rather than derived via `keyof NotificationTransportState['counters']`: the
 * counters schema is `.passthrough()` (house rule), which widens a `keyof` over its inferred type
 * to include the index signature's `string` — indexing with THAT loses the `number` type each
 * counter actually has. Direct property access with one of these literals still narrows correctly
 * through the passthrough intersection; only the derived union does not.
 */
type NotificationCounterKey = keyof typeof ZERO_COUNTERS;

/**
 * Per-transport persisted send health. Every field degrades independently (`.catch`), the
 * `agent-accounts.json` house rule `notifications/config.ts` already documents for this feature's
 * OTHER files — a hand-edited or partially-written `state.json` loses at most the field that broke,
 * never the whole transport's history.
 *
 * `status` is written ONLY by a transition in this file, never recomputed at read time from
 * `backoffUntil` against the clock (Q13, plan D8/D20) — two identical reads of this file a second
 * apart must answer the same `status`.
 */
const notificationTransportStateSchema = z
  .object({
    status: transportHealthStatusSchema.default('unconfigured').catch('unconfigured'),
    lastAttemptAt: z.string().optional().catch(undefined),
    lastSuccessAt: z.string().optional().catch(undefined),
    lastError: z.string().max(500).optional().catch(undefined),
    consecutiveFailures: z.number().int().nonnegative().default(0).catch(0),
    backoffUntil: z.string().optional().catch(undefined),
    counters: transportHealthCountersFileSchema.default(() => ({ ...ZERO_COUNTERS })).catch(() => ({ ...ZERO_COUNTERS })),
  })
  .passthrough();
export type NotificationTransportState = z.infer<typeof notificationTransportStateSchema>;

const notificationStateFileSchema = z
  .object({
    version: z.number().int().min(0).default(1).catch(1),
    transports: z
      .record(z.string(), notificationTransportStateSchema)
      .default(() => ({}))
      .catch(() => ({})),
  })
  .passthrough();
type NotificationStateFile = z.infer<typeof notificationStateFileSchema>;

function defaultTransportState(): NotificationTransportState {
  return notificationTransportStateSchema.parse({});
}

export interface NotificationSenderOptions {
  outbox: NotificationOutbox;
  /**
   * Attempts one delivery through a registered transport — exactly `NotificationRegistry.send()`'s
   * shape (transportId, notification, timeoutMs) -> `DeliveryResult`, injected rather than importing
   * `NotificationRegistry` directly so a test never wires a real transport or touches the network,
   * matching this package's own "fetch is an injected dependency" discipline (W2.4's, applied here
   * one level up).
   */
  send: (transportId: string, notification: Notification, timeoutMs?: number) => Promise<DeliveryResult>;
  now?: () => number;
  warn?: (message: string) => void;
  /** Seeded for deterministic retry-curve tests; defaults to `Math.random`. */
  random?: () => number;
  maxAgeMs?: number;
  sendTimeoutMs?: number;
  leaseStaleMs?: number;
  rowStaleMs?: number;
}

/**
 * `NotificationSink` implementation AND the demand-driven drain loop, composed over one
 * `NotificationOutbox`. Construction does not start anything — call `start()` once the caller is
 * ready to acquire the cross-process lease and begin sending (mirrors `DueScheduler`'s own
 * `start()`/`schedule()` split, and `WorkspaceAutomationScheduler`'s `start()`).
 */
export class NotificationSender implements NotificationSink {
  private readonly outbox: NotificationOutbox;
  private readonly sendImpl: NotificationSenderOptions['send'];
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly random: () => number;
  private readonly maxAgeMs: number;
  private readonly sendTimeoutMs: number;
  private readonly leaseStaleMs: number;
  private readonly rowStaleMs: number;
  private readonly due: DueScheduler<NotificationLogRow>;
  private readonly statePath: string;
  private state: NotificationStateFile = notificationStateFileSchema.parse({});
  private lease: { release(): void } | undefined;
  private started = false;

  constructor(options: NotificationSenderOptions) {
    this.outbox = options.outbox;
    this.sendImpl = options.send;
    this.now = options.now ?? Date.now;
    this.warn = options.warn ?? ((message) => console.warn(`[notifications] ${message}`));
    this.random = options.random ?? Math.random;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    this.leaseStaleMs = options.leaseStaleMs ?? DEFAULT_LEASE_STALE_MS;
    this.rowStaleMs = options.rowStaleMs ?? DEFAULT_ROW_STALE_MS;
    this.statePath = join(this.outbox.dataDir, STATE_FILE);
    this.loadState();
    this.due = new DueScheduler<NotificationLogRow>({
      collectDue: () => this.collectDue(),
      run: (row) => this.attempt(row),
      now: this.now,
    });
  }

  /**
   * Acquires the cross-process lease and, only if that succeeds, requeues stale in-flight rows
   * (restart recovery) and arms the scheduler. A second instance sharing the same `CEZ_HOME` gets
   * `undefined` from the outbox's lease and this method returns having sent nothing and armed no
   * timer — Verification "The wx lease with staleness reclaim gives a second instance undefined
   * and it sends nothing."
   */
  start(): void {
    if (this.started) return;
    const lease = this.outbox.acquireLease(this.leaseStaleMs);
    if (!lease) {
      this.warn('notifications sender: another process already holds the outbox lease — not starting');
      return;
    }
    this.started = true;
    this.lease = lease;
    const touched = this.outbox.requeueStaleReservations(this.rowStaleMs);
    for (const row of touched) {
      this.bumpCounter(row.transportId, 'requeued');
      // The lock itself was reclaimed from a dead process (not merely found free) — attribute it
      // to whichever transports actually had rows healed by that reclaim.
      if (lease.reclaimed) this.bumpCounter(row.transportId, 'leaseReclaimed');
    }
    this.due.start();
    this.wake();
  }

  stop(): void {
    this.started = false;
    this.due.stop();
    this.lease?.release();
    this.lease = undefined;
  }

  /** Whether a timer is currently armed — `false` whenever the outbox has nothing pending, which is
   *  Verification #12 ("the idle machine holds no timer") asserted directly. */
  hasTimer(): boolean {
    return this.due.hasTimer();
  }

  health(transportId: string): NotificationTransportState {
    return this.state.transports[transportId] ?? defaultTransportState();
  }

  /** `NotificationSink.reserve` — delegates to the outbox for the actual at-most-once write, then
   *  wakes the scheduler if (and only if) a new row was actually created, so a collision never arms
   *  a timer for nothing. */
  reserve(transportId: string, notification: Notification): void {
    const row = this.outbox.reserve(transportId, notification);
    if (row) this.wake();
  }

  private wake(): void {
    if (!this.started) return;
    this.due.cancel();
    this.due.schedule();
  }

  private collectDue(): Array<DueEntry<NotificationLogRow>> {
    return this.outbox.pending().map((row) => ({
      at: row.nextAttemptAt ? Date.parse(row.nextAttemptAt) : Date.parse(row.createdAt),
      value: row,
    }));
  }

  private async attempt(row: NotificationLogRow): Promise<void> {
    const now = this.now();

    // Staleness ceiling (Noise control #7) — checked on every attempt, not only at restart, so a
    // row that was fresh when reserved but has since aged past `maxAgeMs` while waiting on a retry
    // delay is caught the moment it is next considered, rather than sent late.
    if (now - Date.parse(row.createdAt) > this.maxAgeMs) {
      this.outbox.markDropped(row.rowId, 'stale');
      this.bumpCounter(row.transportId, 'dropped');
      return;
    }

    const transportState = this.health(row.transportId);
    if (transportState.backoffUntil && Date.parse(transportState.backoffUntil) > now) {
      // The circuit breaker is open for this transport — leave the row due exactly when the
      // breaker itself will next allow an attempt, instead of retrying (and re-extending its own
      // backoff) on the row's own, unrelated cadence.
      this.outbox.scheduleRetry(row.rowId, { attempts: row.attempts, nextAttemptAt: transportState.backoffUntil });
      return;
    }

    this.outbox.markSending(row.rowId);

    const notification = rowToNotification(row);
    let result: DeliveryResult;
    try {
      result = await this.sendImpl(row.transportId, notification, this.sendTimeoutMs);
    } catch (error) {
      // `send` MUST NOT throw per its own contract, but nothing here may ever let a throw escape
      // and reach whatever scheduled this attempt.
      result = { ok: false, retryable: true, error: describeError(error), durationMs: 0 };
    }

    if (result.ok) {
      this.outbox.markSent(row.rowId, result.httpStatus);
      this.recordSuccess(row.transportId, now);
      return;
    }

    this.recordFailure(row.transportId, now, result.error);

    const attempts = row.attempts + 1;
    if (!result.retryable || attempts >= MAX_ATTEMPTS) {
      this.outbox.markFailed(row.rowId, { attempts, lastError: result.error, httpStatus: result.httpStatus });
      this.bumpCounter(row.transportId, 'failed');
      return;
    }

    const delayMs = result.retryAfterMs ?? this.backoffDelay(attempts);
    this.outbox.scheduleRetry(row.rowId, {
      attempts,
      nextAttemptAt: new Date(now + delayMs).toISOString(),
      lastError: result.error,
      httpStatus: result.httpStatus,
    });
  }

  /** `delay = min(15min, 2000 * 2^(attempt-1)) * (0.5 + random())` — the spec's curve verbatim,
   *  deliberately tighter than `automations/scheduler.ts`'s six-hour ceiling: a stale notification
   *  is worthless long before six hours, and the staleness ceiling above would drop it anyway. */
  private backoffDelay(attempt: number): number {
    const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
    return base * (0.5 + this.random());
  }

  private recordSuccess(transportId: string, now: number): void {
    const nowIso = new Date(now).toISOString();
    const state = this.health(transportId);
    this.setState(transportId, {
      ...state,
      status: 'ok',
      lastAttemptAt: nowIso,
      lastSuccessAt: nowIso,
      lastError: undefined,
      consecutiveFailures: 0,
      backoffUntil: undefined,
    });
    this.bumpCounter(transportId, 'sent');
  }

  /** Every failed attempt counts toward the breaker, regardless of whether that particular row will
   *  still retry — the breaker is transport-scoped, not row-scoped. Five consecutive failures flip
   *  `status` to `degraded` and open `backoffUntil`; recovery is a normal send attempt succeeding
   *  once `backoffUntil` has passed (no separate healthcheck probe — `NotificationRegistry` does not
   *  expose a wrapped one, and this package's acceptance criteria stops at "flip to degraded"). */
  private recordFailure(transportId: string, now: number, error: string): void {
    const nowIso = new Date(now).toISOString();
    const state = this.health(transportId);
    const consecutiveFailures = state.consecutiveFailures + 1;
    const degraded = consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD;
    this.setState(transportId, {
      ...state,
      status: degraded ? 'degraded' : state.status,
      lastAttemptAt: nowIso,
      lastError: error,
      consecutiveFailures,
      backoffUntil: degraded ? new Date(now + this.backoffDelay(consecutiveFailures)).toISOString() : state.backoffUntil,
    });
  }

  private bumpCounter(transportId: string, key: NotificationCounterKey): void {
    const state = this.health(transportId);
    this.setState(transportId, { ...state, counters: { ...state.counters, [key]: state.counters[key] + 1 } });
  }

  private setState(transportId: string, next: NotificationTransportState): void {
    const parsed = notificationTransportStateSchema.parse(next);
    this.state = { ...this.state, transports: { ...this.state.transports, [transportId]: parsed } };
    atomicWriteJsonSync(this.statePath, this.state);
  }

  private loadState(): void {
    if (!existsSync(this.statePath)) {
      this.state = notificationStateFileSchema.parse({});
      return;
    }
    try {
      const parsed = notificationStateFileSchema.safeParse(JSON.parse(readFileSync(this.statePath, 'utf8')));
      if (parsed.success) {
        this.state = parsed.data;
        return;
      }
    } catch {
      // Fall through to the warning + defaults below.
    }
    this.warn(`notification transport health state at ${this.statePath} is corrupt — resetting to defaults`);
    this.state = notificationStateFileSchema.parse({});
  }
}

function rowToNotification(row: NotificationLogRow): Notification {
  return {
    event: row.event,
    severity: row.severity,
    projectId: row.projectId,
    runIds: row.runIds,
    title: row.title,
    body: row.body,
    ...(row.url ? { url: row.url } : {}),
    dedupeKey: row.dedupeKey,
    createdAt: row.createdAt,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
