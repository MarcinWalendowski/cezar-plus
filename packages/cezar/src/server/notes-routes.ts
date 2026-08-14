import { Hono } from 'hono';
import { z } from 'zod';
import {
  approveNoteInputSchema,
  createNoteInputSchema,
  noteRecordSchema,
  rejectNoteInputSchema,
  updateNoteInputSchema,
  type ApproveNoteResponse,
  type NoteRecord,
  type NoteRemovedResponse,
  type NoteResponse,
  type NoteSummary,
  type NotesListResponse,
  type ProcessNoteResponse,
} from '@open-mercato/cezar-contract';
import { jsonZodValidator, queryZodValidator } from './validators.ts';
import { resolveCapabilities } from './capabilities.ts';
import { NoteStore } from '../notes/store.ts';
import type { NotePipeline } from '../notes/pipeline.ts';
import type { StoredNote } from '../notes/types.ts';

/**
 * The NOTES family of `/api/v1/workspace` (F3 feature B, `CEZ_NOTES=1`). See
 * `.ai/specs/2026-08-14-note-to-spec-pipeline.md` and `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md`
 * D13/D14/D19.
 *
 * **This file knows about a store and a pipeline, and nothing else.** It never imports
 * `./project-context.ts`, `../runs/store.ts` or `../workflows/run.ts`: capturing, listing and
 * editing a note must not be able to instantiate a project, and instantiating a project runs
 * `manager.recover()`, which resumes interrupted agent runs. Starting a run is the pipeline's job
 * (`../notes/pipeline.ts`), reached through an interface for exactly that reason.
 *
 * **Flag-off shape (D19/D4).** With `CEZ_NOTES` anything but `'1'` — or under
 * `CEZ_SINGLE_PROJECT=1`, where a cross-project inbox has nothing to be cross — every `GET`
 * answers 200 with a schema-valid empty payload and every mutator answers 409. Never 404: a 404
 * in this family must keep meaning "no such note", so that a client can tell an unknown id from a
 * disabled feature without parsing prose.
 *
 * Workspace-level and single-mount (never mirrored under `/api/v1/p/:projectId`) — a note is
 * workspace-scoped by design (D14), so `route-parity.test.ts` does not apply to this family.
 * Chained into ONE family with an INFERRED return type, mounted into `workspaceV1` in `server.ts`.
 */

export interface NotesRouteDeps {
  /** Defaults to a `NoteStore` over the real `~/.cezar`. Injected so tests get a temp directory.
   *  Construction touches no filesystem, so building one under a disabled flag costs nothing. */
  store?: NoteStore;
  /** Supplied by `server.ts`. Absent only in tests that exercise the CRUD half. */
  pipeline?: NotePipeline;
  /** Read per request, so a test that flips the flag mid-file is honoured. */
  env?: NodeJS.ProcessEnv;
}

const NOTES_OFF = 'the notes inbox is disabled — set CEZ_NOTES=1 to enable it';
/** The pipeline is wired in `server.ts` and absent only in a CRUD-only test harness. 409 rather
 *  than 500: nothing is broken, this build simply cannot run a pass. */
const NO_PIPELINE = 'this server was built without the note pipeline';
const NOT_FOUND = 'not found';

const EMPTY_NOTES_LIST: NotesListResponse = { notes: [], truncated: false };
const EMPTY_NOTE: NoteResponse = { note: null };

/** Enough of the note to recognise it in a list, and never the whole body — a 100k-character note
 *  must not ride a list response once per row. */
const EXCERPT_CHARS = 280;
const DEFAULT_LIMIT = 100;

const notesListQuerySchema = z.object({
  status: z.enum(['raw', 'processing', 'processed', 'all']).optional(),
  projects: z.string().max(2_000).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * Strip a stored note down to the CLOSED wire shape.
 *
 * `StoredNote` is `.passthrough()` so a key written by a newer cezar survives a round-trip through
 * an older one (`../notes/types.ts`). That openness is a storage property and must stop at the
 * socket: parsing through the closed schema is what keeps an unknown key from leaking onto a wire
 * the contract says does not carry it. Cannot throw — the same schema already validated the row on
 * the way in.
 */
function toWire(note: StoredNote): NoteRecord {
  return noteRecordSchema.parse(note);
}

function toSummary(note: StoredNote): NoteSummary {
  const wire = toWire(note);
  const proposals = wire.pass?.proposals ?? [];
  return {
    id: wire.id,
    capturedAt: wire.capturedAt,
    source: wire.source,
    ...(wire.sourceRef !== undefined ? { sourceRef: wire.sourceRef } : {}),
    status: wire.status,
    title: wire.title,
    titleOrigin: wire.titleOrigin,
    ...(wire.projectHint !== undefined ? { projectHint: wire.projectHint } : {}),
    ...(wire.processedAt !== undefined ? { processedAt: wire.processedAt } : {}),
    resultingTasks: wire.resultingTasks,
    ...(wire.archived !== undefined ? { archived: wire.archived } : {}),
    ...(wire.archivedAt !== undefined ? { archivedAt: wire.archivedAt } : {}),
    excerpt: wire.body.slice(0, EXCERPT_CHARS),
    proposalCount: proposals.length,
    // De-duplicated and sorted so the chip row under a title is stable between renders rather than
    // reordering with whatever order the pass happened to emit.
    targetProjects: [...new Set(proposals.map((row) => row.projectId))].sort(),
  };
}

/** `undefined` in ⇒ `undefined` out (no filter). A present-but-empty string is a deliberate request
 *  for zero projects and is honoured as one — same contract as `workspace-runs-routes.ts`. */
function parseProjectsFilter(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Which projects a note is ABOUT: what the pass targeted, plus the user's advisory hint, so a
 *  captured-but-unprocessed note is still findable under the project it names. */
function noteProjects(note: StoredNote): string[] {
  const targets = (note.pass?.proposals ?? []).map((row) => row.projectId);
  return note.projectHint ? [...targets, note.projectHint] : targets;
}

export function createNotesRoutes(deps: NotesRouteDeps = {}) {
  const store = deps.store ?? new NoteStore();
  const enabled = () => resolveCapabilities(deps.env ?? process.env).notes;

  return new Hono()
    // ---- reads: 200, schema-valid empty, never 404 -------------------------------------------
    .get('/workspace/notes', queryZodValidator(notesListQuerySchema), (c) => {
      const query = c.req.valid('query');
      // Malformed query is still a 400 whether the flag is on or off — a parse error is about the
      // request, not about the feature. Only a WELL-FORMED request gets the empty flag-off answer.
      if (!enabled()) return c.json(EMPTY_NOTES_LIST);

      const projects = parseProjectsFilter(query.projects);
      const limit = query.limit ?? DEFAULT_LIMIT;
      let rows = store.list();
      // `all` is the only value that includes archived notes. Archiving is how a note LEAVES the
      // inbox, so the default view hides them — and there has to be one spelling that shows them
      // again, or an archived note is unreachable through the API that archived it.
      if (query.status !== 'all') rows = rows.filter((note) => note.archived !== true);
      if (query.status && query.status !== 'all') rows = rows.filter((note) => note.status === query.status);
      if (projects) {
        const wanted = new Set(projects);
        rows = rows.filter((note) => noteProjects(note).some((id) => wanted.has(id)));
      }
      const body: NotesListResponse = {
        notes: rows.slice(0, limit).map(toSummary),
        truncated: rows.length > limit,
      };
      return c.json(body);
    })

    // ---- THE single write path (cockpit textarea, phone Shortcut, webhook) --------------------
    .post('/workspace/notes', jsonZodValidator(createNoteInputSchema), async (c) => {
      if (!enabled()) return c.json({ error: NOTES_OFF }, 409);
      const input = c.req.valid('json');
      const note = await store.capture({
        body: input.body,
        // The route IS the API, so an unstamped capture is an API capture. Never guessed from a
        // header: `source` is what the caller calls itself, and a wrong guess is worse than a
        // generic truth.
        source: input.source ?? 'api',
        ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
        ...(input.projectHint ? { projectHint: input.projectHint } : {}),
      });
      // Cheap, bounded, and triggered by the one event that always precedes growth — see
      // `compactLog`'s own note on why this is not a timer.
      store.compactLog();
      const body: NoteResponse = { note: toWire(note) };
      return c.json(body, 201);
    })

    .get('/workspace/notes/:noteId', (c) => {
      if (!enabled()) return c.json(EMPTY_NOTE);
      const note = store.get(c.req.param('noteId'));
      if (!note) return c.json({ error: NOT_FOUND }, 404);
      const body: NoteResponse = { note: toWire(note) };
      return c.json(body);
    })

    .patch('/workspace/notes/:noteId', jsonZodValidator(updateNoteInputSchema), async (c) => {
      if (!enabled()) return c.json({ error: NOTES_OFF }, 409);
      const noteId = c.req.param('noteId');
      const current = store.get(noteId);
      if (!current) return c.json({ error: NOT_FOUND }, 404);
      const input = c.req.valid('json');

      const patch: Partial<StoredNote> = {};
      if (input.title !== undefined) {
        // A title the user typed stops the pass from renaming it later, the same way an edited run
        // title stops the auto-namer (`PATCH /runs/:id`). Same idea, same word for it.
        patch.title = input.title;
        patch.titleOrigin = 'user';
      }
      if (input.body !== undefined) patch.body = input.body;
      // `null` clears the hint; an absent key leaves it alone. Two different intentions that a
      // single optional field cannot tell apart, which is why the contract spells them apart.
      if (input.projectHint === null) patch.projectHint = undefined;
      else if (input.projectHint !== undefined) patch.projectHint = input.projectHint;
      if (input.archived !== undefined) {
        patch.archived = input.archived;
        patch.archivedAt = input.archived ? new Date().toISOString() : undefined;
      }

      const next = await store.update(noteId, patch);
      // The store answers `undefined` only for an unknown id, and the id was just read — but a
      // delete could have landed between the two, and answering 404 for that is exactly right.
      if (!next) return c.json({ error: NOT_FOUND }, 404);
      const body: NoteResponse = { note: toWire(next) };
      return c.json(body);
    })

    .delete('/workspace/notes/:noteId', async (c) => {
      if (!enabled()) return c.json({ error: NOTES_OFF }, 409);
      if (!(await store.remove(c.req.param('noteId')))) return c.json({ error: NOT_FOUND }, 404);
      const body: NoteRemovedResponse = { removed: true };
      return c.json(body);
    })

    // ---- creates nothing, ever (202: the pass runs in the background) -------------------------
    .post('/workspace/notes/:noteId/process', async (c) => {
      if (!enabled()) return c.json({ error: NOTES_OFF }, 409);
      if (!deps.pipeline) return c.json({ error: NO_PIPELINE }, 409);
      const result = await deps.pipeline.process(c.req.param('noteId'));
      if (!result.ok) return c.json({ error: result.error }, result.status);
      const body: ProcessNoteResponse = { note: toWire(result.note) };
      return c.json(body, 202);
    })

    .post('/workspace/notes/:noteId/approve', jsonZodValidator(approveNoteInputSchema), async (c) => {
      if (!enabled()) return c.json({ error: NOTES_OFF }, 409);
      if (!deps.pipeline) return c.json({ error: NO_PIPELINE }, 409);
      const result = await deps.pipeline.approve(c.req.param('noteId'), c.req.valid('json'));
      if (!result.ok) return c.json({ error: result.error }, result.status);
      const body: ApproveNoteResponse = result.body;
      return c.json(body);
    })

    // Rejection touches no project and starts nothing, so it stays here rather than in the
    // pipeline: it is a write to one field of one stored row.
    .post('/workspace/notes/:noteId/reject', jsonZodValidator(rejectNoteInputSchema), async (c) => {
      if (!enabled()) return c.json({ error: NOTES_OFF }, 409);
      const noteId = c.req.param('noteId');
      const current = store.get(noteId);
      if (!current) return c.json({ error: NOT_FOUND }, 404);
      const wanted = new Set(c.req.valid('json').proposals);
      const proposals = current.pass?.proposals ?? [];
      if (!proposals.some((row) => wanted.has(row.id))) {
        return c.json({ error: 'none of those proposals are on this note' }, 404);
      }
      const next = await store.update(noteId, {
        ...(current.pass
          ? {
              pass: {
                ...current.pass,
                proposals: proposals.map((row) =>
                  // A CLAIMED proposal is one that already produced a run; calling it rejected
                  // afterwards would describe the note as if no work had started, which is a
                  // record that lies rather than a state that changed.
                  wanted.has(row.id) && !row.createdRunId ? { ...row, decision: 'rejected' as const } : row,
                ),
              },
            }
          : {}),
      });
      if (!next) return c.json({ error: NOT_FOUND }, 404);
      store.log({ noteId, event: 'rejected', detail: [...wanted].join(',').slice(0, 2_000) });
      const body: NoteResponse = { note: toWire(next) };
      return c.json(body);
    });
}
