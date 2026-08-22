import { z } from 'zod';

/**
 * Who created a task — the wire twin of `src/runs/task-author.ts` in the server package
 * (spec `.ai/specs/2026-08-21-task-author-provenance.md`).
 *
 * Duplicated deliberately, exactly the way `runRecordSchema` and `todoItemSchema` already are:
 * the server persists its own copy and this one describes what the HTTP surface sends. The
 * twins are pinned to each other by `runs/task-author.test.ts`'s source-text guard — see its own
 * doc comment for why the compile-time parity suite cannot see this pair.
 */

/**
 * The surface a task came through.
 *
 * Every value names a real, existing code path — there is deliberately no `'other'` and no
 * `'unknown'`. A new door has to add a value here, and that added line in the diff is the review
 * moment; a catch-all would let the next creation path ship unattributed while still looking
 * attributed.
 */
export const taskAuthorViaSchema = z.enum([
  /** `POST /api/v1/runs` — the composer. */
  'composer',
  /** `POST /api/v1/workspace/runs` — the composer's Workspace submit. */
  'workspace-composer',
  /** `POST /api/v1/todos/:id/start` — a person clicked ▶ Run on a filed task. */
  'todo-start',
  /** The running cockpit's `autostart` watcher (`todo-autostart.ts`). */
  'todo-autostart',
  /** `cezar run "<task>"` at a terminal. */
  'cli-run',
  /** `cezar todo add` — from inside a run, or from a person's shell. */
  'cli-todo-add',
  /** `POST /api/v1/p/:projectId/todos` — the composer filing a task without starting it. */
  'todo-create-route',
  /** A project GitHub automation (`automations/task-template.ts`). */
  'automation',
  /** A note's proposal approved into a spec run (`notes/approve.ts`). */
  'note-approval',
  /** The autonomous spec→implementation continuation (`notes/continuation.ts`). */
  'note-continuation',
  /** A user report approved into a todo (`server/workspace-reports-routes.ts`). */
  'report-triage',
]);
export type TaskAuthorVia = z.infer<typeof taskAuthorViaSchema>;

/** What kind of actor made the task. `kind: 'agent'` is the one that carries a hard requirement —
 *  see the `.refine` below. */
export const taskAuthorKindSchema = z.enum(['user', 'api', 'agent', 'automation', 'system']);
export type TaskAuthorKind = z.infer<typeof taskAuthorKindSchema>;

/**
 * **`author` is an AUDIT and TRIAGE field, never an authorization input.** On a zero-config local
 * install every human is `'local'`, because there is no identity to record — nothing may gate a
 * decision on this object. It answers "who made this task", not "what may they do".
 *
 * Bounds follow `createRunInputSchema`'s own scale (`./runs.ts`) — the closest sibling shape whose
 * strings reach a spawned process — rather than inventing new limits.
 */
export const taskAuthorSchema = z
  .object({
    kind: taskAuthorKindSchema,
    /** `principal.userId`, or `'local'` on an unauthenticated install (the `approverOf` rule,
     *  `server/server.ts`); the PARENT RUN ID for `'agent'`; the `automationId` for
     *  `'automation'`. */
    id: z.string().min(1).max(200),
    /** Display only. Never used for identity or for counting. */
    label: z.string().min(1).max(200).optional(),
    via: taskAuthorViaSchema,
    /** ISO 8601. Equal to the record's own `createdAt`/`ts` at creation, kept explicit so the
     *  provenance object stays self-contained when it is COPIED between records — a todo's author
     *  is carried onto the run its autostart caused, and must keep naming when the agent acted. */
    at: z.string(),
    /** The cezar task that caused this one. */
    parentTaskId: z.string().min(1).max(200).optional(),
    /** The agent session inside that task — `CEZ_SESSION_ID`. Best-effort by construction on the
     *  Codex/OpenCode backends, which mint their own session id AFTER the child env is built;
     *  `parentStepId` is the identifier that always resolves. */
    agentSessionId: z.string().min(1).max(200).optional(),
    /** The workflow step id — `CEZ_STEP_ID`. Stable across resumes and session re-mints, so it is
     *  authoritative wherever `agentSessionId` can drift. */
    parentStepId: z.string().min(1).max(200).optional(),
  })
  .refine((a) => a.kind !== 'agent' || (Boolean(a.parentTaskId) && Boolean(a.agentSessionId)), {
    message: "author.kind 'agent' requires both parentTaskId and agentSessionId",
    path: ['parentTaskId'],
  });
export type TaskAuthor = z.infer<typeof taskAuthorSchema>;
