import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoteStore, firstLineTitle } from './store.ts';
import type { StoredNote } from './types.ts';

/**
 * `NoteStore` — `~/.cezar/notes.json` plus its append-only receipt log (spec
 * `.ai/specs/2026-08-14-note-to-spec-pipeline.md`, P2.1).
 *
 * The two assertions that carry weight are the ones about **not losing a note** (a capture inbox
 * that drops what you gave it is worse than no inbox) and the **first-wins claim** (the guard
 * between one click and two agent runs in two repositories).
 */
describe('NoteStore', () => {
  let dir: string;
  let store: NoteStore;
  const warnings: string[] = [];

  const paths = () => ({ notes: join(dir, 'notes.json'), log: join(dir, 'notes-log.ndjson') });
  const fresh = () => new NoteStore({ paths: paths(), warn: (m) => warnings.push(m) });

  beforeEach(() => {
    dir = mkdtempSync(join(realpathSync(tmpdir()), 'cez-notes-'));
    warnings.length = 0;
    store = fresh();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('captures a note and reads it back through a NEW store instance', async () => {
    const note = await store.capture({ body: 'Ship the thing\nand the other thing', source: 'cockpit' });

    expect(note.status).toBe('raw');
    expect(note.title).toBe('Ship the thing');
    expect(note.titleOrigin).toBe('auto');

    // Through a fresh instance, so this is a round-trip through the FILE and not a read of the
    // in-memory map that just wrote it — the only version of this assertion that means anything.
    expect(fresh().get(note.id)?.body).toBe('Ship the thing\nand the other thing');
  });

  it('keeps a user-written title and says so', async () => {
    const note = await store.capture({ body: 'body', source: 'cli', title: 'My own title' });

    expect(note.title).toBe('My own title');
    expect(note.titleOrigin).toBe('user');
  });

  it('lists newest first', async () => {
    let clock = Date.parse('2026-08-14T10:00:00.000Z');
    const timed = new NoteStore({ paths: paths(), now: () => new Date((clock += 1_000)) });
    await timed.capture({ body: 'first', source: 'cockpit' });
    await timed.capture({ body: 'second', source: 'cockpit' });

    expect(timed.list().map((note) => note.body)).toEqual(['second', 'first']);
  });

  /** PER-ENTRY salvage. A capture inbox exists so a thought is somewhere safe; losing every note
   *  because one row is malformed is the failure this store must not have. */
  it('salvages the readable notes when one row is malformed', () => {
    writeFileSync(
      paths().notes,
      JSON.stringify({
        version: 1,
        notes: [
          { id: 'note_ok', capturedAt: '2026-08-14T10:00:00.000Z', source: 'cockpit', body: 'kept', status: 'raw', title: 'kept', titleOrigin: 'auto', resultingTasks: [] },
          { id: 'note_broken', body: 42 },
        ],
      }),
    );

    expect(fresh().list().map((note) => note.id)).toEqual(['note_ok']);
  });

  it('degrades a corrupt file to an empty inbox with one warning, never a throw', () => {
    writeFileSync(paths().notes, '{ not json');
    const loud: string[] = [];
    const corrupted = new NoteStore({ paths: paths(), warn: (m) => loud.push(m) });

    expect(corrupted.list()).toEqual([]);
    // ONCE, not once per read: a warn-per-call would fill the terminal on every list request for
    // as long as the file stays broken.
    corrupted.list();
    expect(loud).toHaveLength(1);
    expect(loud[0]).toContain('empty inbox');
  });

  /**
   * An unknown key written by a NEWER cezar survives a round-trip through this one. Two builds
   * share one `~/.cezar`, and a closed storage parse would make the older build silently delete
   * what the newer one wrote, every time it rewrote the file.
   */
  it('round-trips a key it has never heard of', async () => {
    writeFileSync(
      paths().notes,
      JSON.stringify({
        version: 1,
        notes: [
          { id: 'note_x', capturedAt: '2026-08-14T10:00:00.000Z', source: 'cockpit', body: 'b', status: 'raw', title: 't', titleOrigin: 'auto', resultingTasks: [], fromTheFuture: { keep: 'me' } },
        ],
      }),
    );
    const next = fresh();
    await next.capture({ body: 'forces a rewrite', source: 'cockpit' });

    const onDisk = JSON.parse(readFileSync(paths().notes, 'utf8')) as { notes: StoredNote[] };
    const survivor = onDisk.notes.find((note) => note.id === 'note_x');
    expect((survivor as Record<string, unknown>).fromTheFuture).toEqual({ keep: 'me' });
  });

  it('updates and removes, and answers honestly for an unknown id', async () => {
    const note = await store.capture({ body: 'body', source: 'cockpit' });

    expect((await store.update(note.id, { title: 'renamed' }))?.title).toBe('renamed');
    expect(await store.update('note_nope', { title: 'x' })).toBeUndefined();
    expect(await store.remove(note.id)).toBe(true);
    expect(await store.remove(note.id)).toBe(false);
    expect(fresh().list()).toEqual([]);
  });

  it('refuses to move id or capturedAt through update', async () => {
    const note = await store.capture({ body: 'body', source: 'cockpit' });

    const patched = await store.update(note.id, {
      id: 'note_hijacked',
      capturedAt: '1999-01-01T00:00:00.000Z',
      title: 'fine',
    } as Partial<StoredNote>);

    expect(patched?.id).toBe(note.id);
    expect(patched?.capturedAt).toBe(note.capturedAt);
    expect(patched?.title).toBe('fine');
  });

  describe('claimProposal — first wins', () => {
    const withProposal = async (): Promise<string> => {
      const note = await store.capture({ body: 'body', source: 'cockpit' });
      await store.update(note.id, {
        pass: {
          id: 'pass_1',
          startedAt: '2026-08-14T10:00:00.000Z',
          runner: 'claude',
          summary: '',
          proposals: [
            { id: 'p1', projectId: 'alpha', title: 'T', task: 'do it', rationale: '', issues: [], decision: 'pending' },
          ],
          unassigned: [],
          fallback: false,
          truncated: false,
          consideredProjects: ['alpha'],
          boardDigestSize: 0,
        },
      });
      return note.id;
    };

    it('claims once and reports the existing run to every later caller', async () => {
      const noteId = await withProposal();

      expect(await store.claimProposal(noteId, 'p1', 'run_placeholder')).toEqual({ claimed: true });
      expect(await store.claimProposal(noteId, 'p1', 'run_other')).toEqual({
        claimed: false,
        runId: 'run_placeholder',
      });
    });

    /**
     * THE guard: a double-click. Both calls are made before either is awaited, which is exactly
     * what two clicks or two tabs produce — and is the shape a check-then-set outside the lock
     * would fail on while passing the sequential test above.
     */
    it('lets exactly one of two concurrent claims win', async () => {
      const noteId = await withProposal();

      const [a, b] = await Promise.all([
        store.claimProposal(noteId, 'p1', 'run_a'),
        store.claimProposal(noteId, 'p1', 'run_b'),
      ]);

      expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1);
    });

    it('does not claim a proposal or note that does not exist', async () => {
      const noteId = await withProposal();

      expect(await store.claimProposal(noteId, 'nope', 'r')).toEqual({ claimed: false });
      expect(await store.claimProposal('note_nope', 'p1', 'r')).toEqual({ claimed: false });
    });

    it('releases a claim whose run never started, so the row is retryable', async () => {
      const noteId = await withProposal();
      await store.claimProposal(noteId, 'p1', 'run_placeholder');

      await store.releaseProposal(noteId, 'p1');

      expect(await store.claimProposal(noteId, 'p1', 'run_second_try')).toEqual({ claimed: true });
    });

    it('records the real run id over the placeholder, one row per (proposal, kind)', async () => {
      const noteId = await withProposal();
      await store.claimProposal(noteId, 'p1', 'run_placeholder');

      await store.recordResultingTask(noteId, { proposalId: 'p1', projectId: 'alpha', runId: 'run_real', kind: 'spec' });
      // The spec run finishing and reporting its path must not add a SECOND spec row.
      await store.recordResultingTask(noteId, {
        proposalId: 'p1', projectId: 'alpha', runId: 'run_real', kind: 'spec', specPath: '.ai/specs/x.md',
      });
      await store.recordResultingTask(noteId, { proposalId: 'p1', projectId: 'alpha', runId: 'run_impl', kind: 'implementation' });

      const note = fresh().get(noteId)!;
      expect(note.resultingTasks.map((row) => [row.kind, row.runId, row.specPath])).toEqual([
        ['spec', 'run_real', '.ai/specs/x.md'],
        ['implementation', 'run_impl', undefined],
      ]);
      expect(note.pass?.proposals[0]?.createdRunId).toBe('run_real');
    });
  });

  describe('the receipt log', () => {
    it('records capture and approval, and survives a malformed row', async () => {
      const note = await store.capture({ body: 'body', source: 'cockpit' });
      await store.claimProposal(note.id, 'p1', 'r');
      writeFileSync(paths().log, `${readFileSync(paths().log, 'utf8')}{ not json\n`);
      store.log({ noteId: note.id, event: 'pass', passId: 'pass_1', detail: 'ok' });

      expect(store.logRecords().map((row) => row.event)).toEqual(['captured', 'pass']);
    });

    it('drops rows past retention on compaction', async () => {
      let clock = Date.parse('2026-01-01T00:00:00.000Z');
      const old = new NoteStore({ paths: paths(), now: () => new Date(clock) });
      old.log({ noteId: 'n', event: 'captured', detail: 'ancient' });
      clock = Date.parse('2026-08-14T00:00:00.000Z');
      old.log({ noteId: 'n', event: 'captured', detail: 'recent' });

      old.compactLog();

      expect(old.logRecords().map((row) => row.detail)).toEqual(['recent']);
    });
  });
});

describe('firstLineTitle', () => {
  it('takes the first non-empty line', () => {
    expect(firstLineTitle('\n\n  Real title  \nrest')).toBe('Real title');
  });

  it('names an empty note rather than answering an empty string', () => {
    expect(firstLineTitle('   \n  ')).toBe('Untitled note');
  });

  /** The contract caps `title` at 200. A cut on a word boundary keeps the inbox readable; a hard
   *  slice at 200 would end mid-word on every long note. */
  it('cuts a long line on a word boundary, within the contract bound', () => {
    const title = firstLineTitle(`${'word '.repeat(60)}end`);

    expect(title.length).toBeLessThanOrEqual(200);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/\bwor…$/);
  });
});
