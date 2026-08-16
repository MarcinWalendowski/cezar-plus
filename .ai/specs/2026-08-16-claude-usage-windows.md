# Claude usage windows, from the CLI that already knows them

**Status:** implemented (2026-08-16).

## TLDR

The sidebar draws a real usage bar for Codex and shows the bare word `max` for Claude. That was
built deliberately, on a premise this spec retires: that Claude reports no usage at all and the
honest rendering is absence.

**The premise was wrong, and the owner is the one who spotted it.** `claude -p "/usage"
--output-format json` returns the same subscription windows Claude Code's own `/usage` screen
shows, in the envelope's `result` field. Measured on this machine: **0 tokens, `num_turns: 0`,
`total_cost_usd: 0`, `duration_api_ms: 0`, ~1.3 s wall** with MCP disabled. It needs no credential
handling of any kind — cezar keeps asking a CLI a question, which is exactly what it already does
for `claude auth status --json`.

So Claude accounts get bars, on both surfaces the owner asked for: the sidebar panel and each
Logins card in Settings.

## Problem

Two rows sit side by side in the sidebar. One says `month ▂▂▂▂ 0% 06:16 PM`. The other says `max`.
A user reads that as a broken probe on the Claude row, not as a statement about what Claude
publishes — and they are now right to, because Claude does publish it.

The prior spec (`2026-08-16-agent-account-usage-routing.md`) asserted the opposite in four places
(the spec, `core/agent-account-probe.ts`, `contract/agent-account-usage.ts`,
`components/account-usage-panel.tsx`), each stating that there is *no other subcommand* and
*nothing on disk*. Every one of those is a claim a future session would have trusted instead of
re-measuring. They are corrected in place, per the workspace's rule that a correction marks what it
invalidates rather than only appending the new truth.

## What was measured, and what was rejected

Three candidate sources, all probed live rather than reasoned about:

| Source | Result | Verdict |
|---|---|---|
| `claude -p "/usage" --output-format json` | Works. Session + weekly + per-model windows, 0 tokens, ~1.3 s, per-account via `CLAUDE_CONFIG_DIR`. | **Chosen** |
| `api.anthropic.com/api/oauth/usage` + Keychain token | Works, and is strictly richer: structured JSON, ISO `resets_at`, `extra_usage` credits. Returned `five_hour 29% / seven_day 66%`. | Rejected |
| Local files (`~/.claude/stats-cache.json`, `usage-data/`) | Neither carries allowance. `stats-cache.json` is message/session/tool counts and was 2 days stale; `usage-data/` is an HTML report from June. | Dead end |

**The OAuth endpoint was rejected on purpose, and not because it is worse.** It requires reading
the account's OAuth access token out of the macOS Keychain
(`Claude Code-credentials`, and `Claude Code-credentials-<sha256(configDir)[0:8]>` for a
non-default config dir — verified against `~/.claude-bis`). That makes cezar a process that handles
the owner's subscription credentials in order to draw a progress bar. The CLI path buys the same
number for the same money without ever touching one, so the credential-handling design has no
remaining justification. It stays out, and this table is here so the next session does not
rediscover the endpoint and assume nobody looked.

**The two sources disagree about the session window**, measured within the same minute: the API
said `five_hour: 29%`, the CLI said `Current session: 0% used`. Not reconciled, and deliberately
not averaged or cross-checked. The property cezar holds is **parity with `/usage`** — the cockpit
shows the number the user sees when they type `/usage` themselves. A cockpit that disagreed with
the tool it drives would be the worse failure, whichever number is "truer".

## Solution

### The parse target

Verbatim from the live fixture (`__fixtures__/claude/usage-print.json`):

```
Current session: 0% used · resets Aug 17 at 12am (Europe/Warsaw)
Current week (all models): 66% used · resets Aug 20 at 1am (Europe/Warsaw)
Current week (Fable): 13% used · resets Aug 20 at 1am (Europe/Warsaw)
```

and from the second account (`usage-print-idle.json`), the case a fixture written by hand would
never have contained:

```
Current session: 0% used
Current week (all models): 9% used · resets Aug 19 at 10:59am (Europe/Warsaw)
Current week (Fable): 0% used
```

**A window at 0% omits the reset clause entirely.** A parser that requires ` · resets …` drops
exactly the windows that are most reassuring to see, and drops them silently.

### Three decisions the shape forces

1. **`resetsAt` becomes optional, and `resetsText` carries Claude's string verbatim.** Claude
   states a *localized human* reset ("Aug 20 at 1am (Europe/Warsaw)") — no year, 12-hour clock, a
   named zone. Converting that to an epoch means inferring a year and re-deriving a timezone, and
   the failure mode is a confidently wrong timestamp. Passing the string through has no failure
   mode: it is already in the user's own zone, because the CLI rendered it there.

   `freshQuota` therefore drops a window only when `resetsAt` is **present and passed**. Codex's
   rollover behaviour is byte-identical to before; Claude windows are bounded by the age check
   alone, which is what a 5-minute TTL is for.

2. **`windowMinutes` becomes optional and `label` is carried instead.** "Current session" does not
   state its length. Claude's session window is documented as 5 hours, and writing `300` here would
   still be cezar inventing a number the provider did not say — the exact habit the previous spec
   built this whole module to avoid. `label` also solves a problem `windowMinutes` cannot:
   **"week (all models)" and "week (Fable)" share a length**, so a UI keyed on minutes renders two
   different windows identically and a React key built from it collides.

3. **`usedPercent` stays required.** It is the one thing Claude always states, and it is the only
   field whose absence should drop a window.

### Probe

`probeClaudeUsage()` sits beside `probeClaudeAccount()` and obeys the module's existing rules —
never throws, never invents, one account per call pinned by `profileEnv()`. It runs:

```
claude -p /usage --output-format json --strict-mcp-config --mcp-config {"mcpServers":{}}
```

- `--strict-mcp-config` with an empty server map is a **3.2× speedup, measured** (4.2 s → 1.3 s):
  without it the child boots every MCP server in the user's config to answer a question that needs
  none of them.
- `--bare` looks like the right flag here and **must not be used**: it explicitly never reads OAuth
  or the keychain, so the account has no subscription to report on and the probe returns nothing.
- The child runs in a neutral cwd, never a project root, so a trust prompt cannot block it.

`parseClaudeUsage(text, takenAt)` is exported for its own tests, matching `parseCodexQuota`'s
precedent: it is the one function whose input is a vendor format that can change under us.

## Data models

```ts
// contract/src/agent-account-usage.ts, mirrored in workspace/agent-account-usage.ts
accountQuotaWindowSchema = {
  usedPercent: number,             // required — the only field a provider always states
  label?: string,                  // 'session' | 'week' | 'week (Fable)' — Claude
  windowMinutes?: number,          // Codex
  resetsAt?: number,               // UNIX seconds — Codex
  resetsText?: string,             // 'Aug 20 at 1am (Europe/Warsaw)' — Claude, verbatim
}
```

## API contracts

`GET /api/v1/workspace/agent-accounts/usage` — unchanged route, unchanged flag
(`CEZ_ACCOUNT_USAGE=1`, still AND-ed with `localHandoff`), unchanged flag-off shape. A Claude row
may now carry `quota`. `windowMinutes` and `resetsAt` are no longer guaranteed on a window;
`BACKWARD_COMPATIBILITY.md` records this, since it narrows what a consumer may assume.

## Phases

1. Window shape widened in the store and the contract; `freshQuota` updated.
2. `probeClaudeUsage` + `parseClaudeUsage`, pinned by the two captured fixtures.
3. Route: Claude profiles join the quota probe; `needsRefresh` counts quota staleness for Claude,
   not just identity TTL — without this the panel probes identity forever and never usage.
4. Sidebar renders the widened window; Settings → Logins renders the same bars per account.
5. The four false claims corrected in place.

### The bars shipped invisible, and the suite could not see it — added 2026-08-16

Every guard in this spec was green and the sidebar was, in fact, drawing nothing. The fill was
`bg-accent` on a `bg-muted` track, and in `styles/index.css` **`--accent` is a shadcn alias for
`--muted`** — a surface token, not the brand accent (that is `--primary`). Fill and track were the
same colour, so `session 3%`, `week 66%` and `week (Fable) 13%` all rendered as one flat grey line.
Only the `>= 90` danger branch was ever a different colour, and no account had been there, so the
bug had no witness. It predates this spec — it came in with the Codex bars — and this spec doubled
the number of rows painting it.

Three things worth carrying forward, because the shape recurs:

- **The percentage was right everywhere it was checked.** `data-percent`, the number beside the
  bar, the API response and the CLI all agreed. Runtime step 3 of the Verification below says "the
  sidebar draws three bars per Claude row, labelled …" — and it does; a zero-width-looking bar is
  still a bar element with the right label. The step verified structure and read as verifying the
  render.
- **A "fill class ≠ track class" assertion would not have caught it.** `bg-accent` and `bg-muted`
  are different strings resolving to the same colour, and jsdom loads no stylesheet to tell them
  apart. The guard that does work checks the fill against an **allowlist of ink tokens**
  (`bg-success` / `bg-pending` / `bg-danger`), which puts the shipped bug on the wrong side of it.
- **`bg-pending` is the sanctioned amber.** The design guardian bans `text-pending` for a contrast
  reason that does not apply to a fill, so grading the bar needed no new token and no raw hex.

Fixed by making the colour carry the reading rather than the width alone: `< 75%` emerald,
`75–89%` amber, `>= 90%` red, on a track one step taller (`h-1` → `h-1.5`) so a sliver of fill has
a shape. Clamping is untouched — the **bar** clamps to 0–100, the **number** does not, so an
overage still reads `104%` beside a full red bar.

## Risks

- **The text format is not a contract.** A Claude Code release can reword it. Mitigation: the
  parser returns `undefined` for anything it does not recognise, which the whole family already
  treats as "this provider said nothing" — the bar disappears, no wrong number is ever drawn. The
  fixtures are captured from the live CLI, never hand-written, so they cannot agree with the parser
  by construction.
- **A distractor line lives in the same text.** `59% of your usage came from subagent-heavy
  sessions` is a percentage in the same blob. A regex anchored on `%` rather than on
  `Current <label>: <n>% used` would harvest it as a window. This is a negative control in the
  suite, not a comment.
- **Wall-clock.** ~1.3 s per Claude account, off the response path (the route answers from the
  stored snapshot and refreshes behind a process-wide latch), so a polled panel still cannot spawn
  a child per poll.
- **`/usage` is a local command.** It does not consume tokens today. If a future release makes it a
  model turn, the cost becomes one turn per account per 5 minutes. `total_cost_usd` is in the
  envelope we already parse, so this is detectable rather than silent.

## Verification

Every guard names the mutation that must turn it red.

| Guard | File | Mutation that must fail it |
|---|---|---|
| The live fixture parses to 3 windows with the right percentages | `core/agent-account-probe.test.ts` | Anchor the regex on `%` alone — the contributing lines get harvested |
| A 0% window with **no** reset clause still parses | same (idle fixture) | Require ` · resets` — the idle account loses every window |
| `resetsText` is passed through verbatim, never converted | same | Parse it into an epoch |
| A window with no parseable percentage is dropped, not zeroed | same | Default `usedPercent` to 0 |
| Unrecognised text yields `undefined`, not an empty window list | same | Return `{windows: []}` — the UI draws an empty gauge reading as 0% |
| `freshQuota` keeps a Claude window with no `resetsAt` | `workspace/agent-account-usage.test.ts` | Restore the unconditional `resetsAt * 1000 > now` filter |
| `freshQuota` still drops a rolled-over **Codex** window | same | Skip the filter when `resetsAt` is present |
| A Claude row carries `quota` end to end | `server/agent-account-usage-api.test.ts` | Leave Claude out of the probe list |
| `needsRefresh` fires for a Claude account with a stale quota but fresh identity | same | Keep the identity-only branch |
| The panel labels a window by `label` before `windowMinutes` | `components/account-usage-panel.test.tsx` | Prefer `windowMinutes` — both weekly windows render as `week` |
| The Logins card shows bars for that account only | `routes/settings/accounts-section.test.tsx` | Drop the id filter — every card shows every account's usage |

**Runtime E2E (the gate on done).** Gates green is not sufficient; the previous round's bugs were
both found by running the thing. **All five steps executed 2026-08-16 against the rebuilt binary
and the real CLIs on this machine — passed.**

1. ✅ Rebuilt, restarted the cockpit with `CEZ_ACCOUNT_USAGE=1` on `localhost:4321`, v0.10.0.
2. ✅ `GET /api/v1/workspace/agent-accounts/usage` carries `quota.windows` for **both** Claude
   accounts, with different percentages — proving `CLAUDE_CONFIG_DIR` pinning works and one
   account's numbers are not being drawn on the other's row:

   ```
   claude | Default            session  3%  Aug 17 at 12am   week 66%  week (Fable) 13%
   claude | owner session  0%  (no reset)       week  9%  week (Fable)  0%
   codex  | Default            43200m   0%  2026-09-15T17:23:41Z
   ```

   The second row is the load-bearing one: its two 0% windows carry **no reset at all** and
   survived the whole path — probe, store, `freshQuota`, response — which is the filter bug this
   spec spends a decision on.
3. ✅ The sidebar draws three bars per Claude row, labelled `session` / `week` / `week (Fa…)`. The
   per-model label truncates in a 220px sidebar, so it carries a `title`; the identifying part is
   exactly what gets cut.
4. ✅ Parity: the same numbers `claude -p "/usage"` prints by hand for each config dir (66% / 9%
   weekly).
5. ✅ Settings → Logins → Show details renders the same bars under a **Usage** heading on the
   opened card, and only there — the second card, closed, shows none.

## Not in this spec

- The OAuth usage endpoint (see the rejection above), and with it `extra_usage` credit balances,
  which only that source carries.
- ~~Routing on Claude allowance. The balancer's inputs are unchanged; `quota` is displayed, not yet
  consulted. Turning a parsed percentage into a routing decision deserves its own measurement of
  how the two windows interact.~~ **DONE 2026-08-16, same day** — see
  `2026-08-16-agent-account-usage-routing.md` → Solution C, where the 95% ceiling is superseded by
  a usage band. The measurement this deferred for is the one that settled it: the two windows
  interact through the **max**, and it is the 5h session window climbing fast under a burst that
  makes the band hand work back without a second mechanism.
- Any change to the `CEZ_ACCOUNT_USAGE` gate or its hosted-mode withholding.
