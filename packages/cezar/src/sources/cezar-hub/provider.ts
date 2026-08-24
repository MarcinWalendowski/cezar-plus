import {
  CLUSTER_CORPUS_BATCH_MAX_PATHS,
  CLUSTER_CORPUS_DEFAULT_SCOPE,
  clusterCorpusBodiesResponseSchema,
  clusterCorpusDocResponseSchema,
  clusterCorpusManifestResponseSchema,
  type ClusterCorpusBody,
  type ClusterCorpusDoc,
  type ClusterCorpusManifestResponse,
} from '@loki-labs/better-cezar-contract';
import { z } from 'zod';
import { signedNodeRequestHeaders } from '../../cluster/node-auth.ts';
import type {
  SourceAvailability,
  SourceCapabilities,
  SourceChange,
  SourceChangePage,
  SourceCollection,
  SourceDocument,
  SourceDocumentPage,
  SourceDocumentRef,
  SourceKind,
  SourceListOptions,
  SourcePollOptions,
  SourceProvider,
  SourceProviderDeps,
  SourcePushInput,
  SourcePushResult,
  SourceWatermark,
} from '../provider-types.ts';
import type { SourceConnection } from '../types.ts';

/**
 * The hub as a `SourceProvider` (F2's seam, D8a of
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`; dispatch plan
 * `.ai/runs/2026-08-22-multi-node-cezar-cluster/PLAN.md` package **3b.1**, extended by item **56**'s
 * performance package for the batch/diff-before-fetch work below). Replaces the scaffold stub that
 * shipped with the one `SOURCE_PROVIDERS` row — see that row's own comment in `../registry.ts` for
 * why the row landed before this file did.
 *
 * **A worker is provisioned to be destroyed, so it must not be where knowledge lives — but an
 * agent running there still has to READ the record.** `workflows/run.ts` grants an agent
 * `--add-dir` onto whatever this node's own knowledge catalog resolves to; there is no API path an
 * agent takes instead. So this provider pulls the hub's corpus down over `GET
 * /api/v1/cluster/corpus` (a scoped, optionally `since`-filtered manifest), `POST
 * /api/v1/cluster/corpus/bodies` (many bodies in one round trip) and `GET
 * /api/v1/cluster/corpus/*path` (one body, kept for `adopt` and single-file repair), and
 * `runSourceSync` (`../sync.ts`, untouched by this package) does the rest: per-document
 * write-or-skip, quarantine on divergence, `notifyChanged` after every commit. Nothing in this file
 * talks to `../sync.ts` directly — that is the whole point of the seam.
 *
 * **CORRECTED 2026-08-24 (item 56 of the spec's handoff) — the doc response shape below is now the
 * LANDED contract, not this file's own proposal.** This module used to parse
 * `GET /corpus/*path` with a file-local, deliberately lenient `cezarHubDocResponseSchema`
 * (`.passthrough()`, `path`/`body` only) because no contract schema existed yet for 3b.2's hub
 * routes. `packages/contract/src/cluster.ts` now carries `clusterCorpusDocResponseSchema`
 * (`= clusterCorpusBodySchema`, STRICT: `path`/`hash`/`body`) plus the whole batch family
 * (`clusterCorpusBodiesRequestSchema`/`clusterCorpusBodiesResponseSchema`,
 * `CLUSTER_CORPUS_BATCH_MAX_PATHS`/`CLUSTER_CORPUS_BATCH_MAX_BYTES`) and the delta query
 * (`clusterCorpusManifestQuerySchema`, `?since=<corpusVersion>`). This file now parses against
 * those landed schemas throughout; the hub routes themselves (3b.2) are a different agent's
 * concurrent work against the same contract, not a dependency of this file compiling or testing.
 *
 * **SUPERSEDED 2026-08-23 by D20.** ~~This paragraph originally proposed `Authorization: Bearer
 * <secret>` + `x-cezar-node-id`.~~ `cluster/node-auth.ts`'s request-bound signed principal covers
 * the whole `/api/v1/cluster/*` family, including the new `POST /corpus/bodies` call added here —
 * `request()` below signs every call (GET or POST) through `signedNodeRequestHeaders`, which already
 * accepted a `bodyText`/`method` pair before this package touched it.
 *
 * **Auth never touches the real process environment.** `StoredClusterNodeIdentity.secret`
 * (`packages/contract/src/cluster.ts`) says so explicitly: "`0600`, and deliberately not in the
 * environment." `SourceProviderDeps` is `{env?, now?}` only, and this package does not widen it
 * (the registry docblock's promise: a second provider needs no contract change). `deps.env` was
 * already an injection point (Notion's own `NotionSourceProviderOptions` documents it as "so a test
 * can supply one"); whoever wires a live `cezar-hub` connection reads `loadNodeIdentity()` once and
 * passes `CEZ_CLUSTER_NODE_ID`/`CEZ_CLUSTER_SECRET` through `deps.env` — never real OS env vars.
 * `CEZ_CLUSTER_HUB` is the one exception (D1 already makes it a real, documented spoke env var).
 *
 * **One static collection, not `connection.collections`-reflecting** — the manifest already comes
 * back scoped server-side to "the asking node's mirror set," so `listCollections()` always returns
 * one collection (`externalId: 'corpus'`); `scope` is a provider-level construction option, not a
 * per-collection one.
 *
 * ---
 *
 * ### The performance package (item 56, 2026-08-24) — diff-before-fetch, batching, coalescing
 *
 * Measured against the live hub: corpus 2173 files / 13 MB, churn 12 files/24h, median RTT 108 ms.
 * One GET per document serial is 235 s; batched 200/request is 1.2 s. `../sync.ts`'s own sweep
 * calls `detect()` (step 3) immediately before `pollChanges()` (steps 4-9) on the SAME provider
 * instance, both hitting the manifest — that pair is what this package now coalesces, and
 * `pollChanges()` is what now drives the batch endpoint. Three mechanisms, each explained because
 * each has a real limit worth knowing before relying on it:
 *
 * **1. Manifest coalescing — a single-slot, consume-once cache, not a TTL.** `fetchManifest()`
 * caches its own outcome keyed by `scope|since`; the VERY NEXT call with the SAME key reuses it
 * instead of hitting the network, and concurrent calls with the same key join the same in-flight
 * promise. No wall-clock reasoning anywhere — this is safe specifically because `detect()` then
 * `pollChanges()` is the only call pair that happens within one tick, and the provider instance is
 * short-lived. This is why a no-change sweep costs exactly one manifest request.
 *
 * **2. `since` is real, but only `pollChanges()` receives it — `detect()` structurally cannot.**
 * `pollChanges(since: SourceWatermark | null, ...)` gets the persisted, cross-tick corpusVersion
 * from `../sync.ts`'s own watermark store and sends it as `?since=`, so a returning spoke gets a
 * delta manifest. `detect(): Promise<SourceAvailability>` (the `SourceProvider` interface,
 * `../provider-types.ts`, not this package's file) takes NO arguments and is called BEFORE
 * `pollChanges()` — it has no channel to learn what `since` the upcoming `pollChanges()` call will
 * use. This provider tracks `lastKnownCorpusVersion` in memory (updated after every successful
 * fetch) and `detect()` uses it as a best-effort `since` — correct and complete WITHIN one provider
 * instance's lifetime (exactly what every test below exercises, and what a future caching resolver
 * would give in production), but **`WorkspaceSourceScheduler.runOne()`
 * (`../scheduler.ts`) constructs a brand-new provider via `resolveSourceProvider` on every tick,
 * verified — no caching in the default resolver.** So in today's production default, tick 1 of a
 * connection coalesces perfectly (both calls want `since: undefined`), but tick 2 onward costs TWO
 * manifest requests: `detect()`'s fresh-instance full-manifest probe, and `pollChanges()`'s real
 * delta. Closing this fully needs either a caching `resolveProvider` (the scheduler already exposes
 * that as an injectable option) or a `detect()` signature change — both outside this package's
 * owned files. Flagged here rather than silently claimed fixed.
 *
 * **3. Body batching happens in `pollChanges()`, not in `fetchDocument()` — because `fetchDocument`
 * cannot batch anything.** `../sync.ts`'s `processUpsert` calls `provider.fetchDocument(ref)` once
 * per changed doc, sequentially, `await`ing each call before issuing the next (`for (const change of
 * page.changes) { await processUpsert(...) }`) — there is never a moment where two documents are
 * simultaneously outstanding from the caller's side, so no trick inside `fetchDocument` alone can
 * coalesce multiple calls into one HTTP request. What DOES have visibility into the whole changed
 * set is `pollChanges()` itself: with `since` in play, `manifest.docs[]` IS the changed set (the hub
 * filters server-side), so `pollChanges()` eagerly batch-fetches bodies for every doc the manifest
 * just reported — via `POST /corpus/bodies`, chunked at `CLUSTER_CORPUS_BATCH_MAX_PATHS`, four
 * chunks in flight at a time (`PREFETCH_CONCURRENCY` below; picked as a small, deliberate cap per
 * item 56's "not fully serial, not unbounded 11-at-once") — and caches the results
 * (`this.bodyCache`, keyed by path, validated against the manifest's own `hash` before being
 * trusted). `fetchDocument()` then serves from that cache when it can, falling back to the existing
 * single-document `GET /corpus/*path` route when it can't (a fresh instance whose `pollChanges()`
 * was never called — exactly the `adopt`/single-file-repair case the per-document route is kept
 * for). **On a WHOLE-corpus (no-`since`) manifest this eagerly fetches every body**, which is the
 * deliberate cold-mirror shape (235 s serial -> 1.2 s batched) rather than an accident; it is only
 * safe from becoming a no-change-sweep regression because a genuine no-change tick's manifest fetch
 * is itself a `since`-filtered delta with an EMPTY `docs[]` (mechanism 2 above) once `since` is
 * flowing, and prefetch of zero docs issues zero batch requests. Never fatal: a batch failure just
 * leaves the cache unpopulated and `fetchDocument()` falls through to its per-document GET, same as
 * before this package existed.
 *
 * **Tombstoning is still the hub's explicit signal, never this provider's inference** — unchanged
 * from the original design: the manifest's `tombstones[]` array is the ONLY source of
 * `{type:'tombstone'}` changes; a document absent from `docs[]` (because it is genuinely unchanged
 * in a delta, or because a request failed) is never treated as deleted.
 *
 * **Deliberately deferred to package 3b.4**: `pushDocument` (`cez kb submit`'s transport,
 * `POST /api/v1/cluster/corpus/submit`) still throws below. `capabilities.push` is left `true`
 * (matching the scaffold stub this file replaced) because the capability is real and coming, not a
 * promise this file itself keeps.
 */

export const CEZAR_HUB_SOURCE_KIND: SourceKind = 'cezar-hub';

const CORPUS_COLLECTION_ID = 'corpus';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DETECT_CACHE_MS = 60_000; // mirrors notion/client.ts's own probe cache window

/** Chunks in flight at once while prefetching bodies (mechanism 3 above). A cold 2173-doc mirror is
 *  11 chunks of <=`CLUSTER_CORPUS_BATCH_MAX_PATHS`; 4 keeps that comfortably below the ~1.2s the
 *  spec measured for the fully-serial 11-chunk case while never hammering the hub with all 11 at
 *  once — a small, deliberate cap, not "as much parallelism as possible." */
const PREFETCH_CONCURRENCY = 4;

const NOT_IMPLEMENTED_PUSH =
  'not implemented: sources/cezar-hub/provider.ts push half — package 3b.4 of .ai/runs/2026-08-22-multi-node-cezar-cluster/PLAN.md';

const CEZAR_HUB_CAPABILITIES: SourceCapabilities = {
  list: true,
  fetch: true,
  poll: true,
  push: true,
  comments: false,
};

/** `SourceWatermark` (`../types.ts`, not this package's file) is shaped for Notion's
 *  timestamp+tie-breaker cursor and carries a `.passthrough()` — this provider repurposes that
 *  passthrough to carry the hub's own `corpusVersion` string rather than overloading the
 *  Notion-shaped `timestamp` field with a foreign meaning. `timestamp`/`tieBreaker` are present
 *  (required by the base schema) but unused by this provider. */
const cezarHubWatermarkSchema = z
  .object({ timestamp: z.string(), tieBreaker: z.string(), corpusVersion: z.string().min(1) })
  .passthrough();

function watermarkFor(corpusVersion: string): SourceWatermark {
  return cezarHubWatermarkSchema.parse({ timestamp: '', tieBreaker: '', corpusVersion });
}

function corpusVersionFromWatermark(watermark: SourceWatermark | null | undefined): string | undefined {
  if (!watermark) return undefined;
  const parsed = cezarHubWatermarkSchema.safeParse(watermark);
  return parsed.success ? parsed.data.corpusVersion : undefined;
}

export interface CezarHubSourceProviderOptions extends SourceProviderDeps {
  /** Explicit override; otherwise resolved from `env.CEZ_CLUSTER_HUB` (D1's own real, documented
   *  spoke boot-time env var — see module header on why this one name IS allowed to read real
   *  `process.env` while `nodeId`/`secret` below are not). */
  hubUrl?: string;
  /** This node's own id, from `~/.cezar/cluster/node.json`. Falls back to
   *  `env.CEZ_CLUSTER_NODE_ID` — an injected carrier, never a real OS environment variable (module
   *  header). */
  nodeId?: string;
  /** This node's per-node cluster secret. Falls back to `env.CEZ_CLUSTER_SECRET` — same injected
   *  carrier as `nodeId`, never real `process.env` in production. */
  secret?: string;
  /** Which top-level corpus directories to mirror. Defaults to `CLUSTER_CORPUS_DEFAULT_SCOPE`
   *  (every scope, since the owner's 2026-08-24 correction to D8a — see the contract's own
   *  docblock on that constant). */
  scope?: readonly string[];
  /** Injectable for tests — no live network in any test in this module (matches
   *  `notion/provider.ts`). */
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

type FetchOutcome = { ok: true; json: unknown } | { ok: false; reason: string };
type ManifestOutcome = { ok: true; manifest: ClusterCorpusManifestResponse } | { ok: false; reason: string };
type BodiesOutcome =
  | { ok: true; docs: ClusterCorpusBody[]; missing: string[]; truncated: boolean }
  | { ok: false };

export class CezarHubSourceProvider implements SourceProvider {
  readonly kind = CEZAR_HUB_SOURCE_KIND;
  readonly capabilities: SourceCapabilities = CEZAR_HUB_CAPABILITIES;

  private readonly hubUrl: string | undefined;
  private readonly nodeId: string | undefined;
  private readonly secret: string | undefined;
  private readonly scope: readonly string[];
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly clock: () => number;
  private readonly collection: SourceCollection = {
    externalId: CORPUS_COLLECTION_ID,
    collectionKind: 'database',
    label: 'cezar-hub corpus',
  };
  private availabilityCache?: { at: number; result: SourceAvailability };

  // ---- manifest coalescing (mechanism 1) -------------------------------------------------------
  private manifestReady?: { key: string; result: ManifestOutcome };
  private manifestInFlight?: { key: string; promise: Promise<ManifestOutcome> };
  /** Best-effort, in-memory only (mechanism 2's documented limit). */
  private lastKnownCorpusVersion?: string;

  // ---- body prefetch cache (mechanism 3), consumed once by fetchDocument ----------------------
  private readonly bodyCache = new Map<string, { hash: string; body: string }>();

  constructor(
    private readonly connection: SourceConnection,
    options: CezarHubSourceProviderOptions = {},
  ) {
    const env = options.env ?? process.env;
    this.hubUrl = normalizeHubUrl(options.hubUrl ?? env.CEZ_CLUSTER_HUB);
    this.nodeId = options.nodeId ?? env.CEZ_CLUSTER_NODE_ID;
    this.secret = options.secret ?? env.CEZ_CLUSTER_SECRET;
    this.scope = options.scope && options.scope.length > 0 ? options.scope : CLUSTER_CORPUS_DEFAULT_SCOPE;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.clock = options.now ?? Date.now;
  }

  async detect(): Promise<SourceAvailability> {
    const result = await this.fetchManifest(this.lastKnownCorpusVersion);
    const availability: SourceAvailability = result.ok ? { available: true } : { available: false, reason: result.reason };
    this.availabilityCache = { at: this.clock(), result: availability };
    return availability;
  }

  /** Non-blocking: serves the last-known probe and fires a background refresh when stale, mirroring
   *  `notion/client.ts#detectCached` so a health/status read never pays a network round trip. */
  detectCached(): SourceAvailability | null {
    const cached = this.availabilityCache?.result ?? null;
    const fresh = this.availabilityCache !== undefined && this.clock() - this.availabilityCache.at < DETECT_CACHE_MS;
    if (!fresh) void this.detect().catch(() => {});
    return cached;
  }

  async listCollections(): Promise<SourceCollection[]> {
    return [this.collection];
  }

  async listDocuments(opts: SourceListOptions): Promise<SourceDocumentPage> {
    const collection = this.findCollection(opts.collectionExternalId);
    if (!collection) return { documents: [], nextPageCursor: null, complete: true, truncated: false };
    if ((opts.callBudget ?? 1) <= 0) return { documents: [], nextPageCursor: opts.cursor ?? null, complete: false, truncated: true };

    // A full listing, deliberately not `since`-filtered - this is the "browse everything" path,
    // never called by `../sync.ts` (which only ever calls `pollChanges`), so it does not
    // participate in body prefetching (mechanism 3) either.
    const result = await this.fetchManifest(undefined);
    if (!result.ok) return { documents: [], nextPageCursor: null, complete: false, truncated: false };

    const documents = result.manifest.docs.map((doc) => this.toDocumentRef(doc, collection.externalId));
    return { documents, nextPageCursor: null, complete: result.manifest.complete, truncated: !result.manifest.complete };
  }

  async pollChanges(since: SourceWatermark | null, opts: SourcePollOptions): Promise<SourceChangePage> {
    const collection = this.findCollection(opts.collectionExternalId);
    if (!collection) return { changes: [], watermark: since, nextPageCursor: null, complete: true, truncated: false };
    if ((opts.callBudget ?? 1) <= 0) {
      return { changes: [], watermark: since, nextPageCursor: opts.cursor ?? null, complete: false, truncated: true };
    }

    const result = await this.fetchManifest(corpusVersionFromWatermark(since));
    if (!result.ok) return { changes: [], watermark: since, nextPageCursor: null, complete: false, truncated: false };

    // Mechanism 3: batch-prefetch bodies for exactly what this manifest reported. With `since` in
    // play that IS the changed set (server-side filtered); on a full manifest it is the whole
    // corpus, which is the deliberate cold-mirror shape. Never fatal - see module header.
    await this.prefetchBodies(result.manifest.docs);

    // Upserts first, then EXPLICIT tombstones only (module header) — never inferred from `docs[]`
    // simply omitting a path.
    const changes: SourceChange[] = [
      ...result.manifest.docs.map((doc): SourceChange => ({ type: 'upsert', doc: this.toDocumentRef(doc, collection.externalId) })),
      ...result.manifest.tombstones.map(
        (tombstone): SourceChange => ({ type: 'tombstone', externalId: tombstone.path, collectionExternalId: collection.externalId }),
      ),
    ];
    return {
      changes,
      watermark: watermarkFor(result.manifest.corpusVersion),
      nextPageCursor: null,
      complete: result.manifest.complete,
      truncated: !result.manifest.complete,
    };
  }

  /** Never throws (provider contract): a fetch failure or a malformed body both come back `null`,
   *  and `../sync.ts` simply retries next tick. Serves the mechanism-3 prefetch cache first - a hit
   *  means zero network calls here - and falls back to the single-document GET route otherwise
   *  (the `adopt` / single-file-repair case, and any call not preceded by `pollChanges` on this same
   *  instance). */
  async fetchDocument(ref: SourceDocumentRef): Promise<SourceDocument | null> {
    const cached = this.bodyCache.get(ref.externalId);
    if (cached && cached.hash === ref.remoteVersion) {
      this.bodyCache.delete(ref.externalId); // consume once - keeps the cache bounded across a sweep
      return { ...ref, body: cached.body, lossy: [] };
    }
    const result = await this.fetchDoc(ref.externalId);
    if (!result) return null;
    // The hub already serves rendered markdown bytes verbatim - nothing here re-renders or drops
    // any block type, so there is nothing lossy to report.
    return { ...ref, body: result.body, lossy: [] };
  }

  viewUrl(ref: SourceDocumentRef): string | null {
    return this.hubUrl ? docUrl(this.hubUrl, ref.externalId) : null;
  }

  /** `cez kb submit`'s transport (`POST /api/v1/cluster/corpus/submit`) - package 3b.4, which
   *  depends on 3b.2's hub routes landing first. Left throwing on purpose (module header). */
  async pushDocument(_input: SourcePushInput): Promise<SourcePushResult> {
    throw new Error(NOT_IMPLEMENTED_PUSH);
  }

  private findCollection(externalId: string): SourceCollection | undefined {
    return externalId === this.collection.externalId ? this.collection : undefined;
  }

  private toDocumentRef(doc: ClusterCorpusDoc, collectionExternalId: string): SourceDocumentRef {
    return {
      externalId: doc.path,
      collectionExternalId,
      title: titleFromPath(doc.path),
      url: docUrl(this.hubUrl, doc.path),
      // The manifest's own hash IS the etag (spec Q12's formula, restated for this provider):
      // never recomputed here, exactly what keeps `../sync.ts`'s diff-before-fetch skip effective.
      remoteVersion: doc.hash,
      docType: 'page',
      properties: {},
    };
  }

  // ---- manifest fetch + coalescing (mechanism 1/2) ---------------------------------------------

  /** Single-slot, consume-once cache keyed by `scope|since`, plus in-flight promise sharing for two
   *  calls issued concurrently with the same key (module header, mechanism 1). Never a TTL: safe
   *  specifically because this provider is short-lived and `detect()`+`pollChanges()` is the only
   *  same-key call pair that happens within one tick. */
  private async fetchManifest(since: string | undefined): Promise<ManifestOutcome> {
    const key = `${this.scope.join(',')}|${since ?? ''}`;
    if (this.manifestReady && this.manifestReady.key === key) {
      const { result } = this.manifestReady;
      this.manifestReady = undefined;
      return result;
    }
    if (this.manifestInFlight && this.manifestInFlight.key === key) {
      return this.manifestInFlight.promise;
    }
    const promise = this.fetchManifestOverNetwork(since);
    this.manifestInFlight = { key, promise };
    try {
      const result = await promise;
      if (result.ok) this.lastKnownCorpusVersion = result.manifest.corpusVersion;
      this.manifestReady = { key, result };
      return result;
    } finally {
      if (this.manifestInFlight?.promise === promise) this.manifestInFlight = undefined;
    }
  }

  /** One HTTP call: auth headers, a timeout, and zod validation of the parsed manifest. Never
   *  throws - every failure mode (no hub configured, no credential, network error, non-2xx,
   *  unparseable body, a body that fails the schema) comes back as `{ok:false, reason}`. */
  private async fetchManifestOverNetwork(since: string | undefined): Promise<ManifestOutcome> {
    if (!this.hubUrl) return { ok: false, reason: 'no cluster hub configured - set CEZ_CLUSTER_HUB or pass hubUrl' };
    if (!this.nodeId || !this.secret) {
      return { ok: false, reason: 'no cluster credential for this node - it has not joined a cluster' };
    }
    const query = new URLSearchParams({ scope: this.scope.join(',') });
    if (since) query.set('since', since);
    const outcome = await this.request(`${this.hubUrl}/api/v1/cluster/corpus?${query.toString()}`);
    if (!outcome.ok) return outcome;
    const parsed = clusterCorpusManifestResponseSchema.safeParse(outcome.json);
    if (!parsed.success) return { ok: false, reason: 'the hub returned a malformed corpus manifest' };
    return { ok: true, manifest: parsed.data };
  }

  // ---- body prefetch (mechanism 3) --------------------------------------------------------------

  /** Chunks `docs` at `CLUSTER_CORPUS_BATCH_MAX_PATHS`, runs up to `PREFETCH_CONCURRENCY` chunk
   *  requests at a time, and populates `bodyCache`. Never throws and never affects the return value
   *  of the caller (`pollChanges`): a batch failure just leaves those paths uncached, and
   *  `fetchDocument` falls back to the per-document GET for them, unchanged from before this
   *  package existed. */
  private async prefetchBodies(docs: readonly ClusterCorpusDoc[]): Promise<void> {
    if (docs.length === 0) return;
    const chunks: ClusterCorpusDoc[][] = [];
    for (let i = 0; i < docs.length; i += CLUSTER_CORPUS_BATCH_MAX_PATHS) {
      chunks.push(docs.slice(i, i + CLUSTER_CORPUS_BATCH_MAX_PATHS));
    }
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < chunks.length) {
        const chunk = chunks[cursor++]!;
        await this.fetchBodiesChunk(chunk);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PREFETCH_CONCURRENCY, chunks.length) }, worker));
  }

  /** One chunk (<=`CLUSTER_CORPUS_BATCH_MAX_PATHS` paths), looping on `truncated` (spec item 56
   *  verification 3) until every path in the chunk has either landed in the cache or been accounted
   *  for by `missing` - bounded by the chunk's own size so a hub that always reports `truncated`
   *  cannot loop forever. Each returned body's `hash` is checked against the manifest doc it
   *  answers before being cached (`ClusterCorpusBody`'s own docblock: "the manifest and the body are
   *  two round trips, and the corpus can change between them") - a mismatch is simply left
   *  uncached, not trusted. */
  private async fetchBodiesChunk(docs: readonly ClusterCorpusDoc[]): Promise<void> {
    let pending = docs;
    for (let attempt = 0; pending.length > 0 && attempt <= docs.length; attempt++) {
      const outcome = await this.requestBodies(pending.map((doc) => doc.path));
      if (!outcome.ok) return;
      for (const body of outcome.docs) {
        const expected = pending.find((doc) => doc.path === body.path);
        if (expected && expected.hash === body.hash) this.bodyCache.set(body.path, { hash: body.hash, body: body.body });
      }
      if (!outcome.truncated) return;
      const answered = new Set<string>([...outcome.docs.map((d) => d.path), ...outcome.missing]);
      pending = pending.filter((doc) => !answered.has(doc.path));
    }
  }

  private async requestBodies(paths: string[]): Promise<BodiesOutcome> {
    if (!this.hubUrl) return { ok: false };
    const outcome = await this.request(`${this.hubUrl}/api/v1/cluster/corpus/bodies`, {
      method: 'POST',
      bodyText: JSON.stringify({ paths }),
    });
    if (!outcome.ok) return { ok: false };
    const parsed = clusterCorpusBodiesResponseSchema.safeParse(outcome.json);
    if (!parsed.success) return { ok: false };
    return { ok: true, docs: parsed.data.docs, missing: parsed.data.missing, truncated: parsed.data.truncated };
  }

  // ---- single-document fetch (adopt / single-file repair) --------------------------------------

  private async fetchDoc(path: string): Promise<{ body: string } | null> {
    if (!this.hubUrl || !this.nodeId || !this.secret) return null;
    const outcome = await this.request(`${this.hubUrl}/api/v1/cluster/corpus/${encodePathSegments(path)}`);
    if (!outcome.ok) return null;
    const parsed = clusterCorpusDocResponseSchema.safeParse(outcome.json);
    if (!parsed.success) return null;
    return { body: parsed.data.body };
  }

  /** Signs with `cluster/node-auth.ts` (D20). Bodyless by default (every GET call this method
   *  serves); `requestBodies` above is the one caller that supplies a real `bodyText` for a signed
   *  POST - `signedNodeRequestHeaders` already accepted `method`/`bodyText` before this package
   *  touched it, so no change was needed there. The `nodeId`/`secret` guard below is belt and
   *  suspenders — every call site already refuses before reaching this method — but it keeps this
   *  method honest on its own rather than trusting every future caller to re-derive the same check. */
  private async request(url: string, options: { method?: string; bodyText?: string } = {}): Promise<FetchOutcome> {
    if (!this.nodeId || !this.secret) {
      return { ok: false, reason: 'no cluster credential for this node - it has not joined a cluster' };
    }
    const method = options.method ?? 'GET';
    const bodyText = options.bodyText ?? '';
    const signed = signedNodeRequestHeaders({
      nodeId: this.nodeId,
      secret: this.secret,
      method,
      url: new URL(url),
      bodyText,
      now: this.clock,
    });
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          ...signed.headers,
          accept: 'application/json',
          ...(bodyText ? { 'content-type': 'application/json' } : {}),
        },
        ...(bodyText ? { body: signed.body } : {}),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (!res.ok) return { ok: false, reason: `the hub responded ${res.status}` };
    try {
      return { ok: true, json: await res.json() };
    } catch {
      return { ok: false, reason: 'the hub returned a non-JSON body' };
    }
  }
}

export function createCezarHubSourceProvider(connection: SourceConnection, deps: SourceProviderDeps = {}): SourceProvider {
  return new CezarHubSourceProvider(connection, deps);
}

// ---- helpers ------------------------------------------------------------------------------------

function normalizeHubUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/\/+$/, '');
}

function docUrl(hubUrl: string | undefined, path: string): string {
  return hubUrl ? `${hubUrl}/api/v1/cluster/corpus/${encodePathSegments(path)}` : path;
}

function encodePathSegments(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** Corpus paths carry no separate title field (`ClusterCorpusDoc` is `path`/`hash`/`size`/`mtime`
 *  only) - the filename, extension stripped, is the closest thing available without a second HTTP
 *  call per document. */
function titleFromPath(path: string): string {
  const base = path.split('/').pop() || path;
  return base.replace(/\.mdx?$/i, '');
}
