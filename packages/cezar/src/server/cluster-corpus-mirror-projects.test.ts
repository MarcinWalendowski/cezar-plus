import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { corpusMirrorProjectDataDirs } from './cluster-routes.ts';

/**
 * The fresh-node measurement of 2026-08-24 (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`,
 * item 64): a node joined to the hub, presence beating, `syncState` never written, corpus never
 * mirrored, and NOTHING in any log saying so. The cause was that the mirror's project list read the
 * workspace registry only, and `cezar serve --repo <dir>` puts its project in the one place the
 * registry deliberately does not carry (D3 `suppressBootRegistration`).
 *
 * These tests pin the union and the dedupe. The "is it loud when empty" half lives in
 * `cluster/corpus-mirror-runtime.test.ts`, deliberately: that guard must hold for ANY cause of an
 * empty list, not only this one.
 */

function workspace(projectRoots: readonly string[]): { env: NodeJS.ProcessEnv; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'cez-mirror-projects-'));
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      schemaVersion: 1,
      projects: projectRoots.map((root, i) => ({
        id: `p${i}`,
        root,
        name: `p${i}`,
        addedAt: new Date(0).toISOString(),
        lastOpenedAt: new Date(0).toISOString(),
        source: 'local',
      })),
    }),
    'utf8',
  );
  return { env: { CEZ_HOME: home } as NodeJS.ProcessEnv, home };
}

describe('corpusMirrorProjectDataDirs — the boot project is a project to mirror (item 64)', () => {
  it('returns the BOOT project when the registry is empty — the measured production case', async () => {
    // Exactly the fresh node: joined, `--repo /w/repo`, nothing ever registered. Before the fix
    // this returned [] and the node mirrored nothing, forever, silently.
    const { env } = workspace([]);
    const dirs = await corpusMirrorProjectDataDirs({ bootProjectRoot: '/w/repo', env });
    expect(dirs).toEqual([join('/w/repo', '.ai/cezar')]);
  });

  it('returns registry projects AND the boot project together', async () => {
    const { env } = workspace(['/w/registered']);
    const dirs = await corpusMirrorProjectDataDirs({ bootProjectRoot: '/w/booted', env });
    expect(dirs).toEqual([join('/w/registered', '.ai/cezar'), join('/w/booted', '.ai/cezar')]);
  });

  it('emits ONE dataDir when the boot root is ALSO registered — no double sweep', async () => {
    // Not hypothetical: a node that registered the directory before it was ever booted with
    // `--repo` carries both, which is the state the first working worker was in.
    const { env } = workspace(['/w/repo']);
    const dirs = await corpusMirrorProjectDataDirs({ bootProjectRoot: '/w/repo', env });
    expect(dirs).toEqual([join('/w/repo', '.ai/cezar')]);
  });

  it('dedupes spellings that differ only by a trailing slash or a `..` segment', async () => {
    const { env } = workspace(['/w/repo/']);
    const dirs = await corpusMirrorProjectDataDirs({ bootProjectRoot: '/w/sub/../repo', env });
    expect(dirs).toEqual([join('/w/repo', '.ai/cezar')]);
  });

  it('without a boot root, returns the registry unchanged (the ten cluster tests that pass none)', async () => {
    const { env } = workspace(['/w/a', '/w/b']);
    const dirs = await corpusMirrorProjectDataDirs({ env });
    expect(dirs).toEqual([join('/w/a', '.ai/cezar'), join('/w/b', '.ai/cezar')]);
  });

  it('returns [] when there is neither a registry project nor a boot root — so the runtime can warn', async () => {
    // The empty case must remain REACHABLE: the runtime's loud-warning guard is what turns it from
    // silence into a message, and a function that invented a fallback path here would hide it.
    const { env } = workspace([]);
    expect(await corpusMirrorProjectDataDirs({ env })).toEqual([]);
  });
});
