import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  parseCodexQuota,
  probeClaudeAccount,
  probeCodexQuota,
  type ClaudeAccountIdentity,
} from './agent-account-probe.ts';
import type { ProviderCommandResult } from './provider-auth.ts';

/**
 * Account probes (spec `2026-08-16-agent-account-usage-routing.md`).
 *
 * The load-bearing tests here are the ones asserting that something is ABSENT: a window with no
 * reset time contributes nothing rather than a zero, and the Claude probe carries no usage number
 * at all. Both failures would render as a confident, wrong bar.
 */

const TAKEN_AT = new Date('2026-08-16T12:00:00.000Z');

function fakeChild(responses: unknown[] = []): {
  child: ChildProcessWithoutNullStreams;
  requests: Array<Record<string, unknown>>;
} {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const requests: Array<Record<string, unknown>> = [];
  const queued = [...responses];
  let input = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk: string) => {
    input += chunk;
    let newline: number;
    while ((newline = input.indexOf('\n')) >= 0) {
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (!line) continue;
      requests.push(JSON.parse(line) as Record<string, unknown>);
      const response = queued.shift();
      if (response !== undefined) queueMicrotask(() => stdout.write(`${JSON.stringify(response)}\n`));
    }
  });
  Object.assign(emitter, { stdin, stdout, stderr, exitCode: null, killed: false, kill: () => true, pid: 321 });
  return { child: emitter as unknown as ChildProcessWithoutNullStreams, requests };
}

/** `initialize` reply, then the throwaway slot the `initialized` notify consumes, then the answer. */
function appServerScript(rateLimitsResult: unknown): unknown[] {
  return [{ id: 1, result: {} }, {}, { id: 2, result: rateLimitsResult }];
}

const WINDOW = { usedPercent: 43, windowDurationMins: 300, resetsAt: 1_783_682_746 };

/** Captured from a live `codex app-server` on 0.143.0 — see the fixture-parses test below. */
const liveResponse = JSON.parse(
  readFileSync(fileURLToPath(new URL('__fixtures__/codex/account-rate-limits.json', import.meta.url)), 'utf8'),
) as unknown;

describe('parseCodexQuota', () => {
  it('parses the response captured from a live codex app-server', () => {
    // THE test in this file. Every other case here is hand-written, and a hand-written fixture
    // agrees with the parser by construction — this one does not.
    //
    // It exists because the first version of this parser read `used_percent` / `window_duration_mins`,
    // which are the field names in the shipped binary's strings (the Rust struct), while the wire
    // is camelCase. Nothing failed: the parser matched nothing, returned `undefined`, and that is
    // exactly what "this provider reports no quota" looks like. The bar would simply never have
    // appeared, and the feature would have looked finished.
    const quota = parseCodexQuota(liveResponse, TAKEN_AT);
    expect(quota).toBeDefined();
    expect(quota?.planType).toBe('free');
    expect(quota?.windows).toHaveLength(1);
    expect(quota?.windows[0]).toEqual({ usedPercent: 0, windowMinutes: 43_200, resetsAt: 1_789_482_577 });
  });

  it('reads the snapshot out of `rateLimits`', () => {
    const quota = parseCodexQuota({ rateLimits: { primary: WINDOW, planType: 'pro' } }, TAKEN_AT);
    expect(quota).toEqual({
      takenAt: TAKEN_AT.toISOString(),
      planType: 'pro',
      windows: [{ usedPercent: 43, windowMinutes: 300, resetsAt: 1_783_682_746 }],
    });
  });

  it('also accepts a snapshot answered at the root', () => {
    // The method could plausibly return the snapshot directly on a future Codex; one `??` survives it.
    expect(parseCodexQuota({ primary: WINDOW }, TAKEN_AT)?.windows).toHaveLength(1);
  });

  it('keeps both windows in primary-then-secondary order', () => {
    const quota = parseCodexQuota(
      { rateLimits: { primary: WINDOW, secondary: { ...WINDOW, usedPercent: 7, windowDurationMins: 10_080 } } },
      TAKEN_AT,
    );
    expect(quota?.windows.map((w) => w.windowMinutes)).toEqual([300, 10_080]);
  });

  it('drops a null `secondary` — a plan with one window, not a malformed one', () => {
    const quota = parseCodexQuota({ rateLimits: { primary: WINDOW, secondary: null } }, TAKEN_AT);
    expect(quota?.windows).toHaveLength(1);
  });

  it('ignores the snake_case spelling, which belongs to a different format', () => {
    // Codex writes snake_case into its own session ROLLOUT files. That is not this wire, and
    // nothing here ever reads one — so accepting it would be a branch no input can reach, and a
    // future reader would take it as evidence the wire might be snake_case.
    expect(
      parseCodexQuota({ rate_limits: { primary: { used_percent: 43, window_duration_mins: 300, resets_at: 1 } } }, TAKEN_AT),
    ).toBeUndefined();
  });

  it('drops a window with no reset time instead of contributing a zero', () => {
    // A window that cannot say when it refills cannot be expired by `freshQuota`, so it would sit
    // on screen forever. Zero would be a claim, and the wrong one.
    expect(parseCodexQuota({ rateLimits: { primary: { usedPercent: 43, windowDurationMins: 300 } } }, TAKEN_AT)).toBeUndefined();
  });

  it('drops a window with no percentage', () => {
    expect(parseCodexQuota({ rateLimits: { primary: { windowDurationMins: 300, resetsAt: 1 } } }, TAKEN_AT)).toBeUndefined();
  });

  it('drops a window whose percentage is not a number', () => {
    expect(
      parseCodexQuota({ rateLimits: { primary: { usedPercent: 'lots', windowDurationMins: 300, resetsAt: 1 } } }, TAKEN_AT),
    ).toBeUndefined();
  });

  it('keeps a genuine zero, which is a real reading and not a missing one', () => {
    const quota = parseCodexQuota({ rateLimits: { primary: { ...WINDOW, usedPercent: 0 } } }, TAKEN_AT);
    expect(quota?.windows[0]?.usedPercent).toBe(0);
  });

  it('returns undefined rather than an empty window list', () => {
    // An empty list renders as a bar with nothing in it, which reads as "0% used".
    expect(parseCodexQuota({ rateLimits: { planType: 'pro' } }, TAKEN_AT)).toBeUndefined();
    expect(parseCodexQuota({}, TAKEN_AT)).toBeUndefined();
    expect(parseCodexQuota(null, TAKEN_AT)).toBeUndefined();
    expect(parseCodexQuota('nope', TAKEN_AT)).toBeUndefined();
  });

  it('keeps the good window when only one of the two is malformed', () => {
    const quota = parseCodexQuota({ rateLimits: { primary: { usedPercent: 1 }, secondary: WINDOW } }, TAKEN_AT);
    expect(quota?.windows).toEqual([{ usedPercent: 43, windowMinutes: 300, resetsAt: 1_783_682_746 }]);
  });

  it('omits planType when the provider did not state one', () => {
    expect(parseCodexQuota({ rateLimits: { primary: WINDOW } }, TAKEN_AT)).not.toHaveProperty('planType');
  });
});

describe('probeCodexQuota', () => {
  it('asks `account/rateLimits/read` after initialising, and returns the parsed quota', async () => {
    // `/read` is part of the name. `account/rateLimits` is rejected as an unknown variant — and
    // the app-server answers that rejection with a list of every method it knows, which is the
    // oracle to re-check this against after a Codex upgrade.
    const fake = fakeChild(appServerScript({ rateLimits: { primary: WINDOW, planType: 'pro' } }));
    const quota = await probeCodexQuota({
      cwd: '/repo',
      spawn: () => fake.child,
      now: () => TAKEN_AT,
    });
    expect(quota?.planType).toBe('pro');
    expect(fake.requests.map((r) => r.method)).toEqual(['initialize', 'initialized', 'account/rateLimits/read']);
  });

  it('pins the probe to one account’s config dir', async () => {
    // The only thing standing between a probe and the wrong login's numbers.
    let seen: Record<string, string> | undefined;
    const fake = fakeChild(appServerScript({ rateLimits: { primary: WINDOW } }));
    await probeCodexQuota({
      cwd: '/repo',
      configDir: '/Users/me/.codex-work',
      spawn: (_bin, _cwd, extraEnv) => {
        seen = extraEnv;
        return fake.child;
      },
    });
    expect(seen).toEqual({ CODEX_HOME: '/Users/me/.codex-work' });
  });

  it('adds nothing to the environment for the discovered default account', async () => {
    let seen: Record<string, string> | undefined = { sentinel: 'unset' };
    const fake = fakeChild(appServerScript({ rateLimits: { primary: WINDOW } }));
    await probeCodexQuota({ cwd: '/repo', spawn: (_b, _c, extraEnv) => ((seen = extraEnv), fake.child) });
    expect(seen).toEqual({});
  });

  it('returns undefined when the CLI cannot be spawned', async () => {
    await expect(
      probeCodexQuota({
        cwd: '/repo',
        spawn: () => {
          throw new Error('ENOENT');
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when the method is gone after a Codex update', async () => {
    const fake = fakeChild([{ id: 1, result: {} }, {}, { id: 2, error: { message: 'unknown method' } }]);
    await expect(probeCodexQuota({ cwd: '/repo', spawn: () => fake.child })).resolves.toBeUndefined();
  });

  it('returns undefined rather than hanging when the server never answers', async () => {
    const fake = fakeChild([]);
    await expect(probeCodexQuota({ cwd: '/repo', timeoutMs: 20, spawn: () => fake.child })).resolves.toBeUndefined();
  });
});

describe('probeClaudeAccount', () => {
  const ok = (stdout: string): ProviderCommandResult => ({ stdout, stderr: '', exitCode: 0 });

  it('reads identity and plan', async () => {
    const identity = await probeClaudeAccount({
      run: async () =>
        ok(JSON.stringify({ loggedIn: true, email: 'me@example.com', subscriptionType: 'max', orgName: 'Mine' })),
    });
    expect(identity).toEqual({ loggedIn: true, email: 'me@example.com', plan: 'max', orgName: 'Mine' });
  });

  it('carries no usage number, because Claude reports none', () => {
    // The negative control for the whole honesty argument. `claude auth status --json` answers
    // `{loggedIn, authMethod, email, orgId, orgName, subscriptionType}` and nothing else — so if a
    // numeric field ever appears on this type, someone has synthesized allowance from spend and it
    // will be drawn as a bar beside Codex's real one.
    const identity: ClaudeAccountIdentity = { loggedIn: true, plan: 'max' };
    const numeric = Object.values(identity).filter((value) => typeof value === 'number');
    expect(numeric).toEqual([]);
    expect(identity).not.toHaveProperty('usedPercent');
    expect(identity).not.toHaveProperty('quota');
  });

  it('distinguishes “signed out” from “could not ask”', async () => {
    // Signed out is a fact worth showing on a row; unreachable is not.
    await expect(probeClaudeAccount({ run: async () => ok(JSON.stringify({ loggedIn: false })) })).resolves.toEqual({
      loggedIn: false,
    });
    await expect(
      probeClaudeAccount({ run: async () => ({ stdout: '', stderr: '', exitCode: null, errorCode: 'ENOENT' }) }),
    ).resolves.toBeUndefined();
  });

  it('pins the probe to one account’s config dir', async () => {
    let seen: Record<string, string> | undefined;
    await probeClaudeAccount({
      configDir: '/Users/me/.claude-work',
      run: async (_bin, _args, _timeout, env) => {
        seen = env;
        return ok(JSON.stringify({ loggedIn: true }));
      },
    });
    expect(seen).toEqual({ CLAUDE_CONFIG_DIR: '/Users/me/.claude-work' });
  });

  it('asks the documented subcommand', async () => {
    let args: readonly string[] = [];
    await probeClaudeAccount({
      run: async (_bin, called) => {
        args = called;
        return ok(JSON.stringify({ loggedIn: true }));
      },
    });
    expect(args).toEqual(['auth', 'status', '--json']);
  });

  it('returns undefined on unparseable output or a timeout', async () => {
    await expect(probeClaudeAccount({ run: async () => ok('not json') })).resolves.toBeUndefined();
    await expect(
      probeClaudeAccount({ run: async () => ({ stdout: '', stderr: '', exitCode: null, timedOut: true }) }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when the runner itself throws', async () => {
    await expect(
      probeClaudeAccount({
        run: async () => {
          throw new Error('spawn failed');
        },
      }),
    ).resolves.toBeUndefined();
  });
});
