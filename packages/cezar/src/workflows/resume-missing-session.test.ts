import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeProjectDirSlug } from '../core/claude-cli-runner.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const MOCK_CODEX = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  'core',
  '__fixtures__',
  'codex',
  'mock-codex-app-server.mjs',
);

/**
 * Spec 2026-08-22-resume-fresh-session-fallback, Phase 4.
 *
 * Root-caused from run `232ad6d4` (`spec-to-deploy`, `commit-push` iteration 1 killed before any
 * transcript existed; iteration 2 resumed the never-created session id and the CLI's rejection
 * fell through the generic failure path, killing the whole run). Three cases, driven end-to-end
 * through the real engine (`CEZ_DRY_RUN=1`, real `RunManager`, no stubbing) because the defect
 * lives in the seam between the runner's rejection and the chain loop, which a stub on either
 * side would not exercise:
 *  (a) the PROACTIVE check (Phase 1) — the exact shape that killed `232ad6d4`: no transcript
 *      ever existed, so the CLI is never even spawned with `--resume`.
 *  (b) the REACTIVE fallback in the chain loop (Phase 2), Claude — a decoy transcript lets the
 *      proactive check pass, the CLI is spawned with `--resume`, and the mock rejects it exactly
 *      as `232ad6d4`'s real CLI did.
 *  (c) the REACTIVE fallback in the chain loop (Phase 2), Codex — the codex twin of (b), and the
 *      one case that actually proves the CHAIN-LOOP branch specifically:
 *      `recover-session-failure.test.ts` only ever drives the single-step `runContinuation` path.
 */
describe('a resumed session cezar never confirmed existed does not fail its step permanently', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  /** A `spec-to-deploy`-shaped chain: `spec` (already done), the target step, then a trailing
   *  interactive step — at least two agent steps remain from the target onward, which is what
   *  `onlyIfMoreStepsFollow` requires before `recover()` re-enters the CHAIN rather than falling
   *  back to a single-step continuation (the path `recover-session-failure.test.ts` covers). */
  function seedChain(opts: {
    backend: 'claude' | 'codex';
    targetSessionId: string;
    lastStepPrompt: string;
  }): { workflow: WorkflowDef; runId: string } {
    const SHIP_PROMPT =
      "The change is implemented and its tests pass. SHIP it, following THIS repository's own " +
      'conventions — commit, push, and follow the repo\'s own release process.\n\n{{task}}';
    const workflow: WorkflowDef = {
      name: 'spec-to-deploy',
      description: 'x',
      source: 'built-in',
      steps: [
        { id: 'spec', name: 'spec', prompt: '{{task}}' },
        { id: 'commit-push', name: 'commit-push', prompt: SHIP_PROMPT },
        { id: 'deploy', name: 'deploy', prompt: opts.lastStepPrompt },
      ],
    };
    const record = store.createRun({
      title: 't',
      workflow: 'spec-to-deploy',
      task: 'ship the fix',
      runner: opts.backend,
      worktree: false,
      steps: [
        { id: 'spec', name: 'spec', kind: 'agent' },
        { id: 'commit-push', name: 'commit-push', kind: 'agent' },
        { id: 'deploy', name: 'deploy', kind: 'agent' },
      ],
    });
    store.updateRun(record.id, { workflowDef: workflow });
    store.updateStep(record.id, 'spec', { status: 'done' });
    store.updateStep(record.id, 'commit-push', {
      status: 'running',
      iterations: 1,
      sessionId: opts.targetSessionId,
      backend: opts.backend,
    });
    store.updateRun(record.id, { status: 'running', currentStepId: 'commit-push' });
    return { workflow, runId: record.id };
  }

  const settled = async (runId: string, ms = 45_000) => {
    const terminal = new Set(['done', 'review', 'failed', 'cancelled', 'waiting']);
    const deadline = Date.now() + ms;
    while (!terminal.has(store.getRun(runId)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error(`run did not settle: ${store.getRun(runId)?.status}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    return store.getRun(runId)!;
  };

  const events = (runId: string): Array<Record<string, unknown>> =>
    readFileSync(join(repoRoot, '.ai/cezar', 'runs', `${runId}.ndjson`), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-resume-missing-'));
    for (const key of [
      'CEZ_DRY_RUN',
      'CLAUDE_CONFIG_DIR',
      'MOCK_CLAUDE_REJECT_RESUME',
      'MOCK_CODEX_REJECT_RESUME',
      'CEZ_CODEX_BIN',
      'CEZ_ENV_PASSTHROUGH',
    ]) {
      savedEnv[key] = process.env[key];
    }
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    manager?.dispose();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('(a) proactive: a session whose transcript never existed is downgraded before the CLI ever spawns', async () => {
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.MOCK_CLAUDE_REJECT_RESUME;
    // An empty `projects/` dir — resolvable, so the check genuinely answers "no transcript"
    // rather than failing open on an unreadable/missing directory (see Architecture/Risks: a
    // resolution FAILURE must fail open, but a real, empty scan correctly answers false).
    const claudeHome = mkdtempSync(join(tmpdir(), 'cez-resume-missing-claude-home-'));
    mkdirSync(join(claudeHome, 'projects'), { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    // `CEZ_`-prefixed vars pass the child-env allowlist unconditionally (agent-env.ts) — no
    // per-step opt-in needed. Captures the FULL untruncated inbound text of every spawned
    // session's every turn, unlike the mock's own `notes.md` trace (truncated to 400 chars,
    // which the long chain-boundary note pushes the ship prompt's own text well past).
    const stdinFile = join(mkdtempSync(join(tmpdir(), 'cez-resume-missing-stdin-')), 'stdin.ndjson');
    process.env.CEZ_MOCK_STDIN_FILE = stdinFile;

    const deadSessionId = 'sess-commit-push-never-created';
    const { runId } = seedChain({
      backend: 'claude',
      targetSessionId: deadSessionId,
      lastStepPrompt: 'mock:done ship it',
    });

    manager = new RunManager(store, repoRoot);
    await manager.recover();
    const finished = await settled(runId);

    // The run reaches a non-failed terminal status — not the permanent kill `232ad6d4` suffered.
    expect(finished.status).not.toBe('failed');
    expect(finished.status).toBe('done');

    // A note records the proactive check firing, and the step's session id changed.
    const noteMessages = events(runId)
      .filter((e) => e.type === 'note')
      .map((e) => String(e.message));
    expect(noteMessages.some((m) => m.includes('no transcript for the recorded session'))).toBe(true);
    const commitPush = finished.steps.find((s) => s.id === 'commit-push');
    expect(commitPush?.sessionId).toBeDefined();
    expect(commitPush?.sessionId).not.toBe(deadSessionId);
    expect(commitPush?.status).toBe('done');

    // The chain really continued — `deploy` ran too, not collapsed into a `continue-N` chat.
    expect(finished.steps.find((s) => s.id === 'deploy')?.status).toBe('done');
    expect(finished.steps.some((s) => s.id.startsWith('continue-'))).toBe(false);

    // The prompt actually delivered to the fresh session is the step's own template, not the
    // restart-continuation prompt: `runAgentStep` sends the opening message straight to the CLI
    // without a `user-message` store event, so `CEZ_MOCK_STDIN_FILE`'s untruncated capture of
    // every spawned session's inbound text is what proves what actually reached it — the
    // assertion this case exists for (spec Phase 1's userPrompt-rebuild fix). Every other
    // assertion above passes even on a contextless fresh session that merely "completes".
    const inbound = readFileSync(stdinFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => (JSON.parse(l) as { userText: string }).userText);
    expect(inbound.some((t) => t.includes("SHIP it, following THIS repository's own"))).toBe(true);
    expect(
      inbound.some((t) => t.includes('The cezar process restarted while you were working on this task')),
    ).toBe(false);

    rmSync(claudeHome, { recursive: true, force: true });
  }, 70_000);

  it('(b) reactive, Claude: a rejected --resume retries once with a fresh session in the chain loop', async () => {
    process.env.CEZ_DRY_RUN = '1';
    process.env.MOCK_CLAUDE_REJECT_RESUME = '1';
    process.env.CEZ_ENV_PASSTHROUGH = 'MOCK_CLAUDE_REJECT_RESUME';
    const claudeHome = mkdtempSync(join(tmpdir(), 'cez-resume-missing-claude-home-'));
    process.env.CLAUDE_CONFIG_DIR = claudeHome;

    const targetSessionId = 'sess-commit-push-decoy';
    const { runId } = seedChain({
      backend: 'claude',
      targetSessionId,
      lastStepPrompt: 'mock:done ship it',
    });
    // A decoy transcript so Phase 1's probe passes and `runAgentStep` actually spawns the mock
    // with `--resume` — this is what makes it Phase 2's fallback under test, not Phase 1's.
    const decoyDir = join(claudeHome, 'projects', claudeProjectDirSlug(repoRoot));
    mkdirSync(decoyDir, { recursive: true });
    writeFileSync(join(decoyDir, `${targetSessionId}.jsonl`), '{}\n');

    manager = new RunManager(store, repoRoot);
    await manager.recover();
    const finished = await settled(runId);

    expect(finished.status).not.toBe('failed');
    expect(finished.status).toBe('done');

    const allEvents = events(runId);
    const retryMetrics = allEvents.filter(
      (e) => e.type === 'metric' && e.name === 'run.step.resumed_after_missing_session',
    );
    expect(retryMetrics).toHaveLength(1); // exactly one retry
    expect(
      allEvents.some(
        (e) =>
          e.type === 'note' &&
          String(e.message).includes('the session was never confirmed to exist'),
      ),
    ).toBe(true);

    const commitPush = finished.steps.find((s) => s.id === 'commit-push');
    expect(commitPush?.sessionId).toBeDefined();
    expect(commitPush?.sessionId).not.toBe(targetSessionId);
    expect(commitPush?.status).toBe('done');
    expect(finished.steps.find((s) => s.id === 'deploy')?.status).toBe('done');

    rmSync(claudeHome, { recursive: true, force: true });
  }, 70_000);

  it('(c) reactive, Codex, on the CHAIN-LOOP path (not the single-step continuation path)', async () => {
    delete process.env.CEZ_DRY_RUN;
    process.env.CEZ_CODEX_BIN = MOCK_CODEX;
    process.env.MOCK_CODEX_REJECT_RESUME = '1';
    process.env.CEZ_ENV_PASSTHROUGH = 'MOCK_CODEX_REJECT_RESUME';

    const targetSessionId = 'missing-thread';
    // Codex's default scripted turn never emits a completion marker, so the trailing interactive
    // step cannot reach `done` here the way the claude cases do — it parks `waiting` instead,
    // which is still a non-failed terminal status.
    const { runId } = seedChain({
      backend: 'codex',
      targetSessionId,
      lastStepPrompt: '{{task}}',
    });

    manager = new RunManager(store, repoRoot);
    await manager.recover();
    const finished = await settled(runId);

    expect(finished.status).not.toBe('failed');
    expect(finished.status).toBe('waiting');

    const allEvents = events(runId);
    const retryMetrics = allEvents.filter(
      (e) => e.type === 'metric' && e.name === 'run.step.resumed_after_missing_session',
    );
    expect(retryMetrics).toHaveLength(1);
    expect(
      allEvents.some(
        (e) =>
          e.type === 'note' &&
          String(e.message).includes('the session was never confirmed to exist'),
      ),
    ).toBe(true);

    const commitPush = finished.steps.find((s) => s.id === 'commit-push');
    expect(commitPush?.sessionId).toBeDefined();
    expect(commitPush?.sessionId).not.toBe(targetSessionId);
    expect(commitPush?.status).toBe('done');
    // The chain kept going past the retried step — `deploy` actually started, proving the
    // CHAIN-LOOP branch (not just a single continuation) is what carried this run forward.
    expect(finished.steps.find((s) => s.id === 'deploy')?.iterations).toBeGreaterThanOrEqual(1);

    // The trailing interactive step parks `waiting` with its backend process still alive (no
    // completion marker fires it) — cancel it so nothing leaks past this test.
    manager.cancel(runId);
  }, 70_000);
});
