import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
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
 * `reports-triage.ts` — the WORKSPACE-scoped triage store behind the REPORTS family
 * (`.ai/specs/2026-08-19-reports-triage-approve-dismiss.md`, "Reports is a workspace tab"
 * amendment).
 *
 * The properties worth asserting here are the ones a report's fate depends on: **absence means
 * pending** (so a missing or broken file can never make a report vanish from the inbox), **a bad
 * row costs one row, not the file**, and **two concurrent writers do not lose each other's row**
 * — that last one is why this store takes a cross-process lease at all, and it is the assertion
 * that would go green by accident if the lease were removed and the test only ever wrote serially.
 *
 * Added when the store moved to workspace scope: **one home, one file** — see the first describe
 * block. That is the regression this whole change exists to prevent, and the reason it is asserted
 * on the FILESYSTEM (nothing under a project root) rather than only on the path helper: a helper
 * returning the right string proves nothing about what the write actually touched.
 *
 * Every call passes `env` explicitly rather than mutating `process.env`. Two reasons: the pin
 * cannot leak into a parallel test in the same worker, and `assertCezarHomeWriteIsSandboxed` reads
 * the SAME env it is handed, so a test that forgot to pin would fail loudly instead of writing into
 * the developer's real `~/.cezar`.
 */

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A pinned `CEZ_HOME`, as the env object every call under test is handed. */
async function tempHome(): Promise<NodeJS.ProcessEnv> {
  const base = await realpath(tmpdir());
  const dir = await mkdtemp(join(base, 'cez-triage-'));
  dirs.push(dir);
  const home = join(dir, '.cezar');
  await mkdir(home, { recursive: true });
  return { ...process.env, CEZ_HOME: home };
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

describe('reports-triage — one home, one file', () => {
  it('the store lives under CEZ_HOME and takes no project argument at all', async () => {
    const env = await tempHome();
    expect(reportsTriagePath(env)).toBe(join(env.CEZ_HOME!, 'reports-triage.json'));
    // Negative control on the assertion above: the path really does follow the home rather than
    // happening to match a constant, so a second home yields a second path.
    const other = await tempHome();
    expect(reportsTriagePath(other)).not.toBe(reportsTriagePath(env));
  });

  it('a decision written once is readable from every project, because there is only one file', async () => {
    const env = await tempHome();
    const base = await realpath(tmpdir());
    const workspace = await mkdtemp(join(base, 'cez-projects-'));
    dirs.push(workspace);
    // Three project checkouts, exactly the shape the old per-project store keyed on. On the box
    // that motivated this change all twelve of them resolved the SAME corpus through one
    // operator-declared knowledge mount, so a decision made from one was invisible from the rest.
    const projects = ['apex', 'chat', 'cezar'].map((id) => join(workspace, id, '.ai', 'cezar'));
    await Promise.all(projects.map((dataDir) => mkdir(dataDir, { recursive: true })));

    await updateReportTriage('notion:9f2c-report', () => row('notion:9f2c-report'), env);

    // The decision is one decision. There is no per-project read to disagree with it, and — the
    // part the filesystem has to confirm rather than the type system — no per-project FILE was
    // written anywhere along the way.
    expect(await readReportTriageRow('notion:9f2c-report', env)).toMatchObject({ status: 'approved' });
    for (const dataDir of projects) {
      expect(await readdir(dataDir)).toEqual([]);
    }
    expect((await readdir(env.CEZ_HOME!)).filter((f) => f.startsWith('reports-triage'))).toEqual([
      'reports-triage.json',
    ]);
  });
});

describe('reports-triage — absence is the pending state', () => {
  it('a home with no file reads as an empty map, and writes nothing to disk', async () => {
    const env = await tempHome();
    expect(await readReportTriage(env)).toEqual(new Map());
    // A read must not materialize state: the queue reads on every open, and a read that created
    // the file would leave one behind on a machine that has never triaged anything.
    await expect(readFile(reportsTriagePath(env), 'utf8')).rejects.toThrow();
  });

  it('unparseable JSON degrades to empty rather than throwing', async () => {
    const env = await tempHome();
    await writeFile(reportsTriagePath(env), '{ not json', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await readReportTriage(env)).toEqual(new Map());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));
  });

  it('a JSON object (not an array) degrades to empty', async () => {
    const env = await tempHome();
    await writeFile(reportsTriagePath(env), '{"a":1}', 'utf8');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await readReportTriage(env)).toEqual(new Map());
  });

  it('one malformed row is skipped and every valid row around it survives', async () => {
    const env = await tempHome();
    await writeFile(
      reportsTriagePath(env),
      JSON.stringify([
        row('good-1'),
        { key: 'bad', keyKind: 'identifier', status: 'maybe', at: 'x' }, // status not in the enum
        row('good-2', { status: 'dismissed', reason: 'duplicate' }),
      ]),
      'utf8',
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const triage = await readReportTriage(env);
    expect([...triage.keys()]).toEqual(['good-1', 'good-2']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed'));
    // Negative control on the assertion above: the bad row really was rejected for its status, so
    // the same row with a valid status DOES survive — the skip is keyed on the defect, not on
    // something incidental about the row.
    await writeFile(
      reportsTriagePath(env),
      JSON.stringify([{ key: 'bad', keyKind: 'identifier', status: 'approved', at: 'x' }]),
      'utf8',
    );
    expect([...(await readReportTriage(env)).keys()]).toEqual(['bad']);
  });
});

describe('reports-triage — upsert and delete', () => {
  it('creates, then updates in place, then deletes when the mutator returns undefined', async () => {
    const env = await tempHome();

    const created = await updateReportTriage('r1', () => row('r1'), env);
    expect(created).toMatchObject({ key: 'r1', status: 'approved' });

    // The mutator sees the CURRENT row, which is what lets a caller decline inside the lease.
    const seen: (ReportTriageRow | undefined)[] = [];
    await updateReportTriage(
      'r1',
      (current) => {
        seen.push(current);
        return { ...row('r1'), status: 'dismissed', reason: 'not a bug' };
      },
      env,
    );
    expect(seen).toEqual([expect.objectContaining({ status: 'approved' })]);
    expect(await readReportTriageRow('r1', env)).toMatchObject({ status: 'dismissed', reason: 'not a bug' });

    // Still ONE row — an update must not append a second row under the same key.
    expect(JSON.parse(await readFile(reportsTriagePath(env), 'utf8'))).toHaveLength(1);

    expect(await updateReportTriage('r1', () => undefined, env)).toBeUndefined();
    expect(await readReportTriage(env)).toEqual(new Map());
    // Deleting a key that is not there is a no-op, not a write of an empty row.
    expect(await updateReportTriage('nope', () => undefined, env)).toBeUndefined();
    expect(JSON.parse(await readFile(reportsTriagePath(env), 'utf8'))).toEqual([]);
  });

  it('a hand-edited file with two rows for one key reads as the LAST one', async () => {
    const env = await tempHome();
    await writeFile(
      reportsTriagePath(env),
      JSON.stringify([row('r1', { reason: 'first' }), row('r1', { status: 'dismissed', reason: 'second' })]),
      'utf8',
    );
    expect(await readReportTriageRow('r1', env)).toMatchObject({ status: 'dismissed', reason: 'second' });
  });
});

describe('reports-triage — the write lease', () => {
  it('twelve concurrent writes of DIFFERENT keys all land (no lost update)', async () => {
    const env = await tempHome();
    const keys = Array.from({ length: 12 }, (_, i) => `r${i}`);
    await Promise.all(keys.map((key) => updateReportTriage(key, () => row(key), env)));
    const triage = await readReportTriage(env);
    // Without serialization these are read-modify-write races over one file and the losers vanish;
    // this is the assertion that fails if the lease is removed. Twelve is not an arbitrary number:
    // it is the number of projects whose cockpit tabs now contend for this one file.
    expect([...triage.keys()].sort()).toEqual([...keys].sort());
  });

  it('concurrent writes of the SAME key serialize, so the second sees the first', async () => {
    const env = await tempHome();
    const observed: (ReportTriageRow | undefined)[] = [];
    await Promise.all([
      updateReportTriage(
        'r1',
        (current) => {
          observed.push(current);
          return row('r1', { reason: 'a' });
        },
        env,
      ),
      updateReportTriage(
        'r1',
        (current) => {
          observed.push(current);
          return row('r1', { reason: 'b' });
        },
        env,
      ),
    ]);
    // One of the two ran on an empty store and the other on the first one's row — which order is
    // not ours to fix, but "both saw undefined" would mean the critical section is not one.
    expect(observed.filter((r) => r === undefined)).toHaveLength(1);
    expect(observed.filter((r) => r !== undefined)).toHaveLength(1);
    expect(JSON.parse(await readFile(reportsTriagePath(env), 'utf8'))).toHaveLength(1);
  });

  it('a lock held past the timeout throws rather than writing without the lease', async () => {
    const env = await tempHome();
    // A wedged writer's lock file, fresh enough not to be reclaimed as stale.
    await writeFile(join(env.CEZ_HOME!, 'reports-triage.lock'), JSON.stringify({ pid: 999999 }), 'utf8');
    await expect(updateReportTriage('r1', () => row('r1'), env)).rejects.toThrow(/write lease/);
    // And it really did not write: losing a triage write is recoverable, writing one without the
    // lease is not.
    await expect(readFile(reportsTriagePath(env), 'utf8')).rejects.toThrow();
  }, 15_000);
});
