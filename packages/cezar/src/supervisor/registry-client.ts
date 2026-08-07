import type { ProjectTeam, Team } from '../auth/types.ts';

/**
 * D4's root→org registry, reached over HTTP (D10, phase 6/7 fill unit 5 — "root-org-registry").
 *
 * Phase 5 enforced "one project root, one org" by opening `IdentityStore.open(identityDir())`
 * IN-PROCESS at four call sites in `server/server.ts` (`withTeams`, `mayActOnRoot`,
 * `releaseRootClaim`, and `registerFolder`'s claim block). D4's amendment 2 says phase 6 "must
 * REPLACE the check, not merely join it": once each org gets its own `CEZ_HOME` (D4), an org
 * process's local `identityDir()` holds no `identity/` directory at all — under D10, "the
 * supervisor terminates auth and is the only process that ever opens
 * `<CEZ_HOME>/identity/*.json`". Opening `IdentityStore` locally from an org process would not
 * error, it would silently start a SECOND, empty `project_teams` table — reinstating exactly the
 * "two orgs both think they own this root" / `RunStore`-has-no-lease history loss D4 exists to
 * prevent, with every gate green.
 *
 * This module is the org process's side of that replacement: everywhere `server.ts` used to call
 * `IdentityStore` directly, it now asks the ONE authoritative registry — the supervisor's own
 * `IdentityStore`, reached over its loopback HTTP surface — through the client built here. Same
 * method names as `IdentityStore#{listProjectTeams,listTeams,getTeamById,getProjectTeam,
 * createProjectTeam,updateProjectTeam,deleteProjectTeam}`, wrapped `async` (an HTTP round trip can never be
 * synchronous, unlike the local store's zero-cache disk reads) so `server/server.ts`'s
 * `openProjectTeamRegistry()` seam can swap this in for the local implementation without either
 * call site knowing which one it got.
 *
 * ## The wire contract (CORRECTED 2026-08-07 against `supervisor/server.ts`'s actual routes)
 *
 * This section originally specified a contract for unit 1's `supervisor/server.ts` to implement,
 * written before that file existed. It now exists, and reading it found real drift: a client
 * built against a spec nobody re-checked against the landed handler is exactly the "two literals
 * hand-kept in sync, and nothing asserted they matched" shape D3's own history names (`server.ts`'s
 * old `LOCAL_PRINCIPAL` vs. `auth/principal.ts`'s `LOCAL_IDENTITY`) — reproduced here one layer up,
 * across a process boundary instead of across two files in one process. The methods below are now
 * corrected to match what `supervisor/server.ts` actually does; two gaps remain on THAT file's side
 * (not this one's to fix — `supervisor/server.ts` is unit 1's, not unit 5's) and are called out
 * where they bite, below the table.
 *
 * **Auth.** Every request carries `Authorization: Bearer <CEZ_SUPERVISOR_SECRET>` — the SAME
 * per-org secret `forwarded-principal.ts` signs with (`OrgProcessRecord#supervisorSecret`,
 * `supervisor/org-process-registry.ts`). The supervisor resolves the secret to a calling org by
 * reverse lookup (timing-safe compare against every ACTIVE record's `supervisorSecret`) rather
 * than trusting an org id the client names — the secret both authenticates the caller and answers
 * "which org is this", so a caller can never claim to be a different org than the one whose
 * secret it holds. A secret matching no active org answers 401.
 *
 * **Org-scoped reads must be checked against the secret-derived org.** `GET /internal/project-teams`
 * and `GET /internal/teams` both accept an `orgId` query param (matching how `withTeams`/
 * `registerFolder` already call the local store with the caller's OWN `principal.orgId`) — the
 * supervisor MUST refuse (403) if that param does not equal the org the bearer secret resolved
 * to, or one org could enumerate another's full team list / project claims across the network
 * boundary the in-process call never had to cross. `POST /internal/project-teams`'s body `orgId`
 * needs the identical check for the identical reason — it is the actual D4 write.
 *
 * **CORRECTED 2026-08-07 (5b/5c/8 repair stage): root-keyed lookups ARE org-scoped, and the
 * paragraph below is false as of this change.** It said `GET`/`DELETE .../by-root` are gated by
 * authentication alone because "`mayActOnRoot` needs to see ANOTHER org's claim to correctly refuse
 * a cross-org write". `DELETE` had already been tightened at the phase-6/7 repair stage (see that
 * route's own comment: holding org B's secret and calling it destroyed org A's claim); `GET` had
 * not, which left it the one unscoped verb in the family — org A's secret read org B's `orgId` and
 * `teamId` off org B's root, 200, while every sibling answered 403. It now calls
 * `callerMayUseOrgId` on the EXISTING row's `orgId` too.
 *
 * The premise about `mayActOnRoot` still holds and is satisfied differently: a foreign claim now
 * arrives as a 403, `call()` below turns that into `RegistryClientError('unauthorized')`, and
 * `mayActOnRoot`'s fail-CLOSED `catch` answers `false` — the same refusal, produced by the
 * supervisor rather than by a client-side org-id comparison. Nothing in `server.ts` changed; the
 * refusal moved to the side of the boundary that can actually enforce it.
 *
 * The original paragraph follows unchanged:
 *
 * **Root-keyed lookups are intentionally NOT org-scoped**, mirroring `IdentityStore#getProjectTeam`
 * /`#deleteProjectTeam`'s own contract exactly: "does this root belong to anyone, and to whom" (or
 * "release whatever claim this root has") has never been scoped to the caller's own org in-process
 * — `mayActOnRoot` needs to see ANOTHER org's claim to correctly refuse a cross-org write. Only
 * authentication (a valid secret for *some* active org) gates these two.
 *
 * | Method | Path | Auth-checked against | Request | Response |
 * |---|---|---|---|---|
 * | GET | `/internal/project-teams?orgId=&teamId=` | `orgId` must equal secret's org | — | `{ projectTeams: ProjectTeam[] }` |
 * | GET | `/internal/project-teams/by-root?root=` (root = `encodeURIComponent`, a query param — NOT a path segment) | checked against the EXISTING row's `orgId` (TIGHTENED 2026-08-07 — was "any active org") | — | `{ projectTeam: ProjectTeam }` on 200; **404** (not a `null` body) when the root is unclaimed; **403** when it is claimed by a DIFFERENT org, which `call()` raises as `unauthorized` and `mayActOnRoot` fails closed on |
 * | POST | `/internal/project-teams` | body `orgId` must equal secret's org | `{ projectRoot, orgId, teamId }` | success: `{ projectTeam }` at 201. failure: `{ error, code }` at 404/409 |
 * | PATCH | `/internal/project-teams` (5c, Fill unit 3, ADDED 2026-08-07) | checked against the EXISTING row's `orgId`, never a body-supplied one — mirrors `DELETE /internal/project-teams/by-root`'s own posture exactly (the reassignment can never smuggle a root across the D4 boundary, since there is no `orgId` field on the wire for it to smuggle THROUGH) | `{ projectRoot, teamId }` — no `orgId`, deliberately, matching `IdentityStore#updateProjectTeam`'s own signature | success: `{ projectTeam }` at 200. failure: `{ error, code }` at 404 (`project-root-not-found`/`team-not-found`) or 409 (`team-org-mismatch`) |
 * | DELETE | `/internal/project-teams/by-root?root=` | any active org (authorization already happened via a prior `mayActOnRoot` round trip — see that function's own comment in `server.ts`) | — | `{ released: boolean }` |
 * | GET | `/internal/teams?orgId=` | `orgId` must equal secret's org | — | `{ teams: Team[] }` |
 * | GET | `/internal/teams/:teamId` | any active org (client re-checks `team.orgId` itself, matching `IdentityStore#getTeamById`'s own unscoped contract) | — | `{ team: Team \| null }` |
 *
 * `root` travels as a query parameter (`?root=<encodeURIComponent>`), matching
 * `supervisor/server.ts`'s actual `rootQuerySchema` — not a path segment as originally drafted here
 * (a percent-encoded `/` inside a path segment is a well-known router/proxy footgun; a query param
 * sidesteps it entirely, and it is what got built and tested in `supervisor/server.test.ts` against a
 * real `Hono` app, not a mock). The realpath normalization D4 depends on
 * (`IdentityStore#createProjectTeam`'s own `realpathSync.native`) happens on the SUPERVISOR side,
 * unchanged, exactly as it does today for the in-process caller — this client passes through
 * whatever root string `server.ts` already resolved (its four call sites already pass an
 * already-`normalizeRoot`'d value, per `workspace/projects.ts`'s own registration path), reusing
 * phase 4-5's normalization rather than adding a second one, per this task's own instruction.
 *
 * **The two gaps this comment used to name are CLOSED (2026-08-07, integration pass).** Both were
 * in `supervisor/server.ts`, which this unit could not edit, and both are now implemented there
 * with the exact shapes the table above already specified:
 *
 * 1. **`/internal/teams` and `/internal/teams/:teamId` now exist.** Until they did, `listTeams`/
 *    `getTeamById` below threw `RegistryClientError('unexpected', …)` against a real supervisor —
 *    which `server.ts#withTeams` swallowed (so D5's team filter on the project board was silently
 *    dead in supervisor mode, showing every project unannotated) and `server.ts#registerFolder`
 *    did NOT (an uncaught 500 for any supervisor-mode registration naming an explicit `teamId`).
 * 2. **`POST /internal/project-teams` now sends `code` alongside `error`.** Two
 *    `IdentityStoreError` codes map onto 404 and two onto 409, so the status alone cannot carry the
 *    discriminant; this client still trusts ONLY the `code` field and never guesses from the
 *    status, but the field is now actually sent, so `registerFolder`'s `project-root-taken ⇒ 409`
 *    branch is reachable instead of collapsing into a thrown `unexpected`.
 *
 * **A real gap that remains, and is NOT this module's to close** — `supervisor/server.ts` reads no
 * `Authorization` header at all, so every `Bearer` this client sends is ignored and the whole
 * `/internal/*` surface is reachable unauthenticated by any local process on the box. The
 * "Auth"/"Org-scoped reads" paragraphs above therefore describe the contract this client HOLDS UP
 * and the supervisor does not yet enforce. See the integration pass's report; closing it is a
 * design change (secret→org reverse lookup, and a bootstrap answer for the installer's very first
 * `POST /internal/org-processes`, which by definition holds no secret yet), not a wiring fix.
 *
 * ## Failure posture
 *
 * Every method THROWS `RegistryClientError` on anything other than a well-formed, authorized
 * response — unlike `IdentityStore`'s read methods, which contractually never throw. This is
 * deliberate, not an oversight: `IdentityStore`'s "reads never throw" guarantee is a LOCAL-DISK
 * property (a read either finds the file or treats it as empty), and nothing about a network call
 * can honestly make that same promise. Rather than silently degrading a network failure to
 * `undefined`/`[]` inside this client — which would make `mayActOnRoot` read an unreachable
 * supervisor as "unclaimed, anyone may act", exactly the fail-OPEN shape D4 exists to prevent —
 * failure handling is left to each of `server.ts`'s four call sites, which already differ in how
 * much a failure should cost (`withTeams` is best-effort annotation and degrades; `mayActOnRoot`
 * is the D4 boundary itself and must fail CLOSED).
 */

export type RegistryClientErrorCode =
  | 'not-configured' // CEZ_SUPERVISOR_PORT / CEZ_SUPERVISOR_SECRET missing under CEZ_AUTH=supervisor
  | 'unreachable' // network error, timeout, connection refused
  | 'unauthorized' // the supervisor rejected this org process's bearer secret (401/403)
  | 'unexpected'; // any other non-2xx status, or a response that does not match the contract above

export class RegistryClientError extends Error {
  constructor(
    readonly code: RegistryClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RegistryClientError';
  }
}

/** Mirrors `IdentityStoreError`'s codes for exactly the checks `createProjectTeam` performs — see
 *  that method's own doc comment in `auth/identity-store.ts`. Not the full `IdentityStoreErrorCode`
 *  union: this client only ever needs the subset ONE remote call can raise. */
export type CreateProjectTeamErrorCode = 'org-not-found' | 'team-not-found' | 'team-org-mismatch' | 'project-root-taken';

export type CreateProjectTeamResult =
  | { readonly ok: true; readonly projectTeam: ProjectTeam }
  | { readonly ok: false; readonly code: CreateProjectTeamErrorCode };

/** Mirrors `IdentityStoreError`'s codes for exactly the checks `updateProjectTeam` performs (5c,
 *  ADDED 2026-08-07, Fill unit 3) — see that method's own doc comment in `auth/identity-store.ts`.
 *  Not `org-not-found`: this reassigns an EXISTING claim, so the org half of the check is always
 *  "does the target team belong to the row's own org" (`team-org-mismatch`), never "does the org
 *  exist at all". */
export type UpdateProjectTeamErrorCode = 'project-root-not-found' | 'team-not-found' | 'team-org-mismatch';

export type UpdateProjectTeamResult =
  | { readonly ok: true; readonly projectTeam: ProjectTeam }
  | { readonly ok: false; readonly code: UpdateProjectTeamErrorCode };

/** The seam `server/server.ts#openProjectTeamRegistry` swaps this client into — every method the
 *  local `IdentityStore` wrapper also implements, async on both sides so either can be handed to
 *  the same four call sites without them knowing which one they got. */
export interface ProjectTeamRegistryClient {
  listProjectTeams(filter: { orgId?: string; teamId?: string }): Promise<ProjectTeam[]>;
  listTeams(orgId: string): Promise<Team[]>;
  getTeamById(teamId: string): Promise<Team | undefined>;
  getProjectTeam(root: string): Promise<ProjectTeam | undefined>;
  createProjectTeam(input: { projectRoot: string; orgId: string; teamId: string }): Promise<CreateProjectTeamResult>;
  /** 5c, ADDED 2026-08-07 (Fill unit 3) — reassign an already-claimed root to a different team in
   *  the SAME org. Takes NO `orgId`: mirrors `IdentityStore#updateProjectTeam`'s own signature
   *  exactly (see that method's doc comment on why — the D4 guard is checked against the EXISTING
   *  row's org, never a caller-supplied one, so a reassignment can never smuggle a root across the
   *  process boundary). */
  updateProjectTeam(root: string, teamId: string): Promise<UpdateProjectTeamResult>;
  deleteProjectTeam(root: string): Promise<boolean>;
}

export interface RegistryClientOptions {
  /** Defaults to `process.env.CEZ_SUPERVISOR_PORT`. The supervisor is always loopback, same host
   *  (D4/D10 — every org unit and the supervisor unit run on the SAME box; nginx's own generated
   *  config reaches the supervisor the identical way, `http://127.0.0.1:<supervisorPort>`, see
   *  `server-install/platforms/hetzner/nginx.ts`), so a bare port is the whole address. */
  port?: string;
  /** Defaults to `process.env.CEZ_SUPERVISOR_SECRET`. */
  secret?: string;
  /** Injectable for tests — never a live HTTP server per this task's safety rules. Defaults to the
   *  global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. 5s: long enough that ordinary supervisor load never trips it, short
   *  enough that `mayActOnRoot`'s fail-closed 409 (see `server.ts`) does not hang a caller's
   *  request indefinitely behind a wedged supervisor. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

interface CallOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
}

/**
 * Builds the client. Throws `RegistryClientError('not-configured', …)` IMMEDIATELY, not on first
 * call, if the port or secret is missing — `CEZ_AUTH=supervisor` with neither set is a
 * misconfigured org process, and failing at construction (inside `server.ts`'s
 * `openProjectTeamRegistry`, itself only reached once a session principal already exists) is a
 * clearer signal than a request that mysteriously 500s deep inside a fetch call.
 */
export function openRegistryClient(options: RegistryClientOptions = {}): ProjectTeamRegistryClient {
  const port = options.port ?? process.env.CEZ_SUPERVISOR_PORT;
  const secret = options.secret ?? process.env.CEZ_SUPERVISOR_SECRET;
  if (!port || !secret) {
    throw new RegistryClientError(
      'not-configured',
      'CEZ_AUTH=supervisor requires CEZ_SUPERVISOR_PORT and CEZ_SUPERVISOR_SECRET, and at least one is unset',
    );
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const call = async ({ method, path, body }: CallOptions): Promise<Response> => {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${secret}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new RegistryClientError(
        'unreachable',
        `could not reach the supervisor at ${baseUrl}${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new RegistryClientError('unauthorized', `supervisor rejected this org process's credentials (${res.status}) calling ${method} ${path}`);
    }
    return res;
  };

  const encodeRoot = (root: string): string => encodeURIComponent(root);

  return {
    async listProjectTeams(filter) {
      const params = new URLSearchParams();
      if (filter.orgId !== undefined) params.set('orgId', filter.orgId);
      if (filter.teamId !== undefined) params.set('teamId', filter.teamId);
      const res = await call({ method: 'GET', path: `/internal/project-teams?${params.toString()}` });
      if (!res.ok) throw new RegistryClientError('unexpected', `GET /internal/project-teams answered ${res.status}`);
      const body = (await res.json().catch(() => null)) as { projectTeams?: unknown } | null;
      if (!body || !Array.isArray(body.projectTeams)) {
        throw new RegistryClientError('unexpected', 'GET /internal/project-teams answered a malformed body');
      }
      return body.projectTeams as ProjectTeam[];
    },

    async listTeams(orgId) {
      const res = await call({ method: 'GET', path: `/internal/teams?orgId=${encodeURIComponent(orgId)}` });
      if (!res.ok) throw new RegistryClientError('unexpected', `GET /internal/teams answered ${res.status}`);
      const body = (await res.json().catch(() => null)) as { teams?: unknown } | null;
      if (!body || !Array.isArray(body.teams)) {
        throw new RegistryClientError('unexpected', 'GET /internal/teams answered a malformed body');
      }
      return body.teams as Team[];
    },

    async getTeamById(teamId) {
      const res = await call({ method: 'GET', path: `/internal/teams/${encodeURIComponent(teamId)}` });
      if (!res.ok) throw new RegistryClientError('unexpected', `GET /internal/teams/:id answered ${res.status}`);
      const body = (await res.json().catch(() => null)) as { team?: Team | null } | null;
      if (!body || body.team === undefined) {
        throw new RegistryClientError('unexpected', 'GET /internal/teams/:id answered a malformed body');
      }
      return body.team ?? undefined;
    },

    async getProjectTeam(root) {
      const res = await call({ method: 'GET', path: `/internal/project-teams/by-root?root=${encodeRoot(root)}` });
      // Unclaimed answers 404 on the real handler (`supervisor/server.ts`), never a 200 with a
      // `null` body — checked BEFORE `!res.ok` so this one expected-and-common case doesn't fall
      // into the generic `unexpected` throw below. Mirrors `IdentityStore#getProjectTeam`'s own
      // never-throws-for-unclaimed contract, just reached over HTTP instead of in-process.
      if (res.status === 404) return undefined;
      // A 403 (the root is claimed by a DIFFERENT org — TIGHTENED 2026-08-07, see the module doc's
      // corrected paragraph) never reaches here: `call()` above raises it as
      // `RegistryClientError('unauthorized')`, which `mayActOnRoot`'s fail-closed catch turns into
      // the refusal a cross-org root has always produced. Deliberately NOT folded into the 404
      // branch: "nobody claims this root" and "somebody else does" are different facts, and
      // collapsing them here would make an unreachable supervisor's foreign claim read as
      // unclaimed, which is the fail-OPEN shape D4 exists to prevent.
      if (!res.ok) throw new RegistryClientError('unexpected', `GET /internal/project-teams/by-root answered ${res.status}`);
      const body = (await res.json().catch(() => null)) as { projectTeam?: ProjectTeam | null } | null;
      if (!body || body.projectTeam === undefined) {
        throw new RegistryClientError('unexpected', 'GET /internal/project-teams/by-root answered a malformed body');
      }
      return body.projectTeam ?? undefined;
    },

    async createProjectTeam(input) {
      const res = await call({ method: 'POST', path: '/internal/project-teams', body: input });
      const body = (await res.json().catch(() => null)) as
        | { projectTeam?: ProjectTeam; code?: unknown }
        | null;
      if (!body) throw new RegistryClientError('unexpected', `POST /internal/project-teams answered a malformed body (${res.status})`);
      // Success is 201 + `{ projectTeam }` — no `ok` field on the wire (see the module doc comment;
      // the earlier `body.ok === true` check here could never be true against the real handler).
      if (res.ok && body.projectTeam) return { ok: true, projectTeam: body.projectTeam };
      // Failure only becomes a discriminated result when the wire actually names a `code` (which
      // `supervisor/server.ts` now sends — see the module doc comment). Anything else still throws:
      // the deliberately fail-LOUD posture of never guessing a code off a 404/409 that two
      // different `IdentityStoreError` codes both map to is unchanged, and is what keeps an older
      // supervisor that predates the `code` field from being silently misread.
      const code = body.code;
      if (code === 'project-root-taken' || code === 'org-not-found' || code === 'team-not-found' || code === 'team-org-mismatch') {
        return { ok: false, code };
      }
      throw new RegistryClientError('unexpected', `POST /internal/project-teams answered an unrecognised shape (${res.status})`);
    },

    /** 5c, ADDED 2026-08-07 (Fill unit 3). No retry — unlike `deleteProjectTeam` below, this is not
     *  idempotent (two successful reassignments to different teams are two different, both
     *  meaningful, outcomes), so a transient failure surfaces rather than silently repeating a
     *  write whose first attempt may already have landed. */
    async updateProjectTeam(root, teamId) {
      const res = await call({ method: 'PATCH', path: '/internal/project-teams', body: { projectRoot: root, teamId } });
      const body = (await res.json().catch(() => null)) as
        | { projectTeam?: ProjectTeam; code?: unknown }
        | null;
      if (!body) throw new RegistryClientError('unexpected', `PATCH /internal/project-teams answered a malformed body (${res.status})`);
      if (res.ok && body.projectTeam) return { ok: true, projectTeam: body.projectTeam };
      // Same "trust only an explicit `code`" posture `createProjectTeam` above already takes — see
      // its own comment for why guessing a code off the status alone is the wrong default here.
      const code = body.code;
      if (code === 'project-root-not-found' || code === 'team-not-found' || code === 'team-org-mismatch') {
        return { ok: false, code };
      }
      throw new RegistryClientError('unexpected', `PATCH /internal/project-teams answered an unrecognised shape (${res.status})`);
    },

    /**
     * **The one method retried, and the only one that may be (ADDED 2026-08-07).**
     *
     * `server.ts#releaseRootClaim` calls this AFTER `removeProject` has already succeeded, so a
     * failure here does not fail loudly into a clean state — it leaves an orphaned `project_teams`
     * row for a root that no longer exists, which a later re-registration then silently inherits.
     * Before phase 6 that was a local write behind D7's `O_EXCL` lease and a failure meant the disk
     * was genuinely broken; it is now a 5 s loopback `fetch`, where a supervisor mid-`systemctl
     * reload` is an ordinary event rather than a broken machine.
     *
     * Retried ONCE, and only on `unreachable`. Two halves, both load-bearing:
     *
     * - **Only `unreachable`.** `unauthorized` and `unexpected` are decisions the supervisor
     *   actually made; repeating the call just pays the timeout twice for the same answer.
     *   `not-configured` cannot reach here at all — `openRegistryClient` throws it at construction.
     * - **Only this method.** A retry is safe here because the route is idempotent by
     *   construction: an already-released root answers `{ released: false }`, never an error. It
     *   would NOT be safe on `createProjectTeam`, where a write that succeeded but whose response
     *   was lost comes back as `project-root-taken` on the second attempt — turning a transient
     *   blip into a permanent, and wrong, "someone else owns this root". The GETs need no retry:
     *   they fail before anything has changed, and `mayActOnRoot` is deliberately fail-CLOSED.
     */
    async deleteProjectTeam(root) {
      const path = `/internal/project-teams/by-root?root=${encodeRoot(root)}`;
      let res: Response;
      try {
        res = await call({ method: 'DELETE', path });
      } catch (err) {
        if (!(err instanceof RegistryClientError) || err.code !== 'unreachable') throw err;
        res = await call({ method: 'DELETE', path });
      }
      if (!res.ok) throw new RegistryClientError('unexpected', `DELETE /internal/project-teams/by-root answered ${res.status}`);
      // Field is `released`, matching `supervisor/server.ts`'s actual response — not `deleted`.
      const body = (await res.json().catch(() => null)) as { released?: unknown } | null;
      if (!body || typeof body.released !== 'boolean') {
        throw new RegistryClientError('unexpected', 'DELETE /internal/project-teams/by-root answered a malformed body');
      }
      return body.released;
    },
  };
}
