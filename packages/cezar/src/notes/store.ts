import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { assertCezarHomeWriteIsSandboxed, notesLogPath, notesPath } from '../paths.ts';
import {
  noteLogRecordSchema,
  notesFileSchema,
  storedNoteSchema,
  type NoteLogRecord,
  type StoredNote,
} from './types.ts';

/**
 * `~/.cezar/notes.json` + `notes-log.ndjson` — the capture inbox's storage (P2.1, spec
 * `.ai/specs/2026-08-14-note-to-spec-pipeline.md`).
 *
 * Storage idioms copied from `automations/store.ts` and `sources/store.ts`: `.tmp` plus `rename` at
 * 0600, corrupt input degrades to empty with one warning rather than a throw, per-entry salvage, and
 * an append-only NDJSON log with retention. Copied in idiom and reimplemented, not shared —
 * `AutomationStore` is per-project and keyed on a `dataDir`, and widening it to also be a
 * workspace-scoped singleton would make one class answer two different questions about scope.
 *
 * ## Two guards that are not incidental
 *
 * 1. **The claim is taken before the run starts.** `claimProposal` checks and sets
 *    `createdRunId` inside the same lock that guards the write — a direct port of `todos.ts`'s
 *    `markStarted`, whose docblock states the mechanism: "the check shares this lock, so two
 *    concurrent launches cannot both claim the entry". Approve takes the claim, and only then calls
 *    `startRun`. That ordering is the whole guard: the worst case becomes a claimed proposal with
 *    no run — visible in the UI and retryable — instead of two agent runs in two repositories from
 *    one click, which is invisible, expensive, and impossible to undo. `claimImplementation` /
 *    `implementationRunId` (PLAN D27 Phase 3) is the same guard applied a second time, to a
 *    second, independent claim slot: the continuation trigger cannot start two implementation runs
 *    off one proposal any more than a double-click can start two spec runs.
 * 2. **Every write goes through one in-process mutex.** The routes are async and a pass runs in the
 *    background, so read-modify-write races are the normal case here rather than the exotic one.
 *    `automations/store.ts` is synchronous throughout and gets this for free; this store cannot,
 *    so it serialises explicitly.
 *
 * `assertCezarHomeWriteIsSandboxed` is called on every write for the reason that function's own
 * docblock gives: under vitest a write whose destination is the real `~/.cezar` is always a leaked
 * test, never intent.
 */

const RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
/** The inbox is a working surface, not an archive: a list route answering ten thousand rows is a
 *  page nobody can read and a response nobody should have to parse. Older notes stay on disk. */
const MAX_NOTES = 2_000;

export interface NoteStoreOptions {
  warn?: (message: string) => void;
  now?: () => Date;
  /** Injected in tests so a fixture never depends on `~/.cezar` resolution order. */
  paths?: { notes: string; log: string };
}

export class NoteStore {
  private notes = new Map<string, StoredNote>();
  private loaded = false;
  private warned = new Set<string>();
  private logSeq = 0;
  private readonly now: () => Date;
  private readonly notesFile: string;
  private readonly logFile: string;
  /** The mutex. Every mutator awaits the previous one, so a read-modify-write can never interleave
   *  with another — see guard 2 in the module doc. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: NoteStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.notesFile = options.paths?.notes ?? notesPath();
    this.logFile = options.paths?.log ?? notesLogPath();
  }

  // ---- reads -----------------------------------------------------------------------------

  /** Every note, newest capture first. Loads on first use; a corrupt file reads as an empty inbox
   *  plus one warning, never a throw. */
  list(): StoredNote[] {
    this.load();
    return [...this.notes.values()].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  }

  get(id: string): StoredNote | undefined {
    this.load();
    return this.notes.get(id);
  }

  /**
   * Reverse lookup: which note/proposal produced this run, if any (PLAN D27 Phase 3, `.ai/specs/
   * 2026-08-15-autonomous-implementation-continuation.md`). The continuation trigger starts from a
   * run id — the spec run a project's store just reported settling — and needs to find the note
   * that owns it before it can check `autonomous` or claim the implementation leg. A linear scan:
   * the inbox is capped (`MAX_NOTES`) and this runs once per settled run, not per request.
   */
  findResultingRun(
    runId: string,
    kind: 'spec' | 'implementation',
  ): { note: StoredNote; proposalId: string } | undefined {
    this.load();
    for (const note of this.notes.values()) {
      const entry = note.resultingTasks.find((row) => row.runId === runId && row.kind === kind);
      if (entry) return { note, proposalId: entry.proposalId };
    }
    return undefined;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.notesFile)) return;
    let rows: unknown[] = [];
    try {
      const parsed = notesFileSchema.safeParse(JSON.parse(readFileSync(this.notesFile, 'utf8')));
      if (!parsed.success) {
        this.warnOnce('notes', 'Ignored a corrupt ~/.cezar/notes.json — starting from an empty inbox.');
        return;
      }
      rows = parsed.data.notes;
    } catch {
      this.warnOnce('notes', 'Ignored an unreadable ~/.cezar/notes.json — starting from an empty inbox.');
      return;
    }
    // PER-ENTRY salvage: one malformed note costs that note, not the inbox.
    for (const row of rows) {
      const note = storedNoteSchema.safeParse(row);
      if (note.success) this.notes.set(note.data.id, note.data);
      else this.warnOnce('note-row', 'Skipped a malformed note in ~/.cezar/notes.json.');
    }
  }

  // ---- writes ----------------------------------------------------------------------------

  /** Serialise a mutator behind every earlier one. Rejections do not poison the chain: a failed
   *  write must not wedge every later write in the process. */
  private serialize<T>(mutator: () => T): Promise<T> {
    const next = this.chain.then(mutator, mutator);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async capture(input: {
    body: string;
    source: StoredNote['source'];
    sourceRef?: string;
    projectHint?: string;
    title?: string;
    /** PLAN D27 Phase 3 — see `noteRecordSchema.autonomous`. Omitted defaults to non-autonomous. */
    autonomous?: boolean;
  }): Promise<StoredNote> {
    return this.serialize(() => {
      this.load();
      const at = this.now().toISOString();
      const note: StoredNote = {
        id: `note_${randomUUID()}`,
        capturedAt: at,
        source: input.source,
        ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
        body: input.body,
        status: 'raw',
        // A generated title beats an empty one and beats a truncated body pretending to be one:
        // the pass rewrites it with something real, and until then the first line is what the
        // person typed, which is the closest thing to a title that exists.
        title: input.title?.trim() || firstLineTitle(input.body),
        titleOrigin: input.title?.trim() ? 'user' : 'auto',
        ...(input.projectHint ? { projectHint: input.projectHint } : {}),
        ...(input.autonomous ? { autonomous: true } : {}),
        resultingTasks: [],
      };
      this.notes.set(note.id, note);
      this.persist();
      this.log({ noteId: note.id, event: 'captured', detail: note.title });
      return note;
    });
  }

  /** Apply `patch` to a note and persist. Returns `undefined` for an unknown id — a missing note is
   *  the caller's 404 to answer, not this store's exception to throw. */
  async update(id: string, patch: Partial<StoredNote>): Promise<StoredNote | undefined> {
    return this.serialize(() => {
      this.load();
      const current = this.notes.get(id);
      if (!current) return undefined;
      const next = { ...current, ...patch, id: current.id, capturedAt: current.capturedAt };
      this.notes.set(id, next);
      this.persist();
      return next;
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.serialize(() => {
      this.load();
      if (!this.notes.delete(id)) return false;
      this.persist();
      this.log({ noteId: id, event: 'removed', detail: '' });
      return true;
    });
  }

  /**
   * Claim one proposal for creation, FIRST WINS — the port of `todos.ts`'s `markStarted`.
   *
   * Answers `{claimed: true}` exactly once per proposal; every later call answers
   * `{claimed: false, runId}` naming the run that already exists. The check and the set happen in
   * one serialised mutator, so two concurrent approvals cannot both see it unclaimed.
   *
   * **Call this BEFORE starting the run**, and write the real run id back with
   * `recordResultingTask`. See guard 1 in the module doc for why that ordering is the guard rather
   * than a detail.
   */
  async claimProposal(
    noteId: string,
    proposalId: string,
    placeholderRunId: string,
  ): Promise<{ claimed: boolean; runId?: string }> {
    return this.serialize(() => {
      this.load();
      const note = this.notes.get(noteId);
      const proposal = note?.pass?.proposals.find((row) => row.id === proposalId);
      if (!note || !proposal) return { claimed: false };
      if (proposal.createdRunId) return { claimed: false, runId: proposal.createdRunId };
      proposal.createdRunId = placeholderRunId;
      this.persist();
      return { claimed: true };
    });
  }

  /** Record the run a claimed proposal actually produced, replacing the placeholder id. */
  async recordResultingTask(
    noteId: string,
    entry: {
      proposalId: string;
      projectId: string;
      runId: string;
      kind: 'spec' | 'implementation';
      specPath?: string;
    },
  ): Promise<StoredNote | undefined> {
    return this.serialize(() => {
      this.load();
      const note = this.notes.get(noteId);
      if (!note) return undefined;
      // Each leg writes only its OWN claim field. `createdRunId` is the first-wins claim on the
      // PROPOSAL for the spec leg; letting the implementation leg overwrite it would replace the
      // spec run's id with the implementation run's, so "has this proposal been turned into a
      // run?" would start answering with the wrong run, and a re-approve would compare against the
      // wrong one. `implementationRunId` (PLAN D27 Phase 3) is the implementation leg's own,
      // separate slot — see `claimImplementation`'s doc comment.
      const proposal = note.pass?.proposals.find((row) => row.id === entry.proposalId);
      if (proposal && entry.kind === 'spec') proposal.createdRunId = entry.runId;
      if (proposal && entry.kind === 'implementation') proposal.implementationRunId = entry.runId;
      note.resultingTasks = [
        ...note.resultingTasks.filter(
          (row) => !(row.proposalId === entry.proposalId && row.kind === entry.kind),
        ),
        { ...entry, createdAt: this.now().toISOString() },
      ];
      this.persist();
      this.log({ noteId, event: 'approved', detail: `${entry.kind}:${entry.projectId}:${entry.runId}` });
      return note;
    });
  }

  /** Release a claim whose run never started, so the proposal is retryable rather than stuck
   *  holding a placeholder forever. */
  async releaseProposal(noteId: string, proposalId: string): Promise<void> {
    await this.serialize(() => {
      this.load();
      const proposal = this.notes.get(noteId)?.pass?.proposals.find((row) => row.id === proposalId);
      if (!proposal) return;
      delete proposal.createdRunId;
      this.persist();
    });
  }

  /**
   * Claim one proposal's IMPLEMENTATION leg for creation, first wins — the second-leg twin of
   * `claimProposal` above (guard 1 in the module doc), for PLAN D27 Phase 3. `createdRunId` is
   * already spent by the spec run; this claims the SEPARATE `implementationRunId` slot so a
   * double-fired continuation trigger cannot start two implementation runs any more than a
   * double-click can start two spec runs. Same discipline: call this BEFORE starting the run, and
   * write the real id back with `recordResultingTask({kind: 'implementation', ...})`; release on
   * throw with `releaseImplementationClaim`.
   */
  async claimImplementation(
    noteId: string,
    proposalId: string,
    placeholderRunId: string,
  ): Promise<{ claimed: boolean; runId?: string }> {
    return this.serialize(() => {
      this.load();
      const note = this.notes.get(noteId);
      const proposal = note?.pass?.proposals.find((row) => row.id === proposalId);
      if (!note || !proposal) return { claimed: false };
      if (proposal.implementationRunId) return { claimed: false, runId: proposal.implementationRunId };
      proposal.implementationRunId = placeholderRunId;
      this.persist();
      return { claimed: true };
    });
  }

  /** Release an implementation claim whose run never started (mirrors `releaseProposal`). */
  async releaseImplementationClaim(noteId: string, proposalId: string): Promise<void> {
    await this.serialize(() => {
      this.load();
      const proposal = this.notes.get(noteId)?.pass?.proposals.find((row) => row.id === proposalId);
      if (!proposal) return;
      delete proposal.implementationRunId;
      this.persist();
    });
  }

  // ---- log -------------------------------------------------------------------------------

  /** Every pass receipt, oldest first, within retention. */
  logRecords(): NoteLogRecord[] {
    if (!existsSync(this.logFile)) return [];
    const rows: NoteLogRecord[] = [];
    for (const line of readFileSync(this.logFile, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const parsed = noteLogRecordSchema.safeParse(JSON.parse(line));
        if (parsed.success) rows.push(parsed.data);
        else this.warnOnce('log-row', 'Skipped a malformed row in ~/.cezar/notes-log.ndjson.');
      } catch {
        this.warnOnce('log-row', 'Skipped a malformed row in ~/.cezar/notes-log.ndjson.');
      }
    }
    return rows;
  }

  log(entry: { noteId: string; event: NoteLogRecord['event']; passId?: string; detail: string }): void {
    assertCezarHomeWriteIsSandboxed(this.logFile);
    mkdirSync(dirname(this.logFile), { recursive: true });
    const record: NoteLogRecord = {
      seq: ++this.logSeq,
      at: this.now().toISOString(),
      noteId: entry.noteId,
      event: entry.event,
      ...(entry.passId ? { passId: entry.passId } : {}),
      detail: entry.detail.slice(0, 2_000),
    };
    const fd = openSync(this.logFile, 'a', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(record)}\n`);
    } finally {
      closeSync(fd);
    }
  }

  /** Drop log rows past retention. Called on capture rather than on a timer: PLAN D4's "unset means
   *  no background timer" applies to the whole family, and a compaction nobody triggers is a
   *  compaction that cannot violate it. */
  compactLog(): void {
    if (!existsSync(this.logFile)) return;
    const cutoff = this.now().getTime() - RETENTION_MS;
    const kept = this.logRecords().filter((row) => Date.parse(row.at) >= cutoff);
    assertCezarHomeWriteIsSandboxed(this.logFile);
    const temporary = `${this.logFile}.tmp`;
    writeFileSync(temporary, kept.map((row) => JSON.stringify(row)).join('\n') + (kept.length ? '\n' : ''), {
      mode: 0o600,
    });
    renameSync(temporary, this.logFile);
  }

  // ---- internals -------------------------------------------------------------------------

  private persist(): void {
    assertCezarHomeWriteIsSandboxed(this.notesFile);
    mkdirSync(dirname(this.notesFile), { recursive: true });
    const notes = [...this.notes.values()]
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
      .slice(0, MAX_NOTES);
    const temporary = `${this.notesFile}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: 1, notes }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.notesFile);
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.options.warn?.(message);
  }
}

/**
 * A title from the note's own first line — never an invented one.
 *
 * The pass replaces this with something considered; until then the honest answer to "what is this
 * note called?" is the words the person actually typed. Bounded at the contract's 200, and cut on a
 * word boundary when it has to be cut so the inbox does not read as a wall of half-words.
 */
export function firstLineTitle(body: string): string {
  const line = body.split('\n').find((row) => row.trim() !== '')?.trim() ?? 'Untitled note';
  if (line.length <= 200) return line;
  const cut = line.slice(0, 200);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > 120 ? cut.slice(0, lastSpace) : cut.slice(0, 199)}…`;
}
