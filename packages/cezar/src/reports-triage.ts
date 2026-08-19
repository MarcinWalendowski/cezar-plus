import { promises as fs } from 'node:fs';
import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from './paths.ts';

/**
 * Triage state for report documents: `~/.cezar/reports-triage.json`, a flat JSON array of rows
 * keyed on a report's provenance identifier. See
 * `.ai/specs/2026-08-19-reports-triage-approve-dismiss.md` and its "Reports is a workspace tab"
 * amendment.
 *
 * **WORKSPACE-SCOPED, on the `notesPath()`/`agentAccountsPath()` precedent (CHANGED 2026-08-19).**
 * This file was `<project dataDir>/reports-triage.json` for the length of one afternoon. One store
 * per project cannot work here, and the deployment showed exactly why: a knowledge mount is declared
 * in the OPERATOR's `~/.cezar/config.json` (`.ai/specs/2026-08-19-tasks-page-and-start-
 * grounding.md` D3), so all 12 registered projects resolved the same 196 reports — and a decision
 * made while standing in one project was invisible from the other eleven. Two stores existed on the
 * box within hours, the second one re-dismissing two reports the first had already dismissed. The
 * decision belongs where the corpus belongs.
 *
 * **Why one store over twelve corpora is safe: the key.** Rows are keyed on the document's
 * PROVENANCE identifier (`notion:<uuid>`, `local:report:<ts>-<hash>`) — minted once by whatever
 * wrote the document, globally unique — so two projects holding genuinely different reports cannot
 * collide. The weaker `catalog-id` fallback keys keep carrying `keyKind`, so a key that could
 * theoretically collide stays visibly weaker rather than being quietly treated as equal.
 *
 * **No migration ships.** This family has never been in a published release, so there is no older
 * per-project file in anyone's repo to read (`BACKWARD_COMPATIBILITY.md` §2). The two that existed
 * on the owner's own box were merged by hand.
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
 * the same report racing a read-modify-write would otherwise mint two todos for one report. That
 * lease matters MORE at workspace scope, not less: it now serializes every project's cockpit tab
 * against one file rather than each against its own.
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

/** `~/.cezar/reports-triage.json`. Takes `env` rather than reading `process.env` once at module
 *  load, exactly as `backupConfigPath()` does, so a test can pin `CEZ_HOME` per call. */
export function reportsTriagePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(cezarHomeDir(env), 'reports-triage.json');
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
function acquireTriageLease(env: NodeJS.ProcessEnv, staleAfterMs = 10 * 60_000): TriageLease | undefined {
  const home = cezarHomeDir(env);
  // A lock file IS a write into the cezar home, so it takes the same sandbox assertion the data
  // write does — a leaked test that reached the developer's real `~/.cezar` would otherwise be
  // caught only on the second syscall, after having already created a lock there.
  assertCezarHomeWriteIsSandboxed(home, env);
  mkdirSync(home, { recursive: true });
  const path = join(home, TRIAGE_LOCK_FILE);
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return new TriageLease(path, fd);
  } catch {
    try {
      if (Date.now() - statSync(path).mtimeMs > staleAfterMs) {
        unlinkSync(path);
        return acquireTriageLease(env, staleAfterMs);
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
async function acquireTriageLeaseBlocking(env: NodeJS.ProcessEnv, lockTimeoutMs = 5_000): Promise<TriageLease> {
  const deadline = Date.now() + lockTimeoutMs;
  let delay = 10;
  for (;;) {
    const lease = acquireTriageLease(env);
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
async function withTriageLease<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
  const lease = await acquireTriageLeaseBlocking(env);
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
async function readRaw(env: NodeJS.ProcessEnv): Promise<ReportTriageRow[]> {
  let raw: string;
  try {
    raw = await fs.readFile(reportsTriagePath(env), 'utf8');
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

async function writeAtomic(env: NodeJS.ProcessEnv, rows: ReportTriageRow[]): Promise<void> {
  const home = cezarHomeDir(env);
  assertCezarHomeWriteIsSandboxed(home, env);
  const file = reportsTriagePath(env);
  const tmp = `${file}.tmp`;
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(rows, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

/** Every triage row in the workspace, as a map keyed the way the list join needs it. */
export async function readReportTriage(env: NodeJS.ProcessEnv = process.env): Promise<Map<string, ReportTriageRow>> {
  const rows = await readRaw(env);
  // Last write wins on a duplicate key — a hand-edited file can carry two rows for one report,
  // and the newer one is the one a reader means.
  return new Map(rows.map((r) => [r.key, r]));
}

export async function readReportTriageRow(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReportTriageRow | undefined> {
  return (await readReportTriage(env)).get(key);
}

/**
 * Upsert one row under the lease. `mutate` receives the row as it exists RIGHT NOW under the
 * lease (not as the caller last saw it) and returns the row to store, or `undefined` to delete
 * it — so a caller that must not act twice (approve) can check the fresh state and decline
 * inside the critical section rather than racing its own read.
 */
export async function updateReportTriage(
  key: string,
  mutate: (current: ReportTriageRow | undefined) => ReportTriageRow | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReportTriageRow | undefined> {
  return withTriageLease(env, async () => {
    const rows = await readRaw(env);
    const index = rows.findIndex((r) => r.key === key);
    const current = index >= 0 ? rows[index] : undefined;
    const next = mutate(current);
    if (next === undefined) {
      if (index < 0) return undefined; // nothing to delete
      rows.splice(index, 1);
      await writeAtomic(env, rows);
      return undefined;
    }
    if (index >= 0) rows[index] = next;
    else rows.push(next);
    await writeAtomic(env, rows);
    return next;
  });
}
