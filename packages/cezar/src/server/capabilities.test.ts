import { describe, expect, it } from 'vitest';
import { isLoopbackHost, isLoopbackHostHeader, normalizeHostname, resolveCapabilities } from './capabilities.ts';

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

  it('is independent of the deployment mode', () => {
    expect(resolveCapabilities({ CEZ_FOLLOWUPS: '1', CEZ_REMOTE: '1' }, '0.0.0.0')).toEqual({
      localHandoff: false,
      followups: true,
      singleProject: false,
      tokenMetrics: true,
      tokenUsageMetrics: true,
      costMetrics: true,
      knowledge: false,
      sources: false,
      notes: false,
      workspaceViews: false,
      notify: false,
      // Opt-OUT, so it is `true` in an env that sets nothing. This `toEqual` is the exhaustive
      // one — it is what forces every new capability to be declared here rather than added
      // silently, and it is why the polarity of a new key cannot slip through unnoticed.
      skills: true,
    });
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
  it('are all off by default', () => {
    expect(resolveCapabilities({})).toMatchObject({
      knowledge: false,
      sources: false,
      notes: false,
      workspaceViews: false,
      notify: false,
    });
  });

  it('turn on independently with their own exact-"1" flag', () => {
    expect(resolveCapabilities({ CEZ_KB: '1' })).toMatchObject({ knowledge: true, sources: false });
    expect(resolveCapabilities({ CEZ_SOURCES: '1' })).toMatchObject({ knowledge: false, sources: true });
    expect(resolveCapabilities({ CEZ_NOTES: '1' })).toMatchObject({ notes: true });
    expect(resolveCapabilities({ CEZ_WORKSPACE_VIEWS: '1' })).toMatchObject({ workspaceViews: true });
    expect(resolveCapabilities({ CEZ_NOTIFY: '1' })).toMatchObject({ notify: true });
  });

  it.each(['0', 'true', 'yes', '', 'on'])('stays off for %j — only an exact "1" opts in', (value) => {
    expect(
      resolveCapabilities({
        CEZ_KB: value,
        CEZ_SOURCES: value,
        CEZ_NOTES: value,
        CEZ_WORKSPACE_VIEWS: value,
        CEZ_NOTIFY: value,
      }),
    ).toMatchObject({
      knowledge: false,
      sources: false,
      notes: false,
      workspaceViews: false,
      notify: false,
    });
  });

  it('notes and workspaceViews report false under CEZ_SINGLE_PROJECT=1 regardless of their own flag', () => {
    expect(
      resolveCapabilities({
        CEZ_SINGLE_PROJECT: '1',
        CEZ_NOTES: '1',
        CEZ_WORKSPACE_VIEWS: '1',
      }),
    ).toMatchObject({ singleProject: true, notes: false, workspaceViews: false });
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
