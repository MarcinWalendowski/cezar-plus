import { readFileSync } from 'node:fs';

/**
 * P2 of `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` — a deployer that survives the
 * restart it triggers.
 *
 * The bug this exists for, observed live on 2026-08-19: a deploy launched from inside the cockpit
 * (an agent task, or an interactive session on the box) runs as a child of `cezar.service`. That
 * unit uses the default `KillMode=control-group`, so `systemctl restart cezar.service` SIGKILLs
 * the entire cgroup — including the process performing the restart. The deploy cannot report its
 * own success because it is dead before the new instance finishes booting. The deploying session
 * was pid 1441357, inside `cezar.service`'s own cgroup.
 *
 * The fix is to leave the cgroup before touching anything: re-exec the real deploy inside a
 * transient systemd unit (`systemd-run`), which systemd places in its OWN cgroup under
 * `system.slice`. Restarting `cezar.service` then cannot reach it.
 *
 * Everything here is pure — cgroup parsing, argv construction, the recursion guard — so the
 * decision logic is testable without systemd. The caller performs the actual spawn.
 */

/** Set on the re-executed child so it never re-execs again. A `systemd-run` that re-invoked
 *  `systemd-run` would fork transient units forever, each one restarting the service. */
export const DETACHED_ENV = 'CEZ_DEPLOY_DETACHED';

/** Where a transient deploy streams its log, so a cockpit that was itself restarted mid-deploy
 *  can still read what happened. */
export function deployLogPath(releaseId: string): string {
  return `/var/log/cezar/deploy-${releaseId}.log`;
}

export function transientUnitName(releaseId: string): string {
  // systemd unit names allow a restricted character set; a release id is already
  // `<stamp>-<shortsha>`, but sanitize defensively rather than emit an invalid unit.
  const safe = releaseId.replace(/[^A-Za-z0-9:_.-]/g, '-');
  return `cezar-deploy-${safe}`;
}

/**
 * Parse `/proc/self/cgroup` and answer: am I inside this unit's cgroup?
 *
 * cgroup v2 emits a single `0::<path>` line, e.g. `0::/system.slice/cezar.service`. A child of the
 * service (an agent run, a nested shell) sits at `…/cezar.service/…` or at the same path, so the
 * test is "the unit name appears as a path SEGMENT", not a substring — `cezar.service` must not
 * match `cezar.service-other.scope`, and `.../cezar-deploy-x.service` must not match `cezar`.
 */
export function isInsideUnitCgroup(unitName: string, cgroupFileContent: string): boolean {
  for (const line of cgroupFileContent.split('\n')) {
    const path = line.split(':').slice(2).join(':');
    if (!path) continue;
    if (path.split('/').some((segment) => segment === unitName)) return true;
  }
  return false;
}

/** Read the live cgroup, degrading to "not inside" on any failure — a box without cgroup v2, a
 *  container, macOS. Being wrong in that direction costs a redundant `systemd-run`; being wrong
 *  the other way kills the deployer, which is the failure this module exists to prevent. */
export function readSelfCgroup(path = '/proc/self/cgroup'): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

export interface ReExecDecision {
  /** True when the caller must hand the deploy to `systemd-run` before proceeding. */
  reExec: boolean;
  reason: string;
}

/**
 * Decide whether this process is in danger from the restart it is about to perform.
 *
 * Three refusals, each deliberate:
 *  - already detached (`CEZ_DEPLOY_DETACHED`) — the recursion guard;
 *  - `systemd-run` unavailable — a non-systemd host (macOS, a container) has no transient units,
 *    and there the deploy is not going to `systemctl restart` anything either;
 *  - not inside the unit's cgroup — an operator running the deploy over plain ssh is already safe,
 *    and wrapping them in a transient unit would only make the output harder to follow.
 */
export function decideReExec(opts: {
  unitName: string;
  env: NodeJS.ProcessEnv;
  cgroupContent: string;
  systemdRunAvailable: boolean;
}): ReExecDecision {
  if (opts.env[DETACHED_ENV] === '1') {
    return { reExec: false, reason: 'already running detached in a transient unit' };
  }
  if (!opts.systemdRunAvailable) {
    return { reExec: false, reason: 'systemd-run is not available on this host' };
  }
  if (!isInsideUnitCgroup(opts.unitName, opts.cgroupContent)) {
    return { reExec: false, reason: `not inside ${opts.unitName}'s cgroup — the restart cannot reach this process` };
  }
  return {
    reExec: true,
    reason: `inside ${opts.unitName}'s cgroup — a restart would SIGKILL this deployer (KillMode=control-group)`,
  };
}

export interface SystemdRunOptions {
  releaseId: string;
  /** The real deploy command, already split into argv. */
  command: string[];
  /** Working directory for the transient unit. */
  cwd?: string;
  /** Extra environment the transient unit needs (credentials are NOT passed here — the unit
   *  inherits the host env that `systemd-run` gives it). */
  setEnv?: Record<string, string>;
}

/**
 * Build the `systemd-run` argv that carries the deploy out of the service cgroup.
 *
 * `--collect` reaps the transient unit once it exits, so a box does not accumulate failed
 * `cezar-deploy-*` units. `KillMode=process` means that even if something later stops THIS unit,
 * it signals only the main process rather than the tree. `Type=oneshot` with
 * `RemainAfterExit=no` keeps `systemctl` semantics honest: the unit is active exactly while the
 * deploy runs.
 */
export function buildSystemdRunArgv(opts: SystemdRunOptions): string[] {
  const argv = [
    'systemd-run',
    `--unit=${transientUnitName(opts.releaseId)}`,
    '--collect',
    '--property=Type=oneshot',
    '--property=RemainAfterExit=no',
    '--property=KillMode=process',
    `--property=StandardOutput=append:${deployLogPath(opts.releaseId)}`,
    `--property=StandardError=append:${deployLogPath(opts.releaseId)}`,
    `--setenv=${DETACHED_ENV}=1`,
  ];
  if (opts.cwd) argv.push(`--working-directory=${opts.cwd}`);
  for (const [key, value] of Object.entries(opts.setEnv ?? {})) argv.push(`--setenv=${key}=${value}`);
  argv.push('--', ...opts.command);
  return argv;
}
