# Plain-End Question Verification

**Status (current, 2026-08-29): Implemented and Done.** All three phases landed in `5bec2e55`
("docs: verify plain-end structured question with a runtime E2E") and are merged to `origin/main`
in `2394d174`. P1 shipped `packages/web/e2e/plain-end-question.e2e.ts`: the focused run reported
`TEST_E2E_STATUS=passed` for all three cases (question fallback, nudge-to-chips, report park),
twice, and the V5 discriminating-mutation check (gut `task-thread.tsx`'s `hasWaitingQuestion` to
`false`, rebuild `web/dist`, rerun) reproduced exactly the predicted split, case A red / case C
still green, then was reverted and rebuilt clean. P2 corrected `.ai/specs/2026-08-23-plain-end-structured-question.md`
in place (5 markers: status block, nested-defects stack, verification-table row, the line-786
"never run" sentence, the runbook) — verified by direct read, not by re-running V7's greps in this
step. P3 filed two KB proposals to the durable lessons log and one follow-up todo for an unrelated
onboarding bug found along the way (`fc8fecca`, still open, out of this spec's scope). A second
todo filed mid-session (`9105b80b`, a pre-existing `global-tasks.tsx` typecheck/test break found
by this task's own `run-tests` step, also out of scope) is now moot: the file it names no longer
references the undefined symbol at `HEAD`, resolved incidentally by `7ec6f951` landing through
`origin/main` before this branch merged. `cezar todo` has no `close`/`resolve` subcommand
(`cezar todo --help`: only `add`/`start`/`list`), so the entry itself is left as `todo` in
`.ai/cezar/todos.json` rather than hand-edited outside that tool's contract; this paragraph is the
record that it is resolved. The gate suite was re-run once more after this spec's own implement
step, on the merged `HEAD` `2394d174`:
`npm run typecheck` exit 0, `npm test` 12269 passed / 4 skipped (0 failed — the C18 knowledge-catalog
budget flake this spec's Verification section warned about did **not** reproduce this run), `npm
run test:unit` 47/47, `npm run build` exit 0, `npm run test:package` 25/25. Per this spec's own
"Done vs QA Needed" rule below (V2 `passed`, not `skipped`, and V5 demonstrated it can fail), this
closes as **Done**, not QA Needed. The original scope statement, current at spec-writing time,
follows unchanged.

**Status:** Spec, not yet implemented. Scope is **verification and record reconciliation**, not
re-implementation: the mechanism this task asks for already landed in `d811d34c` (2026-08-24) and
is an ancestor of this branch's `HEAD` (`0a46010b`, `cez/eba6cb05`).

**Date:** 2026-08-29
**Task:** `eba6cb05-f995-4fc3-9cf1-0852977296d1`
**Brief:** `.ai/specs/briefs/2026-08-29-plain-end-question-reconciliation.md` (step 1 of this run)
**Prior spec (the one this completes):** `.ai/specs/2026-08-23-plain-end-structured-question.md`
(KB `specs-af0f9f944acf`)
**Prior task:** `183740fe-df08-4bb6-a46e-5f266354537c`, `status: done`, `archived: true`,
`finishedAt: 2026-08-24T19:46:01.241Z` (`.ai/cezar/runs.json`, verified this session)
**Owner instruction, 2026-08-22:** *"why this is 'The agent is paused, waiting for your reply' - if
agent needs any reply it needs to be done in interactive way with predefined questions and some
suggest answer (like we already do for question)"*

---

## TLDR

The task text reads as if the feature does not exist. It does. Every layer of it (the detector,
the bounded nudge, the two turn-end call sites, the store's clearing rule, the contract fields, the
cockpit's quoted-question box, and the pairing rule in both `handoff.ts` and
`BACKWARD_COMPATIBILITY.md` §8) is present at `HEAD` and was read line by line this session, not
inferred from the prior spec.

What is genuinely open is one thing: **V8, the runtime gate that makes the prior spec Done rather
than QA Needed, has never run on any branch that is reachable from `main`.** Its only evidence is
two screenshots stranded on `cez/183740fe`, an orphan branch now 321 files and 68,805 lines behind
`HEAD`. Alongside it sit two record defects: the prior spec's header still headlines "verification
incomplete, QA Needed, not Done" while its task is closed `done`, and the header itself is a stack
of five nested SUPERSEDED/CORRECTED passes from a single day that a reader cannot resolve without
re-reading the code, as this spec had to.

The prior spec assumed V8 was a manual pass on `prod-host` with screenshots pasted into a
handoff. That assumption is wrong, and it is why V8 never ran: **this repo has an automated
browser E2E suite** (`npm run test:e2e` → `.ai/scripts/e2e.sh` → `packages/web/e2e/*.e2e.ts`), and
`queued-stack.e2e.ts` already demonstrates the exact pattern needed: boot a real cezar against the
mock backend, POST a real run, drive the real cockpit in a real browser. So this spec converts V8
from a manual gate nobody ran into an executable one that runs on every future change, which is
also the assembled scenario test acceptance criterion 5 asks for and which no existing test
provides.

Three phases, each independently shippable: land the E2E spec (P1), rewrite the prior spec's status
into one non-contradictory block (P2), settle the orphan branch and the tracker mismatch in the
record (P3).

---

## Problem

### The mechanism is not the problem: it shipped

Re-stated in this repository's own terms: a cezar agent turn ends one of four ways. Three carry a
guard. The fourth, no marker at all, historically had none, and the cockpit rendered the identical
*"The agent is paused, waiting for your reply"* banner whether the agent asked something real or
simply stopped. That is what the owner reported on 2026-08-22, and it is what `d811d34c` fixed.

Verified at `HEAD` (`0a46010b`) by direct read, this session:

| Layer | Where | State |
|---|---|---|
| Detector | `packages/cezar/src/core/turn-question.ts` (76 lines) | Present. Pure regex, no I/O, no LLM. `QUESTION_SCAN_TAIL_CHARS = 1200`, `TRAILING_QUESTION_MAX_CHARS = 280`, `FENCE_RE`, `PROTOCOL_LINE_RE`, `DECISION_CUE_RE` (a closed 11-cue list; bare `confirm` deliberately excluded). Returns the agent's own sentence verbatim or `null`. It never synthesises. |
| Bounded nudge | `run.ts:8497-8528` (`parkPlainEnd`), `:471` (`MAX_ASK_STRUCTURE_NUDGES = 1`), `:475` (`ASK_STRUCTURE_NUDGE`) | Present. Skips cancelled, autonomous and closed-session runs; appends a `note` event naming the spend; otherwise parks with `waitingReason: 'question' \| 'report'` and `waitingQuestion`. |
| Both turn-end twins | `run.ts:5155` (`runAgentStep`), `run.ts:7445` (`runContinuation`) | Present. One shared method called from both, per the prior spec's R3. |
| Store clearing | `store.ts:949-986` | Present, and it is the **transition-keyed choke point** the prior spec's own review said was still missing: `normalized.status !== run.status && !hasOwnProperty(patch, 'waitingReason')` clears both fields, with a deliberate same-status exemption for the idle reap. The earlier enumerate-five-call-sites approach is gone. |
| Contract | `packages/contract/src/runs.ts:476,478` and `:676,678` | Present in **both** schema variants: `waitingReason: z.enum(['question','report','handoff'])`, `waitingQuestion: z.string().max(280)`. |
| Server projection | `server.ts:7563-7564` | Present. Both fields projected into the runs **index**, not only the detail route, so a cross-project board sees the reason too. |
| Notifications | `notifications/observer.ts:104-105` | Present. Both fields ride into the snapshot the decider reads. |
| Cockpit | `task-thread.tsx:195` (`hasWaitingQuestion`), `:437-462` (render) | Present. A `question` park renders the agent's sentence in a bordered quote box inside `[data-slot="paused-hint"]`; a `report` park renders the historical banner unchanged. |
| Contract prose | `handoff.ts` (`HANDOFF_ONLY_INSTRUCTIONS`), `BACKWARD_COMPATIBILITY.md` §8 | Present. Both state the pairing as a **rule**: a plain end is "for a turn the user only reads", and a plain end containing a question "is a defect the engine will nudge you to fix, once". §8 additionally classes the plain end as part of the marker vocabulary rather than an absence of one. |
| Unit/integration tests | `turn-question.test.ts` (11 `it` blocks, one of them a loop over every decision cue), `run.test.ts:1923-1988` (five plain-end cases: report park, nudge-once-then-park, continuation twin, ask upgrade, autonomous exemption), `store.test.ts`, `task-thread.test.tsx:241-254`, `recover-pending-ask.test.ts`, `decider.test.ts:141`, `runs-index-api.test.ts:446-464` | Present and specific. |

So acceptance criteria 1–4 are, as written, **already satisfied in code**. They must be re-read as
verification criteria against landed code, not as implementation criteria.

### What is actually broken

**1. The runtime gate never ran where it counts.** The prior spec's own verification table ends
`| V8 runtime E2E | **no**, never run |`, and its closing line is unambiguous: *"V8 is what makes
this Done rather than QA Needed, and V8 has never run."* Repo doctrine says gates green is
necessary and not sufficient; a user-facing change is QA Needed until a real runtime pass has
executed. Nothing reachable from `main` has ever exercised detector → nudge → park → SSE →
projection → browser render as one scenario. Every existing test stops at a module boundary.

**2. The only evidence that exists is stranded and un-reproducible.** `cez/183740fe` still exists
locally; its tip `89535360` ("cezar autosave (turn end)") adds
`.ai/qa/artifacts/plain-end-structured-question/v8-ask-chips.png` and `v8-question-fallback.png`.
`git merge-base --is-ancestor 89535360 HEAD` → **not an ancestor**. I extracted both from the
object store and opened them this session:

- `v8-ask-chips.png`: task titled `mock:ask-on-nudge mock:question runtime paused question QA`,
  showing "The agent is asking" with a `LIBRARY` header and two tappable chips (`date-fns`,
  `Luxon`). The nudge was accepted and produced structured options. This is the owner's requested
  outcome, rendered.
- `v8-question-fallback.png`, same task, later: an `Answered Library: date-fns` card (so a chip
  tap did resume the run), then a follow-up prose question, then the paused banner **with**
  `So: merge and deploy now, or hold for review?` in the quoted box above an enabled composer.

They are real and they show the two cases V8 names. But they are a **manual, one-shot artifact of a
branch that cannot be merged** (merging it would revert 68,805 lines of subsequently landed work),
they do not cover V8's third case (a genuine report parking identically), they carry no NDJSON
evidence of the `note` event, and, decisively, they prove nothing about *today's* code and will
prove nothing about tomorrow's. A screenshot is not a regression test.

**3. The record contradicts itself in two places.** The prior spec's header stacks a `CORRECTED
2026-08-24` block, a `SUPERSEDED 2026-08-24 by d811d34c` block, and an "All three re-confirmed open
on 2026-08-24" block that re-asserts as open the same three defects the block above it marks as
closed. Read top to bottom, it says a defect is fixed and unfixed on the same day. All three
**are** fixed at `HEAD` (table above), so the live document misleads the next reader against the
code. Separately, `183740fe` is `done`/`archived` in `runs.json` while the spec it produced
headlines "QA Needed, not Done", and nothing in the record explains the gap.

### The wrong assumption that caused the gap

V8 as written is a manual runbook: *"Start a real task on `prod-host`… capture screenshots
into the run's handoff."* Manual gates do not run. This one did not, for five days, on a feature
the owner personally reported. The prior spec did not consider `npm run test:e2e` (the repo's own
browser E2E dispatcher), even though `queued-stack.e2e.ts` had already established that a spec can
boot a real cezar server, POST a real run against the mock backend, and drive the real cockpit.

---

## Solution

### Decisions

**D1: Scope is verification and record reconciliation. Do not re-implement.** No change to
`turn-question.ts`, `parkPlainEnd`, the store rule, the contract schemas, the projections or the
cockpit render. Any temptation to "fix" acceptance criteria 1–4 is a re-litigation of `d811d34c`,
and the code is correct. If P1's E2E finds a real defect, that becomes a named phase then, on
evidence, not now, on assumption.

**D2: V8 becomes an automated E2E spec, not a manual pass. This is the core of the work.** New
`packages/web/e2e/plain-end-question.e2e.ts`, modelled on `queued-stack.e2e.ts`, driving all three
V8 cases in one real browser against one real server. This is simultaneously:
- the runtime gate that closes the prior spec's QA Needed status;
- acceptance criterion 5's "regression test that drives a turn ending plainly with a question in
  prose and asserts the user-facing surface is not a dead end", which no existing test provides,
  because every existing test stops at one module's edge;
- reproducible on every future change, which the screenshots never were.

**D3: Do not merge, cherry-pick or resurrect `cez/183740fe`.** Merging reverts landed work. Even
cherry-picking just the two PNGs is wrong: `.gitignore:32` ignores `.ai/qa/artifacts_*/`, so this
repo's stated convention is that QA artifacts are ephemeral and regenerated. The orphan's path
`.ai/qa/artifacts/plain-end-structured-question/` slipped past that rule only because it lacks the
underscore. P1's E2E writes to `.ai/qa/artifacts_e2e/` (the ignored, conventional location, same as
`task-thread.e2e.ts` and `queued-stack.e2e.ts`) and regenerates its evidence every run. The branch
is left in place, untouched (deleting it destroys the only copy of that evidence for no gain), and
P3 records in the spec what it holds and why it was not merged, so the next reader does not
rediscover it as a mystery.

**D4: A `report` park renders exactly as it does today. This is the accepted design, made
explicit.** Acceptance criterion 3 requires prose that is genuinely not a question to park cleanly
without inventing a fake question. The current behaviour (`waitingReason: 'report'` renders the
historical undifferentiated banner, no quote box, `items-center` alignment) satisfies it, and is
already pinned by `task-thread.test.tsx:252-254`. The prior spec never stated this as a *decision*,
which left it readable as an oversight. It is not: differentiating the report case would add a
badge for a state the user does not need to act on. No change; the decision is now on the record.

**D5: The tracker stands; the document is corrected.** `183740fe` correctly reads `done`: it did
ship the code, and the run is closed. Rewriting a closed run's status in `runs.json` to relitigate
a QA gap would corrupt the run history for a documentation problem. Instead, P2 rewrites the prior
spec's status block in place, per the house correction rule (mark what is invalidated where it
stands, keep the original text below, amend the heading when the falsehood is in the heading), and
names `eba6cb05` as the task that closed the gate.

### Non-goals

- Any change to the detector's cue list, thresholds or heuristics. It is deliberately tight.
- Rendering the question in list surfaces (`tasks-overview`, `workspace-tasks`). Both fields are
  already projected into the index (`server.ts:7563-7564`) and available if that is ever wanted;
  the dead end the owner reported was in the thread, and that is where it is fixed.
- Persisting the nudge counter across a server restart (see Risks).
- Reviving any part of `cez/183740fe`'s 321-file divergence.

---

## Architecture

### The four layers, unchanged

```
agent turn ends with no marker
  └─ detectTrailingQuestion(turnText)          core/turn-question.ts       ← pure, verbatim, never invents
       ├─ TrailingQuestion  → parkPlainEnd     run.ts:8497                 ← called from :5155 and :7445
       │    ├─ nudge (≤1/run, skip autonomous/cancelled/closed) → agent re-emits CEZ:ASK → chips
       │    └─ park: status waiting, waitingReason 'question', waitingQuestion <verbatim>
       └─ null              → park: waitingReason 'report', no question
                                   │
                store.updateRun ───┤ transition-keyed clear (store.ts:961-968)
                                   │
       contract runs.ts:476/676 ───┤ both schema variants
       server.ts:7563 ─────────────┤ index + detail projection
       observer.ts:104 ────────────┤ notification snapshot
                                   ▼
       task-thread.tsx:195/437  hasWaitingQuestion → [data-slot="waiting-question"] quote box
                                 report/absent    → historical banner, unchanged
```

### The seam this spec adds

Every existing test cuts this diagram horizontally at one layer. The E2E cuts it vertically:

```
plain-end-question.e2e.ts
  boot: mkdtemp → git init → spawn `cezar serve --repo <tmp> --port <free> --no-open`
        env CEZ_DRY_RUN=1 (selects scripts/mock-claude.mjs), CEZ_HOME=<tmp>/.cez-home
  drive: POST /api/v1/runs { task: 'mock:…', workflow: 'quick-task' }
         poll GET /api/v1/runs/:id until status 'waiting'
         AgentBrowser.goto(`${baseUrl}/tasks/${id}`) → assert DOM → screenshot
```

The mock's verbs make all three cases drivable without an LLM, and they already exist
(`packages/cezar/scripts/mock-claude.mjs:117-118, :250`):

| Verb | Turn shape | Expected surface |
|---|---|---|
| `mock:report` | prose, no `?`, no cue | `waitingReason: 'report'`, no quote box |
| `mock:question` | prose ending in a bare question | nudge spent, agent declines, quote box carries the sentence verbatim |
| `mock:ask-on-nudge mock:question` | question, then a valid `CEZ:ASK` on the nudged turn | `ask.requested`, tappable chips, `waitingReason` cleared |

`run.test.ts:1932-1985` already proves all three at the engine layer, so the E2E is not re-testing
the engine. It is testing that the engine's verdict survives the store, the contract, the SSE
projection and the reducer, and arrives in the DOM. That crossing is exactly what has never been
verified, and it is where a projection or schema regression would hide.

---

## Data models

**No change.** Both fields already exist in both variants of `packages/contract/src/runs.ts`:

```ts
waitingReason: z.enum(['question', 'report', 'handoff']).optional(),      // :476 index, :676 detail
waitingQuestion: z.string().max(280).optional().catch(undefined),        // :478 index, :678 detail
```

`.catch(undefined)` is load-bearing: an old record carrying an over-long or malformed value
degrades to absent rather than failing the whole parse. `max(280)` matches
`TRAILING_QUESTION_MAX_CHARS` in the detector.

## API contracts

**No change.** For the record, as the E2E depends on them:

- `POST /api/v1/runs` `{ task, workflow }` → `CreateRunResponse`, which is a **union**, not
  `{ id }`: either a stored `RunRecord` (the single-run branch) or `{ runs: RunRecord[] }` for a
  batch (`packages/contract/src/runs.ts:819-823`, `server.ts:5299`). P1 always takes the
  single-run branch and reads `id` off the returned record, which is what
  `queued-stack.e2e.ts:83-93` does; an implementer who types the response as `{ id }` will find
  the rest of the record present and the batch shape unhandled.
- `GET /api/v1/runs/:id` → the detail record, including `waitingReason`/`waitingQuestion`: how the
  E2E polls for the park.
- `GET /api/v1/runs` → index rows carrying both fields (`server.ts:7563-7564`), pinned by
  `runs-index-api.test.ts:446-464`, including the negative control that an ordinary row has no
  `waitingReason` key.
- `GET /api/v1/projects` → `{ bootProject }`, for the `/p/<projectId>` URL prefix
  (`agent-browser.ts:108`).
- The marker vocabulary itself is a contract under `BACKWARD_COMPATIBILITY.md` §8. **Nothing in
  this spec changes it**, so §8 needs no edit: the pairing rule it already states is the rule this
  spec verifies.

---

## Phases

Each phase is independently shippable and independently valuable. P1 is the one that closes the
gate; P2 and P3 are record work that can land separately if P1 needs iteration.

### P1: V8 becomes an executable regression (closes AC5 and the QA gate) — shipped, `5bec2e55`

New file `packages/web/e2e/plain-end-question.e2e.ts`. Template: `queued-stack.e2e.ts` (live mock
runs, `CEZ_DRY_RUN=1`, real server) crossed with `task-thread.e2e.ts` (thread-route assertions,
`bootProjectId`, scoped URLs).

1. **Boot**, once, in `beforeAll`: `mkdtempSync` a data root; `git init -q -b main`, configure
   `user.email`/`user.name`, commit a `README.md` (the run needs a repo);
   `spawn(process.execPath, [cezarCli, 'serve', '--repo', dataRoot, '--port', port, '--no-open'],
   { env: fixtureServeEnv(dataRoot), stdio: 'ignore' })`; `waitForHealth`; `bootProjectId`.
   Timeout `180_000`, matching the neighbours.

   **Use `fixtureServeEnv`, imported from `agent-browser.ts`, not a hand-built `{ ...process.env,
   CEZ_DRY_RUN: '1' }`.** A spread of `process.env` inherits **every** `CEZ_*` variable from the
   developer's or the agent's own shell, so hosted-mode and project settings leak into the fixture
   and the test passes or fails for reasons that have nothing to do with it. `fixtureServeEnv`
   exists precisely to prevent that: it strips every `CEZ_*` key before setting its own
   `CEZ_DRY_RUN=1`, `CEZ_HOME` (under `dataRoot`) and `CEZ_ANALYTICS=1` (`agent-browser.ts:84-99`),
   and it is what `agents-dock`, `backlog-composer`, `commit-list`, `composer-defaults`,
   `composer-dispatch-mode` and `task-thread` all use. `queued-stack.e2e.ts`, the boot template
   this spec otherwise copies, uses the older hand-built form because it needs to write a
   `maxParallel: 1` config into `CEZ_HOME` first; **this spec writes no config, so it needs no
   manual `CEZ_HOME` and must not `mkdirSync` one** (`fixtureServeEnv` supplies the path).
2. **Case A: the question fallback (the dead end, gone).** Start `mock:question ship it?`, poll to
   `waiting`. Assert on the API record first: `waitingReason === 'question'` and `waitingQuestion`
   is the mock's own trailing sentence. Then in the browser, at `/p/<project>/tasks/<id>`: a
   `[data-slot="waiting-question"]` exists **inside** `[data-slot="paused-hint"]`, its text equals
   that same sentence, the composer textarea is present and **not disabled**, and the paused-hint
   wrapper's `className` contains `items-start`. Screenshot to
   `.ai/qa/artifacts_e2e/plain-end-question-fallback.png`. **This is acceptance criterion 5's
   assertion**: the surface carries the question, so the user is not told to reply with nothing to
   reply to.
3. **Case B: the nudge produces tappable options.** Start `mock:ask-on-nudge mock:question ship
   it?`. **Wait on a signal that actually exists:** there is no `pendingAsk` field on `RunRecord`
   or in `packages/contract/src/runs.ts` (the engine derives it from events via `runHasPendingAsk`,
   `run.ts:8328`, and the E2E has no store handle), and `waitingReason` is *cleared* when the ask
   lands, so polling the detail record for it is not a wait either. Use either
   `browser.waitForFunction("document.querySelector('[data-slot=\"ask-card\"]') !== null")` after
   `goto` (the selector is real: `task-thread/ask-card.tsx:39,79`), or poll
   `GET /api/v1/runs/:id/history` (`server.ts:5380`) for an `ask.requested` event. Then assert the
   ask card renders with its header and both option chips. The API record is the **negative
   control** here, not the wait: once the ask has arrived, `waitingReason` and `waitingQuestion`
   are both absent, which is exactly what `run.test.ts:1972-1973` asserts at the engine layer.
   Assert no `[data-slot="waiting-question"]` is present. **Screenshot to
   `plain-end-question-chips.png` now, before clicking**, while the chips are on screen.

   Then click the first chip and wait for `[data-slot="ask-card"][data-resolved="true"]`
   (`ask-card.tsx:36-43`: an answered ask collapses to a compact `Answered` summary), asserting
   that summary contains the option that was selected. **Do not assert that the run leaves
   `waiting`, or that it stays out of it.** That assertion is racy and would flake: the mock never
   disarms `questionArmed` once `mock:question` has appeared in any turn
   (`mock-claude.mjs:118`, set and never reset), so the turn that resumes after the chip answer
   appends the same trailing question again (`:251-253`) and the run re-parks within a second or
   two. The durable, non-transient evidence that the tap worked is the resolved card, not a status
   snapshot taken during a race. This is the owner's literal request, *"predefined questions and
   some suggest answer"*, asserted rather than photographed.
4. **Case C: a genuine report still parks cleanly (AC3).** Start `mock:report just do the thing`,
   poll to `waiting`. Assert `waitingReason === 'report'`, `waitingQuestion` undefined,
   `[data-slot="paused-hint"]` present, `[data-slot="waiting-question"]` **absent**, and the
   wrapper `className` contains `items-center`. Screenshot to `plain-end-question-report.png`. No
   fake question is invented.
5. **The NDJSON evidence V8 asks for**, without a second server: after case A, read
   `<dataRoot>/.ai/cezar/runs/<id>.ndjson` and assert exactly one `note` event whose message
   contains `nudged to re-send`, the same assertion `run.test.ts:1941` makes, now against a run
   that went through the real server. This is the one V8 sub-case the orphaned screenshots could
   never show.

Ship: the E2E file only. No source change. If it goes red, that is a genuine finding and the fix is
scoped then, on the failure output.

### P2: the prior spec stops contradicting itself — shipped, `5bec2e55`

Targeted edits to `.ai/specs/2026-08-23-plain-end-structured-question.md`. Per the house correction
rule, this marks what is invalidated in place and leaves the original text below it: the layered
history is the record of what was fixed and must not be deleted.

**Nothing in this phase deletes or rewrites an existing sentence.** The house rule is that a
correction marks what it invalidates *in place* and leaves the original text below it unchanged, so
every step below **inserts** a current statement and **marks** the stale one, and none of them
replaces a word of the original. That applies to the status block, the verification-table row and
line 786 exactly as it already applies to the runbook at 939-945.

1. **Insert a current `Status:` block above the existing one** (which begins at line 3), stating
   without contradiction: implemented in `d811d34c`, all three reviewed defects verified closed at
   `HEAD` (with the file:line evidence from this spec's table), V8 closed by
   `plain-end-question.e2e.ts` under task `eba6cb05`, or, if P1 lands separately, still open and
   named as such. Then give the original block (lines 3-12) a bolded
   **`SUPERSEDED 2026-08-29 by the status block above`** lead-in and leave its text **unchanged
   beneath it**. The new block goes first because it is what a reader scanning the head of the file
   carries away; the old one stays because it is the record of what was believed on 2026-08-24.
2. Leave the three nested `CORRECTED`/`SUPERSEDED`/`re-confirmed open` blocks (**lines 14-38**) in
   place, under one added lead-in: **`RESOLVED 2026-08-29`**, stating that all three were verified
   closed by direct read at `0a46010b` and pointing at this spec's table. Do not delete them.
   **Lines 40-47 are not part of that stack** and must be left untouched: they are the
   `**Date:**` / `**Task:**` / `**Brief:**` / `**Owner instruction**` metadata, and sweeping them
   under a `RESOLVED` lead-in would read as if the task id and the owner's own words had been
   invalidated.
3. In the Verification table, **leave the historical `V8 runtime E2E | **no**, never run` row
   standing** and add a **new row beside it** naming `plain-end-question.e2e.ts` and its result,
   once P1 has actually run. **Do not pre-write a green**, and do not edit the historical row: it
   is what was true when the table was written, and the pair of rows is what shows a reader the
   gate moved.
4. **Two further stale statements live outside the header and the table, and P2 is not complete
   without them.** Line 786, *"V8 is what makes this Done rather than QA Needed, and V8 has never
   run."*, gets a bolded **`CORRECTED 2026-08-29`** lead-in inserted **before** it, naming what
   closed it, with the sentence itself left **unchanged below**. Lines 939-945, the
   bolded `V8` runtime-E2E-on-`prod-host` heading (line 939) and the manual runbook under it
   (lines 940-945) that D2 explicitly replaces, get a bolded **`SUPERSEDED 2026-08-29 by plain-end-question.e2e.ts`**
   lead-in, with the original runbook left below it unchanged per the house rule. Line 939 is the
   one that matters most: a manual runbook is what a future reader would actually follow, so
   leaving it unmarked would send the next session to re-run by hand the pass P1 automated.

Ship: one file, docs only.

### P3: the orphan branch and the tracker mismatch are on the record — shipped, `5bec2e55`

1. Add a short subsection to this spec (or to P2's status block) recording: `cez/183740fe` exists
   locally, tip `89535360`, holding `v8-ask-chips.png` and `v8-question-fallback.png`; both were
   opened and judged this session; both show real, correct behaviour; the branch is **not** merged
   because it is 321 files / 68,805 lines behind `HEAD` and merging reverts landed work; the
   artifacts are not cherry-picked because `.gitignore:32` makes QA artifacts ephemeral and P1
   regenerates them. Leave the branch untouched.
2. Record D5: `183740fe` stays `done`/`archived`; the QA gap it left is closed by `eba6cb05`, not
   by rewriting a closed run's status.
3. Propose one KB entry (NDJSON to `CEZ_KB_WRITE_FILE`, `op: upsert`, scope `project`) recording
   the durable lesson: **a manual verification gate in a spec is a gate that does not run.** This
   one sat unrun for five days on an owner-reported feature while the repo had an E2E dispatcher
   the spec never considered. A spec whose verification section names a runbook instead of a
   command has not planned its test.

   **Carry no `supersedes` key on this proposal.** A lessons note does not replace the plain-end
   spec, and pointing `supersedes` at `specs-af0f9f944acf` would contradict D5 and P2, which keep
   that document live and repair it in place: it would tell every future `cez kb search` reader
   that the spec P2 just fixed is dead. Reference `specs-af0f9f944acf` and this spec in the note's
   **body** instead. If a supersede relation is ever wanted, it belongs on this spec's own future
   KB entry, not on a lessons note.

Ship: docs + one KB proposal. No code.

---

## Risks

- **The E2E dispatcher can legitimately skip.** `.ai/scripts/e2e.sh` exits `0` with
  `TEST_E2E_STATUS=skipped` when no browser provider can be provisioned, deliberately loud and
  non-blocking. A skip is **not** a pass, and reporting P1 green off a skipped run would recreate
  exactly the false-verification problem this spec exists to fix. Verification below requires
  quoting the `TEST_E2E_STATUS=` line.
- **Live-run E2Es are the flakiest kind here.** Case B depends on the mock arming on turn 1 and
  emitting `CEZ:ASK` on turn 2 through the real server. Mitigation: poll the API for state
  transitions (`waitForStatus`-style, as `queued-stack.e2e.ts` does) rather than sleeping, and
  assert the API record before touching the DOM so a failure says which layer broke.
- **P1 may find a real defect at the seam.** That is the point of it. Treat a red as a finding,
  scope the fix on its output, and do not pre-emptively "fix" anything under D1.
- **The nudge cap is in-memory.** `state.askStructureNudges` lives on `ActiveRun`, not in the
  store, so a server restart re-arms it and a long-parked run could be nudged a second time. This
  is bounded (one per process per run) and harmless (the nudge is a message, not an action), but
  it is a real deviation from "once per run" as documented. Named here, deliberately not fixed:
  persisting it is a store-schema change for a cosmetic bound, and D1 keeps this spec out of the
  code.
- **The detector is a heuristic and will misfire both ways.** A report ending in a rhetorical
  question gets a quote box; a question phrased without `?` or a listed cue does not. Both failure
  modes are cheap by construction: a false positive shows the user a sentence the agent actually
  wrote, and a false negative is the status quo ante. The false-positive-stalls-a-chain risk was
  already retired: `run.ts:2571`'s wide `pendingAttention` no longer gates `reenterChain`.
- **Screenshots are evidence, not assertions.** P1 writes three PNGs, but every claim it makes is a
  DOM assertion. If a screenshot is the only thing proving a case, that case is not tested.

---

## Verification

Run from the repo root `/var/lib/cezar/loki-labs/cezar` or this task's worktree. Gates are
`npm run typecheck` and `npm test`. **There is no `lint` script in this repo**, so do not report one
as green (verified: `package.json` `scripts`).

**V1: the landed mechanism is still intact (regression floor for P1).**
`npm test -- turn-question run.test store.test recover-pending-ask task-thread decider
runs-index-api system-prompt`. Expect green. If any of these is red before P1 changes anything,
stop: something else regressed and this spec's premise needs re-checking.

**V2: the new E2E, the gate itself (P1).** `npm run test:e2e`, then **quote the
`TEST_E2E_STATUS=` line**. `passed` is the only acceptable outcome for a Done claim; `skipped`
means the UI was not verified and the gate is still open on this machine; `failed` is a finding.
To iterate on just this spec: `npx vitest run --config packages/web/e2e/vitest.config.ts
plain-end-question`.

**V3: the three cases assert, not photograph (P1).** In the spec's output, all three `it` blocks
green:
- case A: `waitingReason === 'question'`, `waitingQuestion` equals the mock's sentence verbatim,
  `[data-slot="waiting-question"]` present inside `[data-slot="paused-hint"]` with that text,
  composer enabled, wrapper `items-start`;
- case B: ask card with both chips, no `[data-slot="waiting-question"]`, and after the chip click
  an `[data-slot="ask-card"][data-resolved="true"]` whose answered summary names the selected
  option. **Not** a run-status assertion: the mock stays armed and re-parks, so "leaves `waiting`"
  is a race, not a result;
- case C: `waitingReason === 'report'`, no quote box, wrapper `items-center`.

**V4: the NDJSON `note` (P1).** Case A asserts exactly one event matching `nudged to re-send` in
`<dataRoot>/.ai/cezar/runs/<id>.ndjson`. This is V8's sub-case (a) that the orphaned screenshots
could not evidence.

**V5: it discriminates (P1). A test that cannot go red is not a test.** Temporarily change
`task-thread.tsx:195` to `const hasWaitingQuestion = false`, re-run the E2E, and confirm **case A
fails and case C still passes**. Quote both outputs, then revert. A pair of cases that stay green
with the render gutted does not satisfy AC5.

**Rebuild, or this V silently proves nothing.** The spawned server serves the built cockpit bundle
from `web/dist` (`server.ts:7784-7785`), not the React source, so editing `task-thread.tsx` alone
changes nothing the browser can see and case A goes green against the *old* bundle, which reads as
"the mutation did not break it" when in fact the mutation was never loaded. The focused
`npx vitest run --config packages/web/e2e/vitest.config.ts` command in V2 does **not** rebuild:
only `npm run test:e2e` does, via `test-env-up.sh`, and even that skips the build when its
fingerprint over the sources matches the cached artifacts (`test-env-up.sh:248,271-274`). So run
the mutation pass one of two ways, and say which:
- `npm run build:web` first, then the focused Vitest command; or
- `npm run test:e2e -- --force-rebuild`, which sets `FORCE_REBUILD=1` (`test-env-up.sh:65,69`) and
  bypasses the fingerprint short-circuit.

**Then rebuild again after restoring the source**, before the final passing run of V2. Reverting
`task-thread.tsx` does not revert `web/dist`; without a second rebuild the green you report at the
end is a green from the gutted bundle.

**V6: artifacts land in the ignored location (P1/D3).** After a passing run,
`ls .ai/qa/artifacts_e2e/plain-end-question-*.png` shows three non-empty files, and
`git status --short` shows **no** untracked QA artifacts (`.gitignore:32` covers `artifacts_*`).
`AgentBrowser.screenshot` already throws on a zero-byte file.

**V7: the record reads straight (P2/P3).** Let `S` be
`.ai/specs/2026-08-23-plain-end-structured-question.md`.

**Do not assert that `grep -n "never run" "$S"` returns nothing.** P2 preserves every historical
statement in place, so those words must still be on disk after it — and the correction prose
itself quotes the phrase it is correcting, which adds hits rather than removing them. A grep
demanding their absence would be satisfiable only by deleting the record P2 exists to keep, or by
never explaining what a correction invalidates. The check is that every hit is either part of a
2026-08-29 correction itself, or sits near one, and that the current result is stated too:

- `sed -n '1,25p' "$S"` shows the **current** status block first, then the
  `SUPERSEDED 2026-08-29` lead-in, then the original 2026-08-24 block intact beneath it.
- `rg -n "never run" "$S"` returns **5** hits, not 2: two inside the 2026-08-29 correction prose
  itself (the status-block supersession note, which quotes the original's "has never run" line by
  name, and the runbook's supersession note, which says the runbook itself "was never run") — both
  trivially "corrected" by construction — plus the three 2026-08-24 originals (the embedded status
  line, the table row, the "Per repo doctrine" sentence).
- For the two originals that get a **dedicated** local correction, `rg -n -B4 "never run" "$S"`
  shows it within the preceding 4 lines: the "Per repo doctrine" sentence (a `CORRECTED 2026-08-29`
  lead-in immediately above it), and the table row (its `SUPERSEDED`/replacement is a **new row
  directly below**, not above — check with `rg -n -A2` instead of `-B4` for that one hit only).
- The third original (the embedded "has never run" line inside the preserved 2026-08-24 status
  block) has no *local* marker within 4 lines — it sits inside a block governed by ONE lead-in at
  the block's own top, per P2 step 1, not a per-line correction. Check coverage by range, not
  distance: confirm the line falls between the `SUPERSEDED 2026-08-29 by the status block above`
  line and the block's end (`sed -n '<superseded-line>,<line>p' "$S"` shows no line between them
  that isn't part of the one preserved block).
- `rg -n "plain-end-question.e2e.ts" "$S"` returns the new status block, the new verification-table
  row, and the runbook's supersession lead-in: the current truth is stated, not merely the
  correction of the old one.
- `rg -c "SUPERSEDED 2026-08-29|CORRECTED 2026-08-29|RESOLVED 2026-08-29" "$S"` is at least 5
  (status block, nested-defects stack, table row, "Per repo doctrine" sentence, runbook).

`grep -n "CEZ:ASK" BACKWARD_COMPATIBILITY.md` still returns its §8 lines, unchanged: this spec
alters no marker vocabulary.

**V8: the full gates, last.** `npm run typecheck` clean; `npm test`. Note the known baseline: the
prior spec recorded the root suite at 10,774 passed / 1 failed / 4 skipped, the single failure
being the C18 knowledge-catalog host-speed budget, reproduced on a clean detached baseline. If that
is still the only failure, say so explicitly and name it rather than claiming a green gate; if
anything else is red, it is a finding.

**Result (2026-08-29): Done.** V2 reported `passed`, twice; V5 demonstrated the assertions can fail
(case A red under the mutation) and pass again once reverted and rebuilt. See the status block at
the top of this spec for the full gate results. The paragraph below is the rule that result was
checked against, left as written.

**Done vs QA Needed.** Per repo doctrine, this is Done when V2 reports `passed` (not `skipped`) and
V5 has demonstrated the assertions can fail. Until then it stays QA Needed, which is precisely the
mistake this spec exists to stop repeating.

---

## Sources read

Read directly this session, at the paths and lines cited above, in this worktree at `HEAD`
`0a46010b` unless noted:

- `.ai/specs/briefs/2026-08-29-plain-end-question-reconciliation.md`: step 1's brief (whose
  headline finding and code map were confirmed correct on every point checked).
- `.ai/specs/2026-08-23-plain-end-structured-question.md`: full header (1-60), section index, and
  the Verification section (755-950), including the V8 row and the "never run" line.
- `packages/cezar/src/core/turn-question.ts` (whole file) and `turn-question.test.ts` (11 `it`
  blocks enumerated).
- `packages/cezar/src/workflows/run.ts`: `parkPlainEnd` (8480-8528), and every
  `waitingReason`/`waitingQuestion`/`ASK_STRUCTURE_NUDGE` site by grep (:364, :471, :475, :2571,
  :5123-5155, :7414-7445, :8493-8525).
- `packages/cezar/src/workflows/run.test.ts:1918-1990`: the five plain-end cases.
- `packages/cezar/src/runs/store.ts:945-990`: the transition-keyed clearing rule and its
  same-status exemption comment.
- `packages/contract/src/runs.ts`: `waitingReason`/`waitingQuestion` at :476/:478 and :676/:678.
- `packages/cezar/src/server/server.ts:7555-7572`: the index projection carrying both fields.
- `packages/cezar/src/notifications/observer.ts:104-105`.
- `packages/web/src/routes/task-thread/task-thread.tsx:430-470` and `task-thread.test.tsx:229-254`.
- `packages/cezar/src/handoff.ts`: `HANDOFF_ONLY_INSTRUCTIONS`, the full marker contract prose.
- `BACKWARD_COMPATIBILITY.md` §7-§8 (205-250): the marker vocabulary and its pairing paragraph.
- `packages/cezar/scripts/mock-claude.mjs:117-118, :250`: the three mock verbs.
- `.ai/scripts/e2e.sh` (whole file): the dispatcher, its exit-code contract, and the
  `TEST_E2E_STATUS=skipped` path.
- `packages/web/e2e/queued-stack.e2e.ts:60-140`: the live-mock boot pattern this spec copies;
  `packages/web/e2e/task-thread.e2e.ts:1-80`; `packages/web/e2e/agent-browser.ts:84-115, :268-279`
  (`fixtureServeEnv` setting `CEZ_DRY_RUN=1`, `bootProjectId`, `screenshot`).
- `.gitignore:30-39`: `.ai/qa/artifacts_*/` ignored; the orphan's `.ai/qa/artifacts/` is not.
- `package.json` `scripts`: `test`, `test:unit`, `test:e2e`, `typecheck`; no `lint`.
- `git`: `merge-base --is-ancestor d811d34c HEAD` → yes; `--is-ancestor 89535360 HEAD` → no;
  `log --oneline cez/183740fe`; `diff --stat HEAD cez/183740fe` → 321 files, +2,306 / -68,805;
  `show --stat 89535360`.
- Both orphaned screenshots, extracted with `git show 89535360:<path>` and **opened**:
  `v8-ask-chips.png`, `v8-question-fallback.png`.
- `/var/lib/cezar/loki-labs/cezar/.ai/cezar/runs.json`: `183740fe` `done`/`archived`/
  `finishedAt: 2026-08-24T19:46:01.241Z`; `eba6cb05` `running`.
- `cez kb search "plain end structured question"`: surfaced `specs-af0f9f944acf` (the prior spec),
  `specs-e4735009f213` (the prior brief), `specs-38aca129d002` (AskUser, the `CEZ:ASK` protocol
  this pairs with), `specs-320f8ce97e1a` (inactive sessions park as in-progress).

**Not verified, stated as such rather than assumed:** whether any manual runtime pass happened
outside this repo's git history since 2026-08-24 (no KB record of one found); the file-by-file
content of `cez/183740fe`'s 321-file divergence beyond the four commits identified; whether the
E2E browser provider can actually be provisioned on `prod-host`, and V2 is written to surface a
`skipped` rather than let it pass silently, precisely because that is unknown.
