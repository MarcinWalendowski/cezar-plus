import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
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
  sourceCommentRecordSchema,
  sourceLogRecordSchema,
  sourceStateFileSchema,
  sourceStateSchema,
  type SourceCommentRecord,
  type SourceConnection,
  type SourceLogRecord,
  type SourceState,
} from './types.ts';
import type { SourceCommentEntry } from './provider-types.ts';

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
const COMMENTS = 'source-comments.ndjson';
const POLL_LOCK = 'sources-poll.lock';
const STORE_LOCK = 'sources-store.lock';
const RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const STORE_LOCK_TIMEOUT_MS = 30_000;

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
  private commentSeq = 0;
  private storeLockDepth = 0;
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

  /** Reload all durable source state after another process released the project lease. */
  reload(): void {
    this.load();
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
    return this.withStoreLock(() => {
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
    });
  }

  update(
    id: string,
    expectedRevision: number,
    input: Omit<SourceConnection, 'id' | 'revision' | 'createdAt' | 'updatedAt'>,
  ): SourceConnection {
    return this.withStoreLock(() => {
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
      if (state) this.setStateInternal(id, { ...state, revision: connection.revision });
      this.persistConnections();
      return connection;
    });
  }

  /** Tombstone, never a hard delete (Q10) — mirrors `automations/store.ts`'s own `delete`. */
  delete(id: string): boolean {
    return this.withStoreLock(() => {
      if (!this.connections.delete(id)) return false;
      this.connectionsFile.tombstones = {
        ...this.connectionsFile.tombstones,
        [id]: this.now().toISOString(),
      };
      this.persistConnections();
      return true;
    });
  }

  // ---- per-connection runtime state (source-state.json) --------------------------------

  state(id: string): SourceState | undefined {
    return this.stateFile.states[id];
  }

  setState(id: string, state: SourceState): void {
    this.withStoreLock(() => this.setStateInternal(id, state));
  }

  /**
   * Merge `patch` onto the current (or a fresh, all-default) state and persist it. This is the
   * enforcement mechanism for D8's "transitions are writes": `syncState` only ever changes because
   * something called this, never because a handler read the clock.
   */
  updateState(id: string, patch: Partial<SourceState>): SourceState {
    return this.withStoreLock(() => {
      const current = this.state(id) ?? sourceStateSchema.parse({});
      const next = sourceStateSchema.parse({ ...current, ...patch });
      this.setStateInternal(id, next);
      return next;
    });
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
    this.withStoreLock(() => {
      const current = this.state(connectionId) ?? sourceStateSchema.parse({});
      if (current.adoptedExternalIds.includes(externalId)) return;
      this.setStateInternal(connectionId, { ...current, adoptedExternalIds: [...current.adoptedExternalIds, externalId] });
    });
  }

  isTombstonedExternal(connectionId: string, externalId: string): boolean {
    return this.state(connectionId)?.tombstonedExternalIds.includes(externalId) ?? false;
  }

  tombstoneExternal(connectionId: string, externalId: string): void {
    this.withStoreLock(() => {
      const current = this.state(connectionId) ?? sourceStateSchema.parse({});
      if (current.tombstonedExternalIds.includes(externalId)) return;
      this.setStateInternal(connectionId, {
        ...current,
        tombstonedExternalIds: [...current.tombstonedExternalIds, externalId],
      });
    });
  }

  // ---- source-log.ndjson ------------------------------------------------------------------

  appendLog(
    record: Omit<SourceLogRecord, 'seq' | 'ts'> & Partial<Pick<SourceLogRecord, 'ts'>>,
  ): SourceLogRecord {
    return this.withStoreLock(() => {
      const parsed = sourceLogRecordSchema.parse({
        ...record,
        seq: ++this.logSeq,
        ts: record.ts ?? this.now().toISOString(),
      });
      this.appendNdjson(LOG, redactDeep(parsed, this.secrets));
      return parsed;
    });
  }

  /** Append new provider comments once per connection/comment id. */
  appendComments(connectionId: string, docId: string, entries: readonly SourceCommentEntry[]): SourceCommentRecord[] {
    return this.withStoreLock(() => {
      const existing = this.readNdjson(COMMENTS, sourceCommentRecordSchema);
      const seen = new Set(existing.filter((row) => row.connectionId === connectionId).map((row) => row.id));
      const added: SourceCommentRecord[] = [];
      for (const entry of entries) {
        if (seen.has(entry.externalId)) continue;
        const record = sourceCommentRecordSchema.parse({
          seq: ++this.commentSeq,
          connectionId,
          id: entry.externalId,
          docId,
          externalId: entry.externalId,
          ...(entry.author !== undefined ? { author: entry.author } : {}),
          body: entry.body,
          createdAt: entry.createdAt,
          attachments: entry.attachments,
        });
        this.appendNdjson(COMMENTS, redactDeep(record, this.secrets));
        seen.add(entry.externalId);
        added.push(record);
      }
      return added;
    });
  }

  listComments(connectionId: string): SourceCommentRecord[] {
    return this.readNdjson(COMMENTS, sourceCommentRecordSchema)
      .filter((row) => row.connectionId === connectionId)
      .sort((a, b) => a.seq - b.seq);
  }

  compactComments(): void {
    this.withStoreLock(() => {
      const retained = new Map<string, SourceCommentRecord>();
      for (const row of this.readNdjson(COMMENTS, sourceCommentRecordSchema)) {
        const key = `${row.connectionId}\u0000${row.id}`;
        if (!retained.has(key)) retained.set(key, row);
      }
      this.rewriteNdjson(COMMENTS, [...retained.values()].sort((a, b) => a.seq - b.seq));
    });
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
    this.withStoreLock(() => {
      const logs = this.readNdjson(LOG, sourceLogRecordSchema);
      this.rewriteNdjson(LOG, logs.slice(-10_000));
    });
  }

  maybeCompact(): void {
    if (this.readNdjson(LOG, sourceLogRecordSchema).length > 10_500) this.compact();
    const comments = this.readNdjson(COMMENTS, sourceCommentRecordSchema);
    if (comments.length > 10_500) this.compactComments();
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
    this.connections.clear();
    this.loadConnections();
    this.stateFile = this.readJson(STATE, sourceStateFileSchema, { version: 1, states: {} });
    this.logSeq = this.lastNdjsonSeq(LOG);
    this.commentSeq = this.lastNdjsonSeq(COMMENTS);
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

  private setStateInternal(id: string, state: SourceState): void {
    const parsed = sourceStateSchema.parse(state);
    this.stateFile.states = { ...this.stateFile.states, [id]: parsed };
    this.atomicJson(STATE, this.stateFile);
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

  /**
   * The highest `seq` in an append-ordered NDJSON file, without validating every row.
   *
   * `load()` runs on every store-lock acquisition, so recovering the sequence by reading the
   * whole file made a single `appendLog` O(rows) and a run of them O(rows^2). That is a
   * production cost, not just a slow test: `maybeCompact` deliberately lets the log reach
   * 10,000 rows, so every sync event was re-validating 10,000 records to learn one number.
   *
   * Rows are only ever appended in `seq` order, and both `compact` and `compactComments`
   * preserve that order, so the newest well-formed line carries the highest `seq`. A torn
   * trailing line (a crash mid-append) is stepped over exactly as `readNdjson` skips a
   * malformed row, rather than being allowed to reset the sequence to 0 and reissue live ids.
   */
  private lastNdjsonSeq(filename: string): number {
    const path = join(this.dataDir, filename);
    if (!existsSync(path)) return 0;
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      let window = 0;
      while (window < size) {
        window = Math.min(size, window === 0 ? 64 * 1024 : window * 4);
        const start = size - window;
        const buffer = Buffer.allocUnsafe(window);
        readSync(fd, buffer, 0, window, start);
        const text = buffer.toString('utf8');
        // Past the first byte the window almost certainly opens mid-row; drop that fragment so a
        // split line is never mistaken for a torn one. Scanning backwards, losing the window's
        // first line is harmless, because only the LAST line carries the highest seq.
        const scanned = start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
        const lines = scanned.split('\n');
        for (let index = lines.length - 1; index >= 0; index--) {
          const line = lines[index];
          if (!line) continue;
          try {
            const { seq } = JSON.parse(line) as { seq?: unknown };
            if (typeof seq === 'number' && Number.isFinite(seq)) return seq;
          } catch {
            // A torn trailing row, or a row this window cut in half: keep walking back, then
            // widen the window if the whole window yielded nothing parseable.
          }
        }
      }
      return 0;
    } finally {
      closeSync(fd);
    }
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

  /** Serialize all source-file read-modify-writes across cezar processes. */
  private withStoreLock<T>(operation: () => T): T {
    if (this.storeLockDepth > 0) return operation();
    mkdirSync(this.dataDir, { recursive: true });
    const path = join(this.dataDir, STORE_LOCK);
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + STORE_LOCK_TIMEOUT_MS;
    let fd: number | undefined;
    while (fd === undefined) {
      let opened: number | undefined;
      try {
        opened = openSync(path, 'wx', 0o600);
        writeFileSync(opened, JSON.stringify({ pid: process.pid, startedAt: this.now().toISOString() }));
        fd = opened;
      } catch {
        if (opened !== undefined) {
          closeSync(opened);
          try {
            unlinkSync(path);
          } catch {
            // Another process may have reclaimed the lock while the marker write failed.
          }
        }
        if (Date.now() >= deadline) throw new Error('timed out waiting for the source store lock');
        Atomics.wait(waitCell, 0, 0, 5);
      }
    }
    this.storeLockDepth = 1;
    try {
      this.load();
      return operation();
    } finally {
      this.storeLockDepth = 0;
      closeSync(fd!);
      try {
        unlinkSync(path);
      } catch {
        // Another owner may have reclaimed a stale lock during shutdown.
      }
    }
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
