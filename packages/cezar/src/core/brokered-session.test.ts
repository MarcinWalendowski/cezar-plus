import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { brokerRequest } from './broker-client.ts';
import { BrokeredSession } from './brokered-session.ts';
import { startRunBroker } from './run-broker.ts';

/**
 * P4 of `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`.
 *
 * Driven against a REAL broker rather than a fake spool: the thing under test is whether the
 * session and the broker agree about offsets and exit ordering, and a fake would let them agree
 * with each other while both being wrong.
 */

const dirs: string[] = [];
const TEST_TIMEOUT_MS = 20_000;

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cez-bsession-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

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

describe('BrokeredSession', () => {
  it(
    'satisfies the AgentSession shape and streams lines in order',
    async () => {
      const spool = join(scratch(), 'run.spool');
      const broker = startRunBroker({ spoolDir: spool, runId: 'b1', backend: 'claude', command: echoBackend() });
      const seen: string[] = [];
      const session = new BrokeredSession({ spoolDir: spool, onLine: (l) => seen.push(l), pollMs: 10 });

      // the interface every layer above the runner already talks to
      expect(typeof session.sendMessage).toBe('function');
      expect(typeof session.end).toBe('function');
      expect(typeof session.interrupt).toBe('function');
      expect(session.open).toBe(true);

      await waitFor(() => seen.length >= 1);
      expect(JSON.parse(seen[0] as string).type).toBe('ready');
      expect(session.pid).toBe(broker.childPid);

      session.sendMessage([{ type: 'text', text: 'one' }]);
      await waitFor(() => seen.some((l) => l.includes('"echo"')));

      session.end();
      await session.result;
      expect(session.open).toBe(false);
      expect(JSON.parse(seen.at(-1) as string).type).toBe('result');
      await broker.finished;
    },
    TEST_TIMEOUT_MS,
  );

  it(
    're-attaching at the persisted offset replays exactly the unconsumed remainder',
    async () => {
      // The acceptance criterion: a server dies mid-run, the agent keeps working, and the
      // replacement sees every record once.
      const spool = join(scratch(), 'run.spool');
      const broker = startRunBroker({ spoolDir: spool, runId: 'b2', backend: 'claude', command: echoBackend() });

      const first: string[] = [];
      let persisted = 0;
      const before = new BrokeredSession({
        spoolDir: spool,
        onLine: (l) => first.push(l),
        onOffset: (o) => {
          persisted = o;
        },
        pollMs: 10,
      });
      await waitFor(() => first.length >= 1);
      before.sendMessage([{ type: 'text', text: 'before' }]);
      await waitFor(() => first.some((l) => l.includes('before')));

      // --- the server is replaced: stop reading, keep the agent alive ---
      before.detach();
      expect(persisted).toBeGreaterThan(0);
      const consumedByFirst = [...first];

      // --- the agent keeps working with nobody reading ---
      await brokerRequest(spool, { op: 'send', content: [{ type: 'text', text: 'during' }] });
      await brokerRequest(spool, { op: 'send', content: [{ type: 'text', text: 'after' }] });

      // --- the replacement resumes at the persisted offset ---
      const second: string[] = [];
      const resumed = new BrokeredSession({
        spoolDir: spool,
        startOffset: persisted,
        onLine: (l) => second.push(l),
        pollMs: 10,
      });
      await waitFor(() => second.filter((l) => l.includes('"echo"')).length >= 2);

      const texts = second.map((l) => JSON.parse(l)).filter((e) => e.type === 'echo').map((e) => e.got.message.content[0].text);
      expect(texts).toEqual(expect.arrayContaining(['during', 'after']));
      expect(texts).not.toContain('before'); // no duplicate
      // and concatenating the two readers reproduces the whole transcript -- no gap
      expect([...consumedByFirst, ...second].length).toBe(new Set([...consumedByFirst, ...second]).size);

      resumed.end();
      await resumed.result;
      await broker.finished;
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'detach() leaves the backend running; end() stops it',
    async () => {
      const spool = join(scratch(), 'run.spool');
      const broker = startRunBroker({ spoolDir: spool, runId: 'b3', backend: 'claude', command: echoBackend() });
      const seen: string[] = [];
      const session = new BrokeredSession({ spoolDir: spool, onLine: (l) => seen.push(l), pollMs: 10 });
      await waitFor(() => seen.length >= 1);

      session.detach();
      await session.result; // resolves without the backend exiting
      const stillThere = await brokerRequest(spool, { op: 'status' });
      expect(stillThere).toMatchObject({ ok: true, open: true });

      await brokerRequest(spool, { op: 'end' });
      await broker.finished;
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports the exit once the broker records it, after a final drain',
    async () => {
      const spool = join(scratch(), 'run.spool');
      const broker = startRunBroker({ spoolDir: spool, runId: 'b4', backend: 'claude', command: echoBackend() });
      const seen: string[] = [];
      let exitSeen: unknown = undefined;
      const session = new BrokeredSession({
        spoolDir: spool,
        onLine: (l) => seen.push(l),
        onExit: (e) => {
          exitSeen = e;
        },
        pollMs: 10,
      });
      await waitFor(() => seen.length >= 1);
      session.sendMessage([{ type: 'text', text: 'x' }]);
      session.end();
      await session.result;

      expect(exitSeen).toMatchObject({ code: 0 });
      // the final `result` record must have been drained BEFORE exit was reported
      expect(JSON.parse(seen.at(-1) as string).type).toBe('result');
      expect(seen.some((l) => l.includes('"echo"'))).toBe(true);
      await broker.finished;
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a throwing consumer does not wedge the tail',
    async () => {
      const spool = join(scratch(), 'run.spool');
      const broker = startRunBroker({ spoolDir: spool, runId: 'b5', backend: 'claude', command: echoBackend() });
      let calls = 0;
      const session = new BrokeredSession({
        spoolDir: spool,
        onLine: () => {
          calls += 1;
          throw new Error('consumer defect');
        },
        pollMs: 10,
      });
      await waitFor(() => calls >= 1);
      session.sendMessage([{ type: 'text', text: 'y' }]);
      await waitFor(() => calls >= 2); // still tailing after the throw
      session.end();
      await session.result;
      await broker.finished;
    },
    TEST_TIMEOUT_MS,
  );

  it('sendMessage on a closed session returns false rather than pretending', async () => {
    const spool = join(scratch(), 'absent.spool');
    const session = new BrokeredSession({ spoolDir: spool, onLine: () => {}, pollMs: 10 });
    session.detach();
    expect(session.open).toBe(false);
    expect(session.sendMessage([{ type: 'text', text: 'z' }])).toBe(false);
  });
});
