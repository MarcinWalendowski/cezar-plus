import { randomUUID } from 'node:crypto';
import { FileSourceSink } from './sink.ts';
import { SourceCoordinator, type SourceProjectSource } from './coordinator.ts';
import { WorkspaceSourceScheduler } from './scheduler.ts';
import type { SourceProvider, SourceProviderDeps } from './provider-types.ts';
import { resolveSourceProvider } from './registry.ts';
import type { SourceStore } from './store.ts';
import type { SourceConnection, SourceSink } from './types.ts';

export interface SourceRuntimeOptions {
  listProjects: () => Promise<readonly SourceProjectSource[]>;
  bootProjectId: string;
  bootRoot: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  callBudget?: number;
  getKnowledgeStore?: (projectId: string) => { createSourceSink(base: SourceSink): SourceSink } | undefined;
  emit?: (event: 'source-sync', data: unknown) => void;
  resolveProvider?: (connection: Pick<SourceConnection, 'kind'> & Partial<Omit<SourceConnection, 'kind'>>, deps?: SourceProviderDeps) => SourceProvider | null;
}

interface ProjectQueue {
  tail: Promise<unknown>;
}

interface JoinedRun {
  syncId: string;
  promise: Promise<unknown>;
}

const LEASE_RETRY_DELAYS_MS = [50, 100, 200];

/** Owns the one source coordinator, scheduler, project queue and manual/due join map. */
export class SourceRuntime {
  readonly bootProjectId: string;
  readonly coordinator: SourceCoordinator;
  readonly scheduler: WorkspaceSourceScheduler;
  private knowledgeStoreResolver: SourceRuntimeOptions['getKnowledgeStore'];
  private readonly queues = new Map<string, ProjectQueue>();
  private readonly joins = new Map<string, JoinedRun>();
  private stopped = true;

  constructor(private readonly options: SourceRuntimeOptions) {
    this.bootProjectId = options.bootProjectId;
    this.knowledgeStoreResolver = options.getKnowledgeStore;
    this.coordinator = new SourceCoordinator({
      listProjects: options.listProjects,
      bootProject: { id: options.bootProjectId, root: options.bootRoot, status: 'ok' },
    });
    this.coordinator.store(options.bootProjectId, options.bootRoot);
    this.scheduler = new WorkspaceSourceScheduler({
      coordinator: this.coordinator,
      now: options.now,
      resolveProvider: options.resolveProvider,
      enqueue: (projectId, connectionId, operation) => this.enqueue(projectId, connectionId, operation),
      handle: (projectId, store) => {
        return {
          projectId,
          dataDir: store.dataDir,
          callBudget: options.callBudget,
          providerDeps: { env: options.env, ...(options.now ? { now: options.now } : {}) },
          sink: (connectionId) => this.sink(projectId, store.dataDir, connectionId),
          onChange: (connectionId, revision, result) => {
            options.emit?.('source-sync', {
              project: projectId,
              connectionId,
              revision,
              ...(result ? { syncState: result.syncState, ran: result.ran } : {}),
            });
          },
        };
      },
    });
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.scheduler.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.scheduler.stop();
    this.joins.clear();
  }

  async reschedule(): Promise<void> {
    if (this.stopped) return;
    await this.scheduler.reschedule();
  }

  async refresh(): Promise<void> {
    await this.coordinator.refresh();
  }

  store(projectId: string, root?: string): SourceStore | undefined {
    return this.coordinator.store(projectId, root);
  }

  provider(connection: Pick<SourceConnection, 'kind'> & Partial<Omit<SourceConnection, 'kind'>>): SourceProvider | null {
    return (this.options.resolveProvider ?? resolveSourceProvider)(connection, {
      env: this.options.env,
      ...(this.options.now ? { now: this.options.now } : {}),
    });
  }

  sink(projectId: string, dataDir: string, connectionId: string): SourceSink {
    const base = new FileSourceSink(dataDir, connectionId);
    return this.knowledgeStoreResolver?.(projectId)?.createSourceSink(base) ?? base;
  }

  setKnowledgeStoreResolver(
    resolver: (projectId: string) => { createSourceSink(base: SourceSink): SourceSink } | undefined,
  ): void {
    this.knowledgeStoreResolver = resolver;
  }

  /** Returns the stable id for an already queued connection, or creates a new queued run. */
  kick(projectId: string, connectionId: string): { syncId: string; promise: Promise<unknown> } {
    const key = `${projectId}\u0000${connectionId}`;
    const existing = this.joins.get(key);
    if (existing) return existing;
    const promise = this.enqueue(projectId, connectionId, () => this.scheduler.runConnection(projectId, connectionId));
    return this.joins.get(key) ?? { syncId: randomUUID(), promise };
  }

  private async enqueue(
    projectId: string,
    connectionId: string,
    operation: () => Promise<import('./sync.ts').SourceSyncResult | undefined>,
  ): Promise<import('./sync.ts').SourceSyncResult | undefined> {
    const joinKey = `${projectId}\u0000${connectionId}`;
    const joined = this.joins.get(joinKey);
    if (joined) return joined.promise as Promise<import('./sync.ts').SourceSyncResult | undefined>;
    const key = projectId;
    const queue = this.queues.get(key) ?? { tail: Promise.resolve() };
    const run = queue.tail.catch(() => undefined).then(async () => {
      for (let attempt = 0; ; attempt += 1) {
        const result = await operation();
        if (result?.reason !== 'lease-held' || attempt >= LEASE_RETRY_DELAYS_MS.length) return result;
        await delay(LEASE_RETRY_DELAYS_MS[attempt]!);
      }
    });
    queue.tail = run;
    this.queues.set(key, queue);
    this.joins.set(joinKey, { syncId: randomUUID(), promise: run });
    void run.then(() => {
      if (this.queues.get(key)?.tail === run) this.queues.delete(key);
      if (this.joins.get(joinKey)?.promise === run) this.joins.delete(joinKey);
    }, () => {
      if (this.queues.get(key)?.tail === run) this.queues.delete(key);
      if (this.joins.get(joinKey)?.promise === run) this.joins.delete(joinKey);
    });
    return run;
  }

}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
