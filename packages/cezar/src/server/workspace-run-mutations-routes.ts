import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { jsonZodValidator } from './validators.ts';
import type { ProjectApiEnv } from './server.ts';
import { RunStore } from '../runs/store.ts';
import { listProjects } from '../workspace/projects.ts';

/**
 * Row actions for the CROSS-PROJECT board — `/api/v1/workspace/runs/:projectId/:runId/…`.
 * Spec: `.ai/specs/2026-08-14-cross-project-run-mutations.md`.
 *
 * ## Why this family exists at all
 *
 * The board's twins live at `POST /api/v1/p/:projectId/runs/:id/{archive,read,unread}`, and that
 * prefix carries `use('*', resolveProjectScope)` — method-agnostic, so it runs for a POST too. It
 * calls `contexts.context()`, the **building** accessor, whose `build()` runs `pruneOrphans` →
 * `reclaimWorktrees` (deleting worktree directories) → `manager.recover()`, which resumes every
 * interrupted run in that project into `spawn('bash', ['-lc', …])`.
 *
 * So marking one finished row read spent tokens, deleted directories and started processes in a
 * project the user only pointed at. The trigger was the project, not the row, and it was entirely
 * invisible at the call site.
 *
 * Moving the action to `/workspace/*` is the fix: that prefix has no `:projectId` of its own, so
 * the scope resolver sets the already-seeded boot context and returns. **The project id here is
 * data the handler resolves, not a routing scope.**
 *
 * ## Two invariants this file keeps, and how
 *
 * **It never builds a context.** `contexts` arrives as an injected dep, so this module imports
 * neither `./project-context.ts` nor `../workflows/run.ts` — pinned structurally, the same way
 * `run-index.test.ts` pins the read side. Only `peek` is ever called, and `peek` cannot build.
 *
 * **It never rewrites a row it was not asked about.** The standalone open passes
 * `keepLive: true`. Without it `RunStore.open` runs `reconcileLoadedRun`, which turns every
 * `running`/`queued`/`waiting` row into `failed` with "interrupted — cezar process exited during
 * the run" — and this path flushes, so a read receipt would persist that verdict over a run that
 * is alive in another process.
 *
 * Unlike the read family (`./workspace-runs-routes.ts`) this is **not** gated on
 * `capabilities.workspaceViews`: the board it serves is upstream's always-on `/tasks`, and a
 * capability that leaves an always-on page with row actions answering 409 has half-disabled a
 * page rather than disabled a feature.
 */

/** The already-built context, or nothing. Deliberately the narrowest possible view of
 *  `ProjectContexts` — a `peek` cannot build, and a dep typed as the whole class could. */
export interface WorkspaceRunMutationContexts {
  peek(projectId: string): { store: RunStore } | undefined;
}

export interface WorkspaceRunMutationDeps {
  /** Injected rather than imported: importing `./project-context.ts` is exactly what the
   *  structural guard forbids, and the guard is the thing keeping this route honest. */
  contexts: WorkspaceRunMutationContexts;
  /** Defaults to the plain registry lookup — the same one the read family uses. Injected so a
   *  test can name a fixture root without registering a project. */
  listProjects?: typeof listProjects;
}

const archiveBodySchema = z.object({ archived: z.boolean() });

/** `<root>/.ai/cezar` — the directory `RunStore` keys on, and the one `WorkspaceRunIndex` reads
 *  `runs.json` out of. Spelled once here so the two can never drift apart. */
function dataDirFor(root: string): string {
  return join(root, '.ai', 'cezar');
}

type Resolved =
  | { ok: true; store: RunStore; live: boolean }
  | { ok: false; status: 404 | 409; error: string };

/**
 * The store for `projectId`, without building anything.
 *
 * `peek` first, and that is **correctness rather than a shortcut**: `RunStore.open` returns a NEW
 * instance every call (no singleton), and `saveNow` rewrites the whole file from that instance's
 * own map — so a second store opened over a live one would silently drop everything the live one
 * had learned since it opened. Where a context is already built, its store is the only store
 * allowed to write.
 */
async function resolveStore(
  projectId: string,
  deps: Required<Pick<WorkspaceRunMutationDeps, 'contexts' | 'listProjects'>>,
): Promise<Resolved> {
  const live = deps.contexts.peek(projectId);
  if (live !== undefined) return { ok: true, store: live.store, live: true };

  const entry = (await deps.listProjects()).find((project) => project.id === projectId);
  if (entry === undefined) return { ok: false, status: 404, error: `unknown project: ${projectId}` };

  // Checked BEFORE opening: `RunStore.open` begins with `mkdirSync(…, { recursive: true })`, so
  // opening a project whose folder is gone would recreate the deleted repo's skeleton — a
  // mutation route quietly resurrecting a tree. 409 matches what `resolveProjectScope` already
  // answers for this condition, so the two paths agree about a missing root.
  if (!existsSync(entry.root)) {
    return { ok: false, status: 409, error: `project folder not found: ${projectId}` };
  }
  return { ok: true, store: RunStore.open(dataDirFor(entry.root), { keepLive: true }), live: false };
}

/** Persist a standalone store's edit now. A live context's store owns its own save cadence (and
 *  its `touch` already scheduled one), so flushing it here would only fight it. */
function persist(resolved: { store: RunStore; live: boolean }): void {
  if (!resolved.live) resolved.store.flush();
}

export function createWorkspaceRunMutationRoutes(deps: WorkspaceRunMutationDeps) {
  const resolved = { contexts: deps.contexts, listProjects: deps.listProjects ?? listProjects };

  return new Hono<ProjectApiEnv>()
    .post(
      '/workspace/runs/:projectId/:runId/archive',
      jsonZodValidator(archiveBodySchema),
      async (c) => {
        const { projectId, runId } = c.req.param();
        const store = await resolveStore(projectId, resolved);
        if (!store.ok) return c.json({ error: store.error }, store.status);
        const run = store.store.setArchived(decodeURIComponent(runId), c.req.valid('json').archived);
        if (run === undefined) return c.json({ error: `unknown run: ${runId}` }, 404);
        persist(store);
        return c.json(run);
      },
    )
    .post('/workspace/runs/:projectId/:runId/read', async (c) => {
      const { projectId, runId } = c.req.param();
      const store = await resolveStore(projectId, resolved);
      if (!store.ok) return c.json({ error: store.error }, store.status);
      const run = store.store.setRead(decodeURIComponent(runId));
      if (run === undefined) return c.json({ error: `unknown run: ${runId}` }, 404);
      persist(store);
      return c.json(run);
    })
    .post('/workspace/runs/:projectId/:runId/unread', async (c) => {
      const { projectId, runId } = c.req.param();
      const store = await resolveStore(projectId, resolved);
      if (!store.ok) return c.json({ error: store.error }, store.status);
      const run = store.store.setUnread(decodeURIComponent(runId));
      if (run === undefined) return c.json({ error: `unknown run: ${runId}` }, 404);
      persist(store);
      return c.json(run);
    })
}
