import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BrokerIsolation } from './broker-isolation.ts';

/**
 * Where the `cezar run-broker` process image comes from, and when brokering is allowed to happen
 * at all (P4 of `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`).
 *
 * Split out from the runner because it answers a question the runner should not have to: "can this
 * installation spawn a second copy of cezar?". The answer is a property of how cezar was STARTED,
 * not of the run being launched.
 *
 * The rule, and the reason it is a rule rather than a flag: the broker must be the SAME artifact
 * as the server, so a release flip can never leave a broker from one version tailing a spool a
 * server from another version wrote. The cheapest way to guarantee that is to re-exec this
 * package's own built entry point — which exists only in a BUILT tree. Running from TypeScript
 * sources (`tsx`, vitest, `npm run dev`) there is no `dist/index.js` to exec, and spawning
 * `node src/index.ts` would simply fail. So source mode reports "unavailable" and every run takes
 * the in-process path exactly as it always has: local development and the whole test suite are
 * untouched by this feature, and production — which only ever runs `dist` — gets it by default.
 */

/**
 * `CEZ_RUN_BROKER` — the operator override.
 *
 * `0` disables brokering even in a built tree (the escape hatch if a broker ever misbehaves in
 * production: one drop-in edit and a restart returns to the in-process path). `1` states the
 * intent explicitly, which is what the box's unit drop-in sets, but it cannot conjure an entry
 * point that is not there — an unbuilt tree still reports unavailable rather than failing every
 * run at spawn time.
 */
export function brokerPreference(env: NodeJS.ProcessEnv = process.env): 'on' | 'off' | 'auto' {
  const raw = env.CEZ_RUN_BROKER?.trim();
  if (raw === '0') return 'off';
  if (raw === '1') return 'on';
  return 'auto';
}

/**
 * The argv prefix that runs a broker — `[node, <cezar entry>, 'run-broker']` — or `null` when this
 * process has no built entry point to re-exec.
 *
 * `import.meta.url` is `<pkg>/dist/core/broker-launch.js` in a built tree and
 * `<pkg>/src/core/broker-launch.ts` under tsx, so the sibling `index.js` resolves to
 * `dist/index.js` and `src/index.js` respectively — and only the first of those exists. That
 * asymmetry IS the availability test; no environment sniffing required.
 */
export function resolveBrokerCommand(): string[] | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = resolvePath(here, '..', 'index.js');
  if (!existsSync(entry)) return null;
  return [process.execPath, entry, 'run-broker'];
}

/** True when a run may be brokered: the operator has not disabled it and an entry point exists. */
export function brokerAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (brokerPreference(env) === 'off') return false;
  return resolveBrokerCommand() !== null;
}

/**
 * The backends whose runs are brokered today, for `/api/v1/health` to report.
 *
 * `claude` only, and that is a decision rather than an omission (spec, "Backend scope"): `codex`
 * speaks JSON-RPC over a bidirectional app-server transport and `opencode` runs its own HTTP
 * server, so neither has a stdout pipe of the shape a spool replaces. They keep today's
 * interrupt-and-continue behaviour. Reporting the list means an operator can SEE which runs a
 * deploy will survive rather than inferring it.
 */
export const BROKERED_BACKENDS = ['claude'] as const;

/** Build the broker's own argv tail: its flags, then `--`, then the backend command. */
export function brokerArgs(opts: {
  spoolDir: string;
  runId: string;
  instanceId: string;
  stepId?: string;
  backend: string;
  cwd?: string;
  command: string[];
}): string[] {
  const args = ['--spool', opts.spoolDir, '--run', opts.runId, '--instance', opts.instanceId, '--backend', opts.backend];
  if (opts.stepId) args.push('--step', opts.stepId);
  if (opts.cwd) args.push('--cwd', opts.cwd);
  return [...args, '--', ...opts.command];
}

/**
 * What `RunManager` hands a runner to make one session brokered.
 *
 * `startOffset` is the entire re-attach contract in one number: absent (or 0) starts a fresh
 * spool, and a value resumes an EXISTING one at exactly the byte the previous server process had
 * finished consuming — replaying the remainder with no gap and no duplicate.
 */
export interface BrokerSessionRequest {
  /** `<dataDir>/runs/<runId>.spool/<instanceId>`. */
  spoolDir: string;
  runId: string;
  /** Present for a fresh launch, absent only while adopting a protocol-1 spool. */
  instanceId?: string;
  stepId?: string;
  /** Byte offset into `out.ndjson` to resume from. Only a re-attach sets this. */
  startOffset?: number;
  /** Called after each consumed batch so the caller can persist the offset. */
  onOffset?: (offset: number) => void;
  /** Where to put the broker's cgroup; defaults to `none` (no relocation). */
  isolation?: BrokerIsolation;
}
