# Stop agents blocking on guessed `sleep N` — wait on the process, slice a saved file

- Date: 2026-08-21
- Category: prompt doctrine (agent-facing text) + measurement
- Priority signal: high — todo `eb6e528b-50d6-419b-842a-ffa4f0d61fa5`, filed high, is this task verbatim. Measured at ~17 min lost per six sessions, and the fix needs no runtime code.
- Risk signal: medium — the change lands in the one string injected into **every** agent step of every run, guarded by a hard word cap with **7 words of headroom**, and it re-opens a failure mode (`f42e2ad2`) where a step ends while its gate is still running.
- Routing: next step writes the spec from this brief.

## Problem, in this repo's terms

`TOOL_BUDGET_DOCTRINE` (`packages/cezar/src/workflows/run.ts:519-535`) tells every agent step
"**Background what is genuinely slow.** … start it with `run_in_background`, keep working, and
wait for it before you report." The `run-tests` step prompt
(`packages/cezar/src/workflows/types.ts:743-744`) repeats it: "Run each long gate with
`run_in_background` and keep working; `wait` for every one of them and read its full output
BEFORE you report."

Neither text says **how** to wait. Agents supplied the mechanism themselves, and they guessed a
duration. Measured across six production sessions (kb `local:2026-08-21-cezar-run-speed-measured`):

> "sleep/poll waiting **16.9 min** (mean 101s, max 276s) against **7.0 min** of real vitest time
> and **3.0 min** of typecheck. Phase 5's 'background what is genuinely slow' was implemented as a
> **guessed `sleep N` then grep a log** — one call is literally `sleep 240`. That is a **2.4:1
> loss** against the thing it was meant to speed up."

The second, related cost is the batching bullet's bounding rule
(`run.ts:527-528`): "bound every section (`head`, `sed -n`) so the batch cannot flood your
context." It is correct for cheap reads and has **no carve-out for expensive commands**, so:

> "the same single test file was re-run **12 times**, four of them consecutively, differing only in
> the output filter (`| grep -E "FAIL|✓|×"` → `| grep -E "Test Files"` → `| sed -n '1,80p'`). …
> the agent re-runs a test instead of re-slicing a saved file."
> — kb `local:2026-08-21-cezar-run-speed-measured`

That note's own "what to do" item #1 is this task, word for word: *"Replace guessed `sleep N` with
waiting on the process in the tool-budget/run-tests prompt, and add a carve-out: redirect an
expensive command's output to a file once, then slice the file. Worth ~17 min per six sessions and
needs no code."*

## What I measured myself (2026-08-21, this worktree)

`jq` is **not installed on this box** (`command -v jq` → exit 1), so these were counted with node
over `/var/lib/cezar/loki-labs/cezar/.ai/cezar/runs/*.ndjson`. Only five runs' NDJSON is present
locally.

| run | Bash calls | commands matching `sleep <n>` | calls with `run_in_background: true` |
|---|---:|---:|---:|
| `7c2dd8f0` | 595 | **19** | 26 |
| `c10864d1` | 298 | **14** | 9 |
| `7aecd6a2` | 124 | **6** | 8 |
| `e06f2169` (in flight) | 85 | 0 | 0 |
| `70f19253` (this run, read-only step) | 70 | 0 | 0 |
| **total** | **1172** | **39** | **43** |

**The dominant form is not a blind sleep — it is a bounded poll loop**, and that matters for the
acceptance criterion. Real commands from `7c2dd8f0`:

```
sleep 120; tail -12 /tmp/full-suite-mine.log                                   # blind guess (1 of them)
for i in $(seq 1 60);  do grep -q '^EXIT=' /tmp/gate-typecheck.log && break; sleep 2; done
for i in $(seq 1 100); do grep -q '^EXIT=' /tmp/gate-vitest.log    && break; sleep 6; done
```

The poll loop already exits early on an `EXIT=` marker and costs exactly **one** round trip, so it
is not a round-trip defect at all — it is a *wall-clock overshoot* defect, and a naive
`grep 'sleep <n>'` cannot tell the two apart. Note also that `/tmp/full-suite-mine.log` proves
agents **already redirect to a file**; what is missing is the instruction to **re-slice** that file
instead of re-running the command.

## What the record already decided (citations)

| Decision | Where | Bearing on this change |
|---|---|---|
| Round trips, not tool execution, make a step slow; a tool call costs ~6s regardless | kb `local:2026-08-20-round-trips-not-tool-execution`; `run.ts:499-518` | The rationale the doctrine is built on. Unchanged. |
| "Batching is for the 231 [cheap calls]. … The 10 slowest calls were 80% of all tool execution … Batching does nothing for those — **backgrounding** does." | kb `local:2026-08-20-round-trips-not-tool-execution` | Cheap and expensive calls get **different** rules. The carve-out is consistent with this split, not a new idea. |
| R2: an unbounded batch floods context and is "**strictly worse** than the calls it replaced"; every section must be bounded | `.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md` § Risks R2 and § Solution L1 (line 152) | **The bounding rule must survive.** The 2026-08-21 note says it *lacks a carve-out*, not that it is wrong. Repealing it contradicts R2 and `system-prompt.test.ts:74-75`. |
| R6: backgrounded gates need an explicit `wait`; never background anything that mutates the index | same spec § Risks R6 | Both clauses stay. |
| R7: the doctrine must stay under ~200 words because it precedes every step prompt | same spec § Risks R7, enforced at `system-prompt.test.ts:86` | **The binding constraint — see below.** |
| Phase 5 (the backgrounding guidance) shipped and is deployed | kb `local:2026-08-21-cezar-run-speed-measured`: it is "in `/opt/cezar/packages/cezar/dist/workflows/run.js` and visible in the `--append-system-prompt` of every live `claude` process" | This is an edit to live text, not a new feature. |
| The prompt was **read and followed** — command text changed (100% of prod Bash calls are multi-statement batches, median 510 chars) but batch factor stayed 1.00→1.02 and sub-agent calls stayed 0 | kb `local:2026-08-21-cezar-run-speed-measured` | Precedent that prompt edits change *what agents type* reliably, and *how many turns they take* not at all. This change is of the first kind, so it has a real chance. |
| "Batching *inside* a call is not batching *round trips* … Reading the command text alone says the doctrine worked. Reading `cez run stats` says it did not. **Always cite the meter.**" | same note | Do not claim a win from prompt text alone. |
| Three benchmarked-and-dead toolchain fixes: `--project server` (1.68s vs 1.73s), jsdom→happy-dom (81s → **86s**), `isolate: false` (**"dies, exit 144, mid-run, on both machines"** — the suite spawns real processes) | same note | Out of scope. Do not re-spend time here. |
| A single server test file runs in **1.7–2.0s**; the agent's observed 37s runs were a new test hanging/failing on a loaded box; the full server project is 79s and the suite is genuinely **flaky** (6 then 4 failing files on two identical runs) | same note | The thing being waited on is usually ~2s. Most of the 16.9 min was spent waiting for something already finished. |

### The prior decision this most nearly contradicts

kb `local:2026-08-20-backgrounded-gate-outlives-its-step` (todo `f42e2ad2-3a24-438a-b9f0-fef3fe808cb0`,
open). On run `23221162` — *the run that implemented the batching doctrine* — `run-tests`
backgrounded `npm test`, **ended 1m30s later while it was still running**, and `commit-push`
inherited the unfinished suite and committed nothing, both reporting `status=done`:

> "**Backgrounding is only half a technique; the `wait` is the other half, and a step boundary can
> eat it.** A background job's lifetime is the *session's*, not the step's. … Any prompt that grants
> backgrounding must also make the step's completion *conditional on having read the output*, or the
> gate is decorative. **A gate you started is not a gate you ran.**"

This does not block the change, but it sets a hard boundary on it: **a guessed sleep is at least a
wait.** Removing it without naming a mechanism that actually blocks until completion converts a
slow-but-correct gate into a fast-and-fake one. `commit-push` got a `verify` post-condition for
exactly this class of failure (`types.ts:763`, `everything-committed`); **`run-tests` still has
none** — its gate is prompt-enforced only (`types.ts:721-755`).

## Code actually involved

| File:line | What it is |
|---|---|
| `packages/cezar/src/workflows/run.ts:519-535` | `TOOL_BUDGET_DOCTRINE` — the only copy in source. Bullet 1 (`:525-528`) holds the `head`/`sed -n` bounding rule; bullet 3 (`:533-535`) holds the backgrounding rule. |
| `packages/cezar/src/workflows/run.ts:499-518` | The doc comment carrying the `ec6e8e06` measurement that justifies the doctrine. Will need updating if the numbers move. |
| `packages/cezar/src/workflows/run.ts:4522` and `:3295` | The two composition sites — every agent step, and every Continue turn. Unconditional: no env flag, no backend check, no step-kind check. |
| `packages/cezar/src/workflows/types.ts:721-755` | `spec-to-deploy`'s `run-tests` step; its backgrounding bullets are `:741-744`. No `verify:` post-condition. |
| `packages/cezar/src/core/agent-runner.ts:92-94` | codex/opencode have no system-prompt channel, so the whole block is prepended to the opening user message. Any mechanism the new text names must be meaningful on **all three** backends. |
| `packages/cezar/src/workflows/system-prompt.test.ts:63-95` | Pins `'bound every section'` (`:74`), `/`head`\|head -/` (`:75`), `'Background what is genuinely slow'` (`:68`), `'mutates the git index'` (`:79`), and the **word cap** (`:86`). |
| `packages/cezar/src/workflows/types.test.ts:229-238` | Pins the `run-tests` prompt: `'BACKGROUND'`, `'run_in_background'`, `` '`wait` for every one of' ``, `'Never background anything that mutates the git index'`, `'AGENTS.md'`. Rewording the bullet breaks this test — update it deliberately. |
| `packages/cezar/src/runs/stats.ts:132-248` | `computeRunStats`. Reads `type`, `seq`, `ts`, `stepId`, `id`, `tool` — **never `input`**. So today the meter counts Bash *calls*, never Bash *commands*, and reports no sleep/poll time. |
| `packages/cezar/src/runs/stats-cli.ts:53-55` | `cez run stats <runId>`, reads `<repo>/.ai/cezar/runs/<runId>.ndjson`. |
| `AGENTS.md:405-445` | Prose restatement of the doctrine — a drift target that must be edited in the same commit. |

**The command string *is* recorded**, so criterion 3 is measurable:
`{"type":"tool-call","tool":"Bash","input":{"command":"…","run_in_background":true},"stepId":…}`
— emitted at `core/claude-cli-runner.ts:802`, forwarded with `stepId` at `run.ts:4319`, persisted
whole at `runs/store.ts:951-961`.

**Trap:** the checked-in fixture `packages/cezar/src/core/__fixtures__/runs/ec6e8e06-trimmed.ndjson`
has `input` **stripped** from its `tool-call` lines. A sleep-counter tested against that fixture
reports zero for every run regardless of truth. Test it against a real `.ai/cezar/runs/*.ndjson`.

## The constraint that will decide the design

`TOOL_BUDGET_DOCTRINE` is **203 words**; `system-prompt.test.ts:86` asserts `< 210`. **Seven words
of headroom.** (Measured this session with a node script over `run.ts`; the test counts the
resolved constant, and source form and resolved form both come to 203.) The cap is not arbitrary —
R7 exists because the doctrine precedes every step prompt, and the test comment reads: *"A doctrine
that grows past this is one that starts competing with the step prompt underneath it for the
model's attention."*

Two rules cannot be added in seven words. The spec must pick one of:
1. **Rewrite within budget** — replace words in the existing bullets rather than appending.
2. **Raise the cap** — a deliberate, argued amendment to R7, not a silent test edit.
3. **Split by scope** — the anti-sleep mechanism into the doctrine (it applies everywhere), the
   file-slicing carve-out into `run-tests`/`implement` step prompts (which have no cap).

## Open questions a spec must settle

1. **What is the mechanism the prompt should name?** The Bash tool's own contract is that *"Working
   directory persists between calls … Shell state (env vars, functions) does not persist"*, so a PID
   captured in call A is not a child of the shell in call B: **`wait $PID` only works when the start
   and the wait are in the same Bash call** — which is not backgrounding, it is blocking. That leaves
   three real patterns, and the spec should say which to prefer when:
   - no independent work to do → run it in the **foreground**, redirect to a file, one call, zero
     overshoot (this is the common case, and the current prompt never mentions it);
   - independent work exists → harness `run_in_background` + the harness's completion signal;
   - a fresh shell must poll → poll the exit marker with early exit and a bound, never a blind sleep.
   Acceptance criterion 1 names "`wait $PID` or the harness completion signal"; criterion 1 as
   literally worded is only satisfiable in the same-call case.
2. **Is the mechanism backend-portable?** `Monitor` was used **14 times in `7c2dd8f0`**, so it exists
   in the Claude harness on this box — but cezar's source has **zero** occurrences of `Monitor`,
   `BashOutput` or `KillShell`, `DEFAULT_ALLOWED_TOOLS` is `['Read','Edit','Write','Grep','Glob','Bash']`
   (`types.ts:251`), and `.ai/specs/2026-07-18-subagent-monitoring-status.md:44` states cezar *"models
   no background/async work at all."* Naming a Claude-specific tool in a doctrine that is also
   prepended to codex and opencode prompts needs a decision. (Tool *availability* is not the blocker:
   `--allowedTools` only **grants**, never restricts — `claude-cli-runner.ts:91-103`, `:672-678`, and
   the runner passes `--permission-mode bypassPermissions`.)
3. **Does a bounded poll loop violate criterion 3?** 38 of the 39 measured sleeps are poll loops with
   early exit costing one round trip; only one is a blind `sleep 120`. A grep for `sleep <n>` cannot
   distinguish them, so criterion 3 is either over-strict (bans a good pattern) or unfalsifiable.
   The spec must define the measured predicate exactly, and pick a baseline run.
4. **How is criterion 3 checked — one-off or a gate?** The 16.9 min figure was computed ad hoc by
   replaying NDJSON, **not** by `cez run stats` (`stats.ts` has no sleep/poll metric and never reads
   `input`). Options: an ad-hoc node one-liner in the spec's Verification section, or a `sleepCalls` /
   `sleepWaitMs` column added to `StepStats` — which is documented as *derived on demand, never
   persisted*, so it touches no store or contract-parity test. Related open bug: todo `3dd1907d`
   ("`cez run stats` prints '1.00 = never batched' for a run that batched perfectly", `stats.ts:328`).
5. **Which run proves it?** This run (`70f19253`) has 0 sleeps because its steps are read-only; a
   post-change run must actually execute gates for the measurement to mean anything. Name the run.
6. **Should `run-tests` get a `verify:` post-condition too?** kb `local:2026-08-20-backgrounded-gate-outlives-its-step`
   argues prompt text alone cannot make a backgrounded gate real, and `commit-push` already has
   `everything-committed`. Open todo `f42e2ad2` covers it. In scope or explicitly deferred?
7. **Does the `bashAllowlist` interaction matter?** `run-tests` and `implement` share
   `AUTONOMOUS_IMPLEMENTATION_WORKFLOW.steps[0].bashAllowlist` by reference (`types.ts:706`, `:727`),
   and the spec's own status log records: *"`bashAllowlist` compiles to STARTS-WITH `Bash(<prefix>:*)`
   patterns that no `set +e …` batch script can ever match"* (todo `444c7db2`). Currently moot on
   Claude (allowlists are decorative there), but not on a backend where they are not.

## Coordination risk

Run **`e06f2169`** (branch `cez/e06f2169`, worktree present, 85 Bash calls so far) is in flight
**right now** on the adjacent recommendation from the same KB note — "make sub-agent fan-out
actually happen", todo `095a272e`. It edits the **same two files**: `workflows/run.ts`
(`TOOL_BUDGET_DOCTRINE`) and `workflows/types.ts` (step prompts). If it lands first it will consume
part of the same 7-word headroom. Rebase before implementing, and re-measure the word count against
`origin/main` rather than against this brief's number.

## What I could not find

- **No spec file exists for this task.** `.ai/specs/` holds nothing on it; the only 2026-08-21 spec
  is `2026-08-21-one-settings-area.md`. This brief is the first artifact.
- **No prompt, doctrine, spec or doc anywhere tells an agent not to use `sleep`.** Every `sleep` in
  the repo is in shell scripts and tests (`.ai/scripts/test-env-up.sh:140,199,345`,
  `server-install/platforms/ubuntu-vps.ts:107`, `hetzner.ts:288`, `postconditions.test.ts:243`).
- **No carve-out anywhere** for "expensive command → redirect once → slice the file". The existing
  bounding rule actively pushes the opposite behaviour.
- **No `wait $PID` or completion-signal wording in any prompt** — only the bare word `wait` at
  `types.ts:744`.
- **No branch, commit or stash implementing this todo** (`git log --all -S "run_in_background"` in
  `packages/cezar/src/workflows` returns exactly one commit, `1f1078a4`, which *added* the current
  text).
- Older runs' NDJSON is not on this box — only five `.ndjson` files remain under `.ai/cezar/runs/`,
  so the six-session, 16.9-minute figure cannot be independently re-derived here. It is cited from
  the KB note, not re-measured.
