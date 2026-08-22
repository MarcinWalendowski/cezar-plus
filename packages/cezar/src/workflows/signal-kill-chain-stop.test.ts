import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { localCliAuthor } from '../runs/task-author.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

/**
 * The orchestration-level regression for "a run whose agent is killed by a signal reports done,
 * and the workflow continues." `claude-cli-runner.test.ts` and `broker-external-kill.test.ts`
 * pin the fix at the transport level (the session's `result` rejects and names the signal); this
 * file proves the fact that actually mattered — that `RunManager` treats the killed step as a
 * FAILURE and never runs the step after it. A test that only checked the step's status would pass
 * against a fix that marks the step red and still lets the chain continue, which is exactly the
 * shape of the original defect (the agent did no work, the run said `done`, and the next step ran
 * anyway). `run-tests` deliberately carries no `verify:` here, mirroring the real `spec-to-deploy`
 * shape the defect was found in — nothing downstream would have caught a false `done` either.
 */

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const STUB_BIN = fileURLToPath(
  new URL('../core/__fixtures__/claude/stub-suicide-sigkill.mjs', import.meta.url),
);

async function waitFor(predicate: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const settledStatuses = ['done', 'failed', 'cancelled', 'review', 'waiting'];

const CHAIN: WorkflowDef = {
  name: 'signal-kill-chain-stop-repro',
  source: 'built-in',
  steps: [
    { id: 'run-tests', name: 'Run the tests', prompt: '{{task}}' },
    { id: 'after', name: 'The step after', command: 'node -e ""' },
  ],
};

describe('an agent killed by an untrapped external signal stops the chain', () => {
  const roots: string[] = [];
  const managers: RunManager[] = [];
  const saved: Record<string, string | undefined> = {};

  afterEach(async () => {
    for (const manager of managers.splice(0)) manager.dispose();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.CEZ_DRY_RUN = undefined;
    saved.CEZ_CLAUDE_BIN = undefined;
  });

  it('run-tests fails naming the signal, and "after" never runs (not a false done)', async () => {
    saved.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    saved.CEZ_CLAUDE_BIN = process.env.CEZ_CLAUDE_BIN;
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_CLAUDE_BIN = STUB_BIN;

    const root = mkdtempSync(join(tmpdir(), 'cez-signal-kill-chain-'));
    roots.push(root);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', [...GIT_ID, 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });

    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 2 } }),
    });
    managers.push(manager);

    const run = manager.startRun(CHAIN, { author: localCliAuthor(), task: 'run the gates' });
    await waitFor(() => settledStatuses.includes(store.getRun(run.id)?.status ?? ''), 'the run to settle');

    const record = store.getRun(run.id);
    const runTests = record?.steps.find((s) => s.id === 'run-tests');
    const after = record?.steps.find((s) => s.id === 'after');

    // The core defect: the killed step must be reported FAILED, not `done`, and the error must
    // name the signal — "killed" with no reason is what gets blamed on the tests.
    expect(runTests?.status).toBe('failed');
    expect(runTests?.error ?? '').toMatch(/SIGKILL/);

    // The damaging property the bug had: the chain used to CONTINUE past a killed step. `after`
    // must never have run — this is the assertion a fix that only recolors the step red, without
    // actually stopping the chain, would fail.
    expect(after?.status).toBe('pending');

    expect(record?.status).toBe('failed');
    expect(record?.error ?? '').toContain('run-tests');
  }, 30_000);
});
