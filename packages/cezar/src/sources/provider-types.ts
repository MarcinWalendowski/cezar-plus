import type { SourceLossyKind, SourcePropertyValue } from '@loki-labs/cezar-plus-contract';
import {
  sourceAvailabilitySchema,
  sourceCapabilitiesSchema,
  sourceKindSchema,
  type SourceAvailability,
  type SourceCapabilities,
  type SourceCollectionKind,
  type SourceConnection,
  type SourceDocType,
  type SourceKind,
  type SourceWatermark,
} from './types.ts';

/**
 * The `SourceProvider` seam (F2, W2.2). See
 * `.ai/specs/2026-08-06-external-source-connectors-notion.md` ("Architecture" → "The provider
 * seam") and `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D1..D25. `SourceKind`,
 * `SourceCapabilities` and `SourceAvailability` are NOT redefined here — they are `./types.ts`'s
 * (W1.5, already landed) storage schemas, re-exported by name, so there is exactly one definition
 * of each rather than two that can drift (the same discipline the plan's D17 applies to F1's
 * `source` object).
 *
 * **`SourceKind` is a plain string, never a literal union** — that is precisely the `ForgeKind`
 * mistake this seam exists to avoid (a single-member literal union that turns a second provider
 * into a type change at every use site), so a second provider (Linear, Jira, Drive) is one new
 * file plus one registry row, never a schema change. No host-remote lookup of any kind lives on
 * this path — a Notion workspace has no such remote to key off.
 *
 * **Capabilities are DATA** (spec Q3), never `typeof provider.x === 'function'`: the cockpit must
 * be able to say "read only" before it calls anything, and a provider that forgets one of the five
 * required booleans fails `sourceCapabilitiesSchema.parse`, not a runtime probe.
 */

export {
  sourceAvailabilitySchema,
  sourceCapabilitiesSchema,
  sourceKindSchema,
  type SourceAvailability,
  type SourceCapabilities,
  type SourceKind,
  type SourceWatermark,
};

// ---- collections ------------------------------------------------------------------------------

/** One collection as a provider reports it — either a connection's own configured collection
 *  (`listCollections`) or a candidate the sweep enumerates against (`listDocuments`/`pollChanges`
 *  key on `externalId` the same way). */
export interface SourceCollection {
  externalId: string;
  collectionKind: SourceCollectionKind;
  label?: string;
  documentCount?: number;
}

// ---- documents ---------------------------------------------------------------------------------

/**
 * What a provider knows about ONE document before its body is fetched — exactly what a Notion
 * `queryDatabase` row (or a page discovered while walking a page-tree collection) already carries
 * without a further network call. `listDocuments`/`pollChanges` return these; `fetchDocument` is
 * what turns one into a full `SourceDocument` with `body`/`lossy` (spec "The sweep, step by step",
 * step 6, "Convert").
 */
export interface SourceDocumentRef {
  externalId: string;
  collectionExternalId: string;
  /** Links a `transcript` document back to its `summary` (spec "Meeting notes"). Not populated by
   *  every provider in phase 1 — see `notion/provider.ts`'s own header for what it does and does
   *  not implement of the meeting-notes split. */
  parentExternalId?: string;
  title: string;
  url: string;
  /** The provider's own etag for this document — Notion's `last_edited_time` for a database row.
   *  Never recomputed at read time elsewhere (D8); this is the ONE place it is produced. */
  remoteVersion: string;
  docType: SourceDocType;
  properties: Record<string, SourcePropertyValue>;
}

/** A `SourceDocumentRef` plus its rendered body — `fetchDocument`'s return shape. */
export interface SourceDocument extends SourceDocumentRef {
  body: string;
  lossy: SourceLossyKind[];
}

export interface SourceListOptions {
  collectionExternalId: string;
  /** Resume token from a prior `nextPageCursor`; omitted or `null` starts from the beginning. */
  cursor?: string | null;
  /** Max HTTP calls this ONE call may spend. */
  callBudget?: number;
}

export interface SourceDocumentPage {
  documents: SourceDocumentRef[];
  nextPageCursor: string | null;
  complete: boolean;
  truncated: boolean;
}

// ---- polling -------------------------------------------------------------------------------

/** `{type:'upsert', doc}` carries a `SourceDocumentRef` — metadata only, no body — never a fetched
 *  `SourceDocument`; that is exactly the diff-before-fetch split (spec step 5/6): the sweep decides
 *  whether `doc`'s `remoteVersion` is actually new before paying for `fetchDocument`. */
export type SourceChange =
  | { type: 'upsert'; doc: SourceDocumentRef }
  | { type: 'tombstone'; externalId: string; collectionExternalId: string };

export interface SourcePollOptions {
  collectionExternalId: string;
  cursor?: string | null;
  callBudget?: number;
}

/**
 * `complete` is the field the rest of the feature is built around (spec "Pagination is a
 * correctness requirement"): `true` if and only if this ONE call's enumeration reached exhaustion.
 * Every other exit — the call budget ran out, or a request failed — reports `complete: false` and
 * a `nextPageCursor` that resumes exactly where this attempt stopped.
 */
export interface SourceChangePage {
  changes: SourceChange[];
  watermark: SourceWatermark | null;
  nextPageCursor: string | null;
  complete: boolean;
  truncated: boolean;
}

// ---- comments (spec Q17) ------------------------------------------------------------------------

export interface SourceCommentEntry {
  externalId: string;
  author?: string;
  body: string;
  createdAt: string;
  /** An unreadable attachment is recorded as `downloadable: false`, never silently absent. */
  attachments: Array<{ type: string; downloadable: boolean }>;
}

export interface SourceCommentPage {
  comments: SourceCommentEntry[];
  nextPageCursor: string | null;
  complete: boolean;
  truncated: boolean;
}

// ---- push (declared, unused in phase 1 — spec Q9) ------------------------------------------------

export interface SourcePushInput {
  ref: SourceDocumentRef;
  body: string;
  title?: string;
}

export interface SourcePushResult {
  ok: boolean;
  remoteVersion?: string;
  error?: string;
}

// ---- the provider itself ------------------------------------------------------------------------

export interface SourceProvider {
  readonly kind: SourceKind;
  readonly capabilities: SourceCapabilities;
  /** Never throws for an expected absence (no token, revoked token, offline) — mirrors the forge
   *  driver's own contract (`AGENTS.md`: "no CLI, no remote, offline all return
   *  `{available:false, reason}`"). */
  detect(): Promise<SourceAvailability>;
  /** Non-blocking: last-known probe, or `null` before the first one. Never touches the network on
   *  the read itself. */
  detectCached(): SourceAvailability | null;
  listCollections(): Promise<SourceCollection[]>;
  listDocuments(opts: SourceListOptions): Promise<SourceDocumentPage>;
  fetchDocument(ref: SourceDocumentRef): Promise<SourceDocument | null>;
  pollChanges(since: SourceWatermark | null, opts: SourcePollOptions): Promise<SourceChangePage>;
  listComments?(ref: SourceDocumentRef, since?: string): Promise<SourceCommentPage>;
  pushDocument?(input: SourcePushInput): Promise<SourcePushResult>;
  viewUrl(ref: SourceDocumentRef): string | null;
}

/** Constructor deps every provider accepts — deliberately minimal and provider-agnostic (spec Q7:
 *  auth is environment-only, resolved at use, never persisted). A concrete provider MAY accept a
 *  wider, provider-specific options bag for direct construction in its own tests (see
 *  `notion/provider.ts`'s `NotionSourceProviderOptions`); that wider shape is never part of this
 *  seam, only of the one provider that needs it. */
export interface SourceProviderDeps {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export type SourceProviderFactory = (connection: SourceConnection, deps?: SourceProviderDeps) => SourceProvider;
