import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import { profileEnv } from './agent-profiles.ts';
import {
  CodexAppServerRpc,
  endCodexAppServer,
  resolveCodexExecutable,
  spawnCodexAppServer,
  type CodexAppServerMessage,
} from './codex-app-server-transport.ts';
import { readNdjson } from './ndjson.ts';
import { defaultRunProviderCommand, type RunProviderCommand } from './provider-auth.ts';
import type { AccountQuota, QuotaWindow } from '../workspace/agent-account-usage.ts';

/**
 * Asking each agent CLI what it will say about one account (spec
 * `2026-08-16-agent-account-usage-routing.md`).
 *
 * ## The asymmetry this module exists to expose rather than hide
 *
 * The two providers do not answer the same question, and no amount of shaping makes them:
 *
 * - **Codex** reports true remaining allowance. Its app-server — the protocol cezar already
 *   speaks for runs and model discovery — answers `account/rateLimits` with per-window
 *   `used_percent`, a window length and a reset time, plus the plan. That is a fact about how
 *   much is left.
 * - **Claude** reports none. `claude auth status --json` returns
 *   `{loggedIn, authMethod, email, orgName, subscriptionType}` and nothing about usage; there is
 *   no other subcommand, and nothing on disk (`~/.claude/stats-cache.json` is Claude Code's own
 *   lazily-computed *spend* cache, per config dir, and `usage-data/` is a stale HTML report). The
 *   number its `/usage` screen shows comes from `/api/oauth/usage`, reachable only with the
 *   account's OAuth token out of the macOS Keychain.
 *
 * So `probeClaudeAccount` returns an identity and **no quota**, permanently, and the return types
 * differ on purpose. A shared `AccountProbe { usedPercent: number }` would have forced a number
 * into the Claude branch, and the only numbers available there are spend — which is not allowance,
 * and would have been drawn as a bar beside a Codex bar that means something else entirely.
 *
 * ## Rules every probe here keeps
 *
 * - **Never throws into a caller.** A probe failure is a missing fact, not an error state: the
 *   panel loses a row's detail and routing falls back to signals cezar owns. Modelled on
 *   `core/codex-model-catalog.ts`, whose child/timeout/EOF handling this reuses verbatim.
 * - **Never invents.** A field that is absent or unparseable drops the window; it never
 *   contributes a zero. Zero is a claim ("nothing used"), and it is the wrong one.
 * - **One account per call**, pinned by `profileEnv()`, which is the only thing standing between a
 *   probe and the wrong login's numbers.
 */

const DEFAULT_PROBE_TIMEOUT_MS = 8_000;
/** Enough for `primary`, `secondary` and any window a future Codex adds; a runaway list is a bug. */
const MAX_QUOTA_WINDOWS = 8;

/**
 * The app-server method. **`/read` is part of the name** — `account/rateLimits` alone is rejected
 * with `unknown variant`, which the app-server helpfully answers with a list of every method it
 * does know. That list is the oracle to re-check this against after a Codex upgrade.
 */
const RATE_LIMITS_METHOD = 'account/rateLimits/read';

/**
 * One rate-limit window, **camelCase — the wire spelling, verified live against codex 0.143.0**.
 *
 * Worth stating because the obvious research path gives the wrong answer. The strings inside the
 * shipped binary are `used_percent` / `window_duration_mins` / `resets_at`, because those are the
 * Rust struct's field names; serde renames them for the JSON the app-server actually speaks. The
 * snake_case spelling IS real — it is what Codex writes into its own session rollout files — but
 * that is a different format with a different consumer, and nothing here ever reads one.
 *
 * The failure mode of getting this wrong is the reason for the fixture test: a parser that matches
 * nothing returns `undefined`, which is indistinguishable from "this provider reports no quota".
 * The panel would simply never draw a bar and would look like it was working.
 */
const rawWindowSchema = z
  .object({
    usedPercent: z.number(),
    windowDurationMins: z.number(),
    resetsAt: z.number(),
  })
  .passthrough();

/** `RateLimitSnapshot`. `secondary` is `null` on a plan with only one window, not absent. */
const rawSnapshotSchema = z
  .object({
    primary: z.unknown().optional(),
    secondary: z.unknown().optional(),
    planType: z.string().nullish(),
  })
  .passthrough();

export interface CodexQuotaProbeOptions {
  /** The account's `CODEX_HOME`, already expanded. Omit for the discovered default account. */
  configDir?: string;
  /** Working directory for the short-lived child. Any readable dir; nothing is written. */
  cwd: string;
  bin?: string;
  timeoutMs?: number;
  spawn?: (bin: string, cwd: string, extraEnv?: Record<string, string>) => ChildProcessWithoutNullStreams;
  now?: () => Date;
}

/**
 * Ask Codex what is left on one account, or `undefined` if it will not say.
 *
 * `undefined` covers every failure — not installed, not logged in, method gone after an update,
 * timeout, malformed answer — and that is deliberate: the caller's handling of "no quota" already
 * has to be correct, because it is Claude's permanent state.
 */
export async function probeCodexQuota(options: CodexQuotaProbeOptions): Promise<AccountQuota | undefined> {
  const now = options.now ?? (() => new Date());
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (options.spawn ?? spawnCodexAppServer)(
      resolveCodexExecutable(options.bin),
      options.cwd,
      profileEnv('codex', options.configDir),
    );
  } catch {
    return undefined;
  }

  const rpc = new CodexAppServerRpc(child);
  const reader = (async () => {
    try {
      for await (const line of readNdjson(child.stdout)) {
        let message: CodexAppServerMessage;
        try {
          message = JSON.parse(line) as CodexAppServerMessage;
        } catch {
          throw new Error('codex rate-limit probe returned malformed NDJSON');
        }
        rpc.dispatchResponse(message);
      }
    } catch (error) {
      rpc.rejectPending(error instanceof Error ? error.message : String(error));
    }
  })();

  const exited = new Promise<never>((_, reject) => {
    const fail = (detail: string) => {
      const error = new Error(detail);
      rpc.rejectPending(error.message);
      reject(error);
    };
    child.once('error', () => fail('codex rate-limit probe child failed'));
    child.once('exit', (code) => fail(`codex rate-limit probe child exited (${code ?? 'unknown'})`));
  });

  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error('codex rate-limit probe timed out');
      rpc.rejectPending(error.message);
      reject(error);
    }, options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
    timeout.unref?.();
  });

  try {
    const raw = await Promise.race([
      (async () => {
        await rpc.initialize();
        return rpc.request(RATE_LIMITS_METHOD, {});
      })(),
      exited,
      deadline,
    ]);
    return parseCodexQuota(raw, now());
  } catch {
    return undefined;
  } finally {
    if (timeout) clearTimeout(timeout);
    endCodexAppServer(child);
    void reader.catch(() => undefined);
  }
}

/**
 * Pull the windows out of whatever `account/rateLimits` answered.
 *
 * Exported for its own tests, because this is the one function whose input is a vendor shape that
 * can change under us — and it is pinned by a fixture captured from the LIVE wire
 * (`__fixtures__/codex/account-rate-limits.json`) rather than one hand-written from what the shape
 * was assumed to be. A hand-written fixture agrees with the parser by construction and would have
 * happily passed against the wrong field names.
 *
 * The snapshot sits at `rateLimits`, with the result itself as a fallback in case a future method
 * answers it directly. `rateLimitsByLimitId` and `rateLimitResetCredits` are deliberately ignored:
 * one snapshot is what a row can honestly show.
 *
 * Returns `undefined` when no window survives parsing. It never returns an empty window list: an
 * empty bar reads as "0% used", which is the most confident possible wrong answer.
 */
export function parseCodexQuota(raw: unknown, takenAt: Date): AccountQuota | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const container = raw as Record<string, unknown>;
  const snapshot = rawSnapshotSchema.safeParse(container.rateLimits ?? container);
  if (!snapshot.success) return undefined;

  const windows: QuotaWindow[] = [];
  for (const candidate of [snapshot.data.primary, snapshot.data.secondary]) {
    if (windows.length >= MAX_QUOTA_WINDOWS) break;
    const window = parseWindow(candidate);
    if (window) windows.push(window);
  }
  if (windows.length === 0) return undefined;

  const quota: AccountQuota = { takenAt: takenAt.toISOString(), windows };
  if (snapshot.data.planType) quota.planType = snapshot.data.planType;
  return quota;
}

/** One window, or nothing. A missing length or reset time drops it — a window that cannot say when
 *  it refills cannot be rendered honestly, and `freshQuota` has nothing to expire it by. A `null`
 *  `secondary` (a plan with one window) lands here and is dropped, which is the correct reading. */
function parseWindow(candidate: unknown): QuotaWindow | undefined {
  const parsed = rawWindowSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  const { usedPercent, windowDurationMins, resetsAt } = parsed.data;
  if (!Number.isFinite(windowDurationMins) || windowDurationMins <= 0) return undefined;
  if (!Number.isFinite(resetsAt) || resetsAt < 0) return undefined;
  if (!Number.isFinite(usedPercent) || usedPercent < 0) return undefined;
  return {
    usedPercent,
    windowMinutes: Math.round(windowDurationMins),
    resetsAt: Math.round(resetsAt),
  };
}

/** What `claude auth status --json` is willing to say about one login. No usage — there is none. */
export interface ClaudeAccountIdentity {
  loggedIn: boolean;
  email?: string;
  /** `subscriptionType` verbatim (`max`, `pro`, …) — a plan NAME, never a quantity. */
  plan?: string;
  orgName?: string;
}

const claudeStatusSchema = z
  .object({
    loggedIn: z.boolean().optional(),
    email: z.string().optional(),
    subscriptionType: z.string().optional(),
    orgName: z.string().optional(),
  })
  .passthrough();

export interface ClaudeIdentityProbeOptions {
  /** The account's `CLAUDE_CONFIG_DIR`, already expanded. Omit for the discovered default. */
  configDir?: string;
  bin?: string;
  timeoutMs?: number;
  run?: RunProviderCommand;
}

/**
 * Ask Claude who one login is. Identity and plan only — see the module note.
 *
 * `undefined` when the CLI is missing, times out, or answers something unparseable.
 * `{loggedIn: false}` is a DIFFERENT answer and is preserved: "signed out" is a fact worth showing
 * on a row, whereas "could not ask" is not.
 */
export async function probeClaudeAccount(
  options: ClaudeIdentityProbeOptions = {},
): Promise<ClaudeAccountIdentity | undefined> {
  const run = options.run ?? defaultRunProviderCommand;
  const bin = options.bin ?? process.env.CEZ_CLAUDE_BIN ?? 'claude';
  let result;
  try {
    result = await run(
      bin,
      ['auth', 'status', '--json'],
      options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      profileEnv('claude', options.configDir),
    );
  } catch {
    return undefined;
  }
  if (result.timedOut || result.errorCode) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
  const status = claudeStatusSchema.safeParse(parsed);
  if (!status.success) return undefined;

  const identity: ClaudeAccountIdentity = { loggedIn: status.data.loggedIn === true };
  if (status.data.email) identity.email = status.data.email;
  if (status.data.subscriptionType) identity.plan = status.data.subscriptionType;
  if (status.data.orgName) identity.orgName = status.data.orgName;
  return identity;
}
