import { z } from 'zod';

/**
 * The KNOWLEDGE family of `/api/v1` — a knowledge base over Markdown documents mounted from two
 * writable roots and N read-only mounts (F1, `CEZ_KB=1`). See
 * `.ai/specs/2026-08-06-knowledge-base-mounts-search.md` for the full design and
 * `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` (D1..D25) for decisions that outrank it.
 *
 * As with `./automations.ts`, these shapes exist twice on purpose. `packages/cezar/src/knowledge/
 * types.ts` (W2.1) owns the STORAGE schemas — `.passthrough()`, every field optional or defaulted,
 * because a document's frontmatter is user content, not managed state. The schemas here are the
 * CLOSED wire half: every key a route actually answers with, and no index signature, so a document
 * whose provenance carries `source.state: 'conflict'` cannot be silently dropped at the wire the way
 * `.passthrough()` alone would allow (D17). `contract-parity.knowledge.test.ts` (W1.1) checks each
 * response schema against the route that serves it, in both directions.
 *
 * **Flag-off shape (D19, D4).** With `CEZ_KB` unset every `GET` answers 200 with a schema-valid empty
 * payload and every mutator answers 409 — never 404, because the feature is switched off, not
 * missing. The schemas below are shaped so that empty payload is a normal, valid value of the same
 * type as the "on" response, never a second shape.
 */

// ---- shared vocabulary -----------------------------------------------------------------------

/** Unknown falls back to `note` at parse time (server-side); the wire always carries one of these. */
export const knowledgeDocTypeSchema = z.enum(['note', 'decision', 'spec', 'reference', 'meeting', 'runbook']);
export type KnowledgeDocType = z.infer<typeof knowledgeDocTypeSchema>;

/** Unknown falls back to `current`. Superseded documents are demoted in search, never hidden. */
export const knowledgeStatusSchema = z.enum(['current', 'superseded', 'draft']);
export type KnowledgeStatus = z.infer<typeof knowledgeStatusSchema>;

/**
 * Closed enum for a changelog entry (D3, `.ai/specs/2026-08-14-knowledge-domains-and-changelog.md`).
 * A changelog entry is an ordinary knowledge document — presence of `changeType` on it is what
 * makes it one, not a new `knowledgeDocTypeSchema` member. Widening this enum later carries the
 * same released-package caution as `knowledgeDocTypeSchema` itself (D1): an older client's zod
 * parse rejects an enum member it does not know.
 */
export const knowledgeChangeTypeSchema = z.enum(['Added', 'Changed', 'Fixed', 'Removed']);
export type KnowledgeChangeType = z.infer<typeof knowledgeChangeTypeSchema>;

export const knowledgeSourceOriginSchema = z.enum(['remote', 'local']);
export type KnowledgeSourceOrigin = z.infer<typeof knowledgeSourceOriginSchema>;

export const knowledgeSourceStateSchema = z.enum(['ok', 'conflict', 'tombstoned', 'truncated']);
export type KnowledgeSourceState = z.infer<typeof knowledgeSourceStateSchema>;

/**
 * The mirror provenance object (D17/D24), defined ONCE here and referenced by `./sources.ts` rather
 * than restated — F2 fills it in, F1 carries it through unchanged. Ten members. Present and complete
 * on a document a `SourceProvider` mirrored; absent on one nobody mirrored; `origin: 'local'` with
 * `adoptedAt` set on one that was adopted. `mirroredAt` is STORED, never recomputed on read (D8).
 */
export const knowledgeSourceSchema = z.object({
  kind: z.string(),
  connectionId: z.string(),
  externalId: z.string(),
  url: z.string(),
  remoteVersion: z.string(),
  origin: knowledgeSourceOriginSchema,
  state: knowledgeSourceStateSchema,
  mirroredAt: z.string(),
  /** Present only when `origin === 'local'`. */
  adoptedAt: z.string().optional(),
  lossy: z.array(z.string()).default([]),
});
export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;

/**
 * A resolved link is `{target, resolved: true, id}`. An unresolved link is REPORTED, never dropped
 * (`{resolved: false}`); an ambiguous one carries `candidates` rather than silently picking one.
 */
export const knowledgeLinkSchema = z.object({
  target: z.string(),
  resolved: z.boolean(),
  id: z.string().optional(),
  reason: z.string().optional(),
  candidates: z.array(z.string()).optional(),
});
export type KnowledgeLink = z.infer<typeof knowledgeLinkSchema>;

/**
 * The catalog entry and the search result are the SAME object (Q15) — this is that shape.
 * `GET /knowledge/:id` is the one route that additionally carries `body`.
 */
export const knowledgeDocumentSchema = z.object({
  /** Opaque, `<rootId>-<12 hex>` (Q7) — never a client-supplied path, so `GET /knowledge/:id` has no
   *  traversal surface at all. */
  id: z.string(),
  /** Human name. NOT unique — a wikilink resolving to more than one slug is reported ambiguous. */
  slug: z.string(),
  root: z.string(),
  path: z.string(),
  title: z.string(),
  type: knowledgeDocTypeSchema,
  tags: z.array(z.string()).default([]),
  /** Absent means workspace-wide. */
  project: z.string().optional(),
  /**
   * Free-form grouping axis (D1) — an emergent axis, not a fixed list, so its valid set is
   * whatever the index actually contains. NOT a member of `knowledgeDocTypeSchema`: a decision, a
   * spec and a runbook can all share one domain, so a document must be able to say what it IS
   * (`type`) and what it is ABOUT (`domain`) independently. Absent = not filed under a domain.
   */
  domain: z.string().optional(),
  /** Presence of this field is what makes a document a changelog entry (D3) — a projection over
   *  the ordinary knowledge documents, not a second store. Absent on every other document. */
  changeType: knowledgeChangeTypeSchema.optional(),
  status: knowledgeStatusSchema,
  /** The original status string, always kept verbatim, even once normalized into `status`. */
  statusRaw: z.string().optional(),
  supersedes: z.array(z.string()).optional(),
  supersededBy: z.string().optional(),
  supersededAt: z.string().optional(),
  /** Secondary, NON-UNIQUE index (Q7) — an identifier is a set lookup, never a key. */
  identifiers: z.array(z.string()).default([]),
  updatedAt: z.string(),
  hash: z.string(),
  bytes: z.number().int(),
  headings: z.array(z.string()).default([]),
  excerpt: z.string(),
  links: z.array(knowledgeLinkSchema).default([]),
  backlinkCount: z.number().int(),
  /** Present and complete on a mirrored document; absent on one nobody mirrored (Q15). */
  source: knowledgeSourceSchema.optional(),
  /** Only on `GET /knowledge/:id` — the sole route that carries a body. */
  body: z.string().optional(),
});
export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;

/**
 * `GET /knowledge/documents` (skills-preview parity, `.ai/specs/2026-08-17-knowledge-skills-preview-
 * parity.md`) — the browseable catalog projection: the catalog entry minus `body` (never carried
 * outside `GET /knowledge/:id`) AND minus `links` (a per-document resolved-wikilink array with no
 * use on a list row; the reader still gets it from `GET /knowledge/:id`). Narrower than
 * `catalogEntrySchema` (which keeps `links`) on purpose — this is what the wire actually sends.
 */
export const knowledgeDocumentListSchema = knowledgeDocumentSchema.omit({ body: true, links: true });
export type KnowledgeDocumentList = z.infer<typeof knowledgeDocumentListSchema>;

// ---- GET /knowledge: roots, facets, scan, counts ----------------------------------------------

export const knowledgeRootSchema = z.object({
  id: z.string(),
  path: z.string(),
  format: z.string().optional(),
  writable: z.boolean(),
  /** False when the root does not exist, or is a configured mount outside the project root in
   *  hosted mode (`{indexed:false, reason:'external mount is local only'}`) — never a throw. */
  indexed: z.boolean(),
  reason: z.string().optional(),
  documentCount: z.number().int().optional(),
});
export type KnowledgeRoot = z.infer<typeof knowledgeRootSchema>;

export const knowledgeFacetBucketSchema = z.object({ value: z.string(), count: z.number().int() });
export type KnowledgeFacetBucket = z.infer<typeof knowledgeFacetBucketSchema>;

export const knowledgeFacetsSchema = z.object({
  types: z.array(knowledgeFacetBucketSchema).default([]),
  tags: z.array(knowledgeFacetBucketSchema).default([]),
  statuses: z.array(knowledgeFacetBucketSchema).default([]),
  roots: z.array(knowledgeFacetBucketSchema).default([]),
  /** `distinct(domain)` over the index (D1) — a document with no `domain` contributes to no
   *  bucket here, it is not counted as an "unfiled" bucket of its own. */
  domains: z.array(knowledgeFacetBucketSchema).default([]),
});
export type KnowledgeFacets = z.infer<typeof knowledgeFacetsSchema>;

/** A truncated scan is REPORTED here, never silently short (caps: 1 MiB/file, 20,000 files,
 *  64 MiB total, whichever binds first). */
export const knowledgeScanSchema = z.object({
  truncated: z.boolean(),
  filesScanned: z.number().int(),
  bytesScanned: z.number().int(),
  skipped: z.number().int(),
  capHit: z.enum(['files', 'bytes', 'perFile']).optional(),
});
export type KnowledgeScan = z.infer<typeof knowledgeScanSchema>;

export const knowledgeCountsSchema = z.object({
  documents: z.number().int(),
  /** A 12-hex id collision is astronomically unlikely and still DETECTED (Q7), never assumed away. */
  idCollisions: z.number().int(),
});
export type KnowledgeCounts = z.infer<typeof knowledgeCountsSchema>;

/**
 * `GET /knowledge`. Flag off (D19) answers 200 with `enabled: false` and every array/count empty —
 * never 404. Every field is stored or derived from stored data (D8): no `indexedAt`, no `ageMs`, no
 * `builtAt` anywhere here.
 */
export const knowledgeResponseSchema = z.object({
  enabled: z.boolean(),
  roots: z.array(knowledgeRootSchema),
  counts: knowledgeCountsSchema,
  facets: knowledgeFacetsSchema,
  scan: knowledgeScanSchema,
  formatVersion: z.number().int(),
});
export type KnowledgeResponse = z.infer<typeof knowledgeResponseSchema>;

// ---- search -------------------------------------------------------------------------------

/** `GET /knowledge/search`. Flag off answers `{query, total: 0, truncated: false, results: []}`. */
export const knowledgeSearchResponseSchema = z.object({
  query: z.string(),
  total: z.number().int(),
  truncated: z.boolean(),
  results: z.array(knowledgeDocumentSchema),
});
export type KnowledgeSearchResponse = z.infer<typeof knowledgeSearchResponseSchema>;

// ---- single document ------------------------------------------------------------------------

/**
 * `GET /knowledge/:id`. Flag off answers `{document: null}` (200) so a 404 keeps meaning "no such
 * document" and never "no such feature" once the flag is on and the id really is unknown.
 */
export const knowledgeDocumentResponseSchema = z.object({ document: knowledgeDocumentSchema.nullable() });
export type KnowledgeDocumentResponse = z.infer<typeof knowledgeDocumentResponseSchema>;

/**
 * `GET /knowledge/documents`. Flag off answers `{documents: [], total: 0, truncated: false}` (D19)
 * — the same empty-payload discipline as every other read in this family. `truncated` mirrors the
 * store's own scan-truncation flag (same source `GET /knowledge`'s `scan.truncated` reads): a
 * capped scan must not read to a client as a complete catalog.
 */
export const knowledgeDocumentsResponseSchema = z.object({
  documents: z.array(knowledgeDocumentListSchema),
  total: z.number().int(),
  truncated: z.boolean(),
});
export type KnowledgeDocumentsResponse = z.infer<typeof knowledgeDocumentsResponseSchema>;

export const knowledgeRemovedResponseSchema = z.object({ removed: z.literal(true) });
export type KnowledgeRemovedResponse = z.infer<typeof knowledgeRemovedResponseSchema>;

// ---- write-back proposals --------------------------------------------------------------------

const knowledgeProposalBaseSchema = z.object({
  /** Position within the run's proposal NDJSON — the unit `POST /knowledge/proposals/apply` names. */
  seq: z.number().int(),
  runId: z.string(),
  createdAt: z.string(),
});

/** One `{"op":"upsert",...}` NDJSON line the agent appended. */
export const knowledgeUpsertProposalSchema = knowledgeProposalBaseSchema.extend({
  op: z.literal('upsert'),
  scope: z.enum(['project', 'workspace']),
  path: z.string().min(1),
  title: z.string().optional(),
  type: knowledgeDocTypeSchema.optional(),
  tags: z.array(z.string()).optional(),
  supersedes: z.array(z.string()).optional(),
  body: z.string(),
});
export type KnowledgeUpsertProposal = z.infer<typeof knowledgeUpsertProposalSchema>;

/** One `{"op":"supersede",...}` NDJSON line — the correction-in-place operation. Re-applying with a
 *  different `by` prepends a second lead-in above the first rather than overwriting it. */
export const knowledgeSupersedeProposalSchema = knowledgeProposalBaseSchema.extend({
  op: z.literal('supersede'),
  target: z.string(),
  by: z.string(),
  date: z.string(),
  note: z.string().optional(),
  amendHeading: z.boolean().optional(),
});
export type KnowledgeSupersedeProposal = z.infer<typeof knowledgeSupersedeProposalSchema>;

export const knowledgeProposalSchema = z.discriminatedUnion('op', [
  knowledgeUpsertProposalSchema,
  knowledgeSupersedeProposalSchema,
]);
export type KnowledgeProposal = z.infer<typeof knowledgeProposalSchema>;

/** `GET /knowledge/proposals`. Flag off answers `{proposals: []}`, never 404. */
export const knowledgeProposalsResponseSchema = z.object({
  proposals: z.array(knowledgeProposalSchema),
});
export type KnowledgeProposalsResponse = z.infer<typeof knowledgeProposalsResponseSchema>;

export const knowledgeProposalRefusalSchema = z.object({
  seq: z.number().int(),
  reason: z.string(),
});
export type KnowledgeProposalRefusal = z.infer<typeof knowledgeProposalRefusalSchema>;

/** `POST /knowledge/proposals/apply`. A proposal targeting a read-only mount stays pending with a
 *  reason rather than being silently dropped — visible, unapplied, not lost. */
export const applyKnowledgeProposalsResponseSchema = z.object({
  applied: z.array(z.number().int()),
  refused: z.array(knowledgeProposalRefusalSchema),
});
export type ApplyKnowledgeProposalsResponse = z.infer<typeof applyKnowledgeProposalsResponseSchema>;

/** `POST /knowledge/reindex`. 409 when the flag is off. */
export const knowledgeReindexResponseSchema = z.object({
  formatVersion: z.number().int(),
  scan: knowledgeScanSchema,
});
export type KnowledgeReindexResponse = z.infer<typeof knowledgeReindexResponseSchema>;

// ---- request bodies ------------------------------------------------------------------------
//
// `z.input`, like every other request type in this package: a caller writes what the schema
// ACCEPTS.

/** `POST /knowledge` — the one place path containment is asked for a client-supplied path. */
export const createKnowledgeDocumentInputSchema = z.object({
  scope: z.enum(['project', 'workspace']),
  path: z.string().min(1),
  content: z.string(),
});
export type CreateKnowledgeDocumentInput = z.input<typeof createKnowledgeDocumentInputSchema>;

/** `PUT /knowledge/:id` — `version` is the sha256 of the exact bytes the editor last read; a stale
 *  version is a 409, never a silent overwrite. */
export const updateKnowledgeDocumentInputSchema = z.object({
  content: z.string(),
  version: z.string(),
});
export type UpdateKnowledgeDocumentInput = z.input<typeof updateKnowledgeDocumentInputSchema>;

export const applyKnowledgeProposalsInputSchema = z.object({
  runId: z.string().min(1),
  seq: z.array(z.number().int()).min(1),
});
export type ApplyKnowledgeProposalsInput = z.input<typeof applyKnowledgeProposalsInputSchema>;
