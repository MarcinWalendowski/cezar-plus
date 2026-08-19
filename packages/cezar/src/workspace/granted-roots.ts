import { sep } from 'node:path';
import type { WorkspaceGrantProject, WorkspaceWorktree } from '@loki-labs/better-cezar-contract';
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
  /** The deduped, on-disk root set handed to `--add-dir`. When the run is isolated
   *  (`isolated: true`), these are per-project WORKTREE paths, not the real checkouts. */
  roots: string[];
  /** True on a parallel workspace run: `roots` point at isolated `cez/<id8>` worktrees, applied
   *  back to the real checkouts when the run finishes
   *  (`.ai/specs/2026-08-19-parallel-workspace-runs-worktrees.md`). The system prompt says so. */
  isolated: boolean;
  /** project root → the path the agent should work in (its worktree, or the real root when that
   *  project has no worktree). The prompt names these; drives nothing on a non-isolated grant. */
  paths: ReadonlyMap<string, string>;
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
export function buildWorkspaceGrant(
  projects: readonly GrantedProject[],
  worktrees: readonly WorkspaceWorktree[] = [],
): WorkspaceGrant {
  const worktreeByRoot = new Map(worktrees.map((wt) => [wt.root, wt.worktreePath]));
  const isolated = worktrees.length > 0;
  // The path the agent works in per project: its worktree when it has one, else the real root
  // (a non-git or worktree-failed project, granted in place — see materializeWorkspaceWorktrees).
  const paths = new Map<string, string>();
  for (const project of projects) {
    if (project.status === 'missing') continue;
    paths.set(project.root, worktreeByRoot.get(project.root) ?? project.root);
  }
  return {
    projects: [...projects],
    roots: dedupeContainedRoots([...paths.values()]),
    isolated,
    paths,
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
  const pathFor = (project: GrantedProject) => grant?.paths?.get(project.root) ?? project.root;
  const lines = [
    '## Workspace run — every registered project',
    '',
    'This task is NOT scoped to one repository. Your working directory is a scratch repo that',
    'holds none of the work; the work is in the projects below, and you reach them by ABSOLUTE',
    'path. You have read and write access to all of them.',
    '',
    ...reachable.map((project) => `- ${project.name || project.id}: ${pathFor(project)}`),
  ];

  if (missing.length > 0) {
    lines.push(
      '',
      `Registered but not on disk right now — do not try to work in these: ${missing
        .map((project) => project.name || project.id)
        .join(', ')}.`,
    );
  }

  if (grant?.isolated) {
    // Parallel workspace run: the paths above are ISOLATED worktrees, not the real checkouts
    // (`.ai/specs/2026-08-19-parallel-workspace-runs-worktrees.md`). Editing there is why several
    // workspace runs can run at once without colliding.
    lines.push(
      '',
      'Each path above is an ISOLATED git worktree for that project, not its real checkout. Do all',
      'your work there. When this task finishes, cezar applies your changes back into each real',
      'checkout automatically and removes the worktree — so do NOT commit, stash, reset, or push,',
      'and never edit a project outside its worktree path. Report what you changed, per project.',
    );
  } else {
    lines.push(
      '',
      'There is no worktree and no branch for this run: every edit lands directly in the real',
      'working tree of each project, alongside whatever the user already had in progress. So do',
      'NOT commit, stash, reset, or push in any of them unless the task explicitly asks for it —',
      'you would be committing changes that are not yours. Report what you changed, per project.',
    );
  }

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
