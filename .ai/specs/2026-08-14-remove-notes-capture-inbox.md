# Remove the notes capture inbox (F3 feature B)

**Date:** 2026-08-14 · **Status:** implemented · **Branch:** `main`

## TLDR

Delete F3 feature B — the workspace notes capture inbox — from the fork entirely: the
`CEZ_NOTES` flag, the `capabilities.notes` health key, the six
`/api/v1/workspace/notes*` routes, the `@open-mercato/cezar-contract` notes module, the
`/notes` cockpit route and nav item, and the two `~/.cezar` path helpers. Owner decision,
2026-08-14. F3 **feature A** (cross-project workspace runs, `CEZ_WORKSPACE_VIEWS`) is
untouched, as are F1 knowledge, F2 sources and F4 notifications.

## Problem

Notes has never been more than a scaffold. `server/notes-routes.ts` says so in its own
docblock: the `notes/{types,store,coordinator,processor,prompt,task-template}.ts` modules
that P2.1–P2.3 were to add do not exist, so every route answers a constant schema-valid
empty payload or a fixed `409`, **regardless of the flag**. The cockpit page renders
"Notes is not built yet". Nothing has ever written `~/.cezar/notes.json`.

What it does cost is real:

- a flag, a capability key and a nav item that promise a feature to anyone who reads the
  README or turns `CEZ_NOTES=1` on,
- 234 lines of contract, 69 of routes and 52 of UI that every later refactor must carry,
- an entry in `BACKWARD_COMPATIBILITY.md` naming six routes as a protected surface,
- a spec that reads to the next session as work still queued rather than work dropped.

**The removal contradicts a recorded decision, and that is deliberate.** The central-hub
plan (`.ai/runs/2026-08-06-cezar-central-hub/PLAN.md`) names "notes processed into tasks
across multiple projects" as part of the mission, and F3 feature B is how it was to be
delivered. Owner reaffirmed the removal after that conflict was raised. This spec is the
record that supersedes it, per the plan's own precedence rule.

## Solution

Delete, do not deprecate. Under `BACKWARD_COMPATIBILITY.md`'s general rule a vanishing
route and a vanishing health key are breaking and would owe a deprecation window, a
migration path and a called-out minor bump. **None of that applies here**, and the reason
is checkable rather than a judgement call:

```
git cat-file -e upstream/main:packages/cezar/src/server/notes-routes.ts   → ABSENT
git cat-file -e upstream/main:packages/contract/src/notes.ts             → ABSENT
git log --diff-filter=A -- packages/cezar/src/server/notes-routes.ts     → 65eef6d2 (fork only)
```

The whole surface was introduced by `65eef6d2` in this fork and has never been in a
published `@open-mercato/cezar` release. No installed version answers these routes, no
installed version reports `capabilities.notes`, and no user's `~/.cezar` holds a
`notes.json`. There is no consumer to keep compatible with, so the BC entry is deleted
rather than converted into a deprecation note.

## Architecture

Five seams, each cut once. The scaffold was built to be removable this way (PLAN "Shared-file
ownership": one edit per shared file), so no seam is shared with F1/F2/F4 except the two
files that enumerate all capabilities.

| Seam | Files |
|---|---|
| Contract | `packages/contract/src/notes.ts` (delete), `index.ts` export line, `health.ts` `notes` key |
| Server | `server/notes-routes.ts` + `contract-parity.notes.test.ts` (delete), `server.ts` import + mount, `capabilities.ts` |
| Paths | `paths.ts` `notesPath()` / `notesLogPath()` |
| Cockpit | `routes/notes/notes.tsx` (delete), `routes.tsx`, `nav-items.ts`, `app-shell.tsx`, `app-shell-container.tsx`, `api/client.ts`, `api/queries.ts` |
| Docs + ops | `README.md`, `.env.example`, `BACKWARD_COMPATIBILITY.md`, `CHANGELOG.md`, `server-install/platforms/hetzner/systemd-unit.ts` |

Two things that look like Notes and are **not**, left alone:

- `case 'note':` in `packages/cezar/src/index.ts` is a run-event type in the headless CLI
  printer. Unrelated to the inbox, despite the old spec's W1.1 line claiming the inbox
  would add one.
- The task header's "Notes" panel is the per-run handoff journal
  (`runs/<id>.handoff.md`), a different feature that predates the central hub.

## Phases

1. **Contract** — delete `notes.ts`, its `export *`, the `notes` boolean on
   `capabilitiesSchema`.
2. **Server** — delete the route family and its parity test, unmount from `workspaceV1`,
   drop the capability from `resolveCapabilities`, drop the two path helpers.
3. **Cockpit** — delete the route component, its `<Route>`, its `pageLabel`, the nav item
   and the `notes?` gate on `NavItem`, `notesAvailable` on the app shell, the typed API
   wrappers and query keys.
4. **Tests** — drop every `notes:` line from the capability fixtures rather than flipping
   them to `false`; a fixture key for a capability that no longer exists is how a removal
   silently half-lands.
5. **Docs** — README env row, `.env.example`, the BC scaffold bullet, a CHANGELOG entry,
   the hetzner unit's env list; mark the old spec and the plan superseded in place.

## Data models

`notesPath()` → `~/.cezar/notes.json` and `notesLogPath()` → `~/.cezar/notes-log.ndjson`
are deleted. **No migration, no cleanup pass.** Both were path helpers only: no code in
any released or unreleased build ever opened, created or wrote either file, which the
scaffold docblock states and `git grep` confirms (the only non-test references are two
comments in `notifications/` citing `notesPath()` as a naming precedent — those comments
are repointed at `agentAccountsPath()`, the same precedent one link up the chain).

## API contracts

Removed from `/api/v1`:

```
GET    /workspace/notes
POST   /workspace/notes
GET    /workspace/notes/:noteId
PATCH  /workspace/notes/:noteId
DELETE /workspace/notes/:noteId
POST   /workspace/notes/:noteId/process
POST   /workspace/notes/:noteId/approve
POST   /workspace/notes/:noteId/reject
```

**Measured after removal, not assumed:** these paths answer `404 Not Found`,
`content-type: text/plain`, byte-identical to any `/api/v1/*` path that never existed
(`curl /api/v1/nonexistent-xyz` gives the same). The SPA catch-all does **not** claim them — it
answers non-`/api` URLs only. So the page URL `/notes` still returns `200 text/html` (the client
shell, which then renders its own not-found) while the API family is genuinely gone. An earlier
draft of this spec asserted the API paths fell through to the SPA catch-all; the Verification
E2E disproved it, and this is the corrected text.

Removed from `GET /api/v1/health`: `capabilities.notes`. The remaining keys
(`knowledge`, `sources`, `workspaceViews`, `notify`, `skills`, …) are unchanged in
spelling, value and order.

Removed env var: `CEZ_NOTES`. Setting it now does nothing at all rather than enabling a
placeholder.

## Risks

| Risk | Mitigation |
|---|---|
| Removing the health key breaks the contract-parity / versioned-surface / bc-route-inventory guards | Those suites derive from the app's real route registrations, so they follow the deletion. They are the verification, not a casualty: if any still names `notes` afterwards, the removal is incomplete. |
| `workspaceViews` (F3 feature A) shares a spec file and the `!singleProject` clause with `notes` | Only the `notes:` line leaves `resolveCapabilities`; feature A's line, its route family and its `CEZ_SINGLE_PROJECT` behaviour are untouched, and its own tests stay. |
| A capability fixture keeps `notes: false` and the removal half-lands unnoticed | Phase 4 deletes the keys instead of setting them false, and `git grep -i notes` over `packages/` is part of verification. |
| The old spec keeps reading as queued work | It and the plan are marked superseded **in place**, in the heading, not by appending a note underneath. |
| Upstream later ships its own notes feature and the merge conflicts | Acceptable: upstream has no notes surface today, and a future upstream feature arriving through a merge is a decision to take then, not a reason to keep dead code now. |

## Verification

1. `npm run typecheck` green (contract + client + server + web). This is the load-bearing
   one: the contract module and the health key are removed, so any consumer left behind is
   a type error rather than a silent 404.
2. `npm test` green — in particular `capabilities.test.ts`, `health-forge.test.ts`,
   `contract-parity.*`, `typed-bodies.test.ts`, `route-parity.test.ts`,
   `bc-route-inventory.test.ts`, `versioned-surface.test.ts`, `app-shell.test.tsx`,
   `routes.test.tsx`.
3. `npm run build` green, including the `check:pack` gate.
4. `git grep -in "cez_notes\|notesPath\|notesLogPath\|createNotesRoutes\|getWorkspaceNotes\|NotesRoute"`
   returns nothing outside this spec and the superseded-in-place markers.
5. Runtime E2E on the built server: `GET /api/v1/health` has no `notes` key;
   `GET /api/v1/workspace/notes` no longer answers the scaffold's
   `{"notes":[],"truncated":false}`; the cockpit nav has no Notes item with
   `CEZ_NOTES=1` explicitly set (the strongest single check — the flag being inert is the
   point).

### Results, 2026-08-14

All five executed on this machine, against the built `packages/cezar/dist` served from
`/Users/mw/loki-labs` with `CEZ_NOTES=1` deliberately **set** for the runtime pass.

| # | Result |
|---|---|
| 1 | `npm run typecheck` exit 0. It earned its keep: it caught `command-palette.tsx` still passing `notes` to `visibleNavItems`, a consumer the grep sweep had missed. |
| 2 | `npm test`: 6984 passed, 14 failed in 3 files. **All 14 are pre-existing on clean `main`**, established by stashing this work and re-running: `routes.test.tsx` + `onboarding.test.tsx` fail 13 identically at `9b5f62b8`, and `bc-route-inventory.test.ts` fails on `/api/v1/projects/blank` missing from `BACKWARD_COMPATIBILITY.md`, a route this change never touched. Zero failures attributable to the removal. |
| 3 | `npm run build` exit 0, `check:pack ok — 742 files, 111 under web/dist`. |
| 4 | `git grep` for `CEZ_NOTES` / `notesPath` / `createNotesRoutes` / `getWorkspaceNotes` / `NotesRoute` returns only this spec, the superseded-in-place markers, and the `capabilities.test.ts` negative control. |
| 5 | Health `capabilities` keys are `costMetrics, followups, knowledge, localHandoff, notify, singleProject, skills, sources, tokenMetrics, tokenUsageMetrics, workspaceViews` — no `notes`, with the flag on. `GET /api/v1/workspace/notes` → `404 text/plain`. Control: `GET /api/v1/workspace/runs` → `200` with real rows, so the workspace mount itself is alive and the 404 is about this family alone. Cockpit nav renders Tasks / Git / Knowledge / Skills / Workflows / Settings, no Notes. |

One claim in this spec was **wrong before the E2E ran** and has been corrected above: the API
paths do not fall through to the SPA catch-all, they 404 like any unregistered `/api/v1` path.
