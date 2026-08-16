import { readdir, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { classify, type BackupScope } from './paths.ts';

/**
 * The snapshot engine's file collector (Architecture §2 "Snapshot engine", spec
 * `.ai/specs/2026-08-16-provider-agnostic-platform-backup.md`). Walks the whole backup include
 * set — every `home/`-scoped file under `~/.cezar/`, every `project/<id>/`-scoped file under each
 * registered project's `<root>/.ai/cezar/`, and every configured `extra/` absolute path — and
 * hands back `{logicalPath, absPath}` pairs ready for the engine to hash and upload.
 *
 * Classification is delegated entirely to `./paths.ts#classify`, the single fail-closed source of
 * truth (N5): this module only walks and applies it, never re-derives include/exclude itself.
 *
 * `homeDir` and `listProjects` are injected rather than read from `cezarHomeDir()` /
 * `../workspace/projects.ts` directly, so a test can exercise this against a fixture tree without
 * ever touching the real home or the real project registry.
 */

export interface IncludeSetEntry {
  /** Scope-prefixed restore path (`home/…`, `project/<id>/…`, `extra/<basename>`) — the key the
   *  manifest stores per entry and restore maps back to an absolute path. */
  logicalPath: string;
  /** Absolute path to read the file's current bytes from. */
  absPath: string;
}

export interface CollectIncludeSetDeps {
  /** Absolute path to the cezar home dir (`cezarHomeDir()` in production; a fixture in tests). */
  homeDir: string;
  /** Registered projects to walk `<root>/.ai/cezar/` for. Only `id`/`root` are read, so a real
   *  `ProjectListEntry` (from `../workspace/projects.ts#listProjects`) or a bare fixture both work. */
  listProjects: () => Promise<ReadonlyArray<{ id: string; root: string }>>;
  /** Extra absolute paths from `backup.json`'s `include[]` (Data Models `config`). Each becomes
   *  `extra/<basename>`; a second path with the same basename is dropped (dedupe by basename). */
  extraIncludes?: ReadonlyArray<string>;
}

/** Collects the full include set, sorted by `logicalPath` for deterministic manifest ordering. */
export async function collectIncludeSet(deps: CollectIncludeSetDeps): Promise<IncludeSetEntry[]> {
  const entries: IncludeSetEntry[] = [];

  await walkScope(deps.homeDir, deps.homeDir, 'home', null, entries);

  const projects = await deps.listProjects();
  for (const project of projects) {
    const projectCezarDir = join(project.root, '.ai', 'cezar');
    await walkScope(projectCezarDir, projectCezarDir, 'project', project.id, entries);
  }

  const seenBasenames = new Set<string>();
  for (const absPath of deps.extraIncludes ?? []) {
    const base = basename(absPath);
    if (seenBasenames.has(base)) continue;
    seenBasenames.add(base);
    const info = await safeStat(absPath);
    if (!info || !info.isFile()) continue; // missing/unreadable/not-a-file — skip
    entries.push({ logicalPath: `extra/${base}`, absPath });
  }

  entries.sort((a, b) => a.logicalPath.localeCompare(b.logicalPath));
  return entries;
}

/**
 * Recursively walks `dirPath` (relative to `scopeRoot`), classifying every regular file it finds
 * and keeping the `'include'`s. Directories are always descended into (classification is
 * file-level, per `paths.ts`'s module doc) — a missing or unreadable directory degrades to "no
 * files here" rather than throwing, matching the engine's "never on the hot write path" guarantee
 * (a directory that doesn't exist yet, e.g. a fresh project with no `.ai/cezar/knowledge/`, is not
 * an error).
 */
async function walkScope(
  dirPath: string,
  scopeRoot: string,
  scope: BackupScope,
  projectId: string | null,
  out: IncludeSetEntry[],
): Promise<void> {
  let dirents;
  try {
    dirents = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of dirents) {
    const abs = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await walkScope(abs, scopeRoot, scope, projectId, out);
      continue;
    }
    if (!entry.isFile()) continue; // skip symlinks and other non-regular entries
    const info = await safeStat(abs);
    if (!info) continue; // unreadable (permission denied, or removed in a race with a writer)
    const rel = relative(scopeRoot, abs).split(sep).join('/');
    // Fail closed (`paths.ts` module doc, N5): `classify` answers `'include' | 'exclude' | null`,
    // and an unclassified (`null`) path is REFUSED — never silently dropped (a durable file lost
    // from the backup, discovered only at restore time) nor silently shipped (a secret a future
    // store adds leaking into the ciphertext). `backup.json` and OS junk (`.DS_Store`, AppleDouble
    // `._*`) are classified in `paths.ts`, so this throws only on a genuinely new cezar-written
    // file whose classification a dev has not added yet — exactly the case that must be loud. It
    // surfaces as a failed run and a staling `lastRun` in the cockpit, prompting the paths.ts fix.
    const classification = classify(scope, rel);
    if (classification === null) {
      throw new Error(
        `backup: refusing the run — unclassified corpus path ${scope}:${rel}. ` +
          `Add it to the include/exclude manifest in backup/paths.ts (and backup/paths.test.ts).`,
      );
    }
    if (classification === 'exclude') continue;
    const logicalPath = scope === 'home' ? `home/${rel}` : `project/${projectId}/${rel}`;
    out.push({ logicalPath, absPath: abs });
  }
}

async function safeStat(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}
