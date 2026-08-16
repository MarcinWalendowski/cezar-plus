import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cezarHomeDir } from '../paths.ts';
import { listProjects as listProjectsFromWorkspace } from '../workspace/projects.ts';
import { decrypt, deriveMasterKey, sha256Hex, verifyKeyCheckToken } from './crypto.ts';
import { loadBackupConfig, resolveEncryptionKey, resolveProviderConfig, type BackupConfig } from './config.ts';
import { parseManifest, type Manifest, type ManifestEntry } from './manifest.ts';
import { resolveBackupProvider } from './registry.ts';
import type { BackupProvider } from './provider-types.ts';

/**
 * The restore path (Architecture §4 "Restore", spec
 * `.ai/specs/2026-08-16-provider-agnostic-platform-backup.md`; N3/N4/N6). Built entirely on the
 * already-landed `crypto.ts` / `manifest.ts` / `config.ts` / `registry.ts` / `provider-types.ts` /
 * `../paths.ts` / `../workspace/projects.ts` modules — nothing here is exported from
 * `snapshot.ts` (the engine), so the remote-layout constants and the key-resolution/manifest-fetch
 * steps are re-derived here, deliberately mirroring `snapshot.ts`'s own private helpers byte-for-byte
 * so the two agree on the wire format without either importing the other's internals.
 *
 * Order of operations, and why:
 *  1. Resolve provider + passphrase, derive the master key from the stored `keyderiv`.
 *  2. **Verify `keycheck` before touching disk at all (N4).** A wrong/lost key must abort here,
 *     before the target manifest is even fetched — never a garbage write, never a partial one.
 *  3. Resolve the target manifest (`deps.snapshotId` or `latest`), decrypt it.
 *  4. Map every entry's logical path to an absolute target, skipping (and counting) entries whose
 *     `project/<id>/…` id matches no project registered on this machine — a cross-machine restore
 *     where that project isn't mounted, not a failure.
 *  5. **Fail-closed overwrite guard (N6).** If any resolved target already exists and `force` was
 *     not passed, refuse the whole restore before any blob is even fetched — nothing is written to
 *     the live tree, and the caller sees a clear, throw-shaped refusal.
 *  6. **Stage then apply (N3).** Fetch + decrypt each blob, verify its `sha256` against the
 *     manifest entry (a mismatch throws — never write a corrupt/tampered blob), write it into a
 *     per-run staging dir under `homeDir`. Only once every entry is staged does the apply step move
 *     each staged file into its final place, atomically per file (`rename`, falling back to
 *     copy+rename+unlink across a filesystem boundary — project roots can be on a different volume
 *     than `~/.cezar`). The staging dir is removed in a `finally` regardless of outcome.
 */

export interface RestoreDeps {
  /** The snapshot to restore; omitted ⇒ whatever `latest` currently points at. */
  snapshotId?: string;
  /** Overwrite a non-empty target. Absent/false ⇒ the fail-closed guard refuses (N6). */
  force?: boolean;
  /** Injected so tests never touch the real project registry; production callers omit this and get
   *  `../workspace/projects.ts#listProjects`. Only `id`/`root` are read. */
  listProjects?: () => Promise<ReadonlyArray<{ id: string; root: string }>>;
  /** Injected cezar home dir for hermetic tests; production callers omit this and get
   *  `cezarHomeDir()`. */
  homeDir?: string;
  /** Injectable clock, used only to name this run's staging dir uniquely. */
  now?: () => Date;
}

export interface RunRestoreResult {
  /** Manifest entries with a resolvable target whose blob was fetched, decrypted, and
   *  sha256-verified. */
  restored: number;
  /** Of those, how many were written into the staging dir (equals `restored` in this
   *  implementation — a verified entry is always staged, or the whole run has already thrown). */
  staged: number;
  /** Whether anything actually landed in the live tree — `false` for a genuine no-op restore (an
   *  empty manifest, or every entry belonged to an unmounted project), `true` once at least one
   *  staged file was moved into place. The overwrite guard refusing (N6) never reaches this: it
   *  throws instead, since a refusal is a distinct outcome from a no-op the wire contract's
   *  3-field shape can't tell apart from `applied: false` on its own. */
  applied: boolean;
  /** `project/<id>/…` entries skipped because `id` matches no project registered on this machine
   *  (surfaced here, and via a `console.warn`, per the spec — not a failure). Not part of the wire
   *  contract (`BackupRestoreResponse` in `@loki-labs/better-cezar-contract` has no field for it
   *  yet); a route handler wiring this up in a later phase can fold it into a message or drop it. */
  skippedProjects: number;
}

const KEYDERIV_KEY = 'keyderiv';
const KEYCHECK_KEY = 'keycheck';
const LATEST_KEY = 'latest';
const SNAPSHOTS_PREFIX = 'snapshots/';
const BLOBS_PREFIX = 'blobs/';

/** Mirrors `snapshot.ts`'s private `KeyDeriv` shape exactly — the two must agree on the bytes
 *  stored at `keyderiv`, and neither exports this type for the other to import. */
interface KeyDeriv {
  salt: string; // base64
  N: number;
  r: number;
  p: number;
}

/** Mirrors `snapshot.ts`'s private `LatestPointer` shape exactly. */
interface LatestPointer {
  manifestKey: string;
}

/** Mirrors `snapshot.ts#manifestKeyFor` exactly — the remote key a given snapshot id's manifest
 *  lives at. */
function manifestKeyFor(snapshotId: string): string {
  return `${SNAPSHOTS_PREFIX}${snapshotId}.manifest.enc`;
}

/** Mirrors `snapshot.ts#requireProviderAndPassphrase` exactly (same messages — deliberate, so a
 *  user sees one consistent error whether a run or a restore hit it). */
function requireProviderAndPassphrase(config: BackupConfig): { provider: BackupProvider; passphrase: string } {
  const providerConfig = resolveProviderConfig(config);
  const provider = providerConfig ? resolveBackupProvider(providerConfig) : null;
  if (!provider) {
    throw new Error('backup is not configured: no usable provider (check `~/.cezar/backup.json` and its secrets)');
  }
  const passphrase = resolveEncryptionKey(config);
  if (!passphrase) {
    throw new Error('backup is not configured: no encryption key (set the configured `encryption.keyEnv`/`keyFile`)');
  }
  return { provider, passphrase };
}

/** Derives the master key from the stored `keyderiv` salt. Unlike `snapshot.ts#resolveMasterKey`,
 *  restore never provisions a fresh salt on a miss — a missing `keyderiv` means nothing has ever
 *  been backed up to this provider, which is a clear error here, not a first-run side effect. */
async function resolveMasterKeyForRestore(provider: BackupProvider, passphrase: string): Promise<Buffer> {
  const existing = await provider.get(KEYDERIV_KEY);
  if (!existing) {
    throw new Error('no backup found: `keyderiv` is missing on the configured provider — nothing has been backed up yet');
  }
  const parsed = JSON.parse(Buffer.from(existing).toString('utf8')) as KeyDeriv;
  return deriveMasterKey(passphrase, Buffer.from(parsed.salt, 'base64'));
}

/** Verifies the key-check token and throws on a mismatch — the FIRST thing `runRestore` does after
 *  deriving the master key, before any manifest fetch or disk touch (N4: "a wrong/lost key must
 *  make restore refuse before touching disk"). Never provisions a token (that is `runBackup`'s job
 *  on a first run); a missing token alongside an existing `keyderiv` is itself a clear error. */
async function verifyKeyOrThrow(provider: BackupProvider, masterKey: Buffer): Promise<void> {
  const token = await provider.get(KEYCHECK_KEY);
  if (!token) {
    throw new Error('backup key mismatch: no key-check token found on the configured provider (backup is not fully initialized)');
  }
  if (!verifyKeyCheckToken(masterKey, token)) {
    throw new Error('backup key mismatch: the configured passphrase does not match this backup’s stored key-check token');
  }
}

/** Resolves and decrypts the target manifest: `deps.snapshotId` if given, else whatever `latest`
 *  currently points at. Throws clearly when the requested (or the pointed-at) snapshot is absent —
 *  restore must never silently fall back to "nothing to restore". */
async function resolveTargetManifest(
  provider: BackupProvider,
  masterKey: Buffer,
  snapshotId: string | undefined,
): Promise<Manifest> {
  let manifestKey: string;
  let label: string;
  if (snapshotId) {
    manifestKey = manifestKeyFor(snapshotId);
    label = snapshotId;
  } else {
    const latestBytes = await provider.get(LATEST_KEY);
    if (!latestBytes) {
      throw new Error('no backup found: no snapshots exist on the configured provider yet');
    }
    const pointer = JSON.parse(decrypt(masterKey, latestBytes).toString('utf8')) as LatestPointer;
    manifestKey = pointer.manifestKey;
    label = manifestKey;
  }
  const manifestBytes = await provider.get(manifestKey);
  if (!manifestBytes) {
    throw new Error(`no backup found: snapshot "${label}" does not exist on the configured provider`);
  }
  return parseManifest(decrypt(masterKey, manifestBytes));
}

/** Maps one manifest entry's scope-prefixed logical path back to an absolute restore target.
 *  `null` means "skip" — only ever returned for a `project/<id>/…` entry whose `id` matches no
 *  project registered on this machine (a cross-machine restore, not a failure; the caller counts
 *  and surfaces it). Every other shape is either resolvable or a corrupt-manifest error. */
function resolveTargetPath(
  logicalPath: string,
  homeDir: string,
  projectRootsById: ReadonlyMap<string, string>,
): string | null {
  if (logicalPath.startsWith('home/')) {
    const rel = logicalPath.slice('home/'.length);
    return join(homeDir, ...rel.split('/'));
  }
  if (logicalPath.startsWith('project/')) {
    const rest = logicalPath.slice('project/'.length);
    const slash = rest.indexOf('/');
    const projectId = slash === -1 ? rest : rest.slice(0, slash);
    const rel = slash === -1 ? '' : rest.slice(slash + 1);
    const root = projectRootsById.get(projectId);
    if (!root) return null; // project not registered on this machine — skip, not a failure
    return join(root, '.ai', 'cezar', ...rel.split('/'));
  }
  if (logicalPath.startsWith('extra/')) {
    // The manifest never carries the original absolute path for an `include[]`-configured extra
    // file (only its basename, deduped — `walk.ts#collectIncludeSet`), so there is no absolute
    // path to restore it TO. It lands under a clearly-named, permanent subdir of `homeDir` instead
    // of the live tree it originally came from — the owner relocates it by hand if needed.
    const base = logicalPath.slice('extra/'.length);
    return join(homeDir, 'restored-extra', base);
  }
  throw new Error(`backup restore: unrecognized logical path scope "${logicalPath}"`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Moves a staged file into its final place, atomically. `rename` is atomic and is all that's
 *  needed when the staging dir and the target share a filesystem (the common case: most targets
 *  are under `homeDir`, the same volume the staging dir itself is on). A `project/<id>/…` target
 *  can be on a different volume, where `rename` throws `EXDEV` — the fallback copies the bytes to a
 *  tmp file ADJACENT to the final target (guaranteeing it's on the same filesystem as the target),
 *  renames that into place (atomic again), then removes the now-copied staged source. */
async function atomicMoveInto(stagingPath: string, targetPath: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  try {
    await rename(stagingPath, targetPath);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  const tmp = `${targetPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await copyFile(stagingPath, tmp);
  await rename(tmp, targetPath);
  await rm(stagingPath, { force: true });
}

/** `<ts>` for this run's staging dir name — matches `snapshot.ts#toSnapshotId`'s filename-safe
 *  transform; the two never collide with each other's directories since restore's live under
 *  `restore-staging-…` and the engine's manifests live under `snapshots/`. */
function toRunSuffix(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * Restores a backed-up snapshot (Architecture §4). See the module doc for the full step order.
 * Never partially writes to the live tree: the overwrite guard (N6) and every blob's sha256 check
 * (N3) each throw rather than proceed on a bad state, and the staging dir is cleaned up in a
 * `finally` regardless of outcome.
 */
export async function runRestore(deps: RestoreDeps = {}): Promise<RunRestoreResult> {
  const now = deps.now ?? (() => new Date());
  const homeDir = deps.homeDir ?? cezarHomeDir();
  const listProjects = deps.listProjects ?? listProjectsFromWorkspace;

  const config = await loadBackupConfig();
  const { provider, passphrase } = requireProviderAndPassphrase(config);

  const masterKey = await resolveMasterKeyForRestore(provider, passphrase);
  // N4: refuse before touching disk at all — before the manifest fetch, before the overwrite
  // guard, before any staging.
  await verifyKeyOrThrow(provider, masterKey);

  const manifest = await resolveTargetManifest(provider, masterKey, deps.snapshotId);

  const projects = await listProjects();
  const projectRootsById = new Map(projects.map((project) => [project.id, project.root]));

  const targets: Array<{ entry: ManifestEntry; absPath: string }> = [];
  let skippedProjects = 0;
  for (const entry of manifest.entries) {
    const absPath = resolveTargetPath(entry.path, homeDir, projectRootsById);
    if (absPath === null) {
      skippedProjects++;
      continue;
    }
    targets.push({ entry, absPath });
  }
  if (skippedProjects > 0) {
    console.warn(
      `[cez] backup restore: skipped ${skippedProjects} entr${skippedProjects === 1 ? 'y' : 'ies'} ` +
        'belonging to a project not registered on this machine',
    );
  }

  // Fail-closed overwrite guard (N6): checked before any blob is fetched or anything staged, so a
  // refusal never does unnecessary work and — more importantly — never writes to the live tree.
  if (deps.force !== true) {
    const existing: string[] = [];
    for (const { absPath } of targets) {
      if (await pathExists(absPath)) existing.push(absPath);
    }
    if (existing.length > 0) {
      const shown = existing.slice(0, 5).join(', ') + (existing.length > 5 ? ', …' : '');
      throw new Error(`refusing to overwrite ${existing.length} existing file(s) without force: ${shown}`);
    }
  }

  const stagingDir = join(homeDir, `restore-staging-${toRunSuffix(now())}`);
  let restored = 0;
  let staged = 0;
  let appliedCount = 0;
  try {
    const stagedFiles: Array<{ stagingPath: string; targetPath: string }> = [];
    for (const { entry, absPath } of targets) {
      const ciphertext = await provider.get(`${BLOBS_PREFIX}${entry.hmacKey}`);
      if (!ciphertext) {
        throw new Error(
          `backup restore: missing blob for "${entry.path}" (blobs/${entry.hmacKey}) — refusing to restore an incomplete backup`,
        );
      }
      const plaintext = decrypt(masterKey, ciphertext);
      if (sha256Hex(plaintext) !== entry.sha256) {
        throw new Error(`backup restore: sha256 mismatch for "${entry.path}" — refusing to write a corrupted/tampered blob`);
      }
      restored++;

      const stagingPath = join(stagingDir, ...entry.path.split('/'));
      await mkdir(dirname(stagingPath), { recursive: true });
      await writeFile(stagingPath, plaintext);
      staged++;
      stagedFiles.push({ stagingPath, targetPath: absPath });
    }

    for (const { stagingPath, targetPath } of stagedFiles) {
      await atomicMoveInto(stagingPath, targetPath);
      appliedCount++;
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }

  return { restored, staged, applied: appliedCount > 0, skippedProjects };
}
