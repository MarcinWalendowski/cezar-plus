/**
 * Socket-activation + run-slice unit text (P3/P4 of
 * `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`).
 *
 * Why a DROP-IN rather than a rewritten service unit. The live `cezar.service` on
 * `prod-host` is hand-written — its `Description` is `cezar cockpit (hosted, Cloudflare
 * Access is the perimeter)`, which no generator in this repo emits — and it already carries three
 * operator drop-ins (`10-cloudflare.conf`, `20-onepassword.conf`, `30-agent-passthrough.conf`)
 * holding the Cloudflare token, the 1Password service-account token and the agent env
 * passthrough. Regenerating the unit would mean reproducing a file this repo never authored and
 * risking those. A drop-in adds exactly the three directives this spec needs, is idempotent, and
 * leaves everything else — including anything an operator added last week — untouched.
 *
 * The `[Socket]` unit itself is new, so it is generated whole.
 */

/** systemd expands `%` specifiers in unit values — a literal `%` must be doubled. Same helper as
 *  the other generators in this directory (private there, so duplicated rather than exported). */
function sysd(s: string): string {
  return s.replace(/%/g, '%%');
}

export interface CezarSocketUnitOptions {
  /** Loopback address the cockpit answers on — the fixed contract the tunnel's ingress names. */
  bindHost: string;
  port: number;
  /** The service this socket activates (e.g. `cezar.service`). */
  serviceUnit: string;
  /** Accept backlog. Sized to absorb a full restart's worth of arrivals: during the swap every
   *  connection queues here instead of being refused, so this is the depth of the "gap". */
  backlog?: number;
}

/**
 * `cezar.socket` — systemd owns the listening descriptor, the service borrows it.
 *
 * `Accept=no` is the load-bearing setting: it means ONE service instance receives the listening
 * socket and accepts connections itself, which is what lets a long-lived HTTP/SSE server inherit
 * it. `Accept=yes` would spawn a service instance per connection (inetd style) and is wrong for
 * anything that keeps state.
 *
 * There is deliberately no `[Install] WantedBy=sockets.target` conflict with the service's own
 * `WantedBy=multi-user.target`: the socket is what should be enabled, and the service is pulled
 * in by traffic or by an explicit start. Both being enabled is harmless and keeps a reboot
 * behaving exactly as it does today.
 */
export function cezarSocketUnit(opts: CezarSocketUnitOptions): string {
  return `# Managed by cezar — socket activation (.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md, P3).
# systemd owns 127.0.0.1:${opts.port}, so a restart of ${opts.serviceUnit} never closes it and
# connections arriving mid-deploy queue in the backlog instead of being refused.
[Unit]
Description=cezar cockpit socket (${opts.bindHost}:${opts.port})
Before=${sysd(opts.serviceUnit)}

[Socket]
ListenStream=${sysd(opts.bindHost)}:${opts.port}
Backlog=${opts.backlog ?? 1024}
Accept=no
# Keep the socket (and therefore every queued connection) across a service restart.
FlushPending=no
Service=${sysd(opts.serviceUnit)}

[Install]
WantedBy=sockets.target
`;
}

export interface NonDisruptiveDropInOptions {
  socketUnit: string;
  /** Slice that owns detached run brokers (P4). Runs live here, NOT in the service cgroup, so a
   *  deploy's restart cannot signal them. */
  runsSlice?: string;
}

/**
 * `40-non-disruptive.conf` — the three directives that make a restart survivable.
 *
 * `Sockets=` binds the inherited descriptor to this service.
 *
 * `KillMode=process` is the one that saves in-flight runs, and it is the direct answer to
 * disruption vector 1: with the default `control-group`, `systemctl restart` SIGKILLs every
 * process in the cgroup, which is every agent CLI cezar has spawned. `process` signals only the
 * main process, leaving the tree alone.
 *
 * `Delegate=yes` lets the cockpit create its own child cgroups, which is the fallback isolation
 * mode for run brokers on a box where `systemd-run --user --scope` is unavailable.
 *
 * `TimeoutStopSec` must exceed the drain window (`CEZ_DRAIN_MS`, default 5 s) or systemd will
 * SIGKILL the process mid-drain and undo the graceful shutdown this spec just built.
 */
export function nonDisruptiveDropIn(opts: NonDisruptiveDropInOptions): string {
  return `# Managed by cezar — non-disruptive deploy (.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md).
# A DROP-IN, not a unit rewrite: the base unit on this box is hand-written and carries operator
# drop-ins (Cloudflare token, 1Password, agent env passthrough) that must not be disturbed.
[Service]
Sockets=${sysd(opts.socketUnit)}
# Vector 1: the default control-group mode SIGKILLs every agent run on every deploy.
KillMode=process
Delegate=yes
# Must exceed CEZ_DRAIN_MS, or systemd kills the process part-way through its graceful drain.
TimeoutStopSec=30
`;
}

/**
 * `cezar-runs.slice` — the cgroup that owns detached run brokers (P4).
 *
 * A slice, not a scope: scopes are created at runtime by `systemd-run`, and this is the parent
 * they are created under. Keeping runs in a named slice means an operator can see and account for
 * them (`systemd-cgtop`, `systemctl status cezar-runs.slice`) rather than discovering a drift of
 * unparented processes.
 */
export function cezarRunsSlice(): string {
  return `# Managed by cezar — detached run brokers (.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md, P4).
# Agent runs live here, never in cezar.service's cgroup, so a deploy restart cannot signal them.
[Unit]
Description=cezar agent runs
Before=slices.target

[Slice]
`;
}
