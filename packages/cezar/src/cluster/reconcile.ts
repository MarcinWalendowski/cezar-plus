import { isDeepStrictEqual } from 'node:util';
import type { ClusterNodeId, ClusterProjectKey, ClusterTodoFields } from '@loki-labs/cezar-plus-contract';
import { backupAndAppendTodosPreservingIds, backupTodos, readTodos, type TodoItem } from '../todos.ts';
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
 * **Back up before any write, per side.** `todos.json.bak` is written before THAT SIDE's own first
 * mutation, not after the first success — a reconcile that half-applied and then failed is exactly
 * the case the backup exists for. **CORRECTED 2026-08-23 — this used to say "on both sides"
 * meaning both backups land before EITHER side mutates.** That joint ordering is gone:
 * `reconcileProject`'s local backup and local append are now fused into one lease
 * (`backupLocalAndMaybeAppend`, D21's amendment — the "Found during implementation" row about a
 * `.bak` written outside the lease that guarded the write it protected), so local can finish
 * mutating before the remote backup is even taken. Each backup still strictly precedes its OWN
 * side's mutation, which is the property this file actually needs; giving up the joint ordering is
 * safe because both mutation paths are idempotent by id (`appendTodosPreservingIds`/
 * `backupAndAppendTodosPreservingIds` locally, `RemoteReconcileTransport#apply` on the peer, per
 * its own docblock below) — a pass that dies between the local mutation and the remote backup
 * converges cleanly on retry: nothing duplicates, nothing corrupts, and the remote side was never
 * touched this pass, so it needed no backup yet.
 *
 * **This module never dials out itself.** **CORRECTED 2026-08-23 — the first half of this
 * paragraph is no longer true.** It said `todos.ts` *"does not yet carry the cluster fields
 * (`pendingSince`/`hubSeq`/`tombstone`/`placement`/`startedOn` — package 2.3 … still open as this
 * file was written)"*. Package 2.3 landed: `todoSchema` now spreads `clusterTodoFieldsSchema.shape`
 * verbatim, so `TodoItem` carries all **six** of them — the original list is also one short,
 * `pendingFields` was added after that note was written. `cluster/replica.ts` dropped its own
 * `TodoItem & ClusterTodoFields` intersection on the same date for the same reason. The link (1.3)
 * and the ops/replica pipeline (2.1/2.2) do now exist as modules, though nothing arms the link yet
 * (`startClusterRuntime` is still a warning, not activation). What is unchanged, and is the actual
 * point of this paragraph: the
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
  /** Each path is written before THAT SIDE's own mutation, not necessarily before the other side's
   *  (module header, "CORRECTED 2026-08-23" — the local backup+append are fused under one lease
   *  and can both complete before the remote backup is even taken). Empty on a dry run — and a
   *  caller must not read an empty list as "nothing to back up". */
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
   * The peer side of every paired project — see `RemoteReconcileTransport`.
   *
   * **CORRECTED 2026-08-23 — the gap this described is closed, and the route it says does not
   * exist now does.** The original text (kept below) called out "no HTTP route for a project's full
   * todos snapshot" as a real gap in the plan. D21 built exactly that route family —
   * `GET /cluster/todos/:projectKey` plus `/backup` and `/append`, all node-authenticated (D20) —
   * and `cluster/reconcile-transport.ts#createHttpReconcileTransport` is the transport that speaks
   * it. So a reader looking for "the missing piece" should stop looking: it is built, and
   * `index.ts`'s `cez cluster reconcile` wires it for real.
   *
   * What has NOT changed is that this field stays OPTIONAL, for the surviving half of the original
   * reason: this module has no peer registry of its own, so it cannot pick a peer or mint that
   * peer's credential without importing `peers.ts` and `node-identity.ts`. The caller resolves both
   * and hands the transport in. Omitting it still throws a named error rather than silently doing
   * nothing.
   *
   * Original text, unchanged: *"OPTIONAL for the same reason as `resolveLocalDataDir`: nothing in
   * this plan yet exposes a live 'fetch a peer's full todo list' call to wire a default from — the
   * cluster link (`link-client.ts`) is fire-and-forget and event-streamed (`send`/`on('frame', …)`,
   * no request/response), and there is no HTTP route for a project's full todos snapshot in
   * `packages/contract/src/cluster.ts`'s API list. That is a real gap in the plan, not an oversight
   * in this file — flagged prominently in the report rather than papered over with an invented
   * transport this package does not own."*
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
//
// **CORRECTED again 2026-08-23, same day — `appendLocalTodos` and the standalone
// `backupLocalTodos` above it are both gone.** The paragraph above fixed the deadlock but left a
// second hazard in place: `backupLocalTodos` took no lease at all, and `appendLocalTodos` took its
// own, so a concurrent local `createTodo`/`updateTodo`/`markStarted`/`removeTodo` landing in the
// gap between the two calls was picked up correctly by the append (a fresh read, under its own
// lease) and absent from the `.bak` — a backup that can be older than the state it backs up, and
// trusted anyway (PLAN "Found during implementation", the row this fixes). `todos.ts` now exports
// `backupAndAppendTodosPreservingIds`, doing both under ONE lease — the same primitive
// `server/cluster-routes.ts`'s `/cluster/todos/:projectKey/append` route uses on the hub side
// (D21's amendment) — so this file delegates to it directly rather than composing its own pair of
// calls. `backupLocalAndMaybeAppend`, below, is the one call site.

/** Local half of "back up, then (maybe) append" for one project's `todos.json`, done under ONE
 *  lease when there is something to append — see the correction above for the hazard this closes.
 *  Delegates to `todos.ts`'s `backupAndAppendTodosPreservingIds` whenever `adds` is non-empty.
 *  `adds` is empty exactly when every divergent entry classified `local-only` (headed to the peer
 *  instead of landing here) — there is no append to fold a backup into, but a backup is still
 *  owed: `RemoteReconcileTransport#backup`'s own docblock states the same "before the first
 *  mutation of a pass, whether or not THIS side ends up receiving an add" contract for the peer,
 *  and the local side honors it the same way, via the standalone, lease-free `backupTodos`
 *  (mirrors the hub's own `/cluster/todos/:projectKey/backup` route, which exists for exactly this
 *  zero-adds case). Returns the backup path either way, for `reconcileProject`'s `backupPaths`. */
async function backupLocalAndMaybeAppend(dataDir: string, adds: readonly TodoItem[]): Promise<string> {
  if (adds.length === 0) return backupTodos(dataDir);
  const { backupPath } = await backupAndAppendTodosPreservingIds(dataDir, adds);
  return backupPath;
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
    // **Each side is backed up under the same step as its own mutation.** The local half backs up
    // and (when there is one) appends under a SINGLE lease — `backupLocalAndMaybeAppend`, above,
    // and the correction in the "local filesystem I/O" section explaining why a separate backup
    // call and a separate append call is exactly the hazard this closes. The remote half is
    // symmetric but out of this file's hands: `remoteTransport.backup`/`apply` are the peer's own
    // primitives to pair correctly (the hub's `/cluster/todos/:projectKey/append` route fuses them
    // the same way on its side, D21's amendment).
    //
    // **CORRECTED 2026-08-23 — this said "Both sides, before the FIRST mutation", and fusing the
    // local pair made that false in the same edit that made it safe.** The local append now lands
    // BEFORE `remoteTransport.backup()` is taken, where it used to land after; a reader trusting
    // the old sentence would conclude nothing is mutated until both `.bak` files exist, and that
    // is no longer what happens. What is actually guaranteed, and is the property that matters:
    // **no side is ever mutated without a fresh backup OF THAT SIDE** — local under one lease
    // here, remote by the hub's own fused route. What was given up is cross-side atomicity: a pass
    // that dies between the local append and the remote backup leaves this side written and the
    // peer untouched. That is recoverable rather than corrupting, because both append paths skip
    // an id already present (`appendTodosPreservingIds`, on both sides), so re-running the pass
    // converges instead of duplicating — and the local `.bak` written under that same lease is a
    // true pre-mutation snapshot either way. Ordering the remote backup first would restore the
    // stronger reading, at the cost of paying a network round trip before touching local state; it
    // is not free either way, and this is the trade that was taken, deliberately.
    backupPaths.push(
      await backupLocalAndMaybeAppend(
        localDataDir,
        remoteOnly.map((e) => e.remote as TodoItem),
      ),
    );
    backupPaths.push(await remoteTransport.backup(projectKey));

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
  /**
   * One pass.
   *
   * **CORRECTED 2026-08-23 — there is no production caller, so this described one that does not
   * exist.** Verified: `startPeriodicReconcile` is referenced in exactly two places outside its own
   * tests — its definition here, and a docblock in `server/cluster-routes.ts` recording that
   * activation *deliberately does not arm it*. Nothing constructs these options in production, and
   * `dryRun` is a REQUIRED field on `ReconcileOptions` with no default, so there is no standing
   * behaviour for this sentence to have been describing.
   *
   * This matters because the original text was written in the present tense and directly
   * contradicts D21, which keeps the real merge owner-gated. A reader hitting it would reasonably
   * conclude either that a periodic non-dry-run reconcile is already running (it is not), or that
   * arming one non-dry-run is simply implementing the documented design (it is not — it is the
   * decision D21 reserved). The divergence in play is ~110 one-side-only rows, which is exactly the
   * class a non-dry-run pass merges, so guessing here is expensive.
   *
   * What is true today: a test supplies a double directly, which is what makes the scheduling
   * guarantees below provable without depending on peer enumeration. Whoever arms the first real
   * caller owns the dry-run decision, must get it from the owner, and must correct this block again
   * to say which way it went. Original text, describing an intent rather than a caller:
   *
   * > in production, a non-dry-run `reconcileAll` against every peer this node is linked to (peer
   * > enumeration is `cluster/peers.ts`'s pairing store, out of this package's scope — see the
   * > module header); a test supplies a double directly, so the scheduling guarantees below are
   * > provable without depending on that module landing first.
   */
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
