# Meter the `document` step's fan-out now that the rewritten prompt is actually live

> **Status: MEASURED — FALSIFIED, 2026-08-22.** This is Phase 4 of
> `.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md`, filed as cezar todo
> `221cf511-4e18-4f7b-ba46-e20edf956a16` and picked up by task `fb62168a-6972-49f0-afb4-ffe9c4ec9b01`
> (`startedTaskId` on the todo already points here — no duplicate claim). **No code changes are
> required or proposed by this spec.** The finding did not require waiting on this run's own chain:
> five `spec-to-deploy` runs, unrelated to this task, had already finished a `document` step that
> both carries the rewritten prompt (Phase 3) and started after the deploy that shipped it (a fifth,
> `f2012c07`, finished mid-review and was folded in). All five
> read `subAgentCalls == 0`. The prompt-rewrite hypothesis (Phase 3's premise — that promoting the
> fan-out clause into `context`'s imperative voice would make `document` fan out the way `context`
> does, absent any task instruction telling it to) is **falsified on n=5**, cleanly, with no
> self-measurement caveat on any sample. See *Problem* for the corrected candidate rule and *Status
> log* for the numbers.

## TLDR

The measurement this task needs was already sitting on disk when this spec step ran; it did not
need to be produced by waiting on an in-flight run. Two things this document supersedes from an
earlier draft, written from the wrong assumption that no sample yet existed: (1) the deploy that
shipped the rewritten `document` prompt landed at `2026-08-21T21:03:27.076Z` (release
`20260821T210309Z-387ba439`, since pruned from the live `deploy.json`'s rolling 5-entry window but
independently reconstructed from the deploying run's own transcript), not the next day's unrelated
release; (2) checking against that correct timestamp, five **finished, foreign** runs already
qualify (a fifth, `f2012c07`, finished during this spec's own re-verification pass) — none confounded
by this task's own fan-out-shaped instructions, none read mid-step. All
five show `subAgentCalls == 0` on `document`. **The implementation is two in-place text edits**: fill
this file's *Status log* (already drafted below with the real numbers) and correct the parent
spec's Phase 4 row, both executed from this run's `implement` step — not `document`, and not a
poll-and-wait procedure.

## Problem

**The rewritten `document` prompt is live in production and has been since before this task
started.** Two independent facts establish this, verified directly rather than assumed:

1. `git merge-base --is-ancestor 5ef7e6539 387ba439` exits 0 — commit `5ef7e6539` (the Phase 3
   prompt rewrite) is an ancestor of `387ba439`, the commit the `e06f2169-…` deploy step pushed and
   deployed.
2. `e06f2169-7a55-4524-a035-7e5e8de8585b`'s own NDJSON records the release it activated:
   `{"id":"20260821T210309Z-387ba439","sha":"387ba439…","activatedAt":"2026-08-21T21:03:27.076Z"}`.
   This is the correct qualifying timestamp — **not** the current release
   (`20260822T014340Z-351626f5`, activated `2026-08-22T01:43:46.791Z`), which is a later,
   unrelated release (release-staging excludes, run-broker keepalive) that also happens to carry
   the same Phase 3 text but is not when it first shipped. `deploy.json`'s `keep: 5` window has
   since rolled past `20260821T210309Z-387ba439` — it is not in the current `releases` array — so
   this timestamp had to be reconstructed from the deploying run's own transcript, not read off
   the live deploy state.

**An earlier draft of this spec picked the wrong threshold and concluded, incorrectly, that no
sample existed yet.** It compared candidate runs against the *current* release's activation time
instead of the *first* release to carry the prompt, which pushed the qualifying window a full day
forward and hid four runs that already qualified. The robust test is not a timestamp lookup against
a possibly-pruned release list at all — `runs.json` persists each run's own `workflowDef`
(`packages/cezar/src/workflows/run.ts:1186` writes it, `:1884` reads it back), so a given run's exact
`document` prompt can be read directly off the run record:

```bash
python3 -c "
import json
for r in json.load(open('.ai/cezar/runs.json')):
    d = [s for s in (r.get('workflowDef') or {}).get('steps', []) if s.get('id') == 'document']
    if d and 'Then go WIDE. What the knowledge base already says' in d[0].get('prompt', ''):
        print(r['id'], r['status'])"
```

Combined with the corrected activation timestamp, the qualifying rule is: **a run's `document`
step-start timestamp is at/after `2026-08-21T21:03:27.076Z` AND its own persisted `workflowDef`
carries the rewritten prompt text AND the run's status is terminal (`done`)** — all three, not the
timestamp alone (a run could in principle be re-run with a stale cached `workflowDef`, though none
observed here were).

**Five runs already satisfy all three conditions, re-verified directly for this spec** (`cez run
stats <id> --json`, `document` step, plus the `workflowDef` prompt check and the `step-start` NDJSON
event). The fifth, `f2012c07`, finished `document` while this spec's `implement` step was
re-confirming the first four (caught by the review pass, re-verified directly here):

| run | own | child | trips | batch | `sub` | peak ctx | `document` step-start |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `f272fda8-3cbe-4c4a-924c-6fcd6d1243b4` | 25 | 0 | 25 | 1.00 | **0** | 140 770 | 2026-08-21T22:32:57.421Z |
| `0762e872-f6e5-4a51-b1b1-8a7df9cdf4e7` | 14 | 0 | 14 | 1.00 | **0** | 113 147 | 2026-08-22T00:11:02.214Z |
| `57f093be-b984-4d3d-9929-e259c6477636` | 21 | 0 | 21 | 1.00 | **0** | 125 766 | 2026-08-22T00:51:31.597Z |
| `d92e6b85-ae6f-4398-b923-3c76ccbb083f` | 32 | 0 | 32 | 1.00 | **0** | 128 025 | 2026-08-22T01:38:59.800Z |
| `f2012c07-f201-4f17-804a-e8ff7fa1ffd8` | 16 | 0 | 16 | 1.00 | **0** | 120 072 | 2026-08-22T02:04:19.403Z |

None of these five tasks' own instructions mention fan-out, sub-agents, or this metering effort — so
unlike the confound below, a nonzero `sub` here would have been attributable to the prompt alone. It
is 0 on all five.

**Two further runs were checked and correctly excluded**: `f0d48513`/`e06f2169`-adjacent runs
`70f19253-cf6b-407c-92e0-96a8020a8ebb` and `e06f2169-7a55-4524-a035-7e5e8de8585b` both persist
`NEW_DOC_PROMPT = False` in their own `workflowDef` (created `2026-08-21T19:19:xx`, well before the
rewrite even merged) — correctly excluded, not part of the n=5 sample. `e06f2169`'s `document` step
is nonetheless informative as a **negative control**, already recorded in the parent spec's own
status log (`.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md:780`, "`document`,
before and after" table): under the OLD prompt it read `sub 3`, but only because that run's own task
instructions were explicitly about metering fan-out (the parent spec's own words, lines 665-666:
*"this step ran under the OLD prompt and fanned out because its *own instructions* said to"*). That is the
exact confound the next section rules out for this task's own chain.

**A second thing the earlier draft got wrong: it proposed metering this run's own `document` step as
a fallback, and that path is not just unnecessary now (the n=5 sample above makes it moot) — it
would have been methodologically invalid even if no foreign sample existed.** This task's own goal
statement is literally "Meter the document step's fan-out" — so this run's own `document` step, were
it read, would carry the same confound as `e06f2169` above: a `sub ≥ 1` result on *this* run's
`document` step would be indistinguishable from task-instruction-driven fan-out, exactly what the
todo's own scoping question rules out (parent spec, lines 762-763: *"does the rewritten prompt make a
`document` step choose fan-out when nothing in the task instructions tells it to?"*). This run's own
`document`/`deploy` steps are therefore **not used** for this measurement at all, confounded or not
— the n=5 foreign sample above is the entire evidentiary basis.

## Solution

**No code.** The "implementation" is two in-place text edits, made from this run's `implement`
step — not `document`. `document` was the natural-seeming home in an earlier draft only because it
is nominally "the step that writes records," but it is not distinguished from `implement` for this
purpose: `DEFAULT_ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash']`
(`packages/cezar/src/workflows/types.ts:251`) is shared by `implement` (`:805`), `run-tests`
(`:835`) and `deploy` (`:1024`) alike; `document`'s only addition is `Task` (`:956`), which is
irrelevant to reading `cez run stats` or editing two markdown files. Using `implement` also sidesteps
the confound above entirely, since `implement`'s own prompt has nothing to do with fan-out or
metering.

**Edit 1 — this file's `## Status log — 2026-08-22` section** (below): filled in with the
five-run table from *Problem* (the fifth, `f2012c07`, folded in once it finished mid-review), the
comparison against both `document` baselines, and the falsification statement satisfying the todo's
third acceptance criterion. `implement` re-runs the *Problem* section's verification commands once
more immediately before finalizing (Phase 1 below) and only touches this section again if a sixth
qualifying run has appeared or a number has changed — otherwise it is confirmed unchanged as-is.

**Edit 2 — the parent spec**, `.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md`,
corrected in place per the workspace's "a correction marks what it invalidates, in place" rule
(`CLAUDE.md` sync rule 3a), not appended beside stale text:

- Its `## Status log — 2026-08-21` "What landed" table has a row `4 — runtime A/B | **no, and
  cannot here** | filed as cezar todo 221cf511-…`. That statement is now false — edit the cell to
  point at this spec's Status log for the falsified result, per the format the "What landed" table
  already uses for the other three rows.
- Its top-of-file status banner (wherever it currently states Phase 4 is outstanding, e.g. the
  `Phase 4 is a follow-up by construction` sentence at line 604) gains a note that Phase 4 closed as
  a falsification, pointing here — **not** rewritten to claim the fan-out adoption succeeded; a
  falsification is a closed measurement, not an open one, and the banner should say which it is.

**The cezar todo** (`221cf511-4e18-4f7b-ba46-e20edf956a16`) has no direct CLI action available —
`cezar todo --help` exposes only `add`/`list`, no `done`/`update` subcommand (re-verified for this
spec). Its `startedTaskId` already points at this task; nothing further to do here beyond finishing
the task honestly, same as the earlier draft already concluded.

**No further prompt iteration.** Per the parent spec's own rule (R2 / §V4 step 5: do not iterate a
second time inside this follow-up task), the falsification is recorded and this task stops there.
The named fallback — a `fanned-out` postcondition — stays explicitly out of scope, same blocker the
parent spec already identified: `PostconditionContext` does not carry a run/step id
(`packages/cezar/src/workflows/postconditions.ts:48-68`, `packages/cezar/src/workflows/run.ts:5468`,
the `evaluatePostcondition` call site, passing only `{ cwd, workspaceRun }`).
Do not start that plumbing without a separate spec for it.

## Architecture

No new components. This reuses, unchanged:

```
.ai/cezar/runs.json + .ai/cezar/runs/<id>.ndjson   (already written by every run)
        │
        ▼
cez run stats <id> --repo <dir> [--json]   (packages/cezar/src/runs/stats.ts, stats-cli.ts — Phases 1-2, already deployed)
        │
        ▼
this run's `implement` step reads the five foreign candidates' stats (already done once, for this
spec; re-confirmed once more by `implement` before finalizing) and writes the result into:
  - .ai/specs/2026-08-22-document-fanout-post-deploy-metering.md  (this file, § Status log)
  - .ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md  (Phase 4 row + banner, corrected in place)
```

`document` and `deploy` in this run's own chain do not participate in the *measurement* at all (see
*Problem*'s confound discussion) — they run normally afterward, empty of fan-out-metering content.
That exclusion is from the measurement only, not from the record: a falsified hypothesis is durable
knowledge, so `document` should still write this finding to the KB (`cez kb`) as part of its normal
per-run knowledge-sync duty, same as any other run's `document` step would.

## Data models

None. No schema changes anywhere — `StepStats`, `RunStats`, `runs.json` and the NDJSON event shapes
are exactly as Phases 1–2 of the parent spec left them.

## API / interface contracts

None new. `cez run stats <runId> [--json] [--repo <dir>]` is the only surface touched, and it is
already shipped (`packages/cezar/src/runs/stats-cli.ts:9,45`). Confirmed shape for this spec by
reading `cez run stats <id> --json` on all five candidates: each step object carries
`ownToolCalls`, `childToolCalls`, `roundTrips`, `batchFactor`, `subAgentCalls`, `peakContextTokens`
alongside `wallMs`, `toolCalls`, `restarts` and the cheap/sleep/heredoc counters added since the
parent spec's own example.

## Phases

Each independently checkable; all five run from this chain's `implement` step.

1. **Re-confirm the two facts *Problem* establishes**, immediately before writing anything — the
   ancestor check (`git merge-base --is-ancestor 5ef7e6539 387ba439`) and the five-candidate table
   (`cez run stats <id> --json` on each of `f272fda8`, `0762e872`, `57f093be`, `d92e6b85`, `f2012c07`),
   rather than trusting this spec's write-time snapshot. Also re-run the `workflowDef` prompt-carriage
   check from *Problem* in case `runs.json` has since been pruned or rewritten.
2. **Confirm this file's `## Status log — 2026-08-22` section still matches** the re-confirmed
   numbers from step 1; edit it only if something changed (a fifth qualifying run appeared, or a
   number differs), otherwise leave as-is.
3. **Correct the parent spec's Phase 4 row and status banner in place**, per *Solution* Edit 2.
4. **Do not iterate the prompt.** Falsification is the result; stop here per the parent spec's own
   R2 / §V4 step 5.
5. **Commit both files.** `run-tests` is a genuine no-op — no code changed, nothing for
   `npm run typecheck` / `npm test` to catch beyond the repo's standard gates, which apply as normal
   to any unrelated edit elsewhere in this chain, not introduced by this spec. `commit-push` commits
   the two markdown edits.

## Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | The five-run sample is all `spec-to-deploy` runs of a similar shape (record-gathering/fan-out-adoption-flavored chains), not a controlled cross-task A/B. | Named as an inherent limit, consistent with the parent spec's R10; the categorical `sub == 0` reading across all five (not a single sample) is the load-bearing claim, not any one run's exact own-call count. |
| R2 | A later deploy reverted or further edited the Phase 3 prompt between this spec being written and `implement` executing. | Phase 1 re-runs the ancestor check and the `workflowDef` prompt-carriage grep immediately before finalizing, rather than trusting this spec's write-time snapshot. |
| R3 | `cezar todo`'s CLI has no way to mark `221cf511-…` done directly. | Confirmed via `cezar todo --help` (only `add`/`list`); left to the cockpit's own reconciliation from `startedTaskId`, not worked around with a direct `todos.json` edit that could race the cockpit's own writer. |
| R4 | An earlier draft of this spec exists on the **local `main`** checkout (`/var/lib/cezar/loki-labs/cezar`) — but it is not untracked; it is **committed** there as `c73c8a2d "msg"` (2026-08-22T02:04:11Z), a stray commit that also swept up three unrelated tasks' briefs (`release-staging-exclude-worktrees-tmp`, `run-tests-phase4-gather`, `sleep-doctrine-phase-4-after-run`). That commit is on local `main` and on `cez/06a8d677`, but **not on `origin/main`** (re-verified: `origin/main` has since moved to `a97e1427`, still without `c73c8a2d`). Because this task's branch (`cez/fb62168a`) also branches from `351626f5` and adds the same path with different content, merging local `main` into this branch (or the reverse) is a guaranteed add/add conflict on this exact file — and resolving it the wrong way, or taking `c73c8a2d`'s side, would silently ship the superseded draft (still banner-marked `SPEC WRITTEN, NOT YET EXECUTED`) in place of this falsified, corrected version. | `commit-push` merges/pushes against **`origin/main`** only (which lacks `c73c8a2d`), never against local `main`. If local `main` is touched at all and the conflict appears, resolve `.ai/specs/2026-08-22-document-fanout-post-deploy-metering.md` in favor of **this branch's** version, then confirm the landed file's banner reads `MEASURED — FALSIFIED`, not `SPEC WRITTEN, NOT YET EXECUTED` (added to *Verification* step 5 below). `c73c8a2d` is someone else's stray junk commit, not this task's to clean up — flag it in this task's final report rather than silently merging or discarding it. |
| R5 | Reading `cez run stats` from this worktree instead of the deployed build could pick up an unreleased/different meter implementation. | `cez`/`cezar` are global wrapper scripts (`/usr/local/bin/cez` → `exec node /opt/cezar/packages/cezar/dist/index.js "$@"`) that always run the deployed build regardless of invoking cwd, so `cez run stats <id> --repo /var/lib/cezar/loki-labs/cezar` reads the fixed meter (Phases 1–2) from any worktree — re-verified for this spec, not just inferred from the earlier draft's brief. |

## Verification

Concrete, executable, run from this task's `implement` step:

1. **Prompt-shipping deploy still an ancestor of current `HEAD`, and its activation timestamp still
   holds:** (paths below are absolute — this task's own worktree, `.ai/cezar/worktrees/fb62168a-…`,
   has no `.ai/cezar/` of its own; only the real repo checkout does, so a relative path silently
   resolves to nothing rather than erroring)
   ```bash
   git merge-base --is-ancestor 5ef7e6539 387ba439 && echo "ancestor OK"
   grep -o 'activatedAt\\*":\\*"2026-08-21T21:03:27.076Z' \
     /var/lib/cezar/loki-labs/cezar/.ai/cezar/runs/e06f2169-7a55-4524-a035-7e5e8de8585b.ndjson | head -1
   # (the release JSON is embedded in an escaped tool-output string, so the on-disk bytes are
   # `sha\":\"387ba439…\",\"activatedAt\":\"2026-08-21T21:03:27.076Z\"` — an unescaped-quote
   # pattern matches nothing here. `grep -c '21:03:27.076' <same file>` → 4 is an equally valid check,
   # re-run directly against this file for this revision.)
   ```
2. **Re-enumerate qualifying candidates** (prompt-carriage + terminal status, per *Problem*):
   ```bash
   python3 -c "
   import json
   for r in json.load(open('/var/lib/cezar/loki-labs/cezar/.ai/cezar/runs.json')):
       d = [s for s in (r.get('workflowDef') or {}).get('steps', []) if s.get('id') == 'document']
       if d and 'Then go WIDE. What the knowledge base already says' in d[0].get('prompt', ''):
           print(r['id'], r['status'])"
   ```
   then for each `done` id printed, cross-check its `document` step-start ts is
   `>= 2026-08-21T21:03:27.076Z`:
   ```bash
   grep -o '"type":"step-start"[^}]*"stepId":"document"[^}]*"ts":"[^"]*"' \
     /var/lib/cezar/loki-labs/cezar/.ai/cezar/runs/<id>.ndjson | head -1 | grep -o '"ts":"[^"]*"'
   ```
3. **Re-read each candidate's `document` row:**
   ```bash
   cez run stats <id> --repo /var/lib/cezar/loki-labs/cezar --json \
     | python3 -c "import json,sys; d=json.load(sys.stdin); \
         s=[x for x in d['steps'] if x['stepId']=='document'][0]; \
         print({k: s.get(k) for k in ('ownToolCalls','childToolCalls','roundTrips','batchFactor', \
                                       'subAgentCalls','peakContextTokens')})"
   ```
4. **Assert / record** (manual — this is a runtime measurement, not a unit test):
   - `document.subAgentCalls >= 1` on any qualifying candidate → **AC1 met** (not the case here on
     any of the five; `== 0` on all → falsification, **AC3** satisfied by the *Status log* section
     below).
   - `document.ownToolCalls` and `document.peakContextTokens` recorded beside `c10864d1` (38 /
     141 783) and `7c2dd8f0` (45 / 167 235) in this file's status log → **AC2 met** regardless of
     direction (the acceptance criterion is that the numbers are *recorded beside* the baselines,
     not that they beat a threshold) — already done below.
5. **Both status logs updated**: this file's `## Status log — 2026-08-22` section (already filled
   in below); the parent spec's Phase 4 row and banner edited in place, not just appended beside.
   Also confirm this file's own top-of-file banner still reads `MEASURED — FALSIFIED` (not
   `SPEC WRITTEN, NOT YET EXECUTED`) once `commit-push` has run — see R4: a wrong-side add/add
   conflict resolution against local `main`'s stray `c73c8a2d` commit would silently reintroduce
   the superseded draft's banner and lose this finding.
6. **No regression check needed** — no code changed. If `implement`/`run-tests`/`commit-push` touch
   any `.ts` file for an unrelated reason, the repo's standard gates still apply to that unrelated
   edit — not introduced by this spec.

## Sources read

- Brief: `.ai/specs/briefs/2026-08-22-document-fanout-post-deploy-metering.md` (full) — including its
  review feedback, which caught the timestamp error this revision fixes.
- `.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md` (full — TLDR through the
  `## Status log — 2026-08-21` section; specifically lines 601-797 for the "What landed" table, the
  Phase 4 filed-todo block at lines 750-763, the `e06f2169` negative-control table and the
  mid-step-rises-34k lesson at lines 774-797).
- `.ai/cezar/todos.json` — read the `221cf511-4e18-4f7b-ba46-e20edf956a16` entry directly (status
  `todo`, `startedTaskId: fb62168a-…`, all three acceptance criteria verbatim).
- `.ai/cezar/runs.json` — read directly for this spec: `workflowDef.steps[document].prompt` on
  `f272fda8`, `0762e872`, `57f093be`, `d92e6b85`, `f2012c07` (all carry the rewritten paragraph, all
  `status: done`) and on `70f19253`/`e06f2169` (both carry the OLD prompt, correctly excluded).
- `.ai/cezar/runs/<id>.ndjson` for all seven ids above — `step-start`/`document` timestamps, and
  `e06f2169`'s own deploy-activation event (`activatedAt: 2026-08-21T21:03:27.076Z` for release
  `20260821T210309Z-387ba439`) reconstructed directly since `deploy.json`'s `keep: 5` window has
  since pruned that release from its live `releases` array (re-read directly: current array holds
  only `531ab96d`, three `6fdbe35e` builds, and `351626f5` — no `387ba439`).
- `cez run stats <id> --repo /var/lib/cezar/loki-labs/cezar --json` for all five qualifying
  candidates — full step objects re-read directly for this spec, not taken from any prior brief.
- `packages/cezar/src/workflows/types.ts:251` (`DEFAULT_ALLOWED_TOOLS`), `:805` (`implement`),
  `:835` (`run-tests`), `:936-1010` (`document`, `allowedTools` at `:956` adds only `Task`),
  `:1012-1066` (`deploy`) — confirmed `implement`/`run-tests`/`deploy` all hold
  `DEFAULT_ALLOWED_TOOLS` (`Read`/`Edit`/`Write`/`Grep`/`Glob`/`Bash`), so `document` is not
  distinguished from `implement` for this task's purposes.
- `packages/cezar/src/workflows/postconditions.ts:48-68`, `packages/cezar/src/workflows/run.ts:5468`
  — confirmed the `fanned-out` postcondition fallback's blocker (`PostconditionContext` carries no
  run/step id) is still unaddressed, unchanged from the parent spec's own note.
- `cezar todo --help` — confirmed only `add`/`list` exist, no `done`/`update` subcommand.
- `git merge-base --is-ancestor 5ef7e6539 387ba439` (exit 0) and `git show -s --format='%H %ci %s'
  387ba439` — re-run directly for this spec.
- **Not found / not chased:** no further foreign candidates beyond the five listed were checked
  exhaustively (the five already give a clean, unambiguous falsification; a sixth would not change
  the categorical reading). `implement`'s Phase 1 re-scan (Verification step 2) already picked up the
  fifth (`f2012c07`) once it finished mid-review, and would pick up any that appear later the same way.

---

## Status log — 2026-08-22

**Candidate set:** five finished, foreign `spec-to-deploy` runs whose `document` step both carries
the rewritten prompt (Phase 3) in its own persisted `workflowDef` and started at/after
`2026-08-21T21:03:27.076Z`, the activation of the release that first shipped it
(`20260821T210309Z-387ba439`). The fifth (`f2012c07`) finished `document` after this spec's first
draft but before `implement`'s Phase 1 re-scan, and was folded in there. None of the five tasks' own
instructions mention fan-out or this metering effort, so no self-measurement or task-instruction
confound applies to any of them.

**Raw numbers:**

| run | own calls | child | trips | batch | `sub` | peak ctx |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `c10864d1` (baseline, pre-deploy, OLD prompt) | 38 | 0 | 38 | 1.00 | 0 | 141 783 |
| `7c2dd8f0` (baseline, pre-deploy, OLD prompt) | 45 | 0 | 44 | 1.02 | 0 | 167 235 |
| `f272fda8` (post-deploy, NEW prompt) | 25 | 0 | 25 | 1.00 | **0** | 140 770 |
| `0762e872` (post-deploy, NEW prompt) | 14 | 0 | 14 | 1.00 | **0** | 113 147 |
| `57f093be` (post-deploy, NEW prompt) | 21 | 0 | 21 | 1.00 | **0** | 125 766 |
| `d92e6b85` (post-deploy, NEW prompt) | 32 | 0 | 32 | 1.00 | **0** | 128 025 |
| `f2012c07` (post-deploy, NEW prompt) | 16 | 0 | 16 | 1.00 | **0** | 120 072 |

For reference, not part of the A/B (OLD prompt, but a task whose own instructions were explicitly
about fan-out metering — the confound this task's own chain avoids by not using its own `document`
step): `e06f2169` read `own 29 / trips 29 / batch 1.00 / sub 3 / peak ctx ~138 700` on `document`
(parent spec, `## Status log — 2026-08-21`, "The `document` step that wrote this log" table).

**Acceptance criteria, as read against the candidate set above:**

- [ ] `subAgentCalls >= 1` on `document` — **measurement complete; hypothesis falsified.** `sub == 0`
      on all five post-deploy runs, so AC1 as literally worded ("shows subAgentCalls >= 1") is NOT
      MET. Left unchecked deliberately, rather than `[x]`, so a checkbox scan doesn't read as the
      opposite of the finding — the measurement is done even though the criterion isn't satisfied.
- [x] `peakContextTokens` and `ownToolCalls` recorded beside both baselines — done, table above.
- [x] The falsification is written into this spec's status log — this section.

**Finding: the Phase 3 prompt-rewrite hypothesis is falsified on n=5.** Promoting the fan-out clause
into `context`'s imperative voice did not make `document` choose to dispatch sub-agents absent a
task instruction telling it to, on any of the five clean post-deploy samples available. Per the
parent spec's own R2 / §V4 step 5, this task does not iterate the prompt a second time — the result
is recorded and the task stops here. The named fallback (a `fanned-out` postcondition, forcing
dispatch rather than hoping the prompt persuades it) remains explicitly out of scope, blocked on
`PostconditionContext` plumbing (see *Solution*), and would need its own spec.
