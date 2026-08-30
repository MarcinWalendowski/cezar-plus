#!/usr/bin/env node
/**
 * Continuous client harness for the non-disruptive deploy acceptance E2E.
 *
 * This script deliberately has no cezar imports. It must remain alive while the cezar process it
 * measures is replaced. The acceptance run uses the optional local transcript and witness inputs;
 * without those inputs the HTTP and SSE portions remain remotely runnable.
 */

import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EM_DASH = String.fromCodePoint(0x2014);
const INTERRUPTION_ERROR = `interrupted ${EM_DASH} cezar process exited during the run`;

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

function isAuthFailureStatus(status) {
  return status === 401 || status === 403 || (status >= 300 && status < 400);
}

function percentile(values, quantile) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

function availabilityUrl(base, path) {
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

function parseHeaders() {
  const result = {};
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] !== '--header') continue;
    const [key, ...rest] = String(process.argv[i + 1] ?? '').split(':');
    if (key && rest.length) result[key.trim()] = rest.join(':').trim();
  }
  return result;
}

function freshRequest(url, headers) {
  const parsed = new URL(url);
  const request = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolveRequest, rejectRequest) => {
    const req = request(
      parsed,
      {
        method: 'GET',
        headers: { ...headers, connection: 'close' },
        agent: parsed.protocol === 'https:' ? new HttpsAgent({ keepAlive: false }) : new HttpAgent({ keepAlive: false }),
      },
      (response) => {
        response.on('data', () => {});
        response.once('end', () => resolveRequest({ status: response.statusCode ?? 0 }));
        response.once('error', rejectRequest);
      },
    );
    req.setTimeout(10_000, () => req.destroy(new Error('request timed out')));
    req.once('error', rejectRequest);
    req.end();
  });
}

function isCanonicalInterruption(value) {
  return typeof value === 'string' && value.includes(INTERRUPTION_ERROR);
}

function interruptionSnapshot(record) {
  const stepErrors = {};
  for (const step of Array.isArray(record?.steps) ? record.steps : []) {
    if (typeof step?.id !== 'string') continue;
    stepErrors[step.id] = typeof step.error === 'string' ? step.error : '';
  }
  return {
    runError: typeof record?.error === 'string' ? record.error : '',
    stepErrors,
  };
}

function interruptionKey(scope, stepId) {
  return scope === 'run' ? 'run' : `step:${stepId}`;
}

function missingSeqs(gaps) {
  const result = [];
  for (const gap of gaps) {
    if (!Number.isSafeInteger(gap.after) || !Number.isSafeInteger(gap.next)) continue;
    for (let seq = gap.after + 1; seq < gap.next; seq += 1) result.push(seq);
  }
  return result;
}

/** Classify wire gaps against the persisted event transcript. */
export function classifyGaps(gaps, transcriptPath) {
  const result = {
    checked: false,
    transcriptPath: transcriptPath ?? null,
    ephemeralHoles: 0,
    durableLoss: [],
    unreadable: 0,
  };
  if (!transcriptPath) return result;

  let text;
  try {
    text = readFileSync(transcriptPath, 'utf8');
  } catch {
    result.unreadable = missingSeqs(gaps).length;
    return result;
  }

  const persisted = new Map();
  let malformedLine = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (Number.isSafeInteger(event?.seq)) persisted.set(event.seq, event);
    } catch {
      malformedLine = true;
    }
  }

  for (const seq of missingSeqs(gaps)) {
    const event = persisted.get(seq);
    if (event) {
      result.durableLoss.push({
        seq,
        type: typeof event.type === 'string' ? event.type : '',
        ts: typeof event.ts === 'string' ? event.ts : '',
      });
    } else if (malformedLine) {
      result.unreadable += 1;
    } else {
      result.ephemeralHoles += 1;
    }
  }
  result.checked = true;
  return result;
}

/** Return true only when every supplied event timestamp falls inside the inclusive window. */
export function timestampsWithinWindow(startedAt, endedAt, timestamps) {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return false;
  return timestamps.every((value) => {
    const timestamp = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
  });
}

function createProbeState(startedMs, config) {
  return {
    startedMs,
    config,
    poll: { total: 0, ok: 0, nonOk: [], connectErrors: [], maxLatencyMs: 0, latencies: [] },
    pollFresh: { total: 0, ok: 0, nonOk: [], connectErrors: [], maxLatencyMs: 0, latencies: [] },
    sse: {
      seqs: [],
      reconnects: 0,
      reconnectSeqFloor: 0,
      reloadFrames: 0,
      dataFrames: 0,
      errors: [],
      errorCount: 0,
      authFailed: false,
      markers: { keptGoing: [], chainRequeued: [], continuationRequeued: [], adoptedOut: [] },
    },
    run: {
      sampleCount: 0,
      authFailed: false,
      errorCount: 0,
      lastError: null,
      statuses: new Set(),
      baseline: null,
      currentInterruption: null,
      newInterruptionErrors: [],
      seenNewInterruptionKeys: new Set(),
    },
    sseAuthRequiredLogged: false,
    runAuthRequiredLogged: false,
  };
}

function logAuthRequired(url, status) {
  console.error(
    `[deploy-e2e-probe] AUTH REQUIRED: GET ${url} answered ${status}. ` +
      "Pass a session cookie with --header 'cookie: cez_session=<id>'. This stream will not be measured.",
  );
}

async function pollOnce(state, fresh) {
  const stats = fresh ? state.pollFresh : state.poll;
  const at = Date.now();
  const url = availabilityUrl(state.config.base, state.config.availPath);
  try {
    const response = fresh
      ? await freshRequest(url, state.config.headers)
      : await fetch(url, {
          headers: state.config.headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        }).then(async (value) => {
          await value.arrayBuffer();
          return { status: value.status, ok: value.ok };
        });
    const latency = Date.now() - at;
    stats.total += 1;
    stats.latencies.push(latency);
    stats.maxLatencyMs = Math.max(stats.maxLatencyMs, latency);
    const ok = 'ok' in response ? response.ok : response.status >= 200 && response.status < 300;
    if (ok) stats.ok += 1;
    else stats.nonOk.push({ atMs: at - state.startedMs, status: response.status, latencyMs: latency });
  } catch (err) {
    stats.total += 1;
    stats.connectErrors.push({ atMs: at - state.startedMs, error: String(err?.message ?? err) });
  }
}

function updateInterruption(state, record, atMs) {
  const current = interruptionSnapshot(record);
  state.run.currentInterruption = current;
  if (!state.run.baseline) {
    state.run.baseline = {
      sampledAt: new Date(state.startedMs + atMs).toISOString(),
      runError: current.runError,
      stepErrors: { ...current.stepErrors },
    };
    return;
  }
  if (isCanonicalInterruption(current.runError) && !isCanonicalInterruption(state.run.baseline.runError)) {
    const key = interruptionKey('run');
    if (!state.run.seenNewInterruptionKeys.has(key)) {
      state.run.seenNewInterruptionKeys.add(key);
      state.run.newInterruptionErrors.push({ scope: 'run', stepId: '', firstSeenAtMs: atMs });
    }
  }
  for (const [stepId, error] of Object.entries(current.stepErrors)) {
    if (!isCanonicalInterruption(error) || isCanonicalInterruption(state.run.baseline.stepErrors[stepId])) continue;
    const key = interruptionKey('step', stepId);
    if (state.run.seenNewInterruptionKeys.has(key)) continue;
    state.run.seenNewInterruptionKeys.add(key);
    state.run.newInterruptionErrors.push({ scope: 'step', stepId, firstSeenAtMs: atMs });
  }
}

async function sampleRun(state) {
  if (!state.config.runId || state.run.authFailed) return;
  const url = `${state.config.runsBase}/${state.config.runId}`;
  try {
    const response = await fetch(url, {
      headers: state.config.headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const bodySnippet = (await response.text().catch(() => '')).slice(0, 200);
      state.run.errorCount += 1;
      state.run.lastError = { status: response.status, bodySnippet };
      if (isAuthFailureStatus(response.status)) {
        state.run.authFailed = true;
        if (!state.runAuthRequiredLogged) {
          state.runAuthRequiredLogged = true;
          logAuthRequired(url, response.status);
        }
      }
      return;
    }
    state.run.sampleCount += 1;
    const record = await response.json();
    if (record?.status) state.run.statuses.add(record.status);
    updateInterruption(state, record, Date.now() - state.startedMs);
  } catch {
    // The availability poller is the HTTP failure detector. A run sample failure is retained in
    // the sample count only when the endpoint actually returned a record.
  }
}

function addMarker(state, kind, seq) {
  state.sse.markers[kind].push({ seq: typeof seq === 'number' ? seq : null, afterFloor: false });
}

function handleFrame(state, frame, setSeq) {
  let event = 'message';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (event === 'reload') {
    state.sse.reloadFrames += 1;
    return;
  }
  if (!data) return;
  try {
    const payload = JSON.parse(data);
    state.sse.dataFrames += 1;
    const seq = typeof payload.seq === 'number' ? payload.seq : null;
    if (seq !== null) {
      state.sse.seqs.push(seq);
      setSeq(seq);
    }
    const message = typeof payload.message === 'string' ? payload.message : '';
    if (message.includes('this run kept going')) addMarker(state, 'keptGoing', seq);
    if (message.includes('chain re-queued at step')) addMarker(state, 'chainRequeued', seq);
    if (message.includes('interrupted continuation re-queued')) addMarker(state, 'continuationRequeued', seq);
    if (message.includes('adopted-out agent stopped: broker')) addMarker(state, 'adoptedOut', seq);
  } catch {
    // A malformed frame is retained as an SSE observation but has no sequence assertion input.
  }
}

async function subscribe(state, deadline) {
  if (!state.config.runId) return;
  let lastSeq = 0;
  while (Date.now() < deadline) {
    if (state.sse.authFailed) return;
    const isReconnect = lastSeq !== 0;
    const url = `${state.config.runsBase}/${state.config.runId}/events`;
    try {
      const response = await fetch(url, {
        headers: {
          ...state.config.headers,
          accept: 'text/event-stream',
          ...(lastSeq ? { 'Last-Event-ID': String(lastSeq) } : {}),
        },
        redirect: 'manual',
      });
      if (isAuthFailureStatus(response.status)) {
        state.sse.authFailed = true;
        if (!state.sseAuthRequiredLogged) {
          state.sseAuthRequiredLogged = true;
          logAuthRequired(url, response.status);
        }
        return;
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!response.ok || !response.body || !contentType.startsWith('text/event-stream')) {
        throw new Error(`events answered ${response.status} (content-type: ${contentType || 'none'})`);
      }
      if (isReconnect) state.sse.reconnects += 1;
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
          handleFrame(state, frame, (seq) => {
            lastSeq = Math.max(lastSeq, seq);
          });
        }
        if (Date.now() >= deadline) {
          await reader.cancel();
          return;
        }
      }
      if (lastSeq > 0 && state.sse.reconnectSeqFloor === 0) state.sse.reconnectSeqFloor = lastSeq;
    } catch (err) {
      state.sse.errors.push({ atMs: Date.now() - state.startedMs, error: String(err?.message ?? err) });
      state.sse.errorCount += 1;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
}

/** Gaps and duplicates in the sequence observed by the SSE client. */
export function continuity(seqs) {
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

function assertion(sample, authFailed, reason, predicate) {
  if (authFailed) return { verdict: 'not-measured', sample, reason: 'auth-failed' };
  if (sample === 0) return { verdict: 'not-measured', sample, ...(reason ? { reason } : {}) };
  return { verdict: predicate() ? 'passed' : 'failed', sample };
}

function markerReport(state) {
  const hasFloor = state.sse.reconnects > 0;
  const floor = state.sse.reconnectSeqFloor;
  const report = {};
  for (const [name, markers] of Object.entries(state.sse.markers)) {
    report[name] = markers.map((marker) => ({
      ...marker,
      afterFloor: hasFloor && marker.seq !== null && marker.seq > floor,
    }));
  }
  const countNew = (name) => report[name].filter((marker) => marker.afterFloor).length;
  return {
    reconnectSeqFloor: floor,
    keptGoing: report.keptGoing,
    chainRequeued: report.chainRequeued,
    continuationRequeued: report.continuationRequeued,
    adoptedOut: report.adoptedOut,
    newKeptGoing: countNew('keptGoing'),
    newChainRequeued: countNew('chainRequeued'),
    newContinuationRequeued: countNew('continuationRequeued'),
    newAdoptedOut: countNew('adoptedOut'),
  };
}

function interruptionReport(state) {
  const current = state.run.currentInterruption ?? { runError: '', stepErrors: {} };
  const baseline = state.run.baseline ?? { sampledAt: '', runError: '', stepErrors: {} };
  return {
    baseline,
    runErrorNow: current.runError,
    stepErrorsNow: current.stepErrors,
    newInterruptionErrors: state.run.newInterruptionErrors,
    baselineWasInterrupted: isCanonicalInterruption(baseline.runError),
  };
}

function readWitness(path, runId) {
  if (!path) return { path: null, present: false, runIdMatches: false, verdict: null, reason: 'no-witness' };
  let witness;
  try {
    witness = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { path, present: false, runIdMatches: false, verdict: null, reason: 'witness-unreadable' };
  }
  const runIdMatches = witness?.runId === runId;
  return {
    path,
    present: true,
    runIdMatches,
    verdict: typeof witness?.comparison?.verdict === 'string' ? witness.comparison.verdict : null,
    ...(runIdMatches ? {} : { reason: 'witness-run-mismatch' }),
  };
}

function reattachAssertion(state, markers, interruption, witness, sseSample) {
  if (!state.config.runId) return { verdict: 'not-measured', sample: 0, reason: 'no-run-id' };
  if (state.sse.reconnects === 0) return { verdict: 'not-measured', sample: 0, reason: 'no-reconnect' };
  if (!witness.present) return { verdict: 'not-measured', sample: sseSample, reason: witness.reason };
  if (!witness.runIdMatches) return { verdict: 'not-measured', sample: sseSample, reason: witness.reason };
  if (witness.verdict === 're-launched-broker-died' || witness.verdict === 're-launched-broker-orphaned') {
    return { verdict: 'failed', sample: sseSample, reason: witness.verdict };
  }
  if (witness.verdict === 'undecidable' || witness.verdict !== 're-attached') {
    return { verdict: 'not-measured', sample: sseSample, reason: 'witness-undecidable' };
  }
  const hasRecoveryMarker =
    markers.newKeptGoing > 0 || markers.newChainRequeued > 0 || markers.newContinuationRequeued > 0;
  if (!hasRecoveryMarker && interruption.newInterruptionErrors.length === 0) {
    return { verdict: 'not-measured', sample: sseSample, reason: 'no-recovery-marker' };
  }
  if (interruption.baselineWasInterrupted) {
    return { verdict: 'not-measured', sample: sseSample, reason: 'baseline-was-interrupted' };
  }
  const passed =
    markers.newKeptGoing === 1 &&
    markers.newChainRequeued === 0 &&
    markers.newContinuationRequeued === 0 &&
    interruption.newInterruptionErrors.length === 0;
  return { verdict: passed ? 'passed' : 'failed', sample: sseSample };
}

function buildConfig() {
  const base = arg('base', 'http://127.0.0.1:4321').replace(/\/+$/, '');
  const projectId = arg('project');
  const runsBase = projectId
    ? `${base}/api/v1/p/${encodeURIComponent(projectId)}/runs`
    : `${base}/api/v1/runs`;
  return {
    base,
    projectId,
    runsBase,
    runId: arg('run'),
    seconds: Number(arg('seconds', '120')),
    out: arg('out'),
    pollHz: Number(arg('hz', '10')),
    transcript: arg('transcript'),
    freshConn: process.argv.includes('--fresh-conn'),
    availPath: arg('avail-path', '/api/v1/ready'),
    witness: arg('witness'),
    headers: parseHeaders(),
  };
}

function reportPoll(stats) {
  return {
    total: stats.total,
    ok: stats.ok,
    failed: stats.nonOk.length,
    connectErrors: stats.connectErrors.length,
    gapMs: stats.maxLatencyMs,
    maxLatencyMs: stats.maxLatencyMs,
    p50: percentile(stats.latencies, 0.5),
    p99: percentile(stats.latencies, 0.99),
    failures: stats.nonOk.slice(0, 20),
    refusals: stats.connectErrors.slice(0, 20),
  };
}

function finalVerdict(assertions) {
  const verdicts = Object.values(assertions).map((value) => value.verdict);
  return verdicts.includes('failed') ? 'failed' : verdicts.includes('not-measured') ? 'not-measured' : 'passed';
}

export async function runProbe(config = buildConfig()) {
  const startedMs = Date.now();
  const deadline = startedMs + config.seconds * 1000;
  const state = createProbeState(startedMs, config);
  const pollLoop = (async () => {
    const interval = 1000 / config.pollHz;
    let tick = 0;
    while (Date.now() < deadline) {
      const at = Date.now();
      await Promise.all([pollOnce(state, false), config.freshConn ? pollOnce(state, true) : Promise.resolve()]);
      if (tick % config.pollHz === 0) await sampleRun(state);
      tick += 1;
      const spent = Date.now() - at;
      if (spent < interval) await new Promise((resolveWait) => setTimeout(resolveWait, interval - spent));
    }
  })();

  await Promise.all([pollLoop, subscribe(state, deadline)]);
  const endedMs = Date.now();
  const { gaps, duplicates } = continuity(state.sse.seqs);
  const gapClassification = classifyGaps(gaps, config.transcript);
  const markers = markerReport(state);
  const interruption = interruptionReport(state);
  const witness = readWitness(config.witness, config.runId ?? null);
  const sseSample = state.sse.reconnects > 0 ? state.sse.seqs.length : 0;
  const noRunId = !config.runId;
  const durableLossAssertion = state.sse.authFailed
    ? { verdict: 'not-measured', sample: sseSample, reason: 'auth-failed' }
    : sseSample === 0
      ? { verdict: 'not-measured', sample: 0, ...(noRunId ? { reason: 'no-run-id' } : {}) }
      : !config.transcript
        ? { verdict: 'not-measured', sample: sseSample, reason: 'no-transcript' }
        : !gapClassification.checked
          ? { verdict: 'not-measured', sample: sseSample, reason: 'transcript-unreadable' }
          : { verdict: gapClassification.durableLoss.length === 0 ? 'passed' : 'failed', sample: sseSample };

  const assertions = {
    'b: zero failed HTTP requests': assertion(state.poll.total, false, undefined, () => state.poll.nonOk.length === 0),
    'b: zero refused connections': assertion(state.poll.total, false, undefined, () => state.poll.connectErrors.length === 0),
    'b: zero failed HTTP requests (fresh)': config.freshConn
      ? assertion(state.pollFresh.total, false, undefined, () => state.pollFresh.nonOk.length === 0)
      : { verdict: 'not-measured', sample: 0, reason: 'fresh-conn-disabled' },
    'b: zero refused connections (fresh)': config.freshConn
      ? assertion(state.pollFresh.total, false, undefined, () => state.pollFresh.connectErrors.length === 0)
      : { verdict: 'not-measured', sample: 0, reason: 'fresh-conn-disabled' },
    'c: no durable event loss': durableLossAssertion,
    'c: no seq duplicates': assertion(sseSample, state.sse.authFailed, noRunId ? 'no-run-id' : undefined, () => duplicates.length === 0),
    'a: run never left running': assertion(state.run.sampleCount, state.run.authFailed, noRunId ? 'no-run-id' : undefined, () =>
      [...state.run.statuses].every((status) => status === 'running'),
    ),
    'a: no NEW interruption error': state.run.authFailed
        ? { verdict: 'not-measured', sample: state.run.sampleCount, reason: 'auth-failed' }
        : state.run.sampleCount === 0
          ? { verdict: 'not-measured', sample: 0, ...(noRunId ? { reason: 'no-run-id' } : {}) }
        : interruption.baselineWasInterrupted
          ? { verdict: 'not-measured', sample: state.run.sampleCount, reason: 'baseline-was-interrupted' }
          : { verdict: state.run.newInterruptionErrors.length === 0 ? 'passed' : 'failed', sample: state.run.sampleCount },
    'a: run was re-attached, not re-launched': reattachAssertion(state, markers, interruption, witness, sseSample),
  };

  const verdict = finalVerdict(assertions);
  const exitCode = verdict === 'passed' ? 0 : verdict === 'failed' ? 1 : 2;
  const report = {
    base: config.base,
    runId: config.runId ?? null,
    startedAt: new Date(startedMs).toISOString(),
    endedAt: new Date(endedMs).toISOString(),
    durationMs: endedMs - startedMs,
    availPath: config.availPath,
    poll: reportPoll(state.poll),
    pollFresh: reportPoll(state.pollFresh),
    sse: {
      events: state.sse.seqs.length,
      reconnects: state.sse.reconnects,
      reloadFrames: state.sse.reloadFrames,
      dataFrames: state.sse.dataFrames,
      gaps,
      duplicates,
      errors: state.sse.errors.slice(0, 20),
      errorCount: state.sse.errorCount,
      authFailed: state.sse.authFailed,
      gapClassification,
    },
    run: {
      statuses: [...state.run.statuses],
      sawKeptGoing: markers.newKeptGoing > 0 || markers.keptGoing.some((marker) => marker.seq !== null),
      sampleCount: state.run.sampleCount,
      authFailed: state.run.authFailed,
      errorCount: state.run.errorCount,
      lastError: state.run.lastError,
      interruption,
      markers,
      witness,
    },
    assertions,
    verdict,
    passed: verdict === 'passed',
  };

  const text = JSON.stringify(report, null, 2);
  if (config.out) {
    mkdirSync(dirname(config.out), { recursive: true });
    writeFileSync(config.out, `${text}\n`);
  }
  return { report, text, exitCode };
}

async function main() {
  const result = await runProbe();
  console.log(result.text);
  for (const [name, assertionResult] of Object.entries(result.report.assertions)) {
    const label = assertionResult.verdict === 'passed' ? 'PASS' : assertionResult.verdict === 'failed' ? 'FAIL' : 'UNMEASURED';
    console.log(`${label.padEnd(10)}  ${name.padEnd(42)}  (n=${assertionResult.sample})`);
  }
  console.log(`verdict=${result.report.verdict} exit=${result.exitCode}`);
  process.exitCode = result.exitCode;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
