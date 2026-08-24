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
 * Deliberately a standalone script with no dependencies and no cezar imports: it has to keep
 * running while the cezar it is measuring is replaced, so it must not be part of that cezar. Run
 * it from anywhere that can reach the host.
 *
 * Usage:
 *   node deploy-e2e-probe.mjs --base http://127.0.0.1:4321 --run <runId> --seconds 120 \
 *        [--out artifacts/deploy-e2e.json] [--header 'cf-access-token: …']
 *
 *   For a hosted box (CEZ_AUTH=oidc), --run's /runs and /events calls need a session credential:
 *   sign in at https://<host>/ in a browser, open devtools → Application/Storage → Cookies →
 *   <host>, copy the `cez_session` value, then pass:
 *     --header 'cookie: cez_session=<value>'
 *   The cookie is HttpOnly (packages/cezar/src/auth/session.ts) — browser JS (document.cookie)
 *   cannot read it, only the browser's own cookie inspector or a captured Set-Cookie response
 *   header can. That is a constraint on browser script, not on this script: an operator with
 *   disk access to CEZ_HOME on the same box (e.g. an agent task running on prod-host
 *   itself) can instead read an unexpired session id straight out of
 *   <CEZ_HOME>/identity/identity.json (IdentityStore keeps no in-memory cache, so a session
 *   written or read this way is honoured by the running server on its next lookup —
 *   packages/cezar/src/auth/identity-store.ts:169,300-301), or mint a dedicated short-TTL one
 *   via SessionService.createSession(userId, ttlMs) (session.ts:239) and destroy it afterward,
 *   which avoids borrowing a real user's session. There is still no bearer-token/service-account
 *   HTTP auth path — the only way a request authenticates is this one cookie.
 *
 * Exit code is the verdict: 0 = every assertion held, 1 = at least one did not (including any
 * assertion that could not be measured at all — see NOT_MEASURED below).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

const BASE = arg('base', 'http://127.0.0.1:4321').replace(/\/+$/, '');
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

// Validate the operator-supplied window before any request is made. A malformed value (a unit
// typo like `2m`, or the flag given with no following value) drives `deadline` to NaN, `while
// (Date.now() < deadline)` is false on its very first check, and every observation-dependent
// assertion would otherwise read as a vacuous PASS having issued zero requests.
if (!Number.isFinite(SECONDS) || SECONDS <= 0) {
  console.error(`deploy-e2e-probe: --seconds must be a finite positive number, got ${JSON.stringify(arg('seconds', '120'))}`);
  process.exit(1);
}
if (!Number.isFinite(POLL_HZ) || POLL_HZ <= 0) {
  console.error(`deploy-e2e-probe: --hz must be a finite positive number, got ${JSON.stringify(arg('hz', '10'))}`);
  process.exit(1);
}

const started = Date.now();
const deadline = started + SECONDS * 1000;

/** (b) — every request's outcome, so a single failure is attributable to a millisecond. */
const poll = { total: 0, ok: 0, nonOk: [], connectErrors: [], maxLatencyMs: 0, latencies: [] };
/** (c) — every `seq` the SSE subscriber saw, in arrival order, across every reconnect. */
const sse = { seqs: [], reconnects: 0, reloadFrames: 0, errors: [] };
/** (a) — the run's status over time, sampled by the poller. */
const runStatuses = new Set();
let sawInterrupted = false;
let sawKeptGoing = false;
/** A 401/403 on `/runs` or `/events` is a deterministic policy decision, not a flaky condition —
 * recorded once each so the retry loop can stop instead of burning the whole `--seconds` window. */
const authErrors = { events: null, runs: null };
let runsAuthFailed = false;

async function pollOnce() {
  const at = Date.now();
  try {
    const response = await fetch(`${BASE}/api/v1/ready`, { headers, signal: AbortSignal.timeout(10_000) });
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
  if (!RUN_ID || runsAuthFailed) return;
  try {
    const response = await fetch(`${BASE}/api/v1/runs/${RUN_ID}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (response.status === 401 || response.status === 403) {
      // A policy decision that will not change tick-to-tick — stop hitting it for the rest of
      // the run instead of firing ~once a second against a 401 until `deadline`.
      runsAuthFailed = true;
      if (!authErrors.runs) {
        authErrors.runs = { status: response.status, atMs: Date.now() - started, path: `/api/v1/runs/${RUN_ID}` };
      }
      return;
    }
    if (!response.ok) return;
    const run = await response.json();
    if (run?.status) runStatuses.add(run.status);
  } catch {
    // Counted by the poller above; this sampler is not the failure detector.
  }
}

/**
 * Subscribe to the run's event stream, resuming with `Last-Event-ID` after every disconnect.
 *
 * Resuming is the whole test: a client that reconnected from scratch would see the transcript
 * replayed and could not tell a gap from a duplicate. Carrying the last seq is what makes the
 * continuity assertion meaningful.
 */
async function subscribe() {
  if (!RUN_ID) return;
  let lastSeq = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/v1/runs/${RUN_ID}/events`, {
        headers: { ...headers, accept: 'text/event-stream', ...(lastSeq ? { 'Last-Event-ID': String(lastSeq) } : {}) },
      });
      if (response.status === 401 || response.status === 403) {
        // Same reasoning as sampleRun(): a deterministic policy decision, not a transient drop.
        // Stop and return instead of sleeping 100ms and reconnecting until `deadline` (up to
        // ~1200 attempts in a default 120s run).
        if (!authErrors.events) {
          authErrors.events = { status: response.status, atMs: Date.now() - started, path: `/api/v1/runs/${RUN_ID}/events` };
        }
        return;
      }
      if (!response.ok || !response.body) throw new Error(`events answered ${response.status}`);
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
      sse.reconnects += 1;
    } catch (err) {
      sse.errors.push({ atMs: Date.now() - started, error: String(err?.message ?? err) });
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

  // An assertion computed from zero observations is NOT_MEASURED, never a vacuous PASS — an
  // empty array/set satisfies `.every(...)` and `.length === 0` trivially, and this script was
  // measured printing `passed: true` on exactly that basis (see the spec this implements).
  const pollObserved = poll.total > 0;
  const sseObserved = sse.seqs.length > 0;
  const runObserved = runStatuses.size > 0;

  const assertions = {
    // (b) the definition of "gap = 0" the spec commits to.
    'b: zero failed HTTP requests': !pollObserved ? 'NOT_MEASURED' : poll.nonOk.length === 0 ? 'PASS' : 'FAIL',
    'b: zero refused connections': !pollObserved ? 'NOT_MEASURED' : poll.connectErrors.length === 0 ? 'PASS' : 'FAIL',
  };
  if (RUN_ID) {
    // Whether the two authenticated endpoints were even reachable — a 401/403 is a hard failure,
    // not a silently-ignored error entry.
    assertions['auth: /runs/:id reachable'] = authErrors.runs ? 'FAIL' : 'PASS';
    assertions['auth: /runs/:id/events reachable'] = authErrors.events ? 'FAIL' : 'PASS';
    // (c) no lost or duplicated events across the reconnect. Only meaningful once `--run` is
    // supplied — `sse.seqs` can only be non-empty when RUN_ID is set.
    assertions['c: no seq gaps'] = !sseObserved ? 'NOT_MEASURED' : gaps.length === 0 ? 'PASS' : 'FAIL';
    assertions['c: no seq duplicates'] = !sseObserved ? 'NOT_MEASURED' : duplicates.length === 0 ? 'PASS' : 'FAIL';
    // (a) the run never leaves `running`, and is not force-continued.
    assertions['a: run never left running'] = !runObserved
      ? 'NOT_MEASURED'
      : [...runStatuses].every((s) => s === 'running')
        ? 'PASS'
        : 'FAIL';
    assertions['a: no interrupted event'] = !runObserved ? 'NOT_MEASURED' : !sawInterrupted ? 'PASS' : 'FAIL';
  }

  const report = {
    base: BASE,
    runId: RUN_ID ?? null,
    durationMs: Date.now() - started,
    poll: {
      total: poll.total,
      ok: poll.ok,
      failed: poll.nonOk.length,
      connectErrors: poll.connectErrors.length,
      // `gapMs` as the spec names it: the max client-observed latency across the swap.
      gapMs: poll.maxLatencyMs,
      p50: p(0.5),
      p99: p(0.99),
      failures: poll.nonOk.slice(0, 20),
      refusals: poll.connectErrors.slice(0, 20),
    },
    sse: {
      events: sse.seqs.length,
      reconnects: sse.reconnects,
      reloadFrames: sse.reloadFrames,
      gaps,
      duplicates,
      // 401/403 on `/events` exits subscribe() before it would repeat, so this array holds only
      // the transient (non-auth) errors the retry loop rode out.
      errors: sse.errors.slice(0, 20),
    },
    run: { statuses: [...runStatuses], sawInterrupted, sawKeptGoing },
    auth: { events: authErrors.events, runs: authErrors.runs },
    assertions,
    passed: Object.values(assertions).every((state) => state === 'PASS'),
  };

  const text = JSON.stringify(report, null, 2);
  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${text}\n`);
  }
  console.log(text);
  for (const [name, state] of Object.entries(assertions)) {
    console.log(`${state.padEnd(12)}  ${name}`);
    if (state === 'FAIL' && name.startsWith('auth:')) {
      const detail = name.includes('events') ? report.auth.events : report.auth.runs;
      console.log(
        `      → ${detail.status} unauthenticated at t=${detail.atMs}ms. Supply credentials: --header 'cookie: cez_session=<value>'`,
      );
      console.log(`        (see script usage comment / README "CEZ_AUTH=oidc" for how to obtain one)`);
    }
  }
  process.exit(report.passed ? 0 : 1);
}

await main();
