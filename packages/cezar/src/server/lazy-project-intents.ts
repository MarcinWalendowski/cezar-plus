import { watchFile, unwatchFile } from 'node:fs';
import { join } from 'node:path';
import { normalizeRoot } from '../workspace/projects.ts';
import { readTodoAutostartSnapshot } from '../todo-autostart.ts';
import { readReopenIntentSnapshot } from '../reopen-watch.ts';

export interface LazyProjectIntentContexts {
  ids(): string[];
  peek(projectId: string): unknown;
  context(projectId: string): Promise<unknown>;
  onContextBuilt(listener: (context: { id: string }) => void): () => void;
}

export interface LazyProjectIntentProject {
  id: string;
  root: string;
}

export interface LazyProjectIntentDiscoveryDeps {
  contexts: LazyProjectIntentContexts;
  /** Already filtered to the projects this server capability mode may expose. */
  loadProjects: () => Promise<readonly LazyProjectIntentProject[]>;
  workspaceConfigPath: string;
  bootRoot: string;
  intervalMs?: number;
}

export interface LazyProjectIntentDiscovery {
  refresh(): Promise<void>;
  stop(): void;
}

interface ProjectRow {
  id: string;
  root: string;
  normalizedRoot: string;
  generation: number;
}

interface Observation {
  row: ProjectRow;
  stopTodo: () => void;
  stopReopen: () => void;
}

interface InspectionState {
  queued: boolean;
  running: boolean;
}

interface RetryState {
  attempt: number;
  timer?: NodeJS.Timeout;
}

const DEFAULT_INTERVAL_MS = 5_000;
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 30_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dataDir(root: string): string {
  return join(root, '.ai/cezar');
}

function intentPath(root: string, name: 'todos.json' | 'reopen-requests.json'): string {
  return join(dataDir(root), name);
}

/**
 * Passive discovery for projects that have not yet received a ProjectContext. The service only
 * polls paths and reads intent files. It never subscribes to a live domain watcher, because those
 * subscriptions create `.ai/cezar` as a side effect.
 */
export function createLazyProjectIntentDiscovery(
  deps: LazyProjectIntentDiscoveryDeps,
): LazyProjectIntentDiscovery {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const observations = new Map<string, Observation>();
  const inspections = new Map<string, InspectionState>();
  const retries = new Map<string, RetryState>();
  let generation = 0;
  let stopped = false;
  let configListener: (() => void) | undefined;
  let builtListener: (() => void) | undefined;
  let refreshTail: Promise<void> = Promise.resolve();

  const bootRoot = normalizeRoot(deps.bootRoot);

  const currentObservation = (row: ProjectRow): Observation | undefined => {
    const observation = observations.get(row.id);
    if (!observation) return undefined;
    const active = observation.row;
    return active.normalizedRoot === row.normalizedRoot && active.generation === row.generation
      ? observation
      : undefined;
  };

  const isCurrent = (row: ProjectRow): boolean =>
    !stopped && currentObservation(row) !== undefined && deps.contexts.peek(row.id) === undefined;

  const cancelRetry = (projectId: string): void => {
    const retry = retries.get(projectId);
    if (!retry) return;
    if (retry.timer) clearTimeout(retry.timer);
    retries.delete(projectId);
  };

  const stopObservation = (projectId: string): void => {
    const observation = observations.get(projectId);
    if (!observation) return;
    observation.stopTodo();
    observation.stopReopen();
    observations.delete(projectId);
    cancelRetry(projectId);
  };

  const queueInspection = (projectId: string): void => {
    if (stopped) return;
    const state = inspections.get(projectId) ?? { queued: false, running: false };
    state.queued = true;
    inspections.set(projectId, state);
    if (state.running) return;
    state.running = true;
    void (async () => {
      try {
        while (!stopped && state.queued) {
          state.queued = false;
          const row = observations.get(projectId)?.row;
          if (row) await inspect(row);
        }
      } catch (error) {
        console.warn(`[cez] lazy project intent inspection failed for ${projectId}: ${errorMessage(error)}`);
      } finally {
        state.running = false;
        if (!state.queued) inspections.delete(projectId);
      }
    })();
  };

  const scheduleRetry = (row: ProjectRow): void => {
    if (!isCurrent(row)) return;
    const retry = retries.get(row.id) ?? { attempt: 0 };
    if (retry.timer) return;
    const exponential = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(retry.attempt, 8));
    const jitter = 0.75 + Math.random() * 0.5;
    const delay = Math.max(1, Math.round(exponential * jitter));
    retry.attempt += 1;
    retry.timer = setTimeout(() => {
      retry.timer = undefined;
      queueInspection(row.id);
    }, delay);
    retry.timer.unref?.();
    retries.set(row.id, retry);
  };

  const watchPath = (path: string, onChange: () => void): (() => void) => {
    try {
      watchFile(path, { persistent: false, interval: intervalMs }, onChange);
      return () => unwatchFile(path, onChange);
    } catch (error) {
      console.warn(`[cez] lazy project intent watch unavailable for ${path}: ${errorMessage(error)}`);
      return () => undefined;
    }
  };

  const observe = (row: ProjectRow): void => {
    const onTodoChange = () => queueInspection(row.id);
    const onReopenChange = () => queueInspection(row.id);
    observations.set(row.id, {
      row,
      stopTodo: watchPath(intentPath(row.root, 'todos.json'), onTodoChange),
      stopReopen: watchPath(intentPath(row.root, 'reopen-requests.json'), onReopenChange),
    });
  };

  const loadRows = async (nextGeneration: number): Promise<ProjectRow[]> => {
    const [boot, projects] = await Promise.all([bootRoot, deps.loadProjects()]);
    const normalized = await Promise.all(
      projects.map(async (project) => ({
        id: project.id,
        root: await normalizeRoot(project.root),
      })),
    );
    return normalized
      .filter((project) => project.root !== boot)
      .map((project) => ({ ...project, normalizedRoot: project.root, generation: nextGeneration }));
  };

  const syncObservations = (rows: readonly ProjectRow[]): void => {
    const nextIds = new Set(rows.map((row) => row.id));
    for (const projectId of observations.keys()) {
      if (!nextIds.has(projectId)) stopObservation(projectId);
    }
    for (const row of rows) {
      const existing = observations.get(row.id);
      if (existing && existing.row.normalizedRoot === row.normalizedRoot) {
        existing.row = row;
      } else {
        if (existing) stopObservation(row.id);
        observe(row);
      }
      queueInspection(row.id);
    }
  };

  const refreshNow = async (): Promise<void> => {
    if (stopped) return;
    const nextGeneration = generation + 1;
    let rows: ProjectRow[];
    try {
      rows = await loadRows(nextGeneration);
    } catch (error) {
      console.warn(`[cez] lazy project intent registry refresh failed: ${errorMessage(error)}`);
      return;
    }
    generation = nextGeneration;
    syncObservations(rows);
  };

  const refresh = (): Promise<void> => {
    refreshTail = refreshTail.then(refreshNow).catch((error) => {
      console.warn(`[cez] lazy project intent refresh failed: ${errorMessage(error)}`);
    });
    return refreshTail;
  };

  const validateFreshIdentity = async (row: ProjectRow): Promise<boolean> => {
    if (!isCurrent(row)) return false;
    let rows: ProjectRow[];
    try {
      rows = await loadRows(row.generation);
    } catch (error) {
      console.warn(`[cez] lazy project intent registry reload failed for ${row.id}: ${errorMessage(error)}`);
      scheduleRetry(row);
      return false;
    }
    const fresh = rows.find((candidate) => candidate.id === row.id);
    if (!fresh || fresh.normalizedRoot !== row.normalizedRoot) {
      await refresh();
      return false;
    }
    return isCurrent(row);
  };

  async function inspect(row: ProjectRow): Promise<void> {
    if (!isCurrent(row)) return;
    const [todoResult, reopenResult] = await Promise.all([
      readTodoAutostartSnapshot(dataDir(row.root)).catch((error) => ({
        items: [],
        pending: false,
        error: error instanceof Error ? error : new Error(String(error)),
      })),
      readReopenIntentSnapshot(dataDir(row.root)).catch((error) => ({
        requests: [],
        pending: false,
        error: error instanceof Error ? error : new Error(String(error)),
      })),
    ]);
    if (!isCurrent(row)) return;

    const failures = [
      todoResult.error ? { source: 'todos', error: todoResult.error } : undefined,
      reopenResult.error ? { source: 'reopen', error: reopenResult.error } : undefined,
    ].filter((failure): failure is { source: string; error: Error } => failure !== undefined);
    for (const failure of failures) {
      console.warn(
        `[cez] lazy project intent read failed ${JSON.stringify({
          projectId: row.id,
          source: failure.source,
          error: failure.error.message,
        })}`,
      );
    }

    const pendingSources = {
      autostart: todoResult.pending,
      reopen: reopenResult.pending,
    };
    if (!pendingSources.autostart && !pendingSources.reopen) {
      if (failures.length > 0) scheduleRetry(row);
      else cancelRetry(row.id);
      return;
    }
    cancelRetry(row.id);
    if (!(await validateFreshIdentity(row))) return;
    if (deps.contexts.peek(row.id) !== undefined) {
      stopObservation(row.id);
      return;
    }

    console.log(`[cez] lazy project intent pending ${JSON.stringify({ projectId: row.id, ...pendingSources })}`);
    try {
      await deps.contexts.context(row.id);
      cancelRetry(row.id);
      stopObservation(row.id);
    } catch (error) {
      console.warn(
        `[cez] lazy project context build failed ${JSON.stringify({
          projectId: row.id,
          ...pendingSources,
          error: errorMessage(error),
        })}`,
      );
      scheduleRetry(row);
    }
  }

  try {
    const onConfigChange = () => void refresh();
    watchFile(deps.workspaceConfigPath, { persistent: false, interval: intervalMs }, onConfigChange);
    configListener = () => unwatchFile(deps.workspaceConfigPath, onConfigChange);
  } catch (error) {
    console.warn(`[cez] lazy project intent registry watch unavailable: ${errorMessage(error)}`);
  }

  builtListener = deps.contexts.onContextBuilt((context) => {
    if (observations.has(context.id)) stopObservation(context.id);
  });

  return {
    refresh,
    stop: () => {
      if (stopped) return;
      stopped = true;
      configListener?.();
      configListener = undefined;
      builtListener?.();
      builtListener = undefined;
      for (const projectId of [...observations.keys()]) stopObservation(projectId);
      for (const projectId of [...retries.keys()]) cancelRetry(projectId);
      inspections.clear();
    },
  };
}
