import { Hono } from 'hono';
import { type WorkspaceTodosResponse } from '@open-mercato/cezar-contract';
import type { ProjectApiEnv } from './server.ts';
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

  return new Hono<ProjectApiEnv>().get('/workspace/todos', async (c) => {
    const result = await index.list();
    const body: WorkspaceTodosResponse = { ...result };
    return c.json(body);
  });
}
