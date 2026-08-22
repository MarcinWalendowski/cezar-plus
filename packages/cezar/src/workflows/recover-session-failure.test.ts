import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { localCliAuthor } from '../runs/task-author.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK_CODEX = join(HERE, '..', 'core', '__fixtures__', 'codex', 'mock-codex-app-server.mjs');

/**
 * SPEC 2026-08-22-resume-fresh-session-fallback, Phase 3/4 inverts this suite's original intent:
 * before that spec, a resume rejected because the backend never created the conversation ended
 * the run `failed` outright — this describe block asserted exactly that as the correct behavior.
 * Now `runContinuation`'s catch block recognizes the rejection and retries once with a fresh
 * session before giving up, so the SAME seeded scenario (a codex step resuming a thread id the
 * app-server has never heard of) now resolves to a non-`failed` terminal status instead.
 */
describe('recover() contains backend session failures (#562)', () => {
  let repoRoot: string;
  let store: RunStore;
  const savedBin = process.env.CEZ_CODEX_BIN;
  const savedPassthrough = process.env.CEZ_ENV_PASSTHROUGH;
  const savedReject = process.env.MOCK_CODEX_REJECT_RESUME;

  beforeEach(async () => {
    process.env.CEZ_CODEX_BIN = MOCK_CODEX;
    process.env.CEZ_ENV_PASSTHROUGH = 'MOCK_CODEX_REJECT_RESUME';
    process.env.MOCK_CODEX_REJECT_RESUME = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-recover-session-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    if (savedBin === undefined) delete process.env.CEZ_CODEX_BIN;
    else process.env.CEZ_CODEX_BIN = savedBin;
    if (savedPassthrough === undefined) delete process.env.CEZ_ENV_PASSTHROUGH;
    else process.env.CEZ_ENV_PASSTHROUGH = savedPassthrough;
    if (savedReject === undefined) delete process.env.MOCK_CODEX_REJECT_RESUME;
    else process.env.MOCK_CODEX_REJECT_RESUME = savedReject;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('retries once with a fresh session instead of failing the run outright', async () => {
    const record = store.createRun({ author: localCliAuthor(),
      title: 't',
      workflow: 'quick-task',
      task: 'continue safely',
      runner: 'codex',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateStep(record.id, 'work', {
      status: 'running',
      iterations: 1,
      sessionId: 'missing-thread',
      backend: 'codex',
    });
    store.updateRun(record.id, { status: 'running', currentStepId: 'work' });

    const firstManager = new RunManager(store, repoRoot);
    await firstManager.recover();
    // The retried attempt mints a fresh session and spawns `thread/start` (never gated by
    // MOCK_CODEX_REJECT_RESUME, which only rejects `thread/resume`) — it succeeds, the turn
    // completes, and the continuation parks `waiting` rather than failing the run.
    await expect
      .poll(() => store.getRun(record.id)?.status, { timeout: 5_000 })
      .toBe('waiting');
    const after = store.getRun(record.id);
    expect(after?.error).toBeUndefined();
    expect(after?.steps.filter((step) => step.id.startsWith('continue-'))).toHaveLength(1);
    // The retried session's id is fresh — not the dead 'missing-thread' id the run started from.
    const continuation = after?.steps.find((step) => step.id === 'continue-1');
    expect(continuation?.sessionId).toBeDefined();
    expect(continuation?.sessionId).not.toBe('missing-thread');

    const events = store.readEvents(record.id);
    expect(
      events.some(
        (e) =>
          e.type === 'metric' &&
          (e as { name?: string }).name === 'run.step.resumed_after_missing_session',
      ),
    ).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === 'note' &&
          String((e as { message?: string }).message).includes(
            'the session was never confirmed to exist',
          ),
      ),
    ).toBe(true);

    // The retried session parked `waiting` with its backend process still alive (the codex mock's
    // default scripted turn never emits a completion marker) — cancel it so nothing leaks past
    // this test.
    firstManager.cancel(record.id);
    firstManager.dispose();
  });

  // The one part of the original test's intent this spec does NOT invert: a step that has
  // already exhausted its one retry and genuinely failed must not be resurrected or retried
  // again on a later boot. Seeded directly in the already-exhausted shape (rather than re-derived
  // through a live double-rejection) because the fixture's retry always spawns a fresh
  // `thread/start`, which this mock never rejects — the fixed behavior no longer produces a
  // single-rejection failure to build the "next boot" scenario from.
  it('does not retry-storm a step that already exhausted its retry and genuinely failed', async () => {
    const record = store.createRun({ author: localCliAuthor(),
      title: 't',
      workflow: 'quick-task',
      task: 'continue safely',
      runner: 'codex',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateStep(record.id, 'work', {
      status: 'failed',
      error: 'interrupted — cezar process exited during the run',
    });
    store.addStep(record.id, { id: 'continue-1', name: 'Continue', kind: 'agent' });
    store.updateStep(record.id, 'continue-1', {
      status: 'failed',
      error: 'no rollout found for thread id missing-thread-2',
      sessionId: 'missing-thread-2',
      backend: 'codex',
    });
    store.updateRun(record.id, {
      status: 'failed',
      error: 'continue failed: no rollout found for thread id missing-thread-2',
      currentStepId: undefined,
    });

    const manager = new RunManager(store, repoRoot);
    await manager.recover();

    // `recover()` only ever looks at `queued`/`waiting`/`running` runs — a `failed` run is left
    // exactly as it was, so the retry that already ran once is not repeated on this boot.
    const after = store.getRun(record.id);
    expect(after?.status).toBe('failed');
    expect(after?.steps.filter((step) => step.id.startsWith('continue-'))).toHaveLength(1);
    manager.dispose();
  });
});
