import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { loopBackResumeDecision, RunManager } from './run.ts';
import type { WorkflowDef, WorkflowStepDef } from './types.ts';
import { localCliAuthor } from '../runs/task-author.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * `.ai/specs/2026-08-29-step-resume-and-two-stage-review.md`, D1.
 *
 * Measured origin: on run `872b396a` a `revise` verdict re-ran `spec` from a fresh session — 11:39
 * and $5.92 to rewrite a document the SAME step had finished 14 minutes earlier, re-reading 373k
 * tokens of file dumps that were still in the window the engine threw away.
 */
describe('loopBackResumeDecision — every guard falls back COLD, and says which one fired', () => {
  const agent: WorkflowStepDef = { id: 'spec', name: 'Write the spec', prompt: '{{task}}' };
  const check: WorkflowStepDef = { id: 'gate', name: 'Gate', command: 'true' };
  const record = { sessionId: 'sess-spec-1', profileId: 'prof-a', backend: 'claude' as const };

  it('resumes when the workflow asked and the target really ran on its own runner', () => {
    const d = loopBackResumeDecision({ enabled: true, target: agent, targetRecord: record, taskBackend: 'claude' });
    expect(d.reason).toBe('resumed');
    expect(d.resume?.sessionId).toBe('sess-spec-1');
    // `sessionId` and `profileId` travel as a pair, or the resume lands on the wrong account.
    expect(d.resume?.profileId).toBe('prof-a');
    // A Claude session with no transcript must never reach `--resume`.
    expect(d.resume?.verifyTranscript).toBe(true);
    // The continuation prompt REPLACES the step's own prompt, so it must not re-issue the
    // original instructions to a window that already contains the finished artifact.
    expect(d.resume?.prompt).toContain('Write the spec');
    expect(d.resume?.prompt).toContain('SAME session');
    expect(d.resume?.prompt).not.toContain('{{task}}');
  });

  it('is OFF by default — a workflow that never opted in keeps starting cold', () => {
    // The load-bearing negative: if this ever returned a handle, every `onFail.retry` in every
    // user workflow on disk would silently change behaviour on upgrade.
    const d = loopBackResumeDecision({ enabled: false, target: agent, targetRecord: record, taskBackend: 'claude' });
    expect(d).toEqual({ reason: 'disabled' });
    expect(d.resume).toBeUndefined();
  });

  it('refuses a check step — there is no session to re-enter', () => {
    const d = loopBackResumeDecision({ enabled: true, target: check, targetRecord: record, taskBackend: 'claude' });
    expect(d).toEqual({ reason: 'not-agent' });
  });

  it('refuses a target that never recorded a session', () => {
    expect(
      loopBackResumeDecision({ enabled: true, target: agent, targetRecord: { backend: 'claude' }, taskBackend: 'claude' }),
    ).toEqual({ reason: 'no-session' });
    expect(
      loopBackResumeDecision({ enabled: true, target: agent, targetRecord: undefined, taskBackend: 'claude' }),
    ).toEqual({ reason: 'no-session' });
  });

  it('refuses when the target actually ran somewhere its own definition does not name', () => {
    // A pinned runner downgraded for quota (`downgradePinnedRunner`). Handing one provider's
    // conversation id to another is not a resume.
    const pinned: WorkflowStepDef = { ...agent, runner: 'claude' };
    const d = loopBackResumeDecision({
      enabled: true,
      target: pinned,
      targetRecord: { sessionId: 's', backend: 'codex' },
      taskBackend: 'claude',
    });
    expect(d).toEqual({ reason: 'backend-changed' });
  });

  it('refuses when an UNPINNED target ran off the run\'s own backend', () => {
    // The same guard from the other side: no `runner` pin, so the comparison is against
    // `taskBackend`. Without this case the guard would be exercised only on pinned steps.
    expect(
      loopBackResumeDecision({
        enabled: true,
        target: agent,
        targetRecord: { sessionId: 's', backend: 'codex' },
        taskBackend: 'claude',
      }),
    ).toEqual({ reason: 'backend-changed' });
  });

  it('still resumes a record that predates the `backend` stamp', () => {
    // Widen the READ (#547's precedent): `runAgentStep` stamps `backend` before it spawns, so a
    // row with a session and no backend is hand-edited or old — not a real mismatch.
    const d = loopBackResumeDecision({
      enabled: true,
      target: agent,
      targetRecord: { sessionId: 'sess-old' },
      taskBackend: 'claude',
    });
    expect(d.reason).toBe('resumed');
  });
});

/**
 * The wiring, end to end through the real engine — `CEZ_DRY_RUN=1`, real `RunManager`, the
 * bundled mock CLI, nothing stubbed. The pure function above cannot prove that `loopBackTo`
 * actually hands its result to the step that re-runs, and that seam is where this feature lives.
 */
describe('a `revise` verdict re-enters the target step in its own session', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  let verdictFile: string;
  let argsFile: string;
  let stdinFile: string;
  const savedEnv: Record<string, string | undefined> = {};

  const chain = (resume: boolean): WorkflowDef => ({
    name: 'two-stage',
    description: 'x',
    source: 'built-in',
    steps: [
      { id: 'spec', name: 'Write the spec', prompt: 'write it: {{task}}' },
      {
        id: 'review',
        name: 'Review the spec',
        prompt: 'review it: {{task}}',
        onFail: { retry: 'spec', max: 1, ...(resume ? { resume: true } : {}) },
      },
      { id: 'tail', name: 'Tail', prompt: 'mock:done finish: {{task}}' },
    ],
  });

  /** One entry per SPAWN: spec#1, review#1 (revise), spec#2, review#2 (pass), tail. */
  const VERDICTS = ['', 'revise', '', 'pass', ''].join('\n');

  const events = (runId: string): Array<Record<string, unknown>> =>
    readFileSync(join(repoRoot, '.ai/cezar', 'runs', `${runId}.ndjson`), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  const sessionsFor = (runId: string, stepId: string): string[] =>
    events(runId)
      .filter((e) => e.type === 'session.started' && e.stepId === stepId)
      .map((e) => String(e.sessionId));

  const settled = async (runId: string, ms = 60_000) => {
    const terminal = new Set(['done', 'review', 'failed', 'cancelled', 'waiting']);
    const deadline = Date.now() + ms;
    while (!terminal.has(store.getRun(runId)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error(`run did not settle: ${store.getRun(runId)?.status}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    return store.getRun(runId)!;
  };

  function start(resume: boolean): string {
    writeFileSync(verdictFile, VERDICTS, 'utf8');
    manager = new RunManager(store, repoRoot);
    return manager.startRun(chain(resume), {
      author: localCliAuthor(),
      task: 'do the thing',
      runner: 'claude',
      worktree: false,
    }).id;
  }

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-loopback-'));
    for (const key of ['CEZ_DRY_RUN', 'CLAUDE_CONFIG_DIR', 'MOCK_CLAUDE_VERDICT_FILE', 'CEZ_MOCK_ARGS_FILE', 'CEZ_MOCK_STDIN_FILE', 'CEZ_ENV_PASSTHROUGH']) {
      savedEnv[key] = process.env[key];
    }
    process.env.CEZ_DRY_RUN = '1';
    // A claude home with NO `projects/` directory: `claudeSessionTranscriptExists` cannot resolve
    // it and FAILS OPEN, which is the behaviour a real machine has for a session the mock never
    // wrote a transcript for. Pointing at a home with an EMPTY `projects/` would instead prove the
    // proactive downgrade, which `resume-missing-session.test.ts` already covers.
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cez-loopback-home-'));
    const hooks = mkdtempSync(join(tmpdir(), 'cez-loopback-hooks-'));
    verdictFile = join(hooks, 'verdicts.txt');
    argsFile = join(hooks, 'args.ndjson');
    stdinFile = join(hooks, 'stdin.ndjson');
    process.env.MOCK_CLAUDE_VERDICT_FILE = verdictFile;
    process.env.CEZ_MOCK_ARGS_FILE = argsFile;
    process.env.CEZ_MOCK_STDIN_FILE = stdinFile;
    // `MOCK_CLAUDE_*` is not a `CEZ_` name, so it needs an explicit pass through the agent-env
    // allowlist to reach the spawned mock at all (`core/agent-env.ts`).
    process.env.CEZ_ENV_PASSTHROUGH = 'MOCK_CLAUDE_VERDICT_FILE';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('with `onFail.resume`, the reworked step keeps its session and is told what changed', async () => {
    const runId = start(true);
    const finished = await settled(runId);
    expect(finished.status).not.toBe('failed');

    // The reviewer really did loop back once.
    const looped = events(runId).filter((e) => e.name === 'run.step.looped_back');
    expect(looped).toHaveLength(1);
    expect(looped[0]).toMatchObject({ stepId: 'review', target: 'spec', attempt: 1, resumed: true, reason: 'resumed' });

    // The proof that matters: `spec` ran twice and BOTH runs are the same conversation.
    const specSessions = sessionsFor(runId, 'spec');
    expect(specSessions).toHaveLength(2);
    expect(specSessions[1]).toBe(specSessions[0]);

    // …and the CLI was actually told to resume it, rather than the id merely being re-recorded.
    const spawns = readFileSync(argsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);
    const resumed = spawns.filter((a) => a.includes('--resume'));
    expect(resumed).toHaveLength(1);
    const argv = resumed[0] ?? [];
    expect(argv[argv.indexOf('--resume') + 1]).toBe(specSessions[0]);

    // The rework is told BOTH things: that it is continuing, and what the reviewer objected to.
    const turns = readFileSync(stdinFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { userText: string });
    const rework = turns.find((t) => t.userText.includes('SAME session'));
    expect(rework).toBeDefined();
    expect(rework!.userText).toContain('Feedback on the previous attempt');
    expect(rework!.userText).toContain('CEZ:REVIEW=revise');
    // It must NOT be re-issued the original instructions — that is how a resumed step re-emits a
    // file it should have edited.
    expect(rework!.userText).not.toContain('write it: do the thing');
  }, 90_000);

  it('WITHOUT `onFail.resume`, the same chain still restarts the step cold', async () => {
    // The negative control. Without it, the test above cannot tell "resume works" from "this
    // engine happened to reuse the session id anyway".
    const runId = start(false);
    const finished = await settled(runId);
    expect(finished.status).not.toBe('failed');

    const looped = events(runId).filter((e) => e.name === 'run.step.looped_back');
    expect(looped).toHaveLength(1);
    expect(looped[0]).toMatchObject({ resumed: false, reason: 'disabled' });

    const specSessions = sessionsFor(runId, 'spec');
    expect(specSessions).toHaveLength(2);
    expect(specSessions[1]).not.toBe(specSessions[0]);
    const spawns = readFileSync(argsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);
    expect(spawns.filter((a) => a.includes('--resume'))).toHaveLength(0);
  }, 90_000);
});
