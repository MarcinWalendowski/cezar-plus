import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

// The script under test is a standalone, dependency-free scripts/*.mjs, not part of this
// package's `src/` — it deliberately has no cezar imports (it has to keep running while the
// cezar it measures is replaced). Spawn it as a real child process against a `node:http`
// fixture, matching this repo's existing pattern for testing a standalone script
// (test/unit/test-env-launcher.test.ts).
const scriptPath = resolve(import.meta.dirname, '../../scripts/deploy-e2e-probe.mjs');

type Fixture = { url: string; requests: RecordedRequest[]; close: () => void };
type RecordedRequest = { method: string; url: string; headers: http.IncomingHttpHeaders };

const fixtures: Array<() => void> = [];
const outDirs: string[] = [];

afterEach(() => {
  for (const close of fixtures.splice(0)) close();
  for (const dir of outDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function startFixture(handler: (req: http.IncomingMessage, res: http.ServerResponse, requests: RecordedRequest[]) => void): Promise<Fixture> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? 'GET', url: req.url ?? '', headers: req.headers });
    handler(req, res, requests);
  });
  fixtures.push(() => server.close());
  return new Promise((resolveFixture) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('expected a TCP address');
      resolveFixture({ url: `http://127.0.0.1:${address.port}`, requests, close: () => server.close() });
    });
  });
}

function outPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cez-deploy-e2e-probe-test-'));
  outDirs.push(dir);
  return join(dir, 'report.json');
}

// A synchronous spawn would block this process's own event loop while waiting for the child to
// exit — and the in-process fixture http server needs that same event loop to answer the child's
// requests, so a sync spawn deadlocks against any fixture that isn't already listening in a
// separate process. Use the async form and drive it to completion with a promise instead.
function runProbe(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [scriptPath, ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 15_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolveRun({ status, stdout, stderr });
    });
  });
}

function readReport(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sseFrame(seq: number): string {
  return `data: ${JSON.stringify({ seq })}\n\n`;
}

// Requests to `/events` end in `/events`; requests to `/runs/:id` do not. `/ready` is its own path.
function isEventsRequest(url: string): boolean {
  return url.endsWith('/events');
}
function isRunRequest(url: string): boolean {
  return url.includes('/api/v1/runs/') && !url.endsWith('/events');
}

test('a malformed --seconds (unit-suffix typo) exits non-zero before any request, not a vacuous PASS', async () => {
  const fixture = await startFixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const result = await runProbe(['--base', fixture.url, '--run', 'abc', '--seconds', '2m']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--seconds must be a finite positive number/);
  assert.equal(fixture.requests.length, 0);
});

test('a bare --seconds with no following value exits non-zero before any request', async () => {
  const fixture = await startFixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  // `--seconds` is the last token, so `arg('seconds', ...)` sees no following value.
  const result = await runProbe(['--base', fixture.url, '--run', 'abc', '--seconds']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--seconds must be a finite positive number/);
  assert.equal(fixture.requests.length, 0);
});

test('a malformed --hz exits non-zero before any request', async () => {
  const fixture = await startFixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const result = await runProbe(['--base', fixture.url, '--run', 'abc', '--seconds', '1', '--hz', 'fast']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--hz must be a finite positive number/);
  assert.equal(fixture.requests.length, 0);
});

test('zero SSE events and empty run statuses report NOT_MEASURED, never PASS, and fail the run', async () => {
  const fixture = await startFixture((req, res, _requests) => {
    const url = req.url ?? '';
    if (url === '/api/v1/ready') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (isEventsRequest(url)) {
      // 200s, but never writes a single frame — and only closes after the probe's window has
      // already elapsed, so `subscribe()` doesn't spin reconnecting inside the window.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      setTimeout(() => res.end(), 1300);
      return;
    }
    if (isRunRequest(url)) {
      // 200s but never matches a real run — no `status` field, so nothing is ever recorded.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const out = outPath();
  const result = await runProbe(['--base', fixture.url, '--run', 'missing-run', '--seconds', '1', '--hz', '20', '--out', out]);
  const report = readReport(out);

  assert.equal(report.sse.events, 0);
  assert.deepEqual(report.run.statuses, []);
  assert.equal(report.assertions['c: no seq gaps'], 'NOT_MEASURED');
  assert.equal(report.assertions['c: no seq duplicates'], 'NOT_MEASURED');
  assert.equal(report.assertions['a: run never left running'], 'NOT_MEASURED');
  assert.equal(report.assertions['a: no interrupted event'], 'NOT_MEASURED');
  assert.equal(report.passed, false);
  assert.notEqual(result.status, 0);
});

test('a live run with real SSE frames and a live run record computes real PASS/FAIL, not NOT_MEASURED', async () => {
  const fixture = await startFixture((req, res, _requests) => {
    const url = req.url ?? '';
    if (url === '/api/v1/ready') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (isEventsRequest(url)) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseFrame(1));
      res.write(sseFrame(2));
      res.write(sseFrame(3));
      setTimeout(() => res.end(), 1300);
      return;
    }
    if (isRunRequest(url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'running' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const out = outPath();
  const result = await runProbe(['--base', fixture.url, '--run', 'real-run', '--seconds', '1', '--hz', '20', '--out', out]);
  const report = readReport(out);

  assert.equal(report.sse.events, 3);
  assert.deepEqual(report.run.statuses, ['running']);
  for (const name of [
    'b: zero failed HTTP requests',
    'b: zero refused connections',
    'auth: /runs/:id reachable',
    'auth: /runs/:id/events reachable',
    'c: no seq gaps',
    'c: no seq duplicates',
    'a: run never left running',
    'a: no interrupted event',
  ]) {
    assert.equal(report.assertions[name], 'PASS', `expected ${name} to be PASS, got ${report.assertions[name]}`);
  }
  assert.equal(report.passed, true);
  assert.equal(result.status, 0);
});

test('a 401 on /events is a hard failure: no retry loop, report.auth.events populated, remediation printed', async () => {
  const fixture = await startFixture((req, res, _requests) => {
    const url = req.url ?? '';
    if (url === '/api/v1/ready') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (isEventsRequest(url)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthenticated"}');
      return;
    }
    if (isRunRequest(url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'running' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const out = outPath();
  const result = await runProbe(['--base', fixture.url, '--run', 'authed-run', '--seconds', '1', '--hz', '20', '--out', out]);
  const report = readReport(out);

  const eventRequests = fixture.requests.filter((r) => isEventsRequest(r.url));
  assert.equal(eventRequests.length, 1, 'events should be requested exactly once, not retried in a loop');
  assert.ok(report.sse.errors.length <= 1);
  assert.ok(report.auth.events, 'report.auth.events should be populated');
  assert.equal(report.auth.events.status, 401);
  assert.equal(report.assertions['auth: /runs/:id/events reachable'], 'FAIL');
  assert.equal(report.passed, false);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Supply credentials: --header 'cookie: cez_session=<value>'/);
});

test('a 401 on /runs (not /events) stops sampling that endpoint after the first failure', async () => {
  const fixture = await startFixture((req, res, _requests) => {
    const url = req.url ?? '';
    if (url === '/api/v1/ready') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (isEventsRequest(url)) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseFrame(1));
      setTimeout(() => res.end(), 1300);
      return;
    }
    if (isRunRequest(url)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthenticated"}');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const out = outPath();
  const result = await runProbe(['--base', fixture.url, '--run', 'authed-run-2', '--seconds', '1', '--hz', '20', '--out', out]);
  const report = readReport(out);

  const runRequests = fixture.requests.filter((r) => isRunRequest(r.url));
  assert.ok(runRequests.length <= 2, `expected sampleRun to stop after the first 401, got ${runRequests.length} calls`);
  assert.ok(report.auth.runs, 'report.auth.runs should be populated');
  assert.equal(report.assertions['auth: /runs/:id reachable'], 'FAIL');
  assert.equal(report.assertions['auth: /runs/:id/events reachable'], 'PASS');
  assert.equal(report.passed, false);
  assert.notEqual(result.status, 0);
});

test('--header is sent on every /runs and /events request', async () => {
  const fixture = await startFixture((req, res, _requests) => {
    const url = req.url ?? '';
    if (url === '/api/v1/ready') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (isEventsRequest(url)) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseFrame(1));
      setTimeout(() => res.end(), 1300);
      return;
    }
    if (isRunRequest(url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'running' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const out = outPath();
  await runProbe([
    '--base',
    fixture.url,
    '--run',
    'headered-run',
    '--seconds',
    '1',
    '--hz',
    '20',
    '--out',
    out,
    '--header',
    'cookie: cez_session=abc123',
  ]);

  const runRequest = fixture.requests.find((r) => isRunRequest(r.url));
  const eventsRequest = fixture.requests.find((r) => isEventsRequest(r.url));
  assert.equal(runRequest?.headers.cookie, 'cez_session=abc123');
  assert.equal(eventsRequest?.headers.cookie, 'cez_session=abc123');
});

test('an HTTP-only invocation (no --run) never includes c:/a:/auth: assertions', async () => {
  const fixture = await startFixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });

  const out = outPath();
  const result = await runProbe(['--base', fixture.url, '--seconds', '1', '--hz', '20', '--out', out]);
  const report = readReport(out);

  assert.equal(report.runId, null);
  for (const name of Object.keys(report.assertions)) {
    assert.ok(!name.startsWith('c:') && !name.startsWith('a:') && !name.startsWith('auth:'), `unexpected assertion in HTTP-only run: ${name}`);
  }
  assert.equal(report.passed, true);
  assert.equal(result.status, 0);
});
