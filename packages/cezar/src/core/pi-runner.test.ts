import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from './agent-runner.js';
import { buildChildEnv } from './agent-env.js';
import { detectEnvironment } from './backend-detect.js';
import { createRunner } from './runner-factory.js';
import { buildPiArgs, PiRunner } from './pi-runner.js';

/** Only the signal-classification tests below swap the child out; every other test in this file
 *  keeps spawning the real mock CLI (or the real "absent binary" probe) through untouched `spawn`. */
const spawnHook = vi.hoisted(() => ({ override: null as null | (() => unknown) }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      spawnHook.override ? spawnHook.override() : actual.spawn(...args),
  };
});

/**
 * The `pi` runner (#387): a new AgentBackend slotted into the runner seam as
 * ONE class. These lock the three seam-level guarantees the issue asks for —
 * the factory hands back a pi runner, detection degrades gracefully when the
 * pi CLI is absent, and the documented RPC protocol emits the normalized
 * streams every backend shares.
 */

describe('createRunner returns the pi runner', () => {
  it('maps the "pi" id to a PiRunner with backend "pi"', () => {
    const runner = createRunner('pi');
    expect(runner).toBeInstanceOf(PiRunner);
    expect(runner.backend).toBe('pi');
  });
});

describe('backend-detect handles an absent pi CLI', () => {
  const saved = { bin: process.env.CEZ_PI_BIN, dry: process.env.CEZ_DRY_RUN };

  beforeEach(() => {
    delete process.env.CEZ_DRY_RUN; // real probe, not the mock short-circuit
    process.env.CEZ_PI_BIN = join(tmpdir(), 'cez-pi-does-not-exist-xyz');
  });
  afterEach(() => {
    if (saved.bin === undefined) delete process.env.CEZ_PI_BIN;
    else process.env.CEZ_PI_BIN = saved.bin;
    if (saved.dry === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = saved.dry;
  });

  it('reports pi as unavailable with a hint, and never rejects (no boot failure)', async () => {
    const checks = await detectEnvironment();
    const pi = checks.find((c) => c.name === 'pi');
    expect(pi).toBeDefined();
    expect(pi!.available).toBe(false);
    expect(pi!.hint).toContain('pi');
  });
});

describe('a dry-run pi session emits normalized AgentEvents', () => {
  const saved = process.env.CEZ_DRY_RUN;
  let cwd: string;

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1'; // swap in the shared mock CLI
    cwd = mkdtempSync(join(tmpdir(), 'cez-pi-run-'));
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = saved;
    rmSync(cwd, { recursive: true, force: true });
  });

  it('streams text, a tool call/result and a terminal done over the mock', async () => {
    const runner = new PiRunner();
    expect(runner.backend).toBe('pi');

    const events: AgentEvent[] = [];
    const result = await runner.run(
      { userPrompt: 'investigate the login redirect bug', cwd, timeoutMs: 20_000 },
      (event) => events.push(event),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain('text');
    expect(types).toContain('tool-call');
    expect(types).toContain('tool-result');
    // Every backend's stream is terminated by exactly one `done`.
    expect(types.filter((t) => t === 'done')).toHaveLength(1);
    expect(result.text.length).toBeGreaterThan(0);
  });
});

describe('pi RPC argv', () => {
  it('uses pi RPC mode, exact session selection, provider/model, and pi tool names', () => {
    expect(
      buildPiArgs({
        cwd: '/repo',
        userPrompt: 'task',
        sessionId: 'session-1',
        resume: true,
        model: 'openai/gpt-5.1',
        systemPrompt: 'Keep changes focused.',
        allowedTools: ['Read', 'Bash', 'Edit', 'Write', 'Grep', 'Glob'],
      }),
    ).toEqual([
      '--mode',
      'rpc',
      '--session',
      'session-1',
      '--append-system-prompt',
      'Keep changes focused.',
      '--model',
      'openai/gpt-5.1',
      '--tools',
      'read,bash,edit,write,grep,find',
    ]);
  });

  it('creates a new exact session id instead of invoking the interactive resume picker', () => {
    expect(buildPiArgs({ cwd: '/repo', userPrompt: 'task', sessionId: 'session-1' })).toEqual([
      '--mode',
      'rpc',
      '--session-id',
      'session-1',
    ]);
  });

  it('fails closed by disabling bash when a command-prefix allowlist cannot be represented', () => {
    expect(
      buildPiArgs({
        cwd: '/repo',
        userPrompt: 'task',
        allowedTools: ['Read', 'Bash'],
        bashAllowlist: ['npm test'],
      }),
    ).toEqual(['--mode', 'rpc', '--tools', 'read']);
  });
});

describe('pi spawns under pi credentials, not another runner', () => {
  const source: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'ant',
    OPENAI_API_KEY: 'oai',
    OPENROUTER_API_KEY: 'orr',
    SOME_UNRELATED_SECRET: 'nope',
  };

  it('gives pi the multi-provider set a provider/model id can name', () => {
    const env = buildChildEnv({ backend: 'pi', source });
    expect(env.ANTHROPIC_API_KEY).toBe('ant');
    expect(env.OPENAI_API_KEY).toBe('oai');
    expect(env.OPENROUTER_API_KEY).toBe('orr');
  });

  it('still withholds everything outside the allowlist — pi is not a full-env escape hatch', () => {
    expect(buildChildEnv({ backend: 'pi', source }).SOME_UNRELATED_SECRET).toBeUndefined();
  });

  it('leaves claude Anthropic-only — widening pi must not widen claude', () => {
    const env = buildChildEnv({ backend: 'claude', source });
    expect(env.ANTHROPIC_API_KEY).toBe('ant');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it('never inherits Claude Code’s cloud credentials — pi does not read its toggles', () => {
    // `CLAUDE_CODE_USE_BEDROCK` / `_USE_VERTEX` unlock the AWS/GCP credential families for the
    // backend that is given the `CLAUDE_` prefix to read them. pi is not Claude Code and reads
    // neither toggle, so a host that configured Claude Code for Bedrock must not thereby hand a
    // pi process its cloud keys. OpenCode — the same `provider/model` shape — is the control.
    const cloudSource: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CONFIG_DIR: '/home/u/.claude',
      AWS_ACCESS_KEY_ID: 'akid',
      AWS_SECRET_ACCESS_KEY: 'asak',
      GOOGLE_APPLICATION_CREDENTIALS: '/home/u/gcp.json',
      GOOGLE_CLOUD_PROJECT: 'proj',
    };
    for (const backend of ['pi', 'opencode'] as const) {
      const env = buildChildEnv({ backend, source: cloudSource });
      expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
      expect(env.GOOGLE_CLOUD_PROJECT).toBeUndefined();
      expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    }
    // …and claude still gets exactly what the toggles exist to deliver.
    expect(buildChildEnv({ backend: 'claude', source: cloudSource }).AWS_ACCESS_KEY_ID).toBe('akid');
  });

  it('keeps the seam identity pi-specific', () => {
    expect(new PiRunner().backend).toBe('pi');
  });
});

/**
 * A run whose agent was killed by an untrapped signal used to report `done`, and the workflow
 * continued as though the step had succeeded — the same defect fixed for the claude backend in
 * `claude-cli-runner.ts` (#703's follow-up). `waitForExit` here discarded the signal before any
 * branch could see it, so `code === null` alone read as a clean exit no matter who sent the
 * signal or why — the kernel OOM killer, a cgroup bound, or an operator's `kill -9`.
 */
describe('an external signal kills the agent process directly (OOM killer / operator kill -9)', () => {
  it('a real subprocess killed by an untrapped SIGKILL fails the run and names the signal', async () => {
    const bin = fileURLToPath(new URL('../../scripts/mock-pi-rpc.mjs', import.meta.url));
    const events: AgentEvent[] = [];
    const session = new PiRunner({ bin, timeoutMs: 0 }).startSession(
      { userPrompt: 'do it', cwd: process.cwd(), env: { MOCK_PI_SUICIDE_SIGKILL: '1' } },
      (event) => events.push(event),
    );

    await expect(session.result).rejects.toThrow(/SIGKILL/);
    expect(events.some((e) => e.type === 'error' && e.message.includes('SIGKILL'))).toBe(true);
    // The damaging property of the bug: a `done` landing right after the signal, which is what let
    // the run manager treat the step as finished.
    expect(events.some((e) => e.type === 'done')).toBe(false);
  }, 15_000);

  /** A fake child whose only source of truth is what the test tells it — used for the exit-code
   *  floor and to pin the exact rejection message, which a real subprocess's stderr noise would
   *  make brittle to assert on directly. */
  function killableChild(): {
    child: ChildProcessWithoutNullStreams;
    exit: (code: number | null, signal: NodeJS.Signals | null) => void;
  } {
    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const child = Object.assign(emitter, {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      pid: 9101,
      kill: () => true, // cezar never signals in this block — the death is entirely external
    }) as unknown as ChildProcessWithoutNullStreams;
    const exit = (code: number | null, signal: NodeJS.Signals | null) => {
      Object.assign(child, { exitCode: code, signalCode: signal });
      stdout.end();
      emitter.emit('exit', code, signal);
    };
    return { child, exit };
  }

  it('the fake child agrees with the real subprocess above, and names the signal in the message', async () => {
    const fake = killableChild();
    spawnHook.override = () => fake.child;
    try {
      const session = new PiRunner({ bin: 'pi', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      fake.exit(null, 'SIGKILL');
      await expect(session.result).rejects.toThrow('pi CLI was killed by signal SIGKILL');
    } finally {
      spawnHook.override = null;
    }
  });

  it.each([0, 1, 2])('floor: ordinary exit code %i with no signal is untouched by this fix', async (code) => {
    const fake = killableChild();
    spawnHook.override = () => fake.child;
    try {
      const session = new PiRunner({ bin: 'pi', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      fake.exit(code, null);
      if (code === 0) {
        await expect(session.result).resolves.toMatchObject({ text: '' });
      } else {
        await expect(session.result).rejects.toThrow(`pi CLI exited with code ${code}`);
      }
    } finally {
      spawnHook.override = null;
    }
  });

  it("negative control: cezar's own interrupt() is NOT an external-kill failure", async () => {
    // pi installs no signal handler of its own (unlike claude, which traps SIGTERM and exits
    // 143) — so cezar's own `interrupt()` sending SIGTERM produces the identical `code: null,
    // signal: 'SIGTERM'` shape an external kill would. `terminatedByCezar` is the only thing
    // that tells them apart, and this must resolve exactly as it always did: cleanly, no error,
    // no signal named.
    const signals: NodeJS.Signals[] = [];
    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const child = Object.assign(emitter, {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      pid: 9102,
      kill: (signal: NodeJS.Signals) => {
        signals.push(signal);
        Object.assign(child, { killed: true, exitCode: null, signalCode: signal });
        stdout.end();
        emitter.emit('exit', null, signal);
        return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;

    spawnHook.override = () => child;
    try {
      const session = new PiRunner({ bin: 'pi', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      session.interrupt();

      expect(signals).toEqual(['SIGTERM']);
      await expect(session.result).resolves.toMatchObject({ text: '' });
    } finally {
      spawnHook.override = null;
    }
  });
});
