# Brief — Phase 4 of the sleep doctrine: measure the after-run once the new prompt is deployed

**Written in the `context` step of run `bde0ec40-06da-4628-8410-06a6a42694c7`, 2026-08-22.**
Read-only gathering only — no spec written, no code touched.

## The problem, in this repo's own terms

`.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md` (Phases 1-3 shipped in `ada8f376`,
"the wait had no mechanism, so agents guessed a sleep — wait on the process instead") rewrote
`TOOL_BUDGET_DOCTRINE` bullet 3 into three waiting tiers and shipped four derived metrics on
`cez run stats`: `sleepCalls`, `blindSleepCalls` (the hard-zero target), `sleepExecMs`,
`repeatedExpensiveCalls`. Its own § Verification §4 says explicitly: **"Not optional, and not
satisfiable by this run."** The run that shipped the change (`70f19253`) doesn't count as
evidence — its deployed dist was built 90 min *before* the commit, so every step of that run was
still composed by the *old* doctrine text, even though its own count came out 0-blind-of-9.

**Nothing about Phase 4 has changed since the handoff was written** — no after-run has been
measured, no todo says otherwise, and no other in-flight run duplicates this work (checked: only
`70f19253`'s handoff and this run's own handoff mention `blindSleepCalls`/`AFTER_RUN_ID`; the 14
other worktrees on this box are unrelated tasks).

## What the record already decided (citations)

- Spec `.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md`, § Verification §4 (lines
  766-806): gives the **exact** `cez run stats <AFTER_RUN_ID> --json | grep -E
  'blindSleepCalls|sleepCalls|repeatedExpensiveCalls|batchFactor'` command and the node one-liner
  that dumps every `sleep`-containing Bash command from the run's own NDJSON so a human can eyeball
  "is this inside an early-exit loop." Four pass conditions, verbatim:
  1. `blindSleepCalls == 0` (the hard criterion).
  2. Every surviving `sleep` is visibly inside an early-exit loop, read from the dump, not inferred
     from the count (R3: the predicate under-reports "false guarded" cases like
     `for f in a b c; do …; done; sleep 60`).
  3. `repeatedExpensiveCalls == 0`, **or** every survivor is explained as a legitimate re-run after
     a code edit (the metric can't tell the difference; a human read decides).
  4. `batchFactor` has not fallen below the 1.00-1.02 baseline, and the `run-tests` step's report
     quotes an exit-marker line (`EXIT=0` / `Test Files N passed`).
- Same spec's requirement for *which* run qualifies (line 772-775): "a `spec-to-deploy` run that
  actually executes a `run-tests` step, started after this change is deployed to
  `/opt/cezar/packages/cezar/dist/`."
- KB `specs-9fbfc379ae06` / `specs-ea32d8b1006a` mirror the same spec content (copies of this file
  under other worktrees plus one KB-indexed note) — no new decision beyond what's in the spec file
  itself.
- `AGENTS.md` § "Changing a mechanism that already works" — not directly on point, but its general
  rule ("a replacement that ships off is not a replacement" / verify the default path) is the same
  spirit driving this spec's insistence on a *measured*, not asserted, Phase 4.

## What is actually deployed, verified fresh this step (not assumed from the handoff)

- `ada8f376` (Phase 1-3 commit, authored 2026-08-21T20:32:12Z) **is an ancestor of `origin/main`
  and of this worktree's `HEAD`** (`git merge-base --is-ancestor ada8f376 origin/main` → exit 0;
  same for `HEAD`). Confirmed by hash, not inferred from the handoff.
- `/opt/cezar` is a symlink to `/opt/cezar-releases/20260822T014340Z-351626f5`. Its
  `deploy.json` records that release **activated at 2026-08-22T01:43:44Z** (release id
  `20260822T014340Z-351626f5`, sha `351626f5…`). `351626f5` is the current tip of `origin/main`
  **and** this worktree's `HEAD` (`git merge-base HEAD origin/main` == `git rev-parse
  origin/main` == `351626f5…`) — the deployed bundle, this worktree, and `origin/main` are all the
  same commit. There is no drift to account for.
- So the doctrine-with-the-new-bullet-3 **is already deployed and has been since 01:43:44Z today**
  — nothing needs to be built or shipped before an after-run can be captured. This is a change from
  the handoff's framing ("started AFTER this change reaches /opt/cezar" as if still pending): it
  already has.
- Direct proof it's live in practice: the `## Tool budget (cezar)` block in *this very system
  prompt* (visible at the top of this conversation) is the new three-tier text verbatim
  (`"Foreground it unless you have work to overlap … block on the marker … never a bare 'sleep
  N' … Re-read '$f' for a different slice"`), not the old one-line "wait for it before you report."

## The load-bearing finding: this run is very likely its own after-run

`packages/cezar/src/workflows/types.ts` shows `spec-to-deploy` has exactly **8** step ids, in
order: `context` (630) → `spec` (694) → `review-spec` (738) → `implement` (802) → `run-tests`
(832) → `commit-push` (884) → `document` (936) → `deploy` (1012). That is exactly "a chain of 8
agent steps" — the framing this very task was launched under.

This run's own NDJSON (`.ai/cezar/runs/bde0ec40-06da-4628-8410-06a6a42694c7.ndjson`) shows its
**first agent step-start event ever** (`"stepId":"context"`, i.e. this very step) fired at
`2026-08-22T01:43:59.856Z` — **15 seconds after** the deploy activated (01:43:44Z), and there is
no earlier `step-start` in the file (only `lifecycle: cezar restarted — task re-queued` noise from
01:43:46Z and before, while the task sat queued through several server restarts). So:

- This run is a genuine `spec-to-deploy` run (satisfies the workflow-shape requirement).
- Its first real agent turn — this one — started after the doctrine's deploy, with no prior step
  having executed under the old doctrine to contaminate the sample.
- Step 5 (`run-tests`) of *this same chain* will execute the actual gates (typecheck/lint/test/
  build) as real Bash calls, which is exactly the transcript § Verification §4 needs to read.
- Step 7 (`document`) is, by the precedent visible in this very spec's own revision history
  (Revision 3 written by `implement`, Revision 4 "shipped and recorded" by `document`), where a
  step conventionally appends a dated revision block recording what happened and updates the
  Status line.

**This strongly suggests the natural design is: this chain measures itself.** `run-tests` (step 5)
produces the transcript; `document` (step 7) — or possibly `spec`/`review-spec` if the workflow
wants the number sooner — runs `cez run stats bde0ec40-06da-4628-8410-06a6a42694c7 --json`,
reads the four pass conditions, and writes Revision 5 into
`.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md` with the AFTER_RUN_ID and numbers,
flipping the Status line from "Phase 4 outstanding" to implemented (pass) or recording a clean
negative result (fail — the spec explicitly says a negative result must be recorded too, not
hidden).

**Open question for the spec step to settle, not resolved here:** does this task's own
`implement`/`run-tests` steps do anything besides re-run the gates untouched (since the actual
code change — Phase 1-3 — already shipped in a prior run)? If `implement` has nothing to change,
`run-tests` still must run for the postcondition/gate discipline (`AGENTS.md`: gates green before
commit-push) — and that execution is exactly the data source needed. If, instead, this chain's
`implement` step were to find some code still needs touching, that would also count (the spec
requirement is just "a spec-to-deploy run that executes run-tests", not "an unchanged one").

**Alternative not to lose sight of:** if for any reason this run turns out unsuitable when
`run-tests` actually runs (e.g., it ends up with zero Bash calls, or the chain is redirected before
reaching `run-tests`), the fallback is to dispatch a *fresh* `spec-to-deploy` task now (since the
doctrine is already deployed) and use *that* run's id instead. The spec step should not assume
`bde0ec40` will complete — it should write the plan so that whichever run's `run-tests` step
actually executes becomes `AFTER_RUN_ID`.

## Which code is actually involved

- `.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md` — the file to edit. Status line at
  lines 3-6; § Verification §4 at lines 766-806 (the exact commands to run); § Phases Phase 4 at
  line 610-612 ("Not optional, and not satisfiable by this run").
- `packages/cezar/src/runs/stats.ts` — `computeRunStats`, already ships the four fields (verified:
  `sleepCalls`/`blindSleepCalls`/`sleepExecMs`/`repeatedExpensiveCalls` all present at lines
  ~401-422, 603-630, 807-871). **No code change needed here** — Phase 4 is pure measurement +
  documentation, not implementation.
- `packages/cezar/src/workflows/run.ts:519-535ish` — `TOOL_BUDGET_DOCTRINE`, confirmed already
  carrying the new bullet 3 text verbatim (read directly from the file this step, matches the
  spec's § Solution text and matches this session's own system prompt).
- `.ai/cezar/runs/bde0ec40-06da-4628-8410-06a6a42694c7.ndjson` — this run's own transcript; the
  thing `cez run stats bde0ec40… --json` will read once `run-tests` has executed.
- `cez run stats <id> --json` (CLI: `cezar run stats <runId> [--json]`) — confirmed working via
  `--help`; **not yet run against this run's id** in this step, since `run-tests` (step 5) hasn't
  executed yet — this run is still on step 1.

## Any prior decision this would contradict

None found. This is a continuation of the same spec's own Phase 4, not a new decision. The one
thing to be careful not to re-litigate: § Verification §4's four pass conditions and the exact
predicate definitions (§ Data models) are already settled and should be read, not redesigned —
this task is "run the already-specified measurement," not "decide how to measure."

## Open questions a spec step will have to settle

1. **Which run is `AFTER_RUN_ID`** — almost certainly `bde0ec40` itself (see above), but the spec
   step should confirm this holds once `run-tests` actually runs, rather than asserting it now.
2. **Which step writes the final revision** — `document` (step 7) matches the precedent in this
   spec's own revision history, but `commit-push` (step 6) already needs "everything committed"
   before it, meaning the spec-file edit recording the outcome has to happen *before or during*
   `commit-push`, not after. Whether that's `run-tests` itself appending a note, or a later
   `implement`-adjacent pass, needs to be decided (this repo's postconditions:
   `everything-committed` / `all-services-deployed` per `workflows/postconditions.ts:45`, unchanged
   by this task).
3. **Todo `ea54dd16-5913-4b8a-bbc8-d3b1db9da66c`** (cited in the spec's Status line as tracking
   Phase 4) — could not verify it exists in `cezar todo list` from this worktree (the bare command
   reported "no todos filed"; `--project loki-labs/cezar` was rejected as an unregistered project
   id/path). Not load-bearing for the measurement itself, but the spec/document step should decide
   whether to close it and how to reference it correctly.
4. **What "every surviving sleep is visibly inside an early-exit loop" means operationally** for
   the write-up — the spec wants the actual Bash commands dumped and read, not just a `grep`d
   count (R3 in the spec: the predicate under-reports one failure direction). The node one-liner in
   § Verification §4 already does this; the spec step should plan to paste its literal output into
   the new revision block, per this file's own established style (every prior revision quotes real
   commands, not paraphrases).

## What I could not verify

- Whether `implement` (step 4) of this chain will find any code to touch. Not yet reached.
- The exact final `blindSleepCalls`/`sleepCalls`/`repeatedExpensiveCalls`/`batchFactor` numbers for
  this run — `run-tests` (step 5) hasn't executed yet, so `cez run stats` has nothing meaningful to
  report yet (the run is one step in).
- Todo `ea54dd16-5913-4b8a-bbc8-d3b1db9da66c`'s existence/status (see open question 3).

## Facts that most constrain the design

1. **The doctrine is already deployed** (since 2026-08-22T01:43:44Z, sha `351626f5`, which is also
   this worktree's `HEAD` and `origin/main` tip) — no build/deploy step is a precondition for
   Phase 4 anymore; only a qualifying run needs to execute `run-tests`.
2. **This very run (`bde0ec40`) is a strong candidate to be its own after-run**: its first
   `step-start` fired 15s after the deploy, it's a `spec-to-deploy` chain (8 steps: context → spec
   → review-spec → implement → run-tests → commit-push → document → deploy), and step 5
   (`run-tests`) will generate the transcript this spec needs.
3. **§ Verification §4 in the existing spec already contains the exact commands and four pass
   conditions** — this task is "execute and record," not "design a new measurement."
4. **No code change is needed in `stats.ts`** — all four metrics are already shipped and working;
   Phase 4 is pure measurement + a documentation edit to the spec file's Status line and §
   Verification §4.
