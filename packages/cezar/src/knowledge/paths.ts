import { readFile } from 'node:fs/promises';
import { realpath as realpathAsync } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { cezarHomeDir, expandTilde, workspaceConfigPath } from '../paths.ts';
import { knowledgeConfigSchema, type KnowledgeMountConfig, type ResolvedKnowledgeRoot } from './types.ts';

/**
 * Root resolution, path containment, and the `.ai/cezar/config.json` `knowledge.mounts[]` reader
 * (W2.1). See `.ai/specs/2026-08-06-knowledge-base-mounts-search.md` ("Roots", "Path containment")
 * and `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` (D1..D25, outranks the spec on conflict).
 */

// ---- derived-state paths ----------------------------------------------------------------------

/** Everything derived lives in one directory (spec "Catalog cache", Q6) — the single entry
 *  `ensureDataGitignore` (`index.ts`, scaffold-owned) already gitignores. */
export function knowledgeIndexDir(dataDir: string): string {
  return join(dataDir, 'knowledge-index');
}

export function catalogPath(dataDir: string): string {
  return join(knowledgeIndexDir(dataDir), 'catalog.ndjson');
}

export function manifestPath(dataDir: string): string {
  return join(knowledgeIndexDir(dataDir), 'manifest.json');
}

// ---- the five root kinds (spec "Roots") ----------------------------------------------------

/** `<repoRoot>/.ai/cezar/knowledge/` — the ONE writable, committable root; also the adoption
 *  target (Q14). `dataDir` is always `<repoRoot>/.ai/cezar` (`project-context.ts:208`). */
export function projectKnowledgeRoot(dataDir: string): string {
  return join(dataDir, 'knowledge');
}

/** `<cezarHomeDir>/knowledge/` — writable, never committable (outside any repo). */
export function workspaceKnowledgeRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(cezarHomeDir(env), 'knowledge');
}

/** `<repoRoot>/.ai/cezar/sources/` — F2's mirror root, registered here as a read-only mount
 *  (D3/C17). `conflicts/` and `deleted/` under it contribute zero documents (D18/C22), enforced
 *  generically by `shouldSkipDir` below rather than a path prefix scoped to this one root. */
export function sourcesMountRoot(dataDir: string): string {
  return join(dataDir, 'sources');
}

/** Discovered read-only roots, inside the project only (D5) — present in the list whenever the
 *  directory exists. */
export function discoveredRoots(repoRoot: string): ReadonlyArray<{ id: string; path: string }> {
  return [
    { id: 'specs', path: join(repoRoot, '.ai/specs') },
    { id: 'docs', path: join(repoRoot, 'docs') },
    { id: 'analysis', path: join(repoRoot, '.ai/analysis') },
  ];
}

// ---- mount config: `.ai/cezar/config.json`'s `knowledge` key (Q11) ----------------------------

/**
 * Reads `.ai/cezar/config.json` itself, with its own tolerant zod schema over the `knowledge` key,
 * ignoring everything else in the file — the same "never cached, never throws" idiom `config.ts`
 * already uses at `:149`/`:174`/`:207` for `worktreeRetention` and `skillsRepos` (Q11). A missing
 * file, malformed JSON, or a `knowledge` block the schema refuses all degrade to `{ mounts: [] }`.
 */
export async function readKnowledgeMountConfig(repoRoot: string): Promise<KnowledgeMountConfig[]> {
  return readMountsFrom(join(repoRoot, '.ai/cezar', 'config.json'));
}

/**
 * The WORKSPACE-scoped twin: `~/.cezar/config.json`'s own `knowledge.mounts[]`, indexed by every
 * project rather than by the one repo that declares it
 * (`.ai/specs/2026-08-19-tasks-page-and-start-grounding.md`, D3).
 *
 * It exists because a repo-local mount cannot express "this corpus is knowledge for everything I
 * work on". Pointing at it from each repo means one entry per repo, each with a path that only
 * makes sense on one machine, committed into repositories that have nothing to do with it — and in
 * hosted mode it does not work at all, because such a mount is necessarily outside its own repo
 * root and `resolveKnowledgeRoots` refuses those.
 *
 * **Why that hosted refusal does not apply here.** The rule exists so a path committed into a
 * REPOSITORY cannot make a hosted deployment index arbitrary host directories: a repo is shared,
 * and its config travels with every clone. The workspace config is neither shared nor cloned — it
 * is the operator's own file on the operator's own box, and it is already the file that lists
 * every project root this server will ever open (`workspace/config.ts`'s `projects[]`). A mount
 * written there is trusted by exactly the argument that makes `projects[].root` trusted. Nothing
 * about the repo-declared case is loosened; see `resolveKnowledgeRoots`.
 *
 * Same tolerant contract as the repo-local reader above (Q11): never cached, never throws, every
 * failure degrades to `[]`. `workspaceConfigSchema` is `.passthrough()`, so an older cezar sharing
 * this home preserves the key on its next write rather than dropping it.
 */
export async function readWorkspaceKnowledgeMountConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<KnowledgeMountConfig[]> {
  return readMountsFrom(workspaceConfigPath(env));
}

/** The shared body of the two readers above — one tolerant parse, so the repo-local and
 *  workspace-scoped configs cannot drift in how forgiving they are. */
async function readMountsFrom(configPath: string): Promise<KnowledgeMountConfig[]> {
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return [];
    const knowledge = (parsed as Record<string, unknown>).knowledge;
    const result = knowledgeConfigSchema.safeParse(knowledge ?? {});
    return result.success ? result.data.mounts : [];
  } catch {
    return [];
  }
}

// ---- exclusions (spec "Roots" scan bounds) -----------------------------------------------------

/** Skipped by NAME, at any depth, wherever they appear under any root. `conflicts` and `deleted`
 *  are here on purpose (D18/C22): a path-prefix-under-`sources/` version would re-open the hole the
 *  moment a second mirror root exists. */
const EXCLUDED_BASENAMES = new Set([
  'node_modules',
  '.git',
  '.history',
  'dist',
  'build',
  '.next',
  'conflicts',
  'deleted',
]);

/** Skipped by path SUFFIX (not a bare basename, so a legitimately named sibling directory
 *  elsewhere is never caught by accident). */
const EXCLUDED_PATH_SUFFIXES = ['.ai/cezar/knowledge-index', '.ai/cezar/worktrees', '.claude/worktrees'];

export function shouldSkipDir(dirAbsPath: string, dirName: string): boolean {
  if (EXCLUDED_BASENAMES.has(dirName)) return true;
  const normalized = dirAbsPath.split(sep).join('/');
  return EXCLUDED_PATH_SUFFIXES.some((suffix) => normalized === suffix || normalized.endsWith(`/${suffix}`));
}

// ---- root resolution --------------------------------------------------------------------------

export interface ResolveRootsOptions {
  repoRoot: string;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  /** `capabilities().localHandoff === false` — a configured mount outside the project root is not
   *  indexed at all in hosted mode (spec "Roots"), mirroring the agent-config write rule rather
   *  than inventing a second one. Defaults to `false` (the default local deployment). */
  hosted?: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await realpathAsync(path);
    return true;
  } catch {
    return false;
  }
}

/** Every root this feature knows about, in the spec's fixed order (project, workspace, sources,
 *  discovered, configured) — deterministic ordering matters (D8): two consecutive `GET /knowledge`
 *  bodies must be byte-identical. */
export async function resolveKnowledgeRoots(options: ResolveRootsOptions): Promise<ResolvedKnowledgeRoot[]> {
  const { repoRoot, dataDir, env = process.env, hosted = false } = options;
  const roots: ResolvedKnowledgeRoot[] = [];

  // Writable roots are always "present" (created lazily on first write) — an empty or missing
  // directory just means zero documents, never `indexed:false`.
  roots.push({ id: 'project', path: projectKnowledgeRoot(dataDir), kind: 'project', writable: true, indexed: true });
  roots.push({
    id: 'workspace',
    path: workspaceKnowledgeRoot(env),
    kind: 'workspace',
    writable: true,
    indexed: true,
  });

  const sourcesPath = sourcesMountRoot(dataDir);
  const sourcesPresent = await exists(sourcesPath);
  roots.push({
    id: 'sources',
    path: sourcesPath,
    kind: 'sources',
    writable: false,
    indexed: sourcesPresent,
    reason: sourcesPresent ? undefined : 'root is not available',
  });

  for (const discovered of discoveredRoots(repoRoot)) {
    const present = await exists(discovered.path);
    roots.push({
      id: discovered.id,
      path: discovered.path,
      kind: 'discovered',
      writable: false,
      indexed: present,
      reason: present ? undefined : 'root is not available',
    });
  }

  const configured = await readKnowledgeMountConfig(repoRoot);
  const realRepoRoot = (await realpathOrNull(repoRoot)) ?? resolve(repoRoot);

  /**
   * Every real path already claimed, so a mount cannot be indexed twice under two ids.
   *
   * This is not hypothetical: a workspace mount is by design visible to every project, and the one
   * project that ALSO declares it repo-locally would otherwise scan the same corpus twice, doubling
   * its catalog and its watchers for no new documents. Repo-local mounts are resolved first, so
   * that project keeps the root id it already has and its manifest does not churn.
   */
  const claimedPaths = new Set(roots.map((root) => root.path));
  const claimedIds = new Set(roots.map((root) => root.id));

  const pushMount = async (mount: KnowledgeMountConfig, scope: 'repo' | 'workspace'): Promise<void> => {
    // A workspace mount losing an id race is SKIPPED, not rendered as unavailable: the repo-local
    // entry with that id is already in the list, and two rows sharing an id is worse than one.
    if (scope === 'workspace' && claimedIds.has(mount.id)) return;
    const expanded = expandTilde(mount.path);
    // A workspace mount has no repo to be relative TO — a bare `notion-export` there would
    // otherwise resolve differently for every project and mean nothing. Relative is repo-local
    // only; elsewhere it is an unresolvable path, reported as such rather than guessed at.
    const absolute = isAbsolute(expanded)
      ? expanded
      : scope === 'repo'
        ? resolve(repoRoot, expanded)
        : resolve(cezarHomeDir(env), expanded);
    const base = {
      id: mount.id,
      path: absolute,
      kind: 'configured' as const,
      writable: false,
      format: mount.format,
    };
    const present = await exists(absolute);
    if (!present) {
      roots.push({ ...base, indexed: false, reason: 'root is not available' });
      return;
    }
    const realMount = (await realpathOrNull(absolute)) ?? absolute;
    // The hosted refusal is REPO-SCOPED, deliberately (2026-08-19-tasks-page-and-start-grounding.md
    // D3): it stops a path committed into a shared, cloneable repository from making a hosted
    // deployment index arbitrary host directories. The workspace config is the operator's own file
    // on their own box — the same file that already names every project root the server opens — so
    // a mount declared there is trusted on the same terms as `projects[].root`. The repo-local case
    // below is byte-for-byte what it always was.
    if (scope === 'repo' && hosted && !containsPath(realRepoRoot, realMount)) {
      roots.push({ ...base, indexed: false, reason: 'external mount is local only' });
      return;
    }
    if (claimedPaths.has(absolute)) return;
    claimedPaths.add(absolute);
    claimedIds.add(mount.id);
    roots.push({ ...base, indexed: true });
  };

  for (const mount of configured) await pushMount(mount, 'repo');
  // Last, and so lowest precedence on both id and path — see `claimedIds`/`claimedPaths` above.
  // Order is fixed (project, workspace, sources, discovered, repo-configured, workspace-configured)
  // because `GET /knowledge` must answer byte-identically twice in a row (D8).
  for (const mount of await readWorkspaceKnowledgeMountConfig(env)) await pushMount(mount, 'workspace');

  return roots;
}

// ---- containment (`fs-browse.ts` discipline, followed exactly and in order) -------------------

/** `candidate` is `root` or strictly beneath it. Both must already be resolved for this to mean
 *  anything — the explicit separator suffix is what stops `/home/bob-evil` from passing as inside
 *  `/home/bob` (`fs-browse.ts:84`'s exact rule, reimplemented here rather than imported: this
 *  module owns no cross-package relative import into `server/`, and the rule is five lines). */
export function containsPath(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpathAsync(path);
  } catch {
    return null;
  }
}

export type ContainResult = { ok: true; target: string } | { ok: false; error: string };

/**
 * Resolve a client-supplied relative (or absolute) path against a writable root, refusing anything
 * that escapes it. The two write surfaces that ever call this: `POST /knowledge` (create) and a
 * proposal's `path` (spec "Path containment"). `root` must already be an absolute, real path — the
 * caller (the two writable roots only) owns picking it.
 *
 * Order, exactly as `fs-browse.ts:17` documents and this spec's "Path containment" section repeats:
 *
 * 1. Reject a NUL byte before any syscall (it would throw inside the fs call instead of failing
 *    containment).
 * 2. Lexical `contains()` gate FIRST — `..` traversal and absolute escapes die here, before any
 *    syscall, so an escape attempt can't be used as an existence oracle (C9).
 * 3. Walk up to the nearest EXISTING ancestor and `realpath` it — the authoritative gate (C8). This
 *    is deliberately not `realpath(target)`: that throws for a path that is inside the root but
 *    simply not there yet, which is the ordinary "create" case (`fs-browse.ts:102`'s split). Any
 *    segment between that ancestor and the target is, by construction, one that does not exist yet,
 *    so it cannot itself be a symlink — `realpath` on the ancestor already resolved the whole
 *    existing chain, symlinks included.
 * 4. Gate on the REASSEMBLED target (`realPrefix` + the still-missing segments), never on
 *    `realPrefix` alone. On the first write the root itself does not exist yet, so the nearest
 *    existing ancestor is an ancestor OF THE ROOT — `contains(root, realPrefix)` is false there for
 *    a perfectly legitimate create, while the reassembled target is correctly inside the root. A
 *    symlinked escape still dies here: whatever the symlink pointed at is what `realPrefix`
 *    resolved to, so the reassembled path lands outside the root and fails the same check.
 * 5. Refuse if the resolved root is not a writable root — the CALLER'S job (this function only ever
 *    receives a writable root to begin with; see the two call sites).
 */
export async function resolveWritablePath(rootRaw: string, relPath: string): Promise<ContainResult> {
  if (relPath.includes('\0')) return { ok: false, error: 'invalid path' };

  // The writable root itself may be a symlink (a checkout inside a symlinked path, say), or may
  // not exist yet at all (the project knowledge root is created lazily on first write). Either
  // way, resolve it the SAME way the target is resolved below — existing prefix realpath'd, the
  // not-yet-created tail appended — so containment never compares an unresolved root against a
  // fully-resolved target and fails a legitimate write.
  const rootAbs = resolve(rootRaw);
  const rootPrefix = await realpathExistingPrefix(rootAbs);
  const root = rootPrefix === null ? rootAbs : reassemble(rootPrefix);

  const target = isAbsolute(relPath) ? resolve(relPath) : resolve(root, relPath);
  if (!containsPath(root, target)) return { ok: false, error: 'path is outside the writable root' };

  const prefix = await realpathExistingPrefix(target);
  if (prefix === null) return { ok: false, error: 'path is outside the writable root' };

  const finalTarget = reassemble(prefix);
  if (!containsPath(root, finalTarget)) return { ok: false, error: 'path is outside the writable root' };

  return { ok: true, target: finalTarget };
}

function reassemble(prefix: { realPrefix: string; missing: string[] }): string {
  return prefix.missing.length > 0 ? join(prefix.realPrefix, ...prefix.missing) : prefix.realPrefix;
}

/** Walks `target` upward until `realpath` succeeds, returning that resolved prefix plus the
 *  (never-yet-existing, so never-a-symlink) trailing segments still to create. `null` only if
 *  nothing in the chain exists all the way to the filesystem root, which should not happen on a
 *  real filesystem and is treated as a refusal rather than a throw. */
async function realpathExistingPrefix(
  target: string,
): Promise<{ realPrefix: string; missing: string[] } | null> {
  let cursor = target;
  const missing: string[] = [];
  for (;;) {
    try {
      const real = await realpathAsync(cursor);
      return { realPrefix: real, missing };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
      const parent = dirname(cursor);
      if (parent === cursor) return null; // reached the filesystem root with nothing resolving
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}
