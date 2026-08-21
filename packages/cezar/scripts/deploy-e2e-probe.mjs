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
 * Exit code is the verdict: 0 = every assertion held, 1 = at least one did not.
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
  if (!RUN_ID) return;
  try {
    const response = await fetch(`${BASE}/api/v1/runs/${RUN_ID}`, { headers, signal: AbortSignal.timeout(10_000) });
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

  const assertions = {
    // (b) the definition of "gap = 0" the spec commits to.
    'b: zero failed HTTP requests': poll.nonOk.length === 0,
    'b: zero refused connections': poll.connectErrors.length === 0,
    // (c) no lost or duplicated events across the reconnect.
    'c: no seq gaps': gaps.length === 0,
    'c: no seq duplicates': duplicates.length === 0,
  };
  if (RUN_ID) {
    // (a) the run never leaves `running`, and is not force-continued.
    assertions['a: run never left running'] = [...runStatuses].every((s) => s === 'running');
    assertions['a: no interrupted event'] = !sawInterrupted;
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
      errors: sse.errors.slice(0, 20),
    },
    run: { statuses: [...runStatuses], sawInterrupted, sawKeptGoing },
    assertions,
    passed: Object.values(assertions).every(Boolean),
  };

  const text = JSON.stringify(report, null, 2);
  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${text}\n`);
  }
  console.log(text);
  for (const [name, ok] of Object.entries(assertions)) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  process.exit(report.passed ? 0 : 1);
}

await main();
