import { z } from 'zod';
import { noteRecordSchema } from '@loki-labs/better-cezar-contract';

/**
 * Storage shapes for `~/.cezar/notes.json` (P2.1, spec
 * `.ai/specs/2026-08-14-note-to-spec-pipeline.md`; PLAN D14 puts notes at workspace scope and
 * never inside a project).
 *
 * **`.passthrough()`, deliberately, and only here.** The wire shapes in
 * `@loki-labs/better-cezar-contract` are CLOSED; the stored shape is open, exactly as
 * `automations/types.ts` and `sources/types.ts` are. The reason is version skew on one machine: two
 * cezar builds share one `~/.cezar`, and a closed storage parse would let the older one silently
 * delete a key the newer one wrote every time it rewrote the file. Passthrough makes an unknown key
 * survive a round-trip through a build that has never heard of it.
 *
 * Per-entry salvage rather than all-or-nothing: one unparseable note costs that note, never the
 * inbox. A capture surface that loses every note because one is malformed is worse than useless —
 * the whole point is that a note is somewhere safe until it has been dealt with.
 */

/** The stored note. Open, per the module doc; `noteRecordSchema` is the closed wire twin. */
export const storedNoteSchema = noteRecordSchema.passthrough();
export type StoredNote = z.infer<typeof storedNoteSchema>;

/**
 * The whole file. `version` is a plain integer that nothing branches on today — it exists so that
 * the day something must branch on it, the files already in the wild carry it.
 */
export const notesFileSchema = z
  .object({
    version: z.literal(1).default(1),
    notes: z.array(z.unknown()).default([]),
  })
  .passthrough();
export type NotesFile = z.infer<typeof notesFileSchema>;

/** One line of `notes-log.ndjson` — the append-only pass receipt, on `automations/store.ts`'s
 *  NDJSON-plus-compaction shape rather than a file per note. It is the only place a superseded
 *  pass survives: `note.pass` holds the LATEST pass only, so without this, re-processing a note
 *  would erase the evidence of what the previous pass proposed and why. */
export const noteLogRecordSchema = z
  .object({
    seq: z.number().int(),
    at: z.string(),
    noteId: z.string(),
    event: z.enum(['captured', 'pass', 'approved', 'rejected', 'removed']),
    passId: z.string().optional(),
    /** Free-form, bounded, and never a place to put a note body — a log line is for answering
     *  "what happened and when", and a 100k-character body in an append-only file is a disk leak. */
    detail: z.string().max(2_000).default(''),
  })
  .passthrough();
export type NoteLogRecord = z.infer<typeof noteLogRecordSchema>;
