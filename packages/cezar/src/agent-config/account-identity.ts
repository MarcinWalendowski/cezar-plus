import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderId } from '../core/provider-auth.ts';
import { claudeStateFilePath, expandTilde } from '../paths.ts';

/**
 * Who an agent account is logged in AS — the "Show details" read (spec
 * `2026-07-29-agent-profiles.md`).
 *
 * This is the second place vendor knowledge lives about an agent's home, beside
 * `catalog.ts` (which config FILES exist) and `core/agent-profiles.ts` (which env var relocates
 * the home). This one knows where each agent writes its own identity. Facts verified against the
 * files on disk 2026-07-29; re-verify before changing them.
 *
 * ## Two rules that are not negotiable
 *
 * 1. **Named fields only, never pass-through.** `~/.codex/auth.json` holds `OPENAI_API_KEY`,
 *    `access_token` and `refresh_token` right beside the identity claims. Every reader below picks
 *    fields by name and builds a fresh object; nothing here spreads, forwards or stringifies a
 *    parsed vendor object, so a key the vendor adds tomorrow cannot leak through. The JWT is read
 *    for its CLAIMS and its signature is never a credential we hold onto.
 * 2. **Read on demand, never on the accounts listing.** This never joins the accounts listing,
 *    never enters `runs.json` or the NDJSON, and is never logged. `provider-auth.ts` keeps account
 *    identity out of its own boundary on purpose; this is the deliberate, opt-in exception —
 *    localHandoff-gated, and only when the user asks for it — not a widening of that rule.
 *
 *    **AMENDED 2026-08-14 (spec `.ai/specs/2026-08-14-claude-subscription-autodetect.md`): two
 *    routes, not one.** The rule said "answered to exactly one route", and account discovery
 *    (`GET /workspace/agent-profiles/discovered`) is now a second one. The narrow reason it has to
 *    be: a discovered dir is NOT an account yet, so there is no account id a details route could be
 *    addressed with, and a list of bare paths does not answer the question discovery exists to
 *    answer ("which subscription is this one?"). It is on-demand and localHandoff-gated exactly
 *    like the details route, and it reads Claude ONLY — `readClaudeOauthAccount` below is the one
 *    reader both routes go through, so there is no second copy of where the file lives.
 *
 *    What did NOT change, and must not: **the accounts listing still carries no identity.** An
 *    email on the listing would sit in the response, the query cache and devtools for every load
 *    of the settings pane, which is what "hidden by default" exists to prevent. An added account
 *    is named by its LABEL — which discovery prefills with the detected email, so the subscription
 *    survives the add without the listing ever carrying the identity itself.
 */

/** One labelled row, as the pane renders it. Deliberately not a fixed per-provider shape: what an
 *  agent knows about its own login differs, and inventing an empty "Organization" for one that has
 *  no concept of it would be a worse answer than omitting the row. */
export interface AccountIdentityField {
  label: string;
  value: string;
}

export interface AccountIdentity {
  /** False when there is nothing to show — not signed in, no file, or a file we cannot parse. */
  available: boolean;
  /** Why, in the user's terms, when `available` is false. */
  reason?: string;
  fields: AccountIdentityField[];
}

/** `.claude.json` can carry per-project history; cap the read like `readUserMcpServers` does. */
const READ_CAP = 2 * 1024 * 1024;

const NOT_SIGNED_IN = 'Not signed in on this account yet — use Connect.';
const UNREADABLE = 'Could not read this account’s details.';

/** Read a JSON file under the cap. `null` for absent, unreadable, oversized or malformed. */
async function readJsonCapped(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, 'utf8');
    if (raw.length > READ_CAP) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A non-empty display string, or undefined — so a blank vendor value never renders as an empty row. */
function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Push a row only when the value is really there. */
function push(fields: AccountIdentityField[], label: string, value: unknown): void {
  const shown = text(value);
  if (shown !== undefined) fields.push({ label, value: shown });
}

/**
 * The `oauthAccount` record a Claude config dir records its login in, or `null` when it records
 * none. Never throws: an absent, unreadable, oversized or malformed file is simply an unknown
 * identity.
 *
 * Claude Code keeps that record in `.claude.json` — a *sibling* of `~/.claude` by default, but
 * INSIDE an overridden config dir (`claudeStateFilePath` owns that rule, and getting it wrong is
 * how one account reports another's email).
 *
 * Exported because account discovery (`workspace/agent-account-identity.ts`) needs the same record
 * in a different shape, and a second `readFile(claudeStateFilePath(...))` elsewhere is precisely how
 * two readers of one upstream drift apart — the vendor's file layout has one home in this repo and
 * this is it. Callers pick fields BY NAME off the returned record (rule 1); nothing here spreads or
 * forwards it onward.
 *
 * `env` is threaded rather than left to `process.env` because `claudeStateFilePath` decides
 * sibling-vs-inside FROM it: a caller that resolves config dirs against one env and reads them
 * against another gets the sibling rule for the wrong dir, which is the "wrong account's email"
 * failure by a slower route.
 */
export async function readClaudeOauthAccount(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown> | null> {
  const state = await readJsonCapped(claudeStateFilePath(expandTilde(configDir), env));
  if (state === null) return null;
  const account = state.oauthAccount;
  return account && typeof account === 'object' ? (account as Record<string, unknown>) : null;
}

async function readClaudeIdentity(configDir: string): Promise<AccountIdentity> {
  const a = await readClaudeOauthAccount(configDir);
  if (a === null) return { available: false, reason: NOT_SIGNED_IN, fields: [] };
  const fields: AccountIdentityField[] = [];
  push(fields, 'Email', a.emailAddress);
  push(fields, 'Name', a.displayName);
  push(fields, 'Organization', a.organizationName);
  push(fields, 'Role', a.organizationRole);
  // `seatTier`/`billingType` are the closest thing to a plan the file states; neither is
  // documented, so they are shown under a label that promises no more than they are.
  push(fields, 'Seat', a.seatTier);
  push(fields, 'Billing', a.billingType);
  return fields.length > 0
    ? { available: true, fields }
    : { available: false, reason: UNREADABLE, fields: [] };
}

/**
 * Codex keeps its login in `auth.json`'s `id_token` — a JWT whose payload carries the identity
 * claims. Read for its claims only: the same file holds `OPENAI_API_KEY`, `access_token` and
 * `refresh_token`, none of which this function so much as names.
 *
 * The signature is NOT verified, and that is correct here: this is a local file the user's own CLI
 * wrote, read to display who they are — not a token cezar is accepting as proof of anything.
 */
/** What `auth.json` says, split into the three facts a caller may act on and nothing else.
 *  `present` distinguishes "no such file" from "signed in by a means with no claims", which read
 *  identically if you only look at `claims`. */
export interface CodexAuthRead {
  /** An `auth.json` exists and parsed. */
  present: boolean;
  /** The `id_token`'s payload claims, or `null` for an API-key login or an unreadable token. */
  claims: Record<string, unknown> | null;
  /** A non-empty `OPENAI_API_KEY` is present. The VALUE never leaves this module. */
  apiKeyLogin: boolean;
}

/**
 * Codex's own record of which account a config dir belongs to — `<dir>/auth.json`'s `id_token`
 * claims. The codex counterpart of `readClaudeOauthAccount` above, and exported for the same
 * reason: discovery (`workspace/agent-account-identity.ts`) needs the same record in a different
 * shape, and a second reader of this file elsewhere is how two readers of one upstream drift apart.
 *
 * **The three credentials in that file are never returned.** `OPENAI_API_KEY` is reduced to a
 * boolean here; `access_token` and `refresh_token` are not read at all. Callers pick claim fields
 * BY NAME (rule 1 at the top of this file), and the claims record itself carries no credential —
 * it is an identity assertion the CLI already wrote to disk in plaintext.
 */
export async function readCodexAuthClaims(configDir: string): Promise<CodexAuthRead> {
  const auth = await readJsonCapped(join(expandTilde(configDir), 'auth.json'));
  if (auth === null) return { present: false, claims: null, apiKeyLogin: false };
  const tokens = auth.tokens;
  const idToken = tokens && typeof tokens === 'object'
    ? (tokens as Record<string, unknown>).id_token
    : undefined;
  return {
    present: true,
    claims: typeof idToken === 'string' ? decodeJwtClaims(idToken) : null,
    apiKeyLogin: typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY !== '',
  };
}

async function readCodexIdentity(configDir: string): Promise<AccountIdentity> {
  const auth = await readCodexAuthClaims(configDir);
  if (!auth.present) return { available: false, reason: NOT_SIGNED_IN, fields: [] };
  const fields: AccountIdentityField[] = [];
  const claims = auth.claims;
  if (claims !== null) {
    push(fields, 'Email', claims.email);
    push(fields, 'Name', claims.name);
    const openai = claims['https://api.openai.com/auth'];
    if (openai && typeof openai === 'object') {
      push(fields, 'Plan', (openai as Record<string, unknown>).chatgpt_plan_type);
    }
  }
  // An API-key login has no id_token at all — say which kind of login this is rather than
  // reporting "not signed in" for an account that is perfectly usable.
  if (fields.length === 0 && auth.apiKeyLogin) {
    return { available: true, fields: [{ label: 'Login', value: 'API key' }] };
  }
  return fields.length > 0
    ? { available: true, fields }
    : { available: false, reason: NOT_SIGNED_IN, fields: [] };
}

/** A JWT's payload claims, or null when it is not a readable three-part token. */
function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * What this account is logged in as, or an honest reason there is nothing to show.
 *
 * Never throws. OpenCode answers "unsupported": its credentials live in a SQLite DB outside the
 * config dir (see `core/agent-profiles.ts`), so there is nothing in a config folder to read — and
 * guessing from the default login would attribute one account's identity to another.
 */
export async function readAccountIdentity(
  provider: ProviderId,
  configDir: string,
): Promise<AccountIdentity> {
  if (provider === 'claude') return readClaudeIdentity(configDir);
  if (provider === 'codex') return readCodexIdentity(configDir);
  return {
    available: false,
    reason: 'OpenCode keeps its login outside its config folder, so cezar-plus cannot read it.',
    fields: [],
  };
}
