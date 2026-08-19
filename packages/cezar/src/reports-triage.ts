import { promises as fs } from 'node:fs';
import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Triage state for report documents: `.ai/cezar/reports-triage.json`, a flat JSON array of rows
 * keyed on a report's provenance identifier. See
 * `.ai/specs/2026-08-19-reports-triage-approve-dismiss.md`.
 *
 * **Why a separate store and not the report's frontmatter.** Report documents live in a knowledge
 * mount that may be read-only, they are owned by whatever drains them (which rewrites the same
 * filename on retry, which is what makes a re-drain safe), and their bodies are end-user text
 * that is not ours to edit. A second writer editing their frontmatter would turn that safe
 * re-drain into a clobber of triage state. So the documents stay append-only and this file holds
 * the outcome.
 *
 * **Absence is the pending state.** There is deliberately no `pending` row: a report with no row
 * is pending. That is what lets a freshly arrived report appear in the inbox with no write at
 * all — the drain writes a file, `fs.watch` indexes it, and the join in the route does the rest.
 *
 * Storage schema conventions follow `../todos.ts` exactly, because the failure modes are the
 * same: rows are external data (a human may hand-edit this file, and two cockpits may each hold
 * one), so each row is validated on read and a malformed row is skipped with a warning rather
 * than taking the whole inbox down. Writes land atomically (tmp + rename) and are serialized by
 * the same cross-process `O_EXCL` lease — `todos.json`'s reasoning applies verbatim here, and
 * more sharply: `approve` writes BOTH this file and `todos.json`, so two concurrent approvals of
 * the same report racing a read-modify-write would otherwise mint two todos for one report.
 */

/** Mirrors the wire twin (`contract/src/reports.ts`'s `reportTriageRowSchema`) field for field.
 *  Kept as its own definition for the same reason `todoSchema` is: this is the STORAGE half, and
 *  it must keep parsing a row written by an older build. */
export const reportTriageRowSchema = z.object({
  key: z.string().min(1).max(500),
  keyKind: z.enum(['identifier', 'catalog-id']),
  status: z.enum(['approved', 'dismissed']),
  at: z.string(),
  by: z.string().max(320).optional(),
  reason: z.string().max(500).optional(),
  todoId: z.string().min(1).optional(),
  todoProjectId: z.string().min(1).optional(),
  auto: z.boolean().optional(),
});
export type ReportTriageRow = z.infer<typeof reportTriageRowSchema>;

export function reportsTriagePath(dataDir: string): string {
  return join(dataDir, 'reports-triage.json');
}

// ---- cross-process write lease (the `todos.ts`/`IdentityStore` `O_EXCL` idiom) ----------------

const TRIAGE_LOCK_FILE = 'reports-triage.lock';
/** Cap on the exponential backoff between lease retries — mirrors `todos.ts`'s own constant of
 *  the same name and role. */
const MAX_RETRY_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class TriageLease {
  private released = false;

  constructor(
    private readonly path: string,
    private readonly fd: number,
  ) {}

  release(): void {
    if (this.released) return;
    this.released = true;
    closeSync(this.fd);
    try {
      unlinkSync(this.path);
    } catch {
      // Already removed during shutdown cleanup.
    }
  }
}

/** One non-blocking attempt at the write lease: open `wx` (fails if the lock file already
 *  exists), reclaim it if it has sat stale past `staleAfterMs` (a crashed writer), else give up. */
function acquireTriageLease(dataDir: string, staleAfterMs = 10 * 60_000): TriageLease | undefined {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, TRIAGE_LOCK_FILE);
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return new TriageLease(path, fd);
  } catch {
    try {
      if (Date.now() - statSync(path).mtimeMs > staleAfterMs) {
        unlinkSync(path);
        return acquireTriageLease(dataDir, staleAfterMs);
      }
    } catch {
      // A contender released it first, or the directory is read-only.
    }
    return undefined;
  }
}

/** Retries with bounded exponential backoff until it succeeds or `lockTimeoutMs` elapses —
 *  "retry and block", not "skip": losing a triage write means a report silently returns to the
 *  pending queue, or worse, gets a second todo. */
async function acquireTriageLeaseBlocking(dataDir: string, lockTimeoutMs = 5_000): Promise<TriageLease> {
  const deadline = Date.now() + lockTimeoutMs;
  let delay = 10;
  for (;;) {
    const lease = acquireTriageLease(dataDir);
    if (lease) return lease;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `reports-triage.json write lease stayed held for over ${lockTimeoutMs}ms — another writer may be stuck`,
      );
    }
    await sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
  }
}

/** Takes the lease, runs `fn`, always releases — the one helper every write below goes through,
 *  so no call site can touch the file without it. */
async function withTriageLease<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  const lease = await acquireTriageLeaseBlocking(dataDir);
  try {
    return await fn();
  } finally {
    lease.release();
  }
}

// ---- read / write -----------------------------------------------------------------------------

/** Parse + validate the file. Broken JSON / non-array → []; bad rows are skipped with a warning.
 *  Never writes, so it takes no lease: a read must not materialize state (AGENTS.md), and the
 *  cross-project board reads projects that have never run cezar at all. */
async function readRaw(dataDir: string): Promise<ReportTriageRow[]> {
  let raw: string;
  try {
    raw = await fs.readFile(reportsTriagePath(dataDir), 'utf8');
  } catch {
    return []; // no file yet — nothing triaged, everything pending
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[cez] reports-triage.json is not valid JSON — treating every report as pending (${message})`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn('[cez] reports-triage.json is not a JSON array — treating every report as pending');
    return [];
  }
  const rows: ReportTriageRow[] = [];
  for (const entry of parsed) {
    const result = reportTriageRowSchema.safeParse(entry);
    if (!result.success) {
      console.warn(
        `[cez] skipped a malformed reports-triage.json row: ${result.error.issues.map((i) => i.message).join('; ')}`,
      );
      continue;
    }
    rows.push(result.data);
  }
  return rows;
}

async function writeAtomic(dataDir: string, rows: ReportTriageRow[]): Promise<void> {
  const file = reportsTriagePath(dataDir);
  const tmp = `${file}.tmp`;
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(rows, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

/** Every triage row for a project, as a map keyed the way the list join needs it. */
export async function readReportTriage(dataDir: string): Promise<Map<string, ReportTriageRow>> {
  const rows = await readRaw(dataDir);
  // Last write wins on a duplicate key — a hand-edited file can carry two rows for one report,
  // and the newer one is the one a reader means.
  return new Map(rows.map((r) => [r.key, r]));
}

export async function readReportTriageRow(dataDir: string, key: string): Promise<ReportTriageRow | undefined> {
  return (await readReportTriage(dataDir)).get(key);
}

/**
 * Upsert one row under the lease. `mutate` receives the row as it exists RIGHT NOW under the
 * lease (not as the caller last saw it) and returns the row to store, or `undefined` to delete
 * it — so a caller that must not act twice (approve) can check the fresh state and decline
 * inside the critical section rather than racing its own read.
 */
export async function updateReportTriage(
  dataDir: string,
  key: string,
  mutate: (current: ReportTriageRow | undefined) => ReportTriageRow | undefined,
): Promise<ReportTriageRow | undefined> {
  return withTriageLease(dataDir, async () => {
    const rows = await readRaw(dataDir);
    const index = rows.findIndex((r) => r.key === key);
    const current = index >= 0 ? rows[index] : undefined;
    const next = mutate(current);
    if (next === undefined) {
      if (index < 0) return undefined; // nothing to delete
      rows.splice(index, 1);
      await writeAtomic(dataDir, rows);
      return undefined;
    }
    if (index >= 0) rows[index] = next;
    else rows.push(next);
    await writeAtomic(dataDir, rows);
    return next;
  });
}
