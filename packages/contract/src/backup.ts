import { z } from 'zod';

/**
 * `/api/v1/backup/*` — the provider-agnostic, incremental, client-side-encrypted backup of the
 * durable platform corpus (spec `.ai/specs/2026-08-16-provider-agnostic-platform-backup.md`).
 * Workspace-level and single-mount (never mirrored under `/api/v1/p/:projectId`), because a
 * backup describes the machine/workspace, not one repo — the same shape as
 * `./workspace-knowledge.ts` / `./workspace-todos.ts`.
 *
 * **`CEZ_BACKUP=1` (exact string) gates it, and it is deliberately NOT a member of
 * `capabilitiesSchema` (`./health.ts`).** It follows the `authProviderSchema` precedent, for the
 * same reason: this plan requires the flag-off `/api/v1/health` body to stay byte-identical to
 * today (D4/N1), and adding a required capability key would grow it and force the ~20-fixture edit
 * that turns the health-payload control into a rubber stamp. The server reads the flag through
 * `backupEnabled(env)` (`server/capabilities.ts`) instead, and the cockpit learns whether backup
 * is on from `GET /api/v1/backup`'s own `enabled` field — never from health.
 *
 * **Flag-off shape (D19):** every GET answers `200` with an empty/false payload (`enabled:false`,
 * nulls and zeros), every mutator answers `409`, and nothing here ever answers `404` — the feature
 * is switched off, not missing. **No clock-derived field in any GET body (D8):** `lastRun`/
 * `createdAt` are the manifest's own **stored** ISO timestamps, never an age computed at read time.
 */

/** Which backend the encrypted objects ship to. `s3` covers R2 / S3 / B2 / MinIO. */
export const backupProviderKindSchema = z.enum(['s3', 'local']);
export type BackupProviderKind = z.infer<typeof backupProviderKindSchema>;

/** A provider named for display — never carries a secret (keys live in env, see the spec). */
export const backupProviderSummarySchema = z.object({
  kind: backupProviderKindSchema,
  /** A short human label, e.g. the S3 endpoint+bucket or the local path. */
  label: z.string(),
});
export type BackupProviderSummary = z.infer<typeof backupProviderSummarySchema>;

/** The result of one completed run, as stored in its manifest — the shape `lastRun` reports. */
export const backupRunSummarySchema = z.object({
  snapshotId: z.string(),
  /** Stored ISO timestamp from the manifest (D8) — never recomputed at request time. */
  createdAt: z.string(),
  uploaded: z.number().int(),
  skipped: z.number().int(),
  bytes: z.number().int(),
});
export type BackupRunSummary = z.infer<typeof backupRunSummarySchema>;

/** A stored summary of what the include set covers — counts only, deterministic across reads. */
export const backupIncludeSummarySchema = z.object({
  homeFiles: z.number().int(),
  projectCount: z.number().int(),
});
export type BackupIncludeSummary = z.infer<typeof backupIncludeSummarySchema>;

/** `GET /api/v1/backup` — the overview the cockpit gates its own visibility on (`enabled`). */
export const backupOverviewResponseSchema = z.object({
  enabled: z.boolean(),
  provider: backupProviderSummarySchema.nullable(),
  lastRun: backupRunSummarySchema.nullable(),
  snapshotCount: z.number().int(),
  includeSummary: backupIncludeSummarySchema.nullable(),
});
export type BackupOverviewResponse = z.infer<typeof backupOverviewResponseSchema>;

/** One stored snapshot, listed newest-first. Every field is stored — no read-time computation. */
export const backupSnapshotSchema = z.object({
  id: z.string(),
  /** Stored ISO timestamp (D8). */
  createdAt: z.string(),
  sizeBytes: z.number().int(),
  blobCount: z.number().int(),
});
export type BackupSnapshot = z.infer<typeof backupSnapshotSchema>;

/** `GET /api/v1/backup/snapshots`. */
export const backupSnapshotsResponseSchema = z.object({
  snapshots: z.array(backupSnapshotSchema),
});
export type BackupSnapshotsResponse = z.infer<typeof backupSnapshotsResponseSchema>;

/** `POST /api/v1/backup/run` — a single incremental run (a no-change run uploads nothing). */
export const backupRunResponseSchema = z.object({
  snapshotId: z.string(),
  uploaded: z.number().int(),
  skipped: z.number().int(),
  bytes: z.number().int(),
});
export type BackupRunResponse = z.infer<typeof backupRunResponseSchema>;

/**
 * `POST /api/v1/backup/restore` body. Both fields optional so an empty `{}` is valid (restore the
 * latest snapshot). `force` is required to overwrite a non-empty target — restore is destructive
 * and fail-closed without it (N6).
 */
export const backupRestoreInputSchema = z.object({
  /** The snapshot to restore; omitted ⇒ the latest. */
  snapshotId: z.string().optional(),
  /** Overwrite a non-empty target. Absent/false ⇒ refuse and write nothing. */
  force: z.boolean().optional().default(false),
});
export type BackupRestoreInput = z.infer<typeof backupRestoreInputSchema>;

/** `POST /api/v1/backup/restore` result. */
export const backupRestoreResponseSchema = z.object({
  restored: z.number().int(),
  staged: z.number().int(),
  applied: z.boolean(),
});
export type BackupRestoreResponse = z.infer<typeof backupRestoreResponseSchema>;

/** `POST /api/v1/backup/verify` — key + provider reachability, checked before any restore. */
export const backupVerifyResponseSchema = z.object({
  keyOk: z.boolean(),
  providerOk: z.boolean(),
  sampleRoundTrip: z.boolean(),
});
export type BackupVerifyResponse = z.infer<typeof backupVerifyResponseSchema>;

/** `POST /api/v1/backup/gc` — prune blobs no live snapshot references. */
export const backupGcResponseSchema = z.object({
  prunedBlobs: z.number().int(),
  freedBytes: z.number().int(),
});
export type BackupGcResponse = z.infer<typeof backupGcResponseSchema>;
