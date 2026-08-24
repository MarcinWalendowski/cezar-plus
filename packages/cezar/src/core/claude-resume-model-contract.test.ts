import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeArgs, encodeClaudeUserMessage } from './claude-cli-runner.ts';

/**
 * `.ai/specs/2026-08-23-codex-resume-explicit-model.md`, Phase 3 — "measure it, then decide".
 *
 * Unlike codex, claude has no known transport-level "resume poisoning" mechanism: `--resume`
 * replays a local on-disk transcript rather than a hosted session with backend-owned settings.
 * But nothing found rules out the CLI restoring the LAST record's model when `--model` is
 * omitted on resume — which is exactly the shape that bit codex. This test settles it by
 * measurement rather than guessing: create a session pinned to one model, resume it with no
 * `--model`, and read which model actually answered off the resumed turn's own `message.model`
 * field (the same field `~/.claude/projects/**\/*.jsonl` carries on every assistant record).
 *
 * Same `describe.skipIf(!LIVE)` gate as `missing-session-string-contract.test.ts`, for the same
 * reason: this drives the real, installed, authenticated CLI and is not something a normal
 * `npm test` run should spend real turns on.
 *
 * This test does NOT assert a specific outcome — that would be exactly the guess this spec
 * refuses to make. It asserts the MECHANISM (a resumed turn answers with a real model id), and
 * prints both models so a human reads the actual result and, per the spec:
 *   - if the resumed model equals the CONFIGURED DEFAULT (not necessarily the pinned one) →
 *     record a docblock here with the measurement, the date, and `claude --version`, no code
 *     change;
 *   - if it equals the PINNED model from the earlier session → claude inherits the transcript's
 *     model exactly like codex inherits `thread_settings.model`, and needs the same explicit-
 *     model treatment Phase 1 gives codex.
 */
const LIVE = process.env.CEZ_LIVE_CLI_CONTRACT === '1';
const TIMEOUT_MS = 30_000;
const scratchDirs: string[] = [];
// Cheapest model with a distinct, unambiguous id — minimizes the cost of a test nobody should be
// running by accident (it is skipped unless CEZ_LIVE_CLI_CONTRACT=1).
const PINNED_MODEL = 'claude-haiku-4-5';

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function executableOnPath(command: string): boolean {
  const candidates = isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? '').split(delimiter).map((dir) => join(dir, command));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function scratchCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cez-claude-resume-model-'));
  scratchDirs.push(dir);
  return dir;
}

/** Runs one headless claude turn and returns the FIRST `message.model` seen on an assistant
 *  stream-json record — the same field a persisted transcript under `~/.claude/projects/`
 *  carries on every assistant record. */
async function runTurnAndReadModel(bin: string, args: string[], cwd: string, prompt: string): Promise<string> {
  const child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { buffer += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  child.stdin.write(`${encodeClaudeUserMessage([{ type: 'text', text: prompt }])}\n`);

  const model = await new Promise<string | undefined>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`claude resume-model probe exceeded ${TIMEOUT_MS}ms; stderr: ${stderr}`));
    }, TIMEOUT_MS);
    const onData = () => {
      for (const line of buffer.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { type?: string; message?: { model?: string } };
          if (msg.type === 'assistant' && typeof msg.message?.model === 'string') {
            cleanup();
            resolve(msg.message.model);
            return;
          }
        } catch {
          // Not a complete JSON line yet — keep buffering.
        }
      }
    };
    const onExit = () => {
      cleanup();
      resolve(undefined);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.once('exit', onExit);
  });
  child.stdin.end();
  if (!child.killed) child.kill('SIGTERM');

  if (!model) throw new Error(`claude never emitted an assistant record; stderr: ${stderr}`);
  return model;
}

describe.skipIf(!LIVE)('installed CLI resume-model contract (claude)', () => {
  it('records which model answers a resume that sends no --model', async ({ skip }) => {
    const bin = process.env.CEZ_CLAUDE_BIN ?? 'claude';
    if (!executableOnPath(bin)) skip(`Claude CLI not found: ${bin}`);

    const cwd = scratchCwd();
    const sessionId = randomUUID();

    const pinnedModel = await runTurnAndReadModel(
      bin,
      buildClaudeArgs({ userPrompt: '', cwd, sessionId, model: PINNED_MODEL }),
      cwd,
      'reply with the single word ok',
    );
    expect(pinnedModel).toBeTruthy();

    const resumedModel = await runTurnAndReadModel(
      bin,
      buildClaudeArgs({ userPrompt: '', cwd, sessionId, resume: true }),
      cwd,
      'reply with the single word ok',
    );

    // The mechanism, not the guess: SOME real model answered. What it equals is the finding — a
    // failed `toBeTruthy` never fires on a real run, so the diagnostic message is what a human
    // reads to learn the answer and update this docblock per the spec, above.
    expect(
      resumedModel,
      `pinned=${pinnedModel} resumed(no --model)=${resumedModel} inherited=${resumedModel === pinnedModel}`,
    ).toBeTruthy();
  }, TIMEOUT_MS * 2 + 10_000);
});
