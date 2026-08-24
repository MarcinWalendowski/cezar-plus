import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { WorkflowDef } from './types.ts';
import { RunManager } from './run.ts';
import { localCliAuthor } from '../runs/task-author.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Wiring-level coverage for the canonical provider/model identity (#405).
 *
 * `model-identity.test.ts` pins the pure mapper; this suite pins the part the
 * PR actually ships — that the run WIRING uses it. It drives the real engine
 * under `CEZ_DRY_RUN=1` and asserts on both ends of the seam at once:
 *
 *  - the wire form the runner is handed (captured from the mock's argv via
 *    `CEZ_MOCK_ARGS_FILE`), and
 *  - the identity persisted on the record (`RunRecord.modelIdentity`).
 *
 * Those two agreeing IS the property #405 exists to guarantee: "a run record
 * can end up asserting a model that is not what actually ran" is exactly the
 * failure a green unit suite over the mapper alone would not have caught.
 */
describe('model identity wiring (dry run)', () => {
  let repoRoot: string;
  let argsFile: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-model-identity-'));
    argsFile = join(repoRoot, 'mock-args.ndjson');
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    savedEnv.CEZ_MOCK_ARGS_FILE = process.env.CEZ_MOCK_ARGS_FILE;
    savedEnv.CEZ_FOLLOWUPS = process.env.CEZ_FOLLOWUPS;
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_MOCK_ARGS_FILE = argsFile;
    delete process.env.CEZ_FOLLOWUPS;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify({ maxParallel: 1 }), 'utf8');
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  // Agent step + trailing check, so the agent session auto-ends and the run
  // reaches a terminal status instead of parking at `waiting`.
  const workflow: WorkflowDef = {
    name: 'model-identity-test',
    source: 'built-in',
    steps: [
      { id: 'work', prompt: '{{task}}' },
      { id: 'verify', command: 'true' },
    ],
  };

  const TERMINAL = new Set(['done', 'review', 'failed', 'cancelled']);

  async function settle(runId: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (!TERMINAL.has(store.getRun(runId)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function runToEnd(input: { task: string; model?: string }, def: WorkflowDef = workflow): Promise<string> {
    writeFileSync(argsFile, '', 'utf8'); // fresh capture per run
    const record = manager.startRun(def, { ...input, author: localCliAuthor() });
    await settle(record.id);
    return record.id;
  }

  /** The persisted step, by id — the per-step half of the seam (spec
   *  2026-08-22-per-step-model-display). */
  function stepOf(runId: string, stepId: string) {
    return store.getRun(runId)?.steps.find((s) => s.id === stepId);
  }

  /** The value the mock was actually invoked with for `flag`, or undefined when unset. */
  function capturedFlag(flag: string, index = 0): string | undefined {
    const lines = readFileSync(argsFile, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(index);
    const argv = JSON.parse(lines[index] as string) as string[];
    const idx = argv.indexOf(flag);
    return idx < 0 ? undefined : argv[idx + 1];
  }

  /** The `--model` value the mock was actually invoked with, or undefined when unset. */
  function capturedModel(index = 0): string | undefined {
    return capturedFlag('--model', index);
  }

  it('a bare preset reaches the CLI bare and persists provider-qualified', async () => {
    const id = await runToEnd({ task: 'do the thing', model: 'opus' });
    // The wire form the claude CLI wants is the bare alias …
    expect(capturedModel()).toBe('opus');
    // … while the record carries the canonical identity (#405's whole point).
    expect(store.getRun(id)?.modelIdentity).toBe('anthropic/opus');
    expect(store.getRun(id)?.model).toBe('opus'); // the free-text surface is untouched
    // … and the STEP carries its own copy, which no later step can clobber (spec
    // 2026-08-22-per-step-model-display).
    expect(stepOf(id, 'work')).toMatchObject({ model: 'opus', modelIdentity: 'anthropic/opus' });
    // A check step never reaches `runAgentStep`, so it resolves nothing and records nothing.
    expect(stepOf(id, 'verify')?.model).toBeUndefined();
    expect(stepOf(id, 'verify')?.modelIdentity).toBeUndefined();
  }, 30_000);

  it('an auto (empty) model persists no identity and pins nothing on the wire', async () => {
    const id = await runToEnd({ task: 'do the thing' });
    expect(capturedModel()).toBeUndefined();
    expect(store.getRun(id)?.modelIdentity).toBeUndefined();
    expect(stepOf(id, 'work')?.model).toBeUndefined();
    expect(stepOf(id, 'work')?.modelIdentity).toBeUndefined();
  }, 30_000);

  /**
   * THE case this spec exists for. Before it, `RunRecord.modelIdentity` was one slot every step
   * rewrote, so a chain that deliberately runs one step on a different model (`spec-to-deploy`
   * puts `review-spec` on opus and its other seven steps on sonnet, spec
   * 2026-08-21-per-step-model-policy) finished asserting only the LAST step's model and discarded
   * every earlier one. Asserting `steps[0]` AND `steps[1]` after both have run is what pins that
   * the second no longer overwrites the first.
   */
  it('each step of a multi-model chain keeps its OWN resolved model', async () => {
    const chain: WorkflowDef = {
      name: 'model-per-step-test',
      source: 'built-in',
      steps: [
        { id: 'plan', prompt: '{{task}}', model: 'opus' },
        { id: 'build', prompt: '{{task}}', model: 'haiku' },
        { id: 'verify', command: 'true' },
      ],
    };
    const id = await runToEnd({ task: 'do the thing', model: 'sonnet' }, chain);
    // Both steps went to the CLI on their own model …
    expect(capturedModel(0)).toBe('opus');
    expect(capturedModel(1)).toBe('haiku');
    // … and the record says so per step, rather than showing `haiku` twice.
    expect(stepOf(id, 'plan')).toMatchObject({ model: 'opus', modelIdentity: 'anthropic/opus' });
    expect(stepOf(id, 'build')).toMatchObject({ model: 'haiku', modelIdentity: 'anthropic/haiku' });
    // The run-level field is unchanged in behaviour — still the last step's — which is exactly why
    // it could not answer this question and the per-step pair had to exist.
    expect(store.getRun(id)?.modelIdentity).toBe('anthropic/haiku');
  }, 40_000);

  it('a provider-qualified model is normalised to the bare wire form for claude', async () => {
    // `anthropic/claude-opus-4-1` is deliberately NOT one of opencode's known
    // presets, so `continueRun`'s foreign-pin guard leaves it on the record and
    // the continuation below exercises the normaliser rather than a cleared pin.
    const id = await runToEnd({ task: 'do the thing', model: 'anthropic/claude-opus-4-1' });
    expect(capturedModel()).toBe('claude-opus-4-1');
    expect(store.getRun(id)?.modelIdentity).toBe('anthropic/claude-opus-4-1');
  }, 30_000);

  it('a continuation normalises the same way as the first spawn (#405 review M1)', async () => {
    const id = await runToEnd({ task: 'do the thing', model: 'anthropic/claude-opus-4-1' });
    expect(capturedModel(0)).toBe('claude-opus-4-1');

    await expect(manager.continueRun(id, { text: 'keep going' })).resolves.toEqual({ ok: true });
    const deadline = Date.now() + 20_000;
    while (readFileSync(argsFile, 'utf8').trim().split('\n').length < 2) {
      if (Date.now() > deadline) throw new Error('continuation did not start in time');
      await new Promise((r) => setTimeout(r, 100));
    }
    // The continuation reads `model` off the record — the RAW free-text string.
    // Without the normaliser it would hand the CLI `anthropic/claude-opus-4-1`,
    // a wire form the first step already converted away: same run, two models.
    expect(capturedModel(1)).toBe('claude-opus-4-1');
    // A resumed session has no wall clock and parks at `waiting`, so this
    // asserts the record directly — the identity is written before the spawn.
    expect(store.getRun(id)?.modelIdentity).toBe('anthropic/claude-opus-4-1');
  }, 40_000);

  it('a follow-up model override re-writes the persisted identity (#401 + #405)', async () => {
    const id = await runToEnd({ task: 'do the thing', model: 'opus' });
    expect(store.getRun(id)?.modelIdentity).toBe('anthropic/opus');

    // #401 lets a continuation switch the model. The record must follow what
    // actually ran, not keep asserting the model the run STARTED with.
    await expect(manager.continueRun(id, { text: 'keep going', model: 'haiku' })).resolves.toEqual({
      ok: true,
    });
    const deadline = Date.now() + 20_000;
    while (readFileSync(argsFile, 'utf8').trim().split('\n').length < 2) {
      if (Date.now() > deadline) throw new Error('continuation did not start in time');
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(capturedModel(1)).toBe('haiku');
    // The record now asserts what the continuation ran, not what the run started with.
    expect(store.getRun(id)?.modelIdentity).toBe('anthropic/haiku');
    // The STEP half of the same guarantee. A continuation is its OWN step (`continue-1`), so this
    // also proves `runContinuation` writes the pair rather than leaving the new step blank while
    // the run-level field moves on — the run-level defect #405 removed, reintroduced one level
    // down. The original step keeps the model IT ran on; nothing retroactively rewrites it.
    expect(stepOf(id, 'continue-1')).toMatchObject({ model: 'haiku', modelIdentity: 'anthropic/haiku' });
    expect(stepOf(id, 'work')).toMatchObject({ model: 'opus', modelIdentity: 'anthropic/opus' });
  }, 40_000);

  it('Claude gateway models run with their provider-qualified wire id', async () => {
    const id = await runToEnd({ task: 'do the thing', model: 'deepseek/deepseek-v4-flash' });
    const record = store.getRun(id);
    expect(record?.status).toBe('done');
    expect(record?.modelIdentity).toBe('deepseek/deepseek-v4-flash');
    expect(capturedModel(0)).toBe('deepseek/deepseek-v4-flash');
  }, 30_000);

  it('fails a run when the runner reports a model error instead of parking it as active', async () => {
    const id = await runToEnd({ task: 'mock:auth-error' });
    const record = store.getRun(id);
    expect(record?.status).toBe('failed');
    expect(record?.error).toContain('Failed to authenticate');
    expect(record?.steps.find((step) => step.id === 'work')?.status).toBe('failed');
  }, 30_000);

  it('a continuation with an unsupported Codex provider still fails loudly', async () => {
    const id = await runToEnd({ task: 'do the thing', model: 'opus' });
    expect(store.getRun(id)?.modelIdentity).toBe('anthropic/opus');

    await expect(
      manager.continueRun(id, {
        text: 'keep going',
        runner: 'codex',
        model: 'anthropic/claude-opus-4-8',
      }),
    ).resolves.toEqual({ ok: false, error: "model 'anthropic/claude-opus-4-8' is not a codex model" });
  }, 40_000);
});

/**
 * The per-runner step override reaches the RUNNER, not just the resolver
 * (`.ai/specs/2026-08-24-codex-step-model-and-effort.md`, D1).
 *
 * `types.test.ts` pins `resolveStepModel` as a pure function; this pins the half that ships — that
 * `runAgentStep` reads the resolved PAIR and hands both halves to the spawned agent. It is driven
 * on the **claude** backend deliberately, because that is the one whose model and effort both
 * appear in argv and can therefore be observed from outside. The codex leg differs only in which
 * runner consumes `AgentRunSpec.effort`, and `codex-app-server-runner.test.ts` pins that end
 * against the mock app-server's real `turn/start` payload. The two halves meet at `AgentRunSpec`.
 *
 * Without this, "the table applies" is provable by a resolver nothing calls — the shape where a
 * unit suite is green over a function the engine reads one line above and then ignores.
 */
describe('byRunner reaches the runner (dry run)', () => {
  let repoRoot: string;
  let argsFile: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-byrunner-'));
    argsFile = join(repoRoot, 'mock-args.ndjson');
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    savedEnv.CEZ_MOCK_ARGS_FILE = process.env.CEZ_MOCK_ARGS_FILE;
    savedEnv.CEZ_FOLLOWUPS = process.env.CEZ_FOLLOWUPS;
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_MOCK_ARGS_FILE = argsFile;
    delete process.env.CEZ_FOLLOWUPS;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify({ maxParallel: 1 }), 'utf8');
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const TERMINAL = new Set(['done', 'review', 'failed', 'cancelled']);

  async function drive(def: WorkflowDef): Promise<string> {
    writeFileSync(argsFile, '', 'utf8');
    const record = manager.startRun(def, { task: 'do the thing', author: localCliAuthor() });
    const deadline = Date.now() + 20_000;
    while (!TERMINAL.has(store.getRun(record.id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }
    return record.id;
  }

  function argvOf(index = 0): string[] {
    const lines = readFileSync(argsFile, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(index);
    return JSON.parse(lines[index] as string) as string[];
  }
  const flag = (name: string): string | undefined => {
    const argv = argvOf();
    const idx = argv.indexOf(name);
    return idx < 0 ? undefined : argv[idx + 1];
  };

  it('hands the spawned agent BOTH halves of the override, not the step\'s own pair', async () => {
    await drive({
      name: 'byrunner-test',
      source: 'built-in',
      steps: [
        {
          id: 'work',
          prompt: '{{task}}',
          model: 'sonnet',
          effort: 'low',
          byRunner: { claude: { model: 'haiku', effort: 'max' } },
        },
        { id: 'verify', command: 'true' },
      ],
    });
    expect(flag('--model')).toBe('haiku');
    expect(flag('--effort')).toBe('max');
  }, 30_000);

  it('leaves a step with no override on its own pair', async () => {
    // The negative control: without it, the assertion above is equally satisfied by wiring that
    // ignores `step.model`/`step.effort` entirely and always reads `byRunner`.
    await drive({
      name: 'byrunner-control',
      source: 'built-in',
      steps: [
        { id: 'work', prompt: '{{task}}', model: 'sonnet', effort: 'low' },
        { id: 'verify', command: 'true' },
      ],
    });
    expect(flag('--model')).toBe('sonnet');
    expect(flag('--effort')).toBe('low');
  }, 30_000);

  it('ignores another runner\'s override entirely', async () => {
    await drive({
      name: 'byrunner-other',
      source: 'built-in',
      steps: [
        {
          id: 'work',
          prompt: '{{task}}',
          model: 'sonnet',
          effort: 'low',
          byRunner: { codex: { model: 'gpt-5.6-luna', effort: 'xhigh' } },
        },
        { id: 'verify', command: 'true' },
      ],
    });
    expect(flag('--model')).toBe('sonnet');
    expect(flag('--effort')).toBe('low');
  }, 30_000);
});
