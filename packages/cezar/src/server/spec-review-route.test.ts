import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { appendSpecReviewEntry } from '../runs/spec-review-log.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { localCliAuthor } from '../runs/task-author.ts';

/**
 * `GET /api/v1/runs/:id/spec` (`.ai/specs/2026-08-29-spec-tab-review-feed.md`, P2 Verification
 * items 11-15).
 */
describe('GET /api/v1/runs/:id/spec', () => {
  let repoRoot: string;
  let store: RunStore;
  let runId: string;
  let worktree: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-specroute-'));
    worktree = mkdtempSync(join(tmpdir(), 'cez-specroute-wt-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    runId = store.createRun({ author: localCliAuthor(), title: 't', workflow: 'spec-to-deploy', task: 'do it', steps: [] }).id;
    store.updateRun(runId, { worktreePath: worktree });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  const get = (id: string) =>
    apiRequest(createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' }), `/api/v1/runs/${id}/spec`);

  const dataDir = () => join(repoRoot, '.ai/cezar');

  it('11. returns recorded entries in order, source: recorded, with a matching summary', async () => {
    appendSpecReviewEntry(dataDir(), runId, { kind: 'spec', stepId: 'spec', specPath: '.ai/specs/x.md', source: 'recorded', text: 'v1' });
    appendSpecReviewEntry(dataDir(), runId, { kind: 'review', stepId: 'review-spec', actor: 'agent', verdict: 'revise', report: 'r1' });
    appendSpecReviewEntry(dataDir(), runId, { kind: 'spec', stepId: 'spec', specPath: '.ai/specs/x.md', source: 'recorded', text: 'v2' });
    appendSpecReviewEntry(dataDir(), runId, { kind: 'review', stepId: 'review-spec', actor: 'agent', verdict: 'pass', report: 'r2' });

    const res = await get(runId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      specPath?: string;
      entries: Array<{ kind: string; source?: string }>;
      summary: { revisions: number; reviews: number; latestVerdict?: string };
    };
    expect(body.entries.map((e) => e.kind)).toEqual(['spec', 'review', 'spec', 'review']);
    expect(body.entries.every((e) => e.kind !== 'spec' || e.source === 'recorded')).toBe(true);
    expect(body.specPath).toBe('.ai/specs/x.md');
    expect(body.summary).toEqual({ revisions: 2, reviews: 2, latestVerdict: 'pass' });
  });

  it('12. unknown run id answers 404 { error: "not found" }', async () => {
    const res = await get('nope-not-a-run');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('13. falls back to the live worktree file when no log is recorded but declaredSpecPath resolves', async () => {
    writeFileSync(join(worktree, 'spec.md'), '# live spec on disk\n');
    store.updateRun(runId, { declaredSpecPath: 'spec.md' });

    const res = await get(runId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      specPath?: string;
      entries: Array<{ kind: string; source?: string; revision?: number; text?: string }>;
      summary: { revisions: number; reviews: number };
    };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({ kind: 'spec', source: 'worktree', revision: 1, text: '# live spec on disk\n' });
    expect(body.specPath).toBe('spec.md');
  });

  it('14. no log and no declaredSpecPath answers the empty 200, never a 409', async () => {
    const res = await get(runId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [], summary: { revisions: 0, reviews: 0 } });
  });

  it('14b. no log and no worktree at all still answers the empty 200, not 409 (unlike /files)', async () => {
    store.updateRun(runId, { worktreePath: undefined });
    const res = await get(runId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [], summary: { revisions: 0, reviews: 0 } });
  });

  it('15. a traversal declaredSpecPath is refused by readWorktreePath — the fallback answers empty, never file content', async () => {
    store.updateRun(runId, { declaredSpecPath: '../../etc/passwd' });
    const res = await get(runId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toEqual([]);
  });
});
