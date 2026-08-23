import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';

/**
 * Release layout + rollback ledger (P1 of spec
 * `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`).
 *
 * The install path `/opt/cezar` **becomes a symlink** into `/opt/cezar-releases/<id>/`, and
 * deliberately so rather than the more usual `<root>/current` subdirectory: every absolute path
 * already baked into this box points *through* `/opt/cezar` — the systemd unit's `ExecStart`, and
 * all three CLI wrappers in `/usr/local/bin` (`cez`, `cezar`, `cezar-cli`, each
 * `exec /usr/bin/node /opt/cezar/packages/cezar/dist/index.js "$@"`). Keeping `/opt/cezar` as the
 * stable NAME means a release flip changes no other file on the box, and the wrapper's own comment
 * ("depends only on the path, which is stable across deploys") stays true instead of becoming a
 * lie the next deploy tells.
 *
 * Everything here is pure or filesystem-only — no child processes, no systemd, no network — so the
 * ledger algebra is unit-testable without a box. The privileged half (staging a build, restarting
 * the unit) lives in the deploy strategy that calls these.
 */

/** Retained release directories. Five ≈ 2.5 GB at the current ~490 MB tree size.
 *  Declared before the schema that defaults to it — a `const` referenced from the schema's
 *  initializer is in the temporal dead zone if it is declared below, which throws at import. */
export const DEFAULT_KEEP = 5;

export const LEDGER_FILENAME = 'deploy.json';

/** One built release. Additive-safe: unknown fields written by a newer cezar survive a
 *  load→save round-trip, per the BACKWARD_COMPATIBILITY cross-version-state rule. */
export const releaseEntrySchema = z
  .object({
    id: z.string().min(1),
    /** Full commit sha the tree was built from. Optional: a hand-staged tree may have none. */
    sha: z.string().optional().catch(undefined),
    /** `packages/cezar/package.json` version at build time. */
    version: z.string().optional().catch(undefined),
    builtAt: z.string().optional().catch(undefined),
    dirty: z.boolean().optional().catch(undefined),
    stale: z.literal(true).optional().catch(undefined),
    /** Set when --allow-unrelated suppressed a divergent / unresolved / unreadable-ledger refusal —
     *  "this deploy was forced", not "the flag was typed". */
    unrelated: z.literal(true).optional().catch(undefined),
    /** The live-only commits `--allow-unrelated` overrode, exactly as printed at force time. */
    unrelatedLostCommits: z.string().optional().catch(undefined),
    /** Set the moment this release became `current`; absent means "built, never activated". */
    activatedAt: z.string().optional().catch(undefined),
    /** Free text — replaces the hand-written `.deployed-commit` marker no code ever owned. */
    note: z.string().optional().catch(undefined),
    /** Set by the post-flip readiness probe (P5). `false` is a release that flipped and failed;
     *  `undefined` is one nothing has judged yet. The two must stay distinguishable. */
    healthy: z.boolean().optional().catch(undefined),
  })
  .passthrough();
export type ReleaseEntry = z.infer<typeof releaseEntrySchema>;

/**
 * Per-entry salvage: one malformed release row must never evict the whole ledger, because the
 * ledger is the only thing that knows how to roll back. Same discipline the workspace registry
 * applies to `projects` — drop the bad row, keep the file.
 */
const releasesArraySchema = z.preprocess(
  (raw) => (Array.isArray(raw) ? raw.filter((e) => releaseEntrySchema.safeParse(e).success) : []),
  z.array(releaseEntrySchema).default([]),
);

/** `<releasesDir>/deploy.json`. */
export const releaseLedgerSchema = z
  .object({
    schema: z.literal(1).catch(1),
    /** Release id the symlink points at. */
    current: z.string().optional().catch(undefined),
    /** The one `--rollback` returns to. */
    previous: z.string().optional().catch(undefined),
    /** How many release directories to retain. `current`/`previous` are never pruned. */
    keep: z.number().int().positive().default(DEFAULT_KEEP).catch(DEFAULT_KEEP),
    releases: releasesArraySchema,
  })
  .passthrough();
export type ReleaseLedger = z.infer<typeof releaseLedgerSchema>;

/** Raised when the install path is a real directory rather than a symlink — i.e. the box has not
 *  been migrated to the release layout yet. Carries the path so the caller can name the fix. */
export class NotMigratedError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(
      `${path} is a real directory, not a release symlink — run the release-layout migration ` +
        `before flipping (see .ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md, P1).`,
    );
    this.name = 'NotMigratedError';
    this.path = path;
  }
}

export function freshLedger(): ReleaseLedger {
  return releaseLedgerSchema.parse({});
}

/**
 * `20260820T093000Z-67e93cca` — sortable, unique per build, and legible in `ls`. The timestamp
 * comes from the caller rather than `Date.now()` so a test can pin it; the sha is truncated to 8
 * because the ledger carries the full one.
 */
export function makeReleaseId(nowIso: string, sha?: string): string {
  const stamp = nowIso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const short = (sha ?? '').trim().slice(0, 8);
  return short ? `${stamp}-${short}` : stamp;
}

export function ledgerPath(releasesDir: string): string {
  return join(releasesDir, LEDGER_FILENAME);
}

/** Load, degrading to a fresh ledger on any corruption — the house pattern. A missing ledger and
 *  an unreadable one are the same thing to the caller: "nothing recorded yet". */
export function loadLedger(releasesDir: string): ReleaseLedger {
  let raw: string;
  try {
    raw = readFileSync(ledgerPath(releasesDir), 'utf8');
  } catch {
    return freshLedger();
  }
  try {
    const parsed = releaseLedgerSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // malformed JSON — fall through
  }
  return freshLedger();
}

/** Atomic write (tmp + rename), so a ledger is never observed half-written — including by a
 *  rollback that runs while the box is on fire, which is exactly when it is read. */
export function saveLedger(releasesDir: string, ledger: ReleaseLedger): void {
  mkdirSync(releasesDir, { recursive: true });
  const path = ledgerPath(releasesDir);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/** Record a freshly staged build. Re-recording the same id replaces its row rather than
 *  duplicating it, so a resumed deploy converges instead of growing the ledger. */
export function recordBuilt(ledger: ReleaseLedger, entry: ReleaseEntry): ReleaseLedger {
  const releases = ledger.releases.filter((r) => r.id !== entry.id);
  return { ...ledger, releases: [...releases, entry] };
}

/**
 * Promote `id` to `current`, demoting the outgoing `current` to `previous`.
 *
 * Re-activating the release that is already current is a no-op for `previous` — otherwise a
 * repeated deploy would set `previous === current` and quietly destroy the rollback target, which
 * is the one thing this ledger exists to protect.
 */
export function activate(ledger: ReleaseLedger, id: string, activatedAt: string): ReleaseLedger {
  const known = ledger.releases.some((r) => r.id === id);
  if (!known) throw new Error(`cannot activate unknown release ${id}`);
  const previous = ledger.current === id ? ledger.previous : ledger.current;
  return {
    ...ledger,
    current: id,
    previous,
    releases: ledger.releases.map((r) => (r.id === id ? { ...r, activatedAt } : r)),
  };
}

/** Stamp the readiness verdict onto a release. */
export function markHealthy(ledger: ReleaseLedger, id: string, healthy: boolean): ReleaseLedger {
  return { ...ledger, releases: ledger.releases.map((r) => (r.id === id ? { ...r, healthy } : r)) };
}

/** What `--rollback` would flip to, or null when there is nothing to go back to. */
export function rollbackTarget(ledger: ReleaseLedger): string | null {
  const target = ledger.previous;
  if (!target || target === ledger.current) return null;
  return ledger.releases.some((r) => r.id === target) ? target : null;
}

/**
 * Release ids safe to delete: oldest first, beyond `keep`, and never `current` or `previous`
 * whatever the count says. Pinning those two is not an optimization — pruning `previous` is
 * pruning the rollback path, and a `keep` of 1 must still leave the box recoverable.
 */
export function prunable(ledger: ReleaseLedger): string[] {
  const pinned = new Set([ledger.current, ledger.previous].filter(Boolean) as string[]);
  const ordered = [...ledger.releases].sort((a, b) => a.id.localeCompare(b.id));
  // Retained = the newest `keep` UNION the pinned pair. Computing the prune count as
  // `total - keep` instead (the first cut here) over-prunes whenever `previous` sits outside the
  // keep window: with 7 releases, keep=3 and previous=r1, it wanted to drop four and took r5 —
  // a release inside the window it had just promised to retain.
  const newest = new Set(ordered.slice(-ledger.keep).map((r) => r.id));
  return ordered.filter((r) => !pinned.has(r.id) && !newest.has(r.id)).map((r) => r.id);
}

/** Where a release's tree lives. */
export function releaseDir(releasesDir: string, id: string): string {
  return join(releasesDir, id);
}

/** The symlink's current target, or null when the path is missing or not a symlink. */
export function currentTarget(linkPath: string): string | null {
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) return null;
    return readlinkSync(linkPath);
  } catch {
    return null;
  }
}

/** True when `linkPath` is already a symlink — i.e. the box has been migrated. */
export function isMigrated(linkPath: string): boolean {
  try {
    return lstatSync(linkPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Point `linkPath` at `target`, atomically.
 *
 * `symlink(2)` refuses an existing path, so the swap is "create a temp symlink beside it, then
 * `rename(2)` over the old one" — rename is atomic on POSIX, so a concurrent `exec` of
 * `<linkPath>/…` either resolves entirely to the old release or entirely to the new one. There is
 * no instant where the path does not resolve, which is what makes a flip safe to do under load.
 *
 * Refuses outright when `linkPath` is a real directory: `rename` of a symlink onto a non-empty
 * directory fails with ENOTEMPTY, and the failure mode of "try harder" here is deleting a live
 * install. That case is the migration's job, and it says so.
 */
export function flipSymlink(linkPath: string, target: string): void {
  if (!isAbsolute(target)) throw new Error(`release symlink target must be absolute: ${target}`);
  if (!existsSync(target)) throw new Error(`release symlink target does not exist: ${target}`);
  if (existsSync(linkPath) && !isMigrated(linkPath)) throw new NotMigratedError(linkPath);
  mkdirSync(dirname(linkPath), { recursive: true });
  const tmp = `${linkPath}.tmp-flip`;
  try {
    rmSync(tmp, { force: true });
  } catch {
    // best effort — the symlink below fails loudly if the path is still occupied
  }
  symlinkSync(target, tmp);
  renameSync(tmp, linkPath);
}

/** Delete a release tree. Never touches `current`/`previous` — callers pass `prunable()` output. */
export function removeRelease(releasesDir: string, id: string): void {
  rmSync(releaseDir(releasesDir, id), { recursive: true, force: true });
}
