import { execFileSync } from 'node:child_process';
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
  /**
   * The unit's EFFECTIVE `KillMode`, read with `systemctl show <unit> -p KillMode` — never
   * assumed. Absent means "could not read it", which is treated as the dangerous value.
   */
  killMode?: string;
}): ReExecDecision {
  if (opts.env[DETACHED_ENV] === '1') {
    return { reExec: false, reason: 'already running detached in a transient unit' };
  }
  if (!isInsideUnitCgroup(opts.unitName, opts.cgroupContent)) {
    return { reExec: false, reason: `not inside ${opts.unitName}'s cgroup — the restart cannot reach this process` };
  }
  // The cheapest correct answer, and the one that needs no privilege at all: if the unit already
  // stops with `KillMode=process`, a restart signals ONLY the main process. This deployer is a
  // child, so it is not signalled, so there is nothing to escape from. Checked before
  // `systemdRunAvailable` deliberately — on a box that has been migrated this returns false and
  // the transient unit is never attempted, which is why an agent-driven deploy stops needing a
  // privilege it was refused.
  if (opts.killMode === 'process') {
    return {
      reExec: false,
      reason: `${opts.unitName} stops with KillMode=process — a restart signals only its main process, not this deployer`,
    };
  }
  if (!opts.systemdRunAvailable) {
    return { reExec: false, reason: 'systemd-run is not available on this host' };
  }
  return {
    reExec: true,
    // CORRECTED 2026-08-21: this used to assert `KillMode=control-group` unconditionally, which
    // became a lie the moment the box was migrated. Report what was actually read.
    reason:
      `inside ${opts.unitName}'s cgroup with KillMode=${opts.killMode ?? 'unknown'} — ` +
      `a restart would kill this deployer along with the cgroup`,
  };
}

/**
 * Read a unit's effective `KillMode`. Read-only, so it needs no privilege even for a system unit.
 * Returns undefined when it cannot be determined — callers must treat that as the dangerous value
 * rather than optimistically skipping the escape.
 */
export function readKillMode(
  unitName: string,
  run: (cmd: string, args: string[]) => string = (cmd, args) =>
    execFileSync(cmd, args, { encoding: 'utf8' }),
): string | undefined {
  try {
    const out = run('systemctl', ['show', unitName, '-p', 'KillMode', '--value']).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
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
  /**
   * Ask the USER manager for the transient unit instead of the system one.
   *
   * This is not a stylistic choice. A SYSTEM transient unit runs as root by default, so granting
   * an unprivileged service account the right to create one is a root-equivalent grant wearing a
   * narrow name — it was deliberately refused on this deployment. A `--user` scope runs as the
   * caller, needs no polkit grant at all, and still lives outside `<unit>.service`'s cgroup, which
   * is the only property the escape actually needs.
   */
  user?: boolean;
  /**
   * Where the unit appends its output. Defaults to `deployLogPath(releaseId)` under
   * `/var/log/cezar`, which only a deployer that can create that directory may use — on a rootless
   * box the `cezar` uid cannot (`mkdir: Permission denied`, measured 2026-08-29), and systemd
   * refuses to START a unit whose `append:` target is unwritable. A caller running as the service
   * account passes a path it owns.
   */
  logPath?: string;
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
    // Must come before --unit: systemd-run selects the bus from this flag.
    ...(opts.user ? ['--user'] : []),
    `--unit=${transientUnitName(opts.releaseId)}`,
    '--collect',
    '--property=Type=oneshot',
    '--property=RemainAfterExit=no',
    '--property=KillMode=process',
    `--property=StandardOutput=append:${opts.logPath ?? deployLogPath(opts.releaseId)}`,
    `--property=StandardError=append:${opts.logPath ?? deployLogPath(opts.releaseId)}`,
    `--setenv=${DETACHED_ENV}=1`,
  ];
  if (opts.cwd) argv.push(`--working-directory=${opts.cwd}`);
  for (const [key, value] of Object.entries(opts.setEnv ?? {})) argv.push(`--setenv=${key}=${value}`);
  argv.push('--', ...opts.command);
  return argv;
}

/**
 * The environment a `--user` `systemd-run` needs to find its bus.
 *
 * Measured 2026-08-21 and the reason option 1 alone was not enough: inside `cezar.service`,
 * `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` are unset, so `systemd-run --user` fails with
 * "Failed to connect to user scope bus via local transport" even though lingering is enabled and
 * `/run/user/<uid>` exists. Over ssh the same command works, because a login session sets them —
 * which is exactly how this gap stayed invisible until a deploy was driven from inside a task.
 *
 * Returns the additions only; the caller merges them over its own env.
 */
export function userBusEnv(uid = process.getuid?.() ?? 0): Record<string, string> {
  return {
    XDG_RUNTIME_DIR: `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
  };
}
