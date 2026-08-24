import { describe, expect, it } from 'vitest';
import {
  isLocalOrgModeActive,
  isLoopbackHost,
  isLoopbackHostHeader,
  normalizeHostname,
  resolveAuthProvider,
  resolveCapabilities,
} from './capabilities.ts';

/**
 * `resolveCapabilities` takes its env as a parameter, so these drive it
 * directly rather than mutating `process.env`.
 *
 * The two loopback predicates sit at different trust seams and must not be
 * collapsed into one (#426 / #467 review):
 *   - `isLoopbackHost(bindHost)`   — our own config. Undefined = "we defaulted
 *                                     to the loopback bind" ⇒ trusted.
 *   - `isLoopbackHostHeader(host)` — an attacker-controlled request header.
 *                                     Absent or unparseable ⇒ untrusted.
 * Both share an *anchored* address match: a `127.` string prefix also matches
 * registrable hostnames like `127.0.0.1.evil.com`, which was the DNS-rebinding
 * bypass this pair replaced.
 */

const REAL_LOOPBACK = [
  'localhost',
  'LOCALHOST',
  '127.0.0.1',
  '127.1.2.3',
  '127.255.255.255',
  '::1',
  '[::1]',
  '0:0:0:0:0:0:0:1',
];

// Every one of these is registrable by an attacker and resolvable to 127.0.0.1.
const NOT_LOOPBACK = [
  '127.0.0.1.evil.com',
  '127.evil.com',
  '127.0.0.1.nip.io',
  '1270.0.0.1',
  '127.0.0.1x',
  '127.0.0.256',
  '127.0.0',
  'localhost.evil.com',
  // Malformed authorities: a lax parser normalizes each of these down to a
  // loopback name. They must fail closed instead.
  '[::1]@evil.com',
  '[::1]evil.com',
  '[::1]x',
  '127.0.0.1%2eevil.com',
  'localhost%.evil.com',
  '127.0.0.1:evil.com',
  'evil.com:80:127.0.0.1',
  '0.0.0.0',
  '192.168.1.10',
  'example.com',
  '::2',
  '::1:1',
];

describe('normalizeHostname', () => {
  it.each([
    ['127.0.0.1:4321', '127.0.0.1'],
    // IPv6 is canonicalized to all 8 groups, so every spelling of ::1 — and the
    // compressed form `new URL().hostname` emits — compares equal.
    ['[::1]:4321', '0:0:0:0:0:0:0:1'],
    ['[0:0:0:0:0:0:0:1]:4321', '0:0:0:0:0:0:0:1'],
    ['[0000:0000:0000:0000:0000:0000:0000:0001]', '0:0:0:0:0:0:0:1'],
    ['::1', '0:0:0:0:0:0:0:1'], // bare IPv6 literal: >1 colon, so never `name:port`
    ['LocalHost.:4321', 'localhost'], // lowercased, trailing FQDN dot dropped
    ['fe80::1%eth0', 'fe80:0:0:0:0:0:0:1'], // IPv6 zone id stripped
    ['[::1%25eth0]:4321', '0:0:0:0:0:0:0:1'], // bracketed, zone id + port
  ])('normalizes %s → %s', (input, expected) => {
    expect(normalizeHostname(input)).toBe(expected);
  });

  it.each([
    '[::1]@evil.com', // trailing junk after the bracket
    '[::1]evil.com',
    '127.0.0.1:evil.com', // port that is not digits
    'evil.com:80:127.0.0.1',
  ])('returns "" for the unparseable authority %s', (input) => {
    expect(normalizeHostname(input)).toBe('');
  });

  it('only strips a % zone id at the end, never mid-hostname', () => {
    // `.replace(/%.*$/, '')` would truncate these to a loopback name.
    expect(normalizeHostname('127.0.0.1%2eevil.com')).toBe('127.0.0.1%2eevil.com');
    expect(normalizeHostname('localhost%.evil.com')).toBe('localhost%.evil.com');
  });
});

describe('isLoopbackHostHeader (untrusted request header)', () => {
  it.each(REAL_LOOPBACK)('accepts the real loopback host %s', (host) => {
    expect(isLoopbackHostHeader(host)).toBe(true);
  });

  it.each(NOT_LOOPBACK)('rejects the non-loopback host %s', (host) => {
    expect(isLoopbackHostHeader(host)).toBe(false);
  });

  it('rejects a missing Host header — absent is untrusted, not "defaulted"', () => {
    expect(isLoopbackHostHeader(undefined)).toBe(false);
    expect(isLoopbackHostHeader('')).toBe(false);
  });

  it('accepts loopback hosts that carry a port or brackets', () => {
    expect(isLoopbackHostHeader('127.0.0.1:4321')).toBe(true);
    expect(isLoopbackHostHeader('[::1]:4321')).toBe(true);
    expect(isLoopbackHostHeader('localhost.:4321')).toBe(true);
  });
});

describe('isLoopbackHost (our own bind host)', () => {
  it('treats the default bind (undefined) as loopback', () => {
    expect(isLoopbackHost(undefined)).toBe(true);
  });

  it.each(REAL_LOOPBACK)('accepts %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(NOT_LOOPBACK)('rejects %s', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('resolveCapabilities — localHandoff', () => {
  it('is on for a default local bind', () => {
    expect(resolveCapabilities({}, undefined).localHandoff).toBe(true);
  });

  it('is on for an explicit loopback bind', () => {
    expect(resolveCapabilities({}, '127.0.0.1').localHandoff).toBe(true);
  });

  it('is off when CEZ_REMOTE=1', () => {
    expect(resolveCapabilities({ CEZ_REMOTE: '1' }, undefined).localHandoff).toBe(false);
  });

  it('is off for a non-loopback bind host', () => {
    expect(resolveCapabilities({}, '0.0.0.0').localHandoff).toBe(false);
  });
});

describe('resolveCapabilities — accountUsage (hosted opt-in, added 2026-08-17)', () => {
  it('is off by default', () => {
    expect(resolveCapabilities({}, undefined).accountUsage).toBe(false);
  });

  it('is on with CEZ_ACCOUNT_USAGE=1 alone, in local mode', () => {
    expect(resolveCapabilities({ CEZ_ACCOUNT_USAGE: '1' }, undefined).accountUsage).toBe(true);
  });

  it('stays off with CEZ_ACCOUNT_USAGE=1 alone when hosted — the pre-override behavior, must not regress', () => {
    expect(resolveCapabilities({ CEZ_ACCOUNT_USAGE: '1', CEZ_REMOTE: '1' }, undefined).accountUsage).toBe(false);
  });

  it('is on when hosted with BOTH CEZ_ACCOUNT_USAGE=1 and CEZ_ACCOUNT_USAGE_HOSTED=1', () => {
    expect(
      resolveCapabilities({ CEZ_ACCOUNT_USAGE: '1', CEZ_ACCOUNT_USAGE_HOSTED: '1', CEZ_REMOTE: '1' }, undefined)
        .accountUsage,
    ).toBe(true);
  });

  it('the override alone, without the base flag, never enables it', () => {
    expect(
      resolveCapabilities({ CEZ_ACCOUNT_USAGE_HOSTED: '1', CEZ_REMOTE: '1' }, undefined).accountUsage,
    ).toBe(false);
    expect(resolveCapabilities({ CEZ_ACCOUNT_USAGE_HOSTED: '1' }, undefined).accountUsage).toBe(false);
  });

  it.each(['0', 'true', 'yes', '', 'on'])(
    'CEZ_ACCOUNT_USAGE_HOSTED=%j stays off when hosted — only an exact "1" opts in',
    (value) => {
      expect(
        resolveCapabilities({ CEZ_ACCOUNT_USAGE: '1', CEZ_ACCOUNT_USAGE_HOSTED: value, CEZ_REMOTE: '1' }, undefined)
          .accountUsage,
      ).toBe(false);
    },
  );

  it('does not affect localHandoff itself — the override is scoped to this one field', () => {
    expect(
      resolveCapabilities({ CEZ_ACCOUNT_USAGE: '1', CEZ_ACCOUNT_USAGE_HOSTED: '1', CEZ_REMOTE: '1' }, undefined)
        .localHandoff,
    ).toBe(false);
  });
});

describe('resolveCapabilities — followups (#471)', () => {
  it('is OFF by default — the global inbox is opt-in', () => {
    expect(resolveCapabilities({}, undefined).followups).toBe(false);
  });

  it('is on with CEZ_FOLLOWUPS=1', () => {
    expect(resolveCapabilities({ CEZ_FOLLOWUPS: '1' }, undefined).followups).toBe(true);
  });

  it.each(['0', 'true', 'yes', '', 'on'])(
    'stays off for CEZ_FOLLOWUPS=%j — only an exact "1" opts in',
    (value) => {
      expect(resolveCapabilities({ CEZ_FOLLOWUPS: value }, undefined).followups).toBe(false);
    },
  );

  it('cluster is off by default and on only for an exact CEZ_CLUSTER=1', () => {
    expect(resolveCapabilities({}, undefined).cluster).toBe(false);
    expect(resolveCapabilities({ CEZ_CLUSTER: '1' }, undefined).cluster).toBe(true);
    // The negative control that matters: an opt-IN key must not be readable as an opt-OUT one.
    // Three of the keys in this object are `!== '0'` gates, and a `cluster` written that way would
    // turn every existing install into a cluster node on upgrade — `@loki-labs/better-cezar` is
    // published, so that would reach machines this repo does not control (PLAN P8).
    for (const value of ['0', 'true', 'yes', '', 'on', 'TRUE']) {
      expect(resolveCapabilities({ CEZ_CLUSTER: value }, undefined).cluster).toBe(false);
    }
    // Hosted mode does NOT withhold it, unlike `accountUsage`: the hub is precisely the node that
    // runs hosted, so withholding here would hide the cluster from the machine most likely to be
    // one. And it is not AND-ed with `singleProject` either — a single-project cockpit is exactly
    // the shape a provisioned worker takes.
    expect(resolveCapabilities({ CEZ_CLUSTER: '1', CEZ_REMOTE: '1' }, '0.0.0.0').cluster).toBe(true);
    expect(resolveCapabilities({ CEZ_CLUSTER: '1', CEZ_SINGLE_PROJECT: '1' }, undefined).cluster).toBe(true);
  });

  it('is independent of the deployment mode', () => {
    expect(resolveCapabilities({ CEZ_FOLLOWUPS: '1', CEZ_REMOTE: '1' }, '0.0.0.0')).toEqual({
      localHandoff: false,
      followups: true,
      singleProject: false,
      automations: false,
      tokenMetrics: true,
      tokenUsageMetrics: true,
      costMetrics: true,
      knowledge: false,
      sources: false,
      notes: false,
      // Opt-OUT since 2026-08-16, like `skills` below: `true` in an env that sets nothing. Hosted
      // mode does NOT withhold it — unlike `accountUsage`, which names each login's email and org,
      // this payload is project names, branches and commit subjects, already behind whatever auth
      // the deployment runs.
      workspaceViews: true,
      notify: false,
      accountUsage: false,
      // Opt-OUT, so it is `true` in an env that sets nothing. This `toEqual` is the exhaustive
      // one — it is what forces every new capability to be declared here rather than added
      // silently, and it is why the polarity of a new key cannot slip through unnoticed.
      skills: true,
      // Opt-IN (`CEZ_CLUSTER=1`, spec 2026-08-22-multi-node-cezar-cluster), and NOT withheld in
      // hosted mode: the hub is the node that runs hosted, so a capability that vanished under
      // `CEZ_REMOTE=1` would hide the cluster from the only machine that can be one.
      cluster: false,
      // Opt-IN (`CEZ_AUTO_ACCOUNTS=1`, spec 2026-08-24-second-codex-account-balancing), and NOT
      // withheld in hosted mode either — see the dedicated test below for why the two differ.
      autoAccounts: false,
    });
  });

  it('reports autoAccounts under CEZ_REMOTE, unlike accountUsage', () => {
    // The pair is the assertion: with both flags set, hosted mode withholds one and not the other.
    // `accountUsage` gates a DISCLOSURE (each login's email, org and plan), so hosted is the
    // audience question and it needs its own `CEZ_ACCOUNT_USAGE_HOSTED=1` override.
    // `autoAccounts` gates a server-side WRITE that discloses nothing, and hosted boxes are exactly
    // the ones whose operators cannot use the Add-account pane instead — withholding it there would
    // switch the feature off on the only machines that need it.
    const hosted = resolveCapabilities({ CEZ_AUTO_ACCOUNTS: '1', CEZ_ACCOUNT_USAGE: '1', CEZ_REMOTE: '1' }, '0.0.0.0');
    expect(hosted).toMatchObject({ autoAccounts: true, accountUsage: false, localHandoff: false });
  });

  it.each(['true', 'yes', '0', ''])('does not enable autoAccounts for the spelling %j', (value) => {
    // Strict `'1'`, like every other capability here. A flag that WRITES state must not be
    // turn-on-able by a plausible typo.
    expect(resolveCapabilities({ CEZ_AUTO_ACCOUNTS: value }, undefined).autoAccounts).toBe(false);
  });
});

describe('resolveAuthProvider (CEZ_AUTH, D1)', () => {
  it('is "none" for the npm default (nothing set)', () => {
    expect(resolveAuthProvider({})).toBe('none');
  });

  it('is "oidc" for CEZ_AUTH=oidc', () => {
    expect(resolveAuthProvider({ CEZ_AUTH: 'oidc' })).toBe('oidc');
  });

  it('is "google" for CEZ_AUTH=google', () => {
    expect(resolveAuthProvider({ CEZ_AUTH: 'google' })).toBe('google');
  });

  it.each(['1', 'true', 'OIDC', 'Google', 'none', ''])(
    'falls back to "none" for the unrecognised spelling %j — a typo must never silently turn auth on',
    (value) => {
      expect(resolveAuthProvider({ CEZ_AUTH: value })).toBe('none');
    },
  );

  it('is independent of the deployment mode', () => {
    expect(resolveAuthProvider({ CEZ_AUTH: 'oidc', CEZ_REMOTE: '1' })).toBe('oidc');
  });

  // The spec's Risks section makes the auth-off health payload the control for the whole auth
  // change ("a diff in the auth-off health payload is a failure, not an update"). `CEZ_AUTH` is
  // therefore read through the function above and NOT reported as a capability — this asserts
  // the absence directly, so re-adding the key fails here rather than only in the ~20 fixtures
  // whose edits are what made the first attempt look green.
  it('never appears in the capability payload, whatever CEZ_AUTH says', () => {
    expect(resolveCapabilities({ CEZ_AUTH: 'oidc' })).not.toHaveProperty('auth');
    expect(resolveCapabilities({ CEZ_AUTH: 'oidc', CEZ_REMOTE: '1' }, '0.0.0.0')).not.toHaveProperty('auth');
  });
});

describe('isLocalOrgModeActive (D13, FIX A3 — the registration seam\'s bind predicate)', () => {
  it('is true for the npm zero-config default: CEZ_AUTH unset, loopback bind (undefined)', () => {
    expect(isLocalOrgModeActive({}, undefined)).toBe(true);
  });

  it('is true for an explicit loopback bindHost too', () => {
    expect(isLocalOrgModeActive({}, '127.0.0.1')).toBe(true);
  });

  it.each(['oidc', 'google', 'supervisor'])(
    'is false whenever CEZ_AUTH names a real provider (%s), even on a loopback bind',
    (provider) => {
      expect(isLocalOrgModeActive({ CEZ_AUTH: provider }, undefined)).toBe(false);
    },
  );

  it('is false on a hosted (non-loopback) bind, even with CEZ_AUTH unset', () => {
    expect(isLocalOrgModeActive({}, '0.0.0.0')).toBe(false);
  });

  it('is false when CEZ_REMOTE=1, even with CEZ_AUTH unset and no bindHost — the D1 hosted-unauthenticated topology', () => {
    expect(isLocalOrgModeActive({ CEZ_REMOTE: '1' }, undefined)).toBe(false);
  });

  it('is false when BOTH halves fail — a hosted CEZ_AUTH=oidc deployment is the case FIX A3 exists for', () => {
    expect(isLocalOrgModeActive({ CEZ_AUTH: 'oidc' }, '0.0.0.0')).toBe(false);
  });
});

describe('resolveCapabilities — skills is the one OPT-OUT capability', () => {
  // Skills predates the capability payload. Had it been added with the `=== '1'` polarity of
  // every neighbour, upgrading would have removed the Skills tab from every install that had
  // never heard of the flag. These assert the inversion in both directions, because "defaults
  // on" and "cannot be turned off" look identical from the default case alone.
  it('is on when the flag is unset', () => {
    expect(resolveCapabilities({})).toMatchObject({ skills: true });
  });

  it('is off for exactly "0"', () => {
    expect(resolveCapabilities({ CEZ_SKILLS: '0' })).toMatchObject({ skills: false });
  });

  it.each(['1', 'true', 'false', 'no', '', 'off'])(
    'stays ON for %j — only an exact "0" opts out',
    (value) => {
      expect(resolveCapabilities({ CEZ_SKILLS: value })).toMatchObject({ skills: true });
    },
  );
});

describe('resolveCapabilities — central-hub scaffold flags (knowledge, sources, notes, workspaceViews, notify)', () => {
  it('are all off by default — except workspaceViews, which is ON', () => {
    // **CHANGED 2026-08-16** (`2026-08-16-claude-usage-windows.md` is a different spec; this is the
    // workspace-views default flip recorded in CHANGELOG and in the 2026-08-06 spec's Q4). This
    // block used to assert `workspaceViews: false` here and in the exact-"1" table below, and both
    // assertions were correct for a flag nobody ever set. The boards it gates are the cockpit's
    // main surface on a multi-project install, and a main path gated on an unset flag fails as
    // SILENCE — the owner ran a full workspace and was told the git overview was off.
    expect(resolveCapabilities({})).toMatchObject({
      knowledge: false,
      sources: false,
      notes: false,
      workspaceViews: true,
      notify: false,
      accountUsage: false,
    });
  });

  it('turn on independently with their own exact-"1" flag', () => {
    expect(resolveCapabilities({ CEZ_KB: '1' })).toMatchObject({ knowledge: true, sources: false });
    expect(resolveCapabilities({ CEZ_SOURCES: '1' })).toMatchObject({ knowledge: false, sources: true });
    expect(resolveCapabilities({ CEZ_NOTES: '1' })).toMatchObject({ notes: true });
    // Still true with the flag set: the flip changed the DEFAULT, so no install that already sets
    // `=1` behaves differently after it.
    expect(resolveCapabilities({ CEZ_WORKSPACE_VIEWS: '1' })).toMatchObject({ workspaceViews: true });
    expect(resolveCapabilities({ CEZ_NOTIFY: '1' })).toMatchObject({ notify: true });
  });

  it.each(['0', 'true', 'yes', '', 'on'])('stays off for %j — only an exact "1" opts in', (value) => {
    expect(
      resolveCapabilities({
        CEZ_KB: value,
        CEZ_SOURCES: value,
        CEZ_NOTES: value,
        CEZ_NOTIFY: value,
      }),
    ).toMatchObject({
      knowledge: false,
      sources: false,
      notes: false,
      notify: false,
      accountUsage: false,
    });
  });

  it.each(['1', 'true', 'yes', '', 'on'])(
    'workspaceViews stays ON for %j — only an exact "0" opts out',
    (value) => {
      // The inverted spelling, matching `CEZ_SKILLS`. A typo'd opt-out leaves the boards ON, which
      // is the safe direction: the failure of the other reading is a blank page with no error.
      expect(resolveCapabilities({ CEZ_WORKSPACE_VIEWS: value })).toMatchObject({ workspaceViews: true });
    },
  );

  it('workspaceViews is off for an exact "0"', () => {
    expect(resolveCapabilities({ CEZ_WORKSPACE_VIEWS: '0' })).toMatchObject({ workspaceViews: false });
  });

  it('notes and workspaceViews report false under CEZ_SINGLE_PROJECT=1 regardless of their own flag', () => {
    expect(
      resolveCapabilities({
        CEZ_SINGLE_PROJECT: '1',
        CEZ_NOTES: '1',
        CEZ_WORKSPACE_VIEWS: '1',
      }),
    ).toMatchObject({ singleProject: true, notes: false, workspaceViews: false });
    // And with the flag UNSET, which is now the common case — the default-on flip must not sneak
    // cross-project boards into a single-project cockpit that has nothing to aggregate.
    expect(resolveCapabilities({ CEZ_SINGLE_PROJECT: '1' })).toMatchObject({ workspaceViews: false });
  });

  it('knowledge, sources and notify are independent of singleProject', () => {
    expect(
      resolveCapabilities({
        CEZ_SINGLE_PROJECT: '1',
        CEZ_KB: '1',
        CEZ_SOURCES: '1',
        CEZ_NOTIFY: '1',
      }),
    ).toMatchObject({ singleProject: true, knowledge: true, sources: true, notify: true });
  });
});

describe('resolveCapabilities — singleProject', () => {
  it('is off by default', () => {
    expect(resolveCapabilities({}).singleProject).toBe(false);
  });

  it('is on with CEZ_SINGLE_PROJECT=1', () => {
    expect(resolveCapabilities({ CEZ_SINGLE_PROJECT: '1' }).singleProject).toBe(true);
  });

  it.each(['0', 'true', 'yes', '', 'on'])(
    'stays off for CEZ_SINGLE_PROJECT=%j — only an exact "1" opts in',
    (value) => {
      expect(resolveCapabilities({ CEZ_SINGLE_PROJECT: value }).singleProject).toBe(false);
    },
  );
});

describe('resolveCapabilities — automations (#801)', () => {
  it('is OFF by default — GitHub automations are opt-in', () => {
    expect(resolveCapabilities({}).automations).toBe(false);
  });

  it('is on with CEZ_AUTOMATIONS=1', () => {
    expect(resolveCapabilities({ CEZ_AUTOMATIONS: '1' }).automations).toBe(true);
  });

  it.each(['0', 'true', 'yes', '', 'on'])(
    'stays off for CEZ_AUTOMATIONS=%j — only an exact "1" opts in',
    (value) => {
      expect(resolveCapabilities({ CEZ_AUTOMATIONS: value }).automations).toBe(false);
    },
  );

  // The three opt-in capabilities are independent switches; turning one on must never
  // imply another, or a user enabling automations would silently get the inbox too.
  it('does not turn on any other opt-in capability', () => {
    expect(resolveCapabilities({ CEZ_AUTOMATIONS: '1' })).toMatchObject({
      automations: true,
      followups: false,
      singleProject: false,
    });
  });
});

describe('resolveCapabilities — usage presentation', () => {
  it('shows token usage and cost by default', () => {
    expect(resolveCapabilities({})).toMatchObject({
      tokenMetrics: true,
      tokenUsageMetrics: true,
      costMetrics: true,
    });
  });

  it.each([
    [{ CEZ_HIDE_TOKEN_METRICS: '1' }, false, false, false],
    [{ CEZ_HIDE_TOKEN_USAGE: '1' }, false, false, true],
    [{ CEZ_HIDE_COST: '1' }, false, true, false],
    [{ CEZ_HIDE_TOKEN_USAGE: '1', CEZ_HIDE_COST: '1' }, false, false, false],
    [{ CEZ_HIDE_TOKEN_METRICS: '1', CEZ_HIDE_TOKEN_USAGE: '0', CEZ_HIDE_COST: '0' }, false, false, false],
  ] as const)(
    'resolves strict visibility for %o',
    (env, tokenMetrics, tokenUsageMetrics, costMetrics) => {
      expect(resolveCapabilities(env)).toMatchObject({ tokenMetrics, tokenUsageMetrics, costMetrics });
    },
  );

  it.each(['0', 'true', 'yes', '', 'on'])(
    'stays visible for CEZ_HIDE_TOKEN_METRICS=%j — only an exact "1" opts out',
    (value) => {
      expect(resolveCapabilities({
        CEZ_HIDE_TOKEN_METRICS: value,
        CEZ_HIDE_TOKEN_USAGE: value,
        CEZ_HIDE_COST: value,
      })).toMatchObject({ tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true });
    },
  );

  it('does not change telemetry visibility when another deployment capability is enabled', () => {
    expect(resolveCapabilities({ CEZ_REMOTE: '1', CEZ_FOLLOWUPS: '1' })).toMatchObject({
      tokenMetrics: true,
      tokenUsageMetrics: true,
      costMetrics: true,
    });
  });
});
