import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { createApp, type ServerDeps } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

/**
 * **REWRITTEN 2026-08-15 by D7a** (`.ai/specs/2026-08-15-knowledge-grounded-task-fanout.md`).
 * This file used to assert that `CEZ_FOLLOWUPS` off made the reader degrade to an empty inbox and
 * the mutators answer `409` "as defense in depth". **That is no longer the contract**, because the
 * flag no longer means what it meant in #471.
 *
 * The line is now **generation, not storage**:
 *
 * - `CEZ_FOLLOWUPS=1` still governs whether a run is asked to produce follow-ups
 *   (`handoff.ts`, `FOLLOWUP_INSTRUCTIONS`, and `generateFollowups` on `POST /runs`). That is the
 *   real opt-in feature #471 added, and it is still asserted below.
 * - **Storing, listing, starting and deleting a task record is ungated.** The composer's fan-out
 *   files fully-specified tasks through `POST /todos` on a default install, so gating the rest of
 *   the family made the flow dead-end at its last step: tasks filed, listed on the board, and then
 *   un-startable. A `409` on Start is a worse artefact than no feature at all.
 *
 * The old "hides entries without destroying them" behaviour goes with it. It existed because
 * entries could accumulate from agents you had not opted into; with generation still gated, an
 * install that never turns the flag on has nothing to hide except the tasks the user filed
 * deliberately — and hiding those is the bug, not the feature.
 *
 * The per-task handoff journal is a separate feature and is asserted here to
 * stay on, because issue #471 keeps it explicitly.
 */

const TODO = {
  id: 'todo-1',
  ts: '2026-07-17T00:00:00.000Z',
  summary: 'a leftover follow-up',
  runnable: false,
};

describe('inbox gate (#471)', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let captured: StartRunInput | undefined;
  let manager: RunManager;
  const savedFollowups = process.env.CEZ_FOLLOWUPS;
  const savedRemote = process.env.CEZ_REMOTE;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-inbox-'));
    dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
    mkdirSync(dataDir, { recursive: true });
    // A pre-existing entry — the whole family below is asserted against it.
    writeFileSync(join(dataDir, 'todos.json'), JSON.stringify([TODO]), 'utf8');
    captured = undefined;
    manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        captured = input;
        return store.createRun({ title: 't', workflow: '(inbox)', task: input.task, steps: [] });
      },
    } as unknown as RunManager;
    delete process.env.CEZ_FOLLOWUPS;
    delete process.env.CEZ_REMOTE;
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedFollowups === undefined) delete process.env.CEZ_FOLLOWUPS;
    else process.env.CEZ_FOLLOWUPS = savedFollowups;
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
  });

  const app = (over: Partial<ServerDeps> = {}) =>
    createApp({
      repoRoot,
      store,
      manager,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
      ...over,
    });

  const onDisk = (): unknown => JSON.parse(readFileSync(join(dataDir, 'todos.json'), 'utf8'));

  /**
   * D7a: the storage half of the family answers the same way whether the flag is set or not, so
   * both configurations run the SAME assertions. A gate coming back anywhere in the family turns
   * the `off` half red while the `on` half stays green — which is exactly the shape of the bug
   * this replaced (`409 FOLLOWUPS_OFF` on a default install).
   */
  for (const flag of [undefined, '1'] as const) {
    describe(`storing, listing, starting and deleting — ${flag ? 'CEZ_FOLLOWUPS=1' : 'no flag (the default install)'}`, () => {
      beforeEach(() => {
        if (flag) process.env.CEZ_FOLLOWUPS = flag;
        else delete process.env.CEZ_FOLLOWUPS;
      });

      it('GET /api/v1/todos serves the real entries', async () => {
        const res = await apiRequest(app(), '/api/v1/todos');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([TODO]);
      });

      it('POST /api/v1/todos files a task and the reader shows it', async () => {
        const res = await apiRequest(app(), '/api/v1/todos', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ summary: 'filed by the composer', origin: 'composer' }),
        });
        expect(res.status).toBe(201);
        const listed = (await (await apiRequest(app(), '/api/v1/todos')).json()) as { summary: string }[];
        expect(listed.map((t) => t.summary)).toContain('filed by the composer');
      });

      it('POST /api/v1/todos/:id/start spawns a run', async () => {
        const res = await apiRequest(app(), `/api/v1/todos/${TODO.id}/start`, { method: 'POST' });
        expect(res.status).toBe(201);
        expect(captured?.task).toContain(TODO.summary);
      });

      it('DELETE /api/v1/todos/:id checks the entry off, on disk', async () => {
        const res = await apiRequest(app(), `/api/v1/todos/${TODO.id}`, { method: 'DELETE' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ removed: true });
        expect(await (await apiRequest(app(), '/api/v1/todos')).json()).toEqual([]);
        // A check-off is a real removal, not a hide: the entry is gone from the file too, so a
        // later flag flip cannot resurrect it.
        expect(onDisk()).toEqual([]);
      });

      it('DELETE of an unknown id 404s — never swallowed', async () => {
        const res = await apiRequest(app(), '/api/v1/todos/nope', { method: 'DELETE' });
        expect(res.status).toBe(404);
      });
    });
  }

  /**
   * The floor under the rewrite: `CEZ_FOLLOWUPS` must still MEAN something after D7a ungated the
   * storage half, or the flag is dead config that reads as live. Its remaining job is
   * generation — whether a run is asked to produce follow-ups at all — and that ceiling is what
   * keeps `FOLLOWUP_INSTRUCTIONS` and a usable `CEZ_TODOS_FILE` away from the agent
   * (`RunManager.agentEnv`). `start-run.test.ts` owns the fuller matrix; these two are here so
   * that re-gating the storage half can never be mistaken for "the flag still does its job".
   */
  describe('generation is still gated (what the flag still means)', () => {
    const startRun = (body: unknown) =>
      apiRequest(app(), '/api/v1/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const base = { task: 'do the thing', steps: [{ id: 'work', prompt: '{{task}}' }] };

    it('off: a client asking for follow-ups is pinned to false', async () => {
      const res = await startRun({ ...base, generateFollowups: true });
      expect(res.status).toBe(201);
      expect(captured?.generateFollowups).toBe(false);
    });

    it('on: the same request is honoured', async () => {
      process.env.CEZ_FOLLOWUPS = '1';
      const res = await startRun({ ...base, generateFollowups: true });
      expect(res.status).toBe(201);
      expect(captured?.generateFollowups).toBe(true);
    });
  });
});
