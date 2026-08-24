# Brief: Plain End Questions

**Task:** `183740fe-df08-4bb6-a46e-5f266354537c`
**Prior todo:** `c19d9d4a-4ce1-48dd-b92a-58dfb9e878f2`
**Record gathered:** 2026-08-24 (refresh of the 2026-08-23 gather)

This gather step is a rerun of the same tracked work. No separate duplicate task or branch was
found. The branch already contains two autosave implementation commits, `d47ec1e6` and
`116c3ee1`; the only current uncommitted change is a later spec correction. Baseline citations
below therefore name `84fb8237` or earlier when
describing the reported gap, and current citations explicitly say when they describe in-flight
work.

## Problem in repository terms

Cezar recognizes four turn endings: `CEZ:DONE`, `CEZ:MONITORING`, `CEZ:ASK <json>`, and no
marker. At the pre-task baseline, the agent-facing contract explicitly allowed a question,
decision, or missing input to end without a marker
(`84fb8237:packages/cezar/src/handoff.ts:146-150`). Both engine turn-end handlers then reduced
that case to an undifferentiated waiting state. The cockpit rendered the generic paused message,
but could not surface what the user was expected to answer.

That makes a markerless prose question indistinguishable from a read-only report that simply
parks. The first needs an actionable question. The second must remain readable without cezar
inventing a question.

The two engine sites are lifecycle twins and must remain symmetric:

- `runAgentStep`, pre-task `packages/cezar/src/workflows/run.ts:5235-5240`
- `runContinuation`, pre-task `packages/cezar/src/workflows/run.ts:3704-3711`

Current in-flight code has moved these sites to `run.ts:5270-5305` and `run.ts:3720-3739`, and
routes both through `parkPlainEnd` at `run.ts:6326-6369`.

## What the record already decided

### Structured questions are a shared protocol

The foundational record is KB `specs-38aca129d002`,
`.ai/specs/2026-07-18-askuser-across-runners.md`.

- Lines 5-13 say prose questions are easy to miss and cannot render as clickable choices. The
  chosen solution is a backend-neutral `CEZ:ASK` marker that parks the run, emits a structured
  event, renders option chips, and retains free-text reply.
- Lines 21-32 reject three backend-specific native question paths for this scope. Native bridges
  remain future work.
- Lines 33-40 decide that chips and the ordinary composer coexist.
- Lines 95-125 define precedence as DONE, valid ASK, MONITORING, then plain waiting.
- Lines 220-229 explicitly accept the exact gap: an agent that ignores the marker and asks in
  prose remains waiting with no card. The new task intentionally reopens only that narrow
  non-fix.

The implementation trail is `67cdc965` (spec), `c84fae41` (schema/event), `a0e24d44`
(parse, park, event), `0b8c2e11` (handoff marker), `e81bb9c4` (cockpit card), and `c9ad5196`
(compatibility documentation), merged via `445883e8`. Later `9c65a1b8` preserves unanswered
structured asks across restart.

### Waiting and monitoring already carry lifecycle guarantees

KB `specs-96d29b2df507` and `specs-d950199213ce` establish monitoring as a distinct, durable,
bounded state. KB `specs-320f8ce97e1a`, implemented 2026-08-20, keeps an inactive interactive
session resumable as waiting rather than falsely settling it as done. Those decisions explain
why markerless waiting must not be silently completed. They do not make its requested action
visible.

The Cezar domain record, `/var/lib/cezar/loki-labs/notion-export/domains/cezar.md`, also records
that the npm package has a hard backward-compatibility burden. A solution should add optional
state or presentation, not casually widen a published status union.

### Both turn-end twins must change together

KB `specs-172ddd891dd0`,
`.ai/specs/2026-08-20-chain-integrity-restart-and-continuation.md`, is the controlling
precedent. It documents a prior defect where the normal turn-end path guarded `CEZ:DONE` but
the continuation twin did not. Commits `ee74a158` through `5774bf95`, live at `e3f542df`, fixed
the resulting chain truncation. A plain-end rule implemented at only one twin repeats this
known defect class.

### Current contracts already contain in-flight wording

At baseline, `BACKWARD_COMPATIBILITY.md:192-204` did not name `CEZ:ASK`, and
`handoff.ts:146-150` sanctioned plain prose questions. Current autosave commit `d47ec1e6`
already changes both records:

- `packages/cezar/src/handoff.ts:146-150` says plain endings are for read-only reports, while
  answer-needed turns use `CEZ:ASK`.
- `BACKWARD_COMPATIBILITY.md:192-212` adds `CEZ:ASK` and the pairing rule.

These are in-flight task changes, not historical evidence that the reported gap was already
fixed.

## Code actually involved

| Concern | Current location | Why it matters |
| --- | --- | --- |
| Agent marker contract | `packages/cezar/src/handoff.ts:146-150` | Tells every backend when plain end is valid |
| Compatibility contract | `BACKWARD_COMPATIBILITY.md:192-212` | Published marker vocabulary and fallback promise |
| ASK schema and parser | `packages/cezar/src/core/ask.ts` | Existing structured protocol, not a new subsystem |
| Plain-question detector | `packages/cezar/src/core/turn-question.ts:1-75` | In-flight heuristic, must not synthesize text |
| Continuation turn end | `packages/cezar/src/workflows/run.ts:3720-3842` | First lifecycle twin |
| Normal turn end | `packages/cezar/src/workflows/run.ts:5270-5379` | Second lifecycle twin |
| Shared park and nudge | `packages/cezar/src/workflows/run.ts:6326-6369` | In-flight once-only follow-up and fallback persistence |
| Persisted run state | `packages/cezar/src/runs/store.ts:344-350` | In-flight `waitingReason` and `waitingQuestion` |
| Public contract | `packages/contract/src/runs.ts:326-329` | Currently uncommitted optional fields |
| Paused surface | `packages/web/src/routes/task-thread/task-thread.tsx:426-450` | Currently uncommitted exact-question rendering |
| Notification surface | `packages/cezar/src/notifications/observer.ts:101-107`, `decider.ts:118-130` | Must prefer current question over stale ASK history |
| Runtime regression | `packages/cezar/src/workflows/run.test.ts:1456-1480` | In-flight report and prose-question cases |
| Cockpit regression | `packages/web/src/routes/task-thread/task-thread.test.tsx:239-255` | In-flight actionable question and no-fake-question cases |

Current HEAD `116c3ee1` is an autosave, not a finished feature commit. It contains the second
in-flight implementation increment after `d47ec1e6`, including the contract, cockpit,
notification, mock, and regression changes listed above. No code file is currently modified;
the only worktree change is a later correction to
`.ai/specs/2026-08-23-plain-end-structured-question.md`. Neither task autosave is an ancestor of
`origin/main`, so none of this is baseline shipped behavior.

## Prior decision intentionally contradicted

This work contradicts only the AskUser spec's narrow edge-case decision that prose questions
remain unchanged as generic waiting. It should not contradict these surrounding decisions:

- `CEZ:ASK` remains the provider-neutral structured vocabulary.
- The normal composer remains available for free-text replies.
- Plain read-only reports may park without a fabricated question.
- Waiting remains resumable and must not be treated as successful completion.
- Both turn-end handlers carry the same lifecycle rule.

## Related work and record gaps

The raw tracker has one adjacent item, todo `751e69fb-d663-438e-a407-fdc4b9eee4e4`, concerning a
valid `CEZ:ASK` payload rejected as invalid JSON. That is a parser defect after a marker is
emitted, not this marker-absence problem, and should remain separate.

**CORRECTED 2026-08-24:** the earlier gather said no durable record independently documented the
run `232ad6d4` symptom. Direct run history is available at
`/var/lib/cezar/workspace/.ai/cezar/runs/232ad6d4-58a5-421e-941f-5c24bd5a8452.ndjson`:

- seq 2347 records the owner's report of the bare paused state;
- seq 2352-2354 records the agent acknowledging that the merge/deploy decision had degraded into
  a trailing prose remark after an owner redirect, then re-emitting it as a valid two-question
  `CEZ:ASK`;
- seq 2361 records the user's chip response;
- seq 2370-2373 records filing prior todo `c19d9d4a-4ce1-48dd-b92a-58dfb9e878f2`.

This is authoritative evidence for the reported interaction. Other records naming the same run
concern separate resume, spool, and worktree-prune incidents and must not be used as evidence for
this defect.

No record supports replacing the shared marker with native provider question tools. The base
AskUser decision points the other way.

## Questions the spec must settle

1. What is the primary recovery path: one bounded follow-up that asks the agent to re-emit
   `CEZ:ASK`, direct cockpit prominence for the detected prose question, or both in a defined
   order?
2. How does detection distinguish an actual trailing request from a read-only report without
   inventing text? The false-positive path is especially important because it can spend a model
   turn and can alter restart behavior.
3. What exact bound prevents a noncompliant agent from entering a question-structure nudge loop?
4. How are normal-step, continuation, restart-recovery, autonomous, notification, and dry-run
   paths kept symmetric?
5. Which state is additive and optional so older persisted records and published clients retain
   their current behavior?
6. Which regression proves the user-facing paused surface says what is being asked, while a
   genuine report still parks without a fake question?

## Most constraining facts

1. KB `specs-38aca129d002` deliberately left prose asks as generic waiting, so this is a scoped
   correction to a documented non-fix.
2. `CEZ:ASK` is already the shipped cross-provider protocol, with chips and free-text reply. A
   native-provider redesign is outside the decided architecture.
3. Turn-end handling has two lifecycle twins. KB `specs-172ddd891dd0` exists because an earlier
   guard changed only one of them.
4. Run `232ad6d4` directly records the dead-end pause, the agent's acknowledgement, its corrected
   `CEZ:ASK`, and the user's chip reply at NDJSON seq 2347, 2352-2354, and 2361.
