import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  DEFAULT_LINK_PATH,
  DEFAULT_RELEASES_DIR,
  describeReleases,
  readDeployLog,
  runReleaseDeploy,
  type ReleaseDeployHost,
} from './release-deploy.ts';
import { activate, freshLedger, isMigrated, makeReleaseId, recordBuilt, releaseDir, saveLedger } from './releases.ts';
import { cezarRunsSlice, cezarSocketUnit, nonDisruptiveDropIn } from './platforms/hetzner/socket-unit.ts';
import type { DeployStrategy } from './deploy-strategy.ts';

/**
 * The CLI faces of P1–P5 (`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`):
 * `cezar server-deploy --strategy=blue-green|--rollback` and the one-shot
 * `cezar server-migrate-releases`.
 *
 * The migration is a separate command rather than a `server-install` step because the box this
 * spec was written from is **hand-provisioned** — its `cezar.service` has a Description no
 * generator in this repo emits, and it carries three operator drop-ins holding the Cloudflare
 * token, the 1Password service-account token and the agent env passthrough. Rewriting that unit to
 * install socket activation would mean reproducing a file this repo never authored, over
 * credentials it must not disturb. So the migration only ADDS: a release layout around the
 * existing install, a new `[Socket]` unit, a numbered drop-in, and a slice. Running it twice
 * changes nothing the second time.
 */

export interface ReleaseDeployCliOptions {
  strategy: string;
  /** `undefined` = not a rollback; `''` = roll back to `previous`; a value = that release. */
  rollback?: string;
  follow?: boolean;
  source: string;
  linkPath?: string;
  releasesDir?: string;
  releaseId?: string;
  unit?: string;
  port?: number;
  sha?: string;
  note?: string;
  dryRun?: boolean;
}

const STRATEGIES = new Set(['restart', 'blue-green']);

export async function releaseDeployCommand(opts: ReleaseDeployCliOptions, host?: ReleaseDeployHost): Promise<number> {
  if (!STRATEGIES.has(opts.strategy)) {
    console.error(`unknown --strategy: ${opts.strategy} (valid: restart, blue-green)`);
    return 1;
  }
  // `--follow --release-id <id>` with nothing else is a READ: attach to a deploy already running
  // in its transient unit. That is the normal way to watch a self-deploy, because the process that
  // launched it may itself have been restarted by the deploy it started.
  if (opts.follow && opts.releaseId) return followDeploy(opts.releaseId);

  const linkPath = opts.linkPath ?? DEFAULT_LINK_PATH;
  const releasesDir = opts.releasesDir ?? DEFAULT_RELEASES_DIR;

  const result = await runReleaseDeploy(
    {
      source: opts.source,
      linkPath,
      releasesDir,
      ...(opts.unit ? { unitName: opts.unit } : {}),
      ...(opts.port ? { port: opts.port } : {}),
      strategy: opts.strategy as DeployStrategy,
      ...(opts.rollback !== undefined ? { rollbackTo: opts.rollback } : {}),
      ...(opts.sha ? { sha: opts.sha } : { sha: gitSha(opts.source) }),
      ...(opts.note ? { note: opts.note } : {}),
      ...(opts.dryRun ? { dryRun: true } : {}),
      version: packageVersion(opts.source),
    },
    host,
  );

  if (result.detachedUnit) {
    console.log(`\n  Deploy is running outside this process so a restart cannot kill it.`);
    if (opts.follow) return followDeploy(result.detachedUnit);
    console.log(`  Follow it with: cezar server-deploy --follow --release-id ${result.detachedUnit}\n`);
    return 0;
  }
  const rollback = result.outcome?.operation === 'rollback' || opts.rollback !== undefined;
  if (!result.ok && rollback && result.outcome?.failedAt === 'readiness' && result.outcome.serving) {
    const outcome = result.outcome;
    const serving = outcome.serving!;
    console.error(`\n  Rollback FAILED: ${outcome.releaseId} did not become ready: ${outcome.detail ?? 'readiness probe failed'}`);
    if (serving.releaseId === outcome.releaseId) {
      const restoring = serving.detail?.match(/; restoring (.+) failed: (.+)$/);
      if (restoring) {
        console.error(`  Restored ${restoring[1]}, but the restart itself failed: ${restoring[2]}. NOTHING is serving a proven release.`);
      } else {
        console.error(`  ${linkPath} still points at ${outcome.releaseId}, and it is NOT serving.`);
        console.error('  Pick another release: cezar server-deploy --rollback=<other-id>');
      }
    } else if (serving.ready) {
      console.error(`  Restored ${serving.releaseId}, which probed ready. The box is serving again, on the release you tried to leave.`);
    } else {
      console.error(`  Restored ${serving.releaseId}; it is NOT ready either: ${serving.detail ?? 'readiness probe failed'}`);
      console.error('  NOTHING is serving a proven release. Intervene by hand.');
    }
    return 1;
  }
  if (!result.ok) {
    console.error(`\n  Deploy failed: ${result.error ?? 'unknown'}`);
    if (result.outcome?.rolledBackTo) {
      console.error(`  Rolled back to ${result.outcome.rolledBackTo}; the previous release is serving.`);
    } else if (result.outcome?.failedAt === 'smoke_boot') {
      console.error('  Nothing was flipped and nothing was restarted — the running release is untouched.');
    }
    return 1;
  }
  if (opts.dryRun) {
    console.log('\n  Dry run complete — nothing was staged, flipped or restarted.');
    for (const line of describeReleases(releasesDir, linkPath)) console.log(`  ${line}`);
    console.log('');
    return 0;
  }
  if (rollback && result.outcome?.serving?.ready) {
    console.log(`\n  Rolled back to ${result.outcome.serving.releaseId}: /api/v1/ready passed.`);
  } else {
    console.log('\n  Deploy complete.');
  }
  for (const line of describeReleases(releasesDir, linkPath)) console.log(`  ${line}`);
  console.log('');
  return 0;
}

/** Tail a transient deploy's log until the unit is gone. */
async function followDeploy(releaseId: string): Promise<number> {
  let printed = 0;
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const text = readDeployLog(releaseId);
    if (text.length > printed) {
      process.stdout.write(text.slice(printed));
      printed = text.length;
    }
    const active = spawnSync('systemctl', ['is-active', `cezar-deploy-${releaseId}`], { encoding: 'utf8' });
    if (active.stdout.trim() !== 'active' && printed > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return 0;
}

export interface MigrateReleasesOptions {
  linkPath?: string;
  releasesDir?: string;
  unit?: string;
  port?: number;
  bindHost?: string;
  /** Without this the command only PRINTS what it would do. */
  apply?: boolean;
  /** Where unit files go. A seam for tests — production never passes it. */
  systemdDir?: string;
  /**
   * The source checkout being deployed. Its top-level entries define what legitimately belongs in
   * the install path, so the stray-entry guard stops drifting as the repo gains files.
   */
  source?: string;
}

/**
 * Turn `/opt/cezar` from a directory into a release symlink, and install the socket/slice units.
 *
 * The order is chosen so an interruption at any point leaves a working box:
 *  1. move the existing install aside into `<releases>/<id>` (a rename within `/opt`, so atomic);
 *  2. create the symlink at the old path — from here on every existing absolute path resolves
 *     again, which is why nothing else on the box has to change;
 *  3. write the ledger naming that release `current`;
 *  4. write the units, which do nothing until systemd is reloaded and they are enabled.
 *
 * Step 2 is the only window, and it is a single `symlinkSync` between two renames.
 */
export async function migrateReleasesCommand(opts: MigrateReleasesOptions): Promise<number> {
  const linkPath = opts.linkPath ?? DEFAULT_LINK_PATH;
  const releasesDir = opts.releasesDir ?? DEFAULT_RELEASES_DIR;
  const unit = opts.unit ?? 'cezar.service';
  const port = opts.port ?? 4321;
  const bindHost = opts.bindHost ?? '127.0.0.1';
  const plan: string[] = [];
  const actions: Array<() => void> = [];

  if (!existsSync(linkPath)) {
    console.error(`${linkPath} does not exist — nothing to migrate. Install cezar first.`);
    return 1;
  }

  if (isMigrated(linkPath)) {
    plan.push(`${linkPath} is already a symlink — leaving the release layout alone.`);
  } else {
    const stray = unexpectedEntries(linkPath, (p) => readdirSync(p), opts.source);
    if (stray.length > 0) {
      // The spec's own requirement: `/opt/cezar/.ai/` is a build-time leftover and `.deployed-commit`
      // becomes a derived ledger field. Anything ELSE unaccounted for might be state someone is
      // relying on, and moving it into a release directory would make it disappear on the next
      // prune.
      console.error(`Refusing to migrate: ${linkPath} holds entries that are not part of a build:`);
      for (const entry of stray) console.error(`  ${entry}`);
      console.error('Move them out (or delete them) and run again — a release directory is pruned, and anything left here would go with it.');
      return 1;
    }
    const id = makeReleaseId(new Date().toISOString(), readDeployedCommit(linkPath));
    const target = releaseDir(releasesDir, id);
    plan.push(`move ${linkPath} → ${target}`);
    plan.push(`symlink ${linkPath} → ${target}`);
    plan.push(`write ${join(releasesDir, 'deploy.json')} naming ${id} current`);
    actions.push(() => {
      mkdirSync(releasesDir, { recursive: true });
      renameSync(linkPath, target);
      symlinkSync(target, linkPath);
      const ledger = activate(
        recordBuilt(freshLedger(), { id, builtAt: new Date().toISOString(), note: 'migrated from the pre-release layout' }),
        id,
        new Date().toISOString(),
      );
      saveLedger(releasesDir, ledger);
    });
  }

  const systemdDir = opts.systemdDir ?? '/etc/systemd/system';
  const units: Array<{ path: string; body: string }> = [
    { path: join(systemdDir, socketUnitName(unit)), body: cezarSocketUnit({ bindHost, port, serviceUnit: unit }) },
    // A numbered drop-in, never a unit rewrite: `10-cloudflare.conf`, `20-onepassword.conf` and
    // `30-agent-passthrough.conf` already live in this directory and hold real credentials.
    { path: join(systemdDir, `${unit}.d`, '40-non-disruptive.conf'), body: nonDisruptiveDropIn({ socketUnit: socketUnitName(unit) }) },
    { path: join(systemdDir, 'cezar-runs.slice'), body: cezarRunsSlice() },
  ];
  for (const file of units) {
    if (fileHas(file.path, file.body)) {
      plan.push(`${file.path} is already current`);
      continue;
    }
    plan.push(`write ${file.path}`);
    actions.push(() => {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.body, { encoding: 'utf8', mode: 0o644 });
      chmodSync(file.path, 0o644);
    });
  }

  console.log('\n  Non-disruptive deploy migration plan:');
  for (const line of plan) console.log(`    - ${line}`);
  if (!opts.apply) {
    console.log('\n  Nothing was changed. Re-run with --yes to apply, then:');
    console.log(`    systemctl daemon-reload && systemctl enable --now ${socketUnitName(unit)} && systemctl restart ${unit}`);
    console.log('    loginctl enable-linger cezar   # so run brokers get their own scopes\n');
    return 0;
  }
  for (const action of actions) action();
  console.log('\n  Applied. Now run:');
  console.log(`    systemctl daemon-reload && systemctl enable --now ${socketUnitName(unit)} && systemctl restart ${unit}`);
  console.log('    loginctl enable-linger cezar\n');
  return 0;
}

export function socketUnitName(serviceUnit: string): string {
  return `${serviceUnit.replace(/\.service$/, '')}.socket`;
}

/** Everything under the install path that a BUILD would not have put there. */
/**
 * Entries in the install path that are NOT part of a build.
 *
 * The guard matters because a release directory is PRUNED: anything sitting in the install path
 * when it is moved into `<releases>/<id>` is deleted with that release later. Operator data left
 * there — a hand-written note, a deploy log — would vanish weeks after the fact, which is the
 * worst shape a data-loss bug can take.
 *
 * **CORRECTED 2026-08-21, caught by a dry run against the real box.** This was a hardcoded
 * allowlist and it was WRONG in the expensive direction: it omitted `AGENT_PROTOCOL.md`,
 * `CODE_REVIEW.md`, `SDLC.md`, `.env.example`, `.github` and `alias-cezar` — all tracked files a
 * normal build tree contains — so the migration refused a perfectly healthy install and the
 * operator's very first command failed. A static list is also wrong by construction: it silently
 * drifts every time the repo gains a top-level file, and the failure only shows up on the box.
 *
 * So the expected set is DERIVED: whatever the source checkout has at its top level is by
 * definition part of a build, plus the few things a build or a deploy creates that the source does
 * not have (`node_modules`, `.ai`, `.deployed-commit`). Genuine cruft — `*.bak.*`,
 * `.deploy-verify-*.log`, hand-written notes — is still flagged, because it is in neither set.
 *
 * `sourceRoot` is optional so the guard degrades to the static core rather than passing everything
 * when the source is unavailable: refusing too much is recoverable by hand, deleting an operator's
 * file is not.
 */
export function unexpectedEntries(
  linkPath: string,
  read: (p: string) => string[] = (p) => readdirSync(p),
  sourceRoot?: string,
): string[] {
  // Created by a build or a deploy, so never present in the source checkout.
  const expected = new Set(['.ai', '.deployed-commit', '.git', 'node_modules']);
  if (sourceRoot) {
    try {
      for (const entry of read(sourceRoot)) expected.add(entry);
    } catch {
      // Unreadable source — fall back to the static core below.
    }
  }
  // The static core stays as the floor for the no-sourceRoot case.
  for (const entry of [
    '.gitignore',
    '.npmrc',
    'AGENTS.md',
    'BACKWARD_COMPATIBILITY.md',
    'CHANGELOG.md',
    'LICENSE',
    'README.md',
    'docs',
    'package-lock.json',
    'package.json',
    'packages',
    'scripts',
    'tsconfig.json',
    'tsconfig.base.json',
    'vitest.config.ts',
    'vitest.workspace.ts',
  ]) {
    expected.add(entry);
  }
  try {
    return read(linkPath).filter((entry) => !expected.has(entry));
  } catch {
    return [];
  }
}

function readDeployedCommit(linkPath: string): string | undefined {
  try {
    const raw = readFileSync(join(linkPath, '.deployed-commit'), 'utf8').trim();
    const sha = /^[0-9a-f]{7,40}/.exec(raw)?.[0];
    return sha;
  } catch {
    return undefined;
  }
}

function fileHas(path: string, body: string): boolean {
  try {
    return readFileSync(path, 'utf8') === body;
  } catch {
    return false;
  }
}

function gitSha(source: string): string | undefined {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function packageVersion(source: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(source, 'packages', 'cezar', 'package.json'), 'utf8')) as { version?: string }).version;
  } catch {
    return undefined;
  }
}
