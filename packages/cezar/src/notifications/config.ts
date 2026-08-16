import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  transportKindSchema,
  transportCapabilitiesSchema,
  notificationQuietHoursSchema,
  notificationRateLimitSchema,
  webhookPayloadModeSchema,
  type NotificationEvent,
  type TransportCapabilities,
  type NotificationQuietHours,
  type NotificationRateLimit,
} from '@loki-labs/better-cezar-contract';
import { cezarHomeDir } from '../paths.ts';
import { atomicWriteJsonSync } from '../workspace/config.ts';
import {
  assertWebhookUrlHasNoUserinfo,
  collectNotificationSecretValues,
  describeAuth,
  resolveAuth,
  webhookAuthSchema,
  WebhookUrlCredentialError,
  type AuthView,
  type ResolvedAuth,
  type WebhookAuth,
} from './secrets.ts';

/**
 * `~/.cezar/notifications.json` — server-side outbound notification transport instances
 * (F4, `CEZ_NOTIFY=1`). `.ai/specs/2026-08-06-pluggable-notification-transports.md`, Data Model 1,
 * Q9 and the plan's D11/D23 (transport INSTANCES, one `kind: 'webhook'`; a fan-out endpoint that
 * serves several channels is ONE row whose config carries a per-channel narrowing array, never one
 * row per channel).
 *
 * Its OWN file, on the `agent-accounts.json` precedent (`workspace/agent-accounts.ts:13-25`): a
 * cezar that has never heard of notifications does not open this file, so it cannot drop them,
 * whereas a key inside `config.json` would make survival depend on another version's
 * `.passthrough()`. House rules, applied verbatim:
 *
 * - every field optional/defaulted with `.catch`, so a bad value degrades per key rather than
 *   discarding the row or the file;
 * - `.passthrough()` at every object level, so a NEWER cezar's keys survive an older one;
 * - per-entry salvage for `transports[]` — one hand-edited row never evicts the rest;
 * - atomic tmp+rename writes at `0600` (dir `0700`) through `atomicWriteJsonSync`, which already
 *   calls `assertCezarHomeWriteIsSandboxed`;
 * - a corrupt or unreadable file degrades to in-memory defaults with ONE warning, left on disk
 *   untouched — the next successful merge-write is what repairs it.
 *
 * `paths.ts` (scaffold-owned, W1.1) does not yet export a `notificationsConfigPath()` helper
 * alongside its `agentAccountsPath()` / `notesPath()` siblings, so the path is resolved locally
 * here from the already-exported `cezarHomeDir()` rather than touching that file — see the
 * dispatch-contract "touch only your files" rule. Worth folding into `paths.ts` for consistency
 * once the scaffold is free to.
 *
 * The credential itself never lives here: `webhook.auth` stores a REFERENCE (an env var name, or —
 * for a caller with nothing to point one at — an inline value), resolved at send time by
 * `./secrets.ts`, never echoed back by a read. See that module for the redaction argument.
 */

export const NOTIFICATION_TRANSPORT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

const DEFAULT_RATE: NotificationRateLimit = { perHour: 10, burst: 4, perMinute: 2 };
const DEFAULT_WEBHOOK_HEADERS: Readonly<Record<string, string>> = { 'content-type': 'application/json' };
const DEFAULT_SUCCESS_STATUSES: readonly number[] = [200, 202];
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60_000; // staleness ceiling, 6h
const DEFAULT_COALESCE_MS = 20_000;
const DEFAULT_URGENT_COALESCE_MS = 5_000;

/** Applied whenever a row's own `capabilities` is absent or malformed — matches the outbox row's
 *  own `title`/`body` bounds (`notificationLogRowSchema`) since those are the caps that actually
 *  bind regardless of what a transport claims. `idempotencyKey: false` is the safe default: a
 *  transport MUST opt in by declaring it true, per the spec, whenever its template renders
 *  `{{dedupeKey}}`. */
const DEFAULT_CAPABILITIES: TransportCapabilities = {
  maxTitleChars: 200,
  maxBodyChars: 2_000,
  links: 'inline',
  markdown: false,
  batch: true,
  idempotencyKey: false,
};

/**
 * One transport row's webhook config. `url` is the one load-bearing field beyond identity: a row
 * whose URL fails to validate (unparseable per `assertWebhookUrlHasNoUserinfo`, see `./secrets.ts`)
 * names no usable endpoint and is dropped by the row-level salvage below, which is also what makes
 * "never stored" hold even for a hand-edited file — the userinfo check runs on every load, not only
 * at the moment a candidate row is first written.
 */
const webhookConfigSchema = z
  .object({
    url: z
      .string()
      .min(1)
      .max(4_096)
      .superRefine((raw, ctx) => {
        try {
          assertWebhookUrlHasNoUserinfo(raw);
        } catch (err) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: err instanceof Error ? err.message : String(err) });
        }
      }),
    method: z.string().trim().min(1).max(16).default('POST').catch('POST'),
    headers: z
      .record(z.string(), z.string())
      .default(() => ({ ...DEFAULT_WEBHOOK_HEADERS }))
      .catch(() => ({ ...DEFAULT_WEBHOOK_HEADERS })),
    auth: webhookAuthSchema.optional().catch(undefined),
    payload: webhookPayloadModeSchema.default('envelope').catch('envelope'),
    template: z.string().max(8_192).optional().catch(undefined),
    timeoutMs: z.number().int().positive().max(120_000).default(DEFAULT_TIMEOUT_MS).catch(DEFAULT_TIMEOUT_MS),
    successStatuses: z
      .array(z.number().int())
      .min(1)
      .max(20)
      .default(() => [...DEFAULT_SUCCESS_STATUSES])
      .catch(() => [...DEFAULT_SUCCESS_STATUSES]),
  })
  .passthrough();
export type WebhookConfig = z.infer<typeof webhookConfigSchema>;

/**
 * One row of `transports[]`. `id` and `kind` are load-bearing alongside `webhook` (above): an entry
 * missing any of the three names no working transport, so `.safeParse()` on it fails and the
 * per-entry salvage in `notificationsConfigSchema` drops it while the rest of the array survives.
 * Every other field degrades per key.
 */
const transportRowSchema = z
  .object({
    id: z.string().regex(NOTIFICATION_TRANSPORT_ID_RE),
    /** The only kind in v1 (Q1/D11/D23) — a row naming anything else names no working transport
     *  under this cezar and is dropped the same way a missing `webhook.url` would be. */
    kind: transportKindSchema,
    label: z.string().max(200).catch(''),
    enabled: z.boolean().default(true).catch(true),
    /** Per-event opt-in; a genuine partial map (an absent key means that event's own default,
     *  decided by W1.7's decider) — `z.record(z.string(), …)` rather than an exhaustive record over
     *  the event enum, mirroring `transportViewSchema.events` in `@loki-labs/better-cezar-contract`. */
    events: z
      .record(z.string(), z.boolean())
      .default(() => ({}))
      .catch(() => ({})),
    /** `null` (or absent) means all projects. */
    projects: z.array(z.string()).nullable().default(null).catch(null),
    quietHours: notificationQuietHoursSchema.nullable().default(null).catch(null),
    rate: notificationRateLimitSchema.nullable().default(null).catch(null),
    capabilities: transportCapabilitiesSchema
      .default(() => ({ ...DEFAULT_CAPABILITIES }))
      .catch(() => ({ ...DEFAULT_CAPABILITIES })),
    webhook: webhookConfigSchema,
  })
  .passthrough();
export type NotificationTransportRow = z.infer<typeof transportRowSchema>;

/** Workspace-wide defaults a transport inherits wherever its own value is `null`/absent. */
const notificationsDefaultsSchema = z
  .object({
    coalesceMs: z.number().int().min(0).max(300_000).default(DEFAULT_COALESCE_MS).catch(DEFAULT_COALESCE_MS),
    urgentCoalesceMs: z
      .number()
      .int()
      .min(0)
      .max(300_000)
      .default(DEFAULT_URGENT_COALESCE_MS)
      .catch(DEFAULT_URGENT_COALESCE_MS),
    /** Staleness ceiling — a queued notification older than this closes `dropped: 'stale'` rather
     *  than being delivered late. */
    maxAgeMs: z.number().int().nonnegative().default(DEFAULT_MAX_AGE_MS).catch(DEFAULT_MAX_AGE_MS),
    /** `null` = discover (server-install domain, else loopback); a config override for the
     *  auto-detected `cockpitUrl`. */
    cockpitUrl: z.string().nullable().default(null).catch(null),
    quietHours: notificationQuietHoursSchema.nullable().default(null).catch(null),
    quietHoursAllowUrgent: z.boolean().default(true).catch(true),
    rate: notificationRateLimitSchema
      .default(() => ({ ...DEFAULT_RATE }))
      .catch(() => ({ ...DEFAULT_RATE })),
  })
  .passthrough();
export type NotificationsDefaults = z.infer<typeof notificationsDefaultsSchema>;

const notificationsConfigSchema = z
  .object({
    /** Format cursor for THIS file, independent of `config.json`'s `schemaVersion`. */
    version: z.number().int().min(0).default(1).catch(1),
    // `.prefault`, not `.default`: unlike `.default`, it re-runs the inner schema on the
    // substituted value, which is what actually fills `notificationsDefaultsSchema`'s own
    // per-field defaults when the whole `defaults` key is absent. `.default` alone would hand back
    // a bare `{}` — verified empirically, not assumed; see `workspace/config.ts`'s identical
    // `resources: resourcesSchema.prefault(...).catch(...)` for the precedent.
    defaults: notificationsDefaultsSchema
      .prefault(() => ({}))
      .catch(() => notificationsDefaultsSchema.parse({})),
    /** Per-entry salvage: a corrupt or unusable row is dropped, the rest of the array survives (a
     *  whole-array `.catch([])` would evict every transport over one bad row). First-wins on a
     *  duplicated `id`. */
    transports: z
      .array(z.unknown())
      .default(() => [])
      .catch(() => [])
      .transform((entries) => {
        const seen = new Set<string>();
        return entries.flatMap((entry) => {
          const parsed = transportRowSchema.safeParse(entry);
          if (!parsed.success || seen.has(parsed.data.id)) return [];
          seen.add(parsed.data.id);
          return [parsed.data];
        });
      }),
  })
  .passthrough();
export type NotificationsConfig = z.infer<typeof notificationsConfigSchema>;

/** The in-memory default — what a missing file behaves like, and the zero-config state:
 *  `{version: 1, transports: []}` (plus `defaults` filled from its own per-field defaults). */
export function defaultNotificationsConfig(): NotificationsConfig {
  return notificationsConfigSchema.parse({});
}

export function notificationsConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(cezarHomeDir(env), 'notifications.json');
}

async function loadNotificationsConfigFrom(path: string): Promise<NotificationsConfig> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    // Missing — the zero-config default, silently. No file created, no warning.
    return defaultNotificationsConfig();
  }
  try {
    const parsed = notificationsConfigSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // malformed JSON — fall through to the warning + defaults
  }
  console.warn(`[cez] notifications config ${path} is corrupt — ignoring it (no transports load until it is fixed)`);
  return defaultNotificationsConfig();
}

/**
 * Read the store on demand — never cached, never throws. Reading never writes, so a read-only home
 * can never fail boot: the worst case is falling back to `defaultNotificationsConfig()`.
 */
export async function loadNotificationsConfig(): Promise<NotificationsConfig> {
  return loadNotificationsConfigFrom(notificationsConfigPath());
}

/**
 * Read-modify-write merge: re-read, apply `mutator`, atomic-rename write (`0600`, dir `0700`) via
 * `atomicWriteJsonSync`. The path is resolved ONCE, before the read, and the same value feeds both
 * the read and the write — `workspace/config.ts`'s `mergeWriteWorkspaceConfig` documents why
 * resolving it twice is a data-loss bug (`CEZ_HOME` can change mid-flight under a test's `afterEach`).
 * Throws on write failure (e.g. a read-only home); degrading is the caller's policy, per house rules.
 */
export async function mergeWriteNotificationsConfig(
  mutator: (config: NotificationsConfig) => NotificationsConfig | void,
): Promise<NotificationsConfig> {
  const path = notificationsConfigPath();
  const current = await loadNotificationsConfigFrom(path);
  const next = mutator(current) ?? current;
  atomicWriteJsonSync(path, next);
  return next;
}

/** The default event matrix a freshly-created transport (including the env bootstrap below)
 *  starts from — the "Default" column of the spec's event-to-notification mapping table.
 *  `queue.drained` stays off (Q8: derived, no server event backs it) and `test` never appears here
 *  (it is never deduped, rate-limited or matrix-gated — a human pressed the button). */
export const DEFAULT_EVENT_MATRIX: Readonly<Partial<Record<NotificationEvent, boolean>>> = {
  'run.failed': true,
  'run.needs-you': true,
  'run.review': true,
  'run.finished': true,
  'run.usage-limit': true,
  'provider.auth-required': true,
  'queue.drained': false,
};

/** The single-transport container bootstrap id — not pinned by the spec, chosen here since nothing
 *  downstream depends on a specific value; only that it is stable and satisfies the id regex. */
export const ENV_BOOTSTRAP_TRANSPORT_ID = 'env';
const ENV_BOOTSTRAP_AUTH_ENV_VAR = 'CEZ_NOTIFY_WEBHOOK_TOKEN';

/**
 * The container-case bootstrap (`.env.example` "notification transports", Configuration on a
 * headless VPS #3): `CEZ_NOTIFY_WEBHOOK_URL` plus `CEZ_NOTIFY_WEBHOOK_TOKEN` synthesise exactly one
 * enabled `webhook` transport with the default event matrix, entirely in memory. Writes NO file —
 * this is a pure function, and the caller (constructing the runtime's transport list) decides how
 * to combine it with whatever `loadNotificationsConfig()` returns. Either var absent yields nothing,
 * so a container that sets only one of the two gets silence rather than a half-configured transport.
 */
export function envBootstrapTransport(env: NodeJS.ProcessEnv = process.env): NotificationTransportRow | undefined {
  const url = env.CEZ_NOTIFY_WEBHOOK_URL?.trim();
  const token = env.CEZ_NOTIFY_WEBHOOK_TOKEN?.trim();
  if (!url || !token) return undefined;
  return transportRowSchema.parse({
    id: ENV_BOOTSTRAP_TRANSPORT_ID,
    kind: 'webhook',
    label: 'Webhook (env)',
    enabled: true,
    events: { ...DEFAULT_EVENT_MATRIX },
    webhook: {
      url,
      payload: 'envelope',
      auth: { scheme: 'bearer', header: 'authorization', envVar: ENV_BOOTSTRAP_AUTH_ENV_VAR },
    },
  });
}

// Re-exported so a caller only needs `./config.ts` for the common path; the credential-shaped
// primitives (`WebhookAuth`, `resolveAuth`, `describeAuth`, the userinfo check) stay DEFINED in
// `./secrets.ts`, which is the one file allowed to talk about what a secret is.
export { assertWebhookUrlHasNoUserinfo, collectNotificationSecretValues, describeAuth, resolveAuth, WebhookUrlCredentialError };
export type { AuthView, ResolvedAuth, WebhookAuth, NotificationEvent, TransportCapabilities, NotificationQuietHours, NotificationRateLimit };
