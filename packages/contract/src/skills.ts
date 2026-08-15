import { z } from 'zod';
// `StartTodoResponse` embeds a whole run record, which belongs to the runs slice.
import { runRecordSchema } from './runs.ts';

// ---- skills (`GET /skills`, `POST /skills/refresh`) ---------------------------------------

/**
 * One discovered skill: repo (`.ai/skills`, `.ai/cezar/skills`), `npx skills` install dirs
 * (project + global), or a configured team skills repo (spec 005).
 */
export const skillSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  /** Advisory hint for untouched composer run-mode choices. */
  interactive: z.literal(true).optional(),
  body: z.string(),
  path: z.string(),
  source: z.enum(['ai', 'cezar', 'agents', 'global', 'team']),
  /** Team skills only: where the definition lives in its skills repo. */
  team: z
    .object({
      repo: z.string(),
      ref: z.string(),
      path: z.string(),
      /** True for the `SKILL.md` convention — a whole directory (references/…). */
      dir: z.boolean(),
      /**
       * The exact commit `ref` resolved to when the skill was read (#428).
       *
       * The hand-written DTO omitted this field entirely — it was NARROWER than the route,
       * which has served it since #428.
       */
      commit: z.string().optional(),
    })
    .optional(),
});
export type Skill = z.infer<typeof skillSchema>;

/**
 * One row in the "Manage skills" panel — a skill a default (vendor) repo offers, from
 * `GET /skills/importable`, independent of whether it is currently kept.
 *
 * `description` is optional because that is what the WIRE says: the handler builds
 * `{ name, description: skill.description }` and `JSON.stringify` omits an undefined value, so
 * a description-less skill is serialized as `{ "name": "…" }`. The route's own type disagrees
 * (it claims the key is always present) — a handler defect, see
 * `contract-parity.workflows.test.ts`.
 */
export const importableSkillSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});
export type ImportableSkill = z.infer<typeof importableSkillSchema>;

// ---- follow-up inbox / todos (spec 007) ---------------------------------------------------

/** One citation a task-fan-out spec was grounded in (D4 of `2026-08-15-knowledge-grounded-task-
 *  fanout.md`): title/slug/project only, matching what `GET /workspace/knowledge/search` itself
 *  hands back — never a document body. */
export const todoKnowledgeRefSchema = z.object({
  project: z.string().min(1).max(64),
  slug: z.string().min(1).max(500),
  title: z.string().min(1).max(300),
});
export type TodoKnowledgeRef = z.infer<typeof todoKnowledgeRefSchema>;

/** One entry of `.ai/cezar/todos.json`, as `GET /todos` serves it (ids are backfilled on read). */
export const todoItemSchema = z.object({
  id: z.string(),
  ts: z.string().optional(),
  taskId: z.string().optional(),
  summary: z.string().min(1),
  action: z.string().optional(),
  prUrl: z.string().optional(),
  suggestedSkill: z.string().optional(),
  suggestedArgs: z.string().optional(),
  suggestedPrompt: z.string().optional(),
  /** Explicit intent; missing infers from suggestedSkill/suggestedPrompt for old files. */
  runnable: z.boolean().optional(),
  /** Set once a task was started from this entry — it then leaves the inbox and stays as
   *  the audit trail. A later launch never overwrites the first. */
  startedTaskId: z.string().optional(),
  // ---- structured spec (2026-08-15-knowledge-grounded-task-fanout.md, D2/D4) -----------------
  // All five additive and optional: an agent's plain append (`FOLLOWUP_INSTRUCTIONS` in
  // `handoff.ts`) carries none of them and still validates unchanged. Bounds follow
  // `createRunInputSchema`'s own scale (`runs.ts`) — the closest sibling shape whose strings
  // reach a spawned process — rather than inventing new limits.
  /** Why this exists, what it extends. */
  context: z.string().max(20_000).optional(),
  /** The work itself. */
  whatToDo: z.string().max(100_000).optional(),
  /** Checkable statements. */
  acceptanceCriteria: z.array(z.string().min(1).max(500)).max(20).optional(),
  /** What grounded it — see `todoKnowledgeRefSchema`. */
  knowledgeRefs: z.array(todoKnowledgeRefSchema).max(20).optional(),
  /** Which writer created it. */
  origin: z.enum(['agent', 'composer']).optional(),
});
export type TodoItem = z.infer<typeof todoItemSchema>;

/**
 * `POST /:projectId/todos` — the create route (2026-08-15-knowledge-grounded-task-fanout.md,
 * Phase 1): everything a caller may specify, `id`/`ts`/`taskId`/`startedTaskId` withheld because
 * they are server- or agent-assigned, never client-supplied. Built by `.omit()` off the wire
 * item itself so the two shapes can never drift apart field-by-field.
 */
export const createTodoInputSchema = todoItemSchema.omit({
  id: true,
  ts: true,
  taskId: true,
  startedTaskId: true,
});
export type CreateTodoInput = z.infer<typeof createTodoInputSchema>;

/** `POST /:projectId/todos` — 201 with the stored todo. */
export const createTodoResponseSchema = z.object({
  todo: todoItemSchema,
});
export type CreateTodoResponse = z.infer<typeof createTodoResponseSchema>;

/**
 * `DELETE /todos/:id` — Dismiss checks the entry off.
 *
 * `removed` is the LITERAL `true`: a miss is a 404 `{ error }`, never `{ removed: false }`.
 * The hand-written DTO said `boolean`, which was wider than the route.
 */
export const removeTodoResponseSchema = z.object({
  removed: z.literal(true),
});
export type RemoveTodoResponse = z.infer<typeof removeTodoResponseSchema>;

/** `POST /todos/:id/start` — 201 with the run the entry became. */
export const startTodoResponseSchema = z.object({
  run: runRecordSchema,
});
export type StartTodoResponse = z.infer<typeof startTodoResponseSchema>;
