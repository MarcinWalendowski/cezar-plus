import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KnowledgeStore, type KnowledgeStoreOptions } from './store.ts';

/**
 * `onChanged` (2026-08-24) — the hook a hub uses to push a `corpus-changed` hint the moment its
 * corpus moves, instead of every spoke waiting out its interval (cluster spec item 57).
 *
 * **`disableWatchers: true` throughout, for the reason the C19 control exists**: proving
 * "`notifyChanged` fired the listener" is vacuous while an `fs.watch` on the same directory could
 * have fired the debounce instead. With watchers off, `notifyChanged` is the only path in, so a
 * count assertion means what it says.
 */

const dirs: string[] = [];
const openStores: KnowledgeStore[] = [];

afterEach(async () => {
  await Promise.all(openStores.splice(0).map((s) => s.dispose?.()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRepo(): Promise<string> {
  const base = await realpath(tmpdir());
  const dir = await mkdtemp(join(base, 'kb-onchanged-'));
  dirs.push(dir);
  await mkdir(join(dir, '.ai/cezar/knowledge'), { recursive: true });
  return dir;
}

async function openStore(repoRoot: string, options: KnowledgeStoreOptions = {}) {
  const dataDir = join(repoRoot, '.ai/cezar');
  const store = KnowledgeStore.create(repoRoot, dataDir, { disableWatchers: true, ...options });
  openStores.push(store);
  await store.initialize();
  return { store, dataDir };
}

describe('KnowledgeStore#onChanged', () => {
  it('fires once for the reindex that initialize() performs', async () => {
    const repoRoot = await tempRepo();
    let calls = 0;
    await openStore(repoRoot, { onChanged: () => void calls++ });
    // Exactly one, not "at least one": a hook that fired per-root or per-document would also be
    // >0, and would make a hub broadcast a burst of hints for a single corpus state.
    expect(calls).toBe(1);
  });

  it('fires again for a later reindex, and NOT for a reindex that never happened', async () => {
    const repoRoot = await tempRepo();
    let calls = 0;
    const { store, dataDir } = await openStore(repoRoot, { onChanged: () => void calls++ });
    expect(calls).toBe(1);

    // The negative half: doing nothing must not fire it. Without this, a hook wired to a timer
    // rather than to a reindex would pass the positive assertion below just as well.
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(1);

    await writeFile(join(dataDir, 'knowledge', 'a.md'), '# A\n\nbody\n', 'utf8');
    await store.reindexNow();
    expect(calls).toBe(2);
  });

  it('a listener that throws does not fail the reindex, and the index is still correct', async () => {
    const repoRoot = await tempRepo();
    const dataDir = join(repoRoot, '.ai/cezar');
    await writeFile(join(dataDir, 'knowledge', 'b.md'), '# B\n\nbody\n', 'utf8');

    const warnings: string[] = [];
    const { store } = await openStore(repoRoot, {
      onChanged: () => {
        throw new Error('listener exploded');
      },
      warn: (m) => void warnings.push(m),
    });

    // The reindex that provoked the throw must still have completed — assert the DOCUMENT is
    // indexed, not merely that `initialize()` resolved. A store that swallowed the error but
    // abandoned the pass would also resolve.
    const result = await store.reindexNow();
    expect(result.formatVersion).toBeGreaterThan(0);
    expect(warnings.some((m) => m.includes('onChanged listener threw'))).toBe(true);
  });

  it('is optional — a store with no listener reindexes normally', async () => {
    const repoRoot = await tempRepo();
    const { store } = await openStore(repoRoot);
    await expect(store.reindexNow()).resolves.toBeTruthy();
  });
});
