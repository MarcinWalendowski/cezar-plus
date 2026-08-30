import { z } from 'zod';
import { PROJECT_ID_RE } from '../workspace/config.ts';

/**
 * F2's storage schemas (W1.5, `.ai/specs/2026-08-06-external-source-connectors-notion.md`
 * "Data Models"; `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D1..D25 outranks the spec on
 * conflict). These are the OPEN, on-disk half — `.passthrough()` at every object layer, every new
 * field optional or `.default()`ed, matching `automations/types.ts` and BACKWARD_COMPATIBILITY.md
 * section 3: a `safeParse` over a whole array must never let one bad row, or one field a newer
 * cezar wrote, evict an older file's siblings.
 *
 * The CLOSED wire half lives in `@loki-labs/cezar-plus-contract`'s `sources.ts` (scaffold-owned,
 * W1.1) and is a *different*, flatter shape by design — see that file's own header.
 *
 * **`SourceKind` is a plain string (Q2 of the spec), never a literal union** — that is precisely
 * the `ForgeKind` mistake (`forge/types.ts:12`) this seam exists to avoid, so a second provider
 * (Linear, Jira, Drive) is one new file plus one registry row, never a schema change.
 */

// ---- shared vocabulary -----------------------------------------------------------------------

/** Never widened into a literal union — see the module header. */
export const sourceKindSchema = z.string().min(1).max(32);
export type SourceKind = z.infer<typeof sourceKindSchema>;

/**
 * Per-kind connection-interval policy, keyed by the plain `SourceKind` string — the same "one new
 * row, no schema change" shape `./registry.ts`'s `SOURCE_PROVIDERS` uses for factories, kept here
 * as data rather than as an `if (kind === ...)` branch in `sourceConnectionSchema` below, and kept
 * as a literal string rather than an import from a specific provider module (e.g.
 * `./cezar-hub/provider.ts`'s `CEZAR_HUB_SOURCE_KIND`) so this file stays what its own header
 * promises: it knows `kind` as an opaque string, never a specific provider's identity.
 *
 * The default floor (300s) protects a THIRD-PARTY api (Notion, ...) from being hammered by an
 * aggressive poll interval — a real rate-limit concern. `cezar-hub` talks to our OWN box over the
 * enrollment tunnel, and under the manifest + `hash` + `?since=` design a no-change sweep costs
 * exactly one small HTTP request (D8a of `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, item
 * 56): 60s -> 1,440 requests/day against our own box, each a cheap delta manifest — nothing like
 * 60s against Notion would be.
 */
const SOURCE_KIND_INTERVAL_POLICY: Readonly<Record<string, { min: number; default: number }>> = {
  'cezar-hub': { min: 60, default: 60 },
};
const DEFAULT_INTERVAL_POLICY = { min: 300, default: 900 };

/** The floor `sourceConnectionSchema`'s `superRefine` enforces for one `kind`. Exported so a
 *  provisioner (e.g. the S5 cluster-runtime bootstrap that arms a `cezar-hub` connection) can pick
 *  a legal value instead of guessing one. */
export function minIntervalSecondsForKind(kind: string): number {
  return (SOURCE_KIND_INTERVAL_POLICY[kind] ?? DEFAULT_INTERVAL_POLICY).min;
}

/** The interval a NEW connection of this `kind` should get when nothing more specific is chosen.
 *  Not wired into `intervalSeconds`'s own `.default()` below — a zod field default cannot see a
 *  sibling field's value (`kind`), so a per-kind schema-level default would need reshaping
 *  `sourceConnectionSchema` into a whole-object `.transform()`, changing what every existing
 *  `SourceConnectionInput`/`SourceConnection` consumer sees. `SourceStore.create()`'s own input
 *  type (`Omit<SourceConnection, ...>`, the OUTPUT type) already forces every caller to pass a
 *  concrete `intervalSeconds`, so that default is not load-bearing there either — this export is
 *  the one, honest place a caller building that value gets it right. */
export function defaultIntervalSecondsForKind(kind: string): number {
  return (SOURCE_KIND_INTERVAL_POLICY[kind] ?? DEFAULT_INTERVAL_POLICY).default;
}

/** DATA, never `typeof provider.x === 'function'` (Q3): all five required so a provider that
 *  forgets one fails `parse`, not a runtime probe. */
export const sourceCapabilitiesSchema = z.object({
  list: z.boolean(),
  fetch: z.boolean(),
  poll: z.boolean(),
  push: z.boolean(),
  comments: z.boolean(),
});
export type SourceCapabilities = z.infer<typeof sourceCapabilitiesSchema>;

export const sourceAvailabilitySchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
});
export type SourceAvailability = z.infer<typeof sourceAvailabilitySchema>;

export const sourceSyncStateSchema = z.enum(['never-synced', 'ok', 'stale', 'error', 'unavailable', 'paused']);
export type SourceSyncState = z.infer<typeof sourceSyncStateSchema>;

export const sourceCollectionKindSchema = z.enum(['database', 'page-tree']);
export type SourceCollectionKind = z.infer<typeof sourceCollectionKindSchema>;

export const sourceConnectionModeSchema = z.enum(['mirror', 'archived']);
export type SourceConnectionMode = z.infer<typeof sourceConnectionModeSchema>;

/** The honest lossiness contract (spec "Block to Markdown"): named per document, never dropped in
 *  silence. `unsupported` is the catch-all for a block type Notion adds later. */
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

export const sourceDocumentOriginSchema = z.enum(['remote', 'local']);
export type SourceDocumentOrigin = z.infer<typeof sourceDocumentOriginSchema>;

export const sourceDocumentStateSchema = z.enum(['ok', 'conflict', 'tombstoned', 'truncated']);
export type SourceDocumentState = z.infer<typeof sourceDocumentStateSchema>;

export const sourceDocTypeSchema = z.enum(['page', 'row', 'section', 'transcript', 'summary']);
export type SourceDocType = z.infer<typeof sourceDocTypeSchema>;

// ---- sources.json: connection definitions --------------------------------------------------

export const sourceCollectionRefSchema = z
  .object({
    /** Notion database id, or root page id for a `page-tree` collection. */
    externalId: z.string().min(1).max(200),
    collectionKind: sourceCollectionKindSchema,
    label: z.string().max(200).optional(),
    /** `page-tree` only. */
    maxDepth: z.number().int().min(1).max(8).default(3),
    /** The 783 KB Knowledge page case: splits an oversized page on H2 into section documents. */
    splitOnHeading: z.enum(['none', 'h2']).default('h2'),
  })
  .passthrough();
export type SourceCollectionRef = z.infer<typeof sourceCollectionRefSchema>;
/** Pre-parse shape: `maxDepth`/`splitOnHeading` carry `.default()`, so they are optional going IN
 *  and always present coming OUT. Anything handing a literal to `.parse()` types against this. */
export type SourceCollectionRefInput = z.input<typeof sourceCollectionRefSchema>;

export const sourceConnectionSchema = z
  .object({
    /** URL-segment safe (`workspace/config.ts:27`), same rule as a project id. */
    id: z.string().regex(PROJECT_ID_RE),
    /** Optimistic concurrency — a PUT must echo the revision it read. */
    revision: z.number().int().positive(),
    /** 'notion'. A STRING (Q2), never a literal union. */
    kind: sourceKindSchema,
    name: z.string().min(1).max(200),
    enabled: z.boolean().default(false),
    mode: sourceConnectionModeSchema.default('mirror'),
    /** `.min(60)` is the GLOBAL floor (the lowest any kind may declare); the real, per-kind floor
     *  is enforced below by `superRefine` via `minIntervalSecondsForKind` — see that function's
     *  own doc comment for why the field-level `.default(900)` stays kind-agnostic. */
    intervalSeconds: z.number().int().min(60).max(86_400).default(900),
    collections: z.array(sourceCollectionRefSchema).max(50).default([]),
    watchComments: z.boolean().default(false),
    maxDocuments: z.number().int().min(1).max(20_000).default(5_000),
    maxBodyBytes: z.number().int().min(4_096).max(4_194_304).default(524_288),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    /** Tombstone marker, never a hard delete (Q10). */
    deletedAt: z.string().datetime().optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    const floor = minIntervalSecondsForKind(value.kind);
    if (value.intervalSeconds < floor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['intervalSeconds'],
        message: `intervalSeconds must be >= ${floor} for kind "${value.kind}"`,
      });
    }
  });
export type SourceConnection = z.infer<typeof sourceConnectionSchema>;
/** Pre-parse shape — see `SourceCollectionRefInput`. Every defaulted field is optional here. */
export type SourceConnectionInput = z.input<typeof sourceConnectionSchema>;

export const sourceConnectionsFileSchema = z
  .object({
    version: z.literal(1).default(1),
    connections: z.array(z.unknown()).default([]),
    tombstones: z.record(z.string(), z.string().datetime()).optional(),
  })
  .passthrough();
export type SourceConnectionsFile = z.infer<typeof sourceConnectionsFileSchema>;

// ---- source-state.json: per-connection runtime state ----------------------------------------

const sourceWatermarkSchema = z
  .object({
    timestamp: z.string(),
    tieBreaker: z.string(),
  })
  .passthrough();
export type SourceWatermark = z.infer<typeof sourceWatermarkSchema>;

const sourcePageCursorSchema = z
  .object({
    collectionExternalId: z.string(),
    cursor: z.string(),
  })
  .passthrough();
export type SourcePageCursor = z.infer<typeof sourcePageCursorSchema>;

const sourceLastErrorSchema = z
  .object({
    at: z.string(),
    message: z.string(),
    status: z.number().int().optional(),
  })
  .passthrough();
export type SourceLastError = z.infer<typeof sourceLastErrorSchema>;

/**
 * One connection's runtime state (source-state.json, keyed by connectionId). No per-document rows
 * here — that would be the second index the plan's cross-spec review found (D15/D17); per-document
 * provenance lives ONLY in that document's own frontmatter, read through `SourceSink.readMeta`.
 */
export const sourceStateSchema = z
  .object({
    /** Bumped to match the connection's own `revision` on every definition update, mirroring
     *  `automationRuntimeStateSchema`'s own field. */
    revision: z.number().int().positive().optional(),
    watermarks: z.record(z.string(), sourceWatermarkSchema).default({}),
    pageCursor: sourcePageCursorSchema.optional(),
    lastAttemptAt: z.string().datetime().optional(),
    lastSuccessAt: z.string().datetime().optional(),
    /** Written ONLY when every collection's enumeration reached exhaustion (Q13) — the field that
     *  gates whether absence may ever imply deletion. */
    lastCompleteSweepAt: z.string().datetime().optional(),
    lastError: sourceLastErrorSchema.optional(),
    backoffUntil: z.string().datetime().optional(),
    /** WRITTEN by the scheduler, never derived from the interval at read time (D8). */
    nextDueAt: z.string().datetime().optional(),
    syncState: sourceSyncStateSchema.default('never-synced'),
    syncStateAt: z.string().datetime().optional(),
    documentCount: z.number().int().nonnegative().default(0),
    conflictCount: z.number().int().nonnegative().default(0),
    tombstoneCount: z.number().int().nonnegative().default(0),
    unresolvedComments: z.number().int().nonnegative().default(0),
    /** The set a naive adoption forgets: without it the next sweep re-mirrors an adopted page as a
     *  brand new document (Q11). Keyed by `externalId`, not `docId`. */
    adoptedExternalIds: z.array(z.string()).max(20_000).default([]),
    tombstonedExternalIds: z.array(z.string()).max(20_000).default([]),
  })
  .passthrough();
export type SourceState = z.infer<typeof sourceStateSchema>;

export const sourceStateFileSchema = z
  .object({
    version: z.literal(1).default(1),
    states: z.record(z.string(), sourceStateSchema).default({}),
  })
  .passthrough();
export type SourceStateFile = z.infer<typeof sourceStateFileSchema>;

// ---- source-log.ndjson --------------------------------------------------------------------

export const sourceLogRecordSchema = z
  .object({
    seq: z.number().int().positive(),
    ts: z.string().datetime(),
    connectionId: z.string().min(1),
    event: z.string().min(1).max(100),
    message: z.string().max(2_000).optional(),
    docId: z.string().optional(),
  })
  .passthrough();
export type SourceLogRecord = z.infer<typeof sourceLogRecordSchema>;

// ---- the mirrored document record (frontmatter) ----------------------------------------------

/**
 * F1's nested provenance object (`packages/contract/src/knowledge.ts`'s `knowledgeSourceSchema`),
 * DEFINED THERE and referenced here by name (D17/D24) — ten members, F2 restates no flat list.
 * Open here (storage), closed on F1's wire.
 */
const mirroredSourceSchema = z
  .object({
    kind: sourceKindSchema,
    connectionId: z.string().min(1),
    /** Opaque, survives a rename and a move (Q12). */
    externalId: z.string().min(1).max(200),
    /** Canonical remote URL. */
    url: z.string(),
    /** Notion's `last_edited_time` — the etag. */
    remoteVersion: z.string(),
    /** 'local' means adopted (Q11); this is the field that makes a document immutable. */
    origin: sourceDocumentOriginSchema.default('remote'),
    state: sourceDocumentStateSchema.default('ok'),
    /** STORED. Never recomputed on read (D8). */
    mirroredAt: z.string().datetime(),
    lossy: z.array(sourceLossyKindSchema).default([]),
    /** The tenth member (D24): present only once adopted. */
    adoptedAt: z.string().datetime().optional(),
  })
  .passthrough();
export type MirroredSource = z.infer<typeof mirroredSourceSchema>;

/** One Notion property value, already flattened by the reader (a `select` is its name, a `date`
 *  its ISO string, …) before it ever reaches frontmatter. */
const sourcePropertyValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string(), z.number(), z.boolean()])),
]);

/**
 * The frontmatter of one mirrored `.md` file (spec "Data Models" → "The document record"). Every
 * field beyond `docId`/`title`/`source` is F2-local: the sweep reads it back through `readMeta`,
 * and F1 neither parses nor republishes it (module header, and the spec's "field carry-through").
 */
export const mirroredDocumentSchema = z
  .object({
    docId: z.string().length(16),
    /** Metadata, NOT the filename (Q12) — a rename is one frontmatter field, not a file move. */
    title: z.string().max(500),
    source: mirroredSourceSchema,
    collectionExternalId: z.string(),
    /** Links a `transcript` document back to its `summary` (or vice versa). */
    parentExternalId: z.string().optional(),
    docType: sourceDocTypeSchema.default('page'),
    /** What the last CLEAN pull recorded — the diff-before-fetch comparator (spec step 5). */
    remoteVersionSeen: z.string().optional(),
    /** sha256 of the local body bytes, computed by the sink (`agent-config/files.ts:17-19`'s
     *  idiom) — the drift-detection comparator for quarantine (spec step 8). */
    localVersion: z.string().optional(),
    properties: z.record(z.string(), sourcePropertyValueSchema).default({}),
    unresolvedComments: z.number().int().nonnegative().default(0),
  })
  .passthrough();
export type MirroredDocument = z.infer<typeof mirroredDocumentSchema>;
/** `SourceSink.readMeta`'s return shape — frontmatter only, no body. Same object; named
 *  separately because the port's doc comment calls it out as "a bounded read". */
export type MirroredDocumentMeta = MirroredDocument;

// ---- the sink port --------------------------------------------------------------------------

/**
 * The write path F1 mounts. `FileSourceSink` (`./sink.ts`) is the default, standalone
 * implementation; with `CEZ_KB=1` F1 supplies its own at `ProjectContext` build time (plan W3.1),
 * writing to the same roots and re-indexing on the move. Neither side blocks the other.
 */
export interface SourceSink {
  upsert(doc: MirroredDocument, body: string): Promise<{ localVersion: string; changed: boolean }>;
  /** Frontmatter only, bounded read — never reads or returns the body. */
  readMeta(docId: string): Promise<MirroredDocumentMeta | null>;
  read(docId: string): Promise<{ body: string; localVersion: string } | null>;
  list(connectionId: string): Promise<MirroredDocumentMeta[]>;
  /** The incoming body is quarantined; the local body is left byte-identical (Q14). */
  quarantine(docId: string, remoteVersion: string, body: string): Promise<void>;
  tombstone(docId: string, at: string): Promise<void>;
  /**
   * The cutover. Moves the file OUT of the mirror root into F1's writable knowledge root
   * (`.ai/cezar/knowledge/`, D16) and returns its new identity. One-way. There is no directory
   * named `adopted` anywhere in this feature.
   */
  adopt(docId: string): Promise<{ path: string; adoptedAt: string }>;
  /**
   * REQUIRED after every sweep commit, never best effort (D15). Forwards to F1's
   * `notifyChanged(root, docIds?)` verbatim (D25). `FileSourceSink` implements this as a no-op
   * only because with `CEZ_KB` unset there is no index to notify.
   */
  notifyChanged(root: string, docIds?: readonly string[]): void;
}
