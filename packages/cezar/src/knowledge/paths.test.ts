import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  containsPath,
  discoveredRoots,
  projectKnowledgeRoot,
  readKnowledgeMountConfig,
  resolveKnowledgeRoots,
  resolveWritablePath,
  shouldSkipDir,
  sourcesMountRoot,
  workspaceKnowledgeRoot,
} from './paths.ts';

// `os.tmpdir()` is itself behind a symlink on macOS (`/var` -> `/private/var`), so every fixture
// root is realpath'd up front — the same reason `vitest.setup.ts`'s sandbox home does it — or
// every "does the resolved target equal the path I expected" assertion below would be comparing
// two spellings of the same directory.
async function tempDir(prefix: string): Promise<string> {
  const base = await realpath(tmpdir());
  const dir = await mkdtemp(join(base, prefix));
  dirs.push(dir);
  return dir;
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('containsPath', () => {
  it('accepts the root itself and anything strictly beneath it', () => {
    expect(containsPath('/a/b', '/a/b')).toBe(true);
    expect(containsPath('/a/b', '/a/b/c')).toBe(true);
  });

  it('rejects a sibling whose name merely starts with the root (no separator boundary)', () => {
    expect(containsPath('/home/bob', '/home/bob-evil')).toBe(false);
  });
});

describe('resolveWritablePath — containment (fs-browse.ts discipline)', () => {
  it('rejects a NUL byte before touching the filesystem', async () => {
    const root = await tempDir('cez-kb-nul-');
    const result = await resolveWritablePath(root, 'a\0b.md');
    expect(result.ok).toBe(false);
  });

  it('C9: rejects lexical `../../etc/passwd` traversal', async () => {
    const root = await tempDir('cez-kb-trav-');
    const result = await resolveWritablePath(root, '../../etc/passwd');
    expect(result).toEqual({ ok: false, error: 'path is outside the writable root' });
  });

  it('C9: rejects an absolute escape outside the root', async () => {
    const root = await tempDir('cez-kb-abs-');
    const result = await resolveWritablePath(root, '/etc/passwd');
    expect(result).toEqual({ ok: false, error: 'path is outside the writable root' });
  });

  it('accepts a plain relative path that stays inside the root, including missing parent dirs', async () => {
    const root = await tempDir('cez-kb-ok-');
    const result = await resolveWritablePath(root, 'decisions/new-doc.md');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toBe(join(await realpath(root), 'decisions/new-doc.md'));
    }
  });

  it('C8: rejects a symlink inside the root pointing outside it (realpath gate), even though the lexical gate alone would pass it', async () => {
    const root = await tempDir('cez-kb-root-');
    const outside = await tempDir('cez-kb-outside-');
    await writeFile(join(outside, 'secret.md'), 'top secret', 'utf8');
    await symlink(outside, join(root, 'escape'));

    // The lexical spelling is entirely inside `root` — proving the realpath gate, not the lexical
    // one, is what has to catch this.
    const target = join(root, 'escape', 'secret.md');
    expect(containsPath(root, target)).toBe(true);

    const result = await resolveWritablePath(root, 'escape/secret.md');
    expect(result).toEqual({ ok: false, error: 'path is outside the writable root' });
  });

  it('C8, negative control: the SAME symlink escape is accepted if the realpath gate is skipped and only the lexical gate runs', async () => {
    // This is the negative control the spec asks for at C8: a check that proves the realpath gate
    // is load-bearing by showing the lexical-only version of the same logic gets it wrong.
    const root = await tempDir('cez-kb-root2-');
    const outside = await tempDir('cez-kb-outside2-');
    await writeFile(join(outside, 'secret.md'), 'top secret', 'utf8');
    await symlink(outside, join(root, 'escape'));

    const target = join(root, 'escape', 'secret.md');
    // Lexical-only containment (no realpath) — this is the bug the spec's C8 says must NOT ship.
    expect(containsPath(root, target)).toBe(true);
  });

  it('resolves a target under a root that does not exist yet at all (the first-write case)', async () => {
    const parent = await tempDir('cez-kb-lazy-');
    const root = join(parent, '.ai/cezar/knowledge'); // never created
    const result = await resolveWritablePath(root, 'notes/first.md');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.target).toBe(join(await realpath(parent), '.ai/cezar/knowledge/notes/first.md'));
  });

  it('accepts a write through a root that is itself a symlink (a symlinked checkout is not an escape)', async () => {
    const real = await tempDir('cez-kb-real-');
    const linkParent = await tempDir('cez-kb-linkparent-');
    const link = join(linkParent, 'root-link');
    await symlink(real, link);

    const result = await resolveWritablePath(link, 'doc.md');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.target).toBe(join(await realpath(real), 'doc.md'));
  });
});

describe('shouldSkipDir', () => {
  it('excludes conflicts/ and deleted/ by NAME at any depth (D18/C22) — not merely under sources/', () => {
    expect(shouldSkipDir('/repo/.ai/cezar/sources/conn/conflicts', 'conflicts')).toBe(true);
    expect(shouldSkipDir('/repo/.ai/cezar/sources/conn/deleted', 'deleted')).toBe(true);
    // A SECOND mirror root, at an entirely different path — the exclusion still fires, because it
    // is a basename rule, not a path prefix scoped to `sources/` (the exact hole D18 closes).
    expect(shouldSkipDir('/somewhere/else/mirror2/conflicts', 'conflicts')).toBe(true);
  });

  it('excludes node_modules, .git and friends at any depth', () => {
    expect(shouldSkipDir('/repo/a/b/node_modules', 'node_modules')).toBe(true);
    expect(shouldSkipDir('/repo/.git', '.git')).toBe(true);
  });

  it('does not exclude a legitimately named sibling directory', () => {
    expect(shouldSkipDir('/repo/docs/decisions', 'decisions')).toBe(false);
  });

  it('excludes the derived-index and worktree dirs by path suffix', () => {
    expect(shouldSkipDir('/repo/.ai/cezar/knowledge-index', 'knowledge-index')).toBe(true);
    expect(shouldSkipDir('/repo/.ai/cezar/worktrees', 'worktrees')).toBe(true);
    expect(shouldSkipDir('/repo/.claude/worktrees', 'worktrees')).toBe(true);
  });
});

describe('readKnowledgeMountConfig', () => {
  it('degrades to [] when the file is absent', async () => {
    const repoRoot = await tempDir('cez-kb-cfg-none-');
    expect(await readKnowledgeMountConfig(repoRoot)).toEqual([]);
  });

  it('degrades to [] when the file is malformed JSON, without throwing', async () => {
    const repoRoot = await tempDir('cez-kb-cfg-bad-');
    await mkdir(join(repoRoot, '.ai/cezar'), { recursive: true });
    await writeFile(join(repoRoot, '.ai/cezar/config.json'), '{ not json', 'utf8');
    expect(await readKnowledgeMountConfig(repoRoot)).toEqual([]);
  });

  it('reads the knowledge.mounts[] key and ignores every other key in the file (Q11)', async () => {
    const repoRoot = await tempDir('cez-kb-cfg-ok-');
    await mkdir(join(repoRoot, '.ai/cezar'), { recursive: true });
    await writeFile(
      join(repoRoot, '.ai/cezar/config.json'),
      JSON.stringify({
        maxParallel: 4, // an unrelated top-level key this reader must ignore, not choke on
        knowledge: { mounts: [{ id: 'memory', path: '~/notes/memory', format: 'strict-frontmatter' }] },
      }),
      'utf8',
    );
    expect(await readKnowledgeMountConfig(repoRoot)).toEqual([
      { id: 'memory', path: '~/notes/memory', format: 'strict-frontmatter' },
    ]);
  });
});

describe('resolveKnowledgeRoots', () => {
  it('lists the two writable roots as always indexed, even when their directories do not exist yet', async () => {
    const repoRoot = await tempDir('cez-kb-roots-empty-');
    const dataDir = join(repoRoot, '.ai/cezar');
    const cezHome = await tempDir('cez-kb-home-');
    const env = { CEZ_HOME: cezHome };
    const roots = await resolveKnowledgeRoots({ repoRoot, dataDir, env });
    const project = roots.find((r) => r.id === 'project');
    const workspace = roots.find((r) => r.id === 'workspace');
    expect(project).toMatchObject({ writable: true, indexed: true, path: projectKnowledgeRoot(dataDir) });
    expect(workspace).toMatchObject({ writable: true, indexed: true, path: workspaceKnowledgeRoot(env) });
  });

  it('C17: registers the sources mirror root, indexed once its directory exists', async () => {
    const repoRoot = await tempDir('cez-kb-roots-sources-');
    const dataDir = join(repoRoot, '.ai/cezar');
    await mkdir(sourcesMountRoot(dataDir), { recursive: true });
    const roots = await resolveKnowledgeRoots({ repoRoot, dataDir });
    const sources = roots.find((r) => r.id === 'sources');
    expect(sources).toMatchObject({ writable: false, indexed: true, path: sourcesMountRoot(dataDir) });
  });

  it('reports a missing discovered root as indexed:false with a stored reason, never a throw', async () => {
    const repoRoot = await tempDir('cez-kb-roots-discovered-');
    const dataDir = join(repoRoot, '.ai/cezar');
    const roots = await resolveKnowledgeRoots({ repoRoot, dataDir });
    for (const d of discoveredRoots(repoRoot)) {
      const found = roots.find((r) => r.id === d.id);
      expect(found).toMatchObject({ indexed: false, reason: 'root is not available' });
    }
  });

  it('a configured mount outside the project root is not indexed in hosted mode, with a stored reason', async () => {
    const repoRoot = await tempDir('cez-kb-roots-hosted-');
    const dataDir = join(repoRoot, '.ai/cezar');
    const external = await tempDir('cez-kb-external-');
    await mkdir(join(repoRoot, '.ai/cezar'), { recursive: true });
    await writeFile(
      join(repoRoot, '.ai/cezar/config.json'),
      JSON.stringify({ knowledge: { mounts: [{ id: 'ext', path: external }] } }),
      'utf8',
    );

    const local = await resolveKnowledgeRoots({ repoRoot, dataDir, hosted: false });
    expect(local.find((r) => r.id === 'ext')).toMatchObject({ indexed: true });

    const hosted = await resolveKnowledgeRoots({ repoRoot, dataDir, hosted: true });
    expect(hosted.find((r) => r.id === 'ext')).toMatchObject({
      indexed: false,
      reason: 'external mount is local only',
    });
  });
});

/**
 * Workspace-scoped mounts (`.ai/specs/2026-08-19-tasks-page-and-start-grounding.md`, D3): one entry
 * in `~/.cezar/config.json`, indexed by every project.
 *
 * The reason this exists at all: the knowledge corpus a workspace reads before every task lives
 * beside the repos, not inside any one of them, so a repo-local mount cannot reach it from a
 * sibling project — and in hosted mode cannot reach it at all.
 */
describe('resolveKnowledgeRoots — workspace-scoped mounts', () => {
  async function fixture(prefix: string) {
    const repoRoot = await tempDir(`cez-kb-ws-${prefix}-repo-`);
    const dataDir = join(repoRoot, '.ai/cezar');
    const cezHome = await tempDir(`cez-kb-ws-${prefix}-home-`);
    const corpus = await tempDir(`cez-kb-ws-${prefix}-corpus-`);
    const env = { CEZ_HOME: cezHome };
    const writeWorkspaceMounts = (mounts: unknown[]) =>
      writeFile(join(cezHome, 'config.json'), JSON.stringify({ knowledge: { mounts } }), 'utf8');
    const writeRepoMounts = async (mounts: unknown[]) => {
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, 'config.json'), JSON.stringify({ knowledge: { mounts } }), 'utf8');
    };
    return { repoRoot, dataDir, cezHome, corpus, env, writeWorkspaceMounts, writeRepoMounts };
  }

  it('indexes a workspace mount that lies outside every repo root, INCLUDING under hosted', async () => {
    const f = await fixture('hosted');
    await f.writeWorkspaceMounts([{ id: 'corpus', path: f.corpus }]);

    for (const hosted of [false, true]) {
      const roots = await resolveKnowledgeRoots({ repoRoot: f.repoRoot, dataDir: f.dataDir, env: f.env, hosted });
      expect(roots.find((r) => r.id === 'corpus')).toMatchObject({
        indexed: true,
        writable: false,
        kind: 'configured',
        path: f.corpus,
      });
    }
  });

  /**
   * The negative control, and the whole reason the hosted rule could be split rather than deleted.
   * Without it, "workspace mounts are indexed under hosted" reads as "external mounts now work" —
   * and a repo-committed path pointing anywhere on the host would quietly start being scanned.
   */
  it('still refuses a REPO-declared external mount under hosted — the rule was split, not lifted', async () => {
    const f = await fixture('control');
    await f.writeRepoMounts([{ id: 'repo-ext', path: f.corpus }]);
    await f.writeWorkspaceMounts([{ id: 'ws-ext', path: f.corpus }]);

    const roots = await resolveKnowledgeRoots({
      repoRoot: f.repoRoot,
      dataDir: f.dataDir,
      env: f.env,
      hosted: true,
    });
    // Same directory, two declarations, two different answers — which is exactly the distinction.
    expect(roots.find((r) => r.id === 'repo-ext')).toMatchObject({
      indexed: false,
      reason: 'external mount is local only',
    });
    expect(roots.find((r) => r.id === 'ws-ext')).toMatchObject({ indexed: true });
  });

  it('drops a workspace mount whose real path a repo mount already claimed, leaving the repo id', async () => {
    // The project that ALSO declares the corpus locally must not scan it twice under two ids.
    const f = await fixture('dedupe');
    const inside = join(f.repoRoot, 'corpus');
    await mkdir(inside, { recursive: true });
    await f.writeRepoMounts([{ id: 'notion', path: 'corpus' }]);
    await f.writeWorkspaceMounts([{ id: 'shared-corpus', path: inside }]);

    const roots = await resolveKnowledgeRoots({ repoRoot: f.repoRoot, dataDir: f.dataDir, env: f.env });
    expect(roots.filter((r) => r.path === inside).map((r) => r.id)).toEqual(['notion']);
    expect(roots.find((r) => r.id === 'shared-corpus')).toBeUndefined();
  });

  it('lets a repo mount win an id collision rather than rendering the id twice', async () => {
    const f = await fixture('collision');
    const inside = join(f.repoRoot, 'local');
    await mkdir(inside, { recursive: true });
    await f.writeRepoMounts([{ id: 'shared', path: 'local' }]);
    await f.writeWorkspaceMounts([{ id: 'shared', path: f.corpus }]);

    const roots = await resolveKnowledgeRoots({ repoRoot: f.repoRoot, dataDir: f.dataDir, env: f.env });
    expect(roots.filter((r) => r.id === 'shared')).toHaveLength(1);
    expect(roots.find((r) => r.id === 'shared')?.path).toBe(inside);
  });

  it('reports a missing workspace mount as unavailable rather than dropping it silently', async () => {
    const f = await fixture('missing');
    await f.writeWorkspaceMounts([{ id: 'gone', path: join(f.corpus, 'nope') }]);
    const roots = await resolveKnowledgeRoots({ repoRoot: f.repoRoot, dataDir: f.dataDir, env: f.env });
    expect(roots.find((r) => r.id === 'gone')).toMatchObject({
      indexed: false,
      reason: 'root is not available',
    });
  });

  it('answers byte-identically twice in a row — D8, the ordering contract GET /knowledge rests on', async () => {
    const f = await fixture('stable');
    const inside = join(f.repoRoot, 'local');
    await mkdir(inside, { recursive: true });
    await f.writeRepoMounts([{ id: 'local', path: 'local' }]);
    await f.writeWorkspaceMounts([{ id: 'corpus', path: f.corpus }]);
    const once = await resolveKnowledgeRoots({ repoRoot: f.repoRoot, dataDir: f.dataDir, env: f.env });
    const twice = await resolveKnowledgeRoots({ repoRoot: f.repoRoot, dataDir: f.dataDir, env: f.env });
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
    // Workspace-configured mounts come LAST, after the repo-configured ones.
    expect(once.map((r) => r.id)).toEqual([
      'project',
      'workspace',
      'sources',
      'specs',
      'docs',
      'analysis',
      'local',
      'corpus',
    ]);
  });

  it('degrades to no workspace mounts when the config is missing or malformed', async () => {
    const f = await fixture('tolerant');
    const baseline = await resolveKnowledgeRoots({ repoRoot: f.repoRoot, dataDir: f.dataDir, env: f.env });
    await writeFile(join(f.cezHome, 'config.json'), '{ not json', 'utf8');
    const broken = await resolveKnowledgeRoots({ repoRoot: f.repoRoot, dataDir: f.dataDir, env: f.env });
    expect(broken.map((r) => r.id)).toEqual(baseline.map((r) => r.id));
  });
});
