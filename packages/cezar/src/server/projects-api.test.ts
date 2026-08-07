import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { allocateProjectSlug, clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { identityDir, workspaceConfigPath } from '../paths.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import type { CloneRunner } from './checkout.ts';
import {
  WorkspaceEventBus,
  createApp,
  type Principal,
  type ProjectsResponse,
  type RegisterProjectResponse,
  type ServerDeps,
  type SessionResolver,
  type UpdateProjectResponse,
} from './server.ts';

/**
 * Multi-project workspace API (spec 2026-07-20-multi-project-workspace, step
 * 1.6): the new `GET /api/v1/projects` registry listing, and `/api/v1/health`'s
 * additive `projects` + `bootProject` fields — with the #431 guarantee that
 * health (the one CORS-open route) never carries a project's absolute root.
 */

interface HealthBody {
  version: string;
  repoRoot: string;
  repo: unknown;
  checks: unknown[];
  defaultRunner?: string;
  forge: unknown;
  capabilities: { localHandoff: boolean; followups: boolean; singleProject: boolean; tokenMetrics: boolean };
  projects: { id: string; name: string }[];
  bootProject: string;
}

describe('workspace projects API', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedRemote = process.env.CEZ_REMOTE;
  const savedFollowups = process.env.CEZ_FOLLOWUPS;
  const savedSingleProject = process.env.CEZ_SINGLE_PROJECT;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  let home: string;
  let repoRoot: string;
  let otherRoot: string;
  let store: RunStore;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-workspace-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-projects-boot-'));
    otherRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-projects-other-'));
    process.env.CEZ_HOME = home; // paths.ts sends all workspace paths here
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    delete process.env.CEZ_REMOTE;
    delete process.env.CEZ_FOLLOWUPS;
    delete process.env.CEZ_SINGLE_PROJECT;
    // Deterministic on any machine: no network, no real agent CLIs.
    process.env.CEZ_DRY_RUN = '1';
    clearProjectProbeCache();
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
    if (savedFollowups === undefined) delete process.env.CEZ_FOLLOWUPS;
    else process.env.CEZ_FOLLOWUPS = savedFollowups;
    if (savedSingleProject === undefined) delete process.env.CEZ_SINGLE_PROJECT;
    else process.env.CEZ_SINGLE_PROJECT = savedSingleProject;
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

  const getProjects = async (over: Partial<ServerDeps> = {}): Promise<ProjectsResponse> => {
    const res = await apiRequest(makeApp(over), '/api/v1/projects');
    expect(res.status).toBe(200);
    return (await res.json()) as ProjectsResponse;
  };

  const getHealth = async (over: Partial<ServerDeps> = {}): Promise<HealthBody> => {
    const res = await apiRequest(makeApp(over), '/api/v1/health');
    expect(res.status).toBe(200);
    return (await res.json()) as HealthBody;
  };

  describe('GET /api/v1/projects', () => {
    it('answers an empty registry with projects:[] and defaults — never a 404', async () => {
      const body = await getProjects();
      expect(body.projects).toEqual([]);
      // Unregistered boot repo (e.g. worktree/$HOME/unreadable workspace):
      // bootProject degrades to the repo's would-be slug, not an error.
      expect(body.bootProject).toBe(allocateProjectSlug(repoRoot, []));
      expect(body.projectsDir).toBe('~/cezar/projects');
    });

    it('lists registered projects with root + status and derives bootProject from the registry', async () => {
      const boot = await registerProject(repoRoot);
      const other = await registerProject(otherRoot);
      const body = await getProjects(); // no bootProjectId — legacy caller path
      expect(body.projects).toHaveLength(2);
      const byId = new Map(body.projects.map((p) => [p.id, p]));
      // Plain temp dirs: exist but have no .git — the fully-usable degraded status.
      expect(byId.get(boot.id)).toMatchObject({
        id: boot.id,
        name: boot.name,
        root: boot.root,
        status: 'not-git',
        source: 'local',
      });
      expect(byId.get(boot.id)?.lastOpenedAt).toBe(boot.lastOpenedAt);
      expect(byId.get(other.id)).toMatchObject({
        id: other.id,
        root: other.root,
        status: 'not-git',
      });
      // Derived lazily by realpath lookup — the boot repo, not the other one.
      expect(body.bootProject).toBe(boot.id);
      expect(body.projectsDir).toBe('~/cezar/projects');
    });

    it('keeps an unregistered boot project distinct from a registered project with the same slug', async () => {
      const registeredRoot = join(otherRoot, basename(repoRoot));
      mkdirSync(registeredRoot);
      const registered = await registerProject(registeredRoot);
      const contexts = new ProjectContexts({ listProjects });

      const body = await getProjects({ contexts });
      expect(registered.id).toBe(allocateProjectSlug(repoRoot, []));
      expect(body.bootProject).toBe(allocateProjectSlug(repoRoot, [registered.id]));

      const scoped = await apiRequest(makeApp({ contexts }), `/api/v1/p/${registered.id}/repo`);
      expect(scoped.status).toBe(200);
      expect(contexts.peek(registered.id)?.root).toBe(await realpath(registeredRoot));
      contexts.disposeAll();
    });

    it('pins flagged reads to the boot project without pruning stored projects', async () => {
      const boot = await registerProject(repoRoot);
      const other = await registerProject(otherRoot);
      process.env.CEZ_SINGLE_PROJECT = '1';

      const body = await getProjects({ bootProjectId: boot.id });
      expect(body.projects.map((project) => project.id)).toEqual([boot.id]);
      expect(body.bootProject).toBe(boot.id);
      expect((await loadWorkspaceConfig()).projects.map((project) => project.id)).toEqual([
        boot.id,
        other.id,
      ]);
    });

    it('reports a deleted root as missing', async () => {
      const other = await registerProject(otherRoot);
      rmSync(otherRoot, { recursive: true, force: true });
      clearProjectProbeCache(); // drop the TTL cache so the probe re-looks
      const body = await getProjects();
      expect(body.projects.find((p) => p.id === other.id)?.status).toBe('missing');
    });

    it('prefers the plumbed deps.bootProjectId over any lookup', async () => {
      await registerProject(repoRoot);
      const body = await getProjects({ bootProjectId: 'plumbed-boot' });
      expect(body.bootProject).toBe('plumbed-boot');
    });

    it('serializes a per-project maxParallel when set, and omits it when absent (2026-07-22)', async () => {
      await registerProject(repoRoot); // boot, no override → inherits
      await registerProject(otherRoot);
      await mergeWriteWorkspaceConfig((config) => {
        const entry = config.projects.find((p) => p.root === realpathSync(otherRoot));
        if (entry) entry.maxParallel = 3;
      });
      const body = await getProjects();
      const byRoot = new Map(body.projects.map((p) => [p.root, p]));
      expect(byRoot.get(realpathSync(otherRoot))?.maxParallel).toBe(3);
      expect(byRoot.get(realpathSync(repoRoot))?.maxParallel).toBeUndefined();
    });
  });

  describe('single-project management guards', () => {
    it('refuses checkout before clone or registry side effects', async () => {
      let cloneCalls = 0;
      const cloneRunner: CloneRunner = async () => {
        cloneCalls += 1;
        return { ok: false, error: 'must not run' };
      };
      process.env.CEZ_SINGLE_PROJECT = '1';

      const res = await apiRequest(makeApp({ cloneRunner }), '/api/v1/projects/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'open-mercato/cezar' }),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'single-project mode is enabled; adding projects is disabled',
      });
      expect(cloneCalls).toBe(0);
      expect((await loadWorkspaceConfig()).projects).toEqual([]);
    });

    it('refuses filesystem browsing with the stable error', async () => {
      process.env.CEZ_SINGLE_PROJECT = '1';
      const res = await apiRequest(
        makeApp(),
        `/api/v1/fs/browse?path=${encodeURIComponent(otherRoot)}`,
      );

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'single-project mode is enabled; folder browsing is disabled',
      });
    });
  });

  describe('POST /api/v1/projects — the folder-browser dialog (step 4.2)', () => {
    const post = async (body: unknown, over: Partial<ServerDeps> = {}) => {
      const res = await apiRequest(makeApp(over), '/api/v1/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return {
        status: res.status,
        body: (await res.json()) as RegisterProjectResponse & {
          error?: string;
        },
      };
    };

    it('refuses registration in single-project mode before registry or event side effects', async () => {
      const existing = await registerProject(repoRoot);
      const bus = new WorkspaceEventBus();
      const seen: string[] = [];
      bus.on((event) => seen.push(event));
      process.env.CEZ_SINGLE_PROJECT = '1';

      const { status, body } = await post({ root: otherRoot }, { workspaceEvents: bus });

      expect(status).toBe(409);
      expect(body).toEqual({
        error: 'single-project mode is enabled; adding projects is disabled',
      });
      expect((await loadWorkspaceConfig()).projects.map((project) => project.id)).toEqual([
        existing.id,
      ]);
      expect(seen).toEqual([]);
    });

    it('registers a NON-GIT folder and answers the entry — the spec\'s "any folder works"', async () => {
      // A plain temp dir with no `.git`: selectable in the dialog, registerable
      // here, and `not-git` is the fully-usable degraded status (never a block).
      const { status, body } = await post({ root: otherRoot });
      expect(status).toBe(200);
      expect(body.project).toMatchObject({
        root: await realpath(otherRoot),
        status: 'not-git',
        source: 'local',
        name: basename(otherRoot),
      });
      expect(body.error).toBeUndefined();
      // The id is what the dialog navigates to (`/p/<id>/`), so it must be a
      // real slug AND resolvable through the list route immediately after.
      expect(body.project.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      const listed = await getProjects();
      expect(listed.projects.map((p) => p.id)).toContain(body.project.id);
    });

    it('registers a git repo as status ok and emits project-added once', async () => {
      mkdirSync(join(otherRoot, '.git'), { recursive: true });
      clearProjectProbeCache();
      const bus = new WorkspaceEventBus();
      const seen: { event: string; data: unknown }[] = [];
      bus.on((event, data) => seen.push({ event, data }));
      const { status, body } = await post({ root: otherRoot }, { workspaceEvents: bus });
      expect(status).toBe(200);
      expect(body.project.status).toBe('ok');
      expect(seen).toEqual([{ event: 'project-added', data: { project: body.project } }]);
    });

    it('re-registering answers 409 with the EXISTING entry and emits nothing', async () => {
      const first = await registerProject(otherRoot);
      const bus = new WorkspaceEventBus();
      const seen: string[] = [];
      bus.on((event) => seen.push(event));
      // A different spelling of the same folder — the registry dedupes by
      // realpath, so a trailing slash must not mint a second project.
      const { status, body } = await post({ root: `${otherRoot}/` }, { workspaceEvents: bus });
      expect(status).toBe(409);
      expect(body.project.id).toBe(first.id);
      expect(body.error).toContain(first.id);
      expect(seen).toEqual([]);
      expect((await getProjects()).projects).toHaveLength(1);
    });

    it('400s a non-absolute path, a missing folder, a file, and a malformed body', async () => {
      const file = join(otherRoot, 'not-a-dir.txt');
      writeFileSync(file, 'x', 'utf8');
      for (const root of ['relative/path', join(otherRoot, 'nope'), file]) {
        const { status, body } = await post({ root });
        expect(status, root).toBe(400);
        expect(typeof body.error).toBe('string');
      }
      expect((await post({})).status).toBe(400);
      expect((await post({ root: '   ' })).status).toBe(400);
      // No 400 path may have written anything.
      expect((await getProjects()).projects).toEqual([]);
    });

    it('refuses $HOME itself — the dialog starts there and could otherwise add it', async () => {
      const { status, body } = await post({ root: '~' });
      expect(status).toBe(400);
      expect(body.error).toContain('home directory');
      expect((await getProjects()).projects).toEqual([]);
    });

    it('hosted mode: a folder outside browseRoot is refused, one inside is registered', async () => {
      // Hosted narrows `/api/v1/fs/browse` to browseRoot; the register route
      // re-checks the same containment, or a hand-made POST would walk around
      // the narrowing entirely.
      const checkoutRoot = join(home, 'checkouts');
      const inside = join(checkoutRoot, 'app');
      mkdirSync(inside, { recursive: true });
      await mergeWriteWorkspaceConfig((config) => {
        config.browseRoot = checkoutRoot;
      });
      process.env.CEZ_REMOTE = '1';
      const refused = await post({ root: otherRoot });
      expect(refused.status).toBe(400);
      // The message must not name the root it is protecting (fs-browse's rule).
      expect(refused.body.error).not.toContain(checkoutRoot);
      expect((await getProjects()).projects).toEqual([]);
      const allowed = await post({ root: inside });
      expect(allowed.status).toBe(200);
      expect(allowed.body.project.root).toBe(await realpath(inside));
    });

    it('hosted mode: an out-of-root path answers identically whether or not it exists', async () => {
      // The containment check runs BEFORE the stat, so a remote caller cannot
      // use the route as an existence oracle — probing `/etc/nginx` vs
      // `/etc/nope` must not map the host layout the browse root hides.
      const checkoutRoot = join(home, 'checkouts');
      mkdirSync(checkoutRoot, { recursive: true });
      await mergeWriteWorkspaceConfig((config) => {
        config.browseRoot = checkoutRoot;
      });
      process.env.CEZ_REMOTE = '1';
      const exists = await post({ root: otherRoot }); // real folder, outside
      const absent = await post({ root: join(otherRoot, 'nope') }); // never existed
      expect(exists.status).toBe(400);
      expect(absent).toEqual(exists);
      // …and neither leaks the probed spelling back (the `no such folder`
      // message echoes it; the containment one deliberately does not).
      expect(absent.body.error).not.toContain('nope');
      expect((await getProjects()).projects).toEqual([]);
    });

    it('hosted mode: a missing folder INSIDE the root still says so, not "outside"', async () => {
      // The uniform out-of-root answer above must not cost message accuracy in
      // the root the caller is actually allowed to use. Containment is asked
      // lexically before the stat (so existence stays unobservable outside the
      // root) and by realpath after it (so symlink escapes still fail) — which
      // leaves an in-root typo free to get the honest `no such folder`.
      const checkoutRoot = join(home, 'checkouts');
      mkdirSync(checkoutRoot, { recursive: true });
      await mergeWriteWorkspaceConfig((config) => {
        config.browseRoot = checkoutRoot;
      });
      process.env.CEZ_REMOTE = '1';
      const typo = join(checkoutRoot, 'my-porject');
      const answer = await post({ root: typo });
      expect(answer.status).toBe(400);
      expect(answer.body.error).toBe(`no such folder: ${typo}`);
      expect((await getProjects()).projects).toEqual([]);
    });

    it('hosted mode: a symlink inside the root pointing out of it is refused', async () => {
      // The realpath half of containment, which only the post-stat check can
      // catch: this path spells as inside the checkout root and is not.
      const checkoutRoot = join(home, 'checkouts');
      mkdirSync(checkoutRoot, { recursive: true });
      await mergeWriteWorkspaceConfig((config) => {
        config.browseRoot = checkoutRoot;
      });
      const escape = join(checkoutRoot, 'escape');
      symlinkSync(otherRoot, escape);
      process.env.CEZ_REMOTE = '1';
      const answer = await post({ root: escape });
      expect(answer.status).toBe(400);
      expect(answer.body.error).toBe('folder is outside the browsable root');
      expect((await getProjects()).projects).toEqual([]);
    });
  });

  /**
   * Phase 5 (spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`, D4/D5/D7/D8) — the
   * `project_teams` mapping's enforcement AT REGISTRATION: a project root belongs to exactly one
   * org, checked and claimed through `POST /api/v1/projects` itself. The negative control for all
   * of this is the very last `describe` below: `CEZ_AUTH` unset must exercise NONE of it.
   */
  describe('/api/v1/projects — org-boundary enforcement + team annotation (Phase 5, D4/D5)', () => {
    const savedAuth = process.env.CEZ_AUTH;

    beforeEach(() => {
      process.env.CEZ_AUTH = 'oidc';
    });

    afterEach(() => {
      if (savedAuth === undefined) delete process.env.CEZ_AUTH;
      else process.env.CEZ_AUTH = savedAuth;
    });

    /** Two real orgs, each with its atomic default team, in a REAL `IdentityStore` rooted at this
     *  test's `CEZ_HOME` (pinned in the outer `beforeEach`) — the registration route opens its own
     *  second `IdentityStore` instance at the same directory (mirrors `auth/routes.ts`'s own
     *  precedent, `session.ts`'s doc comment on why), so this is exactly what it reads. */
    const seedOrgs = async () => {
      const { IdentityStore } = await import('../auth/identity-store.ts');
      const store = IdentityStore.open(identityDir());
      const a = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const b = await store.createOrg({ name: 'Beta', slug: 'beta' });
      return { store, orgA: a.org, teamA: a.defaultTeam, orgB: b.org, teamB: b.defaultTeam };
    };

    /** A `SessionResolver` stand-in, mirroring `auth-perimeter.test.ts`'s `recordingResolver`: maps
     *  a fixed cookie value to a fixed `Principal` with no real OIDC round trip. The middleware that
     *  turns a cookie into a `Principal` is covered there; these tests are about what the
     *  registration ROUTE does once a principal already exists. */
    const principalResolver = (byCookie: Record<string, Principal>): SessionResolver => ({
      resolveFromCookieHeader: (cookie) => (cookie ? (byCookie[cookie] ?? null) : null),
    });

    const postAs = async (body: unknown, cookie: string, sessionResolver: SessionResolver) => {
      const res = await apiRequest(makeApp({ sessionResolver }), '/api/v1/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      });
      return {
        status: res.status,
        body: (await res.json()) as RegisterProjectResponse & { error?: string },
      };
    };

    it('claims an unclaimed root for the signing-in org and reports its team on the 200', async () => {
      const { orgA, teamA } = await seedOrgs();
      const principalA: Principal = { kind: 'session', userId: 'u-a', orgId: orgA.id, teamId: teamA.id, role: 'owner' };
      const resolver = principalResolver({ 'cez_session=a': principalA });

      const { status, body } = await postAs({ root: otherRoot }, 'cez_session=a', resolver);
      expect(status).toBe(200);
      expect(body.project.teamId).toBe(teamA.id);
    });

    it('refuses a second org registering the SAME root — D4 (one root, one org)', async () => {
      const { orgA, teamA, orgB, teamB } = await seedOrgs();
      const principalA: Principal = { kind: 'session', userId: 'u-a', orgId: orgA.id, teamId: teamA.id, role: 'owner' };
      const principalB: Principal = { kind: 'session', userId: 'u-b', orgId: orgB.id, teamId: teamB.id, role: 'owner' };
      const resolver = principalResolver({ 'cez_session=a': principalA, 'cez_session=b': principalB });

      const first = await postAs({ root: otherRoot }, 'cez_session=a', resolver);
      expect(first.status).toBe(200);

      const second = await postAs({ root: otherRoot }, 'cez_session=b', resolver);
      expect(second.status).toBe(409);
      expect(second.body.error).toBe('this project is already registered to a different organization');
      // The registry itself is untouched by the refused attempt: still ONE entry, org A's. Read
      // the registry directly rather than through `getProjects()` — that helper's own GET route
      // sits behind the SAME auth middleware, and asserting through it would need its own
      // `sessionResolver`, which is not what this assertion is about.
      expect((await loadWorkspaceConfig()).projects).toHaveLength(1);
    });

    it('re-registering the SAME root as the SAME org is the ordinary idempotent 409, not the org-conflict one', async () => {
      const { orgA, teamA } = await seedOrgs();
      const principalA: Principal = { kind: 'session', userId: 'u-a', orgId: orgA.id, teamId: teamA.id, role: 'owner' };
      const resolver = principalResolver({ 'cez_session=a': principalA });

      const first = await postAs({ root: otherRoot }, 'cez_session=a', resolver);
      expect(first.status).toBe(200);
      const again = await postAs({ root: otherRoot }, 'cez_session=a', resolver);
      expect(again.status).toBe(409);
      expect(again.body.error).toContain('already registered as');
      expect(again.body.project.teamId).toBe(teamA.id);
    });

    it(
      'the org-boundary refusal is not dodged by a trailing slash or a symlink spelling of the ' +
        'claimed root — a relative spelling is refused earlier, by the same absolute-path gate every ' +
        'other caller hits (workspace/projects.test.ts covers relative-path AND case-differing ' +
        'dedup directly against `registerProject`, below the HTTP layer\'s absolute-path requirement)',
      async () => {
        const { orgA, teamA, orgB, teamB } = await seedOrgs();
        const principalA: Principal = { kind: 'session', userId: 'u-a', orgId: orgA.id, teamId: teamA.id, role: 'owner' };
        const principalB: Principal = { kind: 'session', userId: 'u-b', orgId: orgB.id, teamId: teamB.id, role: 'owner' };
        const resolver = principalResolver({ 'cez_session=a': principalA, 'cez_session=b': principalB });

        const claimed = await postAs({ root: otherRoot }, 'cez_session=a', resolver);
        expect(claimed.status).toBe(200);

        const link = join(home, 'linked-elsewhere');
        symlinkSync(otherRoot, link);

        for (const spelling of [`${otherRoot}/`, link]) {
          const { status, body } = await postAs({ root: spelling }, 'cez_session=b', resolver);
          expect(status, spelling).toBe(409);
          expect(body.error, spelling).toBe('this project is already registered to a different organization');
        }
        expect((await loadWorkspaceConfig()).projects).toHaveLength(1);
      },
    );

    it('claims a LEGACY root (registered before auth existed) on its first authenticated touch', async () => {
      // `registerProject` called directly, the way `cezar serve`'s boot registration or a pre-auth
      // install already did — no `project_teams` row exists for it yet.
      const legacy = await registerProject(otherRoot);
      const { orgA, teamA } = await seedOrgs();
      const principalA: Principal = { kind: 'session', userId: 'u-a', orgId: orgA.id, teamId: teamA.id, role: 'owner' };
      const resolver = principalResolver({ 'cez_session=a': principalA });

      const { status, body } = await postAs({ root: otherRoot }, 'cez_session=a', resolver);
      // Same root, already registered — the ordinary idempotent 409 (workspace layer), but the
      // identity layer still claims it for org A in the SAME request.
      expect(status).toBe(409);
      expect(body.project.id).toBe(legacy.id);
      expect(body.project.teamId).toBe(teamA.id);
      const identityStore = (await import('../auth/identity-store.ts')).IdentityStore.open(identityDir());
      expect(identityStore.getProjectTeam(legacy.root)?.orgId).toBe(orgA.id);
    });

    it('rejects an explicit teamId from a different org (400, nothing persisted), and honors one from the same org', async () => {
      const { store, orgA, teamA, teamB } = await seedOrgs();
      const secondTeamInOrgA = await store.createTeam({ orgId: orgA.id, name: 'Platform', slug: 'platform' });
      const principalA: Principal = { kind: 'session', userId: 'u-a', orgId: orgA.id, teamId: teamA.id, role: 'owner' };
      const resolver = principalResolver({ 'cez_session=a': principalA });

      const wrongOrg = await postAs({ root: otherRoot, teamId: teamB.id }, 'cez_session=a', resolver);
      expect(wrongOrg.status).toBe(400);
      expect(wrongOrg.body.error).toContain('unknown team');
      expect((await loadWorkspaceConfig()).projects).toEqual([]); // refused before any write

      const sameOrg = await postAs({ root: otherRoot, teamId: secondTeamInOrgA.id }, 'cez_session=a', resolver);
      expect(sameOrg.status).toBe(200);
      expect(sameOrg.body.project.teamId).toBe(secondTeamInOrgA.id);
    });

    it('CEZ_AUTH unset: creates no identity.json and ignores a stray teamId field (D1 zero-I/O control)', async () => {
      delete process.env.CEZ_AUTH;
      const res = await apiRequest(makeApp(), '/api/v1/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root: otherRoot, teamId: 'whatever' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as RegisterProjectResponse;
      expect(body.project.teamId).toBeUndefined();
      expect(existsSync(join(home, 'identity'))).toBe(false);
    });

    /**
     * The WRITE verbs on an ALREADY-registered row (ADDED 2026-08-07, repair stage). Phase 5
     * enforced D4's one-root-one-org mapping on `POST` and nowhere else, so a second org could
     * `DELETE` the first org's registration — reproduced at review: `DELETE` answered 200, the
     * registry emptied, and the orphaned `project_teams` row survived and then blocked
     * re-registration. Enforced on create, ignored on destroy, is not a constraint.
     */
    describe('DELETE / PATCH /api/v1/projects/:projectId — the same org boundary', () => {
      const removeAs = async (id: string, cookie: string, sessionResolver: SessionResolver) => {
        const res = await apiRequest(makeApp({ sessionResolver }), `/api/v1/projects/${id}`, {
          method: 'DELETE',
          headers: { cookie },
        });
        return { status: res.status, body: (await res.json()) as { error?: string; removed?: boolean } };
      };

      const patchAs = async (id: string, cookie: string, sessionResolver: SessionResolver) => {
        const res = await apiRequest(makeApp({ sessionResolver }), `/api/v1/projects/${id}`, {
          method: 'PATCH',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ maxParallel: 4 }),
        });
        return { status: res.status, body: (await res.json()) as { error?: string } };
      };

      it("refuses another org's DELETE and leaves the registration standing", async () => {
        const { store: identity, orgA, teamA, orgB, teamB } = await seedOrgs();
        const claimed = await registerProject(otherRoot);
        await identity.createProjectTeam({ projectRoot: claimed.root, orgId: orgA.id, teamId: teamA.id });

        const principalB: Principal = { kind: 'session', userId: 'u-b', orgId: orgB.id, teamId: teamB.id, role: 'owner' };
        const { status, body } = await removeAs(claimed.id, 'cez_session=b', principalResolver({ 'cez_session=b': principalB }));
        expect(status).toBe(409);
        expect(body.error).toBe('this project is already registered to a different organization');
        expect((await loadWorkspaceConfig()).projects.map((p) => p.id)).toEqual([claimed.id]);
        expect(identity.getProjectTeam(claimed.root)?.orgId).toBe(orgA.id);
      });

      it("refuses another org's PATCH of the concurrency ceiling", async () => {
        const { store: identity, orgA, teamA, orgB, teamB } = await seedOrgs();
        const claimed = await registerProject(otherRoot);
        await identity.createProjectTeam({ projectRoot: claimed.root, orgId: orgA.id, teamId: teamA.id });

        const principalB: Principal = { kind: 'session', userId: 'u-b', orgId: orgB.id, teamId: teamB.id, role: 'owner' };
        const { status, body } = await patchAs(claimed.id, 'cez_session=b', principalResolver({ 'cez_session=b': principalB }));
        expect(status).toBe(409);
        expect(body.error).toBe('this project is already registered to a different organization');
        expect((await loadWorkspaceConfig()).projects[0]?.maxParallel).toBeUndefined();
      });

      it("releases the org's claim when its OWN delete succeeds, so the root can be re-registered with a different team", async () => {
        const { store: identity, orgA, teamA } = await seedOrgs();
        const second = await identity.createTeam({ orgId: orgA.id, name: 'Platform', slug: 'platform' });
        const principalA: Principal = { kind: 'session', userId: 'u-a', orgId: orgA.id, teamId: teamA.id, role: 'owner' };
        const resolver = principalResolver({ 'cez_session=a': principalA });

        const registered = await postAs({ root: otherRoot }, 'cez_session=a', resolver);
        expect(registered.status).toBe(200);
        expect(registered.body.project.teamId).toBe(teamA.id);
        const id = registered.body.project.id;
        const root = registered.body.project.root;

        const removed = await removeAs(id, 'cez_session=a', resolver);
        expect(removed.status).toBe(200);
        // The orphan is the bug: left behind, `project_teams` grows a row per removed project AND
        // the explicit `teamId` on the re-registration below is silently discarded in favour of
        // the stale claim (`server.ts` prefers an existing claim, correctly — which is exactly why
        // a dead one must not survive).
        expect(identity.getProjectTeam(root)).toBeUndefined();

        const again = await postAs({ root: otherRoot, teamId: second.id }, 'cez_session=a', resolver);
        expect(again.status).toBe(200);
        expect(again.body.project.teamId).toBe(second.id);
      });

      it('CEZ_AUTH unset: DELETE touches no identity state at all, even with a claim on the root (D1 zero-I/O control)', async () => {
        const { IdentityStore } = await import('../auth/identity-store.ts');
        const identity = IdentityStore.open(identityDir());
        // Ids chosen to match `resolvePrincipal({ authProvider: 'none' })`'s own `orgId`/`teamId`,
        // the same reasoning as the listing control below: a row an auth-off request WOULD match
        // if the `principal.kind` guard were dropped, so the control can actually fail.
        await identity.createOrg({ name: 'Local', slug: 'local' }, { orgId: 'local', defaultTeamId: 'local' });
        const claimed = await registerProject(otherRoot);
        await identity.createProjectTeam({ projectRoot: claimed.root, orgId: 'local', teamId: 'local' });

        delete process.env.CEZ_AUTH;
        const res = await apiRequest(makeApp(), `/api/v1/projects/${claimed.id}`, { method: 'DELETE' });
        expect(res.status).toBe(200);
        // Unregistered as always — and the claim is NOT released, because auth-off never reads or
        // writes identity state. Byte-identical to the pre-Phase-5 behaviour.
        expect((await loadWorkspaceConfig()).projects).toEqual([]);
        expect(identity.getProjectTeam(claimed.root)?.orgId).toBe('local');
      });
    });

    /**
     * The LISTING half of the same mapping. Without it `teamId`/`teamName` would be populated only
     * by the registration response — the cockpit's team filter (D5, `settings/projects-section.tsx`)
     * would have data for exactly the project you just added and none after a reload, i.e. a
     * feature that is load-bearing but never actually reachable.
     */
    describe('GET /api/v1/projects', () => {
      const listAs = async (cookie: string, sessionResolver: SessionResolver): Promise<ProjectsResponse> => {
        const res = await apiRequest(makeApp({ sessionResolver }), '/api/v1/projects', { headers: { cookie } });
        expect(res.status).toBe(200);
        return (await res.json()) as ProjectsResponse;
      };

      it("annotates a root claimed by the caller's own org with teamId AND teamName, and leaves an unclaimed root bare", async () => {
        const { store: identity, orgA, teamA } = await seedOrgs();
        const unclaimed = mkdtempSync(join(realpathSync(tmpdir()), 'cez-projects-unclaimed-'));
        const claimed = await registerProject(otherRoot);
        const bare = await registerProject(unclaimed);
        await identity.createProjectTeam({ projectRoot: claimed.root, orgId: orgA.id, teamId: teamA.id });

        const principalA: Principal = { kind: 'session', userId: 'u-a', orgId: orgA.id, teamId: teamA.id, role: 'owner' };
        const { projects } = await listAs('cez_session=a', principalResolver({ 'cez_session=a': principalA }));

        const claimedEntry = projects.find((p) => p.id === claimed.id);
        // `teamName`, not just the id: the filter's option labels come from here, and there is no
        // "list teams" route for a client to join the raw id against (D5 adds no team surface).
        expect(claimedEntry?.teamId).toBe(teamA.id);
        expect(claimedEntry?.teamName).toBe(teamA.name);

        const bareEntry = projects.find((p) => p.id === bare.id);
        expect(bareEntry).toBeDefined();
        expect(bareEntry?.teamId).toBeUndefined();
        expect(bareEntry?.teamName).toBeUndefined();
        rmSync(unclaimed, { recursive: true, force: true });
      });

      it("still LISTS a root claimed by another org, but never carries that org's team id or name", async () => {
        // Annotation, not scoping: D4 makes cross-org isolation a process boundary that phase 6
        // delivers, so a filtered listing here would read as an isolation control while every
        // other route stays open. What must not happen is org B learning org A's team.
        const { store: identity, orgA, teamA, orgB, teamB } = await seedOrgs();
        const claimed = await registerProject(otherRoot);
        await identity.createProjectTeam({ projectRoot: claimed.root, orgId: orgA.id, teamId: teamA.id });

        const principalB: Principal = { kind: 'session', userId: 'u-b', orgId: orgB.id, teamId: teamB.id, role: 'owner' };
        const { projects } = await listAs('cez_session=b', principalResolver({ 'cez_session=b': principalB }));

        const entry = projects.find((p) => p.id === claimed.id);
        expect(entry).toBeDefined();
        expect(entry?.teamId).toBeUndefined();
        expect(entry?.teamName).toBeUndefined();
        expect(JSON.stringify(projects)).not.toContain(teamA.id);
        expect(JSON.stringify(projects)).not.toContain(teamA.name);
      });

      /**
       * D1's control for the listing. The seeded row's ids are `'local'` DELIBERATELY: that is
       * exactly `resolvePrincipal({ authProvider: 'none' })`'s `orgId`/`teamId`
       * (`auth/principal.ts`), so this row is the one a `CEZ_AUTH`-unset request WOULD match if
       * `withTeams`' `principal.kind !== 'session'` guard were dropped. Seeding an ordinary org's
       * row instead would leave the assertion passing under that mutation for the uninteresting
       * reason that no id matched — a control that cannot fail. Verified by mutation: removing the
       * `kind` check turns this test red and leaves the rest of the file green.
       */
      it("CEZ_AUTH unset: a project_teams row matching the LOCAL principal's own ids is still never read (D1 zero-I/O control)", async () => {
        const { IdentityStore } = await import('../auth/identity-store.ts');
        const identity = IdentityStore.open(identityDir());
        await identity.createOrg({ name: 'Local', slug: 'local' }, { orgId: 'local', defaultTeamId: 'local' });
        const claimed = await registerProject(otherRoot);
        await identity.createProjectTeam({ projectRoot: claimed.root, orgId: 'local', teamId: 'local' });

        delete process.env.CEZ_AUTH;
        const { projects } = await getProjects();
        expect(projects).toHaveLength(1);
        expect(projects[0]?.teamId).toBeUndefined();
        expect(projects[0]?.teamName).toBeUndefined();
      });

      it('CEZ_AUTH unset on a clean home: listing creates no identity directory at all (D7)', async () => {
        await registerProject(otherRoot);
        delete process.env.CEZ_AUTH;
        const { projects } = await getProjects();
        expect(projects).toHaveLength(1);
        expect(existsSync(join(home, 'identity'))).toBe(false);
      });
    });
  });

  describe('DELETE /api/v1/projects/:projectId — Settings → Projects remove (step 4.4)', () => {
    /** Every file under `dir`, path → contents. The removal contract is "no file on disk is
     *  touched", so the assertion has to be about FILES, not just about the root surviving. */
    const snapshot = (dir: string): Record<string, string> => {
      const out: Record<string, string> = {};
      const walk = (current: string, prefix: string): void => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const child = join(current, entry.name);
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(child, rel);
          else out[rel] = readFileSync(child, 'utf8');
        }
      };
      walk(dir, '');
      return out;
    };

    it('refuses removal in single-project mode before registry or context side effects', async () => {
      const other = await registerProject(otherRoot);
      const contexts = new ProjectContexts({ listProjects });
      process.env.CEZ_SINGLE_PROJECT = '1';

      const { status, body } = await del(other.id, { contexts });

      expect(status).toBe(409);
      expect(body).toEqual({
        error: 'single-project mode is enabled; removing projects is disabled',
      });
      expect((await loadWorkspaceConfig()).projects.map((project) => project.id)).toEqual([
        other.id,
      ]);
      expect(contexts.peek(other.id)).toBeUndefined();
      contexts.disposeAll();
    });

    const del = async (id: string, over: Partial<ServerDeps> = {}) => {
      const res = await apiRequest(makeApp(over), `/api/v1/projects/${id}`, {
        method: 'DELETE',
      });
      return {
        status: res.status,
        body: (await res.json()) as {
          error?: string;
          removed?: boolean;
          id?: string;
          runningTasks?: number;
        },
      };
    };

    it('deregisters the project, emits project-removed, and leaves every file on disk untouched', async () => {
      // A realistic project: source, git metadata, and its own cezar state — the three things a
      // user would be devastated to lose behind a button labelled "Remove".
      mkdirSync(join(otherRoot, '.git'), { recursive: true });
      mkdirSync(join(otherRoot, '.ai/cezar/runs'), { recursive: true });
      writeFileSync(join(otherRoot, 'README.md'), '# keep me\n', 'utf8');
      writeFileSync(join(otherRoot, '.git/HEAD'), 'ref: refs/heads/main\n', 'utf8');
      writeFileSync(join(otherRoot, '.ai/cezar/runs.json'), '[]\n', 'utf8');
      clearProjectProbeCache();
      const other = await registerProject(otherRoot);
      const before = snapshot(otherRoot);

      const bus = new WorkspaceEventBus();
      const seen: { event: string; data: unknown }[] = [];
      bus.on((event, data) => seen.push({ event, data }));
      const { status, body } = await del(other.id, { workspaceEvents: bus });

      expect(status).toBe(200);
      expect(body).toEqual({ removed: true, id: other.id });
      // Gone from the registry…
      expect((await getProjects()).projects.map((p) => p.id)).not.toContain(other.id);
      // …and NOTHING else changed. This is the whole promise of the button.
      expect(snapshot(otherRoot)).toEqual(before);
      // The sidebar's live update (step 2.8 → global-events.tsx) hangs off this event.
      expect(seen).toEqual([{ event: 'project-removed', data: { id: other.id } }]);
    });

    it('409s while the project has running tasks, and removes nothing', async () => {
      const contexts = new ProjectContexts({ listProjects });
      const other = await registerProject(otherRoot);
      // Build the context the way a first API touch would, THEN put a live run in its store —
      // seeding first would make `manager.recover()` resume it, which is not what is under test.
      await contexts.context(other.id);
      const ctx = contexts.peek(other.id);
      expect(ctx).toBeDefined();
      const run = ctx!.store.createRun({
        title: 'live',
        workflow: 'quick-task',
        task: 'x',
        steps: [],
      });
      expect(run.status).toBe('queued'); // one of the three statuses the engine still owns

      const refused = await del(other.id, { contexts });
      expect(refused.status).toBe(409);
      expect(refused.body.runningTasks).toBe(1);
      expect(refused.body.error).toMatch(/running task/);
      // Still registered, and its context is still alive — a refused removal must be a no-op.
      expect((await getProjects()).projects.map((p) => p.id)).toContain(other.id);
      expect(contexts.peek(other.id)).toBeDefined();

      // Settle the run and the same call succeeds — the 409 is about live work, not about the
      // project having history.
      ctx!.store.updateRun(run.id, { status: 'done' });
      const allowed = await del(other.id, { contexts });
      expect(allowed.status).toBe(200);
      // The store/manager handles are dropped with the entry (step 2.1's dispose).
      expect(contexts.peek(other.id)).toBeUndefined();
      contexts.disposeAll();
    });

    it('404s an unknown id and a malformed one, without touching the registry', async () => {
      const other = await registerProject(otherRoot);
      for (const id of ['nope', 'Not%20A%20Slug', 'a'.repeat(120)]) {
        const { status, body } = await del(id);
        expect(status, id).toBe(404);
        expect(body.error, id).toContain('unknown project');
      }
      expect((await getProjects()).projects.map((p) => p.id)).toEqual([other.id]);
    });

    it('refuses the boot project (and its `default` alias) — it re-registers itself at every start', async () => {
      const boot = await registerProject(repoRoot);
      for (const id of [boot.id, 'default']) {
        const { status, body } = await del(id);
        expect(status, id).toBe(409);
        expect(body.error, id).toContain('re-registers');
      }
      expect((await getProjects()).projects.map((p) => p.id)).toEqual([boot.id]);
    });
  });

  describe('PATCH /api/v1/projects/:projectId — per-project maxParallel (2026-07-22)', () => {
    /** A semaphore whose refresh() is observable — the route MUST call it so a
     *  new ceiling applies without a restart (mirrors PUT /api/v1/workspace/config). */
    const countingSemaphore = () => {
      let refreshes = 0;
      const semaphore = new WorkspaceSemaphore({
        load: () => {
          refreshes += 1;
          return Promise.resolve({ maxParallel: 2, memoryLimitMb: null });
        },
      });
      return { semaphore, refreshes: () => refreshes };
    };

    const patch = async (id: string, body: unknown, over: Partial<ServerDeps> = {}) => {
      const res = await apiRequest(makeApp(over), `/api/v1/projects/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return {
        status: res.status,
        body: (await res.json()) as UpdateProjectResponse & { error?: string },
      };
    };

    it('refuses edits in single-project mode before registry or semaphore side effects', async () => {
      const other = await registerProject(otherRoot);
      const before = readFileSync(workspaceConfigPath(), 'utf8');
      const { semaphore, refreshes } = countingSemaphore();
      process.env.CEZ_SINGLE_PROJECT = '1';

      const { status, body } = await patch(other.id, { maxParallel: 1 }, { semaphore });

      expect(status).toBe(409);
      expect(body).toEqual({
        error: 'single-project mode is enabled; editing projects is disabled',
      });
      expect(readFileSync(workspaceConfigPath(), 'utf8')).toBe(before);
      expect(refreshes()).toBe(0);
    });

    it('sets the per-project value, persists it, and refreshes the semaphore', async () => {
      const other = await registerProject(otherRoot);
      const { semaphore, refreshes } = countingSemaphore();
      const { status, body } = await patch(other.id, { maxParallel: 1 }, { semaphore });
      expect(status).toBe(200);
      expect(body.project.id).toBe(other.id);
      expect(body.project.maxParallel).toBe(1);
      // Persisted to the registry, and reachable through the read route.
      const listed = await getProjects();
      expect(listed.projects.find((p) => p.id === other.id)?.maxParallel).toBe(1);
      // The live-apply hook fired.
      expect(refreshes()).toBe(1);
    });

    it('clears the override when maxParallel is null (back to inherit)', async () => {
      await registerProject(otherRoot);
      await mergeWriteWorkspaceConfig((config) => {
        const entry = config.projects.find((p) => p.root === realpathSync(otherRoot));
        if (entry) entry.maxParallel = 4;
      });
      const other = (await getProjects()).projects.find((p) => p.root === realpathSync(otherRoot))!;
      expect(other.maxParallel).toBe(4);

      const { status, body } = await patch(other.id, { maxParallel: null });
      expect(status).toBe(200);
      expect(body.project.maxParallel).toBeUndefined();
      const listed = await getProjects();
      expect(listed.projects.find((p) => p.id === other.id)?.maxParallel).toBeUndefined();
    });

    it('rejects an out-of-range value with a 400 and persists nothing', async () => {
      const other = await registerProject(otherRoot);
      for (const bad of [{ maxParallel: 0 }, { maxParallel: 99 }, { maxParallel: 1.5 }, {}]) {
        const { status } = await patch(other.id, bad);
        expect(status, JSON.stringify(bad)).toBe(400);
      }
      expect((await getProjects()).projects.find((p) => p.id === other.id)?.maxParallel).toBeUndefined();
    });

    it('404s an unknown id and a malformed one, and rewrites nothing (read-first, like DELETE)', async () => {
      await registerProject(otherRoot);
      // The config bytes before any 404 PATCH — a well-formed-unknown id must not
      // rewrite the file (else a read-only home would 500 where 404 is honest).
      const before = readFileSync(workspaceConfigPath(), 'utf8');
      for (const id of ['nope', 'Not%20A%20Slug', 'a'.repeat(120)]) {
        const { status, body } = await patch(id, { maxParallel: 1 });
        expect(status, id).toBe(404);
        expect(body.error, id).toContain('unknown project');
      }
      expect(readFileSync(workspaceConfigPath(), 'utf8')).toBe(before);
    });

  });

  describe('GET /api/v1/health — additive projects + bootProject', () => {
    it('pins flagged health listings to the explicit boot identity', async () => {
      const boot = await registerProject(repoRoot);
      await registerProject(otherRoot);
      process.env.CEZ_SINGLE_PROJECT = '1';

      const body = await getHealth({ bootProjectId: boot.id });
      expect(body.projects).toEqual([{ id: boot.id, name: boot.name }]);
      expect(body.bootProject).toBe(boot.id);
    });

    it('keeps the pre-workspace shape byte-identical and adds only projects + bootProject', async () => {
      const boot = await registerProject(repoRoot);
      const other = await registerProject(otherRoot);
      const body = await getHealth();
      // The exact key set: every pre-existing field (BACKWARD_COMPATIBILITY.md
      // §2 — the bookmarklet contract) plus the two new additive fields, and
      // nothing else. `latestVersion` is absent while no update is known.
      expect(Object.keys(body).sort()).toEqual(
        [
          'bootProject',
          'capabilities',
          'checks',
          'defaultRunner',
          'forge',
          'projects',
          'repo',
          'repoRoot',
          'version',
        ].sort(),
      );
      // Pre-existing field values, unchanged by the workspace additions.
      expect(body.version).toBe('0.0.0-test');
      expect(body.repoRoot).toBe(repoRoot);
      expect(body.repo).toBeNull(); // tmp dir — not a git repo
      expect(Array.isArray(body.checks)).toBe(true);
      expect(body.defaultRunner).toBe('claude');
      expect(body.forge).toBeNull();
      expect(body.capabilities).toEqual({
        localHandoff: true,
        followups: false,
        singleProject: false,
        tokenMetrics: true,
        tokenUsageMetrics: true,
        costMetrics: true,
        knowledge: false,
        sources: false,
        notes: false,
        workspaceViews: false,
        notify: false,
        skills: true,
      });
      // New fields: registered projects enumerated, boot project named.
      expect(body.projects.map((p) => p.id).sort()).toEqual([boot.id, other.id].sort());
      expect(body.bootProject).toBe(boot.id);
    });

    it('health project entries carry id + name ONLY — never root (#431)', async () => {
      await registerProject(repoRoot);
      await registerProject(otherRoot);
      const body = await getHealth();
      expect(body.projects.length).toBeGreaterThan(0);
      for (const entry of body.projects) {
        expect(Object.keys(entry).sort()).toEqual(['id', 'name']);
      }
    });

    it("regression: the health payload never contains another project's absolute root", async () => {
      await registerProject(repoRoot);
      const other = await registerProject(otherRoot);
      const raw = JSON.stringify(await getHealth());
      // Health is CORS-open: a cross-origin reader must not learn the
      // absolute path (and thus username) of any registered project (#431).
      expect(raw).not.toContain(other.root);
      expect(raw).not.toContain(otherRoot);
    });

    it('hosted mode (CEZ_REMOTE=1): no absolute root at all — boot repo included (#431)', async () => {
      const boot = await registerProject(repoRoot);
      const other = await registerProject(otherRoot);
      process.env.CEZ_REMOTE = '1';
      const body = await getHealth();
      expect(body.repoRoot).toBe(basename(repoRoot)); // existing trim, untouched
      const raw = JSON.stringify(body);
      expect(raw).not.toContain(boot.root);
      expect(raw).not.toContain(other.root);
    });

    it('degrades to projects:[] with a slug bootProject when nothing is registered', async () => {
      const body = await getHealth();
      expect(body.projects).toEqual([]);
      expect(body.bootProject).toBe(allocateProjectSlug(repoRoot, []));
    });
  });
});
