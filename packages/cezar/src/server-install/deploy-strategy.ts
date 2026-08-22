import { existsSync } from 'node:fs';

import {
  activate,
  flipSymlink,
  loadLedger,
  markHealthy,
  prunable,
  recordBuilt,
  releaseDir,
  removeRelease,
  rollbackTarget,
  saveLedger,
  type ReleaseEntry,
  type ReleaseLedger,
} from './releases.ts';

/**
 * Health-gated deploy with auto-rollback (P5 of
 * `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`).
 *
 * The vector this closes: today `verifyStep` runs AFTER `systemctl restart`, so a broken build is
 * already serving — or crash-looping under `Restart=on-failure` — before anything notices. The
 * order here is inverted: prove the candidate boots BEFORE it becomes `current`, and if it fails
 * after the flip, put the old one back without a human in the loop.
 *
 * The orchestration is expressed as pure state transitions over injected effects, so every branch
 * — including the ones that only happen when a deploy is going wrong — is testable without a box,
 * a systemd, or a real restart. The privileged effects (build, smoke boot, restart, probe) are
 * supplied by the caller.
 */

export const DEPLOY_STRATEGIES = ['restart', 'blue-green'] as const;
export type DeployStrategy = (typeof DEPLOY_STRATEGIES)[number];

/** Analytics, named up front per the workspace rule. `cutover` carries the two numbers that ARE
 *  the definition of non-disruptive: the client-observed gap and how many runs survived it. */
export type DeployEventName =
  | 'deploy.started'
  | 'deploy.release_built'
  | 'deploy.instance_ready'
  | 'deploy.cutover'
  | 'deploy.drained'
  | 'deploy.rollback';

export interface DeployEvent {
  name: DeployEventName;
  releaseId?: string;
  version?: string;
  sha?: string;
  strategy: DeployStrategy;
  /** `deploy.cutover` only — max client-observed latency across the swap. */
  gapMs?: number;
  /** `deploy.cutover` only — runs live at the moment of the flip. */
  inflightRuns?: number;
  /** `deploy.rollback` only. */
  reason?: string;
  failedAt?: 'smoke_boot' | 'readiness';
  /** Whether this was emitted by deploy recovery or an explicit rollback command. */
  operation?: 'deploy' | 'rollback';
  /** `deploy.rollback` only: whether a readiness probe proved this release ready. */
  ready?: boolean;
}

export interface ProbeResult {
  ok: boolean;
  detail?: string;
}

/** Everything privileged, injected so the orchestration itself stays pure. */
export interface DeployEffects {
  /** Stage a built tree into `releaseDir`. Throws to abort before anything is live. */
  stage(releaseDir: string, releaseId: string): Promise<void>;
  /**
   * Boot the candidate in isolation and probe it.
   *
   * MUST use a throwaway `CEZ_HOME` and a throwaway project dir. This is not hygiene: there is no
   * single-writer lock on `.ai/cezar/`, and `RunStore` is an in-memory map flushed wholesale — a
   * second process pointed at the real state dir would overwrite everything the live one wrote.
   */
  smokeBoot(releaseDir: string): Promise<ProbeResult>;
  /** Restart the service so it picks up the newly flipped symlink. */
  restart(): Promise<void>;
  /** Deep readiness probe against the live port (`/api/v1/ready`). */
  probeReady(): Promise<ProbeResult>;
  emit(event: DeployEvent): void;
  now(): string;
  /** Runs live at cutover — recorded, not gated on. */
  inflightRuns?(): number;
}

export interface DeployRequest {
  releasesDir: string;
  /** Stable install path — the symlink every other file on the box points through. */
  linkPath: string;
  entry: ReleaseEntry;
  strategy?: DeployStrategy;
}

export interface DeployOutcome {
  ok: boolean;
  releaseId: string;
  ledger: ReleaseLedger;
  /** Set when the deploy rolled back or refused to flip. */
  failedAt?: 'smoke_boot' | 'readiness';
  rolledBackTo?: string;
  detail?: string;
  operation?: 'deploy' | 'rollback';
  /** The release selected when an explicit rollback returns, and its measured readiness. */
  serving?: { releaseId: string; ready: boolean; detail?: string };
}

/**
 * Run a health-gated deploy.
 *
 * Sequence, and every step is ordered to fail closed:
 *  1. stage into a NEW release dir — nothing live has changed yet;
 *  2. smoke-boot the candidate in isolation; a failure here NEVER flips and never restarts;
 *  3. flip the symlink atomically and restart;
 *  4. probe readiness; a failure here flips back to `previous` and restarts again.
 *
 * A rollback is itself just a symlink flip plus a restart, so it inherits exactly the same gapless
 * machinery (socket activation, drain) as the deploy — recovering is not a more dangerous
 * operation than the thing that broke.
 */
export async function runGatedDeploy(request: DeployRequest, fx: DeployEffects): Promise<DeployOutcome> {
  const strategy = request.strategy ?? 'blue-green';
  const { releasesDir, linkPath, entry } = request;
  const id = entry.id;

  fx.emit({ name: 'deploy.started', releaseId: id, version: entry.version, sha: entry.sha, strategy });

  const dir = releaseDir(releasesDir, id);
  await fx.stage(dir, id);
  let ledger = recordBuilt(loadLedger(releasesDir), { ...entry, builtAt: entry.builtAt ?? fx.now() });
  saveLedger(releasesDir, ledger);
  fx.emit({ name: 'deploy.release_built', releaseId: id, version: entry.version, sha: entry.sha, strategy });

  // ---- gate 1: prove it boots BEFORE it is live ------------------------------------------------
  const smoke = await fx.smokeBoot(dir);
  if (!smoke.ok) {
    ledger = markHealthy(ledger, id, false);
    saveLedger(releasesDir, ledger);
    fx.emit({
      name: 'deploy.rollback',
      releaseId: id,
      strategy,
      failedAt: 'smoke_boot',
      operation: 'deploy',
      reason: smoke.detail ?? 'smoke boot failed',
    });
    // Nothing was flipped and nothing was restarted — the running release is untouched.
    return { ok: false, releaseId: id, ledger, failedAt: 'smoke_boot', detail: smoke.detail };
  }
  fx.emit({ name: 'deploy.instance_ready', releaseId: id, strategy });

  // ---- cutover ---------------------------------------------------------------------------------
  const previous = ledger.current;
  flipSymlink(linkPath, dir);
  ledger = activate(ledger, id, fx.now());
  saveLedger(releasesDir, ledger);
  const startedAt = Date.now();
  await fx.restart();
  fx.emit({
    name: 'deploy.cutover',
    releaseId: id,
    strategy,
    gapMs: Date.now() - startedAt,
    inflightRuns: fx.inflightRuns?.(),
  });

  // ---- gate 2: readiness, with auto-rollback ---------------------------------------------------
  const ready = await fx.probeReady();
  if (!ready.ok) {
    ledger = markHealthy(ledger, id, false);
    const target = previous && previous !== id ? previous : rollbackTarget(ledger);
    if (target) {
      flipSymlink(linkPath, releaseDir(releasesDir, target));
      ledger = activate(ledger, target, fx.now());
      saveLedger(releasesDir, ledger);
      await fx.restart();
    } else {
      saveLedger(releasesDir, ledger);
    }
    fx.emit({
      name: 'deploy.rollback',
      releaseId: id,
      strategy,
      failedAt: 'readiness',
      operation: 'deploy',
      reason: ready.detail ?? 'readiness probe failed',
    });
    return {
      ok: false,
      releaseId: id,
      ledger,
      failedAt: 'readiness',
      rolledBackTo: target ?? undefined,
      detail: ready.detail,
    };
  }

  ledger = markHealthy(ledger, id, true);
  // Prune only after a release is PROVEN healthy: pruning on the way in could delete the very
  // tree a failed readiness probe is about to need.
  for (const stale of prunable(ledger)) removeRelease(releasesDir, stale);
  ledger = { ...ledger, releases: ledger.releases.filter((r) => !prunable(ledger).includes(r.id)) };
  saveLedger(releasesDir, ledger);
  fx.emit({ name: 'deploy.drained', releaseId: id, strategy });
  return { ok: true, releaseId: id, ledger };
}

/** Explicit `--rollback`: flip to `previous` (or a named release) and restart. */
export async function runRollback(
  request: { releasesDir: string; linkPath: string; to?: string },
  fx: Pick<DeployEffects, 'restart' | 'emit' | 'now' | 'probeReady'>,
): Promise<DeployOutcome> {
  let ledger = loadLedger(request.releasesDir);
  const target = request.to ?? rollbackTarget(ledger);
  if (!target) {
    return { ok: false, releaseId: ledger.current ?? '', ledger, detail: 'no previous release to roll back to' };
  }
  if (!ledger.releases.some((release) => release.id === target)) {
    return { ok: false, releaseId: target, ledger, operation: 'rollback', detail: `release ${target} is not in the ledger` };
  }
  const targetDir = releaseDir(request.releasesDir, target);
  if (!existsSync(targetDir)) {
    return {
      ok: false,
      releaseId: target,
      ledger,
      operation: 'rollback',
      detail: `release ${target} has no directory under ${request.releasesDir}`,
    };
  }

  const before = ledger.current;
  flipSymlink(request.linkPath, targetDir);
  ledger = activate(ledger, target, fx.now());
  saveLedger(request.releasesDir, ledger);
  await fx.restart();
  const ready = await fx.probeReady();
  ledger = markHealthy(ledger, target, ready.ok);
  saveLedger(request.releasesDir, ledger);
  fx.emit({
    name: 'deploy.rollback',
    releaseId: target,
    strategy: 'blue-green',
    operation: 'rollback',
    ready: ready.ok,
    ...(ready.ok ? {} : { failedAt: 'readiness' as const }),
    reason: ready.ok ? 'manual rollback' : (ready.detail ?? 'readiness probe failed'),
  });
  if (ready.ok) {
    return {
      ok: true,
      releaseId: target,
      ledger,
      operation: 'rollback',
      rolledBackTo: target,
      serving: { releaseId: target, ready: true },
    };
  }

  const beforeRow = before ? ledger.releases.find((release) => release.id === before) : undefined;
  const restore = before && before !== target && beforeRow && beforeRow.healthy !== false ? before : null;
  if (!restore) {
    return {
      ok: false,
      releaseId: target,
      ledger,
      operation: 'rollback',
      failedAt: 'readiness',
      detail: ready.detail,
      serving: { releaseId: target, ready: false, ...(ready.detail ? { detail: ready.detail } : {}) },
    };
  }

  try {
    flipSymlink(request.linkPath, releaseDir(request.releasesDir, restore));
    ledger = activate(ledger, restore, fx.now());
    saveLedger(request.releasesDir, ledger);
    await fx.restart();
    const restored = await fx.probeReady();
    ledger = markHealthy(ledger, restore, restored.ok);
    saveLedger(request.releasesDir, ledger);
    fx.emit({
      name: 'deploy.rollback',
      releaseId: restore,
      strategy: 'blue-green',
      operation: 'rollback',
      ready: restored.ok,
      ...(restored.ok ? {} : { failedAt: 'readiness' as const }),
      reason: 'restored after a failed manual rollback',
    });
    return {
      ok: false,
      releaseId: target,
      ledger,
      operation: 'rollback',
      failedAt: 'readiness',
      ...(restored.ok ? { rolledBackTo: restore } : {}),
      detail: ready.detail,
      serving: { releaseId: restore, ready: restored.ok, ...(restored.detail ? { detail: restored.detail } : {}) },
    };
  } catch (error) {
    const restoreError = error instanceof Error ? error.message : String(error);
    const detail = `${ready.detail ?? 'readiness probe failed'}; restoring ${restore} failed: ${restoreError}`;
    return {
      ok: false,
      releaseId: target,
      ledger,
      operation: 'rollback',
      failedAt: 'readiness',
      detail: ready.detail,
      serving: { releaseId: target, ready: false, detail },
    };
  }
}
