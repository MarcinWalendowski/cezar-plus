import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { parseStructured, planChain, proposeWorkflowName, type PlannerAccountChoice } from '../../src/planner.js';
import type { AgentRunSpec } from '../../src/core/agent-runner.js';
import { ClaudeCliRunner } from '../../src/core/claude-cli-runner.js';
import { CodexAppServerRunner } from '../../src/core/codex-app-server-runner.js';

test('proposeWorkflowName slugs a title to the file-name form', () => {
  assert.equal(proposeWorkflowName('Fix And Review'), 'fix-and-review');
  assert.equal(proposeWorkflowName('  Ship it!  '), 'ship-it');
  assert.equal(proposeWorkflowName('already-kebab'), 'already-kebab');
});

test('proposeWorkflowName degrades a blank / slug-less title to undefined', () => {
  // The caller keeps the current name rather than blanking it when nothing survives.
  assert.equal(proposeWorkflowName(undefined), undefined);
  assert.equal(proposeWorkflowName('   '), undefined);
  assert.equal(proposeWorkflowName('!!! ???'), undefined);
});

test('parseStructured reads the optional planner title alongside the steps', () => {
  const schema = z.object({
    title: z.string().optional(),
    steps: z.array(z.object({ name: z.string() })),
  });
  const parsed = parseStructured(
    '```json\n{"title":"fix-and-review","steps":[{"name":"Implement"}]}\n```',
    schema,
  );
  assert.deepEqual(parsed, { title: 'fix-and-review', steps: [{ name: 'Implement' }] });
});

// ---- V8: the planner picks its own account (`.ai/specs/2026-08-25-logged-out-account-fallback.md`,
// Solution 4b / Phase 5) ----------------------------------------------------------------------
//
// `planChain` never spawns a real CLI here: `ClaudeCliRunner.prototype.run` / `CodexAppServerRunner
// .prototype.run` are mocked directly, so these assert on exactly what `planChain` HANDS to the
// runner (the env, the model) rather than on process output — the shape Risk R8 calls out
// ("did it invoke codex?" alone would pass a Codex-with-a-Claude-config-dir bug).

const PLAN_RESULT_TEXT = JSON.stringify({
  title: 'do-the-thing',
  steps: [{ name: 'Implement', prompt: '{{task}}' }],
  rationale: 'Implement the thing.',
});

/** A scratch repo root plus a sandboxed `CEZ_HOME`, so a chooser-less `planChain` call's own
 *  `resolveProfileEnvForRoot` read of `~/.cezar/agent-accounts.json` never touches the real home. */
function planTestFixture(t: import('node:test').TestContext): { repoRoot: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'cez-planner-'));
  const home = mkdtempSync(join(tmpdir(), 'cez-planner-home-'));
  const savedHome = process.env.CEZ_HOME;
  process.env.CEZ_HOME = home;
  t.after(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });
  return { repoRoot };
}

test('planChain: an injected chooser moves the runner, model AND profile env together (Risk R8)', async (t) => {
  const { repoRoot } = planTestFixture(t);

  const claudeRun = t.mock.method(ClaudeCliRunner.prototype, 'run', async () => {
    throw new Error('claude must not run — the chooser picked codex');
  });
  const codexCalls: AgentRunSpec[] = [];
  const codexRun = t.mock.method(CodexAppServerRunner.prototype, 'run', async (spec: AgentRunSpec) => {
    codexCalls.push(spec);
    return { text: PLAN_RESULT_TEXT, toolCalls: [], tokensUsed: 0 };
  });

  const chooseAccount = async (): Promise<PlannerAccountChoice> => ({
    provider: 'codex',
    profileId: 'work',
    env: { CODEX_HOME: join(repoRoot, 'codex-work') },
  });

  const result = await planChain(repoRoot, 'do the thing', chooseAccount);

  assert.equal(claudeRun.mock.callCount(), 0);
  assert.equal(codexRun.mock.callCount(), 1);
  // The env HANDED to `runner.run`, not merely which runner was constructed — R8's own mutation.
  assert.deepEqual(codexCalls[0]?.env, { CODEX_HOME: join(repoRoot, 'codex-work') });
  // "sonnet" is a Claude-only alias (`planner.ts`'s own comment) — the codex CLI must never see it.
  assert.equal(codexCalls[0]?.model, undefined);
  assert.equal(result.fallback, false);
  assert.equal(result.rationale, 'Implement the thing.');
});

test('planChain: chooseAccount omitted is byte-identical to the pre-Phase-5 planner', async (t) => {
  const { repoRoot } = planTestFixture(t);

  const codexRun = t.mock.method(CodexAppServerRunner.prototype, 'run', async () => {
    throw new Error('codex must not run — no chooser was injected and the default runner is claude');
  });
  const claudeCalls: AgentRunSpec[] = [];
  const claudeRun = t.mock.method(ClaudeCliRunner.prototype, 'run', async (spec: AgentRunSpec) => {
    claudeCalls.push(spec);
    return { text: PLAN_RESULT_TEXT, toolCalls: [], tokensUsed: 0 };
  });

  const result = await planChain(repoRoot, 'do the thing');

  assert.equal(codexRun.mock.callCount(), 0);
  assert.equal(claudeRun.mock.callCount(), 1);
  assert.equal(claudeCalls[0]?.model, 'sonnet'); // the configured default's own plannerModel
  assert.equal(claudeCalls[0]?.env, undefined); // the default account contributes nothing
  assert.equal(result.fallback, false);
});

test('planChain: a chooser that resolves nothing degrades exactly like the no-chooser path', async (t) => {
  // The `/plan` route only ever injects a chooser once it has confirmed a runnable candidate
  // exists (Solution 4b), so this is a defensive case: proves `planChain` falls back to
  // `config.defaultRunner` + `resolveProfileEnvForRoot` safely rather than mis-wiring a spec that
  // would throw, if the chooser is ever called and comes back empty.
  const { repoRoot } = planTestFixture(t);

  const claudeCalls: AgentRunSpec[] = [];
  const claudeRun = t.mock.method(ClaudeCliRunner.prototype, 'run', async (spec: AgentRunSpec) => {
    claudeCalls.push(spec);
    return { text: PLAN_RESULT_TEXT, toolCalls: [], tokensUsed: 0 };
  });
  const chooseAccount = async (): Promise<PlannerAccountChoice | undefined> => undefined;

  const result = await planChain(repoRoot, 'do the thing', chooseAccount);

  assert.equal(claudeRun.mock.callCount(), 1);
  assert.equal(claudeCalls[0]?.model, 'sonnet');
  assert.equal(claudeCalls[0]?.env, undefined);
  assert.equal(result.fallback, false);
});
