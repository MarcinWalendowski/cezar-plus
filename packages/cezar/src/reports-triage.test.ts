import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readReportTriage,
  readReportTriageRow,
  reportsTriagePath,
  updateReportTriage,
  type ReportTriageRow,
} from './reports-triage.ts';

/**
 * `reports-triage.ts` — the per-project triage store behind the REPORTS family
 * (`.ai/specs/2026-08-19-reports-triage-approve-dismiss.md`).
 *
 * The properties worth asserting here are the ones a report's fate depends on: **absence means
 * pending** (so a missing or broken file can never make a report vanish from the inbox), **a bad
 * row costs one row, not the file**, and **two concurrent writers do not lose each other's row**
 * — that last one is why this store takes a cross-process lease at all, and it is the assertion
 * that would go green by accident if the lease were removed and the test only ever wrote serially.
 */

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDataDir(): Promise<string> {
  const base = await realpath(tmpdir());
  const dir = await mkdtemp(join(base, 'cez-triage-'));
  dirs.push(dir);
  const dataDir = join(dir, '.ai', 'cezar');
  await mkdir(dataDir, { recursive: true });
  return dataDir;
}

function row(key: string, over: Partial<ReportTriageRow> = {}): ReportTriageRow {
  return {
    key,
    keyKind: 'identifier',
    status: 'approved',
    at: '2026-08-19T10:00:00.000Z',
    ...over,
  };
}

describe('reports-triage — absence is the pending state', () => {
  it('a project with no file reads as an empty map, and writes nothing to disk', async () => {
    const dataDir = await tempDataDir();
    expect(await readReportTriage(dataDir)).toEqual(new Map());
    // A read must not materialize state: the cross-project board reads projects that never ran
    // cezar, and a read that created the file would leave one behind in every one of them.
    await expect(readFile(reportsTriagePath(dataDir), 'utf8')).rejects.toThrow();
  });

  it('unparseable JSON degrades to empty rather than throwing', async () => {
    const dataDir = await tempDataDir();
    await writeFile(reportsTriagePath(dataDir), '{ not json', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await readReportTriage(dataDir)).toEqual(new Map());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));
  });

  it('a JSON object (not an array) degrades to empty', async () => {
    const dataDir = await tempDataDir();
    await writeFile(reportsTriagePath(dataDir), '{"a":1}', 'utf8');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await readReportTriage(dataDir)).toEqual(new Map());
  });

  it('one malformed row is skipped and every valid row around it survives', async () => {
    const dataDir = await tempDataDir();
    await writeFile(
      reportsTriagePath(dataDir),
      JSON.stringify([
        row('good-1'),
        { key: 'bad', keyKind: 'identifier', status: 'maybe', at: 'x' }, // status not in the enum
        row('good-2', { status: 'dismissed', reason: 'duplicate' }),
      ]),
      'utf8',
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const triage = await readReportTriage(dataDir);
    expect([...triage.keys()]).toEqual(['good-1', 'good-2']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed'));
    // Negative control on the assertion above: the bad row really was rejected for its status, so
    // the same row with a valid status DOES survive — the skip is keyed on the defect, not on
    // something incidental about the row.
    await writeFile(
      reportsTriagePath(dataDir),
      JSON.stringify([{ key: 'bad', keyKind: 'identifier', status: 'approved', at: 'x' }]),
      'utf8',
    );
    expect([...(await readReportTriage(dataDir)).keys()]).toEqual(['bad']);
  });
});

describe('reports-triage — upsert and delete', () => {
  it('creates, then updates in place, then deletes when the mutator returns undefined', async () => {
    const dataDir = await tempDataDir();

    const created = await updateReportTriage(dataDir, 'r1', () => row('r1'));
    expect(created).toMatchObject({ key: 'r1', status: 'approved' });

    // The mutator sees the CURRENT row, which is what lets a caller decline inside the lease.
    const seen: (ReportTriageRow | undefined)[] = [];
    await updateReportTriage(dataDir, 'r1', (current) => {
      seen.push(current);
      return { ...row('r1'), status: 'dismissed', reason: 'not a bug' };
    });
    expect(seen).toEqual([expect.objectContaining({ status: 'approved' })]);
    expect(await readReportTriageRow(dataDir, 'r1')).toMatchObject({ status: 'dismissed', reason: 'not a bug' });

    // Still ONE row — an update must not append a second row under the same key.
    expect(JSON.parse(await readFile(reportsTriagePath(dataDir), 'utf8'))).toHaveLength(1);

    expect(await updateReportTriage(dataDir, 'r1', () => undefined)).toBeUndefined();
    expect(await readReportTriage(dataDir)).toEqual(new Map());
    // Deleting a key that is not there is a no-op, not a write of an empty row.
    expect(await updateReportTriage(dataDir, 'nope', () => undefined)).toBeUndefined();
    expect(JSON.parse(await readFile(reportsTriagePath(dataDir), 'utf8'))).toEqual([]);
  });

  it('a hand-edited file with two rows for one key reads as the LAST one', async () => {
    const dataDir = await tempDataDir();
    await writeFile(
      reportsTriagePath(dataDir),
      JSON.stringify([row('r1', { reason: 'first' }), row('r1', { status: 'dismissed', reason: 'second' })]),
      'utf8',
    );
    expect(await readReportTriageRow(dataDir, 'r1')).toMatchObject({ status: 'dismissed', reason: 'second' });
  });
});

describe('reports-triage — the write lease', () => {
  it('twelve concurrent writes of DIFFERENT keys all land (no lost update)', async () => {
    const dataDir = await tempDataDir();
    const keys = Array.from({ length: 12 }, (_, i) => `r${i}`);
    await Promise.all(keys.map((key) => updateReportTriage(dataDir, key, () => row(key))));
    const triage = await readReportTriage(dataDir);
    // Without serialization these are read-modify-write races over one file and the losers vanish;
    // this is the assertion that fails if the lease is removed.
    expect([...triage.keys()].sort()).toEqual([...keys].sort());
  });

  it('concurrent writes of the SAME key serialize, so the second sees the first', async () => {
    const dataDir = await tempDataDir();
    const observed: (ReportTriageRow | undefined)[] = [];
    await Promise.all([
      updateReportTriage(dataDir, 'r1', (current) => {
        observed.push(current);
        return row('r1', { reason: 'a' });
      }),
      updateReportTriage(dataDir, 'r1', (current) => {
        observed.push(current);
        return row('r1', { reason: 'b' });
      }),
    ]);
    // One of the two ran on an empty store and the other on the first one's row — which order is
    // not ours to fix, but "both saw undefined" would mean the critical section is not one.
    expect(observed.filter((r) => r === undefined)).toHaveLength(1);
    expect(observed.filter((r) => r !== undefined)).toHaveLength(1);
    expect(JSON.parse(await readFile(reportsTriagePath(dataDir), 'utf8'))).toHaveLength(1);
  });

  it('a lock held past the timeout throws rather than writing without the lease', async () => {
    const dataDir = await tempDataDir();
    // A wedged writer's lock file, fresh enough not to be reclaimed as stale.
    await writeFile(join(dataDir, 'reports-triage.lock'), JSON.stringify({ pid: 999999 }), 'utf8');
    await expect(updateReportTriage(dataDir, 'r1', () => row('r1'))).rejects.toThrow(/write lease/);
    // And it really did not write: losing a triage write is recoverable, writing one without the
    // lease is not.
    await expect(readFile(reportsTriagePath(dataDir), 'utf8')).rejects.toThrow();
  }, 15_000);
});
