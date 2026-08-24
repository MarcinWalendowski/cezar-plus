import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  parseClaudeUsage,
  parseCodexQuota,
  probeClaudeAccount,
  probeClaudeUsage,
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

/**
 * Captured from `codex app-server` 0.147.0 on `prod-host`, 2026-08-24T11:40:19Z, against a
 * ChatGPT Plus account that was rate-limited at that moment — the app-server's EMPTY DEFAULT.
 *
 * Its `resetsAt` is `_capturedAt + windowDurationMins*60` to the second, which is why the takenAt
 * below is the capture instant and not a round number: this fixture only means what it means when
 * it is parsed as of when it was taken.
 */
const liveUnpopulatedResponse = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('__fixtures__/codex/account-rate-limits-unpopulated.json', import.meta.url)),
    'utf8',
  ),
) as unknown;
const UNPOPULATED_TAKEN_AT = new Date(1_787_571_619 * 1000);

/**
 * Captured from a live `claude -p "/usage" --output-format json` on 2.1.224 — TWO accounts, and
 * the second is not redundant. The default account's windows all carry a reset clause; the idle
 * account's 0% windows omit it entirely, which is the case a hand-written fixture would never have
 * contained and the one that breaks a parser requiring `· resets`.
 */
const liveClaudeUsage = JSON.parse(
  readFileSync(fileURLToPath(new URL('__fixtures__/claude/usage-print.json', import.meta.url)), 'utf8'),
) as unknown;
const liveClaudeUsageIdle = JSON.parse(
  readFileSync(fileURLToPath(new URL('__fixtures__/claude/usage-print-idle.json', import.meta.url)), 'utf8'),
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

  describe('the app-server\'s empty default is not a measurement (spec 2026-08-24, D1)', () => {
    it('drops the live unpopulated window rather than storing 0%', () => {
      // THE test for D1, and like its sibling above it runs on bytes off the wire rather than on a
      // shape this parser was written against.
      expect(parseCodexQuota(liveUnpopulatedResponse, UNPOPULATED_TAKEN_AT)).toBeUndefined();
    });

    it('keeps the same window once anything has been spent in it', () => {
      // Negative control #1. Without it, the assertion above passes against a parser that returns
      // `undefined` for every input — which is exactly what the ORIGINAL codex parser bug looked
      // like, and it shipped.
      const spent = structuredClone(liveUnpopulatedResponse) as { rateLimits: { primary: { usedPercent: number } } };
      spent.rateLimits.primary.usedPercent = 12;
      expect(parseCodexQuota(spent, UNPOPULATED_TAKEN_AT)?.windows).toEqual([
        { usedPercent: 12, windowMinutes: 10_080, resetsAt: 1_788_176_419 },
      ]);
    });

    it('keeps a 0% window whose reset is not a whole window away', () => {
      // Negative control #2, and the one that pins the rule to the SHAPE rather than to `usedPercent
      // === 0`. A window ten minutes into its life, still unspent, is a real reading.
      const started = structuredClone(liveUnpopulatedResponse) as { rateLimits: { primary: { resetsAt: number } } };
      started.rateLimits.primary.resetsAt -= 600;
      expect(parseCodexQuota(started, UNPOPULATED_TAKEN_AT)?.windows).toHaveLength(1);
    });

    it('allows the RPC round trip — a few seconds of skew still reads as unpopulated', () => {
      // The epsilon is not decoration: `takenAt` is stamped after the child has spawned, initialized
      // and answered, so the server's `now + duration` is always a little behind ours. Measured at
      // ~0.3 s on the box; the bound is 120 s, and this asserts the tolerance exists in the right
      // direction rather than trusting the constant.
      expect(
        parseCodexQuota(liveUnpopulatedResponse, new Date(UNPOPULATED_TAKEN_AT.getTime() + 90_000)),
      ).toBeUndefined();
    });

    it('reads the 0.143.0 fixture as unpopulated too, at ITS capture instant', () => {
      // The older fixture is the same empty default — `resetsAt - windowDurationMins*60` puts its
      // capture at 2026-08-16T14:29:37Z, and the test above it passes only because `TAKEN_AT` is a
      // rounded 12:00 that day. Stated here so the two tests cannot be read as disagreeing: one
      // pins the WIRE SPELLING (which is why it must keep parsing to a window), this one pins what
      // the bytes actually meant.
      expect(parseCodexQuota(liveResponse, new Date(1_786_890_577 * 1000))).toBeUndefined();
    });
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

  it('carries no usage number — identity and allowance are separate probes', () => {
    // The negative control for the whole honesty argument, and it still holds after Claude gained
    // real windows (2026-08-16): allowance arrives from `probeClaudeUsage`, and `auth status --json`
    // answers `{loggedIn, authMethod, email, orgId, orgName, subscriptionType}` and nothing else. If
    // a numeric field ever appears on THIS type, someone has synthesized allowance from spend on the
    // identity path, and it will be drawn as a bar beside a real one.
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

describe('parseClaudeUsage', () => {
  it('parses the envelope captured from a live `claude -p "/usage"`', () => {
    // THE test in this file for Claude, and the counterpart of the codex fixture test above: every
    // other case here is hand-written, and a hand-written fixture agrees with the parser by
    // construction. This one was captured from the CLI on 2.1.224.
    const quota = parseClaudeUsage(liveClaudeUsage, TAKEN_AT);
    expect(quota?.windows).toEqual([
      { usedPercent: 0, label: 'session', resetsText: 'Aug 17 at 12am (Europe/Warsaw)' },
      { usedPercent: 66, label: 'week', resetsText: 'Aug 20 at 1am (Europe/Warsaw)' },
      { usedPercent: 13, label: 'week (Fable)', resetsText: 'Aug 20 at 1am (Europe/Warsaw)' },
    ]);
    expect(quota?.takenAt).toBe(TAKEN_AT.toISOString());
  });

  it('ignores the “what’s contributing” percentages in the same blob', () => {
    // The negative control. That section carries lines like "59% of your usage came from
    // subagent-heavy sessions" — real percentages that are NOT rate-limit windows. A pattern that
    // hunts for `(\d+)%` instead of `Current <label>: <n>% used` harvests them, and the panel then
    // draws six bars, half of them behavioural statistics presented as allowance.
    const quota = parseClaudeUsage(liveClaudeUsage, TAKEN_AT);
    expect(quota?.windows).toHaveLength(3);
    expect(quota?.windows.map((window) => window.usedPercent)).not.toContain(59);
    expect(quota?.windows.map((window) => window.usedPercent)).not.toContain(82);
  });

  it('keeps a 0% window that states no reset at all', () => {
    // Captured from the SECOND account, and the reason two fixtures exist. An idle window renders
    // as a bare `Current session: 0% used` with no ` · resets …` clause, so a parser that requires
    // the clause silently drops exactly the windows a user is most reassured to see — and the row
    // then looks like a provider that reports nothing.
    const quota = parseClaudeUsage(liveClaudeUsageIdle, TAKEN_AT);
    expect(quota?.windows).toEqual([
      { usedPercent: 0, label: 'session' },
      { usedPercent: 9, label: 'week', resetsText: 'Aug 19 at 10:59am (Europe/Warsaw)' },
      { usedPercent: 0, label: 'week (Fable)' },
    ]);
  });

  it('never converts the reset string into a timestamp', () => {
    // "Aug 20 at 1am (Europe/Warsaw)" has no year and a 12-hour clock. Converting it means guessing
    // both, and the failure mode is a confidently wrong reset time rather than a missing one.
    const quota = parseClaudeUsage(liveClaudeUsage, TAKEN_AT);
    for (const window of quota?.windows ?? []) {
      expect(window).not.toHaveProperty('resetsAt');
      expect(window).not.toHaveProperty('windowMinutes');
    }
  });

  it('returns undefined rather than an empty window list', () => {
    // An empty list renders as a gauge with no bars, which reads as "0% used" — the most confident
    // possible wrong answer. Absence has to stay absence all the way out of the parser.
    expect(parseClaudeUsage({ result: 'You are currently using your subscription' }, TAKEN_AT)).toBeUndefined();
    expect(parseClaudeUsage({ result: '' }, TAKEN_AT)).toBeUndefined();
    expect(parseClaudeUsage({}, TAKEN_AT)).toBeUndefined();
    expect(parseClaudeUsage(null, TAKEN_AT)).toBeUndefined();
  });

  it('refuses an errored turn, whose `result` is a failure message rather than a report', () => {
    expect(
      parseClaudeUsage({ is_error: true, result: 'Current session: 40% used' }, TAKEN_AT),
    ).toBeUndefined();
  });

  it('drops a line whose percentage is not a number, rather than reading it as zero', () => {
    expect(parseClaudeUsage({ result: 'Current session: lots% used' }, TAKEN_AT)).toBeUndefined();
  });

  it('caps a runaway list', () => {
    const many = Array.from({ length: 40 }, (_, i) => `Current w${i}: ${i}% used`).join('\n');
    expect(parseClaudeUsage({ result: many }, TAKEN_AT)?.windows.length).toBeLessThanOrEqual(8);
  });
});

describe('probeClaudeUsage', () => {
  const ok = (stdout: string): ProviderCommandResult => ({ stdout, stderr: '', exitCode: 0 });

  it('asks for the slash command in print mode, with MCP servers switched off', async () => {
    let args: readonly string[] = [];
    await probeClaudeUsage({
      run: async (_bin, called) => {
        args = called;
        return ok(JSON.stringify(liveClaudeUsage));
      },
    });
    expect(args).toEqual(['-p', '/usage', '--output-format', 'json', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']);
    // `--bare` is the flag that looks right here and breaks it: it never reads OAuth or the
    // keychain, so the child has no subscription to report on and the answer comes back empty.
    expect(args).not.toContain('--bare');
  });

  it('pins the probe to one account’s config dir', async () => {
    // Without this, two logins on one machine both report the default account's numbers, and the
    // panel draws one subscription's usage on two rows that look independent.
    let seen: Record<string, string> | undefined;
    await probeClaudeUsage({
      configDir: '/Users/me/.claude-work',
      run: async (_bin, _args, _timeout, env) => {
        seen = env;
        return ok(JSON.stringify(liveClaudeUsage));
      },
    });
    expect(seen).toEqual({ CLAUDE_CONFIG_DIR: '/Users/me/.claude-work' });
  });

  it('returns undefined on a timeout, an unparseable envelope, or a throwing runner', async () => {
    await expect(
      probeClaudeUsage({ run: async () => ({ stdout: '', stderr: '', exitCode: null, timedOut: true }) }),
    ).resolves.toBeUndefined();
    await expect(probeClaudeUsage({ run: async () => ok('not json') })).resolves.toBeUndefined();
    await expect(
      probeClaudeUsage({
        run: async () => {
          throw new Error('spawn failed');
        },
      }),
    ).resolves.toBeUndefined();
  });
});
