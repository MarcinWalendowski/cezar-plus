import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { localCliAuthor } from '../runs/task-author.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK_CODEX = join(HERE, '..', 'core', '__fixtures__', 'codex', 'mock-codex-app-server.mjs');

/**
 * V4 of `.ai/specs/2026-08-23-codex-resume-explicit-model.md`: reaches Solution case 4 (the
 * catalog resolver couldn't resolve a model) through the SAME mechanism Phase 1 provides —
 * injecting `resumeModel` on `CodexRunnerOptions` — via the one seam `RunManager` itself resolves
 * a runner through, `createRunner` (the same technique `workspace-grant-wiring.test.ts` uses).
 * Everything downstream (bootstrap, the mock app-server, the run manager's error handling) is
 * real; only the model resolver is stubbed, so this is the "disable Phase 1" case Verification V4
 * describes without needing an actual toggle.
 */
vi.mock('../core/runner-factory.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/runner-factory.ts')>();
  const { CodexAppServerRunner } = await import('../core/codex-app-server-runner.ts');
  return {
    ...actual,
    createRunner: (backend: Parameters<typeof actual.createRunner>[0]) =>
      backend === 'codex'
        ? new CodexAppServerRunner({ resumeModel: async () => ({ source: 'unavailable' as const }) })
        : actual.createRunner(backend),
  };
});

describe('a resumed codex thread poisoned with a model codex cannot serve (#405 resume)', () => {
  let repoRoot: string;
  let store: RunStore;
  const savedBin = process.env.CEZ_CODEX_BIN;
  const savedPassthrough = process.env.CEZ_ENV_PASSTHROUGH;
  const savedPersisted = process.env.MOCK_CODEX_PERSISTED_MODEL;

  beforeEach(async () => {
    process.env.CEZ_CODEX_BIN = MOCK_CODEX;
    process.env.CEZ_ENV_PASSTHROUGH = 'MOCK_CODEX_PERSISTED_MODEL';
    // The exact persisted poison the incident's real threads carried
    // (`.ai/specs/2026-08-23-codex-resume-explicit-model.md`, "Measured, on the box").
    process.env.MOCK_CODEX_PERSISTED_MODEL = 'sonnet';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-resume-poisoned-'));
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
    if (savedPersisted === undefined) delete process.env.MOCK_CODEX_PERSISTED_MODEL;
    else process.env.MOCK_CODEX_PERSISTED_MODEL = savedPersisted;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('fails the run with the verbatim provider message and never parks it at waiting', async () => {
    const record = store.createRun({
      author: localCliAuthor(),
      title: 't',
      workflow: 'quick-task',
      task: 'continue a poisoned thread',
      runner: 'codex',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateStep(record.id, 'work', {
      status: 'running',
      iterations: 1,
      sessionId: 'th_mock_1',
      backend: 'codex',
    });
    store.updateRun(record.id, { status: 'running', currentStepId: 'work' });

    // Spied (not stubbed — `vi.spyOn` calls through by default) so every status this run is ever
    // moved to is recorded, in order. The acceptance criterion is "never `waiting` at any point
    // in the sequence", not just at the terminal state.
    const updateRunSpy = vi.spyOn(store, 'updateRun');

    const manager = new RunManager(store, repoRoot);
    await manager.recover();

    await expect
      .poll(() => store.getRun(record.id)?.status, { timeout: 10_000 })
      .toBe('failed');

    const after = store.getRun(record.id);
    expect(after?.error).toContain(
      "is not supported when using Codex with a ChatGPT account",
    );
    const statusesSeen = updateRunSpy.mock.calls
      .map(([, patch]) => (patch as { status?: unknown }).status)
      .filter((status) => status !== undefined);
    expect(statusesSeen).not.toContain('waiting');

    manager.dispose();
    updateRunSpy.mockRestore();
  }, 15_000);
});
