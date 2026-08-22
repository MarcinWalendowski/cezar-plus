import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunRecord, RunStatus } from './store.ts';
import { RunStore } from './store.ts';
import { findForeignWorkspaceOwner, loadForeignWorkspaceRunSources } from './worktree-ownership.ts';
import { localCliAuthor } from './task-author.ts';

/**
 * Cross-project ownership check (spec 2026-08-22-cross-project-worktree-orphan-prune-safety,
 * Layer 1). `findForeignWorkspaceOwner` is pure — hand-built minimal records, mirroring
 * `retention.test.ts`'s `run(partial)` fixture pattern. `loadForeignWorkspaceRunSources` does real
 * disk I/O, so its tests go through a real `RunStore` (guarantees schema validity for free, same
 * rationale the spec gives for the AC4 integration test) rather than hand-authoring `runs.json`.
 */

function run(partial: {
  id: string;
  status?: RunStatus;
  workspaceWorktrees?: { root: string; worktreePath: string; branch: string; baseBranch: string }[];
}): RunRecord {
  return {
    id: partial.id,
    status: partial.status ?? 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    workspaceWorktrees: partial.workspaceWorktrees,
    steps: [],
  } as unknown as RunRecord;
}

describe('findForeignWorkspaceOwner', () => {
  it('matches on exact {root, worktreePath}', () => {
    const foreign = [
      {
        projectId: 'p',
        projectName: 'p',
        unreadable: false,
        runs: [
          run({
            id: 'run-a',
            workspaceWorktrees: [
              { root: '/repo/target', worktreePath: '/repo/target/.ai/cezar/worktrees/abc', branch: 'cez/abc', baseBranch: 'main' },
            ],
          }),
        ],
      },
    ];
    expect(
      findForeignWorkspaceOwner('/repo/target', '/repo/target/.ai/cezar/worktrees/abc', foreign),
    ).toEqual({ projectName: 'p', runId: 'run-a' });
  });

  it('ignores a project whose workspaceWorktrees names a different path', () => {
    const foreign = [
      {
        projectId: 'p',
        projectName: 'p',
        unreadable: false,
        runs: [
          run({
            id: 'run-a',
            workspaceWorktrees: [
              { root: '/repo/target', worktreePath: '/repo/target/.ai/cezar/worktrees/other', branch: 'cez/other', baseBranch: 'main' },
            ],
          }),
        ],
      },
    ];
    expect(
      findForeignWorkspaceOwner('/repo/target', '/repo/target/.ai/cezar/worktrees/abc', foreign),
    ).toBeUndefined();
  });

  it('ignores run status entirely — a foreign record read cold as "failed" still counts as owning', () => {
    const foreign = [
      {
        projectId: 'p',
        projectName: 'p',
        unreadable: false,
        runs: [
          run({
            id: 'run-a',
            status: 'failed',
            workspaceWorktrees: [
              { root: '/repo/target', worktreePath: '/repo/target/.ai/cezar/worktrees/abc', branch: 'cez/abc', baseBranch: 'main' },
            ],
          }),
        ],
      },
    ];
    expect(
      findForeignWorkspaceOwner('/repo/target', '/repo/target/.ai/cezar/worktrees/abc', foreign),
    ).toEqual({ projectName: 'p', runId: 'run-a' });
  });

  it('returns undefined when no foreign source claims the path', () => {
    expect(findForeignWorkspaceOwner('/repo/target', '/repo/target/.ai/cezar/worktrees/abc', [])).toBeUndefined();
  });
});

describe('loadForeignWorkspaceRunSources (real disk)', () => {
  let bootRoot: string;
  let targetRoot: string;

  const roots: string[] = [];
  function tempRoot(prefix: string): string {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), prefix));
    roots.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('reads a foreign project\'s real runs.json and skips currentRoot itself', () => {
    bootRoot = tempRoot('cez-ownership-boot-');
    targetRoot = tempRoot('cez-ownership-target-');

    const bootStore = RunStore.open(join(bootRoot, '.ai/cezar'), { keepLive: true });
    const created = bootStore.createRun({ author: localCliAuthor(), title: 'workspace run', workflow: 'w', task: 't', steps: [] });
    bootStore.updateRun(created.id, {
      status: 'running',
      workspaceWorktrees: [
        {
          root: targetRoot,
          worktreePath: join(targetRoot, '.ai/cezar/worktrees', created.id),
          branch: `cez/${created.id.slice(0, 8)}`,
          baseBranch: 'main',
        },
      ],
    });
    bootStore.flush();

    const sources = loadForeignWorkspaceRunSources(targetRoot, [
      { id: 'boot', name: 'workspace boot', root: bootRoot },
      { id: 'target', name: 'target', root: targetRoot }, // currentRoot itself — must be skipped
    ]);

    expect(sources).toHaveLength(1);
    expect(sources[0]!.projectId).toBe('boot');
    expect(sources[0]!.unreadable).toBe(false);
    const owner = findForeignWorkspaceOwner(
      targetRoot,
      join(targetRoot, '.ai/cezar/worktrees', created.id),
      sources,
    );
    expect(owner).toEqual({ projectName: 'workspace boot', runId: created.id });
  });

  it('a missing runs.json is NOT unreadable — it legitimately means no owner', () => {
    bootRoot = tempRoot('cez-ownership-missing-');
    targetRoot = tempRoot('cez-ownership-missing-target-');

    const sources = loadForeignWorkspaceRunSources(targetRoot, [
      { id: 'boot', name: 'workspace boot', root: bootRoot },
    ]);
    expect(sources).toEqual([{ projectId: 'boot', projectName: 'workspace boot', runs: [], unreadable: false }]);
  });

  it('a non-empty but unparseable runs.json is marked unreadable, not treated as "no owner"', () => {
    bootRoot = tempRoot('cez-ownership-corrupt-');
    targetRoot = tempRoot('cez-ownership-corrupt-target-');
    mkdirSync(join(bootRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(bootRoot, '.ai/cezar/runs.json'), 'not valid json{{{');

    const sources = loadForeignWorkspaceRunSources(targetRoot, [
      { id: 'boot', name: 'workspace boot', root: bootRoot },
    ]);
    expect(sources).toEqual([{ projectId: 'boot', projectName: 'workspace boot', runs: [], unreadable: true }]);
  });
});
