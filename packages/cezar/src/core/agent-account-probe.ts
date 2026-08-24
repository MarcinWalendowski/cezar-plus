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
 * - **Claude** reports allowance too, but from a different surface and in a different shape:
 *   `claude -p "/usage" --output-format json` puts the same text its `/usage` screen shows into the
 *   envelope's `result` field — a percentage and a *localized human* reset string per window, with
 *   no machine timestamp and no window length. Identity stays where it was, in
 *   `claude auth status --json`.
 *
 * So the two probes still return different types on purpose, and a window still carries only what
 * its provider actually said (`workspace/agent-account-usage.ts` documents which field belongs to
 * whom). A shared `AccountProbe { usedPercent: number, resetsAt: number }` would force one of them
 * to invent half its answer.
 *
 * **CORRECTED 2026-08-16 by `2026-08-16-claude-usage-windows.md`.** This block used to read
 * "**Claude** reports none … there is no other subcommand, and nothing on disk … The number its
 * `/usage` screen shows comes from `/api/oauth/usage`, reachable only with the account's OAuth
 * token out of the macOS Keychain." Two halves of that were checked and one was not:
 * `claude auth status --json` and the files under `~/.claude` really do carry no allowance
 * (`stats-cache.json` is a lazily-computed *spend* cache per config dir; `usage-data/` is a stale
 * HTML report), and the OAuth endpoint really does work — it was probed, and returned
 * `five_hour 29% / seven_day 66%`. But "no other subcommand" was never tested against `-p` with a
 * slash command, and that is where the answer was. The Keychain path is rejected rather than
 * pending: it would make cezar handle the owner's subscription credentials to draw a bar it can
 * get for free.
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
    const window = parseWindow(candidate, takenAt.getTime());
    if (window) windows.push(window);
  }
  if (windows.length === 0) return undefined;

  const quota: AccountQuota = { takenAt: takenAt.toISOString(), windows };
  if (snapshot.data.planType) quota.planType = snapshot.data.planType;
  return quota;
}

/** One window, or nothing. A missing length or reset time drops it — a window that cannot say when
 *  it refills cannot be rendered honestly, and `freshQuota` has nothing to expire it by. A `null`
 *  `secondary` (a plan with one window) lands here and is dropped, which is the correct reading.
 *
 *  `takenAtMs` is here only for `looksUnpopulated` below, which needs to know when the answer was
 *  asked for in order to recognize one that was computed rather than measured. */
function parseWindow(candidate: unknown, takenAtMs: number): QuotaWindow | undefined {
  const parsed = rawWindowSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  const { usedPercent, windowDurationMins, resetsAt } = parsed.data;
  if (!Number.isFinite(windowDurationMins) || windowDurationMins <= 0) return undefined;
  if (!Number.isFinite(resetsAt) || resetsAt < 0) return undefined;
  if (!Number.isFinite(usedPercent) || usedPercent < 0) return undefined;
  if (looksUnpopulated({ usedPercent, windowDurationMins, resetsAt }, takenAtMs)) return undefined;
  return {
    usedPercent,
    windowMinutes: Math.round(windowDurationMins),
    resetsAt: Math.round(resetsAt),
  };
}

/**
 * How close `resetsAt` may sit to "a whole window from now" and still be believed. Wide enough to
 * absorb the app-server's startup and the RPC round trip, far narrower than any real window.
 */
const UNPOPULATED_RESET_EPSILON_S = 120;

/**
 * Is this window the app-server's EMPTY DEFAULT rather than a measurement
 * (`.ai/specs/2026-08-24-second-codex-account-balancing.md`, D1)?
 *
 * ## What was measured
 *
 * `account/rateLimits/read` on `prod-host`, twice, 21 s apart on 2026-08-24:
 *
 * ```
 * 11:39:15.981Z  {"usedPercent":0,"windowMinutes":10080,"resetsAt":1788176355}
 * 11:39:37.257Z  {"usedPercent":0,"windowMinutes":10080,"resetsAt":1788176377}
 * ```
 *
 * `resetsAt` advanced by exactly the gap between the calls: it is `now + windowDurationMins`,
 * recomputed per call. The account it describes was `limited` at the time, five days into a weekly
 * refusal. Nothing there is a fact about usage — the app-server had no snapshot and answered with
 * a fresh, full window. The session rollout captured from a live request at the same time carried
 * `{"limit_id":"premium","primary":null,"secondary":null}`.
 *
 * ## CORRECTED 2026-08-24, hours later — this is a COLD-SNAPSHOT state, not the plan's behaviour
 *
 * The paragraph above used to end: *"on ChatGPT Plus the windows that matter are `null` and the
 * allowance is announced only in the refusal text."* **That is false**, and it is left struck
 * rather than deleted because it is the reason this function exists and a reader needs to know how
 * far it actually reaches. Measured on the same box the same afternoon, four probes over three
 * minutes, on both accounts:
 *
 * ```
 * .codex            plus  usedPercent 1 → 2 → 4 → 5   resetsAt 1788179533/4  (moved 1s in 180s)
 * .codex-secondary  pro   usedPercent 0               resetsAt 1788179610    (identical, 180s)
 * ```
 *
 * `limitId` was `codex`, not `premium`; `usedPercent` tracked real consumption on the account that
 * was being used; and `resetsAt` was **anchored** — unchanged while `takenAt` advanced by 180 s.
 * That is a genuine measurement, and codex reports one on Plus as well as on Pro.
 *
 * So the empty default is what the app-server answers when it holds **no snapshot yet**, not what a
 * tier permanently answers. It is still worth dropping — a cold answer entering the pool as band 0
 * is the exact failure this was built for — but it is a transient state, and any claim that codex
 * "cannot report quota" is wrong. The discriminator below is unchanged by this, because it never
 * keyed on the plan: it keys on ROLLING vs ANCHORED, which is precisely what separates the two
 * measurements above.
 *
 * ## Why this must be dropped rather than stored
 *
 * The module's own rule, three doc comments above this one: *"Never invents. A field that is absent
 * or unparseable drops the window; it never contributes a zero. Zero is a claim ('nothing used'),
 * and it is the wrong one."* Storing it broke that rule in the most expensive direction —
 * `usageBand` reads `floor(0/10) = 0`, the BEST band, so a codex account that could not run at all
 * presented to the pool as the least-used login on the machine.
 *
 * ## Why the shape is enough, without a second probe
 *
 * A real window is `windowStart + duration`, where `windowStart` is the first request inside it, so
 * it coincides with `now + duration` only in the instant a window opens — and in that instant
 * something has just been spent, so `usedPercent` is no longer 0. Both conditions at once are the
 * unpopulated default. Probing twice and comparing would be the direct test, but it costs a second
 * CLI child on every refresh round to learn what one response already says.
 *
 * ## The cost of being wrong
 *
 * A real window that opened within the last `UNPOPULATED_RESET_EPSILON_S` and has been used 0% is
 * dropped. `selectPoolAccount` then ranks that account on in-flight and dispatch order rather than
 * on its band — one dispatch's worth of fairness, for at most two minutes out of a seven-day
 * window, after which the anchored `resetsAt` drifts out of the epsilon on its own. Observed
 * live: `.codex-secondary` at `usedPercent: 0` was dropped 84 s after its window opened and kept
 * 264 s after, with no change to the account.
 *
 * **Amended 2026-08-24 with the correction above.** This paragraph used to read *"a genuinely idle
 * account reads as unmeasured for as long as it stays idle"*, which assumed `resetsAt` rolls; it is
 * anchored, so an idle account is unmeasured only just after its window opens, not indefinitely.
 *
 * The opposite error puts every run on a login that is out of quota.
 */
function looksUnpopulated(
  window: { usedPercent: number; windowDurationMins: number; resetsAt: number },
  takenAtMs: number,
): boolean {
  if (window.usedPercent !== 0) return false;
  const openedNow = takenAtMs / 1000 + window.windowDurationMins * 60;
  return Math.abs(window.resetsAt - openedNow) <= UNPOPULATED_RESET_EPSILON_S;
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

/**
 * The arguments that make `/usage` cheap and unblockable. Each one is here for a measured reason:
 *
 * - `-p` + `--output-format json` runs the slash command locally and hands back an envelope. It
 *   costs **nothing**: the captured fixtures carry `num_turns: 0`, `total_cost_usd: 0` and
 *   `duration_api_ms: 0`. `/usage` is rendered by the CLI, not by a model.
 * - `--strict-mcp-config` with an empty server map is a **3.2× speedup, measured** (4.2 s → 1.3 s).
 *   Without it the child boots every MCP server in the user's config before answering a question
 *   that needs none of them, and this probe runs once per account.
 * - **`--bare` is deliberately absent.** It is the obvious flag for "minimal, fast, no side
 *   effects", and it would break this outright: it never reads OAuth or the keychain, so the child
 *   has no subscription to report on and the answer comes back empty.
 *
 * A trust prompt is not a hazard here, measured against a brand-new `git init` directory the CLI
 * had never seen: `-p` has no TTY, so it answers in ~2 s rather than blocking. The child therefore
 * inherits the server's cwd like every other probe, and needs no cwd plumbing.
 */
const CLAUDE_USAGE_ARGS = [
  '-p',
  '/usage',
  '--output-format',
  'json',
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
] as const;

/**
 * One `Current …: N% used[ · resets …]` line.
 *
 * **Anchored on `Current` and on the literal word `used`, and both anchors are load-bearing.** The
 * same blob carries a "What's contributing to your limits usage?" section full of lines like
 * `59% of your usage came from subagent-heavy sessions` — percentages that are not windows. A
 * pattern that merely hunts for `(\d+)%` harvests those as rate-limit windows, and the panel then
 * shows six bars, four of which are behavioural statistics. That is a negative control in the
 * suite, not a hypothetical.
 */
const CLAUDE_USAGE_LINE = /^Current\s+(.+?):\s*(\d+(?:\.\d+)?)\s*%\s*used\b(.*)$/;

/** The reset clause, which is ABSENT on a window sitting at 0% — verified against a real second
 *  account, whose idle windows render as a bare `Current session: 0% used`. A parser that requires
 *  this clause drops exactly the windows a user is most reassured to see. */
const CLAUDE_RESET_CLAUSE = /resets\s+(\S.*?)\s*$/;

export interface ClaudeUsageProbeOptions {
  /** The account's `CLAUDE_CONFIG_DIR`, already expanded. Omit for the discovered default. */
  configDir?: string;
  bin?: string;
  timeoutMs?: number;
  run?: RunProviderCommand;
  now?: () => Date;
}

/**
 * Ask Claude what is left on one account, or `undefined` if it will not say.
 *
 * `undefined` covers every failure — not installed, not signed in, a reworded `/usage`, a timeout,
 * a malformed envelope — and the caller's handling of it is already correct, because "no quota" has
 * always been a state this panel had to render.
 */
export async function probeClaudeUsage(options: ClaudeUsageProbeOptions = {}): Promise<AccountQuota | undefined> {
  const run = options.run ?? defaultRunProviderCommand;
  const bin = options.bin ?? process.env.CEZ_CLAUDE_BIN ?? 'claude';
  const now = options.now ?? (() => new Date());
  let result;
  try {
    result = await run(
      bin,
      CLAUDE_USAGE_ARGS,
      options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      profileEnv('claude', options.configDir),
    );
  } catch {
    return undefined;
  }
  if (result.timedOut || result.errorCode) return undefined;

  let envelope: unknown;
  try {
    envelope = JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
  return parseClaudeUsage(envelope, now());
}

/**
 * Pull the windows out of a `claude -p "/usage" --output-format json` envelope.
 *
 * Exported for its own tests for `parseCodexQuota`'s reason: its input is a vendor format that can
 * change under us, and it is pinned by fixtures **captured from the live CLI**
 * (`__fixtures__/claude/usage-print.json` and `…-idle.json`) rather than hand-written. A
 * hand-written fixture agrees with the parser by construction — and would never have contained the
 * idle account's missing reset clause, which is the case that actually breaks a naive parser.
 *
 * Returns `undefined` when nothing parses, never an empty window list: an empty list renders as a
 * gauge with no bars, which reads as "0% used" — the most confident possible wrong answer.
 */
export function parseClaudeUsage(envelope: unknown, takenAt: Date): AccountQuota | undefined {
  const text = claudeUsageText(envelope);
  if (!text) return undefined;

  const windows: QuotaWindow[] = [];
  for (const line of text.split('\n')) {
    if (windows.length >= MAX_QUOTA_WINDOWS) break;
    const window = parseClaudeUsageLine(line.trim());
    if (window) windows.push(window);
  }
  if (windows.length === 0) return undefined;
  return { takenAt: takenAt.toISOString(), windows };
}

/** The envelope's `result`, or the text itself if a caller already unwrapped it. `is_error` is
 *  honoured: an errored turn's `result` is a message about the failure, not a usage report. */
function claudeUsageText(envelope: unknown): string | undefined {
  if (typeof envelope === 'string') return envelope;
  if (!envelope || typeof envelope !== 'object') return undefined;
  const record = envelope as Record<string, unknown>;
  if (record.is_error === true) return undefined;
  return typeof record.result === 'string' ? record.result : undefined;
}

/**
 * One line to one window, or nothing.
 *
 * The label is Claude's own, minus the `(all models)` qualifier — that parenthetical distinguishes
 * the weekly window from a per-model one (`week (Fable)`), and once the model-specific window
 * carries its own name the qualifier is noise in a column two words wide. The distinction survives;
 * only the wording is shortened.
 */
function parseClaudeUsageLine(line: string): QuotaWindow | undefined {
  const matched = CLAUDE_USAGE_LINE.exec(line);
  if (!matched) return undefined;
  const usedPercent = Number(matched[2]);
  if (!Number.isFinite(usedPercent) || usedPercent < 0) return undefined;

  const label = (matched[1] ?? '').replace(/\s*\(all models\)\s*/i, '').trim();
  const window: QuotaWindow = { usedPercent };
  if (label) window.label = label;
  const reset = CLAUDE_RESET_CLAUSE.exec(matched[3] ?? '');
  // Verbatim, never parsed into a timestamp — see the field's doc in `agent-account-usage.ts`.
  if (reset?.[1]) window.resetsText = reset[1];
  return window;
}
