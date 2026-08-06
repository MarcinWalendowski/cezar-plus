import type { WebhookConfig } from '../config.ts';
import { resolveAuth } from '../secrets.ts';
import type { DeliveryResult, HealthResult, Notification, NotificationTransport, TransportCapabilities } from '../types.ts';

/**
 * The ONE generic `webhook` transport (W2.4, spec "Data Models > 1" and "The upstream / fork
 * split"). ntfy, Slack, Discord, Gotify, Matrix, Apprise and a private notification ingress are
 * all this one transport with different config — the body TEMPLATE is the single decision that
 * decides fork versus config, and it is what keeps this file 100% upstreamable.
 *
 * `fetch` is an injected dependency (`WebhookTransportOptions.fetch`) so nothing here ever makes
 * a real network call in a test. Every failure path — timeout, DNS failure, a non-2xx status, a
 * malformed response body — returns a {@link DeliveryResult}; `send()` itself never throws, and
 * never rejects.
 */

// ---- the closed placeholder set (Data Models "The template contract") -----------------------

export const WEBHOOK_TEMPLATE_PLACEHOLDERS = [
  'title',
  'body',
  'text',
  'url',
  'event',
  'severity',
  'project',
  'count',
  'runId',
  'dedupeKey',
] as const;
export type WebhookTemplatePlaceholder = (typeof WEBHOOK_TEMPLATE_PLACEHOLDERS)[number];

/** Named so a caller (a route handler, the config store) can tell "this template is broken" apart
 *  from any other failure. Thrown at CONSTRUCTION time (spec: "validated once when it is written,
 *  not discovered broken when something urgent needs sending") — never at send time. */
export class WebhookTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookTemplateError';
  }
}

const PLACEHOLDER_PATTERN = /\{\{([^{}]*)\}\}/g;

/**
 * Two checks, both load-time, both required before a template is trusted:
 *
 *  1. Every `{{...}}` in the template names a member of {@link WEBHOOK_TEMPLATE_PLACEHOLDERS} (or
 *     whatever `knownPlaceholders` the caller passes — a test seam, see the negative control in
 *     `webhook.test.ts`: dropping `dedupeKey` from the set must make a template that uses it fail
 *     to load). A typo becomes a load-time error, never an empty string sent at 02:14.
 *  2. Substituting every known placeholder with a probe value and running the result through
 *     `JSON.parse` must succeed. This is sound for ANY real substitution, not just the probe: every
 *     substitution is JSON-string-escaped at the exact template position the placeholder occupies
 *     (see `substitutePlaceholders`), so whether the escaped result parses depends only on the
 *     template's own structure (are the placeholders sitting inside a JSON string's quotes?), never
 *     on which string happens to be escaped into it.
 */
export function validateWebhookTemplate(
  template: string,
  knownPlaceholders: readonly string[] = WEBHOOK_TEMPLATE_PLACEHOLDERS,
): void {
  const known = new Set(knownPlaceholders);
  const pattern = new RegExp(PLACEHOLDER_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(template))) {
    const name = (match[1] ?? '').trim();
    if (!known.has(name)) {
      throw new WebhookTemplateError(`webhook template references an unknown placeholder "{{${match[1] ?? ''}}}"`);
    }
  }

  const probeValues: Record<string, string> = {};
  for (const name of knownPlaceholders) probeValues[name] = 'probe';
  const rendered = substitutePlaceholders(template, probeValues);
  try {
    JSON.parse(rendered);
  } catch (err) {
    throw new WebhookTemplateError(
      `webhook template does not produce valid JSON after substitution: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** `JSON.stringify` a value and strip its own surrounding quotes, leaving exactly the escaped
 *  content a template's own literal `"..."` quoting expects to receive. Handles `"`, `\`, control
 *  characters (including `\n`) the same way any other JSON string value would. */
function jsonEscape(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function substitutePlaceholders(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER_PATTERN, (_whole, rawName: string) => {
    const name = rawName.trim();
    return jsonEscape(values[name] ?? '');
  });
}

function truncate(value: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

/** Every placeholder's rendered value, JSON-escaped at substitution — never typed, always a
 *  string, per the spec ("Every substitution is JSON-string-escaped at the point of
 *  substitution"). `{{text}}` is `title + "\n" + body + "\n" + url`, pre-truncated to
 *  `capabilities.maxBodyChars` (spec, verbatim). `{{count}}`/`{{runId}}` read the coalesced
 *  batch's run count and its first run id — a coalesced notification carries every merged run in
 *  `runIds`, and the spec does not name a second placeholder to enumerate the rest. */
function buildRenderValues(
  notification: Notification,
  capabilities: TransportCapabilities,
): Record<WebhookTemplatePlaceholder, string> {
  const url = notification.url ?? '';
  return {
    title: truncate(notification.title, capabilities.maxTitleChars),
    body: truncate(notification.body, capabilities.maxBodyChars),
    text: truncate([notification.title, notification.body, url].join('\n'), capabilities.maxBodyChars),
    url,
    event: notification.event,
    severity: notification.severity,
    project: notification.projectName ?? notification.projectId,
    count: String(notification.runIds.length),
    runId: notification.runIds[0] ?? '',
    dedupeKey: notification.dedupeKey,
  };
}

/** `payload: 'envelope'` — the generic `{title, body, url}` shape (spec "The upstream / fork
 *  split"). `capabilities.links` decides where the deep link goes: its own field, appended to the
 *  body, or dropped entirely — the same distinction the type declares it exists for. */
function buildEnvelopeBody(notification: Notification, capabilities: TransportCapabilities): Record<string, unknown> {
  const title = truncate(notification.title, capabilities.maxTitleChars);
  const body = truncate(notification.body, capabilities.maxBodyChars);
  if (!notification.url || capabilities.links === 'none') return { title, body };
  if (capabilities.links === 'field') return { title, body, url: notification.url };
  return { title, body: truncate(`${body}\n${notification.url}`, capabilities.maxBodyChars) };
}

function buildRequestBody(notification: Notification, webhook: WebhookConfig, capabilities: TransportCapabilities): string {
  if (webhook.payload === 'template') {
    // `createWebhookTransport` already required `webhook.template` to be set and validated
    // whenever `payload === 'template'` — this is defensive, not a path a caller can reach.
    if (!webhook.template) throw new WebhookTemplateError('webhook payload mode is "template" but no template is configured');
    return substitutePlaceholders(webhook.template, buildRenderValues(notification, capabilities));
  }
  return JSON.stringify(buildEnvelopeBody(notification, capabilities));
}

function buildHeaders(webhook: WebhookConfig, env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...webhook.headers };
  const auth = resolveAuth(webhook.auth, env);
  if (auth) headers[auth.header] = `Bearer ${auth.value}`;
  return headers;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 4xx other than 408/429 is a config or payload problem retrying will not fix; 5xx, 408, 429 and
 *  a network-level failure are all transient (spec W2.4 acceptance, verbatim). */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/** Numeric seconds (the common form) or an HTTP-date; anything else is "no hint given". */
function parseRetryAfterMs(res: Response): number | undefined {
  const header = res.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

async function describeFailureBody(res: Response): Promise<string> {
  try {
    const text = (await res.text()).trim();
    return text ? `webhook responded ${res.status}: ${text.slice(0, 500)}` : `webhook responded ${res.status}`;
  } catch {
    return `webhook responded ${res.status}`;
  }
}

/** Whichever of the two signals aborts first wins — the caller's own signal (the registry's
 *  generic wrapping timeout, or a route's cancellation) and this transport's own configured
 *  `webhook.timeoutMs` (spec Architecture "the observer" property 3: "Every outbound `fetch`
 *  carries `AbortSignal.timeout(...)`, so a hanging endpoint cannot pin a socket forever" — this
 *  transport owns that guarantee itself rather than trusting every caller to supply one). Written
 *  by hand instead of `AbortSignal.any` so this module makes no assumption about which Node 20.x
 *  patch a caller runs. */
function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const controller = new AbortController();
  a.addEventListener('abort', () => controller.abort(a.reason), { once: true });
  b.addEventListener('abort', () => controller.abort(b.reason), { once: true });
  return controller.signal;
}

const HEALTHCHECK_METHOD = 'HEAD';

export interface WebhookTransportInit {
  readonly id: string;
  readonly capabilities: TransportCapabilities;
  readonly webhook: WebhookConfig;
}

export interface WebhookTransportOptions {
  /** Injected so no test ever performs a real network call. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Builds one `webhook`-kind {@link NotificationTransport} from a transport row's `webhook`
 * config. Throws {@link WebhookTemplateError} synchronously, at construction, when
 * `payload === 'template'` and the template is missing, references an unknown placeholder, or
 * does not produce valid JSON after substitution — "loads unconfigured" (spec) is the caller's
 * (the wiring layer's) job: it is what catches this exception and marks the row's persisted
 * `health.status` accordingly, not something this function tracks itself.
 */
export function createWebhookTransport(init: WebhookTransportInit, options: WebhookTransportOptions = {}): NotificationTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const { webhook, capabilities } = init;

  if (webhook.payload === 'template') {
    if (!webhook.template) throw new WebhookTemplateError('webhook payload mode is "template" but no template is configured');
    validateWebhookTemplate(webhook.template);
  }

  return {
    id: init.id,
    kind: 'webhook',
    capabilities,

    async send(notification: Notification, signal: AbortSignal): Promise<DeliveryResult> {
      const startedAt = now();

      let body: string;
      try {
        body = buildRequestBody(notification, webhook, capabilities);
      } catch (err) {
        return { ok: false, retryable: false, error: describeError(err), durationMs: now() - startedAt };
      }

      let res: Response;
      try {
        res = await fetchImpl(webhook.url, {
          method: webhook.method,
          headers: buildHeaders(webhook, env),
          body,
          signal: combineSignals(signal, AbortSignal.timeout(webhook.timeoutMs)),
        });
      } catch (err) {
        return { ok: false, retryable: true, error: describeError(err), durationMs: now() - startedAt };
      }

      const durationMs = now() - startedAt;
      if (webhook.successStatuses.includes(res.status)) {
        return { ok: true, httpStatus: res.status, durationMs };
      }

      const retryAfterMs = parseRetryAfterMs(res);
      return {
        ok: false,
        retryable: isRetryableStatus(res.status),
        error: await describeFailureBody(res),
        httpStatus: res.status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        durationMs,
      };
    },

    /** A lightweight reachability probe — `HEAD` at the configured URL with the same auth header
     *  `send()` would attach, carrying no notification body (there is none to render outside a
     *  real `send()` call). Any completed HTTP round trip counts as reachable regardless of
     *  status code; only a network-level failure (DNS, connection refused, the timeout below)
     *  reports `ok: false`. */
    async healthcheck(signal: AbortSignal): Promise<HealthResult> {
      const startedAt = now();
      try {
        await fetchImpl(webhook.url, {
          method: HEALTHCHECK_METHOD,
          headers: buildHeaders(webhook, env),
          signal: combineSignals(signal, AbortSignal.timeout(webhook.timeoutMs)),
        });
        return { ok: true, durationMs: now() - startedAt };
      } catch (err) {
        return { ok: false, error: describeError(err), durationMs: now() - startedAt };
      }
    },
  };
}
