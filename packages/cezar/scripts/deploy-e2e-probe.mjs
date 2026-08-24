#!/usr/bin/env node
/**
 * The continuous-client harness for the non-disruptive-deploy acceptance E2E
 * (`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`, Verification).
 *
 * This is the thing that MEASURES the two acceptance criteria. The spec is explicit that "gap = 0"
 * is not "no TCP connection was ever closed" — an SSE stream is unbounded, so any process
 * replacement must eventually close one. What must not happen is a lost byte or a failed request.
 * So this runs two clients across a cutover and reports:
 *
 *   (b) a 10 rps poller against `/api/v1/ready`  → zero non-2xx, zero connect errors, max latency
 *   (c) an SSE subscriber on a live run's events → `seq` continuous across its reconnect
 *   (a) the run's status and its transcript      → never leaves `running`, no `interrupted` event
 *
 * Every assertion is a `{ verdict, sample, reason? }` tuple, never a bare boolean: an assertion
 * computed over zero observations reports `verdict: 'not-measured'`, not `'passed'`. This matters
 * because the SSE and run-status endpoints are behind this box's session auth — a probe run with no
 * credential (or one whose credential dies mid-run) legitimately measures nothing on those two
 * streams, and a bare `every(Boolean)` over an empty array reads `true`. See
 * `.ai/specs/2026-08-22-deploy-e2e-probe-measured-assertions.md` for the full rationale.
 *
 * Deliberately a standalone script with no dependencies and no cezar imports: it has to keep
 * running while the cezar it is measuring is replaced, so it must not be part of that cezar. Run
 * it from anywhere that can reach the host.
 *
 * Usage:
 *   node deploy-e2e-probe.mjs --base http://127.0.0.1:4321 --project cezar --run <runId> --seconds 120 \
 *        [--out artifacts/deploy-e2e.json] [--header 'cookie: cez_session=<id>']
 *
 * `/api/v1/runs/:id` and `/api/v1/runs/:id/events` require a principal on a `CEZ_AUTH`-enabled
 * box; `/api/v1/ready` does not. Over loopback (the address every recorded run uses), the working
 * credential is this box's own OIDC session cookie — read an unexpired id out of
 * `<CEZ_HOME>/identity/identity.json` and pass it as `--header 'cookie: cez_session=<id>'` (see
 * the parent spec's "How to run the acceptance E2E" section). `cf-access-token` is a different
 * header for a different perimeter — Cloudflare Access, which fronts the public edge
 * (`https://cockpit.example.com`), not loopback — and is not what this probe's own credential
 * clears.
 *
 * Exit code is the verdict: 0 = every assertion passed, 1 = at least one failed, 2 = at least one
 * assertion could not be measured (and none failed) — e.g. no credential was supplied.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

const BASE = arg('base', 'http://127.0.0.1:4321').replace(/\/+$/, '');
const PROJECT_ID = arg('project');
const RUNS_BASE = PROJECT_ID
  ? `${BASE}/api/v1/p/${encodeURIComponent(PROJECT_ID)}/runs`
  : `${BASE}/api/v1/runs`;
const RUN_ID = arg('run');
const SECONDS = Number(arg('seconds', '120'));
const OUT = arg('out');
const POLL_HZ = Number(arg('hz', '10'));
const headers = {};
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] !== '--header') continue;
  const [key, ...rest] = String(process.argv[i + 1] ?? '').split(':');
  if (key && rest.length) headers[key.trim()] = rest.join(':').trim();
}

const started = Date.now();
const deadline = started + SECONDS * 1000;

/** 401/403 is a real auth rejection; a 3xx is a perimeter (e.g. Cloudflare Access) redirecting a
 * client that `fetch`'s default `redirect: 'follow'` would otherwise chase into a phantom 200. Both
 * are the same failure class for this probe's purposes: the endpoint was never actually reached. */
function isAuthFailureStatus(status) {
  return status === 401 || status === 403 || (status >= 300 && status < 400);
}

function logAuthRequired(url, status) {
  console.error(
    `[deploy-e2e-probe] AUTH REQUIRED: GET ${url} answered ${status} — pass a session cookie, e.g. ` +
      `--header 'cookie: cez_session=<id>' (see .ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md ` +
      `§ Verification). This stream will not be measured.`,
  );
}

/** (b) — every request's outcome, so a single failure is attributable to a millisecond. */
const poll = { total: 0, ok: 0, nonOk: [], connectErrors: [], maxLatencyMs: 0, latencies: [] };
/** (c) — every `seq` the SSE subscriber saw, in arrival order, across every reconnect. */
const sse = {
  seqs: [],
  reconnects: 0,
  reloadFrames: 0,
  dataFrames: 0,
  errors: [],
  errorCount: 0,
  authFailed: false,
};
/** (a) — the run's status over time, sampled by the poller. */
const runStatuses = new Set();
const run = { sampleCount: 0, authFailed: false, errorCount: 0, lastError: null };
let sawInterrupted = false;
let sawKeptGoing = false;
let sseAuthRequiredLogged = false;
let runAuthRequiredLogged = false;

async function pollOnce() {
  const at = Date.now();
  try {
    const response = await fetch(`${BASE}/api/v1/ready`, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    const latency = Date.now() - at;
    poll.total += 1;
    poll.latencies.push(latency);
    poll.maxLatencyMs = Math.max(poll.maxLatencyMs, latency);
    if (response.ok) poll.ok += 1;
    else poll.nonOk.push({ atMs: at - started, status: response.status, latencyMs: latency });
    // Drain the body so the connection is reusable rather than abandoned mid-response.
    await response.arrayBuffer();
  } catch (err) {
    poll.total += 1;
    // A connect error is the failure socket activation exists to make impossible. Recorded with a
    // timestamp so it can be lined up against the cutover in the deploy log.
    poll.connectErrors.push({ atMs: at - started, error: String(err?.message ?? err) });
  }
}

/** Sample the run record, so (a) is measured continuously rather than only before and after. */
async function sampleRun() {
  if (!RUN_ID || run.authFailed) return;
  const url = `${RUNS_BASE}/${RUN_ID}`;
  try {
    const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      const bodySnippet = (await response.text().catch(() => '')).slice(0, 200);
      run.errorCount += 1;
      run.lastError = { status: response.status, bodySnippet };
      if (isAuthFailureStatus(response.status)) {
        run.authFailed = true;
        if (!runAuthRequiredLogged) {
          runAuthRequiredLogged = true;
          logAuthRequired(url, response.status);
        }
      }
      return;
    }
    run.sampleCount += 1;
    const record = await response.json();
    if (record?.status) runStatuses.add(record.status);
  } catch {
    // Counted by the poller above; this sampler is not the failure detector.
  }
}

/**
 * Subscribe to the run's event stream, resuming with `Last-Event-ID` after every disconnect.
 *
 * Resuming is the whole test: a client that reconnected from scratch would see the transcript
 * replayed and could not tell a gap from a duplicate. Carrying the last seq is what makes the
 * continuity assertion meaningful — and `sse.reconnects` only counts a connection that actually
 * resumed (carried `Last-Event-ID` and got back a live stream), not every loop iteration that
 * happened to end, so a window with no real cutover in it can't manufacture a false reconnect.
 */
async function subscribe() {
  if (!RUN_ID) return;
  let lastSeq = 0;
  while (Date.now() < deadline) {
    if (sse.authFailed) return;
    const isReconnect = lastSeq !== 0;
    const url = `${RUNS_BASE}/${RUN_ID}/events`;
    try {
      const response = await fetch(url, {
        headers: { ...headers, accept: 'text/event-stream', ...(lastSeq ? { 'Last-Event-ID': String(lastSeq) } : {}) },
        redirect: 'manual',
      });
      if (isAuthFailureStatus(response.status)) {
        sse.authFailed = true;
        if (!sseAuthRequiredLogged) {
          sseAuthRequiredLogged = true;
          logAuthRequired(url, response.status);
        }
        return;
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!response.ok || !response.body || !contentType.startsWith('text/event-stream')) {
        throw new Error(`events answered ${response.status} (content-type: ${contentType || 'none'})`);
      }
      if (isReconnect) sse.reconnects += 1;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split = buffer.indexOf('\n\n');
        while (split >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          split = buffer.indexOf('\n\n');
          handleFrame(frame, (seq) => {
            lastSeq = seq;
          });
        }
        if (Date.now() >= deadline) {
          await reader.cancel();
          return;
        }
      }
    } catch (err) {
      sse.errors.push({ atMs: Date.now() - started, error: String(err?.message ?? err) });
      sse.errorCount += 1;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

function handleFrame(frame, setSeq) {
  let event = 'message';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (event === 'reload') {
    // The terminal frame a draining server sends (P3). Its presence is the proof the cutover was
    // graceful rather than a severed socket.
    sse.reloadFrames += 1;
    return;
  }
  if (!data) return;
  try {
    const payload = JSON.parse(data);
    // Every parsed data frame counts here, seq or not — the interrupted-event assertion is driven
    // by `message`, not `seq`, so this is its sample base, not `sse.seqs.length`.
    sse.dataFrames += 1;
    if (typeof payload.seq === 'number') {
      sse.seqs.push(payload.seq);
      setSeq(payload.seq);
    }
    const message = typeof payload.message === 'string' ? payload.message : '';
    if (message.includes('interrupted — cezar process exited during the run')) sawInterrupted = true;
    if (message.includes('this run kept going')) sawKeptGoing = true;
  } catch {
    // A frame we cannot parse is not a continuity failure; the seq check below is the assertion.
  }
}

/** Gaps and duplicates in the `seq` sequence — the (c) assertion, and half of (a). */
function continuity(seqs) {
  const gaps = [];
  const duplicates = [];
  const seen = new Set();
  let previous = null;
  for (const seq of seqs) {
    if (seen.has(seq)) duplicates.push(seq);
    seen.add(seq);
    if (previous !== null && seq > previous + 1) gaps.push({ after: previous, next: seq });
    if (previous === null || seq > previous) previous = seq;
  }
  return { gaps, duplicates };
}

/**
 * An assertion computed over zero samples is `not-measured`, full stop — the predicate never runs
 * on nothing. A stream whose credential died (`authFailed`) is `not-measured` regardless of how
 * many samples it collected before the failure, since measurement that stopped early is not the
 * same as measurement that covered the whole window; `sample` still reports the true pre-failure
 * count so an artifact reader can see how much data was collected before the credential died.
 */
function assertion(sample, authFailed, notMeasuredReason, predicate) {
  if (authFailed) return { verdict: 'not-measured', sample, reason: 'auth-failed' };
  if (sample === 0) {
    return notMeasuredReason ? { verdict: 'not-measured', sample, reason: notMeasuredReason } : { verdict: 'not-measured', sample };
  }
  return { verdict: predicate() ? 'passed' : 'failed', sample };
}

async function main() {
  const pollLoop = (async () => {
    const interval = 1000 / POLL_HZ;
    let tick = 0;
    while (Date.now() < deadline) {
      const at = Date.now();
      await pollOnce();
      if (tick % POLL_HZ === 0) await sampleRun(); // once a second, not ten times
      tick += 1;
      const spent = Date.now() - at;
      if (spent < interval) await new Promise((r) => setTimeout(r, interval - spent));
    }
  })();

  await Promise.all([pollLoop, subscribe()]);

  const { gaps, duplicates } = continuity(sse.seqs);
  const latencies = poll.latencies.slice().sort((a, b) => a - b);
  const p = (q) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))] ?? 0;

  const noRunId = !RUN_ID;
  // Gated on having observed a *resumed* connection, not just on having seen frames: a window with
  // no cutover in it saw events but never measured continuity "across a reconnect", which is what
  // acceptance criterion #2 actually asks for.
  const sseSample = sse.reconnects > 0 ? sse.seqs.length : 0;

  const assertions = {
    // (b) the definition of "gap = 0" the spec commits to. Never gated on RUN_ID or auth — /ready
    // is exempt from the principal middleware.
    'b: zero failed HTTP requests': assertion(poll.total, false, undefined, () => poll.nonOk.length === 0),
    'b: zero refused connections': assertion(poll.total, false, undefined, () => poll.connectErrors.length === 0),
    // (c) no lost or duplicated events across the reconnect.
    'c: no seq gaps': assertion(sseSample, sse.authFailed, noRunId ? 'no-run-id' : undefined, () => gaps.length === 0),
    'c: no seq duplicates': assertion(sseSample, sse.authFailed, noRunId ? 'no-run-id' : undefined, () => duplicates.length === 0),
    // (a) the run never leaves `running`, and is not force-continued.
    'a: run never left running': assertion(run.sampleCount, run.authFailed, noRunId ? 'no-run-id' : undefined, () =>
      [...runStatuses].every((s) => s === 'running'),
    ),
    'a: no interrupted event': assertion(sse.dataFrames, sse.authFailed, noRunId ? 'no-run-id' : undefined, () => !sawInterrupted),
  };

  const verdicts = Object.values(assertions).map((a) => a.verdict);
  const verdict = verdicts.includes('failed') ? 'failed' : verdicts.includes('not-measured') ? 'not-measured' : 'passed';
  const exitCode = verdict === 'passed' ? 0 : verdict === 'failed' ? 1 : 2;

  const report = {
    base: BASE,
    runId: RUN_ID ?? null,
    durationMs: Date.now() - started,
    poll: {
      total: poll.total,
      ok: poll.ok,
      failed: poll.nonOk.length,
      connectErrors: poll.connectErrors.length,
      // `gapMs` as the parent spec names it: the max client-observed latency across the swap.
      gapMs: poll.maxLatencyMs,
      maxLatencyMs: poll.maxLatencyMs, // exact alias of gapMs — same number, the name defect 8dc8bf3a asked for
      p50: p(0.5),
      p99: p(0.99),
      failures: poll.nonOk.slice(0, 20),
      refusals: poll.connectErrors.slice(0, 20),
    },
    sse: {
      events: sse.seqs.length,
      reconnects: sse.reconnects,
      reloadFrames: sse.reloadFrames,
      dataFrames: sse.dataFrames,
      gaps,
      duplicates,
      errors: sse.errors.slice(0, 20),
      errorCount: sse.errorCount,
      authFailed: sse.authFailed,
    },
    run: {
      statuses: [...runStatuses],
      sawInterrupted,
      sawKeptGoing,
      sampleCount: run.sampleCount,
      authFailed: run.authFailed,
      errorCount: run.errorCount,
      lastError: run.lastError,
    },
    assertions,
    verdict,
    // Kept for callers that still grep `"passed": true` — narrowed so it can never read `true` on a
    // `not-measured` verdict, which is the defect this field's own presence used to launder.
    passed: verdict === 'passed',
  };

  const text = JSON.stringify(report, null, 2);
  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${text}\n`);
  }
  console.log(text);
  for (const [name, result] of Object.entries(assertions)) {
    const label = result.verdict === 'passed' ? 'PASS' : result.verdict === 'failed' ? 'FAIL' : 'UNMEASURED';
    console.log(`${label.padEnd(10)}  ${name.padEnd(36)}  (n=${result.sample})`);
  }
  console.log(`verdict=${verdict} exit=${exitCode}`);
  process.exit(exitCode);
}

await main();
