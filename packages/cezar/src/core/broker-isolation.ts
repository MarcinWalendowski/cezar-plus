/**
 * Where a run broker's process tree lives (P4 of
 * `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`).
 *
 * The problem in one line: `cezar.service` runs with the default `KillMode=control-group`, so
 * `systemctl restart` SIGKILLs every process in its cgroup — and every agent run cezar has spawned
 * is in that cgroup. Making a run survive a deploy means getting the broker OUT of it.
 *
 * Three modes, tried in order, because the right answer depends on privileges this process may not
 * have and must not demand:
 *
 *  1. `scope` — `systemd-run --user --scope --slice=cezar-runs.slice`. A real per-run cgroup under
 *     a named slice, so brokers are visible to `systemd-cgtop` and survive any action on
 *     `cezar.service`. Needs a user manager for the service account (`loginctl enable-linger`),
 *     which the install step arranges.
 *  2. `delegated` — `Delegate=yes` + `KillMode=process` on the service, with the broker
 *     `setsid`-detached. systemd signals only the main process on stop, so the tree is left alone.
 *  3. `none` — macOS, a container without cgroup delegation, a plain `cezar serve` in a terminal.
 *     The broker still spools durably and still survives an ordinary server exit; it just does not
 *     survive a `KillMode=control-group` teardown.
 *
 * Mode 3 is a real degradation, so it is REPORTED (`/api/v1/health` → `runtime.runBrokerIsolation`)
 * rather than assumed away. "It works on the box we tested" is exactly the claim this field exists
 * to stop anyone making.
 */

import { accessSync, constants, existsSync, readFileSync } from 'node:fs';

const { W_OK } = constants;
const nodeFs = { existsSync, accessSync };

export const BROKER_ISOLATIONS = ['scope', 'delegated', 'none'] as const;
export type BrokerIsolation = (typeof BROKER_ISOLATIONS)[number];

/** Slice that owns every run broker. Never `cezar.service`'s own cgroup — that is the point. */
export const RUNS_SLICE = 'cezar-runs.slice';

export interface IsolationCapabilities {
  /** `systemd-run` exists AND a user manager is running for this uid (linger enabled). */
  userScopeAvailable: boolean;
  /** The service unit was started with `Delegate=yes` (systemd exports this in the environment of
   *  a delegated unit as part of the cgroup being writable; the caller probes it). */
  delegated: boolean;
}

export function chooseIsolation(caps: IsolationCapabilities): BrokerIsolation {
  if (caps.userScopeAvailable) return 'scope';
  if (caps.delegated) return 'delegated';
  return 'none';
}

/** Human-readable justification, surfaced on health so an operator can see WHY they are degraded
 *  rather than only that they are. */
export function describeIsolation(isolation: BrokerIsolation): string {
  switch (isolation) {
    case 'scope':
      return `each run gets its own transient scope under ${RUNS_SLICE} — a deploy cannot signal it`;
    case 'delegated':
      return 'runs are setsid-detached in a delegated cgroup with KillMode=process — a deploy signals only the server';
    case 'none':
      return 'runs share the server cgroup — a KillMode=control-group restart WILL kill them (degraded)';
  }
}

/** True when a restart of the service is expected to leave in-flight runs alive. */
export function survivesRestart(isolation: BrokerIsolation): boolean {
  return isolation !== 'none';
}

export interface BrokerLaunchOptions {
  isolation: BrokerIsolation;
  runId: string;
  /** The broker command, already split into argv. */
  command: string[];
  slice?: string;
  /**
   * Discriminator making this launch's unit name unique among the run's other brokers.
   *
   * REQUIRED in practice for `scope` — see `brokerScopeUnitName`. Optional in the type only so the
   * name stays the run's own when a caller genuinely launches once (tests, and the re-attach path,
   * which spawns nothing).
   */
  instanceId?: string;
  /**
   * cgroup resource bounds for this launch (D14a). Omitted, or every field `null`, means no
   * `--property=`/`--slice-property=` flags at all — today's behaviour, unchanged. Ignored outside
   * `scope` isolation: `delegated` and `none` have no cgroup of their own to bound.
   */
  resources?: BrokerResourceLimits;
}

/**
 * The `resources` slice of workspace config (`workspace/config.ts`), mirrored here rather than
 * imported so this file stays buildable from argv/exit facts alone with no dependency on the
 * config schema's own validation. `number | null | undefined` throughout: `null` is config's
 * explicit "no bound" (its own default), `undefined` covers a caller that omits the object, or an
 * older field set — both mean the same thing, leave the property off.
 */
export interface BrokerResourceLimits {
  /** systemd `MemoryHigh` on the run's own scope — throttles (reclaim), does not kill. */
  runMemoryHighMb?: number | null;
  /** systemd `MemoryMax` on the run's own scope — the hard cap; a cgroup breach here is what
   *  `detectResourceKill` below looks for. */
  runMemoryMaxMb?: number | null;
  /** systemd `CPUWeight` (1-10000) on the run's own scope — a scheduling weight, never a hard
   *  cap, so unlike the two Memory knobs it can never be the reason a process was killed. */
  runCpuWeight?: number | null;
  /** systemd `MemoryMax` on `cezar-runs.slice` itself — the ceiling that keeps `cezar.service`
   *  answerable while every run beneath it saturates the box. */
  runsSliceMemoryMaxMb?: number | null;
}

/**
 * `--property=` flags for the run's OWN scope: `MemoryHigh`, `MemoryMax`, `CPUWeight`. A `null`
 * (or absent) value is left off the scope entirely rather than passed as some sentinel — that is
 * today's behaviour (the scope exists and carries no resource properties at all) and stays the
 * safe default for a published package an operator has not tuned.
 *
 * Values are MiB, matching every other `*Mb` field in this codebase (`memoryLimitMb`,
 * `workflows/run.ts`'s `limitBytes = limitMb * 1024 * 1024`) — systemd's own `M` suffix on a byte
 * property is binary (mebibytes), so no conversion is needed, only the suffix.
 */
export function buildRunScopeProperties(limits: BrokerResourceLimits): string[] {
  const props: string[] = [];
  if (limits.runMemoryHighMb != null) props.push(`--property=MemoryHigh=${limits.runMemoryHighMb}M`);
  if (limits.runMemoryMaxMb != null) props.push(`--property=MemoryMax=${limits.runMemoryMaxMb}M`);
  if (limits.runCpuWeight != null) props.push(`--property=CPUWeight=${limits.runCpuWeight}`);
  return props;
}

/**
 * `--slice-property=` flags that cap `cezar-runs.slice` itself, so runs collectively cannot starve
 * `cezar.service` (D14a: "the cockpit going unresponsive under load is how you lose the ability to
 * SEE the overload"). `--slice-property=` is systemd-run's own mechanism for setting a property on
 * a slice at the moment it is implicitly created — a no-op on every launch after the first, which
 * is systemd's own semantics and not something this function needs to special-case.
 */
export function buildRunsSliceProperties(limits: BrokerResourceLimits): string[] {
  if (limits.runsSliceMemoryMaxMb == null) return [];
  return [`--slice-property=MemoryMax=${limits.runsSliceMemoryMaxMb}M`];
}

let brokerInstanceSeq = 0;

/**
 * A discriminator unique to one broker launch.
 *
 * Process start time plus a counter: the counter separates brokers within a process, the start time
 * separates them across a server restart that resets the counter while an old scope is still alive.
 * Both parts are needed — a bare counter collides after a deploy, a bare timestamp collides between
 * two steps starting in the same millisecond.
 */
/**
 * This process's start time, computed ONCE at load.
 *
 * `Date.now() - uptime` drifts a millisecond or two between calls, which measurably produced two
 * different stamps for two launches of the same server in the production E2E. Uniqueness never
 * depended on the stamp — the counter alone guarantees it within a process — but a value that
 * claims to say "when this server started" and quietly differs per call is a small lie, and this
 * prefix is what an operator groups units by.
 */
const PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000).toString(36);

export function nextBrokerInstanceId(): string {
  brokerInstanceSeq += 1;
  return `${PROCESS_STARTED_AT}-${brokerInstanceSeq}`;
}

/**
 * The transient scope unit a broker runs in.
 *
 * **`instanceId` is not decoration.** This used to be `cezar-run-<runId>` and nothing else, one name
 * per RUN — while `spawnBroker` is called once per STEP. A systemd scope stays active as long as its
 * cgroup is non-empty, so any process an agent leaves running (a dev server, `op daemon`, a test
 * fixture — all three were found holding scopes open on prod-host on 2026-08-22) keeps the
 * name taken after its broker exits. The run's next step then hit
 *
 *   Failed to start transient scope unit: Unit cezar-run-<id>.scope was already loaded
 *
 * `systemd-run` exited 1, no broker was ever spawned, and the session reported the generic
 * "run broker did not respond after 5000ms" — blaming a process that did not exist. Permanent, not
 * flaky: the lingering process outlives the run, so every later step failed the same way. Five runs
 * died this way in one morning. `--collect` does not save us; it reaps FAILED units, not active
 * ones. See `.ai/specs/2026-08-22-broker-scope-unit-name-collision.md`.
 *
 * The run id stays the PREFIX so `systemctl --user list-units 'cezar-run-<runId>*'` still groups one
 * run's scopes for an operator.
 */
export function brokerScopeUnitName(runId: string, instanceId?: string): string {
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9:_.-]/g, '-');
  return `cezar-run-${safe(runId)}${instanceId ? `-${safe(instanceId)}` : ''}`;
}

/**
 * Build the argv that launches a broker in the chosen isolation mode.
 *
 * `--scope` (rather than a transient service) is deliberate: a scope adopts an EXISTING process
 * into a new cgroup and keeps it attached to our stdio, which is what we want — the broker is our
 * child, we just need it accounted somewhere systemd will not sweep. A transient `--unit` service
 * would be started by systemd itself, inheriting systemd's environment rather than the carefully
 * built agent environment (`buildChildEnv`), which is a different and much larger change.
 *
 * `delegated` and `none` return the command unchanged — the escape there is `setsid` + `detached`
 * at spawn time, which is the caller's job, not an argv prefix. `resources` is likewise a no-op on
 * those two paths: there is no cgroup of the scope's own to bound.
 */
export function buildBrokerLaunchArgv(opts: BrokerLaunchOptions): string[] {
  if (opts.isolation !== 'scope') return [...opts.command];
  const resources = opts.resources ?? {};
  return [
    'systemd-run',
    '--user',
    '--scope',
    `--slice=${opts.slice ?? RUNS_SLICE}`,
    `--unit=${brokerScopeUnitName(opts.runId, opts.instanceId)}`,
    '--quiet',
    '--collect',
    ...buildRunsSliceProperties(resources),
    ...buildRunScopeProperties(resources),
    '--',
    ...opts.command,
  ];
}

// ---- runtime probe ---------------------------------------------------------------------------

/**
 * Ask the host which isolation modes are actually available, without spawning anything.
 *
 * Deliberately all filesystem checks. The obvious implementation — shell out to `systemd-run
 * --version` and `systemctl --user is-system-running` — costs two process spawns on a path that
 * runs at boot and again per run, and answers a question two `existsSync` calls already settle.
 * It would also be the third place in this repo to learn that `systemctl` prints a healthy banner
 * for a state that does not work (the `wrangler whoami` lesson in the workspace CLAUDE.md).
 *
 * `userScopeAvailable` needs BOTH halves: the binary, and a user manager actually running for this
 * uid. `XDG_RUNTIME_DIR` alone is not proof — it is set in plenty of sessions with no user
 * manager behind them — so the private socket the manager creates is what is tested.
 *
 * `delegated` is "can I write to my own cgroup?", which is precisely what `Delegate=yes` grants
 * and what a non-delegated unit denies. Reading the flag out of the unit file would be reading our
 * configuration; this reads our actual privilege.
 */
export function probeIsolationCapabilities(
  env: NodeJS.ProcessEnv = process.env,
  fs: { existsSync(p: string): boolean; accessSync(p: string, mode: number): void } = nodeFs,
): IsolationCapabilities {
  return {
    userScopeAvailable: probeUserScope(env, fs),
    delegated: probeDelegated(fs),
  };
}

export function probeUserScope(
  env: NodeJS.ProcessEnv,
  fs: { existsSync(p: string): boolean },
  uid = process.getuid?.() ?? 0,
): boolean {
  const hasBinary = (env.PATH ?? '')
    .split(':')
    .filter(Boolean)
    .some((dir) => fs.existsSync(`${dir}/systemd-run`));
  if (!hasBinary) return false;
  // MEASURED 2026-08-21 on prod-host, and the reason this box reported `delegated` rather
  // than `scope`: inside `cezar.service`, XDG_RUNTIME_DIR is UNSET. A login shell over ssh has it,
  // so the user-scope path looked available in every manual probe and was silently unavailable to
  // the server itself. The consequence was not cosmetic -- `delegated` keeps the broker in the
  // service's OWN cgroup, protected only by KillMode=process, which survives `systemctl restart`
  // but NOT a full `stop` (deactivation empties the cgroup). A run therefore survived seven
  // restarts and then died on the first stop/start.
  //
  // So derive the default rather than give up: the user manager's private socket is at a
  // well-known path, and its EXISTENCE is still the actual proof -- this widens where we look, it
  // does not weaken the test.
  const runtimeDir = env.XDG_RUNTIME_DIR ?? defaultRuntimeDir(uid);
  if (!runtimeDir) return false;
  return fs.existsSync(`${runtimeDir}/systemd/private`);
}

function probeDelegated(fs: {
  existsSync(p: string): boolean;
  accessSync(p: string, mode: number): void;
}): boolean {
  let ownCgroup: string;
  try {
    // cgroup v2: a single `0::<path>` line. v1's numbered controller lines have no delegated
    // sub-tree to write into anyway, so failing to find the v2 line is correctly a `false`.
    const line = readFileSync('/proc/self/cgroup', 'utf8')
      .split('\n')
      .find((l) => l.startsWith('0::'));
    if (!line) return false;
    ownCgroup = `/sys/fs/cgroup${line.slice(3)}`;
  } catch {
    return false;
  }
  try {
    fs.accessSync(`${ownCgroup}/cgroup.subtree_control`, W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where a lingering user manager keeps its runtime state. Exported so the launcher can put it
 *  into the child environment: probing for the socket is useless if `systemd-run --user` is then
 *  spawned without the variable that tells it where to look. */
export function defaultRuntimeDir(uid = process.getuid?.() ?? 0): string {
  return `/run/user/${uid}`;
}

/**
 * The environment a `--user` `systemd-run` needs, added only when it is missing.
 *
 * Never overrides an XDG_RUNTIME_DIR the caller already has — a real login session knows better
 * than a derived default.
 */
export function userScopeEnv(
  env: NodeJS.ProcessEnv = process.env,
  uid = process.getuid?.() ?? 0,
): Record<string, string> {
  if (env.XDG_RUNTIME_DIR) return {};
  const dir = defaultRuntimeDir(uid);
  return { XDG_RUNTIME_DIR: dir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${dir}/bus` };
}

// ---- resource kill detection -------------------------------------------------------------------

/** The two facts a finished process's exit already carries — `child_process`'s own shape, kept
 *  narrow so this function needs nothing beyond what every caller already has in hand. */
export interface BrokerExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * True when the exit looks like a SIGKILL, in either of the two forms this codebase already
 * distinguishes (`agent-runner.ts`'s `isSignalTerminationExit`, which groups SIGINT/SIGKILL/SIGTERM
 * together for a different purpose): `signal` set directly by Node, when nothing intercepted it, or
 * exit code 137 (`128 + 9`), the form a CLI that traps and re-reports the signal itself produces.
 * cezar's own SIGTERM→SIGKILL escalation (`claude-cli-runner.ts`, `run-broker.ts`'s `interrupt`)
 * produces exactly the same shape, which is why this alone is never sufficient — see
 * `detectResourceKill`.
 */
function killedBySigkill(exit: BrokerExitInfo): boolean {
  return exit.signal === 'SIGKILL' || exit.code === 137;
}

/**
 * Whether a finished run's exit looks like the cgroup bound this file puts on the scope killed it
 * — spec D14a, verification **C3**: "assert it is killed and reported as a resource kill with a
 * reason, not as a failed test step."
 *
 * Detection, not proof: a cgroup OOM kill delivers SIGKILL to the process the kernel picked, which
 * is bit-for-bit the same signal cezar's own timeout escalation or an operator's manual `kill -9`
 * produces. Two things narrow it to "resource kill": the exit must NOT be one cezar itself
 * initiated (`opts.cezarInitiated` — the caller already tracks this, e.g.
 * `claude-cli-runner.ts`'s `terminatedByCezar`, `run-broker.ts`'s `interrupt()`), and a memory bound
 * must actually have been configured for this launch — a SIGKILL with nothing configured that
 * could have fired it is not attributed to a bound that was never set.
 *
 * **There is no `'cpu'` case.** `runCpuWeight` maps to systemd `CPUWeight`, a scheduling weight
 * (D14a: "weight over quota by default") — it can slow a run down but, unlike `MemoryHigh`/
 * `MemoryMax`, it has no hard ceiling to breach and can never be the reason a process was killed.
 * So this function only ever returns `limit: 'memory'`; a caller with a `'cpu'` case to populate
 * would need a different signal than this file's knobs produce (e.g. a configured `CPUQuota`,
 * which D14a explicitly does not add by default).
 */
export function detectResourceKill(
  exit: BrokerExitInfo,
  limits: BrokerResourceLimits,
  opts: { cezarInitiated: boolean },
): { limit: 'memory'; detail: string } | undefined {
  if (opts.cezarInitiated) return undefined;
  if (!killedBySigkill(exit)) return undefined;
  const scopeMax = limits.runMemoryMaxMb;
  const sliceMax = limits.runsSliceMemoryMaxMb;
  if (scopeMax == null && sliceMax == null) return undefined;
  const bound =
    scopeMax != null
      ? `MemoryMax=${scopeMax}M on the run scope`
      : `MemoryMax=${sliceMax}M on ${RUNS_SLICE}`;
  return {
    limit: 'memory',
    detail: `process exited via SIGKILL with ${bound} configured (cgroup OOM, not a cezar-initiated stop)`,
  };
}
