import {
  DEFAULT_AGENT_ACCOUNT_ID,
  loadAgentAccounts,
  mergeWriteAgentAccounts,
  type AgentAccount,
} from './agent-accounts.ts';
import { discoverAgentAccounts, type DiscoveredAgentAccount } from './agent-account-identity.ts';
import { defaultAgentProfile, sameProfileDir } from './agent-profiles.ts';
import { expandTilde } from '../paths.ts';
import { allocateProjectSlug } from './projects.ts';
import { PROFILE_CAPABLE_PROVIDERS } from '../core/agent-profiles.ts';

/**
 * Register the logins already on this machine, instead of only offering them
 * (`.ai/specs/2026-08-24-second-codex-account-balancing.md`, D5). Behind `CEZ_AUTO_ACCOUNTS=1`.
 *
 * ## This reverses a decision, on purpose and only where it is asked for
 *
 * `2026-08-14-claude-subscription-autodetect.md` argued that *"discovery that registered what it
 * found would be a write nobody asked for, and would also decide FOR the user that every login on
 * the machine belongs in this cockpit"*, and the route that serves discovery still behaves exactly
 * that way — it proposes, it never writes. That argument is right by default, which is why this is
 * strictly opt-in and off for anyone who does not set the flag.
 *
 * The case it is wrong for is the one this was built for: a machine whose owner keeps every login
 * on it in one pool, and where the alternative is not a click but hand-editing
 * `agent-accounts.json` over ssh. On `prod-host` that is not rhetorical — `CEZ_REMOTE=1`
 * means the accounts routes withhold the listing and refuse the POST, so the UI path does not
 * exist there at all and the second Claude account really was added by editing JSON by hand.
 *
 * ## Deliberately not gated on `localHandoff`
 *
 * The routes withhold host PATHS FROM A BROWSER. This writes the server's own state, on the
 * server, and discloses nothing to anyone. Gating it the same way would make the flag inert on the
 * one class of machine that cannot use the UI instead, which is the machine it exists for.
 *
 * ## What it will not do
 *
 * - **Never touches an existing row.** Append-only: no relabelling, no repointing, no removal.
 *   Whatever the user set stays set.
 * - **Never registers a dir with no identity.** A config folder the CLI created but was never
 *   signed into is not an account; adding it would put a login that cannot run into the pool,
 *   where its turn in the rotation is a failed task. This is the one check standing between
 *   "detected a directory" and "spent a subscription".
 * - **Never registers a provider that cannot carry a second account** — `PROFILE_CAPABLE_PROVIDERS`
 *   is the same gate the POST route applies, for the same reason: for the others the config dir
 *   does not move the credentials, so the row would name an account the CLI never uses.
 *
 * ## The known edge, stated rather than guarded
 *
 * It cannot see a deliberate removal. Delete an auto-registered account and the next sweep adds it
 * back, because nothing records "not this one". The fix, if it ever bites, is a dismissed-dirs list
 * in the store — not a change here — and it is written down in the spec's R3 rather than hidden.
 */
export interface AutoRegisterResult {
  /** The rows appended, in the order they were added. Empty is the steady state. */
  added: AgentAccount[];
}

/** Strict `'1'`, like every other capability flag in this repo: no other spelling enables it. */
export function autoAccountsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_AUTO_ACCOUNTS === '1';
}

/**
 * One sweep. Never throws — an unreadable home, a vanished dir or a failed write is a sweep that
 * added nothing, and the caller (a boot hook and an interval) has no failure path worth having.
 */
export async function autoRegisterDiscoveredAccounts(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AutoRegisterResult> {
  if (!autoAccountsEnabled(env)) return { added: [] };
  try {
    const [discovered, store] = await Promise.all([discoverAgentAccounts(env), loadAgentAccounts()]);
    const fresh: DiscoveredAgentAccount[] = [];
    for (const found of discovered) {
      if (!PROFILE_CAPABLE_PROVIDERS.includes(found.provider)) continue;
      // A dir the CLI made but was never signed into names no account — see the doc above.
      if (found.identity === null) continue;
      if (await isKnownDir(store.accounts, found, env)) continue;
      fresh.push(found);
    }
    if (fresh.length === 0) return { added: [] };

    const added: AgentAccount[] = [];
    await mergeWriteAgentAccounts((current) => {
      // Ids allocated against the store as re-read INSIDE the merge, not against the snapshot
      // above: two sweeps (boot and the first interval tick) can otherwise allocate the same id
      // from two reads of the same file, and the second write would carry a duplicate.
      const taken = current.accounts.map((account) => account.id);
      for (const found of fresh) {
        // Re-checked under the merge for the same reason. `sameProfileDir` is async and cannot run
        // in here, so this is the cheap spelling — an exact path match catches the double-sweep
        // race, and the realpath comparison above catches the two-spellings-of-one-dir case.
        if (current.accounts.some((a) => a.provider === found.provider && a.configDir === found.path)) continue;
        const label = found.identity?.email ?? found.path;
        const row: AgentAccount = {
          id: allocateProjectSlug(label, taken),
          provider: found.provider,
          configDir: found.path,
          label,
          addedAt: new Date().toISOString(),
        };
        taken.push(row.id);
        current.accounts.push(row);
        added.push(row);
      }
      return current;
    });
    return { added };
  } catch {
    return { added: [] };
  }
}

/** Already the provider's discovered default, or already a stored row — compared through
 *  `realpath`, exactly as `POST …/agent-profiles` does, so a symlinked spelling of one directory
 *  is not registered as a second account. */
async function isKnownDir(
  stored: readonly AgentAccount[],
  found: DiscoveredAgentAccount,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  // The SAME env discovery resolved against: with `CODEX_HOME` set on the cezar process the
  // default account is not `~/.codex`, and comparing against `process.env`'s answer would register
  // the real default as a second account.
  if (await sameProfileDir(found.path, defaultAgentProfile(found.provider, env).path)) return true;
  for (const account of stored) {
    if (account.provider !== found.provider) continue;
    if (account.id === DEFAULT_AGENT_ACCOUNT_ID) continue;
    // Stored dirs keep a literal `~` (the store records what the user typed); discovery always
    // hands back an absolute path, so one side has to be expanded or every stored `~/.claude-work`
    // reads as a different directory and is registered again on every sweep.
    if (await sameProfileDir(found.path, expandTilde(account.configDir))) return true;
  }
  return false;
}
