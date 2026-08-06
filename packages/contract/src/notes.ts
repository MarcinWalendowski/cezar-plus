import { z } from 'zod';
import { runnerSchema } from './health.ts';

/**
 * The NOTES family of `/api/v1/workspace` — a workspace-scoped capture inbox (`~/.cezar/notes.json`,
 * never inside a repo) drained by ONE agent pass that proposes N tasks across N registered projects,
 * behind a human review gate that is the only path to creation (F3/feature B, `CEZ_NOTES=1`). See
 * `.ai/specs/2026-08-06-workspace-notes-cross-project.md` and the plan's D13/D14 (a note is not a
 * run, and it lives at workspace scope, never inside a project).
 *
 * As with `./automations.ts`, the storage schema (`packages/cezar/src/notes/types.ts`, P2.1) is
 * `.passthrough()`; these are the CLOSED wire shapes.
 *
 * **Flag-off shape (D19, D4).** With `CEZ_NOTES` unset every `GET` answers 200 with a schema-valid
 * empty payload and every mutator answers 409 — never 404.
 */

export const noteStatusSchema = z.enum(['raw', 'processing', 'processed', 'failed']);
export type NoteStatus = z.infer<typeof noteStatusSchema>;

/** Closed today; `'watch'` is added additively later if a drop-directory watcher ships. */
export const noteSourceSchema = z.enum(['cockpit', 'cli', 'api']);
export type NoteSource = z.infer<typeof noteSourceSchema>;

export const proposalDecisionSchema = z.enum(['pending', 'approved', 'rejected']);
export type ProposalDecision = z.infer<typeof proposalDecisionSchema>;

export const proposalIssueSchema = z.enum([
  /** The pass named a project not in the supplied catalog — defaults to rejected, never coerced. */
  'unknown-project',
  /** Registered, but its folder is gone. */
  'missing-root',
  /** Falls back to `quick-task` on approval. */
  'unknown-workflow',
  /** Cannot host a worktree proposal. */
  'not-git',
  /** `agentModelsLocked(root)` refuses the proposed model. */
  'models-locked',
]);
export type ProposalIssue = z.infer<typeof proposalIssueSchema>;

/**
 * One task the pass proposes, targeted at exactly one registry slug. There is deliberately NO
 * `variants` key (Q9): three projects times three variants from one click is nine agent runs from
 * one approval, and a schema that cannot express it is a stronger guard than a validation rule.
 */
export const noteProposalSchema = z.object({
  /** Stable within the pass, not globally. */
  id: z.string().min(1),
  /** The TARGET registry slug — the whole point of the row. */
  projectId: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  task: z.string().min(1).max(100_000),
  skill: z.string().max(200).optional(),
  workflow: z.string().max(200).optional(),
  runner: runnerSchema.optional(),
  model: z.string().max(200).optional(),
  agentProfile: z.string().max(200).optional(),
  rationale: z.string().max(2_000).default(''),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  /** A row carrying this defaults to REJECTED in the review screen. */
  duplicateOf: z
    .object({
      projectId: z.string(),
      runId: z.string().optional(),
      title: z.string(),
      reason: z.string().max(500),
    })
    .optional(),
  issues: z.array(proposalIssueSchema).default([]),
  decision: proposalDecisionSchema.default('pending'),
  /** First-wins guard (`markProposalCreated`, ported from `todos.ts`'s `markStarted`): written
   *  only by approve, under the store's own lock. */
  createdRunId: z.string().optional(),
});
export type NoteProposal = z.infer<typeof noteProposalSchema>;

/**
 * One agent pass over a note, run against the whole board (`WorkspaceRunIndex.digest`) so dedupe is
 * a prompt shape and not a per-line loop. `fallback: true` means the pass degraded to a single
 * whole-note proposal (`planChain`'s own degradation) rather than erroring — it never blocks, and
 * zero proposals is a valid successful pass.
 */
export const notePassSchema = z.object({
  id: z.string().min(1),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  runner: runnerSchema,
  model: z.string().optional(),
  summary: z.string().max(4_000).default(''),
  proposals: z.array(noteProposalSchema).max(12),
  unassigned: z.array(z.object({ text: z.string().max(2_000), reason: z.string().max(500) })).default([]),
  fallback: z.boolean(),
  truncated: z.boolean().default(false),
  /** Registry slugs actually considered (capped at 25 by `lastOpenedAt`) — persisted and shown so
   *  "why did it miss the duplicate?" stays answerable rather than mysterious. */
  consideredProjects: z.array(z.string()),
  boardDigestSize: z.number().int(),
  error: z.string().max(1_000).optional(),
});
export type NotePass = z.infer<typeof notePassSchema>;

export const noteRecordSchema = z.object({
  id: z.string().min(1),
  capturedAt: z.string(),
  source: noteSourceSchema,
  /** Shortcut name, filename, or script id — whatever the capture surface calls itself. */
  sourceRef: z.string().max(200).optional(),
  body: z.string().min(1).max(100_000),
  status: noteStatusSchema,
  title: z.string().max(200),
  titleOrigin: z.enum(['user', 'auto']),
  /** ADVISORY ONLY (Q3): never a default target, never a silent fallback — overrulable by the pass
   *  and by the review screen's per-row project picker. */
  projectHint: z.string().max(64).optional(),
  processedAt: z.string().optional(),
  /** The LATEST pass only; pass history lives in `notes-log.ndjson`, not on the record. */
  pass: notePassSchema.optional(),
  resultingTasks: z
    .array(
      z.object({
        proposalId: z.string(),
        projectId: z.string(),
        runId: z.string(),
        createdAt: z.string(),
      }),
    )
    .default([]),
  archived: z.boolean().optional(),
  archivedAt: z.string().optional(),
});
export type NoteRecord = z.infer<typeof noteRecordSchema>;

/** List row. Body trimmed to a 280-char excerpt so a 100k-char note never rides the list. */
export const noteSummarySchema = noteRecordSchema.omit({ body: true, pass: true }).extend({
  excerpt: z.string(),
  proposalCount: z.number().int(),
  targetProjects: z.array(z.string()),
});
export type NoteSummary = z.infer<typeof noteSummarySchema>;

// ---- responses -----------------------------------------------------------------------------

/** `GET /workspace/notes`. Flag off (D19) answers `{notes: [], truncated: false}`, never 404. */
export const notesListResponseSchema = z.object({
  notes: z.array(noteSummarySchema),
  truncated: z.boolean(),
});
export type NotesListResponse = z.infer<typeof notesListResponseSchema>;

/**
 * `POST /workspace/notes` (201), `GET`/`PATCH /workspace/notes/:noteId`. On the GET, flag off
 * answers `{note: null}` (200) so a 404 keeps meaning "no such note", never "no such feature", once
 * the flag is on.
 */
export const noteResponseSchema = z.object({ note: noteRecordSchema.nullable() });
export type NoteResponse = z.infer<typeof noteResponseSchema>;

export const noteRemovedResponseSchema = z.object({ removed: z.literal(true) });
export type NoteRemovedResponse = z.infer<typeof noteRemovedResponseSchema>;

/** `POST /workspace/notes/:noteId/process` — 202, creates nothing, ever. The pass runs in the
 *  background; an agent call up to 90s must not hold a request open. */
export const processNoteResponseSchema = z.object({ note: noteRecordSchema });
export type ProcessNoteResponse = z.infer<typeof processNoteResponseSchema>;

/**
 * `POST /workspace/notes/:noteId/approve` — all-or-nothing PER proposal, partial ACROSS proposals,
 * reported in one 200 body so partial success stays readable (a 4xx would make it unreadable). A
 * rejected row stays `pending` so the user can fix it and re-approve.
 */
export const approveNoteResponseSchema = z.object({
  note: noteRecordSchema,
  created: z.array(z.object({ proposalId: z.string(), projectId: z.string(), runId: z.string() })),
  rejected: z.array(
    z.object({
      proposalId: z.string(),
      projectId: z.string().optional(),
      status: z.union([z.literal(404), z.literal(409), z.literal(400)]),
      error: z.string(),
    }),
  ),
});
export type ApproveNoteResponse = z.infer<typeof approveNoteResponseSchema>;

// ---- request bodies ------------------------------------------------------------------------
//
// `z.input`, like every other request type in this package: a caller writes what the schema
// ACCEPTS.

/** `POST /workspace/notes` — THE single write path. Cockpit textarea, phone Shortcut and webhook
 *  all use this route; same-origin guarded, never CORS-open. */
export const createNoteInputSchema = z.object({
  body: z.string().min(1).max(100_000),
  source: noteSourceSchema.optional(),
  sourceRef: z.string().max(200).optional(),
  projectHint: z.string().max(64).optional(),
});
export type CreateNoteInput = z.input<typeof createNoteInputSchema>;

export const updateNoteInputSchema = z.object({
  title: z.string().max(200).optional(),
  body: z.string().min(1).max(100_000).optional(),
  /** `null` clears the hint; an absent key leaves it unchanged. */
  projectHint: z.string().max(64).nullable().optional(),
  archived: z.boolean().optional(),
});
export type UpdateNoteInput = z.input<typeof updateNoteInputSchema>;

/** One row inside `approve`'s body — an edit overrides the pass's own proposal for that id. */
export const approveNoteProposalInputSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1).max(64).optional(),
  title: z.string().min(1).max(200).optional(),
  task: z.string().min(1).max(100_000).optional(),
  workflow: z.string().max(200).optional(),
  skill: z.string().max(200).optional(),
  runner: runnerSchema.optional(),
  model: z.string().max(200).optional(),
  agentProfile: z.string().max(200).optional(),
});
export type ApproveNoteProposalInput = z.input<typeof approveNoteProposalInputSchema>;

export const approveNoteInputSchema = z.object({
  /** 409s when this is not the note's CURRENT pass — what a re-process in another tab produces. */
  passId: z.string().min(1),
  proposals: z.array(approveNoteProposalInputSchema).min(1).max(12),
});
export type ApproveNoteInput = z.input<typeof approveNoteInputSchema>;

export const rejectNoteInputSchema = z.object({
  proposals: z.array(z.string().min(1)).min(1),
});
export type RejectNoteInput = z.input<typeof rejectNoteInputSchema>;
