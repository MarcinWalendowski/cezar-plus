import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerProject } from './workspace/projects.ts';
import {
  listRegisteredProjectRoots,
  registerAndAdoptProject,
  releaseProjectTeamClaim,
} from './registered-project-roots.ts';
import { IdentityStore } from './auth/identity-store.ts';
import { invalidateLocalOrgIdentityCache, resolveLocalOrgIdentity } from './auth/local-identity.ts';

/**
 * FIX 6 (D13 repair pass, `.ai/specs/2026-08-06-org-team-auth-onboarding.md`) — the production
 * supplier `src/index.ts`'s local-mode branch threads into
 * `OnboardingRouteDeps.listRegisteredProjectRoots` (`auth/onboarding-routes.ts`), extracted
 * specifically so it HAS a test at all. See this module's own doc comment for why the un-extracted
 * inline version at the `src/index.ts` call site was invisible to every existing gate: deleting it
 * reproduces D13's own "an org whose project list is empty" FAIL state with the whole suite green,
 * because every D13 test injects its own stub for this dependency rather than the real thing.
 */
describe('listRegisteredProjectRoots', () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;
  let repoA: string;
  let repoB: string;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-roots-home-'));
    repoA = mkdtempSync(join(realpathSync(tmpdir()), 'cez-roots-repo-a-'));
    repoB = mkdtempSync(join(realpathSync(tmpdir()), 'cez-roots-repo-b-'));
    process.env.CEZ_HOME = home;
  });

  afterEach(() => {
    for (const dir of [home, repoA, repoB]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  it('returns an empty list against a fresh, never-registered workspace', async () => {
    expect(await listRegisteredProjectRoots()).toEqual([]);
  });

  it('returns every root the registry actually holds, reading the SAME registry registerProject writes', async () => {
    const a = await registerProject(repoA);
    const b = await registerProject(repoB);

    const roots = await listRegisteredProjectRoots();
    expect([...roots].sort()).toEqual([a.root, b.root].sort());
  });

  it('reflects a project added AFTER the first read — no caching of its own', async () => {
    await registerProject(repoA);
    expect(await listRegisteredProjectRoots()).toHaveLength(1);

    const b = await registerProject(repoB);
    const roots = await listRegisteredProjectRoots();
    expect(roots).toHaveLength(2);
    expect(roots).toContain(b.root);
  });
});

/**
 * FIX A1/A3/A4 (D13 repair round 2) — `registerAndAdoptProject`, the registration seam every
 * non-HTTP caller (`src/index.ts#initWorkspace`, `cezar projects add`) now goes through instead of
 * `workspace/projects.ts#registerProject` directly. See that function's own doc comment for the
 * three defects this suite pins.
 */
describe('registerAndAdoptProject', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedAuth = process.env.CEZ_AUTH;
  const savedRemote = process.env.CEZ_REMOTE;
  let home: string;
  let repo: string;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-adopt-home-'));
    repo = mkdtempSync(join(realpathSync(tmpdir()), 'cez-adopt-repo-'));
    process.env.CEZ_HOME = home;
    delete process.env.CEZ_AUTH;
    delete process.env.CEZ_REMOTE;
    // The resolver's cache is ONE global slot (see `auth/local-identity.ts`'s own doc comment on
    // why), not keyed per `CEZ_HOME` — every test here gets a fresh `CEZ_HOME`, so a cached answer
    // from a PREVIOUS case in this file would leak into this one without this reset.
    invalidateLocalOrgIdentityCache();
  });

  afterEach(() => {
    for (const dir of [home, repo]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedAuth === undefined) delete process.env.CEZ_AUTH;
    else process.env.CEZ_AUTH = savedAuth;
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
    invalidateLocalOrgIdentityCache();
  });

  it('registers the root and creates no identity directory when no local org exists yet', async () => {
    const entry = await registerAndAdoptProject(repo);
    expect(entry.root).toBeTruthy();
    expect(existsSync(join(home, 'identity'))).toBe(false);
  });

  it('files the project under the local org once one exists (CEZ_AUTH unset, loopback bind)', async () => {
    const identity = IdentityStore.open(join(home, 'identity'));
    const { user } = await identity.findOrCreateLocalUser();
    const { org, defaultTeam } = await identity.claimOrg({ userId: user.id, name: 'Solo', slug: 'solo' });

    const entry = await registerAndAdoptProject(repo);

    expect(identity.getProjectTeam(entry.root)).toEqual({
      projectRoot: entry.root,
      orgId: org.id,
      teamId: defaultTeam.id,
    });
  });

  // FIX A3 — the regression this repair round exists to close. Round 1's `src/index.ts` call site
  // ran `adoptRegisteredProjectIntoLocalOrg` unconditionally, keyed on NEITHER `CEZ_AUTH` nor the
  // bind — so a local org left over in `<CEZ_HOME>/identity` from before auth was turned on would
  // silently keep claiming every newly-registered project on a HOSTED, AUTHENTICATED deployment.
  // Reverting the `isLocalOrgModeActive` guard inside `registerAndAdoptProject` back to
  // "always adopt" fails this test.
  it('does NOT adopt into a stale local org once CEZ_AUTH names a real provider', async () => {
    const identity = IdentityStore.open(join(home, 'identity'));
    const { user } = await identity.findOrCreateLocalUser();
    await identity.claimOrg({ userId: user.id, name: 'Solo', slug: 'solo' });

    process.env.CEZ_AUTH = 'oidc';
    const entry = await registerAndAdoptProject(repo);

    expect(identity.getProjectTeam(entry.root)).toBeUndefined();
  });

  // The other half of the same predicate (`resolveCapabilities(...).localHandoff`): a hosted,
  // UNAUTHENTICATED bind (`CEZ_AUTH` unset + `CEZ_REMOTE=1`, D1's table) is a real, permitted
  // topology whose audience is a network, not one machine — the local org must not adopt into it
  // either, mirroring `server.ts#isHostedMode`'s identical guard on `resolveLocalPrincipal`.
  it('does NOT adopt on a hosted (non-loopback) bind, even with CEZ_AUTH unset', async () => {
    const identity = IdentityStore.open(join(home, 'identity'));
    const { user } = await identity.findOrCreateLocalUser();
    await identity.claimOrg({ userId: user.id, name: 'Solo', slug: 'solo' });

    process.env.CEZ_REMOTE = '1';
    const entry = await registerAndAdoptProject(repo);

    expect(identity.getProjectTeam(entry.root)).toBeUndefined();
  });

  // FIX 1 (D13 repair round 3) — the case above varies `CEZ_REMOTE`, never `opts.bindHost` itself,
  // so it cannot tell `isLocalOrgModeActive(process.env, opts.bindHost)` apart from a mutated
  // `isLocalOrgModeActive(process.env)` (dropping the second argument, which silently defaults to
  // the loopback-equivalent `undefined`) — that mutation changed no test outcome in this file before
  // this case existed. This one holds `CEZ_REMOTE`/`CEZ_AUTH` both unset and varies ONLY
  // `opts.bindHost`, mirroring `local-mode-boot.test.ts`'s identical fix for `buildLocalModeRoutes`'s
  // own call site (its own doc comment names the mutation verified live there). It can only pass if
  // `opts.bindHost` genuinely reaches `isLocalOrgModeActive` at THIS call site.
  it('does NOT adopt on a hosted (non-loopback) bindHost passed explicitly, even with CEZ_REMOTE unset', async () => {
    const identity = IdentityStore.open(join(home, 'identity'));
    const { user } = await identity.findOrCreateLocalUser();
    await identity.claimOrg({ userId: user.id, name: 'Solo', slug: 'solo' });

    const entry = await registerAndAdoptProject(repo, { bindHost: '0.0.0.0' });

    expect(identity.getProjectTeam(entry.root)).toBeUndefined();
  });

  // FIX A4 — an adoption failure must not un-succeed a registration that already landed.
  //
  // **REWRITTEN 2026-08-07, and the reason is worth keeping.** This test used to force the failure
  // by warming `resolveLocalOrgIdentity`'s cache, deleting the team behind it, and relying on the
  // resolver to keep serving the now-dangling `teamId` so `createProjectTeam` threw
  // `team-not-found`. That premise was the STALE-CACHE BUG itself: the cache has since been changed
  // to fingerprint `identity.json` (size + mtime) on every resolution, so `deleteTeam`'s write is
  // picked up and the resolver returns the surviving team — adoption then SUCCEEDS and the old
  // assertion fails. The two changes were made by different agents in different files and neither
  // could see the other; the full suite is what caught it.
  //
  // So the failure is now forced at the layer FIX A4 is actually about — the identity WRITE — by
  // making the identity directory read-only. Reads (resolution) still work, so an org is genuinely
  // resolved and adoption genuinely attempts; the write then fails with EACCES. That keeps the test
  // exercising "adoption threw" rather than "adoption had nothing to do", which is the difference
  // between this being a control and being decoration.
  it('still returns the registered entry when adoption fails — a registration success survives an unrelated write failure', async () => {
    const identityPath = join(home, 'identity');
    const identity = IdentityStore.open(identityPath);
    const { user } = await identity.findOrCreateLocalUser();
    await identity.claimOrg({ userId: user.id, name: 'Solo', slug: 'solo' });
    // Resolution must still be able to READ, so the org is real and adoption really is attempted —
    // otherwise this would pass because there was nothing to adopt, which is not the property.
    expect(resolveLocalOrgIdentity(identityPath)).not.toBeNull();

    // The lever: every identity WRITE goes through `acquireLeaseBlocking`, which needs
    // `identity.lock`. A DIRECTORY at that path can never be opened `wx`, and `acquireLease`'s
    // bare `catch` treats every failure as "held by a peer", so the write retries for
    // `lockTimeoutMs` (5s) and then throws `lease-timeout`. Chosen over permission bits, which do
    // not constrain root, and over the previous stale-cache premise, which the fingerprint fix
    // removed. Reads never take the lease, so the resolution asserted above is unaffected.
    //
    // Costs a real 5s wait — the price of exercising the write path without an injectable seam
    // (`registerAndAdoptProject` opens its own store via a dynamic import, deliberately, so
    // `lockTimeoutMs` cannot be shortened from here). Hence the explicit timeout below.
    mkdirSync(join(identityPath, 'identity.lock'));

    // The write inside adoption now throws — a real failure, not the `project-root-taken` case
    // `adoptRegisteredProjectIntoLocalOrg` already swallows on purpose. It must not propagate out
    // of `registerAndAdoptProject`.
    const entry = await registerAndAdoptProject(repo);

    expect(entry.root).toBeTruthy();
    expect(entry.id).toBeTruthy();
    expect(identity.getProjectTeam(entry.root)).toBeUndefined();
  }, 20_000);
});

/**
 * FIX A2 (D13 repair round 2) — `releaseProjectTeamClaim`, the un-registration half of the seam.
 * `cezar projects remove <id>` now calls this after a successful `removeProject` so the CLI path
 * releases a `project_teams` claim exactly like `DELETE /api/v1/projects/:id` already does.
 */
describe('releaseProjectTeamClaim', () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;
  let repo: string;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-release-home-'));
    repo = mkdtempSync(join(realpathSync(tmpdir()), 'cez-release-repo-'));
    process.env.CEZ_HOME = home;
  });

  afterEach(() => {
    for (const dir of [home, repo]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  it('is a no-op that creates no identity directory when no claim exists for the root', async () => {
    const entry = await registerProject(repo);
    await releaseProjectTeamClaim(entry.root);
    expect(existsSync(join(home, 'identity'))).toBe(false);
  });

  it('releases an existing claim, unblocking the org\'s team for deletion afterward', async () => {
    const entry = await registerProject(repo);
    const identity = IdentityStore.open(join(home, 'identity'));
    const { user } = await identity.findOrCreateLocalUser();
    const { org, defaultTeam } = await identity.claimOrg({ userId: user.id, name: 'Solo', slug: 'solo' });
    await identity.createProjectTeam({ projectRoot: entry.root, orgId: org.id, teamId: defaultTeam.id });
    // A second team, so `defaultTeam` is not (yet) the org's last one — the orphan this fix closes
    // is specifically `team-has-projects`, not `team-is-last`; keep the two failure modes distinct.
    const spare = await identity.createTeam({ orgId: org.id, name: 'Spare', slug: 'spare' });

    await releaseProjectTeamClaim(entry.root);

    expect(identity.getProjectTeam(entry.root)).toBeUndefined();
    // FIX A2's actual named consequence: the team is deletable again once every project on it has
    // been released — before the release, this call would have thrown `team-has-projects`.
    await expect(identity.deleteTeam(defaultTeam.id)).resolves.toBeUndefined();
    expect(identity.getTeamById(spare.id)).toBeDefined();
  });
});

/**
 * FIX 3 (D13 repair round 3) — `releaseProjectTeamClaim` now goes through the SAME
 * `openProjectTeamRegistry` seam every other D4 project-team write uses
 * (`server/project-team-registry.ts`), instead of opening `IdentityStore.open(identityDir())`
 * directly. On the D10 supervisor topology (`CEZ_AUTH=supervisor`) an org process's own `CEZ_HOME`
 * carries no `identity/` directory at all — the old direct-open always found "no claim" there and
 * silently left the REAL claim, held by the supervisor over HTTP, orphaned. This suite pins the
 * fix the same way `server/projects-api.test.ts`'s own "CEZ_AUTH=supervisor" block pins
 * `server.ts`'s call sites: a mocked HTTP round trip, never a live server (this unit's safety
 * rules), asserting the read AND the delete both go over the wire to the supervisor rather than
 * touching this process's own (nonexistent, on this topology) local identity store.
 */
describe('releaseProjectTeamClaim under CEZ_AUTH=supervisor (D10)', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedAuth = process.env.CEZ_AUTH;
  const savedPort = process.env.CEZ_SUPERVISOR_PORT;
  const savedSecret = process.env.CEZ_SUPERVISOR_SECRET;
  let home: string;
  let repo: string;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-release-supervisor-home-'));
    repo = mkdtempSync(join(realpathSync(tmpdir()), 'cez-release-supervisor-repo-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_AUTH = 'supervisor';
    process.env.CEZ_SUPERVISOR_PORT = '4999';
    process.env.CEZ_SUPERVISOR_SECRET = 'test-supervisor-secret-value-0000';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const dir of [home, repo]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedAuth === undefined) delete process.env.CEZ_AUTH;
    else process.env.CEZ_AUTH = savedAuth;
    if (savedPort === undefined) delete process.env.CEZ_SUPERVISOR_PORT;
    else process.env.CEZ_SUPERVISOR_PORT = savedPort;
    if (savedSecret === undefined) delete process.env.CEZ_SUPERVISOR_SECRET;
    else process.env.CEZ_SUPERVISOR_SECRET = savedSecret;
  });

  const fakeJsonResponse = (status: number, body: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

  it('releases the claim over HTTP against the supervisor, never opening a local identity directory', async () => {
    const entry = await registerProject(repo);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.startsWith('http://127.0.0.1:4999/internal/project-teams/by-root?')) {
        return fakeJsonResponse(200, { projectTeam: { projectRoot: entry.root, orgId: 'org_a', teamId: 'team_a' } });
      }
      if (method === 'DELETE' && url.startsWith('http://127.0.0.1:4999/internal/project-teams/by-root?')) {
        return fakeJsonResponse(200, { released: true });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await releaseProjectTeamClaim(entry.root);

    const deleteCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE');
    expect(deleteCall).toBeDefined();
    expect((deleteCall![1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer test-supervisor-secret-value-0000' });
    // The old defect, made observable: this process's own CEZ_HOME never gets an identity
    // directory of its own — the claim genuinely lives on the supervisor's disk, not here.
    expect(existsSync(join(home, 'identity'))).toBe(false);
  });

  it('is a no-op — no DELETE call at all — when the supervisor reports the root unclaimed', async () => {
    const entry = await registerProject(repo);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.startsWith('http://127.0.0.1:4999/internal/project-teams/by-root?')) {
        return fakeJsonResponse(404, { error: 'no org/team claim' });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await releaseProjectTeamClaim(entry.root);

    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')).toBe(false);
  });
});
