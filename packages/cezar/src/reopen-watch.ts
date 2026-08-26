import {
  isReopenPending,
  markReopenFailed,
  markReopenStarted,
  onReopenRequestsChanged,
  readReopenRequests,
  readReopenRequestsSnapshot,
  type ReopenReadSnapshot,
  type ReopenRequest,
} from './reopen-requests.ts';
import type { RunManager } from './workflows/run.ts';

/**
 * Phase 2 of `.ai/specs/2026-08-20-reopen-finished-tasks-merge-audit.md` — the cockpit side of the
 * reopen inbox.
 *
 * The RUNNING cockpit, never a second headless manager, is what reopens a finished run: only it
 * owns this project's `RunManager` (and therefore the queue, the concurrency cap and the
 * working-tree lease), and only it can stream the reopened run live. This module is that hook —
 * one `reopen-requests.json` watch per project context, wired in `server/server.ts` exactly
 * beside `watchTodoAutostart`, which solves the identical problem for
 * `cezar todo add --start` (`todo-autostart.ts`; see its doc comment for the shared reasoning).
 */

/** The subset of a project context this module needs — a duck-typed slice of
 *  `server/project-context.ts`'s `ProjectContext`, so this module carries no dependency on the
 *  server layer. */
export interface ReopenWatchProject {
  dataDir: string;
  manager: RunManager;
}

export function hasPendingReopenRequests(snapshot: Pick<ReopenReadSnapshot, 'requests'>): boolean {
  return snapshot.requests.some(isReopenPending);
}

export interface ReopenIntentSnapshot extends ReopenReadSnapshot {
  pending: boolean;
}

/** Snapshot the reopen inbox without entering the normal reader or write path. */
export async function readReopenIntentSnapshot(dataDir: string): Promise<ReopenIntentSnapshot> {
  const snapshot = await readReopenRequestsSnapshot(dataDir);
  return { ...snapshot, pending: hasPendingReopenRequests(snapshot) };
}

/**
 * Reopen ONE run.
 *
 * `deferForCapacity` is hard-coded `true` and is not a knob. It routes the continuation through
 * the queue instead of starting it immediately (`workflows/run.ts`'s `continueRun`: the run goes
 * to `status: 'queued'` with `finishedAt`/`error` cleared), which is the same call shape restart
 * recovery already uses. A bulk reopen is the case this exists for: `resources.maxParallel` is a
 * small number, and a nineteen-run sweep firing immediate continuations would spawn nineteen
 * agent processes at once. There is no correct caller-supplied value here, so there is no option.
 *
 * A refusal (`no agent session to resume`, `run is still active`, `not found`) is a fact about
 * this request, not a transient failure — so it is stamped into the row and never retried.
 */
async function applyReopenRequest(project: ReopenWatchProject, request: ReopenRequest): Promise<void> {
  // Continue FIRST, stamp second — the `todo-autostart.ts` ordering, and deliberately not the
  // reverse. A crash between the two leaves the row pending, so the next pass continues the run a
  // second time (a visible `continue-2` step on a run that is already reopened); stamping first
  // would instead lose the reopen silently, which is the failure this whole sweep exists to stop.
  const result = await project.manager.continueRun(request.runId, { text: request.prompt }, true);
  if (result.ok) {
    // TODO(analytics): emit `run.reopened` (project, source, queuedDepth) here once an event sink
    // exists — see `todo-autostart.ts`'s matching TODO for `todo.autostarted`. No analytics /
    // telemetry mechanism exists anywhere in this codebase today (checked), so this is stated
    // rather than invented.
    await markReopenStarted(project.dataDir, request.id);
    console.log(`[cez] reopened run ${request.runId} (request ${request.id})`);
    return;
  }
  await markReopenFailed(project.dataDir, request.id, result.error ?? 'continue refused');
  console.warn(`[cez] reopen refused for run ${request.runId}: ${result.error ?? 'unknown reason'}`);
}

/** Serializes reconcile passes per `dataDir` (the boot pass and a file change landing moments
 *  later must never run concurrently): each pass re-reads the file fresh, so a request stamped by
 *  an earlier pass is no longer pending by the time a later pass reads it — which is what makes
 *  two of OUR OWN triggers double-start safe against each other. Mirrors `todo-autostart.ts`'s
 *  `reconcileTail`, itself mirroring `RunManager`'s `repoRootTail`. */
const reconcileTail = new Map<string, Promise<void>>();

/**
 * One reconcile pass over `project.dataDir`'s `reopen-requests.json`: continue every request that
 * carries neither terminal stamp, in file order. A single throwing row (a manager that blew up, a
 * store write that failed) is logged and skipped — one bad entry never stops the rest of the file
 * from reconciling, and an unstamped row is simply retried on the next pass.
 */
export function reconcileReopenRequests(project: ReopenWatchProject): Promise<void> {
  const prior = reconcileTail.get(project.dataDir) ?? Promise.resolve();
  const next = prior.then(() => reconcileReopenRequestsOnce(project)).catch(() => undefined);
  reconcileTail.set(project.dataDir, next);
  return next;
}

async function reconcileReopenRequestsOnce(project: ReopenWatchProject): Promise<void> {
  const requests = await readReopenRequests(project.dataDir);
  for (const request of requests) {
    if (!isReopenPending(request)) continue;
    try {
      await applyReopenRequest(project, request);
    } catch (err) {
      console.warn(
        `[cez] reopen failed for run ${request.runId} (${request.id}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/** Live subscriptions keyed by `dataDir` — at most one per project, replaced rather than stacked
 *  on re-subscribe (a project context can be disposed and rebuilt with a fresh `manager`, and a
 *  subscription pointed at a disposed one must not linger). */
const watched = new Map<string, () => void>();

/**
 * Wire a project's `reopen-requests.json` to the cockpit: one immediate reconcile pass (the boot
 * pass — covers a project whose context was built, or rebuilt, while requests were already
 * sitting in the file) plus a live `fs.watch` subscription for everything after that.
 *
 * A missed `fs.watch` event is caught at the NEXT reconcile — a later file change, or this
 * project's next boot pass. Same exposure and same mitigation as autostart.
 *
 * Safe to call more than once for the same `dataDir`: a prior subscription is torn down first, so
 * exactly one watch — pointed at the current `manager` — is ever live per project.
 */
export function watchReopenRequests(project: ReopenWatchProject): () => void {
  watched.get(project.dataDir)?.();
  void reconcileReopenRequests(project);
  const unsubscribe = onReopenRequestsChanged(project.dataDir, () => void reconcileReopenRequests(project));
  const stop = () => {
    unsubscribe();
    if (watched.get(project.dataDir) === stop) watched.delete(project.dataDir);
  };
  watched.set(project.dataDir, stop);
  return stop;
}
