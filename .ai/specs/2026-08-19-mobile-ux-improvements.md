# SPEC — Mobile UX improvements for the cezar cockpit

**Date:** 2026-08-19
**Status:** implemented (QA needed — real-device e2e pending)
**Area:** `packages/web` (cockpit SPA)

## TLDR

The cockpit shell is already mobile-aware (drawer, top bar, safe-area insets, 44px
targets, `text-base` composer to dodge iOS zoom, keyboard-aware thread dock). But several
high-traffic *content* surfaces still leak a desktop layout to a ~375px phone. This spec
closes the concrete, verified gaps that hurt the phone experience most, keeping every
change inside the existing design-token + `md`-breakpoint idiom the codebase already uses.

## Problem

A mobile-UX audit of the routes/components found (ranked by traffic × brokenness):

1. **`/tasks` (global-tasks) is a horizontal-scrolling table on mobile** — unlike `/`
   (tasks-overview) and `/workspace/tasks`, which reflow to stacked cards below `md`,
   `global-tasks.tsx` renders its `TaskTable` (Running + grouped) and `FiledTasks` table
   inside a bare `overflow-x-auto`. Minimum row width ≈ 700–750px, so the top cross-project
   surface is a sideways-scroll on a 375px screen.
2. **Filed table** has the same no-reflow problem.
3. **Hover-only action affordances** (`opacity-0 group-hover:opacity-100`) are invisible and
   unreachable on touch (no hover): the run-header rename pencil, the thread's queued-bubble
   Edit/Remove, and the tasks-overview row rename.
4. **Composer controls under 44px** — send (`size-8`=32px), attach (`size-8`), dictation
   (`h-8`) — the single most-tapped mobile controls.
5. **No task search at `/` on mobile** — the search input is `md:`-only in tasks-overview
   (global-tasks already re-adds its search below `md`).
6. **GitHub merge-box branch line** overflows horizontally without truncation.

## Solution

Per-finding, minimal, token-safe:

1/2. **global-tasks card reflow.** Add a `GlobalTaskCard` (mirrors `tasks-overview`'s
   `TaskCard`) and a `FiledCard`, rendered in a `md:hidden` stack; gate the existing tables
   with `hidden md:block`. Card row-actions (Start/Archive/Read) become ≥44px labelled
   controls. Tests scope to the table (`data-slot`/`within`) so the dual render is
   duplication-safe — the same discipline `tasks-overview.test.tsx` already uses.
3. **Touch-visible actions.** Add `pointer-coarse:opacity-100` beside the existing
   `opacity-0 … group-hover:opacity-100` so coarse pointers always show the control while
   fine pointers keep the hover-reveal. (`pointer-coarse`, not `max-md`: a touch tablet at
   ≥`md` also cannot hover.)
4. **Composer targets.** Send/attach/dictation get `max-md:size-11` / `max-md:h-11` so the
   phone gets ≥44px while desktop keeps its compact 30–32px controls.
5. **Mobile search at `/`.** Add a `md:hidden` search input above the card list in
   tasks-overview (copying the global-tasks pattern), wired to the same `query` state.
6. **Branch overflow.** `break-all` on the merge-box ref line.

Out of scope (logged for a follow-up): bottom-thumb Active/Archived segmented control (#11),
sub-44px filter chips across the filter bars (#8), tab-row overflow-x (#9).

## Verification

- `npm run typecheck` + `npm run lint` + `npm test` in `packages/web` green (design-guardian
  included — no raw hex, no `dark:`, no `h-screen`).
- New/updated unit assertions: global-tasks renders a `data-slot="global-task-card"` per
  running/grouped run and a `data-slot="filed-task-card"` per filed row below `md`; existing
  table assertions re-scoped to the table container so they stay unambiguous.
- QA needed: real iPhone-width device pass on `/tasks`, `/`, a thread, and `/new`.
