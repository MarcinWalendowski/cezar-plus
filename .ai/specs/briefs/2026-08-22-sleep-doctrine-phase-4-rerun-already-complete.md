# Brief — Phase 4 of the sleep doctrine (this invocation is a re-run of a task that already finished)

**Written in the `context` step of THIS invocation of run `bde0ec40-06da-4628-8410-06a6a42694c7`,
2026-08-22.** Read-only gathering only — no spec written, no code touched, nothing else changed.

## The problem, in this repo's own terms — and the one fact that dominates everything else

The task handed to this step is verbatim the same task this exact run id (`bde0ec40`) was already
given, and **that prior pass finished it end to end.** This is not an inference from a stale note —
it is directly verified from primary sources, this step, fresh:

- `git log --oneline -5` (this worktree, branch `cez/bde0ec40`, clean working tree): `HEAD` is
  `fb325ff8` ("merge: origin/main (d6d1569e) into cez/bde0ec40 before landing the sleep-doctrine
  Phase 4 measurement"), one commit after `b6a28ab7` ("docs: measure Phase 4 of the sleep doctrine —
  blindSleepCalls 0 on the after-run").
- `.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md` lines 1-10: Status line already reads
  **"IMPLEMENTED, SHIPPED, DEPLOYED AND NOW MEASURED (revision 8, 2026-08-22). All four phases are
  done,"** naming this exact run id and these exact numbers (see below).
- `/opt/cezar` → `/opt/cezar-releases/20260822T122351Z-fb325ff8` (verified `ls -la`), and
  `deploy.json`'s `current` field is `20260822T122351Z-fb325ff8` — the currently-live release **is**
  the commit that recorded this measurement. Nothing to build or ship.
- `cezar run stats bde0ec40-06da-4628-8410-06a6a42694c7 --json` (run from the main checkout, not
  this worktree — the worktree's own `.ai/cezar/runs/` doesn't carry the transcript) returns a
  **7-step** stats object: `context, spec, review-spec, implement, run-tests, commit-push,
  continue-1` (the last a restart-continuation that folded `document`+`deploy`; see
  `.ai/specs/2026-08-20-chain-integrity-restart-and-continuation.md`). Totals:
  `blindSleepCalls: 0`, `sleepCalls: 5`, `sleepExecMs: 16505`, `repeatedExpensiveCalls: 3`,
  `batchFactor: 1`. This matches the spec's own recorded result exactly (see next section for the
  3-vs-0 `repeatedExpensiveCalls` reconciliation, which the spec already explains).
- `.ai/cezar/runs/bde0ec40-06da-4628-8410-06a6a42694c7.handoff.md`'s **Resume notes** (main
  checkout, not this worktree — same run id, prior pass) say verbatim: **"TASK COMPLETE. Phase 4
  measured, spec updated, committed, pushed to origin/main, deployed and deploy-verified. Nothing
  outstanding for this task."**
- `.ai/cezar/runs/bde0ec40-06da-4628-8410-06a6a42694c7.knowledge.ndjson` already holds a fully
  written KB upsert proposal (`knowledge/notes/sleep-doctrine-phase-4-measured.md`, `seq 0`,
  `runId bde0ec40…`), awaiting review via `cez kb proposals` — not yet applied, but authored.

So: **the task's acceptance criteria, as stated in this step's own prompt, are already satisfied by
work this same run id already did.** There is nothing left to gather that would change the
recommendation for the next step; the open question is not "what is the record" but "why is step 1
running again," which this brief cannot answer from inside the repo (it is a harness/orchestration
question, not a code or spec question) and flags rather than guesses at.

Given how conclusive and internally consistent the primary sources are (git history, the deployed
symlink, the spec's own text, the run's own metered stats, and the run's own handoff all agree),
this step did **not** fan out to sub-agents — there is no ambiguity left to resolve in parallel, and
a 3-way search would just re-read the same six files this step already read directly.

## What the record already decided (citations)

- `.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md` — the governing spec. Status line
  (top of file) claims all four phases done, revision 8, 2026-08-22, citing this run id and its
  numbers. § Verification §4 → Result (referenced by the Status line) holds the full command dump,
  the per-hit (a)/(b)/(c) classification of every `sleep` occurrence, and the attribution argument
  (the run reproduces the doctrine's own `until grep -q "^EXIT="` worked example, which the *old*
  doctrine text never contained — a stronger signal than the deploy timestamp alone). § Verification
  §5 covers the `document`-step gate re-run (`npm ci`/`typecheck`/`test:unit` green, `npm test` 3
  failures of 9634, all pre-existing/unrelated to a one-markdown-file branch).
- Commit `b6a28ab7` — the measurement commit; commit message reproduces the same numbers as the spec
  and the KB proposal, independently.
- Commit `ada8f376` (2026-08-21) — Phase 1-3, prerequisite for Phase 4, already an ancestor of `HEAD`
  and of `origin/main` (not re-verified this pass; verified in the prior brief at
  `.ai/specs/briefs/2026-08-22-sleep-doctrine-phase-4-after-run.md`, and nothing since has moved
  `origin/main` backwards past it).
- Todo `90b00d11-b564-42ec-ae10-08bf057e5813` (`cezar todo list`, confirmed still open) — the one
  legitimate follow-up spun out of this work: `catalog.test.ts`'s C18 index-build budget assertion
  fails reproducibly on this box (59-68 ms/MiB vs a 40 ms/MiB line) under load, pre-existing on
  `origin/main`, explicitly **not** part of this task per the handoff's own scoping.

## The prior decision this would contradict if re-done

None found — but re-doing the measurement (e.g., dispatching a *new* run to re-earn
`blindSleepCalls == 0`) would contradict the spec's own closed status without a stated reason, and
would produce a second, redundant KB note for the same fact. If this step chain is meant to
literally repeat the Phase 4 measurement (rather than being an accidental re-invocation), the spec
step should treat it as a **confirmation pass**, not a fresh Phase 4: re-run `cez run stats` on
whatever *this* pass's run id resolves to once `run-tests` executes again, and record it as a
second data point (still expecting `blindSleepCalls == 0`, since the deployed doctrine has not
changed) rather than re-opening Phase 4 as if it were still outstanding.

## Which code is actually involved (unchanged from the prior brief; re-verified, not re-derived)

- `.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md` — already fully edited for Phase 4;
  nothing left to write unless this pass is a deliberate re-measurement.
- `packages/cezar/src/runs/stats.ts` — `computeRunStats`; ships the four metrics; unchanged, no
  further work implied.
- `packages/cezar/src/workflows/run.ts` — `TOOL_BUDGET_DOCTRINE`; unchanged since `ada8f376`, still
  deployed.
- `cez run stats <runId> --json` (run from `/var/lib/cezar/loki-labs/cezar`, **not** this worktree —
  the worktree's local `.ai/cezar/runs/` does not contain this run's transcript; the main checkout
  does) — this is the exact command any next step needs, and it already returns a complete, 7-step,
  `blindSleepCalls: 0` result for `bde0ec40`.

## What I could not verify

- **Why step 1 is executing again for a run whose handoff says "TASK COMPLETE."** This is outside
  what repo state can answer — it's either an orchestration replay/retry, a deliberate re-verification
  request, or a duplicate dispatch. Flagging it rather than guessing; the next step should treat "is
  this a legitimate re-run request or an accidental duplicate" as the first thing to resolve, ideally
  by checking with the user/orchestrator rather than silently redoing (or silently no-op'ing) 8 steps
  of already-completed work.
- Whether `repeatedExpensiveCalls` moving from the spec's recorded "0 at measurement time" to the
  freshly-read total's "3" reflects anything new, or is exactly the "3 afterwards, all deliberate C18
  re-runs by the document step" the handoff already accounts for — the numbers match the handoff's
  explanation exactly, so this reads as already-explained, not a new finding, but it was not
  re-derived line-by-line from the transcript this pass.
- Whether the KB proposal in `.knowledge.ndjson` has since been applied via `cez kb proposals` — not
  checked this pass (would require a KB-side lookup this step didn't run, since it's not load-bearing
  for the finding above).

## Facts that most constrain the design (for whatever step reads this brief next)

1. **This exact run id already completed Phase 4 successfully**: `blindSleepCalls: 0`,
   `sleepCalls: 5`, `sleepExecMs: 16505`, `repeatedExpensiveCalls: 0` at measurement time (3 more
   since, explained as deliberate re-runs), `batchFactor: 1.00` — recorded in commit `b6a28ab7`,
   merged as `fb325ff8` (current `HEAD`), and currently deployed as release `20260822T122351Z-fb325ff8`.
2. **The spec's Status line already reads "done," not "outstanding."** Any next step should not
   flip it back to outstanding or re-run the measurement as if Phase 4 had never happened, unless
   this invocation is deliberately meant to be a second, independent confirmation pass.
3. **The working tree is clean and `HEAD` already carries the fix** — there is nothing to implement,
   nothing uncommitted, and nothing undeployed.
4. **The one real open item is process, not code**: reconcile why this step is running again before
   spending 7 more steps' worth of work redoing something the record shows is already finished.
