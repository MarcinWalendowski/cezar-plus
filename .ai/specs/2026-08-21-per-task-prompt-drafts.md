# Per-task prompt drafts — the thread composer stops forgetting

> **Status:** implemented, QA passed 2026-08-22 (one named gap — see Runtime E2E below) · **Date:** 2026-08-21 · **Owner instruction:** "right now we
> persist input value when creating new agent, but let's do the same when adding prompt into any of
> tasks (running, etc. in every state) it should be seperately persisted on task: on some interval
> + before navigating await + use best practices" · **Brief:** written in step 1
> and lost when this run's git worktree was reaped mid-flight; its conclusions are folded into the
> Problem section below and into the run's handoff file.
>
> **One deliberate departure from the literal ask, called out for review:** the owner's "on some
> interval + before navigating await" describes an *asynchronous* save that needs debouncing and a
> flush. This spec persists **synchronously, per keystroke, to `localStorage`** instead — which
> satisfies the intent strictly more strongly (see D1) and is what every other cezar draft store
> already does. If the owner meant **cross-device** drafts, that is a different feature and D1's
> rejected alternative costs it out.

## TLDR

cezar has one `Composer` with two hosts. The `/new` host passes `value` / `onValueChange`, so its
draft survives navigation and reload (`new-task.tsx:686-695`). **The task-thread host passes
neither** (`task-thread.tsx:466-503`), so every character typed into an existing task's composer
lives in the component's own `useState('')` and dies on unmount.

Three things follow, and this spec fixes all three:

1. **Text is lost.** Switch to the Changes tab, refresh, or open another task — the reply is gone.
2. **Worse: text *leaks*.** `/tasks/A` → `/tasks/B` matches the *same* route element, and `useRun`
   is a plain `useQuery` (`api/queries.ts:1158-1164`), not a suspense query — so nothing unmounts
   and `internalText` carries task A's half-typed reply into task B's box. That is a live bug
   today, independent of persistence.
3. **The record already decided how to fix it** — twice, in this repo, with a store-per-file
   convention (`new-task-draft.ts`, `hand-to-agent-draft.ts`). This adds a third, copies the
   second almost exactly, and changes no server code, no contract and no stored server shape.

## Problem

### 1 — the seam exists, is documented, and the thread host does not use it

`ComposerProps` spells out what the controlled seam is *for* (`composer.tsx:53-60`):

> "Controlled text (pass BOTH or neither): **the /new host owns the draft so it survives
> navigation** (spec: 'Queued form state survives navigation')."

The mechanism (`composer.tsx:126-138`):

```ts
const [internalText, setInternalText] = useState('')
const text = value ?? internalText
const setText = useCallback((next) => { setInternalText(resolved); onValueChangeRef.current?.(resolved) }, [])
```

Every internal edit — typing, `/` completions, the optimistic clear on send, the restore on a
rejected send — routes through `setText`, so a host that passes both props sees all of them. `/new`
passes both. The thread passes neither. The gap is exactly one host's props.

### 2 — the composer is live in every state the owner named

`task-thread.tsx:470` never hides the composer, only disables it:

```
disabled={providerBlocked || (!sessionOpen && !queued && !continuable)}
```

with `sessionOpen = running | waiting` (`:188`), `queued` (`:194`), and `continuable` for a closed
run that recorded a resumable session (`:201-202`). So the composer itself needs **no new gating**: wherever it is enabled today, the draft applies.
This spec adds no state logic to it.

**But the composer is not the only prompt box on a task.** `ThreadView` mounts two more. Both hold
plain `useState('')`, both are mounted unkeyed, and both send what you type straight into the run:

- **The review gate's notes** — `review-panel.tsx:126` (state), `:176` (textarea), mounted at
  `task-thread.tsx:401`. Submitted as `` `Review feedback:\n${text}` `` through `continueRun`
  (`review-panel.tsx:136-139`). That is a prompt; it is *the* prompt box of the `review` state, and
  it is usually the longest text anyone types into a task.
- **The approval gate's notes** — `approval-card.tsx:31` (state), `:94` (textarea), mounted at
  `task-thread.tsx:400`. Its own placeholder says what it is: *"These notes are handed to the spec
  step as its instructions."* A rewind is written in paragraphs, on a run that is still live.

Both are lost on a tab switch or a reload exactly like the composer, and both carry the §3 leak for
exactly the same reason. The owner asked for "any of tasks … in every state", so **all three boxes
are in scope** (D9).

One text input is deliberately **out of scope**: the inline edit of an already-queued message
(`thread-items.tsx:131`). Escape-cancels is its stated contract, so persisting a cancelled edit
would be a bug, not a feature.

### 3 — the cross-task leak, and why it is not hypothetical

`routes.tsx:507` mounts `/tasks/:id` with **no `key`**. React Router re-renders the same
`TaskThreadRoute` instance when only `:id` changes. The `<Suspense>` around it
(`routes.tsx:508-512`) is for the lazy chunk, not for data — `useRun` is `useQuery` with
`enabled: Boolean(id)`, which never suspends. Nothing unmounts **when both queries are already warm** — and that is the common shape.
`TaskThreadRoute` returns `<ThreadLoading/>` while `run.isPending` (`task-thread.tsx:124`) or
`history.isPending` (`:148`), so the *first* visit to a never-opened task does remount and drops the
text, while returning to a task opened inside TanStack's gc window (A → B → A) does not, and
`Composer`'s `internalText` rides across with it. The two notes boxes behave identically.

Stated precisely because the phase-1 gate below is "observe it failing first": at the `ThreadView`
level — a re-render with a different `run` prop, which is what the unit test drives — the leak is
unconditional and deterministic; in a real browser it is the **return** leg that shows it.

This is the exact bug class `routes.tsx:285-297` was written for on the project axis:

> "A `/p/:projectId` param change alone re-renders the SAME `NewTaskRoute` instance… the draft is
> read once from the departing project's storage key, and the write-back effect would then persist
> it under the arriving project's key — exactly the draft leak the per-project keys exist to
> prevent."

Adding persistence *without* fixing this would upgrade a transient leak into a persisted one. The
fix therefore ships first, as its own phase, with its own characterization test.

### 4 — what the owner's "interval + await" is asking for

You only `await` something asynchronous. Every existing cezar draft store is synchronous
`localStorage`, written on every change; there is no debounce, no flush, and no `beforeunload`
handler anywhere in `packages/web/src` (`grep` finds only `pagehide` / `visibilitychange` in the
SSE lifecycle — `run-events.ts:199-200`, `global-events.tsx:398-399`). So the literal ask describes
machinery this codebase has deliberately deleted once already (`8566a2ed`, below). D1 settles it.

## Solution

### D1 — `localStorage`, synchronous, per keystroke. Not the server, and no interval.

**The decision.** A third store-per-file module,
`packages/web/src/routes/task-thread/task-drafts.ts`, holding one entry per (run id × box), written
synchronously inside the box's own change handler. Named for what it holds — a task has three
drafts, not one (D9) — rather than `task-prompt-draft.ts`.

**Why not the server, when the owner's wording points there.** cezar reversed itself on exactly
this class of state and wrote the reversal down. `8566a2ed` (2026-08-07) moved sidebar collapse and
last location *out* of `~/.cezar/ui-state.json`:

> "Both settings were stored workspace-wide… so every open cockpit shared one answer: the last
> client to navigate decided where the next bare-root launch landed on every other client… Both
> describe the browser, not the workspace, so they move to localStorage next to the theme.
> **That deletes the machinery each needed as a server round trip: the debounce, the
> optimistic-then-reconcile cache writes, the unmount flush, the write ordering guard and the
> failure toast.**"

That sentence is a literal inventory of what "on some interval + before navigating await" would
require us to rebuild. It is codified at `BACKWARD_COMPATIBILITY.md` (the `workspace/ui-state`
entry: `lastLocation` and `sidebar` "stay named, bounded and round-tripped… nothing in the current
cockpit reads or writes them"), and the superseded
`.ai/specs/2026-07-29-restore-last-location.md:3-14` amends itself in place:

> "the rejected alternative below — 'localStorage would give each browser a different answer' —
> **turned out to be the requirement, not the objection**."

The record's boundary is also already clean on this exact axis: **submitted prompt text goes
server-side, unsent text does not.** `.ai/specs/2026-07-21-queued-session-prompt-stacking.md` put
`queuedMessages` on `RunRecord` (`packages/cezar/src/runs/store.ts:145-150`) — those are messages
already *delivered* to the run. A half-typed reply has not been said yet.

**Why "no interval" is not a shortcut.** The flush-before-navigate step exists to close the window
a debounced save opens. A save with no window needs no flush. Writing synchronously inside
`onValueChange` — not in a `useEffect`, which is the one place `new-task.tsx:196-198` is weaker
than it needs to be — means that at the instant any navigation begins, the store is already
current. There is nothing pending, so there is nothing to await. **This satisfies the owner's
intent more strongly than the mechanism they described**, and it is the reason the spec departs
from the wording.

**What we give up:** cross-device drafts. Start a reply on the desktop, and the phone will not see
it. On `prod-host` — multi-user behind auth — "gated, therefore server-side" is an available
reading, and `8566a2ed` already answered it the other way for cezar: one server-side answer let the
phone decide where the desktop landed. **If cross-device drafts are what the owner actually
wants, say so at the review gate**, and the cost is: a `promptDraft?: string` additive-optional
field on `runRecordSchema` (`store.ts:120`, additive rule at `:130-133`), its contract twin
(`packages/contract/src/runs.ts:219`), a `PATCH /runs/:id` widening, a debounce, a
flush-on-unmount, a write-ordering guard against the SSE record refresh, and a failure mode where
the run record — the thing cezar restarts from — now carries text nobody sent. That is a different
spec, and it should be one.

**Not `sessionStorage`.** `.ai/specs/2026-08-11-reference-status-chips.md:238-245` chose
`sessionStorage` deliberately, so no reader mistakes this for a contradiction:

> "`sessionStorage` **and not** `localStorage` is the safety bound: it dies with the tab, so the
> oldest thing it can paint is from earlier in the same sitting, never a status from last week
> shown with confidence on a cold morning."

That rule governs **cached server truth repainted as current** — a stale GitHub status asserts
something false about the world. A user's own unsent draft asserts nothing; it is theirs, it is
labelled as theirs by sitting in a textarea they can see and clear, and surviving a browser restart
is the whole point. Different category, opposite answer, on purpose.

**Zero config holds.** `AGENTS.md` § Zero config: "New state may be **written**, never
**required**… Delete any of them and cezar rebuilds what it needs." Every read degrades to `''` on
private mode, a full quota, or malformed JSON — the same stance as both existing stores
(`hand-to-agent-draft.ts:40-42`, `new-task-draft.ts:234-236`).

### D2 — the keys are `cez-task-<box>:<runId>`, with **no** project scope

Run ids are `randomUUID()` (`packages/cezar/src/runs/store.ts:693`), so they are globally unique
and a bare run id cannot collide across projects. This is where the analogy with
`new-task-draft.ts` correctly **stops**: that store needed `:<projectId>`
(`new-task-draft.ts:178-180`) because there is exactly one "new task" composer per project and
nothing else distinguishes them. Here the run id *is* the scope. Adding a project prefix would
buy nothing and would break every draft on the day a run legitimately reports a different
`projectId` (a workspace run's record lives in the boot project — see
`BACKWARD_COMPATIBILITY.md`'s `workspace/runs-index` entry).

Follows `hand-to-agent-draft.ts:62` (`cez-followup-prompt:<itemUrl>`) exactly, and joins the ten
existing `cez-*` keys.

One prefix per box, because they are three different texts about the same task and a user may have
all three in flight (a `review` run shows the review notes *and* an enabled composer):

| Box | Key |
|---|---|
| Thread composer | `cez-task-prompt:<runId>` |
| Review-gate notes | `cez-task-review-notes:<runId>` |
| Approval-gate notes | `cez-task-approval-notes:<runId>` |

A single key with a `{prompt, reviewNotes, approvalNotes}` value was the alternative: rejected
because three independent writers on one JSON blob is a read-modify-write race between components
that re-render on different schedules, for no gain — the reap treats the three prefixes as one
population either way.

### D3 — the draft lives in a `ThreadComposer` child keyed by `run.id`

Not a `key` on the route element. `<TaskThreadRoute key={id}>` would remount the entire thread on
every task switch — history hydration, the scroller, the read receipt — to fix one textarea.

Instead, extract the composer and its draft state out of `ThreadView` into a small
`ThreadComposer` component, mounted `key={run.id}`. This is the pattern already in use **three
lines above it in the same dock**: ``<AgentsDock key={`agents:${run.id}`}>`` (`task-thread.tsx:433`)
and `<PlanDock key={run.id}>` (`:437`, commented "Keyed by run id: the collapse default re-derives
per task"). It is also how `hand-to-agent.tsx` does it — "The route remounts this component per
item (`key={item.url}`)" (`:119-121`).

Keying makes the read a genuine mount-time read:

```tsx
const [text, setText] = useState(() => readTaskPrompt(run.id))
```

— no `useEffect` reset, so there is never a frame that paints the previous task's text. An effect-based reset would render one wrong frame, and on a fast tab switch that frame is
visible.

`ReviewPanel` (`task-thread.tsx:401`) and `ApprovalCard` (`:400`) get the same `key={run.id}` for
the same reason and by the same argument — they are already conditional children of the same dock,
and keying them costs one attribute each. `ReviewPanel` keys the panel rather than the inner
`ReviewActions`: the notes live in the child, but the child is not separately mounted anywhere, and
the panel has no other mount-time state to disturb.

### D4 — clearing is automatic for the COMPOSER, and the `hand-to-agent` trap does not apply to it

`submitDraft` (`composer.tsx:335-344`) clears optimistically; a rejection restores the text in
front of anything typed since (`:318-327`). In controlled mode **both** flow through
`onValueChange`, and `composer.test.tsx:512-542` already pins that ("a rejected send restores the
draft through onValueChange"). So:

- **Successful send** → `onValueChange('')` → the store *removes* the entry. Nothing to clean up.
- **Rejected send** → `onValueChange('my careful reply')` → the store re-persists it. The user's
  words survive a server error *and* a subsequent reload, which is strictly better than today.

`hand-to-agent.tsx:212-218` needed an explicit "clear BOTH the store and the state" because its
textarea state and its store are separate and its persist effect keys on `prompt`. Here the host's
`text` state is the single source and the store is a pure mirror written from the same callback, so
the two cannot diverge. **No explicit clear-on-success call is needed for the composer, and adding one would be
dead code** (the two notes boxes are the opposite case — see D9) — the verification pins the behaviour, not the call.

`allowEmptySubmit={continuable}` (`task-thread.tsx:488`): a one-click Continue with an empty box
submits `''`, the store already holds no entry for that run, and nothing is resurrected on the next
mount. No special case.

### D5 — empty removes; a timestamp and a cap bound the rest

`hand-to-agent-draft.ts:73-78` gives the first half:

> "Empty text REMOVES the entry rather than storing `''` — an untouched or just-submitted item
> leaves no trace, so this store never grows unbounded with every item ever visited."

That bounds growth by *touched* tasks, not by time — and unlike GitHub hand-offs, cezar accumulates
hundreds of runs, and a run can be deleted (`DELETE /api/v1/runs/:id`) while its draft key lives
forever. So the stored value is `{"text": "...", "at": <epochMs>}` rather than a bare string, and
**one reap runs per `ThreadComposer` mount**: it scans **all three** prefixes as one population,
and if there are more than `MAX_DRAFTS = 100` entries, drops the oldest by `at` until 100 remain.
One `localStorage` pass per thread open, over at most a few hundred short keys — not per keystroke,
and not once per box (the composer mounts on every thread; the two gates do not, so hanging the reap
on the composer is the one hook that always runs).

**No `DRAFT_VERSION`.** The doctrine at `new-task-draft.ts:151-164` exists for a specific hazard —
a stored value that records an *old default* rather than a user decision, which is why v2 drops
`source` and keeps text ("a blanket key bump would have thrown away half-typed task text to fix a
pill"). This store holds nothing but the user's own text; there is no default to un-record, so
there is nothing a version could ever be used to invalidate. A malformed or unparseable value reads
as `''` and is overwritten on the next keystroke. A bare-string value (which no version of this
code writes) is tolerated as text rather than discarded — one line, and it keeps the doctrine's
spirit: never throw away typed words to satisfy a schema.

### D6 — text only; images stay out

`new-task-draft.ts:9-10` already rejected persisting images ("multi-MB base64 would blow the ~5 MB
quota"). Beyond that, the composer's `images` state has **no** controlled seam at all
(`composer.tsx:139`; the props are `value` / `onValueChange` and nothing else), so persisting them
means widening the shared component's contract for both hosts. Out of scope. **A user who attaches
an image and navigates away still loses the image** — that is unchanged behaviour, and it should be
said out loud rather than discovered.

### D7 — no analytics events, and why

The standing instruction is that every feature ships with named events. `packages/web/src` contains
**no** client analytics sink — no `analytics`, `track(`, `posthog`, `plausible` or `umami` anywhere
(verified by grep, 2026-08-21) — and neither existing draft store emits anything. Adding events
here means building a browser telemetry pipeline for a feature whose entire footprint is one
`localStorage` key, in a product whose first line is "no accounts, no database, no cloud"
(`AGENTS.md:3`). **This feature ships with no events, deliberately.** If cockpit telemetry is ever
built, `draft_restored` (with a length bucket, never the text) is the one event worth having, since
it is the only way to measure whether this feature is used at all.

### D8 — what this spec does NOT do

- No server change, no contract change, no `RunRecord` field, no new route.
- No change to `Composer` itself. It gains no props; the seam it already documents is simply used.
- No change to which states the composer is enabled in.
- No cross-device sync (D1's rejected alternative).
- No image persistence (D6).
- No touch to `new-task-draft.ts` or `hand-to-agent-draft.ts`.
- No persistence for the inline edit of an already-queued message (`thread-items.tsx:131`) — that
  editor's contract is Escape-cancels, so remembering a cancelled edit would be a defect.
- No change to what any of the three boxes SEND, to when they are enabled, or to their copy.

### D9 — the two notes boxes get the same treatment, one phase later

The review-gate notes and the approval-gate notes are prompts by any reading (Problem §2), so they
persist too, with the same four moves and no new machinery:

| | Composer | Review notes | Approval notes |
|---|---|---|---|
| Host | `ThreadComposer` (new) | `ReviewActions` (`review-panel.tsx:123`) | `ApprovalCard` (`approval-card.tsx:27`) |
| Mount key | `key={run.id}` | `key={run.id}` on `ReviewPanel` | `key={run.id}` on `ApprovalCard` |
| Read | `useState(() => readTaskDraft('prompt', run.id))` | same, `'reviewNotes'` | same, `'approvalNotes'` |
| Write | in `onValueChange` | in `onChange` | in `onChange` |
| Clear | `onValueChange('')` on send (D4) | the existing `setNotes('')` at `review-panel.tsx:145` | the existing `setNotes('')` at `approval-card.tsx:46` |

The two clears are the only place the notes boxes differ from the composer: their state and their
store are written by two different statements, so — unlike D4 — the success path has to say so.
Both already call `setNotes('')` on success; both become a one-line helper that sets state *and*
writes the store, so the pair cannot drift. That is the `hand-to-agent.tsx:212-218` trap, and here
it is real, which is why it is named rather than argued away.

Failure paths deliberately keep the text: a rejected send-back leaves the notes in the box **and**
in the store, matching the composer's rejected-send behaviour (D4) and the standing rule that
nothing the user typed is lost to a server error.

## Architecture

```
routes.tsx:507  /tasks/:id  ──(param change only)──▶  SAME TaskThreadRoute instance   [unchanged]
                                                          │  useRun = useQuery, never suspends
                                                          ▼
                                              ThreadView (task-thread.tsx:163)
                                                          │
                              ┌───────────────────────────┴──────────────────────┐
                              │  thread-dock                                     │
                              │    <AgentsDock  key={`agents:${run.id}`} />       │  (exists)
                              │    <PlanDock    key={run.id} />                   │  (exists)
                              │    <ThreadComposer key={run.id} run={run} … />    │  NEW  [D3]
                              └──────────────────────────────────────────────────┘
                                                          │
   ThreadComposer:  useState(() => readTaskPrompt(run.id))        ← mount-time read, no effect
                    onValueChange = (t) => { setText(t); writeTaskPrompt(run.id, t) }   ← sync [D1]
                    useEffect(reapTaskPrompts, [])                 ← once per mount     [D5]
                                                          │
                              <Composer value={text} onValueChange={…} … />
                                   every edit → setText → onValueChange → store
                                   optimistic clear ''  → entry REMOVED                 [D4]
                                   rejected-send restore → entry REWRITTEN              [D4]
                                                          │
                    localStorage  cez-task-prompt:<runId> = {"text":"…","at":1755…}     [D2,D5]
```

The two gate cards sit in the same dock and take the same two changes:

```
   <ApprovalCard key={run.id} run={run} />        (task-thread.tsx:400)   + key, + draft
        notes: useState(() => readTaskDraft('approvalNotes', run.id))
        onChange → setNotes(t) + writeTaskDraft('approvalNotes', run.id, t)
        sendBack.onSuccess → clear BOTH (approval-card.tsx:46)

   <ReviewPanel  key={run.id} run={run} />        (task-thread.tsx:401)   + key, + draft
        notes: useState(() => readTaskDraft('reviewNotes', run.id))       (review-panel.tsx:126)
        onChange → setNotes(t) + writeTaskDraft('reviewNotes', run.id, t)
        sendBack.onSuccess → clear BOTH (review-panel.tsx:145)
```

The only wire in these diagrams that does not exist today is the one from each box back to
something that keeps the value.

## Data models

**Stored, client-only.** No server shape changes anywhere.

| Key | Value | Lifetime |
|---|---|---|
| `cez-task-prompt:<runId>` | `{"text": string, "at": number}` — `at` is epoch ms, used only for reaping | Until the text is emptied (send or manual clear), or reaped past `MAX_DRAFTS = 100` |
| `cez-task-review-notes:<runId>` | same shape | Until the send-back succeeds, or reaped |
| `cez-task-approval-notes:<runId>` | same shape | Until the send-back succeeds, or reaped |

- `<runId>` is the run's `randomUUID()` (`store.ts:693`) — no project prefix (D2).
- Empty text ⇒ the key is **removed**, never stored as `''` (D5).
- Unparseable value ⇒ read as `''`. A bare string ⇒ read as that string.
- No `v` field (D5 explains why this store is the one that does not need one).

**Module contract** — `packages/web/src/routes/task-thread/task-drafts.ts`:

```ts
export type TaskDraftKind = 'prompt' | 'reviewNotes' | 'approvalNotes'

export function readTaskDraft(kind: TaskDraftKind, runId: string): string
export function writeTaskDraft(kind: TaskDraftKind, runId: string, text: string): void  // '' removes
export function reapTaskDrafts(): void                              // all kinds, bounded to MAX_DRAFTS
export function resetTaskDrafts(): void                             // test isolation only
```

Every function is total and never throws — the `try {} catch {}` stance of both existing stores.

## API contracts

**None.** This spec adds, removes and changes no route, no request body and no response shape.
`BACKWARD_COMPATIBILITY.md` needs no new row; per its own §2 rule an entry is required for route
inventory changes, and there are none. Client-only browser state is precisely the category
`8566a2ed` moved *off* the API surface.

## Phases

Four phases, each shippable and independently verifiable.

1. **The leak, alone.** Extract `ThreadComposer` out of `ThreadView` and mount it `key={run.id}`.
   No persistence yet. This ships a bug fix on its own: typed text no longer follows you from task
   A to task B. Its characterization test must be written **first and observed failing** against
   today's code — if it passes before the change, the leak analysis in Problem §3 is wrong and the
   spec needs correcting rather than implementing.
2. **The store.** Add `task-prompt-draft.ts` with its own unit tests, wired to nothing. Pure
   addition, zero behaviour change, reviewable in isolation.
3. **The wiring.** `ThreadComposer` reads at mount, passes `value` / `onValueChange`, writes
   synchronously, and reaps once per mount. This is the phase the user sees.

4. **The two gates.** `ReviewPanel` and `ApprovalCard` keyed by `run.id`, reading at mount, writing
   on change, clearing both state and store on a successful send-back (D9). Ships on its own: it
   depends on phase 2's module and on nothing in phases 1 or 3.

Phase 1 strictly before phase 3: wiring persistence onto an unkeyed composer would write task A's
text under task B's key, turning a transient leak into a durable one. The same rule is why phase 4
adds each card's `key` in the SAME change as its persistence — for those two the key and the write
are one edit, so they cannot land out of order. Phase 2 may land in any order relative to 1.

## Risks

- **Phase 3 without phase 1 is worse than the bug.** Named above; the phase order is the mitigation
  and the phase-1 test is the enforcement.
- **A restored draft can outlive its context.** Type a reply on a `waiting` run, come back a week
  later to a `done` run, and the text is still in the box — now above a finished transcript, and
  the composer may be disabled so it cannot even be sent. It is still *the user's own text*, which
  is why this is acceptable where a week-old GitHub status is not
  (`2026-08-11-reference-status-chips.md:238-245`) — but a disabled composer showing unsendable
  text is a real, if minor, oddity. Accepted deliberately over the alternative of silently deleting
  words someone wrote. The `MAX_DRAFTS` reap bounds how many such ghosts can accumulate, not how
  old one gets.
- **A per-keystroke synchronous `localStorage.setItem` has an unmeasured cost.** There is no number
  for it: `new-task.tsx:196-198` has done the same thing — worse, actually, `JSON.stringify` over a
  whole draft object — since 2026-07 with no reported problem, and this spec inherits that
  precedent rather than establishing a new one. **There is no measurement, and this spec does not
  invent one.** If it ever surfaces, the fix is coalescing *behind* the synchronous guarantee, and
  that is the point at which the owner's "on some interval" becomes the right mechanism for the
  right reason.
- **Quota exhaustion is silent.** A full store means the write is swallowed and the draft is not
  remembered — the user is not told. That matches both existing stores exactly
  (`hand-to-agent-draft.ts:79-81`) and the alternative (a toast on every keystroke) is worse. The
  in-session text is never at risk, because the host's React state is authoritative and the store
  is only a mirror.
- **`MAX_DRAFTS = 100` is a guess, not a measurement.** No number exists for how many tasks a user
  half-types into. 100 short prompts is far under the ~5 MB quota, and the reap removes the
  *oldest*, so the drafts most likely to matter are the last to go. Stated as a guess so nobody
  later cites it as a finding.
- **The extraction touches a busy component.** `ThreadView` is ~350 lines of dock and the composer
  block carries five conditional props (`disabled`, `disabledReason`, `footerEnd`, `placeholder`,
  `allowEmptySubmit`) plus `continueAction`, which is a hook that must move with it or be passed
  in. `task-thread.test.tsx` drives `ThreadView` directly with fixture runs and asserts on the
  textarea in at least six places (`:225, :298, :353, :365, :641, :659`); all must keep passing
  untouched, which is the real proof the extraction was behaviour-neutral.

## Verification

Every guard names the mutation that must turn it red. Gates, in order,
`npm test -- <path>` never `npx vitest`: `npm run typecheck`, `npm test`, `npm run test:unit`,
`npm run build`, `npm run test:package`. `npm test` is judged by its **exit code**, not its pass
count.

### Unit — the store (`routes/task-thread/task-drafts.test.ts`, new)

| Guard | Mutation that must turn it red |
|---|---|
| `readTaskDraft` on an untouched run answers `''` | return `null` / throw on a missing key |
| write-then-read round-trips the text for the same run id | drop the `at` wrapper's parse path |
| Two run ids never see each other's text | drop the `:<runId>` suffix from the key |
| `writeTaskDraft(kind, id, '')` **removes** the key — assert `localStorage.getItem(...) === null`, not just that the read answers `''` | store `''`; a test that only checks the read cannot tell the difference, and unbounded growth is the whole point of the rule |
| A malformed stored value reads as `''` and does not throw | let `JSON.parse` escape the `try` |
| A bare-string stored value reads as that string | discard non-object values |
| Every function survives a throwing `localStorage` (stubbed) without throwing | remove either `try {} catch {}` |
| `reapTaskDrafts` with 120 entries leaves exactly 100, and keeps the 100 newest by `at` | evict newest-first, or evict by key order |
| Two KINDS never see each other's text for the SAME run id — write `prompt` and `reviewNotes` for one run, read both back | share one key across kinds, or drop the kind from the key |
| `reapTaskDrafts` counts all three prefixes as ONE population — seed 60 `prompt` + 60 `reviewNotes` and assert 100 survive in total, not 120 | reap per prefix |
| `reapTaskDrafts` touches no key outside the `cez-task-*` prefixes — seed `cez-theme`, `cez-new-task-draft` and `cez-followup-prompt:x` and assert all three survive | widen the prefix match; this one guard is the difference between a reap and wiping the user's theme and the GitHub hand-off drafts |

### Unit — the host (`routes/task-thread/task-thread.test.tsx`, extended)

| Guard | Mutation that must turn it red |
|---|---|
| **Phase 1, written first and observed failing on today's code:** render `ThreadView` for run `r1`, type into the composer, re-render with run `r2`, and the textarea is **empty** | drop `key={run.id}` from `ThreadComposer` |
| Text typed for `r1` is still there after re-rendering `r2` and then `r1` again | drop persistence, or key by something that is not the run id |
| A fresh mount for a run with a stored draft paints that text **on the first render** — assert immediately after `render`, with no `waitFor` | move the read into a `useEffect`; a `waitFor` here would pass against the wrong-frame bug and is the single easiest guard to write uselessly |
| A rejected send leaves the restored text **in the store**, not just in the box — assert `readTaskPrompt(id)` after the rejection settles | stop routing the restore through `onValueChange` |
| A successful send leaves **no** stored entry | keep the entry, or clear only the state |
| A `continuable` run submitted with an empty box stores nothing and restores nothing on the next mount | make `allowEmptySubmit` write a `''` entry |
| The composer is enabled and draft-backed in `running`, `waiting` and `queued`, and for a `continuable` closed run | gate persistence on any single status |
| The six pre-existing textarea assertions (`:225, :298, :353, :365, :641, :659`) still pass **unmodified** | any behaviour change in the extraction — editing these to fit is the failure, not the fix |

### Unit — the two gates (`review-panel.test.tsx` extended, `approval-card.test.tsx` new)

No `approval-card.test.tsx` exists today, so phase 4 brings the first one.

| Guard | Mutation that must turn it red |
|---|---|
| Review notes typed for a `review` run are painted on a fresh mount, on the FIRST render | move the read into an effect |
| Review notes for run `r1` do not appear when the panel re-renders for `r2` | drop `key={run.id}` from `ReviewPanel` |
| A SUCCESSFUL send-back clears the box **and** leaves no stored entry | clear only the state (the D9 trap) |
| A FAILED send-back leaves the text in the box **and** in the store | clear on error, or clear before the request settles |
| The same four guards for `ApprovalCard` (its send-back is `requestRunChanges`) | the same mutations on the approval card |
| The composer draft and the review-notes draft for one run are independent — type both, assert each reads back its own | one shared key for the whole task |

### Unit — the shared component

`components/composer/composer.test.tsx:483-542` already pins the controlled seam in both
directions. **It must not be edited by this work.** If it needs changing, `Composer`'s contract
changed, which D8 says this spec does not do.

### Runtime E2E — the gate on Done

`packages/web/e2e/task-thread.e2e.ts` boots a real cezar over the recorded fixture run and drives a
real browser; extend it (video + screenshots per run, into `.ai/qa/artifacts_e2e`). Against the
running cockpit:

1. Open a task, type a reply, **do not send**. Click the **Changes** tab, then back to **Session** —
   the text is still in the box.
2. Reload the page on that task — the text is still there.
3. Open a **second** task. Its composer is **empty**. Type something different in it, return to the
   first — each task shows its own text. *(This is the leak: it must be seen to fail before phase 1
   and to pass after.)*
4. Send the reply on the first task. The box clears, and after a reload it is **still** clear —
   the store was spent, not just the state.
5. On a `queued` run and on a closed-but-`continuable` run, repeat step 1 — the draft survives in
   both, confirming "in every state" end to end.
6. In DevTools, confirm exactly one `cez-task-prompt:<uuid>` key per task with unsent text, and
   **none** for the task whose reply was sent.
7. On a run parked at **review**: type notes into "Notes for the agent", switch to Changes and
   back, reload — the notes are still there. Send back; the box clears and stays clear across a
   reload. *(This is the box the first cut of this spec missed.)*
8. On a run parked at an **approval gate**: the same, for the approval card's notes. If no live
   approval-gated run is available in the fixture workspace, say so and cover it at the unit level
   only — a claimed e2e that was not run is worse than a named gap.

**Corrected 2026-08-22 — QA executed, steps 1–8.** Driven with raw Playwright against a booted
throwaway instance per `AGENTS.md` § "Verifying a cockpit UI change" (deployed `sha` at the time,
`ff06ecc7`, confirmed reachable from the tested `HEAD`). Results, recorded in
`.ai/specs/2026-08-22-per-task-prompt-drafts-qa-and-closeout.md`:

- **Steps 1, 2, 3, 3b, 5, 6, 7, 8 — PASS**, live in a real browser: tab-switch and reload
  persistence, cross-task isolation (the leak this spec exists to fix), draft survival on `queued`
  and closed-`continuable` runs, exactly-one-key-per-task in `localStorage`, and review-gate /
  approval-gate notes persistence — all observed directly, not inferred.
- **Step 4 and the send-clearing halves of 7/8 — named gap, not a confirmed defect.** The
  separate driver that sends a real reply through a live `CEZ_DRY_RUN=1` run
  (`cez-eb9f65aa-qa-send.cjs`) timed out waiting for the composer to render after creating the run,
  before it could observe a send-and-clear cycle end to end. The underlying clear-on-send behaviour
  remains covered at the unit level (`task-thread.test.ts`, `review-panel.test.tsx`,
  `approval-card.test.tsx`, 734/734 green per the original implementation), and this driver's own
  hang (browser never closed on its error path, confirmed separately) points at a QA-tooling defect
  in the throwaway script rather than the shipped feature. Per this section's own rule ("a claimed
  e2e that was not run is worse than a named gap"), this is recorded as an open gap: a live,
  browser-driven confirmation of send-and-clear has still not been captured, and should not be
  assumed from the unit coverage alone.

Steps 1–8 have now been executed against a real browser (with the one gap above named rather than
skipped silently) — per `AGENTS.md` and the repo's definition of done, this clears "qa needed" for
everything but that one send-and-clear path.

## Resolved at the review gate (2026-08-21)

**Did the owner mean cross-device?** No — settled at review, not left open. localStorage,
per-browser, is the answer: the record already decided this exact class for this exact cockpit
(`8566a2ed`), `AGENTS.md:3` is "no accounts, no database, no cloud", and "separately persisted **on
task**" is a statement about scoping per task, not about syncing per device. If the owner later
asks for "start a reply on my laptop, finish it on my phone", that is D1's rejected alternative and
it gets its own spec — this one is not blocked on it.

**Scope, also settled at review:** the ask says "any of tasks … in every state", and the thread has
three prompt boxes, not one. All three persist (D9); the queued-message inline editor does not, for
the reason in Problem §2.


## What could not be found

- **No cezar KB entry on draft persistence.** The reachable `cez kb` roots are `notion`
  (2122 docs, read-only) and local roots with 0 docs; this repo has no `.ai/cezar/knowledge`.
  cezar's decisions live in `.ai/specs`, `AGENTS.md`, `BACKWARD_COMPATIBILITY.md` and commit
  messages — all four were read directly for this spec.
- **No owner report of losing thread text**, beyond the task instruction itself. No memo, note or
  todo describes the symptom; if a specific incident drove this, it is not in the reachable record.
- **No in-flight or duplicate work.** None of the 110 entries in `.ai/cezar/todos.json` mention
  drafts, the composer or prompt persistence; no spec since
  `2026-08-15-composer-stops-forcing-choices.md` touches drafts.
- **No prior decision on debounce or on draft images** for any cezar draft store. Both existing
  stores write undebounced on every change and neither documents that as a choice — D1 and D6 are
  therefore the first time either is decided on the record, not a restatement of one.
- **SPEC-506 "retire client-side persistence" does not apply here.** It is a *chat*-repo spec
  (`/var/lib/cezar/loki-labs/chat/.ai/specs/SPEC-506-2026-08-14-retire-client-side-persistence.md`,
  `**Domain:** grocey (web)`, commit `40c43f00`), and its doctrine is conditioned on a mechanism
  cezar does not have: per-visitor state in D1 keyed to an account, "the sign-in gate is what makes
  that possible". `AGENTS.md:3` — cezar has "no accounts, no database, no cloud".
