import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  let parsed;
  try {
    parsed = deployTargetsSchema.safeParse(JSON.parse(readFileSync(join(cwd, DEPLOY_TARGETS_FILE), 'utf8')));
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
}): string[] {
  const inner = ['bash', '-lc', opts.command];
  if (!opts.systemdRun) return inner;
  return buildSystemdRunArgv({ releaseId: opts.unitId, command: inner, cwd: opts.cwd, user: opts.user });
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
  spawnDetached(argv: string[], env: NodeJS.ProcessEnv, cwd: string): void;
}

export const defaultActivationHost: ActivationHost = {
  systemdRunAvailable: () => spawnSync('sh', ['-c', 'command -v systemd-run'], { encoding: 'utf8' }).status === 0,
  isRoot: () => (process.getuid?.() ?? 0) === 0,
  spawnDetached: (argv, env, cwd) => {
    const [bin, ...rest] = argv;
    const child = spawn(bin as string, rest, { detached: true, stdio: 'ignore', env, cwd });
    child.unref();
  },
};
