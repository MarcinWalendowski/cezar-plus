# API scope ownership token — a departing provider must not un-scope the arriving one

**Status:** Implemented
**Date:** 2026-08-22

## TLDR

Leaving `/p/<project>/…` and coming back — the exact motion of "open a task from the global
Tasks page, go back, open the next one" — leaves the API client **unscoped** while the URL still
names the project. Every project-scoped request then goes to the BOOT project: `GET
/api/v1/runs/<id>` instead of `GET /api/v1/p/cezar/runs/<id>`, which 404s, and the thread renders
**"Task not found — No run has this id."** over a task that is running fine. The scope is a
module-level slot with no owner, and the *departing* `ProjectScopeProvider`'s unmount cleanup
resets it after the *arriving* one has already claimed it. Fix: the slot records **who** claimed
it, and a release only resets when that claim is still standing.

## Problem

`packages/api-client/src/utils/project-scope.ts` holds the active project in one module variable.
`ProjectScopeProvider` (`packages/web/src/api/project-scope-context.tsx`) writes it during render
and resets it on unmount:

```ts
useEffect(() => () => setApiScope(null), [])
```

That reset is unconditional, so it fires even when it is no longer the writer. React renders the
arriving tree **before** committing the departing one's cleanup, so across a provider *instance
swap* the order is:

1. arriving provider renders → `setApiScope('cezar')`
2. children mount → queries fire correctly scoped (`/api/v1/p/cezar/runs/<id>`) ✅
3. departing provider's cleanup runs → `setApiScope(null)` ❌
4. next render recomputes query keys with `queryScope() === 'default'` → the same three queries
   re-fire **unscoped** (`/api/v1/runs/<id>`) → 404 → "Task not found"

and it is **sticky**: step 4's keys are cached under `'default'`, the arriving provider's
`[projectId]` effect restores the module variable without re-rendering anything (a module
variable is not reactive state), so nothing re-keys and nothing retries. Only a full reload
recovers.

The provider's existing comment already reasons about a neighbouring hazard — a `[projectId]`
*change* on the same instance — and splits the reset into its own mount-only effect for it. That
covers a project swap; it does not cover a provider that unmounts and a different one that mounts,
which is what any navigation out of `/p/:projectId/*` and back does.

### Measured on production, 2026-08-22

`cockpit.example.com`, four running `cezar` tasks. Instrumented `window.fetch`, then: global
`/tasks` → click a running task → Back → click another running task.

```
t=19651  /api/v1/p/cezar/runs/43ab17aa…            ← scoped, 200
t=19651  /api/v1/p/cezar/runs/43ab17aa…/history
t=19651  /api/v1/p/cezar/runs/43ab17aa…/history-context
t=19652  /api/v1/runs/43ab17aa…                    ← UNSCOPED, 404
t=19652  /api/v1/runs/43ab17aa…/history
t=19652  /api/v1/runs/43ab17aa…/history-context
```

Screen: "Task not found · No run has this id. It may have been deleted, or the link is from
another machine." The run existed throughout — `GET /api/v1/p/cezar/runs/43ab17aa…` answered 200
from the same tab, and the sidebar's Tasks badge flipped to the boot project's count, which is the
same fact showing twice.

Reached by every route out of a project scope and back: the global Tasks page, `/workspace/*`,
`/notes`, `/settings` (whose `settings-shell.tsx` mounts a second provider of its own), and the
browser Back button.

## Solution

Give the slot an owner.

- `setApiScope(projectId, owner?)` — claims the scope for `owner`.
- `releaseApiScope(owner)` — resets to unscoped **only if `owner` is the claim still standing**.
- `ownsApiScope(owner)` — whether that claim is current.

`ProjectScopeProvider` mints a per-instance token, claims with it during render (which always
precedes any commit, so the arriving instance always owns the slot before the departing one's
cleanup runs), and releases with it on unmount. A stale instance's release becomes a no-op, and a
provider that leaves with no successor still resets normally.

Deliberately NOT done here: moving the scope off the module seam into React context. That is the
real cure for a non-reactive global driving query keys, and it is a refactor of every exported
client function into a hook (the module doc explains why it is a module in the first place). This
change removes the window that makes it fail; it does not relitigate the design.

## Architecture

```
project-scope.ts        activeProjectId + scopeOwner   ← one slot, one claim
  setApiScope(id, owner)      claim
  releaseApiScope(owner)      release IF still owner
  ownsApiScope(owner)         is this claim current

project-scope-context.tsx
  const owner = useRef({}).current                     ← identity, per instance
  render:   claim when the value OR the owner differs
  effect:   re-assert on projectId change
  unmount:  releaseApiScope(owner)                     ← no-op once superseded
```

`owner` is `unknown` and compared by identity, so the token can never collide with a project id
and no caller can forge one. `setApiScope(id)` with no owner keeps working (owner `null`) — it is
a published export of `@open-mercato/cezar`'s client and tests use it.

## Phases

1. `project-scope.ts`: owner slot, `releaseApiScope`, `ownsApiScope`. (done)
2. `project-scope-context.tsx`: claim with a per-instance token, release with it. (done)
3. Regression tests at both layers. (done)
4. Deploy + production E2E of the measured repro. (done)

## Data models

None. One added module-level variable (`scopeOwner`), never persisted, never serialized.

## API contracts

No server change. `setApiScope(projectId: string | null, owner?: unknown)` is a
backward-compatible widening; `releaseApiScope` / `ownsApiScope` are additive exports.

## Risks

- **Render-phase side effect.** The claim still happens during render, so a transition render
  that React discards can claim the slot. It could already write the slot, so this adds no new
  hazard, and a discarded render for the same project writes the same value.
- **A forgotten release.** If a provider unmounts while a *later* provider owns the slot, the
  release no-ops — correct. If the owner never releases (a crash between claim and unmount), the
  next provider's render-time claim overwrites it, which is the pre-existing behaviour.
- **An embedder calling `setApiScope` directly** takes ownership away from the mounted provider,
  so the provider's unmount will not reset. That is the honest reading of "someone else set it".

## Verification

Automated:

- `packages/api-client/src/utils/project-scope.test.ts` — a release by a superseded owner does
  NOT reset; a release by the current owner does; `setApiScope` with no owner still works.
- `packages/web/src/api/project-scope-context.test.tsx` — an **instance swap** (same projectId,
  different provider instance, one commit) never dips to unscoped, measured from a child's mount
  effect *and* from a render after the commit — the two points the production failure was seen at.
  The pre-existing same-instance `projectId`-change test stays.
- Full gates: `npm run typecheck`, `npm run lint`, `npm test`.

Production E2E (the measured repro above, re-run against the deployed build):

1. `https://cockpit.example.com/tasks` → click a running `cezar` task → thread renders.
2. Browser Back → click a *different* running `cezar` task.
3. The thread renders. No `/api/v1/runs/<id>` (unscoped) request is issued — every run request
   carries `/p/cezar`. Verified by instrumenting `window.fetch` in the page.
