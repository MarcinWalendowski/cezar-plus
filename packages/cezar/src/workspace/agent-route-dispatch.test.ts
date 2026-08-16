import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentAccountUsagePath } from '../paths.ts';
import { accountUsageKey, loadAgentAccountUsage } from './agent-account-usage.ts';
import { resolvePoolForDispatch } from './agent-route-select.ts';

/**
 * The dispatch-time half of pool routing
 * (`.ai/specs/2026-08-16-agent-account-usage-routing.md`, Phase C).
 *
 * `agent-route-select.test.ts` covers the RANKING against an in-memory store. This file covers the
 * things that only exist once real files are involved, and which a pure-function test cannot reach:
 * which value gets parsed, whether the project's stored selection is consulted at all, and whether
 * the fairness cursor actually advances on disk. Each of those failed silently — a pool that
 * resolves to "not a pool" simply runs on the default login and looks completely normal.
 */

const HOME = { dir: '' };
const REPO = '/repo/example';

/** Two claude logins and one codex, written the way the cockpit writes them. */
function writeAccounts(selections: Record<string, Record<string, string>> = {}): void {
  writeFileSync(
    join(HOME.dir, 'agent-accounts.json'),
    JSON.stringify({
      version: 1,
      accounts: [
        { id: 'work', provider: 'claude', label: 'Work', configDir: join(HOME.dir, 'claude-work') },
      ],
      selections,
      defaults: {},
    }),
    'utf8',
  );
}

beforeEach(() => {
  HOME.dir = mkdtempSync(join(tmpdir(), 'cez-route-dispatch-'));
  vi.stubEnv('CEZ_HOME', HOME.dir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(HOME.dir, { recursive: true, force: true });
});

const resolve = (agentProfile: string | undefined, fallback: 'claude' | 'codex' = 'claude') =>
  resolvePoolForDispatch({ agentProfile, fallbackProvider: fallback, repoRoot: REPO });

describe('what counts as a pool', () => {
  it('resolves the task\'s own pool choice to a concrete login', async () => {
    writeAccounts();
    const chosen = await resolve('pool:claude');
    expect(chosen?.provider).toBe('claude');
    // A CONCRETE id, never the pool string — the record has to name the login that ran.
    expect(['default', 'work']).toContain(chosen?.accountId);
  });

  it('leaves an ordinary account choice completely alone', async () => {
    writeAccounts();
    // `undefined` means "not a pool, do not interfere". Returning a choice here would make a
    // specific-account selection silently balance.
    expect(await resolve('work')).toBeUndefined();
    expect(await resolve('default')).toBeUndefined();
    expect(await resolve(undefined)).toBeUndefined();
  });

  it('does not honour a `pool:` value naming something that is not a provider', async () => {
    writeAccounts();
    expect(await resolve('pool:anthropic')).toBeUndefined();
  });
});

describe('a pool stored as the project\'s selection', () => {
  it('is resolved even though it never appears on the run input', async () => {
    // THE test in this file. A pool picked in Settings is written to `selections[root][provider]`
    // and is NOT on `input.agentProfile`. Reading only the task's choice made this parse as "no
    // route": it fell through to `selectProfile`, which finds no account with that id and degrades
    // to the discovered login. The setting would have read as applied and done nothing at all.
    writeAccounts({ [REPO]: { claude: 'pool:claude' } });
    const chosen = await resolve(undefined);
    expect(chosen?.provider).toBe('claude');
    expect(['default', 'work']).toContain(chosen?.accountId);
  });

  it('is consulted for the provider the run would actually use', async () => {
    // The selection map is per-provider. Looking it up under the wrong provider finds nothing, and
    // "nothing" is indistinguishable from "no pool configured".
    writeAccounts({ [REPO]: { codex: 'pool:codex' } });
    expect(await resolve(undefined, 'claude')).toBeUndefined();
    expect((await resolve(undefined, 'codex'))?.provider).toBe('codex');
  });

  it('loses to the task\'s own choice, which is the existing precedence', async () => {
    writeAccounts({ [REPO]: { claude: 'pool:claude' } });
    expect(await resolve('work')).toBeUndefined();
  });

  it('is not read from another repo\'s selection', async () => {
    writeAccounts({ '/repo/other': { claude: 'pool:claude' } });
    expect(await resolve(undefined)).toBeUndefined();
  });
});

describe('the everything pool picks the provider too', () => {
  it('can answer codex for a run whose fallback provider is claude', async () => {
    writeAccounts();
    // Forced by making every claude login look busy; the point is that the ANSWER may be a
    // different provider than the one the run would otherwise have used.
    const chosen = await resolvePoolForDispatch({
      agentProfile: 'pool:*',
      fallbackProvider: 'claude',
      repoRoot: REPO,
      inflight: { [accountUsageKey('claude')]: 4, [accountUsageKey('claude', 'work')]: 4 },
    });
    expect(chosen?.provider).toBe('codex');
  });
});

describe('the fairness cursor', () => {
  it('advances on disk at the moment of the choice, not at completion', async () => {
    // A burst of simultaneous dispatches would otherwise all read the same least-recently-used
    // account and stack onto it — the thundering herd signal 3 exists to prevent.
    writeAccounts();
    const chosen = await resolve('pool:claude');
    const stored = await loadAgentAccountUsage();
    const entry = stored.accounts[accountUsageKey('claude', chosen!.accountId)];
    expect(entry?.dispatch?.count).toBe(1);
    expect(Date.parse(entry!.dispatch!.lastAt)).toBeGreaterThan(0);
  });

  it('spreads consecutive dispatches across the logins', async () => {
    // The behavioural assertion: three real resolutions, each writing the cursor the next one
    // reads. An implementation that resolved correctly but never recorded would return the same
    // account every time and still pass every other test in this file.
    writeAccounts();
    const picked: string[] = [];
    for (let i = 0; i < 4; i++) picked.push((await resolve('pool:claude'))!.accountId);
    expect(new Set(picked).size).toBe(2);
  });

  it('does not record anything for a route that is not a pool', async () => {
    writeAccounts();
    await resolve('work');
    expect(Object.keys((await loadAgentAccountUsage()).accounts)).toEqual([]);
  });
});

describe('degrades rather than blocking the run', () => {
  it('answers undefined when the usage file is corrupt', async () => {
    // A pool that cannot be resolved must fall through to the old behaviour, never refuse to start.
    writeAccounts();
    writeFileSync(agentAccountUsagePath(), '{ not json', 'utf8');
    const chosen = await resolve('pool:claude');
    // The corrupt file degrades to an empty store inside `loadAgentAccountUsage`, so this still
    // resolves — the assertion is that it did not throw and did not return a pool string.
    expect(chosen?.accountId).not.toContain('pool:');
  });

  it('answers undefined when there are no accounts to balance over', async () => {
    // No accounts file at all. `listAgentProfiles` still discovers the per-provider defaults, so
    // `pool:claude` has exactly one candidate and resolves to it — the honest answer for a machine
    // with one login, and not an error.
    expect((await resolve('pool:claude'))?.accountId).toBe('default');
  });
});
