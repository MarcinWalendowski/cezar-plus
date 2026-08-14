import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentHomePaths } from '../paths.ts';
import { readClaudeOauthAccount } from '../agent-config/account-identity.ts';
import { looksLikeProfileDir } from '../core/agent-profiles.ts';

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
 * ## Claude only, deliberately
 *
 * `PROFILE_CAPABLE_PROVIDERS` is `['claude', 'codex']`, and this covers only the first. Codex keeps
 * its identity in `<CODEX_HOME>/auth.json`, which is a live CREDENTIAL file — on this machine it
 * holds `OPENAI_API_KEY`, an `access_token` and a `refresh_token` alongside the account id. Reading
 * a token file to build a display label is a real risk taken for a cosmetic gain, and the risk is
 * not "we might print it": it is that a value like that, once in a route's hands, has a way of
 * ending up in a log line or an error body later. Claude's `.claude.json` has no credential in it
 * at all (the OAuth tokens live in the macOS Keychain), which is what makes it safe to read here.
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

/** One Claude config dir found on this machine, with whatever it says about itself. */
export interface DiscoveredAgentAccount {
  provider: 'claude';
  /** Absolute path of the config dir. */
  path: string;
  identity: AgentAccountIdentity | null;
}

/**
 * Every Claude config dir on this machine: the discovered default plus any `~/.claude*` sibling
 * that carries the CLI's own marker files.
 *
 * The `~/.claude*` prefix is the convention the feature itself established — `CLAUDE_CONFIG_DIR`
 * takes any absolute path, so a dir somewhere else is perfectly legal and simply will not be
 * discovered. That is the honest boundary of an autodetect: it offers what it can recognize, and
 * the "Add account" folder picker still exists for everything else. Widening the search to the
 * whole home directory would turn opening a settings pane into a filesystem crawl.
 *
 * `looksLikeProfileDir` is the recognizer, so this cannot invent a second definition of "a Claude
 * home" — an empty `~/.claude-notes` folder is not offered as a login.
 *
 * Ordering is stable (default first, then alphabetical) so the pane does not reshuffle between
 * reads, and identity failures degrade per row: one unreadable dir costs its own label, never the
 * list.
 */
export async function discoverClaudeAccounts(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DiscoveredAgentAccount[]> {
  const home = env.HOME || env.USERPROFILE || homedir();
  const found = new Map<string, DiscoveredAgentAccount>();
  const consider = async (path: string): Promise<void> => {
    if (found.has(path)) return;
    const entries = await readdir(path).catch(() => null);
    if (entries === null || !looksLikeProfileDir('claude', entries)) return;
    // The SAME env the dirs were resolved against — `claudeStateFilePath` reads `~/.claude`'s
    // state from a SIBLING file and an overridden dir's from inside it, so resolving against one
    // env and reading against another would look up the default dir under the override rule.
    found.set(path, { provider: 'claude', path, identity: await readClaudeAccountIdentity(path, env) });
  };

  // The default first, whatever it is: with `CLAUDE_CONFIG_DIR` set on the cezar process itself it
  // is not `~/.claude` at all, and the pane must name the dir cezar actually spawns agents with.
  await consider(agentHomePaths(env).claude);
  const siblings = await readdir(home, { withFileTypes: true }).catch(() => null);
  for (const entry of (siblings ?? []).filter((e) => e.isDirectory() && e.name.startsWith('.claude')).sort((a, b) => a.name.localeCompare(b.name))) {
    await consider(join(home, entry.name));
  }
  return [...found.values()];
}
