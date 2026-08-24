import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunStore } from '../runs/store.ts';
import { localCliAuthor } from '../runs/task-author.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { PostconditionResult } from './postconditions.ts';

type Gate = {
  active: Map<string, unknown>;
  awaitHandoff: (
    runId: string,
    state: Record<string, unknown>,
    step: { id: string },
    emit: (event: unknown) => void,
    verdict: PostconditionResult,
    recheck: () => Promise<PostconditionResult>,
  ) => Promise<{ kind: string; verdict?: PostconditionResult }>;
};

describe('manual handoff gate', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let semaphore: WorkspaceSemaphore;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-handoff-gate-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 1 } });
    manager = new RunManager(store, repoRoot, { semaphore });
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function createRun() {
    const run = store.createRun({
      author: localCliAuthor(),
      title: 'handoff',
      workflow: 'spec-to-deploy',
      task: 'finish the release',
      steps: [{ id: 'deploy', name: 'Deploy', kind: 'check' }],
    });
    store.updateRun(run.id, { status: 'running', currentStepId: 'deploy' });
    store.updateStep(run.id, 'deploy', { status: 'running' });
    return run.id;
  }

  function gate(): Gate {
    return manager as unknown as Gate;
  }

  it('parks, rechecks a still-red handoff, then resumes after a green resolve', async () => {
    const id = createRun();
    const state = { cancelled: false, interrupt: () => undefined };
    gate().active.set(id, state);
    let green = false;
    const verdict: PostconditionResult = {
      ok: false,
      detail: 'manual deployment required for cezar service',
      handoff: { kind: 'manual-deploy', reason: 'activate cezar service', targets: ['cezar service'] },
    };
    const parked = gate().awaitHandoff(
      id,
      state,
      { id: 'deploy' },
      () => undefined,
      verdict,
      async () =>
        green
          ? { ok: true, detail: 'all services deployed' }
          : verdict,
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(store.getRun(id)).toMatchObject({ status: 'waiting', waitingReason: 'handoff' });
    expect(store.getRun(id)?.pendingHandoff).toMatchObject({
      kind: 'manual-deploy',
      targets: ['cezar service'],
    });
    expect(semaphore.busy()).toBe(0);

    const red = await manager.resolveHandoff(id, 'ada');
    expect(red).toMatchObject({ ok: true, resolved: false });
    expect(store.getRun(id)?.pendingHandoff).toBeDefined();

    green = true;
    const resolved = await manager.resolveHandoff(id, 'ada', 'activated');
    const outcome = await parked;
    expect(resolved).toMatchObject({ ok: true, resolved: true });
    expect(outcome.kind).toBe('resolved');
    expect(store.getRun(id)).toMatchObject({ status: 'running' });
    expect(store.getRun(id)?.pendingHandoff).toBeUndefined();
  });

  /**
   * spec `.ai/specs/2026-08-24-manual-deploy-not-a-bug.md` D2b: without this, the card is legible
   * until the first Resolve press, then reverts to `checked.detail`, the full probe-source report:
   * exactly the wall of truncated bash this task is named after. `set -u` stands in for "cezar's
   * own probe source", the cheap marker the spec's own verification step uses.
   */
  it('a red Resolve re-persists the concise handoff.reason, not the full probe-source detail', async () => {
    const id = createRun();
    const state = { cancelled: false, interrupt: () => undefined };
    gate().active.set(id, state);
    const initial: PostconditionResult = {
      ok: false,
      detail: 'manual deployment required for cezar service; FAIL cezar service: `set -u\n...probe source...`',
      handoff: { kind: 'manual-deploy', reason: 'manual deployment required for cezar service: activate it by hand', targets: ['cezar service'] },
    };
    const stillRed: PostconditionResult = {
      ok: false,
      detail: 'manual deployment required for cezar service; FAIL cezar service: `set -u\n...probe source...`',
      handoff: {
        kind: 'manual-deploy',
        reason: 'manual deployment required for cezar service: still not live, activate it by hand',
        targets: ['cezar service'],
      },
    };
    const parked = gate().awaitHandoff(id, state, { id: 'deploy' }, () => undefined, initial, async () => stillRed);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const red = await manager.resolveHandoff(id, 'ada');
    expect(red).toMatchObject({ ok: true, resolved: false });

    const pending = store.getRun(id)?.pendingHandoff;
    expect(pending?.reason).toBe(stillRed.handoff?.reason);
    expect(pending?.reason).not.toContain('set -u');
    expect(pending?.reason?.length).toBeLessThan(2_000);

    // Unpark so the test does not leak a waiting run into the next one.
    state.interrupt();
    await parked.catch(() => undefined);
  });

  it('keeps a persisted handoff parked across recovery', async () => {
    const id = createRun();
    store.updateRun(id, {
      status: 'waiting',
      waitingReason: 'handoff',
      pendingHandoff: {
        kind: 'manual-merge',
        stepId: 'deploy',
        requestedAt: new Date().toISOString(),
        reason: 'merge the protected base branch',
        baseBranch: 'main',
      },
    });
    store.updateStep(id, 'deploy', { status: 'waiting' });

    await manager.recover();

    expect(store.getRun(id)).toMatchObject({ status: 'waiting', waitingReason: 'handoff' });
    expect(store.getRun(id)?.pendingHandoff?.kind).toBe('manual-merge');
    expect(store.getRun(id)?.steps[0]?.status).toBe('waiting');
  });

  it('records Skip as skipped and continues the chain', async () => {
    writeFileSync(
      join(repoRoot, '.ai/deploy-targets.json'),
      JSON.stringify({ targets: [{ name: 'cezar service', probe: 'false', manual: true }] }),
    );
    const workflow = {
      name: 'manual-deploy',
      source: 'file' as const,
      steps: [{ id: 'deploy', command: 'true', verify: { builtin: 'all-services-deployed' as const, max: 0 } }],
    };
    const run = manager.startRun(workflow, {
      author: localCliAuthor(),
      task: 'deploy manually',
      worktree: false,
    });
    const deadline = Date.now() + 5_000;
    while (!store.getRun(run.id)?.pendingHandoff) {
      if (Date.now() > deadline) throw new Error('handoff was not requested');
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    await expect(manager.skipHandoff(run.id, 'ada', 'activated outside cezar')).resolves.toMatchObject({
      ok: true,
      skipped: true,
    });
    while (store.getRun(run.id)?.status === 'waiting' || store.getRun(run.id)?.status === 'running') {
      if (Date.now() > deadline) throw new Error('skipped handoff did not finish the chain');
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(store.getRun(run.id)).toMatchObject({ status: 'done' });
    expect(store.getRun(run.id)?.steps[0]?.status).toBe('skipped');
  }, 15_000);
});
