import { z } from 'zod';
import { taskAuthorSchema } from './task-author.ts';
import { diffStatSchema, runStatusSchema } from './runs.ts';

/**
 * The WORKSPACE RUNS family of `/api/v1/workspace` — a read-only, server-side aggregate over every
 * registered project's `runs.json` (F3/feature A, `CEZ_WORKSPACE_VIEWS=1`). See
 * `.ai/specs/2026-08-06-workspace-notes-cross-project.md`.
 *
 * The read path (`WorkspaceRunIndex`, W1.11) is a read-only PARSER over each project's `runs.json`:
 * it never calls `RunStore.open` or `contexts.context(id)`, because building either would recover
 * and resume interrupted agent runs in every registered project at the moment someone opened a
 * board. Nothing in this contract file changes that; it only describes the shape the parser hands
 * back.
 *
 * **Flag-off shape (D19, D4).** With `CEZ_WORKSPACE_VIEWS` unset (or `CEZ_SINGLE_PROJECT=1`, which
 * reports the capability false), `GET /workspace/runs` answers 200 with a schema-valid empty
 * payload — never 404. This family is read-only, so it has no mutator to 409.
 */

/**
 * Deliberately NOT a narrowing of `runRecordSchema` (Q10): `RunRecord` carries `task` (up to 100k),
 * `queuedMessages`, `steps[]` and `workflowDef`, and 200 of those across projects is megabytes for a
 * table that renders about twenty fields. This is a new shape, so nothing protected moves.
 */
export const workspaceRunSummarySchema = z.object({
  /** Canonical registry slug. The boot project appears under its OWN slug (via
   *  `resolveBootProject()`), never the reserved `'default'` alias. */
  project: z.string(),
  /** A WORKSPACE RUN — the same marker `runIndexEntrySchema.workspace` carries, derived from the
   *  same `RunRecord.workspaceProjects`, so both cross-project boards render the same chip from
   *  one definition. Qualifies `project` rather than replacing it; see that field's own note. */
  workspace: z.boolean().optional(),
  id: z.string(),
  title: z.string(),
  titleSummary: z.string().optional(),
  workflow: z.string(),
  status: runStatusSchema,
  activity: z.literal('monitoring').optional(),
  /** Why a `review` run stopped, when it was not the ordinary diff-first review gate (#489) —
   *  PLAN D27, Phase 1/3. Mirrors `RunRecord.stopReason`; carried here for the same reason
   *  `runIndexEntrySchema` (`runs.ts`) carries it — `deriveAttention` reads it, and without it a
   *  budget-parked run on this board reads as a plain, unremarkable `review`. */
  stopReason: z.enum(['budget', 'inactivity']).optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  diffStat: diffStatSchema.optional(),
  branch: z.string().optional(),
  /** Who created the task (`.ai/specs/2026-08-21-task-author-provenance.md`, Phase 4).
   *  Carried on BOTH board shapes deliberately — `run-index.ts` already notes that the two
   *  boards must not drift, and a provenance column that exists on one of them is exactly
   *  that drift. Absent on runs created before the field existed. */
  author: taskAuthorSchema.optional(),
  groupId: z.string().optional(),
  variant: z.string().optional(),
  archived: z.boolean().optional(),
  seenAt: z.string().optional(),
  tokensUsed: z.number().optional(),
  costUsd: z.number().optional(),
  pullRequestUrl: z.string().optional(),
  prNumber: z.number().optional(),
  issueNumber: z.number().optional(),
  error: z.string().optional(),
  autoResumeAt: z.string().optional(),
  monitoringWakeAt: z.string().optional(),
  /** Derived at READ TIME by joining the note store against this run's id — NOT persisted on the
   *  run itself (Q5): `RunRecord` and `runs.json` gain no field for this feature. */
  noteId: z.string().optional(),
});
export type WorkspaceRunSummary = z.infer<typeof workspaceRunSummarySchema>;

/** Per-project health, so a dead or missing project is RENDERED in the board, never silently
 *  absent — an unreadable `runs.json` degrades to `ok: false` plus a reason and zero rows, never a
 *  5xx for the whole request. */
export const workspaceProjectHealthSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['ok', 'missing', 'not-git', 'no-commits']),
  ok: z.boolean(),
  reason: z.string().optional(),
  total: z.number().int(),
});
export type WorkspaceProjectHealth = z.infer<typeof workspaceProjectHealthSchema>;

/**
 * `GET /workspace/runs`. Every field here is a stored value or a stored timestamp — no
 * clock-derived field rides this body (D8): `route-parity.test.ts` issues the same GET three times
 * and compares bytes, so an age computed at request time would be a flaky red gate.
 */
export const workspaceRunsResponseSchema = z.object({
  runs: z.array(workspaceRunSummarySchema),
  projects: z.array(workspaceProjectHealthSchema),
  truncated: z.boolean(),
  bootProject: z.string(),
});
export type WorkspaceRunsResponse = z.infer<typeof workspaceRunsResponseSchema>;
