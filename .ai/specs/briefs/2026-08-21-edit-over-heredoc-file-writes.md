# Stop re-emitting whole files — Edit an existing file, heredoc only a new one

- Date: 2026-08-21
- Category: prompt doctrine (agent-facing text) + measurement
- Priority signal: high — todo `8ef45202-f29f-4dde-995b-1df150936940`, filed high, started, is this task verbatim. 79.9% of the `implement` step's tool-call input bytes are heredoc bodies, and the fix needs no runtime code.
- Risk signal: medium-high — the change must override an instruction cezar does not own and cannot suppress (it ships inside the Claude Code binary); it collides with a queued run on the same file; and the headline number in the task statement does not reproduce.
- Routing: next step writes the spec from this brief. **Three of the four acceptance criteria need rewording before they can be met** — see § Open questions 1, 2 and 7.

## Problem, in this repository's terms

Every file mutation in run `70f19253-cf6b-407c-92e0-96a8020a8ebb` was a Bash heredoc. The whole
file body is therefore re-emitted as model output on every write, and cezar pays for those bytes
twice — once as generation latency, once as billed output tokens.

The instruction that steers this is **not cezar's**, and that single fact reshapes the whole
design. Grepping the worktree for `accomplish the job`, `dedicated Read, Edit`, or
`bypass permissions mode is active` returns **zero matches in cezar source, specs or docs**. The
text lives in the installed CLI binary
(`/usr/lib/node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-linux-x64/claude`,
`claude --version` → 2.1.233), as a template literal whose minified identifiers resolve to
Bash/Read/Edit/Write:

> `Do your work through the ${Bash} tool wherever it can accomplish the job: read files with cat,`
> `head, or sed -n, search with grep and find, and make file changes with sed, heredocs, or short`
> `scripts, rather than using the dedicated ${Read}, ${Edit}, or ${Write} tools. Fall back to a`
> `dedicated tool only when ${Bash} genuinely cannot do the job.`

It is injected as an `isMeta: true` conversation message, gated on `bypass || steerOnly ||
bashFirst`. cezar takes the `bypass` branch **unconditionally** —
`packages/cezar/src/core/claude-cli-runner.ts:701-702` pushes `--permission-mode
bypassPermissions` with no env read, and `claude-cli-runner.test.ts:101-111` pins exactly that.
So the instruction arrives in **every Claude-backed step of every cezar run**, cezar has no switch
to suppress it, and **prompt text is the only available lever**.

Nothing in cezar's record acknowledges the instruction exists. The spec that turned bypass mode on
(`.ai/specs/2026-08-15-bypass-permissions-claude-sessions.md`, 175 lines, read in full) never
mentions Read, Edit, Write, `sed`, heredocs, or tool preference at all — its stated scope is "one
function, one call site" (`:110-121`) and its Risks section names only the worktree boundary
(`:140-142`). The Bash-first preference arrived as an **unnoticed side effect** of that switch.

The second half of the problem is that the grant cannot help. `claude-cli-runner.ts:679-685`:

> `--allowedTools` is still passed below, but measured against `claude` 2.1.224 it only *grants*
> tools additively — it does not restrict. `default` mode with `--allowedTools Read` still ran
> `Bash`; only `--disallowedTools` removed the tool from the surface entirely. So
> `buildAllowedTools` and a step's `allowedTools`/`bashAllowlist` are decorative on a Claude run
> today.

`Edit` was reachable the entire run. Two sibling runs under the identical bypass config did use it
— `c10864d1` made 4 `Edit` calls, `7c2dd8f0` made 9 `Edit` + 23 `Write` — which independently
confirms availability was never the constraint. The complementary decision task is
`444c7db2-944e-457c-adc9-ec1380270203` (KB `notion-ecc123f96bb8`, "Decide what allowedTools should
actually restrict… or delete the illusion") — **still `todo`, unstarted, four options, no decision
recorded**. It is correctly flagged as a non-blocker: prompt text works today regardless.

## What I measured myself (2026-08-21, this worktree)

Counted with `python3` over
`/var/lib/cezar/loki-labs/cezar/.ai/cezar/runs/70f19253-cf6b-407c-92e0-96a8020a8ebb.ndjson`
(5,155,182 B, 2,632 lines; `jq` is not installed on this box). The `tool-call` events carry the
**full untruncated `input` object**, so this is a direct count, not an estimate.

| step | tool calls | of which Bash |
| --- | --- | --- |
| context | 106 | 74 |
| spec | 44 | 43 |
| review-spec | 33 | 33 |
| **implement** | **52** | **52** |
| run-tests | 37 | 36 |
| commit-push | 12 | 12 |
| document | 28 | 28 |
| deploy | 48 | 48 |
| **total** | **360** | **326** |

Whole-run tool distribution: `Bash` 326 · `Read` 16 · `Grep` 13 · `Agent` 3 · `ToolSearch` 2 —
**`Edit` 0, `Write` 0**. Outside `context`: **252 of 254 calls are Bash** (the two others are
`ToolSearch`, in `spec` and `run-tests`).

**The task statement's "311 of 311" does not reproduce.** No subset of steps and no Bash/non-Bash
split yields 311; the nearest sibling run `e06f2169` gives 300/295. The number appears only in this
task's handoff, nowhere in any spec, KB doc, run log or analysis file. The *substantive* claim
survives intact and should be restated as: **252 of 254 tool calls outside `context` were Bash
(99.2%), 326 of 360 overall, and zero `Edit` / zero `Write` anywhere in the run.**

**The 83,628-char baseline DOES reproduce, exactly.** The formula is
`sum(len(json.dumps(input)))` with Python's default `ensure_ascii=True` — a load-bearing detail,
because every other plausible serialization misses (`ensure_ascii=False` → 82,888; `jq
tostring|length` → 82,716; `utf8bytelength` → 82,977; `.command` alone → 76,636). Reproducible
one-liner:

```bash
python3 -c "import json,sys;print(sum(len(json.dumps(json.loads(l)['input'])) for l in sys.stdin if l.strip() and json.loads(l).get('type')=='tool-call' and json.loads(l).get('stepId')=='implement'))" \
  < /var/lib/cezar/loki-labs/cezar/.ai/cezar/runs/70f19253-cf6b-407c-92e0-96a8020a8ebb.ndjson
# -> 83628      (same filter, len() -> 52 calls)
```

**Where those bytes actually are — the number that should drive the design:** 13 of the 52 calls
contain a heredoc (`cat > … <<`, `python3 - <<'PYEOF'`), and those 13 account for **66,811 of the
83,628 chars = 79.9%** of the step's entire tool-call input. Largest single call: 9,230 chars. So
the ≥40% target (threshold **≤ 50,176 chars**) is reachable by fixing **13 calls**, and the
theoretical ceiling if every one became an `Edit` is far above 40%. This is the strongest fact in
the brief and the spec should lead with it.

## What the record already decided (citations)

- **The measurement surface is `cez run stats`**, and it ships *before* the claim it judges.
  `packages/cezar/src/runs/stats.ts:6-20`: "**This module is the METER, and it ships before the
  optimisations it exists to judge.** The repo's own standing rule is that decisions come from
  measured numbers; without this, every later phase of that spec is an assertion." Both sibling
  specs followed this ordering. Note `cez run stats` **must be run from
  `/var/lib/cezar/loki-labs/cezar`** — it resolves `.ai/cezar/runs/` relative to CWD and fails from
  a worktree.
- **`StepStats` has no size metric at all.** `stats.ts:165-266` exposes `toolCalls`,
  `childToolCalls`, `ownToolCalls`, `roundTrips`, `batchFactor`, `subAgentCalls`, `toolExecMs`,
  `modelMs`, `cheapCalls`, `cheapExecMs`, `sleepCalls`, `blindSleepCalls`, `sleepExecMs`,
  `repeatedExpensiveCalls` — nothing counts characters or output tokens. The `implement` baseline
  is therefore measurable **only via the ad-hoc one-liner above** unless the spec adds a field.
- **The machinery for such a field already exists.** `stats.ts:106-119` `stripHeredocs()` already
  parses heredoc bodies out of a command (it was written so a `sleep 25` inside a script would not
  score as a wait), and `stats.ts:140` / `:157-161` already read a tool call's `input`. A
  `toolInputChars` / `heredocWriteCalls` pair is a small, precedented addition.
- **Universal → doctrine; step-specific → step prompt.** Settled explicitly in
  `.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md`, Open questions item 5:
  "**Doctrine vs step prompt** — step prompt. The doctrine reaches steps deliberately denied `Task`
  and is capped at 210 words; adding fan-out there would be wrong on both counts." The sleep spec
  reached the mirror conclusion: the universal mechanism went *into* `TOOL_BUDGET_DOCTRINE`, while
  the backend-specific detail (`run_in_background`) stayed in the `run-tests` step prompt.
- **The form of the prompt, not the grant, produces the behaviour.** `types.ts:835-848` records the
  campaign's own falsification: `context` "states the fan-out as its own imperative paragraph with
  named jobs and rules, and dispatched sub-agents on 3 of 3 runs; this step held the same grant
  behind a subordinate clause and dispatched on 0 of 2." KB `notion-333c1a0a847b` puts it directly:
  "naming a tool in the allowlist is not what unlocks fan-out; **the prompt is**." Applied here:
  an Edit-over-heredoc rule buried in a clause will be ignored; it needs its own imperative
  paragraph.
- **Prompt changes ship with their test pins and their AGENTS.md restatement in the same commit.**
  `ada8f376` moved `run.ts`, `system-prompt.test.ts`, `types.ts`, `types.test.ts` and `AGENTS.md`
  together — the spec's Phase 1 step 4 insists on it, "or the two documents disagree the moment
  this lands."
- **Record falsification as the outcome, and do not iterate the prompt more than once before
  writing down what was tried.** The fan-out spec closed criteria 1 and 3 but recorded criterion 2
  as *partly met* (−17% on one baseline, −2% = noise on the other), and `f65ccdde` retracted an
  earlier −26%/−37% figure that had been read mid-step. Durable lesson recorded there: "an
  in-flight step cannot measure its own peak context, because the act of writing the measurement
  raises it." The same trap applies to a byte counter measured from inside the step it counts.

### The prior decision this most nearly contradicts

**None is contradicted** — I found no prior decision anywhere in `.ai/specs/`, the KB, or
`AGENTS.md` about tool *choice* for writing files. But four recorded constraints bind the design,
and one is a near-miss worth naming precisely:

1. **`TOOL_BUDGET_DOCTRINE` is at 252 words against a `< 260` cap — 8 words of headroom.** I
   counted this myself against the live constant. The cap is asserted at
   `system-prompt.test.ts:138`, and was raised from 210 *with a written argument*
   (`.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md` R1): "Explicitly **not** 'remove the
   cap'… Growing the doctrine again needs the same argument made again, with numbers." A new
   doctrine bullet does not fit without repeating that argument.
2. **Backend-neutrality in the doctrine is a pinned test, not a preference.**
   `system-prompt.test.ts:110-116` asserts `TOOL_BUDGET_DOCTRINE` contains none of `Monitor`,
   `BashOutput`, `TaskOutput`, `KillShell`, `run_in_background`, because the same text is prepended
   to codex, opencode and pi prompts via `agent-runner.ts:92-94`. **`Edit` and `Write` are Claude
   Code tool names** — putting them in the doctrine is the same class of violation that forced
   `run_in_background` out of it. Together with (1), both pinned tests point at the **step prompt**.
3. **The near-miss: the doctrine's bullet 3 currently mandates the shell-file idiom.**
   `run.ts` bullet 3: "Send its output to a file (`cmd >"$f" 2>&1; echo EXIT=$?`)… Re-read `$f` for
   a different slice; never re-run an expensive command." That governs *command output*, not file
   authoring, so it is not a contradiction — but a model reading both will hear "shell-first", and
   bullet 1 ("Batch cheap reads into ONE script") reinforces it. **The new text must say explicitly
   which case it governs and that it does not repeal the batching rules**, exactly as the sleep
   spec's carve-out did (`system-prompt.test.ts`: "carves the expensive case out of the bounding
   rule without repealing it", asserting both the new phrase *and* the surviving `bound every
   section`).
4. **`bashAllowlist` already contradicts the batching doctrine, recorded twice and unresolved.**
   `types.ts:570-573` and `.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md:519`:
   "`bashAllowlist` compiles to STARTS-WITH `Bash(<prefix>:*)` patterns that no `set +e …` batch
   script can ever match. Either the batch runs or the allowlist does." Decorative today; it becomes
   real the moment `444c7db2` ships. Anything this spec adds to an allowlist inherits that debt.

## Code actually involved

| file:line | what it is |
| --- | --- |
| `packages/cezar/src/workflows/types.ts:547-934` | `SPEC_TO_DEPLOY_WORKFLOW`, all eight steps. Prompts are **inline `[…].join('\n')` string literals** — there are no `.md` prompt templates anywhere. |
| `types.ts:616`, prompt `:624-651`, `allowedTools :622` | **`spec` step.** Grants `['Read','Grep','Glob','Write','Bash']` — **no `Edit`**. ~252 words. |
| `types.ts:701`, prompt `:707-725`, `allowedTools :703` | **`implement` step.** `DEFAULT_ALLOWED_TOOLS`. ~159 words — the shortest write-heavy prompt, and the one with the measured 83,628-char baseline. `:720-722` is the closest structural precedent: a short self-contained paragraph inserted before the "End your report…" line. |
| `types.ts:830`, prompt `:863-900`, `allowedTools :849` | **`document` step.** Grants `['Read','Edit','Write','Grep','Glob','Bash','Task']`. Prompt was **rewritten four commits ago** by `5ef7e653`; `:835-848` carries that change's comment. Churn risk. |
| `types.ts:251` | `DEFAULT_ALLOWED_TOOLS = ['Read','Edit','Write','Grep','Glob','Bash']`. |
| `packages/cezar/src/workflows/run.ts` (`TOOL_BUDGET_DOCTRINE`, doc `:499-566`) | The universal doctrine. 252 words, 1,456 chars. Composed at `run.ts:4540-4553` (agent step) and `:3314-3325` (continue turn) via `composeSystemPrompt` (`:569-575`). |
| `run.ts:4300` | `applyTemplate(step.prompt ?? '{{task}}', input.task)` — the step prompt becomes the **user message**, which lands later in the transcript than the CLI's `isMeta` reminder. That ordering is the only positional advantage available. |
| `packages/cezar/src/core/claude-cli-runner.ts:679-685`, `:701-702`, `:704-706` | The grants-not-restricts comment; the unconditional `bypassPermissions`; the single `--append-system-prompt` channel (never `--system-prompt`, never a prompt file). |
| `packages/cezar/src/runs/stats.ts:106-119`, `:140`, `:165-266` | `stripHeredocs()`; the `input`-reading path; `StepStats`, which has no size field. |
| `packages/cezar/src/workflows/types.test.ts:222-244`, `:301-316` | The prompt **form** tests — the pattern a new pin should follow. |
| `packages/cezar/src/workflows/system-prompt.test.ts:110-116`, `:138` | Backend-neutrality and the 260-word cap. |

Grep confirms **no existing "Edit vs heredoc" or "output token" instruction anywhere in
`packages/cezar/src`**; the only `heredoc` mentions in the package are `stripHeredocs()` and its
test. No duplicate implementation exists.

## The constraint that will decide the design

cezar is arguing with an instruction it does not own, cannot edit, and cannot turn off — one that
is delivered in a system-position `isMeta` frame and is unambiguous ("rather than using the
dedicated Read, Edit, or Write tools"). The only lever is later, more specific text in the step
prompt. That means the spec cannot treat "we wrote the instruction" as done: **whether the override
actually wins is an empirical question that only a real run can settle**, and the campaign's own
rule caps prompt iteration at one attempt before writing down what was tried.

## Open questions a spec must settle

1. **The framing is not in the record, and criterion 2 depends on it.** The task asserts runs are
   output-token bound at 81.3 tok/s, R² 0.984. I could find **no spec, KB entry or analysis file
   making that claim**, and the record's measured position is different in two ways: *round-trip
   bound* (`2026-08-20-…-batching-and-fanout.md:14-21`: 271 calls at batch factor 1.00, "~23.5
   minutes of the hour spent deciding to run 29 seconds of shell") and *context-input bound* (KB
   `notion-cc6ebabb2ab4`: "2.38s per round trip under 50k tokens → 9.55s at 200–300k… the context
   is 28:1 tool output to assistant text"). The only output-side figure on record — ~7k tokens of
   prose — is cited as *small*. `.ai/analysis/` holds nothing from this campaign. Criterion 2
   requires the prompt to state WHY "so a future prompt edit does not delete it as redundant
   boilerplate", so the spec must choose: **(a)** measure the tok/s claim first and cite the meter
   (repo rule: "Always cite the meter"); **(b)** state the WHY in terms the record already supports
   and that hold under *either* explanation — a heredoc re-emits bytes the model already knows,
   and those bytes are 79.9% of `implement`'s tool-call input under any theory of what they cost;
   or **(c)** assert 81.3 tok/s citing only run `70f19253`. **(b) is the recommendation, with (a)
   as a follow-up todo** — it is falsification-proof and does not stake the prompt text on an
   unreplicated regression. Note queued run `49a5aea3` is precisely the "attribute a run's output
   tokens" task, so (a) may belong there rather than here.
2. **Scope collision with queued run `0762e872` — decide before touching the `spec` step.** Its
   title is "The spec revision re-emits the whole spec file — 51,450 chars in one heredoc, 6m43s of
   generation across two passes" (todo `a7ebbe3f`). That is the *same fix* scoped to the `spec`
   step, while this task's criteria name spec, implement **and** document. Both edit the same
   literals in `types.ts` on separate branches and will conflict. Either this task drops `spec` and
   leaves it to `0762e872`, or `a7ebbe3f` is folded in and its run cancelled. **This is a decision,
   not a merge problem.**
3. **Step prompt or doctrine?** The record's rule (universal → doctrine) points at the doctrine
   because file authoring happens in more workflows than `spec-to-deploy`; both pinned tests (the
   8-word cap, backend-neutrality) point at the step prompt. If step prompt, the fix reaches only
   the three named steps of one workflow and nothing else — including `commit-push`, which also
   writes. Name that limitation explicitly rather than letting it pass as coverage.
4. **Backend portability of a Claude-named instruction.** `spec-to-deploy` can run on codex and
   opencode, whose file-edit tools are named differently. Does the text name `Edit`/`Write`
   (precedent: `run-tests` names `run_in_background`), or describe the capability neutrally
   ("your editor tool that takes an old string and a new string")?
5. **Ship a meter, or measure ad hoc?** Adding `toolInputChars` (and plausibly `heredocWriteCalls`)
   to `StepStats` makes the after-run a `cez run stats --json` diff instead of a hand-rolled script,
   and matches the campaign's meter-before-claim ordering. Cost: a new field, fixture updates, and
   the R7 trap the sleep spec recorded — `ec6e8e06-trimmed.ndjson` has `input` **stripped**
   (`grep -c '"input"'` → 0), so a character metric tested only on that fixture is silently always
   zero.
6. **Does the `spec` step get `'Edit'` added to its `allowedTools` (`types.ts:622`)?** Decorative
   today, but telling a step to use a tool its own declared grant omits is an inconsistency that
   becomes a real failure the day `444c7db2` ships `--disallowedTools`.
7. **Criterion 4 has no predicate yet.** "No whole-file rewrite of a file that already existed at
   step start" requires knowing which files existed at step start — the run NDJSON does not record
   a tree snapshot per step. Options: derive it from git state at the step's first event, or weaken
   the criterion to something computable (e.g. "no heredoc write to a path that a `Read`/`cat` in
   the same step already showed the agent"). The spec must define the check or the criterion is
   unfalsifiable.
8. **What is the after-run, and who runs it?** Both siblings could not measure themselves and filed
   the after-run as a follow-up todo with baselines pasted in (`221cf511`, `ea54dd16`). Criterion 3
   says "measured on a run of comparable scope" — `implement` on this very run is the natural
   candidate, but measuring from inside the step being measured is the exact trap `f65ccdde`
   retracted a number for.

## In-flight conflict — name it before editing

- **`0762e872` (todo `a7ebbe3f`), status `queued`** — direct overlap on the `spec` step's prompt.
  See open question 2. Filed in the same 2026-08-21T21:16 batch as this task, one minute after it
  started.
- Also queued from that batch, adjacent but distinct: `95d3c6f2` (todo `33ce6584`, "run-tests burns
  14% of a run's entire output budget"), `49a5aea3` (todo `3d6c0e66`, "a run's cost cannot be
  attributed — thinking vs tool-args vs text"), `f2012c07` (todo `c78140a8`, `npm test` red on the
  prod box). `49a5aea3` is the natural home for open question 1(a).
- Open and adjacent: `444c7db2` (allowedTools decision, non-blocker), `2b56085d` (fan-out made the
  step slower), `221cf511` and `ea54dd16` (the two sibling after-run measurements).
- Working tree state: `main` clean at `387ba439`; **zero open PRs**; 11 worktrees, none with
  uncommitted work on step prompts; the four queued runs have no worktrees yet. Remote is `origin`
  only in this checkout.
- `cezar todo list` from a worktree reports "no todos filed" — the working invocation is
  **`cezar todo list --project cezar` from `/var/lib/cezar/loki-labs/cezar`** (110 todos, 71 open).

## What I could not find

- **Any cezar-side rationale for the Bash-over-Edit/Write preference.** It is upstream CLI text and
  our record does not acknowledge it exists. Nothing forbids overriding it per step.
- **Any claim, measurement or KB entry that cezar runs are output-token bound.** The record says
  round-trip bound and context-input bound, and explicitly rules out the box (prod round-trip mean
  7.44s vs Mac 8.74s). Per-step `inputTokens`/`outputTokens` counters exist
  (`.ai/specs/2026-07-30-session-usage-metrics.md:40,110,167`) but **nothing joins them to wall
  clock**.
- **Any prior decision about tool choice for writing files**, in specs, KB or `AGENTS.md`.
- **The "311 of 311" figure.** Not derivable from any stored artifact under any decomposition; true
  values are 252 of 254 outside `context`, 326 of 360 overall. The "zero Edit, zero Write" half is
  correct.
- **The original measurement script.** No analysis file, script or KB entry contains 83,628; the
  formula was reconstructed by fitting candidate serializations against the target.
- **The claimed "two longest gaps (221s and 135s)" in `implement`.** Not verified. `cez run stats`
  reports `implement` at 768.8s model / 505.8s exec / 1306.0s wall, consistent but not a check.
