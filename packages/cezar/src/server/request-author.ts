import type { Context } from 'hono';
import {
  authorFromRequest,
  type RequestActor,
  type TaskAuthor,
  type TaskAuthorVia,
} from '../runs/task-author.ts';

/**
 * The hono adapter for `authorFromRequest` (spec `.ai/specs/2026-08-21-task-author-provenance.md`).
 *
 * Lives here rather than in `runs/task-author.ts` so that module keeps no dependency on the server
 * layer, and here rather than in `server.ts` so `workspace-run-routes.ts`, `notes-routes.ts` and
 * `workspace-reports-routes.ts` reach the same one function instead of each growing a copy —
 * `AGENTS.md`'s "two handlers, one guard, is the same bug at rest".
 *
 * The principal is read through a CAST rather than by widening the route env, which is exactly what
 * `approverOf`/`triagedBy` already do and for the reason their comments give: widening `app`'s Env
 * broke assignability for the ~30 callers that annotate a plain `Hono`. The shape asserted here is
 * narrower than `Principal` on purpose — this decision needs `kind` and `userId` and nothing else,
 * and reading no more than that is what keeps `author` an audit field rather than a permission one.
 */
export function requestActor(c: Context<never> | Context<any>): RequestActor {
  const withPrincipal = c as unknown as Context<{
    Variables: { principal: { readonly kind: 'local' | 'session'; readonly userId: string } };
  }>;
  return {
    principal: withPrincipal.get('principal'),
    header: (name) => c.req.header(name),
  };
}

/** `authorFromRequest`, for a route that has the request context in hand. */
export function authorOf(c: Context<never> | Context<any>, via: TaskAuthorVia): TaskAuthor {
  return authorFromRequest(requestActor(c), via);
}
