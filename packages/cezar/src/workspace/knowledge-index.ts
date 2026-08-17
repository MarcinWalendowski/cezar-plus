import { basename, join } from 'node:path';
import type { KnowledgeDocument, KnowledgeFacetBucket } from '@loki-labs/better-cezar-contract';
import { KnowledgeStore } from '../knowledge/store.ts';
import { tokenize, type KnowledgeStatusForSearch } from '../knowledge/search.ts';

/**
 * `WorkspaceKnowledgeIndex` — the cross-project knowledge read path (D5/D6,
 * `.ai/specs/2026-08-14-knowledge-domains-and-changelog.md`).
 *
 * **READ never instantiates a context.** This module imports NEITHER `../server/project-context.ts`
 * (`ProjectContexts.context()`/`build()` runs `pruneOrphans` → `reclaimWorktrees` → `manager.recover()`,
 * which resumes every interrupted run in that project) NOR `../workflows/run.ts` — the same
 * invariant `workspace/run-index.ts` and `workspace/git-index.ts` guard, pinned structurally here
 * too (`knowledge-index.test.ts`), WITH a floor: it DOES import `../knowledge/store.ts`, which is
 * what keeps the two negatives from silently passing on an empty file.
 *
 * **Peek, else open a standalone store, never build (D5).** `deps.contexts.peek(projectId)` is the
 * narrowest possible view of `ProjectContexts` — a `peek` cannot build, and a dep typed as the
 * whole class could (the `workspace-run-mutations-routes.ts` precedent). Where a project has no
 * live context (or one with no live `knowledgeStore` — e.g. `CEZ_KB` was off when that context was
 * built), this index opens its OWN standalone `KnowledgeStore.create(root, dataDir).initialize()`.
 * Unlike the run mutations route there is no `keepLive` analogue: a `KnowledgeStore` read
 * reconciles nothing and persists nothing IN THE SENSE OF USER DATA — `initialize()` does write its
 * own rebuildable catalog cache as a side effect of scanning, same as any other `KnowledgeStore`,
 * but that is the store's own derived-cache concern, not something this module manages.
 *
 * **Lazy per-project store construction, held on the index instance (D6).** Once opened for a
 * project, a standalone store is cached on THIS instance (`this.stores`) and reused by every later
 * call — never rebuilt per request. A live `contexts.peek()` store is used directly and never
 * cached here (the live context already owns its lifecycle).
 *
 * **Bounded concurrency, bounded time, both reported as a row (D6).** At most `concurrency`
 * (default 4) projects are resolved (peeked, cache-hit, or freshly built) at once, and each gets
 * its own `deadlineMs` (default 5000) covering the whole resolution — mirroring
 * `workspace/git-index.ts`'s `mapWithConcurrency`/`withDeadline` exactly (reimplemented here rather
 * than imported: this module must not depend on the git family, and the two are independent
 * cross-project aggregates that happen to share a shape). A project that trips either the cap or
 * the deadline answers `{ok: false, reason}` — a row, never a silently dropped one; a dead project
 * that vanishes would read as "all clear", which is the opposite of true.
 *
 * **`changelog()` (D3) is a projection, not a fourth read path.** A changelog entry IS a knowledge
 * document carrying `changeType` — `changelog()` reuses the exact same `resolveSources` /
 * `filterConsidered` / `resolveStore` / concurrency / deadline machinery as `search()` and
 * `domains()`, and lists documents via `KnowledgeStore.listDocuments()` (never `search()`, which
 * cannot filter on a frontmatter field without ranking on incidental body-text overlap instead).
 *
 * **`search()` browses via `listDocuments()` too, when there is a filter but nothing to rank.**
 * `store.search()` applies its own filters and then discards the whole result whenever the query
 * tokenizes to nothing (`search.ts:213-222`) — so "click the domain row" (`domain` set, no query
 * text, the web UI's primary affordance into this index) rendered "No documents match." for every
 * domain, unconditionally, no matter what the domain rollup itself reported. See `search()`'s own
 * doc comment for the fix and why an empty query with no filter must still return empty.
 */

// ---- inputs ------------------------------------------------------------------------------

/** One project this index may read from. Structurally a subset of `workspace/projects.ts`'s
 *  `ProjectListEntry` — injected rather than imported so a unit test never has to touch the real
 *  registry file. Mirrors `WorkspaceGitProjectSource`/`WorkspaceRunProjectSource`'s shape exactly. */
export interface WorkspaceKnowledgeProjectSource {
  id: string;
  root: string;
  status: 'ok' | 'missing' | 'not-git' | 'no-commits';
  name: string;
}

/** The already-built context's knowledge store, or nothing. Deliberately the narrowest possible
 *  view of `ProjectContexts` (the `WorkspaceRunMutationContexts` precedent) — a `peek` cannot
 *  build, and a dep typed as the whole class could. `knowledgeStore` is itself optional on the
 *  returned shape: a live context built with `CEZ_KB` off carries no store at all. */
export interface WorkspaceKnowledgeContexts {
  peek(projectId: string): { knowledgeStore?: KnowledgeStore } | undefined;
}

export interface WorkspaceKnowledgeIndexDeps {
  /** The registry lookup, e.g. `workspace/projects.ts`'s `listProjects()` — injected so tests
   *  never read `~/.cezar`. A rejected promise degrades to an empty index rather than throwing. */
  listProjects: () => Promise<readonly WorkspaceKnowledgeProjectSource[]>;
  /** Injected rather than imported — see the module doc. Only `peek` is ever called. */
  contexts: WorkspaceKnowledgeContexts;
  /** Test seam for standalone store construction. Defaults to
   *  `KnowledgeStore.create(root, dataDir, {disableWatchers: true}).initialize()`. Overriding lets
   *  tests control timing and failure without real fs I/O, and is how the concurrency-cap and
   *  deadline tests measure a real high-water mark rather than a call count. Watchers are disabled
   *  by default for the REAL factory: a workspace search is a point-in-time read, and leaving an
   *  `fs.watch` running for every project a search ever touched, for the life of the server
   *  process, is a cost this read path does not need to pay (a live context's own store, reached
   *  via `peek`, already watches — this only affects the standalone fallback). */
  createStore?: (root: string, dataDir: string) => Promise<KnowledgeStore>;
  /** `<root>/.ai/cezar` by default — the directory `KnowledgeStore` keys on. Spelled once here so
   *  it can never drift from `workspace-run-mutations-routes.ts`'s own `dataDirFor`. */
  dataDirFor?: (root: string) => string;
  /** Max projects resolved (peeked, cache-hit or freshly built) at once. Default 4 (D6). */
  concurrency?: number;
  /** Per-project deadline in ms, covering the whole resolution. Default 5000. */
  deadlineMs?: number;
}

export interface WorkspaceKnowledgeSearchOptions {
  /** Registry ids to include. Absent means ALL projects — matching `WorkspaceRunListOptions`. */
  projects?: readonly string[];
  domain?: string;
  type?: string;
  status?: KnowledgeStatusForSearch;
  limit?: number;
  offset?: number;
}

export interface WorkspaceKnowledgeProjectHealth {
  id: string;
  name: string;
  ok: boolean;
  reason?: string;
}

export interface WorkspaceKnowledgeResultRow {
  project: string;
  document: KnowledgeDocument;
}

export interface WorkspaceKnowledgeSearchResult {
  query: string;
  total: number;
  truncated: boolean;
  results: WorkspaceKnowledgeResultRow[];
  projects: WorkspaceKnowledgeProjectHealth[];
}

export interface WorkspaceKnowledgeDomainRow {
  domain: string;
  docCount: number;
  projects: string[];
  indexDocId?: string;
}

export interface WorkspaceKnowledgeDomainsOptions {
  projects?: readonly string[];
}

export interface WorkspaceKnowledgeDomainsResult {
  domains: WorkspaceKnowledgeDomainRow[];
  projects: WorkspaceKnowledgeProjectHealth[];
}

export interface WorkspaceKnowledgeChangelogOptions {
  /** Registry ids to include. Absent means ALL projects. */
  projects?: readonly string[];
  domain?: string;
  /** An ISO date or date-time string. An entry survives when its own `updatedAt` is on or after
   *  this instant. Unparseable input matches nothing — the same "an out-of-vocabulary filter value
   *  simply matches nothing" precedent `search.ts`'s `status` filter already sets, rather than a
   *  400 for a shape that IS a valid query string. */
  since?: string;
  limit?: number;
}

export interface WorkspaceKnowledgeChangelogResult {
  entries: WorkspaceKnowledgeResultRow[];
  projects: WorkspaceKnowledgeProjectHealth[];
  /** Set (true) only when `since` was supplied, at least one entry existed before it was applied,
   *  and none survive it — see `workspaceKnowledgeChangelogResponseSchema`'s doc comment for the
   *  full contract. Absent in every other case; never `false`. */
  sinceExcludedAll?: boolean;
}

// ---- internals -----------------------------------------------------------------------------

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_DEADLINE_MS = 5_000;
/** `search.ts`'s own `MAX_LIMIT` — each per-project search is asked for up to this many results
 *  so the cross-project merge has enough per-project candidates before the workspace-level
 *  `limit`/`offset` is applied over the merged sequence. */
const MAX_PER_PROJECT_RESULTS = 100;
/** `search.ts`'s own `DEFAULT_LIMIT` — `changelog()` has no `offset` (spec API contract), so this
 *  is the whole page size unless the caller asks for more. */
const CHANGELOG_DEFAULT_LIMIT = 20;

class DeadlineExceededError extends Error {
  constructor() {
    super('timed out');
  }
}

/** Races `promise` against a timer — the `workspace/git-index.ts` idiom, reimplemented rather than
 *  imported (see the module doc). On a trip, the original promise is left to settle on its own. */
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
 *  `items`' order regardless of completion order — the `workspace/git-index.ts` idiom. */
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

/** Round-robin merge of already LOCALLY-ranked (per-project) result lists: index 0 of every list,
 *  then index 1, in project (registry) order at each round. Not a global BM25 merge — a raw score
 *  is not comparable across corpora with different IDF and average lengths (`search.ts`'s own
 *  header), so privileging one project's scale over another's would be an unjustified distortion.
 *  Round-robin is the honest alternative for an unspecified cross-corpus ranking: every project's
 *  own best hit is treated as equally worth seeing first. */
function roundRobinMerge<T>(lists: readonly (readonly T[])[]): T[] {
  const out: T[] = [];
  let depth = 0;
  let more = true;
  while (more) {
    more = false;
    for (const list of lists) {
      if (depth < list.length) {
        out.push(list[depth]!);
        more = true;
      }
    }
    depth++;
  }
  return out;
}

type StoreResolution = { ok: true; store: KnowledgeStore } | { ok: false; reason: string };

interface DomainOutcome {
  health: WorkspaceKnowledgeProjectHealth;
  buckets: readonly KnowledgeFacetBucket[];
  store?: KnowledgeStore;
}

interface ChangelogOutcome {
  health: WorkspaceKnowledgeProjectHealth;
  entries: WorkspaceKnowledgeResultRow[];
}

/** `updatedAt` descending, `id` ascending on a tie — the same idiom `search.ts`'s own
 *  `byScoreThenId` uses (D8: two consecutive identical requests must be byte identical, and a
 *  bare comparator that returns 0 on ties leaves the order at the mercy of `Array.sort`'s
 *  stability plus whatever order the merge happened to produce it in, i.e. registry/scan order —
 *  exactly the "reshuffles between reloads" failure this exists to prevent). */
function byUpdatedAtThenId(a: WorkspaceKnowledgeResultRow, b: WorkspaceKnowledgeResultRow): number {
  if (a.document.updatedAt !== b.document.updatedAt) {
    return a.document.updatedAt < b.document.updatedAt ? 1 : -1;
  }
  return a.document.id < b.document.id ? -1 : a.document.id > b.document.id ? 1 : 0;
}

// ---- the index -----------------------------------------------------------------------------

export class WorkspaceKnowledgeIndex {
  /** Standalone stores this index opened itself, keyed by registry project id — built lazily,
   *  reused for the LIFE of this index instance (D6). A live `contexts.peek()` store is never
   *  cached here; it is already owned and kept live by its context. */
  private readonly stores = new Map<string, KnowledgeStore>();
  private readonly createStoreFn: (root: string, dataDir: string) => Promise<KnowledgeStore>;
  private readonly dataDirForFn: (root: string) => string;
  private readonly concurrency: number;
  private readonly deadlineMs: number;

  constructor(private readonly deps: WorkspaceKnowledgeIndexDeps) {
    this.createStoreFn = deps.createStore ?? defaultCreateStore;
    this.dataDirForFn = deps.dataDirFor ?? defaultDataDirFor;
    this.concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
    this.deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  }

  private async resolveSources(): Promise<WorkspaceKnowledgeProjectSource[]> {
    try {
      return [...(await this.deps.listProjects())];
    } catch {
      return [];
    }
  }

  private filterConsidered(
    sources: readonly WorkspaceKnowledgeProjectSource[],
    projects: readonly string[] | undefined,
  ): WorkspaceKnowledgeProjectSource[] {
    if (!projects) return [...sources];
    const requested = new Set(projects);
    return sources.filter((s) => requested.has(s.id));
  }

  /** The store for one project, without building a context. Peek first — a live context's store
   *  is the only one allowed to own that project's watchers/writes; this index never opens a
   *  second store over a project that already has one live (the `workspace-run-mutations-routes.ts`
   *  precedent). Falls back to this index's own cache, then to a freshly built standalone store,
   *  raced against the shared deadline. */
  private async resolveStore(source: WorkspaceKnowledgeProjectSource): Promise<StoreResolution> {
    const live = this.deps.contexts.peek(source.id);
    if (live?.knowledgeStore) return { ok: true, store: live.knowledgeStore };

    const cached = this.stores.get(source.id);
    if (cached) return { ok: true, store: cached };

    try {
      const store = await withDeadline(
        this.createStoreFn(source.root, this.dataDirForFn(source.root)),
        this.deadlineMs,
      );
      this.stores.set(source.id, store);
      return { ok: true, store };
    } catch (err) {
      return { ok: false, reason: describeFailure(err) };
    }
  }

  /** Cross-project search (D5). Filters first (`projects`, then `type`/`status` forwarded into
   *  each project's own `KnowledgeStore.search()`, then `domain` applied here — `domain` is not a
   *  `search.ts` filter, so it is applied as a post-filter over each project's own results, same
   *  cost either way since every result is already in hand).
   *
   * **Browse fallback for an empty (or whitespace-only) query with a filter attached.**
   * `store.search()` applies its filters and then discards the whole result whenever the query
   * tokenizes to nothing (`search.ts:213-222`), so a plain "search with `domain` set, no query
   * text" — the web UI's own primary affordance, clicking a domain row — went through the ranked
   * path and got nothing back regardless of how many documents that domain actually has. When
   * `tokenize(query)` is empty AND at least one filter (`domain`, `type`, `status`, or `projects`)
   * is present, this browses via `listDocuments()` instead — the same fallback `changelog()`
   * already uses, for the same reason — and applies the filters itself, ordered by
   * `byUpdatedAtThenId` (there is no BM25 score to rank a browse by). An empty query with NO
   * filter at all still returns empty: a browse is "show me this filtered slice", never "dump the
   * whole workspace corpus".
   *
   * `tokenize` is imported from `search.ts` rather than re-derived (e.g. `query.trim() === ''`)
   * so this can never disagree with `search.ts`'s OWN empty-query test: a query like `"---"` is
   * non-empty after trimming but tokenizes to nothing (`TOKEN_RE` requires `[a-z0-9]`), and a
   * trim-based check here would send it down the ranked path, where `search.ts` would then
   * silently drop it back to empty anyway — reproducing this exact bug for that one input. */
  async search(query: string, options: WorkspaceKnowledgeSearchOptions = {}): Promise<WorkspaceKnowledgeSearchResult> {
    const limit = Math.max(0, options.limit ?? 20);
    const offset = Math.max(0, options.offset ?? 0);
    const hasQueryTokens = tokenize(query).length > 0;
    const hasFilter = Boolean(options.domain || options.type || options.status || options.projects?.length);
    const browse = !hasQueryTokens && hasFilter;

    const sources = await this.resolveSources();
    const considered = this.filterConsidered(sources, options.projects);

    const outcomes = await mapWithConcurrency(considered, this.concurrency, async (source) => {
      const name = source.name || basename(source.root);
      if (source.status === 'missing') {
        return { health: { id: source.id, name, ok: false, reason: 'project root is missing' }, results: [] as WorkspaceKnowledgeResultRow[] };
      }
      const resolved = await this.resolveStore(source);
      if (!resolved.ok) {
        return { health: { id: source.id, name, ok: false, reason: resolved.reason }, results: [] as WorkspaceKnowledgeResultRow[] };
      }
      let filtered: readonly KnowledgeDocument[];
      if (browse) {
        filtered = resolved.store
          .listDocuments()
          .filter((d) => (options.type ? d.type === options.type : true))
          .filter((d) => (options.status ? d.status === options.status : true))
          .filter((d) => (options.domain ? d.domain === options.domain : true));
      } else if (!hasQueryTokens) {
        // No filter either — stay empty rather than ranking (there is nothing to rank) or
        // browsing (there is nothing narrowing it, so a browse here would be the whole corpus).
        filtered = [];
      } else {
        const raw = resolved.store.search(query, { type: options.type, status: options.status, limit: MAX_PER_PROJECT_RESULTS });
        filtered = options.domain ? raw.results.filter((d) => d.domain === options.domain) : raw.results;
      }
      const results: WorkspaceKnowledgeResultRow[] = filtered.map((document) => ({ project: source.id, document }));
      return { health: { id: source.id, name, ok: true }, results };
    });

    const projects = outcomes.map((o) => o.health);
    // A browse has no BM25 score to round-robin by rank, so it is sorted like changelog() instead;
    // a ranked search keeps the round-robin merge over each project's own already-ranked list.
    const merged = browse
      ? outcomes.flatMap((o) => o.results).sort(byUpdatedAtThenId)
      : roundRobinMerge(outcomes.map((o) => o.results));
    const total = merged.length;
    const truncated = offset + limit < total;
    const results = merged.slice(offset, offset + limit);

    return { query, total, truncated, results, projects };
  }

  /** Cross-project domain rollup (D1/D5): `distinct(domain)` unioned over every considered
   *  project's own `getFacets().domains` (Phase 1's own facet, reused rather than re-derived —
   *  the same building block a per-project page would use). */
  async domains(options: WorkspaceKnowledgeDomainsOptions = {}): Promise<WorkspaceKnowledgeDomainsResult> {
    const sources = await this.resolveSources();
    const considered = this.filterConsidered(sources, options.projects);

    const outcomes = await mapWithConcurrency(considered, this.concurrency, async (source): Promise<DomainOutcome> => {
      const name = source.name || basename(source.root);
      if (source.status === 'missing') {
        return { health: { id: source.id, name, ok: false, reason: 'project root is missing' }, buckets: [] };
      }
      const resolved = await this.resolveStore(source);
      if (!resolved.ok) {
        return { health: { id: source.id, name, ok: false, reason: resolved.reason }, buckets: [] };
      }
      return { health: { id: source.id, name, ok: true }, buckets: resolved.store.getFacets().domains, store: resolved.store };
    });

    const projects = outcomes.map((o) => o.health);

    const byDomain = new Map<string, { docCount: number; projects: Set<string> }>();
    for (const outcome of outcomes) {
      if (!outcome.health.ok) continue;
      for (const bucket of outcome.buckets) {
        const entry = byDomain.get(bucket.value) ?? { docCount: 0, projects: new Set<string>() };
        entry.docCount += bucket.count;
        entry.projects.add(outcome.health.id);
        byDomain.set(bucket.value, entry);
      }
    }

    const domains: WorkspaceKnowledgeDomainRow[] = [];
    for (const [domain, agg] of [...byDomain.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const indexDocId = this.findIndexDocId(domain, outcomes);
      domains.push({ domain, docCount: agg.docCount, projects: [...agg.projects].sort(), indexDocId });
    }

    return { domains, projects };
  }

  /**
   * Lookup for "the document whose `slug` equals the domain id" (D1), now an exact
   * `KnowledgeStore.findBySlug` call instead of a BM25 probe (SPEC "Workspace knowledge: kill the
   * 5s load, preview in place" — this used to run a full `search()` per domain per request, which
   * re-tokenized the entire corpus from scratch every time; `findBySlug` is O(1)ish against the
   * store's own generation-gated slug index and never touches BM25 at all).
   *
   * **Collisions are resolved exactly as before, still not reported as ambiguous.**
   * `slugify()` has no uniqueness pass, so two documents that title-slugify to the same string are
   * genuinely ambiguous: `findBySlug` returns ALL of them, in the store's own deterministic
   * `(root, path)` order, and this keeps the same "first hit" pick the old BM25-based lookup made
   * (there, "first" meant BM25's top-ranked hit; here it means registry order across `outcomes`,
   * then `(root, path)` order within one project's own matches) — a best guess, not an identity
   * lookup, same caveat as before for callers (e.g. a "view index doc" link, not an authority
   * check).
   */
  private findIndexDocId(domain: string, outcomes: readonly DomainOutcome[]): string | undefined {
    for (const outcome of outcomes) {
      if (!outcome.health.ok || !outcome.store) continue;
      if (!outcome.buckets.some((b) => b.value === domain)) continue;
      const hits = outcome.store.findBySlug(domain);
      if (hits.length > 0) return hits[0]!.id;
    }
    return undefined;
  }

  /**
   * `GET /workspace/knowledge/document` (this spec's own addition): one project's own document by
   * id, through the SAME peek -> instance cache -> standalone-store-under-deadline machinery every
   * other read here uses (`resolveSources`/`resolveStore`) — never a second read path, never a
   * context build (the module's own "READ never instantiates" invariant). An unregistered or
   * missing project and an unknown doc id both collapse to `{ok: false}`; the route layer turns
   * that into 404. A store that fails to build or trips the deadline collapses here too, same as
   * every other failure mode this index reports — the spec's own Risks note: "reported as the
   * endpoint's 404/error path if tripped", not a distinct error shape.
   */
  async getDocument(projectId: string, docId: string): Promise<{ ok: true; document: KnowledgeDocument } | { ok: false }> {
    const sources = await this.resolveSources();
    const source = sources.find((s) => s.id === projectId);
    if (!source || source.status === 'missing') return { ok: false };
    const resolved = await this.resolveStore(source);
    if (!resolved.ok) return { ok: false };
    const document = resolved.store.getDocument(docId);
    if (!document) return { ok: false };
    return { ok: true, document };
  }

  /**
   * Cross-project changelog (D3): a projection over the same indexed documents, filtered to those
   * carrying `changeType` — not a second store, not a new scanner. Reuses everything `search()`
   * and `domains()` already do: `resolveSources`/`filterConsidered`/`resolveStore`, the same
   * `ok:false` per-project row on a missing root, a failed store, or a tripped deadline, and the
   * same bounded concurrency.
   *
   * Per-project listing goes through `store.listDocuments()`, never `store.search()`: `changeType`
   * and `domain` are frontmatter, not part of `SearchableDocument`, so a BM25 query over them would
   * rank on incidental body-text overlap and silently return the wrong set — the exact failure
   * `listDocuments()`'s own doc comment (`knowledge/store.ts`) exists to avoid.
   */
  async changelog(options: WorkspaceKnowledgeChangelogOptions = {}): Promise<WorkspaceKnowledgeChangelogResult> {
    const limit = Math.max(0, options.limit ?? CHANGELOG_DEFAULT_LIMIT);

    const sources = await this.resolveSources();
    const considered = this.filterConsidered(sources, options.projects);

    const outcomes = await mapWithConcurrency(considered, this.concurrency, async (source): Promise<ChangelogOutcome> => {
      const name = source.name || basename(source.root);
      if (source.status === 'missing') {
        return { health: { id: source.id, name, ok: false, reason: 'project root is missing' }, entries: [] };
      }
      const resolved = await this.resolveStore(source);
      if (!resolved.ok) {
        return { health: { id: source.id, name, ok: false, reason: resolved.reason }, entries: [] };
      }
      const docs = resolved.store
        .listDocuments()
        .filter((d) => d.changeType !== undefined)
        .filter((d) => (options.domain ? d.domain === options.domain : true));
      const entries: WorkspaceKnowledgeResultRow[] = docs.map((document) => ({ project: source.id, document }));
      return { health: { id: source.id, name, ok: true }, entries };
    });

    const projects = outcomes.map((o) => o.health);
    const merged = outcomes.flatMap((o) => o.entries).sort(byUpdatedAtThenId);

    // `since` is applied AFTER the merge, over the (domain/project-filtered but not yet
    // date-filtered) set — `sinceExcludedAll` is deliberately scoped to what `since` itself threw
    // away, not to domain/project filtering upstream of it, so it never misattributes an
    // already-empty result to `since`.
    let entries = merged;
    let sinceExcludedAll: boolean | undefined;
    if (options.since !== undefined) {
      const sinceMs = Date.parse(options.since);
      const hadEntriesBeforeSince = merged.length > 0;
      entries = Number.isNaN(sinceMs)
        ? []
        : merged.filter((row) => {
            const rowMs = Date.parse(row.document.updatedAt);
            return !Number.isNaN(rowMs) && rowMs >= sinceMs;
          });
      if (hadEntriesBeforeSince && entries.length === 0) sinceExcludedAll = true;
    }

    return { entries: entries.slice(0, limit), projects, sinceExcludedAll };
  }
}
