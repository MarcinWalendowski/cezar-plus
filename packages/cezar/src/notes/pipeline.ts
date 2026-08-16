import type { ApproveNoteInput, ApproveNoteResponse } from '@loki-labs/better-cezar-contract';
import type { StoredNote } from './types.ts';

/**
 * The seam between the notes ROUTES and the two things a note can set in motion — the triage pass
 * (P2.2) and approval (P2.3). Spec: `.ai/specs/2026-08-14-note-to-spec-pipeline.md`.
 *
 * **Why an interface rather than a direct import.** `./processor.ts` must not reach the run
 * machinery, and `./approve.ts` must — approving is *how* a run gets started, in exactly one
 * target project. Splitting them behind this type keeps that asymmetry visible at the boundary
 * instead of buried, and lets `server/notes-routes.ts` stay a file that knows about a store and
 * nothing else. The route file importing `../workflows/run.ts` transitively is the failure mode
 * this shape exists to make impossible.
 *
 * Both methods answer a discriminated result rather than throwing: an HTTP handler needs a status
 * and a sentence, and deriving those from an exception type is how a 409 turns into a 500.
 */

export type NotePipelineFailure = { ok: false; status: 404 | 409 | 400; error: string };

export interface NotePipeline {
  /**
   * Start a triage pass over one note. Returns as soon as the note is marked `processing` — the
   * pass itself runs in the background, because an agent call can take a minute and a request
   * must not be held open for it (contract: `POST .../process` answers 202).
   */
  process(noteId: string): Promise<{ ok: true; note: StoredNote } | NotePipelineFailure>;

  /**
   * Turn approved proposals into runs, one per proposal, in each proposal's own target project.
   * Partial success is normal and is reported inside a 200 body (`created` / `rejected`), never as
   * a 4xx — a 4xx would make "two of three started" unreadable.
   */
  approve(
    noteId: string,
    input: ApproveNoteInput,
  ): Promise<{ ok: true; body: ApproveNoteResponse } | NotePipelineFailure>;
}
