import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IdentityStore } from '../auth/identity-store.ts';
import { invalidateLocalOrgIdentityCache } from '../auth/local-identity.ts';
import { identityDir } from '../paths.ts';
import { loadWorkspaceConfig } from './config.ts';
import { clearProjectProbeCache, registerProject } from './projects.ts';
import { runProjectsCommand, type ProjectsCommandIo } from './projects-cli.ts';

/**
 * `cezar projects` (spec 2026-07-20-multi-project-workspace, step 5.2): the
 * offline registry CLI. Every test pins `CEZ_HOME` to a temp dir — these cases
 * register and remove projects for real, and must never touch the developer's
 * own `~/.cezar`.
 */
describe('cezar projects CLI', () => {
  const originalHome = process.env.CEZ_HOME;
  let home: string;
  let repos: string;
  let io: ProjectsCommandIo & { out: string[]; err: string[] };

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-projects-cli-'));
    repos = mkdtempSync(join(realpathSync(tmpdir()), 'cez-projects-cli-repos-'));
    process.env.CEZ_HOME = home;
    clearProjectProbeCache();
    // FIX A1/A2 (D13 repair round 2): `add`/`remove` now touch `auth/local-identity.ts`'s
    // resolver — its cache is ONE global slot (see that module's own doc comment), not keyed per
    // `CEZ_HOME`, so a resolved answer from a PREVIOUS case in this file must not leak into this
    // one's fresh `CEZ_HOME`.
    invalidateLocalOrgIdentityCache();
    const out: string[] = [];
    const err: string[] = [];
    io = { out, err, log: (l) => out.push(l), error: (l) => err.push(l) };
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repos, { recursive: true, force: true });
    invalidateLocalOrgIdentityCache();
  });

  const run = (...args: string[]): Promise<number> =>
    runProjectsCommand(args, { defaultRoot: repos, env: {}, io });

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

  describe('list', () => {
    it('is the default subcommand and prints id, status and root per project', async () => {
      const root = makeRepo('shop');
      await registerProject(root);
      expect(await run()).toBe(0);
      const listing = io.out.join('\n');
      expect(listing).toMatch(/✓ shop\s+main\s+/);
      expect(listing).toContain(root);
      expect(listing).toContain('1 project(s)');
      expect(listing).toContain(join(home, 'config.json'));
    });

    it('marks a deleted root missing and a plain folder as not a git repo', async () => {
      await registerProject(makeDir('plain'));
      const doomed = makeDir('doomed');
      await registerProject(doomed);
      rmSync(doomed, { recursive: true, force: true });
      clearProjectProbeCache();
      expect(await run('list')).toBe(0);
      const listing = io.out.join('\n');
      expect(listing).toMatch(/· plain\s+not a git repo/);
      expect(listing).toMatch(/✗ doomed\s+missing/);
    });

    it('explains the empty registry instead of printing an empty table', async () => {
      expect(await run()).toBe(0);
      expect(io.out.join('\n')).toContain('no projects registered yet');
    });

    it('pins listing to an explicit boot project while preserving default listings', async () => {
      const boot = await registerProject(makeRepo('boot'));
      await registerProject(makeRepo('other'));

      expect(await runProjectsCommand([], { defaultRoot: repos, bootProjectId: boot.id, io })).toBe(0);
      expect(io.out.join('\n')).toContain('boot');
      expect(io.out.join('\n')).not.toContain('other');

      io.out.length = 0;
      expect(await run()).toBe(0);
      expect(io.out.join('\n')).toContain('boot');
      expect(io.out.join('\n')).toContain('other');
    });
  });

  describe('add', () => {
    it('registers a folder and reports the allocated slug', async () => {
      const root = makeRepo('billing');
      expect(await run('add', root)).toBe(0);
      expect(io.out.join('\n')).toContain(`+ billing  ${root}`);
      expect((await loadWorkspaceConfig()).projects.map((p) => p.id)).toEqual(['billing']);
    });

    it('defaults to the resolved --repo/cwd root when no dir is given', async () => {
      expect(await run('add')).toBe(0);
      expect((await loadWorkspaceConfig()).projects[0]?.root).toBe(repos);
    });

    it('dedupes a symlinked spelling and says the project is already registered', async () => {
      const root = makeRepo('web');
      const link = join(repos, 'web-link');
      symlinkSync(root, link);
      await run('add', root);
      expect(await run('add', link)).toBe(0);
      expect(io.out.join('\n')).toContain('= web (already registered)');
      expect((await loadWorkspaceConfig()).projects).toHaveLength(1);
    });

    it('exits 1 on a path that is not a directory', async () => {
      const file = join(repos, 'note.txt');
      writeFileSync(file, 'x', 'utf8');
      expect(await run('add', file)).toBe(1);
      expect(io.err.join('\n')).toContain('not a directory');
      expect((await loadWorkspaceConfig()).projects).toEqual([]);
    });

    it('refuses a task worktree and $HOME, exactly like boot registration', async () => {
      const worktree = makeDir('host', '.ai', 'cezar', 'worktrees', 'abc12345');
      expect(await run('add', worktree)).toBe(1);
      expect(await run('add', homedir())).toBe(1);
      expect(io.err.join('\n')).toContain('refusing to register');
      expect((await loadWorkspaceConfig()).projects).toEqual([]);
    });

    // FIX A1 (D13 repair round 2, `.ai/specs/2026-08-06-org-team-auth-onboarding.md`): round 1
    // wired local-org adoption into boot registration only — `cezar projects add` never filed a
    // project under an already-existing local org. This is the CLI-level regression control.
    it('files a newly-added project under an already-existing local org', async () => {
      const identity = IdentityStore.open(identityDir());
      const { user } = await identity.findOrCreateLocalUser();
      const { org, defaultTeam } = await identity.claimOrg({ userId: user.id, name: 'Solo', slug: 'solo' });

      const root = makeRepo('billing');
      expect(await run('add', root)).toBe(0);

      const entry = (await loadWorkspaceConfig()).projects.find((p) => p.id === 'billing');
      expect(entry).toBeDefined();
      expect(identity.getProjectTeam(entry!.root)).toEqual({
        projectRoot: entry!.root,
        orgId: org.id,
        teamId: defaultTeam.id,
      });
    });
  });

  describe('remove', () => {
    it('drops the registry entry and leaves every repo file in place', async () => {
      const root = makeRepo('kept');
      writeFileSync(join(root, 'precious.txt'), 'data', 'utf8');
      const before = readdirSync(root).sort();
      const entry = await registerProject(root);
      expect(await run('remove', entry.id)).toBe(0);
      expect(io.out.join('\n')).toContain('- kept (registry entry only');
      expect((await loadWorkspaceConfig()).projects).toEqual([]);
      expect(readdirSync(root).sort()).toEqual(before);
    });

    it('exits 1 for an unknown id and for a missing id argument', async () => {
      expect(await run('remove', 'nope')).toBe(1);
      expect(io.err.join('\n')).toContain('unknown project: nope');
      expect(await run('remove')).toBe(1);
      expect(io.err.join('\n')).toContain('cezar projects remove <id>');
    });

    // FIX A2 (D13 repair round 2): removal never released the `project_teams` claim, orphaning it
    // — which makes the claiming org's team (and, if it was the last one, the whole org)
    // permanently undeletable through the product. This is the CLI-level regression control.
    it("releases the project's org claim on removal, unblocking the org's team for deletion afterward", async () => {
      const entry = await registerProject(makeRepo('claimed'));
      const identity = IdentityStore.open(identityDir());
      const { user } = await identity.findOrCreateLocalUser();
      const { org, defaultTeam } = await identity.claimOrg({ userId: user.id, name: 'Solo', slug: 'solo' });
      await identity.createProjectTeam({ projectRoot: entry.root, orgId: org.id, teamId: defaultTeam.id });

      expect(await run('remove', entry.id)).toBe(0);

      expect(identity.getProjectTeam(entry.root)).toBeUndefined();
      // Before this fix, this would throw `team-has-projects` — the orphaned claim FIX A2 closes.
      await expect(identity.deleteTeam(defaultTeam.id)).rejects.toThrow(); // still the org's LAST team (team-is-last)
      const secondTeam = await identity.createTeam({ orgId: org.id, name: 'Spare', slug: 'spare' });
      await expect(identity.deleteTeam(defaultTeam.id)).resolves.toBeUndefined();
      expect(identity.getTeamById(secondTeam.id)).toBeDefined();
    });
  });

  describe('single-project mode', () => {
    it('refuses add before path validation and leaves the registry unchanged', async () => {
      const existing = await registerProject(makeRepo('existing'));

      expect(
        await runProjectsCommand(['add', join(repos, 'does-not-exist')], {
          defaultRoot: repos,
          env: { CEZ_SINGLE_PROJECT: '1' },
          io,
        }),
      ).toBe(1);
      expect(io.err).toEqual(['single-project mode is enabled; adding projects is disabled']);
      expect((await loadWorkspaceConfig()).projects.map((project) => project.id)).toEqual([existing.id]);
    });

    it.each(['remove', 'rm'])(
      'refuses %s before argument validation and leaves the registry unchanged',
      async (subcommand) => {
        const existing = await registerProject(makeRepo('existing'));

        expect(
          await runProjectsCommand([subcommand], {
            defaultRoot: repos,
            env: { CEZ_SINGLE_PROJECT: '1' },
            io,
          }),
        ).toBe(1);
        expect(io.err).toEqual(['single-project mode is enabled; removing projects is disabled']);
        expect((await loadWorkspaceConfig()).projects.map((project) => project.id)).toEqual([existing.id]);
      },
    );

    it('preserves list behavior and requires the exact value 1 to refuse mutations', async () => {
      const existing = await registerProject(makeRepo('existing'));

      expect(
        await runProjectsCommand(['list'], {
          defaultRoot: repos,
          bootProjectId: existing.id,
          env: { CEZ_SINGLE_PROJECT: '1' },
          io,
        }),
      ).toBe(0);
      expect(io.out.join('\n')).toContain('existing');

      io.out.length = 0;
      expect(
        await runProjectsCommand(['add', makeRepo('allowed')], {
          defaultRoot: repos,
          env: { CEZ_SINGLE_PROJECT: 'true' },
          io,
        }),
      ).toBe(0);
      expect((await loadWorkspaceConfig()).projects.map((project) => project.id)).toEqual(['existing', 'allowed']);
    });

    it('does not expose the registry when boot project identity is unavailable', async () => {
      await registerProject(makeRepo('hidden'));

      expect(
        await runProjectsCommand(['list'], {
          defaultRoot: repos,
          env: { CEZ_SINGLE_PROJECT: '1' },
          io,
        }),
      ).toBe(0);
      expect(io.out.join('\n')).toContain('no projects registered yet');
      expect(io.out.join('\n')).not.toContain('hidden');
    });
  });

  it('exits 1 with the usage block on an unknown subcommand', async () => {
    expect(await run('frobnicate')).toBe(1);
    expect(io.err.join('\n')).toContain('unknown projects subcommand: frobnicate');
    expect(io.err.join('\n')).toContain('cezar projects [list]');
  });

  it('documents the single-project mutation restriction in usage output', async () => {
    expect(await run('frobnicate')).toBe(1);
    expect(io.err.join('\n')).toContain('add/remove are unavailable when CEZ_SINGLE_PROJECT=1');
  });
});
