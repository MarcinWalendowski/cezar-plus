import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  NoteRecord,
  NoteResponse,
  NotesListResponse,
} from '@loki-labs/better-cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, type ServerDeps } from './server.ts';

/**
 * The NOTES family of `/api/v1/workspace` (P2.1, spec
 * `.ai/specs/2026-08-14-note-to-spec-pipeline.md`).
 *
 * Driven through `createApp()` rather than through `createNotesRoutes()` directly, deliberately:
 * a family that behaves perfectly in isolation and is mounted wrongly is exactly the bug an
 * isolated test cannot see, and this family was shipped once as an inert scaffold that answered
 * constant payloads (`.ai/specs/2026-08-14-remove-notes-capture-inbox.md`). `CEZ_HOME` points at a
 * temp directory, so the store the real mount builds is hermetic without any injection.
 *
 * The load-bearing case here is the FLAG-OFF one (`PLAN.md` D19): reads answer 200 with a
 * schema-valid empty payload, mutators answer 409, and **nothing in the family answers 404**, so a
 * 404 keeps meaning "no such note" rather than "no such feature".
 */
describe('the notes family', () => {
  const saved = {
    home: process.env.CEZ_HOME,
    notes: process.env.CEZ_NOTES,
    singleProject: process.env.CEZ_SINGLE_PROJECT,
  };
  let home: string;
  let repoRoot: string;
  let store: RunStore;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-notes-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-notes-boot-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_NOTES = '1';
    delete process.env.CEZ_SINGLE_PROJECT;
    clearProjectProbeCache();
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    store.flush();
    rmSync(home, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    for (const [key, value] of [
      ['CEZ_HOME', saved.home],
      ['CEZ_NOTES', saved.notes],
      ['CEZ_SINGLE_PROJECT', saved.singleProject],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', ...over });

  const post = (app: ReturnType<typeof makeApp>, path: string, body: unknown) =>
    apiRequest(app, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** Poll the note until its pass has settled. Bounded, and it asserts on the STATUS rather than
   *  on elapsed time — a fixed sleep would be flaky in exactly the direction that hides a bug. */
  const waitForPass = async (app: ReturnType<typeof makeApp>, noteId: string) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const res = await apiRequest(app, `/api/v1/workspace/notes/${noteId}`);
      const status = ((await res.json()) as NoteResponse).note?.status;
      if (status !== 'processing') return status;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return 'processing';
  };

  const capture = async (app: ReturnType<typeof makeApp>, body: string, extra: object = {}) => {
    const res = await post(app, '/api/v1/workspace/notes', { body, ...extra });
    expect(res.status).toBe(201);
    return ((await res.json()) as NoteResponse).note as NoteRecord;
  };

  it('captures a note and reads it back through the list and the detail route', async () => {
    const app = makeApp();
    const note = await capture(app, 'Ship the exporter\nand fix the retry backoff', {
      source: 'cockpit',
      projectHint: 'alpha',
    });

    expect(note.title).toBe('Ship the exporter');
    expect(note.status).toBe('raw');
    expect(note.projectHint).toBe('alpha');

    const list = (await (await apiRequest(app, '/api/v1/workspace/notes')).json()) as NotesListResponse;
    expect(list.notes.map((row) => row.id)).toEqual([note.id]);
    // The list carries an EXCERPT, never the body — the whole reason `noteSummarySchema` omits it.
    expect(list.notes[0]).not.toHaveProperty('body');
    expect(list.notes[0]?.excerpt).toContain('Ship the exporter');

    const detail = await apiRequest(app, `/api/v1/workspace/notes/${note.id}`);
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as NoteResponse).note?.body).toContain('retry backoff');
  });

  it('defaults an unstamped capture to `api` rather than guessing a surface', async () => {
    const note = await capture(makeApp(), 'from a shortcut');

    expect(note.source).toBe('api');
  });

  it('edits, archives, and deletes — and answers 404 for an id that is not there', async () => {
    const app = makeApp();
    const note = await capture(app, 'original', { projectHint: 'alpha' });

    const patched = await apiRequest(app, `/api/v1/workspace/notes/${note.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'my own title', projectHint: null }),
    });
    expect(patched.status).toBe(200);
    const edited = ((await patched.json()) as NoteResponse).note as NoteRecord;
    expect(edited.title).toBe('my own title');
    // A user-typed title is marked as one, so the pass will not rename it later.
    expect(edited.titleOrigin).toBe('user');
    // `null` CLEARS the hint. An absent key would have left it alone — the distinction the
    // contract spells out and the reason the field is nullable rather than merely optional.
    expect(edited.projectHint).toBeUndefined();

    const missing = await apiRequest(app, '/api/v1/workspace/notes/note_nope', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    });
    expect(missing.status).toBe(404);

    const removed = await apiRequest(app, `/api/v1/workspace/notes/${note.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true });
    expect((await apiRequest(app, `/api/v1/workspace/notes/${note.id}`)).status).toBe(404);
  });

  it('hides archived notes from the default list and shows them under `status=all`', async () => {
    const app = makeApp();
    const kept = await capture(app, 'still open');
    const done = await capture(app, 'dealt with');
    await apiRequest(app, `/api/v1/workspace/notes/${done.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    });

    const visible = (await (await apiRequest(app, '/api/v1/workspace/notes')).json()) as NotesListResponse;
    expect(visible.notes.map((row) => row.id)).toEqual([kept.id]);

    // Archiving must not make a note unreachable through the API that archived it.
    const all = (await (
      await apiRequest(app, '/api/v1/workspace/notes?status=all')
    ).json()) as NotesListResponse;
    expect(all.notes.map((row) => row.id).sort()).toEqual([done.id, kept.id].sort());
  });

  it('filters by the project a note names, and reports truncation honestly', async () => {
    const app = makeApp();
    const alpha = await capture(app, 'about alpha', { projectHint: 'alpha' });
    await capture(app, 'about beta', { projectHint: 'beta' });

    const filtered = (await (
      await apiRequest(app, '/api/v1/workspace/notes?projects=alpha')
    ).json()) as NotesListResponse;
    expect(filtered.notes.map((row) => row.id)).toEqual([alpha.id]);

    const capped = (await (
      await apiRequest(app, '/api/v1/workspace/notes?limit=1')
    ).json()) as NotesListResponse;
    expect(capped.notes).toHaveLength(1);
    expect(capped.truncated).toBe(true);
  });

  /**
   * D19, and the reason this family exists in this shape at all. Every route is exercised: a
   * partial check would pass while one forgotten handler 404s and tells a client the feature does
   * not exist.
   */
  it('flag off: reads are 200-and-empty, mutators are 409, and nothing 404s', async () => {
    process.env.CEZ_NOTES = '0';
    const app = makeApp();

    const list = await apiRequest(app, '/api/v1/workspace/notes');
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ notes: [], truncated: false });

    const detail = await apiRequest(app, '/api/v1/workspace/notes/note_anything');
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual({ note: null });

    const mutators = [
      await post(app, '/api/v1/workspace/notes', { body: 'x' }),
      await apiRequest(app, '/api/v1/workspace/notes/note_x', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'x' }),
      }),
      await apiRequest(app, '/api/v1/workspace/notes/note_x', { method: 'DELETE' }),
      await post(app, '/api/v1/workspace/notes/note_x/process', {}),
      await post(app, '/api/v1/workspace/notes/note_x/approve', {
        passId: 'pass_1',
        proposals: [{ id: 'p1' }],
      }),
      await post(app, '/api/v1/workspace/notes/note_x/reject', { proposals: ['p1'] }),
    ];
    expect(mutators.map((res) => res.status)).toEqual([409, 409, 409, 409, 409, 409]);

    // The whole family, reads included: not one 404 anywhere.
    expect([list, detail, ...mutators].some((res) => res.status === 404)).toBe(false);
  });

  /** `CEZ_SINGLE_PROJECT=1` reports `notes: false` (`capabilities.ts`) — a cross-project inbox has
   *  nothing to be cross. It must take the same off-shape, not a different one. */
  it('single-project mode takes the identical flag-off shape', async () => {
    process.env.CEZ_SINGLE_PROJECT = '1';
    const app = makeApp();

    expect((await apiRequest(app, '/api/v1/workspace/notes')).status).toBe(200);
    expect((await post(app, '/api/v1/workspace/notes', { body: 'x' })).status).toBe(409);
  });

  /** A malformed request is about the REQUEST, not the feature: it must still be a 400 with the
   *  flag off, or "your query is broken" becomes indistinguishable from "the feature is off". */
  it('answers 400 for a malformed query whether the flag is on or off', async () => {
    expect((await apiRequest(makeApp(), '/api/v1/workspace/notes?limit=9999')).status).toBe(400);
    process.env.CEZ_NOTES = '0';
    expect((await apiRequest(makeApp(), '/api/v1/workspace/notes?limit=9999')).status).toBe(400);
  });

  /**
   * Storage is `.passthrough()` so a key a NEWER cezar wrote survives a round-trip through this
   * one (`notes/types.ts`); the wire is closed. Both halves matter and they pull in opposite
   * directions, so both are asserted here: the key must NOT reach the client, and must still be on
   * disk afterwards. Dropping the closed-schema parse in `toWire` breaks the first; making storage
   * closed to fix that would break the second.
   */
  it('keeps an unknown stored key off the wire and still on disk', async () => {
    writeFileSync(
      join(home, 'notes.json'),
      JSON.stringify({
        version: 1,
        notes: [
          {
            id: 'note_future',
            capturedAt: '2026-08-14T10:00:00.000Z',
            source: 'cockpit',
            body: 'written by a newer build',
            status: 'raw',
            title: 'from the future',
            titleOrigin: 'auto',
            resultingTasks: [],
            unknownToThisBuild: { keep: 'me' },
          },
        ],
      }),
    );
    const app = makeApp();

    const detail = await apiRequest(app, '/api/v1/workspace/notes/note_future');
    const wire = ((await detail.json()) as NoteResponse).note as NoteRecord;
    expect(wire.title).toBe('from the future');
    expect(wire).not.toHaveProperty('unknownToThisBuild');

    // A write forces a rewrite of the whole file — the moment an older build would silently drop
    // what a newer one wrote.
    await capture(app, 'forces a rewrite');
    const onDisk = JSON.parse(readFileSync(join(home, 'notes.json'), 'utf8')) as {
      notes: Record<string, unknown>[];
    };
    expect(onDisk.notes.find((row) => row.id === 'note_future')?.unknownToThisBuild).toEqual({
      keep: 'me',
    });
  });

  /**
   * The behavioural half of the "a triage pass builds no project context" guard — the structural
   * half (a transitive import walk over `notes/processor.ts`) lives in `notes/processor.test.ts`.
   *
   * Both are needed and neither replaces the other: the import walk cannot see a context built
   * through an injected callback, and this cannot see an import that has not been exercised yet.
   * What is being protected is that analysing a note must not call `manager.recover()` in every
   * registered repository — which silently resumes interrupted agent runs across the whole
   * workspace, as a side effect of triage.
   *
   * `CEZ_DRY_RUN=1` swaps the bundled mock in for the agent CLI, so this drives a REAL pass
   * end-to-end without spawning one.
   */
  it('a full triage pass builds no project context', async () => {
    const savedDryRun = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    const other = mkdtempSync(join(realpathSync(tmpdir()), 'cez-notes-other-'));
    try {
      const boot = await registerProject(repoRoot);
      await registerProject(other);
      const contexts = new ProjectContexts({ listProjects });
      const app = makeApp({ bootProjectId: boot.id, contexts });
      expect(contexts.ids()).toEqual([]);

      const note = await capture(app, 'Ship the exporter');
      const started = await post(app, `/api/v1/workspace/notes/${note.id}/process`, {});
      expect(started.status).toBe(202);

      // Wait for the pass to SETTLE rather than sampling once: the route answers 202 the moment
      // the note is marked `processing`, so an immediate assertion would pass while the pass was
      // still running and had not yet had the chance to build anything.
      const settled = await waitForPass(app, note.id);
      // The pass must have RUN, not merely stopped. A pass that died at the first step would
      // build no context either, and this control would then be proving nothing — so the answer
      // has to show it reached the catalog, the board and the runner.
      expect(settled).toBe('processed');
      const after = ((await (
        await apiRequest(app, `/api/v1/workspace/notes/${note.id}`)
      ).json()) as NoteResponse).note;
      expect(after?.pass?.fallback).toBe(false);
      expect(after?.pass?.consideredProjects.length).toBeGreaterThan(0);
      expect(after?.pass?.proposals.length).toBeGreaterThan(0);

      expect(contexts.ids()).toEqual([]);
    } finally {
      rmSync(other, { recursive: true, force: true });
      if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = savedDryRun;
    }
  }, 30_000);

  it('rejects proposals on a note, and 404s when none of them are on it', async () => {
    const app = makeApp();
    const note = await capture(app, 'body');

    // No pass yet, so no proposal by that id — a 404 about the PROPOSAL, with the flag on.
    const none = await post(app, `/api/v1/workspace/notes/${note.id}/reject`, { proposals: ['p1'] });
    expect(none.status).toBe(404);
  });
});
