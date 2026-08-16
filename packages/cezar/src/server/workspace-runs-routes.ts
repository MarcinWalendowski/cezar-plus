import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { type WorkspaceRunsResponse } from '@open-mercato/cezar-contract';
import { resolveCapabilities } from './capabilities.ts';
import { queryZodValidator } from './validators.ts';
import type { ProjectApiEnv } from './server.ts';
import { WorkspaceRunIndex, type WorkspaceRunProjectSource } from '../workspace/run-index.ts';
import { allocateProjectSlug, isRegisteredRoot, listProjects } from '../workspace/projects.ts';

/**
 * The WORKSPACE RUNS family of `/api/v1/workspace` (F3 feature A, `CEZ_WORKSPACE_VIEWS=1`). See
 * `.ai/specs/2026-08-06-workspace-notes-cross-project.md` ("API Contracts", section A) and
 * `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D19.
 *
 * **W4.10 fills the W1.1 scaffold in.** The route now reads through `WorkspaceRunIndex` (W1.11)
 * instead of answering a constant payload, gated on `capabilities().workspaceViews` (also `false`
 * under `CEZ_SINGLE_PROJECT=1` — `capabilities.ts`).
 *
 * **READ never instantiates.** This file never imports `../server/project-context.ts`,
 * `../runs/store.ts` or `../workflows/run.ts` — the same invariant `run-index.ts` guards
 * structurally (`run-index.test.ts`'s C2). `deps.runIndex` defaults to a lazily built
 * `WorkspaceRunIndex` over the plain, already-exported `listProjects()` registry lookup
 * (`../workspace/projects.ts`) **plus a synthetic row for an unregistered boot project** — see
 * `withBootProject` below for why the registry alone is not the whole workspace. Otherwise
 * functionally identical to the workspace-level singleton at
 * `ProjectContexts.runIndex` (W3.1), since both ultimately read the same `~/.cezar/config.json`
 * through the same function. It is a SEPARATE cache instance rather than the shared one: this
 * family's own `server.ts` mount line (`createWorkspaceRunsRoutes()`) is scaffold-owned (W1.1) and
 * out of this package's file ownership, so there is no seam to thread `contexts.runIndex` through
 * without editing it. The cost is one extra `mtimeMs`+`size` cache the aggregate keeps to itself —
 * never a correctness gap, since both caches key off the same on-disk `runs.json` files.
 *
 * **`bootProject` without a `server.ts` closure.** Naming the boot project's canonical slug needs
 * the same match-by-root-then-`allocateProjectSlug`-fallback `resolveBootProject()` performs in
 * `server.ts` — but that closure is private and not exported. `resolveProjectScope` already runs
 * for every `/api/v1/workspace/*` request (no `:projectId` param ⇒ it sets the ALREADY-SEEDED boot
 * context and returns, per `server.ts`'s own comment on that middleware) — so `c.get('project')`
 * is always the boot `ProjectContext`, and `.root` is always the REAL root (never the `'default'`
 * alias `.id` can be). `deps.resolveBootProject` re-derives the same match-then-fallback the real
 * closure does, from that root, so the two only disagree if the server was launched with a root
 * override this process's own registry lookup cannot see — an edge case, and still never a wrong
 * REGISTERED slug, only a possible difference in the unregistered-root fallback spelling.
 *
 * Workspace-level and single-mount (never mirrored under `/api/v1/p/:projectId`) — a read-only
 * aggregate OVER every project, so `route-parity.test.ts` does not apply. Read-only, so there is no
 * mutator to 409 in this family (D19's 409 half is exercised by `./notes-routes.ts`). Chained with
 * an INFERRED return type, mounted into `workspaceV1` in `server.ts`.
 */

export interface WorkspaceRunsRouteDeps {
  /** Defaults to a `WorkspaceRunIndex` reading the real registry plus the boot project (see the
   *  module doc and `withBootProject`). Injected so tests hand it a hermetic fixture instead of
   *  `~/.cezar` — an injected index supplies its own project list, boot row included or not. */
  runIndex?: WorkspaceRunIndex;
  /** Defaults to a standalone re-derivation of `server.ts`'s own `resolveBootProject()`, given
   *  THIS request's boot root. Injected so a test can pin the answer without registering a
   *  project. */
  resolveBootProject?: (bootRoot: string) => Promise<string>;
}

/** Spec, section A: "Max 64 ids." Mirrors `GH_CHECKS_MAX`'s role for `prs=<csv>` — the precedent
 *  this query format follows. */
const MAX_PROJECTS_FILTER = 64;

const workspaceRunsQuerySchema = z.object({
  projects: z.string().max(2_000).optional(),
  view: z.enum(['active', 'archived']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

function toRunIndexSource(project: { id: string; root: string; status: 'ok' | 'missing' | 'not-git' | 'no-commits'; name: string }): WorkspaceRunProjectSource {
  return { id: project.id, root: project.root, status: project.status, name: project.name || '' };
}

/**
 * The registry, plus the BOOT project when the registry does not already hold it.
 *
 * Same gap and same fix as `GET /workspace/runs-index` (`server.ts`): a boot repo can legitimately
 * sit outside the registry — a dedicated scaffold like `~/cezar/cockpit-boot` is deliberately
 * unregistered so it stays out of the sidebar and the composer's pills — and since
 * `.ai/specs/2026-08-15-cross-project-workspace-run.md` D1 that repo is where every WORKSPACE run's
 * record lives. Without this row the board that exists to show every project's runs is blind to
 * the only runs that span every project.
 *
 * `isRegisteredRoot` is what keeps a REGISTERED boot repo listed once. `dedupeByRoot` inside
 * `WorkspaceRunIndex` is the second net — it exists for exactly this synthetic row (see its
 * comment) — but it collapses on `resolve()`, not on the realpath, so `/tmp/x` against a stored
 * `/private/tmp/x` would slip past it. The explicit check is the one that actually holds.
 */
function withBootProject(bootRoot: string, resolveBoot: (root: string) => Promise<string>) {
  return async (): Promise<WorkspaceRunProjectSource[]> => {
    const registry = await listProjects();
    const sources = registry.map(toRunIndexSource);
    if (await isRegisteredRoot(registry, bootRoot)) return sources;
    const id = await resolveBoot(bootRoot);
    // `status: 'ok'` rather than a probe: `missing` is the only value the index treats as
    // unreadable, and this is the folder the server is running in.
    return [...sources, { id, root: bootRoot, status: 'ok', name: id }];
  };
}

function defaultRunIndex(
  bootRoot: string,
  resolveBoot: (root: string) => Promise<string>,
): WorkspaceRunIndex {
  return new WorkspaceRunIndex({ listProjects: withBootProject(bootRoot, resolveBoot) });
}

/** The standalone twin of `server.ts`'s `resolveBootProject()`: match `bootRoot` against the
 *  registry by realpath, falling back to the same `allocateProjectSlug` an unregistered root gets
 *  there. See the module doc for why this cannot just import that closure. */
async function defaultResolveBootProject(bootRoot: string): Promise<string> {
  const projects = await listProjects();
  const real = await realpath(bootRoot).catch(() => resolve(bootRoot));
  const match = projects.find((p) => p.root === real || p.root === bootRoot);
  if (match) return match.id;
  return allocateProjectSlug(bootRoot, projects.map((p) => p.id));
}

/** `undefined` in (no `projects` param) ⇒ `undefined` out — ALL projects, never none. A
 *  present-but-empty/whitespace/comma-only string is a DELIBERATE request for zero projects and
 *  comes back `[]`, matching `WorkspaceRunListOptions`'s own "absent means all, an empty array is
 *  honored as a real answer" contract (`run-index.ts`). */
function parseProjectsFilter(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function createWorkspaceRunsRoutes(deps: WorkspaceRunsRouteDeps = {}) {
  const resolveBoot = deps.resolveBootProject ?? defaultResolveBootProject;
  // Built on first use, then KEPT: the `mtimeMs`+`size` cache inside `WorkspaceRunIndex` is the
  // whole reason it must not be rebuilt per request. It cannot be built at construction time any
  // more, because the row it appends is the boot root's and that root arrives per request
  // (`c.get('project').root`) — see the module doc on why this file cannot reach `server.ts`'s own
  // closure. Keyed on the root rather than assumed constant so a second boot root, if one ever
  // reached the same routes object, gets its own index instead of the first one's boot row.
  let cached: { root: string; index: WorkspaceRunIndex } | undefined;
  const indexFor = (bootRoot: string): WorkspaceRunIndex => {
    if (deps.runIndex) return deps.runIndex;
    if (cached?.root !== bootRoot) cached = { root: bootRoot, index: defaultRunIndex(bootRoot, resolveBoot) };
    return cached.index;
  };

  return new Hono<ProjectApiEnv>().get(
    '/workspace/runs',
    queryZodValidator(workspaceRunsQuerySchema),
    async (c) => {
      const query = c.req.valid('query');
      const projects = parseProjectsFilter(query.projects);
      // Malformed query only (spec, section A) — checked regardless of the flag, same as any
      // other 400 in this API: the feature being off answers with data, never with a parse error.
      if (projects && projects.length > MAX_PROJECTS_FILTER) {
        return c.json({ error: `invalid projects query: at most ${MAX_PROJECTS_FILTER} ids` }, 400);
      }

      const bootRoot = c.get('project').root;
      const bootProject = await resolveBoot(bootRoot);

      // D19/D4: off (or CEZ_SINGLE_PROJECT=1, which reports the capability false) ⇒ 200 with a
      // schema-valid empty payload, never 404 and never 409 on a read. `bootProject` still names
      // the real boot project — resolving it costs nothing extra and the client can use it
      // whichever shape the flag takes.
      if (!resolveCapabilities(process.env).workspaceViews) {
        const body: WorkspaceRunsResponse = { runs: [], projects: [], truncated: false, bootProject };
        return c.json(body);
      }

      const result = await indexFor(bootRoot).list({
        projects,
        view: query.view,
        limit: query.limit,
      });
      const body: WorkspaceRunsResponse = { ...result, bootProject };
      return c.json(body);
    },
  );
}
