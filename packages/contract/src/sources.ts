import { z } from 'zod';

/**
 * The SOURCES family of `/api/v1` — a `SourceProvider` seam plus one Notion mirror (F2,
 * `CEZ_SOURCES=1`). See `.ai/specs/2026-08-06-external-source-connectors-notion.md` and
 * `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` (D1..D25, especially D3/D15..D18).
 *
 * Closed schemas mirroring the OPEN `.passthrough()` storage schemas
 * (`packages/cezar/src/sources/types.ts`, W1.5): request bodies typed as `z.input`, responses as
 * `z.infer`, following `./automations.ts`. This package is Node-free by construction (its tsconfig
 * has `types: []`), so a `node:*` import here is a compile error rather than a convention.
 *
 * **Not this file's job:** the mirror's provenance object. `source.*` — `kind`, `connectionId`,
 * `externalId`, `url`, `remoteVersion`, `origin`, `state`, `mirroredAt`, `adoptedAt`, `lossy[]` — is
 * defined ONCE in `./knowledge.ts` (D17/D24) and F1 carries it through unchanged; nothing here
 * restates it. The shapes below are F2's OWN route surface (connections, documents as F2 sees them
 * pre-adoption, comments, the sync log), flat by construction, and intentionally NOT the same object.
 *
 * **Flag-off shape (D19, D4).** With `CEZ_SOURCES` unset every `GET` answers 200 with a schema-valid
 * empty payload and every mutator answers 409 — never 404.
 */

/** Registry-keyed, NOT a literal union: that is precisely the `ForgeKind` mistake
 *  (`forge/types.ts:12`), avoided on purpose so a second provider needs no contract change. */
export const sourceKindSchema = z.string().min(1).max(32);
export type SourceKind = z.infer<typeof sourceKindSchema>;

/**
 * Per-kind connection-interval floor, MIRRORING `packages/cezar/src/sources/types.ts`'s own
 * `SOURCE_KIND_INTERVAL_POLICY` — this package cannot import that one (a separate, Node-free
 * package; see the module header), so the same small map is restated here rather than shared,
 * matching how this file already mirrors that one's OPEN storage schemas as a CLOSED wire shape.
 * Keep the two in step by hand.
 *
 * The default floor (300s) protects a THIRD-PARTY api (Notion, ...); `cezar-hub` talks to our own
 * box over the enrollment tunnel, where a no-change sweep costs one small HTTP request under the
 * manifest + `hash` + `?since=` design (D8a of `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`,
 * item 56), so 60s is safe there and nowhere else.
 */
const SOURCE_KIND_MIN_INTERVAL_SECONDS: Readonly<Record<string, number>> = {
  'cezar-hub': 60,
};
const DEFAULT_MIN_INTERVAL_SECONDS = 300;

function minIntervalSecondsForKind(kind: string): number {
  return SOURCE_KIND_MIN_INTERVAL_SECONDS[kind] ?? DEFAULT_MIN_INTERVAL_SECONDS;
}

/** Shared `superRefine` body for both the create and update input schemas below — a stricter,
 *  per-kind floor on top of each field's own kind-agnostic `.min(60)`, the global lowest any kind
 *  may declare. `intervalSeconds` is optional on both bodies (a PUT/POST may omit it entirely), so
 *  an absent value is left for the server's own default rather than flagged here. */
function checkIntervalFloor(value: { kind: string; intervalSeconds?: number }, ctx: z.RefinementCtx): void {
  if (value.intervalSeconds === undefined) return;
  const floor = minIntervalSecondsForKind(value.kind);
  if (value.intervalSeconds < floor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['intervalSeconds'],
      message: `intervalSeconds must be >= ${floor} for kind "${value.kind}"`,
    });
  }
}

export const sourceAvailabilitySchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
});
export type SourceAvailability = z.infer<typeof sourceAvailabilitySchema>;

/** DATA, never `typeof provider.x === 'function'` (Q3): the cockpit must say "read only" before it
 *  calls anything, so all five are required — a partial object fails `parse`. */
export const sourceCapabilitiesSchema = z.object({
  list: z.boolean(),
  fetch: z.boolean(),
  poll: z.boolean(),
  push: z.boolean(),
  comments: z.boolean(),
});
export type SourceCapabilities = z.infer<typeof sourceCapabilitiesSchema>;

export const sourceSyncStateSchema = z.enum(['never-synced', 'ok', 'stale', 'error', 'unavailable', 'paused']);
export type SourceSyncState = z.infer<typeof sourceSyncStateSchema>;

export const sourceCollectionKindSchema = z.enum(['database', 'page-tree']);
export type SourceCollectionKind = z.infer<typeof sourceCollectionKindSchema>;

export const sourceCollectionRefSchema = z.object({
  /** Notion database id, or root page id for a `page-tree` collection. */
  externalId: z.string().min(1).max(200),
  collectionKind: sourceCollectionKindSchema,
  label: z.string().max(200).optional(),
  /** `page-tree` only. */
  maxDepth: z.number().int().min(1).max(8).optional(),
  /** The 783 KB Knowledge page case — splits an oversized page on H2 into section documents. */
  splitOnHeading: z.enum(['none', 'h2']).optional(),
});
export type SourceCollectionRef = z.infer<typeof sourceCollectionRefSchema>;

export const sourceConnectionModeSchema = z.enum(['mirror', 'archived']);
export type SourceConnectionMode = z.infer<typeof sourceConnectionModeSchema>;

/** `GET /sources/providers` — the catalog with capability data and availability, before the user
 *  configures anything. An unavailable provider is rendered greyed with `availability.reason` in the
 *  DOM, never hidden. */
export const sourceProviderInfoSchema = z.object({
  kind: sourceKindSchema,
  label: z.string(),
  capabilities: sourceCapabilitiesSchema,
  availability: sourceAvailabilitySchema,
  /** e.g. "share the page, then set CEZ_NOTION_TOKEN" — never a token field. */
  credentialHint: z.string().optional(),
});
export type SourceProviderInfo = z.infer<typeof sourceProviderInfoSchema>;

/**
 * One connection, as every route answering a connection serves it — the storage definition fields
 * plus the runtime state a caller needs to render a status badge. `mirroredAt` and `syncState`
 * equivalents here are STORED values (Q6/D8): nothing in a handler reads the clock, so three
 * identical GETs return three identical bodies.
 */
export const sourceConnectionWireSchema = z.object({
  id: z.string(),
  /** Optimistic concurrency — a PUT must echo the revision it read. */
  revision: z.number().int(),
  kind: sourceKindSchema,
  name: z.string().min(1).max(200),
  enabled: z.boolean(),
  mode: sourceConnectionModeSchema,
  intervalSeconds: z.number().int(),
  collections: z.array(sourceCollectionRefSchema),
  watchComments: z.boolean(),
  maxDocuments: z.number().int(),
  maxBodyBytes: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  syncState: sourceSyncStateSchema,
  syncStateAt: z.string().optional(),
  /** Written ONLY when every collection's enumeration reached exhaustion on the last sweep (Q13) —
   *  the field that gates whether absence may ever imply deletion. */
  lastCompleteSweepAt: z.string().optional(),
  lastSuccessAt: z.string().optional(),
  /** WRITTEN by the scheduler, never derived from the interval at read time (D8). */
  nextDueAt: z.string().optional(),
  lastErrorMessage: z.string().optional(),
  documentCount: z.number().int(),
  conflictCount: z.number().int(),
  unresolvedComments: z.number().int(),
  availability: sourceAvailabilitySchema,
  /** True only when the connection's most recent sweep enumerated every collection to exhaustion. */
  complete: z.boolean(),
});
export type SourceConnectionWire = z.infer<typeof sourceConnectionWireSchema>;

/** A collection configured on a source connection. */
export const sourceRemoteCollectionSchema = z.object({
  externalId: z.string(),
  collectionKind: sourceCollectionKindSchema,
  label: z.string().optional(),
  documentCount: z.number().int().optional(),
});
export type SourceRemoteCollection = z.infer<typeof sourceRemoteCollectionSchema>;

export const sourceDocTypeSchema = z.enum(['page', 'row', 'section', 'transcript', 'summary']);
export type SourceDocType = z.infer<typeof sourceDocTypeSchema>;

export const sourceDocumentStateSchema = z.enum(['ok', 'conflict', 'tombstoned', 'truncated']);
export type SourceDocumentState = z.infer<typeof sourceDocumentStateSchema>;

export const sourceDocumentOriginSchema = z.enum(['remote', 'local']);
export type SourceDocumentOrigin = z.infer<typeof sourceDocumentOriginSchema>;

/** The honest lossiness contract (never dropped in silence, always named). */
export const sourceLossyKindSchema = z.enum([
  'image',
  'file',
  'video',
  'pdf',
  'audio',
  'embed',
  'bookmark',
  'synced_block',
  'column_list',
  'toggle',
  'child_database',
  'equation',
  'mention',
  'comment',
  'unsupported',
]);
export type SourceLossyKind = z.infer<typeof sourceLossyKindSchema>;

/**
 * One mirrored Notion property value, already FLATTENED by the reader (a `select` is its name, a
 * `date` its ISO string, a `multi_select` an array of names) — see the spec's document record,
 * "Notion select/date/person, flattened".
 *
 * Deliberately NOT `z.unknown()` and NOT `z.json()`, for the same reason `./runs.ts` gave up
 * `z.record(z.string(), z.unknown())` for `workflowDef`: this value goes out over the wire, so it is
 * whatever `JSON.parse` yields and nothing else. `unknown` is wider than the server can serialize —
 * hono maps it to its own `JSONValue`, whose index signature admits `object | symbol | undefined`,
 * so `contract-parity.sources.test.ts` reads the schema as wider than the route in one direction and
 * cannot pass. `z.json()` is the right *value set* but its type is recursive, and hono's `JSONParsed`
 * walking it makes tsc give up with TS2589. A closed, one-level union is representable on both sides,
 * which is what makes the two-way check on this key real rather than skipped.
 */
export const sourcePropertyValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string(), z.number(), z.boolean()])),
]);
export type SourcePropertyValue = z.infer<typeof sourcePropertyValueSchema>;

/**
 * `mirroredAt` and `syncState` are REQUIRED (not optional) — the enforcement mechanism for "a cached
 * mirror never renders without saying how old it is": `contract-parity.sources.test.ts` fails a
 * handler that omits either, rather than shipping a document with no provenance. Both are stored
 * values, so the guarantee costs nothing at request time (Q6).
 */
export const sourceDocumentWireSchema = z.object({
  docId: z.string(),
  externalId: z.string(),
  title: z.string().max(500),
  docType: sourceDocTypeSchema,
  url: z.string(),
  origin: sourceDocumentOriginSchema,
  state: sourceDocumentStateSchema,
  mirroredAt: z.string(),
  syncState: sourceSyncStateSchema,
  lossy: z.array(sourceLossyKindSchema).default([]),
  properties: z.record(z.string(), sourcePropertyValueSchema).default({}),
  /** Body only on the single-document route (`GET .../documents/:docId`). */
  body: z.string().optional(),
});
export type SourceDocumentWire = z.infer<typeof sourceDocumentWireSchema>;

/** `GET /sources/:connectionId/documents` — mirrored metadata, no bodies. */
export const sourceDocumentListItemSchema = sourceDocumentWireSchema.omit({ body: true });
export type SourceDocumentListItem = z.infer<typeof sourceDocumentListItemSchema>;

export const sourceCommentAttachmentSchema = z.object({
  type: z.string(),
  /** An unreadable attachment is recorded as `downloadable: false`, never silently absent. */
  downloadable: z.boolean(),
});
export type SourceCommentAttachment = z.infer<typeof sourceCommentAttachmentSchema>;

export const sourceCommentSchema = z.object({
  id: z.string(),
  docId: z.string(),
  externalId: z.string(),
  author: z.string().optional(),
  body: z.string(),
  createdAt: z.string(),
  attachments: z.array(sourceCommentAttachmentSchema).default([]),
});
export type SourceComment = z.infer<typeof sourceCommentSchema>;

export const sourceLogRowSchema = z.object({
  seq: z.number().int(),
  ts: z.string(),
  connectionId: z.string(),
  event: z.string(),
  message: z.string().optional(),
  docId: z.string().optional(),
});
export type SourceLogRow = z.infer<typeof sourceLogRowSchema>;

// ---- responses -----------------------------------------------------------------------------

/** `GET /sources`. Flag off (D19) answers `{connections: []}`, never 404. */
export const sourcesListResponseSchema = z.object({
  connections: z.array(sourceConnectionWireSchema),
});
export type SourcesListResponse = z.infer<typeof sourcesListResponseSchema>;

/** `POST /sources` (201), `PUT /sources/:connectionId`. */
export const sourceConnectionResponseSchema = z.object({ connection: sourceConnectionWireSchema });
export type SourceConnectionResponse = z.infer<typeof sourceConnectionResponseSchema>;

export const sourceRemovedResponseSchema = z.object({ removed: z.literal(true) });
export type SourceRemovedResponse = z.infer<typeof sourceRemovedResponseSchema>;

/** `GET /sources/providers`. Flag off answers `{providers: []}`. */
export const sourceProvidersResponseSchema = z.object({
  providers: z.array(sourceProviderInfoSchema),
});
export type SourceProvidersResponse = z.infer<typeof sourceProvidersResponseSchema>;

/** `GET /sources/:connectionId/collections`. */
export const sourceCollectionsResponseSchema = z.object({
  collections: z.array(sourceRemoteCollectionSchema),
});
export type SourceCollectionsResponse = z.infer<typeof sourceCollectionsResponseSchema>;

/** `POST /sources/:connectionId/sync` — 202, the manual kick. The sweep runs off the request path. */
export const sourceSyncKickResponseSchema = z.object({ syncId: z.string() });
export type SourceSyncKickResponse = z.infer<typeof sourceSyncKickResponseSchema>;

/** `GET /sources/:connectionId/documents`. Flag off answers `{documents: []}`. */
export const sourceDocumentsResponseSchema = z.object({
  documents: z.array(sourceDocumentListItemSchema),
});
export type SourceDocumentsResponse = z.infer<typeof sourceDocumentsResponseSchema>;

/** `GET /sources/:connectionId/documents/:docId`. Flag off answers `{document: null}` (D19, the
 *  same shape `./knowledge.ts` and `./notes.ts` use for a single-resource GET). */
export const sourceDocumentResponseSchema = z.object({ document: sourceDocumentWireSchema.nullable() });
export type SourceDocumentResponse = z.infer<typeof sourceDocumentResponseSchema>;

/** `POST /sources/:connectionId/documents/:docId/adopt` — the cutover. Mirrors `SourceSink.adopt`'s
 *  own return shape: a one-way move into F1's writable knowledge root, D16. */
export const adoptSourceDocumentResponseSchema = z.object({
  path: z.string(),
  adoptedAt: z.string(),
});
export type AdoptSourceDocumentResponse = z.infer<typeof adoptSourceDocumentResponseSchema>;

/** `POST /sources/:connectionId/documents/:docId/resolve` — the conflict resolver. Exactly two
 *  actions; there is no merge and no third option. */
export const resolveSourceConflictInputSchema = z.object({
  action: z.enum(['keep-local', 'take-remote']),
});
export type ResolveSourceConflictInput = z.input<typeof resolveSourceConflictInputSchema>;

export const resolveSourceConflictResponseSchema = z.object({ document: sourceDocumentWireSchema });
export type ResolveSourceConflictResponse = z.infer<typeof resolveSourceConflictResponseSchema>;

/** `GET /sources/:connectionId/comments`. Flag off answers `{comments: []}`. */
export const sourceCommentsResponseSchema = z.object({
  comments: z.array(sourceCommentSchema),
});
export type SourceCommentsResponse = z.infer<typeof sourceCommentsResponseSchema>;

/** `GET /sources/:connectionId/log` — cursor plus limit, capped at 100. Flag off answers
 *  `{rows: []}`. */
export const sourceLogResponseSchema = z.object({
  rows: z.array(sourceLogRowSchema),
  nextCursor: z.string().optional(),
});
export type SourceLogResponse = z.infer<typeof sourceLogResponseSchema>;

// ---- request bodies ------------------------------------------------------------------------

/** The plain `ZodObject` both request bodies below extend — kept unexported and un-refined so
 *  `.extend()` stays available (`superRefine` returns a `ZodEffects`, which has no `.extend()`);
 *  each of the two exported schemas below attaches its own `checkIntervalFloor` afterward. */
const sourceConnectionInputBaseSchema = z.object({
  kind: sourceKindSchema,
  name: z.string().min(1).max(200),
  enabled: z.boolean().optional(),
  mode: sourceConnectionModeSchema.optional(),
  /** `.min(60)` is the global floor; the real, per-kind floor is `checkIntervalFloor`, applied by
   *  `superRefine` below. */
  intervalSeconds: z.number().int().min(60).max(86_400).optional(),
  collections: z.array(sourceCollectionRefSchema).max(50).optional(),
  watchComments: z.boolean().optional(),
  maxDocuments: z.number().int().min(1).max(20_000).optional(),
  maxBodyBytes: z.number().int().min(4_096).max(4_194_304).optional(),
});

/** `POST /sources`. The connection definition minus everything the server owns — id, revision, the
 *  timestamps and every runtime-state field. */
export const createSourceConnectionInputSchema = sourceConnectionInputBaseSchema.superRefine(checkIntervalFloor);
export type CreateSourceConnectionInput = z.input<typeof createSourceConnectionInputSchema>;

/** `PUT /sources/:connectionId` — the same body plus the revision the editor read; a stale one
 *  answers 409 rather than overwriting somebody else's edit. */
export const updateSourceConnectionInputSchema = sourceConnectionInputBaseSchema
  .extend({ expectedRevision: z.number().int() })
  .superRefine(checkIntervalFloor);
export type UpdateSourceConnectionInput = z.input<typeof updateSourceConnectionInputSchema>;
