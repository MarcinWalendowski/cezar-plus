# Project PATCH drops tags; four tests pin reversed decisions

Status: **Implemented.**

## TLDR

The suite was red in five files, 24 failures. Sorting them by cause:

- **One real product bug.** `updateProject` in the web client sent a hand-listed
  `{maxParallel?, teamId?}` body. `tags` was added to the contract and the route on 2026-08-10 and
  never added to that list, so **every tag edit PATCHed an empty body** — the tag appeared
  optimistically and vanished a beat later.
- **Four stale tests**, each pinning a decision the repo had since reversed: an empty PATCH body as
  a 200 no-op (a later `.refine` made it a 400), and three onboarding/routing expectations left
  behind by D15 (2026-08-07).
- **One unhandled rejection** in `AddProjectDialog`, surfaced by fixing the tests around it.

## Problem

### 1 — the whitelist that stopped tracking the contract

```ts
json: {
  ...(input.maxParallel !== undefined ? { maxParallel: input.maxParallel } : {}),
  ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
}
```

That list existed for a reason, and the reason had expired. It was written to dodge a `?? null`
trap back when `$patch`'s typed `json` still required the narrower pre-`teamId`
`{maxParallel: number | null}`, where an unqualified `input.maxParallel ?? null` would have CLEARED
a project's concurrency override on every team-only reassignment.

Then `31e48bed` (global Tasks + repository tags) added `tags` to `updateProjectInputSchema` and to
the route. The client kept sending two keys. The consequence is the nastiest shape a dropped field
takes: the server received a body naming nothing, left the project untouched, and answered **200
with the unchanged project**. `onSuccess` replaced the optimistic row with that answer, so the UI
showed the new tag for one frame and then took it away — with no error anywhere, on either side.

A hand-maintained whitelist over a contract that grows will drift again; the layer above
(`useUpdateProject`) had already learned this and forwards its variables whole, with a comment
saying why.

### 2 — tests pinning decisions that were later reversed

| Test | Pinned | Reversed by |
|---|---|---|
| `projects-api.test.ts` — "an empty body is a no-op — 200" | `{}` is accepted | `31e48bed`'s `.refine` requiring one of `maxParallel` / `tags` / `teamId` → 400 |
| `onboarding.test.tsx` — `"Skip for now" leaves without registering a project` | a button D15 deleted | D15 (2026-08-07): "there is no way past this screen that does not create a project, which is the point" |
| `onboarding.test.tsx` — `Add project` button label | a label D15 renamed | D15's three affordances: Create blank / Open local folder / Import from GitHub |
| `routes.test.tsx` — every bare-root case | that `/` resolves without the onboarding probe | D15 made `LegacyPathRedirect` **wait** for the probe (two authorities used to race on `/`) |

The last one is the interesting failure. `routes.test.tsx` stubs `fetch` to a promise that never
resolves, so an unseeded probe never settles and every bare-root case parks on `scope-resolving`
forever. The tests were not wrong about routing; they were missing a fixture that the route began
requiring.

**A test that pins a deleted behaviour is worse than no test**: it reads as current, and it is what
the next session reads first.

### 3 — the unhandled rejection

`AddProjectDialog`'s confirm button is `onClick={() => void add()}`, and `void` discards a promise
without handling it. `register.mutateAsync` rejects on a real refusal (a home directory, a
cross-org root), so a refused folder threw an unhandled rejection into the page — and a "this may
cause false positive tests" error into the suite.

## Solution

### D1 — forward the body whole

`json: input`. `undefined` values disappear in JSON serialization, which is exactly the route's
"absent means untouched" contract, and the typed `json` is inferred from `server.ts`'s own
validator (`app-type.ts`), so a field the route does not accept **cannot compile**. The compiler
now enforces what the whitelist was maintaining by hand. The original `?? null` hazard is gone with
it: nothing here rebuilds a key it was not given.

### D2 — correct the stale tests in place, toward the later decision

Each of the four keeps the decision that won and says, in the test, what it used to claim and which
change reversed it — `CORRECTED 2026-08-14` / `REPLACED 2026-08-14` lead-ins with the commit or
decision named. None was deleted: a deleted test leaves no trace that the behaviour was ever
considered.

Two are strengthened rather than merely flipped:

- The empty-body test becomes `a body naming nothing is refused — 400, and the registration is
  untouched`, and the half of the original claim worth keeping — *a body silent about `teamId` must
  not attempt a team write* — moves to its own test on `{maxParallel: 3}`, which is where it was
  always the more interesting assertion. An empty body never reaches the write at all.
- The "Skip for now" test becomes `offers three ways to create a project and no way past without
  one (D15)`, asserting the three real affordances **by name** plus the absence of four plausible
  escape hatches. A negative-only assertion would stay green if the whole step stopped rendering.

### D3 — seed the onboarding probe with an answer that still runs the predicate

`routes.test.tsx` gets an `ONBOARDING_READY` fixture (`kind: 'ready'`, `hasProjects: true`) applied
by default, and an `onboarding` option on `renderAt` to opt out.

`ready` + `hasProjects: true` deliberately, **not** the simpler `unavailable`: `unavailable` never
gates by construction, so it would keep these tests green even if `needsOnboardingGate` started
gating an onboarded install. The seed runs the real predicate.

The `OnboardingEntryGate` block is the one place that must *not* take the default — those tests are
about the probe's live answer — so every `renderAt` in it passes `PROBE_LIVE = { onboarding: null }`.
Without that, the assertions would be about the fixture instead of about the gate.

### D4 — catch at the call site that discards

`await register.mutateAsync(...)` in a `try` with `return` on failure. Nothing is swallowed:
`register.isError` renders the server's message verbatim below, which is the entire error surface
this flow ever had.

## Architecture

```
packages/web/src/api/client.ts                          D1
packages/cezar/src/server/projects-api.test.ts          D2
packages/web/src/routes/onboarding/onboarding.test.tsx  D2
packages/web/src/routes.test.tsx                        D2, D3
packages/web/src/components/add-project-dialog.tsx      D4
```

## Data Models

None.

## API Contracts

None changed. D1 makes the client send the contract that already existed.

## Phases

Single change; no phasing.

## Risks

- **D1 widens what the client can send** from two keys to whatever the contract accepts. That is
  the intent, and the bound is the shared validator rather than this function's imagination.
- **The four corrections lock in D15 and `31e48bed`.** If either is itself reversed later, these
  tests are where it will show up — which is what they are for.

## Verification

`npm run typecheck` clean. `npm test` — **422 files, 7840 tests, all passing**, from 24 failing
across 5 files.

The tag bug's own guard is the corrected `projects-api.test.ts` pair plus the contract's typed
`json`: the whitelist cannot silently fall behind again, because a body the route accepts and the
client omits is now a type error at the call site rather than a runtime no-op.

Runtime: not separately exercised — the tag round trip is what the corrected suite covers, and the
rendering session's own cockpit run exercised the project rows these calls write. Editing a tag by
hand in the running app remains part of the owner's QA pass.
