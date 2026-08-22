import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { buildChildEnv } from '../core/agent-env.ts';
import { authorFromAgentEnv, localCliAuthor, taskAuthorSchema } from '../runs/task-author.ts';
import { RunManager } from './run.ts';

/**
 * `CEZ_STEP_ID` / `CEZ_SESSION_ID` — Phase 2 of
 * `.ai/specs/2026-08-21-task-author-provenance.md`.
 *
 * `CEZ_TASK_ID` answers "which task" and has since spec 007. A task filed from inside a run also
 * has to name the SESSION that filed it, and a session id is a step-level fact that was never
 * exported into a child's environment at all — so the owner's third requirement ("if different
 * agent sessions, require what was parent task + agent session") was not merely unrecorded before
 * this, it was unreachable from where a task gets filed.
 *
 * | Guard | Mutation that must turn it red |
 * |---|---|
 * | Both vars are present on an agent step's env | drop either from `agentEnvForStep` |
 * | Both are PRESENT-BUT-EMPTY when unknown | make them conditional spreads instead |
 * | `buildChildEnv` forwards both to the spawned process | add either to a secret-shaped name |
 * | Together with `CEZ_TASK_ID` they produce a complete `agent` author | any of the three |
 *
 * Asserted THROUGH `buildChildEnv`, not by inspecting `agentEnvForStep`'s return value alone: the
 * question is what the spawned process can read, and the curated-env allowlist sits between the
 * two.
 */
describe('the agent step env carries the step and session ids', () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  /** The private seam — the `agent-profile-wiring.test.ts` access pattern. */
  type Seam = {
    agentEnvForStep(
      runId: string,
      backend: 'claude' | 'codex' | 'opencode',
      options?: {
        generateFollowups?: boolean;
        recordedProfileId?: string;
        stepId?: string;
        sessionId?: string;
      },
    ): Promise<{ env: Record<string, string>; profileId: string }>;
  };
  const seam = () => manager as unknown as Seam;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-session-env-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-session-env-repo-'));
    process.env.CEZ_HOME = home;
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  const newRun = () =>
    store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 't',
      author: localCliAuthor(),
      steps: [{ id: 'implement', name: 'implement', kind: 'agent' }],
    });

  it('exports the step and session ids alongside the task id', async () => {
    const run = newRun();
    const { env } = await seam().agentEnvForStep(run.id, 'claude', {
      stepId: 'implement',
      sessionId: 'sess_abc',
    });
    expect(env.CEZ_TASK_ID).toBe(run.id);
    expect(env.CEZ_STEP_ID).toBe('implement');
    expect(env.CEZ_SESSION_ID).toBe('sess_abc');
  });

  it('sets both to EMPTY rather than omitting them when unknown', async () => {
    // Present-but-empty is load-bearing: a nested cezar inherits its parent's `process.env`
    // wholesale, so an omitted key would let the PARENT run's session id shine through and a task
    // filed by the child would name the wrong session. The `CEZ_TODOS_FILE` spelling, same reason.
    const run = newRun();
    const { env } = await seam().agentEnvForStep(run.id, 'claude');
    expect(env.CEZ_STEP_ID).toBe('');
    expect(env.CEZ_SESSION_ID).toBe('');
  });

  it('buildChildEnv forwards both to the spawned process', async () => {
    const run = newRun();
    const { env } = await seam().agentEnvForStep(run.id, 'claude', {
      stepId: 'implement',
      sessionId: 'sess_abc',
    });
    const child = buildChildEnv({ backend: 'claude', extraEnv: env, source: { PATH: '/usr/bin' } });
    expect(child.CEZ_TASK_ID).toBe(run.id);
    expect(child.CEZ_STEP_ID).toBe('implement');
    expect(child.CEZ_SESSION_ID).toBe('sess_abc');
  });

  it('an empty parent value cannot shine through into the child', async () => {
    const run = newRun();
    const { env } = await seam().agentEnvForStep(run.id, 'claude');
    const child = buildChildEnv({
      backend: 'claude',
      extraEnv: env,
      // A host env polluted by an OUTER cezar run — exactly the nested case.
      source: { PATH: '/usr/bin', CEZ_SESSION_ID: 'the-parents-session', CEZ_STEP_ID: 'the-parents-step' },
    });
    expect(child.CEZ_SESSION_ID).toBe('');
    expect(child.CEZ_STEP_ID).toBe('');
  });

  it('the three ids together are what make a complete `agent` author reachable', async () => {
    const run = newRun();
    const { env } = await seam().agentEnvForStep(run.id, 'claude', {
      stepId: 'implement',
      sessionId: 'sess_abc',
    });
    const child = buildChildEnv({ backend: 'claude', extraEnv: env, source: { PATH: '/usr/bin' } });
    const author = authorFromAgentEnv(child, 'cli-todo-add');
    expect(taskAuthorSchema.safeParse(author).success).toBe(true);
    expect(author).toMatchObject({
      kind: 'agent',
      id: run.id,
      parentTaskId: run.id,
      agentSessionId: 'sess_abc',
      parentStepId: 'implement',
    });
  });
});
