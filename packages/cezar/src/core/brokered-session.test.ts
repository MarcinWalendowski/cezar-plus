import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { brokerRequest } from './broker-client.ts';
import {
  BrokeredSession,
  BrokerUnavailableError,
  PENDING_MAX_ATTEMPTS,
  isRetryableBrokerLaunch,
} from './brokered-session.ts';
import { brokerNeverStarted } from './claude-cli-runner.ts';
import { startRunBroker } from './run-broker.ts';
import { ensureSpoolDir, spoolPaths, writeSpoolExit, writeSpoolMeta } from './run-spool.ts';
import { spoolDirFor } from './run-spool.ts';

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
  it('ignores a foreign exit and threads only the accepted exit into the result', async () => {
    const spool = join(scratch(), 'owned.spool');
    ensureSpoolDir(spool);
    let accepted: unknown;
    const session = new BrokeredSession({
      spoolDir: spool,
      owner: { instanceId: 'B' },
      onLine: () => {},
      onExit: (exit) => { accepted = exit; },
      buildResult: (exit) => ({ text: String(exit?.code), toolCalls: [], tokensUsed: 0 }),
      pollMs: 5,
    });
    writeSpoolExit(spool, { code: 143, signal: null, instanceId: 'A', brokerPid: 10 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(session.open).toBe(true);
    expect(accepted).toBeUndefined();

    writeSpoolExit(spool, { code: 0, signal: null, instanceId: 'B', brokerPid: 11 });
    await expect(session.result).resolves.toMatchObject({ text: '0' });
    expect(accepted).toMatchObject({ instanceId: 'B', code: 0 });
  });

  it('rejects when a known broker dies without recording an exit', async () => {
    const spool = join(scratch(), 'vanished.spool');
    ensureSpoolDir(spool);
    writeSpoolMeta(spool, {
      schema: 1,
      protocol: 2,
      runId: 'vanished',
      backend: 'claude',
      pid: 2 ** 30,
      argv: [],
      instanceId: 'gone',
    });
    const session = new BrokeredSession({
      spoolDir: spool,
      owner: { instanceId: 'gone' },
      onLine: () => {},
      pollMs: 5,
    });
    await expect(session.result).rejects.toThrow(/died without recording an exit.*instance gone/);
  });

  it('keeps a live sibling running when an older broker exits 143', async () => {
    const runsDir = scratch();
    const spoolA = spoolDirFor(runsDir, 'same-run', 'A');
    const spoolB = spoolDirFor(runsDir, 'same-run', 'B');
    const sigterm143 = [process.execPath, '-e', 'process.on("SIGTERM",()=>process.exit(143));setInterval(()=>{},1000)'];
    const brokerA = startRunBroker({
      spoolDir: spoolA,
      runId: 'same-run',
      instanceId: 'A',
      backend: 'claude',
      command: sigterm143,
      orphanTimeoutMs: 50,
    });
    const brokerB = startRunBroker({
      spoolDir: spoolB,
      runId: 'same-run',
      instanceId: 'B',
      backend: 'claude',
      command: echoBackend(),
    });
    const session = new BrokeredSession({
      spoolDir: spoolB,
      owner: { instanceId: 'B' },
      onLine: () => {},
      buildResult: (exit) => {
        if (exit?.code && exit.code !== 0) throw new Error(`claude CLI exited with code ${exit.code}`);
        return { text: '', toolCalls: [], tokensUsed: 0 };
      },
      pollMs: 10,
    });

    await expect(brokerA.finished).resolves.toMatchObject({ code: 143 });
    expect(session.open).toBe(true);
    session.end();
    await expect(session.result).resolves.toMatchObject({ tokensUsed: 0 });
    await brokerB.finished;
  }, TEST_TIMEOUT_MS);

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

  // 2026-08-22-run-broker-cli-keepalive: the poll timer must hold a one-shot `cezar run` process
  // open while a session is genuinely in flight, and the exhausted-retry give-up path must
  // actually settle `result` instead of leaving it — and the process — hanging forever.
  it('the poll timer is ref\'d while the session is open and cleared once it ends', async () => {
    const spool = join(scratch(), 'run.spool');
    const broker = startRunBroker({ spoolDir: spool, runId: 'b6', backend: 'claude', command: echoBackend() });
    const clearSpy = vi.spyOn(global, 'clearInterval');
    const session = new BrokeredSession({ spoolDir: spool, onLine: () => {}, pollMs: 10 });
    const timer = (session as unknown as { timer?: NodeJS.Timeout }).timer;
    // `setInterval` handles are ref'd by default; P1's fix is simply the absence of the
    // `.unref()` call that used to follow construction — this is the process-keep-alive half of
    // the mechanism (the actual process-exit proof lives at the e2e level; see the spec's
    // Verification §1 note on why a same-process unit test cannot observe an event-loop drain).
    expect(timer?.hasRef()).toBe(true);
    expect(clearSpy).not.toHaveBeenCalled();

    session.detach();
    expect(clearSpy).toHaveBeenCalledWith(timer);
    clearSpy.mockRestore();
    await brokerRequest(spool, { op: 'end' });
    await broker.finished;
  }, TEST_TIMEOUT_MS);

  it(`gives up and rejects result within ${PENDING_MAX_ATTEMPTS} attempts when no broker ever answers`, async () => {
    const spool = join(scratch(), 'no-broker.spool');
    // Short `pollMs` (5ms) scales the ~`PENDING_MAX_ATTEMPTS`-attempt give-up budget down in real
    // time too, since it's attempt-counted rather than wall-clock — keeps this test fast without
    // changing the production 5s/100-attempt tuning (`SPOOL_POLL_MS`/`PENDING_MAX_ATTEMPTS`).
    const session = new BrokeredSession({ spoolDir: spool, onLine: () => {}, pollMs: 5 });
    const start = Date.now();
    expect(session.sendMessage([{ type: 'text', text: 'hello' }])).toBe(true);

    const rejected = await session.result.catch((err: unknown) => err);
    expect(rejected).toBeInstanceOf(BrokerUnavailableError);
    expect(rejected).toMatchObject({ everAnswered: false, spoolDir: spool });
    expect(isRetryableBrokerLaunch(rejected)).toBe(true);
    expect(session.open).toBe(false);
    expect(Date.now() - start).toBeLessThan(5_000);
  }, TEST_TIMEOUT_MS);

  it('never classifies a re-attached channel as a cold launch', async () => {
    const spool = join(scratch(), 'reattached-no-broker.spool');
    const session = new BrokeredSession({
      spoolDir: spool,
      onLine: () => {},
      pollMs: 5,
      previouslyAnswered: true,
    });
    session.sendMessage([{ type: 'text', text: 'follow-up' }]);

    const rejected = await session.result.catch((err: unknown) => err);
    expect(rejected).toBeInstanceOf(BrokerUnavailableError);
    expect(rejected).toMatchObject({ everAnswered: true, spoolDir: spool });
    expect(isRetryableBrokerLaunch(rejected)).toBe(false);
  }, TEST_TIMEOUT_MS);

  it('a spawn failure takes precedence over the generic give-up message', async () => {
    const spool = join(scratch(), 'no-broker-spawn-failed.spool');
    const spawnErr = new Error('boom: broker exec failed');
    const session = new BrokeredSession({
      spoolDir: spool,
      onLine: () => {},
      pollMs: 5,
      spawnFailed: () => spawnErr,
    });
    expect(session.sendMessage([{ type: 'text', text: 'hello' }])).toBe(true);

    await expect(session.result).rejects.toBe(spawnErr);
  }, TEST_TIMEOUT_MS);

  it(
    'protects billed work: a session that answered once and then went silent is not retryable',
    async () => {
      const spool = join(scratch(), 'answered-then-died.spool');
      const broker = startRunBroker({ spoolDir: spool, runId: 'answered-then-died', backend: 'claude', command: echoBackend() });
      const seen: string[] = [];
      const session = new BrokeredSession({ spoolDir: spool, onLine: (l) => seen.push(l), pollMs: 5 });

      // One real round-trip over the bound control socket — this is what sets `everAnswered` at
      // the runtime assignment (`brokered-session.ts:308`), not the constructor seed the
      // "re-attached channel" test above exercises.
      session.sendMessage([{ type: 'text', text: 'one' }]);
      await waitFor(() => seen.some((l) => l.includes('"echo"')));

      // "close the socket": remove the control socket the broker is bound to, so every request
      // from here on fails to connect. The broker process itself (this test process — brokers
      // run in-process, only the backend is a real child) stays alive, so this exercises the
      // give-up path rather than `failBrokerVanished`.
      rmSync(spoolPaths(spool).ctl, { force: true });

      const start = Date.now();
      expect(session.sendMessage([{ type: 'text', text: 'after-death' }])).toBe(true);
      const rejected = await session.result.catch((err: unknown) => err);
      expect(rejected).toBeInstanceOf(BrokerUnavailableError);
      expect(rejected).toMatchObject({ everAnswered: true, spoolDir: spool });
      expect(isRetryableBrokerLaunch(rejected)).toBe(false);
      expect(Date.now() - start).toBeLessThan(5_000);

      await broker.close();
    },
    TEST_TIMEOUT_MS,
  );

  it('the give-up seam rejects with launchFailure\'s own object when the broker was never started', async () => {
    const spoolDir = join(scratch(), 'never-started.spool');
    const launchLog = join(scratch(), 'never-started.broker.log');
    writeFileSync(
      launchLog,
      'Failed to start transient scope unit: Unit cezar-run-x.scope was already loaded.\n',
    );
    let launchErr: Error | null = null;
    const session = new BrokeredSession({
      spoolDir,
      onLine: () => {},
      pollMs: 5,
      launchFailure: () => {
        launchErr = brokerNeverStarted(spoolDir, launchLog);
        return launchErr;
      },
    });
    expect(session.sendMessage([{ type: 'text', text: 'hello' }])).toBe(true);

    const rejected = await session.result.catch((err: unknown) => err);
    expect(rejected).toBe(launchErr);
    expect(rejected).not.toBeInstanceOf(BrokerUnavailableError);
    expect(isRetryableBrokerLaunch(rejected)).toBe(false);
    expect((rejected as Error).message).toMatch(
      /was never started — no meta\.json was written; launcher said: .*already loaded/,
    );
  }, TEST_TIMEOUT_MS);
});
