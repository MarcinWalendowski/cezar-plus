import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { isMissingSessionRejection } from './agent-runner.ts';
import { buildClaudeArgs } from './claude-cli-runner.ts';
import {
  CodexAppServerRpc,
  endCodexAppServer,
  resolveCodexExecutable,
  spawnCodexAppServer,
  waitForCodexAppServerExit,
} from './codex-app-server-transport.ts';

const LIVE = process.env.CEZ_LIVE_CLI_CONTRACT === '1';
const TIMEOUT_MS = 15_000;
const scratchDirs: string[] = [];

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
  const dir = mkdtempSync(join(tmpdir(), 'cez-missing-session-contract-'));
  scratchDirs.push(dir);
  return dir;
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} exceeded ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

describe.skipIf(!LIVE)('installed CLI missing-session string contract', () => {
  it('keeps Claude headless resume rejection recognizable', async ({ skip }) => {
    const bin = process.env.CEZ_CLAUDE_BIN ?? 'claude';
    if (!executableOnPath(bin)) skip(`Claude CLI not found: ${bin}`);

    const sessionId = randomUUID();
    const cwd = scratchCwd();
    const child = spawn(
      bin,
      buildClaudeArgs({ userPrompt: '', cwd, sessionId, resume: true }),
      { cwd, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Claude missing-session probe exceeded ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/No conversation found with session ID/i);
    expect(isMissingSessionRejection('claude', output)).toBe(true);
  }, TIMEOUT_MS + 5_000);

  it('keeps Codex app-server resume rejection recognizable', async ({ skip }) => {
    const bin = resolveCodexExecutable();
    if (!executableOnPath(bin)) skip(`Codex CLI not found: ${bin}`);

    const child = spawnCodexAppServer(bin, scratchCwd());
    const rpc = new CodexAppServerRpc(child);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try {
        rpc.dispatchResponse(JSON.parse(line));
      } catch {
        // Non-JSON output cannot settle a JSON-RPC request.
      }
    });
    child.once('exit', () => rpc.rejectPending());
    child.once('error', (error) => rpc.rejectPending(error.message));

    let message = '';
    try {
      await withTimeout(rpc.initialize(), 'Codex initialization');
      await withTimeout(
        rpc.request('thread/resume', {
          threadId: randomUUID(),
          cwd: scratchCwd(),
          sandbox: 'danger-full-access',
          approvalPolicy: 'never',
        }),
        'Codex missing-session probe',
      );
      throw new Error('Codex unexpectedly resumed an impossible thread id');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      lines.close();
      endCodexAppServer(child);
      await waitForCodexAppServerExit(child);
    }

    expect(message).toMatch(/no rollout found for thread id/i);
    expect(isMissingSessionRejection('codex', message)).toBe(true);
  }, TIMEOUT_MS + 5_000);
});
