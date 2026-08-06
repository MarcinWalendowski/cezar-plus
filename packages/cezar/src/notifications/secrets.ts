import { z } from 'zod';
import { collectSecretValues } from '../core/secret-redaction.ts';

/**
 * Credential handling for notification transports (F4, `CEZ_NOTIFY=1`).
 * `.ai/specs/2026-08-06-pluggable-notification-transports.md` Q9/Q10, "Config and secrets (W1.8)".
 *
 * There is no general secret store in this repo and it must not grow one (Q10 — the same stance
 * `server-install/platforms/macosx-ngrok.ts:83` takes for the ngrok authtoken: never written to
 * cezar's own state). A transport's credential is a REFERENCE to an env var, resolved from
 * `process.env` at send time and never persisted; the documented spelling is
 * `CEZ_NOTIFY_<ID>_TOKEN`, which `SECRET_NAME_RE` already recognises (matches `TOKEN`), so the
 * value is auto-scrubbed from every persisted run transcript for free. The API also accepts an
 * `inline` credential (the CLI's `--auth-inline` escape hatch) for a caller with no env var to
 * point at; `collectNotificationSecretValues` below is what keeps THAT case from being a silent
 * redaction gap (see its own doc comment).
 *
 * Two rules make redaction structural rather than best-effort, the distinction this module exists
 * to hold:
 *   1. `describeAuth` cannot return a resolved secret — the RETURN TYPE has no field capable of
 *      carrying one (presence + a source name + an optional last-4 hint). That is not scrubbing a
 *      string after the fact; the shape itself cannot hold the value, so there is nothing to leak.
 *   2. `collectNotificationSecretValues` does not rely on `SECRET_NAME_RE` matching an operator's
 *      chosen env-var name. It walks the schema position that IS a credential reference (structural)
 *      rather than pattern-matching the variable's name (best-effort) — see its own doc comment for
 *      the gap this closes.
 */

/** One transport's webhook credential reference. `envVar` is the documented default; `inline` is
 *  the escape hatch for a caller with nothing to point an env var at. Never a third shape: a
 *  transport either names where to look, or carries the value, never both.
 *
 *  Deliberately NOT `.passthrough()` on either branch, unlike most schemas in this file's
 *  neighbourhood — matching `notificationTransportAuthInputSchema` in `@open-mercato/cezar-contract`,
 *  the equivalent write-side shape, which makes the same choice for the same reason: a passthrough
 *  index signature on BOTH union members makes `'envVar' in auth` stop narrowing (every member
 *  structurally "has" every string key), which is exactly the discrimination `resolveAuth` and
 *  `describeAuth` depend on below. */
export const webhookAuthSchema = z.union([
  z.object({
    scheme: z.literal('bearer'),
    header: z.string().trim().min(1).catch('authorization'),
    envVar: z.string().trim().min(1),
  }),
  z.object({
    scheme: z.literal('bearer'),
    header: z.string().trim().min(1).catch('authorization'),
    inline: z.string().min(1),
  }),
]);
export type WebhookAuth = z.infer<typeof webhookAuthSchema>;

/** What a `send()` actually carries on the wire: the header name plus the resolved value.
 *  `undefined` means "no credential is currently resolvable" — an absent `auth`, an unset env
 *  var, or an empty inline value — and is the caller's (the webhook transport's) signal to treat
 *  the transport as unconfigured rather than sending an unauthenticated request by accident. */
export interface ResolvedAuth {
  header: string;
  value: string;
}

/** Read `auth.envVar` from `env` at send time, or return the stored `inline` value. Never persists
 *  either. Returns `undefined` when there is nothing to resolve (no `auth`, an unset env var, or
 *  an empty inline value) rather than throwing — a transport with a not-yet-set credential is a
 *  normal, common state (`describeAuth` is how a caller learns *why* before it ever tries to send). */
export function resolveAuth(auth: WebhookAuth | undefined, env: NodeJS.ProcessEnv = process.env): ResolvedAuth | undefined {
  if (!auth) return undefined;
  if ('envVar' in auth) {
    const value = env[auth.envVar];
    return value ? { header: auth.header, value } : undefined;
  }
  return auth.inline ? { header: auth.header, value: auth.inline } : undefined;
}

/** The read-side (GET) view of a credential — presence and provenance, never a value. Mirrors
 *  `transportAuthViewSchema` in `@open-mercato/cezar-contract`. `hint` is the last four characters
 *  of an inline secret, and only ever populated at length >= 12 (below that a "hint" is most of
 *  the secret). */
export type AuthView =
  | { source: 'env'; envVar: string; present: boolean }
  | { source: 'inline'; present: boolean; hint?: string }
  | { source: 'none' };

const INLINE_HINT_MIN_LENGTH = 12;
const INLINE_HINT_LENGTH = 4;

/** Structurally incapable of returning a resolved secret (see the module doc comment) — the
 *  control this module promises: `JSON.stringify(describeAuth(...))` never contains a credential
 *  value, only whether one is present and (for `inline`, and only past the length floor) its last
 *  four characters. */
export function describeAuth(auth: WebhookAuth | undefined, env: NodeJS.ProcessEnv = process.env): AuthView {
  if (!auth) return { source: 'none' };
  if ('envVar' in auth) {
    const value = env[auth.envVar];
    return { source: 'env', envVar: auth.envVar, present: typeof value === 'string' && value.length > 0 };
  }
  const value = auth.inline;
  const present = typeof value === 'string' && value.length > 0;
  const hint = present && value.length >= INLINE_HINT_MIN_LENGTH ? value.slice(-INLINE_HINT_LENGTH) : undefined;
  return hint ? { source: 'inline', present, hint } : { source: 'inline', present };
}

/** Thrown by `assertWebhookUrlHasNoUserinfo` — a named error so a caller (a route handler, the
 *  config schema below) can distinguish "this URL carries a credential" from any other URL
 *  validation failure. Its message never repeats the credential: it echoes only the scheme, host
 *  and path, because a "here is what was wrong" error is exactly the kind of text that ends up in
 *  a log line. */
export class WebhookUrlCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookUrlCredentialError';
  }
}

/** Reject a webhook URL carrying userinfo (`https://user:pass@host/...`) — a credential in a URL is
 * a credential in every log line, error message and outbox row that URL ever appears in, and the
 * one place `redactDeep` cannot help: it scrubs known secret VALUES, but a URL-embedded password is
 * never collected as one unless this check runs first. Docs steer the credential into a header
 * instead. A URL that does not even parse is a DIFFERENT failure (general well-formedness, not a
 * credential-in-URL problem) and is silently let through here — that check belongs to whoever
 * validates the URL is usable at all, not to this function. */
export function assertWebhookUrlHasNoUserinfo(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  if (!parsed.username && !parsed.password) return;
  throw new WebhookUrlCredentialError(
    `webhook url must not carry userinfo — put the credential in a header instead (offending url: ` +
      `${parsed.protocol}//${parsed.host}${parsed.pathname})`,
  );
}

/**
 * Every secret value a notifications config can resolve, for a redactor (the durable outbox,
 * W2.5) to scrub before anything touches disk or a console line.
 *
 * `collectSecretValues()` alone is not enough here, and this is the "structural rather than
 * best-effort" instruction made concrete: it only catches an env var whose NAME matches
 * `SECRET_NAME_RE` (`TOKEN`, `SECRET`, `_KEY`, …). `auth.envVar` is an operator-chosen name — the
 * documented spelling (`CEZ_NOTIFY_<ID>_TOKEN`) matches, but nothing stops someone pointing a
 * transport at `CEZ_NOTIFY_ACME_CRED` or any other name that does not. This module KNOWS, from the
 * schema position alone, that whatever `auth.envVar` names is a credential — regardless of what it
 * is called — so it resolves and adds that value explicitly rather than hoping the name matches a
 * pattern. An `inline` secret is added directly for the same reason: it never lived in `process.env`
 * at all, so name-based collection could never have found it.
 */
export function collectNotificationSecretValues(
  transports: readonly { webhook: { auth?: WebhookAuth } }[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const values = new Set(collectSecretValues(env));
  for (const transport of transports) {
    const resolved = resolveAuth(transport.webhook.auth, env);
    if (resolved) values.add(resolved.value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}
