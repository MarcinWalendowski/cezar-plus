import { Hono } from 'hono';
import type {
  BackupGcResponse,
  BackupOverviewResponse,
  BackupRestoreResponse,
  BackupRunResponse,
  BackupSnapshotsResponse,
  BackupVerifyResponse,
} from '@loki-labs/cezar-plus-contract';
import { backupRestoreInputSchema } from '@loki-labs/cezar-plus-contract';
import { listProjects } from '../workspace/projects.ts';
import {
  getBackupStatus,
  listSnapshots,
  runBackup,
  runGc,
  verifyBackup,
} from '../backup/snapshot.ts';
import { runRestore } from '../backup/restore.ts';
import { backupEnabled } from './capabilities.ts';
import type { ProjectApiEnv } from './server.ts';
import { jsonZodValidator } from './validators.ts';

/**
 * `/api/v1/backup/*` — the provider-agnostic platform backup family (spec
 * `.ai/specs/2026-08-16-provider-agnostic-platform-backup.md`). Workspace-level and single-mount
 * (chained onto `workspaceV1`, never mirrored under `/api/v1/p/:projectId`), because a backup
 * describes the machine/workspace, not one repo.
 *
 * **Gated on `backupEnabled(process.env)` (`CEZ_BACKUP=1`), read per request** so a test can flip
 * the env between apps — never captured (the `workspace-knowledge-routes.ts` precedent). The gate
 * is the N1 guarantee: flag-off, no engine code runs — no provider resolution, no credential read,
 * no network. GETs answer a **constant** empty payload (`enabled:false` + nulls/zeros), so three
 * back-to-back GETs are byte-for-byte identical; mutators answer `409`; nothing here ever answers
 * `404` — switched off, not missing (D19).
 *
 * **Flag-on:** the GETs delegate to the engine's read paths (`getBackupStatus`/`listSnapshots`),
 * whose timestamps are the manifest's own **stored** ISO strings (D8, never `Date.now()`); the
 * mutators run the engine and map its operational errors (`not configured` / `already running` /
 * `key mismatch` / `no backup found` / `refusing to overwrite` / `sha256 mismatch`) to `409`,
 * anything unexpected to `500`.
 */

const BACKUP_OFF = 'backups are disabled — set CEZ_BACKUP=1 to enable them';

/** The constant flag-off overview — `enabled:false`, everything else null/zero. Deterministic
 *  across reads (no engine call), which is what keeps the flag-off GET byte-stable (D8). */
function offOverview(): BackupOverviewResponse {
  return { enabled: false, provider: null, lastRun: null, snapshotCount: 0, includeSummary: null };
}

const OFF_SNAPSHOTS: BackupSnapshotsResponse = { snapshots: [] };

/** Operational failures the caller can act on (fix config, wait, fix the key, pass `force`, restore
 *  a different snapshot) map to `409`; anything else is an unexpected server fault (`500`). */
function mutatorErrorStatus(message: string): 409 | 500 {
  return /not configured|already running|key mismatch|no backup found|refusing to overwrite|sha256 mismatch/i.test(
    message,
  )
    ? 409
    : 500;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createBackupRoutes() {
  return new Hono<ProjectApiEnv>()
    .get('/backup', async (c) => {
      if (!backupEnabled(process.env)) return c.json(offOverview());
      const body: BackupOverviewResponse = await getBackupStatus({ listProjects });
      return c.json(body);
    })

    .get('/backup/snapshots', async (c) => {
      if (!backupEnabled(process.env)) return c.json(OFF_SNAPSHOTS);
      const body: BackupSnapshotsResponse = { snapshots: await listSnapshots() };
      return c.json(body);
    })

    .post('/backup/run', async (c) => {
      if (!backupEnabled(process.env)) return c.json({ error: BACKUP_OFF }, 409);
      try {
        const body: BackupRunResponse = await runBackup({ listProjects });
        return c.json(body);
      } catch (error) {
        const message = errorMessage(error);
        return c.json({ error: message }, mutatorErrorStatus(message));
      }
    })

    // An empty `{}` is a valid body (restore the latest snapshot), so a flag-off call with `{}`
    // reaches the `409`, not a `400`. Restore is destructive and fail-closed: `runRestore` throws
    // (mapped to `409`) rather than overwrite a non-empty target unless `force` is set (N6).
    .post('/backup/restore', jsonZodValidator(backupRestoreInputSchema), async (c) => {
      if (!backupEnabled(process.env)) return c.json({ error: BACKUP_OFF }, 409);
      const input = c.req.valid('json');
      try {
        const result = await runRestore({ snapshotId: input.snapshotId, force: input.force, listProjects });
        const body: BackupRestoreResponse = {
          restored: result.restored,
          staged: result.staged,
          applied: result.applied,
        };
        return c.json(body);
      } catch (error) {
        const message = errorMessage(error);
        return c.json({ error: message }, mutatorErrorStatus(message));
      }
    })

    .post('/backup/verify', async (c) => {
      if (!backupEnabled(process.env)) return c.json({ error: BACKUP_OFF }, 409);
      const body: BackupVerifyResponse = await verifyBackup();
      return c.json(body);
    })

    .post('/backup/gc', async (c) => {
      if (!backupEnabled(process.env)) return c.json({ error: BACKUP_OFF }, 409);
      try {
        const body: BackupGcResponse = await runGc({});
        return c.json(body);
      } catch (error) {
        const message = errorMessage(error);
        return c.json({ error: message }, mutatorErrorStatus(message));
      }
    });
}
