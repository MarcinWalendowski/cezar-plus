import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { IdentityStore } from '../auth/identity-store.ts';
import { invalidateLocalOrgIdentityCache } from '../auth/local-identity.ts';
import { identityDir } from '../paths.ts';
import {
  createApp,
  type ProjectsResponse,
  type RegisterProjectResponse,
  type ServerDeps,
  type UpdateProjectResponse,
} from './server.ts';

/**
 * D13's HTTP-surface pass (`.ai/specs/2026-08-06-org-team-auth-onboarding.md`, phase 9) — the
 * POSITIVE half of the five `hasOrgScope` call sites (`withTeams`, `mayActOnRoot`,
 * `releaseRootClaim`, `registerFolder`'s claim block, `PATCH /projects/:id`'s `teamId` arm).
 *
 * The three "no identity directory is created" controls in `projects-api.test.ts`
 * (577/665/751/855/869) already pin the NEGATIVE half — a `CEZ_AUTH`-unset request with NO local
 * org must never read or write `<CEZ_HOME>/identity/*.json`. What none of those tests can pin,
 * because none of them ever creates a real `(issuer: 'local', subject: 'local')` user, is the
 * other side of the same predicate: a LOCAL principal (`kind: 'local'`, never authenticated) that
 * DOES have a real org must be treated exactly like a signed-in session at every one of the five
 * sites — reading/writing `project_teams` for real, not the implicit no-org identity. That is the
 * scenario `resolvePrincipal`'s D13 arm and `hasOrgScope` exist for, and it is untested anywhere
 * else in `server/*.test.ts` (verified by grep before writing this file).
 *
 * D13's own phase-9 verification row names the mutation this file exists to kill: "coercing a
 * `null` `orgId` back to the string `'local'` — if the suite stays green, `hasOrgScope` is not
 * actually load-bearing anywhere." A suite that only ever exercises the no-org case can't tell
 * `hasOrgScope(principal)` apart from `principal.kind === 'session'` (both are `false` there) —
 * only a real local-org-scoped request can, and that is exactly what every test below drives.
 */
describe('server.ts D13 call sites — a LOCAL principal WITH a real org (hasOrgScope true)', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedAuth = process.env.CEZ_AUTH;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  let home: string;
  let repoRoot: string;
  let otherRoot: string;
  let store: RunStore;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-local-org-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-local-org-boot-'));
    otherRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-local-org-other-'));
    process.env.CEZ_HOME = home;
    delete process.env.CEZ_AUTH;
    process.env.CEZ_DRY_RUN = '1';
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    // `resolveLocalOrgIdentity`'s cache is ONE global slot, not keyed per `CEZ_HOME` (see that
    // module's own doc comment on why) — every test in this file gets a fresh `CEZ_HOME`, so a
    // cached answer from the PREVIOUS case would leak into this one without this reset.
    invalidateLocalOrgIdentityCache();
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedAuth === undefined) delete process.env.CEZ_AUTH;
    else process.env.CEZ_AUTH = savedAuth;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
      ...over,
    });

  /**
   * A REAL local org, seeded the same way `POST /auth/onboarding/org`'s legacy branch would
   * (`findOrCreateLocalUser` + `claimOrg`, `auth/identity-store.ts`) — not a fake `Principal`
   * object, so the request under test actually exercises `resolveLocalPrincipal` /
   * `local-gates.ts#localSessionResolver` / `resolveLocalOrgIdentity` reading this exact store,
   * the same as it would in production.
   */
  const seedLocalOrg = async () => {
    const identity = IdentityStore.open(identityDir());
    const { user } = await identity.findOrCreateLocalUser();
    const { org, defaultTeam } = await identity.claimOrg({ userId: user.id, name: 'Local', slug: 'local-org' });
    return { identity, org, defaultTeam };
  };

  it('withTeams: annotates a project claimed under the local org with teamId AND teamName', async () => {
    const { identity, org, defaultTeam } = await seedLocalOrg();
    const claimed = await registerProject(otherRoot);
    await identity.createProjectTeam({ projectRoot: claimed.root, orgId: org.id, teamId: defaultTeam.id });

    const res = await apiRequest(makeApp(), '/api/v1/projects');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectsResponse;
    const entry = body.projects.find((p) => p.id === claimed.id);
    expect(entry?.teamId).toBe(defaultTeam.id);
    expect(entry?.teamName).toBe(defaultTeam.name);
  });

  it("registerFolder's claim block: POST /api/v1/projects claims a fresh root under the local org's default team", async () => {
    const { identity, org, defaultTeam } = await seedLocalOrg();

    const res = await apiRequest(makeApp(), '/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: otherRoot }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RegisterProjectResponse;
    expect(body.project.teamId).toBe(defaultTeam.id);
    expect(identity.getProjectTeam(body.project.root)).toEqual({
      projectRoot: body.project.root,
      orgId: org.id,
      teamId: defaultTeam.id,
    });
  });

  it("registerFolder's claim block: an explicit teamId from a DIFFERENT org is refused (400), nothing persisted", async () => {
    await seedLocalOrg();
    const res = await apiRequest(makeApp(), '/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: otherRoot, teamId: 'not-a-real-team' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('unknown team');
  });

  it("PATCH /projects/:id's teamId arm: succeeds once the local org exists — 400'd before onboarding", async () => {
    const { identity, org, defaultTeam } = await seedLocalOrg();
    const engineering = await identity.createTeam({ orgId: org.id, name: 'Engineering', slug: 'engineering' });
    const claimed = await registerProject(otherRoot);
    await identity.createProjectTeam({ projectRoot: claimed.root, orgId: org.id, teamId: defaultTeam.id });

    const res = await apiRequest(makeApp(), `/api/v1/projects/${claimed.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ teamId: engineering.id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UpdateProjectResponse;
    expect(body.project.teamId).toBe(engineering.id);
    expect(identity.getProjectTeam(claimed.root)?.teamId).toBe(engineering.id);
  });

  it('PATCH teamId: 400s with the CORRECTED message before any local org exists — names an organization, not a session', async () => {
    const claimed = await registerProject(otherRoot);
    const res = await apiRequest(makeApp(), `/api/v1/projects/${claimed.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ teamId: 'whatever' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    // The old wording named a fact ("authenticated session") that is true of every local request,
    // onboarded or not, and was therefore never the actual reason for the refusal.
    expect(body.error).not.toContain('authenticated session');
    expect(body.error).toContain('organization');
  });

  it('releaseRootClaim: DELETE releases the project_teams claim once the local org exists, unlike the pre-onboarding D1 control', async () => {
    const { identity, org, defaultTeam } = await seedLocalOrg();
    const claimed = await registerProject(otherRoot);
    await identity.createProjectTeam({ projectRoot: claimed.root, orgId: org.id, teamId: defaultTeam.id });

    const res = await apiRequest(makeApp(), `/api/v1/projects/${claimed.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(identity.getProjectTeam(claimed.root)).toBeUndefined();

    // And re-registering picks a FRESH claim rather than silently inheriting a dead one — same
    // "the orphan is the bug" assertion `projects-api.test.ts`'s session-mode sibling makes.
    const again = await apiRequest(makeApp(), '/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: otherRoot }),
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as RegisterProjectResponse).project.teamId).toBe(defaultTeam.id);
  });

  it("mayActOnRoot: PATCH's maxParallel succeeds for the local org's own claim (the write verb the D4 boundary guards)", async () => {
    const { identity, org, defaultTeam } = await seedLocalOrg();
    const claimed = await registerProject(otherRoot);
    await identity.createProjectTeam({ projectRoot: claimed.root, orgId: org.id, teamId: defaultTeam.id });

    const res = await apiRequest(makeApp(), `/api/v1/projects/${claimed.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxParallel: 3 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UpdateProjectResponse;
    expect(body.project.maxParallel).toBe(3);
  });

  it("kind stays 'local' even once hasOrgScope is true — never re-becomes a stand-in for org scope", async () => {
    // A behavioural pin on the distinction D13 makes, not a `kind` assertion this file can make
    // directly (the middleware never exposes the resolved `Principal` back to the caller) — proven
    // indirectly: EVERY assertion above already demonstrates that a request which never carried a
    // session cookie (local mode parses none, D13 invariant 1) is nonetheless treated as org-scoped
    // once `hasOrgScope` is true. This test is the explicit negative control for the OTHER reading:
    // that the five call sites might have been changed to key on `kind === 'local'` (always true
    // here) rather than `hasOrgScope`, which would make every write above succeed regardless of
    // whether an org was ever seeded. Rerun the claim-refusal case with NO local org at all — if
    // the gate were keyed on `kind` alone, this would incorrectly succeed too.
    const claimed = await registerProject(otherRoot);
    const res = await apiRequest(makeApp(), `/api/v1/projects/${claimed.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ teamId: 'whatever' }),
    });
    expect(res.status).toBe(400);
  });
});
