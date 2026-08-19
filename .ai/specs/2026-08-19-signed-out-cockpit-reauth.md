# A signed-out cockpit must force re-login, not render empty

**Status:** Implemented (2026-08-19)
**Owner:** Marcin Walendowski
**Related:** `2026-08-06-org-team-auth-onboarding.md` (D14/D15 — the onboarding gate this
corrects; D1's topology table; D6's cookie session)

## TLDR

Clearing site data on `cockpit.example.com` leaves the open tab **looking signed in and showing
nothing** — no tasks, no git, no knowledge — instead of sending the user to sign in. Owner,
2026-08-19: *"if I clear application/website data I'm still in cezar, but I can't see any tasks,
git, etc. I should be always enforced to relogin there."*

Two independent causes produce that one symptom, and each is sufficient on its own: cezar's own
onboarding gate deliberately does **not** gate on `signed-out`, and the Cloudflare Access edge
answers a **cross-origin 302** that the SPA's `fetch` chases into a CORS failure and reports as
*"cannot reach the cezar server"*. This spec fixes both, routing them into one mechanism: any
answer meaning "you have no session" navigates the document to `/auth/login`, with no click.

## Problem

### Cause 1 — cezar serves its whole cockpit to an unauthenticated caller

Probed on the production box against the app directly, no cookie, bypassing Access entirely
(`curl -H 'Host: cockpit.example.com' http://127.0.0.1:4321/…`, 2026-08-19):

| request | answer |
| --- | --- |
| `GET /` | **200 `text/html`** — the full SPA shell |
| `GET /api/v1/health` | **200**, project list redacted to `[]` |
| `GET /api/v1/todos` | **401** `{"error":"unauthenticated"}` |
| `GET /auth/onboarding` | **401** `{"error":"unauthenticated"}` |

`server.ts`'s `requirePrincipal` is doing its job — every `/api/*` route refuses. But the shell
is static and unguarded, and the 401 on `/auth/onboarding` becomes probe kind `signed-out`
(`onboarding-api.ts#probeOnboarding`), for which `needsOnboardingGate`
(`onboarding-gate.ts`) **returns `false`**. So the chrome renders in full, every query 401s,
and the user gets a cockpit that looks logged in and is empty. Nothing anywhere in that path
offers a way to sign in.

The rule that produced it is **D15** of `2026-08-06-org-team-auth-onboarding.md`:

> *"`unavailable` must never gate (it would brick the hosted + `CEZ_AUTH` unset +
> `CEZ_ALLOW_UNAUTHENTICATED=1` topology behind a wizard that deployment can never satisfy), and
> neither may `signed-out` or `needs-invite`."*

`unavailable`'s exclusion is argued in full. **`signed-out` was given no argument at all** — it
was carried along in the same sentence. It does not belong there, and the boot wiring is what
proves it. `signed-out` requires `/auth/onboarding` to answer a **JSON 401**, and `index.ts`
can only produce that from one of its three branches:

| boot branch (`packages/cezar/src/index.ts`) | `/auth/onboarding` answers | probe kind |
| --- | --- | --- |
| `supervisor`, and hosted + `CEZ_ALLOW_UNAUTHENTICATED=1` — no `/auth/*` mounted | SPA catch-all HTML | `unavailable` |
| local mode (`buildLocalModeRoutes`) — `onboardingRoutes` only | `needs-org` / `ready`, **never 401** (D13 invariant 1: "no 401 in local mode, ever") | never `signed-out` |
| `oidc` / `google` — sets `authRoutes` **and** `onboardingRoutes` together | 401 when there is no session | `signed-out` |

So **`signed-out` implies `/auth/login` is mounted.** Gating on it is always satisfiable and
cannot brick a topology — which is the entire hazard D14/D15 excluded `unavailable` for. The
two states are not alike, and treating them alike is what shipped the bug.

### Cause 2 — the Access edge answers a cross-origin redirect, read by the SPA as "server down"

`cockpit.example.com` sits behind a self-hosted Cloudflare Access app. With the cookie cleared,
**every** path — including `/` and the CORS-open `/api/v1/health` — answers (observed
2026-08-19; adding `Origin` + `Sec-Fetch-Mode: cors` changes nothing but the CORS headers):

```
HTTP/2 302
location: https://example.cloudflareaccess.com/cdn-cgi/access/login/cockpit.example.com?…
www-authenticate: Cloudflare-Access resource_metadata="…"
```

A page **reload** therefore does force re-login correctly, which is why this never showed up as
a security hole. But the already-open tab never reloads. `client.ts#fetchOrThrow` uses fetch's
default `redirect: 'follow'`, so the request chases that 302 to another origin, CORS rejects the
final response, and the resulting `TypeError` is converted to
`ApiError(0, 'cannot reach the cezar server')`.

**The app reports "the server is unreachable" for what is actually "you are signed out."** It
keeps the shell mounted and waits for a server that is answering fine.

The two causes are independent: fixing only Cause 1 leaves the reported tab broken (the probe
never gets a 401 to read — Access ate it first), and fixing only Cause 2 leaves any cezar
deployment *not* behind Access serving an empty cockpit to strangers.

## Solution

One predicate — *does this answer mean I have no session?* — and one action — *navigate the
document to `/auth/login`*. Both causes feed the same predicate.

**Auto-redirect, no click** (owner's choice, asked explicitly, 2026-08-19). The loop risk was
named at the time: an IdP that returns without minting a session would bounce
`/ → /auth/login → / → …` forever. The zero-click path is exactly as chosen; a **one-shot guard**
keeps a broken IdP legible — a *second* signed-out answer within 30 s of an auto-redirect
renders the sign-in screen with a button instead of navigating again.

## Architecture

```
  Cloudflare Access 302 (cross-origin)          cezar requirePrincipal 401
              │                                            │
   redirect:'manual' → opaqueredirect                       │
              │                                            │
              ▼                                            ▼
        ApiError{ status:0, identityGate:true }   ApiError{ status:401 }
              └──────────────┬─────────────────────────────┘
                             ▼
                    isSignedOutError()          ← lib/reauth.ts
                             │
        ┌────────────────────┴────────────────────┐
        ▼                                          ▼
  QueryCache/MutationCache onError        needsOnboardingGate('signed-out')
  (every query + mutation)                → chromeless shell → /onboarding
        │                                          │
        └──────────────► forceReauth() ◄───────────┘
                             │
              guard fired? ──┴── no → window.location.assign('/auth/login')
                             │
                            yes → render SignInStep (button)
```

Two entry points, one exit. The `QueryCache`/`MutationCache` listener is what makes this cover
every request in the cockpit rather than the handful anyone thought to enumerate — the same
"a library default beats a hand-rolled mechanism, because it also covers the cases nobody
wrote" rule the corpus already records for the Grocey TanStack port (SPEC-504).

## Phases

1. **`lib/reauth.ts`** — `isSignedOutError`, `forceReauth`, `reauthSuppressed`, and the guard.
2. **`api/client.ts`** — `redirect: 'manual'`; `opaqueredirect` becomes `ApiError.identityGate`.
   Same two lines in the three hand-rolled `/auth/*` probes that bypass `fetchOrThrow`.
3. **`api/query-client.ts`** — one `QueryCache` + `MutationCache` `onError` listener.
4. **`onboarding-gate.ts`** — `needsOnboardingGate` gates on `signed-out`.
5. **`onboarding.tsx`** — `SignInStep` calls `forceReauth()` on mount; the button is the
   guard-suppressed fallback.
6. **D15 corrected in place** in `2026-08-06-org-team-auth-onboarding.md`.

## Data Models

No server change, no schema change, no migration. `ApiError` gains one optional boolean:

```ts
class ApiError extends Error {
  readonly status: number
  /** The identity gate answered instead of the server — an Access/SSO redirect a fetch may
   *  not follow. Status is 0: the request never reached cezar. */
  readonly identityGate?: boolean
}
```

`sessionStorage['cezar:reauth-at']` holds one `Date.now()` stamp. Deliberately **session**
storage: it must not outlive the tab, and clearing site data (the reported action) wipes it,
which is correct — that is a first redirect, not a repeat.

## API Contracts

Unchanged. `GET /auth/login` (302 to the IdP) and the `401 {"error":"unauthenticated"}` contract
on `/api/*` and `/auth/onboarding` already exist and are what this reads.

## Risks

- **Redirect loop** — accepted by the owner, bounded by the 30 s one-shot guard. The guard must
  *expire*, not latch, or a single blip would strand the tab on the button forever; test 5 pins
  both directions.
- **`redirect: 'manual'` breaking a legitimate 3xx.** Checked by inspection: the only
  `c.redirect(...)` calls in the entire server are `/auth/login` and `/auth/callback`
  (`auth/routes.ts`), both reached by top-level `<a href>` navigation and never by fetch. No
  `/api/*` route answers 3xx.
- **Misfiring in local mode** (`npx cezar`, the most common deployment) would be the worst
  outcome — a redirect to a `/auth/login` that is not mounted. It cannot happen: with auth off
  `/api/*` resolves an implicit principal and never 401s, and the `/auth/*` probes turn their
  own 401 into a `signed-out` **result** rather than a thrown error. Test 4's negative controls
  hold the line.
- **`needs-invite` is untouched** and still does not gate. That user *has* a session, so it is a
  different problem (a cockpit authorized but membership-less) and D8's invite-redemption screen
  is still unbuilt. Named here so the omission is deliberate rather than overlooked.

## Verification

Automated — `npm run typecheck` and `npm test` from `cezar/`:

| # | test | fails before the fix because | negative control |
| --- | --- | --- | --- |
| 1 | `onboarding-gate`: `signed-out` gates | the predicate returns `false` | `unavailable`, `needs-invite`, `ready`+`hasProjects`, `undefined` still do **not** gate |
| 2 | `app-shell-container`: the existing **`'signed-out never gates'`** case, inverted — chromeless, no sidebar | it currently pins the bug | the neighbouring `unavailable` case stays green, unedited |
| 3 | `client`: an `opaqueredirect` → `ApiError` with `identityGate` | it is returned as a falsy-`ok` response and read as a body | a 200 and a real 500 are untouched |
| 4 | `reauth`: 401 → `location.assign('/auth/login')`, once | no such module | 403 / 404 / 500 / `ApiError(0)` **without** `identityGate` / a plain `Error` must not navigate |
| 5 | `reauth`: a second signed-out within 30 s does not navigate, `reauthSuppressed()` is true | — | after 30 s it navigates again — the guard expires, never latches |

Runtime E2E on production, after deploy — **required before this is Done**:

- **Cause 1** — with a live Access session, delete only cezar's own session cookie and reload:
  must land on `/auth/login`, not on an empty cockpit.
- **Cause 2, the report verbatim** — open `cockpit.example.com`, clear application/website data
  in DevTools, **do not reload**, wait for the next query: the tab must navigate to the
  Access/IdP login by itself.
- Sign in again: cockpit returns with tasks, git and knowledge intact.
