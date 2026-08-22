import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './agent-runner.ts';
import { isSignalTerminationExit, prependSystemPrompt } from './agent-runner.ts';
import {
  buildClaudeArgs,
  ClaudeCliRunner,
  EOF_KILL_GRACE_MS,
  EOF_TERM_GRACE_MS,
  KILL_GRACE_MS,
} from './claude-cli-runner.ts';
import type { UiEvent } from './ui-events.ts';

/** Only the escalation tests below swap the child out; every other test in this
 *  file keeps spawning its real stub binary through the untouched `spawn`. */
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
 * The per-backend system-prompt delivery mechanism (spec §protocol v2
 * mapping table): claude gets `--append-system-prompt`, codex/opencode get
 * the prompt prepended to the opening user message (`prependSystemPrompt`,
 * shared by both runners).
 */
describe('buildClaudeArgs systemPrompt', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('emits --append-system-prompt with the exact text', () => {
    const args = buildClaudeArgs({ ...spec, systemPrompt: 'Extra rules.\n\n---\n\nContract.' });
    const idx = args.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('Extra rules.\n\n---\n\nContract.');
  });

  it('omits the flag entirely when no systemPrompt is set', () => {
    expect(buildClaudeArgs(spec)).not.toContain('--append-system-prompt');
  });
});

/**
 * `.ai/specs/2026-08-21-run-tests-reasoning-ceiling.md`, Phase 1 — the per-step `effort` knob,
 * mirroring `--model`. No env-side mirror: the CLI does not read `CLAUDE_EFFORT` as input
 * (spec's Revision note), so the flag is the only signal this function ever emits.
 */
describe('buildClaudeArgs effort', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('emits --effort with the exact level, alongside --model', () => {
    const args = buildClaudeArgs({ ...spec, model: 'sonnet', effort: 'medium' });
    const idx = args.indexOf('--effort');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('medium');
  });

  it('omits the flag entirely when no effort is set', () => {
    expect(buildClaudeArgs(spec)).not.toContain('--effort');
  });
});

/**
 * `Task` survives the trip from a step definition into the real argv (spec
 * `.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md`, Phase 4 / R4).
 *
 * This test exists because the grant it checks is, today, **decorative** — `buildClaudeArgs`'s
 * own doc comment records that `--allowedTools` only GRANTS additively against claude 2.1.224,
 * so `Task` was already reachable in the run that motivated the spec (its `session.started`
 * event lists it) and the model simply never used it. So Phase 4 could "work" for entirely the
 * wrong reason, and a test asserting behaviour would be green either way.
 *
 * What is assertable, and what becomes load-bearing the day the filed `--disallowedTools`
 * follow-up lands, is the ARGV: a step whose prompt says "fan out" and whose `allowedTools`
 * omits `Task` would silently lose the ability then. This pins the plumbing, not the outcome.
 */
describe('buildClaudeArgs sub-agent grant', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('emits Task into --allowedTools alongside a bash allowlist, unexpanded', () => {
    const args = buildClaudeArgs({
      ...spec,
      allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Bash', 'Task'],
      bashAllowlist: ['git log', 'cez kb'],
    });
    const allowed = args[args.indexOf('--allowedTools') + 1]?.split(',') ?? [];
    // `Task` is not a Bash prefix, so it passes through whole while `Bash` expands per prefix.
    expect(allowed).toContain('Task');
    expect(allowed).toContain('Bash(git log:*)');
    expect(allowed).toContain('Bash(cez kb:*)');
    expect(allowed).not.toContain('Bash');
  });

  it('leaves Task out when the step never asked for it', () => {
    const args = buildClaudeArgs({ ...spec, allowedTools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'] });
    expect(args[args.indexOf('--allowedTools') + 1]?.split(',') ?? []).not.toContain('Task');
  });
});

/**
 * spec `.ai/specs/2026-08-15-bypass-permissions-claude-sessions.md`, Verification row 2. The
 * second case is the one that matters: a test that only asserts the default value would pass
 * just as happily against `env.CEZ_APPROVAL_GATE === '1' ? 'acceptEdits' : 'bypassPermissions'`
 * — the ternary the owner explicitly rejected — so it has to set the variable and still see
 * `bypassPermissions` come out.
 */
describe('buildClaudeArgs permission mode', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('always runs bypassPermissions, with no env read', () => {
    const args = buildClaudeArgs(spec, {});
    const idx = args.indexOf('--permission-mode');
    expect(args[idx + 1]).toBe('bypassPermissions');
  });

  it('stays bypassPermissions even with CEZ_APPROVAL_GATE=1 in the env — the gate is gone, not inverted', () => {
    const args = buildClaudeArgs(spec, { CEZ_APPROVAL_GATE: '1' });
    const idx = args.indexOf('--permission-mode');
    expect(args[idx + 1]).toBe('bypassPermissions');
  });
});

/**
 * #703 — a session cezar tore down itself must not settle as an agent
 * failure. Every agent CLI installs its own stop-signal handler and exits
 * `128 + signal`, so the runner sees a NON-ZERO code for a teardown it
 * asked for (goal achieved → `end()`, or a user cancel → `interrupt()`).
 */
describe('isSignalTerminationExit', () => {
  it('recognizes the 128+signal codes a signalled CLI reports', () => {
    expect(isSignalTerminationExit(130)).toBe(true); // SIGINT
    expect(isSignalTerminationExit(137)).toBe(true); // SIGKILL
    expect(isSignalTerminationExit(143)).toBe(true); // SIGTERM
  });

  it('leaves genuine failures and clean exits alone', () => {
    for (const code of [0, 1, 2, 127, null]) {
      expect(isSignalTerminationExit(code)).toBe(false);
    }
  });
});

describe('a teardown cezar initiated', () => {
  const stubBin = fileURLToPath(
    new URL('./__fixtures__/claude/stub-ignores-eof-exits-143.mjs', import.meta.url),
  );

  it('settles the session instead of failing it when the CLI exits 143', async () => {
    const runner = new ClaudeCliRunner({ bin: stubBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const uiEvents: UiEvent[] = [];
    let sawText: () => void = () => {};
    const firstText = new Promise<void>((resolve) => {
      sawText = resolve;
    });
    const session = runner.startSession(
      { userPrompt: 'do it', cwd: process.cwd() },
      (event) => {
        events.push(event);
        if (event.type === 'text') sawText();
      },
      { onUiEvent: (event) => uiEvents.push(event) },
    );
    await firstText;

    // The cancel path; the EOF watchdog reaches the same `signalChild`.
    session.interrupt();
    const result = await session.result;

    expect(result.text).toBe('work done');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(
      uiEvents.some((event) => event.type === 'turn.completed' && event.stopReason === 'error'),
    ).toBe(false);
    expect(uiEvents).toContainEqual({
      type: 'turn.completed',
      turnId: 'turn_1',
      stopReason: 'end_turn',
    });
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(
      events.some((e) => e.type === 'note' && e.message.includes('terminated by cezar (code 143)')),
    ).toBe(true);
  }, 15_000);
});

/**
 * #844 — the watchdogs used to ask `!child.killed` before escalating, but Node
 * sets `killed` the moment a signal is *delivered*. claude installs its own
 * SIGTERM handler, so the flag went true while the process ran on and the
 * SIGKILL that exists for exactly that case was never sent — one leaked CLI per
 * teardown. The escalation now follows real termination instead.
 */
describe('SIGTERM→SIGKILL escalation for a CLI that survives SIGTERM', () => {
  function signallableChild(): {
    child: ChildProcessWithoutNullStreams;
    signals: NodeJS.Signals[];
    exit: (code: number) => void;
  } {
    const signals: NodeJS.Signals[] = [];
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      pid: 4242,
      // Node's semantics: delivery flips `killed`; a CLI with its own handler
      // keeps running with `exitCode` still null.
      kill: (signal: NodeJS.Signals) => {
        signals.push(signal);
        Object.assign(child, { killed: true });
        return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    const exit = (code: number) => {
      Object.assign(child, { exitCode: code });
      emitter.emit('exit', code, null);
    };
    return { child, signals, exit };
  }

  function withFakeChild(run: (fake: ReturnType<typeof signallableChild>) => void): void {
    const fake = signallableChild();
    spawnHook.override = () => fake.child;
    vi.useFakeTimers();
    try {
      run(fake);
    } finally {
      vi.useRealTimers();
      spawnHook.override = null;
    }
  }

  it('escalates after end() even though Node already flagged the child as killed', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      session.end();

      vi.advanceTimersByTime(EOF_TERM_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
      // Delivered, not dead — the state that used to disable the escalation.
      expect(fake.child.killed).toBe(true);
      expect(fake.child.exitCode).toBeNull();

      vi.advanceTimersByTime(EOF_KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('escalates on the inactivity timeout path as well', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 20 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);

      vi.advanceTimersByTime(20);
      expect(fake.signals).toEqual(['SIGTERM']);

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  /**
   * Spec 2026-08-20-agent-step-inactivity-timeout. The deadline used to be a wall clock armed
   * once at spawn, so ANY step that ran longer than the limit was killed and recorded as
   * `failed` however hard it was working — run `9d09795a` lost both `implement` and `run-tests`
   * that way, at exactly 30 minutes each. It now bounds SILENCE: every line the agent emits
   * re-arms it.
   *
   * This is the regression test. Against the old fixed deadline it goes red at the second
   * iteration, when the wall clock fires despite a steady stream of output.
   */
  it('never fires while the agent keeps producing output, however long the step runs', async () => {
    const fake = signallableChild();
    spawnHook.override = () => fake.child;
    vi.useFakeTimers();
    try {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 100 }).startSession({
        userPrompt: 'a long but very much alive step',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);

      // Six half-limit ticks: 3x the limit in total elapsed time, never one full limit of silence.
      for (let i = 0; i < 6; i++) {
        (fake.child.stdout as unknown as PassThrough).write('{}\n');
        await vi.advanceTimersByTimeAsync(50);
      }

      expect(fake.signals).toEqual([]);
      expect(fake.child.killed).toBe(false);
    } finally {
      vi.useRealTimers();
      spawnHook.override = null;
    }
  });

  it('still fires once the agent goes quiet for a full limit, even after a busy spell', async () => {
    const fake = signallableChild();
    spawnHook.override = () => fake.child;
    vi.useFakeTimers();
    try {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 100 }).startSession({
        userPrompt: 'a step that wedges after doing some work',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);

      for (let i = 0; i < 3; i++) {
        (fake.child.stdout as unknown as PassThrough).write('{}\n');
        await vi.advanceTimersByTimeAsync(50);
      }
      expect(fake.signals).toEqual([]); // alive so far

      // Then silence — the bound a non-interactive step has no other source of. Being busy
      // earlier buys no immunity; it only moves the deadline.
      await vi.advanceTimersByTimeAsync(100);
      expect(fake.signals).toEqual(['SIGTERM']);
      // SIGTERM→SIGKILL escalation itself is pinned by the `timeoutMs: 20` case above. It is not
      // re-asserted here: consuming stdout means the destroyed stream ends the read loop, whose
      // `finally` clears the kill timer before fake time can reach it.
      expect(fake.child.killed).toBe(true);
    } finally {
      vi.useRealTimers();
      spawnHook.override = null;
    }
  });

  it('timeoutMs: 0 disables the bound entirely, silence or not (interactive sessions)', async () => {
    const fake = signallableChild();
    spawnHook.override = () => fake.child;
    vi.useFakeTimers();
    try {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 0 }).startSession({
        userPrompt: 'interactive',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(fake.signals).toEqual([]);
    } finally {
      vi.useRealTimers();
      spawnHook.override = null;
    }
  });

  it('stops escalating once the CLI really exits after SIGTERM', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      session.end();

      vi.advanceTimersByTime(EOF_TERM_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
      fake.exit(143);

      vi.advanceTimersByTime(EOF_KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
    });
  });
});

describe('prependSystemPrompt (codex/opencode delivery)', () => {
  it('prepends the prompt as a leading block of the first user message', () => {
    expect(prependSystemPrompt('Extra rules.', 'do it')).toBe('Extra rules.\n\n---\n\ndo it');
  });

  it('leaves the user prompt untouched when no systemPrompt is set', () => {
    expect(prependSystemPrompt(undefined, 'do it')).toBe('do it');
  });
});

describe('ClaudeCliRunner token usage', () => {
  it('counts the aggregate result usage without re-adding assistant-frame snapshots', async () => {
    const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
    const runner = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 60_000 });
    const events: AgentEvent[] = [];
    const cwd = mkdtempSync(join(tmpdir(), 'cez-claude-token-usage-'));

    try {
      const result = await runner.run(
        {
          userPrompt: 'fix the login redirect',
          cwd,
          env: {
            CEZ_HANDOFF_FILE: '',
            CEZ_MOCK_ARGS_FILE: '',
            CEZ_TODOS_FILE: '',
          },
          sessionId: '5f701b42-382a-4a6e-b831-0ab9e56eff58',
        },
        (event) => events.push(event),
      );

      // The mock emits four assistant usage snapshots before its aggregate
      // result usage (1,270 input + 185 output). Only the result is authoritative.
      expect(result.tokensUsed).toBe(1_455);
      expect(events.filter((event) => event.type === 'token-usage')).toEqual([
        { type: 'token-usage', tokensUsed: 1_455 },
      ]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});

describe('CEZ_APPROVAL_GATE removal (spec Verification row 3, whole packages/cezar/src tree)', () => {
  // The name is deleted, not defaulted (D2) — a stale switch that reads as live is the failure
  // mode this spec exists to close. `SELF` excludes this file: a rule that names what it forbids
  // cannot pass its own scan.
  const APPROVAL_GATE_RE = /CEZ_APPROVAL_GATE/;
  const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
  const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;
  const SELF = join(import.meta.dirname, 'claude-cli-runner.test.ts');

  function listFiles(dir: string): string[] {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && TEXT_EXT.test(entry.name))
      .map((entry) => join(entry.parentPath, entry.name));
  }

  it('no file under packages/cezar/src mentions CEZ_APPROVAL_GATE', () => {
    const files = listFiles(join(repoRoot, 'packages', 'cezar', 'src')).filter((file) => file !== SELF);
    // A walk that found nothing would pass this vacuously — the scan has to be shown to have run.
    expect(files.length).toBeGreaterThan(300);
    const offenders = files.filter((file) => APPROVAL_GATE_RE.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => file.slice(repoRoot.length + 1))).toEqual([]);
  });

  it('negative control: the scan actually catches the name when present', () => {
    expect(APPROVAL_GATE_RE.test('env.CEZ_APPROVAL_GATE === "1" ? "acceptEdits" : "dontAsk"')).toBe(true);
    expect(APPROVAL_GATE_RE.test('--permission-mode bypassPermissions')).toBe(false);
  });
});

/**
 * The grace window between SIGTERM and SIGKILL has to be REAL.
 *
 * The inactivity handler used to call `child.stdout.destroy()` the instant the bound fired, and
 * the read loop bailed on `if (timedOut) break`. Between them, the 10s grace window bought
 * nothing: everything the CLI emitted while winding down — its final message, a handoff write, a
 * `CEZ:SPEC_PATH` declaration — was thrown away, and the step's last words were lost precisely
 * when they mattered most, on the run that got stopped mid-work.
 */
describe('a stopped session keeps draining until the stream really ends', () => {
  function drainableChild(): {
    child: ChildProcessWithoutNullStreams;
    signals: NodeJS.Signals[];
    frame: (text: string) => void;
    endStdout: () => void;
    exit: (code: number) => void;
  } {
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
      pid: 5150,
      kill: (signal: NodeJS.Signals) => {
        signals.push(signal);
        Object.assign(child, { killed: true });
        return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    const frame = (text: string) =>
      stdout.write(
        `${JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
        })}\n`,
      );
    const exit = (code: number) => {
      Object.assign(child, { exitCode: code });
      emitter.emit('exit', code, null);
    };
    return { child, signals, frame, endStdout: () => stdout.end(), exit };
  }

  async function withChild(run: (fake: ReturnType<typeof drainableChild>) => Promise<void>): Promise<void> {
    const fake = drainableChild();
    spawnHook.override = () => fake.child;
    vi.useFakeTimers();
    try {
      await run(fake);
    } finally {
      vi.useRealTimers();
      spawnHook.override = null;
    }
  }

  it('frames emitted after the SIGTERM still reach the result', async () => {
    // Guard: restore `child.stdout.destroy()` in the deadline handler, or the `if (timedOut)
    // break` in the read loop, and this goes red — the parting message never lands.
    await withChild(async (fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 60_000 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });

      await vi.advanceTimersByTimeAsync(60_001);
      expect(fake.signals).toEqual(['SIGTERM']);

      fake.frame('here is my handoff before I go');
      await vi.advanceTimersByTimeAsync(0);
      fake.endStdout();
      fake.exit(143);

      const result = await session.result;
      expect(result.text).toContain('here is my handoff before I go');
    });
  });

  it('the stop is reported as a cezar stop, not an agent failure', async () => {
    await withChild(async (fake) => {
      const events: AgentEvent[] = [];
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 60_000 }).startSession(
        { userPrompt: 'do it', cwd: process.cwd() },
        (event) => events.push(event),
      );

      await vi.advanceTimersByTimeAsync(60_001);
      fake.endStdout();
      fake.exit(143);
      await session.result;

      const error = events.find((e) => e.type === 'error');
      // `reason` is what the run manager keys `review`-not-`failed` off.
      expect(error).toMatchObject({ reason: 'inactivity' });
      expect((error as { message: string }).message).toContain('no output for 1m');
    });
  });

  it('a session that keeps talking is never stopped — the bound measures silence', async () => {
    await withChild(async (fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 60_000 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });

      // 90 minutes of steady work in 50s gaps: far past any wall clock, never 60s of silence.
      for (let i = 0; i < 108; i++) {
        await vi.advanceTimersByTimeAsync(50_000);
        fake.frame(`working ${i}`);
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(fake.signals).toEqual([]);

      fake.endStdout();
      fake.exit(0);
      const result = await session.result;
      expect(result.text).toContain('working 107');
    });
  });
});
