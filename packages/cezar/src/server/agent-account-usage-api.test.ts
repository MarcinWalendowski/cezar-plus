import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountUsageResponse } from '@loki-labs/better-cezar-contract';
import { agentAccountUsagePath, agentAccountsPath } from '../paths.ts';
import {
  awaitAccountUsageRefreshForTests,
  createAgentAccountUsageRoutes,
  resetAccountUsageRefreshForTests,
} from './agent-account-usage-routes.ts';

/**
 * `GET /workspace/agent-accounts/usage` (spec `2026-08-16-agent-account-usage-routing.md`).
 *
 * The test this file exists for is "a Claude row never carries a quota". Everything else here is
 * ordinary route behaviour; that one is the whole honesty argument, and it is the assertion that
 * fails the moment someone decides a percentage can be derived from tokens spent.
 */

const URL_PATH = 'http://x/workspace/agent-accounts/usage';

/** Flags on, hosted mode off — the topology this panel is allowed to exist in. */
const ON = { CEZ_ACCOUNT_USAGE: '1' } as NodeJS.ProcessEnv;

function futureUnixSeconds(minutes = 60): number {
  return Math.floor(Date.now() / 1000) + minutes * 60;
}

describe('agent account usage route', () => {
  const originalHome = process.env.CEZ_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-usage-api-'));
    process.env.CEZ_HOME = home;
    resetAccountUsageRefreshForTests();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  /** Two Claude logins (the discovered default + a stored one) and Codex's discovered default. */
  function writeAccounts(): void {
    writeFileSync(
      agentAccountsPath(),
      JSON.stringify({
        version: 1,
        accounts: [{ id: 'work', provider: 'claude', configDir: '/tmp/claude-work', label: 'Work' }],
      }),
    );
  }

  function writeUsage(accounts: Record<string, unknown>): void {
    writeFileSync(agentAccountUsagePath(), JSON.stringify({ version: 1, accounts }));
  }

  /** No probe ever reaches a real CLI in these tests. */
  const silentProbes = {
    probeQuota: async () => undefined,
    probeIdentity: async () => undefined,
  };

  async function get(deps: Parameters<typeof createAgentAccountUsageRoutes>[0]): Promise<AccountUsageResponse> {
    const res = await createAgentAccountUsageRoutes(deps).request(URL_PATH);
    expect(res.status).toBe(200);
    return (await res.json()) as AccountUsageResponse;
  }

  /** The two-phase read the panel actually performs: a first poll kicks the probes off and answers
   *  from the stored snapshot, a later poll sees what they found. */
  async function getAfterProbe(
    deps: Parameters<typeof createAgentAccountUsageRoutes>[0],
  ): Promise<AccountUsageResponse> {
    await get(deps);
    await awaitAccountUsageRefreshForTests();
    return get(deps);
  }

  describe('the flag', () => {
    it('answers 200 with an empty, schema-valid payload when off — never 404', async () => {
      // A 404 in this family has to keep meaning "no such route".
      const body = await get({ env: {}, ...silentProbes });
      expect(body).toEqual({ enabled: false, accounts: [] });
    });

    it('says `enabled` so a client can tell a disabled feature from a machine with no accounts', async () => {
      // Both answer `accounts: []`, and the two empty states read completely differently.
      expect((await get({ env: {}, ...silentProbes })).enabled).toBe(false);
      expect((await get({ env: ON, ...silentProbes })).enabled).toBe(true);
    });

    it('stays off in hosted mode even with the flag set', async () => {
      // The panel names each login's email, org and plan. The rest of this family is already
      // withheld when the bind is not loopback, for the weaker reason that it echoes host paths.
      const body = await get({ env: { ...ON, CEZ_REMOTE: '1' }, ...silentProbes });
      expect(body).toEqual({ enabled: false, accounts: [] });
    });
  });

  describe('rows', () => {
    it('lists every profile-capable account, discovered defaults included', async () => {
      writeAccounts();
      const body = await get({ env: ON, ...silentProbes });
      expect(body.accounts.map((a) => a.id)).toEqual(['default:claude', 'work', 'default:codex']);
      expect(body.accounts.map((a) => a.provider)).toEqual(['claude', 'claude', 'codex']);
    });

    it('never carries a quota on a Claude row', async () => {
      // THE guard. Claude reports no allowance — `claude auth status --json` has identity and a
      // plan NAME and nothing else — so a bar on this row could only have been invented, and it
      // would sit beside Codex's real one looking identical.
      writeAccounts();
      const body = await getAfterProbe({
        env: ON,
        probeQuota: async () => undefined,
        probeIdentity: async () => ({ loggedIn: true, plan: 'max', email: 'me@example.com' }),
      });
      for (const row of body.accounts.filter((a) => a.provider === 'claude')) {
        expect(row.quota).toBeUndefined();
        expect(row).not.toHaveProperty('usedPercent');
        // The plan is a NAME, and naming it must not smuggle a quantity onto the row.
        expect(row.plan).toBe('max');
      }
    });

    it('carries a fresh quota on a Codex row', async () => {
      writeUsage({
        'codex:default': {
          quota: {
            takenAt: new Date().toISOString(),
            planType: 'pro',
            windows: [{ usedPercent: 43, windowMinutes: 300, resetsAt: futureUnixSeconds() }],
          },
        },
      });
      const body = await get({ env: ON, ...silentProbes });
      const codex = body.accounts.find((a) => a.provider === 'codex');
      expect(codex?.quota?.planType).toBe('pro');
      expect(codex?.quota?.windows[0]?.usedPercent).toBe(43);
    });

    it('drops a stale quota rather than serving an old number as current', async () => {
      writeUsage({
        'codex:default': {
          quota: {
            takenAt: new Date(Date.now() - 60 * 60_000).toISOString(),
            windows: [{ usedPercent: 43, windowMinutes: 300, resetsAt: futureUnixSeconds() }],
          },
        },
      });
      const body = await get({ env: ON, ...silentProbes });
      expect(body.accounts.find((a) => a.provider === 'codex')?.quota).toBeUndefined();
    });

    it('does not give one provider’s default the other’s quota', async () => {
      // `default` is the reserved id for EVERY provider, so a key that ignored the provider would
      // draw Codex's bar on the Claude row. Only the zero-config setup would ever show it.
      writeUsage({
        'codex:default': {
          quota: {
            takenAt: new Date().toISOString(),
            windows: [{ usedPercent: 43, windowMinutes: 300, resetsAt: futureUnixSeconds() }],
          },
        },
      });
      const body = await get({ env: ON, ...silentProbes });
      expect(body.accounts.find((a) => a.provider === 'claude')?.quota).toBeUndefined();
      expect(body.accounts.find((a) => a.provider === 'codex')?.quota).toBeDefined();
    });
  });

  describe('identity', () => {
    it('leaves `signedIn` absent when cezar could not ask', async () => {
      // "Could not ask" is not "signed out" — collapsing them puts a red state on a working login.
      const body = await get({ env: ON, ...silentProbes });
      expect(body.accounts.find((a) => a.provider === 'claude')).not.toHaveProperty('signedIn');
    });

    it('reports a signed-out login as signed out', async () => {
      const body = await getAfterProbe({
        env: ON,
        probeQuota: async () => undefined,
        probeIdentity: async () => ({ loggedIn: false }),
      });
      expect(body.accounts.find((a) => a.provider === 'claude')?.signedIn).toBe(false);
    });

    it('keeps a good cached answer when a later probe cannot ask', async () => {
      // A momentarily busy CLI must not turn a working login red.
      let answer: { loggedIn: boolean; plan?: string } | undefined = { loggedIn: true, plan: 'max' };
      const deps = { env: ON, probeQuota: async () => undefined, probeIdentity: async () => answer };
      await getAfterProbe(deps);
      answer = undefined;
      const body = await getAfterProbe(deps);
      expect(body.accounts.find((a) => a.provider === 'claude')?.plan).toBe('max');
    });
  });

  describe('in-flight and limits', () => {
    it('reports the live count for the account it belongs to', async () => {
      writeAccounts();
      const body = await get({
        env: ON,
        ...silentProbes,
        inflight: () => ({ 'claude:work': 2, 'codex:default': 1 }),
      });
      const byId = Object.fromEntries(body.accounts.map((a) => [a.id, a.inflight]));
      expect(byId).toEqual({ 'default:claude': 0, work: 2, 'default:codex': 1 });
    });

    it('reads zero when this build cannot see runs at all', async () => {
      const body = await get({ env: ON, ...silentProbes });
      expect(body.accounts.every((a) => a.inflight === 0)).toBe(true);
    });

    it('marks a limited account and names when it recovers', async () => {
      const until = new Date(Date.now() + 30 * 60_000).toISOString();
      writeUsage({ 'codex:default': { limited: { since: new Date().toISOString(), until, source: 'run-error' } } });
      const codex = (await get({ env: ON, ...silentProbes })).accounts.find((a) => a.provider === 'codex');
      expect(codex?.limited).toBe(true);
      expect(codex?.limitedUntil).toBe(until);
    });

    it('does not name a recovery time it was never told', async () => {
      // The bounded cooldown makes the account eligible again; it is not a time to show a user.
      writeUsage({ 'codex:default': { limited: { since: new Date().toISOString(), source: 'run-error' } } });
      const codex = (await get({ env: ON, ...silentProbes })).accounts.find((a) => a.provider === 'codex');
      expect(codex?.limited).toBe(true);
      expect(codex).not.toHaveProperty('limitedUntil');
    });

    it('clears the limit once the window has passed', async () => {
      const since = new Date(Date.now() - 10 * 60_000).toISOString();
      const until = new Date(Date.now() - 60_000).toISOString();
      writeUsage({ 'codex:default': { limited: { since, until, source: 'run-error' } } });
      expect((await get({ env: ON, ...silentProbes })).accounts.find((a) => a.provider === 'codex')?.limited).toBe(false);
    });
  });

  describe('probing', () => {
    it('answers while the probes are still running, never waiting on a CLI child', async () => {
      // The failure this pins: awaiting the round would put each probe's multi-second timeout on
      // every poll of a panel whose whole job is to be glanceable. A probe that NEVER settles is
      // the only honest way to assert that — if the handler awaited it, this test would time out
      // rather than fail on an assertion.
      const never = new Promise<undefined>(() => {});
      const body = await get({
        env: ON,
        probeIdentity: () => never,
        probeQuota: () => never,
      });
      expect(body.enabled).toBe(true);
      expect(body.accounts.length).toBeGreaterThan(0);
      // Nothing came back yet, so nothing is claimed.
      expect(body.accounts.every((a) => a.quota === undefined)).toBe(true);
      expect(body.accounts.every((a) => a.signedIn === undefined)).toBe(true);
    });

    it('writes what a probe round found, so the next poll sees it', async () => {
      const quota = {
        takenAt: new Date().toISOString(),
        planType: 'pro',
        windows: [{ usedPercent: 12, windowMinutes: 300, resetsAt: futureUnixSeconds() }],
      };
      const body = await getAfterProbe({
        env: ON,
        probeIdentity: async () => undefined,
        probeQuota: async () => quota,
      });
      expect(body.accounts.find((a) => a.provider === 'codex')?.quota?.windows[0]?.usedPercent).toBe(12);
    });

    it('does not start a second probe round while one is still running', async () => {
      // A polling panel must not spawn a CLI child per poll.
      let started = 0;
      let release: (() => void) | undefined;
      const blocked = new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      });
      const deps = {
        env: ON,
        probeIdentity: async () => undefined,
        probeQuota: async () => {
          started += 1;
          return blocked;
        },
      };
      await get(deps);
      await get(deps);
      await get(deps);
      expect(started).toBe(1);
      release?.();
    });
  });
});
