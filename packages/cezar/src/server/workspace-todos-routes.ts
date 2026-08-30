import { Hono } from 'hono';
import { workspaceTodosQuerySchema, type WorkspaceTodosResponse } from '@loki-labs/cezar-plus-contract';
import type { ProjectApiEnv } from './server.ts';
import { queryZodValidator } from './validators.ts';
import { WorkspaceTodoIndex, type WorkspaceTodoProjectSource } from '../workspace/todo-index.ts';
import { listProjects } from '../workspace/projects.ts';

/**
 * `GET /api/v1/workspace/todos` — the cross-project todo board (D2 of
 * `.ai/specs/2026-08-15-knowledge-grounded-task-fanout.md`, Phase 1). See `../workspace/todo-
 * index.ts` for the read path itself; this file is only the route.
 *
 * **READ never instantiates.** This file never imports `./project-context.ts` — the index it
 * wraps derives each project's `dataDir` and calls `readTodos()` directly, exactly like
 * `./workspace-runs-routes.ts`'s own `WorkspaceRunIndex` wiring. `deps.todoIndex` defaults to a
 * fresh `WorkspaceTodoIndex` built from the plain, already-exported `listProjects()` registry
 * lookup, matching every sibling workspace-read route's own default-index pattern.
 *
 * **Ungated (D7, added 2026-08-15).** This file used to gate on `capabilities.followups` AND
 * `capabilities.workspaceViews`, mirroring `./workspace-knowledge-routes.ts`'s AND-gate. That
 * precedent does not transfer: `followups`/`workspaceViews` are off on a default install
 * (measured on the owner's own cockpit), and this board is becoming the composer's default
 * fan-out surface, not an optional side view. A main path gated on a flag nobody sets is
 * invisible, failing as silence rather than an error — so the gate was removed rather than
 * documented as a known gap. This route now always reads and returns whatever the registry has;
 * it serves real data whenever there is data.
 *
 * Workspace-level and single-mount — never mirrored under `/api/v1/p/:projectId`
 * (`BACKWARD_COMPATIBILITY.md` §2, the same rule every sibling workspace family follows).
 *
 * **Optional query, added 2026-08-25** (`.ai/specs/2026-08-25-split-active-backlog-tables.md`):
 * `partition`/`sort`/`dir`/`limit`/`view`/`status`/`priority`/`q` move the Filed board's ordering
 * and paging off the browser. Every key is optional and **a request carrying none of them answers
 * exactly what it answered before they existed** — same `todos`, same `projects`, and neither of
 * the two new response keys. That is not a courtesy: this payload is §2-protected and the
 * composer's own board reads it.
 *
 * Validation is `queryZodValidator` middleware rather than parsing in the handler, so the query
 * shape reaches the ROUTE TYPE and `hc` refuses a `?bogus=1` at compile time (see
 * `./validators.ts` on why parsing inside a handler is invisible to Hono). Unknown keys are
 * stripped by the zod object rather than rejected, so no existing caller newly fails.
 */

export interface WorkspaceTodosRouteDeps {
  /** Defaults to a fresh `WorkspaceTodoIndex` reading the real registry. Injected so tests hand it
   *  a hermetic fixture instead of `~/.cezar`. */
  todoIndex?: WorkspaceTodoIndex;
}

function toTodoIndexSource(project: {
  id: string;
  root: string;
  status: 'ok' | 'missing' | 'not-git' | 'no-commits';
  name: string;
}): WorkspaceTodoProjectSource {
  return { id: project.id, root: project.root, status: project.status, name: project.name || '' };
}

function defaultTodoIndex(): WorkspaceTodoIndex {
  return new WorkspaceTodoIndex({
    listProjects: async () => (await listProjects()).map(toTodoIndexSource),
  });
}

export function createWorkspaceTodosRoutes(deps: WorkspaceTodosRouteDeps = {}) {
  const index = deps.todoIndex ?? defaultTodoIndex();

  return new Hono<ProjectApiEnv>().get(
    '/workspace/todos',
    queryZodValidator(workspaceTodosQuerySchema),
    async (c) => {
      const result = await index.list(c.req.valid('query'));
      const body: WorkspaceTodosResponse = { ...result };
      return c.json(body);
    },
  );
}
