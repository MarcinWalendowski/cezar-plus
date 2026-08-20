import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Restart recovery must not settle a task that asked the user a question to plain `done`.
 *
 * A run parks at `status: 'waiting'` after a turn ends with `CEZ:ASK` — that IS the "needs you"
 * signal. Before the fix, `recover()` ran every `waiting` run through `settleSuccess`, landing a
 * diff-less run on `done` and dropping the pending question's attention. `recover()` now keeps a
 * run with an unanswered ask in the attention-bearing, still-continuable `review` gate.
 */
describe('recover() and a task parked on an unanswered question', () => {
  let repoRoot: string;
  let store: RunStore;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-recover-ask-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const frozen = () => new WorkspaceSemaphore({ initial: { maxParallel: 0 } });

  /** A run left `waiting` by a crash, with an open agent step that recorded a session. */
  const waitingRun = (): string => {
    const { id } = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 'do it',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateStep(id, 'work', { status: 'waiting', sessionId: 'sess-1' });
    store.updateRun(id, { status: 'waiting' });
    return id;
  };

  it('keeps a run with an UNANSWERED ask in `review`, not `done`, after a restart', async () => {
    const id = waitingRun();
    store.appendEvent(id, { type: 'ask.requested', requestId: 'q1', questions: [{ header: 'Deploy', question: 'Ship it?' }] });

    await new RunManager(store, repoRoot, { semaphore: frozen() }).recover();

    // review = attention ("needs you") AND continuable (the ask card resumes through it).
    expect(store.getRun(id)?.status).toBe('review');
  });

  it('settles a run whose ask was ALREADY ANSWERED to `done`, like any parked session', async () => {
    const id = waitingRun();
    store.appendEvent(id, { type: 'ask.requested', requestId: 'q1', questions: [{ header: 'Deploy', question: 'Ship it?' }] });
    // A later user-message resolves the card — the question is no longer pending.
    store.appendEvent(id, { type: 'user-message', text: 'yes, ship it' });

    await new RunManager(store, repoRoot, { semaphore: frozen() }).recover();

    expect(store.getRun(id)?.status).toBe('done');
  });

  it('settles a plain parked `waiting` run (no ask) to `done`, unchanged', async () => {
    const id = waitingRun();

    await new RunManager(store, repoRoot, { semaphore: frozen() }).recover();

    expect(store.getRun(id)?.status).toBe('done');
  });
});
