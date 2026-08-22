import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { brokerRequest, brokerResponds } from './broker-client.ts';
import { startRunBroker } from './run-broker.ts';
import { isSpoolLive, readSpoolExit, readSpoolMeta, readSpoolFrom, spoolPaths } from './run-spool.ts';

/**
 * P4 of `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`, end to end: a real child
 * process, a real spool on disk, a real unix control socket.
 *
 * The case this file exists for is "simulated server restart": the reader goes away mid-stream,
 * the agent keeps producing, and a fresh reader resuming at the recorded offset sees every record
 * exactly once. That is the acceptance criterion in miniature.
 */

const dirs: string[] = [];
const TEST_TIMEOUT_MS = 20_000;

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cez-broker-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/**
 * A stand-in backend: echoes one NDJSON record per stdin line, so the test can drive it through
 * the control socket exactly as the server drives `claude`. Node rather than a shell script so it
 * behaves identically wherever the suite runs.
 */
function echoBackend(): string[] {
  const script = [
    'process.stdout.write(JSON.stringify({type:"ready"})+"\\n");',
    'let buf="";',
    'process.stdin.on("data",(c)=>{',
    '  buf+=c;',
    '  let i=buf.indexOf("\\n");',
    '  while(i>=0){',
    '    const line=buf.slice(0,i); buf=buf.slice(i+1); i=buf.indexOf("\\n");',
    '    if(!line.trim()) continue;',
    '    process.stdout.write(JSON.stringify({type:"echo",got:JSON.parse(line)})+"\\n");',
    '  }',
    '});',
    'process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({type:"result"})+"\\n");process.exit(0);});',
  ].join('');
  return [process.execPath, '-e', script];
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for condition');
}

describe('run broker', () => {
  it(
    'spools the backend output and answers status on the control socket',
    async () => {
      const spool = join(scratch(), 'run.spool');
      const broker = startRunBroker({ spoolDir: spool, runId: 'r1', instanceId: 'i1', backend: 'claude', command: echoBackend() });

      const meta = readSpoolMeta(spool);
      expect(meta?.runId).toBe('r1');
      expect(meta?.pid).toBe(process.pid);
      expect(meta?.childPid).toBe(broker.childPid);
      expect(isSpoolLive(spool)).toBe(true);

      await waitFor(() => readSpoolFrom(spoolPaths(spool).out, 0).lines.length >= 1);
      expect(await brokerResponds(spool)).toBe(true);

      const status = await brokerRequest(spool, { op: 'status' });
      expect(status).toMatchObject({ ok: true, open: true, pid: broker.childPid });

      await brokerRequest(spool, { op: 'end' });
      await broker.finished;
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'writes a message to the live backend through the control socket',
    async () => {
      const spool = join(scratch(), 'run.spool');
      const broker = startRunBroker({ spoolDir: spool, runId: 'r2', instanceId: 'i2', backend: 'claude', command: echoBackend() });
      const out = spoolPaths(spool).out;

      await waitFor(() => readSpoolFrom(out, 0).lines.length >= 1);
      const sent = await brokerRequest(spool, { op: 'send', content: [{ type: 'text', text: 'hello' }] });
      expect(sent.ok).toBe(true);

      await waitFor(() => readSpoolFrom(out, 0).lines.some((l) => l.includes('"echo"')));
      const echoed = readSpoolFrom(out, 0).lines.map((l) => JSON.parse(l));
      expect(echoed.find((e) => e.type === 'echo')?.got?.message?.content?.[0]?.text).toBe('hello');

      await brokerRequest(spool, { op: 'end' });
      await broker.finished;
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'SURVIVES its reader going away, and a new reader resumes with no gap and no duplicate',
    async () => {
      // This is the acceptance criterion in miniature: the "server" reads part of the stream,
      // disappears (as it would during `systemctl restart`), and a fresh one picks up from the
      // persisted byte offset while the agent has kept working throughout.
      const spool = join(scratch(), 'run.spool');
      const broker = startRunBroker({ spoolDir: spool, runId: 'r3', instanceId: 'i3', backend: 'claude', command: echoBackend() });
      const out = spoolPaths(spool).out;

      await waitFor(() => readSpoolFrom(out, 0).lines.length >= 1);
      await brokerRequest(spool, { op: 'send', content: [{ type: 'text', text: 'first' }] });
      await waitFor(() => readSpoolFrom(out, 0).lines.length >= 2);

      // --- "server" reads what exists and then dies, persisting only its offset ---
      const beforeRestart = readSpoolFrom(out, 0);
      const persistedOffset = beforeRestart.nextOffset;
      expect(beforeRestart.lines.length).toBeGreaterThanOrEqual(2);

      // --- the agent keeps working while nothing is reading it ---
      await brokerRequest(spool, { op: 'send', content: [{ type: 'text', text: 'during-restart' }] });
      await brokerRequest(spool, { op: 'send', content: [{ type: 'text', text: 'after-restart' }] });
      await waitFor(() => readSpoolFrom(out, persistedOffset).lines.length >= 2);

      // --- a NEW server resumes at the recorded offset ---
      const afterRestart = readSpoolFrom(out, persistedOffset);
      const texts = afterRestart.lines
        .map((l) => JSON.parse(l))
        .filter((e) => e.type === 'echo')
        .map((e) => e.got.message.content[0].text);
      expect(texts).toContain('during-restart');
      expect(texts).toContain('after-restart');
      // nothing the old reader already consumed is replayed
      expect(texts).not.toContain('first');

      const whole = readSpoolFrom(out, 0).lines;
      const combined = [...beforeRestart.lines, ...afterRestart.lines];
      expect(combined).toEqual(whole);

      await brokerRequest(spool, { op: 'end' });
      await broker.finished;
      expect(isSpoolLive(spool)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'records the exit and tears the control socket down',
    async () => {
      const spool = join(scratch(), 'run.spool');
      const broker = startRunBroker({ spoolDir: spool, runId: 'r4', instanceId: 'i4', backend: 'claude', command: echoBackend() });
      await waitFor(() => readSpoolFrom(spoolPaths(spool).out, 0).lines.length >= 1);
      await brokerRequest(spool, { op: 'end' });
      const exit = await broker.finished;
      expect(exit.code).toBe(0);

      const recorded = readSpoolExit(spool);
      expect(recorded).toMatchObject({ code: 0, signal: null });
      expect(isSpoolLive(spool)).toBe(false);
      expect(await brokerResponds(spool, 500)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'flushes the whole transcript before recording the exit',
    async () => {
      // A server that sees exit.json stops reading. If the tees were still flushing, it would
      // lose the tail -- so exit.json must be written strictly after the streams close.
      const spool = join(scratch(), 'run.spool');
      const broker = startRunBroker({ spoolDir: spool, runId: 'r5', instanceId: 'i5', backend: 'claude', command: echoBackend() });
      await waitFor(() => readSpoolFrom(spoolPaths(spool).out, 0).lines.length >= 1);
      for (const text of ['a', 'b', 'c']) {
        await brokerRequest(spool, { op: 'send', content: [{ type: 'text', text }] });
      }
      await brokerRequest(spool, { op: 'end' });
      await broker.finished;

      const lines = readSpoolFrom(spoolPaths(spool).out, 0).lines.map((l) => JSON.parse(l));
      expect(lines.filter((e) => e.type === 'echo')).toHaveLength(3);
      // the backend's final record must be present, not truncated by the exit race
      expect(lines.at(-1)?.type).toBe('result');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'interrupt stops the backend and the exit reflects a signal death',
    async () => {
      const spool = join(scratch(), 'run.spool');
      // a backend that ignores stdin EOF and would otherwise run forever
      const forever = [process.execPath, '-e', 'process.stdout.write("{}\\n");setInterval(()=>{},1000);'];
      const broker = startRunBroker({ spoolDir: spool, runId: 'r6', instanceId: 'i6', backend: 'claude', command: forever });
      await waitFor(() => readSpoolFrom(spoolPaths(spool).out, 0).lines.length >= 1);

      await brokerRequest(spool, { op: 'interrupt' });
      const exit = await broker.finished;
      expect(exit.signal ?? exit.code).toBeTruthy();
      expect(readSpoolExit(spool)).not.toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a malformed control request without dying',
    async () => {
      const spool = join(scratch(), 'run.spool');
      const broker = startRunBroker({ spoolDir: spool, runId: 'r7', instanceId: 'i7', backend: 'claude', command: echoBackend() });
      await waitFor(() => readSpoolFrom(spoolPaths(spool).out, 0).lines.length >= 1);

      await expect(brokerRequest(spool, { op: 'nonsense' })).resolves.toMatchObject({ ok: false });
      // still alive and serving after a bad request
      expect(await brokerResponds(spool)).toBe(true);

      await brokerRequest(spool, { op: 'end' });
      await broker.finished;
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'captures stderr separately from the NDJSON stream',
    async () => {
      const spool = join(scratch(), 'run.spool');
      const noisy = [
        process.execPath,
        '-e',
        'process.stderr.write("a warning\\n");process.stdout.write("{\\"type\\":\\"ready\\"}\\n");process.exit(0);',
      ];
      const broker = startRunBroker({ spoolDir: spool, runId: 'r8', instanceId: 'i8', backend: 'claude', command: noisy });
      await broker.finished;

      expect(readFileSync(spoolPaths(spool).err, 'utf8')).toContain('a warning');
      // the warning must NOT have polluted the record stream
      expect(readSpoolFrom(spoolPaths(spool).out, 0).lines).toEqual(['{"type":"ready"}']);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('broker client', () => {
  it('reports unavailable rather than hanging when there is no broker', async () => {
    const spool = join(scratch(), 'absent.spool');
    await expect(brokerRequest(spool, { op: 'status' }, 500)).rejects.toThrow(/unreachable/);
    expect(await brokerResponds(spool, 500)).toBe(false);
  });
});
