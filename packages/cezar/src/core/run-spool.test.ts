import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BROKER_PROTOCOL,
  type SpoolMeta,
  ensureSpoolDir,
  exitBelongsTo,
  isPidAlive,
  isSpoolLive,
  readSpoolExit,
  readSpoolFrom,
  readSpoolMeta,
  spoolDirFor,
  legacySpoolDirFor,
  spoolPaths,
  writeSpoolExit,
  writeSpoolMeta,
} from './run-spool.ts';

/**
 * P4 of `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`.
 *
 * The offset arithmetic in `readSpoolFrom` is the correctness core of re-attach: an off-by-one
 * either duplicates an event into the transcript or drops one, and both are silent.
 */

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cez-spool-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function meta(over: Partial<SpoolMeta> = {}): SpoolMeta {
  return {
    schema: 1,
    protocol: BROKER_PROTOCOL,
    runId: 'run-1',
    backend: 'claude',
    pid: process.pid,
    argv: ['claude', '--print'],
    startedAt: '2026-08-20T09:00:00.000Z',
    instanceId: 'i1',
    ...over,
  } as SpoolMeta;
}

describe('spool layout', () => {
  it('names one spool per run under the runs dir', () => {
    expect(spoolDirFor('/d/runs', 'abc', 'i1')).toBe('/d/runs/abc.spool/i1');
    expect(legacySpoolDirFor('/d/runs', 'abc')).toBe('/d/runs/abc.spool');
    const p = spoolPaths('/d/runs/abc.spool');
    expect(p.out).toBe('/d/runs/abc.spool/out.ndjson');
    expect(p.ctl).toBe('/d/runs/abc.spool/ctl.sock');
    expect(p.exit).toBe('/d/runs/abc.spool/exit.json');
  });

  it('clears a stale exit when preparing a retry', () => {
    const dir = scratch();
    ensureSpoolDir(dir);
    writeSpoolExit(dir, { code: 143, signal: null });
    ensureSpoolDir(dir);
    expect(readSpoolExit(dir)).toBeNull();
  });
});

describe('exit ownership', () => {
  it('uses instance identity before pid identity', () => {
    expect(exitBelongsTo(meta({ pid: 10 }), { code: 0, signal: null, instanceId: 'i1', brokerPid: 11 })).toBe(true);
    expect(exitBelongsTo(meta(), { code: 0, signal: null, instanceId: 'i2', brokerPid: process.pid })).toBe(false);
  });

  it('supports pid-owned and anonymous protocol-1 exits conservatively', () => {
    const legacy = meta({ protocol: 1, instanceId: undefined, pid: 10 });
    expect(exitBelongsTo(legacy, { code: 0, signal: null, brokerPid: 10 })).toBe(true);
    expect(exitBelongsTo(legacy, { code: 0, signal: null }, () => true)).toBe(false);
    expect(exitBelongsTo(legacy, { code: 0, signal: null }, () => false)).toBe(true);
    expect(exitBelongsTo(null, { code: 0, signal: null }, () => false)).toBe(false);
  });
});

describe('meta and exit records', () => {
  it('round-trips meta and preserves unknown fields from a newer broker', () => {
    const dir = scratch();
    ensureSpoolDir(dir);
    writeSpoolMeta(dir, { ...meta(), somethingNew: 'kept' } as never);
    const back = readSpoolMeta(dir) as Record<string, unknown>;
    expect(back.runId).toBe('run-1');
    expect(back.somethingNew).toBe('kept');
  });

  it('reads null for a missing or corrupt meta rather than throwing', () => {
    const dir = scratch();
    ensureSpoolDir(dir);
    expect(readSpoolMeta(dir)).toBeNull();
    writeFileSync(spoolPaths(dir).meta, '{broken', 'utf8');
    expect(readSpoolMeta(dir)).toBeNull();
  });

  it('round-trips an exit record including a signal death', () => {
    const dir = scratch();
    ensureSpoolDir(dir);
    writeSpoolExit(dir, { code: null, signal: 'SIGKILL', exitedAt: 't' });
    expect(readSpoolExit(dir)).toMatchObject({ code: null, signal: 'SIGKILL' });
  });
});

describe('readSpoolFrom', () => {
  it('returns complete lines and an offset just past them', () => {
    const dir = scratch();
    const { out } = ensureSpoolDir(dir);
    writeFileSync(out, '{"a":1}\n{"b":2}\n', 'utf8');
    const r = readSpoolFrom(out, 0);
    expect(r.lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(r.nextOffset).toBe(16);
    expect(r.size).toBe(16);
  });

  it('never returns a partial trailing line, and re-reads it once complete', () => {
    // The core guarantee. A read that lands mid-record must neither emit the fragment
    // nor advance past it.
    const dir = scratch();
    const { out } = ensureSpoolDir(dir);
    writeFileSync(out, '{"a":1}\n{"partial"', 'utf8');
    const first = readSpoolFrom(out, 0);
    expect(first.lines).toEqual(['{"a":1}']);
    expect(first.nextOffset).toBe(8);
    expect(first.size).toBe(18);

    appendFileSync(out, ':true}\n', 'utf8');
    const second = readSpoolFrom(out, first.nextOffset);
    expect(second.lines).toEqual(['{"partial":true}']);
    expect(second.nextOffset).toBe(25);
  });

  it('resuming at a recorded offset yields no gap and no duplicate', () => {
    const dir = scratch();
    const { out } = ensureSpoolDir(dir);
    writeFileSync(out, '', 'utf8');
    const emitted: string[] = [];
    let offset = 0;

    appendFileSync(out, '{"n":1}\n{"n":2}\n', 'utf8');
    let r = readSpoolFrom(out, offset);
    emitted.push(...r.lines);
    offset = r.nextOffset;

    // ---- server dies here; a new one resumes from `offset` ----
    appendFileSync(out, '{"n":3}\n{"n":4}\n', 'utf8');
    r = readSpoolFrom(out, offset);
    emitted.push(...r.lines);

    expect(emitted).toEqual(['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}']);
    expect(new Set(emitted).size).toBe(emitted.length); // no duplicate
  });

  it('keeps byte offsets correct across multi-byte UTF-8', () => {
    // Character length would desynchronise the offset from the file and shift every later read.
    const dir = scratch();
    const { out } = ensureSpoolDir(dir);
    const line = '{"text":"héllo — 日本語"}';
    writeFileSync(out, `${line}\n`, 'utf8');
    const r = readSpoolFrom(out, 0);
    expect(r.lines).toEqual([line]);
    expect(r.nextOffset).toBe(Buffer.byteLength(line, 'utf8') + 1);
    expect(r.nextOffset).toBe(r.size);
    expect(readSpoolFrom(out, r.nextOffset).lines).toEqual([]);
  });

  it('is empty and non-advancing when nothing new has been written', () => {
    const dir = scratch();
    const { out } = ensureSpoolDir(dir);
    writeFileSync(out, '{"a":1}\n', 'utf8');
    const r = readSpoolFrom(out, 8);
    expect(r.lines).toEqual([]);
    expect(r.nextOffset).toBe(8);
  });

  it('handles a missing spool and an offset past EOF without throwing or skipping', () => {
    const dir = scratch();
    const { out } = ensureSpoolDir(dir);
    expect(readSpoolFrom(out, 0)).toEqual({ lines: [], nextOffset: 0, size: 0 });
    writeFileSync(out, '{"a":1}\n', 'utf8');
    const past = readSpoolFrom(out, 9_999);
    expect(past.lines).toEqual([]);
    expect(past.size).toBe(8);
  });

  it('ignores blank lines rather than emitting empty records', () => {
    const dir = scratch();
    const { out } = ensureSpoolDir(dir);
    writeFileSync(out, '{"a":1}\n\n{"b":2}\n', 'utf8');
    expect(readSpoolFrom(out, 0).lines).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe('isPidAlive', () => {
  it('is true for this process and false for nonsense', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(2 ** 30)).toBe(false);
  });
});

describe('isSpoolLive — every false routes the caller to the legacy interrupted-run path', () => {
  it('is true for a live broker with no exit recorded', () => {
    const dir = scratch();
    ensureSpoolDir(dir);
    writeSpoolMeta(dir, meta());
    expect(isSpoolLive(dir)).toBe(true);
  });

  it('is false once the broker has recorded an exit, even while the pid is alive', () => {
    const dir = scratch();
    ensureSpoolDir(dir);
    writeSpoolMeta(dir, meta());
    writeSpoolExit(dir, { code: 0, signal: null, instanceId: 'i1' });
    expect(isSpoolLive(dir)).toBe(false);
  });

  it('is false for a dead broker pid', () => {
    const dir = scratch();
    ensureSpoolDir(dir);
    writeSpoolMeta(dir, meta({ pid: 2 ** 30 }));
    expect(isSpoolLive(dir)).toBe(false);
  });

  it('is false on a protocol mismatch — a straddling server must not guess', () => {
    const dir = scratch();
    ensureSpoolDir(dir);
    writeSpoolMeta(dir, meta({ protocol: BROKER_PROTOCOL + 1 }));
    expect(isSpoolLive(dir)).toBe(false);
  });

  it('is false for a missing spool dir and for unparseable meta', () => {
    const dir = scratch();
    expect(isSpoolLive(join(dir, 'nope.spool'))).toBe(false);
    ensureSpoolDir(dir);
    writeFileSync(spoolPaths(dir).meta, 'not json', 'utf8');
    expect(isSpoolLive(dir)).toBe(false);
  });
});
