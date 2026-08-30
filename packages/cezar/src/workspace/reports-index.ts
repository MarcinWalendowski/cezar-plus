import { basename, join } from 'node:path';
import type { WorkspaceProjectHealth } from '@loki-labs/cezar-plus-contract';
import { KnowledgeStore } from '../knowledge/store.ts';
import type { CatalogEntry } from '../knowledge/types.ts';

/**
 * `WorkspaceReportsIndex` — the cross-project read path behind `GET /api/v1/workspace/reports`
 * (`.ai/specs/2026-08-19-reports-triage-approve-dismiss.md`, "Reports is a workspace tab"
 * amendment). Mirrors `./knowledge-index.ts` field for field, because it is the same kind of
 * thing: a bounded fan-out over every registered project's knowledge store.
 *
 * **READ never instantiates a context.** This module imports NEITHER `../server/project-context.ts`
 * (`ProjectContexts.context()`/`build()` runs `pruneOrphans` → `reclaimWorktrees` →
 * `manager.recover()`, which resumes every interrupted run in that project) NOR
 * `../workflows/run.ts` — the same invariant `./knowledge-index.ts`, `./run-index.ts` and
 * `./git-index.ts` guard, pinned structurally in `reports-index.test.ts` WITH a floor: it DOES
 * import `../knowledge/store.ts`, which is what keeps the two negatives from passing on an empty
 * file.
 *
 * **The one thing this index does that its siblings do not: it DE-DUPLICATES.**
 * A knowledge mount is declared in the operator's `~/.cezar/config.json`
 * (`.ai/specs/2026-08-19-tasks-page-and-start-grounding.md` D3), so a single corpus is resolved by
 * every registered project — measured: 12 projects, 196 reports, one corpus. A naive fan-out would
 * answer 2352 rows, the same 196 questions asked twelve times over. So one document is ONE row
 * carrying `projects: string[]` (everyone who resolves it) plus a canonical `project` for the
 * document link.
 *
 * **Dedupe is keyed on the TRIAGE key, not on the catalog id, and that is deliberate.** The triage
 * key is what a decision is filed under, so two entries sharing one are ALREADY sharing one
 * decision whether this index merges them or not — merging is the honest rendering of that, while
 * two rows over one stored answer would be the lie (approve one, watch the other change). For a
 * document carrying a provenance identifier the two keys agree anyway; for the weaker `catalog-id`
 * fallback, `keyKind` on the row keeps the weakness visible rather than pretending it is an
 * identifier.
 *
 * **Canonical project = first in REGISTRY order.** Not "the owner" — a workspace mount has no
 * owning repo — just a deterministic pick, so two consecutive identical requests answer
 * byte-identically (`./knowledge-index.ts`'s D8 rule). `projects[]` is sorted for the same reason.
 *
 * **Peek, else open a standalone store, never build.** `deps.contexts.peek(projectId)` is the
 * narrowest possible view of `ProjectContexts` — a `peek` cannot build, and a dep typed as the
 * whole class could. Where a project has no live context (or one with no live `knowledgeStore`,
 * e.g. `CEZ_KB` was off when it was built), this opens its OWN standalone store, cached on THIS
 * instance for its lifetime and never rebuilt per request.
 *
 * **Bounded concurrency, bounded time, both reported as a row.** At most `concurrency` (default 4)
 * projects resolve at once, each under its own `deadlineMs` (default 5000). A project that trips
 * either answers `{ok: false, reason}` — a row, never a silently dropped one. That matters more
 * here than anywhere else in this family: a dropped project reads as "nothing to triage", which is
 * the opposite of true, and the dedupe makes it invisible (eleven other projects would still be
 * carrying the same documents, so the queue would look completely healthy).
 */

// ---- inputs ------------------------------------------------------------------------------

/** One project this index may read from. Structurally a subset of `./projects.ts`'s
 *  `ProjectListEntry` — injected rather than imported so a unit test never touches the real
 *  registry. Mirrors `WorkspaceKnowledgeProjectSource`'s shape exactly. */
export interface WorkspaceReportsProjectSource {
  id: string;
  root: string;
  status: 'ok' | 'missing' | 'not-git' | 'no-commits';
  name: string;
}

/** The already-built context's knowledge store, or nothing. Deliberately the narrowest possible
 *  view of `ProjectContexts` — a `peek` cannot build. `knowledgeStore` is itself optional: a live
 *  context built with `CEZ_KB` off carries no store at all. */
export interface WorkspaceReportsContexts {
  peek(projectId: string): { knowledgeStore?: KnowledgeStore } | undefined;
}

export interface WorkspaceReportsIndexDeps {
  /** The registry lookup, e.g. `./projects.ts`'s `listProjects()` — injected so tests never read
   *  `~/.cezar`. A rejected promise degrades to an empty index rather than throwing. */
  listProjects: () => Promise<readonly WorkspaceReportsProjectSource[]>;
  /** Injected rather than imported — see the module doc. Only `peek` is ever called. */
  contexts: WorkspaceReportsContexts;
  /** Test seam for standalone store construction. Defaults to
   *  `KnowledgeStore.create(root, dataDir, {disableWatchers: true}).initialize()` — watchers off
   *  for the same reason `./knowledge-index.ts` disables them: this is a point-in-time read, and a
   *  live context's own store (reached via `peek`) already watches. */
  createStore?: (root: string, dataDir: string) => Promise<KnowledgeStore>;
  /** `<root>/.ai/cezar` by default — the directory `KnowledgeStore` keys on. */
  dataDirFor?: (root: string) => string;
  /** Max projects resolved (peeked, cache-hit or freshly built) at once. Default 4. */
  concurrency?: number;
  /** Per-project deadline in ms, covering the whole resolution. Default 5000. */
  deadlineMs?: number;
}

/** One report document, after the cross-project merge. */
export interface WorkspaceReportRow {
  key: string;
  keyKind: 'identifier' | 'catalog-id';
  /** The catalog entry, taken from the CANONICAL project's store — see `resolveDocument` for why
   *  the body is fetched from that same store rather than from whichever one answered first. */
  entry: CatalogEntry;
  /** First project in registry order that resolves this document. */
  project: string;
  /** Every project that resolves it, sorted, `project` included. */
  projects: string[];
}

export interface WorkspaceReportsListOptions {
  /** Which tags mark a document as a report. */
  tags: readonly string[];
}

export interface WorkspaceReportsListResult {
  rows: WorkspaceReportRow[];
  projects: WorkspaceProjectHealth[];
  /**
   * The markdown body of one listed row, read from its CANONICAL project's own store — `''` for a
   * row this result does not carry.
   *
   * A closure over the fan-out this call already did, rather than a second lookup, because the
   * alternative is quadratic where it hurts most: `process-pending` converts every pending report
   * in one request, and fetching each body through a fresh `find()` would re-open and re-scan every
   * project's knowledge store once PER REPORT — 196 reports × 12 projects on the deployment this
   * was measured on. One fan-out per request, bodies served from it.
   */
  body: (key: string) => string;
}

// ---- internals -----------------------------------------------------------------------------

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_DEADLINE_MS = 5_000;

class DeadlineExceededError extends Error {
  constructor() {
    super('timed out');
  }
}

/** Races `promise` against a timer — the `./git-index.ts` idiom, reimplemented rather than
 *  imported (this module must not depend on a sibling aggregate). On a trip, the original promise
 *  is left to settle on its own. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new DeadlineExceededError()), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (err) => {
        clearTimeout(timer);
        rejectPromise(err);
      },
    );
  });
}

/** Bounded-concurrency map: at most `limit` calls to `fn` in flight at once, `results` preserving
 *  `items`' order regardless of completion order — the `./git-index.ts` idiom. Order preservation
 *  is load-bearing here and not just tidy: registry order is what picks the canonical project. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length || 1));
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function describeFailure(err: unknown): string {
  if (err instanceof DeadlineExceededError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function defaultDataDirFor(root: string): string {
  return join(root, '.ai', 'cezar');
}

async function defaultCreateStore(root: string, dataDir: string): Promise<KnowledgeStore> {
  const store = KnowledgeStore.create(root, dataDir, { disableWatchers: true });
  await store.initialize();
  return store;
}

type StoreResolution = { ok: true; store: KnowledgeStore } | { ok: false; reason: string };

interface ProjectOutcome {
  health: WorkspaceProjectHealth;
  entries: CatalogEntry[];
  store?: KnowledgeStore;
}

/**
 * The triage key for a document: its provenance identifier when it has one, else the catalog id.
 * The identifier is minted once by whatever wrote the document and survives a reindex; the catalog
 * id is derived and can change, so a row filed under it can be orphaned. `keyKind` keeps that
 * difference visible on the wire instead of pretending the two are equal.
 *
 * Exported because the route layer needs the same derivation for the key it writes into a todo's
 * `context` — one definition, so the queue and the idempotency marker cannot disagree about what a
 * report is called.
 */
export function reportTriageKeyFor(entry: CatalogEntry): { key: string; keyKind: 'identifier' | 'catalog-id' } {
  const identifier = entry.identifiers?.[0];
  if (identifier) return { key: identifier, keyKind: 'identifier' };
  return { key: entry.id, keyKind: 'catalog-id' };
}

export function isReportDocument(entry: CatalogEntry, tags: readonly string[]): boolean {
  return entry.tags.some((t) => tags.includes(t));
}

// ---- the index -----------------------------------------------------------------------------

export class WorkspaceReportsIndex {
  /**
   * Standalone store BUILDS this index started itself, keyed by registry project id — started
   * lazily, reused for the LIFE of this index instance. A live `contexts.peek()` store is never
   * cached here; it is already owned and kept live by its context.
   *
   * **This caches the in-flight promise, not the settled store, and that is the whole point
   * (FIXED 2026-08-19).** It held `KnowledgeStore` at first, assigned only after
   * `withDeadline` resolved — which meant a build slower than `deadlineMs` had its result thrown
   * away even though `withDeadline` deliberately leaves the underlying promise to settle. The next
   * request found nothing cached and started a SECOND build of the same corpus, so a project that
   * could not make the deadline once could never make it: it rebuilt on every request, forever,
   * answering `ok:false, reason:"timed out"` each time while burning a full scan in the background.
   * Measured on the deployment this was written for — 12 projects over one 2081-file mount, where
   * the first call resolved 5 and the second 10, non-deterministically, at 15s and 9.7s.
   *
   * Caching the promise fixes both halves: a slow build is ADOPTED when it lands, so the project
   * succeeds on a later request, and a concurrent request joins the build already running instead
   * of racing a duplicate against it.
   */
  private readonly stores = new Map<string, Promise<KnowledgeStore>>();
  private readonly createStoreFn: (root: string, dataDir: string) => Promise<KnowledgeStore>;
  private readonly dataDirForFn: (root: string) => string;
  private readonly concurrency: number;
  private readonly deadlineMs: number;

  constructor(private readonly deps: WorkspaceReportsIndexDeps) {
    this.createStoreFn = deps.createStore ?? defaultCreateStore;
    this.dataDirForFn = deps.dataDirFor ?? defaultDataDirFor;
    this.concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
    this.deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  }

  private async resolveSources(): Promise<WorkspaceReportsProjectSource[]> {
    try {
      return [...(await this.deps.listProjects())];
    } catch {
      return [];
    }
  }

  /**
   * The store for one project, without building a context. Peek first — a live context's store is
   * the only one allowed to own that project's watchers/writes. Falls back to this index's own
   * in-flight-or-settled build, started here if this is the first ask.
   *
   * The deadline races only THIS CALL's wait, never the build itself: the build stays in
   * {@link stores} and keeps going, so tripping the deadline costs this request an `ok:false` row
   * and costs the next request nothing. A build that REJECTS is evicted, so a project broken by
   * something transient (a root that was briefly unreadable) retries on the next request rather
   * than caching its own failure for the life of the process.
   */
  private async resolveStore(source: WorkspaceReportsProjectSource): Promise<StoreResolution> {
    const live = this.deps.contexts.peek(source.id);
    if (live?.knowledgeStore) return { ok: true, store: live.knowledgeStore };

    let build = this.stores.get(source.id);
    if (!build) {
      build = this.createStoreFn(source.root, this.dataDirForFn(source.root));
      this.stores.set(source.id, build);
      // Evict on failure only. Attached here rather than in the `catch` below so eviction happens
      // once per BUILD, not once per waiter — and so a build whose only waiter already gave up on
      // the deadline is still cleaned up. `.catch` on a detached copy: this must never add an
      // unhandled rejection, and must not replace the cached promise with a resolved one.
      build.catch(() => {
        if (this.stores.get(source.id) === build) this.stores.delete(source.id);
      });
    }

    try {
      return { ok: true, store: await withDeadline(build, this.deadlineMs) };
    } catch (err) {
      return { ok: false, reason: describeFailure(err) };
    }
  }

  /** Every considered project's report documents, plus its health row. The shared body of `list()`
   *  and `find()`, so the two can never disagree about which projects were reachable or which
   *  documents count as reports. */
  private async fanOut(tags: readonly string[]): Promise<ProjectOutcome[]> {
    const sources = await this.resolveSources();
    return mapWithConcurrency(sources, this.concurrency, async (source): Promise<ProjectOutcome> => {
      const name = source.name || basename(source.root);
      if (source.status === 'missing') {
        return {
          health: { id: source.id, name, status: 'missing', ok: false, reason: 'project root is missing', total: 0 },
          entries: [],
        };
      }
      const resolved = await this.resolveStore(source);
      if (!resolved.ok) {
        return {
          health: { id: source.id, name, status: source.status, ok: false, reason: resolved.reason, total: 0 },
          entries: [],
        };
      }
      const entries = resolved.store.listDocuments().filter((entry) => isReportDocument(entry, tags));
      return {
        // `total` is this project's OWN report count, before the cross-project dedupe. So these
        // deliberately sum to more than the deduped `counts.total` whenever a mount is shared —
        // which is the normal case, and which is exactly the fact this page exists to make visible.
        health: { id: source.id, name, status: source.status, ok: true, total: entries.length },
        entries,
        store: resolved.store,
      };
    });
  }

  /** Merge the fan-out into one row per triage key. Registry order decides the canonical project;
   *  `projects` is sorted so two identical requests answer byte-identically. */
  private merge(outcomes: readonly ProjectOutcome[]): WorkspaceReportRow[] {
    const byKey = new Map<string, { row: WorkspaceReportRow; projects: Set<string> }>();
    for (const outcome of outcomes) {
      if (!outcome.health.ok) continue;
      for (const entry of outcome.entries) {
        const { key, keyKind } = reportTriageKeyFor(entry);
        const existing = byKey.get(key);
        if (existing) {
          existing.projects.add(outcome.health.id);
          continue;
        }
        byKey.set(key, {
          row: { key, keyKind, entry, project: outcome.health.id, projects: [] },
          projects: new Set([outcome.health.id]),
        });
      }
    }
    return [...byKey.values()].map(({ row, projects }) => ({ ...row, projects: [...projects].sort() }));
  }

  /**
   * Every report document in the workspace, deduped, plus one health row per considered project and
   * a body resolver bound to this call's own fan-out.
   *
   * ONE fan-out per request is the whole cost model of this family: `list()` is what the queue,
   * every mutator (through {@link find}) and `process-pending` all go through, so a second scan
   * hidden behind any of them multiplies by the number of projects.
   */
  async list(options: WorkspaceReportsListOptions): Promise<WorkspaceReportsListResult> {
    const outcomes = await this.fanOut(options.tags);
    const rows = this.merge(outcomes);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const storeById = new Map(outcomes.filter((o) => o.store).map((o) => [o.health.id, o.store!]));
    return {
      rows,
      projects: outcomes.map((o) => o.health),
      // Read from the CANONICAL project's own store, not from whichever store answered first, so
      // the row a client saw and the body it then approves are the same document read the same way
      // twice.
      body: (key) => {
        const row = byKey.get(key);
        if (!row) return '';
        return storeById.get(row.project)?.getDocument(row.entry.id)?.body ?? '';
      },
    };
  }

  /**
   * One report by triage key, with the document's markdown body — the mutators' resolution step.
   *
   * Every mutator goes through this rather than trusting the key it was handed: a key matching no
   * report document answers `undefined`, which the route turns into 404, so triage can never be
   * filed against something that is not a report (or is not there at all).
   */
  async find(
    key: string,
    options: WorkspaceReportsListOptions,
  ): Promise<{ row: WorkspaceReportRow; body: string } | undefined> {
    const listed = await this.list(options);
    const row = listed.rows.find((r) => r.key === key);
    if (!row) return undefined;
    return { row, body: listed.body(key) };
  }
}
