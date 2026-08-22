import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentEvent, AgentRunSpec } from './agent-runner.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { startRunBroker } from './run-broker.ts';
import { spoolDirFor } from './run-spool.ts';
import type { UiEvent } from './ui-events.ts';

/**
 * **The parity requirement, made executable** — P4 of
 * `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`, and the rule `AGENT_PROTOCOL.md`
 * already imposes on every backend: the v1 `AgentEvent` stream and the v2 `UiEvent` stream must
 * not depend on how the bytes reached us.
 *
 * This is the test that makes brokering safe to turn on. A run's transcript is produced by a
 * parser, and the tempting way to add a second transport is to write a second parser for it — at
 * which point the two drift, and the drift shows up not as a failing test but as a run whose
 * transcript is subtly wrong. So the runner has exactly one consumer (`createClaudeConsumer`) and
 * both transports feed it, and this compares their OUTPUT over the golden fixtures to prove it.
 *
 * Both sides run the same stub binary over the same fixture. The only difference is the pipe: one
 * is `readNdjson(child.stdout)` in this process, the other is a real broker teeing to a file that
 * a `BrokeredSession` tails.
 */
describe('a brokered claude session emits the same events as an in-process one', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const STUB = join(HERE, '__fixtures__', 'claude', 'stub-replays-ndjson.mjs');
  const FIXTURES = ['text-turn', 'bash-and-screenshot', 'task-tools-plan', 'subagent-task'];
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cez-parity-'));
    dirs.push(dir);
    return dir;
  }

  const fixturePath = (fixture: string): string => join(HERE, '__fixtures__', 'claude', `${fixture}.ndjson`);

  /**
   * `env` carries the fixture rather than `process.env`, and that is not incidental: `buildChildEnv`
   * is an ALLOWLIST (#427), so a variable set on this process is dropped on the way to the backend.
   * Passing it as spec env is the same channel a real run uses for `CEZ_HANDOFF_FILE`.
   */
  const spec = (cwd: string, fixture: string): AgentRunSpec => ({
    userPrompt: 'go',
    cwd,
    sessionId: '3f9c0a52-6de1-4c8e-9a41-1b2d3c4e5f60',
    timeoutMs: 0,
    env: { STUB_FIXTURE: fixturePath(fixture) },
  });

  interface Captured {
    v1: AgentEvent[];
    v2: UiEvent[];
    text: string;
    tokensUsed: number;
  }

  async function inProcess(fixture: string): Promise<Captured> {
    const cwd = scratch();
    const v1: AgentEvent[] = [];
    const v2: UiEvent[] = [];
    const runner = new ClaudeCliRunner({ bin: STUB, timeoutMs: 0 });
    const session = runner.startSession(spec(cwd, fixture), (e) => v1.push(e), {
      autoEndAfterFirstTurn: true,
      onUiEvent: (e) => v2.push(e),
    });
    const result = await session.result;
    return { v1, v2, text: result.text, tokensUsed: result.tokensUsed };
  }

  async function brokered(fixture: string): Promise<Captured> {
    const cwd = scratch();
    const spoolDir = spoolDirFor(cwd, 'parity-run', 'i1');
    const v1: AgentEvent[] = [];
    const v2: UiEvent[] = [];
    const broker = startRunBroker({
      spoolDir,
      runId: 'parity-run',
      instanceId: 'i1',
      stepId: 'implement',
      backend: 'claude',
      command: [process.execPath, STUB],
      cwd,
      env: { ...process.env, STUB_FIXTURE: fixturePath(fixture) },
    });
    const runner = new ClaudeCliRunner({ bin: STUB, timeoutMs: 0 });
    // `reattachSession` rather than `startSession`: the broker is already running (started above,
    // as `spawnBroker` would in production), and this is the exact code path a restart takes.
    const session = runner.reattachSession(spec(cwd, fixture), (e) => v1.push(e), {
      autoEndAfterFirstTurn: true,
      onUiEvent: (e) => v2.push(e),
      broker: { spoolDir, runId: 'parity-run', instanceId: 'i1', stepId: 'implement', startOffset: 0 },
    });
    // The opening message the seeded path would have sent. It goes out before the broker has
    // bound its control socket, which is precisely the queueing case that must not lose it.
    session.sendMessage([{ type: 'text', text: 'go' }]);
    try {
      const result = await session.result;
      return { v1, v2, text: result.text, tokensUsed: result.tokensUsed };
    } finally {
      // Always: `afterEach` deletes the scratch dir, and a broker still flushing into it would
      // crash the worker with an ENOENT that hides whatever actually failed.
      await broker.finished.catch(() => undefined);
    }
  }

  for (const fixture of FIXTURES) {
    it(`v1 and v2 streams match for the "${fixture}" fixture`, async () => {
      const [piped, spooled] = await Promise.all([inProcess(fixture), brokered(fixture)]);

      // v1 is what the transcript is built from. Compared whole and in order — a reordering here
      // would be invisible in a set comparison and very visible to a user.
      expect(spooled.v1).toEqual(piped.v1);
      // v2 is what the cockpit renders.
      expect(spooled.v2).toEqual(piped.v2);
      expect(spooled.text).toBe(piped.text);
      expect(spooled.tokensUsed).toBe(piped.tokensUsed);
      // Not a tautology: an empty stream would satisfy every assertion above.
      expect(piped.v1.length).toBeGreaterThan(1);
    }, 30_000);
  }
});
