import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readReopenRequests, reopenRequestsPath } from '../reopen-requests.ts';
import { runRunsCommand, type ReopenCliIo } from './reopen-cli.ts';

/**
 * Phase 3 of `.ai/specs/2026-08-20-reopen-finished-tasks-merge-audit.md` — `cezar runs reopen`.
 *
 * Every case here runs against a temp repo that is NOT in `~/.cezar/config.json`, so the CLI's
 * "every registered project plus the boot project" default resolves to exactly that one repo: the
 * suite never reads or writes the developer's real registry, and never touches a real project's
 * `reopen-requests.json`.
 */

interface Row {
  id: string;
  status: string;
  archived?: boolean;
  finishedAt?: string;
  title?: string;
}

function runsJson(rows: Row[]): string {
  return JSON.stringify(
    rows.map((row) => ({
      id: row.id,
      title: row.title ?? `task ${row.id}`,
      workflow: 'quick-task',
      task: 't',
      status: row.status,
      steps: [],
      tokensUsed: 0,
      createdAt: '2026-08-01T00:00:00.000Z',
      ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
      ...(row.archived !== undefined ? { archived: row.archived } : {}),
    })),
  );
}

describe('cezar runs reopen', () => {
  let repoRoot: string;
  let dataDir: string;
  let cezHome: string;
  let out: string[];
  let err: string[];
  let io: ReopenCliIo;
  const savedHome = process.env.CEZ_HOME;

  const seed = (rows: Row[]) => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'runs.json'), runsJson(rows), 'utf8');
  };

  const cli = (args: string[]) => runRunsCommand(args, { repoRoot, io, env: {} });

  beforeEach(() => {
    // Pin the registry into a sandbox: without this, `allTargets` reads the DEVELOPER'S real
    // `~/.cezar/config.json` and the sweep would file reopen requests into real projects.
    cezHome = mkdtempSync(join(tmpdir(), 'cez-reopen-home-'));
    process.env.CEZ_HOME = cezHome;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-reopen-cli-'));
    dataDir = join(repoRoot, '.ai/cezar');
    out = [];
    err = [];
    io = { log: (l) => out.push(l), error: (l) => err.push(l) };
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(cezHome, { recursive: true, force: true });
  });

  it('prints usage for no subcommand and for --help, exit 0', async () => {
    expect(await cli([])).toBe(0);
    expect(out.join('\n')).toContain('cezar runs reopen --all-done');
    out = [];
    expect(await cli(['--help'])).toBe(0);
    expect(out.join('\n')).toContain('cezar runs reopen');
  });

  it('rejects an unknown subcommand with exit 1', async () => {
    expect(await cli(['nope'])).toBe(1);
    expect(err.join('\n')).toContain('unknown runs subcommand: nope');
  });

  it('--all-done selects only done + unarchived runs', async () => {
    seed([
      { id: 'done-1', status: 'done', finishedAt: '2026-08-02T00:00:00.000Z' },
      { id: 'done-archived', status: 'done', archived: true, finishedAt: '2026-08-02T00:00:00.000Z' },
      { id: 'failed-1', status: 'failed', finishedAt: '2026-08-02T00:00:00.000Z' },
      { id: 'review-1', status: 'review' },
    ]);
    expect(await cli(['reopen', '--all-done', '--prompt', 'did it land?'])).toBe(0);

    const requests = await readReopenRequests(dataDir);
    expect(requests.map((r) => r.runId)).toEqual(['done-1']);
    expect(requests[0]?.prompt).toBe('did it land?');
    expect(requests[0]?.source).toBe('cli');
  });

  it('--dry-run prints the selection and writes NOTHING', async () => {
    seed([{ id: 'done-1', status: 'done', finishedAt: '2026-08-02T00:00:00.000Z', title: 'ship the thing' }]);
    expect(await cli(['reopen', '--all-done', '--dry-run'])).toBe(0);

    const printed = out.join('\n');
    expect(printed).toContain('done-1');
    expect(printed).toContain('ship the thing');
    expect(printed).toContain('2026-08-02T00:00:00.000Z');
    expect(printed).toContain('nothing written');
    expect(existsSync(reopenRequestsPath(dataDir))).toBe(false);
  });

  it('--limit truncates oldest-finished-first', async () => {
    seed([
      { id: 'newest', status: 'done', finishedAt: '2026-08-05T00:00:00.000Z' },
      { id: 'oldest', status: 'done', finishedAt: '2026-08-01T00:00:00.000Z' },
      { id: 'middle', status: 'done', finishedAt: '2026-08-03T00:00:00.000Z' },
    ]);
    expect(await cli(['reopen', '--all-done', '--limit', '2'])).toBe(0);
    expect((await readReopenRequests(dataDir)).map((r) => r.runId)).toEqual(['oldest', 'middle']);
    expect(out.join('\n')).toContain('--limit 2 of 3 selected');
  });

  it('--limit rejects a non-integer', async () => {
    seed([{ id: 'done-1', status: 'done' }]);
    expect(await cli(['reopen', '--all-done', '--limit', 'many'])).toBe(1);
    expect(err.join('\n')).toContain('--limit must be a non-negative integer');
  });

  it('--exclude drops the named id (the run firing the sweep)', async () => {
    seed([
      { id: 'keep', status: 'done', finishedAt: '2026-08-01T00:00:00.000Z' },
      { id: 'me', status: 'done', finishedAt: '2026-08-02T00:00:00.000Z' },
    ]);
    expect(await cli(['reopen', '--all-done', '--exclude', 'me'])).toBe(0);
    expect((await readReopenRequests(dataDir)).map((r) => r.runId)).toEqual(['keep']);
  });

  it('a project with no runs.json is reported as skipped, never an error', async () => {
    expect(await cli(['reopen', '--all-done'])).toBe(0);
    expect(out.join('\n')).toContain('no matching runs');
    expect(out.join('\n')).toContain('skipped (no runs.json)');
    expect(err).toEqual([]);
  });

  it('names run ids explicitly, and refuses an id that exists nowhere', async () => {
    seed([
      { id: 'r1', status: 'done', finishedAt: '2026-08-01T00:00:00.000Z' },
      { id: 'r2', status: 'failed', finishedAt: '2026-08-02T00:00:00.000Z' },
    ]);
    // An explicit id is NOT filtered by status — naming a run is the caller saying they mean it.
    expect(await cli(['reopen', 'r2'])).toBe(0);
    expect((await readReopenRequests(dataDir)).map((r) => r.runId)).toEqual(['r2']);

    expect(await cli(['reopen', 'ghost'])).toBe(1);
    expect(err.join('\n')).toContain('no such run in any selected project: ghost');
  });

  it('refuses --all-done mixed with explicit run ids', async () => {
    seed([{ id: 'r1', status: 'done' }]);
    expect(await cli(['reopen', '--all-done', 'r1'])).toBe(1);
    expect(err.join('\n')).toContain('do not also name run ids');
  });

  it('refuses a selector-less invocation', async () => {
    expect(await cli(['reopen'])).toBe(1);
    expect(err.join('\n')).toContain('cezar runs reopen --all-done');
  });

  it('rejects an unknown --project rather than silently sweeping everything', async () => {
    seed([{ id: 'r1', status: 'done' }]);
    expect(await cli(['reopen', '--all-done', '--project', 'not-a-project'])).toBe(1);
    expect(err.join('\n')).toContain('unknown project: not-a-project');
    expect(existsSync(reopenRequestsPath(dataDir))).toBe(false);
  });

  it('--project accepts the invoking repo by path, and `all` is the explicit default', async () => {
    seed([{ id: 'r1', status: 'done', finishedAt: '2026-08-01T00:00:00.000Z' }]);
    expect(await cli(['reopen', '--all-done', '--project', repoRoot])).toBe(0);
    expect((await readReopenRequests(dataDir)).map((r) => r.runId)).toEqual(['r1']);

    expect(await cli(['reopen', '--all-done', '--project', 'all'])).toBe(0);
    expect((await readReopenRequests(dataDir)).map((r) => r.runId)).toEqual(['r1', 'r1']);
  });

  it('stamps the filing run id into `source` when CEZ_TASK_ID is set', async () => {
    seed([{ id: 'r1', status: 'done' }]);
    expect(await runRunsCommand(['reopen', '--all-done'], { repoRoot, io, env: { CEZ_TASK_ID: 'abc-123' } })).toBe(0);
    expect((await readReopenRequests(dataDir))[0]?.source).toBe('cli:abc-123');
  });

  it('a whitespace-only --prompt is dropped, so the engine uses its own default', async () => {
    seed([{ id: 'r1', status: 'done' }]);
    expect(await cli(['reopen', '--all-done', '--prompt', '   '])).toBe(0);
    expect((await readReopenRequests(dataDir))[0]?.prompt).toBeUndefined();
  });

  it('never opens a RunStore — selection leaves the project untouched', async () => {
    seed([{ id: 'r1', status: 'done' }]);
    await cli(['reopen', '--all-done', '--dry-run']);
    // `RunStore.open` would have created this; the read-only index reader must not.
    expect(existsSync(join(dataDir, 'runs'))).toBe(false);
  });
});
