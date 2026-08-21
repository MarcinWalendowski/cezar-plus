import { startRunBroker } from './run-broker.ts';

/**
 * `cezar run-broker` — the CLI face of the run broker (P4 of
 * `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`).
 *
 * Hidden from `--help` on purpose: it is an internal process image, not a user-facing command. A
 * user has no reason to run it, and a broker started by hand would have no server tailing its
 * spool. It lives in the SAME binary as `serve` rather than as a second executable so a release
 * flip ships one artifact — a broker and a server from different releases would be exactly the
 * kind of skew the protocol version in `meta.json` exists to catch, and the cheapest way to never
 * hit it is to make them the same file.
 *
 * Argv is parsed by hand rather than through `node:util.parseArgs` because everything after `--`
 * is the backend's own command line, flags and all, and `parseArgs` in strict mode throws on the
 * first unrecognised one. The separator is the contract.
 */

export interface ParsedBrokerArgv {
  spoolDir: string;
  runId: string;
  backend: string;
  stepId?: string;
  cwd?: string;
  orphanTimeoutMs?: number;
  command: string[];
}

export class BrokerArgvError extends Error {}

/**
 * Parse `--spool <dir> --run <id> [--backend <id>] [--step <id>] [--cwd <dir>] -- <argv…>`.
 *
 * Everything after the first bare `--` is handed through untouched.
 */
export function parseBrokerArgv(argv: string[]): ParsedBrokerArgv {
  const separator = argv.indexOf('--');
  if (separator < 0) throw new BrokerArgvError('run-broker: missing `--` before the backend command');
  const flags = argv.slice(0, separator);
  const command = argv.slice(separator + 1);
  if (command.length === 0) throw new BrokerArgvError('run-broker: no backend command after `--`');

  const read = (name: string): string | undefined => {
    const at = flags.indexOf(name);
    if (at < 0) return undefined;
    const value = flags[at + 1];
    if (value === undefined || value.startsWith('--')) throw new BrokerArgvError(`run-broker: ${name} needs a value`);
    return value;
  };

  const spoolDir = read('--spool');
  const runId = read('--run');
  if (!spoolDir) throw new BrokerArgvError('run-broker: --spool is required');
  if (!runId) throw new BrokerArgvError('run-broker: --run is required');

  const orphanRaw = read('--orphan-timeout-ms');
  const orphanTimeoutMs = orphanRaw === undefined ? undefined : Number(orphanRaw);
  if (orphanTimeoutMs !== undefined && !Number.isFinite(orphanTimeoutMs)) {
    throw new BrokerArgvError('run-broker: --orphan-timeout-ms must be a number');
  }

  return {
    spoolDir,
    runId,
    backend: read('--backend') ?? 'claude',
    stepId: read('--step'),
    cwd: read('--cwd'),
    orphanTimeoutMs,
    command,
  };
}

/**
 * Run a broker to completion. Resolves with the exit code this process should carry.
 *
 * The broker's exit code deliberately MIRRORS the backend's: a supervisor (systemd scope, or a
 * human reading `systemctl status`) should see the agent's outcome, not the babysitter's. A signal
 * death is reported as 128+n, the shell convention, so it is distinguishable from a clean low exit
 * code.
 */
export async function runBrokerCommand(argv: string[]): Promise<number> {
  let parsed: ParsedBrokerArgv;
  try {
    parsed = parseBrokerArgv(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  const broker = startRunBroker({
    spoolDir: parsed.spoolDir,
    runId: parsed.runId,
    stepId: parsed.stepId,
    backend: parsed.backend,
    command: parsed.command,
    cwd: parsed.cwd,
    env: process.env,
    orphanTimeoutMs: parsed.orphanTimeoutMs,
  });

  const { code, signal } = await broker.finished;
  if (signal) return 128 + (signalNumber(signal) ?? 0);
  return code ?? 0;
}

/** Minimal signal→number map for the 128+n convention. Unknown signals contribute 0, which still
 *  yields a non-zero 128 rather than pretending the run succeeded. */
function signalNumber(signal: string): number | undefined {
  const table: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
  return table[signal];
}
