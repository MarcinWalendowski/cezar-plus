import { createHash, randomUUID } from 'node:crypto';
import { type FSWatcher, watch } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  KnowledgeCounts,
  KnowledgeDocument,
  KnowledgeFacetBucket,
  KnowledgeFacets,
  KnowledgeRoot,
} from '@open-mercato/cezar-contract';
import {
  assembleDocuments,
  DEFAULT_SCAN_CAPS,
  manifestRootsFrom,
  parseScannedFile,
  readCatalog,
  readManifest,
  scanRoots,
  writeCatalog,
  writeManifest,
  type ParsedWorking,
  type ScanCaps,
} from './catalog.ts';
import {
  containsPath,
  projectKnowledgeRoot,
  resolveKnowledgeRoots,
  resolveWritablePath,
  workspaceKnowledgeRoot,
} from './paths.ts';
import { CATALOG_FORMAT_VERSION, emptyScanStats, type CatalogEntry, type ResolvedKnowledgeRoot, type ScanStats } from './types.ts';
import { search as runSearch, type SearchFilters, type SearchOptions, type SearchableDocument } from './search.ts';

// `SourceSink` (F2, W1.5) — imported for typing only, never re-exported: this feature never owns
// the port, only an implementation of it (Q14). Reading it does not "touch" `sources/`.
import type { MirroredDocumentMeta, SourceSink } from '../sources/types.ts';

/**
 * The knowledge store: orchestrates roots, the catalog cache, change detection, document CRUD
 * with containment, search, and the adoption sink (W2.1). This is where the pure pieces
 * (`catalog.ts`, `search.ts`, `links.ts`, `paths.ts`) become a stateful, per-project object with
 * an fs.watch-backed live index. See `.ai/specs/2026-08-06-knowledge-base-mounts-search.md` and
 * `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` (D1..D25, outranks the spec on conflict).
 *
 * **Two change triggers, one debounced reindex (D15/D25/C19).** `startWatchers()` runs one
 * `fs.watch` per indexed root; `notifyChanged(root, docIds?)` is the second, in-process trigger F2
 * calls after a sync batch. Both funnel into the SAME per-root 300ms-debounced `performReindex()` —
 * removing either leg is the deadlock this store exists to close, never a performance nicety.
 */

const DEBOUNCE_MS = 300;

export interface KnowledgeStoreOptions {
  env?: NodeJS.ProcessEnv;
  /** `capabilities().localHandoff === false` — gates external configured mounts (paths.ts) and
   *  workspace-scope writes. Defaults to `false` (the default local deployment). */
  hosted?: boolean;
  caps?: ScanCaps;
  now?: () => Date;
  warn?: (message: string) => void;
  /**
   * Suppresses trigger 1 (`startWatchers`) entirely, leaving `notifyChanged` and explicit reindex
   * as the only paths into `performReindex`. Defaults to `false` — production always watches.
   *
   * This exists so the C19 negative control can actually control for something: proving
   * "`notifyChanged` alone reindexes" is vacuous while an fs.watch on the same directory could
   * have fired the debounce instead. Same degraded mode `startWatchers` already falls back to on
   * a platform without recursive `fs.watch`, just chosen rather than forced.
   */
  disableWatchers?: boolean;
}

export type WriteFailure = { ok: false; status: 400 | 404 | 409; error: string };
export type WriteSuccess = { ok: true; document: KnowledgeDocument };
export type WriteOutcome = WriteSuccess | WriteFailure;

const HOSTED_WORKSPACE_REFUSAL = 'workspace-scoped knowledge writes are a local-machine capability (see localHandoff)';
const REMOTE_ORIGIN_REFUSAL = 'this document was mirrored from a remote source — adopt it before editing';
const READ_ONLY_ROOT_REFUSAL = 'this document lives on a read-only mount';

export class KnowledgeStore {
  private roots: ResolvedKnowledgeRoot[] = [];
  /** Keyed by absolute file path — stable across reindexes, unlike the (possibly collision-
   *  suffixed) final document id, which is assembly-time only (`catalog.ts`'s `resolveIds`). This
   *  is what makes the reindex O(changed): an unchanged path's working record is reused untouched. */
  private working = new Map<string, ParsedWorking>();
  private manifestDocs = new Map<string, { size: number; mtimeMs: number; hash: string }>();
  /** Derived from `working` on every `performReindex()` — the assembled, wire-shaped view. */
  private documents = new Map<string, CatalogEntry>();
  private scan: ScanStats = emptyScanStats();
  private idCollisions = 0;
  private initialized = false;

  private readonly watchers = new Map<string, FSWatcher>();
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  /** Serializes reindexes so a burst of debounced fires (watcher + `notifyChanged` on the same
   *  batch) never runs two `performReindex()` passes concurrently against the same maps. */
  private reindexChain: Promise<void> = Promise.resolve();

  private readonly env: NodeJS.ProcessEnv;
  private readonly hosted: boolean;
  private readonly caps: ScanCaps;
  private readonly now: () => Date;
  private readonly warn: (message: string) => void;
  private readonly watchersDisabled: boolean;

  static create(repoRoot: string, dataDir: string, options: KnowledgeStoreOptions = {}): KnowledgeStore {
    return new KnowledgeStore(repoRoot, dataDir, options);
  }

  private constructor(
    readonly repoRoot: string,
    readonly dataDir: string,
    options: KnowledgeStoreOptions,
  ) {
    this.env = options.env ?? process.env;
    this.hosted = options.hosted ?? false;
    this.caps = options.caps ?? DEFAULT_SCAN_CAPS;
    this.now = options.now ?? (() => new Date());
    this.warn = options.warn ?? ((message) => console.warn(`[cez] knowledge: ${message}`));
    this.watchersDisabled = options.disableWatchers ?? false;
  }

  /**
   * Resolve roots, seed from the on-disk cache when it matches the current `formatVersion`
   * (a mismatch or corrupt cache discards and rebuilds, C11), run one reindex, and start the
   * watchers. Call once — `project-context.ts` (W3.1) schedules the call itself, off the boot
   * path, after listen (spec "Roots": "the one owner-approved default-on exception").
   */
  async initialize(): Promise<void> {
    this.roots = await this.resolveRoots();
    const manifest = await readManifest(this.dataDir);
    if (manifest) {
      const cached = await readCatalog(this.dataDir);
      if (cached) {
        for (const [path, doc] of Object.entries(manifest.docs)) this.manifestDocs.set(path, doc);
        for (const entry of cached) this.documents.set(entry.id, entry);
      }
    }
    await this.performReindex(); // also starts the watchers, once roots are known to exist or not
    this.initialized = true;
  }

  dispose(): void {
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  private async resolveRoots(): Promise<ResolvedKnowledgeRoot[]> {
    return resolveKnowledgeRoots({
      repoRoot: this.repoRoot,
      dataDir: this.dataDir,
      env: this.env,
      hosted: this.hosted,
    });
  }

  // ---- reindexing (the one place both change triggers converge, D15) --------------------------

  /**
   * The real work, never debounced itself — callers that need "right now" (CRUD, `reindexNow()`,
   * `initialize()`) await this directly; the two change TRIGGERS (`notifyChanged`, the watcher)
   * schedule it through `scheduleReindex` instead. Chained through `reindexChain` so overlapping
   * callers never race the same in-memory maps.
   */
  private async performReindex(): Promise<void> {
    const run = async (): Promise<void> => {
      this.roots = await this.resolveRoots();
      const { files, stats } = await scanRoots(this.roots, this.caps);
      this.scan = stats;

      const currentPaths = new Set(files.map((f) => f.absPath));
      for (const path of [...this.working.keys()]) {
        if (!currentPaths.has(path)) {
          this.working.delete(path);
          this.manifestDocs.delete(path);
        }
      }

      for (const file of files) {
        const cachedMeta = this.manifestDocs.get(file.absPath);
        const cachedWorking = this.working.get(file.absPath);
        // O(changed): a file whose (size, mtimeMs) still matches the manifest, AND whose parsed
        // working record is already in memory, is reused untouched — no read, no reparse.
        if (cachedMeta && cachedWorking && cachedMeta.size === file.size && cachedMeta.mtimeMs === file.mtimeMs) {
          continue;
        }
        const parsed = await parseScannedFile(file);
        if (!parsed) {
          this.scan.skipped++;
          this.working.delete(file.absPath);
          this.manifestDocs.delete(file.absPath);
          continue;
        }
        // sha256 tiebreak (spec "Catalog cache"): an mtime-only touch with byte-identical content
        // still replaces the working record (cheap — we already read and parsed it above), but is
        // recognisable in the manifest by an unchanged hash. Recorded for fidelity to the spec's
        // stated comparator even though this store does not currently special-case it further.
        this.working.set(file.absPath, parsed);
        this.manifestDocs.set(file.absPath, { size: file.size, mtimeMs: file.mtimeMs, hash: parsed.entry.hash });
      }

      const { documents, idCollisions } = assembleDocuments([...this.working.values()]);
      this.idCollisions = idCollisions;
      this.documents = new Map(documents.map((d) => [d.entry.id, d.entry]));

      await this.persist();
      // A root that did not exist yet (e.g. `project`, before its first write) may exist now —
      // `startWatchers` is idempotent per root id, so this only ever ADDS a watcher, never
      // duplicates one.
      this.startWatchers();
    };
    this.reindexChain = this.reindexChain.then(run, run);
    await this.reindexChain;
  }

  private async persist(): Promise<void> {
    await writeCatalog(this.dataDir, [...this.documents.values()]);
    await writeManifest(this.dataDir, {
      formatVersion: CATALOG_FORMAT_VERSION,
      roots: manifestRootsFrom(this.roots),
      docs: Object.fromEntries(this.manifestDocs),
    });
  }

  /** Force a full reindex right now (`POST /knowledge/reindex`, route 9). */
  async reindexNow(): Promise<{ formatVersion: number; scan: ScanStats }> {
    await this.performReindex();
    return { formatVersion: CATALOG_FORMAT_VERSION, scan: this.scan };
  }

  /**
   * `notifyChanged(root, docIds?)` (D25) — the second trigger, called by F2 after a sync batch
   * commits, and internally by the watcher (trigger 1). `docIds` is accepted for signature
   * fidelity but a targeted reindex is not attempted here: `root` alone always reindexes correctly
   * (spec: "Passing no docIds reindexes the root, which is always correct and merely slower"), and
   * `performReindex` is already O(changed) at the file level regardless of which root asked. Both
   * triggers funnel through the SAME per-root debounce (`scheduleReindex`), so a burst from either
   * or both collapses into one reindex pass, never two.
   */
  notifyChanged(root: string, _docIds?: readonly string[]): void {
    this.scheduleReindex(root);
  }

  private scheduleReindex(rootId: string): void {
    const existing = this.debounceTimers.get(rootId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(rootId);
      void this.performReindex().catch((err) => {
        this.warn(`reindex after a change to root "${rootId}" failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, DEBOUNCE_MS);
    timer.unref?.();
    this.debounceTimers.set(rootId, timer);
  }

  /** Trigger 1: one `fs.watch` per indexed root, following `todos.ts`'s exact precedent — watch
   *  the directory, 300ms debounce, `unref()` so a watch never holds the process open, swallow a
   *  watcher `error` so a dying watcher never kills the server. If `fs.watch` throws at creation,
   *  the store degrades to a watcher-less root with one warning; the index still updates via
   *  `notifyChanged` and explicit reindex (`todos.ts:171`'s degradation shape). */
  private startWatchers(): void {
    if (this.watchersDisabled) return;
    for (const root of this.roots) {
      if (!root.indexed) continue;
      if (this.watchers.has(root.id)) continue;
      try {
        // `recursive: true` is only supported on macOS and Windows; Node throws
        // `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` synchronously on other platforms, which the catch
        // below turns into exactly the documented degradation (one warning, no watcher for this
        // root, the index still updates via `notifyChanged` and explicit reindex).
        const watcher = watch(root.path, { recursive: true }, () => this.scheduleReindex(root.id));
        watcher.on('error', () => undefined);
        watcher.unref?.();
        this.watchers.set(root.id, watcher);
      } catch (err) {
        this.warn(
          `fs.watch unavailable for root "${root.id}" — the index still updates via notifyChanged and explicit reindex (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  }

  // ---- reads ------------------------------------------------------------------------------

  getRoots(): KnowledgeRoot[] {
    const counts = new Map<string, number>();
    for (const entry of this.documents.values()) counts.set(entry.root, (counts.get(entry.root) ?? 0) + 1);
    return this.roots.map((r) => ({
      id: r.id,
      path: r.path,
      format: r.format,
      writable: r.writable,
      indexed: r.indexed,
      reason: r.reason,
      documentCount: counts.get(r.id) ?? 0,
    }));
  }

  getCounts(): KnowledgeCounts {
    return { documents: this.documents.size, idCollisions: this.idCollisions };
  }

  getFacets(): KnowledgeFacets {
    const types = new Map<string, number>();
    const tags = new Map<string, number>();
    const statuses = new Map<string, number>();
    const roots = new Map<string, number>();
    for (const entry of this.documents.values()) {
      types.set(entry.type, (types.get(entry.type) ?? 0) + 1);
      statuses.set(entry.status, (statuses.get(entry.status) ?? 0) + 1);
      roots.set(entry.root, (roots.get(entry.root) ?? 0) + 1);
      for (const tag of entry.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1);
    }
    const toBuckets = (map: Map<string, number>): KnowledgeFacetBucket[] =>
      [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([value, count]) => ({ value, count }));
    return { types: toBuckets(types), tags: toBuckets(tags), statuses: toBuckets(statuses), roots: toBuckets(roots) };
  }

  getScan(): ScanStats {
    return this.scan;
  }

  getFormatVersion(): number {
    return CATALOG_FORMAT_VERSION;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /** Deterministic ordering (D8/spec): `(rootId, relPath)` — approximated here as `(root, path)`,
   *  which sorts identically since `path` is absolute and `root` groups by mount. */
  private orderedEntries(): CatalogEntry[] {
    return [...this.documents.values()].sort((a, b) => {
      const byRoot = a.root.localeCompare(b.root);
      if (byRoot !== 0) return byRoot;
      return a.path.localeCompare(b.path);
    });
  }

  search(query: string, options: SearchFilters & { limit?: number; offset?: number } = {}): {
    query: string;
    total: number;
    truncated: boolean;
    results: KnowledgeDocument[];
  } {
    const searchable: SearchableDocument[] = this.orderedEntries().map((entry) => ({
      id: entry.id,
      title: entry.title,
      headings: entry.headings,
      body: this.working.get(entry.path)?.body ?? '',
      identifiers: entry.identifiers,
      status: entry.status,
      type: entry.type,
      tags: entry.tags,
      root: entry.root,
    }));
    const opts: SearchOptions = { ...options };
    const result = runSearch(searchable, query, opts);
    const byId = this.documents;
    return {
      query,
      total: result.total,
      truncated: result.truncated,
      results: result.results.map((doc) => byId.get(doc.id)!).filter((entry): entry is CatalogEntry => !!entry),
    };
  }

  /** `GET /knowledge/:id` — the only read that carries `body`. */
  getDocument(id: string): KnowledgeDocument | null {
    const entry = this.documents.get(id);
    if (!entry) return null;
    const body = this.working.get(entry.path)?.body ?? '';
    return { ...entry, body };
  }

  // ---- writes -------------------------------------------------------------------------------

  private writableRoot(scope: 'project' | 'workspace'): { id: string; path: string } {
    return scope === 'project'
      ? { id: 'project', path: projectKnowledgeRoot(this.dataDir) }
      : { id: 'workspace', path: workspaceKnowledgeRoot(this.env) };
  }

  async createDocument(input: { scope: 'project' | 'workspace'; path: string; content: string }): Promise<WriteOutcome> {
    if (input.scope === 'workspace' && this.hosted) {
      return { ok: false, status: 409, error: HOSTED_WORKSPACE_REFUSAL };
    }
    const root = this.writableRoot(input.scope);
    const resolved = await resolveWritablePath(root.path, input.path);
    if (!resolved.ok) return { ok: false, status: 400, error: resolved.error };

    const alreadyThere = await readFile(resolved.target, 'utf8').then(
      () => true,
      () => false,
    );
    if (alreadyThere) return { ok: false, status: 409, error: 'a document already exists at this path' };

    await mkdir(dirname(resolved.target), { recursive: true });
    const tmp = `${resolved.target}.cez-tmp-${process.pid}-${randomUUID()}`;
    await writeFile(tmp, input.content, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, resolved.target);

    await this.performReindex();
    const document = this.findByPath(resolved.target);
    if (!document) return { ok: false, status: 400, error: 'the document did not index after being written' };
    return { ok: true, document };
  }

  async updateDocument(id: string, input: { content: string; version: string }): Promise<WriteOutcome> {
    const entry = this.documents.get(id);
    if (!entry) return { ok: false, status: 404, error: 'no such document' };
    if (entry.root !== 'project' && entry.root !== 'workspace') {
      return { ok: false, status: 409, error: READ_ONLY_ROOT_REFUSAL };
    }
    if (entry.root === 'workspace' && this.hosted) {
      return { ok: false, status: 409, error: HOSTED_WORKSPACE_REFUSAL };
    }
    if (entry.source?.origin === 'remote') {
      return { ok: false, status: 409, error: REMOTE_ORIGIN_REFUSAL };
    }

    // Re-read fresh: the version guard is against what is on DISK right now, not the possibly
    // stale in-memory catalog (`agent-config/files.ts`'s exact idiom).
    let current: string;
    try {
      current = await readFile(entry.path, 'utf8');
    } catch {
      return { ok: false, status: 409, error: 'the document no longer exists on disk — reload before saving' };
    }
    const currentVersion = hashBytes(current);
    if (currentVersion !== input.version) {
      // Bytes unchanged: refuse BEFORE any write.
      return { ok: false, status: 409, error: 'the document changed on disk since you opened it — reload before saving' };
    }

    const tmp = `${entry.path}.cez-tmp-${process.pid}-${randomUUID()}`;
    await writeFile(tmp, input.content, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, entry.path);

    await this.performReindex();
    const document = this.getDocument(id) ?? this.findByPath(entry.path);
    if (!document) return { ok: false, status: 400, error: 'the document did not re-index after being written' };
    return { ok: true, document };
  }

  async deleteDocument(id: string): Promise<{ ok: true } | WriteFailure> {
    const entry = this.documents.get(id);
    if (!entry) return { ok: false, status: 404, error: 'no such document' };
    if (entry.root !== 'project' && entry.root !== 'workspace') {
      return { ok: false, status: 409, error: READ_ONLY_ROOT_REFUSAL };
    }
    if (entry.root === 'workspace' && this.hosted) {
      return { ok: false, status: 409, error: HOSTED_WORKSPACE_REFUSAL };
    }
    if (entry.source?.origin === 'remote') {
      return { ok: false, status: 409, error: REMOTE_ORIGIN_REFUSAL };
    }
    await rm(entry.path, { force: true });
    await this.performReindex();
    return { ok: true };
  }

  private findByPath(path: string): KnowledgeDocument | null {
    for (const entry of this.documents.values()) {
      if (entry.path === path) return { ...entry, body: this.working.get(entry.path)?.body ?? '' };
    }
    return null;
  }

  // ---- adoption sink (Q14) --------------------------------------------------------------------

  /**
   * Wraps a base `SourceSink` (F2's `FileSourceSink`, typically) so that `adopt()` and
   * `notifyChanged()` reach this store's REAL reindex instead of `FileSourceSink`'s standalone
   * no-op `notifyChanged` (its own doc comment: "F1 supplies its own sink at ProjectContext build
   * time that forwards this to its real notifyChanged"). Every other member passes through
   * unchanged — the spec's "only `adopt(docId)` is interesting here; the rest is F2's own file
   * handling" (architecture, "The adoption sink").
   *
   * `adopt`'s own move (mirror root -> `.ai/cezar/knowledge/`) is `base.adopt()`'s job, already
   * correct against D16 (`FileSourceSink.adopt` writes to `join(dataDir, 'knowledge')`, exactly
   * this store's `project` root). This wrapper's only addition is reindexing BOTH affected roots
   * afterward — full-root reindexes (no `docIds`), per the same "always correct, merely slower"
   * reasoning `notifyChanged` itself uses, rather than trying to thread the F2 `docId` (a 16-char
   * mirror-local id) through to this store's own (unrelated) id scheme.
   */
  createSourceSink(base: SourceSink): SourceSink {
    const store = this;
    return {
      upsert: (doc, body) => base.upsert(doc, body),
      readMeta: (docId: string): Promise<MirroredDocumentMeta | null> => base.readMeta(docId),
      read: (docId: string) => base.read(docId),
      list: (connectionId: string) => base.list(connectionId),
      quarantine: (docId, remoteVersion, body) => base.quarantine(docId, remoteVersion, body),
      tombstone: (docId, at) => base.tombstone(docId, at),
      async adopt(docId: string) {
        const result = await base.adopt(docId);
        store.notifyChanged('sources');
        store.notifyChanged('project');
        return result;
      },
      notifyChanged(root: string, docIds?: readonly string[]) {
        store.notifyChanged(root, docIds);
      },
    };
  }
}

function hashBytes(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// `containsPath` is re-exported for callers (route handlers) that want to classify a document's
// root as writable without re-deriving the two writable-root paths themselves.
export { containsPath };
