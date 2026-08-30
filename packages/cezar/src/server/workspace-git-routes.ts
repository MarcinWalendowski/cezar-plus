import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { type WorkspaceGitResponse } from '@loki-labs/cezar-plus-contract';
import { resolveCapabilities } from './capabilities.ts';
import type { ProjectApiEnv } from './server.ts';
import { WorkspaceGitIndex, type WorkspaceGitProjectSource } from '../workspace/git-index.ts';
import { allocateProjectSlug, listProjects } from '../workspace/projects.ts';

/**
 * `GET /api/v1/workspace/git` — the workspace git overview
 * (`.ai/specs/2026-08-14-cross-project-git-overview.md`, D1). One row per registered project:
 * branch, ahead/behind, dirty count, last commit — answering "which repos have uncommitted work
 * and which branch is each on" without a per-project click, and without the per-project context
 * build that click costs today (`resolveProjectScope` calling `contexts.context()`, whose
 * `build()` runs `pruneOrphans` → `reclaimWorktrees` → `manager.recover()`).
 *
 * **READ never instantiates.** This file never imports `../server/project-context.ts` or
 * `../workflows/run.ts` — the same invariant `./workspace-runs-routes.ts` and
 * `../workspace/git-index.ts` guard, the latter structurally. `deps.gitIndex` defaults to a
 * fresh `WorkspaceGitIndex` built from the plain, already-exported `listProjects()` registry
 * lookup, the same pattern `./workspace-runs-routes.ts` uses for its own default `runIndex` — see
 * that file's docblock for why a separate cache instance (rather than a shared workspace-level
 * singleton) is the right cost to pay here too.
 *
 * **`bootProject` without a `server.ts` closure.** Duplicated from `./workspace-runs-routes.ts`
 * rather than imported: naming the boot project's canonical slug needs the same
 * match-by-root-then-`allocateProjectSlug`-fallback `resolveBootProject()` performs in
 * `server.ts`, but that closure is private and not exported, and each workspace-level family
 * keeps its own standalone re-derivation (see that file's docblock for the full reasoning — it
 * applies unchanged here).
 *
 * **Gated on `capabilities.workspaceViews` (D1), like the runs family** — `CEZ_WORKSPACE_VIEWS
 * === '1' && !singleProject`. Off (or under `CEZ_SINGLE_PROJECT=1`) answers 200 with a
 * schema-valid empty payload, never 404: this is our own opt-in aggregate, not an always-on
 * upstream board (contrast `./workspace-run-mutations-routes.ts`, deliberately ungated for
 * exactly that reason).
 *
 * Workspace-level and single-mount — never mirrored under `/api/v1/p/:projectId`
 * (`BACKWARD_COMPATIBILITY.md` §2): a scoped spelling would be a second surface with no
 * consumer. Read-only, so `route-parity.test.ts` does not apply and there is no mutator to 409.
 */

export interface WorkspaceGitRouteDeps {
  /** Defaults to a fresh `WorkspaceGitIndex` reading the real registry (see the module doc).
   *  Injected so tests hand it a hermetic fixture instead of `~/.cezar`. */
  gitIndex?: WorkspaceGitIndex;
  /** Defaults to a standalone re-derivation of `server.ts`'s own `resolveBootProject()`, given
   *  THIS request's boot root. Injected so a test can pin the answer without registering a
   *  project. */
  resolveBootProject?: (bootRoot: string) => Promise<string>;
}

function toGitIndexSource(project: {
  id: string;
  root: string;
  status: 'ok' | 'missing' | 'not-git' | 'no-commits';
  name: string;
}): WorkspaceGitProjectSource {
  return { id: project.id, root: project.root, status: project.status, name: project.name || '' };
}

function defaultGitIndex(): WorkspaceGitIndex {
  return new WorkspaceGitIndex({
    listProjects: async () => (await listProjects()).map(toGitIndexSource),
  });
}

/** The standalone twin of `server.ts`'s `resolveBootProject()` — see the module doc and
 *  `./workspace-runs-routes.ts`'s identical helper for why this cannot just import that closure. */
async function defaultResolveBootProject(bootRoot: string): Promise<string> {
  const projects = await listProjects();
  const real = await realpath(bootRoot).catch(() => resolve(bootRoot));
  const match = projects.find((p) => p.root === real || p.root === bootRoot);
  if (match) return match.id;
  return allocateProjectSlug(bootRoot, projects.map((p) => p.id));
}

export function createWorkspaceGitRoutes(deps: WorkspaceGitRouteDeps = {}) {
  const gitIndex = deps.gitIndex ?? defaultGitIndex();
  const resolveBoot = deps.resolveBootProject ?? defaultResolveBootProject;

  return new Hono<ProjectApiEnv>().get('/workspace/git', async (c) => {
    const bootProject = await resolveBoot(c.get('project').root);

    // D1/D19: off (or CEZ_SINGLE_PROJECT=1, which reports the capability false) ⇒ 200 with a
    // schema-valid empty payload, never 404. `bootProject` still names the real boot project.
    if (!resolveCapabilities(process.env).workspaceViews) {
      const body: WorkspaceGitResponse = { projects: [], bootProject };
      return c.json(body);
    }

    const result = await gitIndex.list();
    const body: WorkspaceGitResponse = { ...result, bootProject };
    return c.json(body);
  });
}
