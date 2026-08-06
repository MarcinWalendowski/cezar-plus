import { join } from 'node:path';
import { DueScheduler, type DueEntry } from '../scheduling/due-scheduler.ts';
import { resolveSourceProvider } from './registry.ts';
import { FileSourceSink } from './sink.ts';
import type { SourceCoordinator } from './coordinator.ts';
import type { SourceProvider, SourceProviderDeps } from './provider-types.ts';
import { runSourceSync } from './sync.ts';
import type { SourceStore } from './store.ts';
import type { SourceConnection, SourceSink } from './types.ts';

/**
 * One workspace-wide timer over `pollChanges` connections (F2, W4.4). See
 * `.ai/specs/2026-08-06-external-source-connectors-notion.md` phase "3.3" and
 * `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D1..D25.
 *
 * Mirrors `automations/scheduler.ts`'s `WorkspaceAutomationScheduler` in shape, built over the
 * source-agnostic `DueScheduler` (`scheduling/due-scheduler.ts`, W1.6) rather than a
 * sources-specific copy of the earliest-due-timer mechanism.
 *
 * **`nextDueAt` and the `ok` -> `stale` transition are written HERE, never by `sync.ts`** (spec
 * Data Models: "nextDueAt: WRITTEN by the scheduler, never derived (D8)"; "the scheduler... is the
 * only thing that may flip ok to stale... and it does so by persisting the field"). `sync.ts`
 * reports what happened on ONE attempt; this file decides when the NEXT one is due.
 *
 * **Flag gating is not this file's job.** `CEZ_SOURCES` is read nowhere here, per D4/D19 "no
 * background timer" when the flag is unset is enforced by whoever CONSTRUCTS a
 * `WorkspaceSourceScheduler` (the boot flow in `server.ts`/`project-context.ts`, W1.1/W3.1's
 * ownership), by simply not constructing one. Nothing wires this scheduler into the boot flow yet,
 * see this package's implementation report.
 */

export interface ProjectSourceHandle {
  projectId: string;
  /** `<root>/.ai/cezar`, the same root `SourceStore.open` and `FileSourceSink` are constructed
   *  against. */
  dataDir: string;
  /** Builds the sink for one connection. Defaults to a standalone `FileSourceSink` when omitted;
   *  with `CEZ_KB=1` the caller supplies F1's own sink so adoption re-indexes on the move (spec
   *  "The sink port"). */
  sink?: (connectionId: string) => SourceSink;
  providerDeps?: SourceProviderDeps;
  callBudget?: number;
  onChange?: (connectionId: string, revision: number) => void;
}

export interface WorkspaceSourceSchedulerOptions {
  coordinator: SourceCoordinator;
  handle: (projectId: string, store: SourceStore) => ProjectSourceHandle | undefined;
  now?: () => number;
  /** Injectable for tests, defaults to the real `./registry.ts` dispatch table. */
  resolveProvider?: (connection: SourceConnection, deps?: SourceProviderDeps) => SourceProvider | null;
}

interface DueConnectionSync {
  handle: ProjectSourceHandle;
  store: SourceStore;
  connectionId: string;
}

/** The scheduler flips `ok` to `stale` once a connection's last COMPLETE sweep is more than three
 *  intervals old, long enough that a slow-but-healthy cold backfill (spec "Research": 15-25
 *  minutes for the measured corpus) never reads as stale mid-walk. */
const STALE_INTERVAL_MULTIPLIER = 3;

export class WorkspaceSourceScheduler {
  private readonly due: DueScheduler<DueConnectionSync>;
  private readonly resolveProvider: (connection: SourceConnection, deps?: SourceProviderDeps) => SourceProvider | null;
  private stopped = true;
  private scheduleGeneration = 0;

  constructor(private readonly options: WorkspaceSourceSchedulerOptions) {
    this.resolveProvider = options.resolveProvider ?? resolveSourceProvider;
    this.due = new DueScheduler({
      collectDue: () => this.collectDue(),
      run: (next) => this.runOne(next),
      now: this.options.now,
    });
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.due.start();
    await this.reschedule();
  }

  async reschedule(): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.scheduleGeneration;
    this.due.cancel();
    await this.options.coordinator.refresh();
    if (this.stopped || generation !== this.scheduleGeneration) return;
    this.due.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.scheduleGeneration += 1;
    this.due.stop();
  }

  hasTimer(): boolean {
    return this.due.hasTimer();
  }

  private collectDue(): Array<DueEntry<DueConnectionSync>> {
    const nowMs = this.options.now?.() ?? Date.now();
    const due: Array<DueEntry<DueConnectionSync>> = [];
    for (const projectId of this.options.coordinator.enabledProjectIds()) {
      const store = this.options.coordinator.store(projectId);
      if (!store) continue;
      const handle = this.options.handle(projectId, store);
      if (!handle) continue;
      for (const connection of store.list().filter((item) => item.enabled && item.mode !== 'archived')) {
        this.markStaleIfDue(store, connection, nowMs);
        const state = store.state(connection.id);
        const at = state?.nextDueAt ? Date.parse(state.nextDueAt) : nowMs;
        due.push({ at, value: { handle, store, connectionId: connection.id } });
      }
    }
    return due;
  }

  /** The ONLY writer of the `ok` -> `stale` transition (spec Data Models), a stored write made on
   *  every reschedule, never a derivation a handler computes at read time (D8). */
  private markStaleIfDue(store: SourceStore, connection: SourceConnection, nowMs: number): void {
    const state = store.state(connection.id);
    if (!state || state.syncState !== 'ok' || !state.lastCompleteSweepAt) return;
    const staleAfterMs = connection.intervalSeconds * STALE_INTERVAL_MULTIPLIER * 1000;
    if (nowMs - Date.parse(state.lastCompleteSweepAt) > staleAfterMs) {
      store.updateState(connection.id, {
        syncState: 'stale',
        syncStateAt: new Date(nowMs).toISOString(),
      });
    }
  }

  private async runOne(next: DueConnectionSync): Promise<void> {
    const { handle, store, connectionId } = next;
    const connection = store.get(connectionId);
    if (!connection) return;
    try {
      const provider = this.resolveProvider(connection, handle.providerDeps);
      if (!provider) {
        const at = this.nowIso();
        store.updateState(connectionId, {
          syncState: 'error',
          syncStateAt: at,
          lastAttemptAt: at,
          lastError: {
            at,
            message: `no source provider registered for kind "${connection.kind}"`,
          },
        });
        return;
      }
      const sink = handle.sink ? handle.sink(connectionId) : new FileSourceSink(handle.dataDir, connectionId);
      await runSourceSync({
        connection,
        store,
        sink,
        provider,
        mirrorRoot: join(handle.dataDir, 'sources'),
        callBudget: handle.callBudget,
        now: this.options.now ? () => new Date(this.options.now!()) : undefined,
      });
      handle.onChange?.(connectionId, connection.revision);
    } finally {
      this.writeNextDueAt(store, connectionId, connection);
    }
  }

  /**
   * Spec Data Models: "nextDueAt: WRITTEN by the scheduler, never derived at read time." A
   * `backoffUntil` `sync.ts` set for this tick pushes the next attempt out further than the plain
   * interval, this is what makes a backed-off connection genuinely skipped rather than re-tried
   * (and no-op'd by `sync.ts`'s own step-2 skip) on every reschedule.
   */
  private writeNextDueAt(store: SourceStore, connectionId: string, connection: SourceConnection): void {
    const nowMs = this.options.now?.() ?? Date.now();
    const state = store.state(connectionId);
    const backoffAtMs = state?.backoffUntil ? Date.parse(state.backoffUntil) : 0;
    const intervalAtMs = nowMs + connection.intervalSeconds * 1000;
    const nextDueAt = new Date(Math.max(intervalAtMs, backoffAtMs)).toISOString();
    store.updateState(connectionId, { nextDueAt });
  }

  private nowIso(): string {
    return new Date(this.options.now?.() ?? Date.now()).toISOString();
  }
}
