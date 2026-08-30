# Brief: Plain-End Question — Reconciliation, Not a Fresh Feature

**Task:** `eba6cb05-f995-4fc3-9cf1-0852977296d1` (this run)
**Prior task, same title, verbatim:** `183740fe-df08-4bb6-a46e-5f266354537c` — status `done`,
`archived: true`, `finishedAt: 2026-08-24T19:46:01Z` (`.ai/cezar/runs.json`, this project). Its
own worktree was reclaimed 2026-08-25.
**Prior todo:** `c19d9d4a-4ce1-48dd-b92a-58dfb9e878f2` — no longer present in `cezar todo list --json`
(consumed when `183740fe` was started).

## Headline finding

**This is not a new problem.** The exact feature the task asks for — pairing the plain turn-end
with `CEZ:ASK` — was already designed, implemented, and merged to `origin/main`/current `HEAD` in
commit `d811d34c` ("fix: implement plain-end structured question spec", 2026-08-24), which **is an
ancestor of this worktree's HEAD** (`git merge-base --is-ancestor d811d34c HEAD` → yes). The task
that did that work (`183740fe`) is administratively closed as `done`. What remains open is a
**verification/reconciliation gap**, not a design question — see "What's actually left" below.

## Problem in this repository's own terms

Re-stated from the task text, matching the code: a cezar agent turn ends one of four ways. Three
carry a guard (`CEZ:DONE` gated to the chain's last step, `CEZ:ASK` zod-validated, `CEZ:MONITORING`
bounded by `MAX_AUTO_CONTINUES`). The fourth, no marker at all, historically had none, and the
cockpit rendered the identical "The agent is paused, waiting for your reply" banner whether the
agent asked something real or simply stopped.

## What the record already decided (with citations)

- **KB `specs-af0f9f944acf`** = `.ai/specs/2026-08-23-plain-end-structured-question.md` (in this
  worktree). Header: *"Status: Implemented and pushed to `origin/main` in `d811d34c` on
  2026-08-24, verification incomplete, QA Needed, not Done."* The file is internally
  layered with multiple correction/re-confirmation passes (SUPERSEDED / CORRECTED blocks) that,
  read superficially, look contradictory — read against current code (below), the fixes described
  as landed are in fact landed.
- **KB `specs-e4735009f213`** = `.ai/specs/briefs/2026-08-23-plain-end-structured-question.md`
  — the prior run's own step-1 brief (dated 2026-08-24, itself a rerun of a 2026-08-23 gather).
  It posed six open questions for the spec step (recovery mechanism, question-vs-report
  distinction, nudge-loop bound, symmetry across turn-end call sites, backward compatibility,
  the regression to prove). **All six were answered and implemented** in `d811d34c` per the spec's
  own decision sections and confirmed present in code (below).
- **The motivating incident is run `232ad6d4-58a5-421e-941f-5c24bd5a8452`.** The spec text itself
  (tail of `2026-08-23-plain-end-structured-question.md`, "Read for the 2026-08-24 revision") cites
  this exact full run id as the file it read at NDJSON seq 1892, 1900, 2347, 2352-2354, 2360-2361,
  2370-2373, with three `ask.requested` hits (1892, 2360, 3126) — i.e. asked correctly once, then
  degraded to prose later in the same run. **This matches the current task's own handoff verbatim**
  ("the merge/deploy decision had been asked correctly with CEZ:ASK earlier in the run, then after
  an owner redirect it degraded into a trailing prose sentence"). One research pass surfaced an
  unrelated KB notion note (`notion-04ca960e6408`, a spool/exit-code crosstalk incident) that also
  mentions an `232ad6d4` prefix; the primary source (the spec's own read-and-cited NDJSON offsets)
  is authoritative here and confirms the current task is citing the *same*, already-addressed
  incident, not a new one.

## Current code state — verified by reading HEAD directly, not assumed from the spec doc

All three defects the spec's own review passes had flagged as "re-confirmed open on 2026-08-24"
are **fixed at current HEAD** (branch `cez/eba6cb05`, commit `0a46010b` and its ancestors):

1. **`packages/cezar/src/core/turn-question.ts`** (77 lines) — pure regex heuristic, no LLM call.
   `detectTrailingQuestion` strips fenced code and `CEZ:` protocol lines, scans only the last
   paragraph (clipped to 1200 chars), and returns a verbatim trailing sentence (max 280 chars) if
   it ends in `?` or matches one of 11 closed decision-cue phrases, else `null`. Covered by
   `turn-question.test.ts` (11 cue cases, fence/protocol stripping, clip/ellipsis, negative cases).
2. **`packages/cezar/src/workflows/run.ts`** — `parkPlainEnd` (:8497-8528) sends
   `ASK_STRUCTURE_NUDGE` at most once per run (`state.askStructureNudges < MAX_ASK_STRUCTURE_NUDGES`,
   =1, in-memory not persisted), skipped for cancelled/autonomous sessions, else parks with
   `waitingReason: 'question'|'report'` + `waitingQuestion`. Called from both turn-end sites
   (:5155, :7445). **The P5 defect (widened `pendingAsk` gating `reenterChain`) is fixed**: the
   narrow `pendingAsk` (`runHasPendingAsk`, real unanswered `CEZ:ASK` only) gates `reenterChain`
   at :2584; the wide `pendingAttention` (includes heuristic `waitingReason==='question'`) does not
   — a false-positive prose verdict no longer stalls a chain that should resume.
3. **`packages/cezar/src/runs/store.ts`** — **P2 defect (5 missed clearing call sites) is fixed**:
   `updateRun` (:949-986) has a transition-keyed clearing rule (:961-968, any status change not
   itself setting `waitingReason` clears it) in addition to the original terminal-status-only rule
   (:969-975) — a generic choke point, not the enumerated-site approach the review criticized.
4. **`packages/contract/src/runs.ts`** — `waitingReason: z.enum(['question','report','handoff'])`,
   `waitingQuestion: z.string().max(280).optional()`, in both the index and detail schema variants.
5. **`packages/web/src/routes/task-thread/`** — `thread-state.ts:195` computes
   `hasWaitingQuestion`; `task-thread.tsx:437-462` renders a highlighted quoted box only when
   `waitingReason==='question'`. A `'report'` verdict renders **identically** to the pre-feature
   undifferentiated "paused, waiting for your reply" banner — no distinct treatment, which
   satisfies AC3 ("parks cleanly without inventing a fake question") but means AC1/AC2's "the
   paused state always shows WHAT is being asked" is only true for the `question` case, not
   visually distinguished from `report` beyond the absence of the quoted box.
6. **`packages/cezar/src/handoff.ts`** and **`BACKWARD_COMPATIBILITY.md` §8** — both already carry
   the pairing rule as a stated contract (verified by direct read, this session): a plain end is
   "for a turn the user only reads," a plain end containing a question "is a defect the engine will
   nudge you to fix, once, by asking you to re-send it as CEZ:ASK." §8 states the same pairing and
   marks it part of the marker vocabulary, breaking-change class.
7. **Tests/typecheck, scoped run this session:** `turn-question.test.ts`, `store.test.ts`,
   `run.test.ts`, `recover-pending-ask.test.ts`, `decider.test.ts`, `runs-index-api.test.ts` →
   339/339 passing. `tsc --noEmit -p tsconfig.test.json` → clean.

## What's actually left (the real gap)

- **The V8 runtime/browser E2E the merged spec calls "never run" does exist, but on an orphaned,
  unmerged sibling branch.** `git branch -a` shows `cez/183740fe` still present locally, with two
  commits after `d811d34c` not reachable from `origin/main` or this worktree's `HEAD`
  (`git merge-base --is-ancestor 89535360 HEAD` → not an ancestor): `8e5848c2` ("docs: record
  plain-end question decision"), `2e578cef` (autosave), `da6c6c45` ("docs: clarify plain-end
  verification record"), `89535360` (autosave, adds
  `.ai/qa/artifacts/plain-end-structured-question/v8-ask-chips.png` and
  `v8-question-fallback.png`). **These screenshots were not opened/verified this session.**
- **A tracker/doc mismatch:** `183740fe` is marked `done`/`archived` in `runs.json`, while the spec
  file it produced still headlines "verification incomplete, QA Needed, not Done." Nothing in the
  record explains or resolves that mismatch.
- **The spec document itself is hard to read as a single source of truth** — it is layered with
  five or six nested SUPERSEDED/CORRECTED passes from the same day, each re-asserting and then
  re-reversing "open" vs. "fixed" for the same three defects. A reader has to cross-check against
  current code (as this brief did) to get the real answer.

## Prior decisions this would contradict

None found. This continues/completes `183740fe`'s work rather than reversing anything. No spec or
KB entry found that argues for a different mechanism (e.g. always rendering a distinct `report`
badge, or removing the plain end entirely).

## Open questions a spec step must settle

1. **Scope of this run.** Given the mechanism is already implemented, tested, and merged, is the
   goal of `eba6cb05` to (a) recover and land the orphaned V8 evidence from `cez/183740fe` so the
   spec can honestly say "verified," (b) rewrite the spec doc into one clean, non-contradictory
   status section reflecting current code, (c) re-run a fresh V8 pass on this branch rather than
   trust the orphaned one, or (d) some combination? The task's acceptance criteria read as if the
   feature doesn't exist yet; they need to be re-read as **verification** criteria against already-
   landed code, not implementation criteria.
2. **What to do with the orphaned `cez/183740fe` branch and its two unmerged doc/evidence commits**
   — cherry-pick, merge, or treat as stale and redo the E2E fresh? The screenshots need to actually
   be opened and judged still valid before trusting them.
3. **Does AC5 ("a regression test drives a turn that ends plainly with a question in prose")** ask
   for something beyond what `turn-question.test.ts` + `run.test.ts` + `recover-pending-ask.test.ts`
   already cover, e.g. an explicit end-to-end scenario spanning detect → nudge → park → UI render in
   one test? Current coverage is unit/integration-level per module, not one assembled scenario test
   by that description.
4. **Does the `report` verdict need any visual differentiation** from the historical undifferentiated
   banner, or is "renders identically, adds nothing" the intended, accepted design (per AC3's
   wording, it appears accepted, but this should be an explicit decision, not an assumption)?
5. **How to close the tracker/doc mismatch** — should `183740fe`'s already-`done` status stand as-is
   (accepting the QA gap was simply never closed out), or does this task's closure need to also
   correct that record?

## What could not be verified this session

- The actual content/correctness of the two orphaned V8 screenshots (not opened).
- Whether any device/browser E2E has run *since* 2026-08-24 anywhere outside this repo's git history
  (e.g., manually, undocumented) — no KB record of one found.
- The full diff between `cez/183740fe`'s tip and current `HEAD` beyond the two doc/autosave commits
  identified (not diffed file-by-file).

## Code map (for the next step)

- `packages/cezar/src/core/turn-question.ts` + `.test.ts` — the classifier.
- `packages/cezar/src/workflows/run.ts` — `parkPlainEnd` (~8497-8528), `ASK_STRUCTURE_NUDGE`
  (~475-476), `MAX_ASK_STRUCTURE_NUDGES` (~471), `runHasPendingAsk` (~8328-8336), `reenterChain`
  call sites (~2584, 2607, 4692, 6911, 6922, 7160, 5537), both turn-end call sites (~5155, 7445).
- `packages/cezar/src/runs/store.ts` — `updateRun` (~949-986), `reconcileLoadedRun` (~800-804).
- `packages/contract/src/runs.ts` — `waitingReason`/`waitingQuestion` schema (two variants).
- `packages/web/src/routes/task-thread/thread-state.ts` (~195) and `task-thread.tsx` (~437-462).
- `packages/cezar/src/handoff.ts` (~146-150) and `BACKWARD_COMPATIBILITY.md` §8 (~217-238) — already
  updated; a spec step should only touch these if the vocabulary itself changes.
- `.ai/specs/2026-08-23-plain-end-structured-question.md` — needs a status rewrite regardless of
  what else this task does, to remove the internal contradiction.
