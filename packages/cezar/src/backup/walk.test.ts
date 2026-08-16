import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectIncludeSet } from './walk.ts';

describe('collectIncludeSet', () => {
  let home: string;
  let projectRoot: string;
  let extraDir: string;
  const originalHome = process.env.CEZ_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-backup-walk-home-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'cez-backup-walk-project-'));
    extraDir = mkdtempSync(join(tmpdir(), 'cez-backup-walk-extra-'));
    process.env.CEZ_HOME = home; // pinned per house convention, even though homeDir is injected below

    // --- home fixture ---
    writeFileSync(join(home, 'config.json'), '{"a":1}'); // include
    writeFileSync(join(home, 'notes.json'), '{"n":[]}'); // include
    writeFileSync(join(home, 'config.json.bak'), 'stale'); // exclude
    writeFileSync(join(home, 'server.json'), '{}'); // exclude
    mkdirSync(join(home, 'identity'), { recursive: true });
    writeFileSync(join(home, 'identity', 'identity.json'), '{"org":1}'); // include
    mkdirSync(join(home, 'server-instances'), { recursive: true });
    writeFileSync(join(home, 'server-instances', 'example-com.json'), '{}'); // exclude
    // a symlink at a path that WOULD classify include if it were a regular file — must still be
    // skipped, proving the walker filters symlinks before consulting `classify`.
    symlinkSync(join(home, 'notes.json'), join(home, 'ui-state.json'));

    // --- project fixture (<root>/.ai/cezar/) ---
    const projectCezarDir = join(projectRoot, '.ai', 'cezar');
    mkdirSync(join(projectCezarDir, 'knowledge'), { recursive: true });
    writeFileSync(join(projectCezarDir, 'knowledge', 'architecture.md'), '# arch'); // include
    writeFileSync(join(projectCezarDir, 'config.json'), '{}'); // include
    writeFileSync(join(projectCezarDir, 'runs.json'), '{}'); // exclude
    mkdirSync(join(projectCezarDir, 'runs', 'run-1'), { recursive: true });
    writeFileSync(join(projectCezarDir, 'runs', 'run-1', 'events.ndjson'), '{}'); // exclude
    writeFileSync(join(projectCezarDir, 'launch-key'), 'secret'); // exclude
    mkdirSync(join(projectCezarDir, 'knowledge-index'), { recursive: true });
    writeFileSync(join(projectCezarDir, 'knowledge-index', 'manifest.json'), '{}'); // exclude

    // --- extra include fixture ---
    writeFileSync(join(extraDir, 'custom-mount.md'), '# custom');
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(extraDir, { recursive: true, force: true });
  });

  const listProjects = async () => [{ id: 'proj1', root: projectRoot }];

  it('includes the expected home files with `home/`-prefixed logical paths', async () => {
    const entries = await collectIncludeSet({ homeDir: home, listProjects, extraIncludes: [] });
    const logicalPaths = entries.map((e) => e.logicalPath);
    expect(logicalPaths).toContain('home/config.json');
    expect(logicalPaths).toContain('home/notes.json');
    expect(logicalPaths).toContain('home/identity/identity.json');
  });

  it('excludes home files the scope decision excludes', async () => {
    const entries = await collectIncludeSet({ homeDir: home, listProjects, extraIncludes: [] });
    const logicalPaths = entries.map((e) => e.logicalPath);
    expect(logicalPaths).not.toContain('home/config.json.bak');
    expect(logicalPaths).not.toContain('home/server.json');
    expect(logicalPaths).not.toContain('home/server-instances/example-com.json');
  });

  it('skips a symlink even at a path that would otherwise classify as include', async () => {
    const entries = await collectIncludeSet({ homeDir: home, listProjects, extraIncludes: [] });
    expect(entries.map((e) => e.logicalPath)).not.toContain('home/ui-state.json');
  });

  it('includes the expected project files with `project/<id>/`-prefixed logical paths', async () => {
    const entries = await collectIncludeSet({ homeDir: home, listProjects, extraIncludes: [] });
    const logicalPaths = entries.map((e) => e.logicalPath);
    expect(logicalPaths).toContain('project/proj1/knowledge/architecture.md');
    expect(logicalPaths).toContain('project/proj1/config.json');
  });

  it('excludes project files the scope decision excludes', async () => {
    const entries = await collectIncludeSet({ homeDir: home, listProjects, extraIncludes: [] });
    const logicalPaths = entries.map((e) => e.logicalPath);
    expect(logicalPaths).not.toContain('project/proj1/runs.json');
    expect(logicalPaths).not.toContain('project/proj1/runs/run-1/events.ndjson');
    expect(logicalPaths).not.toContain('project/proj1/launch-key');
    expect(logicalPaths).not.toContain('project/proj1/knowledge-index/manifest.json');
  });

  it('resolves an `extraIncludes` absolute path to `extra/<basename>`', async () => {
    const entries = await collectIncludeSet({
      homeDir: home,
      listProjects,
      extraIncludes: [join(extraDir, 'custom-mount.md')],
    });
    const extra = entries.find((e) => e.logicalPath === 'extra/custom-mount.md');
    expect(extra).toBeDefined();
    expect(extra?.absPath).toBe(join(extraDir, 'custom-mount.md'));
  });

  it('dedupes `extraIncludes` by basename, keeping the first', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'cez-backup-walk-extra2-'));
    try {
      writeFileSync(join(otherDir, 'custom-mount.md'), '# second, same basename');
      const entries = await collectIncludeSet({
        homeDir: home,
        listProjects,
        extraIncludes: [join(extraDir, 'custom-mount.md'), join(otherDir, 'custom-mount.md')],
      });
      const matches = entries.filter((e) => e.logicalPath === 'extra/custom-mount.md');
      expect(matches).toHaveLength(1);
      expect(matches[0]?.absPath).toBe(join(extraDir, 'custom-mount.md'));
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('degrades to no entries for a project whose `.ai/cezar/` does not exist yet', async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'cez-backup-walk-empty-'));
    try {
      const entries = await collectIncludeSet({
        homeDir: home,
        listProjects: async () => [{ id: 'empty', root: emptyRoot }],
        extraIncludes: [],
      });
      expect(entries.some((e) => e.logicalPath.startsWith('project/empty/'))).toBe(false);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});
