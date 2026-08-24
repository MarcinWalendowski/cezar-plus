import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentHomePaths } from '../paths.ts';
import { readClaudeOauthAccount, readCodexAuthClaims } from '../agent-config/account-identity.ts';
import { looksLikeProfileDir } from '../core/agent-profiles.ts';
import type { ProviderId } from '../core/provider-auth.ts';

/**
 * Which Claude subscription a config dir is signed in to — and which ones exist on this machine.
 *
 * Two accounts differ by one environment variable (`CLAUDE_CONFIG_DIR`, see
 * `core/agent-profiles.ts`), and until now cezar knew them only by whatever LABEL the person typed
 * when adding one. That label is a guess about a fact the CLI already recorded: a dir's
 * `.claude.json` carries the `oauthAccount` it is logged in as. Reading it turns "account-2" into
 * "owner@example.com · Max 20x", and makes the machine's other logins discoverable
 * instead of something you have to remember the path of.
 *
 * ## Both profile-capable providers
 *
 * **CORRECTED 2026-08-24 by `.ai/specs/2026-08-24-second-codex-account-balancing.md` (D3). This
 * section read "Claude only, deliberately" and is quoted below unchanged**, because the risk it
 * names is real and the code still honours it — what was wrong is the conclusion that the risk
 * could not be separated from the fact.
 *
 * ~~`PROFILE_CAPABLE_PROVIDERS` is `['claude', 'codex']`, and this covers only the first. Codex
 * keeps its identity in `<CODEX_HOME>/auth.json`, which is a live CREDENTIAL file — on this machine
 * it holds `OPENAI_API_KEY`, an `access_token` and a `refresh_token` alongside the account id.
 * Reading a token file to build a display label is a real risk taken for a cosmetic gain, and the
 * risk is not "we might print it": it is that a value like that, once in a route's hands, has a way
 * of ending up in a log line or an error body later. Claude's `.claude.json` has no credential in
 * it at all (the OAuth tokens live in the macOS Keychain), which is what makes it safe to read
 * here.~~
 *
 * Two things settled it. First, `agent-config/account-identity.ts` has read codex's `id_token`
 * claims for the "Show details" route since `2026-07-29-agent-profiles.md` — the exclusion here was
 * not protecting a file the repo otherwise leaves alone, it was leaving discovery blind to a fact
 * cezar already displays. Second, the credentials are separable at the READER rather than at the
 * caller: `readCodexAuthClaims` returns the JWT payload and a boolean, and never the API key, the
 * access token or the refresh token — so no value that must not reach a log line is ever in a
 * route's hands to begin with. That is the guarantee the original paragraph wanted; it just had to
 * be built rather than avoided.
 *
 * The claims are also, unlike the tokens beside them, exactly the same class of fact as Claude's
 * `oauthAccount`: an email, a plan name, an organization. And they are equally non-authoritative —
 * see the next section.
 *
 * ## Nothing here is authoritative about auth
 *
 * `oauthAccount` is the last account the CLI wrote — it says who this dir BELONGS to, never whether
 * the login still works. That question already has an owner (`ProviderAuthService`, which shells
 * out to the CLI and is what fills `status` on an account row). This is identity, not liveness, and
 * they must not be confused: a dir whose session expired still names its account here.
 */

/** What one config dir says about itself. Every field optional — a dir the CLI has created but
 *  never logged into has a `.claude.json` with no `oauthAccount` at all. */
export interface AgentAccountIdentity {
  /** `oauthAccount.emailAddress` — the one field a person actually recognizes. */
  email?: string;
  /** A short plan label (`Max 20x`), derived from the vendor's own strings. See `planLabel`. */
  plan?: string;
  /** `oauthAccount.organizationName`, when it is not just the email restated. */
  organization?: string;
}

/**
 * A human plan label from whatever the vendor wrote, WITHOUT a lookup table of plan names.
 *
 * The only tier string observed on a real machine (2026-08-14) is `default_claude_max_20x`, so a
 * hardcoded map would be one verified entry and a pile of guesses — and a guessed plan name
 * rendered next to an email address reads exactly as confidently as a correct one. Instead:
 *
 * - `…max_<n>x…` → `Max <n>x`, which is the shape the tier string carries;
 * - otherwise the vendor's own `organizationType`/tier string, de-snake-cased, so an unrecognized
 *   plan still shows something true rather than nothing or something invented.
 */
export function planLabel(fields: { organizationType?: unknown; organizationRateLimitTier?: unknown }): string | undefined {
  const tier = typeof fields.organizationRateLimitTier === 'string' ? fields.organizationRateLimitTier : '';
  const type = typeof fields.organizationType === 'string' ? fields.organizationType : '';
  const multiplier = /max_(\d+)x/.exec(tier);
  if (multiplier) return `Max ${multiplier[1]}x`;
  const raw = type || tier;
  if (!raw) return undefined;
  return raw
    .replace(/^default_/, '')
    .replace(/^claude_/, '')
    .replace(/_/g, ' ')
    .replace(/^\w/, (ch) => ch.toUpperCase());
}

/**
 * Read the identity a Claude config dir records, or `null` when it records none.
 *
 * Never throws: an absent, unreadable or malformed file is simply an unknown identity, and a dir
 * whose identity is unknown must still be offered as a dir.
 *
 * The FILE this comes out of is `agent-config/account-identity.ts`'s to name, not this module's:
 * the location is not uniform (sibling of `~/.claude` by default, inside the dir under an override)
 * and that vendor rule has exactly one home in this repo. Getting it wrong would be worse than
 * useless — it would label a second account with the DEFAULT account's email, which is the one
 * failure this feature must not have — and a second `readFile` here is exactly how the two would
 * come to disagree. This function only decides which fields make a display identity.
 */
export async function readClaudeAccountIdentity(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentAccountIdentity | null> {
  const fields = await readClaudeOauthAccount(configDir, env);
  if (fields === null) return null;
  const email = typeof fields.emailAddress === 'string' ? fields.emailAddress : undefined;
  const organization = typeof fields.organizationName === 'string' ? fields.organizationName : undefined;
  const plan = planLabel(fields);
  const identity: AgentAccountIdentity = {
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
    // A personal account's org is literally "<email>'s Organization" — restating the email in
    // longer words. Dropped, so the field means "a real organization" wherever it is present.
    ...(organization && email && !organization.startsWith(email) ? { organization } : {}),
  };
  return Object.keys(identity).length > 0 ? identity : null;
}

/** One config dir found on this machine, with whatever it says about itself. */
export interface DiscoveredAgentAccount {
  provider: ProviderId;
  /** Absolute path of the config dir. */
  path: string;
  identity: AgentAccountIdentity | null;
}

/**
 * What a Codex config dir says about itself, from `auth.json`'s `id_token` claims. `null` when it
 * says nothing — an API-key login, an unreadable token, or a dir the CLI made but never signed in.
 *
 * Never throws, and never sees a credential: `readCodexAuthClaims` reduces `OPENAI_API_KEY` to a
 * boolean and does not read the access or refresh token at all.
 *
 * The plan is `chatgpt_plan_type` title-cased — the vendor's own word (`plus` → `Plus`), on the
 * same rule `planLabel` follows for Claude: show what the vendor said, never a name we invented.
 * The organization is dropped when it is the personal default, matching Claude's rule that an org
 * which merely restates the account is not an organization.
 */
export async function readCodexAccountIdentity(configDir: string): Promise<AgentAccountIdentity | null> {
  const auth = await readCodexAuthClaims(configDir);
  const claims = auth.claims;
  if (claims === null) return null;
  const email = typeof claims.email === 'string' ? claims.email : undefined;
  const openai = claims['https://api.openai.com/auth'];
  const scoped = openai && typeof openai === 'object' ? (openai as Record<string, unknown>) : {};
  const planType = typeof scoped.chatgpt_plan_type === 'string' ? scoped.chatgpt_plan_type : '';
  const plan = planType ? planType.replace(/^\w/, (ch) => ch.toUpperCase()) : undefined;
  const orgs = Array.isArray(scoped.organizations) ? scoped.organizations : [];
  const primary = orgs.find((org) => org && typeof org === 'object') as Record<string, unknown> | undefined;
  const title = typeof primary?.title === 'string' ? primary.title : undefined;
  const identity: AgentAccountIdentity = {
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
    ...(title && title !== 'Personal' ? { organization: title } : {}),
  };
  return Object.keys(identity).length > 0 ? identity : null;
}

/** Where each profile-capable provider's extra homes are conventionally kept, relative to `$HOME`.
 *  A prefix, not a pattern: `CLAUDE_CONFIG_DIR`/`CODEX_HOME` take any absolute path, so a dir
 *  somewhere else is perfectly legal and simply will not be discovered. */
const HOME_DIR_PREFIX: Record<'claude' | 'codex', string> = { claude: '.claude', codex: '.codex' };

/**
 * Every Claude and Codex config dir on this machine: each provider's discovered default, plus any
 * `~/.claude*` / `~/.codex*` sibling that carries that CLI's own marker files.
 *
 * The prefixes are the convention the feature itself established, and they are the honest boundary
 * of an autodetect: it offers what it can recognize, and the "Add account" folder picker still
 * exists for everything else. Widening the search to the whole home directory would turn opening a
 * settings pane into a filesystem crawl.
 *
 * `looksLikeProfileDir` is the recognizer, so this cannot invent a second definition of "a Claude
 * home" — an empty `~/.claude-notes` folder is not offered as a login, and `~/.codex-old-notes` is
 * not offered either unless it holds an `auth.json` or a `config.toml`.
 *
 * Ordering is stable (each provider's default first, then alphabetical, claude before codex) so the
 * pane does not reshuffle between reads, and identity failures degrade per row: one unreadable dir
 * costs its own label, never the list.
 *
 * **Keyed by path across providers, not per provider.** One dir cannot be two providers' homes, and
 * the marker sets do not overlap — but a shared `Map` also means a machine where someone pointed
 * `CODEX_HOME` at `~/.claude` reports it once rather than twice under two names.
 */
export async function discoverAgentAccounts(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DiscoveredAgentAccount[]> {
  const home = env.HOME || env.USERPROFILE || homedir();
  const homes = agentHomePaths(env);
  const found = new Map<string, DiscoveredAgentAccount>();
  const siblings = await readdir(home, { withFileTypes: true }).catch(() => null);

  const consider = async (provider: 'claude' | 'codex', path: string): Promise<void> => {
    if (found.has(path)) return;
    const entries = await readdir(path).catch(() => null);
    if (entries === null || !looksLikeProfileDir(provider, entries)) return;
    // The SAME env the dirs were resolved against — `claudeStateFilePath` reads `~/.claude`'s
    // state from a SIBLING file and an overridden dir's from inside it, so resolving against one
    // env and reading against another would look up the default dir under the override rule.
    const identity =
      provider === 'claude'
        ? await readClaudeAccountIdentity(path, env)
        : await readCodexAccountIdentity(path);
    found.set(path, { provider, path, identity });
  };

  for (const provider of ['claude', 'codex'] as const) {
    // The default first, whatever it is: with `CLAUDE_CONFIG_DIR`/`CODEX_HOME` set on the cezar
    // process itself it is not `~/.claude` at all, and the pane must name the dir cezar actually
    // spawns agents with.
    await consider(provider, provider === 'claude' ? homes.claude : homes.codex);
    const prefix = HOME_DIR_PREFIX[provider];
    const dirs = (siblings ?? [])
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of dirs) await consider(provider, join(home, entry.name));
  }
  return [...found.values()];
}

/**
 * **SUPERSEDED 2026-08-24 by `discoverAgentAccounts` above**, which covers codex as well. Kept as a
 * Claude-only filter over it so an out-of-tree caller keeps the answer it had; nothing in this repo
 * calls it.
 */
export async function discoverClaudeAccounts(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DiscoveredAgentAccount[]> {
  return (await discoverAgentAccounts(env)).filter((account) => account.provider === 'claude');
}
