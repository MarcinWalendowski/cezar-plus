import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { formatRunStats, readRunStats } from './stats.ts';

/**
 * `cez run stats <runId> [--json] [--repo <dir>]` — the tool-economy meter
 * (spec `.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md`, Phase 1).
 *
 * Filesystem-only: it reads `<repo>/.ai/cezar/runs/<runId>.ndjson` and nothing else. No server,
 * no HTTP, no auth wall — same posture as `cez kb` and `cez todo`, and for the same reason: it
 * has to answer inside a running agent's Bash, where there is no cockpit to talk to.
 *
 * **Why this is routed from raw argv in `index.ts` rather than from the command switch.** `cez
 * run "<task>"` joins every positional into the task text, so `cez run stats <id>` would start a
 * run titled "stats <id>" — and the top-level `parseArgs` is strict, so `--json` would be
 * rejected as an unknown option long before the switch. `runs/stats-cli-wiring.test.ts` is what
 * keeps that dispatch honest; `knowledge/cli-wiring.test.ts` explains at length why a unit test
 * over this function proves nothing about reachability.
 */

export interface RunStatsCliIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

export interface RunStatsCliOptions {
  /** Repo root, resolved by the caller the same way `index.ts` resolves it for every other
   *  subcommand (git toplevel, falling back to cwd). `--repo` overrides it. */
  repoRoot: string;
  io?: RunStatsCliIo;
}

const defaultIo: RunStatsCliIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

const USAGE = `usage:
  cez run stats <runId> [--json] [--repo <dir>]

  Tool economy for one run, read from its NDJSON transcript:
  tool calls, model round trips, batch factor (calls per round trip),
  model time vs tool-execution time, and sub-agent calls — per step.

  batch factor 1.00 means the run never batched two calls into one turn.`;

/** `<repo>/.ai/cezar/runs/<runId>.ndjson` — the same path `RunStore` writes (`store.ts`). */
export function runNdjsonPath(repoRoot: string, runId: string): string {
  return join(repoRoot, '.ai/cezar', 'runs', `${runId}.ndjson`);
}

/**
 * Reject anything that could climb out of the runs directory. Run ids are UUIDs in practice and
 * the contract's own `runIdParamSchema` pins the same character class — restated here because
 * this entry point never goes near a route.
 */
function validRunId(runId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(runId) && runId.length <= 128;
}

export async function runRunStatsCommand(argv: string[], opts: RunStatsCliOptions): Promise<number> {
  const io = opts.io ?? defaultIo;

  let values: { json?: boolean; repo?: string; help?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        json: { type: 'boolean', default: false },
        repo: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
    }));
  } catch (err) {
    io.error(err instanceof Error ? err.message : String(err));
    io.error(USAGE);
    return 1;
  }

  if (values.help) {
    io.log(USAGE);
    return 0;
  }

  const runId = positionals[0];
  if (!runId) {
    io.error('cez run stats: a run id is required');
    io.error(USAGE);
    return 1;
  }
  if (!validRunId(runId)) {
    io.error(`cez run stats: invalid run id "${runId}"`);
    return 1;
  }

  const repoRoot = values.repo ? resolve(values.repo) : opts.repoRoot;
  const path = runNdjsonPath(repoRoot, runId);
  if (!existsSync(path)) {
    io.error(`cez run stats: no transcript for run ${runId} (looked in ${path})`);
    return 1;
  }

  let stats;
  try {
    stats = await readRunStats(path, runId);
  } catch (err) {
    io.error(`cez run stats: could not read ${path} — ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // A run with zero tool calls is VALID output (`batchFactor: 0`), not an error — a run that was
  // cancelled before its first turn still has a span worth printing.
  io.log(values.json ? JSON.stringify(stats, null, 2) : formatRunStats(stats));
  return 0;
}
