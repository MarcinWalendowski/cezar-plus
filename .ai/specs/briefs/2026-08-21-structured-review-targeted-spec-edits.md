# Structured review verdicts, and targeted edits on spec revision

- Date: 2026-08-21
- Category: prompt doctrine (agent-facing text) + workflow mechanism
- Priority signal: high — todo `a7ebbe3f-ec42-4ce0-8b9d-90c60dfed6b4`, filed high, started, is
  this task verbatim. Measured on run `70f19253-cf6b-407c-92e0-96a8020a8ebb`: the `spec` step's
  revision pass (iteration 2) cost 216s of pure generation re-emitting 51,450 chars — longer than
  the 37,188-char original (iteration 1) — via one `cat > … <<'SPECEOF'` heredoc.
- Risk signal: **high — active scope collision with an already-implemented sibling change on
  branch `cez/f272fda8` that edits the exact same step prompts in the exact same file.** See
  § "In-flight conflict" below; this is not optional context, it decides how this task must be
  scoped.

## Problem, in this repository's own terms

`packages/cezar/src/workflows/types.ts` defines `SPEC_TO_DEPLOY_WORKFLOW` (the built-in
`spec-to-deploy` chain: `context → spec → review-spec → implement → run-tests → commit-push →
document → deploy`). Two things combine to make a spec revision expensive:

1. **`review-spec`'s output is unstructured prose, not a change list.** Its prompt
   (`types.ts:697-724`) asks the reviewer to answer five open-ended questions and end with a
   verdict marker on its own last line — `CEZ:REVIEW=pass` or `CEZ:REVIEW=revise`
   (`parseReviewVerdict`, `types.ts:493-502`). There is no requested structure (file / section /
   what-to-change) anywhere in the prompt. Whatever the reviewer writes above the verdict line is
   the ENTIRE artifact the next step gets.
2. **That raw prose becomes the entire "what changed" signal for the retried `spec` step, and the
   `spec` step's prompt does not vary by iteration.** In `run.ts`:
   - `state.reviewReport = turnText.trimEnd().slice(-CHECK_OUTPUT_CAP)` (`run.ts:4480`,
     `CHECK_OUTPUT_CAP = 20_000`, `run.ts:97`) — the reviewer's raw turn text, capped, kept whole
     ("kept whole… rather than reduced to the verdict word", `run.ts:4478-4479`).
   - On a `revise` verdict, `loopBackTo(i, step, report ?? '...', message)` (`run.ts:3970-3975`)
     sets `checkFailure = feedback` (`run.ts:3783`), i.e. `checkFailure` = that raw prose.
   - `runAgentStep` then does: `if (checkFailure) userPrompt += '\n\nA verification command
     failed after the previous attempt. Fix the cause. Failing output:\n\n${checkFailure}'`
     (`run.ts:4399-4400`). **This is the ONLY difference between iteration 1's prompt and
     iteration 2's prompt for the `spec` step**, and it is a generic string written for a failed
     shell check (`onFail`/`verify` retries reuse the identical channel) — "a verification command
     failed" is not even true of a review; nothing in it says "apply these as edits" or "do not
     rewrite the file."
   - The `spec` step's own literal prompt (`types.ts:649-676`) is identical for both iterations:
     "write ONE spec file… following this repository's own conventions." It never distinguishes a
     from-scratch write from a revision, and gives no `Edit` instruction (see next point).

The result measured on `70f19253`: `review-spec` wrote a prose report; `spec` (iteration 2) read
`checkFailure` framed as a "verification failure," then re-ran its unchanged "write ONE spec file"
instruction against a blank slate, producing a second `cat > … <<'SPECEOF'` of the ENTIRE document
(51,450 chars, longer than the 37,188-char original) instead of touching only what the reviewer
flagged. Nothing checks that the sections the reviewer did not criticize survived byte-identical —
because nothing was ever diffed; the whole file was retyped from the model's own memory of it.

## What the record already decided (citations)

- **The three-step split (`context`/`spec`/`review-spec`) and the `onFail: {retry:'spec',
  max:2}` loop are already implemented**, not proposed here.
  `.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md` (status: `draft 2026-08-20`,
  but its P1-P3 code is live in `types.ts`/`run.ts` today — commit `097d1b15` and later). That
  spec defines the `CEZ:REVIEW` marker and the loop-back but **says nothing about the review's
  output format or about full-rewrite-vs-targeted-edit** — confirmed by direct read (a
  read-only sub-agent quoted its retry description, "reset the intervening steps to pending…
  append the failure text to the retried agent's prompt," with no format requirement).
- **`.ai/specs/2026-08-21-per-step-model-policy.md` (implemented 2026-08-21)** only assigns
  `review-spec` → opus, the other seven steps → sonnet (`SPEC_TO_DEPLOY_STEP_MODEL` /
  `SPEC_REVIEW_MODEL`, `types.ts:526-529`). No bearing on prompt content or output format, but it
  is a **live constraint**: whatever change list format `review-spec` is asked to produce, it is
  opus that has to produce it, and whatever the `spec` step does with it runs on sonnet.
- **The form of a prompt, not the tool grant, is what predicts model behavior — measured twice in
  this repo, not asserted once.** `types.ts:872-878` (the `document` step's own comment) records
  a controlled A/B: fan-out stated as its own imperative paragraph → 3/3 adoption; the same grant
  behind a subordinate clause → 0/2. `.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md`
  is the full writeup. **This directly bears on how the new "apply as targeted edits" instruction
  must be written** — as its own imperative paragraph with explicit rules, not a clause folded into
  the existing "write ONE spec file" sentence.
- **`TOOL_BUDGET_DOCTRINE` (the universal system-prompt doctrine, `run.ts`, doc `~499-566`) is at
  252 words against a documented `<260`-word cap** (asserted `system-prompt.test.ts:138`,
  raised from 210 with a written argument in `.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md`
  R1). **There is no headroom to add this doctrine there** — any new instruction almost certainly
  belongs in the **step prompt**, not the universal doctrine, both because of the word cap and
  because "review verdict format" / "spec revision behavior" only apply to one workflow's two
  steps, not to every agent step cezar runs (mirrors the "universal → doctrine; step-specific →
  step prompt" rule settled in the fan-out spec's Open Questions item 5, restated in the sibling
  brief below).

## In-flight conflict — read before scoping this task

**Branch `cez/f272fda8` (worktree
`.ai/cezar/worktrees/f272fda8-3cbe-4c4a-924c-6fcd6d1243b4`), commit `76c8de0c`, spec
`.ai/specs/2026-08-21-edit-an-existing-file-never-re-emit-it.md` (status: IMPLEMENTED, NOT yet
merged to `main` — `git merge-base --is-ancestor 76c8de0c HEAD` on this worktree is false) has
**already**:

1. Added a new shared constant `FILE_WRITE_RECIPE` (`types.ts:~500`, ~250 words) — an imperative
   paragraph instructing: use `Edit` (old_string→new_string) for a change to an existing file, use
   `Write` only for a file that doesn't exist yet, override the CLI's built-in bypass-mode
   Bash/heredoc-first instruction for file mutation specifically, and an explicit exception for
   genuine majority-rewrites.
2. Added `FILE_WRITE_RECIPE` into the **`spec`**, `implement`, and `document` step prompts, and
   added `'Edit'` to the **`spec`** step's `allowedTools` (was `['Read','Grep','Glob','Write','Bash']`,
   now `+'Edit'`).
3. **Its own brief explicitly flagged this exact task as a scope collision before implementing**
   (`.ai/cezar/worktrees/f272fda8-.../.ai/specs/briefs/2026-08-21-edit-over-heredoc-file-writes.md`,
   § Open questions item 2): *"Scope collision with queued run `0762e872`... Both edit the same
   literals in `types.ts` on separate branches and will conflict. Either this task drops `spec` and
   leaves it to `0762e872`, or `a7ebbe3f` is folded in and its run cancelled. **This is a decision,
   not a merge problem.**"* — and then proceeded to touch the `spec` step's prompt and
   `allowedTools` anyway (its own recorded open question, apparently left unresolved rather than
   acted on).

**Consequence for this task's spec-writing step:** the `spec` step's exact current prompt/`allowedTools`
in `types.ts` on `main`/this worktree (no `Edit`, no `FILE_WRITE_RECIPE`) **will not be what's on
disk once `f272fda8` merges.** Two live facts to design against:

- `FILE_WRITE_RECIPE` gives the mechanism (Edit over heredoc, generically, for any file mutation)
  but is **content-agnostic** — it never mentions review verdicts, revision iterations, or "don't
  re-emit the whole document." It solves "if you're going to touch three lines, use Edit," not
  "here is specifically what changed and here specifically is why you shouldn't touch the rest."
  This task's job is the complementary, narrower piece: the **review step's output shape** and the
  **revision-specific instruction** telling `spec` iteration ≥2 to use exactly that shape as its
  edit list.
- This task and `f272fda8` will produce a real merge conflict on the same lines of `types.ts` (the
  `spec` step's `prompt` array and `allowedTools`) if both land independently. **This brief does
  not resolve that collision — it is a decision for whoever writes the spec**, but the spec MUST
  name it explicitly and pick one of: (a) treat `f272fda8`'s `FILE_WRITE_RECIPE` as a merged
  prerequisite and build this task's change on top of it (the `spec` step already having `Edit` +
  the generic recipe, so this task only adds the revision-specific instruction and the
  `review-spec` output-format change); (b) implement independently against current `main` and flag
  the merge conflict as a known follow-up; the sibling's own brief already frames this as "not a
  merge problem" but a scoping decision, so re-litigating that is in scope for the next step, not
  this one.

## Which code is actually involved

| file:line | what it is |
| --- | --- |
| `packages/cezar/src/workflows/types.ts:493-502` | `parseReviewVerdict` / `REVIEW_VERDICT_RE` — the `CEZ:REVIEW=pass\|revise` parser. Format is fixed at one word; nothing here would break if the reviewer's prose ABOVE the verdict line gained required structure. |
| `types.ts:678-725` | The **`review-spec` step** — prompt, `allowedTools: ['Read','Grep','Glob','Bash']` (no Write/Edit, deliberate), `onFail: {retry:'spec', max:2}`, `requiresApproval: true`. This is the step whose prompt needs the "emit a structured change list" instruction. |
| `types.ts:640-677` | The **`spec` step** — prompt, `allowedTools` (currently no `Edit`; will gain one via `f272fda8` if merged first). Needs the "on iteration ≥2, apply the change list as targeted edits, don't re-emit" instruction. |
| `run.ts:3959-3990` | Where `reviewVerdict`/`reviewReport` are read off the finished `review-spec` turn and, on `revise`, handed into `loopBackTo` as `feedback`. |
| `run.ts:4475-4481` | Where `state.reviewReport` is captured: `turnText.trimEnd().slice(-CHECK_OUTPUT_CAP)` — the reviewer's raw prose, last 20,000 chars, kept whole. If the review's required output format changes, this capture logic does not need to change (it's format-agnostic slicing), but the **20,000-char cap** should be checked against a realistic structured change-list size (much smaller than free prose, so headroom only improves). |
| `run.ts:4397-4401` | `runAgentStep`'s prompt assembly: `userPrompt += '\n\nA verification command failed after the previous attempt. Fix the cause. Failing output:\n\n${checkFailure}'`. **This generic, mislabeled text is what actually reaches the `spec` step on revision** — it is shared by every `onFail`/`verify` retry in the whole engine, not specific to reviews. Acceptance criterion 2 ("on iteration ≥2 the spec step's prompt directs it to apply changes as targeted edits") most likely requires either (a) new text appended specifically for the review-triggered case (would need a way to distinguish "review revise" from "check/verify failure" at this call site — currently both flow through the same untyped `checkFailure: string \| null` parameter), or (b) instructional text inside the `spec` step's OWN prompt literal that conditions on the presence of appended failure text ("if the section below contains reviewer feedback, treat it as a change list and edit only what it names"). Both are legitimate; the spec must pick one and say why. |
| `run.ts:97` | `CHECK_OUTPUT_CAP = 20_000` — the cap applied to `reviewReport`. |
| `types.ts:872-878` | The `document` step's own recorded A/B finding on imperative-paragraph vs. subordinate-clause prompt phrasing — the precedent this task's new instructions should follow. |
| `packages/cezar/src/workflows/types.test.ts:126-143` | Existing structural tests for `review-spec` (onFail shape, verdict markers present in prompt, requiresApproval, opus model). A new test asserting the change-list format and the revision instruction should sit alongside these. |
| `packages/cezar/src/core/claude-cli-runner.ts:679-706` | Why prompt text is the only lever at all: `--allowedTools` grants additively and does not restrict on Claude; bypass-permissions mode is unconditional; the CLI injects its own Bash-first file-write preference that step prompts must explicitly override. |

## Any prior decision this would contradict

None directly — no prior spec defines a required review output format or a revision-specific spec
prompt. The one thing worth flagging as tension rather than contradiction: `review-spec`'s prompt
today explicitly says *"Judge the spec, not its prose… `revise` is for a spec that is wrong,
incomplete... not for one you would have worded differently"* (`types.ts:721-722`) — a structured
change-list requirement must not turn this into a line-editing/style pass; the five judgment
questions (does it solve the task, are its citations true, does it contradict a decision, are
phases shippable, what's missing) stay the substance, and the structure is only about how the
verdict's list of defects is FORMATTED for the next step to consume mechanically, not a narrowing
of what counts as a real defect.

## Open questions the spec will have to settle

1. **Exact schema of the "structured change list."** Acceptance criterion 1 says "file, section,
   what to change" — is this free-form markdown with a fixed heading shape (`### <file> § <section>`
   list items), a fenced block the `spec` step parses visually (no code parses it programmatically
   today — there is no JSON/YAML verdict channel, only the `CEZ:REVIEW=` regex), or something
   stricter? Given `parseReviewVerdict` is a regex over the LAST line only and everything else is
   opaque prose to the engine, the pragmatic choice is a **prescribed markdown shape the model
   follows by instruction**, not a machine-parsed schema — consistent with how `CEZ:SPEC_PATH` and
   `CEZ:REVIEW` already work (declared markers in prose, not structured payloads the engine parses).
2. **How does `spec` (iteration ≥2) know it's a revision, precisely?** `checkFailure` is non-null
   exactly when this is a loop-back (from a review OR a failed verify — currently the same channel,
   see `run.ts:4397-4401` above). Does the fix rely on that existing signal (append revision-mode
   instructions inside the appended failure text at the call site) or does the `spec` step's own
   prompt carry a permanent conditional paragraph ("IF the material above this line is reviewer
   feedback, treat it as...")? The former is more surgical but the call site is shared plumbing used
   by every retry in the engine — changing its generic message could ripple to unrelated `verify`/
   `onFail` retries elsewhere; the latter keeps the blast radius to `types.ts` only. Recommend the
   spec choose explicitly and say why, per the repo's "changing a mechanism that already works"
   doctrine (`AGENTS.md`/global `CLAUDE.md`, "name what the old mechanism was load-bearing for").
3. **Does "forbids re-emitting the whole document unless the reviewer explicitly asked for a
   structural rewrite" need a new escape hatch in the change-list format** (e.g., a reviewer line
   like "STRUCTURAL REWRITE NEEDED: <why>") so a genuine large-scope revise isn't blocked by an
   instruction that says "never rewrite"? `FILE_WRITE_RECIPE` (sibling branch) already carries
   exactly this kind of honest exception for majority-rewrites — worth reusing that framing rather
   than inventing a second one.
4. **Interaction with `Edit` tool availability.** If this task lands independently of `f272fda8`,
   the `spec` step currently has NO `Edit` in `allowedTools` (`types.ts:647`, confirmed by direct
   read: `['Read','Grep','Glob','Write','Bash']`) — "apply changes as targeted edits" is not
   achievable without granting it. The spec must add `'Edit'` to the `spec` step's `allowedTools`
   regardless of whether `f272fda8` merges first (idempotent either way).
5. **Measurement plan for acceptance criterion 3** (iteration-2 output tokens drop ≥60%,
   50,052 → under 20,000; no single tool-call input > 10,000 chars) and criterion 4 (byte-identical
   unflagged sections). Neither is measurable from inside the implementing step itself — the
   sibling `f272fda8` spec explicitly names this trap ("a byte counter measured from inside the
   step it counts... an in-flight step cannot measure its own peak context, because the act of
   writing the measurement raises it," citing `f65ccdde`'s retraction). This needs a **real,
   separate revision run** after deploy, the same "implemented, empirical criterion outstanding,
   filed as a follow-up todo" pattern both sibling specs used
   (`e91ba865`, `221cf511`, `ea54dd16` are the precedent todos). `cez run stats` has no
   `toolInputChars`/byte-diff field yet on `main` — `f272fda8`'s branch adds one
   (`toolInputChars`, `heredocChars`, `heredocFileWrites`, `heredocRewrites`,
   `heredocRewriteWasteChars` in `runs/stats.ts`) but again, not yet merged. Criterion 4 (byte-diff
   the two spec file versions) is straightforward with plain `diff`/`git diff` against the two
   committed revisions of the `.ai/specs/*.md` file — no new instrumentation needed for that one.
6. **`CHECK_OUTPUT_CAP = 20_000`** (`run.ts:97`) truncates `reviewReport` to its LAST 20,000
   characters. A structured change list is almost certainly far shorter than a 20,000-char prose
   report, so this is very unlikely to bind — but if the reviewer is asked to quote long code
   excerpts per defect, worth a one-line check in the spec that the cap still comfortably covers
   the new format's realistic size.

## What I could not find

- No existing spec, KB entry, or test asserting a required format for `review-spec`'s output beyond
  the single trailing verdict word.
- No mechanism today that distinguishes, at the `runAgentStep` prompt-assembly call site
  (`run.ts:4397-4401`), a review-triggered loop-back from a check/verify-triggered one — both are
  the same `checkFailure: string | null` parameter with the same generic wording.
- No merged version of `f272fda8`'s `FILE_WRITE_RECIPE` / `Edit`-on-`spec`-step change on `main` or
  this worktree's branch — it exists only on `cez/f272fda8`, unmerged, as of this brief.
- No `toolInputChars`/output-token-per-step metric on `main`'s `runs/stats.ts` today (confirmed by
  grep — the field does not exist outside the `f272fda8` branch).

## The three or four facts that most constrain the design

1. **The only behavioral lever the engine gives you between iteration 1 and iteration 2 of `spec`
   is the generic, mislabeled `checkFailure` text appended at `run.ts:4397-4401`** ("A verification
   command failed... Failing output:") — shared with every other `onFail`/`verify` retry in the
   engine. Deciding whether to special-case this call site or condition inside `types.ts`'s own
   `spec` prompt is the central design fork.
2. **A sibling branch (`cez/f272fda8`, commit `76c8de0c`, unmerged) already edited the exact same
   `spec` step's prompt and `allowedTools` in `types.ts`, for a closely related but distinct reason
   (generic Edit-over-heredoc), and its own brief predicted this exact collision and left it
   unresolved.** The next step cannot write this spec without deciding how to sequence against
   that branch.
3. **Prompt form measurably changes model behavior in this repo — an instruction folded into an
   existing sentence gets ignored; the same instruction as its own imperative paragraph with named
   rules gets followed (3/3 vs 0/2, `types.ts:872-878`).** The new "treat this as a change list, use
   `Edit`, don't rewrite" instruction must be written as its own paragraph, not a clause.
4. **`TOOL_BUDGET_DOCTRINE` has 8 words of headroom under its documented cap** — this change
   belongs in the `review-spec` and `spec` STEP PROMPTS, not the universal doctrine.
