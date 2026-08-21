# Edit an existing file; never re-emit it

> **Status: IMPLEMENTED and SHIPPED — commit `76c8de0c` on `cez/f272fda8`, 2026-08-21.**
> `FILE_WRITE_RECIPE` (`packages/cezar/src/workflows/types.ts:500`) ships in the `spec`,
> `implement` and `document` steps of `spec-to-deploy`; `spec` also gained `'Edit'` in its
> `allowedTools`. The five new `StepStats` fields (`toolInputChars`, `heredocChars`,
> `heredocFileWrites`, `heredocRewrites`, `heredocRewriteWasteChars`) ship in `runs/stats.ts` and
> are tested (`stats.test.ts`). `AGENTS.md` § "Changing part of a file that already exists" carries
> the doctrine for future sessions. Todo `8ef45202-f29f-4dde-995b-1df150936940` is closed done.
> **What is NOT yet verified: acceptance criterion 3** ("tool-call input characters in `implement`
> drop by >= 40%") is empirical and this run implemented the change without itself running
> end-to-end under the new prompt — see § "What I could not verify" → *"Whether the override
> actually wins"*. Tracked as follow-up todo `e91ba865-eb2a-4935-aebc-c7c0e6eb491d`, filed because
> the closest precedent (the round-trip-batching prompt, `.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md`)
> shipped, read correct in review, and then moved its measured number by nothing (batch factor
> 1.00 → 1.02) — a prompt instruction looking right is not evidence it changes behaviour under
> bypass-permissions mode, which actively steers the opposite way. · **Date:** 2026-08-21
>
> **Origin:** todo `8ef45202-f29f-4dde-995b-1df150936940` (high, started → done) — *"Every file
> write in a run is a Bash heredoc, so whole files are re-emitted as output tokens"* — measured on
> run `70f19253-cf6b-407c-92e0-96a8020a8ebb`.
>
> This spec changes **agent-facing prompt text, one `allowedTools` entry, and four derived
> metrics**. It changes no route, no stored schema and no run protocol.
>
> **Revision 2 — 2026-08-21, after review (`CEZ:REVIEW=revise`).** The review verified the
> diagnosis, the mechanism and the "criterion 3 is unreachable" call, and rejected the numbers.
> It was right. Every figure in this spec has been **re-measured against the implementation the
> spec itself prescribes** — `stripHeredocs()` as it actually ships, and `JSON.stringify`
> semantics — rather than against the ad-hoc one-liner that produced the task statement. Four
> things changed, and all four are recorded in place rather than silently corrected:
>
> 1. **The serialization was wrong, and the review did not catch this one.** `83,628` is *not*
>    `JSON.stringify(input).length`. It is Python `json.dumps` with **default separators**
>    (`", "` / `": "`) and `ensure_ascii=True`. A TypeScript meter cannot produce it. The real
>    `JSON.stringify` figures are **82,716** for `implement` and **459,056** for the run. Every
>    baseline in this spec is now stated in the serialization the shipped meter will actually
>    compute. § Risks R9 carries the reconciliation.
> 2. **`heredocChars` is now the honest `stripHeredocs()` delta** — 239,216 of 459,056 (52.1%),
>    not 274,926 of 465,531 (59.1%). § Data models states the blind spot and, having measured it,
>    argues for keeping `stripHeredocs()` exactly as it is.
> 3. **The file-authoring predicate was broken and its baselines were wrong.** It could never
>    match `tee`. Rewritten and re-measured: `heredocFileWrites` = **13** run-wide (not 2),
>    `heredocRewrites` = **2** (not 1). § Data models.
> 4. **`toolInputChars`' scope is now stated** — all of a step's tool calls, children included,
>    the same scope as `toolCalls`. § Data models says why, and what the other choice would give.
>
> The design — one shared constant on the `RECORD_READ_RECIPE` pattern, meter before optimisation,
> `'Edit'` added to `types.ts:622`, `TOOL_BUDGET_DOCTRINE` untouched — is unchanged. This revision
> is numbers and one predicate.

> ### ⚠️ Read this before the rest: the task's headline target is not reachable, and this spec says why
>
> The task's acceptance criterion 3 asks for a **≥ 40% drop in `implement`'s tool-call input
> characters**, on the premise that "every file change re-emits the file body". I re-measured the
> transcript rather than trusting the premise, and **the premise is false for `implement`.**
>
> `implement`'s 13 heredoc calls are not whole-file rewrites. They are `python3 - <<'PYEOF'`
> scripts doing `s.replace(old, new)` — **hand-rolled `Edit`s**. 53,193 of their 62,276 heredoc-body
> characters are triple-quoted literal payload that a real `Edit` has to emit too, and the `old`
> anchors are already short (6,697 chars against 30,979 of `new`). Converting all 31 of their
> `s.replace()` calls to `Edit`s moves the step from 82,716 to ≈ 77,353 characters: **6.5%, not
> 40%.** Criterion 3 as written cannot be met by this change, by any agent, on this baseline.
> § Problem shows the arithmetic; § Open questions Q3 proposes the replacement criteria.
>
> **And converting them may cost more wall clock than it saves**, which is the sharper reason not
> to point the rule at this idiom. 13 Bash calls become up to 31 `Edit` calls. If each extra round
> trip costs the ~6 s `TOOL_BUDGET_DOCTRINE` itself budgets (`run.ts:540`), +18 round trips is
> ≈ 108 s against ≈ 5,363 saved characters — under any plausible emission rate, a net loss unless
> the edits ride in **one turn**. So the recipe explicitly tells the agent to emit several `Edit`s
> as parallel calls in a single turn, and § Analytics does not ask `implement`'s character count
> to fall much at all. R10 carries this.
>
> The defect the task describes **is real**, and it is real in the `spec` step, which the task's
> own criteria list first: `spec` wrote the *same file* through `cat > … <<'SPECEOF'` **twice**
> (34,845 chars of body, then 48,618) and spent **1,463 s of model time against 21 s of tool execution**
> doing it.
>
> But that instance is not free money either, and this spec measures it rather than assuming it.
> The second write changed **81 separate hunks** and grew the document by 14 KB; at realistic
> anchor sizes an `Edit`-shaped second pass costs **more** than the rewrite did. The part that is
> unambiguously wasted is the **20,550 characters of unchanged lines the second body carried**
> (42% of it). Run-wide, re-emission wasted **21,934 characters of 459,056 — 4.8%**. That is the
> real size of this defect on this run, and § Analytics states targets against it rather than
> against the task's ≥ 40%.

---

## TLDR

Across run `70f19253`, **239,216 of 459,056 tool-call input characters (52.1%) are heredoc
bodies**, and the run made **zero `Edit` and zero `Write` calls** in 360 tool calls. The
instruction that produces this is not cezar's — it ships inside the Claude Code binary and fires
because cezar sets `--permission-mode bypassPermissions` unconditionally
(`packages/cezar/src/core/claude-cli-runner.ts:702`). cezar cannot suppress it. The only lever is
**later, more specific text in the step prompt**.

So: add one shared prompt constant, `FILE_WRITE_RECIPE`, to the three write-heavy steps of
`spec-to-deploy` (`spec`, `implement`, `document`) that overrides the Bash-first preference **for
file mutation only** — editor tool for a change to an existing file, write tool for a new file,
heredoc kept for genuinely scripted multi-file transforms — and says *why*, in terms the record
supports. Add `'Edit'` to the `spec` step's grant, which omits it today
(`packages/cezar/src/workflows/types.ts:622`). Ship a meter first
(`toolInputChars` / `heredocChars` / `heredocFileWrites` / `heredocRewrites` on `StepStats`) so the
claim is falsifiable, because `cez run stats` has **no size metric at all** today.

The honest expected win: **the re-emission class of write disappears.** That class costs the size
of the *file* rather than the size of the *change*, so it is unbounded and it is the only part of
this worth chasing. `implement`'s hand-rolled-`Edit` heredocs are a *different* class and are
roughly a wash — ≈ 6.5% of characters, against up to 18 extra round trips. **Not 40%, and the
spec does not pretend otherwise.**

---

## Problem

### What produces the behaviour, and why cezar cannot turn it off

The brief located the instruction in the installed CLI binary rather than anywhere in this repo —
grepping the worktree for `dedicated Read, Edit` returns nothing in cezar source, specs or docs. It
is injected as an `isMeta` conversation message whenever bypass mode is on:

> Do your work through the Bash tool wherever it can accomplish the job: read files with cat, head,
> or sed -n, search with grep and find, and **make file changes with sed, heredocs, or short
> scripts, rather than using the dedicated Read, Edit, or Write tools.** Fall back to a dedicated
> tool only when Bash genuinely cannot do the job.

cezar takes that branch unconditionally — `claude-cli-runner.ts:702` pushes `'bypassPermissions'`
with no env read, and `claude-cli-runner.test.ts` pins it. The switch was thrown by
`.ai/specs/2026-08-15-bypass-permissions-claude-sessions.md`, whose stated scope is "one function,
one call site" and which **never mentions Read, Edit, Write, `sed`, heredocs or tool preference at
all**. The Bash-first preference arrived as an unnoticed side effect.

**The grant is not the cause, and "add `Edit` to `allowedTools`" is the obvious wrong fix.**
`claude-cli-runner.ts:679-685` records the measurement: `--allowedTools` "only *grants* tools
additively — it does not restrict… so `buildAllowedTools` and a step's
`allowedTools`/`bashAllowlist` are decorative on a Claude run today." `Edit` was reachable for the
whole run. Two sibling runs under the identical config did reach for it (`c10864d1`: 4 `Edit`;
`7c2dd8f0`: 9 `Edit` + 23 `Write`), which settles availability independently.

The one positional advantage cezar has: the step prompt becomes the **user message**
(`run.ts:4300`, `applyTemplate(step.prompt ?? '{{task}}', input.task)`), which lands later in the
transcript than the CLI's `isMeta` reminder.

### What I measured myself (2026-08-21, this session)

Counted with `python3` over
`/var/lib/cezar/loki-labs/cezar/.ai/cezar/runs/70f19253-cf6b-407c-92e0-96a8020a8ebb.ndjson`
(5,155,182 B). `tool-call` events carry the full untruncated `input` object, so these are direct
counts. `jq` is not installed on this box.

**Tool distribution — the brief's correction to the task statement reproduces exactly:**

| step | calls | Bash | other |
| --- | ---: | ---: | --- |
| context | 106 | 74 | Read 16 · Grep 13 · Agent 3 |
| spec | 44 | 43 | ToolSearch 1 |
| review-spec | 33 | 33 | — |
| implement | 52 | 52 | — |
| run-tests | 37 | 36 | ToolSearch 1 |
| commit-push | 12 | 12 | — |
| document | 28 | 28 | — |
| deploy | 48 | 48 | — |
| **total** | **360** | **326** | **`Edit` 0 · `Write` 0** |

The task's "311 of 311" does not reproduce under any decomposition. **Restate it as: 252 of 254
tool calls outside `context` were Bash (99.2%), 326 of 360 overall, and zero `Edit` / zero `Write`
anywhere in the run.** The "zero Edit, zero Write" half is exactly right and is the load-bearing
half.

#### First, the serialization — because the task's own baseline number is not reproducible in TypeScript

The task names **83,628** as `implement`'s tool-call input characters. Four plausible encodings of
the same 52 `input` objects give four different answers:

| encoding | `implement` | note |
| --- | ---: | --- |
| `json.dumps(input)` — Python **default separators** (`", "` / `": "`), `ensure_ascii=True` | **83,628** | the task's figure |
| `json.dumps(input, separators=(',',':'))`, `ensure_ascii=True` | 83,456 | |
| `json.dumps(input, separators=(',',':'), ensure_ascii=False)` — **`JSON.stringify` semantics** | **82,716** | **what this spec adopts** |
| `json.dumps(input, ensure_ascii=False)` | 82,888 | |

**83,628 carries Python's default `", "`/`": "` separators and its `\uXXXX` escaping of non-ASCII.
`JSON.stringify` does neither.** A meter written in TypeScript cannot produce it. Revision 1 of
this spec asserted that the two "agree on this input"; they do not, and a `cez run stats` built to
hit 83,628 would have failed its own acceptance test on day one.

So **every baseline below is `JSON.stringify(input).length`**, the quantity `runs/stats.ts` will
actually compute. Against the task's numbers this is uniformly ≈ 1.1–1.4% lower; nothing in the
argument moves, but the figures a test asserts do.

**Heredoc share of tool-call input, per step.** `chars` = Σ `JSON.stringify(input).length` over
**every** tool call attributed to the step, sub-agent calls included (§ Data models states that
scope choice). `heredoc chars` = the `stripHeredocs()` delta, i.e. the metric exactly as
§ Data models prescribes it, not a looser hand parse. `fw` / `rw` = file-authoring heredocs and
re-emissions among them, under the corrected predicate in § Data models.

| step | calls | chars | heredoc calls | heredoc chars | heredoc % | fw | rw |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| context | 106 | 58,332 | 3 | 21,692 | 37.2% | 2 | 0 |
| **spec** | 44 | **141,813** | 5 | **92,284** | **65.1%** | **2** | **1** |
| review-spec | 33 | 31,119 | 4 | 7,650 | 24.6% | 3 | 0 |
| **implement** | 52 | **82,716** | 13 | **62,276** | **75.3%** | 2 | 0 |
| run-tests | 37 | 31,809 | 3 | 5,721 | 18.0% | 1 | 0 |
| commit-push | 12 | 12,395 | 2 | 6,347 | 51.2% | 0 | 0 |
| document | 28 | 41,500 | 10 | 24,228 | 58.4% | 0 | 0 |
| deploy | 48 | 59,372 | 7 | 19,018 | 32.0% | **3** | **1** |
| **TOTAL** | **360** | **459,056** | **47** | **239,216** | **52.1%** | **13** | **2** |

Restricting to a step's **own** calls (dropping the 93 sub-agent calls, all of them `context`'s)
moves only that row and the total: `context` 36,930, TOTAL 437,654. Every other row is unchanged,
because no other step dispatched.

The `≥ 40%` threshold the task names for `implement` is ≤ 33,086 characters against 82,716.
§ The correction shows why no tool choice reaches it.

### The correction that reshapes the whole design

**`implement` never wrote a whole file.** Its 13 heredocs are, without exception, `python3 -
<<'PYEOF'` scripts of this shape (verbatim, from the 9,230-char call):

```
set +e
cd …/worktrees/70f19253-…
python3 - <<'PYEOF'
import io
p = 'packages/cezar/src/runs/stats.ts'
s = io.open(p, encoding='utf-8').read()
old = """…"""
new = """…"""
assert s.count(old) == 1, '…'
s = s.replace(old, new)
```

That is an `Edit`, written out longhand. Decomposing the 13 calls' **62,276 heredoc-body
characters**:

| | chars | share of the 62,276 |
| --- | ---: | ---: |
| triple-quoted literal payload (all `x = """…"""` assignments) | 53,193 | 85.4% |
| python/shell boilerplate, `cd`, `set +e`, asserts, escaping | 9,083 | 14.6% |
| — of which `old`-named literals | 6,697 | |
| — of which `new`-named literals | 30,979 | |
| — of which other named literals (`block`, `insert`, `rev3`, `entry`, `anchor`) | 15,517 | |

The 13 calls carry **31** `s.replace(old, new)` invocations. An idealised conversion — one `Edit`
per `replace`, at ~120 chars of call envelope each — gives
`20,440 + 53,193 + 3,720 = 77,353` chars against 82,716: **a 6.5% drop**. Allowing generously for
escaping inflation inside those literals (python source escaping `\\n`/`\'`, then JSON escaping
again) the realistic ceiling is still only **~8–15%**.

The reason is structural, not a modelling artefact: **`new` is 30,979 of the 53,193 literal
characters, and new content is irreducible.** Whatever tool writes it, the model emits it once. The
only bytes an `Edit` saves against a python-`replace` heredoc are the boilerplate and the
double-escaping.

**And the conversion is not free on the other axis.** Those 13 Bash calls hold 31 `replace`s, so
an `Edit`-per-`replace` conversion turns 13 round trips into as many as 31 — **+18**. The one
round-trip price on record is `TOOL_BUDGET_DOCTRINE`'s own framing (`run.ts:540`): "spend a tool
call as if it costs six seconds, because it does", derived from a measured cezar run that spent 23
of 61 minutes on 231 sub-second calls. +18 round trips is therefore ≈ 108 s, against ≈ 5,363
characters saved. **On this idiom the two effects are the same order of magnitude, and the sign
depends on batching.** Hence two consequences, both carried through the rest of this spec:

1. The recipe tells the agent that **several edits to one file go out as parallel `Edit` calls in
   a single turn** — which is not a new rule, it is `TOOL_BUDGET_DOCTRINE` bullet 2 applied here.
2. § Analytics asks `implement`'s **mechanism** to change (heredoc share down) and asks its
   character count for only a token improvement. Anyone judging this by `implement`'s character
   count alone will mis-read it. R10.

### Where the money actually is: the `spec` step

`spec` wrote `.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md` through `cat >
<path> <<'SPECEOF'` **twice** — 34,845 chars of body, then 48,618, in one step. The first is a new
file and correctly exempt. The second re-emits every unchanged line of the first, and that is the
defect this spec is named for.

**Revision 1 of this spec got the arithmetic here wrong in the flattering direction, so here it is
properly.** Diffing the two bodies line-by-line: **81 changed hunks**, 14,296 chars on the old
side, 28,069 on the new, and **423 of the second body's 807 lines unchanged**. Revision 1 stopped
there and reported `14,296 + 28,069 = 42,365` against 48,618 — "12.9% saved". That model is wrong
because it charges nothing for anchors or call envelopes. An `Edit` needs `old_string` to be
*unique*, which over an 807-line spec means real context on both sides. At ~80 chars of anchor per
side plus ~120 of envelope, 81 hunks cost `14,296 + 28,069 + 81 × 280 = 65,045` characters —
**34% MORE than the rewrite**, in 81 round trips rather than 1.

**So on the one instance the task points at, the heredoc was defensible.** A revision that touches
81 places and adds 14 KB to an 807-line document is a rewrite, and rewrites are what heredocs are
for. Any rule that says "never re-emit" without qualification would have made this run *worse*.

What is *not* defensible, and is measurable without argument, is the **unchanged payload carried
for nothing: 20,550 characters, 42% of the second body.** And the run's other re-emission is the
pure case — `deploy` wrote `/tmp/probe-backend.sh` twice with a **byte-identical 1,383-char body**,
100% waste, no judgement call required.

| re-emission | prev body | new body | unchanged carried | share |
| --- | ---: | ---: | ---: | ---: |
| `spec` → `…wait-on-the-process-not-a-guess.md` | 34,845 | 48,618 | **20,550** | 42% |
| `deploy` → `/tmp/probe-backend.sh` | 1,383 | 1,383 | **1,384** | 100% |
| **run total** | | | **21,934** | 4.8% of 459,056 |

**21,934 characters — 4.8% of the run's tool-call input — is the honest, defensible size of this
defect on this run.** Not 40%. Two consequences run through the rest of the spec:

1. **The metric is the waste, not the count.** § Data models adds `heredocRewriteWasteChars`; a
   near-total rewrite scores near zero on it *by construction*, so a legitimate rewrite is not
   punished and the `deploy` case is caught at 100%.
2. **The rule must be conditional on how much of the file is changing**, or it forces the 65,045-
   character outcome above. § Solution's recipe says so explicitly.

The reason to ship this anyway, at 4.8%: **the cost of a re-emission scales with the size of the
file and not with the size of the change, so it is unbounded.** A 50 KB spec touched three times to
fix three sentences costs 150 KB as heredocs and a few hundred bytes as edits. This run happens not
to be that case. Nothing in the prompt currently prevents it from being the next one.

The `spec` step is also the run's most expensive step by model time — `cez run stats
70f19253-cf6b-407c-92e0-96a8020a8ebb`, run from `/var/lib/cezar/loki-labs/cezar` (it resolves
`.ai/cezar/runs/` relative to CWD and fails from a worktree):

```
step             calls child trips batch  model s   exec s   wall s
spec (×2)           44     0    44  1.00   1463.3     21.1   1508.2
implement           52     0    52  1.00    768.8    505.8   1306.0
document            28     0    28  1.00    458.1     31.3    518.1
TOTAL              267    93   265  1.01   5072.6   1364.6   6883.3
```

**1,463 s of model time against 21 s of tool execution.** Whatever the mechanism by which emitted
characters convert to wall clock, this step is not waiting on tools.

### `document` is the weakest of the three targets, and the spec says so

10 of `document`'s 28 calls carry a heredoc `stripHeredocs()` can see (an 11th is discussed under
the blind spot in § Data models), but **not one of them authors a file**: they are batched
`say(){ printf … }` probe scripts, `python3 - <<'PY'` KB-proposal builders writing to
`$CEZ_KB_WRITE_FILE`, and todo-lease scripts. Its single largest call is the knowledge-base entry
body — **new content, correctly emitted once**. `heredocFileWrites` = 0 and
`heredocRewriteWasteChars` = 0 for this step.

Including `document` is still right — it holds `Edit`/`Write` and edits specs and docs, so the rule
belongs there before a future run needs it — but nobody should expect a number from it on this
baseline, and criterion 3 must not be pointed at it.

### What is explicitly NOT the problem

- **Not the grant.** `Edit` was reachable throughout (§ above). Adding it to `spec`'s
  `allowedTools` is a consistency fix, not the mechanism.
- **Not batching.** Batch factor is 1.00–1.18 everywhere. That is a real defect and it is
  `.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md`'s problem, not this one.
- **Not blind sleeps or re-runs.** `0 blind of 10` sleeps and `0` repeated expensive calls on this
  run — `.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md` shipped in `ada8f376` and its
  meters read clean here.
- **Not `python3 - <<` as such.** A script that transforms twelve files, or that reads a 5 MB
  NDJSON, is the correct tool and this spec must not ban it. The rule is about *authoring a file*,
  not about *running a script*.

---

## Solution

Four levers. L1 is the whole point; L2 makes L1 falsifiable; L3 and L4 keep the record straight.

### L1 — One shared prompt constant, in the three write-heavy steps

Follow the `RECORD_READ_RECIPE` precedent exactly (`types.ts:465`, interpolated into `context` at
`:591` and `document` at `:873`): a single exported constant, referenced by every step that needs
it, so the three copies cannot drift.

It must be **its own imperative paragraph, not a subordinate clause.** This is measured, not
stylistic: `types.ts:835-848` records the campaign's own falsification — `context` "states the
fan-out as its own imperative paragraph with named jobs and rules, and dispatched sub-agents on 3 of
3 runs; this step held the same grant behind a subordinate clause and dispatched on 0 of 2." KB
`notion-333c1a0a847b`: "naming a tool in the allowlist is not what unlocks fan-out; **the prompt
is**."

It must **name the case it governs and disclaim the ones it does not**, or it collides with
`TOOL_BUDGET_DOCTRINE` bullets 1 and 3, which are correctly shell-first for *reading* and for
*command output*. This is the same carve-out shape the sleep spec used and pinned
(`system-prompt.test.ts:98-105`: assert the new phrase *and* the surviving `bound every section`).

#### The exact proposed text

```ts
/**
 * How an agent step should WRITE A FILE (spec
 * `.ai/specs/2026-08-21-edit-an-existing-file-never-re-emit-it.md`, L1).
 *
 * This exists to argue with an instruction cezar does not own and cannot switch off: bypass
 * permissions mode injects "make file changes with sed, heredocs, or short scripts, rather than
 * using the dedicated Read, Edit, or Write tools" into every Claude-backed step
 * (`core/claude-cli-runner.ts:702` sets `bypassPermissions` unconditionally). That instruction is
 * right for a three-line `sed`, and wrong for changing one paragraph of a 50 KB document. The step
 * prompt is the only lever, and it lands LATER in the transcript than the injected reminder
 * (`run.ts:4300`).
 *
 * Measured on run `70f19253`: 360 tool calls containing zero `Edit` and zero `Write`. Its `spec`
 * step wrote the same document through `cat > … <<'SPECEOF'` twice — 34,845 characters, then
 * 48,618, of which 20,550 were unchanged lines carried for nothing — and its `deploy` step wrote
 * `/tmp/probe-backend.sh` twice with a byte-identical body.
 *
 * NOTE the rule is deliberately CONDITIONAL, and that is measured, not cautious. That `spec`-step
 * rewrite touched 81 separate hunks and grew the file by 14 KB; converted to 81 anchored `Edit`s it
 * would have cost ~65,045 characters against the 48,618 the rewrite spent, in 81 round trips
 * instead of 1. An unconditional "never re-emit" makes that case WORSE. See the spec's § Problem.
 */
export const FILE_WRITE_RECIPE = [
  'CHANGING PART OF A FILE THAT ALREADY EXISTS: use your editor tool, not a heredoc that re-emits',
  'the whole file. On Claude Code that is `Edit` (old_string → new_string) for a change and `Write`',
  'for a file that does not exist yet; on another backend, whatever patch/edit tool it gives you.',
  'This OVERRIDES the standing "make file changes with sed, heredocs, or short scripts" preference,',
  'for file mutation only. Several edits to one file go out as PARALLEL edit calls in ONE turn.',
  '',
  'Why, because this rule is not boilerplate and must not be deleted as such: an edit costs the',
  'CHANGE, a heredoc costs the FILE, and you pay for every character twice — once emitting it, once',
  'carrying it in context afterwards. Measured on run `70f19253`: 360 tool calls, ZERO `Edit`, ZERO',
  '`Write`. Its spec step wrote one document twice — 34,845 characters, then 48,618, of which',
  '20,550 were unchanged lines carried for nothing. Its deploy step wrote the same 1,383-character',
  'script twice, byte-identical. That cost scales with the size of the FILE and not with the size',
  'of your change, so it gets worse the longer the file gets, without limit.',
  '',
  'The honest exception, so do not over-apply this: when you are genuinely rewriting MOST of a',
  'file, re-emitting it is correct and cheaper than dozens of anchored edits. Judge by how much of',
  'the file changes, not by whether it existed. Rewriting a whole file to change three paragraphs',
  'is the failure; rewriting it because three paragraphs are all that survive is not.',
  '',
  'Also still correct, and NOT repealed here:',
  '- Heredocs for a file that does not exist yet, and for a genuinely scripted multi-file transform',
  '  (one script that rewrites twelve call sites). Writing those out as edits is worse.',
  '- The batched `set +e` probe script for READING — that rule is about reading, this one is about',
  '  writing, and they do not conflict.',
  '- Redirecting an expensive command\'s output to a file and re-slicing it.',
  '',
  'If an edit fails to match, re-read the exact region and retry with a longer, unique anchor. Do',
  'NOT fall back to rewriting the whole file — that is the failure this rule exists to prevent, and',
  'the second attempt costs more than the first.',
].join('\n');
```

Interpolated into `spec`, `implement` and `document` as its own block, the way `RECORD_READ_RECIPE`
already is.

**On naming `Edit`/`Write`.** The backend-neutrality pin
(`system-prompt.test.ts:110-116`) binds `TOOL_BUDGET_DOCTRINE` only, because that text is prepended
to codex/opencode/pi prompts via `core/agent-runner.ts:92`. A *step* prompt may name a backend tool
— `run-tests` names `run_in_background` today and `types.test.ts:275` asserts it. The text above
still leads with the capability and names the Claude tools second, so a codex or opencode run gets a
followable instruction.

### L2 — Ship the meter before the claim

`cez run stats` has **no size metric of any kind**: `StepStats` (`runs/stats.ts:165-266`) exposes
`toolCalls`, `roundTrips`, `batchFactor`, `toolExecMs`, `modelMs`, `cheapCalls`, `sleepCalls`,
`blindSleepCalls`, `repeatedExpensiveCalls` and nothing that counts characters. Every number in this
spec came from a hand-rolled one-liner, which is exactly what the module's own header forbids
(`stats.ts:6-20`: "**This module is the METER, and it ships before the optimisations it exists to
judge.**").

Add five fields (§ Data models). The machinery is mostly there: `stripHeredocs()`
(`stats.ts:106-119`) parses heredoc bodies out of a command, and `commandOf()` (`:157`) already
reads a call's `input`. What is new is the file-authoring predicate and the per-path body map that
`heredocRewriteWasteChars` diffs against.

**And the meter is not a formality here** — writing it is what caught revision 1's numbers. Three
of that revision's figures were wrong (the serialization, the file-write baselines, the diff
model), all of them in the direction that flattered the change, and none of them would have
surfaced before the acceptance test failed.

### L3 — Make the `spec` step's grant agree with its prompt

`types.ts:622` grants `['Read','Grep','Glob','Write','Bash']` — no `Edit`. Decorative today, but a
step told to use a tool its own declared grant omits is an inconsistency that becomes a real
failure the day todo `444c7db2-944e-457c-adc9-ec1380270203` ships `--disallowedTools`. Add `'Edit'`.

`implement` uses `DEFAULT_ALLOWED_TOOLS` (`types.ts:251`) and `document` lists both already — no
change needed there.

### L4 — Resolve the duplicate task before implementing, not after

Todo `a7ebbe3f-ec42-4ce0-8b9d-90c60dfed6b4` — *"The spec revision re-emits the whole spec file —
51,450 chars in one heredoc, 6m43s of generation across two passes"* — is **`started`**, i.e. its
run is live now, and it is the same fix scoped to the `spec` step. It edits the same literals in
`types.ts` on a different branch. § Open questions Q6 settles this; § Phases makes it Phase 0.

---

## Architecture

Where the two instructions meet, and why the later one is the only lever:

```
  claude CLI process (v2.1.233)
  ────────────────────────────────────────────────────────────────────────
  --append-system-prompt          ← composeSystemPrompt(...)          run.ts:4546
      skill body
      run extra prompt
      TOOL_BUDGET_DOCTRINE        ← 252/260 words, backend-neutral,   run.ts:540
                                    pinned by system-prompt.test.ts
      HANDOFF_INSTRUCTIONS
  ────────────────────────────────────────────────────────────────────────
  isMeta conversation message     ← INJECTED BY THE BINARY, not by cezar.
      "…make file changes with      Fires on bypassPermissions, which
       sed, heredocs, or short      claude-cli-runner.ts:702 sets with no
       scripts, rather than         env read. No cezar switch suppresses it.
       using the dedicated
       Read, Edit, or Write tools"
  ────────────────────────────────────────────────────────────────────────
  user message                    ← applyTemplate(step.prompt, task)  run.ts:4300
      step prompt
      + FILE_WRITE_RECIPE  ◄── THIS SPEC. Later in the transcript,
                               more specific, scoped to file mutation.
  ────────────────────────────────────────────────────────────────────────
```

Three properties make this the right slot and all three are constraints, not preferences:

1. **Not the doctrine.** `TOOL_BUDGET_DOCTRINE` is 252 words against a `< 260` cap asserted at
   `system-prompt.test.ts:138` — 8 words of headroom, and the cap was raised from 210 *with a
   written argument* that explicitly demands the same argument again with numbers before it grows
   further. And `Edit`/`Write` are Claude Code tool names, which is the same class of violation
   that forced `run_in_background` out of the doctrine (`system-prompt.test.ts:110-116`). Both
   pinned tests point at the step prompt.
2. **One constant, three call sites.** Same shape as `RECORD_READ_RECIPE` (`types.ts:465`, used at
   `:591` and `:873`), so `types.test.ts` can assert "this step contains the constant" rather than
   asserting three copies of a sentence.
3. **Coverage is narrow and this spec says so out loud.** It reaches `spec`, `implement` and
   `document` of `spec-to-deploy` only. **Not covered:** `commit-push` (51.2% heredoc share on this
   run, though those are git plumbing, not file authoring), `review-spec` (3 file-authoring
   heredocs), **`deploy` — which holds 3 file writes and one of the run's two re-emissions, the
   byte-identical `/tmp/probe-backend.sh`** — `context`,
   `QUICK_TASK_WORKFLOW`, `AUTONOMOUS_IMPLEMENTATION_WORKFLOW`, and every user-defined workflow.
   That is the price of not touching the doctrine. Revisit only if the meter shows the rule works
   and the uncovered steps matter.

---

## Data models

**Five** new fields on `StepStats` (`packages/cezar/src/runs/stats.ts:165-266`), summed into
`RunStats.totals` like every counter except `peakContextTokens`.

```ts
/**
 * Σ `JSON.stringify(input).length` over EVERY tool call attributed to this step, sub-agent calls
 * INCLUDED — the size of what was emitted to drive tools, as opposed to how many times
 * (`toolCalls`) or how long the tools took (`toolExecMs`).
 *
 * SCOPE, stated because it is a real choice and the two answers differ: this is the same scope as
 * `toolCalls`, which also counts children (`stats.ts:518`, before the `childIds` drop). Own-only
 * would be the same scope as `roundTrips`/`modelMs`. Children are included because the question
 * this metric answers is "how many characters did this run pay to emit", and a sub-agent's
 * characters are still the run's characters — on run `70f19253` a sub-agent wrote an 18,042-char
 * brief through a `cat >` heredoc, which own-only would hide. `ownToolCalls` already exists for
 * the other reading; no `ownToolInputChars` is added, because no question needs it yet.
 *
 * IMPLEMENTATION: accumulate immediately after `bucket.toolCalls += 1` and BEFORE the
 * `items.childIds.has(id)` break at `stats.ts:522-526`. The `signalsOf()` call stays where it is,
 * after the break — the sleep/repetition meters are own-only and must not change.
 *
 * SERIALIZATION IS LOAD-BEARING (R9). `implement` on run `70f19253` = **82,716** over 52 calls
 * under `JSON.stringify`. The task statement's 83,628 is Python `json.dumps` with DEFAULT
 * separators and `ensure_ascii=True` — a different number that TypeScript cannot produce. Two more
 * near-neighbours give 83,456 and 82,888. A test pins the exact encoding.
 */
toolInputChars: number;

/**
 * …of which lives inside a heredoc BODY, measured as the `stripHeredocs()` delta (below).
 * **62,276** of `implement`'s 82,716 (75.3%); 239,216 of the run's 459,056 (52.1%).
 *
 * This is a FLOOR, deliberately. `stripHeredocs()` (`stats.ts:106-119`) only recognises an opener
 * whose tag ends the line, so `python3 - <<'PY' > /tmp/out.txt` is invisible to it. Measured on
 * run `70f19253`: 8 calls contain `<<` and are not seen — and **7 of the 8 are not heredocs at
 * all**, they are JavaScript sources whose text contains `<<` (a heredoc-stripping regex being
 * written into a scratch script, and a template literal). The only genuine miss is one 449-char
 * `document` call. So the strict opener buys 7 correct rejections for 449 characters of
 * under-count, and is the right trade.
 *
 * **DO NOT WIDEN `stripHeredocs()` to close that gap.** It also feeds `signalsOf()`
 * (`stats.ts:140`), i.e. the `sleepCalls` / `blindSleepCalls` / `repeatedExpensiveCalls` metrics
 * shipped in `ada8f376`, whose own doc comment records that stripping-plus-positive-duration is
 * what lands on the 7 genuine blind waits and that either half alone finds a different 8. Widening
 * it silently re-scores that spec's numbers. Reuse it unchanged, or leave the gap.
 */
heredocChars: number;

/**
 * Heredocs whose BODY IS A FILE'S CONTENT — `cat > P <<T`, `cat >> P <<T`, `cat <<T > P`,
 * `tee P <<T`, `tee -a P <<T`. Counted per heredoc, not per call: one call may author two files.
 *
 * Deliberately narrower than "contains a heredoc": in `python3 - <<'PY' > out.txt` the body is a
 * SCRIPT and `out.txt` is its stdout, not the heredoc's content — a script that transforms twelve
 * files is the correct tool and must not score here.
 *
 * Run `70f19253`: **13** run-wide — context 2, spec 2, review-spec 3, implement 2, run-tests 1,
 * document 0, deploy 3. (Revision 1 of the spec said 2 run-wide and 0 for `implement`; it was
 * wrong on both. `implement` wrote `/tmp/wc-doctrine.mts` and `wc-check.mts`.)
 *
 * `/tmp` SCRATCH SCRIPTS COUNT, and that is a decision, not an oversight: the run's cleanest
 * re-emission is `deploy` writing `/tmp/probe-backend.sh` twice with an identical body. A
 * throwaway script re-emitted is still re-emitted.
 */
heredocFileWrites: number;

/**
 * …of which target a path this run has ALREADY written or read. Run `70f19253`: **2** — `spec`
 * (the spec file) and `deploy` (`/tmp/probe-backend.sh`). Revision 1 said 1.
 *
 * A file-authoring heredoc counts as a re-emission when its path was, EARLIER IN THE SAME RUN,
 * either (a) the target of another file-authoring heredoc, or (b) read — a `Read` tool call's
 * `file_path`, or a `cat`/`head`/`tail`/`sed -n …p` argument in a Bash command.
 *
 * Why this predicate and not "did the file exist at step start": the NDJSON records no tree
 * snapshot per step, so that question is not answerable from the transcript at all (the brief's
 * open question 7). This one is answerable and needs no git.
 *
 * **This is a DIAGNOSTIC, not the gate** — see `heredocRewriteWasteChars`. A count cannot tell a
 * wasteful re-emission from a legitimate near-total rewrite, and run `70f19253` contains one of
 * each. Both failure directions of the predicate, stated rather than hidden:
 * - UNDER-reports a file that existed before the run and was never read first. Deliberate: an
 *   unread file is one the model could not have edited safely anyway.
 * - OVER-reports a legitimate full regeneration that was also read — which is exactly why the
 *   character metric below, and not this count, is what § Analytics gates on.
 */
heredocRewrites: number;

/**
 * **THE DEFECT, IN CHARACTERS, AND THE ONLY HARD GATE.** For each re-emission, the number of
 * characters of the new body that are UNCHANGED from the body this run last wrote to that path —
 * i.e. what was paid for twice and bought nothing. Σ over the step.
 *
 * Run `70f19253`: **21,934** run-wide = `spec` 20,550 (42% of a 48,618-char body) + `deploy` 1,384
 * (100% of a byte-identical 1,383-char body). 4.8% of the run's 459,056 tool-call input chars.
 *
 * Why this and not `heredocRewrites`: a count punishes the legitimate case. The `spec` step's
 * second write changed 81 hunks and grew the file 14 KB; as 81 anchored edits it would have cost
 * ~65,045 characters against 48,618, so re-emitting was the CHEAPER choice and a gate on the count
 * would have scored a correct decision as a failure. This metric scores that same write at 42%
 * and a total rewrite at ~0, which is the behaviour we actually want.
 *
 * COMPUTABLE FROM THE TRANSCRIPT ALONE: the meter already replays every `tool-call`, so the prior
 * body is in hand. Keep `Map<path, lastBody>` and diff line-wise (`equal` opcodes of a
 * longest-common-subsequence over lines). Bound the map — retain at most the last body per path
 * and cap a retained body at 256 KB, dropping (and counting) anything larger, so a pathological
 * run cannot make the meter the memory problem.
 */
heredocRewriteWasteChars: number;
```

### The file-authoring predicate, exactly

Revision 1 proposed a single regex over the whole command. It had two defects the review caught and
one it did not, so here is the corrected form, which is **line-scoped** rather than command-scoped:

```ts
/** An opener anywhere on the line — deliberately looser than `stripHeredocs`' end-of-line form. */
const OPENS_HEREDOC = /<<-?\s*['"]?[A-Za-z_]\w*['"]?/;
/** `cat … > P` / `cat … >> P` — either ordering, `cat > P <<T` and `cat <<T > P`. */
const CAT_TARGET = /(?:^|[;&|]\s*)cat\b[^|\n]*?>{1,2}\s*['"]?([^\s'";|&<>]+)/;
/** `tee P` / `tee -a P` — POSITIONAL, no redirect. A `>`-only regex can never match this. */
const TEE_TARGET = /(?:^|[;&|]\s*)tee\b\s+(?:-a\s+)?['"]?([^\s'";|&<>][^\s'";|&<>]*)/;
```

For each line of the command that matches `OPENS_HEREDOC`, test `CAT_TARGET` then `TEE_TARGET`; the
first capture is the authored path, and the heredoc body that line opens is that file's content.

What was wrong before, recorded so it is not reintroduced:

1. **`tee` was unreachable.** `/(?:cat|tee)\s+(?:-a\s+)?>{1,2}/` requires a redirect after the
   command name, but `tee` takes a *positional* path — `tee P <<T` has no `>` at all. The doc
   comment named `tee P <<T` as a target shape that the regex could never match.
2. **`(?:-a\s+)?` before `>` is meaningless.** `cat` has no `-a`, and `tee -a` takes no redirect.
   The flag belongs on the `tee` branch, where it now is.
3. **Gating on `stripHeredocs`' opener regex loses `cat <<'T' > P`.** That regex requires the tag
   at end of line; with a trailing redirect it is not. Hence the separate, looser `OPENS_HEREDOC`
   used *only* for this predicate — `stripHeredocs()` itself is not touched (see `heredocChars`).

**`heredocChars` is still measured on the stripped/unstripped delta**, not by re-parsing:
`heredocChars = JSON.stringify(input).length − JSON.stringify({...input, command:
stripHeredocs(command)}).length` for a Bash call, 0 otherwise. Reusing `stripHeredocs()` unchanged
is what keeps this metric from re-scoring `ada8f376`'s sleep numbers; the price is the 449-char
under-count documented on the field, which is accepted.

Note the consequence, and it is intended: **a call can score `heredocFileWrites` while contributing
`heredocChars` of 0**, if its opener carries a trailing redirect. It does not happen on run
`70f19253` — the one blind-spot heredoc there is a `python3` script, not a file write — but the two
metrics use different parsers on purpose and a reader comparing them must know that.

### Presentation

`formatRunStats` (`stats.ts:693`) gains one column, `chars k` (thousands, with the heredoc share
beside it), and one summary line. The waste leads, because it is the only number that is a defect
on its own:

```
21.9k chars re-emitted for nothing  (13 file-authoring heredocs, 2 of them re-emissions)
 · 239.2k of 459.1k tool-call input chars were heredoc bodies (52.1%)
```

---

## API contracts

Only one surface changes and it is additive.

`cez run stats <runId> --json` emits `RunStats` verbatim. **Five** new keys appear on every step
object and on `totals` — `toolInputChars`, `heredocChars`, `heredocFileWrites`, `heredocRewrites`,
`heredocRewriteWasteChars` — all `number`, all summed into `totals`. No key is removed, renamed or
re-typed. `runs/stats-cli.ts` needs no change — `stats-cli-wiring.test.ts` already asserts the JSON
round-trip.

No HTTP route, no stored schema, no run-protocol event changes. `RunEvent` is read, never written.

---

## Phases

Independently shippable, in order. Phase 1 can ship alone and is useful alone.

### Phase 0 — Settle the duplicate (no code)

`a7ebbe3f-ec42-4ce0-8b9d-90c60dfed6b4` is `started` and covers the `spec` step of this same fix.
Decide before touching `types.ts` (§ Open questions Q6 recommends folding it in). Whoever
implements Phase 2 must first re-check:

```bash
cd /var/lib/cezar/loki-labs/cezar
cezar todo list --project cezar | grep -E 'a7ebbe3f|8ef45202'
git -C . log --oneline origin/main -5          # did 0762e872's branch land first?
git -C . log --oneline origin/main -- packages/cezar/src/workflows/types.ts | head -3
```

If it landed, **rebase onto it and keep the shared-constant shape** — do not revert its `spec`-step
text, fold it into `FILE_WRITE_RECIPE`. If it has not, proceed and let the `document` step close
`a7ebbe3f` as superseded by this spec.

### Phase 1 — The meter (`runs/stats.ts` + `runs/stats.test.ts`)

1. Add the five `StepStats` fields, `Bucket` fields, `emptyBucket()` entries, per-step mapping and
   `totals` sums (`stats.ts:165-266`, `:386-417`, `:595-645`). `toolInputChars`/`heredocChars` and
   the three heredoc counters accumulate **before** the `childIds` break at `:522-526`;
   `signalsOf()` stays after it, untouched.
2. Add `OPENS_HEREDOC` / `CAT_TARGET` / `TEE_TARGET`, the per-run path-seen `Set<string>`, and the
   per-run `Map<path, lastBody>` that `heredocRewriteWasteChars` diffs against (256 KB cap per
   retained body). Both live in the same replay loop that already reads `commandOf(event)` at
   `:543`. **`stripHeredocs()` is not modified** — see § Data models.
3. Extend `formatRunStats` with the `chars k` column and the two summary lines.
4. Tests, **inline events, not the fixture** (R7 below).

Ships alone. Re-running `cez run stats 70f19253-…` must reproduce every number in § Problem — that
is the acceptance test for this phase, and it is available immediately because the transcript is
already on disk.

### Phase 2 — The prompt (`workflows/types.ts` + tests + `AGENTS.md`), ONE commit

Precedent `ada8f376` moved `run.ts`, `system-prompt.test.ts`, `types.ts`, `types.test.ts` and
`AGENTS.md` together, and that spec's Phase 1 step 4 insists on it "or the two documents disagree the
moment this lands."

1. `export const FILE_WRITE_RECIPE` beside `RECORD_READ_RECIPE` (`types.ts:465`), with the doc
   comment from L1 — the *why* lives in the comment as well as in the text, so a future editor
   deleting it has to delete the measurement too.
2. Interpolate it into the `spec` (`:616`), `implement` (`:701`) and `document` (`:830`) prompts as
   its own block. In `implement`, place it beside the existing gate-output paragraph at `:720-722`
   — the closest structural precedent, a short self-contained paragraph before "End your report…".
3. Add `'Edit'` to `types.ts:622`.
4. `types.test.ts`: the constant is present in all three prompts; asserts on flowed text
   (`.replace(/\s+/g, ' ')`) because these prompts are hard-wrapped line arrays; asserts the
   override clause, the *why* clause, the new-file/scripted-transform carve-out, and the
   failed-match rule.
5. `system-prompt.test.ts`: assert `TOOL_BUDGET_DOCTRINE` is **unchanged** — still `< 260` words,
   still free of `Edit`/`Write` — so this spec cannot smuggle the rule into the doctrine later
   without the argument the cap demands.
6. `AGENTS.md`: restate the rule beside the existing tool-budget section (`AGENTS.md:417-452`),
   with the run number and the two figures.

### Phase 3 — Record and file (the `document` step of the implementing run)

KB entry for the durable decision; this spec's status set to `implemented` / `partial`; todo
`8ef45202` closed; `a7ebbe3f` closed as superseded per Phase 0.

### Phase 4 — The after-run that decides it

**Cannot be done by the run that implements this**, for the reason `f65ccdde` retracted a number
for: a step cannot measure itself while running, because the act of writing the measurement changes
it. Both sibling specs hit the same wall and filed follow-ups (`221cf511`, `ea54dd16`). File a todo
with the baselines pasted in (§ Verification §4) and run it on the next `spec-to-deploy` of
comparable scope.

---

## Analytics

Named while designing the feature, per this workspace's standing rule. All four ride on the
existing `cez run stats` surface — no new event, no new sink.

| metric | baseline (`70f19253`) | target | reads |
| --- | --- | --- | ---: |
| **`heredocRewriteWasteChars` (run)** | **21,934** | **≤ 2,000** | **the defect in characters — the hard gate** |
| `Edit` calls (run) | 0 of 360 | **≥ 1** | did the override land at all — hard gate |
| `heredocChars / toolInputChars`, run | 52.1% | ≤ 40% | whole-run shape |
| `heredocChars / toolInputChars`, `implement` | 75.3% | ≤ 45% | mechanism switched, not just bytes |
| `toolInputChars`, `spec` | 141,813 | ≤ 125,000 (−12%) | where the re-emission actually was |
| `heredocRewrites` (run) | 2 | *diagnostic — no target* | a count cannot tell waste from rewrite |
| `heredocFileWrites` (run) | 13 | *diagnostic — no target* | a new file is not a defect |
| `toolInputChars`, `implement` | 82,716 | *no target; ±8% expected* | R10 — the conversion is ~a wash here |
| `roundTrips`, `implement` | 52 | **≤ 60** | R10 guard: edits must ride in batches |

**Why the waste target is 2,000 and not 0.** The baseline decomposes as `spec` 20,550 + `deploy`
1,384, and **`deploy` is not one of the three steps this spec touches** (§ Architecture point 3).
So the achievable target is exactly "`spec`'s share goes to zero, `deploy`'s survives". Setting it
at 0 would gate this change on a step it deliberately does not modify. If a later revision extends
the recipe to `deploy`, lower it then.

**Read the last two together or not at all.** `implement`'s heredocs are hand-rolled edits, not
re-emissions; converting them trades ≈ 5,363 characters for up to 18 round trips. A run that cuts
`implement`'s characters by 8% while its round trips go from 52 to 80 has made the run *slower*.
The `roundTrips` bound is there so that outcome is visible instead of celebrated.

The per-step `inputTokens`/`outputTokens` counters that already exist
(`.ai/specs/2026-07-30-session-usage-metrics.md:40,110,167`) are **not** joined to wall clock
anywhere, which is why no target above is stated in tokens or seconds. See Q1.

---

## Risks

**R1 — The injected instruction may simply win.** It arrives in a system-position `isMeta` frame and
is unambiguous. Our text is a user message, later in the transcript and more specific, which is the
only advantage available. *Mitigation:* the meter makes the answer visible in one run. **The
campaign's own rule caps this at one prompt iteration** — if the next comparable run still shows
`Edit 0`, record the falsification in this spec and stop rewording. `types.ts:835-848` sets that
precedent explicitly for the fan-out clause.

**R2 — A failed `Edit` becomes a whole-file rewrite, and we lose more than we save.** `Edit`
requires an exact unique match; a near-miss is a hard error. An agent that hits one and falls back
to `cat > file` has now paid for both. *Mitigation:* the recipe's last paragraph names the recovery
(re-read the region, longer anchor) and bans the fallback, and `types.test.ts` pins that sentence.
`heredocRewrites` catches it if it happens anyway.

**R3 — The win is much smaller than the task claims, and someone will read this as failure.**
Stated up front rather than buried, and smaller again after revision 2's re-measurement: the
defensible saving on this baseline is **21,934 characters, 4.8% of the run's tool-call input**, and
**≥ 40% on `implement` is not reachable** — 85.4% of its heredoc bytes are literal payload an
`Edit` also emits, and `new` alone is 30,979 chars. If the implementing run removes the re-emission
waste, uses `Edit` at all, and moves `implement`'s characters by −3%, that is the **correct
outcome, not a shortfall**. Q3 carries the criteria that make it judgeable. The reason to ship at
4.8% is the unbounded tail, not this run's magnitude.

**R4 — `document`'s prompt is churning.** Rewritten four commits ago by `5ef7e653` and carrying a
long behavioural comment at `types.ts:835-848`. Inserting a block risks conflict and risks diluting
the fan-out paragraph that comment is measuring. *Mitigation:* insert as a distinct block after the
numbered `Do all of:` list, and do not reflow anything already there.

**R5 — Prompt dilution across three steps (R7 of the 2026-08-20 spec).** ~200 words added to each of
three prompts. No measurement of dilution exists in either direction. *Mitigation:* one shared
constant, so the cost is paid once in the source and is easy to shorten later; step prompts have no
word cap; and the counter-argument is recorded here rather than assumed away.

**R6 — `bashAllowlist` debt.** `types.ts:570-573` and
`.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md:519` record, unresolved, that
`bashAllowlist` compiles to STARTS-WITH `Bash(<prefix>:*)` patterns no `set +e` batch can ever
match. This spec adds nothing to any allowlist and inherits the debt unchanged; it is
`444c7db2`'s to resolve.

**R7 — The fixture trap, verified live.** Both stats fixtures have their `input` payloads stripped:
`grep -c '"input"'` returns **0** on `ec6e8e06-trimmed.ndjson` (559 lines) and **0** on
`c10864d1-trimmed.ndjson` (613 lines). A character metric tested only against them measures zero
forever and passes. *Mitigation:* every new assertion runs over inline events, exactly as
`stats.test.ts:246-300` does for the sleep predicates, **and** the fixtures' zeroes are pinned with
the reason attached, as `stats.test.ts:369-378` does.

**R8 — Concurrent edit to the same literals.** Run `0762e872` / todo `a7ebbe3f` is live on the
`spec` step. *Mitigation:* Phase 0.

**R9 — The serialization is load-bearing, and revision 1 of this spec already got it wrong.** The
task's 83,628 is Python `json.dumps` with **default separators** and `ensure_ascii=True`; three
near-neighbours over the same 52 inputs give 83,456, 82,888 and **82,716**, and only the last is
`JSON.stringify`. Revision 1 asserted the two "agree on this input" and set 83,628 as the meter's
acceptance number — a meter built to that spec would have failed § Verification §2 on the day it
shipped, for a reason no one would have looked for. Reconciliation, so nobody re-derives it:
`+", "/": "` separators and `\uXXXX` escaping of non-ASCII together account for the 912-character
gap. *Mitigation:* every baseline in this spec is `JSON.stringify`, and §1 pins the encoding
against an inline event whose input is known, so a "tidy-up" that switches encodings fails loudly.

**R10 — Converting hand-rolled edits to real edits can cost more wall clock than it saves.**
`implement`'s 13 heredocs hold 31 `s.replace()` calls; one `Edit` each is +18 round trips for
≈ 5,363 characters. At the ~6 s per round trip `TOOL_BUDGET_DOCTRINE` itself budgets, that is a net
loss unless the edits ride in one turn. *Mitigation:* the recipe says "several edits to one file go
out as PARALLEL edit calls in ONE turn"; § Analytics sets no character target for `implement` and
bounds its `roundTrips` at 60; § Verification §4 fails a run whose round trips balloon. **This is
the most likely way for this change to backfire**, and it is the one the meter is weakest at
showing, because `roundTrips` moving is not by itself proof of cause.

**R11 — A legitimate near-total rewrite scores as a re-emission.** The `spec` step's second write
is exactly that case, and revision 1 would have gated on it. *Mitigation:* the gate is
`heredocRewriteWasteChars`, not `heredocRewrites` — a total rewrite carries almost no unchanged
lines and scores ≈ 0 by construction. The count remains, as a diagnostic, beside it.

---

## Verification

Concrete and executable. §1–§3 run in the implementing session; §4 cannot and is Phase 4.

### §1 — The meter reproduces this spec's Problem section (`runs/stats.test.ts`)

Inline events, not the fixture (R7).

```ts
it('counts a heredoc body separately from the command that carries it', () => {
  const s = computeRunStats('r', [
    bash(1, 0, 'a', "cat > .ai/specs/x.md <<'EOF'\nline one\nline two\nEOF"),
    done(2, 1, 'a'),
  ]);
  expect(s.totals.heredocFileWrites).toBe(1);
  expect(s.totals.heredocRewrites).toBe(0);           // a NEW file is not the defect
  expect(s.totals.heredocChars).toBeGreaterThan(0);
  expect(s.totals.heredocChars).toBeLessThan(s.totals.toolInputChars);
});

it('charges a re-emission only for the lines it carried unchanged', () => {
  const p = '.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md';
  const s = computeRunStats('r', [
    bash(1, 0, 'a', `cat > ${p} <<'SPECEOF'\nkept one\nkept two\nSPECEOF`), done(2, 1, 'a'),
    bash(3, 2, 'b', `cat > ${p} <<'SPECEOF'\nkept one\nkept two\nbrand new\nSPECEOF`), done(4, 3, 'b'),
  ]);
  expect(s.totals.heredocFileWrites).toBe(2);
  expect(s.totals.heredocRewrites).toBe(1);
  // 'kept one\n' + 'kept two\n' — the two lines paid for twice. NOT 'brand new'.
  expect(s.totals.heredocRewriteWasteChars).toBe('kept one\n'.length + 'kept two\n'.length);
});

it('charges a TOTAL rewrite almost nothing — R11, the reason the gate is chars not count', () => {
  const s = computeRunStats('r', [
    bash(1, 0, 'a', "cat > doc.md <<'EOF'\nalpha\nbravo\nEOF"), done(2, 1, 'a'),
    bash(3, 2, 'b', "cat > doc.md <<'EOF'\ncharlie\ndelta\nEOF"), done(4, 3, 'b'),
  ]);
  expect(s.totals.heredocRewrites).toBe(1);          // the count still flags it…
  expect(s.totals.heredocRewriteWasteChars).toBe(0); // …and the gate correctly does not.
});

it('matches `tee` and the trailing-redirect ordering, which the first predicate could not', () => {
  const s = computeRunStats('r', [
    bash(1, 0, 'a', "tee -a notes.md <<'EOF'\nx\nEOF"), done(2, 1, 'a'),
    bash(3, 2, 'b', "cat <<'EOF' > other.md\ny\nEOF"), done(4, 3, 'b'),
  ]);
  expect(s.totals.heredocFileWrites).toBe(2);
});

it('scores a heredoc write to a path the run already READ as a re-emission', () => {
  const s = computeRunStats('r', [
    ev(1, 0, 'tool-call', { id: 'a', tool: 'Read', input: { file_path: 'src/x.ts' } }), done(2, 1, 'a'),
    bash(3, 2, 'b', "cat > src/x.ts <<'EOF'\nwhole new body\nEOF"), done(4, 3, 'b'),
  ]);
  expect(s.totals.heredocRewrites).toBe(1);
});

it('does NOT score a script as a file write, in either redirect position', () => {
  const s = computeRunStats('r', [
    bash(1, 0, 'a', "python3 - <<'PYEOF'\nimport io\ns = io.open('a.ts').read()\nPYEOF"), done(2, 1, 'a'),
    bash(3, 2, 'b', "python3 - <<'PY' > /tmp/out.txt\nprint(1)\nPY"), done(4, 3, 'b'),
  ]);
  expect(s.totals.heredocFileWrites).toBe(0);   // the body is a SCRIPT; /tmp/out.txt is its stdout
  expect(s.totals.heredocChars).toBeGreaterThan(0);
});

it('documents the `stripHeredocs` blind spot instead of widening it (R9/§ Data models)', () => {
  // The tag is not at end of line, so `stripHeredocs` — which `signalsOf` also depends on — does
  // not see this body. Accepted: 449 chars of under-count on run 70f19253, against 7 correct
  // rejections of JS sources containing `<<`. If this ever fails, someone widened the stripper.
  const s = computeRunStats('r', [
    bash(1, 0, 'a', "python3 - <<'PY' > /tmp/out.txt\nprint(1)\nPY"), done(2, 1, 'a'),
  ]);
  expect(s.totals.heredocChars).toBe(0);
});

it('pins the serialization — the baseline is JSON.stringify, NOT python json.dumps (R9)', () => {
  const input = { command: 'héllo <<EOF' };
  const s = computeRunStats('r', [ev(1, 0, 'tool-call', { id: 'a', tool: 'Bash', input })]);
  expect(s.totals.toolInputChars).toBe(JSON.stringify(input).length);
  // Guards the exact failure revision 1 shipped: `{"command":"héllo <<EOF"}` is 25 characters,
  // where python's `json.dumps` default (`", "`/`": "` separators + \uXXXX escaping) gives 31.
  expect(s.totals.toolInputChars).toBe(25);
});

it('reports ZERO on both fixtures because their `input` was STRIPPED, not because they never wrote', () => {
  expect(stats.totals.toolInputChars).toBe(0);
  expect(stats.totals.heredocChars).toBe(0);
  expect(stats.totals.heredocFileWrites).toBe(0);
  expect(stats.totals.heredocRewriteWasteChars).toBe(0);
  expect(stats.totals.toolCalls).toBe(271);   // the proof the zero is the fixture's, not the meter's
});
```

### §2 — The meter against the real transcript (the number that matters)

These are the numbers the prescribed implementation actually produces — `stripHeredocs()`
unmodified, `JSON.stringify` semantics, the corrected file-write predicate, children included.
They were measured this session by executing that specification against the transcript, not
transcribed from the task statement.

```bash
cd /var/lib/cezar/loki-labs/cezar          # NOT from a worktree — it resolves .ai/cezar/runs/ from CWD
cez run stats 70f19253-cf6b-407c-92e0-96a8020a8ebb --json | python3 -c "
import json,sys
d=json.load(sys.stdin)
k=('toolInputChars','heredocChars','heredocFileWrites','heredocRewrites','heredocRewriteWasteChars')
for s in d['steps']+[dict(d['totals'],stepId='TOTAL')]:
    print('%-12s'%s['stepId'], tuple(s[x] for x in k))
"
```

Must print, exactly:

```
context      (58332,  21692, 2, 0,     0)
spec         (141813, 92284, 2, 1, 20550)
review-spec  (31119,   7650, 3, 0,     0)
implement    (82716,  62276, 2, 0,     0)
run-tests    (31809,   5721, 1, 0,     0)
commit-push  (12395,   6347, 0, 0,     0)
document     (41500,  24228, 0, 0,     0)
deploy       (59372,  19018, 3, 1,  1384)
TOTAL        (459056,239216,13, 2, 21934)
```

Three of those rows are the ones revision 1 got wrong, so check them first: **`implement` is 2
file writes, not 0** (`/tmp/wc-doctrine.mts`, `wc-check.mts`); **`deploy` is 3 writes and 1
re-emission**, not absent; **`document` is 0 writes** — that row was right, and it is the reason
`document` gets no character target.

Any disagreement means the meter or this spec is wrong, and this is where that shows up
(`stats.test.ts:19-22` sets that convention). **If a row disagrees, do not adjust `stripHeredocs()`
to close the gap** — § Data models explains what that breaks; adjust this spec, or the predicate
that is genuinely at fault.

### §3 — The prompt is present, in the right form (`workflows/types.test.ts`)

```ts
it('overrides the bypass-mode Bash preference for FILE EDITS in all three write-heavy steps', () => {
  const flowed = (id: string) => (stepById(id)?.prompt ?? '').replace(/\s+/g, ' ');
  for (const id of ['spec', 'implement', 'document']) {
    expect(stepById(id)?.prompt, id).toContain(FILE_WRITE_RECIPE);
  }
  const t = FILE_WRITE_RECIPE.replace(/\s+/g, ' ');
  // It overrides, explicitly and by name — a rule that does not mention what it overrides loses.
  expect(t).toContain('OVERRIDES');
  expect(t).toContain('for file mutation only');
  // Criterion 2: the WHY travels with the rule, with numbers, so it cannot be deleted as
  // boilerplate. Both figures are DIRECT COUNTS that survive any change to how heredoc bodies are
  // parsed — revision 1 pinned a share (274,926/465,531) that the meter's own implementation then
  // failed to reproduce. Do not put a parse-dependent number in prompt text.
  expect(t).toContain('an edit costs the CHANGE, a heredoc costs the FILE');
  expect(t).toMatch(/360 tool calls, ZERO `Edit`, ZERO `Write`/);
  expect(t).toMatch(/34,845 characters, then 48,618, of which 20,550/);
  // R10: without this the conversion can cost more round trips than it saves characters.
  expect(t).toMatch(/PARALLEL edit calls in ONE turn/);
  // R11: the rule is conditional on how much of the file changes, not on whether it existed.
  expect(t).toContain('when you are genuinely rewriting MOST of a file');
  expect(t).toContain('Judge by how much of the file changes');
  // The carve-outs, or it collides with the doctrine's (correct) shell-first reading rules.
  expect(t).toContain('a file that does not exist yet');
  expect(t).toContain('scripted multi-file transform');
  expect(t).toContain('that rule is about reading, this one is about writing');
  // R2: the recovery path, or a failed match becomes the exact defect this forbids.
  expect(t).toContain('Do NOT fall back to rewriting the whole file');
});

it('grants the spec step the editor tool it is now told to use', () => {
  expect(stepById('spec')?.allowedTools).toContain('Edit');
});
```

And in `system-prompt.test.ts`, the negative pin:

```ts
it('keeps the file-write rule OUT of the backend-neutral doctrine', () => {
  for (const t of ['Edit', 'Write', 'heredoc']) expect(TOOL_BUDGET_DOCTRINE).not.toContain(t);
  expect(TOOL_BUDGET_DOCTRINE.split(/\s+/).filter(Boolean).length).toBeLessThan(260);
});
```

### §4 — The after-run (Phase 4; cannot be run by the implementing session)

On the next `spec-to-deploy` run of comparable scope:

```bash
cd /var/lib/cezar/loki-labs/cezar
cez run stats <newRunId>
# Baselines to beat — run 70f19253-cf6b-407c-92e0-96a8020a8ebb.
# All figures JSON.stringify semantics; heredoc chars = stripHeredocs() delta. NOT the task's
# 83,628/465,531, which are a python json.dumps encoding TypeScript cannot produce (R9).
#   run       toolInputChars 459,056 · heredoc 239,216 (52.1%) · writes 13 · re-emits 2 · WASTE 21,934
#   spec      141,813 ·  92,284 (65.1%) · 2 · 1 · waste 20,550 · model 1463.3s / exec  21.1s
#   implement  82,716 ·  62,276 (75.3%) · 2 · 0 · waste      0 · model  768.8s / exec 505.8s · 52 trips
#   document   41,500 ·  24,228 (58.4%) · 0 · 0 · waste      0 · model  458.1s / exec  31.3s
#   Edit calls 0 · Write calls 0 · Bash 326 of 360
```

**Pass** = `heredocRewriteWasteChars ≤ 2,000` run-wide (from 21,934) **and** the run made ≥ 1 `Edit`
call (from 0) **and** `implement`'s `roundTrips ≤ 60` (from 52). The waste gate is the one that
matters; the `Edit` gate proves the override landed at all; the round-trip gate is R10's guard
against winning characters and losing wall clock.

**Explicitly NOT pass conditions**, so a later reader does not reinstate them: `heredocRewrites == 0`
(a legitimate near-total rewrite scores here — R11) and `implement`'s `toolInputChars` falling ≥ 40%
(arithmetically impossible — § Problem).

**Partial** = `Edit` used, waste down, but `implement` unchanged or its round trips up. Record it as
partial, keep the change, and **stop iterating the wording** (R1). **Fail** = still zero `Edit`
calls; the override lost to the injected instruction. That is a real and publishable result:
record it in this section, and the next move is `444c7db2`'s `--disallowedTools` or an upstream ask,
**not a third rewording**.

Read the commands as well as the counts. `heredocRewrites` is crude by construction and says so.

---

## Open questions — settled here

**Q1 — Is the run output-token bound at 81.3 tok/s? Not relied on.** The task asserts it with
R² 0.984. I searched the specs, the KB and `.ai/analysis/` and **found no spec, KB entry or analysis
file making that claim**; the record's measured positions are different — *round-trip bound*
(`.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md:14-21`) and *context-input bound*
(KB `notion-cc6ebabb2ab4`). The one output-side figure on record, ~7k tokens of prose, is cited as
*small*. Per-step `inputTokens`/`outputTokens` exist but nothing joins them to wall clock.

**Decision: option (b) from the brief.** The *why* in the prompt is stated in terms that hold under
every theory — "an edit costs the change, a heredoc costs the file", with the "360 tool calls, zero
`Edit`, zero `Write`" and 34,845→48,618-of-which-20,550-unchanged figures, which are direct counts
from the transcript and not a regression. **Revision 2 removed the one share-shaped figure the
prompt carried** (274,926/465,531), because it depended on how heredoc bodies are parsed and the
prescribed parser does not reproduce it — a number in prompt text that a pinned test asserts must
be one that cannot move under an implementation detail. This
satisfies criterion 2 (the rule carries its reason and its numbers) without staking prompt text on
an unreplicated claim. **Measuring tok/s is filed as a follow-up**, and its natural home is todo
`3d6c0e66` / run `49a5aea3`, which is precisely the "attribute a run's output tokens" task.

**Q2 — Doctrine or step prompt? Step prompt.** Forced by two pinned tests, not chosen:
`system-prompt.test.ts:138` (252/260 words, and the cap was raised once with a written argument that
demands the same argument again) and `:110-116` (backend-neutrality, which `Edit`/`Write` violate as
surely as `run_in_background` did). The narrowness of the coverage is named in § Architecture point
3 rather than left to look like coverage.

**Q3 — Criterion 3 is not achievable and needs replacing.** § Problem shows why, and revision 2's
re-measurement makes the gap wider than revision 1 admitted: the ideal conversion is 6.5%, and it
buys those characters with up to 18 extra round trips. Proposed replacement, falsifiable and
measured:

- ~~`implement`'s tool-call input chars drop ≥ 40% against 83,628~~ → **run-level
  `heredocRewriteWasteChars ≤ 2,000`, against a baseline of 21,934.** This is the defect stated in
  the units the task meant, and it is the only hard character gate.
- ~~…and `implement`'s `toolInputChars` drops ≥ 8%~~ → **no character target for `implement`**, but
  its `heredocChars / toolInputChars` falls from 75.3% to ≤ 45% (the mechanism changed) **and** its
  `roundTrips` stays ≤ 60 (R10 — the conversion must not be paid for in round trips).
- **The run makes ≥ 1 `Edit` call**, against a baseline of 0 in 360.
- ~~run-level `heredocRewrites == 0`~~ — **withdrawn.** Revision 1 proposed it; R11 shows it
  punishes the legitimate near-total rewrite that this very run performed. It stays as a printed
  diagnostic with no target.

Criterion 4 of the task ("no whole-file rewrite of a file that already existed at step start")
survives in spirit as the waste metric, and Q4 explains why its literal form is not computable.

**Q4 — Criterion 4's predicate.** "A file that already existed at step start" is unanswerable from
the transcript — the NDJSON records no per-step tree snapshot. Replaced by the
already-written-or-already-read predicate in § Data models, which is computable from the NDJSON
alone, catches both measured instances, and documents both failure directions. A new file and a
scripted multi-file transform are exempt by construction, as the criterion asks.

The criterion also says a re-emission "appears in the run log" is a failure, full stop. **Revision 2
declines that half**, on evidence: the `spec` step's re-emission was the cheaper of the two
available options, and a rule that forbade it would have cost that run ~16,000 extra characters and
80 extra round trips. What is charged instead is the *unchanged payload* a re-emission carries,
which is zero for the case the criterion means to allow and 100% for `deploy`'s duplicate script.

**Q5 — Ship a meter? Yes, and first.** `stats.ts:6-20` states the rule this repo runs on: the meter
ships before the optimisation it judges. Every number in this spec currently comes from a one-liner
that exists nowhere in the repo — the brief could not find the original 83,628 script either, and
reconstructed the formula by fitting candidate serializations.

**Q6 — Scope against `a7ebbe3f` / run `0762e872`.** **Fold it in.** `a7ebbe3f` is a strict subset
(the `spec` step only) of `8ef45202` (spec + implement + document), and splitting one shared
constant across two branches guarantees a conflict in `types.ts` for no benefit. Phase 0 re-checks
which landed first; Phase 3 closes `a7ebbe3f` as superseded by this spec. **This is a decision the
implementing run must confirm is still current** — `a7ebbe3f` was `started` when this spec was
written, so it may have landed by then.

**Q7 — Add `'Edit'` to the `spec` step's grant? Yes.** `types.ts:622`. Decorative on Claude today
(the grant only adds), but a step told to use a tool its own declared grant omits is precisely the
inconsistency that turns into a hard failure the day `444c7db2` makes the allowlist real. One word.

**Q8 — Who runs the after-run? Not this run.** Phase 4, filed as a todo with the baselines in
§ Verification §4 pasted into it, following `221cf511` and `ea54dd16`.

---

## What I could not verify

- **The 81.3 tok/s / R² 0.984 framing.** Absent from every stored artefact I searched. Q1.
- **"311 of 311".** Not derivable under any decomposition; the true figures are 252 of 254 outside
  `context` and 326 of 360 overall. The "zero Edit, zero Write" half is exact.
- **"the two longest gaps (221s and 135s) [in `implement`] are exactly that".** Not checked — the
  meter reports per-step model time, not per-gap, so confirming it needs a gap histogram this spec
  does not add. `implement`'s 768.8 s model / 505.8 s exec is consistent with the claim but is not
  a test of it.
- **The Edit-conversion cost models are models, not measurements.** Two numbers rest on assumed
  constants: `implement`'s 77,353 (≈120 chars of `Edit` envelope per call) and the `spec` step's
  65,045 (≈80 chars of anchor per side, per hunk). Both constants are estimates. The *conclusions*
  are robust to them — `implement` stays far from −40% for any envelope size, and the `spec`
  rewrite stays more expensive than 48,618 for any anchor above ~10 chars/side — but neither exact
  figure should be quoted as measured. The unchanged-payload numbers (20,550 / 1,384 / 21,934) are
  direct counts and carry no such assumption, which is precisely why the gate is built on them.
- **The ~6 s per round trip.** Taken from `TOOL_BUDGET_DOCTRINE`'s own text (`run.ts:540`) and its
  cited 231-calls-in-23-minutes run. Not independently re-measured this session, and R10's
  arithmetic inherits whatever error it carries.
- **Whether the override actually wins.** Empirical, and only a real run settles it. R1, § Verif §4.
- **`cez run stats` reports 267 own calls against the 360 `tool-call` events I counted** — the
  difference is the 93 sub-agent calls it attributes to children. Consistent, and noted so a reader
  comparing the two tables is not surprised.

---

## Provenance

**Read first-hand this session** (paths relative to the cezar repo root unless absolute):

- `.ai/specs/briefs/2026-08-21-edit-over-heredoc-file-writes.md` — the brief, in full.
- `packages/cezar/src/workflows/types.ts` — `DEFAULT_ALLOWED_TOOLS` `:251`, `RECORD_READ_RECIPE`
  `:465`, `BRIEFS_DIR` `:506`, `context` `:553`, the `bashAllowlist` contradiction comment
  `:570-573`, `spec` `:616` (grant `:622`, prompt `:624-651`), `implement` `:701`, `commit-push`
  `:779`, `document` `:830` (behavioural comment `:835-848`, grant `:849`).
- `packages/cezar/src/workflows/run.ts` — `TOOL_BUDGET_DOCTRINE` doc `:499-566` and text `:540`,
  `composeSystemPrompt` `:569`, `applyTemplate(step.prompt …)` `:4300`, composition `:4546`.
- `packages/cezar/src/core/claude-cli-runner.ts` — grants-not-restricts `:679-685`,
  `bypassPermissions` `:702`, `--append-system-prompt` `:705`.
- `packages/cezar/src/core/agent-runner.ts:92` — `prependSystemPrompt`, why the doctrine is
  backend-neutral.
- `packages/cezar/src/runs/stats.ts` — module doctrine `:6-20`, `NO_STEP` `:60`, `stripHeredocs`
  `:106-119`, `commandOf` `:157`, `StepStats` `:165-266`, `Bucket`/`emptyBucket` `:386-417`, the
  replay loop `:520-580`, per-step map + `totals` `:595-645`, `formatRunStats` `:693-757`.
- `packages/cezar/src/runs/stats.test.ts` — fixture doctrine `:11-26`, the inline-event pattern
  `:233-300`, the stripped-fixture pin `:369-378`.
- `packages/cezar/src/workflows/types.test.ts:222-316` — the prompt-*form* tests.
- `packages/cezar/src/workflows/system-prompt.test.ts:98-140` — the carve-out pattern,
  backend-neutrality, the 260-word cap and the argument behind it.
- `.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md` — headings + status block + rev-2 notes;
  the section conventions this spec follows.
- Commits: `ada8f376` (five-file prompt-change precedent, `--stat` read), `5ef7e653`
  (`document`-prompt churn).

**Re-measured first-hand in revision 2** (2026-08-21, after review), over the same NDJSON, by
executing this spec's own prescribed definitions rather than an ad-hoc parse — a faithful Python
port of `stripHeredocs()` (`stats.ts:106-119`), `JSON.stringify` serialization
(`separators=(',',':')`, `ensure_ascii=False`), the corrected line-scoped file-write predicate, and
`difflib.SequenceMatcher` over lines for the waste metric. Everything in § Problem's tables,
§ Verification §2 and § Analytics comes from that run:

- The four-encoding serialization table (83,628 / 83,456 / 82,888 / **82,716**) and the run total
  459,056 — establishing that the task's baseline is not `JSON.stringify`.
- The full per-step chars / heredoc-chars / file-writes / re-emissions / waste table, and the
  own-calls variant (context 36,930, total 437,654).
- The 8 `<<`-bearing calls `stripHeredocs()` does not see, individually inspected: **7 are not
  heredocs at all** (JS sources containing `<<`), 1 is a 449-char `document` script.
- `implement`'s decomposition — 13 heredoc calls, **31** `s.replace()` invocations, 53,193 chars of
  triple-quoted literal (`old` 6,697 / `new` 30,979 / other named 15,517).
- Both `spec` bodies (34,845 / 48,618) extracted and diffed at line granularity: 81 hunks, 14,296
  old-side, 28,069 new-side, 423 of 807 lines unchanged, **20,550 chars carried unchanged**.
- `deploy`'s `/tmp/probe-backend.sh` written twice with a **byte-identical 1,383-char body**.
- Read to confirm the implementation notes: `stats.ts` `stripHeredocs` `:106-119`, `signalsOf`
  `:139-140`, `commandOf` `:157`, the `tool-call` replay arm and its `childIds` break `:515-556`,
  and `collectItems`' `parentItemId` rule `:342-353` (93 child ids on this run).

**Measured first-hand in revision 1**, over
`/var/lib/cezar/loki-labs/cezar/.ai/cezar/runs/70f19253-cf6b-407c-92e0-96a8020a8ebb.ndjson`
(5,155,182 B): the tool-distribution table, the per-step heredoc table, the 79.6% literal decomposition
of `implement`'s heredocs, the old/new split (6,697 / 30,979), the two `spec`-step heredoc bodies and
their diff (34,845 → 48,618; 14,296 old / 28,069 new), the zero file-authoring heredocs in
`document`, and `cez run stats 70f19253-…` in full. Both stats fixtures confirmed to have `input`
stripped (`grep -c '"input"'` → 0 on each).

**Superseded 2026-08-21 by revision 2, in part.** Of that list, the tool-distribution table, the
old/new split, the two body sizes and the zero-file-writes-in-`document` finding all reproduced and
stand. **Its character totals, heredoc-share table, file-write counts and the 12.9% diff model did
not**, for the three reasons in the revision-2 note at the top of this spec. Where the two disagree,
revision 2 is the one computed from the implementation this spec actually prescribes.

**Tracker state at time of writing** (`cezar todo list --project cezar`, from
`/var/lib/cezar/loki-labs/cezar` — it reports "no todos filed" from a worktree):
`8ef45202` high/started (this task) · `a7ebbe3f` high/**started** (the `spec`-step duplicate) ·
`444c7db2` medium/todo (the `allowedTools` decision).

**Not read, and named rather than implied:** the Claude Code binary's own source (only the brief's
extracted string literal, which I did not re-extract); Notion (read-only archive since the
2026-08-17 cutover); `.ai/analysis/` (searched for the tok/s claim, found nothing from this
campaign).
