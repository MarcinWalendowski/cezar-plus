import { join } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { AutomationStore } from '../automations/store.ts';
import { reconcileAutomationReceipts } from '../automations/task-template.ts';
import { DEFAULT_WORKTREE_RETENTION, resolveWorktreeRetention } from '../config.ts';
import { canonicalPath, pruneOrphans } from '../git-worktree.ts';
import { emitCorpusChanged } from '../cluster/corpus-change-bus.ts';
import { KnowledgeStore } from '../knowledge/store.ts';
import { NotificationOutbox, notificationsDataDir } from '../notifications/outbox.ts';
import { NotificationRegistry } from '../notifications/registry.ts';
import { NotificationSender } from '../notifications/sender.ts';
import { reclaimWorktrees } from '../runs/retention.ts';
import { RunStore } from '../runs/store.ts';
import { findForeignWorkspaceOwner, loadForeignWorkspaceRunSources } from '../runs/worktree-ownership.ts';
import { SourceStore } from '../sources/store.ts';
import { normalizeRoot } from '../workspace/projects.ts';
import { WorkspaceRunIndex, type WorkspaceRunProjectSource } from '../workspace/run-index.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { accountAuthFromService } from '../workspace/account-viability.ts';
import type { AccountAuth } from '../workspace/account-viability.ts';
import type { ProviderAuthService, ProviderId } from '../core/provider-auth.ts';
import { RunManager } from '../workflows/run.ts';
import { isLoopbackHost } from './capabilities.ts';
import { ensureLaunchKey } from './launch-key.ts';
import { getRepoInfo } from './git.ts';

/**
 * Per-project server context (spec 2026-07-20-multi-project-workspace,
 * "Project contexts" + "Boot flow"): one `{store, manager, dataDir,
 * launchKey}` bundle per registered project, built lazily on first access.
 *
 * Building a context mirrors what `serveCommand` does for the boot project
 * today — `RunStore.open(dataDir, { keepLive: true })`, `new RunManager`,
 * orphan-worktree prune + count-based retention when the root is a git repo,
 * then `manager.recover()` — so a project opened from the sidebar gets the
 * exact same crash recovery the boot project gets. A registry entry whose
 * root is gone (`status: 'missing'`) is never instantiated; `context()`
 * throws a typed `ProjectContextError` the route layer maps to 409 (and
 * `unknown-project` to 404).
 *
 * **Central-hub activation** (`.ai/runs/2026-08-06-cezar-central-hub/PLAN.md`, W3.1, D22a): this
 * file also hangs the F1/F2 per-project stores on the bundle above, and registers the F3/F4
 * workspace-level singletons on `ProjectContexts` itself, never per project (a notification
 * runtime and a cross-project run index are one-per-process by nature).
 *
 * - `knowledgeStore` (F1, `CEZ_KB=1`) and `sourceStore` (F2, `CEZ_SOURCES=1`) are built in
 *   `build()` and torn down in `teardown()`/`dispose()`, exactly like `automationStore`. Unlike
 *   `automationStore`, each is gated on its own flag and performs ZERO I/O when that flag is
 *   unset (D4): a context built with every central-hub flag off is byte-identical to one built
 *   before this package existed.
 * - `runIndex` (W1.11) and `notifications()` (W1.7 registry + W2.5 outbox/sender) live on
 *   `ProjectContexts`, not on any one `ProjectContext`; see the class doc comment below.
 */

/** The per-project bundle the routes operate on. */
/**
 * The two flag-gated stores a project context may carry, built the same way for
 * EVERY project.
 *
 * Extracted 2026-08-06 because it was not. `ProjectContexts.build()` activated
 * these, and the boot project never goes through `build()` — `server.ts` hand-
 * builds its `bootContext` from the deps `serveCommand` already had. So with
 * `CEZ_KB=1` the knowledge base came up on every project EXCEPT the one the
 * user is looking at, and `resolveProjectScope` hands that same boot context to
 * unscoped requests, to `default`, AND to the boot project's own id — three of
 * the four ways to name it. The cockpit showed an empty Knowledge tab over a
 * fully-indexed corpus (80 documents, verified directly against the store).
 *
 * The general shape of that bug — one construction path per caller, silently
 * diverging — is why this is a function rather than a second copy: any store
 * added here reaches both paths or neither.
 */
export interface OptionalProjectStores {
  knowledgeStore?: KnowledgeStore;
  sourceStore?: SourceStore;
}

export function activateOptionalStores(opts: {
  env: NodeJS.ProcessEnv;
  projectId: string;
  root: string;
  dataDir: string;
  /** The host the server bound to, for the hosted-mode decision — same value
   *  `resolveCapabilities(env, bindHost)` reads. Omitted reads as loopback. */
  bindHost?: string;
}): OptionalProjectStores {
  const { env, projectId, root, dataDir, bindHost } = opts;

  // F1 (plan D4/D22a): zero I/O when `CEZ_KB` is unset. `KnowledgeStore.create` itself never
  // touches the filesystem; only `initialize()` does, and that is fired below without awaiting.
  const knowledgeStore = env.CEZ_KB === '1'
    ? KnowledgeStore.create(root, dataDir, {
        env,
        hosted: env.CEZ_REMOTE === '1' || !isLoopbackHost(bindHost),
        // A hub tells its spokes the corpus moved the moment it actually moves, instead of every
        // spoke waiting out its own interval (cluster spec item 57). Emitting unconditionally is
        // deliberate: the bus is a no-op with nothing registered, which is the state on a spoke and
        // on any non-clustered cockpit, so this costs a function call and gates on nothing.
        onChanged: () => emitCorpusChanged(),
      })
    : undefined;
  if (knowledgeStore) {
    // Fire-and-forget, per `KnowledgeStore.initialize()`'s own doc comment: "the build runs off
    // the boot path, after listen". A full corpus scan must never add latency to this project's
    // first API touch. A caller that needs to know whether the scan finished reads
    // `knowledgeStore.isInitialized()`.
    void knowledgeStore.initialize().catch((err: unknown) => {
      console.warn(
        `[cez] knowledge base failed to initialize for project "${projectId}": ${describeError(err)}`,
      );
    });
  }

  // F2 (plan D4/D22a): zero I/O when `CEZ_SOURCES` is unset. `SourceStore.open` DOES do
  // synchronous I/O (mkdir + read), so a failure here degrades to `undefined` with a warning
  // rather than failing the whole project context: the run store, manager and automation
  // store have nothing to do with external sources and must still come up.
  let sourceStore: SourceStore | undefined;
  if (env.CEZ_SOURCES === '1') {
    try {
      sourceStore = SourceStore.open(dataDir);
    } catch (err) {
      console.warn(
        `[cez] external sources store failed to open for project "${projectId}": ${describeError(err)}`,
      );
    }
  }

  return { knowledgeStore, sourceStore };
}

export interface ProjectContext {
  /** Registry project id (slug). */
  id: string;
  /** Realpath'd repo root the registry holds for this project. */
  root: string;
  /** `<root>/.ai/cezar` — all of this project's on-disk state. */
  dataDir: string;
  store: RunStore;
  manager: RunManager;
  automationStore: AutomationStore;
  /** Present only when `CEZ_KB` is exactly `'1'` (F1, plan W2.1); `undefined` otherwise, with
   *  zero I/O performed to decide that (D4). `build()` fires `initialize()` off without awaiting
   *  it (see that method's own doc comment: "the call runs off the boot path, after listen"), so a
   *  full corpus scan never adds latency to this project's first API touch; a caller that needs to
   *  know whether the scan has finished reads `knowledgeStore.isInitialized()`. */
  knowledgeStore?: KnowledgeStore;
  /** Present only when `CEZ_SOURCES` is exactly `'1'` (F2, plan W1.5), the same zero-I/O-when-off
   *  contract as `knowledgeStore`. Opening it is cheap (JSON reads, no directory scan), so unlike
   *  `knowledgeStore` there is no async warm-up to avoid awaiting. */
  sourceStore?: SourceStore;
  /** Bookmarklet auto-start secret (spec 011), ensured at context build. */
  launchKey: string;
  sweepTimer?: NodeJS.Timeout;
}

/** Minimal registry shape the context map needs — matches
 *  `workspace/projects.ts` `ProjectListEntry` structurally, but injected so
 *  tests stay hermetic (no `~/.cezar` reads). */
export interface ProjectContextSource {
  id: string;
  root: string;
  /** `missing` roots are never instantiated; `ok`/`not-git` both build. */
  status: 'ok' | 'missing' | 'not-git' | 'no-commits';
  /** Display name. Optional because every caller and test fixture written before W3.1 never set
   *  it; threaded through to `WorkspaceRunIndex` (workspace level, D22a) as `name ?? ''`, which
   *  that module already turns into `basename(root)` when falsy. */
  name?: string;
}

/** The workspace-level notification runtime (plan D22a: this package's dependency on F4 is
 *  narrowed to exactly W1.7's registry and W2.5's outbox/sender, not W1.8's config store or
 *  W2.4's webhook transport). One instance for the whole process, never per project, reachable
 *  via `ProjectContexts.notifications()`. `registry` starts with zero registered transports:
 *  loading `~/.cezar/notifications.json` and turning its rows into `RegisteredTransport`s is a
 *  later package's job (W4.7), which is also what calls `registry.register(...)` as transports
 *  are added or edited. `sender.start()` IS called here (this package's whole point is
 *  activation); with nothing registered, `dispatch()` is never invoked by anything yet, so
 *  starting early arms no timer (D4's "no background timer" holds) and only holds the
 *  cross-process outbox lease, which is the intended one-sender-per-`CEZ_HOME` guarantee. */
export interface NotificationRuntime {
  readonly outbox: NotificationOutbox;
  readonly registry: NotificationRegistry;
  readonly sender: NotificationSender;
}

export interface ProjectContextDeps {
  /** Registry lookup — the workspace `listProjects()` in production. */
  listProjects: () => Promise<readonly ProjectContextSource[]>;
  /** Resolve the one automation store owned by this project. Production
   *  injects the workspace automation coordinator's cached store so API
   *  mutations and scheduler reads share the same in-memory state. */
  automationStore?: (projectId: string, root: string) => AutomationStore;
  /** Workspace-wide parallel-cap semaphore (spec 2026-07-20, step 2.5). Boot
   *  passes the ONE instance it already gave the boot manager, so every
   *  project's RunManager counts against the same `resources.maxParallel`.
   *  When omitted, the map still shares one private instance across the
   *  managers it builds (workspace defaults, never refreshed). */
  semaphore?: WorkspaceSemaphore;
  /** The ONE `ProviderAuthService` for the process, owned by `createApp` — this package has no
   *  reference of its own (`grep -n 'providerAuth' project-context.ts` found nothing before
   *  `.ai/specs/2026-08-25-logged-out-account-fallback.md`, Phase 1). Threaded into every
   *  `RunManager` this class builds as `accountAuth`, so a non-boot project's dispatch pickers
   *  learn credentials the same way the boot project's do. Omitted (every existing test fixture)
   *  keeps `RunManager`'s own default: every account reads `'unknown'`, therefore eligible. */
  providerAuth?: ProviderAuthService;
  /** Overrides `process.env`. Every central-hub `CEZ_*` gate below (D4) reads through this, and
   *  it is threaded into `KnowledgeStore`'s own env-based root resolution and into
   *  `notificationsDataDir()`, so a test exercises a flag without mutating the real process env. */
  env?: NodeJS.ProcessEnv;
  /** Untrusted-input twin of `CEZ_REMOTE` for the `knowledgeStore.hosted` gate (Q4 of the
   *  knowledge spec: `capabilities().localHandoff === false`): the bind host the server was
   *  started with, exactly as `resolveCapabilities(env, bindHost)` uses it. Omitted (the CLI's
   *  normal loopback default) reads as loopback, matching `isLoopbackHost(undefined) === true`. */
  bindHost?: string;
  /** Test seam for the workspace-level notification runtime (D22a). Bypasses `CEZ_NOTIFY` gating
   *  and the real `NotificationOutbox.open()` I/O entirely when supplied. Production never sets
   *  this; the constructor builds the real thing from `env`. */
  notificationRuntime?: NotificationRuntime;
  /** Test seam for the workspace run index (W1.11). Production builds one from `listProjects`. */
  runIndex?: WorkspaceRunIndex;
  /**
   * The boot project's own root (spec `2026-08-15-duplicate-project-context-wipes-runs`), RAW
   * and unresolved exactly as `server.ts` received it (`deps.repoRoot`) — this class normalizes
   * it once, lazily, the same way the registry keys itself (`normalizeRoot`). The boot project
   * deliberately carries no row of its own in the registry (`suppressBootRegistration`, D3), so a
   * row CAN name this same root under a different id — pre-dating `registerProject`'s own boot
   * short-circuit, or written by a concurrent `cezar projects add` in another process. `build()`
   * below refuses to open a context for such a row rather than opening a second `RunStore` over
   * the identical `.ai/cezar` dir the boot context's store already owns; see its own comment.
   * Omitted by every fixture with no boot project of its own — the check is then simply skipped.
   */
  bootRoot?: string;
}

export type ProjectContextFailure = 'unknown-project' | 'missing-root' | 'boot-root-conflict';

/** Typed failure so the route layer can map reasons to statuses (404/409)
 *  without string matching. */
export class ProjectContextError extends Error {
  constructor(
    readonly reason: ProjectContextFailure,
    readonly projectId: string,
  ) {
    super(
      reason === 'unknown-project'
        ? `unknown project: ${projectId}`
        : reason === 'missing-root'
          ? `project root is missing: ${projectId}`
          : `project ${projectId} duplicates the boot project's root — refusing to open a second RunStore over it`,
    );
    this.name = 'ProjectContextError';
  }
}

/**
 * Lazy `Map<projectId, ProjectContext>`. Nothing is instantiated at
 * construction — the boot project is built eagerly by the caller via
 * `context(bootId)`; every other project on first API touch. Concurrent
 * `context()` calls for the same id share one build (the in-flight promise is
 * cached), so recovery never runs twice for a project.
 *
 * Also the home of the two central-hub WORKSPACE-level singletons (plan D22a: "this package's
 * dependencies include W1.7 and W2.5, because its own title requires it to register the
 * notification runtime"): `runIndex` (W1.11) and the notification runtime reachable through
 * `notifications()`. Neither belongs on a per-project `ProjectContext`; a note or a cross-project
 * board reads N projects' `runs.json` without instantiating any of them, and one notification
 * sender must exist per `CEZ_HOME`, not one per registered project.
 */
export class ProjectContexts {
  private readonly contexts = new Map<string, ProjectContext>();
  private readonly building = new Map<string, Promise<ProjectContext>>();
  /** Live store-created subscribers; invoked before RunManager recovery. */
  private readonly storeListeners = new Set<(store: RunStore) => void>();
  /** Live `onContextBuilt` subscribers (workspace SSE, step 2.8). */
  private readonly builtListeners = new Set<(ctx: ProjectContext) => void>();
  /** One semaphore for every manager this map builds — injected by boot,
   *  private-but-shared otherwise. */
  private readonly semaphore: WorkspaceSemaphore;
  private readonly env: NodeJS.ProcessEnv;
  /** Workspace level (D22a), never per project. Always buildable at zero cost: it is a read-only
   *  parser that touches no filesystem until `.list()`/`.digest()` is actually called (its own doc
   *  comment), so it exists whether or not `CEZ_NOTES`/`CEZ_WORKSPACE_VIEWS` are on; those flags
   *  gate the ROUTES that call it (W4.10/P2.x), not this index. */
  readonly runIndex: WorkspaceRunIndex;
  /** Workspace level (D22a). `undefined` when `CEZ_NOTIFY` is not exactly `'1'`, or when building
   *  it failed: a degraded cockpit rather than a boot failure (`AGENTS.md`: "a missing
   *  dependency, an absent peer, a read-only home: degrade... never fail the boot"). */
  private readonly notificationRuntime: NotificationRuntime | undefined;
  /** `deps.bootRoot`, realpath'd once and cached — the boot root does not change during the
   *  process lifetime, so every `build()` after the first reuses this instead of re-stat'ing it.
   *  `undefined` (never populated) when `deps.bootRoot` was omitted. */
  private bootRootReal: Promise<string> | undefined;
  /** Bound once from `deps.providerAuth`, so every `build()` hands its `RunManager` the same
   *  credentials read `index.ts`'s two boot paths do. `undefined` (`deps.providerAuth` omitted)
   *  keeps `RunManager`'s own `'unknown'` default. */
  private readonly accountAuth: ((provider: ProviderId, profileId: string | undefined) => AccountAuth) | undefined;

  constructor(private readonly deps: ProjectContextDeps) {
    this.semaphore = deps.semaphore ?? new WorkspaceSemaphore();
    this.env = deps.env ?? process.env;
    this.runIndex = deps.runIndex ?? new WorkspaceRunIndex({
      listProjects: async () => (await this.deps.listProjects()).map(toRunIndexSource),
    });
    this.notificationRuntime = deps.notificationRuntime
      ?? (this.env.CEZ_NOTIFY === '1' ? buildNotificationRuntime(this.env) : undefined);
    this.accountAuth = deps.providerAuth ? accountAuthFromService(deps.providerAuth) : undefined;
  }

  /** The workspace-level notification runtime (D22a), `undefined` under `CEZ_NOTIFY` unset,
   *  matching every other flag-off shape in this plan (D4/D19). Registering transports from
   *  `~/.cezar/notifications.json` and driving `POST /workspace/notifications/*` is a later
   *  package's job (W4.7); this method only makes the wired-but-empty runtime reachable. */
  notifications(): NotificationRuntime | undefined {
    return this.notificationRuntime;
  }

  /** The built context for `projectId`, building it on first access.
   *  Throws `ProjectContextError` for unknown ids and missing roots. */
  async context(projectId: string): Promise<ProjectContext> {
    const existing = this.contexts.get(projectId);
    if (existing) return existing;
    const inFlight = this.building.get(projectId);
    if (inFlight) return inFlight;
    const build = this.build(projectId);
    this.building.set(projectId, build);
    try {
      const ctx = await build;
      this.contexts.set(projectId, ctx);
      this.notifyBuilt(ctx);
      return ctx;
    } finally {
      this.building.delete(projectId);
    }
  }

  /**
   * Subscribe to future context builds (multi-project spec, step 2.8): the
   * workspace SSE stream attaches to every already-built context at connect
   * and uses this hook to pick up contexts built LATER — so subscribing never
   * force-instantiates a project, yet a project's first API touch makes its
   * events flow to already-open workspace streams. Returns an unsubscribe.
   */
  onContextBuilt(listener: (ctx: ProjectContext) => void): () => void {
    this.builtListeners.add(listener);
    return () => this.builtListeners.delete(listener);
  }

  /**
   * Subscribe at the earliest RunStore lifecycle point: immediately after a
   * lazy project's store opens and before its manager can recover runs. This
   * stays generic so backend-specific observers do not leak into the context
   * map. Returns an unsubscribe.
   */
  onStoreCreated(listener: (store: RunStore) => void): () => void {
    this.storeListeners.add(listener);
    return () => this.storeListeners.delete(listener);
  }

  /** A listener throwing must never fail the build (its store is usable). */
  private notifyStoreCreated(store: RunStore): void {
    for (const listener of [...this.storeListeners]) {
      try {
        listener(store);
      } catch {
        // subscriber's problem — context construction can continue
      }
    }
  }

  /** A listener throwing must never fail the build (its context is fine). */
  private notifyBuilt(ctx: ProjectContext): void {
    for (const listener of [...this.builtListeners]) {
      try {
        listener(ctx);
      } catch {
        // subscriber's problem — the build succeeded
      }
    }
  }

  /** Already-built context, without triggering a build. */
  peek(projectId: string): ProjectContext | undefined {
    return this.contexts.get(projectId);
  }

  /** Ids of every built context (dispose bookkeeping, shutdown flush). */
  ids(): string[] {
    return [...this.contexts.keys()];
  }

  /**
   * Tear down one project's context (project removal): the manager stops
   * making moves on its own (`RunManager.dispose()` — usage-sampler
   * unsubscribe, timers, queued state) and the store is closed — index
   * flushed to disk, every event-bus subscriber detached. Returns false when
   * nothing was built for `projectId`.
   */
  dispose(projectId: string): boolean {
    const ctx = this.contexts.get(projectId);
    if (!ctx) return false;
    this.contexts.delete(projectId);
    teardown(ctx);
    return true;
  }

  /** Tear down every built context (process shutdown), including the workspace-level notification
   *  runtime (D22a): it is shared across every project, so only a full-workspace teardown, never
   *  a single `dispose(projectId)`, releases its outbox lease and stops its send timer. */
  disposeAll(): void {
    for (const id of this.ids()) this.dispose(id);
    this.notificationRuntime?.sender.stop();
  }

  /** Lazily realpath's `deps.bootRoot` and caches the promise (see `bootRootReal`'s own comment).
   *  `undefined` when no boot root was injected — every existing test fixture, which never
   *  wires this dep, is unaffected by the `build()` check below. */
  private resolveBootRoot(): Promise<string> | undefined {
    if (this.deps.bootRoot === undefined) return undefined;
    if (!this.bootRootReal) this.bootRootReal = normalizeRoot(this.deps.bootRoot);
    return this.bootRootReal;
  }

  private async build(projectId: string): Promise<ProjectContext> {
    const projects = await this.deps.listProjects();
    const project = projects.find((p) => p.id === projectId);
    if (!project) throw new ProjectContextError('unknown-project', projectId);
    if (project.status === 'missing') throw new ProjectContextError('missing-root', projectId);

    // A registry row can duplicate the boot project's own root under a DIFFERENT id (spec
    // 2026-08-15-duplicate-project-context-wipes-runs) — `registerProject`'s own boot short-
    // circuit (`server.ts`'s `registerFolder`) refuses to WRITE such a row going forward, so
    // reaching this branch means one pre-dates that fix or was written by a concurrent `cezar
    // projects add` in another process. Refuse rather than silently sharing or duplicating:
    // sharing the live boot `ProjectContext` object under a second id would let a later
    // `dispose(projectId)` (e.g. "remove project") tear the running server's own boot context
    // down, and opening a SECOND `RunStore` over the identical `.ai/cezar` dir is the data-loss
    // bug itself — two independent in-memory copies of `runs.json` that do not observe each
    // other's writes, and whichever flushes last (its own 300ms debounce, or shutdown)
    // truncates the other's away.
    const bootRoot = await this.resolveBootRoot();
    if (bootRoot !== undefined && bootRoot === project.root) {
      throw new ProjectContextError('boot-root-conflict', projectId);
    }

    const dataDir = join(project.root, '.ai/cezar');
    // keepLive + recover() (#367), same as serveCommand: runs that were live
    // when this project's context last existed are re-queued or resumed.
    const store = RunStore.open(dataDir, { keepLive: true });
    const automationStore = this.deps.automationStore?.(project.id, project.root)
      ?? AutomationStore.open(dataDir);
    reconcileAutomationReceipts(automationStore, store);
    this.notifyStoreCreated(store);
    const manager = new RunManager(store, project.root, {
      semaphore: this.semaphore,
      ...(this.accountAuth ? { accountAuth: this.accountAuth } : {}),
    });

    const { knowledgeStore, sourceStore } = activateOptionalStores({
      env: this.env,
      projectId: project.id,
      root: project.root,
      dataDir,
      bindHost: this.deps.bindHost,
    });

    let sweepTimer: NodeJS.Timeout | undefined;
    try {
      const launchKey = ensureLaunchKey(dataDir);
      // Startup reconcile (spec 006) + count-based retention (#483) — the same
      // best-effort sweeps serveCommand runs for the boot project, gated on the
      // root actually being a git repo.
      const repo = await getRepoInfo(project.root);
      if (repo) {
        // Cross-project ownership check (spec 2026-08-22-cross-project-worktree-orphan-prune-
        // safety, Layer 1): candidates are every OTHER registered project PLUS the workspace boot
        // root (never a `listProjects()` row itself — `suppressBootRegistration` — so it must be
        // added explicitly; this is the call site that actually failed in the 232ad6d4 incident,
        // since `cezar` IS a registered project but its owning run's record lived only at the boot
        // root). `bootRoot` was already resolved above for the boot-root-duplication guard.
        const candidates = [
          ...projects,
          ...(bootRoot !== undefined ? [{ id: '__boot__', name: 'workspace boot', root: bootRoot }] : []),
        ].filter((p) => canonicalPath(p.root) !== canonicalPath(project.root));
        const delay = Number(this.env.CEZ_SWEEP_DELAY_MS ?? 5 * 60_000);
        sweepTimer = setTimeout(() => {
          // Snapshot ownership at FIRE time, not at build() time: build() runs before
          // manager.recover() has re-claimed this project's own runs, and the sweep fires up to
          // `delay` later — a snapshot taken here would otherwise be up to 5 minutes staler than
          // the reality it is judging, on top of the deferral itself.
          const foreignSources = loadForeignWorkspaceRunSources(project.root, candidates);
          const unreadableSource = foreignSources.find((s) => s.unreadable);
          void pruneOrphans(project.root, new Set(store.listRuns().map((r) => r.id)), {
            findForeignOwner: (path) => findForeignWorkspaceOwner(project.root, path, foreignSources),
            ownershipCheckUnavailable: unreadableSource
              ? { reason: `project "${unreadableSource.projectName}"'s runs.json could not be read` }
              : undefined,
            onOutcome: (outcome) => {
              mkdirSync(dataDir, { recursive: true });
              appendFileSync(join(dataDir, 'worktree-reaps.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), runId: outcome.id, repoRoot: project.root, ...outcome })}\n`);
            },
          }).then((orphans) => {
            if (orphans.removed.length > 0) console.log(`[cez] project "${project.id}": cleaned ${orphans.removed.length} orphaned worktree(s): ${orphans.removed.map((d) => `${d.id.slice(0, 8)} (${d.reason})`).join(', ')}`);
            if (orphans.kept.length > 0) console.log(`[cez] project "${project.id}": kept ${orphans.kept.length} unsafe-to-reclaim worktree(s): ${orphans.kept.map((d) => `${d.id.slice(0, 8)} (${d.reason})`).join(', ')}`);
            if (orphans.declined.length > 0) console.log(`[cez] project "${project.id}": declined to reclaim ${orphans.declined.length} worktree(s): ${orphans.declined.map((d) => `${d.id.slice(0, 8)} (${d.reason})`).join(', ')}`);
          }).catch(() => undefined);
        }, Math.max(0, delay));
        sweepTimer.unref?.();
        const keep = await resolveWorktreeRetention(project.root).catch(
          () => DEFAULT_WORKTREE_RETENTION,
        );
        await reclaimWorktrees(project.root, store, keep).catch(() => [] as string[]);
      }
      await manager.recover();
      return {
        id: project.id,
        root: project.root,
        dataDir,
        store,
        manager,
        automationStore,
        knowledgeStore,
        sourceStore,
        launchKey,
        ...(typeof sweepTimer !== 'undefined' ? { sweepTimer } : {}),
      };
    } catch (err) {
      // A failed build must not leak the half-built context's subscriptions.
      teardown({ store, manager, knowledgeStore });
      throw err;
    }
  }
}

/** Shared teardown for built and half-built contexts. `knowledgeStore` is absent when `CEZ_KB` was
 *  never on for this project; `dispose()`'s own optional chaining is the whole gate. `sourceStore`
 *  needs no teardown call: it holds no live resource beyond its own explicitly-acquired-and-released
 *  `SourceLease`, unlike `KnowledgeStore`'s fs.watch handles and debounce timers. */
function teardown(ctx: { store: RunStore; manager: RunManager; knowledgeStore?: KnowledgeStore; sweepTimer?: NodeJS.Timeout }): void {
  if (ctx.sweepTimer) clearTimeout(ctx.sweepTimer);
  ctx.manager.dispose();
  ctx.store.flush();
  ctx.store.removeAllListeners();
  ctx.knowledgeStore?.dispose();
}

function toRunIndexSource(source: ProjectContextSource): WorkspaceRunProjectSource {
  return { id: source.id, root: source.root, status: source.status, name: source.name ?? '' };
}

/**
 * Wires the runtime skeleton (D22a): outbox -> registry -> sender. The registry/sender circular
 * reference (the registry's `sink` IS the sender; the sender's `send` calls back into the
 * registry) is closed with a `let` capture, safe because neither side is ever invoked during this
 * function, only later, off a reserved outbox row or a `/test` call, by which point both are
 * assigned. Never throws: this runs inside `ProjectContexts`'s constructor, on the boot path, and
 * `AGENTS.md`'s "degrade, never fail the boot" applies. A broken `CEZ_HOME` disables notifications;
 * it does not stop cezar from starting.
 */
function buildNotificationRuntime(env: NodeJS.ProcessEnv): NotificationRuntime | undefined {
  try {
    const outbox = NotificationOutbox.open(notificationsDataDir(env));
    let registry!: NotificationRegistry;
    const sender = new NotificationSender({
      outbox,
      send: (transportId, notification, timeoutMs) => registry.send(transportId, notification, timeoutMs),
    });
    registry = new NotificationRegistry({ sink: sender });
    sender.start();
    return { outbox, registry, sender };
  } catch (err) {
    console.warn(`[cez] notification runtime failed to initialize, notifications are unavailable (${describeError(err)})`);
    return undefined;
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
