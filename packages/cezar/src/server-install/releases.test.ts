import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_KEEP,
  NotMigratedError,
  activate,
  currentTarget,
  flipSymlink,
  freshLedger,
  isMigrated,
  loadLedger,
  makeReleaseId,
  markHealthy,
  prunable,
  recordBuilt,
  releaseDir,
  releaseLedgerSchema,
  removeRelease,
  rollbackTarget,
  saveLedger,
} from './releases.ts';

/**
 * P1 of `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`.
 *
 * The ledger is the only thing on the box that knows how to undo a deploy, so the cases that
 * matter most here are the destructive ones: a repeat deploy must not erase the rollback target,
 * a corrupt row must not evict the file, and a flip must never leave the install path unresolvable.
 */

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cez-releases-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function built(id: string): ReturnType<typeof releaseLedgerSchema.parse>['releases'][number] {
  return { id, sha: `${id}sha`, version: '0.10.0', builtAt: '2026-08-20T09:00:00.000Z' };
}

describe('release id', () => {
  it('is sortable, stamped and sha-suffixed', () => {
    expect(makeReleaseId('2026-08-20T09:30:00.000Z', '67e93cca8398faa')).toBe('20260820T093000Z-67e93cca');
  });

  it('drops the suffix when there is no sha rather than emitting a trailing dash', () => {
    expect(makeReleaseId('2026-08-20T09:30:00.000Z')).toBe('20260820T093000Z');
    expect(makeReleaseId('2026-08-20T09:30:00.000Z', '   ')).toBe('20260820T093000Z');
  });

  it('sorts lexically in build order', () => {
    const a = makeReleaseId('2026-08-19T18:00:00.000Z', 'aaaaaaaa');
    const b = makeReleaseId('2026-08-20T09:30:00.000Z', 'bbbbbbbb');
    expect([b, a].sort((x, y) => x.localeCompare(y))).toEqual([a, b]);
  });
});

describe('ledger persistence', () => {
  it('round-trips and preserves unknown fields written by a newer cezar', () => {
    const dir = scratch();
    const ledger = { ...freshLedger(), current: 'r1', releases: [built('r1')], futureKey: 'keep me' };
    saveLedger(dir, ledger as never);
    const back = loadLedger(dir) as Record<string, unknown>;
    expect(back.current).toBe('r1');
    expect(back.futureKey).toBe('keep me');
  });

  it('degrades to a fresh ledger when the file is missing or corrupt', () => {
    const dir = scratch();
    expect(loadLedger(dir)).toEqual(freshLedger());
    writeFileSync(join(dir, 'deploy.json'), '{not json', 'utf8');
    expect(loadLedger(dir)).toEqual(freshLedger());
  });

  it('salvages the ledger when ONE release row is malformed', () => {
    const dir = scratch();
    writeFileSync(
      join(dir, 'deploy.json'),
      JSON.stringify({ schema: 1, current: 'r2', previous: 'r1', releases: [built('r1'), { nope: true }, built('r2')] }),
      'utf8',
    );
    const back = loadLedger(dir);
    expect(back.releases.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(back.current).toBe('r2');
    expect(back.previous).toBe('r1');
  });

  it('defaults keep', () => {
    expect(freshLedger().keep).toBe(DEFAULT_KEEP);
  });
});

describe('activate', () => {
  it('promotes to current and demotes the outgoing current to previous', () => {
    let ledger = recordBuilt(recordBuilt(freshLedger(), built('r1')), built('r2'));
    ledger = activate(ledger, 'r1', '2026-08-20T09:00:00.000Z');
    ledger = activate(ledger, 'r2', '2026-08-20T09:30:00.000Z');
    expect(ledger.current).toBe('r2');
    expect(ledger.previous).toBe('r1');
    expect(ledger.releases.find((r) => r.id === 'r2')?.activatedAt).toBe('2026-08-20T09:30:00.000Z');
  });

  it('re-activating the CURRENT release does not destroy the rollback target', () => {
    // The regression this guards: a repeated deploy of the same build setting
    // previous := current, leaving the box with nowhere to roll back to.
    let ledger = recordBuilt(recordBuilt(freshLedger(), built('r1')), built('r2'));
    ledger = activate(ledger, 'r1', 't1');
    ledger = activate(ledger, 'r2', 't2');
    ledger = activate(ledger, 'r2', 't3');
    expect(ledger.current).toBe('r2');
    expect(ledger.previous).toBe('r1');
    expect(rollbackTarget(ledger)).toBe('r1');
  });

  it('refuses an unknown release', () => {
    expect(() => activate(freshLedger(), 'ghost', 't')).toThrow(/unknown release/);
  });
});

describe('rollbackTarget', () => {
  it('is null with nothing to go back to', () => {
    expect(rollbackTarget(freshLedger())).toBeNull();
  });

  it('is null when previous no longer has a release row', () => {
    const ledger = { ...recordBuilt(freshLedger(), built('r2')), current: 'r2', previous: 'gone' };
    expect(rollbackTarget(ledger)).toBeNull();
  });
});

describe('prunable', () => {
  it('keeps the newest `keep` and never prunes current or previous', () => {
    let ledger = freshLedger();
    for (const id of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']) ledger = recordBuilt(ledger, built(id));
    ledger = { ...ledger, keep: 3, current: 'r7', previous: 'r1' };
    const gone = prunable(ledger);
    expect(gone).not.toContain('r7');
    expect(gone).not.toContain('r1');
    // oldest-first among the unpinned
    expect(gone).toEqual(['r2', 'r3', 'r4']);
  });

  it('prunes nothing when at or under the keep count', () => {
    let ledger = freshLedger();
    for (const id of ['r1', 'r2']) ledger = recordBuilt(ledger, built(id));
    expect(prunable({ ...ledger, keep: 5 })).toEqual([]);
  });

  it('keep=1 still leaves the box recoverable', () => {
    let ledger = freshLedger();
    for (const id of ['r1', 'r2', 'r3']) ledger = recordBuilt(ledger, built(id));
    ledger = { ...ledger, keep: 1, current: 'r3', previous: 'r2' };
    expect(prunable(ledger)).toEqual(['r1']);
  });
});

describe('markHealthy', () => {
  it('distinguishes unjudged from judged-unhealthy', () => {
    let ledger = recordBuilt(freshLedger(), built('r1'));
    expect(ledger.releases[0]?.healthy).toBeUndefined();
    ledger = markHealthy(ledger, 'r1', false);
    expect(ledger.releases[0]?.healthy).toBe(false);
  });
});

describe('flipSymlink', () => {
  it('points the stable path at a release, atomically, and repoints on the next flip', () => {
    const root = scratch();
    const releases = join(root, 'releases');
    const link = join(root, 'cezar');
    mkdirSync(releaseDir(releases, 'r1'), { recursive: true });
    mkdirSync(releaseDir(releases, 'r2'), { recursive: true });

    flipSymlink(link, releaseDir(releases, 'r1'));
    expect(isMigrated(link)).toBe(true);
    expect(readlinkSync(link)).toBe(releaseDir(releases, 'r1'));
    expect(currentTarget(link)).toBe(releaseDir(releases, 'r1'));

    flipSymlink(link, releaseDir(releases, 'r2'));
    expect(currentTarget(link)).toBe(releaseDir(releases, 'r2'));
    // the temp symlink used for the atomic rename must not survive
    expect(existsSync(`${link}.tmp-flip`)).toBe(false);
  });

  it('refuses a target that does not exist rather than creating a dangling install path', () => {
    const root = scratch();
    expect(() => flipSymlink(join(root, 'cezar'), join(root, 'releases', 'nope'))).toThrow(/does not exist/);
    expect(existsSync(join(root, 'cezar'))).toBe(false);
  });

  it('refuses a relative target', () => {
    const root = scratch();
    expect(() => flipSymlink(join(root, 'cezar'), 'releases/r1')).toThrow(/must be absolute/);
  });

  it('refuses to flip when the install path is still a real directory, and leaves it intact', () => {
    const root = scratch();
    const releases = join(root, 'releases');
    const link = join(root, 'cezar');
    mkdirSync(releaseDir(releases, 'r1'), { recursive: true });
    // the pre-migration state of the live box: /opt/cezar is a populated directory
    mkdirSync(link, { recursive: true });
    writeFileSync(join(link, 'AGENTS.md'), 'live install', 'utf8');

    expect(() => flipSymlink(link, releaseDir(releases, 'r1'))).toThrow(NotMigratedError);
    // the whole point: the refusal must not have eaten the install
    expect(existsSync(join(link, 'AGENTS.md'))).toBe(true);
    expect(isMigrated(link)).toBe(false);
  });

  it('recovers when a previous flip died leaving its temp symlink behind', () => {
    const root = scratch();
    const releases = join(root, 'releases');
    const link = join(root, 'cezar');
    mkdirSync(releaseDir(releases, 'r1'), { recursive: true });
    mkdirSync(releaseDir(releases, 'r2'), { recursive: true });
    flipSymlink(link, releaseDir(releases, 'r1'));
    // simulate a crash between symlink() and rename()
    symlinkSync(releaseDir(releases, 'r1'), `${link}.tmp-flip`);
    expect(() => flipSymlink(link, releaseDir(releases, 'r2'))).not.toThrow();
    expect(currentTarget(link)).toBe(releaseDir(releases, 'r2'));
  });
});

describe('currentTarget', () => {
  it('is null for a missing path and for a real directory', () => {
    const root = scratch();
    expect(currentTarget(join(root, 'missing'))).toBeNull();
    mkdirSync(join(root, 'real'));
    expect(currentTarget(join(root, 'real'))).toBeNull();
  });
});

describe('removeRelease', () => {
  it('deletes the tree and is idempotent', () => {
    const root = scratch();
    mkdirSync(releaseDir(root, 'r1'), { recursive: true });
    writeFileSync(join(releaseDir(root, 'r1'), 'f'), 'x', 'utf8');
    removeRelease(root, 'r1');
    expect(existsSync(releaseDir(root, 'r1'))).toBe(false);
    expect(() => removeRelease(root, 'r1')).not.toThrow();
  });
});
