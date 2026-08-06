import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceCoordinator } from './coordinator.ts';

/**
 * `coordinator.ts` (F2, W4.4). See
 * `.ai/specs/2026-08-06-external-source-connectors-notion.md` phase "3.2": "a project without
 * that file is never discovered; no git remote is read." Mirrors
 * `automations/coordinator.test.ts` exactly in shape.
 */

const dirs: string[] = [];
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cezar-sources-coordinator-'));
  dirs.push(root);
  return root;
}
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe('SourceCoordinator', () => {
  it('discovers only projects carrying the optional sources.json definitions file', async () => {
    const first = await project();
    const second = await project();
    await mkdir(join(first, '.ai/cezar'), { recursive: true });
    await writeFile(join(first, '.ai/cezar/sources.json'), '{"version":1,"connections":[]}');
    const coordinator = new SourceCoordinator({
      listProjects: async () => [
        { id: 'first', root: first, status: 'ok' },
        { id: 'second', root: second, status: 'ok' },
      ],
    });
    await coordinator.refresh();
    expect(coordinator.ids()).toEqual(['first']);
    await expect(import('node:fs/promises').then(({ stat }) => stat(join(second, '.ai')))).rejects.toThrow();
  });

  it('drops removed and gone projects without failing other handles', async () => {
    const root = await project();
    await mkdir(join(root, '.ai/cezar'), { recursive: true });
    await writeFile(join(root, '.ai/cezar/sources.json'), '{"version":1,"connections":[]}');
    let status: 'ok' | 'missing' = 'ok';
    const coordinator = new SourceCoordinator({
      listProjects: async () => [{ id: 'one', root, status }],
    });
    await coordinator.refresh();
    expect(coordinator.ids()).toEqual(['one']);
    status = 'missing';
    await coordinator.refresh();
    expect(coordinator.ids()).toEqual([]);
  });

  it('degrades a registry failure to a warning rather than throwing', async () => {
    const warn = vi.fn();
    const coordinator = new SourceCoordinator({
      listProjects: async () => {
        throw new Error('offline');
      },
      warn,
    });
    await expect(coordinator.refresh()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('offline'));
  });

  it('enabledProjectIds reflects only connections that are enabled and not archived', async () => {
    const root = await project();
    await mkdir(join(root, '.ai/cezar'), { recursive: true });
    await writeFile(join(root, '.ai/cezar/sources.json'), '{"version":1,"connections":[]}');
    const coordinator = new SourceCoordinator({
      listProjects: async () => [{ id: 'p', root, status: 'ok' }],
    });
    await coordinator.refresh();
    expect(coordinator.enabledProjectIds()).toEqual([]);

    const store = coordinator.store('p')!;
    const disabled = store.create(
      {
        kind: 'notion',
        name: 'Off',
        enabled: false,
        mode: 'mirror',
        intervalSeconds: 900,
        collections: [],
        watchComments: false,
        maxDocuments: 5_000,
        maxBodyBytes: 524_288,
      },
      'off',
    );
    expect(coordinator.enabledProjectIds()).toEqual([]);
    void disabled;

    store.create(
      {
        kind: 'notion',
        name: 'On',
        enabled: true,
        mode: 'mirror',
        intervalSeconds: 900,
        collections: [],
        watchComments: false,
        maxDocuments: 5_000,
        maxBodyBytes: 524_288,
      },
      'on',
    );
    expect(coordinator.enabledProjectIds()).toEqual(['p']);
  });

  it('no coordinator file references a git host or its parsing helper by name', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = fileURLToPath(new URL('./coordinator.ts', import.meta.url));
    const text = readFileSync(path, 'utf8');
    const forbidden = [['git', 'hub.com'].join(''), ['parse', 'Remote'].join('')];
    expect(forbidden.some((term) => text.includes(term))).toBe(false);
  });
});
