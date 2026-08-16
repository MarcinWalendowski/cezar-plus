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
 * **CORRECTED 2026-08-15 — this route is not flag-gated at all.** The paragraph below said an
 * install with `CEZ_FOLLOWUPS` / `CEZ_WORKSPACE_VIEWS` unset gets "a schema-valid empty payload".
 * D7a made that false: both flags are off on a default install and the composer files through
 * these same todo stores, so an empty answer would have hidden the user's own filed work on
 * exactly the installs the fan-out serves. The route answers with the real todos regardless of
 * either flag, which is what the Tasks board's Filed section reads
 * (`web/src/routes/global-tasks.tsx`). `CEZ_FOLLOWUPS` still gates **generation** — whether agents
 * are asked to leave follow-ups — and nothing else.
 *
 * Superseded text, kept for the reader who remembers it: *"**Flag-off shape.** With
 * `CEZ_FOLLOWUPS` or `CEZ_WORKSPACE_VIEWS` unset (or `CEZ_SINGLE_PROJECT=1`, which reports
 * `workspaceViews` false), `GET /workspace/todos` answers 200 with a schema-valid empty payload —
 * never 404."* Still true and unchanged: it is read-only, so there is no mutator to 409, and it
 * never 404s.
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
