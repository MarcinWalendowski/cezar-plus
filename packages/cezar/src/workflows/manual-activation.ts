import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSystemdRunArgv, userBusEnv } from '../server-install/self-safe-deploy.ts';
import { DEPLOY_TARGETS_FILE, deployTargetsSchema } from './postconditions.ts';

/**
 * Running the manual deployment the Resolve button has, until now, only ever ASKED ABOUT.
 *
 * The owner decision this operates under (D6, 2026-08-24) is that a PERSON activates cezar, not an
 * agent. Pressing Resolve is a person acting, so running the activation from that press keeps the
 * decision intact — what changes is that the person no longer has to leave the cockpit, open an
 * ssh session and remember the runbook to act on what the card already told them.
 *
 * Two properties make this different from any other command the engine spawns:
 *
 * 1. **It outlives its parent on purpose.** The activation restarts `cezar.service`, which is the
 *    process handling the click. A child in that service's cgroup is killed with it, mid-deploy,
 *    with the symlink possibly already flipped — so the command is handed to a transient systemd
 *    unit, reusing the escape `server-deploy` already relies on for exactly this reason.
 * 2. **Nothing waits for it.** The HTTP response goes back immediately, because the connection is
 *    about to be severed by the restart. The run is picked back up by the post-restart park sweep
 *    (`recheckManualDeployParksEverywhere`), which re-probes and re-queues on green. That path is
 *    the mechanism, not a fallback: a click here never learns whether it worked.
 */

/** One failing manual target and the command that deploys it. */
export interface ActivationCommand {
  name: string;
  command: string;
}

/** The lock file's name inside a project's `.ai/cezar` data directory. */
export const ACTIVATION_LOCK = 'activation.lock';

/**
 * How long a launched activation is assumed to still be running.
 *
 * A file, not memory, because the thing being guarded RESTARTS this process: an in-memory flag is
 * cleared by the very event it exists to survive, which would let the second click land while the
 * first activation is mid-cutover.
 */
export const ACTIVATION_LOCK_TTL_MS = 15 * 60 * 1000;

/**
 * The activation commands for the manual targets that just failed, read from the run's own
 * worktree at click time rather than persisted onto the handoff.
 *
 * Reading it live is deliberate: the handoff can be days old, and the declaration in the repo is
 * the current truth about how this service is deployed. `failing` filters to the targets the probe
 * actually reported red, so a green service is never redeployed to satisfy a different one.
 */
export function readActivationCommands(cwd: string, failing: readonly string[]): ActivationCommand[] {
  try {
    return selectActivations(readFileSync(join(cwd, DEPLOY_TARGETS_FILE), 'utf8'), failing);
  } catch {
    return [];
  }
}

/** The shared half: parse one targets document and pick the runnable activations out of it. */
function selectActivations(source: string, failing: readonly string[]): ActivationCommand[] {
  let parsed;
  try {
    parsed = deployTargetsSchema.safeParse(JSON.parse(source));
  } catch {
    return [];
  }
  if (!parsed.success) return [];
  const wanted = new Set(failing);
  const seen = new Map<string, ActivationCommand>();
  for (const t of parsed.data.targets) {
    if (!t.manual || !t.activate || !wanted.has(t.name)) continue;
    // DEDUPED BY COMMAND, not by target. One activation usually satisfies several targets — cezar's
    // own backend and UI are one blue-green cutover declared twice — and running the same command
    // concurrently with itself is precisely the double-cutover the lock exists to prevent. The
    // names are merged so the operator still sees everything the one launch covers.
    const already = seen.get(t.activate);
    if (already) already.name = `${already.name}, ${t.name}`;
    else seen.set(t.activate, { name: t.name, command: t.activate });
  }
  return [...seen.values()];
}

/**
 * The same declaration, read from a git REF instead of a working tree.
 *
 * The project-root fallback exists for a run whose own worktree predates the feature — but on this
 * box the project root is the SHARED checkout task worktrees fork from, and nothing brings it
 * forward: `activate-main.sh` refuses to `reset --hard` there by design, and agents fetch without
 * pulling. Measured 2026-08-29: 22 commits behind `origin/main` with 4 dirty files. Reading its
 * working tree is therefore reading a snapshot from whenever someone last touched it.
 *
 * A ref has none of that. `git show origin/main:<file>` is current the moment anything fetched, is
 * unaffected by dirty files, and needs no checkout to be mutated. Worktrees already resolve their
 * base this way (`resolveBaseRef` prefers `origin/<base>` when the local branch is behind), so this
 * keeps the two answers consistent instead of inventing a third.
 */
export function readActivationCommandsFromRef(
  repoRoot: string,
  ref: string,
  failing: readonly string[],
): ActivationCommand[] {
  const shown = spawnSync('git', ['-C', repoRoot, 'show', `${ref}:${DEPLOY_TARGETS_FILE}`], {
    encoding: 'utf8',
  });
  if (shown.status !== 0 || !shown.stdout) return [];
  return selectActivations(shown.stdout, failing);
}

/**
 * The argv that runs one activation outside this service's cgroup.
 *
 * Falls back to a plain `bash -lc` when `systemd-run` is unavailable — on a dev box with no
 * systemd the activation is not restarting a unit that would kill it, so the escape buys nothing
 * and refusing to run at all would make the feature untestable off the production host.
 */
export function activationArgv(opts: {
  unitId: string;
  command: string;
  cwd: string;
  user: boolean;
  systemdRun: boolean;
  logPath: string;
}): string[] {
  const inner = ['bash', '-lc', opts.command];
  if (!opts.systemdRun) return inner;
  return buildSystemdRunArgv({
    releaseId: opts.unitId,
    command: inner,
    cwd: opts.cwd,
    user: opts.user,
    // NOT the default `/var/log/cezar` — the service account cannot create it, and systemd refuses
    // to start a unit whose `append:` target is unwritable. This directory is the project's own.
    logPath: opts.logPath,
  });
}

/** Where one activation's output is appended. Inside the project's data dir, which the service
 *  account owns by construction — unlike `/var/log/cezar`. */
export function activationLogPath(dataDir: string, unitId: string): string {
  return join(dataDir, 'activations', `${unitId}.log`);
}

/**
 * The environment a launched activation needs on top of the caller's.
 *
 * `systemd-run --user` needs bus coordinates that `cezar.service` does not have: measured on
 * prod-host, the service's `/proc/<pid>/environ` carries NEITHER `XDG_RUNTIME_DIR` nor
 * `DBUS_SESSION_BUS_ADDRESS`, so the launch fails with "Failed to connect to user scope bus via
 * local transport". An ssh session HAS them, which is exactly how this stays invisible until it
 * runs from inside the service — the same trap `userBusEnv`'s own doc comment records, and the
 * one this function exists to stop repeating.
 */
export function activationEnv(base: NodeJS.ProcessEnv, user: boolean): NodeJS.ProcessEnv {
  return user ? { ...base, ...userBusEnv() } : { ...base };
}

/** Is an activation launched from this project still presumed in flight? */
export function activationInFlight(dataDir: string, now: number, ttlMs = ACTIVATION_LOCK_TTL_MS): number | undefined {
  const path = join(dataDir, ACTIVATION_LOCK);
  if (!existsSync(path)) return undefined;
  const at = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
  if (!Number.isFinite(at)) return undefined;
  return now - at < ttlMs ? at : undefined;
}

/** Record that an activation was launched now. Best-effort: an unwritable lock must not block a
 *  deployment a person explicitly asked for. */
/** Make the activation log directory, best-effort. Returns whether it is usable. */
export function ensureActivationLogDir(dataDir: string): boolean {
  try {
    mkdirSync(join(dataDir, 'activations'), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export function markActivationLaunched(dataDir: string, now: number): void {
  try {
    writeFileSync(join(dataDir, ACTIVATION_LOCK), String(now), 'utf8');
  } catch {
    // Intentionally silent — see the doc comment.
  }
}

export interface ActivationHost {
  systemdRunAvailable(): boolean;
  isRoot(): boolean;
  /**
   * Register the transient unit and REPORT whether registration succeeded.
   *
   * `systemd-run` returns as soon as the unit's binary has been execed — it does not wait for the
   * command to FINISH — so this can be synchronous and still not block the click. Being
   * synchronous is the point: the first version spawned this detached with `stdio: 'ignore'` and
   * took the lock regardless, so a launch that failed for either reason above was
   * INDISTINGUISHABLE from one that worked, and left a 15-minute lock over nothing running.
   * Measured on the first production press.
   *
   * **CORRECTED 2026-08-30 — that first sentence was FALSE, and this call was the freeze.** The
   * unit `buildSystemdRunArgv` built was `Type=oneshot`, whose start job does not complete until
   * the command EXITS, so `spawnSync` here blocked node's event loop for the entire ~62 s
   * activation: no SIGTERM handler ran, no drain, no `store.flush()`, and the restart the
   * activation itself triggers could only end in a 30 s `TimeoutStopSec` SIGKILL. The type is now
   * `Type=exec`, which makes the sentence above true. Do NOT "fix" a future slow launch here by
   * spawning detached or by adding `--no-block`: both restore the silent failure this reports.
   * Spec: `.ai/specs/2026-08-30-activation-blocks-the-event-loop.md`.
   */
  registerUnit(argv: string[], env: NodeJS.ProcessEnv, cwd: string): { ok: boolean; error?: string };
  /** The no-systemd fallback, which genuinely cannot be waited on. */
  spawnDetached(argv: string[], env: NodeJS.ProcessEnv, cwd: string): void;
}

export const defaultActivationHost: ActivationHost = {
  systemdRunAvailable: () => spawnSync('sh', ['-c', 'command -v systemd-run'], { encoding: 'utf8' }).status === 0,
  isRoot: () => (process.getuid?.() ?? 0) === 0,
  registerUnit: (argv, env, cwd) => {
    const [bin, ...rest] = argv;
    const done = spawnSync(bin as string, rest, { cwd, env, encoding: 'utf8' });
    if (done.status === 0) return { ok: true };
    const detail = (done.stderr || done.stdout || '').trim().split('\n').slice(0, 3).join(' ');
    return { ok: false, error: detail || done.error?.message || `exit ${done.status ?? 'unknown'}` };
  },
  spawnDetached: (argv, env, cwd) => {
    const [bin, ...rest] = argv;
    const child = spawn(bin as string, rest, { detached: true, stdio: 'ignore', env, cwd });
    child.unref();
  },
};
