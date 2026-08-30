import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const witnessPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/deploy-reattach-witness.mjs');
const RUN_ID = 'witness-run';
const EM_DASH = String.fromCodePoint(0x2014);

type Fixture = {
  root: string;
  dataDir: string;
  spoolDir: string;
  transcriptPath: string;
};

type WitnessResult = {
  code: number;
  out: Record<string, any>;
};

async function makeFixture(options: { pid?: number; transcript?: string; out?: string } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'deploy-reattach-witness-test-'));
  const dataDir = join(root, 'data');
  const spoolDir = join(dataDir, 'runs', `${RUN_ID}.spool`, 'instance-1');
  const transcriptPath = join(dataDir, 'runs', `${RUN_ID}.ndjson`);
  await mkdir(spoolDir, { recursive: true });
  await writeFile(
    join(dataDir, 'runs.json'),
    JSON.stringify([
      {
        id: RUN_ID,
        status: 'running',
        error: '',
        currentStepId: 'step-a',
        consumedOffset: 10,
        spoolDir: `runs/${RUN_ID}.spool/instance-1`,
      },
    ]),
  );
  await writeFile(transcriptPath, options.transcript ?? `${JSON.stringify({ seq: 1, message: 'before' })}\n`);
  await writeFile(
    join(spoolDir, 'meta.json'),
    JSON.stringify({
      schema: 1,
      protocol: 2,
      runId: RUN_ID,
      stepId: 'step-a',
      backend: 'claude',
      pid: options.pid ?? process.pid,
      startedAt: '2026-08-30T00:00:00.000Z',
    }),
  );
  await writeFile(join(spoolDir, 'out.ndjson'), options.out ?? 'before spool\n');
  return { root, dataDir, spoolDir, transcriptPath };
}

async function runWitness(args: string[], out: string): Promise<WitnessResult> {
  let code = 0;
  try {
    await execFile(process.execPath, [witnessPath, ...args, '--out', out], { maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    const childError = error as { code?: number };
    code = typeof childError.code === 'number' ? childError.code : 1;
  }
  return { code, out: JSON.parse(await readFile(out, 'utf8')) };
}

async function beforeReport(fixture: Fixture): Promise<{ path: string; out: Record<string, any> }> {
  const path = join(fixture.root, 'witness-before.json');
  const result = await runWitness(
    ['--run', RUN_ID, '--data-dir', fixture.dataDir, '--phase', 'before'],
    path,
  );
  assert.equal(result.code, 0);
  return { path, out: result.out };
}

async function updateRun(fixture: Fixture, patch: Record<string, unknown>): Promise<void> {
  const path = join(fixture.dataDir, 'runs.json');
  const runs = JSON.parse(await readFile(path, 'utf8')) as Array<Record<string, unknown>>;
  runs[0] = { ...runs[0], ...patch };
  await writeFile(path, JSON.stringify(runs));
}

async function appendSignal(fixture: Fixture, seq: number, message: string): Promise<void> {
  await appendFile(fixture.transcriptPath, `${JSON.stringify({ seq, type: 'lifecycle', message })}\n`);
}

async function runAfterDuringAppend(
  fixture: Fixture,
  before: string,
  message: string,
  timeout = '0.6',
): Promise<WitnessResult> {
  const out = join(fixture.root, 'witness-after.json');
  const child = spawn(
    process.execPath,
    [
      witnessPath,
      '--run', RUN_ID,
      '--data-dir', fixture.dataDir,
      '--phase', 'after',
      '--before', before,
      '--settle-timeout', timeout,
      '--out', out,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const codePromise = new Promise<number>((resolveCode, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolveCode(code ?? 1));
  });
  setTimeout(() => {
    void appendSignal(fixture, 2, message);
  }, 120);
  const code = await codePromise;
  return { code, out: JSON.parse(await readFile(out, 'utf8')) };
}

async function withFixture<T>(fn: (fixture: Fixture) => Promise<T>, options: { pid?: number; transcript?: string; out?: string } = {}): Promise<T> {
  const fixture = await makeFixture(options);
  try {
    return await fn(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

test('before and after reports distinguish an appended spool from a rewrite', { timeout: 20_000 }, async () => {
  await withFixture(async (fixture) => {
    const before = await beforeReport(fixture);
    await appendFile(fixture.spoolDir + '/out.ndjson', 'after spool\n');
    await updateRun(fixture, { consumedOffset: 20 });
    await appendSignal(fixture, 2, 'cezar restarted this run kept going');
    const after = await runWitness(
      [
        '--run', RUN_ID,
        '--data-dir', fixture.dataDir,
        '--phase', 'after',
        '--before', before.path,
        '--settle-timeout', '0.5',
      ],
      join(fixture.root, 'witness-after.json'),
    );

    assert.equal(after.code, 0);
    assert.equal(after.out.settle.markerSeen, 'kept going');
    assert.equal(after.out.settle.timedOut, false);
    assert.equal(after.out.comparison.prefixEqual, true);
    assert.equal(after.out.comparison.sameBrokerPid, true);
    assert.equal(after.out.comparison.offsetNonRegressing, true);
    assert.equal(after.out.comparison.truncated, false);
    assert.equal(after.out.comparison.verdict, 're-attached');
  });
});

test('a rewritten spool is classified as broker died or broker orphaned from liveness alone', { timeout: 20_000 }, async () => {
  await withFixture(async (fixture) => {
    const before = await beforeReport(fixture);
    const editedBefore = { ...before.out, spool: { ...before.out.spool, brokerAlive: true, meta: { ...before.out.spool.meta, pid: 999999 } } };
    await writeFile(before.path, JSON.stringify(editedBefore));
    await writeFile(fixture.spoolDir + '/out.ndjson', 'rewritten spool\n');
    await writeFile(
      fixture.spoolDir + '/meta.json',
      JSON.stringify({ schema: 1, protocol: 2, runId: RUN_ID, stepId: 'step-a', backend: 'claude', pid: 999999, startedAt: '2026-08-30T00:00:00.000Z' }),
    );
    await appendSignal(fixture, 2, 'chain re-queued at step "implement"');
    const died = await runWitness(
      ['--run', RUN_ID, '--data-dir', fixture.dataDir, '--phase', 'after', '--before', before.path, '--settle-timeout', '0.2'],
      join(fixture.root, 'died.json'),
    );
    assert.equal(died.out.comparison.verdict, 're-launched-broker-died');

    const orphanFixture = await makeFixture();
    try {
      const orphanBefore = await beforeReport(orphanFixture);
      await writeFile(orphanFixture.spoolDir + '/out.ndjson', 'rewritten spool\n');
      await appendSignal(orphanFixture, 2, 'chain re-queued at step "implement"');
      const orphan = await runWitness(
        ['--run', RUN_ID, '--data-dir', orphanFixture.dataDir, '--phase', 'after', '--before', orphanBefore.path, '--settle-timeout', '0.2'],
        join(orphanFixture.root, 'orphan.json'),
      );
      assert.equal(orphan.out.comparison.verdict, 're-launched-broker-orphaned');
    } finally {
      await rm(orphanFixture.root, { recursive: true, force: true });
    }
  });
});

test('a shorter spool is reported as a truncated re-launch instead of throwing', { timeout: 20_000 }, async () => {
  await withFixture(async (fixture) => {
    const before = await beforeReport(fixture);
    const editedBefore = { ...before.out, spool: { ...before.out.spool, brokerAlive: true, meta: { ...before.out.spool.meta, pid: 999999 } } };
    await writeFile(before.path, JSON.stringify(editedBefore));
    await writeFile(fixture.spoolDir + '/out.ndjson', 'x');
    await appendSignal(fixture, 2, 'chain re-queued at step "implement"');
    const after = await runWitness(
      ['--run', RUN_ID, '--data-dir', fixture.dataDir, '--phase', 'after', '--before', before.path, '--settle-timeout', '0.2'],
      join(fixture.root, 'after.json'),
    );

    assert.equal(after.out.comparison.truncated, true);
    assert.equal(after.out.comparison.verdict, 're-launched-broker-died');
  });
});

test('mismatched or absent before reports are undecidable', { timeout: 20_000 }, async () => {
  await withFixture(async (fixture) => {
    const before = await beforeReport(fixture);
    const mismatch = { ...before.out, runId: 'other-run' };
    const mismatchPath = join(fixture.root, 'mismatch.json');
    await writeFile(mismatchPath, JSON.stringify(mismatch));
    const mismatchResult = await runWitness(
      ['--run', RUN_ID, '--data-dir', fixture.dataDir, '--phase', 'after', '--before', mismatchPath, '--settle-timeout', '0.2'],
      join(fixture.root, 'mismatch-after.json'),
    );
    assert.equal(mismatchResult.out.comparison.verdict, 'undecidable');
    assert.match(mismatchResult.out.comparison.reason, /runId/);

    const noBefore = await runWitness(
      ['--run', RUN_ID, '--data-dir', fixture.dataDir, '--phase', 'after'],
      join(fixture.root, 'no-before.json'),
    );
    assert.equal(noBefore.out.comparison.verdict, 'undecidable');
    assert.equal(noBefore.out.comparison.reason, 'after phase requires --before');
  });
});

test('after settle waits symmetrically for every lifecycle outcome and ignores record.error', { timeout: 40_000 }, async () => {
  const messages = [
    'cezar restarted this run kept going',
    'chain re-queued at step "implement"',
    `interrupted continuation re-queued ${EM_DASH} waiting`,
    `cezar restarted ${EM_DASH} resuming the interrupted task from its last session`,
    `cezar restarted ${EM_DASH} could not resume the interrupted task (missing session)`,
  ];
  const waited: number[] = [];
  for (const message of messages) {
    const result = await withFixture(async (fixture) => {
      const before = await beforeReport(fixture);
      return runAfterDuringAppend(fixture, before.path, message);
    });
    assert.equal(result.out.settle.timedOut, false);
    assert.notEqual(result.out.settle.markerSeen, '');
    waited.push(result.out.settle.waitedMs);
  }
  assert.ok(Math.max(...waited) - Math.min(...waited) < 250, JSON.stringify(waited));

  await withFixture(async (fixture) => {
    await updateRun(fixture, { error: `interrupted ${EM_DASH} cezar process exited during the run` });
    const before = await beforeReport(fixture);
    const result = await runAfterDuringAppend(fixture, before.path, '', '0.25');
    assert.equal(result.out.settle.markerSeen, '');
    assert.equal(result.out.settle.timedOut, true);
    assert.equal(result.out.comparison.verdict, 'undecidable');
  });
});

test('settle starts after the before transcript checkpoint and never reads historical markers', { timeout: 20_000 }, async () => {
  const historical = `${JSON.stringify({ seq: 1, message: 'this run kept going' })}\n`;
  await withFixture(async (fixture) => {
    const before = await beforeReport(fixture);
    const result = await runAfterDuringAppend(fixture, before.path, 'chain re-queued at step "implement"');
    assert.equal(result.out.settle.markerSeen, 'chain re-queued');
    assert.equal(result.out.settle.timedOut, false);
    assert.ok(result.out.settle.waitedMs >= 80);
  }, { transcript: historical });

  await withFixture(async (fixture) => {
    const before = await beforeReport(fixture);
    const result = await runWitness(
      ['--run', RUN_ID, '--data-dir', fixture.dataDir, '--phase', 'after', '--before', before.path, '--settle-timeout', '0.2'],
      join(fixture.root, 'timeout.json'),
    );
    assert.equal(result.out.settle.timedOut, true);
    assert.equal(result.out.settle.markerSeen, '');
    assert.equal(result.out.comparison.verdict, 'undecidable');
  }, { transcript: historical });
});

test('missing spool data, corrupt metadata, and a dead broker produce recorded reasons', { timeout: 20_000 }, async () => {
  await withFixture(async (fixture) => {
    const runsPath = join(fixture.dataDir, 'runs.json');
    await writeFile(runsPath, JSON.stringify([{ id: RUN_ID, status: 'running', steps: [] }]));
    const missing = await runWitness(
      ['--run', RUN_ID, '--data-dir', fixture.dataDir, '--phase', 'before'],
      join(fixture.root, 'missing.json'),
    );
    assert.ok(missing.out.errors.includes('run record has no spoolDir'));
  });

  await withFixture(async (fixture) => {
    await writeFile(fixture.spoolDir + '/meta.json', '{not json');
    const corrupt = await runWitness(
      ['--run', RUN_ID, '--data-dir', fixture.dataDir, '--phase', 'before'],
      join(fixture.root, 'corrupt.json'),
    );
    assert.ok(corrupt.out.errors.includes('spool meta.json is missing or unreadable'));
    assert.equal(corrupt.out.spool.brokerAlive, false);
  });

  await withFixture(async (fixture) => {
    await writeFile(
      fixture.spoolDir + '/meta.json',
      JSON.stringify({ schema: 1, protocol: 2, runId: RUN_ID, stepId: 'step-a', backend: 'claude', pid: 999999, startedAt: '2026-08-30T00:00:00.000Z' }),
    );
    const dead = await runWitness(
      ['--run', RUN_ID, '--data-dir', fixture.dataDir, '--phase', 'before'],
      join(fixture.root, 'dead.json'),
    );
    assert.ok(dead.out.errors.includes('broker pid is not alive at the checkpoint'));
    assert.equal(dead.out.spool.brokerAlive, false);
  });
});
