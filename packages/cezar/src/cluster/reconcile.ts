import { promises as fs } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { ClusterNodeId, ClusterProjectKey, ClusterTodoFields } from '@loki-labs/better-cezar-contract';
import { appendTodosPreservingIds, readTodos, todosPath, type TodoItem } from '../todos.ts';
import type { ClusterHomeOptions } from './node-identity.ts';

/**
 * The reconcile classifier, and the periodic full reconcile that is what actually recovers a
 * sleeping node (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D16; PLAN 2.4/2.5).
 *
 * **A watcher that stops firing is indistinguishable from a quiet system** (D16), and macOS
 * `fs.watch` is known to go quiet across sleep. So this runs on a low-frequency schedule regardless
 * of whether any op arrived — watermark comparison first, then a diff pass — and its last-success
 * time is a health signal the cockpit renders (`ClusterLinkHealth.lastReconcileAt`). The watcher is
 * the fast path; this is the correct one.
 *
 * **Three classes, and the third is not resolvable by any ordering rule.** The 110-row divergence
 * that already exists predates every clock and every hub: a single source of truth prevents FUTURE
 * divergence, it cannot adjudicate divergence that happened before it existed. So a row where both
 * sides differ and neither ever saw the hub is **refused**, named, and left for a human — an agent
 * auto-picking a side here is the most believable wrong answer available (PLAN P9).
 *
 * **Back up before any write, on both sides.** `todos.json.bak` is written before the first mutation,
 * not after the first success — a reconcile that half-applied and then failed is exactly the case
 * the backup exists for.
 *
 * **This module never dials out itself.** `todos.ts` (`packages/cezar/src/todos.ts`) does not yet
 * carry the cluster fields (`pendingSince`/`hubSeq`/`tombstone`/`placement`/`startedOn` — package
 * 2.3, `.ai/runs/2026-08-22-multi-node-cezar-cluster/PLAN.md`, still open as this file was written),
 * and neither the link (1.3) nor the ops/replica pipeline (2.1/2.2) exist yet either. So the
 * REMOTE side of a reconcile — reading a peer's todos and writing a merge back onto it — is an
 * injected `RemoteReconcileTransport` rather than a socket this module opens: in production the
 * caller backs it with the established cluster link (out of this package's scope — see
 * `packages/cezar/src/cluster/link-client.ts`), in a test it is backed by a second temp directory.
 * `classify` itself stays pure either way; only the I/O around it is pluggable.
 */

/**
 * `local-only` / `remote-only` — present one side, absent the other. Copy across.
 * `identical` — same id, same content. Nothing to do, and the count is the sanity check.
 * `divergent-unclocked` — both sides differ and neither carries a `hubSeq`. **Refused**, never
 *   auto-merged: there is no fact available that says which is right.
 */
export type ReconcileClass =
  | 'local-only'
  | 'remote-only'
  | 'identical'
  | 'divergent-unclocked';

export interface ReconcileEntry {
  class: ReconcileClass;
  entityId: string;
  local?: TodoItem;
  remote?: TodoItem;
  /** For `divergent-unclocked`: which fields disagree, so a human is shown the disagreement rather
   *  than two whole records to diff by eye. */
  fields?: string[];
}

export interface ReconcileReport {
  projectKey: ClusterProjectKey;
  entries: ReconcileEntry[];
  counts: Record<ReconcileClass, number>;
  /** Written before the first mutation. Empty on a dry run — and a caller must not read an empty
   *  list as "nothing to back up". */
  backupPaths: string[];
  /** True when nothing was written. The dry run is the default posture for the real divergence. */
  dryRun: boolean;
}

/**
 * The peer side of one reconcile, supplied by the caller. Reconcile itself has no project registry
 * and no transport — see the module header. Every method is scoped to `peerNodeId` implicitly (the
 * caller builds one transport per peer it is reconciling against).
 *
 * `apply`'s `adds` are guaranteed absent from the peer's own list as of the `list()` call that
 * produced them, but a real implementation should still be safe to retry (skip an id that has
 * already landed) — a re-run after a partial failure must never duplicate a row it already added.
 */
export interface RemoteReconcileTransport {
  /** Every project this node has confirmed paired with the peer (`cluster/peers.ts`, out of this
   *  package's scope). Drives `reconcileAll`. */
  listProjects(): Promise<ClusterProjectKey[]>;
  /** The peer's current, full todo list for one project. */
  list(projectKey: ClusterProjectKey): Promise<TodoItem[]>;
  /** Writes `todos.json.bak` on the peer, from whatever the peer currently holds — called before
   *  the first mutation of a reconcile pass that is about to write EITHER side, whether or not the
   *  peer itself ends up receiving an add. Returns the path it wrote, for the report. */
  backup(projectKey: ClusterProjectKey): Promise<string>;
  /** Appends `adds` to the peer's list, verbatim (id, `ts`, `author` — every field the entry
   *  already carries; reconcile never rewrites a field). Called only after `backup` has settled
   *  for this project, and only when `adds` is non-empty. */
  apply(projectKey: ClusterProjectKey, adds: readonly TodoItem[]): Promise<void>;
}

export interface ReconcileOptions extends ClusterHomeOptions {
  dryRun: boolean;
  /** The peer whose records are being compared against this node's. */
  peerNodeId: ClusterNodeId;
  /**
   * Resolves a paired project's LOCAL data directory (where this node's own `todos.json` for it
   * lives). Reconcile has no project registry of its own.
   *
   * OPTIONAL, and deliberately so: the real resolution (a confirmed pairing's `byNode[thisNodeId]
   * .projectId` → the workspace project registry's `root`) needs `cluster/peers.ts` and
   * `cluster/node-identity.ts`, both mid-flight in sibling packages as this file was written and
   * too unstable to import from safely at the time — see the report for package 2.4. Omitting this
   * (and `remote` below) throws a named error rather than silently doing nothing; the CLI's own
   * `catch` (`index.ts`'s `cez cluster reconcile` case) already surfaces a thrown message as-is.
   */
  resolveLocalDataDir?: (projectKey: ClusterProjectKey) => string;
  /**
   * The peer side of every paired project — see `RemoteReconcileTransport`. OPTIONAL for the same
   * reason as `resolveLocalDataDir`: nothing in this plan yet exposes a live "fetch a peer's full
   * todo list" call to wire a default from — the cluster link (`link-client.ts`) is fire-and-forget
   * and event-streamed (`send`/`on('frame', …)`, no request/response), and there is no HTTP route
   * for a project's full todos snapshot in `packages/contract/src/cluster.ts`'s API list. That is a
   * real gap in the plan, not an oversight in this file — flagged prominently in the report rather
   * than papered over with an invented transport this package does not own.
   */
  remote?: RemoteReconcileTransport;
}

/** `resolveLocalDataDir`/`remote` are optional on `ReconcileOptions` (see there for why) so the
 *  real caller (`cez cluster reconcile`, `index.ts`) type-checks against just `{ dryRun,
 *  peerNodeId }` today. Calling without them is a configuration error, not a silent no-op. */
function requireWiring(
  options: ReconcileOptions,
): { resolveLocalDataDir: (projectKey: ClusterProjectKey) => string; remote: RemoteReconcileTransport } {
  if (!options.resolveLocalDataDir || !options.remote) {
    throw new Error(
      'cluster reconcile has no project resolver / remote transport configured yet — nothing in ' +
        'this plan currently exposes a live "fetch a peer\'s full todo list" call (the cluster link ' +
        'is fire-and-forget/event-streamed, and no HTTP route serves a todos snapshot). Pass ' +
        'options.resolveLocalDataDir and options.remote explicitly until that lands.',
    );
  }
  return { resolveLocalDataDir: options.resolveLocalDataDir, remote: options.remote };
}

/** A `TodoItem` that may additionally carry the cluster bookkeeping fields, once `todos.ts`'s own
 *  schema is extended with them (package 2.3). Declared locally rather than by editing `todos.ts`
 *  — see the module header — so this reads correctly both before and after that lands: today every
 *  record reads these as `undefined`, which is the honest state of the real divergence (it predates
 *  the hub entirely). */
type PossiblyClustered = TodoItem & Partial<ClusterTodoFields>;

/** Fields that describe the CLUSTER's opinion of a record, not the record's own content. Two
 *  records that agree on everything else must not be called different merely because one has been
 *  stamped and the other has not. */
const CLUSTER_BOOKKEEPING_FIELDS = ['pendingSince', 'hubSeq', 'tombstone', 'placement', 'startedOn'] as const;

function contentOf(item: TodoItem): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  for (const field of CLUSTER_BOOKKEEPING_FIELDS) delete clone[field];
  return clone;
}

function contentEqual(a: TodoItem, b: TodoItem): boolean {
  return isDeepStrictEqual(contentOf(a), contentOf(b));
}

/** Field-by-field, so a human sees the disagreement rather than two whole records to diff by eye. */
function diffFields(local: TodoItem, remote: TodoItem): string[] {
  const a = contentOf(local);
  const b = contentOf(remote);
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const key of keys) {
    if (key === 'id') continue;
    if (!isDeepStrictEqual(a[key], b[key])) out.push(key);
  }
  return out.sort();
}

/** Pure. `divergent-unclocked` requires that NEITHER side carries a `hubSeq` — once the hub has seen
 *  a record there is an order, and the classifier must not pretend there is a conflict. */
export function classify(local: TodoItem | undefined, remote: TodoItem | undefined): ReconcileClass {
  if (local && !remote) return 'local-only';
  if (!local && remote) return 'remote-only';
  if (!local && !remote) {
    throw new Error('classify: at least one of local/remote must be defined');
  }
  const l = local as TodoItem;
  const r = remote as TodoItem;
  if (contentEqual(l, r)) return 'identical';
  // Content differs. `divergent-unclocked` is reserved for the case neither side has ever been
  // ordered by the hub — that is the actual real-world shape (todos.ts carries no `hubSeq` yet, so
  // this reads undefined for every record that exists today, which is correct: the 110-row
  // divergence predates the hub entirely). Once EITHER side has a `hubSeq`, the hub has already
  // established an order for this record; a further difference is the replica pipeline's job to
  // correct (D4/D7), not this bootstrap tool's, so it is not reported as a conflict here.
  const localHubSeq = (l as PossiblyClustered).hubSeq;
  const remoteHubSeq = (r as PossiblyClustered).hubSeq;
  if (localHubSeq === undefined && remoteHubSeq === undefined) return 'divergent-unclocked';
  return 'identical';
}

function classifyEntries(
  local: readonly TodoItem[],
  remote: readonly TodoItem[],
): { entries: ReconcileEntry[]; counts: Record<ReconcileClass, number> } {
  const localById = new Map(local.map((t) => [t.id, t] as const));
  const remoteById = new Map(remote.map((t) => [t.id, t] as const));
  const ids = new Set<string>([...localById.keys(), ...remoteById.keys()]);

  const counts: Record<ReconcileClass, number> = {
    'local-only': 0,
    'remote-only': 0,
    identical: 0,
    'divergent-unclocked': 0,
  };
  const entries: ReconcileEntry[] = [];
  for (const id of ids) {
    const l = localById.get(id);
    const r = remoteById.get(id);
    const cls = classify(l, r);
    counts[cls] += 1;
    const entry: ReconcileEntry = { class: cls, entityId: id, local: l, remote: r };
    if (cls === 'divergent-unclocked' && l && r) entry.fields = diffFields(l, r);
    entries.push(entry);
  }
  return { entries, counts };
}

// ---- local filesystem I/O --------------------------------------------------------------------
// This section used to re-implement `todos.ts`'s own `O_EXCL` write lease locally — same lock
// file name, same dataDir — because `todos.ts` exported no insert that PRESERVES an existing id
// (`createTodo` always mints a fresh one, which is wrong for copying a record that already exists
// on the other side). That re-implementation nested a second, non-reentrant acquisition of the
// SAME lease (`appendLocalTodos` called `readTodos`, which takes this lease on its own id-backfill
// path, from inside its own `withLease`) and deadlocked for the lease's 5s timeout the moment the
// local file needed an id backfill — see the PLAN's "Found during implementation" row and the
// report for this fix. **Corrected 2026-08-23:** `todos.ts` now exports
// `appendTodosPreservingIds`, built for exactly this call site, so the local re-implementation is
// gone; `appendLocalTodos` below is a thin wrapper over it.

/** `todos.json.bak`, copied from whatever is on disk right now — raw bytes, not re-serialized, so
 *  the safety net is exactly what was there before this run touched anything. `[]` when the file
 *  does not exist yet, matching `readTodos`'s own empty-inbox default. */
async function backupLocalTodos(dataDir: string): Promise<string> {
  const file = todosPath(dataDir);
  const backupFile = `${file}.bak`;
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    raw = '[]';
  }
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(backupFile, raw, 'utf8');
  return backupFile;
}

/** Appends `items` verbatim (id, `ts`, `author` — every field the entry already carries) by
 *  delegating to `todos.ts`'s `appendTodosPreservingIds` — the same lease and read-modify-write
 *  shape as every other writer in that file, in a single lease acquisition (see that function's
 *  docblock for why this used to deadlock before it existed). Idempotent: an id already present on
 *  this side is skipped, so a retried reconcile pass never duplicates a row it already added. */
async function appendLocalTodos(dataDir: string, items: readonly TodoItem[]): Promise<void> {
  if (items.length === 0) return;
  await appendTodosPreservingIds(dataDir, items);
}

// ---- the classifier + merge, per project and across every paired project ----------------------

export async function reconcileProject(
  projectKey: ClusterProjectKey,
  options: ReconcileOptions,
): Promise<ReconcileReport> {
  const { resolveLocalDataDir, remote: remoteTransport } = requireWiring(options);
  const localDataDir = resolveLocalDataDir(projectKey);
  const [local, remote] = await Promise.all([readTodos(localDataDir), remoteTransport.list(projectKey)]);
  const { entries, counts } = classifyEntries(local, remote);

  const localOnly = entries.filter((e) => e.class === 'local-only');
  const remoteOnly = entries.filter((e) => e.class === 'remote-only');
  const willWrite = !options.dryRun && (localOnly.length > 0 || remoteOnly.length > 0);

  const backupPaths: string[] = [];
  if (willWrite) {
    // Both sides, before the FIRST mutation — a reconcile that half-applied and then failed is
    // exactly the case the backup exists for (module header).
    backupPaths.push(await backupLocalTodos(localDataDir));
    backupPaths.push(await remoteTransport.backup(projectKey));

    if (remoteOnly.length > 0) {
      await appendLocalTodos(
        localDataDir,
        remoteOnly.map((e) => e.remote as TodoItem),
      );
    }
    if (localOnly.length > 0) {
      await remoteTransport.apply(
        projectKey,
        localOnly.map((e) => e.local as TodoItem),
      );
    }
  }

  return { projectKey, entries, counts, backupPaths, dryRun: options.dryRun };
}

/** Every paired project. One report per project — a merged total would hide which repo the ten
 *  refusals are in, which is the only question a human can act on. A project whose own reconcile
 *  throws (an unreachable peer, a corrupt local file) is logged and skipped rather than aborting
 *  every other project's pass — the same "one bad entry never stops the rest" precedent
 *  `todo-autostart.ts` already sets. */
export async function reconcileAll(options: ReconcileOptions): Promise<ReconcileReport[]> {
  const warn = options.warn ?? ((message: string) => console.warn(`[cez] ${message}`));
  const { remote: remoteTransport } = requireWiring(options);
  const projects = await remoteTransport.listProjects();
  const reports: ReconcileReport[] = [];
  for (const projectKey of projects) {
    try {
      reports.push(await reconcileProject(projectKey, options));
    } catch (err) {
      warn(`cluster reconcile failed for "${projectKey}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return reports;
}

export interface PeriodicReconcileOptions extends ClusterHomeOptions {
  intervalMs: number;
  /** One pass: in production, a non-dry-run `reconcileAll` against every peer this node is linked
   *  to (peer enumeration is `cluster/peers.ts`'s pairing store, out of this package's scope — see
   *  the module header); a test supplies a double directly, so the scheduling guarantees below are
   *  provable without depending on that module landing first. */
  run: () => Promise<unknown>;
  /** Stamped on success only. A reconcile that threw must leave the previous timestamp alone, or
   *  the health signal reports freshness it does not have. */
  onSuccess?: (at: Date) => void;
}

/** Returns the stop function, the disposal shape used throughout this codebase. Never runs two
 *  passes concurrently: the second would diff against a tree the first is mid-write on.
 *
 * Runs one immediate pass on start (the same "boot pass" `watchTodoAutostart` runs, covering a node
 * that came up with divergence already sitting there) and then one pass every `intervalMs`
 * regardless of whether any op arrived (D16) — the mechanism that recovers a node whose watcher went
 * quiet across sleep, not the watcher itself. Passes are chained on a promise tail, exactly
 * `todo-autostart.ts#reconcileAutostartTodos`'s own idiom for the same reason: a pass must never
 * start while the previous one is still mid-write. */
export function startPeriodicReconcile(options: PeriodicReconcileOptions): () => void {
  const warn = options.warn ?? ((message: string) => console.warn(`[cez] ${message}`));
  const now = options.now ?? (() => new Date());
  let stopped = false;
  let tail: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const runOnce = (): Promise<void> => {
    tail = tail.then(async () => {
      if (stopped) return;
      try {
        await options.run();
        options.onSuccess?.(now());
      } catch (err) {
        warn(`periodic cluster reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    return tail;
  };

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      void runOnce().finally(scheduleNext);
    }, options.intervalMs);
    timer.unref?.();
  };

  void runOnce().finally(scheduleNext);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
