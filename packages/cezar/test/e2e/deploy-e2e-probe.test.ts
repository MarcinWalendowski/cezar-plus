import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const probePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/deploy-e2e-probe.mjs');

/**
 * `deploy-e2e-probe.mjs` measures a real cutover on `prod-host` — the box terminates OIDC
 * auth, so `/api/v1/runs/:id` and `/api/v1/runs/:id/events` 401 without a session cookie. Before
 * `.ai/specs/2026-08-22-deploy-e2e-probe-measured-assertions.md`, an unauthenticated run measured
 * NOTHING on those two streams (`sse.seqs`/`runStatuses` stayed empty) and the probe's own
 * `every(Boolean)` verdict read that emptiness as `passed` — a vacuous pass indistinguishable from
 * a real one. This suite runs the probe against a local mock server (no live box needed) and checks
 * the tri-state `{ verdict, sample, reason? }` assertion shape can no longer do that, on both the
 * JSON artifact and the stdout summary.
 */

const RUN_ID = 'test-run';
const VALID_COOKIE = 'cez_session=test-session-id';

function hasValidCookie(req: IncomingMessage): boolean {
  return req.headers.cookie === VALID_COOKIE;
}

function writeSseFrame(res: ServerResponse, seq: number, message = ''): void {
  res.write(`data: ${JSON.stringify({ seq, message })}\n\n`);
}

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

type ProbeResult = { stdout: string; stderr: string; code: number; out: Record<string, any> };

async function runProbe(args: string[]): Promise<ProbeResult> {
  const dir = await mkdtemp(join(tmpdir(), 'deploy-e2e-probe-test-'));
  const outFile = join(dir, 'report.json');
  try {
    let stdout = '';
    let stderr = '';
    let code = 0;
    try {
      const result = await execFile(process.execPath, [probePath, ...args, '--out', outFile], {
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err) {
      const execErr = err as { stdout?: string; stderr?: string; code?: number };
      stdout = execErr.stdout ?? '';
      stderr = execErr.stderr ?? '';
      code = typeof execErr.code === 'number' ? execErr.code : 1;
    }
    const out = JSON.parse(await readFile(outFile, 'utf8'));
    return { stdout, stderr, code, out };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function assertionLine(stdout: string, name: string): string {
  const line = stdout.split('\n').find((l) => l.includes(name) && /^(PASS|FAIL|UNMEASURED)/.test(l));
  assert.ok(line, `expected a PASS/FAIL/UNMEASURED stdout line for "${name}", got:\n${stdout}`);
  return line as string;
}

function verdictLine(stdout: string): string | undefined {
  return stdout.split('\n').find((l) => l.startsWith('verdict='));
}

const VACUOUS_NAMES = ['c: no seq gaps', 'c: no seq duplicates', 'a: run never left running', 'a: no interrupted event'];

test('no credential: previously-vacuous assertions report not-measured/UNMEASURED, never a vacuous pass', { timeout: 20_000 }, async () => {
  await withServer(
    (req, res) => {
      const url = new URL(req.url ?? '/', 'http://placeholder');
      if (url.pathname === '/api/v1/ready') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthenticated' }));
    },
    async (base) => {
      const { code, out, stdout, stderr } = await runProbe(['--base', base, '--run', RUN_ID, '--seconds', '1.2']);

      assert.equal(code, 2, 'no assertion failed, but four could not be measured — exit code must be 2');
      assert.equal(out.verdict, 'not-measured');
      assert.equal(out.passed, false);
      assert.equal(out.sse.authFailed, true);

      for (const name of VACUOUS_NAMES) {
        assert.equal(out.assertions[name].verdict, 'not-measured', name);
        assert.equal(out.assertions[name].sample, 0, name);
        assert.equal(out.assertions[name].reason, 'auth-failed', name);
        assert.ok(assertionLine(stdout, name).startsWith('UNMEASURED'), `stdout must print UNMEASURED for ${name}, not PASS`);
      }

      // The (b) poll assertions are unaffected — /ready is exempt from auth and answered real 200s.
      assert.equal(out.assertions['b: zero failed HTTP requests'].verdict, 'passed');
      assert.equal(out.assertions['b: zero refused connections'].verdict, 'passed');

      const authLinesForEvents = stderr.split('\n').filter((l) => l.includes('AUTH REQUIRED') && l.includes('/events'));
      assert.equal(
        authLinesForEvents.length,
        1,
        `expected exactly one AUTH REQUIRED line for the SSE stream (not one per retry), got:\n${stderr}`,
      );

      assert.equal(verdictLine(stdout), 'verdict=not-measured exit=2');
      assert.equal(out.poll.maxLatencyMs, out.poll.gapMs);
    },
  );
});

test('no --run: run/SSE assertions report not-measured with reason no-run-id, and no request reaches /runs', { timeout: 20_000 }, async () => {
  let runsRequests = 0;
  await withServer(
    (req, res) => {
      const url = new URL(req.url ?? '/', 'http://placeholder');
      if (url.pathname === '/api/v1/ready') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      if (url.pathname.startsWith('/api/v1/runs')) runsRequests += 1;
      res.writeHead(404);
      res.end();
    },
    async (base) => {
      const { code, out, stderr } = await runProbe(['--base', base, '--seconds', '1']);

      assert.equal(code, 2);
      assert.equal(out.verdict, 'not-measured');
      assert.equal(out.runId, null);

      for (const name of VACUOUS_NAMES) {
        assert.equal(out.assertions[name].verdict, 'not-measured', name);
        assert.equal(out.assertions[name].sample, 0, name);
        assert.equal(out.assertions[name].reason, 'no-run-id', name);
      }

      assert.equal(runsRequests, 0, 'subscribe()/sampleRun() must return immediately when RUN_ID is null');
      assert.ok(!stderr.includes('AUTH REQUIRED'), 'no request was attempted, so no AUTH REQUIRED line should print');
    },
  );
});

test('valid cookie, project scope, and a real reconnect: SSE continuity passes on real data', { timeout: 20_000 }, async () => {
  let eventsAttempt = 0;
  await withServer(
    (req, res) => {
      const url = new URL(req.url ?? '/', 'http://placeholder');
      if (url.pathname === '/api/v1/ready') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      if (!hasValidCookie(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthenticated' }));
        return;
      }
      if (url.pathname === `/api/v1/p/cezar/runs/${RUN_ID}`) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'running' }));
        return;
      }
      if (url.pathname === `/api/v1/p/cezar/runs/${RUN_ID}/events`) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const attempt = eventsAttempt++;
        if (attempt === 0) {
          writeSseFrame(res, 1);
          writeSseFrame(res, 2);
          writeSseFrame(res, 3);
          setTimeout(() => res.end(), 100);
          return;
        }
        let seq = 4;
        const timer = setInterval(() => writeSseFrame(res, seq++), 50);
        req.on('close', () => clearInterval(timer));
        return;
      }
      res.writeHead(404);
      res.end();
    },
    async (base) => {
      const { code, out, stdout } = await runProbe([
        '--base', base,
        '--project', 'cezar',
        '--header', `cookie: ${VALID_COOKIE}`,
        '--run', RUN_ID,
        '--seconds', '1.2',
      ]);

      assert.equal(code, 0, JSON.stringify(out, null, 2));
      assert.equal(out.verdict, 'passed');
      assert.ok(out.sse.reconnects >= 1, `expected at least one reconnect, got ${out.sse.reconnects}`);

      for (const [name, result] of Object.entries(out.assertions) as [string, any][]) {
        assert.ok(result.sample > 0, `${name} should have a non-zero sample, got ${result.sample}`);
        assert.equal(result.verdict, 'passed', name);
        assert.ok(assertionLine(stdout, name).startsWith('PASS'), `stdout must print PASS for ${name}`);
      }

      assert.equal(verdictLine(stdout), 'verdict=passed exit=0');
      assert.equal(out.poll.maxLatencyMs, out.poll.gapMs);
    },
  );
});

test('valid cookie, zero reconnects in the window: seq continuity reports not-measured even though events were seen', { timeout: 20_000 }, async () => {
  await withServer(
    (req, res) => {
      const url = new URL(req.url ?? '/', 'http://placeholder');
      if (url.pathname === '/api/v1/ready') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      if (!hasValidCookie(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthenticated' }));
        return;
      }
      if (url.pathname === `/api/v1/runs/${RUN_ID}`) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'running' }));
        return;
      }
      if (url.pathname === `/api/v1/runs/${RUN_ID}/events`) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        let seq = 1;
        const timer = setInterval(() => writeSseFrame(res, seq++), 50);
        req.on('close', () => clearInterval(timer));
        return;
      }
      res.writeHead(404);
      res.end();
    },
    async (base) => {
      const { code, out } = await runProbe(['--base', base, '--header', `cookie: ${VALID_COOKIE}`, '--run', RUN_ID, '--seconds', '1']);

      assert.equal(code, 2);
      assert.equal(out.sse.reconnects, 0);
      assert.ok(out.sse.events > 0, 'the mock server did send events; the gate must not depend on zero events');
      assert.equal(out.assertions['c: no seq gaps'].verdict, 'not-measured');
      assert.equal(out.assertions['c: no seq gaps'].sample, 0);
      assert.equal(out.assertions['c: no seq duplicates'].verdict, 'not-measured');
      assert.equal(out.assertions['c: no seq duplicates'].sample, 0);
    },
  );
});

test('valid cookie, a reconnect that injects a seq gap: the assertion fails, distinct from not-measured', { timeout: 20_000 }, async () => {
  let eventsAttempt = 0;
  await withServer(
    (req, res) => {
      const url = new URL(req.url ?? '/', 'http://placeholder');
      if (url.pathname === '/api/v1/ready') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      if (!hasValidCookie(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthenticated' }));
        return;
      }
      if (url.pathname === `/api/v1/runs/${RUN_ID}`) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'running' }));
        return;
      }
      if (url.pathname === `/api/v1/runs/${RUN_ID}/events`) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const attempt = eventsAttempt++;
        if (attempt === 0) {
          writeSseFrame(res, 1);
          writeSseFrame(res, 2);
          writeSseFrame(res, 3);
          setTimeout(() => res.end(), 100);
          return;
        }
        // Reconnect resumes at seq 5, skipping 4 — a real gap.
        let seq = 5;
        const timer = setInterval(() => writeSseFrame(res, seq++), 50);
        req.on('close', () => clearInterval(timer));
        return;
      }
      res.writeHead(404);
      res.end();
    },
    async (base) => {
      const { code, out } = await runProbe(['--base', base, '--header', `cookie: ${VALID_COOKIE}`, '--run', RUN_ID, '--seconds', '1.2']);

      assert.equal(code, 1);
      assert.equal(out.verdict, 'failed');
      assert.equal(out.assertions['c: no seq gaps'].verdict, 'failed');
      assert.ok(out.assertions['c: no seq gaps'].sample > 0);
      assert.ok(out.sse.gaps.length > 0);
    },
  );
});

test('valid cookie that dies mid-run: pre-failure samples must not read passed', { timeout: 20_000 }, async () => {
  let eventsAttempt = 0;
  await withServer(
    (req, res) => {
      const url = new URL(req.url ?? '/', 'http://placeholder');
      if (url.pathname === '/api/v1/ready') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      if (url.pathname === `/api/v1/runs/${RUN_ID}`) {
        if (!hasValidCookie(req)) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthenticated' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'running' }));
        return;
      }
      if (url.pathname === `/api/v1/runs/${RUN_ID}/events`) {
        const attempt = eventsAttempt++;
        if (attempt >= 2) {
          // The credential "dies" from the third attempt on, regardless of the cookie.
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthenticated' }));
          return;
        }
        if (!hasValidCookie(req)) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthenticated' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const base = attempt === 0 ? 1 : 4;
        writeSseFrame(res, base);
        writeSseFrame(res, base + 1);
        writeSseFrame(res, base + 2);
        setTimeout(() => res.end(), 100);
        return;
      }
      res.writeHead(404);
      res.end();
    },
    async (base) => {
      const { code, out, stderr } = await runProbe(['--base', base, '--header', `cookie: ${VALID_COOKIE}`, '--run', RUN_ID, '--seconds', '1.5']);

      assert.equal(code, 2);
      assert.equal(out.verdict, 'not-measured');
      assert.equal(out.sse.authFailed, true);
      assert.ok(out.sse.events > 0, 'frames were collected before the credential died');
      assert.equal(out.assertions['c: no seq gaps'].verdict, 'not-measured');
      assert.equal(out.assertions['c: no seq gaps'].reason, 'auth-failed');
      assert.ok(out.assertions['c: no seq gaps'].sample > 0, 'sample must still report the true pre-failure count');
      assert.ok(stderr.includes('AUTH REQUIRED'));
    },
  );
});

test('perimeter redirect (e.g. an Access sign-in page): a followed 3xx never counts as a healthy sample', { timeout: 20_000 }, async () => {
  await withServer(
    (req, res) => {
      res.writeHead(302, { location: '/sign-in' });
      res.end();
    },
    async (base) => {
      const { code, out, stderr } = await runProbe(['--base', base, '--header', `cookie: ${VALID_COOKIE}`, '--run', RUN_ID, '--seconds', '1']);

      assert.equal(code, 1, 'a persistent poll failure is a real failure, not a not-measured result');
      assert.equal(out.assertions['b: zero failed HTTP requests'].verdict, 'failed');
      assert.ok(out.poll.failed > 0);
      assert.ok(out.poll.total > 0);
      assert.equal(out.poll.ok, 0, 'a redirect must never be counted as a healthy /ready poll');

      assert.equal(out.sse.authFailed, true, 'a 3xx on the SSE stream is treated the same as a 401/403');
      assert.ok(stderr.includes('AUTH REQUIRED'));
    },
  );
});
