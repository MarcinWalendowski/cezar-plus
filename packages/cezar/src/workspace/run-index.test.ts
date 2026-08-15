import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceRunIndex } from './run-index.ts';

/**
 * W1.11 unit surface (`.ai/specs/2026-08-06-workspace-notes-cross-project.md`, "Verification"
 * -> "Negative controls, feature A"). This file owns C1 (partial: the running-run half — the
 * `contexts.ids()` half of C1 needs a live server and lives in W4.10's
 * `workspace-runs-api.test.ts`), C2, C3 and C7, plus the boot-dedupe control named in the
 * dispatch note and light functional coverage of `list()` / `digest()`.
 */

const dirs: string[] = [];
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cez-run-index-'));
  dirs.push(root);
  return root;
}
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

/** Every field `runRecordSchema` requires with no `.optional()`/`.default()` — a raw fixture
 *  written straight to a fixture `runs.json`, deliberately NOT going through `RunStore` (the
 *  whole point of this module is that it never does). */
function runJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'run-1',
    title: 'do the thing',
    workflow: 'quick-task',
    task: 'do the thing',
    status: 'done',
    createdAt: '2026-08-01T00:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...overrides,
  };
}

async function writeRuns(root: string, runs: unknown[]): Promise<string> {
  const dir = join(root, '.ai/cezar');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'runs.json');
  await writeFile(path, JSON.stringify(runs));
  return path;
}

describe('WorkspaceRunIndex', () => {
  describe('list()', () => {
    it('with no projects filter, returns runs from every considered project (absent means ALL)', async () => {
      const a = await project();
      const b = await project();
      await writeRuns(a, [runJson({ id: 'a1', createdAt: '2026-08-01T00:00:00.000Z' })]);
      await writeRuns(b, [runJson({ id: 'b1', createdAt: '2026-08-02T00:00:00.000Z' })]);
      const index = new WorkspaceRunIndex({
        listProjects: async () => [
          { id: 'proj-a', root: a, status: 'ok', name: 'A' },
          { id: 'proj-b', root: b, status: 'ok', name: 'B' },
        ],
      });
      const result = await index.list();
      expect(result.runs.map((r) => `${r.project}:${r.id}`)).toEqual(['proj-b:b1', 'proj-a:a1']);
      expect(result.projects).toEqual([
        { id: 'proj-a', name: 'A', status: 'ok', ok: true, total: 1 },
        { id: 'proj-b', name: 'B', status: 'ok', ok: true, total: 1 },
      ]);
      expect(result.truncated).toBe(false);
    });

    it('carries `stopReason`, so a budget-stopped run does not read as plain review (#25)', async () => {
      // Guard for #25: `workspaceRunSummarySchema` gained `stopReason`, but a schema field
      // nothing populates looks fixed and changes nothing. The mutation that must turn this red
      // is dropping `stopReason: run.stopReason` from `toSummary()` (`run-index.ts`) while
      // leaving the schema field in place.
      const a = await project();
      await writeRuns(a, [
        runJson({ id: 'budget-stopped', status: 'review', stopReason: 'budget' }),
        // Second negative control: a run with no `stopReason` must come back without one —
        // "populate unconditionally" fails this the same way never populating it would.
        runJson({ id: 'ordinary-review', status: 'review', createdAt: '2026-08-01T00:00:01.000Z' }),
      ]);
      const index = new WorkspaceRunIndex({
        listProjects: async () => [{ id: 'proj-a', root: a, status: 'ok', name: 'A' }],
      });

      const result = await index.list();

      const budgetRow = result.runs.find((r) => r.id === 'budget-stopped');
      expect(budgetRow?.stopReason).toBe('budget');
      const ordinaryRow = result.runs.find((r) => r.id === 'ordinary-review');
      expect(ordinaryRow?.stopReason).toBeUndefined();
      // The absent-on-the-wire half of this guard (JSON drops an `undefined` key; this in-memory
      // `TrimmedRun` does not, matching `activity`'s own unconditional assignment right above it
      // in `toSummary()`) lives at the HTTP layer: `workspace-runs-api.test.ts`.
    });

    it('C1 (partial): a stored `running` run is reported as running, never rewritten — unlike RunStore.open without keepLive', async () => {
      const root = await project();
      await writeRuns(root, [runJson({ id: 'live', status: 'running' })]);
      const index = new WorkspaceRunIndex({
        listProjects: async () => [{ id: 'p', root, status: 'ok', name: 'p' }],
      });
      const result = await index.list();
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0]).toMatchObject({ id: 'live', status: 'running' });
    });

    it('C3: a read never creates the project directory (unlike RunStore.open, which mkdirSyncs `runs/`)', async () => {
      const root = await project(); // exists, but .ai/cezar does not
      const index = new WorkspaceRunIndex({
        listProjects: async () => [{ id: 'p', root, status: 'ok', name: 'p' }],
      });
      const result = await index.list();
      expect(result.runs).toEqual([]);
      expect(result.projects).toEqual([{ id: 'p', name: 'p', status: 'ok', ok: true, total: 0 }]);
      await expect(stat(join(root, '.ai'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('a missing-root project is never read, and an unreadable runs.json degrades without blanking the others', async () => {
      const healthy = await project();
      const corrupt = await project();
      await writeRuns(healthy, [runJson({ id: 'fine' })]);
      await writeRuns(corrupt, ['not', 'a', 'run', 'record']); // parses as JSON, fails the schema
      const index = new WorkspaceRunIndex({
        listProjects: async () => [
          { id: 'healthy', root: healthy, status: 'ok', name: 'Healthy' },
          { id: 'corrupt', root: corrupt, status: 'ok', name: 'Corrupt' },
          { id: 'gone', root: '/does/not/exist/anywhere', status: 'missing', name: 'Gone' },
        ],
      });
      const result = await index.list();
      expect(result.runs.map((r) => r.id)).toEqual(['fine']);
      const byId = new Map(result.projects.map((p) => [p.id, p] as const));
      expect(byId.get('healthy')).toMatchObject({ ok: true, total: 1 });
      expect(byId.get('corrupt')?.ok).toBe(false);
      expect(byId.get('corrupt')?.reason).toMatch(/schema/);
      expect(byId.get('gone')).toEqual({
        id: 'gone',
        name: 'Gone',
        status: 'missing',
        ok: false,
        reason: 'project root is missing',
        total: 0,
      });
    });

    it('dedupes a synthetic "default" boot row against the same root registered under its real slug', async () => {
      const root = await project();
      await writeRuns(root, [runJson({ id: 'boot-run' })]);
      const index = new WorkspaceRunIndex({
        listProjects: async () => [
          { id: 'default', root, status: 'ok', name: 'Boot (unresolved)' },
          { id: 'shop', root, status: 'ok', name: 'shop' },
        ],
      });
      const result = await index.list();
      expect(result.projects).toHaveLength(1);
      expect(result.projects[0]?.id).toBe('shop');
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0]?.project).toBe('shop');
    });
  });

  describe('digest()', () => {
    it('returns non-archived entries newest-first, capped at perProject', async () => {
      const root = await project();
      await writeRuns(root, [
        runJson({ id: 'r1', createdAt: '2026-08-03T00:00:00.000Z' }),
        runJson({ id: 'r2', createdAt: '2026-08-02T00:00:00.000Z' }),
        runJson({ id: 'r3', createdAt: '2026-08-01T00:00:00.000Z', archived: true }),
      ]);
      const index = new WorkspaceRunIndex({
        listProjects: async () => [{ id: 'p', root, status: 'ok', name: 'p' }],
      });
      const result = await index.digest(['p'], 1);
      expect(result.p).toEqual({
        ok: true,
        entries: [{ id: 'r1', title: 'do the thing', status: 'done', createdAt: '2026-08-03T00:00:00.000Z' }],
      });
    });

    it('degrades an unknown project id without failing the ones that do exist', async () => {
      const root = await project();
      await writeRuns(root, [runJson({ id: 'ok-run' })]);
      const index = new WorkspaceRunIndex({
        listProjects: async () => [{ id: 'p', root, status: 'ok', name: 'p' }],
      });
      const result = await index.digest(['p', 'ghost'], 10);
      expect(result.p?.ok).toBe(true);
      expect(result.p?.entries).toHaveLength(1);
      expect(result.ghost).toEqual({ ok: false, reason: 'unknown project', entries: [] });
    });
  });

  describe('C7: cache correctness, both directions', () => {
    it('does not re-read the file when mtime and size are unchanged', async () => {
      const root = await project();
      await writeRuns(root, [runJson()]);
      let reads = 0;
      const index = new WorkspaceRunIndex({
        listProjects: async () => [{ id: 'p', root, status: 'ok', name: 'p' }],
        readFile: async (path) => {
          reads++;
          return readFile(path, 'utf8');
        },
      });
      await index.list();
      await index.list();
      await index.digest(['p'], 10); // shares the same cache
      expect(reads).toBe(1);
    });

    it('returns updated rows once the file genuinely changes', async () => {
      const root = await project();
      const path = await writeRuns(root, [runJson({ id: 'a' })]);
      const index = new WorkspaceRunIndex({
        listProjects: async () => [{ id: 'p', root, status: 'ok', name: 'p' }],
      });
      expect((await index.list()).runs.map((r) => r.id)).toEqual(['a']);
      await writeFile(path, JSON.stringify([runJson({ id: 'a' }), runJson({ id: 'b', createdAt: '2026-08-02T00:00:00.000Z' })]));
      expect((await index.list()).runs.map((r) => r.id).sort()).toEqual(['a', 'b']);
    });

    it('detects a change even when mtime is held constant — size is load-bearing in the cache key', async () => {
      const root = await project();
      const path = await writeRuns(root, [runJson({ id: 'a' })]);
      const before = await stat(path);
      const index = new WorkspaceRunIndex({
        listProjects: async () => [{ id: 'p', root, status: 'ok', name: 'p' }],
      });
      expect((await index.list()).runs.map((r) => r.id)).toEqual(['a']);

      await writeFile(path, JSON.stringify([runJson({ id: 'a' }), runJson({ id: 'b', createdAt: '2026-08-02T00:00:00.000Z' })]));
      await utimes(path, before.atime, before.mtime); // force mtime back — only size actually changed

      expect((await index.list()).runs.map((r) => r.id).sort()).toEqual(['a', 'b']);
    });

    it('detects a change even when byte size is held constant — mtime is load-bearing in the cache key', async () => {
      const root = await project();
      const path = await writeRuns(root, [runJson({ id: 'run-a' })]);
      const before = await stat(path);
      const index = new WorkspaceRunIndex({
        listProjects: async () => [{ id: 'p', root, status: 'ok', name: 'p' }],
      });
      expect((await index.list()).runs.map((r) => r.id)).toEqual(['run-a']);

      // Same-length id swap: identical byte size on disk, genuinely different record.
      await writeFile(path, JSON.stringify([runJson({ id: 'run-b' })]));
      const rewritten = await stat(path);
      expect(rewritten.size).toBe(before.size); // sanity: size really did hold constant
      await utimes(path, before.atime, new Date(before.mtimeMs + 1000));

      expect((await index.list()).runs.map((r) => r.id)).toEqual(['run-b']);
    });
  });

  it('C2: the structural import guard — never imports runs/store.ts, project-context.ts, or workflows/run.ts', async () => {
    const source = await readFile(new URL('./run-index.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from\s+['"][^'"]*runs\/store(\.ts)?['"]/);
    expect(source).not.toMatch(/from\s+['"][^'"]*project-context(\.ts)?['"]/);
    expect(source).not.toMatch(/from\s+['"][^'"]*workflows\/run(\.ts)?['"]/);
  });
});
