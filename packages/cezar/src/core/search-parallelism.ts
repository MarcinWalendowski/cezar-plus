/**
 * Shared derivation for two burst-bounding caps that must scale with the box, not be a constant
 * that is only correct on one machine (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`,
 * Phase 0 step 2 — "capped vitest workers and ripgrep threads"; plan package 0.5).
 *
 * Problem §2's measured shape is why both need this: a `run-tests` step alone goes from
 * ~0.5 GB / 1-8 processes at rest to 2.2-6.2 GB / 18-50 processes while testing, because
 * vitest's default pool forks roughly one worker per test file, and every agent search shells
 * out to ripgrep, which by default claims one thread per core. Neither number should be a
 * hardcoded constant: this repo's own fleet already spans three different core counts —
 * `prod-host` and a CX43-class worker are both 8 vCPU, the owner's Mac is 16 cores (spec
 * Problem §2a) — so a constant tuned for one is wrong on the others by 2x.
 *
 * `os.availableParallelism()` over `os.cpus().length`: the box gets `MemoryHigh`/`CPUWeight`
 * cgroup scopes per D14a (`core/broker-isolation.ts`), and `availableParallelism()` is
 * cgroup/cpuset-aware where `cpus().length` reports the host's raw core count regardless of any
 * quota placed on the process. Falls back to `cpus().length` only for defensiveness — this
 * package requires Node >=20 (`package.json` engines), and `availableParallelism` has shipped
 * since 19.4/18.15, so the fallback is not expected to fire in practice.
 */

import os from 'node:os';

export function detectedParallelism(): number {
  return typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
}

/**
 * HALF the box, floor 1 — not all of it, and not an absolute number.
 *
 * Phase 0's other new gate (`maxHeavySteps`, `workspace/semaphore.ts`) defaults to letting 2
 * heavy steps — `run-tests` among them — run at once on this box, because the measured 12.9%
 * heavy-step duty cycle (spec Problem §2) makes that safe. A vitest process or a ripgrep
 * invocation that claimed every core on its own would recreate the exact oversubscription
 * Phase 0 exists to remove the moment a second one starts beside it; budgeting half the box to
 * each keeps two concurrent claimants inside the machine's own ceiling instead of doubling past
 * it. Concretely: 4 on `prod-host` and a CX43 worker (8 vCPU), 8 on the owner's Mac
 * (16 cores) — the same box, worker and Mac split the spec cites throughout Problem §2a/§2b.
 */
export function halfParallelism(cpuCount: number = detectedParallelism()): number {
  return Math.max(1, Math.floor(cpuCount / 2));
}

/**
 * Read a positive-integer override from an already-resolved env value, else compute
 * `fallback()`. `raw` is a plain string (or `undefined`) rather than an env name, so callers
 * decide how to resolve it — `process.env.X` directly, or `agent-env.ts`'s case-insensitive
 * `readVar` for a value that must also survive Windows' `Path`/`PATH` spelling split.
 *
 * Mirrors `defaultIdleTimeoutMs` (`core/claude-cli-runner.ts`, `CEZ_RUN_IDLE_TIMEOUT_MS`): an
 * unparseable, empty, non-finite or sub-1 value is treated as unset rather than as the literal
 * number it failed to parse into — a typo in a shell profile must not silently collapse a
 * concurrency cap to `0` (which would mean "never runs" here, not "unbounded").
 */
export function positiveIntEnvOr(raw: string | undefined, fallback: () => number): number {
  if (raw !== undefined && raw.trim() !== '') {
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 1) return Math.floor(value);
  }
  return fallback();
}
