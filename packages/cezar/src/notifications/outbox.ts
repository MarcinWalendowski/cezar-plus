import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  notificationLogRowSchema,
  notificationLogStatusSchema,
  type NotificationDroppedReason,
  type NotificationLogRow,
  type NotificationLogStatus,
} from '@open-mercato/cezar-contract';
import { redactDeep } from '../core/secret-redaction.ts';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from '../paths.ts';
import type { Notification } from './types.ts';

/**
 * The durable outbox (W2.5, spec "Architecture > Outbox and sender" and Data Model 2). One
 * append-only NDJSON row per (notification x transport), reserved through the `reserveReceipt`
 * collision pattern (`automations/store.ts:147-165`) keyed on `(transportId, dedupeKey)` — the
 * spec's own reference, reproduced here rather than imported, because `AutomationStore` has no
 * exported primitive to reuse: it is the SHAPE that carries over, not the code.
 *
 * A "row" is a logical entity (`rowId`) whose history is a sequence of PHYSICAL NDJSON lines —
 * every transition (`reserved -> sending -> sent/failed/dropped`, or a retry bump) appends a NEW
 * line rather than mutating one in place, and the LATEST line per `rowId` is what a reader sees.
 * This is the same append-then-latest-wins shape `AutomationStore` uses for receipts/log rows.
 *
 * `paths.ts` (scaffold-owned, W1.1) does not export a `notificationsDataDir()` helper alongside
 * its `agentAccountsPath()` / `notesPath()` siblings, so `notificationsDataDir()` below resolves
 * it locally from the already-exported `cezarHomeDir()` — the same move `notifications/config.ts`
 * (W1.8) already makes for `notificationsConfigPath()`, and for the same reason (dispatch-contract
 * rule 5: touch only your own files).
 */

const OUTBOX_FILE = 'outbox.ndjson';
const LOCK_FILE = 'outbox.lock';
/** "the automations/store.ts:192-206 shape" — 7-day window plus a 5,000-row cap, per the spec's
 *  own retention numbers for THIS feature (distinct from automations' 90-day/10,000-row figures). */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const RETENTION_ROW_CAP = 5_000;
const MAYBE_COMPACT_ROW_THRESHOLD = 20_000;
const TITLE_MAX = 200;
const BODY_MAX = 2_000;
const ERROR_MAX = 500;
const RUN_IDS_MAX = 50;

export function notificationsDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(cezarHomeDir(env), 'notifications');
}

export interface NotificationOutboxOptions {
  warn?: (message: string) => void;
  now?: () => Date;
  /**
   * Every secret value currently resolvable from the live notifications config — recomputed by
   * the CALLER on demand (`collectNotificationSecretValues` in `./secrets.ts`, W1.8) rather than
   * captured once at construction, so a credential added to a transport after the outbox opened
   * is still caught. Defaults to `() => []`: an outbox opened with no accessor has nothing extra
   * to scrub beyond whatever the caller already stripped upstream.
   */
  secrets?: () => readonly string[];
}

export interface NotificationOutboxListOptions {
  transportId?: string;
  status?: NotificationLogStatus;
  /** Rows with `seq` at or after this cursor are excluded — matches `automations/store.ts`'s
   *  `logs({cursor})` convention (an exclusive upper bound on `seq`, newest-first paging). */
  cursor?: number;
  /** Capped at 100, the same ceiling `automations/store.ts:180-181` applies. */
  limit?: number;
}

export class NotificationOutboxLease {
  private released = false;
  constructor(
    private readonly path: string,
    private readonly fd: number,
    /** True when this acquisition had to remove a stale lock file first — a caller (the sender)
     *  can use this to distinguish "recovered from a dead process" from "the lease was simply
     *  free," for its own `leaseReclaimed` counter. */
    readonly reclaimed: boolean = false,
  ) {}

  release(): void {
    if (this.released) return;
    this.released = true;
    closeSync(this.fd);
    try {
      unlinkSync(this.path);
    } catch {
      // Already removed during shutdown cleanup, or by a reclaim that lost the race.
    }
  }
}

export class NotificationOutbox {
  /** Latest row per collision key (`${transportId}:${dedupeKey}`) — the at-most-once index. */
  private latest = new Map<string, NotificationLogRow>();
  /** `rowId -> collision key`, so callers addressing a row by its public `rowId` (the wire
   *  identity `POST /log/:rowId/retry` uses) can still resolve it against the map above. */
  private rowIdToKey = new Map<string, string>();
  private seq = 0;
  private warnedKinds = new Set<string>();
  private readonly now: () => Date;
  private readonly warn: (message: string) => void;
  private readonly secrets: () => readonly string[];

  static open(dataDir: string = notificationsDataDir(), options: NotificationOutboxOptions = {}): NotificationOutbox {
    const store = new NotificationOutbox(dataDir, options);
    store.load();
    return store;
  }

  private constructor(
    readonly dataDir: string,
    options: NotificationOutboxOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.warn = options.warn ?? (() => {});
    this.secrets = options.secrets ?? (() => []);
  }

  /**
   * The at-most-once reservation point, keyed on `(transportId, dedupeKey)`. Returns the created
   * row, or `undefined` on collision — a collision against ANY prior status (including a
   * long-`sent`/`failed`/`dropped` row) still refuses, because "at most once, ever" (Noise
   * control #1) must hold across a restart, not just while a row is in flight.
   *
   * Never throws: every field that could otherwise violate the wire schema's bounds (a run title
   * longer than 200 chars, more than 50 `runIds`) is clamped before `notificationLogRowSchema`
   * ever sees it, and any other unexpected failure is caught, warned once, and answers `undefined`
   * — a dropped reservation, not a crash reaching the registry that calls this.
   */
  reserve(transportId: string, notification: Notification): NotificationLogRow | undefined {
    try {
      const key = reservationKey(transportId, notification.dedupeKey);
      if (this.latest.has(key)) return undefined;
      const nowIso = this.now().toISOString();
      const row = notificationLogRowSchema.parse({
        seq: this.seq + 1,
        rowId: randomUUID(),
        transportId,
        dedupeKey: notification.dedupeKey,
        event: notification.event,
        severity: notification.severity,
        projectId: notification.projectId,
        runIds: notification.runIds.slice(0, RUN_IDS_MAX),
        title: truncate(notification.title, TITLE_MAX),
        body: truncate(notification.body, BODY_MAX),
        ...(notification.url ? { url: notification.url } : {}),
        status: 'reserved' satisfies NotificationLogStatus,
        attempts: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      this.appendRow(row);
      return row;
    } catch (error) {
      this.warnOnce('reserve', `Failed to reserve a notification outbox row: ${describeError(error)}`);
      return undefined;
    }
  }

  get(rowId: string): NotificationLogRow | undefined {
    const key = this.rowIdToKey.get(rowId);
    return key ? this.latest.get(key) : undefined;
  }

  /** Rows a sender should consider sending right now or later (`nextAttemptAt` may be in the
   *  future) — everything still in the `reserved` state. */
  pending(): NotificationLogRow[] {
    return [...this.latest.values()].filter((row) => row.status === 'reserved');
  }

  list(options: NotificationOutboxListOptions = {}): NotificationLogRow[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
    return [...this.latest.values()]
      .filter((row) => !options.transportId || row.transportId === options.transportId)
      .filter((row) => !options.status || row.status === options.status)
      .filter((row) => options.cursor === undefined || row.seq < options.cursor)
      .sort((a, b) => a.seq - b.seq)
      .slice(-limit)
      .reverse();
  }

  markSending(rowId: string): NotificationLogRow | undefined {
    return this.transition(rowId, { status: 'sending' });
  }

  markSent(rowId: string, httpStatus?: number): NotificationLogRow | undefined {
    return this.transition(rowId, {
      status: 'sent',
      httpStatus,
      nextAttemptAt: undefined,
      lastError: undefined,
      droppedReason: undefined,
    });
  }

  scheduleRetry(
    rowId: string,
    input: { attempts: number; nextAttemptAt: string; lastError?: string; httpStatus?: number },
  ): NotificationLogRow | undefined {
    return this.transition(rowId, {
      status: 'reserved',
      attempts: input.attempts,
      nextAttemptAt: input.nextAttemptAt,
      lastError: input.lastError ? truncate(input.lastError, ERROR_MAX) : undefined,
      httpStatus: input.httpStatus,
    });
  }

  markFailed(rowId: string, input: { attempts: number; lastError?: string; httpStatus?: number }): NotificationLogRow | undefined {
    return this.transition(rowId, {
      status: 'failed',
      attempts: input.attempts,
      lastError: input.lastError ? truncate(input.lastError, ERROR_MAX) : undefined,
      httpStatus: input.httpStatus,
      nextAttemptAt: undefined,
    });
  }

  markDropped(rowId: string, reason: NotificationDroppedReason): NotificationLogRow | undefined {
    return this.transition(rowId, { status: 'dropped', droppedReason: reason, nextAttemptAt: undefined });
  }

  /** `POST /log/:rowId/retry`'s primitive: a manual retry gets a fresh attempt budget. Only a
   *  terminally `failed` or `dropped` row is eligible — retrying a row still in flight would race
   *  the sender's own next attempt. */
  requeue(rowId: string): NotificationLogRow | undefined {
    const current = this.get(rowId);
    if (!current || (current.status !== 'failed' && current.status !== 'dropped')) return undefined;
    return this.transition(rowId, {
      status: 'reserved',
      attempts: 0,
      nextAttemptAt: undefined,
      lastError: undefined,
      httpStatus: undefined,
      droppedReason: undefined,
    });
  }

  /**
   * Restart recovery (spec "Outbox and sender" bullet 1): a row still `reserved`/`sending` whose
   * `updatedAt` is older than `staleAfterMs` (default 10 minutes — a crash mid-send, or a process
   * that died between reserve and send) is re-queued exactly once: this call moves it back to
   * `reserved` with `nextAttemptAt` set to now, which refreshes `updatedAt` and takes it out of
   * consideration for the NEXT call to this same method (it will not re-trigger unless it goes
   * stale again on its own). Returns the touched rows (their POST-requeue state) so a caller that
   * tracks per-transport counters can attribute them precisely, rather than guessing from whatever
   * happens to be pending afterward.
   */
  requeueStaleReservations(staleAfterMs = 10 * 60_000): NotificationLogRow[] {
    const now = this.now().getTime();
    const touched: NotificationLogRow[] = [];
    for (const row of [...this.latest.values()]) {
      if (row.status !== 'reserved' && row.status !== 'sending') continue;
      if (now - Date.parse(row.updatedAt) < staleAfterMs) continue;
      const next = this.transition(row.rowId, { status: 'reserved', nextAttemptAt: new Date(now).toISOString() });
      if (next) touched.push(next);
    }
    return touched;
  }

  /** `automations/store.ts:192-200`'s shape: keep the latest row per key within the retention
   *  window, then cap the survivors to the most recent `RETENTION_ROW_CAP`. */
  compact(): void {
    const cutoff = this.now().getTime() - RETENTION_MS;
    let survivors = [...this.latest.values()].filter((row) => Date.parse(row.updatedAt) >= cutoff);
    survivors.sort((a, b) => a.seq - b.seq);
    if (survivors.length > RETENTION_ROW_CAP) survivors = survivors.slice(-RETENTION_ROW_CAP);
    this.rewrite(survivors);
  }

  maybeCompact(): void {
    if (this.latest.size > MAYBE_COMPACT_ROW_THRESHOLD) this.compact();
  }

  /**
   * `openSync(path, 'wx', 0o600)` with 10-minute staleness reclaim — `automations/store.ts:208-227`'s
   * primitive, reproduced (not imported: `AutomationLease`/`acquireLease` are private to
   * `AutomationStore`) so two cezar processes sharing a `CEZ_HOME` never both run the sender.
   */
  acquireLease(staleAfterMs = 10 * 60_000, reclaimed = false): NotificationOutboxLease | undefined {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const path = join(this.dataDir, LOCK_FILE);
    assertCezarHomeWriteIsSandboxed(path);
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: this.now().toISOString() }));
      return new NotificationOutboxLease(path, fd, reclaimed);
    } catch {
      try {
        if (this.now().getTime() - statSync(path).mtimeMs > staleAfterMs) {
          unlinkSync(path);
          return this.acquireLease(staleAfterMs, true);
        }
      } catch {
        // A contender released it first, or the directory is read-only.
      }
      return undefined;
    }
  }

  private transition(rowId: string, patch: Partial<NotificationLogRow>): NotificationLogRow | undefined {
    const key = this.rowIdToKey.get(rowId);
    const current = key ? this.latest.get(key) : undefined;
    if (!current) return undefined;
    try {
      const next = notificationLogRowSchema.parse({
        ...current,
        ...patch,
        seq: this.seq + 1,
        rowId: current.rowId,
        transportId: current.transportId,
        dedupeKey: current.dedupeKey,
        createdAt: current.createdAt,
        updatedAt: this.now().toISOString(),
      });
      this.appendRow(next);
      return next;
    } catch (error) {
      this.warnOnce('transition', `Failed to persist a notification outbox transition: ${describeError(error)}`);
      return undefined;
    }
  }

  private load(): void {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const rows = this.readAll();
    this.latest.clear();
    this.rowIdToKey.clear();
    for (const row of rows) this.index(row);
    this.seq = rows.at(-1)?.seq ?? 0;
  }

  private index(row: NotificationLogRow): void {
    const key = reservationKey(row.transportId, row.dedupeKey);
    this.latest.set(key, row);
    this.rowIdToKey.set(row.rowId, key);
  }

  private appendRow(row: NotificationLogRow): void {
    this.seq = row.seq;
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const path = join(this.dataDir, OUTBOX_FILE);
    assertCezarHomeWriteIsSandboxed(path);
    // Redact BEFORE it ever reaches disk, and keep the in-memory copy identical to what disk
    // holds (never an unredacted live copy a future reader could serialize directly) — Verification
    // negative control #2.
    const redacted = redactDeep(row, this.secrets());
    const fd = openSync(path, 'a', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(redacted)}\n`);
    } finally {
      closeSync(fd);
    }
    this.index(redacted);
  }

  private rewrite(rows: NotificationLogRow[]): void {
    const path = join(this.dataDir, OUTBOX_FILE);
    assertCezarHomeWriteIsSandboxed(path);
    const body = rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
    const temp = `${path}.tmp`;
    writeFileSync(temp, body, { mode: 0o600 });
    renameSync(temp, path);
    this.latest.clear();
    this.rowIdToKey.clear();
    for (const row of rows) this.index(row);
  }

  private readAll(): NotificationLogRow[] {
    const path = join(this.dataDir, OUTBOX_FILE);
    if (!existsSync(path)) return [];
    const rows: NotificationLogRow[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const parsed = notificationLogRowSchema.safeParse(JSON.parse(line));
        if (parsed.success) rows.push(parsed.data);
        else this.warnOnce('malformed-row', `Skipped a malformed row in ${OUTBOX_FILE}.`);
      } catch {
        this.warnOnce('malformed-row', `Skipped a malformed row in ${OUTBOX_FILE}.`);
      }
    }
    return rows;
  }

  private warnOnce(kind: string, message: string): void {
    if (this.warnedKinds.has(kind)) return;
    this.warnedKinds.add(kind);
    this.warn(message);
  }
}

function reservationKey(transportId: string, dedupeKey: string): string {
  return `${transportId}:${dedupeKey}`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
