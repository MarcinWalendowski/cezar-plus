import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { collectSecretValues, redactDeep } from '../core/secret-redaction.ts';
import {
  sourceConnectionSchema,
  sourceConnectionsFileSchema,
  sourceLogRecordSchema,
  sourceStateFileSchema,
  sourceStateSchema,
  type SourceConnection,
  type SourceLogRecord,
  type SourceState,
} from './types.ts';

/**
 * `sources.json` + `source-state.json` + `source-log.ndjson` + `sources-poll.lock` (W1.5). Storage
 * idioms copied deliberately from `automations/store.ts` (spec "Research" → "The storage idioms
 * this feature must obey"): `.tmp` plus `rename` at 0600, corrupt input degrades to empty plus one
 * warning never a throw, per-entry salvage, delete-as-tombstone, an `O_EXCL` lease with a stale-mtime
 * reclaim. Not shared code, because sharing means widening `AutomationStore`'s protected shape for a
 * domain it was never built for (Q1) — copied in idiom, reimplemented in full.
 *
 * **No per-document rows anywhere in this file.** That is what structurally prevents the second
 * index the plan's cross-spec review found (D15/D17): per-document provenance lives only in that
 * document's own frontmatter, read through `SourceSink.readMeta`.
 */

const CONNECTIONS = 'sources.json';
const STATE = 'source-state.json';
const LOG = 'source-log.ndjson';
const POLL_LOCK = 'sources-poll.lock';
const RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

type ConnectionsFile = ReturnType<typeof sourceConnectionsFileSchema.parse>;
type StateFile = ReturnType<typeof sourceStateFileSchema.parse>;

export interface SourceStoreOptions {
  warn?: (message: string) => void;
  now?: () => Date;
}

export class SourceStore {
  private connectionsFile: ConnectionsFile = { version: 1, connections: [] };
  private stateFile: StateFile = { version: 1, states: {} };
  private connections = new Map<string, SourceConnection>();
  private warned = new Set<string>();
  private logSeq = 0;
  private readonly now: () => Date;
  private readonly secrets = collectSecretValues();

  static open(dataDir: string, options: SourceStoreOptions = {}): SourceStore {
    const store = new SourceStore(dataDir, options);
    store.load();
    return store;
  }

  private constructor(
    readonly dataDir: string,
    private readonly options: SourceStoreOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  // ---- connections (sources.json) --------------------------------------------------------

  list(): SourceConnection[] {
    return [...this.connections.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): SourceConnection | undefined {
    return this.connections.get(id);
  }

  create(
    input: Omit<SourceConnection, 'id' | 'revision' | 'createdAt' | 'updatedAt'>,
    id: string = randomUUID(),
  ): SourceConnection {
    if (this.connections.has(id) || this.isTombstoned(id)) throw new Error('source connection id unavailable');
    const now = this.now().toISOString();
    const connection = sourceConnectionSchema.parse({
      ...input,
      id,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    this.connections.set(id, connection);
    this.persistConnections();
    return connection;
  }

  update(
    id: string,
    expectedRevision: number,
    input: Omit<SourceConnection, 'id' | 'revision' | 'createdAt' | 'updatedAt'>,
  ): SourceConnection {
    const current = this.connections.get(id);
    if (!current) throw new Error('source connection not found');
    if (current.revision !== expectedRevision) throw new Error('source connection revision conflict');
    const connection = sourceConnectionSchema.parse({
      ...current,
      ...input,
      id,
      revision: current.revision + 1,
      createdAt: current.createdAt,
      updatedAt: this.now().toISOString(),
    });
    this.connections.set(id, connection);
    const state = this.state(id);
    if (state) this.setState(id, { ...state, revision: connection.revision });
    this.persistConnections();
    return connection;
  }

  /** Tombstone, never a hard delete (Q10) — mirrors `automations/store.ts`'s own `delete`. */
  delete(id: string): boolean {
    if (!this.connections.delete(id)) return false;
    this.connectionsFile.tombstones = {
      ...this.connectionsFile.tombstones,
      [id]: this.now().toISOString(),
    };
    this.persistConnections();
    return true;
  }

  // ---- per-connection runtime state (source-state.json) --------------------------------

  state(id: string): SourceState | undefined {
    return this.stateFile.states[id];
  }

  setState(id: string, state: SourceState): void {
    const parsed = sourceStateSchema.parse(state);
    this.stateFile.states = { ...this.stateFile.states, [id]: parsed };
    this.atomicJson(STATE, this.stateFile);
  }

  /**
   * Merge `patch` onto the current (or a fresh, all-default) state and persist it. This is the
   * enforcement mechanism for D8's "transitions are writes": `syncState` only ever changes because
   * something called this, never because a handler read the clock.
   */
  updateState(id: string, patch: Partial<SourceState>): SourceState {
    const current = this.state(id) ?? sourceStateSchema.parse({});
    const next = sourceStateSchema.parse({ ...current, ...patch });
    this.setState(id, next);
    return next;
  }

  isAdopted(connectionId: string, externalId: string): boolean {
    return this.state(connectionId)?.adoptedExternalIds.includes(externalId) ?? false;
  }

  /**
   * Records `externalId` in the durable adopted set (Q11) so the next sweep can never re-mirror an
   * adopted page as a brand new document. `SourceSink.adopt` is a different method entirely — it
   * moves the file; this marks the connection's state. A route handler calls both.
   */
  adopt(connectionId: string, externalId: string): void {
    const current = this.state(connectionId) ?? sourceStateSchema.parse({});
    if (current.adoptedExternalIds.includes(externalId)) return;
    this.updateState(connectionId, { adoptedExternalIds: [...current.adoptedExternalIds, externalId] });
  }

  isTombstonedExternal(connectionId: string, externalId: string): boolean {
    return this.state(connectionId)?.tombstonedExternalIds.includes(externalId) ?? false;
  }

  tombstoneExternal(connectionId: string, externalId: string): void {
    const current = this.state(connectionId) ?? sourceStateSchema.parse({});
    if (current.tombstonedExternalIds.includes(externalId)) return;
    this.updateState(connectionId, {
      tombstonedExternalIds: [...current.tombstonedExternalIds, externalId],
    });
  }

  // ---- source-log.ndjson ------------------------------------------------------------------

  appendLog(
    record: Omit<SourceLogRecord, 'seq' | 'ts'> & Partial<Pick<SourceLogRecord, 'ts'>>,
  ): SourceLogRecord {
    const parsed = sourceLogRecordSchema.parse({
      ...record,
      seq: ++this.logSeq,
      ts: record.ts ?? this.now().toISOString(),
    });
    this.appendNdjson(LOG, redactDeep(parsed, this.secrets));
    return parsed;
  }

  logs(
    options: {
      connectionId?: string;
      event?: string;
      since?: string;
      cursor?: number;
      limit?: number;
    } = {},
  ): SourceLogRecord[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
    return this.readNdjson(LOG, sourceLogRecordSchema)
      .filter((row) => !options.connectionId || row.connectionId === options.connectionId)
      .filter((row) => !options.event || row.event === options.event)
      .filter((row) => !options.since || row.ts >= options.since)
      .filter((row) => !options.cursor || row.seq < options.cursor)
      .slice(-limit)
      .reverse();
  }

  compact(): void {
    const logs = this.readNdjson(LOG, sourceLogRecordSchema);
    this.rewriteNdjson(LOG, logs.slice(-10_000));
  }

  maybeCompact(): void {
    if (this.readNdjson(LOG, sourceLogRecordSchema).length > 10_500) this.compact();
  }

  // ---- sources-poll.lock -------------------------------------------------------------------

  acquireLease(staleAfterMs = 10 * 60_000): SourceLease | undefined {
    mkdirSync(this.dataDir, { recursive: true });
    const path = join(this.dataDir, POLL_LOCK);
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: this.now().toISOString() }));
      return new SourceLease(path, fd);
    } catch {
      try {
        if (this.now().getTime() - statSync(path).mtimeMs > staleAfterMs) {
          unlinkSync(path);
          return this.acquireLease(staleAfterMs);
        }
      } catch {
        // A contender removed the lock or the directory is read-only.
      }
      return undefined;
    }
  }

  // ---- internals ----------------------------------------------------------------------------

  private load(): void {
    mkdirSync(this.dataDir, { recursive: true });
    this.loadConnections();
    this.stateFile = this.readJson(STATE, sourceStateFileSchema, { version: 1, states: {} });
    const logs = this.readNdjson(LOG, sourceLogRecordSchema);
    this.logSeq = logs.at(-1)?.seq ?? 0;
  }

  private loadConnections(): void {
    this.connectionsFile = this.readJson(CONNECTIONS, sourceConnectionsFileSchema, {
      version: 1,
      connections: [],
    });
    for (const raw of this.connectionsFile.connections) {
      const parsed = sourceConnectionSchema.safeParse(raw);
      if (parsed.success) this.connections.set(parsed.data.id, parsed.data);
      else this.warnOnce('connections', 'Ignored an invalid source connection definition.');
    }
  }

  private persistConnections(): void {
    this.pruneTombstones();
    this.connectionsFile.connections = [...this.connections.values()];
    this.atomicJson(CONNECTIONS, this.connectionsFile);
  }

  private isTombstoned(id: string): boolean {
    const deletedAt = this.connectionsFile.tombstones?.[id];
    return Boolean(deletedAt && Date.parse(deletedAt) >= this.now().getTime() - RETENTION_MS);
  }

  private pruneTombstones(): void {
    const cutoff = this.now().getTime() - RETENTION_MS;
    this.connectionsFile.tombstones = Object.fromEntries(
      Object.entries(this.connectionsFile.tombstones ?? {}).filter(
        ([, timestamp]) => Date.parse(timestamp) >= cutoff,
      ),
    );
  }

  private readJson<T>(
    filename: string,
    schema: { safeParse(value: unknown): { success: boolean; data?: T } },
    fallback: T,
  ): T {
    const path = join(this.dataDir, filename);
    if (!existsSync(path)) return fallback;
    try {
      const parsed = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (parsed.success) return parsed.data as T;
    } catch {
      // Warn once below.
    }
    this.warnOnce(filename, `Ignored corrupt source state in ${filename}.`);
    return fallback;
  }

  private readNdjson<T>(
    filename: string,
    schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  ): T[] {
    const path = join(this.dataDir, filename);
    if (!existsSync(path)) return [];
    const rows: T[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const parsed = schema.safeParse(JSON.parse(line));
        if (parsed.success) rows.push(parsed.data as T);
        else this.warnOnce(filename, `Skipped a malformed row in ${filename}.`);
      } catch {
        this.warnOnce(filename, `Skipped a malformed row in ${filename}.`);
      }
    }
    return rows;
  }

  private atomicJson(filename: string, value: unknown): void {
    mkdirSync(this.dataDir, { recursive: true });
    const path = join(this.dataDir, filename);
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  }

  private appendNdjson(filename: string, value: unknown): void {
    mkdirSync(this.dataDir, { recursive: true });
    const path = join(this.dataDir, filename);
    const fd = openSync(path, 'a', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(value)}\n`);
    } finally {
      closeSync(fd);
    }
  }

  private rewriteNdjson(filename: string, rows: unknown[]): void {
    const path = join(this.dataDir, filename);
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), {
      mode: 0o600,
    });
    renameSync(temporary, path);
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.options.warn?.(message);
  }
}

export class SourceLease {
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
