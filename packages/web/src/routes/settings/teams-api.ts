import { getApiBaseUrl } from '@open-mercato/cezar-api-client'
import type {
  CreateTeamInput,
  CreateTeamResponse,
  ListTeamsResponse,
  RenameTeamInput,
  RenameTeamResponse,
  Team,
} from '@open-mercato/cezar-api-client'

import { ApiError } from '@/api/client'

/**
 * `GET /auth/teams` — every team in the caller's own org (`packages/contract/src/orgs.ts`'s own
 * doc comment on `listTeamsResponseSchema`: "open to any signed-in member", unlike the D12
 * create/rename verbs on the same route family). Backs `projects-section.tsx`'s team filter (spec
 * `.ai/specs/2026-08-06-org-team-auth-onboarding.md`, phase 5c, Fill unit "Board/project team
 * filter"): before this, `teamOptions` could only ever list a team that already had a registered
 * project on it, so a freshly-created, still-empty team (D2's own examples, `engineering` /
 * `marketing`) could never appear as something to filter — or reassign a project — TO.
 *
 * **Hand-rolled, not `client.ts`, and duplicated rather than imported from `onboarding-api.ts`.**
 * `/auth/*` is a root-mounted `Hono` app (`auth/routes.ts` family) never chained into the
 * `/api/v1` builder, so it never reaches `AppType` — the same reason `onboarding-api.ts` gives for
 * being hand-rolled itself. This module does not import that one's private helpers (they are not
 * exported, and it is a different Fill unit's file under the 5b/5c/8 scaffold's ownership map) —
 * the ~15 lines below are a deliberate duplicate of its `fetchAuth`/`isJsonResponse`/
 * `parseJsonBody`/`errorMessageFrom` shape, not a drifted reinvention.
 *
 * **The "no `/auth/*` at all" signal is the same one `onboarding-api.ts#probeOnboarding` already
 * established, and reads the same way here.** On a hosted, unauthenticated deployment
 * (`CEZ_ALLOW_UNAUTHENTICATED=1`, D9) — the one topology that mounts no `/auth/*` surface at all —
 * `GET /auth/teams` falls through to the SPA catch-all, which answers every unmatched GET with the
 * built `index.html` — `200 text/html`, never JSON. That is read as "no teams" here rather than as
 * an error: `listOrgTeams` resolves to `[]`, which is exactly the value that already makes
 * `projects-section.tsx`'s filter render nothing (its own `teamOptions` already treats an empty
 * option set as "no filter, not an empty dropdown"). So that invariant holds without a special
 * case at the call site — see that file's own test for the negative control.
 *
 * **This is narrower than "`CEZ_AUTH` unset" since D13 (phase 9, local mode).** The npm
 * zero-config default (loopback, `CEZ_AUTH` unset) now mounts a real, local `/auth/teams` — so a
 * `CEZ_AUTH`-unset deployment answers real JSON here (a genuine, possibly-empty team list, or the
 * local `no organization exists yet` 400 before onboarding), not the SPA shell. See
 * `probeTeams`/`TeamsProbe` below for the client's own read of both those states.
 */

function authUrl(path: string): string {
  return `${getApiBaseUrl()}${path}`
}

function isJsonResponse(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').includes('application/json')
}

function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function errorMessageFrom(status: number, statusText: string, body: unknown): string {
  if (body && typeof body === 'object' && 'error' in body) {
    const error = (body as { error?: unknown }).error
    if (typeof error === 'string') return error
  }
  return `${status} ${statusText || 'request failed'}`.trim()
}

export async function listOrgTeams(signal?: AbortSignal): Promise<Team[]> {
  let res: Response
  try {
    res = await fetch(authUrl('/auth/teams'), { method: 'GET', credentials: 'include', signal })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new ApiError(0, 'cannot reach the cezar server (/auth/teams)', { cause })
  }
  if (!isJsonResponse(res)) {
    // The SPA shell, not `/auth/teams` — drain the body (nothing in it is ours to read) and
    // report the org as carrying no teams rather than trying to interpret HTML as a list.
    await res.text().catch(() => undefined)
    return []
  }
  const body = parseJsonBody(await res.text())
  if (!res.ok || body === undefined) {
    throw new ApiError(res.status, errorMessageFrom(res.status, res.statusText, body))
  }
  return (body as ListTeamsResponse).teams
}

// ---- the Settings → Teams management pane (5c: create/rename) -----------------------------------
//
// `listOrgTeams` above folds "no `/auth/*` mounted" AND "org has zero teams" into the same `[]` —
// exactly right for a SUPPLEMENTARY filter (no data means no filter, either reason), but too lossy
// for the pane that owns "manage your teams": that surface has to tell a genuinely-empty org apart
// from a deployment with no onboarding surface at all, the same way
// `onboarding-api.ts#probeOnboarding` distinguishes `unavailable` from a real state. `probeTeams`
// below is that dedicated probe, kept separate from `listOrgTeams` rather than folded into it —
// same reasoning as this file's own module doc comment ("a deliberate duplicate... not a drifted
// reinvention").

/** The four states `teams-panel.tsx` renders. Mirrors `onboarding-api.ts#OnboardingProbe`'s shape
 *  for `signed-out` and (renamed, see below) `unavailable` — see that file for the exact signal
 *  each one reads off the response.
 *
 *  **`unavailable`, renamed from `auth-off` 2026-08-07 (second adversarial review, FIX C4).** Kept
 *  out of step with `onboarding-api.ts#OnboardingProbe`'s own 2026-08-07 rename — its own module
 *  doc comment already gives the reason: D13 local mode answers real JSON here now, so a kind named
 *  for "auth is off" is actively misleading about which deployments reach it. Renamed to match its
 *  twin rather than left to say a false thing about a state it does still, correctly, describe (the
 *  narrower hosted-unauthenticated topology — see the module doc comment above).
 *
 *  **`no-org`, ADDED 2026-08-07 (FIX C3).** `probeTeams` used to fold this precondition into a
 *  thrown `ApiError`, same as any other non-2xx body — which rendered `teams-panel.tsx`'s generic
 *  `tone="danger"` "Could not load workspaces" card for the ordinary, expected zero-config-default
 *  state (before any org exists, or permanently after a decline): a RED ERROR CARD on the default
 *  deployment mode, where the pre-D13 pane showed a quiet neutral explainer. `team-routes.ts`'s own
 *  `GET /auth/teams` handler answers this precondition with 400, never 401, and — for this specific
 *  parameterless GET — for no other reason (see that file's own doc comment, "D13 invariant 1: no
 *  401 in local mode, ever"), so matching on `res.status === 400` alone is decisive here, not a
 *  guess at an error string. */
export type TeamsProbe =
  | { kind: 'unavailable' }
  | { kind: 'signed-out' }
  | { kind: 'no-org' }
  | { kind: 'ok'; teams: Team[] }

/** Same contract as `onboarding-api.ts#fetchAuth`: credentials always included, and a request that
 *  never reached the server becomes an `ApiError` with status 0 rather than a raw `TypeError`. Not
 *  shared with `listOrgTeams` above (which inlines the same three lines itself) or with
 *  `onboarding-api.ts` (a different Fill unit's file) — see this file's own module doc comment on
 *  why duplication, not a shared helper, is the deliberate choice here. */
async function fetchAuth(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(authUrl(path), { ...init, credentials: 'include' })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new ApiError(0, `cannot reach the cezar server (${path})`, { cause })
  }
}

/** `GET /auth/teams`, read as a `TeamsProbe` rather than folded into `[]` — see this section's own
 *  module comment for why the management pane needs the extra states `listOrgTeams` collapses. */
export async function probeTeams(signal?: AbortSignal): Promise<TeamsProbe> {
  const res = await fetchAuth('/auth/teams', { method: 'GET', signal })
  if (!isJsonResponse(res)) {
    // The SPA shell, not `/auth/teams` — drain the body (nothing in it is ours to read) and
    // report the deployment as carrying no onboarding surface rather than trying to interpret
    // HTML as a team list.
    await res.text().catch(() => undefined)
    return { kind: 'unavailable' }
  }
  const body = parseJsonBody(await res.text())
  if (res.status === 401) return { kind: 'signed-out' }
  // FIX C3: the local "no organization exists yet" precondition (D13, `team-routes.ts`'s own D13
  // branch) — a genuine, expected state, never an error. See `TeamsProbe`'s own doc comment for
  // why matching on the status code alone is decisive for this route.
  if (res.status === 400) return { kind: 'no-org' }
  if (!res.ok || body === undefined) {
    throw new ApiError(res.status, errorMessageFrom(res.status, res.statusText, body))
  }
  return { kind: 'ok', teams: (body as ListTeamsResponse).teams }
}

async function sendJson<T>(path: string, method: string, json: unknown): Promise<T> {
  const res = await fetchAuth(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(json),
  })
  const body = parseJsonBody(await res.text())
  if (!res.ok) throw new ApiError(res.status, errorMessageFrom(res.status, res.statusText, body))
  if (body === undefined) {
    throw new ApiError(res.status, `the cezar server answered ${path} with a non-JSON body`)
  }
  return body as T
}

/** `POST /auth/teams` — D12 admin action: create a new team in the caller's own org. A non-admin
 *  member gets the server's 403 verbatim (`require-org-admin.ts`), surfaced by the caller. */
export function createTeam(input: CreateTeamInput): Promise<CreateTeamResponse> {
  return sendJson('/auth/teams', 'POST', input)
}

/** `PATCH /auth/teams/:teamId` — D12 admin action: rename any team in the caller's own org (unlike
 *  `onboarding-api.ts#renameOnboardingTeam`, which only ever reaches the caller's own first team). */
export function renameTeam(teamId: string, input: RenameTeamInput): Promise<RenameTeamResponse> {
  return sendJson(`/auth/teams/${encodeURIComponent(teamId)}`, 'PATCH', input)
}
