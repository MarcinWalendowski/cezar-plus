import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentAccountUsagePath } from '../paths.ts';
import {
  accountUsageKey,
  defaultAgentAccountUsageStore,
  loadAgentAccountUsage,
  recordDispatch,
  recordLimited,
} from './agent-account-usage.ts';
import { resolvePoolForProvider } from './agent-route-select.ts';

/**
 * `resolvePoolForProvider` — the account for a provider a STEP pinned
 * (`.ai/specs/2026-08-23-step-runner-account-resolution.md`).
 *
 * The production failure this covers is silent by construction: landing on a provider's DEFAULT
 * login is indistinguishable from balancing onto it, so every assertion here names the account and
 * not merely "a claude account". Run `da0119ec` failed on `claude:default` at 15:51 UTC on
 * 2026-08-23 with `claude:secondary` unlimited and unconsulted.
 */

const HOME = { dir: '' };
const REPO = '/repo/example';

/** Two claude logins (`default` + `secondary`) and codex, as the cockpit writes them. */
function writeAccounts(defaults: Record<string, string>, selections: Record<string, Record<string, string>> = {}): void {
  writeFileSync(
    join(HOME.dir, 'agent-accounts.json'),
    JSON.stringify({
      version: 1,
      accounts: [
        { id: 'secondary', provider: 'claude', label: 'Secondary', configDir: join(HOME.dir, 'claude-secondary') },
      ],
      selections,
      defaults,
    }),
    'utf8',
  );
}

function writeUsage(build: (s: ReturnType<typeof defaultAgentAccountUsageStore>) => void): void {
  const store = defaultAgentAccountUsageStore();
  build(store);
  writeFileSync(agentAccountUsagePath(), JSON.stringify(store), 'utf8');
}

beforeEach(() => {
  HOME.dir = mkdtempSync(join(tmpdir(), 'cez-route-step-'));
  vi.stubEnv('CEZ_HOME', HOME.dir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(HOME.dir, { recursive: true, force: true });
});

describe('a step-pinned provider resolves its own account', () => {
  it('skips the limited default and returns the healthy sibling', async () => {
    // The exact production shape: `pool:*` on both providers, claude:default out of quota.
    writeAccounts({ claude: 'pool:*', codex: 'pool:*' });
    writeUsage((s) => {
      recordLimited(s, accountUsageKey('claude'), {
        source: 'usage-limit',
        until: '2026-08-26T23:00:00.000Z',
      });
    });

    const chosen = await resolvePoolForProvider({ provider: 'claude', repoRoot: REPO });

    // Names the ACCOUNT. `provider === 'claude'` would pass even on the bug.
    expect(chosen).toEqual({ provider: 'claude', accountId: 'secondary' });
  });

  it('never crosses providers on the wildcard `pool:*`', async () => {
    // The narrowing. `resolvePoolForDispatch` honours the wildcard's provider hop; this must not,
    // because the caller already pinned the provider. With EVERY claude account limited and codex
    // healthy, a wildcard that leaked would answer codex — and would silently undo the step's pin.
    writeAccounts({ claude: 'pool:*', codex: 'pool:*' });
    writeUsage((s) => {
      for (const key of [accountUsageKey('claude'), accountUsageKey('claude', 'secondary')]) {
        recordLimited(s, key, { source: 'usage-limit', until: '2026-08-26T23:00:00.000Z' });
      }
    });

    const chosen = await resolvePoolForProvider({ provider: 'claude', repoRoot: REPO });

    expect(chosen?.provider).toBe('claude');
  });

  it('leaves a non-pool route alone', async () => {
    // `undefined` means "do not interfere" — `selectProfile` already honours a stored account, and
    // a second routing rule here would be invisible.
    writeAccounts({ claude: 'secondary' });
    expect(await resolvePoolForProvider({ provider: 'claude', repoRoot: REPO })).toBeUndefined();

    writeAccounts({});
    expect(await resolvePoolForProvider({ provider: 'claude', repoRoot: REPO })).toBeUndefined();
  });

  it('advances the fairness cursor for the account it picked', async () => {
    writeAccounts({ claude: 'pool:*' });
    writeUsage(() => {});

    const chosen = await resolvePoolForProvider({ provider: 'claude', repoRoot: REPO });
    const after = await loadAgentAccountUsage();
    const key = accountUsageKey('claude', chosen?.accountId === 'default' ? undefined : chosen?.accountId);

    expect(after.accounts[key]?.dispatch?.lastAt).toBeDefined();
  });

  it('still balances by the cursor when nothing is limited', async () => {
    // Signal 4 reaching this path at all — proof the ranking is the shared one, not a fresh
    // "pick the non-default" rule that would only look correct in the limited case above.
    writeAccounts({ claude: 'pool:*' });
    writeUsage((s) => {
      recordDispatch(s, accountUsageKey('claude', 'secondary'));
    });

    // `secondary` was just dispatched, `default` never — least-recently-dispatched wins.
    const chosen = await resolvePoolForProvider({ provider: 'claude', repoRoot: REPO });
    expect(chosen?.accountId).toBe('default');
  });

  it('answers undefined rather than throwing when the home is unreadable', async () => {
    // No accounts file at all. Degrading beats refusing to start.
    expect(await resolvePoolForProvider({ provider: 'claude', repoRoot: REPO })).toBeUndefined();
  });
});
