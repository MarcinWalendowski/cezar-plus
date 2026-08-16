import { sep } from 'node:path';
import type { WorkspaceGrantProject } from '@loki-labs/better-cezar-contract';
import { listProjects } from './projects.ts';

/**
 * The directory grant behind a WORKSPACE RUN
 * (`.ai/specs/2026-08-15-cross-project-workspace-run.md`) — one run, not scoped to any project,
 * that reads and writes in every registered project directory.
 *
 * **Why this is a module and not four lines inside the route.** The grant has two halves that must
 * agree, and only one of them is enforced by the machine:
 *
 *  1. `roots` becomes `--add-dir` (`core/claude-cli-runner.ts`) — the half that actually grants
 *     access, and the half that is CLAUDE-ONLY. The codex and opencode runners drop
 *     `additionalDirectories` on the floor.
 *  2. `workspaceGrantSystemPrompt` is the PORTABLE half: the absolute paths written into the
 *     prompt as text. It is the only thing a non-Claude backend ever sees, and it is also what
 *     tells ANY backend where the work is — a cwd of the boot repo contains none of it.
 *
 * Deleting (2) leaves Claude working and every other runner unable to find a single file, with no
 * error and no test failure anywhere near the deletion. That is exactly the shape
 * `knowledge/prompt.ts` already guards against for KB roots ("the portable half is the absolute
 * path already stated in `knowledgeSystemPrompt`'s own text"), and this module follows it.
 *
 * Pure except for `loadWorkspaceGrant`, so the containment rule and the prompt text are testable
 * with no registry, no disk and no server.
 */

/** The contract's own shape, aliased rather than re-declared — this is what a workspace run
 *  PERSISTS (`runRecordSchema.workspaceProjects`), so a second local copy could drift from the
 *  thing on disk without a single test noticing. */
export type GrantedProject = WorkspaceGrantProject;

export interface WorkspaceGrant {
  /** Every registered project, in registry order — including one that is not on disk, which is
   *  RENDERED as unavailable rather than silently dropped (the same rule
   *  `workspaceProjectHealthSchema` follows on every workspace board). */
  projects: GrantedProject[];
  /** The deduped, on-disk root set handed to `--add-dir`. */
  roots: string[];
}

/**
 * Drop every root that already lies inside another root in the same set.
 *
 * Registering a parent and its children is the NORMAL case here, not an edge one: the owner's own
 * workspace registers `/home/u/monorepo` alongside ten of its subdirectories, so the honest
 * grant is two directories, not twelve. Passing all twelve would work — `--add-dir` is additive —
 * but it makes the spawn line and the prompt claim a precision the grant does not have.
 *
 * Containment is compared on path SEGMENTS (`p + sep`), never a bare `startsWith`: `/a/bc` is not
 * inside `/a/b`, and a prefix test says it is. Exact duplicates collapse to one.
 */
export function dedupeContainedRoots(roots: readonly string[]): string[] {
  const normalized = roots.map(stripTrailingSep).filter((root) => root.length > 0);
  // Shortest first, so a parent is always considered before anything it contains.
  const byDepth = [...new Set(normalized)].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const kept: string[] = [];
  for (const root of byDepth) {
    if (kept.some((parent) => root === parent || root.startsWith(parent + sep))) continue;
    kept.push(root);
  }
  return kept;
}

function stripTrailingSep(root: string): string {
  let end = root.length;
  while (end > 1 && root[end - 1] === sep) end -= 1;
  return root.slice(0, end);
}

/**
 * A project that is not on disk contributes NO root: `--add-dir` on a path that does not exist is
 * a spawn-time failure on the Claude CLI, and a workspace run must not die because one registered
 * checkout was moved. It stays in `projects` so the prompt can say so.
 */
export function buildWorkspaceGrant(projects: readonly GrantedProject[]): WorkspaceGrant {
  return {
    projects: [...projects],
    roots: dedupeContainedRoots(
      projects.filter((project) => project.status !== 'missing').map((project) => project.root),
    ),
  };
}

/**
 * The system-prompt block. `undefined` when nothing is reachable — a run with an empty grant is
 * an ordinary run in the boot repo, and claiming a workspace it does not have would be worse than
 * saying nothing.
 *
 * The "do not commit" line is not boilerplate. A workspace run has **no worktree and no branch**:
 * every edit lands in the user's real working tree, next to whatever they had in progress. An
 * agent that helpfully commits is committing someone else's uncommitted work.
 */
export function workspaceGrantSystemPrompt(grant: WorkspaceGrant | undefined): string | undefined {
  const reachable = (grant?.projects ?? []).filter((project) => project.status !== 'missing');
  if (reachable.length === 0) return undefined;

  const missing = (grant?.projects ?? []).filter((project) => project.status === 'missing');
  const lines = [
    '## Workspace run — every registered project',
    '',
    'This task is NOT scoped to one repository. Your working directory is a scratch repo that',
    'holds none of the work; the work is in the projects below, and you reach them by ABSOLUTE',
    'path. You have read and write access to all of them.',
    '',
    ...reachable.map((project) => `- ${project.name || project.id}: ${project.root}`),
  ];

  if (missing.length > 0) {
    lines.push(
      '',
      `Registered but not on disk right now — do not try to work in these: ${missing
        .map((project) => project.name || project.id)
        .join(', ')}.`,
    );
  }

  lines.push(
    '',
    'There is no worktree and no branch for this run: every edit lands directly in the real',
    'working tree of each project, alongside whatever the user already had in progress. So do',
    'NOT commit, stash, reset, or push in any of them unless the task explicitly asks for it —',
    'you would be committing changes that are not yours. Report what you changed, per project.',
  );

  return lines.join('\n');
}

/** The production read. Kept a thin wrapper for the same reason `listRegisteredProjectRoots`
 *  (`../registered-project-roots.ts`) is one: the only thing worth asserting about it is that it
 *  reads the SAME registry the sidebar and `cezar projects` read. */
export async function loadWorkspaceGrant(
  list: typeof listProjects = listProjects,
): Promise<WorkspaceGrant> {
  const projects = await list();
  return buildWorkspaceGrant(
    projects.map((project) => ({
      id: project.id,
      name: project.name || '',
      root: project.root,
      status: project.status,
    })),
  );
}
