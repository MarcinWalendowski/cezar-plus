import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  storedClusterRemoteRunReportSchema,
  storedClusterRemoteRunSchema,
  type ClusterNodeId,
  type ClusterProjectKey,
  type ClusterRemoteRun,
  type StoredClusterRemoteRunReport,
} from '@loki-labs/cezar-plus-contract';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { clusterHomeDir, type ClusterHomeOptions } from './node-identity.ts';
import { atomicWriteJsonSync } from '../workspace/config.ts';

/**
 * The foreign-run index projection — an **observer** on `RunStore`, and the local store of other
 * nodes' rows (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D9 · D10; PLAN 3.4).
 *
 * **Nothing in `runs/store.ts` changes for this.** `RunStore extends EventEmitter` and already emits
 * `run`, `event` and `deleted`, so this is an observer that `watch(store)`es it — the shape
 * `provider-auth-runtime.ts` and `notifications/observer.ts` already use, wired through the same
 * `onStoreCreated` / `onContextBuilt` hooks so it covers the boot context, every already-built
 * context and every later one. Missing one of those hooks is how an observer ends up working for
 * projects opened after boot and silently not for the boot project.
 *
 * **This diverges from `notifications/observer.ts` on one point, deliberately.** That file's own
 * doc comment explains why attaching to a store that already moved a run must stay SILENT: a
 * notification fires on a *transition*, and replaying one for every pre-existing run would be a
 * replay storm the first time a lazy project context is built. A projection is not a transition
 * feed, it is a MIRROR of current state — so the same silence here would instead leave every run
 * that existed before this observer attached permanently unprojected until it happens to change
 * again, which is exactly the boot-context gap the module doc above calls out. So `watchRunProjection`
 * does one synchronous pass over `store.listRuns()` before it subscribes to anything, publishing
 * every run this store already holds. `ClusterRunProjectionObserver`'s per-store dedupe (below)
 * keeps that pass to exactly once per store no matter how many boot-ordering call sites `watch()` it.
 *
 * **A run never migrates** (D10). Sessions, worktrees and broker scopes are node-local: a run starts
 * on a node and finishes there. If that node goes away mid-run the row is marked `unreachable` as a
 * **separate optional field beside `status`**, never as a new `RunStatus` — `RunStatus` ships in
 * `@loki-labs/cezar-plus` and a published wire enum is never widened (PLAN P8), which is the same
 * reason a budget stop is `review` + `stopReason`.
 *
 * **The projection drops every local path by construction.** No `worktreePath`, no session handle,
 * nothing a viewer's machine could act on — `ClusterRemoteRun` has no field for one, and none may be
 * added. A foreign run must never be able to offer "open in terminal" on somebody else's host.
 * `projectRun` below builds its result field-by-field off `runIndexEntrySchema` (the same shape
 * `server.ts`'s own `runIndexEntry()` builds for the cross-project palette), which already excludes
 * every local-machine field for the same reason — a foreign run needs no second render path, and
 * `clusterRemoteRunSchema`'s own `.strict()` is the hard backstop if one is ever added by mistake.
 */

export interface ClusterRunProjectionProject {
  readonly id: string;
  readonly projectKey?: ClusterProjectKey;
  readonly name?: string;
}

/** The minimal sink, injected rather than imported — the same structural-interface move
 *  `notifications/observer.ts` makes, so a test can hand this a plain recording object. */
export interface ClusterRunProjectionSink {
  publish(run: ClusterRemoteRun): void;
  remove(runId: string): void;
}

export interface WatchRunProjectionOptions extends ClusterHomeOptions {
  nodeId: ClusterNodeId;
}

/** Returns the unsubscribe function. */
export function watchRunProjection(
  store: RunStore,
  sink: ClusterRunProjectionSink,
  project: ClusterRunProjectionProject,
  options: WatchRunProjectionOptions,
): () => void {
  const { nodeId } = options;

  const publish = (run: RunRecord): void => {
    sink.publish(projectRun(run, project, nodeId));
  };

  // Initial sync — see the module doc above for why this observer cannot stay silent on attach
  // the way `notifications/observer.ts` does. Synchronous and one-shot: `store.listRuns()` is an
  // in-memory read, never a disk hit, so this costs nothing beyond what `watch()` already pays.
  for (const run of store.listRuns()) publish(run);

  const onRun = (run: RunRecord): void => publish(run);
  const onDeleted = (runId: string): void => sink.remove(runId);

  store.on('run', onRun);
  store.on('deleted', onDeleted);
  return () => {
    store.off('run', onRun);
    store.off('deleted', onDeleted);
  };
}

/** Process-wide dedupe for store observation, the same shape `RunNotificationObserver` uses: one
 *  store gets wired at several boot-ordering call sites, and this keeps that fan-in to one listener
 *  per store. */
export class ClusterRunProjectionObserver {
  private readonly watched = new WeakSet<RunStore>();

  constructor(
    private readonly sink: ClusterRunProjectionSink,
    private readonly options: WatchRunProjectionOptions,
  ) {}

  watch(store: RunStore, project: ClusterRunProjectionProject): void {
    if (this.watched.has(store)) return;
    this.watched.add(store);
    watchRunProjection(store, this.sink, project, this.options);
  }
}

/** `RunRecord` → the board row a foreign node renders. Built on the existing index-entry shape, so a
 *  foreign run needs no second render path — and stripped of every local path on the way out.
 *  Deliberately mirrors `server.ts`'s own `runIndexEntry()` field-by-field (same optional-spread
 *  idiom, so an added `RunIndexEntry` field is a two-file diff rather than a rediscovery), minus
 *  `usage` — the live process-tree sample is only meaningful inside the process that is actually
 *  running the agent, which a pure `RunRecord -> ClusterRemoteRun` mapping never has access to. */
export function projectRun(
  run: RunRecord,
  project: ClusterRunProjectionProject,
  nodeId: ClusterNodeId,
): ClusterRemoteRun {
  return {
    projectId: project.id,
    nodeId,
    ...(project.projectKey !== undefined ? { projectKey: project.projectKey } : {}),
    // Same derivation as `server.ts`'s `runIndexEntry()`: a grant the record already persists,
    // never a second definition of "is a workspace run".
    ...(run.workspaceProjects && run.workspaceProjects.length > 0 ? { workspace: true } : {}),
    id: run.id,
    title: run.title,
    ...(run.titleSummary !== undefined ? { titleSummary: run.titleSummary } : {}),
    ...(run.titleOrigin !== undefined ? { titleOrigin: run.titleOrigin } : {}),
    status: run.status,
    ...(run.activity !== undefined ? { activity: run.activity } : {}),
    ...(run.stopReason !== undefined ? { stopReason: run.stopReason } : {}),
    createdAt: run.createdAt,
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    ...(run.seenAt !== undefined ? { seenAt: run.seenAt } : {}),
    archived: run.archived,
    ...(run.autoResumeAt !== undefined ? { autoResumeAt: run.autoResumeAt } : {}),
    workflow: run.workflow,
    ...(run.branch !== undefined ? { branch: run.branch } : {}),
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run.author !== undefined ? { author: run.author } : {}),
    ...(run.pullRequestUrl !== undefined ? { pullRequestUrl: run.pullRequestUrl } : {}),
    ...(run.referencedPullRequestUrl !== undefined
      ? { referencedPullRequestUrl: run.referencedPullRequestUrl }
      : {}),
    ...(run.prNumber !== undefined ? { prNumber: run.prNumber } : {}),
    ...(run.issueNumber !== undefined ? { issueNumber: run.issueNumber } : {}),
    ...(run.referencedIssueUrl !== undefined ? { referencedIssueUrl: run.referencedIssueUrl } : {}),
    ...(run.markerRefs !== undefined ? { markerRefs: run.markerRefs } : {}),
    ...(run.referencedPrCandidates !== undefined
      ? { referencedPrCandidates: run.referencedPrCandidates }
      : {}),
    ...(run.referencedIssueCandidates !== undefined
      ? { referencedIssueCandidates: run.referencedIssueCandidates }
      : {}),
    ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}),
    ...(run.contextTokens !== undefined ? { contextTokens: run.contextTokens } : {}),
    ...(run.contextWindow !== undefined ? { contextWindow: run.contextWindow } : {}),
    ...(run.peakRssBytes !== undefined ? { peakRssBytes: run.peakRssBytes } : {}),
    ...(run.peakProcCount !== undefined ? { peakProcCount: run.peakProcCount } : {}),
  };
}

// ---- `~/.cezar/cluster/runs-remote.json` (foreign run PROJECTION — no worktreePath, no local
// paths) --------------------------------------------------------------------------------------

export function remoteRunsPath(env?: NodeJS.ProcessEnv): string {
  return join(clusterHomeDir(env), 'runs-remote.json');
}

function reportWarning(options: ClusterHomeOptions | undefined, message: string): void {
  (options?.warn ?? ((m: string) => console.warn(m)))(message);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The whole file, as this node reads it: the foreign rows PLUS the per-node report envelope.
 *
 * `runs` alone cannot tell "node-b has never reported" from "node-b reported and had nothing
 * running" — both are zero rows carrying that `nodeId`. `nodes` is what separates them, so any
 * consumer asking a freshness or liveness question must read this rather than `readRemoteRuns`.
 * See `storedClusterRemoteRunsSchema.nodes` for the three states.
 */
export interface RemoteRunsFile {
  readonly runs: ClusterRemoteRun[];
  /** Keyed by node id. A node with no entry has never reported — the map is never pre-populated
   *  from the roster, because "on the roster" is not "has been heard from". */
  readonly nodes: Record<string, StoredClusterRemoteRunReport>;
}

/** Per-entry salvage, missing file reads as empty. This is what the workspace runs list unions in.
 *  Follows `reports-triage.ts`'s `readRaw` idiom exactly: broken JSON, a non-object body, or a
 *  `runs` field that is not an array all degrade to `[]` with one warning; a single malformed ROW
 *  is skipped with its own warning rather than failing every other node's rows in the same file —
 *  `storedClusterRemoteRunSchema.safeParse` is applied per entry, never to the array as a whole,
 *  because a whole-array `.safeParse` fails atomically on the first bad element (D13: an entry a
 *  newer node wrote and this one cannot place must never take the rest of the file down with it).
 *  The `nodes` envelope is salvaged the same way, per node, for the same reason. */
export async function readRemoteRunsFile(options?: ClusterHomeOptions): Promise<RemoteRunsFile> {
  const path = remoteRunsPath(options?.env);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { runs: [], nodes: {} }; // no file yet — this node has never received a peer's projection
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    reportWarning(
      options,
      `[cez] ${path} is not valid JSON — treating the remote run projection as empty (${describeError(error)})`,
    );
    return { runs: [], nodes: {} };
  }
  const body = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  const runs = body?.runs;
  if (!Array.isArray(runs)) {
    reportWarning(options, `[cez] ${path} is not the expected shape — treating the remote run projection as empty`);
    return { runs: [], nodes: {} };
  }

  const rows: ClusterRemoteRun[] = [];
  for (const entry of runs) {
    const result = storedClusterRemoteRunSchema.safeParse(entry);
    if (!result.success) {
      reportWarning(
        options,
        `[cez] skipped a malformed row in ${path}: ${result.error.issues.map((i) => i.message).join('; ')}`,
      );
      continue;
    }
    rows.push(result.data);
  }

  // A file written before the envelope existed simply has no `nodes` — that reads as "no node has
  // been heard from", which is exactly right for a file this node has not applied a report into
  // since. It is never synthesised from the rows: a row's presence says nothing about WHEN.
  const nodes: Record<string, StoredClusterRemoteRunReport> = {};
  const rawNodes = body?.nodes;
  if (rawNodes !== undefined) {
    if (typeof rawNodes !== 'object' || rawNodes === null || Array.isArray(rawNodes)) {
      reportWarning(options, `[cez] ignored a malformed "nodes" envelope in ${path} — node freshness is unknown`);
    } else {
      for (const [nodeId, entry] of Object.entries(rawNodes as Record<string, unknown>)) {
        const result = storedClusterRemoteRunReportSchema.safeParse(entry);
        if (!result.success) {
          reportWarning(
            options,
            `[cez] skipped a malformed node report for "${nodeId}" in ${path}: ${result.error.issues.map((i) => i.message).join('; ')}`,
          );
          continue;
        }
        nodes[nodeId] = result.data;
      }
    }
  }

  return { runs: rows, nodes };
}

/** The rows only — what the workspace runs list unions in. A caller that needs to tell a silent
 *  node from an idle one wants `readRemoteRunsFile` instead. */
export async function readRemoteRuns(options?: ClusterHomeOptions): Promise<ClusterRemoteRun[]> {
  return (await readRemoteRunsFile(options)).runs;
}

function writeRemoteRunsFile(file: RemoteRunsFile, options?: ClusterHomeOptions): void {
  // Reuses `workspace/config.ts`'s shared atomic writer — same tmp+rename, `0600` file / `0700`
  // dir, and `assertCezarHomeWriteIsSandboxed` guard `node-identity.ts` already reuses it for, so
  // this directory keeps exactly one place that knows how an atomic write happens.
  atomicWriteJsonSync(remoteRunsPath(options?.env), { runs: file.runs, nodes: file.nodes });
}

/**
 * Serialises every read-modify-write of `runs-remote.json`, per file.
 *
 * Both mutators below read the whole file, filter it in memory and write the result back, and the
 * read is a real suspension point — `readRemoteRunsFile` does `await readFile(path, 'utf8')`. With
 * N spokes reporting into one hub, two `applyRemoteRuns` calls overlap there routinely: the second
 * reads a snapshot that predates the first's write, its `kept` filter therefore never sees the
 * first node's rows, and the second write drops a whole node's row-set until that node's next beat.
 * Node's single-threaded execution does NOT make this safe; it is safe only across code with no
 * `await` between read and write, which this is not.
 *
 * Keyed by resolved path, exactly as `todo-autostart.ts`'s `reconcileTail` is keyed by `dataDir` —
 * one chain per file, so two tests (or two `CEZ_HOME`s) never serialise against each other. The
 * rejection handling is `notes/store.ts#serialize`'s: the caller gets the real promise so a failed
 * write still throws where it happened, while the stored tail is the swallowed one so one failure
 * cannot wedge every later write in the process.
 */
const remoteRunsTail = new Map<string, Promise<unknown>>();

function serializeRemoteRunsWrite<T>(mutator: () => Promise<T>, options?: ClusterHomeOptions): Promise<T> {
  const key = remoteRunsPath(options?.env);
  const prior = remoteRunsTail.get(key) ?? Promise.resolve();
  const next = prior.then(mutator, mutator);
  remoteRunsTail.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/** Replaces one node's rows wholesale — a node's projection is authoritative for its own runs and
 *  for nothing else, so a merge across nodes could never be right. Every kept/incoming row is
 *  stamped with `nodeId` on the way in (never trusted verbatim off the wire) so this file can never
 *  end up with a row claiming a `nodeId` other than the one that was just told to own it.
 *
 *  `reportedAt` is REQUIRED and is stamped by the caller from the arrival of the frame that carried
 *  these rows. It is not defaulted and never computed here: a caller that omitted it would not get
 *  "no freshness claim", it would get a plausible WRONG one — the moment the write happened rather
 *  than the moment the node spoke — and the field exists precisely to expose staleness. An empty
 *  `runs` still writes the entry: "reported, and had nothing running" is a real observation, and it
 *  is the one this envelope exists to tell apart from silence. */
export async function applyRemoteRuns(
  nodeId: ClusterNodeId,
  runs: readonly ClusterRemoteRun[],
  reportedAt: string,
  options?: ClusterHomeOptions,
): Promise<void> {
  return serializeRemoteRunsWrite(async () => {
    const file = await readRemoteRunsFile(options);
    const kept = file.runs.filter((row) => row.nodeId !== nodeId);
    const incoming = runs.map((run) => (run.nodeId === nodeId ? run : { ...run, nodeId }));
    writeRemoteRunsFile(
      { runs: [...kept, ...incoming], nodes: { ...file.nodes, [nodeId]: { reportedAt } } },
      options,
    );
  }, options);
}

/** Statuses `markNodeUnreachable` will touch — the terminal three are excluded on purpose (see its
 *  own doc comment): a finished run's truth does not change because the node that produced it went
 *  quiet. */
const LIVE_RUN_STATUSES = new Set<ClusterRemoteRun['status']>(['queued', 'running', 'waiting', 'review']);

/** D10: the owning node went away mid-run. Marks its live rows `unreachable` — a statement about
 *  visibility, never a status change, and reversible when the node comes back (the next
 *  `applyRemoteRuns` for that node replaces these rows wholesale, `unreachable` included).
 *  Idempotent and returns the count actually TOUCHED this call, not the count already marked, so a
 *  caller cannot mistake a re-run for fresh news.
 *
 *  Leaves the `nodes` envelope exactly as it found it, including the now-stale `reportedAt`. That
 *  staleness is the point: "these rows are as of 11:04" is what makes an unreachable row readable
 *  as history rather than as current state, and refreshing or clearing it here would either claim
 *  this node just spoke or erase the only record that it ever did. */
export async function markNodeUnreachable(
  nodeId: ClusterNodeId,
  at: Date,
  options?: ClusterHomeOptions,
): Promise<number> {
  return serializeRemoteRunsWrite(async () => {
    const file = await readRemoteRunsFile(options);
    let changed = 0;
    const next = file.runs.map((row) => {
      if (row.nodeId !== nodeId || row.unreachable || !LIVE_RUN_STATUSES.has(row.status)) return row;
      changed += 1;
      return { ...row, unreachable: true, unreachableSince: at.toISOString() };
    });
    if (changed > 0) writeRemoteRunsFile({ runs: next, nodes: file.nodes }, options);
    return changed;
  }, options);
}
