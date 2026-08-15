import { z } from 'zod';
import { todoItemSchema } from './skills.ts';
import { workspaceProjectHealthSchema } from './workspace-runs.ts';

/**
 * `GET /api/v1/workspace/todos` — the cross-project todo board (D2 of
 * `.ai/specs/2026-08-15-knowledge-grounded-task-fanout.md`, Phase 1): a fan-out that wrote a task
 * into several projects is visible in one place instead of one project's own `/todos` at a time.
 *
 * Same family shape as `./workspace-runs.ts`/`./workspace-knowledge.ts`: `workspaceProjectHealthSchema`
 * is reused as-is rather than re-declared, so a dead or missing project renders identically across
 * every workspace board.
 *
 * **Flag-off shape.** With `CEZ_FOLLOWUPS` or `CEZ_WORKSPACE_VIEWS` unset (or `CEZ_SINGLE_PROJECT=1`,
 * which reports `workspaceViews` false), `GET /workspace/todos` answers 200 with a schema-valid
 * empty payload — never 404. Read-only, so there is no mutator to 409.
 */

/** One todo, stamped with the registry slug of the project it lives in. */
export const workspaceTodoEntrySchema = z.object({
  project: z.string(),
  todo: todoItemSchema,
});
export type WorkspaceTodoEntry = z.infer<typeof workspaceTodoEntrySchema>;

export const workspaceTodosResponseSchema = z.object({
  todos: z.array(workspaceTodoEntrySchema),
  /** One entry per considered project — including a dead one, with `ok: false` and a reason. */
  projects: z.array(workspaceProjectHealthSchema),
});
export type WorkspaceTodosResponse = z.infer<typeof workspaceTodosResponseSchema>;
