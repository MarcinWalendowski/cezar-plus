import { z } from 'zod';

/**
 * Who created a task — the PERSISTED twin of `contract/src/task-author.ts`, plus the constructors
 * every creation site builds one with (spec `.ai/specs/2026-08-21-task-author-provenance.md`).
 *
 * Duplicated the same way `runRecordSchema` and `todoSchema` already are: this copy is what
 * `runs.json`/`todos.json` are validated against, the contract copy is what the HTTP surface
 * describes, and `./task-author.test.ts` pins the two to each other.
 *
 * **The enforcement is not this schema.** `author` is OPTIONAL wherever it is persisted, because
 * every record written before 2026-08-21 lacks it and rejecting those would be a breaking change
 * (`BACKWARD_COMPATIBILITY.md` §3). What makes "every task has an author" true is the INPUT type:
 * `RunStore.createRun`, `RunManager.startRun` and `createTodo` all take `author` as a REQUIRED
 * argument, so a creation path that names none does not compile. There is no default and no
 * fallback on purpose — a default is exactly what would let a real path ship unattributed.
 */

/** See the wire twin's doc comment: every value names a real code path, and there is deliberately
 *  no `'other'`/`'unknown'` — a new door must add a line here, which is the review moment. */
export const taskAuthorViaSchema = z.enum([
  'composer',
  'workspace-composer',
  'todo-start',
  'todo-autostart',
  'cli-run',
  'cli-todo-add',
  'todo-create-route',
  'automation',
  'note-approval',
  'note-continuation',
  'report-triage',
  'cluster-dispatch',
]);
export type TaskAuthorVia = z.infer<typeof taskAuthorViaSchema>;

export const taskAuthorKindSchema = z.enum(['user', 'api', 'agent', 'automation', 'system']);
export type TaskAuthorKind = z.infer<typeof taskAuthorKindSchema>;

/** **Audit and triage only — never an authorization input.** See the wire twin. */
export const taskAuthorSchema = z
  .object({
    kind: taskAuthorKindSchema,
    id: z.string().min(1).max(200),
    label: z.string().min(1).max(200).optional(),
    via: taskAuthorViaSchema,
    at: z.string(),
    parentTaskId: z.string().min(1).max(200).optional(),
    agentSessionId: z.string().min(1).max(200).optional(),
    parentStepId: z.string().min(1).max(200).optional(),
  })
  .refine((a) => a.kind !== 'agent' || (Boolean(a.parentTaskId) && Boolean(a.agentSessionId)), {
    message: "author.kind 'agent' requires both parentTaskId and agentSessionId",
    path: ['parentTaskId'],
  });
export type TaskAuthor = z.infer<typeof taskAuthorSchema>;

// ---- the constructors ------------------------------------------------------------------------
// Every creation site goes through one of these rather than writing the object literal itself, so
// the `kind`/`id` pairing is decided once, here. They are the reason a required field costs each
// call site one line instead of five.

/** `'local'` is an honest single identity for an unauthenticated deployment: one machine, one
 *  actor. Lifted verbatim from `approverOf`'s reasoning (`server/server.ts`), which answers the
 *  same question for approvals — see its doc comment. */
export const LOCAL_ACTOR_ID = 'local';

/** The subset of a request this module reads. Duck-typed rather than a hono `Context` so `runs/`
 *  keeps no dependency on the server layer — `server/request-author.ts` is the adapter. */
export interface RequestActor {
  /** The resolved principal, when the route sits behind the principal middleware. */
  principal?: { readonly kind: 'local' | 'session'; readonly userId: string } | undefined;
  /** Case-insensitive request-header reader (`c.req.header`). */
  header: (name: string) => string | undefined;
}

/**
 * A `user` or an `api` author for an HTTP creation route.
 *
 * **Telling the two apart is the one genuinely novel decision here**, because both arrive at the
 * same routes behind the same principal middleware and, on the default zero-config install, both
 * resolve to the same `local` principal. So the discriminator is the REQUEST, not the principal:
 *
 * - a signed-in principal (`kind: 'session'`, including the supervisor's forwarded assertion) is a
 *   person, full stop — that is what a session IS;
 * - otherwise, browser fetch metadata (`Sec-Fetch-Site: same-origin`/`same-site`) or an `Origin`
 *   the origin guard already accepted means the cockpit, i.e. a `user`;
 * - anything else — `curl`, a script, the api-client from Node, a machine bearer — is `api`.
 *
 * **Its failure mode, stated rather than hidden:** a `fetch()` typed into the browser devtools
 * console reads as `user`. That is accepted — it *is* the user's own browser — and the only
 * alternative, letting the client supply its own `author`, is forgeable, which is strictly worse.
 * `author` is never read off a request body on any route.
 */
export function authorFromRequest(req: RequestActor, via: TaskAuthorVia): TaskAuthor {
  const at = new Date().toISOString();
  const principal = req.principal;
  if (principal?.kind === 'session') {
    return { kind: 'user', id: principal.userId, via, at };
  }
  const id = principal?.userId ?? LOCAL_ACTOR_ID;
  const fetchSite = req.header('sec-fetch-site')?.toLowerCase();
  const fromBrowser =
    fetchSite === 'same-origin' || fetchSite === 'same-site' || Boolean(req.header('origin'));
  return { kind: fromBrowser ? 'user' : 'api', id, via, at };
}

/**
 * The author for something a CHILD PROCESS of a running agent step created — `cezar todo add`
 * from inside a run being the whole point of it.
 *
 * `CEZ_TASK_ID` alone is not enough: the owner's third requirement is the parent task AND the
 * agent session, and the schema's `.refine` makes a half-answer invalid rather than merely
 * incomplete. So an `agent` author is claimed only when both ids are present — which, since
 * `agentEnvForStep` exports `CEZ_SESSION_ID` alongside `CEZ_STEP_ID`, is every agent step of a
 * current cezar.
 *
 * When they are not (a person typing `cezar todo add` in their own terminal, or a child of an
 * OLDER cezar that never exported the session), this falls back to the local user rather than
 * claiming an agent identity it cannot name — and still records `parentTaskId` when it has one,
 * because a fact you have is worth keeping even when it is not the whole answer.
 */
export function authorFromAgentEnv(env: NodeJS.ProcessEnv, via: TaskAuthorVia): TaskAuthor {
  const at = new Date().toISOString();
  const parentTaskId = env.CEZ_TASK_ID?.trim();
  const agentSessionId = env.CEZ_SESSION_ID?.trim();
  const parentStepId = env.CEZ_STEP_ID?.trim();
  if (parentTaskId && agentSessionId) {
    return {
      kind: 'agent',
      id: parentTaskId,
      via,
      at,
      parentTaskId,
      agentSessionId,
      ...(parentStepId ? { parentStepId } : {}),
    };
  }
  return {
    kind: 'user',
    id: LOCAL_ACTOR_ID,
    via,
    at,
    ...(parentTaskId ? { parentTaskId } : {}),
    ...(parentStepId ? { parentStepId } : {}),
  };
}

/**
 * Carry a filed todo's author onto the run its AUTOSTART caused.
 *
 * Inheritance, not re-derivation: no human acted, so the agent that filed the todo is the author
 * of the run it caused. `at` is deliberately kept verbatim — it names when that actor acted, and
 * re-stamping it to "now" would quietly turn the provenance into a timestamp of the machinery.
 * Only `via` changes, to the door this record actually came through.
 *
 * A legacy todo carrying no author at all degrades to `systemAuthor`: cezar has no evidence about
 * who filed it, and `system` says that honestly where a guess would not.
 */
export function inheritAuthor(author: TaskAuthor | undefined, via: TaskAuthorVia): TaskAuthor {
  return author ? { ...author, via } : systemAuthor(via);
}

/**
 * A project GitHub automation. `id` is the `automationId`; `RunRecord.automation`
 * (`runs/store.ts`) keeps carrying the receipt/revision/event detail exactly as it always has, so
 * this is a POINTER to that object, not a migration of it.
 *
 * That object is applied as a post-creation `updateRun` patch, which is precisely why `author`
 * goes in the constructor instead: a patch after the fact can be skipped, and the whole point of
 * this field is that it cannot be.
 */
export function automationAuthor(automationId: string, via: TaskAuthorVia = 'automation'): TaskAuthor {
  return { kind: 'automation', id: automationId, via, at: new Date().toISOString() };
}

/**
 * A run that another RUN caused, built in-process rather than from a child's env — the notes
 * spec→implementation continuation being the case it exists for.
 *
 * `sessionId` is optional here and the return kind depends on it, because the schema's `.refine`
 * makes an `agent` author without a session INVALID, not merely incomplete. A parent whose steps
 * never carried a session id (it failed before spawning anything) therefore yields a `system`
 * author that still names `parentTaskId` — cezar did cause this run, and saying so is honest where
 * claiming an agent session that does not exist would not be.
 */
export function agentAuthor(
  parent: { taskId: string; sessionId?: string | undefined; stepId?: string | undefined },
  via: TaskAuthorVia,
): TaskAuthor {
  const at = new Date().toISOString();
  const parentStepId = parent.stepId ? { parentStepId: parent.stepId } : {};
  if (parent.sessionId) {
    return {
      kind: 'agent',
      id: parent.taskId,
      via,
      at,
      parentTaskId: parent.taskId,
      agentSessionId: parent.sessionId,
      ...parentStepId,
    };
  }
  return { kind: 'system', id: 'cezar', via, at, parentTaskId: parent.taskId, ...parentStepId };
}

/** Cezar itself, with no external actor behind the record. Deliberately the narrowest kind, so an
 *  implementation reaching for it lazily stands out in a grep. */
export function systemAuthor(via: TaskAuthorVia): TaskAuthor {
  return { kind: 'system', id: 'cezar', via, at: new Date().toISOString() };
}

/**
 * A person at their own terminal — `cezar run`, and `cezar todo add` outside any agent env.
 *
 * This is the spec's `LOCAL_CLI_AUTHOR` fixture, spelled as a FUNCTION because `at` has to be the
 * real creation time in production. Tests constructing runs use this same call: it is a true
 * statement about a headless `cezar run`, not a test-only escape hatch — which is why no `'test'`
 * value was added to the `via` enum.
 */
export function localCliAuthor(via: TaskAuthorVia = 'cli-run'): TaskAuthor {
  return { kind: 'user', id: LOCAL_ACTOR_ID, via, at: new Date().toISOString() };
}
