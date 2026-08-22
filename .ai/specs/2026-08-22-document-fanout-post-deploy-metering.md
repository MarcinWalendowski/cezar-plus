# Meter the `document` step's fan-out now that the rewritten prompt is actually live

> **Status: SPEC WRITTEN, NOT YET EXECUTED — 2026-08-22.** This is Phase 4 of
> `.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md`, filed as cezar todo
> `221cf511-4e18-4f7b-ba46-e20edf956a16` and picked up by task `fb62168a-6972-49f0-afb4-ffe9c4ec9b01`
> (`startedTaskId` on the todo already points here — no duplicate claim). **No code changes are
> required or proposed by this spec** — the meter fix (Phase 1), `peakContextTokens` (Phase 2) and
> the rewritten `document` prompt (Phase 3) are already merged to `main` and confirmed live in
> production (see *Problem*). What remains is pure measurement: pick a `document` step that ran
> under the deployed prompt, read its numbers once it has closed, and write them down — including a
> falsification if `subAgentCalls` is still 0. This document records the procedure and the decision
> rules; the *Status log* section at the foot of this file is where the actual numbers land once a
> later step in this same run's chain executes them.

## TLDR

Everything Phase 4 needs is already shipped and already running in production; nothing here writes
code. The one open item is that **no run's `document` step has yet executed entirely after the
deploy that shipped the rewritten prompt** (`release 20260822T014340Z-351626f5`, activated
`2026-08-22T01:43:46.791Z`) — so there is no sample to read yet. This spec is the decision
procedure for producing and reading that sample once it exists: which run counts as a valid
candidate, in what order to prefer them, how to avoid the "read a step's peak context before it
closes and get a lower bound" trap the parent spec's own Phase 4 attempt already fell into once,
and exactly where the result gets written down (both this file's status log and, per the
workspace's own correction-in-place rule, the parent spec's Phase 4 row).

## Problem

**The rewritten `document` prompt is live in production, right now, and there is nothing left to
build.** Three independent checks agree:

1. `/opt/cezar-releases/deploy.json` — `"current": "20260822T014340Z-351626f5"`, `sha:
   351626f561435bdbbd4667add85ed9ae2d33dd03`, `activatedAt: 2026-08-22T01:43:46.791Z`, `healthy:
   true` (re-read directly for this spec, matches the brief).
2. `GET http://127.0.0.1:4321/api/v1/health` — `"deploy":{"releaseId":"20260822T014340Z-351626f5",
   "sha":"351626f561435bdbbd4667add85ed9ae2d33dd03","activatedAt":"2026-08-22T01:43:46.791Z"}`
   (re-fetched directly for this spec).
3. `grep -n "go WIDE\|worth a minute of work" /opt/cezar/packages/cezar/dist/workflows/types.js`
   — the rewritten `document` clause is present verbatim at the deployed bundle's own lines 951 and
   960 (re-grepped directly for this spec, not inferred from source).

`cez`/`cezar` are global wrapper scripts (`/usr/local/bin/cez` → `exec node
/opt/cezar/packages/cezar/dist/index.js "$@"`) that always run this deployed build regardless of
invoking cwd, so `cez run stats <runId> --repo /var/lib/cezar/loki-labs/cezar` reads any run's
NDJSON with the fixed meter (Phases 1–2) no matter which worktree runs the command.

**What is missing is a sample, not a mechanism.** As of this spec being written (2026-08-22,
~01:50Z), one run had already reached `document` and finished: `d92e6b85-ae6f-4398-b923-3c76ccbb083f`
— but its `document` step's `step-start` event is timestamped `2026-08-22T01:38:59.800Z` (re-verified
by grepping its own NDJSON for this spec: `{"type":"step-start","stepId":"document",...,"ts":
"2026-08-22T01:38:59.800Z"}`), **5 minutes before** the `01:43:46.791Z` deploy — so it ran the OLD
prompt and is not usable for this A/B (`cez run stats` on it: `document` own 32, sub 0, peak ctx
128 025 — consistent with the two pre-deploy baselines, not a contradiction). Four other
`spec-to-deploy` runs were in flight, all started at/after the deploy
(`bde0ec40-06da-4628-8410-06a6a42694c7`, `f2012c07-f201-4f17-804a-e8ff7fa1ffd8`,
`95d3c6f2-7e11-4a1d-826c-e03a5a5a168b`, `49a5aea3-a85d-41e2-ac5e-0f4e5fe36a1b`, plus
`8ae78391-832e-4788-b413-67848bb7aedf`), re-checked directly for this spec via `cez run stats` on
each — none had reached `document` yet (all still in `context`/`spec`/`review-spec`/`implement`).
This task's own run (`fb62168a-6972-49f0-afb4-ffe9c4ec9b01`) is itself one of those five, currently
on this very `spec` step (step 2 of 8 in its own `spec-to-deploy` chain:
`context → spec → review-spec → implement → run-tests → commit-push → document → deploy`,
`packages/cezar/src/workflows/types.ts:553-1043`).

**The self-measurement trap, already paid for once.** The parent spec's own `document` step
(`e06f2169-…`) read its own in-flight transcript mid-step and reported `own 13 / peak ctx 104.7k`;
by the time the step actually finished, the true numbers were `own 29 / peak ctx 138.7k` — a 34k
rise in peak context alone, from writing the very act of recording it. The parent spec's own
lesson, quoted verbatim because it governs this spec's procedure: *"an in-flight step cannot
measure its own peak context, because the act of writing the measurement raises it… Only
`ownToolCalls` and `sub` are safe to read from inside the step."* Any procedure this spec proposes
has to either read a **different, already-finished** run, or accept and clearly label a **lower
bound** if it reads its own not-yet-closed step — the same accepted, precedented pattern the parent
spec's own status log already used and labeled honestly rather than treating as a closed result.

## Solution

No code. The "implementation" is a decision procedure, executed from a **later step in this same
run's chain** — specifically the `document` step (step 7 of 8), which is the one step in this
workflow that already holds `Edit`/`Write`/`Bash`/`Task` and is already responsible for writing
records (`types.ts:936-1010`; it commits its own edits, `verify: { builtin: 'everything-committed'
}`). No new step, no new automation, no cron, no watcher process — this rides the workflow that is
already running.

**Candidate selection, in preference order:**

1. **Prefer an already-finished foreign run.** At the time the `document` step of this run
   executes, list `spec-to-deploy` runs with `status: "done"` in `.ai/cezar/runs.json` (excluding
   this run's own id) and check each candidate's `document` step-start timestamp
   (`grep -o '"type":"step-start"[^}]*"stepId":"document"[^}]*' .ai/cezar/runs/<id>.ndjson`, read
   the `"ts"` field) against the deploy activation time, `2026-08-22T01:43:46.791Z`. Any candidate
   whose `document` step started at or after that timestamp is a clean sample — no self-measurement
   caveat needed, because it is read from a run that is no longer executing at all. If more than one
   qualifies, prefer the one whose `document` step finished **earliest** (closer in time to this
   spec, reducing the chance an unrelated later change shifts the baseline further).
2. **Fall back to this run's own `document` step**, read as late as possible within the step's own
   execution — after the knowledge/spec/tracker writes are done, as the last action before the step
   ends its turn. This is the same pattern the parent spec's own `document` step already used and
   the workspace already accepted as a labeled lower bound, not a closed result. `ownToolCalls` and
   `subAgentCalls` are safe to read at this point (per the parent spec's own stated rule); report
   `peakContextTokens` explicitly as a **lower bound, not a settled figure** if this path is taken.
3. **Before treating either candidate as "post-deploy," re-confirm the running deployment still
   carries the fixed prompt** (`grep` the deployed `dist/workflows/types.js` for the same strings
   used in *Problem*, and cross-check `deploy.json`'s `current` field). If a *later* deploy has
   happened in the interim (e.g. from a concurrent task), that is still fine as long as it did not
   revert the Phase 3 prompt — nothing in flight is expected to touch `document`'s fan-out clause
   again, but this is a one-line check worth doing rather than assuming.

**Reading the numbers**, either path:

```bash
cez run stats <candidateRunId> --repo /var/lib/cezar/loki-labs/cezar --json \
  | python3 -c "import json,sys; d=json.load(sys.stdin); \
      s=[x for x in d['steps'] if x['stepId']=='document'][0]; \
      print({k: s.get(k) for k in ('ownToolCalls','childToolCalls','roundTrips','batchFactor', \
                                    'subAgentCalls','peakContextTokens')})"
```

(the human table via `cez run stats <id> --repo /var/lib/cezar/loki-labs/cezar`, reading the
`document` row's `own` / `child` / `trips` / `batch` / `sub` / `ctx k` columns, is equivalent and
fine to quote instead of the JSON — whichever is more convenient at execution time).

**Where the result is written**, in the same step, per the workspace's "a correction marks what it
invalidates, in place" rule (`CLAUDE.md` sync rule 3a) rather than only appended beside stale text:

1. **This file** — a `## Status log — 2026-08-22` section is appended at the foot (see the stub
   below), recording which candidate was chosen and why, the raw numbers, the comparison against
   both `document` baselines (`c10864d1`: own 38 / trips 38 / batch 1.00 / sub 0 / peak ctx 141 783;
   `7c2dd8f0`: own 45 / trips 44 / batch 1.02 / sub 0 / peak ctx 167 235), and the pass/fail read
   against each of the three todo acceptance criteria.
2. **The parent spec**, `.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md` — its
   own `## Status log — 2026-08-21` "What landed" table has a row `4 — runtime A/B | **no, and
   cannot here** | filed as cezar todo 221cf511-…`. That row states a fact that becomes stale the
   moment this spec's measurement lands, so it gets edited in place (not left to read as current)
   to point at this spec's own status log for the actual numbers, per the same correction-in-place
   rule. The parent spec's top status banner should also gain one line noting Phase 4 closed
   (measured or falsified) and pointing here — it should NOT be rewritten to claim "Phase 4:
   closed" if the result is a falsification; falsified is also a closed measurement, and the banner
   should say which.
3. **The cezar todo** (`221cf511-4e18-4f7b-ba46-e20edf956a16`) — the `cezar todo` CLI here only
   supports `add`/`list` (verified: `cezar todo --help`), no `done`/`update` subcommand, so there is
   no direct CLI action to take. Its `startedTaskId` already points at this task
   (`fb62168a-6972-49f0-afb4-ffe9c4ec9b01`); the cockpit is expected to reconcile the todo's status
   from this task's own completion. Nothing further to do here beyond finishing the task honestly.

**If `subAgentCalls` is still 0 on the chosen candidate:** write the falsification plainly in both
status logs — the prompt-form hypothesis (Phase 3's premise: rewriting the clause into `context`'s
imperative-paragraph voice would make `document` fan out the way `context` does) did not hold on
this sample. Per the parent spec's own R2/§V4 step 5: **do not iterate the prompt a second time
inside this task** — record what was tried and stop. The named fallback (a `fanned-out`
post-condition) is out of scope here exactly as the parent spec already scoped it: blocked on
`PostconditionContext` not carrying a run/step id (`postconditions.ts:48-68`, `run.ts:5292`,
`5342`), and explicitly "do not start Phase 4's fallback without a separate spec for that
plumbing." If falsified, this spec's own status banner should say so and, if warranted, name (but
not build) that follow-up spec as the next step.

## Architecture

No new components. This reuses, unchanged:

```
.ai/cezar/runs/<id>.ndjson  (already written by every run)
        │
        ▼
cez run stats <id> --repo <dir> [--json]   (packages/cezar/src/runs/stats.ts, stats-cli.ts — Phases 1-2, already deployed)
        │
        ▼
this run's own `document` step (types.ts:936-1010) reads a candidate's stats,
writes the result into:
  - .ai/specs/2026-08-22-document-fanout-post-deploy-metering.md  (this file, § Status log)
  - .ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md  (Phase 4 row, corrected in place)
```

The only "new" wiring is the candidate-selection procedure above, which is a decision rule an agent
follows, not code.

## Data models

None. No schema changes anywhere — `StepStats`, `RunStats`, `runs.json` and the NDJSON event shapes
are exactly as Phases 1–2 of the parent spec left them.

## API / interface contracts

None new. `cez run stats <runId> [--json] [--repo <dir>]` is the only surface touched, and it is
already shipped (`packages/cezar/src/runs/stats-cli.ts:9,45`; JSON shape confirmed for this spec by
reading `cez run stats d92e6b85-… --json`, which returns `ownToolCalls`, `childToolCalls`,
`roundTrips`, `batchFactor`, `subAgentCalls`, `peakContextTokens` per step, e.g. the `document` step
of `d92e6b85` reads `{"ownToolCalls":32,"childToolCalls":0,"roundTrips":32,"batchFactor":1,
"peakContextTokens":128025,"subAgentCalls":0,...}`).

## Phases

Each independently checkable; 1–2 can happen anywhere in this run's chain, 3–5 must happen from the
`document` step specifically (it is the step with write/commit authority in this workflow).

1. **Confirm the deploy is still live and unreverted**, immediately before reading any candidate —
   the three-way check in *Problem*, re-run rather than trusted from this spec's write-time.
2. **Select a candidate** per the preference order in *Solution*: an already-`done` foreign run
   whose `document` step started at/after `2026-08-22T01:43:46.791Z`, else this run's own
   `document` step read late and labeled a lower bound.
3. **Read the candidate's `document` row** (`cez run stats`, human table or `--json`) and compute
   the deltas against both recorded baselines.
4. **Write the result** into this file's status log and correct the parent spec's Phase 4 row in
   place, per *Solution* point 2 above.
5. **If `subAgentCalls == 0`**, write the falsification explicitly in both places (this satisfies
   the todo's third acceptance criterion verbatim) and stop — no second prompt edit in this task.

## Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | No foreign run finishes `document` before this run reaches its own `document` step, forcing the self-read fallback. | Explicitly planned as path 2, with the lower-bound caveat carried through to the write-up rather than silently rounded to a "closed" result — same posture the parent spec already modeled. |
| R2 | A self-read still understates `peakContextTokens` even taken "as late as possible," because the step keeps writing after the read. | Labeled a lower bound in the status log, never claimed as the settled figure — matches the parent spec's own Criterion 2 write-up, which is the precedent for this exact situation. |
| R3 | n=1 on a *different* task than either baseline — peak context and own-call count are task-shaped, per the parent spec's R10. | Reported with that caveat attached; the categorical `sub ≥ 1` (or `sub == 0`, falsified) reading is the only claim treated as non-directional. |
| R4 | A concurrent task deploys again before this run's `document` step executes, and (hypothetically) reverts or further edits the Phase 3 prompt. | Phase 1 of *Phases* re-checks the deployed bundle immediately before reading any candidate, rather than trusting this spec's write-time snapshot. |
| R5 | The chosen foreign candidate is a very different shape of task than the two `document` baselines (both were record-gathering/fan-out-adoption tasks), so its own-call count is not a fair like-for-like comparison. | Named as an inherent limit of a single-sample A/B, consistent with the parent spec's R10 — not something this spec can control by picking a "better" candidate, since only one or two will exist for a while. |
| R6 | `cezar todo`'s CLI has no way to mark `221cf511-…` done directly. | Confirmed via `cezar todo --help` (only `add`/`list`); left to the cockpit's own reconciliation from `startedTaskId`, noted rather than worked around with a direct `todos.json` edit that could race the cockpit's own writer. |

## Verification

Concrete, executable, run from the `document` step of this task's own chain (or, if a foreign
candidate is ready sooner, run manually against that candidate's id — the commands are identical):

1. **Deploy is still live and unreverted:**
   ```bash
   cat /opt/cezar-releases/deploy.json | python3 -m json.tool | grep -A2 '"current"'
   curl -s http://127.0.0.1:4321/api/v1/health | python3 -c "import json,sys; print(json.load(sys.stdin)['deploy'])"
   grep -n "go WIDE\|worth a minute of work" /opt/cezar/packages/cezar/dist/workflows/types.js
   ```
2. **Enumerate candidates:**
   ```bash
   cd /var/lib/cezar/loki-labs/cezar
   for f in .ai/cezar/runs/*.ndjson; do
     id=$(basename "$f" .ndjson)
     [ "$id" = "fb62168a-6972-49f0-afb4-ffe9c4ec9b01" ] && continue
     ts=$(grep -o '"type":"step-start"[^}]*"stepId":"document"[^}]*"ts":"[^"]*"' "$f" | head -1 | grep -o '"ts":"[^"]*"' | cut -d'"' -f4)
     [ -n "$ts" ] && [ "$ts" '>' "2026-08-22T01:43:46.791Z" ] && echo "$id started document at $ts"
   done
   ```
3. **Read the chosen candidate:**
   ```bash
   cez run stats <candidateRunId> --repo /var/lib/cezar/loki-labs/cezar
   cez run stats <candidateRunId> --repo /var/lib/cezar/loki-labs/cezar --json > /tmp/doc-stats.json
   ```
4. **Assert / record** (manual, not a unit test — this is a runtime measurement, not code):
   - `document.subAgentCalls >= 1` → **AC1 met**; `== 0` → falsification, write it down (**AC3**).
   - `document.ownToolCalls` and `document.peakContextTokens` recorded beside `c10864d1` (38 /
     141 783) and `7c2dd8f0` (45 / 167 235) in this file's status log → **AC2 met** regardless of
     direction (the acceptance criterion is that the numbers are *recorded beside* the baselines,
     not that they beat a threshold).
5. **Both status logs updated**: this file's `## Status log — 2026-08-22` section exists and is
   filled in; the parent spec's Phase 4 row is edited in place, not just appended beside.
6. **No regression check needed** — no code changed, so there is nothing for `npm run typecheck` /
   `npm test` to catch that this spec's own procedure could introduce. If the `document`/`deploy`
   steps of this run's own chain edit any `.ts` file for an unrelated reason, the repo's standard
   gates still apply to that unrelated edit, per this repo's normal `run-tests` step — not
   introduced by this spec.

## Sources read

- Brief: `.ai/specs/briefs/2026-08-22-document-fanout-post-deploy-metering.md` (full).
- `.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md` (full — TLDR through the
  `## Status log — 2026-08-21` section, including the mid-step-rises-34k lesson, the Phase 4 filed
  todo block, and R10).
- `.ai/cezar/todos.json` — read the `221cf511-4e18-4f7b-ba46-e20edf956a16` entry directly (status
  `todo`, `startedTaskId: fb62168a-…`, all three acceptance criteria verbatim).
- `packages/cezar/src/workflows/types.ts:553-1043` — the `spec-to-deploy` step chain in full,
  including `implement`/`run-tests`/`commit-push`/`document`/`deploy`'s exact `allowedTools`,
  `bashAllowlist` and prompts, to determine which step in this run's own chain can execute this
  spec's procedure.
- `packages/cezar/src/core/claude-cli-runner.ts:673-749` — confirmed `bashAllowlist` is decorative
  on a `bypassPermissions` Claude run today (only `--disallowedTools` actually restricts), so the
  `document` step's literal allowlist (`git …`, `cez kb`) does not block it from also running
  `cez run stats`.
- `packages/cezar/src/runs/stats-cli.ts:1-50` — `cez run stats` usage and doc comment.
- `/opt/cezar-releases/deploy.json`, `http://127.0.0.1:4321/api/v1/health`,
  `/opt/cezar/packages/cezar/dist/workflows/types.js` (grepped directly) — re-verified live, not
  taken on the brief's word alone.
- `.ai/cezar/runs.json` and `.ai/cezar/runs/*.ndjson` — re-read directly for this spec to confirm
  candidate run states as of write-time (`d92e6b85` done but pre-deploy; `bde0ec40`, `f2012c07`,
  `95d3c6f2`, `49a5aea3`, `8ae78391` all running, none yet at `document`).
- `cezar todo --help` — confirmed only `add`/`list` exist, no `done`/`update` subcommand.
- **Not found / not chased:** no run anywhere on this box yet has a `document` step that both
  started at/after the deploy AND has reached a terminal run status — this is expected (see
  *Problem*) and is exactly the gap Phases 1–5 exist to close once one appears.

---

## Status log — 2026-08-22

*(Not yet executed as of this spec's writing. This section is the target for the `document` step's
own measurement write-up — see Solution → "Where the result is written," item 1. Leaving the
structure here rather than an empty heading so the writing step edits into it rather than inventing
its own shape.)*

**Candidate chosen:** _pending_ (foreign run id, or this run's own id with the lower-bound caveat)

**Raw numbers:**

| run | own calls | child | trips | batch | `sub` | peak ctx |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `c10864d1` (baseline, pre-deploy) | 38 | 0 | 38 | 1.00 | 0 | 141 783 |
| `7c2dd8f0` (baseline, pre-deploy) | 45 | 0 | 44 | 1.02 | 0 | 167 235 |
| _pending_ (post-deploy) | — | — | — | — | — | — |

**Acceptance criteria, as read against the candidate above:**

- [ ] `subAgentCalls >= 1` on `document` — _pending_
- [ ] `peakContextTokens` and `ownToolCalls` recorded beside both baselines — _pending_
- [ ] If `sub` is still 0, the falsification is written here — _pending_
