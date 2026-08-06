import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  createNotificationTransportInputSchema,
  notificationLogStatusSchema,
  updateNotificationDefaultsInputSchema,
  updateNotificationTransportInputSchema,
  type CockpitUrl,
  type NotificationDefaultsView,
  type NotificationEventCatalogEntry,
  type NotificationLogResponse,
  type NotificationRetryResponse,
  type NotificationsResponse,
  type NotificationTestResult,
  type NotificationTransportAuthInput,
  type NotificationTransportDeletedResponse,
  type NotificationTransportResponse,
  type NotificationWebhookInput,
  type TransportHealth,
  type TransportHealthCounters,
  type TransportView,
} from "@open-mercato/cezar-contract";
import { jsonZodValidator, queryZodValidator } from "./validators.ts";
import { resolveCapabilities } from "./capabilities.ts";
import { loadServerState } from "../server-install/state.ts";
import { redactDeep } from "../core/secret-redaction.ts";
import { EVENT_CATALOG } from "../notifications/decider.ts";
import {
  NOTIFICATION_EVENTS,
  type Notification,
  type NotificationEvent,
  type RegisteredTransport,
  type TransportRoute,
} from "../notifications/types.ts";
import {
  NOTIFICATION_TRANSPORT_ID_RE,
  assertWebhookUrlHasNoUserinfo,
  collectNotificationSecretValues,
  describeAuth,
  loadNotificationsConfig,
  mergeWriteNotificationsConfig,
  type NotificationsConfig,
  type NotificationsDefaults,
  type NotificationTransportRow,
  type WebhookAuth,
  type WebhookConfig,
} from "../notifications/config.ts";
import {
  createWebhookTransport,
  validateWebhookTemplate,
} from "../notifications/transports/webhook.ts";
import type { NotificationTransportState } from "../notifications/sender.ts";
import type { NotificationRuntime } from "./project-context.ts";

/**
 * The NOTIFICATIONS family of `/api/v1/workspace` (F4, `CEZ_NOTIFY=1`) - pluggable outbound
 * webhook transports. See `.ai/specs/2026-08-06-pluggable-notification-transports.md`
 * ("API Contracts") and `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D11/D19/D23.
 *
 * Not to be confused with the pre-existing Settings → Notifications section
 * (`packages/web/src/routes/settings/notifications-section.tsx`), which is the per-browser
 * desktop-notification toggle (spec R6 step 1.7) - an unrelated, already-shipped feature. This
 * family is the machine-wide, server-side outbound webhook transport registry.
 *
 * Workspace-level and single-mount (never mirrored under `/api/v1/p/:projectId`) - transports
 * answer for the whole machine, like `/api/v1/workspace/config`. Chained into ONE family with an
 * INFERRED return type, mounted into `workspaceV1` in `server.ts`.
 *
 * **What this file can and cannot wire on its own (W4.7, plan D6).** Config CRUD (`GET`/`PUT`
 * defaults, the transport `POST`/`PUT`/`DELETE`) and `POST .../test` are self-contained: they read
 * and write `~/.cezar/notifications.json` directly (`../notifications/config.ts`) and, for `/test`,
 * build a throwaway transport with `createWebhookTransport` and send through it - none of that
 * needs the live runtime. `GET .../log` and `POST .../log/:rowId/retry` DO need it (the durable
 * outbox lives on `ProjectContexts.notifications()`, one per `CEZ_HOME`, not per request), and so
 * does keeping the registry's live routing table in sync as rows are added/edited/removed/loaded
 * at boot. That runtime is reached through `NotificationsRouteDeps.notifications`, which
 * `server.ts` does not yet pass at this file's `createNotificationsRoutes()` call site - that one
 * line (`createNotificationsRoutes({ notifications: () => contexts.notifications() })`) is a
 * scaffold-owned edit (D6) this package cannot make; see the implementation report. Until it lands,
 * `GET .../log` answers `{rows: []}` and `POST .../log/:rowId/retry` answers 409 - both honest,
 * schema-valid answers, never a crash.
 */

export interface NotificationsRouteDeps {
  /** The shared workspace-level runtime `ProjectContexts.notifications()` exposes (W3.1, already
   *  wired there - `sender.start()` runs at boot): `outbox` for the log, `registry` to register
   *  live transports so a future run notification (W4.5, not yet built) can actually reach them,
   *  and direct transport construction for `/test`. `undefined` in every test and, today, in
   *  production too (see the top-of-file note) until the scaffold threads it. */
  notifications?: () => NotificationRuntime | undefined;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

const NOTIFY_OFF =
  "notifications are disabled - set CEZ_NOTIFY=1 to enable them";

/** Mirrors `notifications/config.ts`'s own (unexported) `WebhookConfig` defaults - the spec's Data
 *  Model 1 literal values, duplicated here because `config.ts` does not export them and this file
 *  cannot edit it to add an export (touch only the files you own). Any candidate row this file
 *  writes that OMITS one of these is filled in by `notificationsConfigSchema`'s own defaults the
 *  next time it is loaded (see the `reloaded` re-read after every write below), which is why
 *  staying byte-identical to config.ts's own private literals is not load-bearing for correctness
 *  - only for what the FIRST read-back shows before that reload happens. */
const DEFAULT_WEBHOOK_METHOD = "POST";
const DEFAULT_WEBHOOK_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json",
};
const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;
const DEFAULT_WEBHOOK_SUCCESS_STATUSES: readonly number[] = [200, 202];

const AUTH_UNCHANGED_SENTINEL = "__unchanged__";

const ZERO_HEALTH_COUNTERS: TransportHealthCounters = {
  sent: 0,
  failed: 0,
  dropped: 0,
  suppressed: 0,
  leaseReclaimed: 0,
  requeued: 0,
};
const UNCONFIGURED_HEALTH: TransportHealth = {
  status: "unconfigured",
  consecutiveFailures: 0,
  counters: { ...ZERO_HEALTH_COUNTERS },
};

const EMPTY_NOTIFICATIONS: NotificationsResponse = {
  configured: false,
  cockpitUrl: { value: "", source: "loopback" },
  defaults: {
    coalesceMs: 0,
    urgentCoalesceMs: 0,
    maxAgeMs: 0,
    quietHours: null,
    quietHoursAllowUrgent: false,
    rate: { perHour: 0, burst: 0, perMinute: 0 },
  },
  events: [],
  transports: [],
};

const EMPTY_NOTIFICATIONS_LOG: NotificationLogResponse = { rows: [] };

const notificationsLogQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  transportId: z.string().max(32).optional(),
  status: notificationLogStatusSchema.optional(),
});

/** Display labels for the matrix UI - display-only strings, owned by this API layer, never a
 *  second copy of `decider.ts`'s "one mapping table" (that table is severity/defaultEnabled, read
 *  from `EVENT_CATALOG` below, not re-derived here). `test` is excluded: it is not matrix-driven
 *  (spec: "Never deduped, rate-limited or quiet-hours-suppressed - a human pressed it"), so it has
 *  no row in the catalog a per-event toggle UI would render. */
const EVENT_LABELS: Readonly<
  Record<Exclude<NotificationEvent, "test">, string>
> = {
  "run.failed": "Run failed",
  "run.needs-you": "Needs you",
  "run.review": "Ready for review",
  "run.finished": "Run finished",
  "run.usage-limit": "Paused on usage limit",
  "provider.auth-required": "Provider auth required",
  "queue.drained": "Queue drained",
};

const EVENT_CATALOG_VIEW: NotificationEventCatalogEntry[] =
  NOTIFICATION_EVENTS.filter(
    (event): event is Exclude<NotificationEvent, "test"> => event !== "test",
  ).map((id) => ({
    id,
    label: EVENT_LABELS[id],
    severity: EVENT_CATALOG[id].severity,
    defaultEnabled: EVENT_CATALOG[id].defaultEnabled,
  }));

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNotifyOn(env: NodeJS.ProcessEnv): boolean {
  return resolveCapabilities(env).notify;
}

/** `new URL()` can throw on a stored-but-unparseable string (the config schema lets a
 *  non-parseable URL through - see `assertWebhookUrlHasNoUserinfo`'s own doc comment, "silently let
 *  through here"); the caller falls back to showing the raw string as the path with an empty host,
 *  rather than crashing a GET over one hand-edited row. */
function safeParseUrl(
  raw: string,
): { host: string; pathname: string } | undefined {
  try {
    const url = new URL(raw);
    return { host: url.host, pathname: url.pathname };
  } catch {
    return undefined;
  }
}

function toHealthView(
  state: NotificationTransportState | undefined,
): TransportHealth {
  if (!state)
    return { ...UNCONFIGURED_HEALTH, counters: { ...ZERO_HEALTH_COUNTERS } };
  return {
    status: state.status,
    ...(state.lastAttemptAt !== undefined
      ? { lastAttemptAt: state.lastAttemptAt }
      : {}),
    ...(state.lastSuccessAt !== undefined
      ? { lastSuccessAt: state.lastSuccessAt }
      : {}),
    ...(state.lastError !== undefined ? { lastError: state.lastError } : {}),
    consecutiveFailures: state.consecutiveFailures,
    ...(state.backoffUntil !== undefined
      ? { backoffUntil: state.backoffUntil }
      : {}),
    counters: {
      sent: state.counters.sent,
      failed: state.counters.failed,
      dropped: state.counters.dropped,
      suppressed: state.counters.suppressed,
      leaseReclaimed: state.counters.leaseReclaimed,
      requeued: state.counters.requeued,
    },
  };
}

function toTransportView(
  row: NotificationTransportRow,
  runtime: NotificationRuntime | undefined,
  env: NodeJS.ProcessEnv,
): TransportView {
  const url = safeParseUrl(row.webhook.url);
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    enabled: row.enabled,
    endpointHost: url?.host ?? "",
    endpointPath: url?.pathname ?? row.webhook.url,
    auth: describeAuth(row.webhook.auth, env),
    events: row.events,
    projects: row.projects,
    quietHours: row.quietHours,
    rate: row.rate,
    capabilities: row.capabilities,
    health: toHealthView(runtime?.sender.health(row.id)),
  };
}

/** Q15: discovered before configured. `CEZ_COCKPIT_URL` wins over the stored `defaults.cockpitUrl`
 *  override when both are set (an env var is a deploy-time override of a file the operator may not
 *  have touched for this box); otherwise the `server-install` domain, else loopback. Neither branch
 *  reads the clock (D8). */
function discoverCockpitUrl(
  env: NodeJS.ProcessEnv,
  override: string | null,
): CockpitUrl {
  const configured = env.CEZ_COCKPIT_URL?.trim() || override?.trim();
  if (configured) return { value: configured, source: "config" };
  const state = loadServerState();
  if (state.domain)
    return { value: `https://${state.domain}`, source: "server-install" };
  return { value: `http://127.0.0.1:${state.primaryPort}`, source: "loopback" };
}

function toDefaultsView(
  defaults: NotificationsDefaults,
): NotificationDefaultsView {
  return {
    coalesceMs: defaults.coalesceMs,
    urgentCoalesceMs: defaults.urgentCoalesceMs,
    maxAgeMs: defaults.maxAgeMs,
    quietHours: defaults.quietHours,
    quietHoursAllowUrgent: defaults.quietHoursAllowUrgent,
    rate: defaults.rate,
  };
}

function buildNotificationsResponse(
  config: NotificationsConfig,
  runtime: NotificationRuntime | undefined,
  env: NodeJS.ProcessEnv,
): NotificationsResponse {
  return {
    configured: true,
    cockpitUrl: discoverCockpitUrl(env, config.defaults.cockpitUrl),
    defaults: toDefaultsView(config.defaults),
    events: EVENT_CATALOG_VIEW,
    transports: config.transports.map((row) =>
      toTransportView(row, runtime, env),
    ),
  };
}

// ---- wire input -> stored row -----------------------------------------------------------------

function toStoredAuth(auth: NotificationTransportAuthInput): WebhookAuth {
  const header = auth.header ?? "authorization";
  return "envVar" in auth
    ? { scheme: "bearer", header, envVar: auth.envVar }
    : { scheme: "bearer", header, inline: auth.inline };
}

function isUnchangedAuthSentinel(
  auth: NotificationTransportAuthInput,
): boolean {
  return "inline" in auth && auth.inline === AUTH_UNCHANGED_SENTINEL;
}

function toStoredWebhook(input: NotificationWebhookInput): WebhookConfig {
  return {
    url: input.url,
    method: input.method ?? DEFAULT_WEBHOOK_METHOD,
    headers: input.headers ?? { ...DEFAULT_WEBHOOK_HEADERS },
    ...(input.auth !== undefined ? { auth: toStoredAuth(input.auth) } : {}),
    payload: input.payload,
    ...(input.template !== undefined ? { template: input.template } : {}),
    timeoutMs: input.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS,
    successStatuses: input.successStatuses ?? [
      ...DEFAULT_WEBHOOK_SUCCESS_STATUSES,
    ],
  };
}

function toStoredRow(
  input: z.output<typeof createNotificationTransportInputSchema>,
): NotificationTransportRow {
  return {
    id: input.id,
    kind: input.kind,
    label: input.label,
    enabled: input.enabled ?? true,
    events: input.events ?? {},
    projects: input.projects ?? null,
    quietHours: input.quietHours ?? null,
    rate: input.rate ?? null,
    capabilities: input.capabilities,
    webhook: toStoredWebhook(input.webhook),
  };
}

/** Partial merge for `PUT .../transports/:id`. Omitted top-level keys keep the stored value;
 *  `webhook` merges field-by-field on the same terms, with `auth` special-cased per spec: omitted
 *  keeps the stored credential, and `auth.inline === "__unchanged__"` does the same explicitly so a
 *  UI round-trip that never saw the real secret cannot blank it. */
function mergeTransportRow(
  current: NotificationTransportRow,
  patch: z.output<typeof updateNotificationTransportInputSchema>,
): NotificationTransportRow {
  return {
    ...current,
    ...(patch.label !== undefined ? { label: patch.label } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.events !== undefined ? { events: patch.events } : {}),
    ...(patch.projects !== undefined ? { projects: patch.projects } : {}),
    ...(patch.quietHours !== undefined ? { quietHours: patch.quietHours } : {}),
    ...(patch.rate !== undefined ? { rate: patch.rate } : {}),
    ...(patch.capabilities !== undefined
      ? { capabilities: patch.capabilities }
      : {}),
    webhook: mergeWebhook(current.webhook, patch.webhook),
  };
}

function mergeWebhook(
  current: WebhookConfig,
  patch: Partial<NotificationWebhookInput> | undefined,
): WebhookConfig {
  if (!patch) return current;
  const authPatch =
    patch.auth === undefined
      ? undefined
      : isUnchangedAuthSentinel(patch.auth)
        ? undefined
        : toStoredAuth(patch.auth);
  return {
    ...current,
    ...(patch.url !== undefined ? { url: patch.url } : {}),
    ...(patch.method !== undefined ? { method: patch.method } : {}),
    ...(patch.headers !== undefined ? { headers: patch.headers } : {}),
    ...(authPatch !== undefined ? { auth: authPatch } : {}),
    ...(patch.payload !== undefined ? { payload: patch.payload } : {}),
    ...(patch.template !== undefined ? { template: patch.template } : {}),
    ...(patch.timeoutMs !== undefined ? { timeoutMs: patch.timeoutMs } : {}),
    ...(patch.successStatuses !== undefined
      ? { successStatuses: patch.successStatuses }
      : {}),
  };
}

/** The two runtime checks a candidate `webhook` must pass before it is ever written: no userinfo in
 *  the URL (a credential in a URL is a credential in every log line it appears in), and - when
 *  `payload === 'template'` - a closed-placeholder, JSON-valid template (W2.4). Everything else is
 *  either shape-validated already (the wire zod schema) or has no wrong answer (labels, matrices).
 *  Returns an error string, or `undefined` when the candidate is fine to persist. */
function validateWebhookCandidate(
  webhook: Pick<WebhookConfig, "url" | "payload" | "template">,
): string | undefined {
  try {
    assertWebhookUrlHasNoUserinfo(webhook.url);
  } catch (err) {
    return describeErr(err);
  }
  if (webhook.payload === "template") {
    if (!webhook.template)
      return 'webhook payload mode is "template" but no template is configured';
    try {
      validateWebhookTemplate(webhook.template);
    } catch (err) {
      return describeErr(err);
    }
  }
  return undefined;
}

// ---- keeping the live registry in sync (best-effort, never fails a write) ---------------------

function toTransportRoute(
  row: NotificationTransportRow,
  defaults: NotificationsDefaults,
): TransportRoute {
  return {
    transportId: row.id,
    enabled: row.enabled,
    events: row.events as Partial<Record<NotificationEvent, boolean>>,
    projects: row.projects,
    quietHours: row.quietHours ?? defaults.quietHours,
    quietHoursAllowUrgent: defaults.quietHoursAllowUrgent,
    rate: row.rate ?? defaults.rate,
    coalesceMs: defaults.coalesceMs,
    urgentCoalesceMs: defaults.urgentCoalesceMs,
  };
}

/** Registers (or, on a build failure, unregisters) one row's live transport. A row that fails to
 *  build - most likely a template that no longer validates after a hand-edit of the JSON file
 *  outside the API - is simply absent from the live registry; the config write itself already
 *  succeeded, so the operator can fix and re-`PUT`. Never throws: this runs after the durable write
 *  has already committed, so a registry failure must not turn a successful save into an error
 *  response. */
function syncLiveTransport(
  runtime: NotificationRuntime | undefined,
  row: NotificationTransportRow,
  defaults: NotificationsDefaults,
  env: NodeJS.ProcessEnv,
): void {
  if (!runtime) return;
  try {
    const transport = createWebhookTransport(
      { id: row.id, capabilities: row.capabilities, webhook: row.webhook },
      { env },
    );
    const entry: RegisteredTransport = {
      transport,
      route: toTransportRoute(row, defaults),
    };
    runtime.registry.register(entry);
  } catch {
    runtime.registry.unregister(row.id);
  }
}

/** Boot-time hydration: the registry starts with zero registered transports (`project-context.ts`'s
 *  own doc comment on `NotificationRuntime` says filling it from `~/.cezar/notifications.json` is
 *  this package's job). Fire-and-forget, off the request path - mirrors `KnowledgeStore`'s own
 *  "runs off the boot path, after listen" precedent (`project-context.ts`) - and a no-op whenever
 *  `deps.notifications` is not wired (today's production shape, see the top-of-file note) or the
 *  flag is off, so it is safe to call unconditionally from the factory below. */
async function hydrateRegistry(deps: NotificationsRouteDeps): Promise<void> {
  const runtime = deps.notifications?.();
  if (!runtime) return;
  const env = deps.env ?? process.env;
  if (!isNotifyOn(env)) return;
  const config = await loadNotificationsConfig();
  for (const row of config.transports)
    syncLiveTransport(runtime, row, config.defaults, env);
}

// ---- /test -------------------------------------------------------------------------------------

/** `event: 'test'` per Q5/Noise-control #5: `dedupeKey` carries a fresh uuid so a test send is
 *  never deduped, and it never touches the outbox at all (`/test` calls the transport directly,
 *  bypassing dedupe/coalescing/quiet-hours/rate - spec, "a human pressed a button"). */
function buildTestNotification(now: number): Notification {
  const iso = new Date(now).toISOString();
  return {
    event: "test",
    severity: "info",
    projectId: "test",
    runIds: [],
    title: "Test notification",
    body: `Sent from cezar at ${iso}.`,
    dedupeKey: `test:${randomUUID()}`,
    createdAt: iso,
  };
}

export function createNotificationsRoutes(deps: NotificationsRouteDeps = {}) {
  void hydrateRegistry(deps).catch(() => {});

  return (
    new Hono()
      .get("/workspace/notifications", async (c) => {
        const env = deps.env ?? process.env;
        if (!isNotifyOn(env)) return c.json(EMPTY_NOTIFICATIONS);
        const config = await loadNotificationsConfig();
        return c.json(
          buildNotificationsResponse(config, deps.notifications?.(), env),
        );
      })

      // Partial merge of `defaults` only.
      .put(
        "/workspace/notifications",
        jsonZodValidator(updateNotificationDefaultsInputSchema),
        async (c) => {
          const env = deps.env ?? process.env;
          if (!isNotifyOn(env)) return c.json({ error: NOTIFY_OFF }, 409);
          const input = c.req.valid("json");
          const config = await mergeWriteNotificationsConfig((cfg) => {
            if (input.coalesceMs !== undefined)
              cfg.defaults.coalesceMs = input.coalesceMs;
            if (input.urgentCoalesceMs !== undefined)
              cfg.defaults.urgentCoalesceMs = input.urgentCoalesceMs;
            if (input.maxAgeMs !== undefined)
              cfg.defaults.maxAgeMs = input.maxAgeMs;
            if (input.cockpitUrl !== undefined)
              cfg.defaults.cockpitUrl = input.cockpitUrl;
            if (input.quietHours !== undefined)
              cfg.defaults.quietHours = input.quietHours;
            if (input.quietHoursAllowUrgent !== undefined)
              cfg.defaults.quietHoursAllowUrgent = input.quietHoursAllowUrgent;
            if (input.rate !== undefined) cfg.defaults.rate = input.rate;
          });
          return c.json(
            buildNotificationsResponse(config, deps.notifications?.(), env),
          );
        },
      )

      .post(
        "/workspace/notifications/transports",
        jsonZodValidator(createNotificationTransportInputSchema),
        async (c) => {
          const env = deps.env ?? process.env;
          if (!isNotifyOn(env)) return c.json({ error: NOTIFY_OFF }, 409);
          const input = c.req.valid("json");
          if (!NOTIFICATION_TRANSPORT_ID_RE.test(input.id))
            return c.json({ error: `invalid transport id: ${input.id}` }, 400);
          const candidate = toStoredRow(input);
          const invalid = validateWebhookCandidate(candidate.webhook);
          if (invalid) return c.json({ error: invalid }, 400);

          let duplicate = false;
          await mergeWriteNotificationsConfig((cfg) => {
            if (cfg.transports.some((row) => row.id === candidate.id)) {
              duplicate = true;
              return;
            }
            cfg.transports = [...cfg.transports, candidate];
          });
          if (duplicate)
            return c.json(
              { error: `transport already exists: ${candidate.id}` },
              409,
            );

          // Reload rather than trust the mutator's raw return: `mergeWriteNotificationsConfig` never
          // re-parses its own output, so a field this route left to its own default only becomes
          // canonical (schema-filled) on the next validated read.
          const reloaded = await loadNotificationsConfig();
          const saved =
            reloaded.transports.find((row) => row.id === candidate.id) ??
            candidate;
          syncLiveTransport(
            deps.notifications?.(),
            saved,
            reloaded.defaults,
            env,
          );
          const body: NotificationTransportResponse = {
            transport: toTransportView(saved, deps.notifications?.(), env),
          };
          return c.json(body, 201);
        },
      )

      .put(
        "/workspace/notifications/transports/:id",
        jsonZodValidator(updateNotificationTransportInputSchema),
        async (c) => {
          const env = deps.env ?? process.env;
          if (!isNotifyOn(env)) return c.json({ error: NOTIFY_OFF }, 409);
          const id = c.req.param("id");
          const patch = c.req.valid("json");
          const before = await loadNotificationsConfig();
          const current = before.transports.find((row) => row.id === id);
          if (!current)
            return c.json({ error: `unknown transport: ${id}` }, 404);
          const merged = mergeTransportRow(current, patch);
          const invalid = validateWebhookCandidate(merged.webhook);
          if (invalid) return c.json({ error: invalid }, 400);

          let found = false;
          await mergeWriteNotificationsConfig((cfg) => {
            cfg.transports = cfg.transports.map((row) => {
              if (row.id !== id) return row;
              found = true;
              return merged;
            });
          });
          if (!found) return c.json({ error: `unknown transport: ${id}` }, 404);

          const reloaded = await loadNotificationsConfig();
          const saved =
            reloaded.transports.find((row) => row.id === id) ?? merged;
          syncLiveTransport(
            deps.notifications?.(),
            saved,
            reloaded.defaults,
            env,
          );
          const body: NotificationTransportResponse = {
            transport: toTransportView(saved, deps.notifications?.(), env),
          };
          return c.json(body);
        },
      )

      // Idempotent - a second delete of an already-gone id still answers `{deleted: true}`.
      .delete("/workspace/notifications/transports/:id", async (c) => {
        const env = deps.env ?? process.env;
        if (!isNotifyOn(env)) return c.json({ error: NOTIFY_OFF }, 409);
        const id = c.req.param("id");
        await mergeWriteNotificationsConfig((cfg) => {
          cfg.transports = cfg.transports.filter((row) => row.id !== id);
        });
        deps.notifications?.()?.registry.unregister(id);
        const body: NotificationTransportDeletedResponse = { deleted: true };
        return c.json(body);
      })

      // Bypasses dedupe/coalescing/quiet-hours/rate - a human pressed the button. Builds its OWN
      // transport directly from the stored row rather than going through the live registry, so this
      // route works even before `deps.notifications` is wired (see the top-of-file note): a test send
      // needs no shared runtime, only the config it just read.
      .post("/workspace/notifications/transports/:id/test", async (c) => {
        const env = deps.env ?? process.env;
        if (!isNotifyOn(env)) return c.json({ error: NOTIFY_OFF }, 409);
        const id = c.req.param("id");
        const config = await loadNotificationsConfig();
        const row = config.transports.find((t) => t.id === id);
        if (!row) return c.json({ error: `unknown transport: ${id}` }, 404);
        const secrets = collectNotificationSecretValues(config.transports, env);
        const startedAt = deps.now?.() ?? Date.now();

        let result: {
          delivered: boolean;
          httpStatus?: number;
          error?: string;
          durationMs: number;
        };
        try {
          const transport = createWebhookTransport(
            {
              id: row.id,
              capabilities: row.capabilities,
              webhook: row.webhook,
            },
            { env },
          );
          const outcome = await transport.send(
            buildTestNotification(startedAt),
            new AbortController().signal,
          );
          result = outcome.ok
            ? {
                delivered: true,
                ...(outcome.httpStatus !== undefined
                  ? { httpStatus: outcome.httpStatus }
                  : {}),
                durationMs: outcome.durationMs,
              }
            : {
                delivered: false,
                ...(outcome.httpStatus !== undefined
                  ? { httpStatus: outcome.httpStatus }
                  : {}),
                error: outcome.error,
                durationMs: outcome.durationMs,
              };
        } catch (err) {
          result = {
            delivered: false,
            error: describeErr(err),
            durationMs: (deps.now?.() ?? Date.now()) - startedAt,
          };
        }
        const body: NotificationTestResult = redactDeep(result, secrets);
        return c.json(body);
      })

      .get(
        "/workspace/notifications/log",
        queryZodValidator(notificationsLogQuerySchema),
        (c) => {
          const env = deps.env ?? process.env;
          if (!isNotifyOn(env)) return c.json(EMPTY_NOTIFICATIONS_LOG);
          const runtime = deps.notifications?.();
          if (!runtime) return c.json(EMPTY_NOTIFICATIONS_LOG);
          const query = c.req.valid("query");
          const rows = runtime.outbox.list({
            ...(query.transportId !== undefined
              ? { transportId: query.transportId }
              : {}),
            ...(query.status !== undefined ? { status: query.status } : {}),
            ...(query.cursor !== undefined
              ? { cursor: Number(query.cursor) }
              : {}),
            ...(query.limit !== undefined ? { limit: query.limit } : {}),
          });
          const last = rows.at(-1);
          const body: NotificationLogResponse = {
            rows,
            ...(last ? { nextCursor: String(last.seq) } : {}),
          };
          return c.json(body);
        },
      )

      // See the top-of-file note: without `deps.notifications` wired (today's production shape) this
      // 409s rather than silently accepting a retry it cannot act on. Once wired, a requeued row is
      // picked up by the demand-driven sender's NEXT wake (a fresh reservation elsewhere), not
      // necessarily immediately - `NotificationSender` (W2.5) exposes no public wake/nudge hook this
      // package can call after `outbox.requeue()`, which is a real gap reported alongside this file
      // rather than papered over with a second, duplicated copy of the sender's private retry logic.
      .post("/workspace/notifications/log/:rowId/retry", async (c) => {
        const env = deps.env ?? process.env;
        if (!isNotifyOn(env)) return c.json({ error: NOTIFY_OFF }, 409);
        const runtime = deps.notifications?.();
        if (!runtime) return c.json({ error: NOTIFY_OFF }, 409);
        const rowId = c.req.param("rowId");
        const requeued = runtime.outbox.requeue(rowId);
        const body: NotificationRetryResponse = {
          requeued: requeued !== undefined,
        };
        return c.json(body);
      })
  );
}
