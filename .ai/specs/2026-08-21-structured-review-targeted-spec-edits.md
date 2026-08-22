# Structured review verdicts, and targeted edits on spec revision

**Status: DRAFT (2026-08-21) — spec only, nothing implemented.** Written in the `spec` step of
the `spec-to-deploy` run for task `0762e872-f6e5-4a51-b1b1-8a7df9cdf4e7`, from the brief left by
that run's `context` step: `.ai/specs/briefs/2026-08-21-structured-review-targeted-spec-edits.md`.
Todo `a7ebbe3f-ec42-4ce0-8b9d-90c60dfed6b4` is this task.

## TLDR

Measured on run `70f19253-cf6b-407c-92e0-96a8020a8ebb`: `spec-to-deploy`'s `review-spec` step
asked for changes, and the `spec` step's revision pass (iteration 2) spent 216s re-emitting the
**entire** spec file as one `cat > … <<'SPECEOF'` heredoc — 51,450 chars, longer than the
37,188-char original. Two causes, both in this repo's own code: `review-spec`'s prompt asks for
open-ended prose with a trailing verdict word, not a change list; and the `spec` step's prompt is
byte-identical on iteration 1 and iteration 2 — the ONLY thing that differs is a generic string
(`run.ts:4399-4400`, "A verification command failed…") that was written for a failed shell check
and says nothing about editing vs rewriting.

The fix is two prompt-level changes plus one shared-code wording fix, all cited against the
current code:

1. **`review-spec`'s prompt** (`types.ts`, the `review-spec` step only) now requires a `revise`
   verdict to be a **numbered change list** — `FILE: … / SECTION: … / CHANGE: …` per defect —
   instead of open prose, with a plain-English escape hatch for a genuine structural rewrite.
2. **A new pure function, `specRevisionFeedback()`, in `run.ts`** wraps that change list (or a
   human reviewer's free-text notes) with a fixed instruction — apply each item as a targeted
   `Edit`, do not re-emit the whole file — before it is handed to the retried `spec` step. Applied
   at all three places in `run.ts` that build feedback text for a re-entry into `spec`.
3. **The generic `checkFailure` wrapper text in `runAgentStep`** (`run.ts:4399-4400`, shared by
   every `onFail`/`verify` retry in the engine, not just this workflow) is reworded from "A
   verification command failed…" to language that is actually true of both a failed check and a
   review verdict.

No schema, no route, and no new `CEZ:*` marker for the engine to parse — the change list is a
prescribed markdown shape the model follows by instruction, the same pattern `CEZ:SPEC_PATH` and
`CEZ:REVIEW` already use. Nothing here touches the `spec` step's own prompt literal or
`allowedTools` in `types.ts` — see § Prerequisite below for why that matters.

## Problem

### What's actually broken, cited against the code on this branch

`packages/cezar/src/workflows/types.ts` defines `SPEC_TO_DEPLOY_WORKFLOW`, the built-in
`spec-to-deploy` chain: `context → spec → review-spec → implement → run-tests → commit-push →
document → deploy`. `review-spec` is read-only by construction (no `Write`/`Edit`,
`types.ts:747`) and carries `onFail: { retry: 'spec', max: 2 }` (`types.ts:752`): a `revise`
verdict sends the chain back to `spec` for up to two more passes.

1. **`review-spec`'s prompt asks five open-ended questions and ends with a verdict word — nothing
   about structure.** (`types.ts:756-780`, current text on this branch.) `parseReviewVerdict`
   (`types.ts:547-556` on `origin/main` — re-anchored here after review iteration 1 flagged this
   citation as `HEAD`-based and stale) reads only the trailing `CEZ:REVIEW=pass|revise` line via
   `REVIEW_VERDICT_RE`; every word above it is opaque prose to the engine. Whatever the reviewer
   writes is the entire artifact the next step gets.
2. **That raw prose becomes the *only* signal that distinguishes iteration 2 of `spec` from
   iteration 1**, and the wrapper around it actively mislabels it:
   - `state.reviewReport = turnText.trimEnd().slice(-CHECK_OUTPUT_CAP)` (`run.ts:4480`,
     `CHECK_OUTPUT_CAP = 20_000`, `run.ts:97`) — the reviewer's raw turn text, capped, kept whole.
   - On `revise`, `loopBackTo(i, step, report ?? '…', message)` (`run.ts:3970-3975`) sets
     `checkFailure = feedback` (`run.ts:3783`) to that raw prose, and resets the intervening steps
     to `pending`.
   - `runAgentStep` then does `if (checkFailure) userPrompt += '\n\nA verification command failed
     after the previous attempt. Fix the cause. Failing output:\n\n${checkFailure}'`
     (`run.ts:4399-4400`). **This is the only difference between iteration 1's and iteration 2's
     prompt for `spec`**, and the sentence is not even true of a review — nothing in it says
     "these are edits, apply them, don't rewrite the file."
   - The `spec` step's own literal prompt (`types.ts:706-735`, current text on `origin/main` —
     re-anchored here after the implement step found this citation was stale) is identical on both
     iterations: "write ONE spec file … following this repository's own conventions."
3. **Result, measured on `70f19253`**: `review-spec` wrote a prose report; `spec` (iteration 2)
   read it wrapped in "a verification command failed," re-ran its unchanged "write ONE spec file"
   instruction, and produced a second full-file `cat > … <<'SPECEOF'` — 51,450 chars, longer than
   the 37,188-char original — instead of touching only what the reviewer actually flagged.
   Nothing checked that the sections the reviewer did not criticize survived unchanged, because
   nothing was ever diffed: the whole file was retyped from the model's own memory of it. The
   full rework loop (`spec` iteration 2, 613s, + `review-spec` iteration 2, 250s) cost 14m23s and
   ≈$5.25 — 17% of the run's 85 minutes and $32.53.

   *(A unit note, since three char/token counts are now in play: the 37,188/51,450 figures above
   are the FULL heredoc call, envelope included — `cat > … <<'SPECEOF'`, quoting, the `EOF`
   marker. The sibling spec's 34,845/48,618, cited two paragraphs down, are the extracted BODY
   only, which is why they don't match digit-for-digit even though both describe the same two
   writes on the same run. The 50,052 → under 20,000 figures in this task's own acceptance
   criteria and § Verification are OUTPUT TOKENS — a different unit again, not a third character
   count to reconcile against either of these.)*

   **This looks like it contradicts a landed, measured decision, and that is worth saying
   directly rather than leaving a reader to find it.** The sibling spec
   `.ai/specs/2026-08-21-edit-an-existing-file-never-re-emit-it.md` (commit `76c8de0c`, merged to
   `origin/main`) measured this SAME rewrite and reached the opposite number for the instance it
   looked at: diffed at line granularity, the two bodies differ by 81 changed hunks, and
   converting those 81 hunks to anchored `Edit` calls would have cost ~65,045 characters
   (14,296 + 28,069 of old/new-side text, plus ~80 chars of anchor and ~120 of call envelope per
   hunk) against the 48,618 the heredoc actually spent — **34% MORE than the rewrite, in 81 round
   trips instead of one** (`types.ts:488-499` on `origin/main`, the doc comment above
   `FILE_WRITE_RECIPE`).

   **That does not defeat this spec's premise; it explains what the premise actually is: "fewer
   hunks," not "edits always beat heredocs."** The 81 hunks measured there are not 81 things a
   reviewer asked for — nothing had diffed the two bodies before the second write, so the model
   reconstructed sections nobody had touched, line by line, slightly differently each time. That
   is self-generated drift, which is exactly what acceptance criterion 4 (byte-identical unflagged
   sections) exists to eliminate. A `review-spec` change list of N genuine defects produces N
   targeted edits, not 81, and the sibling spec's own arithmetic inverts as soon as the edit count
   shrinks that far: five edits at roughly 280 chars of anchor/envelope each, plus their
   `old_string`/`new_string` bodies, comes nowhere near a 48,618-character heredoc. The case where
   it does NOT shrink that far — a change list that, taken together, touches most of the document
   — is exactly what § Solution 2's widened escape hatch and § Risks below are for.

This run is output-token bound, not tool- or round-trip-bound (measured across all 9 steps of
`70f19253`: 82% of wall clock is idle with no tool running, output at 81.3 tok/s, R² = 0.984). A
full-file rewrite is the single most expensive thing an agent step can do under that model: every
character re-emitted, changed or not, costs ≈12ms of wall clock and real dollars, twice over —
once to emit it, once to carry it back into context afterward.

### Cross-cutting concern this problem statement must not lose

`review-spec`'s prompt already says, deliberately: *"Judge the spec, not its prose… `revise` is
for a spec that is wrong, incomplete against the ask, or built on facts that do not hold — not
for one you would have worded differently"* (`types.ts:780-781`, current text). A structured
change-list requirement must not turn `review-spec` into a line-editing/style pass. The five
judgment questions stay the substance; the structure below is only about how a real defect's
description is **formatted** for the next step to act on mechanically, not a narrowing of what
counts as a defect.

## Prerequisite — read this before implementing (scope collision, now resolved)

The `context` step's brief flagged a **live scope collision**: branch `cez/f272fda8`
(commit `76c8de0c`, spec `.ai/specs/2026-08-21-edit-an-existing-file-never-re-emit-it.md`) had
already, independently, added a generic `FILE_WRITE_RECIPE` constant to `types.ts` and inserted
it into the `spec`, `implement` and `document` step prompts, plus added `'Edit'` to the `spec`
step's `allowedTools` — the exact same lines this task would otherwise need to touch.

**Verified directly in this step, not assumed from the brief: that collision resolved itself
during this run.** `git fetch origin main` on this worktree shows `origin/main` is now commit
`0a2541ca`, a merge of `f272fda8` into the *previous* `main` tip (`3444f1c8`, the commit this
worktree branched from) — i.e. **`76c8de0c` is on `origin/main` today**, even though this
worktree's own branch (`cez/0762e872`, based on `3444f1c8`) does not have it yet
(`git merge-base --is-ancestor 76c8de0c HEAD` → false, verified). Confirmed by reading
`origin/main`'s `types.ts` directly (`git show origin/main:…/types.ts`): the `spec` step already
carries `allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash']` and
`FILE_WRITE_RECIPE` inserted before its closing `'Change NO other file in this step…'` line
(current lines 704, 727 on `origin/main`). `review-spec` is untouched by that merge (it has no
Write/Edit tools to begin with, so `FILE_WRITE_RECIPE` was never added there) — confirmed via
`git diff main origin/main --stat`, which shows only `spec`, `implement`, `document` prompts
changed in `types.ts`.

**This resolves the brief's open question in favor of option (a):** treat `FILE_WRITE_RECIPE` and
the `spec` step's `Edit` grant as an already-landed prerequisite, and build this change entirely
on top of it rather than duplicating it.

**Phase 0 below is therefore a real, load-bearing step, not boilerplate:** the `implement` step of
*this* task must rebase or merge `cez/0762e872` onto current `origin/main` **before** editing
`types.ts`. Skipping this would silently recreate the exact conflict the sibling brief predicted —
two independent edits to the same `spec`-step prompt array, one already merged and one about to
be authored against a stale copy. Done correctly, this task's diff to the `spec` step's own prompt
array in `types.ts` is **zero** (see § Solution) — the design below only touches `review-spec`'s
prompt and `run.ts`, both of which `f272fda8` left alone, so the merge conflict this task was at
risk of causing does not materialize as long as Phase 0 runs first.

## Solution

### Design fork, decided

The brief names the central fork explicitly: does the "apply as targeted edits, don't rewrite"
instruction live (a) at the `run.ts` call site that builds the retried step's feedback text, or
(b) as a permanent conditional paragraph inside the `spec` step's own prompt literal in
`types.ts`?

**Decision: (a), narrowly.** A new function, `specRevisionFeedback()`, wraps the feedback text at
the three `run.ts` call sites that build feedback specifically for a re-entry into the `spec`
step (all listed in § Architecture below) — never at the generic `runAgentStep` wrapper, which
stays a **shared, step-agnostic** channel used by every `onFail`/`verify` retry in the whole
engine (not just this workflow). This is more surgical than (b): it adds nothing to the `spec`
step's own prompt literal (zero touch to those lines, per the Prerequisite above), and the
instruction only fires exactly when it is true — iteration ≥ 2 of `spec`, which is precisely when
`checkFailure` is non-null for this step (`run.ts:3762`, `3783`, `3829`; the base prompt template
supports only `{{task}}` substitution, `run.ts:5530-5532`, so there is no per-iteration branching
available inside `types.ts`'s static prompt array regardless).

The one **shared**-code change — rewording `runAgentStep`'s generic append text
(`run.ts:4399-4400`) from "A verification command failed…" to language true of both cases — is
justified separately: that sentence was already factually wrong for the review path (which
predates this task), and grep confirms no test in `packages/cezar/src/workflows/*.test.ts` pins
the old exact string, so the wording-only change carries no behavioral risk to other `onFail`
users of the same channel (e.g. a future workflow's command-check retries).

### 1. `review-spec`'s prompt: prescribed change-list shape

Replace the current `CEZ:REVIEW=revise` bullet and the paragraph after it
(`types.ts`, current lines 775-782 on `origin/main` — re-anchored here after review iteration 2
caught the earlier `774-780` as a stale `HEAD`-based span; the `revise` bullet itself is 777-778,
the "Judge the spec" paragraph is 780-782) with a required shape for a `revise` verdict, following the
form the fan-out A/B already proved in this repo (`types.ts:932-939` on `origin/main` — re-anchored
here; this was cited as `872-878` in review iteration 1, which is that comment's `HEAD` line
number, not its `origin/main` one. Current text: fan-out stated as its own imperative paragraph got
3/3 adoption; the same instruction folded into an existing sentence got 0/2 — so this is its own
paragraph, not a clause):

```
'Then end your report with your verdict on its OWN LAST LINE, exactly one of:',
'  CEZ:REVIEW=pass     — good enough to build; list any nits above, they will not block.',
'  CEZ:REVIEW=revise   — a real defect exists.',
'',
'A `revise` verdict is handed to the spec step as ITS INSTRUCTIONS, and it acts on it as a change',
'list to apply, not as prose to re-derive. So write every defect as its own numbered item, in',
'exactly this shape:',
'  1. FILE: <a path that resolves from YOUR OWN working directory — check it exists before you',
'     write it down. If it does not, use an absolute path instead of guessing a repo-relative one;',
'     a repo can have more than one directory of the same relative name (e.g. a worktree and the',
'     main checkout each have their own .ai/specs/).>',
'     SECTION: <the exact heading text the defect is in, e.g. "## Verification"> — or, for a',
'     missing section, "NEW — insert after <the heading before it>".',
'     CHANGE: what is wrong, and specifically what the section should say instead. Concrete',
'     enough to apply directly — not "clarify this part".',
'',
'List every defect this way, even several in the same section. If, taken together, the defects',
'touch MOST of the document rather than isolated sections, say so in one sentence before the',
'list (e.g. "This needs a structural rewrite: …") — that is the one case where the next step',
're-emitting the whole file is the right call instead of editing section by section.',
'',
'Judge the spec, not its prose. `revise` is for a spec that is wrong, incomplete against the',
'ask, or built on facts that do not hold — not for one you would have worded differently.',
'You get at most two revisions, so spend them on defects that matter.',
```

This keeps the existing "judge the spec, not its prose" guardrail verbatim (see § Problem's
cross-cutting concern) and keeps `parseReviewVerdict` untouched — it is a regex over the last
line only (`types.ts:547-556` on `origin/main`) and does not care what shape the prose above it
takes.

No new `CEZ:*` marker for the structural-rewrite escape hatch. Per the brief's Open Question 3,
this reuses `FILE_WRITE_RECIPE`'s own framing (already in the `spec` step's prompt post-merge,
per § Prerequisite: *"when you are genuinely rewriting MOST of a file, re-emitting it is correct
… judge by how much of the file changes"*) rather than inventing a second mechanism. Nothing in
the engine needs to branch on this programmatically — unlike `CEZ:REVIEW`, which `run.ts` reads
to decide loop-back, whether a rewrite is "structural" is read only by the model on the next
turn, so a declared marker would add a parser for no behavioral gain.

### 2. `specRevisionFeedback()`: the instruction that reaches `spec` on revision

**Revised after review iteration 1 (`CEZ:REVIEW=revise`).** The reviewer found the first draft of
this function pointed the fresh iteration-2 session at "CEZ:SPEC_PATH, in this run's handoff" as
if that marker were reliably present. It is not: measured directly on this spec's own run
(`0762e872`) — the marker was never emitted and `declaredSpecPath` stayed unset. Worse, this exact
spec file was written to the main checkout's `.ai/specs/` (absolute path, inode `526049`), not the
worktree's own `.ai/specs/` (inode `3146117` — confirmed distinct, non-symlinked directories, both
named `.ai/specs`, holding different files). A fresh session told "the path is in the handoff" with
nothing there, checking a repo-relative path that resolves to the WRONG near-empty directory rather
than failing outright, has exactly one obvious next move: write the file — the bug this task exists
to kill, reproduced by its own delivery mechanism. Fixed two ways below: the function takes a
concrete path when one is known, and instructs the model to locate the file, not assume it is
missing, when one isn't.

New pure function in `run.ts`, near `loopBackTo` (`run.ts:3781-3790`):

```ts
/**
 * Wraps feedback destined for a re-entry into the `spec` step with a fixed instruction: apply it
 * as targeted edits, don't re-emit the whole file. Used at every place in this file that builds
 * feedback text for THAT step specifically — never at the generic `checkFailure` wrapper in
 * `runAgentStep`, which stays step-agnostic (spec .ai/specs/2026-08-21-structured-review-targeted-
 * spec-edits.md).
 *
 * `specPath`, when known, is `RunRecord.declaredSpecPath` (`store.ts:291`) — the concrete path the
 * `spec` step itself declared on an earlier turn via `CEZ:SPEC_PATH=` (`applyTurnMarkers`,
 * `run.ts:4969-4970`). It is NOT guaranteed to be set — measured on this task's own run, it isn't —
 * so the `undefined` branch below is the case to design for, not an edge case.
 */
function specRevisionFeedback(report: string, specPath?: string): string {
  const locate = specPath
    ? `Changes were requested for the spec at \`${specPath}\`.`
    : [
        'Changes were requested for the spec. This run never recorded its path, so before doing',
        "anything else: find the existing file from the change list's own FILE: line(s) below, then",
        "`ls .ai/specs/` or `git status` if a path doesn't resolve from your working directory. A",
        'repo can have more than one `.ai/specs/` directory (for example a worktree plus the main',
        "checkout) — if a path doesn't exist relative to your cwd, that means look elsewhere, not",
        'that it needs to be created. Never write a second copy of the spec under a new path.',
      ].join('\n');
  return [
    locate,
    'Open the EXISTING file and apply each item below as a TARGETED EDIT to the section it names —',
    'Read, then Edit (old_string → new_string), the same rule FILE_WRITE_RECIPE already gave you.',
    'Do NOT re-emit or rewrite the whole file — no `cat > … <<EOF`, no full-file `Write` — unless',
    'the notes below themselves say the changes touch most of the document and call for a',
    'structural rewrite, or unless the items below, TAKEN TOGETHER, change most of the file — judge',
    'by how much of the file changes, exactly as FILE_WRITE_RECIPE already told you. Rewriting the',
    'file to fix three sections is the failure; rewriting it because the list genuinely touches',
    'nearly every section is not. Every section the notes below do not name must come out',
    'byte-identical.',
    '',
    'The requested changes:',
    '',
    report,
  ].join('\n');
}
```

Applied at all three places `run.ts` builds feedback for a `spec` re-entry, all three now guarded
by `step.onFail?.retry === 'spec'` (or the equivalent resolved-step field at the site that doesn't
have `step` directly in scope) — new in this revision, per review iteration 1's nit that
`requiresApproval` is a general, schema-exposed field, `types.ts:68`, not exclusive to this
workflow's `review-spec`, and review iteration 2's nit that `parseReviewVerdict` itself runs on
**every** agent step's turn text unconditionally (`run.ts:4475`), so the `revise` branch at site 1
is reachable by any user-defined workflow whose step emits the marker and sets `onFail` — not
"by construction only `review-spec`," as this spec's first draft claimed. The guard is one clause
at all three sites and keeps them consistent; without it, a non-`spec` retry target would get
`spec`-specific "apply as a targeted Edit" instructions that don't apply to it.

- **`run.ts:3970-3975`** — the `review-spec` `revise`-verdict loop-back. `step` is already in scope
  here. Guard with `step.onFail?.retry === 'spec'`; when true, change
  `report ?? 'The reviewer asked for changes but left no report.'` to
  `specRevisionFeedback(report ?? 'The reviewer asked for changes but left no report.', this.store.getRun(runId)?.declaredSpecPath)`;
  otherwise leave the existing fallback text unchanged (a non-`spec` retry target gets the plain
  report, no rewrite-vs-edit instruction grafted onto it).
- **`run.ts:4000-4005`** — the live human-approval "changes requested" loop-back (`onFail`'s
  human gate, dormant unless `approvals.minApprovers ≥ 1`). This site fires for **any** step with
  `requiresApproval: true`, so guard it: only when `step.onFail?.retry === 'spec'` (`step` is
  already in scope here), replace the inline template literal
  `` `A reviewer requested changes to the spec:\n\n${outcome.notes}` `` with
  `specRevisionFeedback(outcome.notes, this.store.getRun(runId)?.declaredSpecPath)`; otherwise fall
  back to the same wording generalized to name the real target instead of hardcoding "the spec":
  `` `A reviewer requested changes to "${step.onFail?.retry ?? step.id}":\n\n${outcome.notes}` ``.
- **`run.ts:4335`**, inside `releaseApproval()` — the restart-recovery path for the same human
  gate (a process restart killed the parked `execute()`, so the "changes requested" outcome is
  replayed through `reenterChain`'s `feedback` field instead of a live loop-back). **Corrected
  after review iteration 2's nit: use `pending.specPath`, not `run.declaredSpecPath`.**
  `pending: PendingApproval` is already a parameter of `releaseApproval` (`run.ts:4318`) and
  already carries `specPath`, seeded from `run.declaredSpecPath` at the moment the gate parked
  (`run.ts:4178`) — the path as it stood when this approval was requested, not whatever
  `declaredSpecPath` happens to read at release time. This site only has `pending.stepId`, not the
  `WorkflowStepDef` itself, so resolve the guard's target the same way as before:
  `const def = await this.reviveWorkflow(run); const target = def?.steps.find((s) =>
  s.id === pending.stepId);` (`reviveWorkflow`, `run.ts:1839-1846`, already used elsewhere to get a
  `WorkflowDef` back from a `RunRecord`). Same guard, `target?.onFail?.retry === 'spec'`, same two
  branches as the site above, but sourcing the path from `pending.specPath` instead of a fresh
  `this.store.getRun(runId)?.declaredSpecPath` lookup.

All three currently build ad hoc feedback text for the identical destination (a `spec` re-entry);
unifying them through one function means a human's free-text "changes requested" note gets the
same "use Edit, don't rewrite" instruction as the reviewer's structured list, even though a
human's note is not guaranteed to follow the FILE/SECTION/CHANGE shape — the instruction ("apply
as targeted edits") holds regardless of whether the notes themselves are structured. The generic
fallback text at the two human-approval sites (`run.ts:4000-4005` and `run.ts:4335`, not the
`review-spec` loop-back at `3970-3975`, which has no such wording) is a pre-existing, mild bug in
its own right — it says "to the spec" unconditionally today regardless of what `onFail.retry`
actually names — worth fixing in the same edit since the line is already being touched, but not
the point of this task.

### 3. The shared wrapper's wording

`runAgentStep` (`run.ts:4399-4400`):

```diff
- userPrompt += `\n\nA verification command failed after the previous attempt. Fix the cause. Failing output:\n\n${checkFailure}`;
+ userPrompt += `\n\nFeedback on the previous attempt — read it and act on it:\n\n${checkFailure}`;
```

True of both a failed shell check (`output` from `runCheckStep`, `run.ts:4048-4053`, still fits
"feedback… act on it") and a review verdict (now itself a full instruction block, thanks to
`specRevisionFeedback()`). No test in `packages/cezar/src/workflows/*.test.ts` pins the old exact
string (grepped for `A verification command failed` and `Failing output` — zero hits outside
`run.ts` itself), so this is a safe, low-risk wording fix, not a behavior change.

## Architecture

```
review-spec turn ends
        │
        ▼
parseReviewVerdict(turnText) → 'revise'          (types.ts:547-556, unchanged — re-anchored
                                                   here after review iteration 2 caught the
                                                   earlier `498` as a stray FILE_WRITE_RECIPE-
                                                   doc-comment line; REVIEW_VERDICT_RE is 547,
                                                   the function itself is 552-556)
state.reviewReport = turnText.slice(-20_000)      (run.ts:4480, unchanged — now holds a
        │                                          structured change list, not free prose)
        ▼
run.ts:3970  i = loopBackTo(i, step,
               specRevisionFeedback(report,         ← NEW: wraps report + the run's
                 declaredSpecPath), …)                declaredSpecPath (may be undefined)
        │                                            before it becomes checkFailure
        ▼
checkFailure = specRevisionFeedback(report, path)  (run.ts:3783, unchanged mechanism)
        │
        ▼
spec step re-enters (iteration 2, fresh sessionId — run.ts:4415)
        │
        ▼
runAgentStep: userPrompt = 'write ONE spec file…' (types.ts spec prompt, UNTOUCHED)
            + '\n\nFeedback on the previous attempt — read it and act on it:\n\n'
              + specRevisionFeedback(report, path)  ← reworded wrapper (run.ts:4399-4400)
        │
        ▼
Model reads: FILE_WRITE_RECIPE (already in its prompt, post-Prerequisite-merge) +
             specRevisionFeedback's "apply as targeted Edit, don't rewrite" +
             the reviewer's FILE/SECTION/CHANGE list
        │
        ▼
Model issues Read + Edit(old_string, new_string) per item, NOT a full-file Write/heredoc
```

Three independent levers, each doing one job: `review-spec`'s prompt produces a **shape** the
model can act on mechanically; `specRevisionFeedback()` supplies the **imperative instruction**
that shape needs to be useful (an unread change list is not self-executing); the shared wrapper's
reworded text stops actively lying about what happened. None of the three depends on the other
two to be independently correct, which is what makes them separately shippable (§ Phases).

## Data models

No persisted schema changes. No new `CEZ:*` marker, no new `WorkflowStepDef` field, no new
`ChainResumePoint`/`ActiveRun` field. One new pure function (`specRevisionFeedback`, `run.ts`,
`(report: string, specPath?: string) → string`, reading the existing `RunRecord.declaredSpecPath`,
`store.ts:291`, already persisted today) and prompt-literal text changes in `types.ts` (`review-spec`
step only) and `run.ts` (one template-literal reword, plus a `step.onFail?.retry === 'spec'` guard
at all three `specRevisionFeedback()` call sites, per review iteration 2's nit — a runtime check,
not a schema addition).

## API contracts

None change. `GET /api/v1/workflows` already serializes each step's `prompt` verbatim, so the
cockpit's workflow view reflects the new `review-spec` prompt text with no API change, the same
pattern `.ai/specs/2026-08-21-per-step-model-policy.md`'s own § API contracts recorded for its
step-level change.

## Phases

**Phase 0 — prerequisite, not a code change.** Rebase or merge `cez/0762e872` onto current
`origin/main` (commit `0a2541ca` or later) before touching `types.ts`, so `FILE_WRITE_RECIPE` and
the `spec` step's `Edit` grant are already present and this task's diff to the `spec` step's own
prompt array is zero, per § Prerequisite. Verify with
`git merge-base --is-ancestor 76c8de0c HEAD` → true, and confirm `grep -n "FILE_WRITE_RECIPE"
packages/cezar/src/workflows/types.ts` finds it in the `spec` step's prompt before proceeding.

**Phase 1 — `review-spec`'s structured output.** Replace the `revise`-verdict bullet and
paragraph in the `review-spec` step's prompt (`types.ts`) with the FILE/SECTION/CHANGE shape and
the structural-rewrite escape hatch, per § Solution 1. Independently shippable and testable: it
only changes what the reviewer is asked to write; nothing downstream depends on it yet if shipped
alone (the `spec` step still gets the old generic wrapper text until Phase 2 lands, so the change
list would still arrive framed as "a verification command failed" — worse than doing nothing
alone, which is why Phase 2 ships in the same commit rather than as a follow-up).

**Phase 2 — revision-aware feedback in `run.ts`.** Add `specRevisionFeedback()`; apply it at the
three call sites in § Solution 2; reword the shared `checkFailure` wrapper in § Solution 3. Ships
together with Phase 1 (see Phase 1's note on why splitting them is worse than doing nothing).

**Phase 3 — tests.**
- `packages/cezar/src/workflows/types.test.ts`, alongside the existing `review-spec` assertions
  (current lines 126-143): assert the `review-spec` prompt contains `'FILE:'`, `'SECTION:'`,
  `'CHANGE:'`, the structural-rewrite sentence, and still contains both `CEZ:REVIEW=pass` and
  `CEZ:REVIEW=revise` (regression guard on the existing marker) and the "Judge the spec, not its
  prose" sentence verbatim (regression guard on the cross-cutting concern in § Problem).
- New test (extend `packages/cezar/src/workflows/review-verdict.test.ts` or a sibling file) for
  `specRevisionFeedback()`: given a report string, asserts the output contains `'TARGETED EDIT'`,
  `'Do NOT re-emit'`, `'byte-identical'`, and the original report text verbatim (nothing dropped).
  Requires exporting `specRevisionFeedback` from `run.ts` (or importing it into the test the same
  way `parseReviewVerdict` is imported today).
- Confirm no existing test asserts the literal string `'A verification command failed'` (grepped
  already — zero hits; re-run the grep after the edit to catch anything added in the meantime).
- **New, from review iteration 2's nit.** `review-verdict.test.ts`'s existing drift guard —
  `/CEZ:REVIEW=(\w+)/g` scanned over the `review-spec` prompt, then round-tripped through
  `parseReviewVerdict` — must stay green against the reworded prompt from § Solution 1. Verified
  by hand during this review that it still yields exactly `pass`/`revise`; pin it as an explicit
  Phase 3 assertion so a future `CEZ:REVIEW=` mention inside a FILE/SECTION/CHANGE example block
  (the prompt text itself now shows the shape by example) doesn't silently break it.

**Phase 4 — real revision run (QA needed, cannot execute inside this chain).** Per the brief's
Open Question 5 and the precedent both sibling specs used (`e91ba865`, `221cf511`, `ea54dd16`): a
byte counter or token counter measured from inside the step it counts cannot see its own true
cost, so acceptance criteria 3 and 4 need a **separate, real** `spec-to-deploy` run whose
`review-spec` step returns `revise`, inspected after the fact. See § Verification for the exact
steps, including the review iteration 2 addition (Verification 3c2): measure `review-spec`'s own
output tokens on both iterations too and report the net run-level change, not just `spec`'s own
drop — a net that is not negative means the change-list format itself needs to shrink, and that is
this phase's finding to make, not a silent pass. File as a follow-up todo (same pattern as the
three precedent ids above) if this task's own chain does not naturally produce a `revise` verdict
to observe.

## Risks

- **A reviewer might not follow the prescribed shape despite the instruction.** Mitigated by using
  the same imperative-paragraph technique the fan-out A/B proved works in this exact prompt style
  (3/3 vs 0/2, `types.ts:932-939` on `origin/main` — re-anchored after review iteration 1) — but it
  remains a prompted convention, not a machine-parsed schema, the same trust boundary
  `CEZ:SPEC_PATH`/`CEZ:REVIEW` already operate inside. If Phase 4 finds low compliance, the next
  step is a lightweight structural check (e.g. `grep -c 'FILE:'` against the captured report) added
  as a soft warning, not a hard gate — out of scope here.
- **New, from review iteration 1: the `spec` step's own prompt still opens with "write ONE spec
  file" on iteration ≥2** — § Solution deliberately leaves that literal untouched (zero diff to the
  `spec` step's prompt array, per § Prerequisite), so the appended `specRevisionFeedback()` text
  ("apply as targeted edits, don't rewrite") competes with it rather than replacing it. Recency and
  imperativeness favor the appended text — it is the LAST thing the model reads and is itself an
  imperative paragraph, the same form the fan-out A/B measured as effective — but this is a
  hypothesis, not a measurement. Phase 4's real revision run is the falsification test: if iteration
  2 still emits a full-file `Write`/heredoc despite a change list with no structural-rewrite
  escape-hatch line, the competing-instruction theory is wrong and the fix needs a conditional
  paragraph inside the `spec` step's own prompt (design fork (b), rejected in § Solution) instead.
- **New, from review iteration 1: this spec's own file was written outside the run's worktree** —
  to the main checkout's `.ai/specs/` (absolute path), not `.ai/cezar/worktrees/0762e872-.../.ai/specs/`
  (confirmed distinct, non-symlinked directories, inodes `526049` vs `3146117`). If that pattern
  holds through this task's own `commit-push` step, the spec file will not be part of this run's
  commit or PR diff — worth naming, not fixing here (out of scope for this spec-writing step); see
  Verification § 3e for the practical consequence (name the checkout before diffing).
- **The structural-rewrite escape hatch is prose-only and self-reported by the reviewer**, not
  verified by any code. A reviewer could over-claim "this needs a structural rewrite" to avoid
  writing a precise change list. Accepted risk: building a real diff-size gate to catch this would
  need a saved snapshot of the pre-review file to diff against, which nothing captures today (see
  Phase 4's manual capture instead) — out of scope for this change. `review-spec`'s existing
  "Judge the spec, not its prose" discipline is the only defense, unchanged by this spec.
- **New, from review iteration 2 — the converse risk, which is the measured one.** A reviewer who
  itemises many genuinely small changes scattered across the whole document produces a change list
  that is legitimately cheaper to apply as one rewrite than as N separately-anchored edits, and a
  hard, unconditional "never re-emit" would reproduce the sibling spec's measured 65,045-character
  outcome (§ Problem). § Solution 2's widened `specRevisionFeedback()` escape hatch — "or unless
  the items below, taken together, change most of the file" — is the mitigation: it hands the
  judgement back to the model, in `FILE_WRITE_RECIPE`'s own words, rather than requiring the
  reviewer to pre-declare a structural rewrite it may not have recognized as one. A consequence
  worth stating plainly rather than discovering at Phase 4: **acceptance criterion 3's "≥60% output
  token drop" is conditional on the change list staying bounded to isolated sections.** A change
  list that legitimately spans most of the document is the one case where the drop legitimately
  will not hold — that is the escape hatch firing correctly, not the fix failing. Phase 4's real
  revision run should report which case it observed (bounded change list vs. named structural
  rewrite) rather than treat a low measured drop as a failed criterion without checking which case
  it was.
- **Rewording the shared `checkFailure` wrapper (`run.ts:4399-4400`) affects every `onFail`/verify
  retry in the engine**, not just `spec-to-deploy`. Low risk: it is wording only (the appended
  content is unchanged), no test pins the old string (verified by grep), and the new wording is
  strictly more accurate for every existing caller — but Phase 3's test suite run is the gate that
  actually confirms nothing else broke.
- **Sequencing risk if Phase 0 is skipped**: implementing against this worktree's current, stale
  base would re-derive `FILE_WRITE_RECIPE`/`Edit`-on-`spec` independently and produce exactly the
  merge conflict the sibling brief predicted. Named explicitly in § Prerequisite and Phase 0 so it
  cannot be missed by whoever implements this.
- **`CHECK_OUTPUT_CAP = 20_000` (`run.ts:97`) truncates `reviewReport` from the END**
  (`.slice(-CHECK_OUTPUT_CAP)`) if the reviewer writes more than 20,000 chars total. A structured
  per-item list is very likely far shorter than the free prose it replaces (per the brief's Open
  Question 6), so this is very unlikely to bind — but `review-spec`'s prompt already asks for
  concise, concrete `CHANGE:` text per item, which keeps this comfortably true without a code
  change to the cap.

## Verification

1. **Unit (automated).** Phase 3's new and updated assertions in `types.test.ts` and
   `review-verdict.test.ts` (or its sibling), run via `npm test` **from the repo root** —
   corrected after review iteration 2's nit: `AGENTS.md` § Validation runs every gate from the
   root, and the root `vitest.config.ts` projects list is what `npm test` is documented against,
   not a per-package `packages/cezar/` invocation.
2. **Gates.** Corrected after review iteration 1: `npm run lint` does not exist in this repo (no
   `lint` script in either `package.json`, no `.eslintrc*`/`eslint.config.*` anywhere — confirmed
   directly) and the original list omitted two gates `AGENTS.md` § Validation actually requires.
   The real gate, in that section's order: `npm run typecheck`, `npm test`, `npm run test:unit`,
   `npm run build`, `npm run test:package` — all green. Read `AGENTS.md` § Validation first for
   this repo's own environment traps (`NODE_ENV=production` zeroing `npm ci`'s devDependencies; a
   cockpit session's exported knobs the server suites assert on; `TMPDIR` inside a git repo) before
   concluding a suite is unrunnable.
3. **Runtime, on a real revision run (Phase 4, QA needed).** Trigger (or wait for) a
   `spec-to-deploy` run whose `review-spec` step returns `CEZ:REVIEW=revise`. On that run:
   a. Read the `review-spec` step's report (`reviewReport`, or the step's transcript) and confirm
      it contains at least one `FILE:`/`SECTION:`/`CHANGE:` item.
   b. Identify the `spec` step's iteration-2 `sessionId` (a fresh `randomUUID()` minted at
      `run.ts:4415` on the loop-back — distinct from iteration 1's). Read that session's raw event
      journal and confirm its tool calls are `Read`/`Edit`, not a single `Write`/`Bash` heredoc
      covering the whole file — unless the reviewer's report explicitly named a structural
      rewrite, in which case a single larger `Write` is the expected, called-out exception.
   c. **Output-token drop (acceptance criterion 3, first half). Corrected during implementation
      (must-fix nit from review iteration 3) — the recipe below named artifacts that do not exist
      in the journal.** Measured directly against `.ai/cezar/runs/70f19253-....ndjson`: the event
      type is `usage.updated` (not `usage`), the field is `usage.output` (not `output_tokens`), and
      the event is keyed by `stepId` ONLY — it never carries `sessionId`, so "sum under each
      session id" is not executable. Exactly ONE `usage.updated` fires per session, at session end
      (a cumulative total, not a per-turn delta) — so TAKE the event, don't sum. Iteration 1 vs
      iteration 2 are the 1st and 2nd `usage.updated` event with `stepId === 'spec'`, ordered by
      `ts`; cross-check against `session.started` events for the same `stepId` (those DO carry
      `sessionId` + `stepId` + `ts`, one per session, which is what confirms which `usage.updated`
      belongs to which iteration). Confirm iteration 2's `usage.output` is **≥60% lower** than
      iteration 1's, against the measured baseline this task was filed against (50,052 → under
      20,000 on `70f19253`; the verified reference pair on that same run was spec 40,619 then
      50,052).
   c2. **New, from review iteration 2 (D2) — `review-spec`'s OWN output tokens, both iterations,
      same corrected method.** `review-spec` runs on `SPEC_REVIEW_MODEL` (`types.ts:583` on
      `origin/main` — re-anchored here after the implement step found this citation was stale,
      `opus`, the expensive model), and its prompt now asks for a concrete change list instead of
      open prose (§ Solution 1). That is not free: if `review-spec`'s output grows by roughly what
      `spec`'s iteration-2 output shrinks by, criterion 3 goes green while the run gets no faster
      and costs more. Read `usage.output` the same way as 3c — the 1st and 2nd `usage.updated`
      event with `stepId === 'review-spec'` — for that step's iteration-1 and iteration-2 sessions
      (the verified reference pair on `70f19253` was review-spec 21,784 then 18,812 — that run's
      own `review-spec` output FELL between iterations rather than growing, so its net check was
      not stress-tested there; recompute against whatever the real Phase 4 revision run actually
      shows, don't assume the same direction). **Report the NET change**: `(spec iter1 − spec
      iter2) − (review-spec iter2 − review-spec iter1)`, in tokens, alongside criterion 3's
      per-step number. Criterion 3 as literally asked is satisfied by 3c alone — but state
      explicitly whether the net figure is negative (a real win) or not. If `review-spec`'s output
      grows by more than `spec`'s shrinks, say so plainly and treat that as "the change-list format
      needs to get terser," a follow-up, not as this task being done.
   d. **Max tool-call input size (acceptance criterion 3, second half).** For every `tool-call`
      event in iteration 2's session, measure the serialized `input` length (`Edit.old_string.length
      + Edit.new_string.length`, or `Write.content.length` for the rare structural-rewrite case).
      Confirm every one is under 10,000 chars, with the single named exception being a
      reviewer-declared structural rewrite (call this out explicitly if it occurs; it should not
      occur on an ordinary content-fix revision).
   e. **Byte-identical unflagged sections (acceptance criterion 4).** Capture the spec file's
      content as it stood right when `review-spec` started (the last state iteration 1 wrote —
      recoverable either by reading the file on disk at that instant during a live-watched run, or
      by reconstructing it from iteration 1's `Write`/`Edit` tool-call payloads in its session's
      event journal) and again after iteration 2 finishes. **Name which checkout you are reading
      both copies from before diffing** — per § Risks, the `spec` step is observed (on this task's
      own run) writing to the main checkout's `.ai/specs/`, not the run's own worktree, and the two
      directories are distinct, non-symlinked paths that can each hold a same-named file; diffing
      one iteration's copy in the worktree against the other's copy in the main checkout would
      compare two unrelated files, not two revisions of the same one. `diff -u` the two copies from
      the SAME checkout. Confirm every changed line falls inside a section the reviewer's change
      list actually named; no line outside those sections differs.
   If this task's own chain does not naturally produce a `revise` verdict to observe, file a
   follow-up todo for this step specifically (same pattern as `e91ba865`/`221cf511`/`ea54dd16`)
   rather than marking it done on an assumption.
