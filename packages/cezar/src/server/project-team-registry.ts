import type { ProjectTeam, Team } from '../auth/types.ts';
import { identityDir } from '../paths.ts';
import { resolveAuthProvider } from './capabilities.ts';

/**
 * D4's root→org registry (`<CEZ_HOME>/identity/*.json`'s `project_teams`/`teams` tables),
 * abstracted behind ONE seam every D4 call site goes through — never `IdentityStore` directly, and
 * never a second, independent lookup. This is what the spec's phase-6 amendment to D4 asks for:
 * "the phase-5 in-process check must be REPLACED by the supervisor's mapping, not joined by it" —
 * per-org `CEZ_HOME`s make each org process blind to every other org's `project_teams` table, so a
 * local `IdentityStore.open(identityDir())` call from an org process would not error, it would
 * silently start a SECOND, empty table, reinstating the exact leaseless-`RunStore` history loss D4
 * exists to prevent, with every gate green. One seam here means a local read and a remote read can
 * never quietly disagree about the same root.
 *
 * Which implementation answers is `resolveAuthProvider()`, read fresh on every call — the same
 * "`CEZ_AUTH` is read per request" posture `server.ts` already documents at its `/api/*` auth
 * middleware. `'supervisor'` (phase 6+, D10: an org process running behind the supervisor) asks the
 * supervisor over HTTP (`supervisor/registry-client.ts`); every other session-carrying provider
 * (`oidc`/`google`, the phase 1-5 single-process deployment, and every existing test in
 * `projects-api.test.ts`, none of which set `CEZ_AUTH`) keeps reading the SAME local `IdentityStore`
 * it always has — unchanged behavior, unchanged tests.
 *
 * Both implementations return the exact same async shape (never a mix of sync reads and async
 * writes, unlike `IdentityStore`'s own public methods) — the local one is a thin `async` wrapper,
 * not a second construction of the contract. `createProjectTeam`/`updateProjectTeam` return a
 * discriminated result rather than throwing an error type specific to either implementation, so a
 * caller has exactly one error-handling shape regardless of which one answered.
 *
 * **EXTRACTED 2026-08-07 (D13 repair round 3, FIX 3) out of `server/server.ts`'s `createApp`.** It
 * used to be a closure private to that function — which is why `registered-project-roots.ts#releaseProjectTeamClaim`
 * (the non-HTTP `cezar projects remove` path, which has no request and no resolved `Principal` to
 * build the closure from) could not reach it and opened `IdentityStore.open(identityDir())` directly
 * instead. On the D10 supervisor topology that read the WRONG store: an org process's own `CEZ_HOME`
 * carries no `identity/` directory at all (the supervisor is the only process that ever opens one),
 * so that direct call always found "no claim" and silently left the real one — held by the
 * supervisor, over HTTP — orphaned. Nothing in this module closes over `ServerDeps` or anything else
 * `createApp` builds (`identityDir()` and `resolveAuthProvider()` both read only `paths.ts`/
 * `process.env`), so the extraction is mechanical: `server.ts` now imports `openProjectTeamRegistry`
 * from here instead of defining it inline, and `registered-project-roots.ts` imports the identical
 * function — one seam, two callers, exactly the shape the paragraph above already asked for.
 */
export interface ProjectTeamRegistry {
  listProjectTeams(filter: { orgId?: string; teamId?: string }): Promise<ProjectTeam[]>;
  listTeams(orgId: string): Promise<Team[]>;
  getTeamById(teamId: string): Promise<Team | undefined>;
  getProjectTeam(root: string): Promise<ProjectTeam | undefined>;
  createProjectTeam(input: { projectRoot: string; orgId: string; teamId: string }): Promise<
    | { ok: true; projectTeam: ProjectTeam }
    | { ok: false; code: 'org-not-found' | 'team-not-found' | 'team-org-mismatch' | 'project-root-taken' }
  >;
  /** 5c (D2/D4) — reassign an already-claimed root to a different team in the SAME org. No `orgId`
   *  parameter: the D4 guard is checked against the EXISTING row's org, not a caller-supplied one —
   *  see `auth/identity-store.ts#updateProjectTeam`'s own doc comment. */
  updateProjectTeam(root: string, teamId: string): Promise<
    | { ok: true; projectTeam: ProjectTeam }
    | { ok: false; code: 'project-root-not-found' | 'team-not-found' | 'team-org-mismatch' }
  >;
  deleteProjectTeam(root: string): Promise<boolean>;
}

/** The phase 1-5 implementation, wrapped to the async shape above — every check and every write is
 *  byte-for-byte what `IdentityStore` already did; only the calling convention changed. */
async function openLocalProjectTeamRegistry(): Promise<ProjectTeamRegistry> {
  const { IdentityStore, IdentityStoreError } = await import('../auth/identity-store.ts');
  const store = IdentityStore.open(identityDir());
  return {
    listProjectTeams: async (filter) => store.listProjectTeams(filter),
    listTeams: async (orgId) => store.listTeams(orgId),
    getTeamById: async (teamId) => store.getTeamById(teamId),
    getProjectTeam: async (root) => store.getProjectTeam(root),
    createProjectTeam: async (input) => {
      try {
        const projectTeam = await store.createProjectTeam(input);
        return { ok: true, projectTeam };
      } catch (err) {
        if (
          err instanceof IdentityStoreError &&
          (err.code === 'org-not-found' ||
            err.code === 'team-not-found' ||
            err.code === 'team-org-mismatch' ||
            err.code === 'project-root-taken')
        ) {
          return { ok: false, code: err.code };
        }
        throw err;
      }
    },
    updateProjectTeam: async (root, teamId) => {
      try {
        const projectTeam = await store.updateProjectTeam(root, teamId);
        return { ok: true, projectTeam };
      } catch (err) {
        if (
          err instanceof IdentityStoreError &&
          (err.code === 'project-root-not-found' ||
            err.code === 'team-not-found' ||
            err.code === 'team-org-mismatch')
        ) {
          return { ok: false, code: err.code };
        }
        throw err;
      }
    },
    deleteProjectTeam: async (root) => store.deleteProjectTeam(root),
  };
}

/** **CORRECTED 2026-08-07 (D13, phase 9): the sentence below described `kind`, and the gate moved to
 *  `hasOrgScope`.** A principal with NO org scope never reaches this — every HTTP call site guards
 *  on `hasOrgScope` first, exactly as they guarded on `principal.kind === 'session'` before this
 *  seam existed, so D1's "unset means zero I/O" and D7's "the module is never imported" both hold
 *  literally for that case: this function is never even called, let alone the dynamic imports inside
 *  either branch it can reach.
 *
 *  `registered-project-roots.ts`'s two non-HTTP callers reach this function differently but both
 *  preserve the same guarantee: `registerAndAdoptProject` calls it only once `isLocalOrgModeActive`
 *  already holds (a genuine gate, before this function runs at all); `releaseProjectTeamClaim` calls
 *  it on every invocation — by design, it releases a claim under ANY topology — but the delete WRITE
 *  it can trigger is still gated on this function's own `getProjectTeam` read coming back non-empty,
 *  and that read (like `IdentityStore#getProjectTeam` itself) never creates `<CEZ_HOME>/identity`
 *  merely by finding nothing there. */
export async function openProjectTeamRegistry(): Promise<ProjectTeamRegistry> {
  if (resolveAuthProvider(process.env) === 'supervisor') {
    const { openRegistryClient } = await import('../supervisor/registry-client.ts');
    return openRegistryClient();
  }
  return openLocalProjectTeamRegistry();
}
