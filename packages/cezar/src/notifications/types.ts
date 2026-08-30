/**
 * Notification transports (F4, `CEZ_NOTIFY=1`) — the shared vocabulary. See
 * `.ai/specs/2026-08-06-pluggable-notification-transports.md` ("Data Models > 3. In-memory
 * types") and the plan's D11/D23 (transport INSTANCES, never types).
 *
 * Everything here is a plain interface, never a zod schema: these are in-memory domain shapes
 * consumed by `registry.ts`, `decider.ts` and (later) `transports/webhook.ts`, `observer.ts`,
 * `outbox.ts` — not wire shapes. The WIRE contract for the HTTP API lives in
 * `@loki-labs/cezar-plus-contract` (`notifications.ts`, scaffold-owned); a future package adapts
 * between the two at the boundary, the same split `runs/store.ts` keeps from `contract/runs.ts`.
 *
 * This file, `registry.ts` and `decider.ts` are the three files under `src/notifications/`
 * that exist so far. Per the spec's Q12/W1.7 acceptance, `decider.ts` is the ONLY file in this
 * directory permitted to contain a bare `RunStatus` string literal — nothing here references a
 * run's own status, only the notification-side `NotificationEvent`/`Severity` vocabulary.
 */

// ---- the closed event set ------------------------------------------------------------------

/** Mirrors `notificationEventSchema` in `@loki-labs/cezar-plus-contract` exactly — kept as a plain
 *  union here (rather than importing the zod-inferred type) because this file must not depend on
 *  the scaffold's wire package for its own internal vocabulary; `decider.test.ts` pins the two
 *  in agreement. */
export type NotificationEvent =
  | 'run.failed'
  | 'run.needs-you'
  | 'run.review'
  | 'run.finished'
  | 'run.usage-limit'
  | 'provider.auth-required'
  /** Default OFF (Q8) — derived, no server-side queue event exists behind it. */
  | 'queue.drained'
  /** The test button / `cez notify test <id>`. Never deduped, rate-limited, or quiet-hours
   *  suppressed — a human pressed it. */
  | 'test';

/** Every member of {@link NotificationEvent}, for runtime iteration (building the event-catalog
 *  UI list, and the source-level guard that no `permission.*` member ever sneaks in — Q7). */
export const NOTIFICATION_EVENTS: readonly NotificationEvent[] = [
  'run.failed',
  'run.needs-you',
  'run.review',
  'run.finished',
  'run.usage-limit',
  'provider.auth-required',
  'queue.drained',
  'test',
];

export type Severity = 'info' | 'warn' | 'urgent';

// ---- transport capabilities and delivery outcomes -------------------------------------------

export interface TransportCapabilities {
  maxTitleChars: number;
  maxBodyChars: number;
  /** How a deep link is carried: its own field, appended to the body, or dropped. */
  links: 'field' | 'inline' | 'none';
  markdown: boolean;
  batch: boolean;
  /** MUST be true whenever the template renders `{{dedupeKey}}`: this endpoint requires it, and
   *  a transport that claims not to carry one would let the sender skip it. */
  idempotencyKey: boolean;
}

export type DeliveryResult =
  | { ok: true; providerId?: string; httpStatus?: number; durationMs: number }
  | {
      ok: false;
      retryable: boolean;
      error: string;
      httpStatus?: number;
      retryAfterMs?: number;
      durationMs: number;
    };

export interface HealthResult {
  ok: boolean;
  error?: string;
  durationMs?: number;
}

export interface NotificationTransport {
  readonly id: string;
  readonly kind: 'webhook';
  readonly capabilities: TransportCapabilities;
  /** MUST NOT throw. Every failure is a `DeliveryResult`. The registry wraps it anyway (a
   *  synchronous throw, a rejected promise and a hang all coerce to
   *  `{ok:false, retryable:true}`), because a transport is third-party-shaped code and a run
   *  must never see it. */
  send(notification: Notification, signal: AbortSignal): Promise<DeliveryResult>;
  healthcheck(signal: AbortSignal): Promise<HealthResult>;
}

// ---- the decider's output -------------------------------------------------------------------

/**
 * One notification, already resolved to a concrete event/severity/body — the pure decider's
 * output and the registry's input. Not the outbox row (`outboxRowSchema` in the spec, W2.5's):
 * this is transport-agnostic, minted once per notify-worthy transition, before routing.
 */
export interface Notification {
  event: NotificationEvent;
  severity: Severity;
  projectId: string;
  projectName?: string;
  runIds: string[];
  title: string;
  body: string;
  url?: string;
  /** `${projectId}:${runId}:${event}` for run events, `${projectId}:provider:${provider}:${authFailureId}`
   *  for auth, `test:${uuid}` for the test button (Noise control #5). The outbox's at-most-once
   *  key is `(transportId, dedupeKey)`. */
  dedupeKey: string;
  /** ISO 8601, when the decider minted it. */
  createdAt: string;
}

// ---- routing / noise-control configuration ---------------------------------------------------

/** `{start: "22:00", end: "07:00", timezone?}`. The DST case is load-bearing: a 22:00-to-07:00
 *  window must never become a 25-hour silence — `decider.ts` reads wall-clock time in this zone
 *  at the instant given, never a fixed UTC offset. */
export interface QuietHours {
  start: string;
  end: string;
  /** IANA zone; absent defaults to the host's own. */
  timezone?: string;
}

export interface RateLimitConfig {
  perHour: number;
  burst: number;
  perMinute: number;
}

/** The token bucket's persisted state (siblings live in `~/.cezar/notifications/state.json`,
 *  W2.5's). Threaded through `decider.ts#applyRateLimit` by the caller — pure functions don't
 *  hold it themselves. */
export interface RateBucketState {
  tokens: number;
  /** ms epoch of the last refill computation. */
  refilledAt: number;
  /** Carried across calls while a run of suppressions is open, so the eventual "N suppressed"
   *  summary can name the whole run, not just the latest batch. */
  suppressedSinceRefill: number;
}

/**
 * One registered transport's routing/noise-control config — the slice `registry.ts` and
 * `decider.ts` need to route and rate-limit. NOT the full persisted `~/.cezar/notifications.json`
 * row (which also carries the webhook endpoint, auth reference, label and capabilities); that
 * full shape is storage-owned by `config.ts` (W1.8, a parallel leaf that does not depend on this
 * file — see the plan's package table), and a future activation package (W3.1/W4.5/W4.7) adapts
 * a loaded config row into this one at wiring time.
 */
export interface TransportRoute {
  readonly transportId: string;
  readonly enabled: boolean;
  /** Per-event opt-in; a genuine partial map — an absent key means the event's own default
   *  (`decider.ts`'s `EVENT_CATALOG`). */
  readonly events: Readonly<Partial<Record<NotificationEvent, boolean>>>;
  /** `null` means all projects. */
  readonly projects: readonly string[] | null;
  readonly quietHours: QuietHours | null;
  readonly quietHoursAllowUrgent: boolean;
  readonly rate: RateLimitConfig | null;
  readonly coalesceMs: number;
  readonly urgentCoalesceMs: number;
}

/** A live transport implementation paired with its routing config — what `registry.ts` holds one
 *  of per instance (plan D11/D23: instances, never types). */
export interface RegisteredTransport {
  readonly transport: NotificationTransport;
  readonly route: TransportRoute;
}

/**
 * The seam `registry.dispatch()` reserves outbox rows through. Injected rather than imported,
 * because the durable outbox is W2.5's (`notifications/outbox.ts`), a sibling package this file
 * has no dependency on. MUST NOT throw synchronously; a returned promise MAY reject, and the
 * registry never awaits it (spec Architecture #2: "HTTP happens later, on a timer, off the emit
 * path" — reservation is the one synchronous op the observer's critical path pays for).
 */
export interface NotificationSink {
  reserve(transportId: string, notification: Notification): void | Promise<void>;
}
