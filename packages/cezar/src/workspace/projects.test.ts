import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from './config.ts';
import {
  RESERVED_PROJECT_IDS,
  allocateProjectSlug,
  clearProjectProbeCache,
  listProjects,
  registerProject,
  removeProject,
  shouldRegisterProject,
} from './projects.ts';

/**
 * Project registry ops (spec 2026-07-20-multi-project-workspace, step 1.3):
 * realpath/symlink/trailing-slash dedupe, slug collision suffixes, the
 * reserved-slug skip (`default` → `default-2`), status probing
 * (ok/missing/not-git + branch), and the promise that register/remove never
 * write a byte inside the repo itself.
 */
describe('workspace projects', () => {
  const originalHome = process.env.CEZ_HOME;
  let home: string;
  let repos: string;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-workspace-'));
    repos = mkdtempSync(join(realpathSync(tmpdir()), 'cez-repos-'));
    process.env.CEZ_HOME = home; // paths.ts sends all workspace paths here
    clearProjectProbeCache();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repos, { recursive: true, force: true });
  });

  const makeDir = (...segments: string[]): string => {
    const dir = join(repos, ...segments);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  const makeRepo = (...segments: string[]): string => {
    const dir = makeDir(...segments);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'],
      { cwd: dir },
    );
    return dir;
  };

  describe('registerProject', () => {
    it('registers a new root with slug, name, timestamps and source', async () => {
      const root = makeDir('cezar');
      const entry = await registerProject(root);
      expect(entry).toMatchObject({ id: 'cezar', root, name: 'cezar', source: 'local' });
      expect(entry.addedAt).not.toBe('');
      expect(entry.lastOpenedAt).toBe(entry.addedAt);
      expect((await loadWorkspaceConfig()).projects).toEqual([entry]);
    });

    it('dedupes a trailing-slash spelling to the existing entry and bumps lastOpenedAt', async () => {
      const root = makeDir('api');
      const first = await registerProject(root);
      const again = await registerProject(`${root}/`);
      expect(again.id).toBe(first.id);
      expect(again.addedAt).toBe(first.addedAt);
      expect(Date.parse(again.lastOpenedAt)).toBeGreaterThanOrEqual(Date.parse(first.lastOpenedAt));
      expect((await loadWorkspaceConfig()).projects).toHaveLength(1);
    });

    it('dedupes a symlinked path to the realpath entry', async () => {
      const root = makeDir('real-repo');
      const link = join(repos, 'linked-repo');
      symlinkSync(root, link);
      const first = await registerProject(root);
      const viaLink = await registerProject(link);
      expect(viaLink.id).toBe(first.id);
      expect(viaLink.root).toBe(first.root);
      expect((await loadWorkspaceConfig()).projects).toHaveLength(1);
    });

    it('dedupes a relative-path spelling to the same absolute entry', async () => {
      const root = makeDir('relative-target');
      const first = await registerProject(root);
      const relativeSpelling = relative(process.cwd(), root);
      const again = await registerProject(relativeSpelling);
      expect(again.id).toBe(first.id);
      expect(again.root).toBe(first.root);
      expect((await loadWorkspaceConfig()).projects).toHaveLength(1);
    });

    it(
      'dedupes a case-differing spelling on a case-insensitive filesystem (spec ' +
        '2026-08-06-org-team-auth-onboarding, "the key is the REALPATH … a case-differing path on a ' +
        'case-insensitive filesystem must collapse to the same key") — normalizeRoot uses ' +
        "`fs/promises.realpath`, which is libuv-backed and returns the on-disk case; Node's " +
        'JS-implemented `fs.realpathSync` echoes the queried case back instead, and swapping ' +
        'normalizeRoot for it fails this test (verified by mutation, 2026-08-07)',
      async () => {
        const root = makeDir('CaseSensitiveName');
        const differentCase = `${root.slice(0, -'CaseSensitiveName'.length)}casesensitivename`;
        if (!existsSync(differentCase)) {
          // A genuinely case-sensitive filesystem (e.g. Linux ext4 in CI): the
          // differently-cased spelling does not exist, so there is nothing to
          // dedupe — the property under test does not apply here. Skipping
          // silently would look identical to a passing assertion, so assert
          // the precondition instead of just returning.
          expect(existsSync(differentCase)).toBe(false);
          return;
        }
        const first = await registerProject(root);
        const viaOtherCase = await registerProject(differentCase);
        expect(viaOtherCase.id).toBe(first.id);
        expect(viaOtherCase.root).toBe(first.root);
        expect((await loadWorkspaceConfig()).projects).toHaveLength(1);
      },
    );

    it('suffixes colliding slugs numerically (web, web-2)', async () => {
      const a = await registerProject(makeDir('one', 'web'));
      const b = await registerProject(makeDir('two', 'web'));
      const c = await registerProject(makeDir('three', 'web'));
      expect(a.id).toBe('web');
      expect(b.id).toBe('web-2');
      expect(c.id).toBe('web-3');
    });

    /** Spelled out rather than derived from `RESERVED_PROJECT_IDS`, and then checked against it in
     *  both directions below — deriving the loop from the set under test would make the set
     *  unfalsifiable (delete an entry and the loop simply stops testing it, green). */
    const EXPECTED_RESERVED = [
      'default',
      'new',
      'settings',
      'api',
      'p',
      'assets',
      // auth/login/callback/o/t: added by spec 2026-08-06-org-team-auth-onboarding
      // (D5) for the auth/onboarding routes and the future /o/<org>/, /t/<team>/
      // segments.
      'auth',
      'login',
      'callback',
      // `onboarding`: added 2026-08-07 (repair stage) once phase 4 made `/onboarding` a real
      // top-level cockpit segment, which the D5 reservation had not caught up with.
      'onboarding',
      'o',
      't',
      // `internal`: added 2026-08-07 (repair stage) — phase 7's generated org vhost declares
      // `location /internal/ { internal; }`, so nginx 404s that prefix before the org process ever
      // sees it. See `RESERVED_PROJECT_IDS`' own comment.
      'internal',
    ] as const;

    it('never allocates a reserved slug — a repo named default/ becomes default-2', async () => {
      for (const reserved of EXPECTED_RESERVED) {
        const entry = await registerProject(makeDir('reserved', reserved));
        expect(entry.id).toBe(`${reserved}-2`);
      }
    });

    it('the reserved set and the list exercised above are the SAME set, in both directions', () => {
      // Adding a slug to `RESERVED_PROJECT_IDS` without exercising it here, or dropping one from
      // the set while the list still names it, both fail here rather than passing quietly.
      expect([...RESERVED_PROJECT_IDS].sort()).toEqual([...EXPECTED_RESERVED].sort());
    });

    it('every path prefix the generated org vhost carves out is reserved (D5)', () => {
      // The mechanism, not a plausible proxy: these are the literal `location` prefixes
      // `server-install/platforms/hetzner/nginx.ts` writes for an org hostname. `/internal/` is
      // nginx-`internal;` (external 404) and `/auth/` proxies to the SUPERVISOR, so a project
      // holding either slug is unreachable in hosted mode while working fine locally. If that
      // generator grows a third carve-out, this list grows with it — and then this test fails
      // until the slug is reserved too.
      for (const prefix of ['internal', 'auth']) {
        expect(RESERVED_PROJECT_IDS.has(prefix)).toBe(true);
      }
    });

    it(
      'retroactive reservation is forward-only: an existing registry entry already holding a ' +
        'now-reserved slug still loads and resolves (spec 2026-08-06-org-team-auth-onboarding D5) ' +
        "— it is JSON on someone's disk and cannot be migrated out from under a new reservation",
      async () => {
        // Simulate a registry written before `auth` was reserved: push the entry
        // directly rather than through registerProject/allocateProjectSlug, which
        // would now refuse to hand out this id.
        const root = makeDir('legacy-auth-project');
        const legacyEntry = {
          id: 'auth',
          root,
          name: 'legacy-auth-project',
          addedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
          source: 'local' as const,
        };
        await mergeWriteWorkspaceConfig((config) => {
          config.projects.push(legacyEntry);
        });

        // It still loads via the raw config...
        expect((await loadWorkspaceConfig()).projects).toEqual([legacyEntry]);

        // ...and still resolves through listProjects, both unfiltered and pinned.
        const [listed] = await listProjects();
        expect(listed).toMatchObject({ id: 'auth', root, status: 'not-git' });
        expect((await listProjects({ projectId: 'auth' })).map((p) => p.id)).toEqual(['auth']);

        // A second, unrelated root registering fresh still gets steered off the
        // now-reserved slug — the legacy entry surviving does not un-reserve it.
        const fresh = await registerProject(makeDir('another-auth-repo', 'auth'));
        expect(fresh.id).toBe('auth-2');
      },
    );

    it('slugifies ugly basenames and keeps a checkout source', async () => {
      const entry = await registerProject(makeDir('My Repo!.git'), 'checkout');
      expect(entry.id).toBe('my-repo-git');
      expect(entry.source).toBe('checkout');
    });

    it('never writes any file inside the repo', async () => {
      const root = makeDir('untouched');
      writeFileSync(join(root, 'keep.txt'), 'keep', 'utf8');
      await registerProject(root);
      expect(readdirSync(root)).toEqual(['keep.txt']);
    });
  });

  describe('allocateProjectSlug', () => {
    it('falls back to "project" for a degenerate basename', () => {
      expect(allocateProjectSlug('/tmp/日本語', [])).toBe('project');
    });

    it('keeps suffixed slugs within the 64-char id cap', () => {
      const long = 'a'.repeat(80);
      const first = allocateProjectSlug(`/tmp/${long}`, []);
      expect(first).toBe('a'.repeat(64));
      const second = allocateProjectSlug(`/tmp/${long}`, [first]);
      expect(second).toBe(`${'a'.repeat(62)}-2`);
      expect(second).toHaveLength(64);
    });
  });

  describe('listProjects', () => {
    it('keeps default reads unchanged and pins explicit reads without pruning the registry', async () => {
      const first = await registerProject(makeDir('first'));
      const second = await registerProject(makeDir('second'));

      expect((await listProjects()).map((project) => project.id)).toEqual([first.id, second.id]);
      expect((await listProjects({ projectId: second.id })).map((project) => project.id)).toEqual([
        second.id,
      ]);
      expect((await loadWorkspaceConfig()).projects.map((project) => project.id)).toEqual([
        first.id,
        second.id,
      ]);
    });

    it('returns an empty pinned read when the selected id is not registered', async () => {
      await registerProject(makeDir('existing'));
      expect(await listProjects({ projectId: 'unknown' })).toEqual([]);
    });

    it('keeps boot registration self-healing while reads are pinned', async () => {
      const hidden = await registerProject(makeDir('hidden'));
      const boot = await registerProject(makeDir('boot'));

      expect((await listProjects({ projectId: boot.id })).map((project) => project.id)).toEqual([
        boot.id,
      ]);
      const registeredAgain = await registerProject(boot.root);
      expect(registeredAgain.id).toBe(boot.id);
      expect((await loadWorkspaceConfig()).projects.map((project) => project.id)).toEqual([
        hidden.id,
        boot.id,
      ]);
    });

    it('reports a git repo as ok with its current branch', async () => {
      const root = makeRepo('gitful');
      await registerProject(root);
      const [entry] = await listProjects();
      expect(entry).toMatchObject({ id: 'gitful', status: 'ok', branch: 'main' });
    });

    it('classifies a github.com remote as the github forge (#698)', async () => {
      const root = makeRepo('forged');
      execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/forged.git'], { cwd: root });
      await registerProject(root);
      const [entry] = await listProjects();
      expect(entry).toMatchObject({ status: 'ok', forge: 'github' });
    });

    it('omits forge for a non-github remote and for a remote-less repo', async () => {
      const gitlab = makeRepo('lab');
      execFileSync('git', ['remote', 'add', 'origin', 'git@gitlab.com:acme/lab.git'], { cwd: gitlab });
      const bare = makeRepo('loner');
      await registerProject(gitlab);
      await registerProject(bare);
      const entries = await listProjects();
      expect(entries.every((entry) => entry.forge === undefined)).toBe(true);
    });

    it('reports a deleted root as missing (after the probe TTL cache is cleared)', async () => {
      const root = makeDir('doomed');
      await registerProject(root);
      rmSync(root, { recursive: true, force: true });
      clearProjectProbeCache();
      const [entry] = await listProjects();
      expect(entry?.status).toBe('missing');
      expect(entry?.branch).toBeUndefined();
    });

    it('reports an existing non-git dir as not-git', async () => {
      await registerProject(makeDir('plain-folder'));
      const [entry] = await listProjects();
      expect(entry?.status).toBe('not-git');
      expect(entry?.branch).toBeUndefined();
    });

    it('serves a repeat render from the TTL cache instead of re-probing', async () => {
      const root = makeDir('cached');
      await registerProject(root);
      expect((await listProjects())[0]?.status).toBe('not-git');
      rmSync(root, { recursive: true, force: true });
      // Within the TTL the stale probe is served (no fs/git work per render)…
      expect((await listProjects())[0]?.status).toBe('not-git');
      // …and a cleared cache sees reality again.
      clearProjectProbeCache();
      expect((await listProjects())[0]?.status).toBe('missing');
    });
  });

  describe('removeProject', () => {
    it('unregisters by id and leaves every repo file untouched', async () => {
      const root = makeRepo('kept-repo');
      writeFileSync(join(root, 'precious.txt'), 'data', 'utf8');
      const before = readdirSync(root).sort();
      const entry = await registerProject(root);
      expect(await removeProject(entry.id)).toBe(true);
      expect((await loadWorkspaceConfig()).projects).toEqual([]);
      expect(readdirSync(root).sort()).toEqual(before);
      expect(execFileSync('git', ['-C', root, 'log', '--oneline'], { encoding: 'utf8' })).toContain('init');
    });

    it('returns false for an unknown id and keeps other entries', async () => {
      const entry = await registerProject(makeDir('survivor'));
      expect(await removeProject('no-such-project')).toBe(false);
      expect((await loadWorkspaceConfig()).projects.map((p) => p.id)).toEqual([entry.id]);
    });
  });

  describe('shouldRegisterProject (boot registration guards)', () => {
    it('allows a normal repo root', async () => {
      expect(await shouldRegisterProject(makeRepo('normal-repo'))).toBe(true);
    });

    it('suppresses a cezar task worktree root', async () => {
      const worktree = makeDir('host-repo', '.ai', 'cezar', 'worktrees', 'abc12345');
      expect(await shouldRegisterProject(worktree)).toBe(false);
    });

    it('suppresses a repo nested deeper inside a task worktree', async () => {
      const nested = join(repos, 'host', '.ai', 'cezar', 'worktrees', 'run-1', 'sub', 'repo');
      // Path need not exist — normalizeRoot degrades to resolve(); the guard
      // must still recognize the worktree marker on the raw spelling.
      expect(await shouldRegisterProject(nested)).toBe(false);
    });

    it('does not suppress a repo merely named like the marker pieces', async () => {
      expect(await shouldRegisterProject(makeDir('cezar-worktrees'))).toBe(true);
    });

    it('suppresses the home directory itself, in any spelling', async () => {
      expect(await shouldRegisterProject(homedir())).toBe(false);
      expect(await shouldRegisterProject(`${homedir()}/`)).toBe(false);
    });
  });
});
