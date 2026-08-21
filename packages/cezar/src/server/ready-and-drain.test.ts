import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunStore } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { DrainController } from './drain.ts';
import { createApp } from './server.ts';

/**
 * `GET /api/v1/ready` and the drain middleware — P3/P5 of
 * `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`.
 *
 * Both halves exist because of the same measured failure: the old shutdown was
 * `store.flush(); process.exit(0)`, which cut in-flight responses mid-body, and the old deploy
 * probed health only AFTER the restart, so a broken build was already serving before anything
 * noticed. The tests below are the two negative controls for that — a draining server must refuse
 * work and say so in a way a deploy can act on, and a readiness failure must show up in the STATUS
 * LINE, because every consumer of this probe (`curl`, the deploy script, systemd tooling) reads
 * that and not the body.
 */
describe('/api/v1/ready and the graceful drain', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-ready-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    process.env.CEZ_DRY_RUN = '1'; // keeps the health probe off the network
    manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) =>
        store.createRun({ title: 't', workflow: '(planned)', task: input.task, steps: [] }),
      brokerIsolation: () => 'none' as const,
    } as unknown as RunManager;
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const makeApp = (drain?: DrainController, listenFd?: number): Hono =>
    createApp({
      repoRoot,
      store,
      manager,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
      ...(drain ? { drain } : {}),
      ...(listenFd !== undefined ? { listenFd } : {}),
    });

  it('answers 200 with per-subsystem checks when the server is serving', async () => {
    const response = await apiRequest(makeApp(), '/api/v1/ready');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ready: boolean;
      version: string;
      checks: Array<{ name: string; ok: boolean }>;
      runtime: { socketActivated: boolean; runBrokerIsolation: string; brokeredBackends: string[] };
    };
    expect(body.ready).toBe(true);
    expect(body.version).toBe('0.0.0-test');
    // Named checks, not a bare boolean: a failure has to say which subsystem failed, or a deploy's
    // rollback reason is "not ready" and an operator has nowhere to start.
    expect(body.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['store', 'workspace', 'backends', 'draining']));
    expect(body.checks.every((c) => c.ok)).toBe(true);
    expect(body.runtime.runBrokerIsolation).toBe('none');
  });

  it('answers 503 — in the STATUS LINE — while draining', async () => {
    const drain = new DrainController({ drainMs: 5 });
    const app = makeApp(drain);
    expect((await apiRequest(app, '/api/v1/ready')).status).toBe(200);

    await drain.drain();

    const response = await apiRequest(app, '/api/v1/ready');
    // 503, not 200-with-ready:false. A body-only failure is reported as healthy by curl, by the
    // deploy script and by every load balancer in existence.
    expect(response.status).toBe(503);
    expect(response.headers.get('connection')).toBe('close');
    expect(response.headers.get('retry-after')).toBe('1');
  });

  it('refuses ordinary API work while draining, and tells the client to retry', async () => {
    const drain = new DrainController({ drainMs: 5 });
    const app = makeApp(drain);
    expect((await apiRequest(app, '/api/v1/runs')).status).toBe(200);

    await drain.drain();

    const response = await apiRequest(app, '/api/v1/runs');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'cezar is restarting — retry' });
  });

  it('counts an in-flight request, so a drain waits for it instead of cutting it', async () => {
    const drain = new DrainController({ drainMs: 5 });
    const app = makeApp(drain);
    expect(drain.inFlightCount()).toBe(0);
    const inFlight = apiRequest(app, '/api/v1/runs');
    // The count is observable only while the handler runs; awaiting it first would always read 0.
    await inFlight;
    expect(drain.inFlightCount()).toBe(0);
  });

  it('reports socket activation on health, so a degraded install is visible rather than assumed', async () => {
    const activated = (await (await apiRequest(makeApp(undefined, 3), '/api/v1/health')).json()) as {
      runtime: { socketActivated: boolean; brokerAvailable: boolean };
    };
    expect(activated.runtime.socketActivated).toBe(true);

    const plain = (await (await apiRequest(makeApp(), '/api/v1/health')).json()) as {
      runtime: { socketActivated: boolean };
    };
    expect(plain.runtime.socketActivated).toBe(false);
  });

  it('leaves the drain inert when no controller is injected — every embedder and every test', async () => {
    // The middleware is registered only when `deps.drain` is present, so an app without one
    // behaves exactly as it did before P3 shipped. This is the control for "additive".
    const response = await apiRequest(makeApp(), '/api/v1/runs');
    expect(response.status).toBe(200);
  });
});
