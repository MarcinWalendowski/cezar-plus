import type { RunStatus } from '@loki-labs/better-cezar-contract';
import type {
  Notification,
  NotificationEvent,
  QuietHours,
  RateBucketState,
  RateLimitConfig,
  Severity,
} from './types.ts';

/**
 * The pure decider (W1.7, spec "Architecture > The decider" and "Noise control"). Every export
 * here is total and side-effect free: no store, no clock read beyond an injected `now`, no fs —
 * table-tested without a store, a clock or a socket.
 *
 * This is also the ONLY file under `src/notifications/` permitted to contain a bare `RunStatus`
 * string literal (Q12, W1.7 acceptance): `types.ts` and `registry.ts` operate on
 * `NotificationEvent`/`Severity` only, never on a run's own status. And `wantsAttention`
 * (`packages/web/src/lib/attention.ts`) is never imported here or anywhere in this directory —
 * that ladder deliberately excludes `done` and the usage-limit hold (spec Q12), and this notifier
 * deliberately includes both, because a remote user DOES want to hear that the fleet finished and
 * that a task is parked until the window reopens. The divergence is intentional; importing the
 * browser's predicate here would let the two definitions of "this run wants a human" drift apart
 * silently, which is exactly what `decider.test.ts`'s mapping-table guard exists to catch.
 */

// ---- the one mapping table -------------------------------------------------------------------

/**
 * `NotificationEvent -> {severity, defaultEnabled}`, the spec's "Event to notification mapping"
 * table verbatim. `test` carries no meaningful default (a human always triggers it directly,
 * bypassing the matrix entirely — spec "`/test` is the exception path") and is listed only so
 * every {@link NotificationEvent} member has exactly one entry here.
 */
export const EVENT_CATALOG: Readonly<Record<NotificationEvent, { severity: Severity; defaultEnabled: boolean }>> = {
  'run.failed': { severity: 'urgent', defaultEnabled: true },
  'run.needs-you': { severity: 'urgent', defaultEnabled: true },
  'run.review': { severity: 'warn', defaultEnabled: true },
  'run.finished': { severity: 'info', defaultEnabled: true },
  'run.usage-limit': { severity: 'info', defaultEnabled: true },
  'provider.auth-required': { severity: 'urgent', defaultEnabled: true },
  'queue.drained': { severity: 'info', defaultEnabled: false },
  test: { severity: 'info', defaultEnabled: true },
};

/** One run, as the decider needs to see it — a projection of `RunRecord`
 *  (`packages/contract/src/runs.ts`), not the record itself, so this file never depends on the
 *  runs store. `askText`/`pullRequestUrl` are read elsewhere (a bounded tail scan of the run's
 *  NDJSON, W4.5's job) and simply carried through here. */
export interface RunSnapshot {
  runId: string;
  projectId: string;
  projectName?: string;
  title: string;
  status: RunStatus;
  activity?: 'monitoring';
  waitingReason?: 'question' | 'report';
  waitingQuestion?: string;
  autoResumeAt?: string;
  pullRequestUrl?: string;
  /** The last `ask.requested` text. */
  askText?: string;
}

interface MappedEvent {
  event: NotificationEvent;
  severity: Severity;
}

/**
 * The one mapping table, as a pure function of a single run's transition.
 *
 *  - `previousStatus === undefined` is first sight (the boot fetch or a reconnect
 *    reconciliation seeding the cache) and never notifies.
 *  - An unchanged status never notifies.
 *  - `activity === 'monitoring'` never notifies, ever — checked defensively even though every
 *    status it can co-occur with (`running`) already maps to nothing below, because the browser
 *    half of this rule is pinned at `.ai/specs/2026-07-18-subagent-monitoring-status.md:214-215`
 *    and a second, independent guard here is what keeps the server side from silently drifting
 *    from it if the mapping ever grows a `running` case.
 *  - `failed` with `autoResumeAt` is `run.usage-limit`, never also `run.failed`.
 *  - `running`, `queued` and `cancelled` are deliberately not notify-worthy (spec "Event to
 *    notification mapping").
 */
export function mapRunTransition(previousStatus: RunStatus | undefined, run: RunSnapshot): MappedEvent | null {
  if (previousStatus === undefined) return null;
  if (previousStatus === run.status) return null;
  if (run.activity === 'monitoring') return null;

  switch (run.status) {
    case 'failed':
      return run.autoResumeAt
        ? { event: 'run.usage-limit', severity: EVENT_CATALOG['run.usage-limit'].severity }
        : { event: 'run.failed', severity: EVENT_CATALOG['run.failed'].severity };
    case 'waiting':
      return { event: 'run.needs-you', severity: EVENT_CATALOG['run.needs-you'].severity };
    case 'review':
      return { event: 'run.review', severity: EVENT_CATALOG['run.review'].severity };
    case 'done':
      return { event: 'run.finished', severity: EVENT_CATALOG['run.finished'].severity };
    case 'running':
    case 'queued':
    case 'cancelled':
      return null;
    default:
      return null;
  }
}

function buildRunNotification(run: RunSnapshot, mapped: MappedEvent, now: number): Notification {
  const base = {
    event: mapped.event,
    severity: mapped.severity,
    projectId: run.projectId,
    ...(run.projectName ? { projectName: run.projectName } : {}),
    runIds: [run.runId],
    title: run.title,
    dedupeKey: `${run.projectId}:${run.runId}:${mapped.event}`,
    createdAt: new Date(now).toISOString(),
  };
  switch (mapped.event) {
    case 'run.needs-you':
      return {
        ...base,
        body:
          (run.waitingReason === 'question' ? run.waitingQuestion : undefined) ??
          run.askText ??
          'Waiting on you.',
      };
    case 'run.review':
      return {
        ...base,
        body: run.pullRequestUrl ? `Ready for review. ${run.pullRequestUrl}` : 'Ready for review.',
        ...(run.pullRequestUrl ? { url: run.pullRequestUrl } : {}),
      };
    case 'run.usage-limit':
      return {
        ...base,
        body: run.autoResumeAt ? `Paused on a usage limit. Resumes ${run.autoResumeAt}.` : 'Paused on a usage limit.',
      };
    case 'run.failed':
      return { ...base, body: 'Failed.' };
    case 'run.finished':
      return { ...base, body: 'Finished.' };
    default:
      return { ...base, body: '' };
  }
}

/** Occupies (or waits for) one of `maxParallel`'s slots — the definition `queue.drained` derives
 *  its "active count" from (spec Q8: "no server event exists behind it"). `waiting` and `review`
 *  runs have already left the queue and are parked on a human, so they are deliberately excluded. */
const ACTIVE_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['queued', 'running']);

export interface DecideConfig {
  /** ms epoch this store booted — the boot-grace anchor. */
  bootAt: number;
  /** Default 10_000 (spec "No replay storm on restart"). */
  bootGraceMs?: number;
  /** Off by default (Q8) — the caller still narrows further per transport via its own event
   *  matrix; this only controls whether `decide()` computes the candidate at all. */
  queueDrainedEnabled?: boolean;
}

const DEFAULT_BOOT_GRACE_MS = 10_000;

interface ProjectActivity {
  previousActive: number;
  currentActive: number;
  justFinished: boolean;
  projectName?: string;
}

/**
 * `decide(previousStatuses, runs, now, config) -> Notification[]`. Pure over plain values: given
 * the same inputs it returns the same notifications, always. Transport-agnostic — it does not
 * know about transport instances, event matrices, coalescing windows, quiet hours or rate limits;
 * those are per-transport and applied downstream by whoever calls `coalesce`/`applyQuietHours`/
 * `applyRateLimit` below on this function's output, once per enabled transport
 * (`registry.routeFor`).
 *
 * During the boot grace window (`now - bootAt < bootGraceMs`) every transition is silently
 * dropped — "recorded but not sent" (spec): the CALLER still updates its own previous-status map
 * from `runs` regardless of what this returns, so once the window closes a run is no longer
 * "first sight," it is simply back to normal unchanged/changed comparison.
 */
export function decide(
  previousStatuses: ReadonlyMap<string, RunStatus>,
  runs: readonly RunSnapshot[],
  now: number,
  config: DecideConfig,
): Notification[] {
  const bootGraceMs = config.bootGraceMs ?? DEFAULT_BOOT_GRACE_MS;
  const withinBootGrace = now - config.bootAt < bootGraceMs;

  const notifications: Notification[] = [];
  const projects = new Map<string, ProjectActivity>();

  for (const run of runs) {
    const previousStatus = previousStatuses.get(run.runId);

    const activity = projects.get(run.projectId) ?? {
      previousActive: 0,
      currentActive: 0,
      justFinished: false,
      projectName: run.projectName,
    };
    if (previousStatus !== undefined && ACTIVE_STATUSES.has(previousStatus)) activity.previousActive += 1;
    if (ACTIVE_STATUSES.has(run.status)) activity.currentActive += 1;
    if (previousStatus !== undefined && previousStatus !== 'done' && run.status === 'done') {
      activity.justFinished = true;
    }
    if (run.projectName) activity.projectName = run.projectName;
    projects.set(run.projectId, activity);

    if (withinBootGrace) continue;
    const mapped = mapRunTransition(previousStatus, run);
    if (mapped) notifications.push(buildRunNotification(run, mapped, now));
  }

  if (!withinBootGrace && config.queueDrainedEnabled) {
    for (const [projectId, activity] of projects) {
      if (activity.previousActive >= 1 && activity.currentActive === 0 && activity.justFinished) {
        notifications.push(buildQueueDrainedNotification(projectId, activity.projectName, now));
      }
    }
  }

  return notifications;
}

function buildQueueDrainedNotification(projectId: string, projectName: string | undefined, now: number): Notification {
  return {
    event: 'queue.drained',
    severity: EVENT_CATALOG['queue.drained'].severity,
    projectId,
    ...(projectName ? { projectName } : {}),
    runIds: [],
    title: 'Queue drained',
    body: 'All queued runs finished.',
    dedupeKey: `${projectId}:queue-drained:${now}`,
    createdAt: new Date(now).toISOString(),
  };
}

// ---- provider.auth-required (fed via the `('event', ...)` channel, not a run transition) -----

export interface ProviderAuthRequiredInput {
  projectId: string;
  projectName?: string;
  provider: string;
  /** The same identity `provider-auth-runtime.ts:31-34` dedupes on. */
  authFailureId: string;
}

/** Always fires — at-most-once is the outbox's job (`(transportId, dedupeKey)` reservation), not
 *  this function's. Deep-links to the accounts settings: on a box nobody watches, an expired
 *  credential silently fails every subsequent run. */
export function decideProviderAuthRequired(input: ProviderAuthRequiredInput, now: number): Notification {
  return {
    event: 'provider.auth-required',
    severity: EVENT_CATALOG['provider.auth-required'].severity,
    projectId: input.projectId,
    ...(input.projectName ? { projectName: input.projectName } : {}),
    runIds: [],
    title: `${input.provider}: authentication required`,
    body: `Re-authenticate ${input.provider} to keep runs going.`,
    dedupeKey: `${input.projectId}:provider:${input.provider}:${input.authFailureId}`,
    createdAt: new Date(now).toISOString(),
  };
}

// ---- coalescing (Noise control #2) -------------------------------------------------------------

export interface CoalesceOptions {
  /** How many individual runs to name before folding the rest into "and N more". Default 5. */
  maxNamed?: number;
}

const DEFAULT_MAX_NAMED = 5;

/**
 * Merges notifications sharing `(projectId, severity)` into one digest message naming up to
 * `maxNamed` runs then "and N more" — batches never mix projects because the grouping key always
 * includes `projectId`, and never mix severity classes because it always includes `severity`.
 *
 * Operates on whatever batch it is given; the coalescing WINDOW (`coalesceMs`/`urgentCoalesceMs`
 * on `TransportRoute`) is a buffering decision for whoever accumulates that batch over time
 * (the sender, W2.5) — this function itself reads no clock, so the same batch always merges the
 * same way.
 */
export function coalesce(notifications: readonly Notification[], opts: CoalesceOptions = {}): Notification[] {
  const maxNamed = opts.maxNamed ?? DEFAULT_MAX_NAMED;
  const order: string[] = [];
  const groups = new Map<string, Notification[]>();
  for (const notification of notifications) {
    const key = `${notification.projectId} ${notification.severity}`;
    const group = groups.get(key);
    if (group) {
      group.push(notification);
    } else {
      groups.set(key, [notification]);
      order.push(key);
    }
  }

  const merged: Notification[] = [];
  for (const key of order) {
    const group = groups.get(key);
    if (!group) continue;
    merged.push(group.length === 1 && group[0] ? group[0] : mergeGroup(group, maxNamed));
  }
  return merged;
}

function mergeGroup(group: Notification[], maxNamed: number): Notification {
  const first = group[0];
  if (!first) throw new Error('coalesce: empty group');
  const named = group.slice(0, maxNamed);
  const remaining = group.length - named.length;
  const names = named.map((n) => n.title).join(', ');
  const body = remaining > 0 ? `${names} and ${remaining} more` : names;
  return {
    event: first.event,
    severity: first.severity,
    projectId: first.projectId,
    ...(first.projectName ? { projectName: first.projectName } : {}),
    runIds: group.flatMap((n) => n.runIds),
    title: `${group.length} notifications`,
    body,
    dedupeKey: group.map((n) => n.dedupeKey).join('|'),
    createdAt: first.createdAt,
  };
}

// ---- quiet hours (Noise control #4) ------------------------------------------------------------

export interface QuietHoursGate {
  quietHours: QuietHours | null;
  quietHoursAllowUrgent: boolean;
  now: number;
}

/** True when `gate.now` falls inside the configured window, read as WALL-CLOCK time in the
 *  window's (or host's) IANA zone — never a fixed UTC offset, so a 22:00-to-07:00 window is
 *  computed identically across a DST transition instead of drifting by an hour. */
export function isQuietHours(gate: Pick<QuietHoursGate, 'quietHours' | 'now'>): boolean {
  const { quietHours } = gate;
  if (!quietHours) return false;
  const start = parseHHMM(quietHours.start);
  const end = parseHHMM(quietHours.end);
  if (start === end) return false;
  const minutes = wallClockMinutes(gate.now, quietHours.timezone);
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** Only `severity: 'urgent'` passes quiet hours, and only when `quietHoursAllowUrgent`.
 *  Everything else is held (the caller queues it, landing as one digest when the window ends). */
export function applyQuietHours(
  notifications: readonly Notification[],
  gate: QuietHoursGate,
): { allowed: Notification[]; held: Notification[] } {
  if (!isQuietHours(gate)) return { allowed: [...notifications], held: [] };
  const allowed: Notification[] = [];
  const held: Notification[] = [];
  for (const notification of notifications) {
    if (notification.severity === 'urgent' && gate.quietHoursAllowUrgent) allowed.push(notification);
    else held.push(notification);
  }
  return { allowed, held };
}

function parseHHMM(value: string): number {
  const [rawHour, rawMinute] = value.split(':');
  const hour = Number.parseInt(rawHour ?? '0', 10) || 0;
  const minute = Number.parseInt(rawMinute ?? '0', 10) || 0;
  return (hour % 24) * 60 + (minute % 60);
}

function wallClockMinutes(now: number, timezone: string | undefined): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    ...(timezone ? { timeZone: timezone } : {}),
  });
  const parts = formatter.formatToParts(new Date(now));
  const hour = Number.parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const minute = Number.parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  // Some ICU builds render midnight as "24" with hour12:false; normalize either way.
  return (hour % 24) * 60 + (minute % 60);
}

// ---- rate limiting, token bucket (Noise control #3) --------------------------------------------

const MS_PER_HOUR = 60 * 60 * 1000;

export function createRateBucketState(now: number): RateBucketState {
  return { tokens: 0, refilledAt: now, suppressedSinceRefill: 0 };
}

export interface SuppressionSummary {
  count: number;
  title: string;
  body: string;
}

export interface RateLimitResult {
  allowed: Notification[];
  suppressed: Notification[];
  bucket: RateBucketState;
  /** Set when this call closes out a run of suppressions carried from earlier calls (nothing new
   *  was suppressed this round, and the bucket has room) — the "one 'N notifications suppressed'
   *  summary" (Noise control #3). Not a `Notification` itself (there is no `NotificationEvent`
   *  member for a digest of this shape); the caller turns it into whatever it sends. */
  summary?: SuppressionSummary;
}

/**
 * A token bucket per transport instance: refills continuously at `perHour / 3600000` tokens per
 * ms, capped at `burst`, with a hard `perMinute` ceiling applied within THIS call (the caller is
 * expected to call this once per minute-scale batch, matching how `coalesce` is used). Over
 * budget folds into `bucket.suppressedSinceRefill` rather than being dropped; once a call finds
 * room again with nothing new to suppress, the accumulated count closes out as one `summary`.
 */
export function applyRateLimit(
  notifications: readonly Notification[],
  rate: RateLimitConfig,
  now: number,
  bucket: RateBucketState,
): RateLimitResult {
  const elapsedMs = Math.max(0, now - bucket.refilledAt);
  const perMs = rate.perHour / MS_PER_HOUR;
  let tokens = Math.min(rate.burst, bucket.tokens + elapsedMs * perMs);

  const allowed: Notification[] = [];
  const suppressed: Notification[] = [];
  let perMinuteUsed = 0;
  for (const notification of notifications) {
    if (tokens >= 1 && perMinuteUsed < rate.perMinute) {
      tokens -= 1;
      perMinuteUsed += 1;
      allowed.push(notification);
    } else {
      suppressed.push(notification);
    }
  }

  let suppressedSinceRefill = bucket.suppressedSinceRefill + suppressed.length;
  let summary: SuppressionSummary | undefined;
  if (suppressed.length === 0 && bucket.suppressedSinceRefill > 0 && tokens >= 1) {
    summary = buildSuppressionSummary(bucket.suppressedSinceRefill);
    suppressedSinceRefill = 0;
  }

  return {
    allowed,
    suppressed,
    bucket: { tokens, refilledAt: now, suppressedSinceRefill },
    summary,
  };
}

function buildSuppressionSummary(count: number): SuppressionSummary {
  return {
    count,
    title: `${count} notification${count === 1 ? '' : 's'} suppressed`,
    body: `${count} notification${count === 1 ? '' : 's'} were held by the rate limit and are visible in the log.`,
  };
}
