import { Hono } from 'hono';
import { z } from 'zod';
import {
  approveNoteInputSchema,
  createNoteInputSchema,
  rejectNoteInputSchema,
  updateNoteInputSchema,
  type NoteResponse,
  type NotesListResponse,
} from '@open-mercato/cezar-contract';
import { jsonZodValidator, queryZodValidator } from './validators.ts';

/**
 * The NOTES family of `/api/v1/workspace` (F3 feature B, `CEZ_NOTES=1`). See
 * `.ai/specs/2026-08-06-workspace-notes-cross-project.md` ("API Contracts", section B) and
 * `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D13/D14/D19.
 *
 * **Inert scaffold** — `notes/{types,store,coordinator,processor,prompt,task-template}.ts` (P2.1,
 * P2.2, P2.3) do not exist yet, so every route answers a constant schema-valid empty/409 shape
 * regardless of `CEZ_NOTES`. P2.3 fills this file in, gating each handler on
 * `capabilities().notes`.
 *
 * Workspace-level and single-mount (never mirrored under `/api/v1/p/:projectId`) — a note is
 * workspace-scoped by design (D14), so `route-parity.test.ts` does not apply to this family.
 * Chained into ONE family with an INFERRED return type, mounted into `workspaceV1` in `server.ts`.
 */

export interface NotesRouteDeps {}

const NOTES_OFF = 'the notes inbox is disabled — set CEZ_NOTES=1 to enable it';

const EMPTY_NOTES_LIST: NotesListResponse = { notes: [], truncated: false };
const EMPTY_NOTE: NoteResponse = { note: null };

const notesListQuerySchema = z.object({
  status: z.enum(['raw', 'processing', 'processed', 'all']).optional(),
  projects: z.string().max(2_000).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export function createNotesRoutes(_deps: NotesRouteDeps = {}) {
  return new Hono()
    // ---- reads: 200, schema-valid empty, never 404 -------------------------------------------
    .get('/workspace/notes', queryZodValidator(notesListQuerySchema), (c) => c.json(EMPTY_NOTES_LIST))

    // ---- THE single write path (cockpit textarea, phone Shortcut, webhook) --------------------
    .post('/workspace/notes', jsonZodValidator(createNoteInputSchema), (c) =>
      c.json({ error: NOTES_OFF }, 409),
    )

    .get('/workspace/notes/:noteId', (c) => c.json(EMPTY_NOTE))

    .patch('/workspace/notes/:noteId', jsonZodValidator(updateNoteInputSchema), (c) =>
      c.json({ error: NOTES_OFF }, 409),
    )

    .delete('/workspace/notes/:noteId', (c) => c.json({ error: NOTES_OFF }, 409))

    // ---- creates nothing, ever (202 on success — but off is 409 like every other mutator) -----
    .post('/workspace/notes/:noteId/process', (c) => c.json({ error: NOTES_OFF }, 409))

    .post('/workspace/notes/:noteId/approve', jsonZodValidator(approveNoteInputSchema), (c) =>
      c.json({ error: NOTES_OFF }, 409),
    )

    .post('/workspace/notes/:noteId/reject', jsonZodValidator(rejectNoteInputSchema), (c) =>
      c.json({ error: NOTES_OFF }, 409),
    );
}
