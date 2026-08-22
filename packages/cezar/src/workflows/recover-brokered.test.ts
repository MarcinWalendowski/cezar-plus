import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import { BROKER_PROTOCOL, spoolDirFor, writeSpoolExit, writeSpoolMeta } from '../core/run-spool.ts';
import { localCliAuthor } from '../runs/task-author.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * `recover()`'s re-attach branch — P4 of
 * `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`.
 *
 * The acceptance criterion this serves is "a deploy mid-run leaves the run alive and streaming",
 * and the failure it guards against is subtler than the criterion sounds. `recover()` already
 * handles a restart well: it marks the interrupted step failed and force-resumes the task in a
 * fresh session. That is CRASH recovery, and it is correct for a crash. A deploy is not a crash —
 * the agent is still running, still producing output into its spool — and treating it as one costs
 * the live context, adds an `interrupted` error to the transcript and injects a restart prompt on
 * every single deploy.
 *
 * So the branch must fire when the agent really is alive, and — much more importantly — must NOT
 * fire in every other case. A missed re-attach costs a restart. A WRONG re-attach orphans a live
 * agent that nothing is reading, which is strictly worse than the behaviour it replaced. Every
 * test below the first is about a way it must decline.
 */
describe('recover() re-attaches a run whose broker is still alive (P4)', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let manager: RunManager;

  const CHAIN = ['implement', 'run-tests'];
  const WORKFLOW = {
    name: 'two-step',
    description: 'x',
    source: 'built-in' as const,
    steps: CHAIN.map((id) => ({ id, name: id, prompt: '{{task}}' })),
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-reattach-'));
    dataDir = join(repoRoot, '.ai/cezar');
    mkdirSync(join(dataDir, 'runs'), { recursive: true });
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(dataDir, { keepLive: true });
    // maxParallel 0 so nothing actually spawns: this tests the recovery DECISION.
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }),
      reapBroker: async () => true,
    });
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** A run interrupted mid-`implement`, exactly as a restart leaves it. */
  function runningRun(): string {
    const { id } = store.createRun({ author: localCliAuthor(),
      title: 't',
      workflow: 'two-step',
      task: 'do the thing',
      autonomous: true,
      steps: CHAIN.map((s) => ({ id: s, name: s, kind: 'agent' as const })),
    });
    store.updateRun(id, { workflowDef: WORKFLOW, runner: 'claude' });
    store.updateRun(id, { status: 'running', currentStepId: 'implement' });
    store.updateStep(id, 'implement', {
      status: 'running',
      iterations: 1,
      sessionId: 'sess-implement-1',
      backend: 'claude',
    });
    return id;
  }

  /** A spool whose broker is this very process, so `isPidAlive` is true by construction. */
  function liveSpool(runId: string, opts: { stepId?: string; pid?: number; protocol?: number } = {}): string {
    const dir = spoolDirFor(join(dataDir, 'runs'), runId, 'test-instance');
    mkdirSync(dir, { recursive: true });
    writeSpoolMeta(dir, {
      schema: 1,
      protocol: opts.protocol ?? BROKER_PROTOCOL,
      runId,
      stepId: opts.stepId ?? 'implement',
      backend: 'claude',
      pid: opts.pid ?? process.pid,
      argv: ['claude'],
      startedAt: new Date().toISOString(),
      instanceId: 'test-instance',
    });
    writeFileSync(join(dir, 'out.ndjson'), '');
    store.updateRun(runId, { spoolDir: relative(dataDir, dir), consumedOffset: 0 });
    return dir;
  }

  const events = (id: string): string[] =>
    store.readEvents(id).map((e) => (typeof e.message === 'string' ? e.message : e.type));

  it('keeps the run RUNNING and does not force-continue it', async () => {
    const id = runningRun();
    liveSpool(id);

    await manager.recover();

    const record = store.getRun(id);
    // The whole point: no `queued`, no `failed`, no restart-continuation. The agent never stopped,
    // so neither does the run.
    expect(record?.status).toBe('running');
    expect(record?.error).toBeUndefined();
    expect(record?.steps.find((s) => s.id === 'implement')?.status).toBe('running');
    expect(events(id).join('\n')).toContain('cezar restarted — this run kept going');
    expect(events(id).join('\n')).not.toContain('interrupted — cezar process exited during the run');
  });

  it('falls through to the legacy path when the broker pid is DEAD', async () => {
    const id = runningRun();
    // pid 2 is the kernel's kthreadd on Linux and is never ours; what matters is that it is not a
    // broker we started. A pid we know to be gone is the common real case (the box rebooted).
    liveSpool(id, { pid: 999_999_999 });

    await manager.recover();

    const record = store.getRun(id);
    expect(record?.status).not.toBe('running');
    expect(events(id).join('\n')).not.toContain('this run kept going');
  });

  it('falls through when the broker recorded an EXIT — the agent finished while we were gone', async () => {
    const id = runningRun();
    const dir = liveSpool(id);
    writeSpoolExit(dir, { code: 0, signal: null, exitedAt: new Date().toISOString(), instanceId: 'test-instance' });

    await manager.recover();

    expect(store.getRun(id)?.status).not.toBe('running');
  });

  it('falls through on a PROTOCOL mismatch rather than tailing a spool it may misread', async () => {
    const id = runningRun();
    liveSpool(id, { protocol: BROKER_PROTOCOL + 1 });

    await manager.recover();

    expect(store.getRun(id)?.status).not.toBe('running');
  });

  it('falls through when the spool belongs to a DIFFERENT step than the chain would resume', async () => {
    const id = runningRun();
    // The spool says the live agent is on `run-tests`; the record says `implement` is the open
    // step. The two disagree about where this run is, and guessing between them is how a run ends
    // up with two live agents.
    liveSpool(id, { stepId: 'run-tests' });

    await manager.recover();

    expect(store.getRun(id)?.status).not.toBe('running');
  });

  it('falls through when there is no spool at all — every pre-P4 run', async () => {
    const id = runningRun();

    await manager.recover();

    expect(store.getRun(id)?.status).not.toBe('running');
    expect(events(id).join('\n')).not.toContain('this run kept going');
  });

  it('sweeps spools whose runs are over, and never a live one', async () => {
    const liveId = runningRun();
    const liveDir = liveSpool(liveId);
    const doneDir = spoolDirFor(join(dataDir, 'runs'), 'a-finished-run', 'done-instance');
    mkdirSync(doneDir, { recursive: true });
    // A finished run's spool always has its meta.json — only a broker mid-launch (still within
    // SPOOL_ORPHAN_GRACE_MS) lacks one, which is the race the sweep's grace period protects.
    writeSpoolMeta(doneDir, {
      schema: 1,
      protocol: BROKER_PROTOCOL,
      runId: 'a-finished-run',
      stepId: 'implement',
      backend: 'claude',
      pid: 999_999_999,
      argv: ['claude'],
      startedAt: new Date().toISOString(),
      instanceId: 'done-instance',
    });
    writeFileSync(join(doneDir, 'out.ndjson'), 'x\n');

    await manager.recover();

    const { existsSync } = await import('node:fs');
    expect(existsSync(doneDir)).toBe(false);
    expect(existsSync(liveDir)).toBe(true);
  });
});
