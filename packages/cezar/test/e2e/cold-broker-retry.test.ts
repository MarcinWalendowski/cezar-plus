import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * `.ai/specs/2026-08-22-bounded-transient-broker-retry.md` Verification §4/§6.
 *
 * Deliberately a `node:test` suite rather than a vitest one — `packages/cezar/vitest.config.ts`
 * excludes `test/` on purpose, and the root config's `passWithNoTests: true` would make a vitest
 * version of this file exit green having run zero assertions (see `package-cli.test.ts`'s own
 * comment). `resolveBrokerCommand()` also only resolves in a BUILT tree
 * (`dist/index.js`), so a real broker cannot be exercised under vitest/tsx at all — this is why
 * the packaged-tarball shape (`npm pack` → install → drive `dist/index.js`) is load-bearing here,
 * not ceremony borrowed from `package-cli.test.ts`.
 */

/** Waits for `predicate()` to return truthy, polling every `intervalMs`. */
async function waitFor<T>(
  predicate: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 20_000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * `<repoRoot>/.ai/cezar/runs/<runId>.spool/<instanceId>/meta.json` for the first instance
 * directory found whose name is not in `exclude` — `reapAbandonedColdLaunch` (`run.ts:344`)
 * SIGTERMs the abandoned launch's pids but does not remove its spool directory, so both the
 * abandoned and the retry's instance directories coexist under the same `<runId>.spool` once the
 * run has finished; `exclude` is what lets a caller ask for "the OTHER one."
 */
async function firstBrokerMeta(
  runsDir: string,
  exclude: ReadonlySet<string> = new Set(),
): Promise<{ spoolName: string; instanceDir: string; meta: Record<string, unknown> } | undefined> {
  const spoolNames = await readdir(runsDir).catch(() => [] as string[]);
  for (const spoolName of spoolNames) {
    if (!spoolName.endsWith('.spool')) continue;
    const instances = await readdir(join(runsDir, spoolName)).catch(() => [] as string[]);
    for (const instanceDir of instances) {
      if (exclude.has(instanceDir)) continue;
      const metaPath = join(runsDir, spoolName, instanceDir, 'meta.json');
      if (!existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>;
        return { spoolName, instanceDir, meta };
      } catch {
        // meta.json mid-write — try again on the next poll.
      }
    }
  }
  return undefined;
}

/** True once the OS reports the pid as gone. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCezarAsync(
  cliPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): { child: ReturnType<typeof spawn>; done: Promise<CliRun> } {
  const child = spawn(process.execPath, [cliPath, ...args], { cwd, env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
  const done = new Promise<CliRun>((settle) => {
    child.on('close', (code) => settle({ code, stdout, stderr }));
  });
  return { child, done };
}

async function makeFixtureRepo(root: string, name: string): Promise<string> {
  const fixtureRepo = join(root, name);
  await mkdir(fixtureRepo);
  await execFile('git', ['init', '--initial-branch=main'], { cwd: fixtureRepo });
  await writeFile(join(fixtureRepo, 'README.md'), '# E2E fixture\n', 'utf8');
  await execFile('git', ['add', 'README.md'], { cwd: fixtureRepo });
  await execFile(
    'git',
    ['-c', 'user.name=Cezar CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'test fixture'],
    { cwd: fixtureRepo },
  );
  return fixtureRepo;
}

/** `npm pack` this package and install the tarball into a scratch consumer dir, once, shared by
 *  every case below — packing and installing is the expensive part, and the built tree it produces
 *  does not depend on which fault mode a given case injects. */
async function packagedCliPath(root: string): Promise<string> {
  const packDir = join(root, 'pack');
  await mkdir(packDir);
  const packed = await execFile(
    npm,
    ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir],
    { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
  );
  const records = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  const record = records[0];
  assert.ok(record, 'npm pack should describe the generated tarball');

  const consumerDir = join(root, 'consumer');
  await mkdir(consumerDir);
  await writeFile(join(consumerDir, 'package.json'), '{"private":true}\n', 'utf8');
  const tarball = join(packDir, record.filename);
  await execFile(
    npm,
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball],
    { cwd: consumerDir, maxBuffer: 10 * 1024 * 1024 },
  );

  const packageRoot = join(consumerDir, 'node_modules', '@loki-labs', 'better-cezar');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
    bin: { cezar: string };
  };
  return join(packageRoot, manifest.bin.cezar);
}

const root = await mkdtemp(join(tmpdir(), 'cezar-broker-retry-e2e-'));
const cliPath = await packagedCliPath(root);

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

test(
  'deaf-alive: a broker that started, bound nothing, and stayed alive is retried once, and both the abandoned broker and its backend are reaped',
  { timeout: 120_000 },
  async () => {
    const caseRoot = join(root, 'case-deaf-alive');
    await mkdir(caseRoot);
    const fixtureRepo = await makeFixtureRepo(caseRoot, 'fixture-repo');
    const cezHome = join(caseRoot, 'cez-home');
    const markerPath = join(caseRoot, 'deaf-marker');
    const runsDir = join(fixtureRepo, '.ai', 'cezar', 'runs');

    const { done } = runCezarAsync(
      cliPath,
      ['run', 'mock:done', '--workflow', 'quick-task', '--repo', fixtureRepo],
      {
        ...process.env,
        CEZ_DRY_RUN: '1',
        CEZ_HOME: cezHome,
        CEZ_RUN_BROKER: '1',
        CEZ_BROKER_FAULT: `deaf-alive:${markerPath}`,
      },
      caseRoot,
    );

    // Capture the ABANDONED launch's identity — `reapAbandonedColdLaunch` SIGTERMs its pids but
    // never removes its spool directory (see `firstBrokerMeta`'s doc comment), so it is safe to
    // read this after the run finishes too; captured here mainly to know which instance to
    // exclude when looking for the retry's own directory below.
    const abandoned = await waitFor(() => firstBrokerMeta(runsDir), 30_000);
    const abandonedPid = abandoned.meta.pid as number;
    const abandonedChildPid = abandoned.meta.childPid as number | undefined;
    assert.ok(existsSync(markerPath), 'deaf-alive should have created its marker on the first launch');

    const result = await done;
    assert.match(result.stdout, /run (done|review)/, `deaf-alive: ${result.stdout}\n${result.stderr}`);

    const runs = JSON.parse(await readFile(join(fixtureRepo, '.ai', 'cezar', 'runs.json'), 'utf8')) as Array<{
      id: string;
      status: string;
    }>;
    assert.equal(runs.length, 1);
    const run = runs[0];
    assert.ok(run && ['done', 'review'].includes(run.status), 'deaf-alive: run should finish successfully');

    const events = (await readFile(join(runsDir, `${run!.id}.ndjson`), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const retryMetrics = events.filter((e) => e.name === 'run.step.retried_cold_broker');
    assert.equal(retryMetrics.length, 1, 'deaf-alive: exactly one retry metric');
    assert.ok(
      events.some((e) => e.type === 'note' && String(e.message).includes('relaunching the broker')),
      'deaf-alive: the retry note must be visible on the thread, not only in the NDJSON',
    );

    assert.ok(existsSync(join(runsDir, `${run!.id}.broker.log`)), 'deaf-alive: the launch log must exist');

    // The retry's broker is a genuinely different launch — look for an instance directory OTHER
    // than the abandoned one, since both persist on disk once the run has finished.
    const retried = await firstBrokerMeta(runsDir, new Set([abandoned.instanceDir]));
    assert.ok(retried, 'deaf-alive: the retry must have written its own instance directory');
    assert.notEqual(
      retried!.meta.instanceId,
      abandoned.meta.instanceId,
      'deaf-alive: the retry must launch a broker with a different instanceId',
    );

    // Both the abandoned broker and its backend must be gone — the reap, not a leak.
    await waitFor(() => (!pidAlive(abandonedPid) ? true : undefined), 10_000).catch(() => {
      throw new Error(`deaf-alive: abandoned broker pid ${abandonedPid} is still alive`);
    });
    if (abandonedChildPid !== undefined) {
      await waitFor(() => (!pidAlive(abandonedChildPid) ? true : undefined), 10_000).catch(() => {
        throw new Error(`deaf-alive: abandoned backend pid ${abandonedChildPid} is still alive`);
      });
    }
  },
);

/**
 * **Characterizes a gap this run's implementation step found, not the spec's original
 * expectation.** The spec assumed `deaf-once` would exercise the same give-up/retry path as
 * `deaf-alive` (Verification §4's `deaf-once` paragraph). Measured here instead: under
 * `deaf-once` the BROKER'S OWN process exits (`process.exit(0)`) immediately after writing
 * `meta.json`, and `BrokeredSession.tick()` notices the dead `meta.pid` via `isPidAlive` — see
 * `brokered-session.ts:205` — well before the ~5s give-up budget, so it fails through
 * `failBrokerVanished` (`brokered-session.ts:245`) with a plain `Error`, never through `giveUp`'s
 * `BrokerUnavailableError`. `isRetryableBrokerLaunch` only recognises the latter
 * (`brokered-session.ts:60`), so this path is NOT retried today — the run fails outright. This is
 * arguably still a "transient" failure by the spec's own definition (the broker never answered,
 * `everAnswered` is false), so whether `failBrokerVanished`'s rejection should also be retryable
 * is a real open question for a follow-up, not something this phase (verification-only, no
 * production behaviour change per its own scope) should decide. This test pins CURRENT behaviour
 * so a change to it is a deliberate decision, not a silent regression.
 */
test(
  'deaf-once: a broker whose own process exits before binding fails the run without a retry (known gap, see comment)',
  { timeout: 120_000 },
  async () => {
    const caseRoot = join(root, 'case-deaf-once');
    await mkdir(caseRoot);
    const fixtureRepo = await makeFixtureRepo(caseRoot, 'fixture-repo');
    const cezHome = join(caseRoot, 'cez-home');
    const markerPath = join(caseRoot, 'deaf-marker');
    const runsDir = join(fixtureRepo, '.ai', 'cezar', 'runs');

    const { done } = runCezarAsync(
      cliPath,
      ['run', 'mock:done', '--workflow', 'quick-task', '--repo', fixtureRepo],
      {
        ...process.env,
        CEZ_DRY_RUN: '1',
        CEZ_HOME: cezHome,
        CEZ_RUN_BROKER: '1',
        CEZ_BROKER_FAULT: `deaf-once:${markerPath}`,
      },
      caseRoot,
    );

    const abandoned = await waitFor(() => firstBrokerMeta(runsDir), 30_000);
    assert.ok(existsSync(markerPath), 'deaf-once should have created its marker on the first launch');

    const result = await done;
    assert.notEqual(result.code, 0, 'deaf-once: the run currently fails rather than retrying');

    const runs = JSON.parse(await readFile(join(fixtureRepo, '.ai', 'cezar', 'runs.json'), 'utf8')) as Array<{
      id: string;
      status: string;
      error?: string;
    }>;
    assert.equal(runs.length, 1);
    const run = runs[0];
    assert.equal(run?.status, 'failed');
    assert.match(
      run?.error ?? '',
      /died without recording an exit/,
      'deaf-once currently fails via failBrokerVanished, not the cold-broker give-up path',
    );

    const events = (await readFile(join(runsDir, `${run!.id}.ndjson`), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(
      events.filter((e) => e.name === 'run.step.retried_cold_broker').length,
      0,
      'deaf-once: no retry is spent today (the gap this test documents)',
    );

    // The backend must still not be leaked even though the retry never fired: its stdin pipe
    // closes when the broker process exits, and the mock backend exits on EOF.
    const abandonedChildPid = abandoned.meta.childPid as number | undefined;
    if (abandonedChildPid !== undefined) {
      await waitFor(() => (!pidAlive(abandonedChildPid) ? true : undefined), 10_000).catch(() => {
        throw new Error(`deaf-once: abandoned backend pid ${abandonedChildPid} is still alive`);
      });
    }
  },
);

test('a broker that was never started fails the first attempt and spends no retry', { timeout: 120_000 }, async () => {
  const caseRoot = join(root, 'case-never-start');
  await mkdir(caseRoot);
  const fixtureRepo = await makeFixtureRepo(caseRoot, 'fixture-repo');
  const cezHome = join(caseRoot, 'cez-home');
  const runsDir = join(fixtureRepo, '.ai', 'cezar', 'runs');

  const { done } = runCezarAsync(
    cliPath,
    ['run', 'mock:done', '--repo', fixtureRepo],
    {
      ...process.env,
      CEZ_DRY_RUN: '1',
      CEZ_HOME: cezHome,
      CEZ_RUN_BROKER: '1',
      CEZ_BROKER_FAULT: 'never-start',
    },
    caseRoot,
  );

  const result = await done;
  assert.notEqual(result.code, 0, 'a never-started broker must fail the run');

  const runs = JSON.parse(await readFile(join(fixtureRepo, '.ai', 'cezar', 'runs.json'), 'utf8')) as Array<{
    id: string;
    status: string;
    error?: string;
  }>;
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.equal(run?.status, 'failed');
  assert.match(run?.error ?? '', /was never started — no meta\.json was written; launcher said:.*never-start/);

  const events = (await readFile(join(runsDir, `${run!.id}.ndjson`), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(
    events.filter((e) => e.name === 'run.step.retried_cold_broker').length,
    0,
    'a permanent failure must not spend the retry budget',
  );

  const brokerLog = await readFile(join(runsDir, `${run!.id}.broker.log`), 'utf8');
  assert.match(brokerLog, /fault injection: never-start/);
});
