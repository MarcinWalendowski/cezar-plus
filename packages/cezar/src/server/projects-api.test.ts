import { execFileSync } from 'node:child_process';
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_TAGS_MAX, PROJECT_TAG_MAX_LENGTH } from '@loki-labs/better-cezar-contract';
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
import { localCliAuthor } from '../runs/task-author.ts';

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
  capabilities: {
    localHandoff: boolean;
    followups: boolean;
    singleProject: boolean;
    automations: boolean;
    tokenMetrics: boolean;
  };
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
      // A real repo with a commit, not a bare `.git` directory (2026-08-15): `ok` is the answer for
      // a repo an agent can actually take a worktree of, and a commitless one now reports
      // `no-commits` — so a `.git`-only fixture would be asserting `ok` about the one shape that
      // does not earn it.
      execFileSync('git', ['init', '-b', 'main'], { cwd: otherRoot });
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'first'], {
        cwd: otherRoot,
      });
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

    /**
     * The reported bug, `.ai/specs/2026-08-15-duplicate-project-context-wipes-runs.md`: booting
     * on `repoRoot` and then registering that SAME root through this route used to find no
     * registry match (the boot project deliberately carries no row of its own — D3,
     * `suppressBootRegistration`) and allocate a FRESH slug for it — a second registry row over
     * the identical `.ai/cezar`. `ProjectContexts.build()` then opens a SECOND `RunStore` over the
     * same `runs.json` the boot context's own store already owns: two independent in-memory
     * copies of one file, and whichever flushes last (its own 300ms debounce, or shutdown)
     * truncates the other's writes away.
     *
     * Mutation: drop the boot-root short-circuit in `registerFolder` — this then observes a fresh
     * slug (and the registry gaining a row) instead of the boot identity.
     */
    it("registering the boot repo's own root is idempotent: 200 with the boot identity, no registry write, no event", async () => {
      const bus = new WorkspaceEventBus();
      const seen: string[] = [];
      bus.on((event) => seen.push(event));
      const expectedBootId = allocateProjectSlug(repoRoot, []);

      const { status, body } = await post({ root: repoRoot }, { workspaceEvents: bus });

      expect(status).toBe(200);
      expect(body.project.id).toBe(expectedBootId);
      expect(body.project.root).toBe(await realpath(repoRoot));
      expect(body.error).toBeUndefined();
      // Not a new project — no event, no registry row.
      expect(seen).toEqual([]);
      expect((await loadWorkspaceConfig()).projects).toEqual([]);
      expect((await getProjects()).projects).toEqual([]);
    });

    it("registering the boot repo's own root normalizes the same way every other dedupe does (trailing slash)", async () => {
      const expectedBootId = allocateProjectSlug(repoRoot, []);
      const { status, body } = await post({ root: `${repoRoot}/` });
      expect(status).toBe(200);
      expect(body.project.id).toBe(expectedBootId);
      expect((await loadWorkspaceConfig()).projects).toEqual([]);
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

      const patchAs = async (id: string, cookie: string, sessionResolver: SessionResolver, patchBody: unknown = { maxParallel: 4 }) => {
        const res = await apiRequest(makeApp({ sessionResolver }), `/api/v1/projects/${id}`, {
          method: 'PATCH',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify(patchBody),
        });
        return { status: res.status, body: (await res.json()) as UpdateProjectResponse & { error?: string } };
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

      /**
       * 5c (D2/D4, `.ai/specs/2026-08-06-org-team-auth-onboarding.md`, Fill unit 3, ADDED
       * 2026-08-07): `PATCH /api/v1/projects/:projectId`'s `teamId` field — reassigning an
       * already-claimed root to a different team WITHIN its owning org. The cross-org write
       * refusal tests just above already cover `mayActOnRoot` generically (it runs before this
       * field is even read); the tests here are about the reassignment itself. Nested here (not a
       * sibling describe) so `patchAs`/`seedOrgs`/`principalResolver`/`postAs` are in scope.
       */
      describe('PATCH /api/v1/projects/:projectId — teamId reassignment (5c)', () => {
      it("reassigns to a different team in the caller's own org, and the response reports it back (withTeams)", async () => {
        const { store: identity, orgA, teamA } = await seedOrgs();
        const engineering = await identity.createTeam({ orgId: orgA.id, name: 'Engineering', slug: 'engineering' });
        const claimed = await registerProject(otherRoot);
        await identity.createProjectTeam({ projectRoot: claimed.root, orgId: orgA.id, teamId: teamA.id });

        const principalA: Principal = { kind: 'session', userId: 'u-a', orgId: orgA.id, teamId: teamA.id, role: 'owner' };
        const { status, body } = await patchAs(claimed.id, 'cez_session=a', principalResolver({ 'cez_session=a': principalA }), {
          teamId: engineering.id,
        });
        expect(status).toBe(200);
        expect(body.project.teamId).toBe(engineering.id);
        expect(body.project.teamName).toBe('Engineering');
        // and the org claim itself never moved (D4) — read back from the store directly.
        expect(identity.getProjectTeam(claimed.root)?.orgId).toBe(orgA.id);
      });

      it("refuses moving a root to a team from a DIFFERENT org (409), and nothing changes", async () => {
        const { store: identity, orgA, teamA, teamB } = await seedOrgs();
        const claimed = await registerProject(otherRoot);
        await identity.createProjectTeam({ projectRoot: claimed.root, orgId: orgA.id, teamId: teamA.id });

        const principalA: Principal = { kind: 'session', userId: 'u-a', orgId: orgA.id, teamId: teamA.id, role: 'owner' };
        const { status, body } = await patchAs(claimed.id, 'cez_session=a', principalResolver({ 'cez_session=a': principalA }), {
          teamId: teamB.id,
        });
        expect(status).toBe(409);
        expect(body.error).toContain('outside its own organization');
        expect(identity.getProjectTeam(claimed.root)?.teamId).toBe(teamA.id);
      });

      it('refuses an unknown teamId (400), and nothing changes', async () => {
        const { store: identity, orgA, teamA } = await seedOrgs();
        const claimed = await registerProject(otherRoot);
        await identity.createProjectTeam({ projectRoot: claimed.root, orgId: orgA.id, teamId: teamA.id });

        const principalA: Principal = { kind: 'session', userId: 'u-a', orgId: orgA.id, teamId: teamA.id, role: 'owner' };
        const { status, body } = await patchAs(claimed.id, 'cez_session=a', principalResolver({ 'cez_session=a': principalA }), {
          teamId: 'does-not-exist',
        });
        expect(status).toBe(400);
        expect(body.error).toContain('unknown team');
        expect(identity.getProjectTeam(claimed.root)?.teamId).toBe(teamA.id);
      });

      it('refuses reassigning a root with NO existing team claim (400) — this reassigns, it does not create one', async () => {
        const { orgA, teamA } = await seedOrgs();
        // Registered as a plain workspace entry, never claimed by an org (no `project_teams` row).
        const unclaimed = await registerProject(otherRoot);

        const principalA: Principal = { kind: 'session', userId: 'u-a', orgId: orgA.id, teamId: teamA.id, role: 'owner' };
        const { status, body } = await patchAs(unclaimed.id, 'cez_session=a', principalResolver({ 'cez_session=a': principalA }), {
          teamId: teamA.id,
        });
        expect(status).toBe(400);
        expect(body.error).toContain('never claimed');
      });

      it("CEZ_AUTH unset: teamId is REJECTED (400), not silently ignored — unlike POST's registration-time field", async () => {
        const claimed = await registerProject(otherRoot);
        delete process.env.CEZ_AUTH;
        const res = await apiRequest(makeApp(), `/api/v1/projects/${claimed.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ teamId: 'whatever' }),
        });
        expect(res.status).toBe(400);
        expect(existsSync(join(home, 'identity'))).toBe(false); // zero I/O — the field was rejected, not looked up
      });

      it("another org's caller cannot reassign the team either — the SAME mayActOnRoot gate as maxParallel", async () => {
        const { store: identity, orgA, teamA, orgB, teamB } = await seedOrgs();
        const claimed = await registerProject(otherRoot);
        await identity.createProjectTeam({ projectRoot: claimed.root, orgId: orgA.id, teamId: teamA.id });

        const principalB: Principal = { kind: 'session', userId: 'u-b', orgId: orgB.id, teamId: teamB.id, role: 'owner' };
        const { status, body } = await patchAs(claimed.id, 'cez_session=b', principalResolver({ 'cez_session=b': principalB }), {
          teamId: teamB.id,
        });
        expect(status).toBe(409);
        expect(body.error).toBe('this project is already registered to a different organization');
        expect(identity.getProjectTeam(claimed.root)?.teamId).toBe(teamA.id);
      });

      /**
       * **CORRECTED 2026-08-14.** This asserted `{}` was a 200 no-op, and had been failing since
       * `31e48bed` (global Tasks + repository tags) gave `updateProjectInputSchema` a `.refine`
       * requiring one of `maxParallel` / `tags` / `teamId`. The refine is the later and better
       * decision — a PATCH that names nothing is a caller bug, and 400 says so — so the expectation
       * moves to match it rather than the refine being weakened back.
       *
       * The half of the original claim worth keeping is the SECOND half: a body that stays silent
       * about `teamId` must not attempt a team write. That is now pinned below on a body that names
       * something else, which is where it was always the more interesting assertion — an empty body
       * never reaches the write at all.
       */
      it('a body naming nothing is refused — 400, and the registration is untouched', async () => {
        const { store: identity, orgA, teamA } = await seedOrgs();
        const claimed = await registerProject(otherRoot);
        await identity.createProjectTeam({ projectRoot: claimed.root, orgId: orgA.id, teamId: teamA.id });

        const principalA: Principal = { kind: 'session', userId: 'u-a', orgId: orgA.id, teamId: teamA.id, role: 'owner' };
        const { status } = await patchAs(claimed.id, 'cez_session=a', principalResolver({ 'cez_session=a': principalA }), {});
        expect(status).toBe(400);
        expect(identity.getProjectTeam(claimed.root)?.teamId).toBe(teamA.id);
      });

      it('a body silent about teamId leaves the team exactly as it was — no team write attempted', async () => {
        const { store: identity, orgA, teamA } = await seedOrgs();
        const claimed = await registerProject(otherRoot);
        await identity.createProjectTeam({ projectRoot: claimed.root, orgId: orgA.id, teamId: teamA.id });

        const principalA: Principal = { kind: 'session', userId: 'u-a', orgId: orgA.id, teamId: teamA.id, role: 'owner' };
        const { status, body } = await patchAs(claimed.id, 'cez_session=a', principalResolver({ 'cez_session=a': principalA }), {
          maxParallel: 3,
        });
        expect(status).toBe(200);
        expect(body.project.maxParallel).toBe(3);
        expect(body.project.teamId).toBe(teamA.id);
        expect(identity.getProjectTeam(claimed.root)?.teamId).toBe(teamA.id);
      });
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
       * D1's control for the listing. **CORRECTED 2026-08-07 by D13: two statements below are now
       * FALSE, and the control's own named mutation may no longer kill it.** The seeded row's ids
       * were `'local'` because that used to be exactly `resolvePrincipal({ authProvider: 'none'
       * })`'s `orgId`/`teamId`; D13 invariant 3 (`auth/principal.ts#LOCAL_IDENTITY`) makes that
       * pair `null`/`null` instead — a `null` orgId/teamId is never coerced to the string `'local'`,
       * precisely so it can never collide with a real row. And `withTeams` (`server/server.ts`)
       * no longer has a `principal.kind !== 'session'` guard to drop — D13 replaced it with
       * `!hasOrgScope(principal)`, which narrows `orgId`/`teamId` from `string | null` to `string`.
       * So "removing the `kind` check turns this test red" no longer describes an available
       * mutation, and the row this test seeds (`orgId: 'local'`) can no longer be the one a real
       * `CEZ_AUTH`-unset principal would match even if `hasOrgScope`'s check were deleted outright:
       * `principal.orgId` would be `null`, `project_teams.org_id` is `NOT NULL` (Data Models), and
       * `listProjectTeams({ orgId: null })` filters on `row.orgId === null`, which is unsatisfiable
       * by construction — no row can ever have a `null` org id to match. **This control is very
       * likely VACUOUS post-D13**: the assertions below still pass, but for the same
       * "no id matched" reason this comment used to name as the failure mode a well-formed control
       * must avoid. Left as-is rather than quietly rewritten — the fix (if wanted) is a THIRD
       * negative control keyed on D13's actual local-org case: seed a row under a real onboarded
       * local org's `(orgId, teamId)` and assert a differently-scoped or pre-onboarding request
       * still doesn't read it. Not made here: the spec that requested this fix pass scoped it to
       * comments only and forbade changing this file's assertions.
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

  /**
   * ADDED 2026-08-07 (D13 repair): the sibling "no `<CEZ_HOME>/identity` directory is created"
   * controls above (this file's own D1 zero-I/O controls, incl. the listing one at
   * `"CEZ_AUTH unset: a project_teams row matching the LOCAL principal's own ids is still never
   * read"`) still pass, but their own comments now say why that no longer proves what they claim:
   * `withTeams`'s guard moved from `principal.kind !== 'session'` to `hasOrgScope(principal)`
   * (`orgId !== null && teamId !== null`), and `resolvePrincipal({ authProvider: 'none' })`'s
   * implicit identity carries `orgId: null` (D13 invariant 3 — never the string `'local'`). Since
   * `project_teams.org_id` is `NOT NULL` (Data Models), NO seeded row can ever have a `null` org
   * id to match — so `listProjectTeams({ orgId: null })` returns `[]` whether the guard runs or
   * is deleted outright. The "matching row" shape those controls use is unfalsifiable for D13's
   * actual local-no-org case, not merely stale.
   *
   * **This is a NEW control, not a fix to those** (that file's own comment says the fix, if
   * wanted, is a THIRD control — this is it) — and their assertions are left untouched.
   *
   * **Why "make it fatal" catches `mayActOnRoot`/`releaseRootClaim`/`registerFolder`'s claim
   * block but structurally CANNOT catch `withTeams` itself, and that gap is left open rather
   * than hidden:** `IdentityStore`'s read methods (`listProjectTeams`, `listTeams`, `getProjectTeam`,
   * …) are documented and implemented to "always [read] fresh off disk, never throw, never create
   * state" (`identity-store.ts`'s own `// ---- reads ----` section) — `readSnapshot` degrades a
   * missing OR unreadable OR corrupt file to an empty snapshot inside its own `catch`, by design,
   * so that a damaged identity store never takes down an unrelated request. `withTeams` then wraps
   * its own registry calls in a SECOND catch-all ("Best-effort, not a security check … degrades to
   * the unannotated listing rather than failing the whole request", `server.ts`). Two independent
   * swallow layers mean NO booby trap on `<CEZ_HOME>/identity` can make a bypassed `withTeams`
   * guard observable through the listing response — not as a thrown error (both catches eat it)
   * and not as leaked team data (no row can ever match a `null` orgId either). A black-box HTTP
   * control cannot see a `withTeams`-only guard failure post-D13, full stop.
   *
   * What CAN be made observable: `hasOrgScope` is the ONE shared predicate behind five call sites
   * (D13's own text), and the other four are not read-only/self-swallowing the way `withTeams` is —
   * `registerFolder`'s claim block calls `registry.createProjectTeam` (a WRITE, propagated
   * uncaught past `IdentityStoreError`-only handling in `project-team-registry.ts`), and
   * `releaseRootClaim` calls `registry.deleteProjectTeam` with **no** try/catch at all ("Unlike
   * `withTeams`, a failure here is deliberately NOT swallowed", `server.ts`'s own comment). Both
   * bottom out in `IdentityStore`'s write plumbing (`guardedWrite` → `writeSnapshot`), whose last
   * step, `renameSync(tmp, path)`, is unguarded and throws `EISDIR` if `identity.json` is a
   * DIRECTORY rather than a file (verified directly against Node's `fs` before relying on it — see
   * the trap's own comment below for the fuller account, including a FIRST trap shape — `identity/`
   * itself as a plain file — that was tried, ran, and rejected because it also broke the correct,
   * unmutated code: every auth-off request `statSync`s `identity.json` during principal resolution
   * alone, before any route runs, and re-throws anything but `ENOENT`). So: with `CEZ_AUTH` unset
   * and no local org, `principal.orgId` is really `null` and every one of these five call sites
   * must see `hasOrgScope` return `false` and never reach the write path at all. If any of them
   * stopped checking it, the very next write attempt hits the trap and the request fails loudly —
   * proven below by actually deleting the check and watching it fail (see this session's report for
   * the verbatim mutation output).
   */
  describe('CEZ_AUTH unset, no org: identity storage booby-trapped so any WRITE attempt is fatal (D13)', () => {
    const savedAuth = process.env.CEZ_AUTH;

    afterEach(() => {
      if (savedAuth === undefined) delete process.env.CEZ_AUTH;
      else process.env.CEZ_AUTH = savedAuth;
    });

    /**
     * `<CEZ_HOME>/identity/identity.json` as a DIRECTORY, not a file — not `identity/` itself as a
     * plain file. That first shape was tried and rejected here (empirically, not by inspection):
     * every auth-off request — including a request no mutation is even under test on — resolves
     * its principal through `resolveLocalOrgIdentity` (`auth/local-identity.ts`), which
     * `statSync`s `identity.json` on EVERY call to fingerprint it for change-detection and
     * *deliberately* re-throws anything other than `ENOENT` ("a permissions problem is real and is
     * allowed to propagate", that module's own doc comment). Making `identity/` itself a file turns
     * that `statSync` into `ENOTDIR`, which is not `ENOENT`, so it throws on the FIRST line of
     * principal resolution for every request regardless of `hasOrgScope` — a trap that fires
     * whether or not the guard under test is even reached, catching nothing specific. Confirmed by
     * running it: all three requests below 500'd even against the unmodified, correct guard.
     *
     * `identity.json` as a directory clears that false positive: `statSync` on a directory succeeds
     * (it is a real, `stat`-able node), so fingerprinting is unaffected, and `IdentityStore`'s own
     * reads (`readSnapshot`'s `readFileSync`) degrade an `EISDIR` the same way they degrade a
     * missing or corrupt file — inside their own `catch`, silently, to an empty snapshot (see the
     * block comment above). Only a WRITE reaches the failure: `writeSnapshot`'s last step,
     * `renameSync(tmp, path)`, tries to rename a freshly-written temp file ONTO `identity.json` —
     * and POSIX `rename()` refuses to replace an existing directory with a file (`EISDIR`),
     * unguarded, propagating straight out of `guardedWrite` and past `project-team-registry.ts`'s
     * `IdentityStoreError`-only `catch` (a plain `EISDIR` is not an `IdentityStoreError`, so it
     * re-throws rather than swallows). Verified directly against Node's `fs` before relying on it.
     */
    const trapIdentityDir = () => {
      const dir = join(home, 'identity');
      mkdirSync(dir, { recursive: true });
      mkdirSync(join(dir, 'identity.json'));
    };

    it('POST /api/v1/projects (register) still returns its normal 200, never reaching the trap', async () => {
      trapIdentityDir();
      delete process.env.CEZ_AUTH;
      const res = await apiRequest(makeApp(), '/api/v1/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root: otherRoot }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as RegisterProjectResponse;
      expect(body.project.teamId).toBeUndefined();
    });

    it('DELETE /api/v1/projects/:id still returns its normal 200, never reaching the trap', async () => {
      const claimed = await registerProject(otherRoot);
      trapIdentityDir();
      delete process.env.CEZ_AUTH;
      const res = await apiRequest(makeApp(), `/api/v1/projects/${claimed.id}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { removed?: boolean };
      expect(body.removed).toBe(true);
    });

    // Included for completeness against the request set this control is named for, but — per the
    // block comment above — this one is NOT itself a mutation-killing negative control: a bypassed
    // `withTeams` guard is a pure read, both `readSnapshot` and `withTeams`'s own catch degrade any
    // failure silently, and no row can ever match a `null` orgId. This assertion can never turn red
    // from the mutation this describe block exists to catch; it only confirms the trap itself
    // doesn't collaterally break an unrelated GET.
    it('GET /api/v1/projects still returns its normal 200 (not a negative control — see comment above)', async () => {
      await registerProject(otherRoot);
      trapIdentityDir();
      delete process.env.CEZ_AUTH;
      const { projects } = await getProjects();
      expect(projects).toHaveLength(1);
    });
  });

  /**
   * Phase 6/7 (spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`, D4's phase-6 amendment,
   * D10) — the REPLACEMENT half: `CEZ_AUTH=supervisor` must route every D4 call site through
   * `supervisor/registry-client.ts` (a mocked HTTP round trip here — never a live server, per this
   * unit's safety rules) instead of `IdentityStore.open(identityDir())`. The `CEZ_AUTH=oidc` block
   * above already proves the LOCAL path is unchanged; this block proves the two paths are mutually
   * exclusive, not additive — a `CEZ_AUTH=supervisor` request must touch NO local identity state
   * at all, the same "zero I/O on the path that doesn't apply" discipline D1/D7 already hold for
   * the auth-off case, applied here to the OTHER process that must stay blind to this one.
   */
  describe('CEZ_AUTH=supervisor — the org process asks the supervisor, never the local IdentityStore (D10)', () => {
    const savedAuth = process.env.CEZ_AUTH;
    const savedPort = process.env.CEZ_SUPERVISOR_PORT;
    const savedSecret = process.env.CEZ_SUPERVISOR_SECRET;

    beforeEach(() => {
      process.env.CEZ_AUTH = 'supervisor';
      process.env.CEZ_SUPERVISOR_PORT = '4999';
      process.env.CEZ_SUPERVISOR_SECRET = 'test-supervisor-secret-value-0000';
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      if (savedAuth === undefined) delete process.env.CEZ_AUTH;
      else process.env.CEZ_AUTH = savedAuth;
      if (savedPort === undefined) delete process.env.CEZ_SUPERVISOR_PORT;
      else process.env.CEZ_SUPERVISOR_PORT = savedPort;
      if (savedSecret === undefined) delete process.env.CEZ_SUPERVISOR_SECRET;
      else process.env.CEZ_SUPERVISOR_SECRET = savedSecret;
    });

    const principalResolver = (byCookie: Record<string, Principal>): SessionResolver => ({
      resolveFromCookieHeader: (cookie) => (cookie ? (byCookie[cookie] ?? null) : null),
    });

    const orgA: Principal = { kind: 'session', userId: 'u-a', orgId: 'org_a', teamId: 'team_a', role: 'owner' };

    const fakeJsonResponse = (status: number, body: unknown) =>
      ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

    it('a successful registration never opens a local identity directory (no fetch fallback to IdentityStore)', async () => {
      // Ordered by what `registerFolder` actually does (server.ts): (1) pre-check the requested
      // root is unclaimed, (2) register locally (no fetch), (3) re-check + (4) POST the claim, (5)
      // `withTeams` reads the claim + the team name back. No explicit `teamId` in the request body
      // below, so `registerFolder` never calls `GET /internal/teams/:id` on this path.
      // Every shape below is the REAL one `supervisor/server.ts` answers with — deliberately not a
      // convenient approximation. An over-generous fake here is how the client/server drift this
      // seam already suffered once got in: a fake that answers 200 where the real route answers
      // 404/201, or answers a route the real supervisor does not serve at all, makes this test
      // prove the org process talks to a supervisor that does not exist.
      // `supervisor/server.test.ts` + `supervisor/registry-client.test.ts` pin these same shapes
      // against the real `createSupervisorApp`, so a drift fails there rather than only here.
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        // Unclaimed reads 404 on the real handler, never a 200 carrying `null`.
        if (method === 'GET' && url.startsWith('http://127.0.0.1:4999/internal/project-teams/by-root?')) {
          return fakeJsonResponse(404, { error: 'no org/team claim' });
        }
        // Success is 201 + `{ projectTeam }` — there is no `ok` field on the wire.
        if (method === 'POST' && url === 'http://127.0.0.1:4999/internal/project-teams') {
          return fakeJsonResponse(201, { projectTeam: { projectRoot: otherRoot, orgId: 'org_a', teamId: 'team_a' } });
        }
        if (method === 'GET' && url.startsWith('http://127.0.0.1:4999/internal/project-teams?')) {
          return fakeJsonResponse(200, { projectTeams: [{ projectRoot: otherRoot, orgId: 'org_a', teamId: 'team_a' }] });
        }
        if (method === 'GET' && url.startsWith('http://127.0.0.1:4999/internal/teams?')) {
          return fakeJsonResponse(200, { teams: [{ id: 'team_a', orgId: 'org_a', name: 'General', slug: 'general' }] });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);
      // Registration doesn't pass an explicit teamId — registerFolder falls back to principal.teamId
      // (`team_a`), so no /internal/teams/:id lookup happens on this path (see server.ts's
      // `if (teamId !== undefined)` guard) — only the create + read-back calls below fire.
      const res = await apiRequest(makeApp({ sessionResolver: principalResolver({ 'cez_session=a': orgA }) }), '/api/v1/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'cez_session=a' },
        body: JSON.stringify({ root: otherRoot }),
      });
      const createCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
      expect(createCall).toBeDefined();
      expect(String(createCall![0])).toBe('http://127.0.0.1:4999/internal/project-teams');
      expect((createCall![1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer test-supervisor-secret-value-0000' });
      expect(res.status).toBe(200);
      // The zero-cross-contamination half: nothing under this test's CEZ_HOME/identity exists —
      // the supervisor's own store is a DIFFERENT process's disk this org process never touches.
      expect(existsSync(join(home, 'identity'))).toBe(false);
    });

    it("mayActOnRoot fails CLOSED when the supervisor is unreachable — an unclaimed root's DELETE is refused, not silently allowed", async () => {
      const claimed = await registerProject(otherRoot);
      const fetchMock = vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await apiRequest(makeApp({ sessionResolver: principalResolver({ 'cez_session=a': orgA }) }), `/api/v1/projects/${claimed.id}`, {
        method: 'DELETE',
        headers: { cookie: 'cez_session=a' },
      });
      const body = (await res.json()) as { error?: string };
      // 409, the exact CROSS_ORG_REFUSAL wording — an unreachable registry must read the same as a
      // genuinely cross-org claim, never as "unclaimed, go ahead" (that would be the fail-OPEN
      // shape D4 exists to prevent).
      expect(res.status).toBe(409);
      expect(body.error).toBe('this project is already registered to a different organization');
      // Refused before the workspace registry write: the project is still registered.
      expect((await loadWorkspaceConfig()).projects.map((p) => p.id)).toEqual([claimed.id]);
    });

    it('withTeams degrades to the unannotated listing when the supervisor is unreachable, rather than 500ing the whole request', async () => {
      await registerProject(otherRoot);
      const fetchMock = vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await apiRequest(makeApp({ sessionResolver: principalResolver({ 'cez_session=a': orgA }) }), '/api/v1/projects', {
        headers: { cookie: 'cez_session=a' },
      });
      expect(res.status).toBe(200);
      const { projects } = (await res.json()) as ProjectsResponse;
      expect(projects).toHaveLength(1);
      expect(projects[0]?.teamId).toBeUndefined();
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
      const run = ctx!.store.createRun({ author: localCliAuthor(),
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
      for (const bad of [{ maxParallel: 0 }, { maxParallel: 99 }, { maxParallel: 1.5 }]) {
        const { status } = await patch(other.id, bad);
        expect(status, JSON.stringify(bad)).toBe(400);
      }
      expect((await getProjects()).projects.find((p) => p.id === other.id)?.maxParallel).toBeUndefined();
    });

    /**
     * CORRECTED 2026-08-07 (5c, Fill unit 3): `{}` used to be in the "bad" list above, because
     * `maxParallel` was a REQUIRED key — an empty body failed the validator's own presence check.
     * The 5c widening relaxed `maxParallel` to optional so a `teamId`-only PATCH doesn't have to
     * restate the ceiling, and that incidentally made `{}` parse.
     *
     * **SUPERSEDED 2026-08-13 by the upstream 0.9.3 merge (#845).** The 200 above was a
     * side effect of the 5c widening, not a decision: nothing wanted "empty PATCH = no-op", it
     * simply fell out of making every key optional. Upstream added an explicit `.refine` to
     * `updateProjectInputSchema` restoring the 400, and its reasoning is the one we want —
     * "a request that names no field is a mistake, and answering 200 to it would report a change
     * that never happened". The merged refine accepts a body naming `maxParallel`, `tags` OR
     * `teamId`, so the teamId-only PATCH the 5c widening was actually for keeps working; only the
     * genuinely empty body is refused. `BACKWARD_COMPATIBILITY.md` §2 states the 400, so leaving
     * this test asserting 200 would put our own build gate in contradiction with our own suite.
     */
    it('refuses an empty body with a 400 — naming no field is a mistake, not a no-op', async () => {
      const other = await registerProject(otherRoot);
      const { semaphore, refreshes } = countingSemaphore();
      const { status } = await patch(other.id, {}, { semaphore });
      expect(status).toBe(400);
      expect((await getProjects()).projects.find((p) => p.id === other.id)?.maxParallel).toBeUndefined();
      // Refused before any write — the live-apply hook must not fire for a rejected body.
      expect(refreshes()).toBe(0);
    });

    /** The widening 5c was actually for: a `teamId`-only body is legal and does NOT have to
     *  restate `maxParallel`. This is what the refine above must never start refusing. */
    it('accepts a teamId-only body — the refine must not narrow 5c back', async () => {
      const other = await registerProject(otherRoot);
      const { status } = await patch(other.id, { teamId: 'team-does-not-exist' });
      // 400 for the unknown team, NOT for a body that named no field — the distinction the
      // refine has to preserve. A schema-level rejection would answer before the handler runs.
      expect(status).toBe(400);
    });

    it('sets tags, normalized, and leaves maxParallel alone', async () => {
      await registerProject(otherRoot);
      await mergeWriteWorkspaceConfig((config) => {
        const entry = config.projects.find((p) => p.root === realpathSync(otherRoot));
        if (entry) entry.maxParallel = 3;
      });
      const other = (await getProjects()).projects.find((p) => p.root === realpathSync(otherRoot))!;

      const { status, body } = await patch(other.id, {
        tags: [' Storefront ', 'api', 'STOREFRONT'],
      });

      expect(status).toBe(200);
      // Trimmed by the schema, then deduped case-insensitively (first spelling wins) and
      // sorted by the normalizer.
      expect(body.project.tags).toEqual(['api', 'Storefront']);
      // A body that says nothing about maxParallel must not clear it.
      expect(body.project.maxParallel).toBe(3);
      const listed = await getProjects();
      expect(listed.projects.find((p) => p.id === other.id)?.tags).toEqual(['api', 'Storefront']);
    });

    it('clears tags on null and on [], storing no key at all', async () => {
      const other = await registerProject(otherRoot);
      await patch(other.id, { tags: ['api'] });
      for (const cleared of [null, []]) {
        await patch(other.id, { tags: ['api'] });
        const { status, body } = await patch(other.id, { tags: cleared });
        expect(status, JSON.stringify(cleared)).toBe(200);
        expect(body.project.tags, JSON.stringify(cleared)).toBeUndefined();
        // Absent, not `[]`: an untagged project costs nothing in the registry file.
        const raw = JSON.parse(readFileSync(workspaceConfigPath(), 'utf8')) as {
          projects: { id: string; tags?: unknown }[];
        };
        expect(Object.keys(raw.projects.find((p) => p.id === other.id)!)).not.toContain('tags');
      }
    });

    it('leaves tags alone for a maxParallel-only body (the pre-tags client)', async () => {
      const other = await registerProject(otherRoot);
      await patch(other.id, { tags: ['storefront'] });
      const { status, body } = await patch(other.id, { maxParallel: 2 });
      expect(status).toBe(200);
      expect(body.project.tags).toEqual(['storefront']);
      expect(body.project.maxParallel).toBe(2);
    });

    it('rejects a tag list the registry could not hold, and persists nothing', async () => {
      const other = await registerProject(otherRoot);
      const bodies = [
        { tags: ['x'.repeat(PROJECT_TAG_MAX_LENGTH + 1)] },
        { tags: Array.from({ length: PROJECT_TAGS_MAX + 1 }, (_, i) => `t${i}`) },
        { tags: [''] },
        { tags: 'storefront' },
      ];
      for (const bad of bodies) {
        const { status } = await patch(other.id, bad);
        expect(status, JSON.stringify(bad)).toBe(400);
      }
      expect((await getProjects()).projects.find((p) => p.id === other.id)?.tags).toBeUndefined();
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
      //
      // `runtime` joined the list on 2026-08-21 (spec
      // `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`, lines 449-450: "`GET
      // /api/v1/health` gains `deploy` … and `runtime`"). Adding it here rather than loosening
      // the assertion to a subset check is the point of this test — it is the tripwire that makes
      // every new health field a DELIBERATE edit to the documented contract, so a field that
      // arrives by accident still fails. Its sibling `deploy` is correctly absent: it ships only
      // when this process is running from a release tree with a ledger entry, which a tmp-dir
      // test never is.
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
          'runtime',
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
        automations: false,
        tokenMetrics: true,
        tokenUsageMetrics: true,
        costMetrics: true,
        knowledge: false,
        sources: false,
        notes: false,
        workspaceViews: true,
        notify: false,
        accountUsage: false,
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
