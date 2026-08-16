import { Hono } from 'hono';
import type {
  BackupOverviewResponse,
  BackupSnapshotsResponse,
} from '@loki-labs/better-cezar-contract';
import { backupRestoreInputSchema } from '@loki-labs/better-cezar-contract';
import { backupEnabled } from './capabilities.ts';
import type { ProjectApiEnv } from './server.ts';
import { jsonZodValidator } from './validators.ts';

/**
 * `/api/v1/backup/*` — the provider-agnostic platform backup family (spec
 * `.ai/specs/2026-08-16-provider-agnostic-platform-backup.md`). Workspace-level and single-mount
 * (chained onto `workspaceV1`, never mirrored under `/api/v1/p/:projectId`), because a backup
 * describes the machine/workspace, not one repo.
 *
 * **This file is the SCAFFOLD (Phase 1) and is inert.** The snapshot engine, crypto, providers and
 * restore land in later phases; here every GET answers the schema-valid empty payload and every
 * mutator answers `409`. The shape is what matters now:
 *
 *  - Gated on `backupEnabled(process.env)` (`CEZ_BACKUP=1`), read per request so a test can flip
 *    the env between apps — never captured (the `workspace-knowledge-routes.ts` precedent).
 *  - **Flag-off shape (D19):** GETs stay `200` with `enabled:false` + nulls/zeros; mutators `409`;
 *    nothing here ever answers `404` — switched off, not missing.
 *  - **No clock-derived field (D8):** the empty GET bodies are constant, so three identical GETs
 *    are byte-for-byte identical. When the engine lands, `lastRun`/`createdAt` come from the
 *    manifest's stored ISO timestamps, still never `Date.now()`.
 *
 * Until the engine exists a mutator answers `409` whether the flag is on or off — the route is
 * wired but does no work yet. Phases 5–6 replace the mutator bodies with the real engine behind
 * the same gate.
 */

const BACKUP_OFF = 'backups are disabled — set CEZ_BACKUP=1 to enable them';
const BACKUP_NOT_READY = 'the backup engine is not implemented yet (scaffold)';

/** The constant empty overview — `enabled` is the one live field, reflecting the flag. */
function emptyOverview(): BackupOverviewResponse {
  return {
    enabled: backupEnabled(process.env),
    provider: null,
    lastRun: null,
    snapshotCount: 0,
    includeSummary: null,
  };
}

const EMPTY_SNAPSHOTS: BackupSnapshotsResponse = { snapshots: [] };

/** The reason a mutator refuses: the flag being off is the primary, documented one. */
function mutatorRefusal(): string {
  return backupEnabled(process.env) ? BACKUP_NOT_READY : BACKUP_OFF;
}

export function createBackupRoutes() {
  return new Hono<ProjectApiEnv>()
    .get('/backup', (c) => {
      const body: BackupOverviewResponse = emptyOverview();
      return c.json(body);
    })

    .get('/backup/snapshots', (c) => {
      const body: BackupSnapshotsResponse = EMPTY_SNAPSHOTS;
      return c.json(body);
    })

    .post('/backup/run', (c) => c.json({ error: mutatorRefusal() }, 409))

    // Declares its typed body now (the request schema is real) even though the handler is inert,
    // so `typed-bodies.test.ts` pins the input shape from Phase 1. An empty `{}` is a valid body,
    // so a flag-off call with `{}` reaches the `409` rather than a `400`.
    .post('/backup/restore', jsonZodValidator(backupRestoreInputSchema), (c) =>
      c.json({ error: mutatorRefusal() }, 409),
    )

    .post('/backup/verify', (c) => c.json({ error: mutatorRefusal() }, 409))

    .post('/backup/gc', (c) => c.json({ error: mutatorRefusal() }, 409));
}
