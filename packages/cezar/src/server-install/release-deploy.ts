import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DETACHED_ENV,
  buildSystemdRunArgv,
  decideReExec,
  deployLogPath,
  readKillMode,
  readSelfCgroup,
  userBusEnv,
} from './self-safe-deploy.ts';
import {
  currentTarget,
  isMigrated,
  loadLedger,
  makeReleaseId,
  releaseDir,
  type ReleaseEntry,
} from './releases.ts';
import {
  runGatedDeploy,
  runRollback,
  type DeployEffects,
  type DeployEvent,
  type DeployStrategy,
  type DeployOutcome,
  type ProbeResult,
} from './deploy-strategy.ts';

/**
 * `cezar server-deploy --strategy=blue-green` / `--rollback`: the concrete, privileged half of
 * P1/P2/P5 in `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`.
 *
 * Everything about the ORDER of a health-gated deploy already lives in `deploy-strategy.ts` as
 * pure transitions over injected effects, and everything about escaping the service cgroup lives
 * in `self-safe-deploy.ts` as pure decisions. This module is what those two need to actually
 * happen on a box: an rsync, a smoke boot, a `systemctl restart`, an HTTP probe. It is kept
 * separate precisely so the interesting logic stays testable without any of them.
 *
 * The default deploy path is untouched. `--strategy=restart` still goes through the install
 * engine's `runDeploy`, which is what every existing platform expects, and remains the default
 * exactly as the spec says it should until P3 and P4 are live on a given box.
 */

/** Default install root — the stable symlink every other path on the box points through. */
export const DEFAULT_LINK_PATH = '/opt/cezar';
/** Default release store, a sibling of the link so a flip is a rename within one filesystem. */
export const DEFAULT_RELEASES_DIR = '/opt/cezar-releases';
/** Refuse to stage a release when free space is below this. A release is ~500 MB. */
export const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

export interface ReleaseDeployOptions {
  /** Built tree to publish. Defaults to the repo the command runs in. */
  source: string;
  linkPath?: string;
  releasesDir?: string;
  unitName?: string;
  /** Loopback port the readiness probe hits. */
  port?: number;
  strategy?: DeployStrategy;
  /** Roll back instead of deploying; an empty string means "the previous release". */
  rollbackTo?: string | null;
  /** Tail the transient unit's log rather than returning as soon as it is launched. */
  follow?: boolean;
  sha?: string;
  version?: string;
  note?: string;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export interface ReleaseDeployResult {
  ok: boolean;
  /** Set when the deploy handed itself to a transient unit and this process is only the launcher. */
  detachedUnit?: string;
  outcome?: DeployOutcome;
  error?: string;
}

/** Shell out, capturing failure rather than throwing — every caller here wants to decide. */
function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): { ok: boolean; out: string } {
  const result = spawnSync(cmd, args, { encoding: 'utf8', cwd: opts.cwd, env: opts.env });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, out };
}

function commandExists(cmd: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0;
}

/** Free bytes on the filesystem holding `path`, or `Infinity` when it cannot be determined —
 *  refusing to deploy because `df` was unparseable would be a worse failure than deploying. */
export function freeBytes(path: string, exec = execFileSync): number {
  try {
    const out = String(exec('df', ['-kP', path], { encoding: 'utf8' }));
    const line = out.trim().split('\n')[1];
    const available = line?.trim().split(/\s+/)[3];
    const kb = Number(available);
    return Number.isFinite(kb) ? kb * 1024 : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Everything a release deploy needs from the outside world, in one injectable bundle.
 *
 * The default implementation is the real box; tests pass their own. This is the seam that keeps
 * `runReleaseDeploy` — which decides whether to detach, what the release id is, and how failure is
 * reported — testable without root.
 */
export interface ReleaseDeployHost {
  stage(source: string, target: string): Promise<void>;
  smokeBoot(dir: string): Promise<ProbeResult>;
  restart(unit: string): Promise<void>;
  probeReady(port: number): Promise<ProbeResult>;
  waitReady(port: number, timeoutMs: number): Promise<ProbeResult>;
  freeBytes(path: string): number;
  now(): string;
  spawnDetached(argv: string[], env: NodeJS.ProcessEnv): void;
  systemdRunAvailable(): boolean;
  cgroup(): string;
  /** The unit's effective KillMode, read not assumed. */
  killMode(unit: string): string | undefined;
}

export function defaultHost(log: (line: string) => void): ReleaseDeployHost {
  return {
    async stage(source, target) {
      mkdirSync(target, { recursive: true });
      // `--delete` so a release directory reused after a failed attempt cannot keep a stale file in
      // the shipped tree — note this does NOT delete *excluded* paths (that needs the separate
      // `--delete-excluded` flag, not added here), so a reused target can still carry whatever it
      // already had under the four excludes below. Harmless: nothing in a running release reads any
      // of them (see Risks), and Phase 4 covers reclaiming space already on disk, which a re-stage
      // cannot do.
      // A release is an artifact, not a checkout: git metadata (`.git`) is excluded, and so is every
      // directory that is cezar's own AGENT RUNTIME STATE rather than the tree being shipped —
      // `.ai/cezar/runs` (per-run history), `.ai/cezar/worktrees` (live task git worktrees, each with
      // its own node_modules — measured 2026-08-21/22 at up to several GB) and `.ai/cezar/tmp`
      // (per-run scratch dirs, recreated on demand at runtime by `agentTmpDir`). All three are also
      // being concurrently written to by whatever other tasks are running on the box at stage time, so
      // excluding them removes that race along with the size.
      const rsync = run('rsync', [
        '-a',
        '--delete',
        '--exclude',
        '.git',
        '--exclude',
        '.ai/cezar/runs',
        '--exclude',
        '.ai/cezar/worktrees',
        '--exclude',
        '.ai/cezar/tmp',
        `${source.replace(/\/*$/, '')}/`,
        `${target.replace(/\/*$/, '')}/`,
      ]);
      if (!rsync.ok) throw new Error(`staging failed: ${rsync.out}`);
      // The flip is a rename over a symlink, which is atomic, but the CONTENT has to be on disk
      // before it: a crash between rsync and flip must not leave a release that is `current` and
      // half-written.
      run('sync', []);
    },
    async smokeBoot(dir) {
      return smokeBootRelease(dir, log);
    },
    async restart(unit) {
      const result = run('systemctl', ['restart', unit]);
      if (!result.ok) throw new Error(`restart failed: ${result.out}`);
    },
    async probeReady(port) {
      return probeReady(port);
    },
    async waitReady(port, timeoutMs) {
      return waitForReady(port, timeoutMs);
    },
    freeBytes,
    now: () => new Date().toISOString(),
    spawnDetached(argv, env) {
      const [bin, ...rest] = argv;
      const child = spawn(bin as string, rest, { detached: true, stdio: 'ignore', env });
      child.unref();
    },
    systemdRunAvailable: () => commandExists('systemd-run'),
    cgroup: () => readSelfCgroup(),
    killMode: (unit: string) => readKillMode(unit),
  };
}

/**
 * Boot a candidate release in isolation and ask whether it is alive.
 *
 * **The throwaway `CEZ_HOME` and project dir are mandatory, not hygiene.** There is no
 * single-writer lock on `.ai/cezar/`, and `RunStore` is an in-memory map flushed wholesale, so a
 * second process pointed at the real state directory would not race at the margins — it would
 * overwrite everything the live cockpit had written since it started. That is the failure this
 * whole isolation exists to prevent, and it is why the scratch port is also deliberately not the
 * live one.
 */
export async function smokeBootRelease(dir: string, log: (line: string) => void): Promise<ProbeResult> {
  const entry = join(dir, 'packages', 'cezar', 'dist', 'index.js');
  if (!existsSync(entry)) return { ok: false, detail: `candidate has no ${entry}` };
  const home = mkdtempSync(join(tmpdir(), 'cez-smoke-home-'));
  const project = mkdtempSync(join(tmpdir(), 'cez-smoke-project-'));
  // A scratch port, deliberately far from the live one. `hrtime` rather than `Math.random` so a
  // deploy running under a seeded-random test harness still spreads across ports.
  const port = 34_000 + Number(process.hrtime.bigint() % 900n);
  const child = spawn(process.execPath, [entry, 'serve', '--no-open', '--bind-host', '127.0.0.1', '--port', String(port)], {
    cwd: project,
    env: {
      ...process.env,
      CEZ_HOME: home,
      HOME: home,
      // Never inherit socket activation into the candidate: it would try to adopt the LIVE
      // listening descriptor, which is the one thing a smoke boot must not touch.
      LISTEN_FDS: '',
      LISTEN_PID: '',
      CEZ_SINGLE_PROJECT: '1',
      // Neutralize the auth boot gate for the candidate.
      //
      // MEASURED 2026-08-21: without this, a smoke boot on a HOSTED box inherits `CEZ_REMOTE=1`
      // from the service environment but not the auth provider that makes hosted mode legal, so
      // `runAuthBootGate` refuses to boot — "hosted mode with no authentication exposes shell
      // execution to anyone who can reach this port". The candidate never answers, the smoke gate
      // reports failure, and `--strategy=blue-green` becomes permanently unusable on exactly the
      // kind of deployment it was written for. The build was fine every time.
      //
      // Turning the gate off here is safe, and narrowly so: the candidate binds a RANDOM high port
      // on 127.0.0.1 only, serves nothing but its own readiness probe, shares no state (throwaway
      // CEZ_HOME and project dir), and is SIGKILLed a few seconds later in the `finally` below. It
      // is never routed to and never outlives the check. What the smoke boot asks is "does this
      // build come up?" — auth configuration is not what it is testing, and inheriting half of it
      // only makes the answer wrong.
      CEZ_REMOTE: '',
      CEZ_AUTH: '',
      CEZ_ALLOW_UNAUTHENTICATED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (c: Buffer) => {
    stderr += c.toString();
  });
  try {
    const ready = await waitForReady(port, 30_000);
    if (!ready.ok) {
      log(`smoke boot failed: ${ready.detail ?? 'no readiness'}${stderr ? ` — ${stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`);
      return { ok: false, detail: ready.detail ?? (stderr.trim().slice(-500) || 'candidate never became ready') };
    }
    return { ok: true };
  } finally {
    child.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
}

/** One readiness request against a loopback port. */
export async function probeReady(port: number, path = '/api/v1/ready'): Promise<ProbeResult> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { ok: false, detail: `${path} answered ${response.status}` };
    const body = (await response.json()) as { ready?: boolean; checks?: Array<{ name: string; ok: boolean; detail?: string }> };
    if (body.ready === false) {
      const failed = (body.checks ?? []).filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail ?? 'not ok'}`);
      return { ok: false, detail: failed.join('; ') || 'not ready' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function waitForReady(port: number, timeoutMs: number): Promise<ProbeResult> {
  const deadline = Date.now() + timeoutMs;
  let last: ProbeResult = { ok: false, detail: 'never probed' };
  while (Date.now() < deadline) {
    last = await probeReady(port);
    if (last.ok) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return last;
}

/**
 * Run a release deploy or a rollback, escaping the service cgroup first when it is needed.
 *
 * The re-exec is decided BEFORE anything is staged or flipped, which is the whole point: once the
 * deploy has started changing the box, dying part-way through is exactly the failure P2 exists to
 * prevent. A launcher that has handed off returns immediately with `detachedUnit` set — it is no
 * longer the deploy, and pretending otherwise would make it report a success it cannot observe.
 */
export async function runReleaseDeploy(
  options: ReleaseDeployOptions,
  host?: ReleaseDeployHost,
): Promise<ReleaseDeployResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const fx = host ?? defaultHost(log);
  const env = options.env ?? process.env;
  const linkPath = options.linkPath ?? DEFAULT_LINK_PATH;
  const releasesDir = options.releasesDir ?? DEFAULT_RELEASES_DIR;
  const unitName = options.unitName ?? 'cezar.service';
  const port = options.port ?? 4321;
  const strategy: DeployStrategy = options.strategy ?? 'blue-green';
  const rollback = options.rollbackTo !== undefined && options.rollbackTo !== null;

  const releaseId = rollback
    ? (options.rollbackTo || 'rollback')
    : makeReleaseId(fx.now(), options.sha);

  // ---- P2: get out of the cgroup we are about to restart ---------------------------------------
  const decision = decideReExec({
    unitName,
    env,
    cgroupContent: fx.cgroup(),
    systemdRunAvailable: fx.systemdRunAvailable(),
    // READ the unit's kill mode rather than assume it. On a migrated box this is `process`, and
    // the escape is then unnecessary — which is what lets a deploy driven from inside an agent
    // task work without any privilege it was refused.
    killMode: fx.killMode(unitName),
  });
  log(`deploy: ${decision.reason}`);
  if (decision.reExec) {
    if (options.dryRun) return { ok: true, detachedUnit: `dry-run:${releaseId}` };
    // A SYSTEM transient unit runs as root by default, so an unprivileged service account is
    // refused it — and granting that right would be a root-equivalent grant under a narrow name.
    // As a non-root uid, ask the USER manager instead: same cgroup escape, no grant needed.
    const asUser = (process.getuid?.() ?? 0) !== 0;
    const argv = buildSystemdRunArgv({
      releaseId,
      command: reExecCommand(options, releaseId),
      cwd: options.source,
      user: asUser,
    });
    try {
      mkdirSync('/var/log/cezar', { recursive: true });
    } catch {
      // Best-effort. A deployer without permission to make the log directory still gets to
      // deploy; systemd will say so about the append: target, and refusing here would fail the
      // whole cutover over a log file.
    }
    // A `--user` systemd-run needs the bus coordinates a service context does not have
    // (XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS are unset inside the unit, though set over ssh —
    // which is exactly why this gap was invisible until a deploy ran from inside a task).
    fx.spawnDetached(argv, { ...env, ...(asUser ? userBusEnv() : {}), [DETACHED_ENV]: '1' });
    log(`deploy: handed off to a transient unit — follow it at ${deployLogPath(releaseId)}`);
    return { ok: true, detachedUnit: releaseId };
  }

  // ---- P1: the install path must already be a symlink ------------------------------------------
  if (!options.dryRun && existsSync(linkPath) && !isMigrated(linkPath)) {
    return {
      ok: false,
      error:
        `${linkPath} is a directory, not a release symlink — run \`cezar server-migrate-releases\` first. ` +
        'Flipping would otherwise have to delete a live install to make room for the link.',
    };
  }

  const emit = (event: DeployEvent): void => {
    log(`[${event.name}] ${JSON.stringify({ ...event, name: undefined })}`);
  };

  if (rollback) {
    const outcome = await runRollback(
      { releasesDir, linkPath, ...(options.rollbackTo ? { to: options.rollbackTo } : {}) },
      { restart: () => fx.restart(unitName), probeReady: () => fx.waitReady(port, 30_000), emit, now: fx.now },
    );
    return { ok: outcome.ok, outcome, ...(outcome.ok ? {} : { error: outcome.detail }) };
  }

  const free = fx.freeBytes(releasesDir);
  if (free < MIN_FREE_BYTES) {
    return {
      ok: false,
      error: `only ${Math.round(free / 1e9)} GB free under ${releasesDir} — refusing to stage a release`,
    };
  }

  const entry: ReleaseEntry = {
    id: releaseId,
    ...(options.sha ? { sha: options.sha } : {}),
    ...(options.version ? { version: options.version } : {}),
    builtAt: fx.now(),
    ...(options.note ? { note: options.note } : {}),
  };

  const effects: DeployEffects = {
    stage: (dir) => fx.stage(options.source, dir),
    smokeBoot: (dir) => fx.smokeBoot(dir),
    restart: () => fx.restart(unitName),
    probeReady: () => fx.probeReady(port),
    emit,
    now: fx.now,
  };

  if (options.dryRun) {
    log(`DRY RUN — would stage ${options.source} → ${releaseDir(releasesDir, releaseId)}, smoke-boot it, flip ${linkPath}, restart ${unitName}, probe :${port}/api/v1/ready.`);
    return { ok: true };
  }

  const outcome = await runGatedDeploy({ releasesDir, linkPath, entry, strategy }, effects);
  return { ok: outcome.ok, outcome, ...(outcome.ok ? {} : { error: outcome.detail ?? outcome.failedAt }) };
}

/**
 * The argv the transient unit runs — this same command, with `--strategy` pinned and the release
 * id fixed so both halves agree on which release this is.
 *
 * `process.argv` is rebuilt rather than reused verbatim: the launcher may have been invoked
 * through any of the three `/usr/local/bin` wrappers, and re-running the wrapper from inside a
 * transient unit would resolve `/opt/cezar` again — possibly to the release the deploy is about to
 * replace.
 */
function reExecCommand(options: ReleaseDeployOptions, releaseId: string): string[] {
  const argv = [process.execPath, process.argv[1] as string, 'server-deploy', `--strategy=${options.strategy ?? 'blue-green'}`];
  if (options.rollbackTo !== undefined && options.rollbackTo !== null) {
    argv.push(options.rollbackTo ? `--rollback=${options.rollbackTo}` : '--rollback');
  }
  if (options.source) argv.push(`--source=${options.source}`);
  if (options.linkPath) argv.push(`--link-path=${options.linkPath}`);
  if (options.releasesDir) argv.push(`--releases-dir=${options.releasesDir}`);
  if (options.sha) argv.push(`--sha=${options.sha}`);
  if (options.note) argv.push(`--note=${options.note}`);
  argv.push(`--release-id=${releaseId}`);
  return argv;
}

/**
 * Describe what a release deploy would act on, for the CLI to print before it does anything.
 *
 * Read-only by construction — an operator asking "what is live?" must never be the thing that
 * changes what is live.
 */
export function describeReleases(releasesDir = DEFAULT_RELEASES_DIR, linkPath = DEFAULT_LINK_PATH): string[] {
  const lines: string[] = [];
  const target = currentTarget(linkPath);
  lines.push(`link:     ${linkPath}${target ? ` → ${target}` : ' (not a symlink — not migrated)'}`);
  let ledger;
  try {
    ledger = loadLedger(releasesDir);
  } catch (err) {
    lines.push(`ledger:   unreadable (${err instanceof Error ? err.message : String(err)})`);
    return lines;
  }
  lines.push(`current:  ${ledger.current ?? '(none)'}`);
  lines.push(`previous: ${ledger.previous ?? '(none)'}`);
  for (const entry of ledger.releases) {
    const marks = [entry.id === ledger.current ? 'current' : '', entry.healthy === false ? 'unhealthy' : ''].filter(Boolean);
    lines.push(`  ${entry.id}${entry.version ? ` v${entry.version}` : ''}${marks.length ? `  [${marks.join(', ')}]` : ''}`);
  }
  return lines;
}

/** Size of a release tree, for the CLI's disk report. Best-effort; a missing dir is 0. */
export function releaseSize(dir: string): number {
  try {
    return statSync(dir).size;
  } catch {
    return 0;
  }
}

/** Read the deploy log for `--follow`, returning what exists so far. */
export function readDeployLog(releaseId: string): string {
  try {
    return readFileSync(deployLogPath(releaseId), 'utf8');
  } catch {
    return '';
  }
}
