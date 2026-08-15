import { z } from 'zod';
import { todoKnowledgeRefSchema } from './skills.ts';

/**
 * `POST /api/v1/workspace/task-fanout` (`.ai/specs/2026-08-15-knowledge-grounded-task-fanout.md`,
 * D1/D3) — the composer's All / Auto submit path: one input, split into distinct work items
 * (Phase A), each grounded against that project's knowledge base and written as a todo (Phase B).
 *
 * Workspace-level, like `./workspace-todos.ts` and `./workspace-knowledge.ts` — never
 * `/p/:projectId`-prefixed, because the whole point is deciding WHICH project(s) before anything
 * is scoped to one.
 *
 * D5: nothing here starts a run. The response names what was FILED; `POST /todos/:id/start`
 * (unchanged) is the existing path a human takes from a board afterward.
 */

/** `input` is bounded exactly like `createRunInputBaseSchema.task` (`./runs.ts`) — the closest
 *  sibling shape whose text reaches a spawned process, once someone starts what this files. */
export const taskFanoutInputSchema = z.object({
  input: z.string().min(1).max(100_000, 'must be at most 100000 characters'),
  /**
   * Which projects Phase A may file into. `'auto'` (the default, and what an omitted value
   * means) lets the pass choose from the full catalog; `'all'` considers every registered
   * project regardless of relevance; an explicit list restricts it to those ids.
   */
  targets: z
    .union([
      z.literal('auto'),
      z.literal('all'),
      z.array(z.string().min(1).max(64)).min(1).max(25),
    ])
    .optional(),
});
export type TaskFanoutInput = z.input<typeof taskFanoutInputSchema>;

/** One work item Phase A split out and Phase B specified — a todo that now exists. */
export const taskFanoutItemSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  todoId: z.string(),
  title: z.string(),
  /** What grounded it (D4). Empty means Phase B found nothing relevant via lexical search —
   *  the UI renders that as "not grounded", never as an absent list (Verification table). */
  knowledgeRefs: z.array(todoKnowledgeRefSchema),
});
export type TaskFanoutItem = z.infer<typeof taskFanoutItemSchema>;

/** A work item Phase A could not file anywhere — named and reasoned, never silently dropped. */
export const taskFanoutUnassignedSchema = z.object({
  title: z.string(),
  reason: z.string(),
});
export type TaskFanoutUnassigned = z.infer<typeof taskFanoutUnassignedSchema>;

/** `POST /api/v1/workspace/task-fanout`. */
export const taskFanoutResponseSchema = z.object({
  items: z.array(taskFanoutItemSchema),
  unassigned: z.array(taskFanoutUnassignedSchema),
  /** The item-count cap (Risks: "N needs a cap, and the cap needs to be said out loud") was hit
   *  — rendered, never silent. */
  truncated: z.boolean(),
});
export type TaskFanoutResponse = z.infer<typeof taskFanoutResponseSchema>;
