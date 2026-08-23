import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';
import { localCliAuthor } from '../runs/task-author.ts';

/**
 * `POST /api/v1/runs/:id/agent` — "Run on…", moving a PARKED task to another engine
 * (spec `.ai/specs/2026-08-23-retarget-task-to-another-engine.md`, Phase 3).
 *
 * The contract this file pins is the ROUTING between two engine calls, because that is the part a
 * caller cannot see and the part that silently does nothing when it is wrong:
 *
 *  - `queued` → `retargetQueuedRun` (rewrites the pending work item)
 *  - `failed` → `continueRun` (reopens the session on the named engine)
 *  - anything else → 409 naming the status
 *
 * Capturing stubs for both, the `continue-run.test.ts` pattern: the manager's own behaviour is
 * covered by the engine tests, and what is at issue here is which of the two is called.
 */
describe('POST /api/v1/runs/:id/agent', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  type Target = { runner?: string; agentProfile?: string; model?: string };
  let retargeted: { id: string; target: Target } | undefined;
  let continued: { id: string; opts: Target } | undefined;
  let retargetResult: { ok: boolean; error?: string };
  const savedDryRun = process.env.CEZ_DRY_RUN;

  /** A run in `status`, with the fields the route reads. */
  const makeRun = (status: string): string => {
    const id = store.createRun({
      author: localCliAuthor(),
      title: 't',
      workflow: 'quick-task',
      task: 't',
      steps: [],
    }).id;
    store.updateRun(id, { status: status as never, runner: 'claude' });
    return id;
  };

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-retarget-api-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    retargeted = undefined;
    continued = undefined;
    retargetResult = { ok: true };
    const manager = {
      retargetQueuedRun: (id: string, target: Target = {}) => {
        retargeted = { id, target };
        return retargetResult;
      },
      continueRun: (id: string, opts: Target = {}) => {
        continued = { id, opts };
        return { ok: true };
      },
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const post = (id: string, body: unknown) =>
    apiRequest(app, `/api/v1/runs/${id}/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('sends a queued run to retargetQueuedRun, with the target verbatim', async () => {
    const id = makeRun('queued');
    const res = await post(id, { runner: 'codex', agentProfile: 'work', model: 'gpt-5.1-codex' });
    expect(res.status).toBe(200);
    expect(retargeted?.id).toBe(id);
    expect(retargeted?.target).toEqual({ runner: 'codex', agentProfile: 'work', model: 'gpt-5.1-codex' });
    // The other engine call must NOT have fired. Without this the test passes just as well when
    // the route calls both, which is the failure that would double-start a task.
    expect(continued).toBeUndefined();
  });

  it('sends a failed (scheduled) run to continueRun instead', async () => {
    const id = makeRun('failed');
    const res = await post(id, { runner: 'codex' });
    expect(res.status).toBe(200);
    expect(continued?.id).toBe(id);
    expect(continued?.opts.runner).toBe('codex');
    expect(retargeted).toBeUndefined();
  });

  it('omits what the caller omitted — an untouched pill is not a re-pin', async () => {
    const id = makeRun('queued');
    const res = await post(id, { runner: 'codex' });
    expect(res.status).toBe(200);
    expect(retargeted?.target).toEqual({ runner: 'codex' });
    expect(retargeted?.target.model).toBeUndefined();
    expect(retargeted?.target.agentProfile).toBeUndefined();
  });

  it('refuses an account change on a run that already has a session, rather than dropping it', async () => {
    // `continueRun` has no `agentProfile` parameter, so accepting the field here would return 200
    // and change nothing about where the work runs — the worst available answer.
    const id = makeRun('failed');
    const res = await post(id, { agentProfile: 'work' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('not to another account') });
    expect(continued).toBeUndefined();
  });

  it('409s a running run, naming the status', async () => {
    const id = makeRun('running');
    const res = await post(id, { runner: 'codex' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('running') });
    expect(retargeted).toBeUndefined();
    expect(continued).toBeUndefined();
  });

  it('404s an unknown run — distinct from the 409 a real-but-unmovable run gets', async () => {
    const res = await post('no-such-run', { runner: 'codex' });
    expect(res.status).toBe(404);
    // The BODY, not just the status. A route that does not exist also answers 404, so asserting
    // the code alone passes with the whole feature deleted — measured: with the route removed this
    // was the one case of the eight still green. `{error:'not found'}` is this handler's own
    // answer and nothing else on the path produces it.
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('passes the engine\'s own refusal through as a 409', async () => {
    const id = makeRun('queued');
    retargetResult = { ok: false, error: 'this task has no queued work item yet, try again in a moment' };
    const res = await post(id, { runner: 'codex' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('no queued work item') });
  });

  it('rejects a runner that is not a known provider', async () => {
    const id = makeRun('queued');
    const res = await post(id, { runner: 'not-a-runner' });
    expect(res.status).toBe(400);
    expect(retargeted).toBeUndefined();
  });
});
