import { mkdirSync, mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSpec, AgentRunner, AgentSession } from '../core/agent-runner.ts';
import { localCliAuthor } from '../runs/task-author.ts';

const fake = vi.hoisted(() => ({
  outcomes: [] as Array<'cold' | 'permanent' | 'answered' | 'success'>,
  specs: [] as AgentRunSpec[],
}));

vi.mock('../core/runner-factory.ts', async () => {
  const { BrokerUnavailableError } = await import('../core/brokered-session.ts');
  return {
    createRunner: (): AgentRunner => ({
      backend: 'claude',
      run: async () => ({ text: '', events: [] }) as never,
      startSession: (spec: AgentRunSpec): AgentSession => {
        fake.specs.push(spec);
        const outcome = fake.outcomes.shift() ?? 'success';
        const result = outcome === 'cold'
          ? Promise.reject(new BrokerUnavailableError('broker control unavailable', {
              everAnswered: false,
              spoolDir: '/tmp/cez-missing-broker-spool',
            }))
          : outcome === 'answered'
            ? Promise.reject(new BrokerUnavailableError('broker control unavailable', {
                everAnswered: true,
                spoolDir: '/tmp/cez-missing-broker-spool',
              }))
            : outcome === 'permanent'
              ? Promise.reject(new Error('broker was never started: launcher refused'))
              : Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 });
        return {
          result,
          sendMessage: () => true,
          end: () => {},
          interrupt: () => {},
          open: true,
        };
      },
      interrupt: async () => {},
    }),
  };
});

// The continuation path (`run.ts`'s `runContinuation`) verifies a resumed Claude session has a
// real transcript before trusting `--resume` (spec 2026-08-22-resume-fresh-session-fallback) —
// this fixture never creates one, so without this mock every continuation here downgrades to a
// freshly minted session id, which would defeat the "same backend session context" assertions
// this suite exists to make. Pinned true: the retry tests below are about the cold-broker path,
// not the separate downgrade fallback (covered by its own suite).
vi.mock('../core/claude-cli-runner.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/claude-cli-runner.ts')>();
  return { ...actual, claudeSessionTranscriptExists: async () => true };
});

const { RunStore } = await import('../runs/store.ts');
const { RunManager } = await import('./run.ts');
type Store = ReturnType<typeof RunStore.open>;
type Manager = InstanceType<typeof RunManager>;

const WORKFLOW = {
  name: 'quick-task',
  source: 'built-in' as const,
  steps: [{ id: 'work', kind: 'agent' as const, prompt: '{{task}}' }],
};

describe('bounded cold broker retry', () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;
  let repoRoot: string;
  let store: Store;
  let manager: Manager;

  beforeEach(() => {
    fake.outcomes.length = 0;
    fake.specs.length = 0;
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-broker-retry-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-broker-retry-repo-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    process.env.CEZ_HOME = home;
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    rmSync(home, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  const settled = async (runId: string) => {
    await vi.waitFor(() => {
      expect(['done', 'review', 'failed']).toContain(store.getRun(runId)?.status);
    }, { timeout: 5_000 });
    return store.getRun(runId)!;
  };

  const events = (runId: string): Array<Record<string, unknown>> =>
    readFileSync(join(repoRoot, '.ai/cezar', 'runs', `${runId}.ndjson`), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  it('retries one cold broker once and makes the reason visible', async () => {
    fake.outcomes.push('cold', 'success');
    const run = manager.startRun(WORKFLOW, {
      author: localCliAuthor(),
      task: 'finish the task',
      worktree: false,
    });
    const finished = await settled(run.id);

    expect(finished.status).not.toBe('failed');
    expect(finished.steps[0]?.iterations).toBe(2);
    expect(fake.specs).toHaveLength(2);
    expect(events(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'note', stepId: 'work' }),
      expect.objectContaining({ type: 'metric', name: 'run.step.retried_cold_broker', attempt: 2 }),
    ]));
  });

  it('fails a never-started broker immediately without spending the retry', async () => {
    fake.outcomes.push('permanent', 'success');
    const run = manager.startRun(WORKFLOW, {
      author: localCliAuthor(),
      task: 'finish the task',
      worktree: false,
    });
    const finished = await settled(run.id);

    expect(finished.status).toBe('failed');
    expect(finished.error).toContain('broker was never started: launcher refused');
    expect(fake.specs).toHaveLength(1);
    expect(events(run.id).some((event) => event.name === 'run.step.retried_cold_broker')).toBe(false);
  });

  it('relaunches a continuation broker with the same backend session context', async () => {
    const original = store.createRun({
      title: 'existing task',
      workflow: 'quick-task',
      task: 'existing task',
      author: localCliAuthor(),
      runner: 'claude',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateStep(original.id, 'work', { status: 'done', sessionId: 'existing-session' });
    store.updateRun(original.id, { status: 'done' });
    fake.outcomes.push('cold', 'success');

    await manager.continueRun(original.id, { text: 'follow up' });
    // The run's status starts at 'done' (set above) and `continueRun` returns before
    // synchronously changing it — `settled()` alone would resolve instantly against that
    // stale status, racing ahead of the retry it's supposed to observe. Wait for the new
    // `continue-1` step itself to reach a terminal status first.
    await vi.waitFor(() => {
      const step = store.getRun(original.id)?.steps.find((s) => s.id === 'continue-1');
      expect(step && ['done', 'failed', 'cancelled'].includes(step.status)).toBe(true);
    }, { timeout: 5_000 });
    await settled(original.id);

    expect(fake.specs).toHaveLength(2);
    expect(fake.specs.map((spec) => spec.sessionId)).toEqual(['existing-session', 'existing-session']);
    expect(fake.specs.map((spec) => spec.resume)).toEqual([true, true]);
    expect(events(original.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'metric', name: 'run.step.retried_cold_broker', attempt: 2 }),
    ]));
  });

  it('is bounded: a second cold broker on the same step is not retried again', async () => {
    fake.outcomes.push('cold', 'cold');
    const run = manager.startRun(WORKFLOW, {
      author: localCliAuthor(),
      task: 'finish the task',
      worktree: false,
    });
    const finished = await settled(run.id);

    expect(finished.status).toBe('failed');
    expect(finished.steps[0]?.iterations).toBe(2); // not 3 — the retry is spent once
    expect(fake.specs).toHaveLength(2);
    expect(finished.error).toContain('broker control unavailable');
    expect(
      events(run.id).filter((event) => event.name === 'run.step.retried_cold_broker'),
    ).toHaveLength(1);
  });

  it('the opening payload survives a cold-broker retry', async () => {
    fake.outcomes.push('cold', 'success');
    const images = [
      { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'AAAA' } },
    ];
    const run = manager.startRun(WORKFLOW, {
      author: localCliAuthor(),
      task: 'finish the task',
      worktree: false,
      images,
    });
    const finished = await settled(run.id);

    expect(finished.status).not.toBe('failed');
    expect(fake.specs).toHaveLength(2);
    // The retry's opening message must carry the SAME opening payload as the abandoned attempt —
    // not `undefined`, which is what `run.ts`'s `startImages = undefined` reset would leave it as
    // without the capture/restore at `:4376-4378`/`:4495-4497`.
    expect(fake.specs[0]?.images).toEqual(images);
    expect(fake.specs[1]?.images).toEqual(images);
  });

  it('does not retry once the channel has ever answered', async () => {
    fake.outcomes.push('answered');
    const run = manager.startRun(WORKFLOW, {
      author: localCliAuthor(),
      task: 'finish the task',
      worktree: false,
    });
    const finished = await settled(run.id);

    expect(finished.status).toBe('failed');
    expect(fake.specs).toHaveLength(1); // no relaunch — retrying here would discard billed work
    expect(events(run.id).some((event) => event.name === 'run.step.retried_cold_broker')).toBe(false);
  });

  it('leaves a healthy run unaffected', async () => {
    const run = manager.startRun(WORKFLOW, {
      author: localCliAuthor(),
      task: 'finish the task',
      worktree: false,
    });
    const finished = await settled(run.id);

    expect(finished.status).not.toBe('failed');
    expect(finished.steps[0]?.iterations).toBe(1);
    expect(fake.specs).toHaveLength(1);
    expect(events(run.id).some((event) => event.name === 'run.step.retried_cold_broker')).toBe(false);
    expect(events(run.id).some((event) => event.type === 'note' && String(event.message).includes('relaunching the broker'))).toBe(false);
  });
});
