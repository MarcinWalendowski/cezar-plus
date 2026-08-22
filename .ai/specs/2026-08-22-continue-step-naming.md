# A follow-up prompt names what it's retrying, or names itself — never the literal "Continue"

**Status: implemented.** All four phases landed together in `6c3d1c3a`, merged with
`origin/main` as `988fbac5` and pushed directly to `main` (no branch protection on this repo).
`tsc --noEmit -p tsconfig.test.json` clean; full vitest run 9757 passed / 1 skipped, only two
pre-existing unrelated failures left (`catalog.test.ts`, `config-api.test.ts` — filed as todos
`72eba946`, `72129a4c`). Root `npm run typecheck`'s `pretypecheck` build step cannot complete on
this host on any branch, reproduced at clean HEAD — pre-existing, filed as `72129a4c`, not a
regression from this change.

The brief this spec was drafted against, `.ai/specs/briefs/2026-08-22-continue-step-naming.md`,
is no longer on disk (reaped mid-session — see this run's handoff log); every citation below was
re-verified directly against the code in this pass, not carried from the brief.

## TLDR

`RunManager.continueRun` (`packages/cezar/src/workflows/run.ts:3056-3058,3210`) mints a
synthetic `continue-N` step named literally `'Continue'` for every follow-up, regardless of
whether the user typed "yes", a one-line correction, or a fully new ask. The owner's ask has
two parts, and this spec answers both without touching `chain.ts`'s deliberate invariant that
`continue-N` steps sit outside the workflow definition (`chain.ts:71`):

1. **When the follow-up is obviously more of the same work** — the common case, a follow-up on
   a run whose last session belongs to a real workflow step — name the new step after *that*
   step (`"Deploy — continued"`, not `"Continue"`), so the timeline reads as what it actually
   is: the same step, retried. No `StepState` record is reopened or mutated to do this — it is
   a naming decision made once, at step creation, using data `continueRun` already has in hand
   (`sessionStep`, `run.ts:3007`).
2. **When a follow-up needs a genuinely new step** — a second-or-later follow-up on an already
   `continue-`-headed run, i.e. a side conversation with no real step underneath it — title it
   from what the user typed (synchronous, reusing the existing `postValidateTitle` sanitizer,
   `runs/auto-name.ts:135`, already imported in `run.ts:62`) and let it be refined once the agent's
   first turn runs, by extending the *existing* `CEZ:TITLE=` marker mechanism
   (`applyTurnMarkers`, `run.ts:5210-5228`) to also patch the active step's name, not only the
   run's. Both are zero-new-LLM-call, reuse of machinery already imported into this file.

A fourth, separate case — a follow-up landing on a `review` run that stopped for a *budget*
reason — is answered by re-entering the chain through the *already-existing* `reenterChain`
(`run.ts:1967-2072`), which its own doc comment names as designed for exactly this caller ("a
continuation... the caller's old path still applies" on `false`) but which no caller has ever
actually been wired to. A budget stop lands from three different places in the code (see
Decisions, item 4), and `reenterChain`'s own resolution logic targets a different step depending
on which one fired: sometimes the chain genuinely has an untouched real step waiting next;
sometimes the step whose own turn was cut off is re-queued and resumed instead, because it never
actually finished. Both are safe to re-enter — neither silently skips a step that didn't reach
its own goal, which is the property Phase 4 is scoped to guarantee, not "always advances." This
is Phase 4, scoped narrowly and flagged as the one part of this spec worth shipping separately if
the owner wants to hold it back — see Risks.

## Problem

Every follow-up submitted to a run that has reached `done`, `failed`, `cancelled`, `review`, or
an idle-parked `waiting` state goes through `continueRun`:

```ts
// run.ts:3056-3058
const continuations = run.steps.filter((s) => s.id.startsWith('continue-')).length;
const stepId = `continue-${continuations + 1}`;
this.store.addStep(runId, { id: stepId, name: 'Continue', kind: 'agent' });
```

and the literal name is repeated at the `step-start` event (`run.ts:3210`,
`{ type: 'step-start', stepId, name: 'Continue', kind: 'agent', iteration: 1 }`) — two separate
literals that happen to agree today only by coincidence of both being hand-written. The step
rail renders `step.name` directly and unstyled (`packages/web/src/routes/task-thread/step-
rail.tsx:89`), so the timeline for a run with three follow-ups shows three rows that all say
"Continue," indistinguishable from each other and from a workflow step that is actually named
that. Nothing about the resulting step record, or the event, carries what the user asked for or
what the agent did about it.

`RunManager.reenterChain` — the mechanism that already exists for "reopen a specific named
step and re-queue the chain from there" — is proven out by four callers (`requestChanges`'s
approval send-back, `run.ts:4540`; restart recovery's settled-session and `running` branches,
`run.ts:1651` and `run.ts:1674`; turn-end hand-back, `run.ts:3670`), but `continueRun` calls none
of them — it is a parallel, disconnected code path that always mints a step outside the chain,
even in cases where the chain has real, untouched work waiting right where the follow-up landed.

## What the record already decided, verified against the code

| Decision | Where | Bearing here |
|---|---|---|
| `continue-N` steps are deliberately outside the workflow definition | `chain.ts:64-72` (doc comment on `pendingChainSteps`) | This spec does not remove that boundary — Phases 1-3 keep every follow-up on a `continue-N` id; only Phase 4's narrow case ever routes a follow-up onto a real def-step id, and it does so through the same `reenterChain` path three other callers already use safely. |
| `defDescribesRun` treats any `continue-`-prefixed id as automatically valid | `chain.ts:40-46` | Unaffected — Phases 1-3 keep minting `continue-N` ids; Phase 4 does not mint an id, it re-queues an existing def step id `reenterChain` already handles correctly. |
| `pendingChainSteps` — `done`/`failed`/`cancelled`/`skipped` are terminal, "a step that failed already stopped the chain... and must not re-open it" | `chain.ts:18-19,68-70,80-85` | **Read carefully during this pass, not just cited**: `finishStep` marks the step itself `failed`/terminal on every path that ends a run `failed` — the check-step failure branch at `run.ts:4256`, and its agent-step equivalent at `run.ts:4132` — *and* on the second-in-a-row inactivity stop that ends a run `review` (`run.ts:4099-4101`, `finishStep(..., 'failed', ..., stopped)`). So `pendingChainSteps` on either of those runs points past the terminal step at the *next, never-reached* step — re-entering there would silently skip a step that never actually finished its own goal. This is why Phase 4 is scoped to the ONE case where the step immediately before the gap is verifiably `done`, not `failed` (see Solution, Decisions). |
| `reenterChain`'s `resetTo` rewind, used by the approval "changes requested" flow | `run.ts:1958-2011`, `4490-4546` | Not reused here — `resetTo` rewinds *backwards* through an `onFail.retry` chain, a different shape than "the chain has real work immediately ahead." Phase 4 calls `reenterChain` with no `resetTo`, the same shape restart recovery and turn-end hand-back already use. |
| A step's `name` is a plain `z.string()`, no `titleOrigin`, no per-step namer call site | `runs/store.ts:64-104` | Superseded by Decisions item 1/Data models below: a `nameOrigin` field is added so Phase 3 can tell a Phase-1-minted (prompt-derived) name from a Phase-2-minted (retried-step) name before patching either from a `CEZ:TITLE=` marker — a step now has exactly the two competing writers `RunRecord.titleOrigin` was built to arbitrate for the run, not zero. |
| The run-level namer + `CEZ:TITLE=` marker pattern | `runs/auto-name.ts` (whole file), `run.ts:5134-5251` | `postValidateTitle` (`runs/auto-name.ts:135-145`) is a generic sanitizer (trim, strip trailing dots, collapse whitespace, lowercase-first, clamp to `TITLE_MAX=40` with an ellipsis) — nothing about it is run-scoped or gerund-specific, so it applies to a step name unmodified EXCEPT the lowercase-first and whole-string-clamp behavior, which Phase 2's composed `"<step> — continued"` string must not go through (see Phase 2). Already imported in `run.ts:62`. `applyTurnMarkers` (`run.ts:5210-5228`) already parses `CEZ:TITLE=` out of turn text; extending it to also patch the active step needs no new parsing. |
| No prior spec covers this | Grepped `.ai/specs/` for `continue-step`, `step title`, `step name`, `continuation.*title` | `2026-08-20-chain-integrity-restart-and-continuation.md` covers `continueRun`/`reenterChain` retry *semantics* extensively (its own incident log quotes `step-start continue-1 "Continue"`) but never proposes naming. `2026-07-17-task-auto-naming.md` is run-level only. New territory. |

### What was checked and found NOT to be a landmine

- **No other code branches on the literal string `'Continue'`.** Grepped
  `packages/web/src`, `packages/cezar/src` for `'Continue'` outside `run.ts:3058`/`:3210` and
  tests: the one hit is a button `aria-label` (`task-thread.tsx:489`), unrelated to
  `step.name`. Renaming the step is display-only.
- **`reviveQueuedRun`'s continuation-recovery branch** (`run.ts:1522-1545`) MATCHES a queued
  continuation by id prefix only (`.startsWith('continue-')`, `run.ts:1523-1525`), never the
  name or the exact numeric suffix — Phases 1-3 do not change that matching logic. But the same
  branch also CONSTRUCTS a second `PendingContinuation` (`run.ts:1532-1538`,
  `this.pendingContinuations.set(run.id, { stepId: queuedContinuation.id, ... })`), independently
  of the `deferForCapacity` construction site inside `continueRun` — once `PendingContinuation`
  gains required `name`/`nameOrigin` fields (Phase 1), this site must also supply them:
  `name: queuedContinuation.name` and `nameOrigin: queuedContinuation.nameOrigin ?? 'prompt'`,
  read off the already-persisted `continue-N` `StepState` (`queuedContinuation` is itself a
  `StepState`, found a few lines above at `run.ts:1523-1525`) — explicitly **not** re-derived
  from `RESTART_CONTINUATION_PROMPT` (the `prompt` field set two lines below it), which would
  relabel the step "resuming the interrupted task…" on every restart instead of preserving its
  real title. Phase 4 doesn't mint a `continue-*` step at all in the case it fires, so it takes
  the *generic* queued-chain revival branch (`run.ts:1546-1567+`) — already exercised today by
  the other three `reenterChain` callers, not new surface.
- **Both `/runs/:id/continue` and `/runs/:id/messages`' idle-`waiting` fallback** feed
  `continueRun` with the same `opts.text` (`server.ts:5158-5182`, `server.ts:5044-5049`) — no
  API/route change needed; the naming and re-entry decisions happen entirely inside
  `continueRun`.

## Solution

### Decisions

1. **"Continuing/retrying an existing step" is answered, for the common case, at the naming
   layer — not by reopening a `StepState` record.** `continueRun` already computes
   `sessionStep = [...run.steps].reverse().find((s) => s.sessionId)` (`run.ts:3007`) — the step
   whose session is about to be resumed. When `sessionStep.id` does **not** start with
   `continue-` (this is the first follow-up since the workflow's own steps last ran), the new
   step is named after it: `` `${sessionStep.name} — continued` `` (`sessionStep.name` itself
   clamped to leave room for the suffix, never lowercased — see Phase 2 for the exact
   composition, which is NOT a `postValidateTitle(...)` call on the composed string).
   This is deliberately *not* a rewind of `sessionStep`'s own record (its `status` stays exactly
   what it already was — `done`, `failed`, whatever) — the follow-up still lands on its own
   `continue-N` id, still resumes `sessionStep`'s session exactly as today, and `chain.ts`'s
   invariants are untouched. Only the label changes, from a disconnected "Continue" to an
   honest "this is the Deploy step, continued."
2. **When there is no real step to attribute to** — `sessionStep.id` itself starts with
   `continue-` (a second-or-later follow-up in a row, genuinely a side conversation past the
   workflow) — title the step from what the user wrote: `postValidateTitle(opts.text)`,
   falling back to the literal `'Continue'` only when `opts.text` is empty/whitespace (the same
   condition that today falls back to the prompt `'Continue.'` at `run.ts:3059` — nothing
   user-authored exists yet to summarize).
3. **"Or what the agent decided to do" is answered by extending the existing marker channel,
   not a new LLM call.** `applyTurnMarkers` (`run.ts:5210-5228`) already reads a `CEZ:TITLE=`
   line out of the finished turn's text and patches `RunRecord.titleSummary`. Extend it: when
   the run's `currentStepId` at that moment is a `continue-*` step, also patch that step's
   `name` via `store.updateStep`. No new marker syntax, no new prompt instruction beyond what
   agents already know about `CEZ:TITLE=` (documented in the system prompt's turn-marker
   section) — the only change is that the existing declaration now has a second target when it
   fires mid-continuation. Rejected: a dedicated per-step namer call (`generateRunName`-style)
   — it would add a real per-follow-up LLM-call cost for something as frequent and often
   contentless as "yes"/"continue," and the marker path this decision instead extends is free.
4. **Chain re-entry (Phase 4) is gated on `run.status === 'review' && run.stopReason ===
   'budget' && !run.pendingApproval`, but that guard does not — and does not need to —
   distinguish the three different places a budget stop can land.** Each leaves the CURRENT step
   in a different state, so re-entry resolves a different target for each; spelled out here
   rather than assumed, since the record does not state it in one place:
   - **`runContinuation`'s own budget handler** (`run.ts:3552-3556`): a continuation session hit
     budget mid-turn; the step it was running is marked `done` ("The step itself completed its
     turn; only the RUN is stopped from taking another"). `chainResumeAt`/`firstUnfinishedStep`
     see a terminal step and resolve to the NEXT def step, if one exists — the "untouched real
     step waiting" case this spec's prose mostly describes.
   - **`execute()`'s loop-top guard** (`run.ts:4012-4014`, `if (this.budgetSpent(...)) {
     state.budgetExceeded = true; break; }`): fires BEFORE the step at index `i` starts, so that
     step is still `pending` — untouched, not done, but also never reached. `chainResumeAt`
     resolves to that same untouched step; re-entry runs a step that never got a turn.
   - **`execute()`'s mid-step break** (`run.ts:4135`, `if (state.budgetExceeded) break;`): fires
     AFTER the agent session ended but BEFORE `finishStep` runs, so that step is left `running`
     — non-terminal, not done, not reached-and-finished. `chainResumeAt`/`firstUnfinishedStep`
     resolve to THIS SAME step (the one that just stopped), not the next one — re-entry resumes
     the step that was cut off rather than advancing past it.
   All three land the run in the identical `review`+`stopReason: 'budget'` state, so Phase 4's
   guard cannot and does not need to tell them apart: `chainResumeAt` (already exercised inside
   `reenterChain`) resolves the correct target for whichever of the three actually happened, and
   in every one of the three the target step's own goal was genuinely not both reached AND
   already handed off — either it finished and there is real work next, or it did not finish and
   is resumed. What Phase 4 must still rule out is the case that IS neither: the inactivity
   `stopReason` case (`run.ts:4099-4101`) marks the current step `failed` after exhausting its
   one retry, which is a real failure, not a stop — it is deliberately excluded from Phase 4 and
   keeps going through Phases 1-3's naming path instead (it still resumes that step's own
   session, same as today — only the label changes, per Decision 1). `!run.pendingApproval`
   explicitly leaves the approval-gate "Send back" flow alone — that gate already has its own
   dedicated UI (`requestChanges`) and resolving it via free text typed into the ordinary
   composer would be a second, silent way to answer a decision that flow deliberately makes
   explicit.

### What Phase 4 does NOT attempt

- Does not touch `failed` or `cancelled` runs — per Decision 4's table walk, the step
  immediately before the gap in those cases is not verifiably "done with its own goal," so
  `continueRun` keeps its current behavior there (still improved by Phases 1-3's naming).
- Does not resolve a pending approval gate — `!run.pendingApproval` guard.
- Does not rewind any step backwards — no `resetTo`; `reenterChain` is called exactly the way
  restart recovery and turn-end hand-back already call it (find the first unfinished def step,
  queue from there).

## Architecture

```
continueRun(runId, opts)
  │
  ├─ guard clauses unchanged (status, active, session presence, runner/model override)
  │
  ├─ Phase 4 check (new, before step minting):
  │    run.status === 'review' && run.stopReason === 'budget' && !run.pendingApproval
  │      && !opts.images?.length
  │    (the guard cannot tell WHICH of the 3 budget landing sites fired — Decisions #4 — nor
  │     does it need to: chainResumeAt, called inside reenterChain, resolves the correct
  │     target for each case — sometimes the next untouched step, sometimes the same step
  │     re-queued because it never finished)
  │      │yes                                          │no
  │      ▼                                              │
  │  resolve target step id FIRST via reviveWorkflow +   │
  │  chainResumeAt (read-only, duplicates reenterChain's │
  │  own internal resolution — needed because            │
  │  reenterChain doesn't return it)                     │
  │      ▼                                               │
  │  reenterChain(run, 'follow-up continues the          │
  │  chain', { feedback: opts.text })                    │
  │      │handled (true)        │not handled (false)     │
  │      ▼                      └────────────┬───────────┘
  │  appendEvent({ type: 'user-message',                 ▼
  │    stepId: <resolved target>, text: opts.text })     (falls through to step minting below,
  │  return { ok: true }                                  exactly as every run does today)
  │
  ├─ step minting (existing continue-N id scheme, unchanged):
  │    sessionStep = last step with a sessionId   (run.ts:3007, already computed)
  │      │sessionStep.id NOT 'continue-*'          │sessionStep.id IS 'continue-*'
  │      ▼ (Phase 2)                               ▼ (Phase 1)
  │  name = clamp(sessionStep.name, TITLE_MAX -    name = opts.text?.trim()
  │    ' — continued'.length) + ' — continued'        ? postValidateTitle(opts.text)
  │  (NOT postValidateTitle on the composed             : 'Continue'
  │   string — no lowercase, suffix preserved)      nameOrigin: 'prompt'
  │  nameOrigin: 'step'
  │      └───────────────────┬─────────────────────┘
  │                           ▼
  │              store.addStep(runId, { id: stepId, name, nameOrigin, kind: 'agent' })
  │              appendEvent({ type: 'step-start', stepId, name, ... })  ← SAME `name` variable,
  │                                                                        both sites (bug fixed:
  │                                                                        today two literals)
  │              → runContinuation(...) as today
  │
  └─ (Phase 3, separate call site) recordTurnEnd → applyTurnMarkers:
       CEZ:TITLE= declared this turn && run.currentStepId?.startsWith('continue-')
         && record.nameOrigin !== 'step'   ← excludes Phase 2's "— continued" titles
         → validated = postValidateTitle(markers.title)   (no refNumber — a step name must not
                                                              carry the run title's PR prefix)
         → if (validated && validated !== '') store.updateStep(runId, currentStepId,
             { name: validated, nameOrigin: 'marker' })   (same non-empty junk guard as the
                                                              run-title patch, run.ts:5220-5224)
           (in addition to the existing RunRecord.titleSummary patch, unchanged)
```

## Phases

Each phase is independently shippable; ship in the order below (lowest risk/complexity first).
Phase 4 is the one worth holding back separately if the owner wants a smaller first cut — see
Risks.

**Phase 1 — Name a new step from the user's own prompt when there's no real step to attribute
it to.**
- Add `nameOrigin: z.enum(['step', 'prompt', 'marker']).optional()` to `stepStateSchema`
  (`runs/store.ts:64-104`; see Data models) — landed here, not in Phase 3, because this phase is
  the first writer. Widen `store.addStep`'s parameter type (`runs/store.ts:799`) to
  `Pick<StepState, 'id' | 'name' | 'kind'> & { nameOrigin?: StepState['nameOrigin'] }` (its body
  already spreads `...step` into the pushed record, so no body change). Add `name: string` and
  `nameOrigin: 'step' | 'prompt'` to `PendingContinuation` (`run.ts:789-795`; see Data models) —
  needed by the `deferForCapacity` bullet below and by the second `PendingContinuation`
  construction site in `reviveQueuedRun` (`run.ts:1532-1538`, see "What was checked" above).
- In `continueRun`, after computing `sessionStep` (`run.ts:3007`) and before minting the step
  (`run.ts:3056-3058`): compute a name for the case `sessionStep.id.startsWith('continue-')`, but
  first exclude cezar's own synthetic prompts — the same exclusion the "What was checked" section
  above already requires for `reviveQueuedRun`'s sibling `PendingContinuation` site, applied here
  at its actual source. Add a module-level `const SYNTHETIC_CONTINUE_PROMPTS: ReadonlySet<string>
  = new Set([RESTART_CONTINUATION_PROMPT, AUTO_RESUME_PROMPT])` (the constants themselves at
  `run.ts:680-681` and `run.ts:427-428`). Then: `const authored = opts.text?.trim(); name =
  authored && !SYNTHETIC_CONTINUE_PROMPTS.has(authored) ? postValidateTitle(authored) :
  'Continue'`. Two of the five production `continueRun` callers pass one of these constants as
  `opts.text` — restart recovery (`run.ts:1697`) and auto-resume after a usage limit
  (`run.ts:2177`) — and both reach this exact branch whenever the run is already headed by a
  `continue-N` step, which is the common shape for a continued run: `reenterChain` returns
  `false` when every def step is already terminal, and recovery falls through to `continueRun`.
  Without the exclusion the rail would read `"the cezar process restarted while you wer…"` or
  `"the provider usage limit that interrupte…"` instead of a title the user or the agent
  authored. `reopen-watch.ts:49`'s `request.prompt` is human-authored and must NOT be excluded —
  `deferForCapacity` is true on that call too, so it is not a usable proxy for "synthetic"; the
  exclusion has to key off the constants themselves. Set `nameOrigin: 'prompt'` on the minted
  `StepState` regardless of which branch fired (Data models) — the tag Phase 3 checks (`!==
  'step'`) before patching this step's title from a later `CEZ:TITLE=` marker, so a synthetic
  `'Continue'` here can still be refined once the agent's own turn runs.
- Replace both literals — `store.addStep`'s `name: 'Continue'` (`run.ts:3058`) and the
  `step-start` event's `name: 'Continue'` (`run.ts:3210`) — with the same computed `name`
  variable threaded through (it must survive from `continueRun` into `runContinuation`, which is
  where the event is appended — add it as a parameter alongside the existing `stepId`).
- Also apply to the `deferForCapacity` branch (`run.ts:3061-3077`) — `PendingContinuation`
  gains `name` and `nameOrigin` fields so a queued continuation (multi-restart-recovery case)
  keeps the same computed title and origin tag when it's eventually dequeued and its `step-start`
  event fires.
- The dequeue path that later fires a queued continuation's `step-start` event
  (`run.ts:1457-1466`: `hydrateQueuedContinuation` then `this.runContinuation(runId,
  hydrated.stepId, ...)`) must pass `hydrated.name` into `runContinuation`'s new `name` parameter
  added above — `hydrateQueuedContinuation` returns `PendingContinuation & { persistedImages,
  persistedAttachments }`, so `name`/`nameOrigin` arrive on `hydrated` for free once
  `PendingContinuation` carries them.
- `runContinuation`'s own self-recursive missing-session retry (`run.ts:3647-3653`) must forward
  the same `name` it was called with — it re-appends `step-start` on that pass (its own comment
  at `run.ts:3641-3645`: "Re-entering `runContinuation` itself... re-sets `status: 'running'`,
  `iterations: 1` and re-appends `step-start`/`user-message` unconditionally"). To make an
  omission a compile error rather than a silently blank rail row, add `name` as a **required**
  parameter positioned before the defaulted ones (immediately after `stepId`, ahead of
  `sessionId`), not appended after the existing trailing `retriedMissingSession` flag — all three
  call sites (`run.ts:3078`, `run.ts:1458`, `run.ts:3647`) then fail typecheck until each passes
  it through.

**Phase 2 — Name a new step after the real step it's retrying, when one exists.**
- Same call site as Phase 1: when `!sessionStep.id.startsWith('continue-')`, compose the name
  directly — do **not** route it through `postValidateTitle` on the composed string. That
  sanitizer lowercases the first character (`runs/auto-name.ts:139`,
  `t = t[0]?.toLowerCase() + t.slice(1)`), which would turn `"Deploy — continued"` into
  `"deploy — continued"`, contradicting the TLDR, Decision 1 and Verification 1 — all of which
  state `"Deploy — continued"`. It also clamps the whole *composed* string to `TITLE_MAX = 40`
  (`runs/auto-name.ts:20,143`), so any `sessionStep.name` over 27 characters truncates the
  ` — continued` suffix away entirely, losing the one word the label exists to carry.
- Instead: clamp `sessionStep.name` ITSELF to `TITLE_MAX - ' — continued'.length` (28) code
  points — using the same `[...str]` code-point slicing and `…`-ellipsis-on-overflow
  `postValidateTitle` uses (`chars.length > n ? chars.slice(0, n - 1).join('').trimEnd() + '…' :
  str`) — then append the literal `' — continued'` unmodified, never lowercased. Two worked
  examples: `sessionStep.name = 'Deploy'` (6 chars, under the 28-char clamp) →
  `'Deploy — continued'`; `sessionStep.name = 'Review the spec and the record'` (30 chars, over
  the clamp) → clamp to 27 chars + ellipsis, `'Review the spec and the rec…'`, then the suffix →
  `'Review the spec and the rec… — continued'` (40 characters total, exactly `TITLE_MAX`).
- No change to `sessionStep`'s own `StepState` record — this phase is naming only. It DOES set
  `nameOrigin: 'step'` on the NEW `continue-N` record it mints (Data models) — that tag is what
  Phase 3 reads to know not to overwrite this title from a `CEZ:TITLE=` marker.

**Phase 3 — Let the agent's own turn refine a Phase-1-minted title. Never Phase 2's.**
- Consumes the `nameOrigin` tag Phase 1 already added to `stepStateSchema`
  (`runs/store.ts:64-104`; see Data models) — Phase 1 writes `nameOrigin: 'prompt'` when it mints
  a step, Phase 2 writes `nameOrigin: 'step'`. This is the tag Phase 3 gates on — without it, a
  `CEZ:TITLE=` marker on the FIRST turn of a follow-up (agents emit it routinely; it is part of
  the standard turn-marker contract, not an edge case) would overwrite Phase 2's
  `"Deploy — continued"` with the agent's own title, destroying exactly the "this is the
  existing step, retried" reading Decision 1 exists to produce.
- Extend `applyTurnMarkers` (`run.ts:5210-5228`): when `markers.title` is present,
  `run.titleOrigin !== 'user'` (existing guard, unchanged), `run.currentStepId?.startsWith(
  'continue-')`, AND the current step's `record.nameOrigin !== 'step'` — compute `validated =
  postValidateTitle(markers.title)` **without** a `refNumber` argument (a step name must not
  carry the run title's `"812: "` PR-number prefix `postValidateTitle` prepends when `refNumber`
  is passed). Apply the same non-empty junk guard the run-title patch already uses
  (`run.ts:5220-5224`, `if (validated && validated !== ...)`) so a marker that validates to
  nothing cannot blank the step name and leave an empty row in the rail. On a passing guard:
  `store.updateStep(runId, run.currentStepId, { name: validated, nameOrigin: 'marker' })`. Uses
  the run's own `currentStepId`, already on the record (`run.ts:3196` sets it at continuation
  start) — no new field beyond `nameOrigin` itself.
- This fires from `recordTurnEnd`, which already runs for continuation sessions:
  `runContinuation` calls it from its own turn-end handler at `run.ts:3271` (the same call site
  step-driven turns use, `run.ts:4678`), and `currentStepId` is set to the continuation's
  `stepId` before that, at `run.ts:3196` — so Phase 3 needs no new call site.

**Phase 4 — Re-enter the chain instead of minting a step, for the case Decisions item 4 scopes
(budget-stopped review, not gated on approval, no attachments).**
- In `continueRun`, before the step-minting block, resolve the re-entry target FIRST — needed
  for the `user-message` event below, and `reenterChain` does not return it: `const workflow =
  run.status === 'review' && run.stopReason === 'budget' && !run.pendingApproval &&
  !opts.images?.length ? await this.reviveWorkflow(run) : undefined; const resumeAt = workflow ?
  this.chainResumeAt(run, workflow) : undefined;`. Both are already-private, read-only methods on
  the same class — this duplicates the resolution `reenterChain` does internally, an accepted
  small cost to avoid widening `reenterChain`'s return type and touching its four existing
  callers (`run.ts:1651,1674,3670,4540`) for a value only this one caller needs.
- Then: `if (resumeAt) { const handled = await this.reenterChain(run, 'follow-up continues the
  chain', { feedback: opts.text }); if (handled) { this.store.appendEvent(runId, { type:
  'user-message', stepId: workflow.steps[resumeAt.index].id, text: opts.text ?? '', imageCount:
  0 }); void this.pump(); return { ok: true }; } }` — on `false`, fall through to Phases 1-3
  unchanged (this is exactly the contract `reenterChain`'s own doc comment already promises
  callers). The explicit `pump()` call is required, not decorative: `reenterChain` ends with
  `this.queue.push(run.id)` and deliberately does not pump itself — the one existing caller that
  already reaches this exact shape (turn-end hand-back reading `handled` off `reenterChain` and
  returning through `{ ok: true }`) compensates the same way at `run.ts:3671`, `void this.pump();`,
  with a comment noting "otherwise the re-queued run waits for an unrelated wakeup." Omitting it
  here would clear the composer, park the run at `status: 'queued'`, and leave it there until the
  `QUEUE_WATCHDOG_MS = 60_000` sweep (`run.ts:354`, `:959-967`) fires — up to a 60-second stall on
  a path meant to resume immediately.
- Appending the `user-message` event is required, not optional: `reenterChain` itself appends
  only a `lifecycle` event — unlike `runContinuation`, which appends `user-message` at
  `run.ts:3222-3229` for the ordinary path. Without it, the text the user just typed reaches the
  agent only indirectly via `resumeAt.feedback` → `checkFailure` (assigned to `resumeAt.feedback`
  at `run.ts:2015`, read from it into `checkFailure` at `run.ts:3991`), a retry-explanation
  channel — it never appears in the rendered thread: the
  composer clears as if the message sent, and the message itself silently never shows up.
- `reenterChain` does not carry pasted images the way `runContinuation` does — no
  `persistImage`/attachments handling exists on that path — so Phase 4 does not attempt to add
  it. Instead the guard requires `!opts.images?.length` (already folded into the `workflow` line
  above); a follow-up with attachments falls through to Phases 1-3 exactly as it does today, and
  only a text-only follow-up on a budget-stopped review takes the re-entry path.
- `continueRun` is currently synchronous (returns `{ ok, error }` without `await`). This phase
  makes it `async`, which means EVERY caller must change — none of today's callers tolerate a
  Promise. Full production call-site list, each currently reading the return value synchronously
  on the next statement: `run.ts:1697` (restart recovery, reads `resumed.ok` at `run.ts:1705`),
  `run.ts:2177` (auto-resume after a usage limit, reads `resumed.ok` at `run.ts:2178`),
  `reopen-watch.ts:49` (reads `result.ok` at `reopen-watch.ts:50`, called with
  `deferForCapacity = true`), `packages/cezar/src/server/server.ts:5051` (`/runs/:id/messages`'s
  idle-`waiting` fallback, reads `resumed.ok` at `server.ts:5052`), `server.ts:5171`
  (`POST /runs/:id/continue`, reads
  `result.ok` at `server.ts:5178`) — five production sites, not the three previously named. Also:
  23 test call sites across `run.test.ts`, `system-prompt.test.ts`,
  `model-identity-wiring.test.ts`, `pasted-attachments.test.ts`, and `reopen-watch.test.ts`
  assert the synchronous return shape (`expect(manager.continueRun(...)).toEqual({ ok: true })`
  and similar) and every one breaks against a returned `Promise` (see Verification item 5).
  Chosen approach: convert `continueRun` to `async`, `await` it at all five production call
  sites, and convert the 23 test assertions to `await manager.continueRun(...)` /
  `.resolves.toEqual(...)`. Rejected: keeping `continueRun` synchronous and firing re-entry as
  `void this.reenterChain(...)` — that returns before re-entry is known to have succeeded, so
  `continueRun`'s `false`-fallthrough contract (mint a step when re-entry did not handle it)
  could not be honored without racing the mint against a fire-and-forget re-entry.

## Data models

`StepState` (`runs/store.ts:64-104`) gains one field: `nameOrigin: z.enum(['step', 'prompt',
'marker']).optional()` — `'step'` when Phase 2 names a step after the real step it's retrying,
`'prompt'` when Phase 1 names one from the user's own text, `'marker'` when Phase 3 subsequently
patches it from a `CEZ:TITLE=` declaration. Absent on every pre-existing record (parses the same
as today, `.optional()`) and on any step this spec's naming logic never touches.
`store.addStep`'s parameter type (`runs/store.ts:799`, currently `Pick<StepState, 'id' | 'name'
| 'kind'>`) widens to `Pick<StepState, 'id' | 'name' | 'kind'> & { nameOrigin?:
StepState['nameOrigin'] }` so Phases 1 and 2 can pass the new field through — the method body
already does `run.steps.push({ ...step, ... })`, so no body change is needed. `updateStep`
already accepts `Partial<Omit<StepState, 'id'>>`, so Phase 3's `name`/`nameOrigin` patch needs no
signature change. `RunRecord` is
unchanged — `stopReason`/`pendingApproval`/`currentStepId` already exist and are only read, not
added. `PendingContinuation` (`run.ts:789-795`, currently `{ stepId, sessionId, backend, prompt,
images }`) gains two fields: `name: string` (Phase 1's computed title, for the
`deferForCapacity` path) and `nameOrigin: 'step' | 'prompt'` (so a queued continuation's
eventual `step-start` carries the same origin tag Phase 3 gates on).

No new event type. `step-start`'s existing `name` field (already part of its shape) simply
carries a computed value instead of a literal.

## API contracts

No route or request/response shape changes. `POST /runs/:id/continue`
(`server.ts:5158-5182`) and `POST /runs/:id/messages`' idle-`waiting` fallback
(`server.ts:5044-5049`) both already pass `opts.text` through to `continueRun` unchanged; all
four phases are internal to `RunManager`.

## Risks

- **Phase 4 changes actual run behavior** (a follow-up that used to always open a fresh
  disconnected chat now sometimes re-queues the persisted chain instead) — where Phases 1-3
  change display only. Which step it resumes is not always "the next one": per Decisions item 4,
  a budget stop from `execute()`'s mid-step break (`run.ts:4135`) leaves the CURRENT step
  non-terminal, so re-entry resumes that same step rather than advancing past it; only the
  continuation-handler (`run.ts:3552-3556`) and loop-top-guard (`run.ts:4012-4014`) cases land on
  a genuinely untouched next step. If the owner wants the naming fix without any behavior change,
  ship Phases 1-3 alone and treat Phase 4 as a separate follow-up decision — Phase 4 is the only
  phase in this spec that changes run behavior rather than display, so this split is worth
  calling out explicitly rather than bundling all four phases into one landing.
- **The `budget`-vs-`inactivity` distinction (Decision 4) rests on reading `finishStep`'s call
  sites, not on a schema-level guarantee** — `run.ts:4099-4101` marks a twice-stopped step
  `failed` today, but nothing stops a future stop-reason from being added that leaves the
  current step in some other, ambiguous state. Phase 4's guard is a `stopReason === 'budget'`
  literal check specifically so a new stop reason is excluded by default rather than silently
  included — a future stop reason that legitimately deserves the same treatment needs its own
  explicit addition to the guard, not an accidental fallthrough.
- **A real step's `name` can theoretically be very long** (nothing in `WorkflowDef` bounds
  step-name length) — Decision 1/Phase 2's `` `${sessionStep.name} — continued` `` composition
  clamps `sessionStep.name` itself for exactly this reason (see Phase 2's worked examples), so it
  degrades to a truncated-with-ellipsis label rather than an unbounded string, same as every
  other title in the system.

## Verification

1. **Unit — naming, no chain involvement (Phases 1 & 2).** In `run.test.ts` (existing
   `continueRun`/`continue-1` coverage at e.g. `run.ts:1772`, `2408-2445`): seed a run whose
   last real step is `sessionStep` (e.g. a `quick-task`-shaped single-step run, `done`), call
   `manager.continueRun(id, { text: 'also check the retry path' })`, assert the new step's
   `StepState.name` is `` `${realStepName} — continued` `` and `nameOrigin` is `'step'` (Phase 2
   case) — then seed a SECOND follow-up on the now-`continue-1`-headed run and assert the new
   `continue-2`'s name is derived from the second follow-up's own text via `postValidateTitle`,
   with `nameOrigin: 'prompt'`, not the literal `'Continue'` (Phase 1 case). Assert the
   `step-start` event's `name` field matches `StepState.name` exactly (the two-literal bug this
   spec fixes). Also assert the exact composed strings for a short and a long `sessionStep.name`
   per Phase 2's worked examples (`'Deploy — continued'`; the 30-character example truncating to
   `'Review the spec and the rec… — continued'`). Separately, drive a continuation through the
   missing-session reactive fallback (`retriedMissingSession = true`, `run.ts:3647-3653`) and
   assert the re-appended `step-start` event still carries the same non-empty `name` it was
   called with — this is the case Phase 1's third `runContinuation` call site exists to cover,
   and a regression here would show up only as a blank rail row, not a thrown error.
2. **Unit — empty-prompt fallback and synthetic-prompt exclusion.** `continueRun(id, {})` (no
   text, mirroring the idle-`waiting` resume and bare "Continue" button) still yields `'Continue'`
   when `sessionStep.id` is itself a `continue-*` step (Phase 1's documented fallback) — pin this
   so the fallback is not accidentally dropped. Then, on a run whose last session-bearing step is
   `continue-1`: assert `continueRun(id, { text: RESTART_CONTINUATION_PROMPT }, true)` and
   `continueRun(id, { text: AUTO_RESUME_PROMPT }, true)` each mint a step named `'Continue'` with
   `nameOrigin: 'prompt'` — not a title derived from the constant's own text — while
   `continueRun(id, { text: 'a human-typed reopen prompt' }, true)` (the `reopen-watch.ts:49`
   shape, also called with `deferForCapacity = true`) IS named from its text, proving the
   exclusion keys off `SYNTHETIC_CONTINUE_PROMPTS` and not off `deferForCapacity`.
3. **Unit — marker refinement (Phase 3).** Seed a `continue-*` step with `nameOrigin: 'prompt'`,
   drive `manager.recordTurnEnd(runId, 'CEZ:TITLE=fixing the flaky retry test')` directly, assert
   `store.getRun(runId).steps` shows that step's `name` updated to the validated marker title and
   `nameOrigin` updated to `'marker'`, and that `RunRecord.titleSummary` is ALSO updated (existing
   behavior, must not regress) — same call, two targets. Separately, seed a `continue-*` step
   with `nameOrigin: 'step'` (a Phase 2 "— continued" title) and assert the SAME marker call does
   NOT change that step's `name` — this is the regression Phase 3's `nameOrigin` gate exists to
   prevent. Also assert a marker that validates to an empty string (e.g. `CEZ:TITLE=...`) leaves
   the step's `name` unchanged (junk guard).
4. **Unit — Phase 4 gate precision.** Three seeded runs: (a) `status: 'review', stopReason:
   'budget'` with a pending real step after the finished one — `continueRun` re-enters the
   chain (assert the pending step transitions toward `running`/`queued`, not a new `continue-N`
   record, AND assert a `user-message` event with the follow-up's `text` is appended against the
   resolved step id, AND — since `reenterChain` on its own only leaves the run `queued` via
   `this.queue.push` and never starts it — assert either that `pump` was invoked (spy on
   `this.pump`) or, end-to-end, that the run actually leaves `status: 'queued'` without waiting
   for the `QUEUE_WATCHDOG_MS` sweep; reaching `queued` alone is not sufficient, since that also
   passes if the required `void this.pump();` call is missing); (b) `status: 'review', stopReason:
   'inactivity'` with the same shape —
   asserts `continueRun` does NOT re-enter the chain, mints `continue-1` as Phases 1/2 describe
   instead; (c) `status: 'review'` with `pendingApproval` set — asserts `continueRun` does not
   re-enter the chain even though `stopReason` might coincidentally be `'budget'` on an unrelated
   earlier stop, proving the `!run.pendingApproval` guard is load-bearing on its own; (d)
   `status: 'review', stopReason: 'budget'` with an image attached in `opts.images` — asserts
   `continueRun` does NOT re-enter the chain (falls through to Phases 1-3 instead), proving
   images are never silently dropped by the re-entry path.
5. **Existing suite regression — and the real coverage gap.** No existing test asserts the step
   name `'Continue'`: the only `name: 'Continue'` occurrences are fixture setup, not assertions
   (`recover-session-failure.test.ts:129`, `chain-integrity.test.ts:85` both seed a `continue-1`
   step named `'Continue'` as a GIVEN, not a THEN); every web-side `'Continue'` hit
   (`run-header.test.tsx`, `follow-up-engine.test.tsx`, `active-provider.test.ts`,
   `thread-state.test.ts`) is the composer button's aria-label or a fixture event, unrelated to
   `step.name`. So items 1-3 above are not updates to existing coverage — they are the ONLY
   coverage this naming behavior gets, and must be written from scratch. The real regression
   surface for the full suite is Phase 4's decision: converting `continueRun` to `async` breaks
   23 existing synchronous call-site assertions across `run.test.ts`, `system-prompt.test.ts`,
   `model-identity-wiring.test.ts`, `pasted-attachments.test.ts`, and `reopen-watch.test.ts` —
   every one of them needs its `continueRun(...)` call wrapped in `await` (or `.resolves.`) as
   part of this change, not as an incidental side effect discovered by a red test run.
6. Gates: `npm run typecheck`, `npm run lint`, `npm test` (full `packages/cezar` suite) green.
7. **Manual/QA — not covered by the automated suite, flagged rather than skipped:** an actual
   cockpit run through the composer — finish a real task, type a one-line follow-up, confirm the
   step rail shows `"<step name> — continued"` rather than `"Continue"`; then type a second
   follow-up and confirm it shows a title derived from that second message, and that a
   `CEZ:TITLE=` marker on that second follow-up's first turn updates the rail label. Separately,
   drive a run into a budget-stopped `review` and confirm a text-only follow-up re-queues the
   chain (visible as the next/same step resuming, not a new "Continue" row) while a follow-up
   with a pasted image instead mints an ordinary `continue-N` step. This is the user-visible
   outcome the ask was actually about, and no automated test substitutes for looking at the
   rendered timeline.
