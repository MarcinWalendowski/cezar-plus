import { z } from 'zod';
// `StartTodoResponse` embeds a whole run record, which belongs to the runs slice.
import { runRecordSchema } from './runs.ts';
import { taskAuthorSchema } from './task-author.ts';

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
  // ---- statuses, priority, archive (2026-08-17-filed-tasks-table-statuses.md) ----------------
  // Additive and optional, like the five below: an agent's plain append carries none of them and
  // still validates unchanged. Absent `status` reads as `'todo'` (the Filed table's own default,
  // not a value written here).
  status: z.enum(['todo', 'in-progress', 'blocked', 'done']).optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
  /** Set by the archive action; an archived entry leaves the Active board. Server-stamped. */
  archivedAt: z.string().optional(),
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
  // ---- autostart (2026-08-19-file-tasks-from-a-running-task.md, Phase 2) ---------------------
  // Additive and optional, like the fields above: an entry with none of them still validates
  // unchanged. Set only by `cezar todo add --start`; cleared server-side the moment the entry
  // becomes a run, so it is never true at the same time as `startedTaskId`.
  /** File this todo AS a run the moment the running cockpit notices it, instead of waiting for a
   *  person to click ▶ Run. */
  autostart: z.boolean().optional(),
  // ---- author (2026-08-21-task-author-provenance.md, Phase 3) --------------------------------
  /**
   * Who filed this task, stamped at creation and never rewritten. Server-stamped: it joins
   * `archivedAt` in `createTodoInputSchema`'s `.omit()` below, and `updateTodoInputSchema` does
   * not carry it, so no route can set OR rewrite an author.
   *
   * Optional like every field above it, and for the same reason twice over: an agent's plain
   * append (`FOLLOWUP_INSTRUCTIONS` in `handoff.ts`) carries none of them, and neither does any
   * entry written before 2026-08-21. Both read as "unknown", which is the honest answer.
   */
  author: taskAuthorSchema.optional(),
});
export type TodoItem = z.infer<typeof todoItemSchema>;

/**
 * `POST /:projectId/todos` — the create route (2026-08-15-knowledge-grounded-task-fanout.md,
 * Phase 1): everything a caller may specify, `id`/`ts`/`taskId`/`startedTaskId` withheld because
 * they are server- or agent-assigned, never client-supplied. Built by `.omit()` off the wire
 * item itself so the two shapes can never drift apart field-by-field.
 *
 * `archivedAt` joined the omit list with the filed-tasks table (2026-08-17-filed-tasks-table-
 * statuses.md): it is stamped by the archive action, never client-supplied on create. `status`
 * and `priority` stay creatable — a caller may file a task as already `blocked`, say.
 */
export const createTodoInputSchema = todoItemSchema.omit({
  id: true,
  ts: true,
  taskId: true,
  startedTaskId: true,
  archivedAt: true,
  // `author` joined the omit list with 2026-08-21-task-author-provenance, for exactly the reason
  // `archivedAt` gives: it is stamped server-side, never client-supplied. An author a caller can
  // set is forgeable, and a forgeable author is not provenance — see the field's doc comment.
  author: true,
});
export type CreateTodoInput = z.infer<typeof createTodoInputSchema>;

/** `POST /:projectId/todos` — 201 with the stored todo. */
export const createTodoResponseSchema = z.object({
  todo: todoItemSchema,
});
export type CreateTodoResponse = z.infer<typeof createTodoResponseSchema>;

/**
 * `PATCH /:projectId/todos/:id` (2026-08-17-filed-tasks-table-statuses.md) — the Filed table's
 * status/priority edits and its Archive/Restore action, all sharing one route rather than three.
 * At least one key required (`.refine`): a body with none would be a 200 that changed nothing,
 * which is worse than rejecting it — the `updateProjectInputSchema` precedent (`projects.ts`).
 *
 * `archived: true` stamps `archivedAt`; `false` REMOVES the key rather than writing an explicit
 * `null`/`undefined` — every reader (`GET /workspace/todos`'s Archived split, the Filed table)
 * keys on the field being ABSENT, the `seenAt` precedent (`runs/store.ts`).
 */
export const updateTodoInputSchema = z
  .object({
    status: z.enum(['todo', 'in-progress', 'blocked', 'done']).optional(),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    archived: z.boolean().optional(),
  })
  .refine(
    (body) => body.status !== undefined || body.priority !== undefined || body.archived !== undefined,
    'specify status, priority or archived',
  );
export type UpdateTodoInput = z.infer<typeof updateTodoInputSchema>;

/** `PATCH /:projectId/todos/:id` — 200 with the stored todo. */
export const updateTodoResponseSchema = z.object({
  todo: todoItemSchema,
});
export type UpdateTodoResponse = z.infer<typeof updateTodoResponseSchema>;

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
