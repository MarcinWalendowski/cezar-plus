import { spawn } from 'node:child_process';
import { closeSync, createWriteStream, existsSync, openSync, rmSync, type WriteStream } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { z } from 'zod';

import {
  BROKER_PROTOCOL,
  ensureSpoolDir,
  spoolPaths,
  writeSpoolExit,
  writeSpoolMeta,
} from './run-spool.ts';

/**
 * The run broker (P4 of `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`).
 *
 * A tiny, long-lived process that owns ONE agent CLI: it spawns the backend, tees its stdout into
 * a durable spool file, and exposes a control socket so whoever is currently the server can write
 * to the backend's stdin. That is all it does. Every layer above the runner seam — the UI mapper,
 * step lifecycle, autosave, leases, the semaphore, store writes — stays in the server, which is
 * what makes this tractable against a 4 000-line `run.ts`.
 *
 * The split exists because the server process is currently the pipe's read end. Moving the agent
 * to another cgroup without moving the pipe leaves it alive but mute (EPIPE on its next write,
 * output recorded nowhere). Moving only the pipe-owning layer out is the minimum change that makes
 * a run survivable, and it leaves the server a replaceable READER of durable state.
 *
 * Deliberately dependency-light: this runs as its own process image and must start fast and stay
 * up long after the server that launched it has been replaced.
 */

/** One control request, NDJSON, one per line. */
export const brokerRequestSchema = z.union([
  z.object({ op: z.literal('send'), content: z.array(z.unknown()) }),
  z.object({ op: z.literal('sendRaw'), line: z.string() }),
  z.object({ op: z.literal('end') }),
  z.object({ op: z.literal('interrupt') }),
  z.object({ op: z.literal('status') }),
]);
export type BrokerRequest = z.infer<typeof brokerRequestSchema>;

export interface BrokerResponse {
  ok: boolean;
  error?: string;
  pid?: number;
  open?: boolean;
  bytes?: number;
}

/** Grace between SIGTERM and SIGKILL when the broker is asked to interrupt. Mirrors the runner's
 *  own watchdog: `claude` installs a SIGTERM handler and exits 143 rather than dying from it. */
export const INTERRUPT_KILL_GRACE_MS = 5_000;

/**
 * No control connection and no output for this long → the broker exits.
 *
 * This is the orphan guard the spec's Risks section calls for. With `KillMode=process`, a server
 * that crashes outright leaves brokers running with nothing consuming them; without a watchdog
 * they would hold an agent session (and its token spend) open indefinitely.
 */
export const ORPHAN_TIMEOUT_MS = 30 * 60_000;

export interface RunBrokerOptions {
  spoolDir: string;
  runId: string;
  instanceId?: string;
  stepId?: string;
  backend: string;
  /** The backend CLI argv — `[bin, ...args]`. */
  command: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  orphanTimeoutMs?: number;
  /** Injectable for tests. */
  now?: () => string;
}

/**
 * Fault injection for `.ai/specs/2026-08-22-bounded-transient-broker-retry.md` Verification
 * §4/§6 only. `CEZ_BROKER_FAULT=deaf-once:<markerPath>` or `deaf-alive:<markerPath>` reproduces the
 * transient case — a broker that started, is recorded in `meta.json`, and never answers — without
 * needing a real stalled process. Inert (returns `null`) whenever the variable is unset or holds an
 * unrelated value such as `never-start`, which is read elsewhere (`claude-cli-runner.ts`).
 */
function readDeafFault(): { mode: 'deaf-once' | 'deaf-alive'; markerPath: string } | null {
  const raw = process.env.CEZ_BROKER_FAULT;
  if (!raw) return null;
  const sep = raw.indexOf(':');
  if (sep < 0) return null;
  const mode = raw.slice(0, sep);
  const markerPath = raw.slice(sep + 1);
  if ((mode === 'deaf-once' || mode === 'deaf-alive') && markerPath) {
    return { mode, markerPath };
  }
  return null;
}

export interface RunBrokerHandle {
  /** Resolves with the backend's exit once it has been recorded to the spool. */
  finished: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Broker-initiated shutdown (used by tests; production exits via the child or the watchdog). */
  close(): Promise<void>;
  readonly childPid?: number;
}

/**
 * Start a broker in THIS process. The CLI entry (`cezar run-broker`) is a thin wrapper around it.
 *
 * Ordering note: the spool directory and `meta.json` are written BEFORE the child is spawned, so a
 * server that crashes in the same millisecond still finds a spool it can reason about. A meta
 * written afterwards would leave a window where a live agent has no discoverable record — exactly
 * the orphan the re-attach logic exists to prevent.
 */
export function startRunBroker(opts: RunBrokerOptions): RunBrokerHandle {
  const now = opts.now ?? (() => new Date().toISOString());
  const paths = ensureSpoolDir(opts.spoolDir);

  const [bin, ...args] = opts.command;
  if (!bin) throw new Error('run-broker: empty command');

  const outStream: WriteStream = createWriteStream(paths.out, { flags: 'a' });
  const errStream: WriteStream = createWriteStream(paths.err, { flags: 'a' });

  const child = spawn(bin, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Own process group: a signal aimed at the server's group (a terminal Ctrl-C, a process-group
    // kill) must not reach the agent. The cgroup escape is a separate mechanism — see
    // `broker-isolation.ts` — and this is the process-group half of the same intent.
    detached: true,
  });

  writeSpoolMeta(opts.spoolDir, {
    schema: 1,
    protocol: opts.instanceId ? BROKER_PROTOCOL : 1,
    runId: opts.runId,
    stepId: opts.stepId,
    backend: opts.backend,
    pid: process.pid,
    childPid: child.pid,
    argv: opts.command,
    cwd: opts.cwd,
    startedAt: now(),
    instanceId: opts.instanceId,
  });

  // The spool is append-only and never re-read by the broker, so a plain pipe is correct and
  // keeps backpressure: if the disk is slow the backend blocks rather than the broker buffering
  // an unbounded transcript in memory.
  child.stdout.pipe(outStream);
  child.stderr.pipe(errStream);

  let stdinOpen = true;
  let lastActivity = Date.now();
  const touch = (): void => {
    lastActivity = Date.now();
  };
  child.stdout.on('data', touch);

  const writeLine = (line: string): boolean => {
    if (!stdinOpen) return false;
    try {
      child.stdin.write(line.endsWith('\n') ? line : `${line}\n`);
      touch();
      return true;
    } catch {
      return false;
    }
  };

  const endStdin = (): void => {
    if (!stdinOpen) return;
    stdinOpen = false;
    try {
      child.stdin.end();
    } catch {
      // already gone
    }
  };

  let killTimer: NodeJS.Timeout | undefined;
  const interrupt = (): void => {
    stdinOpen = false;
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
    killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // gone
      }
    }, INTERRUPT_KILL_GRACE_MS);
    killTimer.unref?.();
  };

  const server: Server = createServer((socket: Socket) => {
    touch();
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      touch();
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
        if (!line.trim()) continue;
        let response: BrokerResponse;
        try {
          const parsed = brokerRequestSchema.safeParse(JSON.parse(line));
          response = parsed.success
            ? handle(parsed.data)
            : { ok: false, error: 'unrecognised control request' };
        } catch {
          response = { ok: false, error: 'malformed control request' };
        }
        socket.write(`${JSON.stringify(response)}\n`);
      }
    });
    // A dropped control connection is NORMAL — it is what a deploy looks like from here. The
    // broker must keep the agent running and keep spooling; the next server re-connects.
    socket.on('error', () => socket.destroy());
  });

  function handle(request: BrokerRequest): BrokerResponse {
    switch (request.op) {
      case 'send':
        return { ok: writeLine(JSON.stringify({ type: 'user', message: { role: 'user', content: request.content } })) };
      case 'sendRaw':
        return { ok: writeLine(request.line) };
      case 'end':
        endStdin();
        return { ok: true };
      case 'interrupt':
        interrupt();
        return { ok: true };
      case 'status':
        return { ok: true, pid: child.pid, open: stdinOpen };
    }
  }

  // A stale socket from a broker that died without cleaning up would make bind fail; the spool is
  // per-run and single-owner, so removing it is safe rather than a race.
  rmSync(paths.ctl, { force: true });
  const deafFault = readDeafFault();
  // A file marker rather than a counter: the broker is a separate process each launch, so nothing
  // in-process can remember "this is the second attempt." The marker's absence means this is the
  // first launch under the fault; its presence (left by that first launch) means a retry, which
  // must behave like a healthy broker so the run can actually recover.
  let markerWritten = false;
  if (deafFault && !existsSync(deafFault.markerPath)) {
    try {
      closeSync(openSync(deafFault.markerPath, 'w'));
      markerWritten = true;
    } catch {
      // Diagnostics must never wedge the broker: if the marker cannot be written, fail open into a
      // normal listen rather than silently never binding.
    }
  }
  if (deafFault && markerWritten && deafFault.mode === 'deaf-once') {
    process.exit(0);
  } else if (deafFault && markerWritten && deafFault.mode === 'deaf-alive') {
    // Skip the listen call and leave the process running — never bind, but stay alive. No
    // keepalive needed: the child's own stdio pipes hold the event loop open.
  } else {
    server.listen(paths.ctl);
  }

  const orphanMs = opts.orphanTimeoutMs ?? ORPHAN_TIMEOUT_MS;
  const watchdog = setInterval(() => {
    if (Date.now() - lastActivity < orphanMs) return;
    // Nothing has spoken to us and the agent has produced nothing for the whole window: the
    // server that owned this run is gone for good. Stop the agent rather than leak it.
    interrupt();
  }, Math.max(1_000, Math.min(orphanMs, 60_000)));
  watchdog.unref?.();

  const finished = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      clearInterval(watchdog);
      // Flush the tees before recording the exit: a server watching for `exit.json` must never
      // see it while output is still in flight, or it would stop reading early and lose the tail.
      const settle = (): void => {
        writeSpoolExit(opts.spoolDir, {
          code,
          signal,
          exitedAt: now(),
          brokerPid: process.pid,
          instanceId: opts.instanceId,
        });
        server.close();
        rmSync(paths.ctl, { force: true });
        resolve({ code, signal });
      };
      let pending = 2;
      const oneDone = (): void => {
        pending -= 1;
        if (pending === 0) settle();
      };
      outStream.end(oneDone);
      errStream.end(oneDone);
    });
  });

  return {
    finished,
    childPid: child.pid,
    async close() {
      interrupt();
      await finished;
    },
  };
}
