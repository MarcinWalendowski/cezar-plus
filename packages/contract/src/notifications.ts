import { z } from 'zod';

/**
 * The NOTIFICATIONS family of `/api/v1/workspace` — server-side outbound notification transports
 * (F4, `CEZ_NOTIFY=1`). See `.ai/specs/2026-08-06-pluggable-notification-transports.md` and the
 * plan's D11/D23 (transport INSTANCES, never types; a fan-out endpoint is one instance whose config
 * carries a per-channel narrowing array, never one row per channel).
 *
 * One zod definition per wire shape, its type inferred, never a hand-written interface — the same
 * discipline `./automations.ts` documents. `transportViewSchema` below is the REDACTED read shape
 * and structurally cannot carry a secret or a full URL: it has `endpointHost` plus `endpointPath`
 * and a closed `auth` union that carries presence, never a value. The full config
 * (`~/.cezar/notifications.json`, including `webhook.url` and `webhook.auth.{envVar,inline}`) is
 * storage-owned by `packages/cezar/src/notifications/config.ts` (W1.8) and is deliberately NOT
 * mirrored here as an open shape — only the write-only INPUT schemas below carry those fields, and
 * they are never echoed back by a response schema in this file.
 *
 * **Flag-off shape (D19, D4).** With `CEZ_NOTIFY` unset every `GET` answers 200 with a schema-valid
 * empty payload (`{configured: false, transports: [], events: [], ...}`) and every mutator
 * (`PUT`, `POST`, `DELETE`, `/test`, `/log/:rowId/retry`) answers 409 — never 404.
 */

export const notificationEventSchema = z.enum([
  'run.failed',
  'run.needs-you',
  'run.review',
  'run.finished',
  'run.usage-limit',
  'provider.auth-required',
  /** Default OFF (Q8): derived client-side from "active count >=1 -> 0 and something finished in
   *  the window" — there is no server-side queue-drained event. */
  'queue.drained',
  /** The test button / `cez notify test <id>`. Never deduped, rate-limited, or quiet-hours
   *  suppressed — a human pressed it. */
  'test',
]);
export type NotificationEvent = z.infer<typeof notificationEventSchema>;

export const notificationSeveritySchema = z.enum(['info', 'warn', 'urgent']);
export type NotificationSeverity = z.infer<typeof notificationSeveritySchema>;

/** The only kind in v1. A registry-keyed string on the server side, not a literal union there —
 *  mirrored here as a literal because it is the one value this contract currently describes. */
export const transportKindSchema = z.literal('webhook');
export type TransportKind = z.infer<typeof transportKindSchema>;

export const transportHealthStatusSchema = z.enum(['ok', 'degraded', 'unconfigured', 'disabled']);
export type TransportHealthStatus = z.infer<typeof transportHealthStatusSchema>;

/** `{start: "22:00", end: "07:00", timezone?}`. The DST case is load-bearing: a 22:00-to-07:00
 *  window must never become a 25-hour silence. */
export const notificationQuietHoursSchema = z.object({
  start: z.string(),
  end: z.string(),
  /** IANA zone; absent defaults to the host's own. */
  timezone: z.string().optional(),
});
export type NotificationQuietHours = z.infer<typeof notificationQuietHoursSchema>;

export const notificationRateLimitSchema = z.object({
  perHour: z.number().int(),
  burst: z.number().int(),
  perMinute: z.number().int(),
});
export type NotificationRateLimit = z.infer<typeof notificationRateLimitSchema>;

export const transportCapabilitiesSchema = z.object({
  maxTitleChars: z.number().int(),
  maxBodyChars: z.number().int(),
  /** How a deep link is carried: its own field, appended to the body, or dropped. */
  links: z.enum(['field', 'inline', 'none']),
  markdown: z.boolean(),
  batch: z.boolean(),
  /** MUST be true whenever the template renders `{{dedupeKey}}` — a transport that claims not to
   *  carry one would let the sender skip it, and SPEC-417's ingress requires it. */
  idempotencyKey: z.boolean(),
});
export type TransportCapabilities = z.infer<typeof transportCapabilitiesSchema>;

export const webhookPayloadModeSchema = z.enum(['envelope', 'template']);
export type WebhookPayloadMode = z.infer<typeof webhookPayloadModeSchema>;

// ---- redacted read shapes (what a GET can ever answer) ---------------------------------------

/** Presence, never a value. `envVar`/`hint` name WHERE a credential lives, not what it is. */
export const transportAuthViewSchema = z.union([
  z.object({ source: z.literal('env'), envVar: z.string(), present: z.boolean() }),
  /** `hint` is the last four characters, and only at length >= 12. */
  z.object({ source: z.literal('inline'), present: z.boolean(), hint: z.string().optional() }),
  z.object({ source: z.literal('none') }),
]);
export type TransportAuthView = z.infer<typeof transportAuthViewSchema>;

export const transportHealthCountersSchema = z.object({
  sent: z.number().int(),
  failed: z.number().int(),
  dropped: z.number().int(),
  suppressed: z.number().int(),
  leaseReclaimed: z.number().int(),
  requeued: z.number().int(),
});
export type TransportHealthCounters = z.infer<typeof transportHealthCountersSchema>;

/** `status` is a persisted enum WRITTEN by a transition, never recomputed at read time from
 *  `backoffUntil` against the clock (Q13, D8/D20) — naming a field stored does not make it stored. */
export const transportHealthSchema = z.object({
  status: transportHealthStatusSchema,
  lastAttemptAt: z.string().optional(),
  lastSuccessAt: z.string().optional(),
  lastError: z.string().optional(),
  consecutiveFailures: z.number().int(),
  backoffUntil: z.string().optional(),
  counters: transportHealthCountersSchema,
});
export type TransportHealth = z.infer<typeof transportHealthSchema>;

/**
 * The redacted read shape of one transport row. Structurally cannot carry a secret or a full URL:
 * `endpointHost`/`endpointPath` only (the full `webhook.url` is WRITE-ONLY), and `auth` carries
 * presence rather than a value.
 */
export const transportViewSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  kind: transportKindSchema,
  label: z.string(),
  enabled: z.boolean(),
  endpointHost: z.string(),
  endpointPath: z.string(),
  auth: transportAuthViewSchema,
  /** Per-event opt-in, keyed by `NotificationEvent`; an absent key means that event's own default.
   *  A genuine partial map — NOT every event needs a key, so this is `z.record(z.string(), …)`
   *  rather than an exhaustive record over `notificationEventSchema`. */
  events: z.record(z.string(), z.boolean()),
  /** `null` (or absent) means all projects. */
  projects: z.array(z.string()).nullable(),
  quietHours: notificationQuietHoursSchema.nullable(),
  rate: notificationRateLimitSchema.nullable(),
  capabilities: transportCapabilitiesSchema,
  health: transportHealthSchema,
});
export type TransportView = z.infer<typeof transportViewSchema>;

/** One row of the event-to-notification mapping table, for the matrix UI. */
export const notificationEventCatalogEntrySchema = z.object({
  id: notificationEventSchema,
  label: z.string(),
  severity: notificationSeveritySchema,
  defaultEnabled: z.boolean(),
});
export type NotificationEventCatalogEntry = z.infer<typeof notificationEventCatalogEntrySchema>;

/** Discovered before configured: server-install domain, else loopback; `CEZ_COCKPIT_URL` or a
 *  config key overrides. `source` is why a dead link is diagnosable in one glance. */
export const cockpitUrlSchema = z.object({
  value: z.string(),
  source: z.enum(['config', 'server-install', 'loopback']),
});
export type CockpitUrl = z.infer<typeof cockpitUrlSchema>;

/** The `defaults` sub-object as the GET response echoes it — NOT the same as the stored
 *  `NotificationDefaults` config, which additionally carries the raw `cockpitUrl` override the
 *  top-level `cockpitUrl` field above is derived from. */
export const notificationDefaultsViewSchema = z.object({
  coalesceMs: z.number().int(),
  urgentCoalesceMs: z.number().int(),
  maxAgeMs: z.number().int(),
  quietHours: notificationQuietHoursSchema.nullable(),
  quietHoursAllowUrgent: z.boolean(),
  rate: notificationRateLimitSchema,
});
export type NotificationDefaultsView = z.infer<typeof notificationDefaultsViewSchema>;

// ---- responses -----------------------------------------------------------------------------

/**
 * `GET /workspace/notifications`. Flag off (D19) answers 200 with `configured: false` and every
 * array empty — never 404. No clock-derived field appears anywhere in this body (Q13, D8): `health`
 * carries stored instants and stored counters only.
 */
export const notificationsResponseSchema = z.object({
  configured: z.boolean(),
  cockpitUrl: cockpitUrlSchema,
  defaults: notificationDefaultsViewSchema,
  events: z.array(notificationEventCatalogEntrySchema),
  transports: z.array(transportViewSchema),
});
export type NotificationsResponse = z.infer<typeof notificationsResponseSchema>;

/** `POST /workspace/notifications/transports` (201, 409 duplicate id),
 *  `PUT /workspace/notifications/transports/:id` (404 unknown). */
export const notificationTransportResponseSchema = z.object({ transport: transportViewSchema });
export type NotificationTransportResponse = z.infer<typeof notificationTransportResponseSchema>;

/** `DELETE /workspace/notifications/transports/:id` — idempotent. */
export const notificationTransportDeletedResponseSchema = z.object({ deleted: z.literal(true) });
export type NotificationTransportDeletedResponse = z.infer<typeof notificationTransportDeletedResponseSchema>;

/** `POST /workspace/notifications/transports/:id/test` — bypasses dedupe, coalescing, quiet hours
 *  and the rate bucket. Returns the verbatim (redacted) `DeliveryResult`: the one place a raw
 *  upstream error string is surfaced, because that is what a person debugging a webhook needs. */
export const notificationTestResultSchema = z.object({
  delivered: z.boolean(),
  httpStatus: z.number().int().optional(),
  error: z.string().optional(),
  durationMs: z.number(),
});
export type NotificationTestResult = z.infer<typeof notificationTestResultSchema>;

export const notificationLogStatusSchema = z.enum(['reserved', 'sending', 'sent', 'failed', 'dropped']);
export type NotificationLogStatus = z.infer<typeof notificationLogStatusSchema>;

export const notificationDroppedReasonSchema = z.enum(['stale', 'rate', 'quiet-expired', 'transport-removed']);
export type NotificationDroppedReason = z.infer<typeof notificationDroppedReasonSchema>;

/** One outbox row, redacted: `request` carries host+path and header NAMES only — never a header
 *  value and never an interpolated body. Every row passes `redactDeep` before it is ever appended,
 *  so this shape is already what disk holds, not a second redaction at the wire. */
export const notificationLogRowSchema = z.object({
  seq: z.number().int(),
  rowId: z.string(),
  transportId: z.string(),
  /** `(transportId, dedupeKey)` is the at-most-once key. */
  dedupeKey: z.string(),
  event: notificationEventSchema,
  severity: notificationSeveritySchema,
  projectId: z.string(),
  runIds: z.array(z.string()).max(50),
  title: z.string().max(200),
  body: z.string().max(2_000),
  url: z.string().optional(),
  status: notificationLogStatusSchema,
  attempts: z.number().int().default(0),
  nextAttemptAt: z.string().optional(),
  lastError: z.string().max(500).optional(),
  httpStatus: z.number().int().optional(),
  droppedReason: notificationDroppedReasonSchema.optional(),
  request: z.object({ url: z.string(), headerNames: z.array(z.string()) }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type NotificationLogRow = z.infer<typeof notificationLogRowSchema>;

/** `GET /workspace/notifications/log`. Flag off answers `{rows: []}`. */
export const notificationLogResponseSchema = z.object({
  rows: z.array(notificationLogRowSchema),
  nextCursor: z.string().optional(),
});
export type NotificationLogResponse = z.infer<typeof notificationLogResponseSchema>;

/** `POST /workspace/notifications/log/:rowId/retry`. */
export const notificationRetryResponseSchema = z.object({ requeued: z.boolean() });
export type NotificationRetryResponse = z.infer<typeof notificationRetryResponseSchema>;

// ---- request bodies ------------------------------------------------------------------------
//
// `z.input`, like every other request type in this package. These are the only schemas in this
// file allowed to carry a credential shape (`envVar`/`inline`) or a full URL — they are WRITE-ONLY,
// never echoed back by a response schema.

/** `webhook.url` and `auth.inline` are accepted here and never returned. Omitting `auth` on a PUT
 *  leaves the stored credential alone; `auth.inline === "__unchanged__"` does the same explicitly,
 *  so a UI round-trip can never blank a secret it was never shown. A URL carrying userinfo
 *  (`https://user:pass@host/...`) is rejected server-side at parse time. */
export const notificationTransportAuthInputSchema = z.union([
  z.object({ scheme: z.literal('bearer'), header: z.string().optional(), envVar: z.string() }),
  z.object({ scheme: z.literal('bearer'), header: z.string().optional(), inline: z.string() }),
]);
export type NotificationTransportAuthInput = z.input<typeof notificationTransportAuthInputSchema>;

/** Closed placeholder set, enforced server-side at template-load time, never at send time:
 *  `{{title}} {{body}} {{text}} {{url}} {{event}} {{severity}} {{project}} {{count}} {{runId}}
 *  {{dedupeKey}}`. Required when `payload === 'template'`. */
export const notificationWebhookInputSchema = z.object({
  url: z.string(),
  method: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  auth: notificationTransportAuthInputSchema.optional(),
  payload: webhookPayloadModeSchema,
  template: z.string().optional(),
  timeoutMs: z.number().int().optional(),
  successStatuses: z.array(z.number().int()).optional(),
});
export type NotificationWebhookInput = z.input<typeof notificationWebhookInputSchema>;

/** `POST /workspace/notifications/transports`. */
export const createNotificationTransportInputSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  kind: transportKindSchema.default('webhook'),
  label: z.string(),
  enabled: z.boolean().optional(),
  /** Per-event opt-in; a genuine partial map (see `transportViewSchema.events`). */
  events: z.record(z.string(), z.boolean()).optional(),
  projects: z.array(z.string()).nullable().optional(),
  quietHours: notificationQuietHoursSchema.nullable().optional(),
  rate: notificationRateLimitSchema.nullable().optional(),
  capabilities: transportCapabilitiesSchema,
  webhook: notificationWebhookInputSchema,
});
export type CreateNotificationTransportInput = z.input<typeof createNotificationTransportInputSchema>;

/** `PUT /workspace/notifications/transports/:id` — a partial edit; every field optional, including
 *  every field of `webhook`. */
export const updateNotificationTransportInputSchema = createNotificationTransportInputSchema
  .omit({ id: true })
  .partial()
  .extend({ webhook: notificationWebhookInputSchema.partial().optional() });
export type UpdateNotificationTransportInput = z.input<typeof updateNotificationTransportInputSchema>;

/** `PUT /workspace/notifications` — a partial merge of `defaults` only. `cockpitUrl: null` means
 *  "go back to discovering it". */
export const updateNotificationDefaultsInputSchema = z.object({
  coalesceMs: z.number().int().min(0).max(300_000).optional(),
  urgentCoalesceMs: z.number().int().min(0).max(300_000).optional(),
  maxAgeMs: z.number().int().optional(),
  cockpitUrl: z.string().nullable().optional(),
  quietHours: notificationQuietHoursSchema.nullable().optional(),
  quietHoursAllowUrgent: z.boolean().optional(),
  rate: notificationRateLimitSchema.optional(),
});
export type UpdateNotificationDefaultsInput = z.input<typeof updateNotificationDefaultsInputSchema>;
