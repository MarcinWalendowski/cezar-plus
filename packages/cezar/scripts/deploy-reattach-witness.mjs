#!/usr/bin/env node
/**
 * Filesystem witness for the non-disruptive deploy acceptance E2E.
 *
 * The witness is independent of cezar so the process that writes the after report survives the
 * service replacement. It records broker identity, append-only spool bytes, the run's persisted
 * consumption offset, and the lifecycle message that proves recovery reached a decision.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EM_DASH = String.fromCodePoint(0x2014);

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readRun(dataDir, runId) {
  const runs = readJson(join(dataDir, 'runs.json'));
  if (!Array.isArray(runs)) throw new Error('runs.json is not an array');
  const run = runs.find((candidate) => candidate?.id === runId);
  if (!run) throw new Error(`run ${runId} was not found in runs.json`);
  return run;
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function maxPersistedSeq(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return 0;
  }
  let maxSeq = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (Number.isSafeInteger(event?.seq)) maxSeq = Math.max(maxSeq, event.seq);
    } catch {
      // A malformed line cannot contribute a checkpoint sequence.
    }
  }
  return maxSeq;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readMeta(path) {
  try {
    const meta = readJson(path);
    if (!Number.isInteger(meta?.pid) || meta.pid <= 0 || typeof meta.runId !== 'string') return null;
    return meta;
  } catch {
    return null;
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function spoolSnapshot(spoolDir, runId, expectedBytes = null) {
  const metaPath = join(spoolDir, 'meta.json');
  const outPath = join(spoolDir, 'out.ndjson');
  const exitPath = join(spoolDir, 'exit.json');
  const meta = readMeta(metaPath);
  let out = Buffer.alloc(0);
  try {
    out = readFileSync(outPath);
  } catch {
    out = Buffer.alloc(0);
  }
  const prefixLength = expectedBytes === null ? out.length : Math.min(expectedBytes, out.length);
  const prefix = out.subarray(0, prefixLength);
  return {
    dir: spoolDir,
    metaPath,
    meta: meta
      ? {
          pid: meta.pid,
          runId: meta.runId,
          stepId: typeof meta.stepId === 'string' ? meta.stepId : '',
          protocol: meta.protocol,
          startedAt: typeof meta.startedAt === 'string' ? meta.startedAt : '',
        }
      : null,
    brokerAlive: meta ? isPidAlive(meta.pid) : false,
    outBytes: out.length,
    prefixBytes: prefix.length,
    prefixSha256: sha256(prefix),
    exitFilePresent: existsSync(exitPath),
    ...(meta ? {} : { error: 'meta-unreadable' }),
  };
}

function serverInfo() {
  const info = { mainPid: 0, invocationId: '', releaseId: '', runBrokerIsolation: 'unknown' };
  try {
    const output = execFileSync(
      'systemctl',
      ['show', 'cezar.service', '-p', 'MainPID', '-p', 'InvocationID'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    for (const line of output.split('\n')) {
      const [key, ...rest] = line.split('=');
      const value = rest.join('=');
      if (key === 'MainPID') info.mainPid = numberOr(value, 0);
      if (key === 'InvocationID') info.invocationId = value;
    }
  } catch {
    // Fixture runs and non-systemd installs still get a complete report with neutral values.
  }
  try {
    info.releaseId = readlinkSync('/opt/cezar');
  } catch {
    // A checkout install has no release symlink.
  }
  return info;
}

function transcriptCheckpoint(path) {
  return { path, bytes: fileSize(path), maxSeq: maxPersistedSeq(path) };
}

function runRecordProjection(run) {
  return {
    status: typeof run?.status === 'string' ? run.status : '',
    error: typeof run?.error === 'string' ? run.error : '',
    spoolDir: typeof run?.spoolDir === 'string' ? run.spoolDir : '',
    consumedOffset: Number.isFinite(run?.consumedOffset) ? run.consumedOffset : 0,
    currentStepId: typeof run?.currentStepId === 'string' ? run.currentStepId : '',
  };
}

function emptySpool() {
  return {
    dir: '',
    metaPath: '',
    meta: null,
    brokerAlive: false,
    outBytes: 0,
    prefixBytes: 0,
    prefixSha256: sha256(Buffer.alloc(0)),
    exitFilePresent: false,
  };
}

function capture(phase, dataDir, runId, beforeBytes = null) {
  const transcriptPath = join(dataDir, 'runs', `${runId}.ndjson`);
  const report = {
    runId,
    stampedAt: new Date().toISOString(),
    phase,
    record: runRecordProjection(undefined),
    transcript: transcriptCheckpoint(transcriptPath),
    spool: emptySpool(),
    server: serverInfo(),
    errors: [],
  };
  let run;
  try {
    run = readRun(dataDir, runId);
    report.record = runRecordProjection(run);
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
    return report;
  }

  if (!report.record.spoolDir) {
    report.errors.push('run record has no spoolDir');
    return report;
  }
  if (isAbsolute(report.record.spoolDir)) {
    report.errors.push('run record spoolDir must be relative to dataDir');
    return report;
  }
  const spoolDir = join(dataDir, report.record.spoolDir);
  report.spool = spoolSnapshot(spoolDir, runId, beforeBytes);
  if (!report.spool.meta) report.errors.push('spool meta.json is missing or unreadable');
  else if (!report.spool.brokerAlive) report.errors.push('broker pid is not alive at the checkpoint');
  return report;
}

const signals = [
  { label: 'kept going', matches: (message) => message.includes('this run kept going') },
  { label: 'chain re-queued', matches: (message) => message.includes('chain re-queued at step') },
  { label: 'interrupted continuation re-queued', matches: (message) => message.includes('interrupted continuation re-queued') },
  {
    label: 'resuming the interrupted task',
    matches: (message) => message.includes(`cezar restarted ${EM_DASH} resuming the interrupted task from its last session`),
  },
  {
    label: 'could not resume the interrupted task',
    matches: (message) => message.includes(`cezar restarted ${EM_DASH} could not resume the interrupted task`),
  },
];

function signalAfterCheckpoint(text, maxSeq) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (!Number.isSafeInteger(event?.seq) || event.seq <= maxSeq || typeof event.message !== 'string') continue;
      const signal = signals.find((candidate) => candidate.matches(event.message));
      if (signal) return signal.label;
    } catch {
      // The store can be observed during a write. The next poll will read a complete line.
    }
  }
  return '';
}

async function waitForSignal(path, checkpoint, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const bytes = readFileSync(path);
      if (bytes.length < checkpoint.bytes) continue;
      const suffix = bytes.subarray(checkpoint.bytes).toString('utf8');
      const marker = signalAfterCheckpoint(suffix, checkpoint.maxSeq);
      if (marker) return { waitedMs: Date.now() - started, markerSeen: marker, timedOut: false };
    } catch {
      // Keep waiting. A missing or temporarily replaced transcript is not a positive signal.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return { waitedMs: Date.now() - started, markerSeen: '', timedOut: true };
}

function comparison(beforePath, before, after) {
  const sameRunId = before?.runId === after.runId;
  const sameSpoolDir =
    typeof before?.spool?.dir === 'string' && before.spool.dir !== '' && before.spool.dir === after.spool.dir;
  const beforePid = before?.spool?.meta?.pid;
  const afterPid = after?.spool?.meta?.pid;
  const sameBrokerPid = Number.isInteger(beforePid) && Number.isInteger(afterPid) && beforePid === afterPid;
  const brokerStartedAtUnchanged =
    typeof before?.spool?.meta?.startedAt === 'string' &&
    typeof after?.spool?.meta?.startedAt === 'string' &&
    before.spool.meta.startedAt === after.spool.meta.startedAt;
  const truncated = after.spool.outBytes < before.spool.outBytes;
  const prefixEqual =
    !truncated &&
    after.spool.prefixBytes === before.spool.outBytes &&
    after.spool.prefixSha256 === before.spool.prefixSha256;
  const offsetNonRegressing = after.record.consumedOffset >= before.record.consumedOffset;
  const brokerWasAliveBefore = before?.spool?.brokerAlive === true;
  const brokerPidStillAlive = isPidAlive(beforePid);
  const result = {
    beforeReport: beforePath,
    sameSpoolDir,
    sameBrokerPid,
    brokerStartedAtUnchanged,
    prefixEqual,
    offsetNonRegressing,
    truncated,
    brokerWasAliveBefore,
    brokerPidStillAlive,
    verdict: 'undecidable',
    reason: '',
  };

  if (!sameRunId) {
    result.reason = 'before runId does not match after runId';
    return result;
  }
  if (!sameSpoolDir) {
    result.reason = 'before spool dir does not match after spool dir';
    return result;
  }
  if (!before?.spool?.meta || !after?.spool?.meta) {
    result.reason = 'broker metadata is missing or unreadable';
    return result;
  }
  if (!truncated && prefixEqual && sameBrokerPid && after.spool.brokerAlive && offsetNonRegressing) {
    result.verdict = 're-attached';
    return result;
  }
  if (!brokerWasAliveBefore) {
    result.reason = 'broker was not alive at the before checkpoint';
    return result;
  }
  if (!brokerPidStillAlive) {
    result.verdict = 're-launched-broker-died';
    result.reason = 'the before broker pid is no longer alive';
    return result;
  }
  if (afterPid === beforePid && after.spool.brokerAlive) {
    result.verdict = 're-launched-broker-orphaned';
    result.reason = 'the before broker pid survived but the spool was rewritten';
    return result;
  }
  result.reason = 'the surviving pid is no longer named by meta.json';
  return result;
}

function writeReport(report, out) {
  const text = JSON.stringify(report, null, 2);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${text}\n`);
  console.log(text);
  return text;
}

export async function runWitness(config = {}) {
  const runId = config.runId ?? arg('run');
  const dataDir = config.dataDir ?? arg('data-dir');
  const phase = config.phase ?? arg('phase');
  const out = config.out ?? arg('out');
  const beforePath = config.before ?? arg('before');
  const settleTimeout = numberOr(config.settleTimeout ?? arg('settle-timeout', '90'), 90);
  if (!runId || !dataDir || !phase || !out || !['before', 'after'].includes(phase)) {
    throw new Error('usage requires --run, --data-dir, --phase before|after, and --out');
  }

  if (phase === 'before') {
    const report = capture(phase, dataDir, runId);
    writeReport(report, out);
    return report;
  }

  if (!beforePath) {
    const report = capture(phase, dataDir, runId);
    report.settle = { waitedMs: 0, markerSeen: '', timedOut: false };
    report.comparison = {
      beforeReport: '',
      sameSpoolDir: false,
      sameBrokerPid: false,
      brokerStartedAtUnchanged: false,
      prefixEqual: false,
      offsetNonRegressing: false,
      truncated: false,
      brokerWasAliveBefore: false,
      brokerPidStillAlive: false,
      verdict: 'undecidable',
      reason: 'after phase requires --before',
    };
    writeReport(report, out);
    return report;
  }

  let before;
  try {
    before = readJson(beforePath);
  } catch (error) {
    const report = capture(phase, dataDir, runId);
    report.settle = { waitedMs: 0, markerSeen: '', timedOut: false };
    report.comparison = {
      beforeReport: beforePath,
      sameSpoolDir: false,
      sameBrokerPid: false,
      brokerStartedAtUnchanged: false,
      prefixEqual: false,
      offsetNonRegressing: false,
      truncated: false,
      brokerWasAliveBefore: false,
      brokerPidStillAlive: false,
      verdict: 'undecidable',
      reason: `before report unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
    writeReport(report, out);
    return report;
  }

  const beforeTranscript = before?.transcript ?? { path: join(dataDir, 'runs', `${runId}.ndjson`), bytes: 0, maxSeq: 0 };
  const beforeSpoolDir = before?.spool?.dir;
  const current = capture(phase, dataDir, runId, Number.isFinite(before?.spool?.outBytes) ? before.spool.outBytes : null);
  const sameRunId = before?.runId === runId;
  const sameSpoolDir = typeof beforeSpoolDir === 'string' && beforeSpoolDir === current.spool.dir;
  current.settle = sameRunId && sameSpoolDir
    ? await waitForSignal(beforeTranscript.path, beforeTranscript, settleTimeout * 1000)
    : { waitedMs: 0, markerSeen: '', timedOut: false };
  const after = capture(phase, dataDir, runId, Number.isFinite(before?.spool?.outBytes) ? before.spool.outBytes : null);
  after.settle = current.settle;
  after.comparison = comparison(beforePath, before, after);
  if (after.settle.timedOut) {
    after.comparison.verdict = 'undecidable';
    after.comparison.reason = 'no recovery signal appeared after the before checkpoint';
  }
  writeReport(after, out);
  return after;
}

async function main() {
  try {
    await runWitness();
    return 0;
  } catch (error) {
    console.error(`[deploy-reattach-witness] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main();
