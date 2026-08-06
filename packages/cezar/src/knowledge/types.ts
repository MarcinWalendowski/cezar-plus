import { z } from 'zod';
import { knowledgeDocumentSchema, type KnowledgeDocument } from '@open-mercato/cezar-contract';

/**
 * Storage-side types (W2.1): the catalog cache and manifest schemas, and the `.ai/cezar/config.json`
 * `knowledge.mounts[]` schema. See `.ai/specs/2026-08-06-knowledge-base-mounts-search.md` ("Catalog
 * cache", "Mount config") and `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` (D1..D25, which
 * outranks the spec on any conflict).
 *
 * `packages/contract/src/knowledge.ts` (W1.1, scaffold-owned) already carries the CLOSED wire half —
 * every field a route answers with, no index signature. The catalog entry is deliberately the SAME
 * shape minus `body` (Q15: "the catalog entry and the search result are the SAME object"; bodies are
 * never in the catalog, only `GET /knowledge/:id` carries one) — reusing `knowledgeDocumentSchema`
 * here rather than restating it keeps that identity a `.omit()`, not two hand-kept field lists that
 * can drift.
 */

// ---- catalog entry (persisted, one NDJSON line; also the search result shape) -----------------

export const catalogEntrySchema = knowledgeDocumentSchema.omit({ body: true });
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

/** The five root kinds from the spec's Roots table. Configured mounts carry whatever `id` the user
 *  gave them in config, so this is a shape, not an exhaustive enum. */
export type KnowledgeRootKind = 'project' | 'workspace' | 'sources' | 'discovered' | 'configured';

export interface ResolvedKnowledgeRoot {
  id: string;
  /** Absolute. For a writable root this is the directory writes land in, whether or not it exists
   *  yet (it is created on first write). */
  path: string;
  kind: KnowledgeRootKind;
  format?: string;
  writable: boolean;
  /** False when the root does not exist (yet, or any more), or is a configured mount outside the
   *  project root in hosted mode. Never a throw either way. */
  indexed: boolean;
  reason?: string;
}

// ---- manifest -----------------------------------------------------------------------------

/** Bumped whenever the on-disk catalog/manifest SHAPE changes. A mismatch discards and rebuilds —
 *  it never migrates (spec "Catalog cache": a rebuildable derived artifact sits on the same side of
 *  the migration-framework fence as run state, per `workspace/migrations.ts:14`). */
export const CATALOG_FORMAT_VERSION = 1;

const knowledgeManifestRootSchema = z.object({
  id: z.string(),
  path: z.string(),
  format: z.string().optional(),
  readOnly: z.boolean(),
});
export type KnowledgeManifestRoot = z.infer<typeof knowledgeManifestRootSchema>;

const knowledgeManifestDocSchema = z.object({
  size: z.number().int(),
  mtimeMs: z.number(),
  hash: z.string(),
});
export type KnowledgeManifestDoc = z.infer<typeof knowledgeManifestDocSchema>;

export const knowledgeManifestSchema = z.object({
  formatVersion: z.number().int(),
  roots: z.array(knowledgeManifestRootSchema).default([]),
  /** Keyed by absolute path — the O(changed) reindex comparator (size, mtimeMs), sha256 as the
   *  tiebreak for a touch-without-content-change. */
  docs: z.record(z.string(), knowledgeManifestDocSchema).default({}),
});
export type KnowledgeManifest = z.infer<typeof knowledgeManifestSchema>;

// ---- mount config: `.ai/cezar/config.json`'s `knowledge` key ----------------------------------

/** `readOnly` is deliberately not a field (spec "Mount config"): every configured mount is read
 *  only, unconditionally. */
export const knowledgeMountConfigSchema = z.object({
  id: z.string().min(1).max(64),
  path: z.string().min(1),
  format: z.string().optional(),
});
export type KnowledgeMountConfig = z.infer<typeof knowledgeMountConfigSchema>;

/** Tolerant over the WHOLE file (Q11): this is parsed out of `.ai/cezar/config.json` alongside
 *  every other top-level key that file carries, so a bad `knowledge` block must never make the
 *  reader of an unrelated key fail, and a bad OTHER key must never stop this one from reading. Every
 *  field degrades to its default rather than throwing, matching `config.ts`'s own house rule. */
export const knowledgeConfigSchema = z.object({
  mounts: z.array(knowledgeMountConfigSchema).catch([]).default([]),
});
export type KnowledgeConfig = z.infer<typeof knowledgeConfigSchema>;

// ---- scan caps ------------------------------------------------------------------------------

/** 1 MiB per file, 20,000 files, 64 MiB total, whichever binds first (spec "Roots"). */
export const SCAN_CAPS = {
  maxFileBytes: 1_048_576,
  maxFiles: 20_000,
  maxTotalBytes: 64 * 1_048_576,
} as const;

export interface ScanStats {
  truncated: boolean;
  filesScanned: number;
  bytesScanned: number;
  skipped: number;
  capHit?: 'files' | 'bytes' | 'perFile';
}

export function emptyScanStats(): ScanStats {
  return { truncated: false, filesScanned: 0, bytesScanned: 0, skipped: 0 };
}

// ---- re-exports for callers that only need the wire shape --------------------------------------

export type { KnowledgeDocument };
