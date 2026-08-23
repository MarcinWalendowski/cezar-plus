import {
  CLUSTER_CORPUS_DEFAULT_SCOPE,
  clusterCorpusManifestResponseSchema,
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
 * `.ai/runs/2026-08-22-multi-node-cezar-cluster/PLAN.md` package **3b.1**). Replaces the scaffold
 * stub that shipped with the one `SOURCE_PROVIDERS` row — see that row's own comment in
 * `../registry.ts` for why the row landed before this file did.
 *
 * **A worker is provisioned to be destroyed, so it must not be where knowledge lives — but an
 * agent running there still has to READ the record.** `workflows/run.ts` grants an agent
 * `--add-dir` onto whatever this node's own knowledge catalog resolves to; there is no API path an
 * agent takes instead. So this provider pulls the hub's corpus down over `GET
 * /api/v1/cluster/corpus` (a scoped manifest) and `GET /api/v1/cluster/corpus/*path` (one body),
 * and `runSourceSync` (`../sync.ts`, untouched by this package) does the rest: diff-before-fetch,
 * quarantine on divergence, `notifyChanged` after every commit. Nothing in this file talks to
 * `../sync.ts` directly — that is the whole point of the seam.
 *
 * **This provider costed exactly what D8a's registry docblock promised: one file, one row, no
 * contract change, no route change, no UI change.** `packages/contract/src/cluster.ts` already
 * carried `clusterCorpusManifestResponseSchema` / `ClusterCorpusDoc` / `CLUSTER_CORPUS_DEFAULT_SCOPE`
 * before this package started (scaffold work, W1.0/W2.0 of the cluster plan) — nothing here added
 * to that file. What this file does NOT yet have a landed contract for is `GET
 * /api/v1/cluster/corpus/*path`'s response body and the hub-side route handlers themselves — both
 * are package **3b.2**, which depends on 3b.1 (this package), not the other way around. So the doc
 * request/response shape below (`cezarHubDocResponseSchema`) is THIS file's own proposal,
 * deliberately lenient (`.passthrough()`) rather than `.strict()` — 3b.2 builds the hub side to
 * match, or revises this file if a better shape turns up. Flagged in the 3b.1 implementation
 * report rather than guessed at silently.
 *
 * **SUPERSEDED 2026-08-23 by D20.** ~~This paragraph originally went on to propose the auth
 * headers the same way: `Authorization: Bearer <secret>` + `x-cezar-node-id`, this file's own
 * invention, flagged rather than guessed at silently, same as the doc response shape above.~~ D20
 * landed `cluster/node-auth.ts`'s request-bound signed principal for the whole
 * `/api/v1/cluster/*` family in the meantime, which supersedes that proposal outright rather than
 * sitting beside it — a bearer secret is a durable, replayable credential, and D20 exists
 * specifically so a captured header pair can't be replayed against a different route or body, or
 * outside a freshness window. `request()` below now signs every call through
 * `signedNodeRequestHeaders` and sends no bearer header at all. Left in place, unlike a deletion,
 * so a reader who only remembers the old shape finds out what replaced it rather than finding a
 * header silently gone.
 *
 * **Auth never touches the real process environment.** `StoredClusterNodeIdentity.secret`
 * (`packages/contract/src/cluster.ts`) says so explicitly: "`0600`, and deliberately not in the
 * environment." But `SOURCE_PROVIDERS`' factory type is fixed at `(connection, deps?:
 * SourceProviderDeps) => SourceProvider` — `SourceProviderDeps` is `{env?, now?}` only, and this
 * package may not widen it (that would be a contract change the registry docblock promises a
 * second provider never needs). The resolution: `deps.env` was ALREADY an injection point, not
 * necessarily real `process.env` — Notion's own `NotionSourceProviderOptions` documents `env` as
 * "so a test can supply one." Whoever wires a live `cezar-hub` connection (a later package, not
 * 3b.1) reads `loadNodeIdentity()` once and passes a small synthetic record through `deps.env`
 * carrying `CEZ_CLUSTER_NODE_ID` / `CEZ_CLUSTER_SECRET` — those two names are never expected to be
 * real OS environment variables, only this seam's carrier. `CEZ_CLUSTER_HUB` (the hub URL) is the
 * one exception: D1 already makes it a real, documented spoke boot-time env var, so falling back to
 * genuine `process.env` for it is not a new credential path.
 *
 * **One static collection, not `connection.collections`-reflecting.** `NotionSourceProvider`
 * reflects the connection's own configured `collections[]` because a Notion workspace has several
 * meaningfully different databases/page-trees to choose among. The hub corpus has exactly one thing
 * to mirror — the manifest already comes back scoped server-side to "the asking node's mirror set"
 * — so `listCollections()` always returns one collection (`externalId: 'corpus'`), and `scope`
 * (which top-level directories: `knowledge`/`domains`/`changelog`/`tasks` by default, `reports`/
 * `raw-input` opt-in) is a provider-level construction option, not a per-collection one.
 *
 * **`detect()` has no cheaper probe to call, unlike Notion's `/v1/users/me`.** There is no lighter
 * "am I reachable" endpoint proposed for the corpus family, so `detect()` fetches the same manifest
 * `pollChanges` does. `../sync.ts`'s own sweep calls `provider.detect()` (step 3) immediately before
 * `pollChanges` (steps 4-9), so ONE sweep tick costs two manifest fetches, not one. Given "sync cost
 * is not the constraint here; correctness is" (spec, corpus 13 MB / 2140 files), this is accepted as
 * a documented cost rather than built around — a cheap `HEAD`/ping endpoint on 3b.2's hub routes
 * would remove it and is worth adding there if the duplicate call ever matters in practice.
 *
 * **No real pagination in the manifest response as currently landed.**
 * `clusterCorpusManifestResponseSchema` carries `complete: boolean` but no cursor/page token, and
 * the spec is explicit that this is deliberate — "the corpus is 13 MB / 2140 files … a full
 * snapshot is one HTTP response." So `pollChanges`/`listDocuments` always fetch the whole (scoped)
 * manifest in one call; `nextPageCursor` is always `null`. `complete: false` on an otherwise
 * successful response is treated as `truncated: true` (retried next tick, no backoff — matches
 * `../sync.ts`'s own "the call budget stopped us" reading); an HTTP-level failure (network error,
 * non-2xx, unparseable body) is `truncated: false` (a real failure, triggers `../sync.ts`'s
 * exponential backoff).
 *
 * **Tombstoning is the hub's explicit signal, never this provider's inference.** The manifest's
 * `tombstones[]` array is the ONLY source of `{type:'tombstone'}` changes this provider emits. A
 * document that is simply absent from `docs[]` (because the hub omitted it from a delta, or because
 * this file's own request failed and returned a stale/partial view) never becomes a tombstone here
 * — `../sync.ts`'s own docblock is emphatic that absence is not evidence of deletion, and this
 * provider does not second-guess that by diffing `docs[]` against anything it remembers locally.
 *
 * **Deliberately deferred to package 3b.4** (per the plan, dependent on 3b.2's hub routes landing
 * first): `pushDocument` (`cez kb submit`'s transport, `POST /api/v1/cluster/corpus/submit`) still
 * throws below. `capabilities.push` is left `true` (matching the scaffold stub this file replaces)
 * because the capability is real and coming, not a promise this file itself keeps.
 */

export const CEZAR_HUB_SOURCE_KIND: SourceKind = 'cezar-hub';

const CORPUS_COLLECTION_ID = 'corpus';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DETECT_CACHE_MS = 60_000; // mirrors notion/client.ts's own probe cache window

const NOT_IMPLEMENTED_PUSH =
  'not implemented: sources/cezar-hub/provider.ts push half — package 3b.4 of .ai/runs/2026-08-22-multi-node-cezar-cluster/PLAN.md';

const CEZAR_HUB_CAPABILITIES: SourceCapabilities = {
  list: true,
  fetch: true,
  poll: true,
  push: true,
  comments: false,
};

/** This file's own proposal for `GET /api/v1/cluster/corpus/*path`'s response — no landed contract
 *  schema exists yet (see module header). `.passthrough()` because 3b.2, not this file, gets to
 *  settle the final wire shape; only `path`/`body` are load-bearing here. */
const cezarHubDocResponseSchema = z
  .object({
    path: z.string().min(1),
    body: z.string(),
  })
  .passthrough();

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
  /** Which top-level corpus directories to mirror. Defaults to
   *  `CLUSTER_CORPUS_DEFAULT_SCOPE` — `reports`/`raw-input` are opt-in only, never a default,
   *  because 196 report files carry phone numbers and chat ids (D8a). */
  scope?: readonly string[];
  /** Injectable for tests — no live network in any test in this module (matches
   *  `notion/provider.ts`). */
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

type FetchOutcome = { ok: true; json: unknown } | { ok: false; reason: string };
type ManifestOutcome = { ok: true; manifest: ClusterCorpusManifestResponse } | { ok: false; reason: string };

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
    const result = await this.fetchManifest();
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

    const result = await this.fetchManifest();
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

    const result = await this.fetchManifest();
    if (!result.ok) return { changes: [], watermark: since, nextPageCursor: null, complete: false, truncated: false };

    // Upserts first, then EXPLICIT tombstones only (module header) — never inferred from `docs[]`
    // simply omitting a path.
    const changes: SourceChange[] = [
      ...result.manifest.docs.map((doc): SourceChange => ({ type: 'upsert', doc: this.toDocumentRef(doc, collection.externalId) })),
      ...result.manifest.tombstones.map(
        (tombstone): SourceChange => ({ type: 'tombstone', externalId: tombstone.path, collectionExternalId: collection.externalId }),
      ),
    ];
    // No cursor in the wire contract to advance a watermark from (module header) - `since` rides
    // through unchanged, and the sink's own diff-before-fetch (`remoteVersionSeen === hash`) is
    // what keeps a steady-state sweep cheap instead.
    return { changes, watermark: since, nextPageCursor: null, complete: result.manifest.complete, truncated: !result.manifest.complete };
  }

  /** Never throws (provider contract): a fetch failure or a malformed body both come back `null`,
   *  and `../sync.ts` simply retries next tick. */
  async fetchDocument(ref: SourceDocumentRef): Promise<SourceDocument | null> {
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

  /** One HTTP call: auth headers, a timeout, and zod validation of the parsed manifest. Never
   *  throws - every failure mode (no hub configured, no credential, network error, non-2xx,
   *  unparseable body, a body that fails the schema) comes back as `{ok:false, reason}`. */
  private async fetchManifest(): Promise<ManifestOutcome> {
    if (!this.hubUrl) return { ok: false, reason: 'no cluster hub configured - set CEZ_CLUSTER_HUB or pass hubUrl' };
    if (!this.nodeId || !this.secret) {
      return { ok: false, reason: 'no cluster credential for this node - it has not joined a cluster' };
    }
    const query = new URLSearchParams({ scope: this.scope.join(',') });
    const outcome = await this.request(`${this.hubUrl}/api/v1/cluster/corpus?${query.toString()}`);
    if (!outcome.ok) return outcome;
    const parsed = clusterCorpusManifestResponseSchema.safeParse(outcome.json);
    if (!parsed.success) return { ok: false, reason: 'the hub returned a malformed corpus manifest' };
    return { ok: true, manifest: parsed.data };
  }

  private async fetchDoc(path: string): Promise<{ body: string } | null> {
    if (!this.hubUrl || !this.nodeId || !this.secret) return null;
    const outcome = await this.request(`${this.hubUrl}/api/v1/cluster/corpus/${encodePathSegments(path)}`);
    if (!outcome.ok) return null;
    const parsed = cezarHubDocResponseSchema.safeParse(outcome.json);
    if (!parsed.success) return null;
    return { body: parsed.data.body };
  }

  /** Signs with `cluster/node-auth.ts` (D20) rather than the bearer header this file used to send
   *  (module header). Every call this method serves is a bodyless GET, so the default `bodyText` of
   *  `''` is right for all of them. The `nodeId`/`secret` guard below is belt and suspenders — both
   *  call sites (`fetchManifest`, `fetchDoc`) already refuse before reaching this method — but it
   *  keeps this method honest on its own rather than trusting every future caller to re-derive the
   *  same check, and it is what turns an impossible-today gap into a stated reason instead of a
   *  signature over an empty-string secret. */
  private async request(url: string): Promise<FetchOutcome> {
    if (!this.nodeId || !this.secret) {
      return { ok: false, reason: 'no cluster credential for this node - it has not joined a cluster' };
    }
    const signed = signedNodeRequestHeaders({
      nodeId: this.nodeId,
      secret: this.secret,
      method: 'GET',
      url: new URL(url),
      now: this.clock,
    });
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { ...signed.headers, accept: 'application/json' },
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
