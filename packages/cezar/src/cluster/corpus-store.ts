import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CLUSTER_CORPUS_BATCH_MAX_BYTES,
  CLUSTER_CORPUS_BATCH_MAX_PATHS,
  CLUSTER_CORPUS_DEFAULT_SCOPE,
  type ClusterCorpusDoc,
  type ClusterCorpusManifestResponse,
} from '@loki-labs/better-cezar-contract';
import { cezarHomeDir, expandTilde } from '../paths.ts';
import { atomicWriteJsonSync } from '../workspace/config.ts';

/**
 * The hub-side corpus store (D8a of `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, handoff
 * item 56, package 3b.2). Pure filesystem + bookkeeping module — no HTTP, no auth, no zod parsing
 * of requests. `server/cluster-routes.ts` calls this; this file never imports it.
 *
 * **`resolveCorpusRoot` — "today: `<CEZ_PROJECTS_DIR or workspace>/notion-export`".** There is no
 * existing helper anywhere in this package that resolves the corpus's on-disk location (it is
 * indexed today via `~/.cezar/config.json`'s project registry, an async, human-configured path —
 * wrong shape for a synchronous store primitive with no `repoRoot`/`cwd` input). Two candidates, in
 * order, the first that exists on disk wins:
 *
 * 1. `<CEZ_CORPUS_ROOT>`, when set — the explicit knob, naming the corpus directly.
 * 2. `<CEZ_PROJECTS_DIR>/notion-export`, when that env var is set (matches `workspace/config.ts`'s
 *    own `projectsDir` env name, so an operator who already knows that knob can redirect this too).
 * 3. **A `notion-export` beside some workspace under this node's home** — `cezarHomeDir(env)` is
 *    already `<home>/.cezar` (`../paths.ts`), so `dirname(...)` recovers that home on either
 *    machine and respects `env.CEZ_HOME` the way every other cluster module does. The immediate
 *    children are SCANNED (sorted, first hit wins), never hardcoded.
 *
 * **CORRECTED 2026-08-24 — candidate 3 used to hardcode one specific workspace directory name.** That is one operator's layout baked into a tool published as `@open-mercato/cezar`, and
 * it is exactly what the upstream-purity gate in `notifications/transports/webhook.test.ts`
 * exists to catch — it failed on this file, deterministically, in both runs of the box gate.
 * Deleting the candidate outright was not an option: `CEZ_PROJECTS_DIR` is unset on
 * `prod-host`, so that fallback is what resolves the live corpus today, and removing it
 * would have silently broken corpus sync on the box. Hence a scan plus a new explicit override,
 * which preserves the resolved path on both machines while naming no workspace.
 *
 * Returns `undefined`, never throws, when neither candidate exists — `server/cluster-routes.ts` is
 * the one place that turns that into `409 CORPUS_PENDING`. `buildManifest`/`readDoc`/`readDocs`
 * below independently re-resolve the root themselves (never throwing either) so a caller that
 * skips the route's own check still gets a well-typed, honest answer rather than an unhandled
 * throw — see each function's own note.
 *
 * **Tombstones: a state file, not absence-diffing.** `~/.cezar/cluster/corpus-state.json` (mirrors
 * `cluster/node-identity.ts`'s own `<cezarHomeDir>/cluster/` convention, inlined rather than
 * imported so this module's dependency graph stays limited to `fs`/`crypto`/`paths` — no reason to
 * pull in that file's account-identity/broker-isolation imports for one path join) records, per
 * corpus-relative path, the `{hash, size, mtimeMs, mtime, seenAtSeq}` this store last observed, plus
 * an explicit tombstone `{atSeq, at}` map. `corpusVersion` on the wire is a monotonic integer
 * (`seq`), stringified — comparable with a plain `Number(since) < seenAtSeq`, immune to clock skew
 * between scans, and untouched by whatever `now()` a caller injects.
 *
 * **Server-side absence-diffing is CORRECT here; client-side is the bug D8a warns about.** This
 * module's own scan sees the WHOLE corpus tree on every sweep (`walkCorpus` below, unscoped), so a
 * previously-known path that is no longer on disk really was deleted — that is what turns into a
 * tombstone. A *client* (the spoke's `sources/cezar-hub/provider.ts`) only ever sees a
 * `since`-filtered delta, where an omitted path just as often means "unchanged since your
 * watermark" as "gone" — which is exactly why `tombstones` is its own explicit array on the wire
 * and no consumer anywhere is allowed to infer a deletion from a document's mere absence from
 * `docs[]`. The two are opposite conclusions from the same-shaped observation ("path not in the
 * list"), and the only thing that makes the hub's conclusion safe is that its input is a full scan,
 * never a delta.
 *
 * **Change-gated write.** A scan that finds nothing different — no new file, no changed hash, no
 * deletion — never calls `atomicWriteJsonSync`. A file whose bytes are unchanged but whose mtime
 * was merely touched *does* still get its `{size, mtimeMs}` refreshed in the state file (so the
 * next scan's `(size, mtimeMs)` fast path — the same O(changed) comparator `knowledge/store.ts` uses
 * — can skip re-reading and re-hashing it), but that refresh does not bump `seq`/`seenAtSeq`: a
 * touch is not a corpus change for diff-before-fetch purposes, only a content change is.
 */

export interface CorpusStoreOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** Structurally identical to the landed wire type (`ClusterCorpusManifestResponse`,
 *  `packages/contract/src/cluster.ts`) — reused rather than redeclared so the two can never drift. */
export type CorpusManifest = ClusterCorpusManifestResponse;

const STATE_FORMAT_VERSION = 1;

interface PersistedDocRecord {
  hash: string;
  size: number;
  mtimeMs: number;
  mtime: string;
  seenAtSeq: number;
}

interface PersistedTombstone {
  atSeq: number;
  at: string;
}

interface PersistedCorpusState {
  formatVersion: number;
  seq: number;
  /** Keyed by corpus-relative path. */
  docs: Record<string, PersistedDocRecord>;
  /** Keyed by corpus-relative path. A path is never a key of both `docs` and `tombstones` at once. */
  tombstones: Record<string, PersistedTombstone>;
}

// ---- root resolution ------------------------------------------------------------------------

export function resolveCorpusRoot(options?: CorpusStoreOptions): string | undefined {
  const env = options?.env ?? process.env;
  const candidates: string[] = [];

  // 1. The explicit knob. Wins outright, and is the only candidate that names the corpus directly
  //    rather than deriving it — an operator who sets this gets exactly what they asked for.
  const corpusRoot = env.CEZ_CORPUS_ROOT?.trim();
  if (corpusRoot) candidates.push(expandTilde(corpusRoot));

  // 2. Beside the registered projects, matching `workspace/config.ts`'s own `projectsDir` env name.
  const projectsDir = env.CEZ_PROJECTS_DIR?.trim();
  if (projectsDir) candidates.push(join(expandTilde(projectsDir), 'notion-export'));

  // 3. A `notion-export` beside SOME workspace under this node's home. Scanned, not hardcoded:
  //    sorted for determinism, and it stops at the first hit.
  const home = dirname(cezarHomeDir(env));
  let entries: string[] = [];
  try {
    entries = readdirSync(home, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    entries = [];
  }
  for (const name of entries) candidates.push(join(home, name, 'notion-export'));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function corpusStatePath(env: NodeJS.ProcessEnv): string {
  return join(cezarHomeDir(env), 'cluster', 'corpus-state.json');
}

// ---- scope + traversal safety ----------------------------------------------------------------

export function scopeForNode(node: { mirrorScope?: readonly string[] } | undefined): readonly string[] {
  const scope = node?.mirrorScope;
  return scope && scope.length > 0 ? scope : CLUSTER_CORPUS_DEFAULT_SCOPE;
}

/**
 * THE single scope+safety rule (module header) — `buildManifest` (via the persisted state it
 * filters), `readDoc`, and `readDocs` all gate through this and nothing else. Lexical only: no fs
 * access, so it can never be used as an existence oracle.
 *
 * Refuses: a NUL byte, any backslash (not just `\..\` — a corpus path is POSIX-only, so ANY
 * backslash is refused outright rather than treated as a literal filename character, closing the
 * mixed-separator escape a Windows-syntax-tolerant join could otherwise open), a leading `/`
 * (absolute), a bare drive-letter prefix (`C:`), and any path whose `..`-resolved form has nothing
 * left to pop (i.e. escapes the root). A path that resolves cleanly is in scope iff its RESOLVED
 * top-level segment — not necessarily its literal first segment, since `a/../b/x` resolves to
 * `b/x` — is a member of `scope`.
 */
export function isPathInScope(corpusRelativePath: string, scope: readonly string[]): boolean {
  if (typeof corpusRelativePath !== 'string' || corpusRelativePath.length === 0) return false;
  if (corpusRelativePath.includes('\0')) return false;
  if (corpusRelativePath.includes('\\')) return false;
  if (corpusRelativePath.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(corpusRelativePath)) return false;

  const resolved: string[] = [];
  for (const segment of corpusRelativePath.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (resolved.length === 0) return false; // escapes the root
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  const top = resolved[0];
  if (top === undefined) return false;
  return scope.includes(top);
}

// ---- manifest ------------------------------------------------------------------------------

export async function buildManifest(
  scope: readonly string[],
  since: string | undefined,
  options?: CorpusStoreOptions,
): Promise<CorpusManifest> {
  const env = options?.env ?? process.env;
  const now = options?.now ?? (() => new Date());
  const scopeList = [...scope];
  const root = resolveCorpusRoot({ env, now });

  if (!root) {
    // The corpus is entirely absent. `server/cluster-routes.ts` is the one place that turns this
    // into 409 (it checks `resolveCorpusRoot` itself before ever reaching here) — this function's
    // return type has no "absent" state to express, so it degrades to an honestly-empty, valid
    // manifest rather than throwing on a caller that skipped that check.
    return { corpusVersion: '0', scope: scopeList, docs: [], tombstones: [], complete: true };
  }

  const state = await scanAndPersist(root, env, now);
  const sinceSeq = parseSeq(since);

  const docs: ClusterCorpusDoc[] = [];
  for (const [path, record] of Object.entries(state.docs)) {
    if (!isPathInScope(path, scope)) continue;
    if (sinceSeq !== undefined && record.seenAtSeq <= sinceSeq) continue;
    docs.push({ path, hash: record.hash, size: record.size, mtime: record.mtime });
  }
  docs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Tombstones are only meaningful relative to a watermark (module header): a full (no-`since`)
  // manifest has nothing to reconcile a deletion against, so it carries none.
  const tombstones: CorpusManifest['tombstones'] = [];
  if (sinceSeq !== undefined) {
    for (const [path, record] of Object.entries(state.tombstones)) {
      if (!isPathInScope(path, scope)) continue;
      if (record.atSeq <= sinceSeq) continue;
      tombstones.push({ path, at: record.at });
    }
    tombstones.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  return { corpusVersion: String(state.seq), scope: scopeList, docs, tombstones, complete: true };
}

/** Malformed/unparseable `since` degrades to "no watermark" (a full manifest) — more data than
 *  asked for, never less; the caller's own diff-before-fetch is unaffected because refetching an
 *  unchanged doc is a no-op for it, just not the cheapest path. */
function parseSeq(since: string | undefined): number | undefined {
  if (since === undefined) return undefined;
  const n = Number(since);
  return Number.isFinite(n) ? n : undefined;
}

// ---- document bodies -------------------------------------------------------------------------

export async function readDoc(
  path: string,
  scope: readonly string[],
  options?: CorpusStoreOptions,
): Promise<{ path: string; hash: string; body: string } | undefined> {
  const env = options?.env ?? process.env;
  const root = resolveCorpusRoot({ env, now: options?.now });
  if (!root) return undefined; // absent corpus reads the same as an absent document (module header)
  if (!isPathInScope(path, scope)) return undefined;

  let body: string;
  try {
    body = await readFile(join(root, path), 'utf8');
  } catch {
    return undefined;
  }
  return { path, hash: hashContent(body), body };
}

export async function readDocs(
  paths: readonly string[],
  scope: readonly string[],
  options?: CorpusStoreOptions,
): Promise<{ docs: Array<{ path: string; hash: string; body: string }>; missing: string[]; truncated: boolean }> {
  const env = options?.env ?? process.env;
  const root = resolveCorpusRoot({ env, now: options?.now });
  if (!root) return { docs: [], missing: [...paths], truncated: false };

  const docs: Array<{ path: string; hash: string; body: string }> = [];
  const missing: string[] = [];

  // Defense in depth — the route's own `clusterCorpusBodiesRequestSchema` already bounds
  // `paths.length` to `CLUSTER_CORPUS_BATCH_MAX_PATHS`, but this function must not assume every
  // caller went through that schema.
  const overPathCap = paths.length > CLUSTER_CORPUS_BATCH_MAX_PATHS;
  const capped = overPathCap ? paths.slice(0, CLUSTER_CORPUS_BATCH_MAX_PATHS) : paths;
  let truncated = overPathCap;

  let usedBytes = 0;
  for (const path of capped) {
    // Scope-checked BEFORE any fs access, same as `readDoc` — an out-of-scope path never touches
    // the filesystem, so its presence/absence is never observable via timing either.
    if (!isPathInScope(path, scope)) {
      missing.push(path);
      continue;
    }
    let body: string;
    try {
      body = await readFile(join(root, path), 'utf8');
    } catch {
      missing.push(path);
      continue;
    }
    const bytes = Buffer.byteLength(body, 'utf8');
    // `usedBytes > 0` guard: the FIRST doc always goes in even if it alone exceeds the cap, so a
    // single oversized document can never wedge a caller into an empty response it can never make
    // progress past.
    if (usedBytes > 0 && usedBytes + bytes > CLUSTER_CORPUS_BATCH_MAX_BYTES) {
      truncated = true;
      break;
    }
    usedBytes += bytes;
    docs.push({ path, hash: hashContent(body), body }); // whole file, always — never a partial read
    if (usedBytes >= CLUSTER_CORPUS_BATCH_MAX_BYTES) {
      truncated = true;
      break;
    }
  }

  return { docs, missing, truncated };
}

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// ---- scan + state -----------------------------------------------------------------------------

interface ScannedFile {
  relPath: string;
  absPath: string;
  size: number;
  mtimeMs: number;
}

/** Full recursive walk of `root`, unscoped — scope is applied later, when a manifest/doc is built
 *  for a specific asking node, so the same scan+state serves every node regardless of its scope.
 *  Dotfiles/dot-directories and `node_modules` are skipped defensively; a corpus tree is expected
 *  to hold neither. A symlink is silently skipped rather than followed: `Dirent#isFile()` and
 *  `#isDirectory()` are both `false` for a symlink entry (they report the link's own type, not its
 *  target's, under `withFileTypes`), so nothing here ever stats or reads through one — the corpus
 *  root must not let a symlink pull content in from outside itself. */
async function walkCorpus(root: string): Promise<ScannedFile[]> {
  const results: ScannedFile[] = [];

  const visit = async (dirAbs: string, relPrefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return; // directory vanished mid-scan; tolerate
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;
      const abs = join(dirAbs, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(abs, rel);
      } else if (entry.isFile()) {
        try {
          const st = await stat(abs);
          results.push({ relPath: rel, absPath: abs, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // vanished between readdir and stat; tolerate
        }
      }
    }
  };

  await visit(root, '');
  return results;
}

/** The one place a scan turns into persisted state (and the one place `seq` ever advances).
 *  Deletions first (any previously-known doc missing from THIS full scan is a real deletion — see
 *  module header on why that inference is safe here and nowhere else), then new/changed files
 *  against the O(changed) `(size, mtimeMs)` comparator `knowledge/store.ts` already uses, with
 *  sha256 as the tiebreak for a touch that left the bytes alone. */
async function scanAndPersist(root: string, env: NodeJS.ProcessEnv, now: () => Date): Promise<PersistedCorpusState> {
  const statePath = corpusStatePath(env);
  const previous = readState(statePath);
  const scanned = await walkCorpus(root);
  const scannedPaths = new Set(scanned.map((f) => f.relPath));

  const nextDocs: Record<string, PersistedDocRecord> = { ...previous.docs };
  const nextTombstones: Record<string, PersistedTombstone> = { ...previous.tombstones };
  let seq = previous.seq;
  let dirty = false;

  for (const path of Object.keys(previous.docs)) {
    if (scannedPaths.has(path)) continue;
    delete nextDocs[path];
    seq += 1;
    dirty = true;
    nextTombstones[path] = { atSeq: seq, at: now().toISOString() };
  }

  for (const file of scanned) {
    const prior = previous.docs[file.relPath];
    if (prior && prior.size === file.size && prior.mtimeMs === file.mtimeMs) continue;

    let body: string;
    try {
      body = await readFile(file.absPath, 'utf8');
    } catch {
      continue; // vanished between the walk and this read; next scan resolves it either way
    }
    const hash = hashContent(body);
    const mtimeIso = new Date(file.mtimeMs).toISOString();

    if (prior && prior.hash === hash) {
      // A touch, not a change: fresh (size, mtimeMs) persisted so the fast path above can skip
      // this file next time, but seq/seenAtSeq stay put — this must never appear in a delta manifest.
      nextDocs[file.relPath] = { ...prior, size: file.size, mtimeMs: file.mtimeMs, mtime: mtimeIso };
      dirty = true;
      continue;
    }

    seq += 1;
    dirty = true;
    delete nextTombstones[file.relPath]; // a resurrection clears any stale tombstone
    nextDocs[file.relPath] = { hash, size: file.size, mtimeMs: file.mtimeMs, mtime: mtimeIso, seenAtSeq: seq };
  }

  const next: PersistedCorpusState = { formatVersion: STATE_FORMAT_VERSION, seq, docs: nextDocs, tombstones: nextTombstones };
  if (dirty) writeState(statePath, next);
  return next;
}

function emptyState(): PersistedCorpusState {
  return { formatVersion: STATE_FORMAT_VERSION, seq: 0, docs: {}, tombstones: {} };
}

/** A format mismatch or any corruption discards and rebuilds (mirrors `CATALOG_FORMAT_VERSION`'s
 *  house rule, `knowledge/types.ts`) — this is a rebuildable derived cache, not the record; losing
 *  it costs one full re-hash sweep, never data. */
function readState(path: string): PersistedCorpusState {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return emptyState();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedCorpusState> | null;
    if (!parsed || typeof parsed !== 'object' || parsed.formatVersion !== STATE_FORMAT_VERSION) return emptyState();
    return {
      formatVersion: STATE_FORMAT_VERSION,
      seq: typeof parsed.seq === 'number' ? parsed.seq : 0,
      docs: parsed.docs && typeof parsed.docs === 'object' ? parsed.docs : {},
      tombstones: parsed.tombstones && typeof parsed.tombstones === 'object' ? parsed.tombstones : {},
    };
  } catch {
    return emptyState();
  }
}

function writeState(path: string, state: PersistedCorpusState): void {
  atomicWriteJsonSync(path, state);
}
