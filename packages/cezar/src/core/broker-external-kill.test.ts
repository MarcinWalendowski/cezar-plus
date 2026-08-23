import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClaudeCliRunner } from './claude-cli-runner.ts';
import type { AgentEvent, AgentRunSpec, AgentSession } from './agent-runner.ts';
import { spoolPaths, writeSpoolExit, type SpoolExit } from './run-spool.ts';

/**
 * The BROKERED half of the "a killed agent reports done" defect — the pipe-path twin lives in
 * `claude-cli-runner.test.ts`'s "an external signal kills the agent process directly" describe.
 *
 * The broker writes `exit.json` straight from `child.on('exit', (code, signal))`, so an untrapped
 * signal death (the kernel OOM killer, a cgroup `MemoryMax` breach, an operator's `kill -9`) lands
 * on disk as `{code: null, signal: 'SIGKILL'}` — no exit code at all, because nothing trapped the
 * signal to produce one. `brokeredExitFailure` and `emitBrokeredTerminalEvents` both used to read
 * `code === null` alone as "ended acceptably", which is exactly the shape this kill produces
 * whether or not `resources` was ever configured for the launch — so a stray SIGKILL with NO bound
 * configured (today's default everywhere) resolved the run successfully.
 */

const spawnHook = vi.hoisted(() => ({ calls: [] as { bin: string; args: string[] }[] }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (bin: string, args: string[]) => {
      spawnHook.calls.push({ bin, args });
      const proc = new EventEmitter() as EventEmitter & { unref(): void; pid: number };
      proc.unref = () => undefined;
      proc.pid = 4242;
      return proc;
    },
  };
});

vi.mock('./broker-launch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./broker-launch.ts')>();
  return { ...actual, resolveBrokerCommand: () => ['/usr/bin/node', '/opt/cezar/dist/index.js', 'run-broker'] };
});

describe('a brokered run whose backend died by an untrapped external signal', () => {
  const dirs: string[] = [];
  let nextRunId = 0;

  afterEach(() => {
    spawnHook.calls.length = 0;
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  /**
   * Starts a brokered session with no isolation/resources configured (today's default on every
   * install that has not opted into D14a's cgroup bounds), THEN drops the spool's `out.ndjson` and
   * `exit.json` — exactly what the broker's own process would write, without a real broker.
   *
   * Order matters: `spawnBroker` (inside `startSession`) `rmSync`s the spool directory before it
   * ever returns, so writing the spool BEFORE the call — the tempting, more linear order — has the
   * runner delete it out from under the test the instant it starts. `BrokeredSession` polls on a
   * real 50ms interval, so this only has to win the race once.
   */
  function brokeredSession(
    exit: SpoolExit | 'omit',
    onEvent?: (event: AgentEvent) => void,
  ): { session: AgentSession; spoolDir: string; instanceId: string } {
    const cwd = mkdtempSync(join(tmpdir(), 'cez-broker-extkill-'));
    dirs.push(cwd);
    const runId = `r${(nextRunId += 1)}`;
    // `instanceId` is load-bearing in this harness, not decoration. Since the dead-twin fix a
    // fresh broker launch must be given one (`spawnBroker` throws without it), the spool lives at
    // `<runId>.spool/<instanceId>` rather than at `<runId>.spool`, and — the part that silently
    // hangs a test rather than failing it — `BrokeredSession` only ACCEPTS an `exit.json` whose
    // `instanceId` matches the launch's. So every exit this file writes has to be stamped with it,
    // which is exactly what the real broker does. Mirrors `RunManager.brokerFor`.
    const instanceId = `i-${runId}`;
    const spoolDir = join(cwd, `${runId}.spool`, instanceId);

    const spec: AgentRunSpec = { userPrompt: 'run the gates', cwd, timeoutMs: 0 };
    const runner = new ClaudeCliRunner({ bin: '/bin/true', timeoutMs: 0 });
    const session = runner.startSession(spec, onEvent, {
      broker: { spoolDir, runId, instanceId, stepId: 'run-tests', isolation: 'none' },
    });

    mkdirSync(spoolDir, { recursive: true });
    writeFileSync(spoolPaths(spoolDir).out, '');
    if (exit !== 'omit') writeSpoolExit(spoolDir, { ...exit, instanceId });
    return { session, spoolDir, instanceId };
  }

  it('an external SIGKILL with no cgroup bound configured fails the run and names the signal', async () => {
    const events: AgentEvent[] = [];
    const { session } = brokeredSession(
      { code: null, signal: 'SIGKILL', exitedAt: new Date().toISOString() },
      (event) => events.push(event),
    );

    await expect(session.result).rejects.toThrow(/SIGKILL/);
    expect(events.some((e) => e.type === 'error' && e.message.includes('SIGKILL'))).toBe(true);
    // The damaging property: a `done` right after, which is what read as the step succeeding.
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it.each([0, 1, 2])('floor: ordinary exit code %i with no signal is untouched by this fix', async (code) => {
    const { session } = brokeredSession({ code, signal: null, exitedAt: new Date().toISOString() });
    if (code === 0) {
      await expect(session.result).resolves.toMatchObject({ text: '' });
    } else {
      await expect(session.result).rejects.toThrow(`claude CLI exited with code ${code}`);
    }
  });

  it("negative control: cezar's own teardown (interrupt) is NOT an external-kill failure", async () => {
    // `session.interrupt()` marks `terminatedByCezar` on the BrokeredSession the same way a real
    // cancel or the inactivity watchdog would — then the exit lands exactly as an untrapped
    // SIGKILL always does: `code: null, signal: 'SIGKILL'`. Bit for bit the same record as the
    // positive case above; only `terminatedByCezar` tells them apart, and this must resolve
    // exactly as it always did before this fix: cleanly, no error, no signal named.
    const { session, spoolDir, instanceId } = brokeredSession('omit');
    session.interrupt();
    // `brokeredSession` already wrote `out.ndjson` and skipped `exit.json` (`'omit'`) — write it
    // now, after `interrupt()`, so the flag is set before the tail ever observes the exit.
    writeSpoolExit(spoolDir, { code: null, signal: 'SIGKILL', exitedAt: new Date().toISOString(), instanceId });

    await expect(session.result).resolves.toMatchObject({ text: '' });
  });

  it('a healthy brokered run still reaches a clean result (floor)', async () => {
    const { session, spoolDir, instanceId } = brokeredSession('omit');
    writeFileSync(
      spoolPaths(spoolDir).out,
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'all good',
        usage: { input_tokens: 10, output_tokens: 5 },
        total_cost_usd: 0.001,
      })}\n`,
    );
    writeSpoolExit(spoolDir, { code: 0, signal: null, exitedAt: new Date().toISOString(), instanceId });

    const result = await session.result;
    expect(result.text).toBe('all good');
  });
});
