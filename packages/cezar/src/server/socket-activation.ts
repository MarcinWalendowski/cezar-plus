/**
 * systemd socket activation (P3 of `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`).
 *
 * The constraint that forces this design: a hosted cockpit may sit behind a tunnel client running
 * in TOKEN mode, where the ingress map (`<public host> → http://127.0.0.1:<port>`) lives in the
 * provider's dashboard rather than in a file on the box. The loopback port then cannot be moved as
 * part of a deploy — flipping it would mean a provider API call, which is slow,
 * eventually-consistent at the edge, and has no local rollback. The loopback port is a fixed
 * contract, and a blue-green cutover has to happen *behind* it.
 *
 * The way to replace a process behind a fixed port without a bind gap is to stop owning the port:
 * a `cezar.socket` unit holds the listening fd, and `cezar.service` inherits it. Across a restart
 * the socket never closes, so connections arriving mid-swap queue in the kernel accept backlog
 * and are served by the new process. Zero refused connections — the gap becomes latency, not
 * failure.
 *
 * This module is the fd-inheritance half, kept pure (env in, decision out) so every branch of the
 * systemd handshake is testable without systemd.
 *
 * Protocol (`sd_listen_fds(3)`): systemd sets `LISTEN_PID` to the pid it spawned, `LISTEN_FDS` to
 * how many descriptors it passed, and passes them consecutively starting at fd 3. `LISTEN_FDNAMES`
 * optionally names them.
 */

/** systemd passes inherited descriptors starting here (`SD_LISTEN_FDS_START`). */
export const SD_LISTEN_FDS_START = 3;

export interface InheritedSocket {
  /** The descriptor to listen on. */
  fd: number;
  /** How many descriptors systemd actually passed — >1 means the unit declared several sockets. */
  count: number;
  /** Name from `LISTEN_FDNAMES`, when systemd supplied one. */
  name?: string;
}

export type SocketActivationResult =
  | { activated: true; socket: InheritedSocket }
  | { activated: false; reason: string };

/**
 * Decide whether this process was socket-activated.
 *
 * The `LISTEN_PID` check is not ceremony. systemd sets these variables in the environment it
 * hands to the service's main process, and a naive implementation that skipped the check would
 * make every CHILD of the cockpit — every agent CLI cezar spawns — believe it too had inherited a
 * listening socket on fd 3. Fd 3 in a child is whatever that child happens to open, so the result
 * would be a subprocess serving HTTP on a random descriptor. Refusing when `LISTEN_PID` is not
 * ours is what confines activation to the one process systemd meant it for.
 */
export function resolveSocketActivation(env: NodeJS.ProcessEnv, pid: number): SocketActivationResult {
  const listenPid = env.LISTEN_PID;
  const listenFds = env.LISTEN_FDS;
  if (!listenPid && !listenFds) {
    return { activated: false, reason: 'not socket-activated (no LISTEN_FDS in the environment)' };
  }
  if (!listenPid || Number(listenPid) !== pid) {
    return {
      activated: false,
      reason: `LISTEN_PID=${listenPid ?? '(unset)'} is not this process (${pid}) — inherited by a child, not activated`,
    };
  }
  const count = Number(listenFds);
  if (!Number.isInteger(count) || count < 1) {
    return { activated: false, reason: `LISTEN_FDS=${listenFds ?? '(unset)'} is not a positive integer` };
  }
  const name = (env.LISTEN_FDNAMES ?? '').split(':')[0] || undefined;
  return { activated: true, socket: { fd: SD_LISTEN_FDS_START, count, name } };
}

/**
 * Resolve activation and then REMOVE the variables from `env`.
 *
 * `sd_listen_fds(3)` unsets them for the same reason: they are addressed to this process, and a
 * child that inherits them would misread fd 3 as a listening socket (see above). cezar spawns
 * agent CLIs constantly, so leaving them set is not a theoretical leak.
 */
export function consumeSocketActivation(env: NodeJS.ProcessEnv, pid: number): SocketActivationResult {
  const result = resolveSocketActivation(env, pid);
  delete env.LISTEN_PID;
  delete env.LISTEN_FDS;
  delete env.LISTEN_FDNAMES;
  return result;
}

/**
 * What `serve` should bind: an inherited descriptor, or a port.
 *
 * When activated, `--port-strict`'s refusal must be SKIPPED rather than satisfied. Strict mode
 * exists to stop a hosted org's cockpit silently drifting to another port while nginx keeps
 * proxying to the configured one — but under socket activation the port is legitimately held, by
 * systemd, on this process's behalf. Probing it would find it busy and refuse to boot, turning
 * the feature that removes the bind gap into a permanent outage.
 */
export function describeListenTarget(result: SocketActivationResult, port: number): string {
  return result.activated
    ? `inherited fd ${result.socket.fd} from systemd (socket activation)`
    : `port ${port}`;
}
