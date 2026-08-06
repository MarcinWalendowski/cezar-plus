import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import {
  NOTIFICATION_TRANSPORT_ID_RE,
  DEFAULT_EVENT_MATRIX,
  assertWebhookUrlHasNoUserinfo,
  describeAuth,
  loadNotificationsConfig,
  mergeWriteNotificationsConfig,
  notificationsConfigPath,
  type NotificationQuietHours,
  type NotificationRateLimit,
  type NotificationTransportRow,
  type TransportCapabilities,
  type WebhookAuth,
} from "./config.ts";
import { NotificationOutbox, notificationsDataDir } from "./outbox.ts";
import {
  createWebhookTransport,
  validateWebhookTemplate,
} from "./transports/webhook.ts";
import { NOTIFICATION_EVENTS, type Notification } from "./types.ts";

/**
 * `cez notify` (W4.7, spec "Configuration on a headless VPS" and "CLI"). The terminal twin of the
 * Notifications section a browser cockpit would show, for the operator who is on a VPS with no
 * browser in front of them - the exact case the whole feature exists for (spec TLDR).
 *
 * Talks to `~/.cezar/notifications.json` (`./config.ts`) and `~/.cezar/notifications/outbox.ndjson`
 * (`./outbox.ts`) directly, NOT over HTTP, on the `workspace/projects-cli.ts` precedent: it must
 * work with no server running. `cez notify test <id>` builds and sends through a transport
 * directly (`./transports/webhook.ts`) for the same reason - nothing here depends on the live
 * `NotificationRegistry`/`NotificationSender` runtime `server/notifications-routes.ts` reaches for.
 *
 * `CEZ_HOME` selects which workspace this operates on, exactly as it does for `serve` and for
 * `cezar projects`.
 */

export interface NotifyCommandIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

const defaultIo: NotifyCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export interface NotifyCommandOptions {
  env?: NodeJS.ProcessEnv;
  io?: NotifyCommandIo;
  /** Injected so `cez notify test` never performs a real network call from a unit test. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const USAGE = `usage:
  cez notify list
  cez notify add <id> --url <u> [--auth-env VAR | --auth-inline VALUE]
                       [--events a,b,c] [--label L] [--template T]
                       [--payload envelope|template] [--method M] [--timeout-ms N]
  cez notify set <id> [--url ...] [--events ...] [--quiet HH:MM-HH:MM] [--rate N/h]
                       [--auth-env VAR | --auth-inline VALUE] [--template T] [--label L]
  cez notify enable <id> | disable <id> | rm <id>
  cez notify test <id>          # exit 0 delivered, 1 otherwise - scriptable on a VPS
  cez notify log [--limit N] [--transport <id>]`;

/** Mirrors `config.ts`'s own (unexported) `WebhookConfig`/capability defaults - the spec's Data
 *  Model 1 literal values, duplicated here for the same reason `server/notifications-routes.ts`
 *  duplicates them: `config.ts` does not export them, and this file cannot edit it to add an
 *  export. Kept identical to that file's comment on the same duplication. */
const DEFAULT_WEBHOOK_METHOD = "POST";
const DEFAULT_WEBHOOK_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json",
};
const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;
const DEFAULT_WEBHOOK_SUCCESS_STATUSES: readonly number[] = [200, 202];
const DEFAULT_CAPABILITIES: TransportCapabilities = {
  maxTitleChars: 200,
  maxBodyChars: 2_000,
  links: "inline",
  markdown: false,
  batch: true,
  idempotencyKey: false,
};

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `event: 'test'` (Noise control #5): a fresh dedupe key every call, and this never touches the
 *  outbox - `cez notify test` sends directly through a throwaway transport, exactly like the HTTP
 *  `/test` route does (`server/notifications-routes.ts`), for the same reason. */
function buildTestNotification(now: number): Notification {
  const iso = new Date(now).toISOString();
  return {
    event: "test",
    severity: "info",
    projectId: "test",
    runIds: [],
    title: "Test notification",
    body: `Sent from cez notify test at ${iso}.`,
    dedupeKey: `test:${randomUUID()}`,
    createdAt: iso,
  };
}

/** `--events a,b,c` is read as the COMPLETE allow-list, not an addition to the defaults: every
 *  known event (bar `test`, which is never matrix-gated) gets an explicit `true`/`false`, so
 *  `cez notify add ntfy --events run.failed,run.needs-you` reliably means "only these two," not
 *  "these two plus whatever the built-in defaults already were." */
function parseEventsFlag(csv: string): Record<string, boolean> {
  const wanted = new Set(
    csv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const matrix: Record<string, boolean> = {};
  for (const event of NOTIFICATION_EVENTS) {
    if (event === "test") continue;
    matrix[event] = wanted.has(event);
  }
  return matrix;
}

/** `DEFAULT_EVENT_MATRIX` is typed `Partial<Record<NotificationEvent, boolean>>` (config.ts); this
 *  normalizes it into the plain `Record<string, boolean>` shape `NotificationTransportRow.events`
 *  actually stores, the same way a `--events` flag does, rather than spreading the `Partial<...>`
 *  in directly (its optional-property type is not assignable to an index-signature record). */
function defaultEventsRecord(): Record<string, boolean> {
  const matrix: Record<string, boolean> = {};
  for (const event of NOTIFICATION_EVENTS) {
    if (event === "test") continue;
    matrix[event] = DEFAULT_EVENT_MATRIX[event] ?? false;
  }
  return matrix;
}

/** `HH:MM-HH:MM`, no timezone flag (the HTTP API's `PUT` covers that); `undefined` on a value that
 *  does not match the shape, which the caller turns into a usage error rather than a silent no-op. */
function parseQuietFlag(spec: string): NotificationQuietHours | undefined {
  const match = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(spec.trim());
  if (!match) return undefined;
  return { start: match[1]!, end: match[2]! };
}

/** `N/h` only - the CLI shorthand encodes the hourly figure; `burst`/`perMinute` take the same
 *  literal defaults `config.ts`'s own `DEFAULT_RATE` does (4 and 2). The full three-field shape is
 *  reachable through the HTTP `PUT` for a caller that needs a different burst/perMinute pair. */
function parseRateFlag(spec: string): NotificationRateLimit | undefined {
  const match = /^(\d+)\/h$/.exec(spec.trim());
  if (!match) return undefined;
  return { perHour: Number(match[1]), burst: 4, perMinute: 2 };
}

interface AddSetFlags {
  url?: string;
  "auth-env"?: string;
  "auth-inline"?: string;
  events?: string;
  label?: string;
  template?: string;
  payload?: string;
  method?: string;
  "timeout-ms"?: string;
}

function buildAuthFromFlags(
  io: NotifyCommandIo,
  values: AddSetFlags,
): { ok: true; auth: WebhookAuth | undefined } | { ok: false } {
  if (values["auth-env"] && values["auth-inline"]) {
    io.error("use --auth-env or --auth-inline, not both");
    return { ok: false };
  }
  if (values["auth-env"])
    return {
      ok: true,
      auth: {
        scheme: "bearer",
        header: "authorization",
        envVar: values["auth-env"],
      },
    };
  if (values["auth-inline"])
    return {
      ok: true,
      auth: {
        scheme: "bearer",
        header: "authorization",
        inline: values["auth-inline"],
      },
    };
  return { ok: true, auth: undefined };
}

async function addCommand(
  id: string | undefined,
  values: AddSetFlags,
  io: NotifyCommandIo,
): Promise<number> {
  if (!id) {
    io.error("missing transport id\n");
    io.error(USAGE);
    return 1;
  }
  if (!NOTIFICATION_TRANSPORT_ID_RE.test(id)) {
    io.error(
      `invalid transport id: ${id} (expected ^[a-z0-9][a-z0-9-]{0,31}$)`,
    );
    return 1;
  }
  if (!values.url) {
    io.error("missing --url");
    return 1;
  }
  try {
    assertWebhookUrlHasNoUserinfo(values.url);
  } catch (err) {
    io.error(describeErr(err));
    return 1;
  }
  if (
    values.payload !== undefined &&
    values.payload !== "envelope" &&
    values.payload !== "template"
  ) {
    io.error(
      `invalid --payload: ${values.payload} (expected envelope or template)`,
    );
    return 1;
  }
  const authResult = buildAuthFromFlags(io, values);
  if (!authResult.ok) return 1;

  const payload: "envelope" | "template" = values.template
    ? "template"
    : values.payload === "template"
      ? "template"
      : "envelope";
  if (payload === "template") {
    if (!values.template) {
      io.error("--payload template requires --template");
      return 1;
    }
    try {
      validateWebhookTemplate(values.template);
    } catch (err) {
      io.error(describeErr(err));
      return 1;
    }
  }

  const row: NotificationTransportRow = {
    id,
    kind: "webhook",
    label: values.label ?? id,
    enabled: true,
    events: values.events
      ? parseEventsFlag(values.events)
      : defaultEventsRecord(),
    projects: null,
    quietHours: null,
    rate: null,
    capabilities: { ...DEFAULT_CAPABILITIES },
    webhook: {
      url: values.url,
      method: values.method ?? DEFAULT_WEBHOOK_METHOD,
      headers: { ...DEFAULT_WEBHOOK_HEADERS },
      ...(authResult.auth ? { auth: authResult.auth } : {}),
      payload,
      ...(values.template ? { template: values.template } : {}),
      timeoutMs: values["timeout-ms"]
        ? Number(values["timeout-ms"])
        : DEFAULT_WEBHOOK_TIMEOUT_MS,
      successStatuses: [...DEFAULT_WEBHOOK_SUCCESS_STATUSES],
    },
  };

  let duplicate = false;
  await mergeWriteNotificationsConfig((cfg) => {
    if (cfg.transports.some((t) => t.id === id)) {
      duplicate = true;
      return;
    }
    cfg.transports = [...cfg.transports, row];
  });
  if (duplicate) {
    io.error(`transport already exists: ${id}`);
    return 1;
  }
  io.log(`  + ${id}  ${values.url}`);
  return 0;
}

async function setCommand(
  id: string | undefined,
  values: AddSetFlags & { quiet?: string; rate?: string },
  io: NotifyCommandIo,
): Promise<number> {
  if (!id) {
    io.error("missing transport id\n");
    io.error(USAGE);
    return 1;
  }
  const config = await loadNotificationsConfig();
  const current = config.transports.find((t) => t.id === id);
  if (!current) {
    io.error(`unknown transport: ${id}`);
    return 1;
  }
  if (values.url) {
    try {
      assertWebhookUrlHasNoUserinfo(values.url);
    } catch (err) {
      io.error(describeErr(err));
      return 1;
    }
  }
  if (
    values.payload !== undefined &&
    values.payload !== "envelope" &&
    values.payload !== "template"
  ) {
    io.error(
      `invalid --payload: ${values.payload} (expected envelope or template)`,
    );
    return 1;
  }
  const authResult = buildAuthFromFlags(io, values);
  if (!authResult.ok) return 1;

  let quietHours = current.quietHours;
  if (values.quiet !== undefined) {
    const parsed = parseQuietFlag(values.quiet);
    if (!parsed) {
      io.error(`invalid --quiet value: ${values.quiet} (expected HH:MM-HH:MM)`);
      return 1;
    }
    quietHours = parsed;
  }
  let rate = current.rate;
  if (values.rate !== undefined) {
    const parsed = parseRateFlag(values.rate);
    if (!parsed) {
      io.error(`invalid --rate value: ${values.rate} (expected N/h)`);
      return 1;
    }
    rate = parsed;
  }

  const template = values.template ?? current.webhook.template;
  const payload: "envelope" | "template" = values.template
    ? "template"
    : values.payload === "template" || values.payload === "envelope"
      ? values.payload
      : current.webhook.payload;
  if (payload === "template") {
    if (!template) {
      io.error('payload "template" requires a --template');
      return 1;
    }
    try {
      validateWebhookTemplate(template);
    } catch (err) {
      io.error(describeErr(err));
      return 1;
    }
  }

  const updated: NotificationTransportRow = {
    ...current,
    ...(values.label !== undefined ? { label: values.label } : {}),
    ...(values.events !== undefined
      ? { events: parseEventsFlag(values.events) }
      : {}),
    quietHours,
    rate,
    webhook: {
      ...current.webhook,
      ...(values.url !== undefined ? { url: values.url } : {}),
      ...(values.method !== undefined ? { method: values.method } : {}),
      ...(authResult.auth !== undefined ? { auth: authResult.auth } : {}),
      payload,
      ...(template !== undefined ? { template } : {}),
      ...(values["timeout-ms"] !== undefined
        ? { timeoutMs: Number(values["timeout-ms"]) }
        : {}),
    },
  };

  let found = false;
  await mergeWriteNotificationsConfig((cfg) => {
    cfg.transports = cfg.transports.map((t) => {
      if (t.id !== id) return t;
      found = true;
      return updated;
    });
  });
  if (!found) {
    io.error(`unknown transport: ${id}`);
    return 1;
  }
  io.log(`  ~ ${id}  updated`);
  return 0;
}

async function setEnabledCommand(
  id: string | undefined,
  enabled: boolean,
  io: NotifyCommandIo,
): Promise<number> {
  if (!id) {
    io.error("missing transport id");
    return 1;
  }
  let found = false;
  await mergeWriteNotificationsConfig((cfg) => {
    cfg.transports = cfg.transports.map((t) => {
      if (t.id !== id) return t;
      found = true;
      return { ...t, enabled };
    });
  });
  if (!found) {
    io.error(`unknown transport: ${id}`);
    return 1;
  }
  io.log(`  ${enabled ? "+" : "-"} ${id}  ${enabled ? "enabled" : "disabled"}`);
  return 0;
}

async function rmCommand(
  id: string | undefined,
  io: NotifyCommandIo,
): Promise<number> {
  if (!id) {
    io.error("missing transport id");
    return 1;
  }
  let existed = false;
  await mergeWriteNotificationsConfig((cfg) => {
    existed = cfg.transports.some((t) => t.id === id);
    cfg.transports = cfg.transports.filter((t) => t.id !== id);
  });
  io.log(
    existed ? `  - ${id}  removed` : `  - ${id}  (not found, nothing removed)`,
  );
  return 0;
}

function authLabel(auth: ReturnType<typeof describeAuth>): string {
  if (auth.source === "none") return "no auth";
  if (auth.source === "env")
    return `env:${auth.envVar}${auth.present ? "" : " (unset)"}`;
  return `inline${auth.present ? "" : " (unset)"}`;
}

async function listCommand(
  io: NotifyCommandIo,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const config = await loadNotificationsConfig();
  if (config.transports.length === 0) {
    io.log("\n  no notification transports configured");
    io.log("  add one: cez notify add <id> --url <endpoint>\n");
    return 0;
  }
  io.log("");
  const idWidth = Math.max(...config.transports.map((t) => t.id.length));
  for (const row of config.transports) {
    const mark = row.enabled ? "✓" : "✗";
    io.log(
      `  ${mark} ${row.id.padEnd(idWidth)}  ${row.webhook.url}  [${authLabel(describeAuth(row.webhook.auth, env))}]`,
    );
  }
  io.log(
    `\n  ${config.transports.length} transport(s) - ${notificationsConfigPath()}`,
  );
  if (env.CEZ_NOTIFY !== "1")
    io.log(
      "  CEZ_NOTIFY is not set to 1 - these transports are configured but inactive\n",
    );
  else io.log("");
  return 0;
}

async function testCommand(
  id: string | undefined,
  io: NotifyCommandIo,
  opts: { env: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; now: () => number },
): Promise<number> {
  if (!id) {
    io.error("missing transport id");
    return 1;
  }
  const config = await loadNotificationsConfig();
  const row = config.transports.find((t) => t.id === id);
  if (!row) {
    io.error(`unknown transport: ${id}`);
    return 1;
  }
  try {
    const transport = createWebhookTransport(
      { id: row.id, capabilities: row.capabilities, webhook: row.webhook },
      {
        env: opts.env,
        ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
        now: opts.now,
      },
    );
    const result = await transport.send(
      buildTestNotification(opts.now()),
      new AbortController().signal,
    );
    if (result.ok) {
      io.log(
        `  ${id}: delivered (HTTP ${result.httpStatus ?? "-"}, ${Math.round(result.durationMs)}ms)`,
      );
      return 0;
    }
    io.error(
      `  ${id}: failed - ${result.error}${result.httpStatus !== undefined ? ` (HTTP ${result.httpStatus})` : ""}`,
    );
    return 1;
  } catch (err) {
    io.error(`  ${id}: ${describeErr(err)}`);
    return 1;
  }
}

async function logCommand(
  values: { limit?: string; transport?: string },
  io: NotifyCommandIo,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const outbox = NotificationOutbox.open(notificationsDataDir(env));
  const rows = outbox.list({
    ...(values.transport !== undefined
      ? { transportId: values.transport }
      : {}),
    ...(values.limit !== undefined ? { limit: Number(values.limit) } : {}),
  });
  if (rows.length === 0) {
    io.log("\n  no notification log rows\n");
    return 0;
  }
  io.log("");
  for (const row of rows) {
    io.log(
      `  ${row.status.padEnd(9)} ${row.transportId.padEnd(16)} ${row.event.padEnd(20)} ${row.title}`,
    );
  }
  io.log(`\n  ${rows.length} row(s)\n`);
  return 0;
}

const ADD_OPTIONS = {
  url: { type: "string" },
  "auth-env": { type: "string" },
  "auth-inline": { type: "string" },
  events: { type: "string" },
  label: { type: "string" },
  template: { type: "string" },
  payload: { type: "string" },
  method: { type: "string" },
  "timeout-ms": { type: "string" },
} as const;

const SET_OPTIONS = {
  ...ADD_OPTIONS,
  quiet: { type: "string" },
  rate: { type: "string" },
} as const;

const LOG_OPTIONS = {
  limit: { type: "string" },
  transport: { type: "string" },
} as const;

/**
 * Run one `notify` subcommand. Returns the process exit code (0 ok, 1 on any usage error, unknown
 * id, or an undelivered test send) so `src/index.ts` can assign it to `process.exitCode`, matching
 * `runProjectsCommand`'s contract.
 */
export async function runNotifyCommand(
  args: string[],
  opts: NotifyCommandOptions = {},
): Promise<number> {
  const io = opts.io ?? defaultIo;
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const [sub = "list", ...rest] = args;
  switch (sub) {
    case "list":
      return listCommand(io, env);
    case "add": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: ADD_OPTIONS,
        allowPositionals: true,
      });
      return addCommand(positionals[0], values, io);
    }
    case "set": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: SET_OPTIONS,
        allowPositionals: true,
      });
      return setCommand(positionals[0], values, io);
    }
    case "enable":
      return setEnabledCommand(rest[0], true, io);
    case "disable":
      return setEnabledCommand(rest[0], false, io);
    case "rm":
    case "remove":
      return rmCommand(rest[0], io);
    case "test":
      return testCommand(rest[0], io, {
        env,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        now,
      });
    case "log": {
      const { values } = parseArgs({
        args: rest,
        options: LOG_OPTIONS,
        allowPositionals: true,
      });
      return logCommand(values, io, env);
    }
    default:
      io.error(`unknown notify subcommand: ${sub}\n`);
      io.error(USAGE);
      return 1;
  }
}
