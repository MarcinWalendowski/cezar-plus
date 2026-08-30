import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runStatusSchema, type RunStatus } from '@loki-labs/cezar-plus-contract';
import {
  appendReopenRequests,
  isReopenPending,
  markReopenFailed,
  markReopenStarted,
  readReopenRequests,
  reopenRequestsPath,
  selectDoneUnarchived,
} from './reopen-requests.ts';

/**
 * Phase 1 of `.ai/specs/2026-08-20-reopen-finished-tasks-merge-audit.md` — the selector and the
 * store, the two halves that ship before anything is wired.
 */

describe('selectDoneUnarchived — the Active tab predicate', () => {
  /**
   * One row per `RunStatus` member, enumerated from the ENUM rather than hand-listed, so a status
   * added to `runStatusSchema` later fails this test instead of slipping silently into (or out of)
   * the sweep. That is the whole point of the table: the set is closed, and the closure is checked.
   */
  const statuses: RunStatus[] = [...runStatusSchema.options];

  it('covers every status the contract defines', () => {
    expect(statuses).toContain('done');
    expect(statuses.length).toBeGreaterThanOrEqual(7);
  });

  for (const status of statuses) {
    const shouldSelect = status === 'done';
    it(`${shouldSelect ? 'picks' : 'rejects'} an unarchived ${status} run`, () => {
      expect(selectDoneUnarchived([{ status }])).toHaveLength(shouldSelect ? 1 : 0);
    });

    it(`rejects an ARCHIVED ${status} run`, () => {
      expect(selectDoneUnarchived([{ status, archived: true }])).toHaveLength(0);
    });
  }

  it('treats an explicit archived: false exactly like an absent field', () => {
    expect(selectDoneUnarchived([{ status: 'done', archived: false }])).toHaveLength(1);
  });

  it('preserves input order and identity of the picked rows', () => {
    const rows = [
      { status: 'done' as const, id: 'a' },
      { status: 'failed' as const, id: 'b' },
      { status: 'done' as const, id: 'c' },
    ];
    expect(selectDoneUnarchived(rows).map((r) => r.id)).toEqual(['a', 'c']);
  });
});

describe('reopen-requests store', () => {
  let dataDir: string;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-reopen-store-'));
    dataDir = join(root, '.ai/cezar');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('a missing file reads as an empty inbox AND is not created by the read', async () => {
    expect(await readReopenRequests(dataDir)).toEqual([]);
    expect(existsSync(reopenRequestsPath(dataDir))).toBe(false);
    expect(existsSync(dataDir)).toBe(false); // a read must not materialize state at all
  });

  it('round-trips an appended request, assigning id + createdAt', async () => {
    const [written] = await appendReopenRequests(dataDir, [
      { runId: 'run-1', prompt: 'did it land?', source: 'cli' },
    ]);
    expect(written?.id).toBeTruthy();
    expect(written?.createdAt).toBeTruthy();

    const [read] = await readReopenRequests(dataDir);
    expect(read).toMatchObject({ runId: 'run-1', prompt: 'did it land?', source: 'cli' });
    expect(read?.startedAt).toBeUndefined();
    expect(read?.error).toBeUndefined();
    expect(isReopenPending(read!)).toBe(true);
  });

  it('appends rather than replaces, and writes valid pretty JSON', async () => {
    await appendReopenRequests(dataDir, [{ runId: 'a' }]);
    await appendReopenRequests(dataDir, [{ runId: 'b' }, { runId: 'c' }]);
    expect((await readReopenRequests(dataDir)).map((r) => r.runId)).toEqual(['a', 'b', 'c']);
    expect(JSON.parse(readFileSync(reopenRequestsPath(dataDir), 'utf8'))).toHaveLength(3);
  });

  it('appending nothing writes nothing', async () => {
    expect(await appendReopenRequests(dataDir, [])).toEqual([]);
    expect(existsSync(reopenRequestsPath(dataDir))).toBe(false);
  });

  it('a corrupt file degrades to [] with one warning and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(reopenRequestsPath(dataDir), '{ not json', 'utf8');
    await expect(readReopenRequests(dataDir)).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a non-array file degrades to [] with one warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(reopenRequestsPath(dataDir), '{"runId":"x"}', 'utf8');
    await expect(readReopenRequests(dataDir)).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('skips a malformed entry with a warning and keeps the valid ones', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      reopenRequestsPath(dataDir),
      JSON.stringify([
        { id: 'ok', runId: 'run-1', createdAt: '2026-08-20T00:00:00.000Z' },
        { id: 'bad-no-runid', createdAt: '2026-08-20T00:00:00.000Z' },
      ]),
      'utf8',
    );
    const items = await readReopenRequests(dataDir);
    expect(items.map((r) => r.id)).toEqual(['ok']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('markReopenStarted stamps startedAt, is first-wins, and answers false for an unknown id', async () => {
    const [written] = await appendReopenRequests(dataDir, [{ runId: 'run-1' }]);
    expect(await markReopenStarted(dataDir, written!.id)).toBe(true);
    const [after] = await readReopenRequests(dataDir);
    expect(after?.startedAt).toBeTruthy();
    expect(isReopenPending(after!)).toBe(false);

    // Idempotent: the second stamp is refused and never rewrites the first one's timestamp.
    expect(await markReopenStarted(dataDir, written!.id)).toBe(false);
    expect((await readReopenRequests(dataDir))[0]?.startedAt).toBe(after?.startedAt);
    expect(await markReopenStarted(dataDir, 'nope')).toBe(false);
  });

  it('markReopenFailed stamps error, is terminal, and truncates an oversized message', async () => {
    const [written] = await appendReopenRequests(dataDir, [{ runId: 'run-1' }]);
    expect(await markReopenFailed(dataDir, written!.id, 'no agent session to resume')).toBe(true);
    const [after] = await readReopenRequests(dataDir);
    expect(after?.error).toBe('no agent session to resume');
    expect(isReopenPending(after!)).toBe(false);

    // Both stamps are terminal against each other — a failed row is never later marked started.
    expect(await markReopenStarted(dataDir, written!.id)).toBe(false);
    expect(await markReopenFailed(dataDir, written!.id, 'again')).toBe(false);

    const [second] = await appendReopenRequests(dataDir, [{ runId: 'run-2' }]);
    await markReopenFailed(dataDir, second!.id, 'x'.repeat(5_000));
    const long = (await readReopenRequests(dataDir)).find((r) => r.id === second!.id);
    expect(long?.error).toHaveLength(2_000);
  });

  it('concurrent appends under the cross-process lease never lose an entry', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => appendReopenRequests(dataDir, [{ runId: `run-${i}` }])),
    );
    const items = await readReopenRequests(dataDir);
    expect(items).toHaveLength(8);
    expect(new Set(items.map((r) => r.runId)).size).toBe(8);
  });

  it('concurrent stamps on one request produce exactly one winner', async () => {
    const [written] = await appendReopenRequests(dataDir, [{ runId: 'run-1' }]);
    const results = await Promise.all([
      markReopenStarted(dataDir, written!.id),
      markReopenStarted(dataDir, written!.id),
      markReopenFailed(dataDir, written!.id, 'refused'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
