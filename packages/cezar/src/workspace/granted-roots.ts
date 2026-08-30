import { join, sep } from 'node:path';
import type { WorkspaceGrantProject, WorkspaceWorktree } from '@loki-labs/cezar-plus-contract';
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
 * Where a project's work lives inside the run's worktrees, or `undefined` when it has none.
 *
 * Not a plain `root → worktreePath` lookup any more (spec 2026-08-20, X1/X2): a worktree entry is
 * now keyed on the REPO root, and several registry entries can sit inside one repo — `brand` and
 * `chatbox` are subdirectories of the `monorepo` checkout, registered as projects of their
 * own. Those map to the MATCHING SUBDIRECTORY of the shared tree, so each project still has a path
 * of its own, the repo root itself is still granted (the agent can work at the top of the repo),
 * and `dedupeContainedRoots` collapses the three to one `--add-dir`.
 *
 * The deepest containing repo root wins, so a nested repo registered inside another one maps to
 * its OWN worktree rather than to its parent's.
 */
function worktreePathOf(
  projectRoot: string,
  worktrees: readonly WorkspaceWorktree[],
): string | undefined {
  const project = stripTrailingSep(projectRoot);
  let best: { root: string; path: string } | undefined;
  for (const wt of worktrees) {
    const root = stripTrailingSep(wt.root);
    if (project === root) return wt.worktreePath;
    if (!project.startsWith(root + sep)) continue;
    if (best && best.root.length >= root.length) continue;
    best = { root, path: join(wt.worktreePath, project.slice(root.length + 1)) };
  }
  return best?.path;
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
  // `isolated` is now ALL-or-nothing, not any-or-nothing
  // (`.ai/specs/2026-08-25-workspace-scope-routes-tasks.md`, Phase 1).
  //
  // It used to be `worktrees.length > 0`, so one isolated project made the whole grant claim
  // isolation — and `workspaceGrantSystemPrompt` then told the agent that EVERY path below was a
  // private worktree cezar would apply back and delete. In a mixed grant that sentence was false
  // about exactly the paths where it mattered: the ones that fell back to the live checkout.
  // Measured on prod 2026-08-24, five separate runs were told that about the same live `cezar`
  // tree. A claim made about a set has to be true of every member of the set.
  //
  // New workspace runs create no worktrees at all, so this is `false` for them and the prompt says
  // "read, do not edit". It stays true for a legacy run whose recorded worktrees are ALL still
  // materialized, which is the one case the old sentence was honest about.
  const paths = new Map<string, string>();
  let withWorktree = 0;
  for (const project of projects) {
    if (project.status === 'missing') continue;
    const worktree = worktreePathOf(project.root, worktrees);
    if (worktree) withWorktree += 1;
    paths.set(project.root, worktree ?? project.root);
  }
  const isolated = paths.size > 0 && withWorktree === paths.size;
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
      '',
      // X5 (spec 2026-08-20-workspace-run-worktree-isolation). The knowledge mount is the ONE
      // grant that is NOT worktreed: worktreeing a 2000-document corpus per run is not worth it,
      // and the append-only write protocol already makes concurrent runs safe. But that safety is
      // a convention agents follow, not an isolation boundary — so it has to be said out loud, or
      // the paragraph above reads as "everything you can reach is yours alone", which is false.
      'One exception: the knowledge-base directories are NOT worktreed. They are mounted at their',
      'real paths and SHARED with every other run in flight, so editing a file there edits it for',
      'everyone at once. Treat them as read-only: the local cezar knowledge base is the only thing',
      'you write to, and you write it by appending to CEZ_KB_WRITE_FILE, which is yours alone.',
    );
  } else {
    // The path every NEW workspace run takes (spec 2026-08-25-workspace-scope-routes-tasks).
    // The paths above are the REAL checkouts, shared with every other run in flight, and this
    // run does not edit them — it routes work into them as todos. The old text here told the
    // agent to edit the live trees and merely not to commit, which is the shape that left five
    // runs' uncommitted edits interleaved in one checkout on 2026-08-24.
    lines.push(
      '',
      'These are the REAL checkouts, not worktrees, and they are shared with every other task',
      'running right now. This task does not edit them. Read them to understand the work, then',
      'file the work into the projects that need it:',
      '',
      '    cez todo add "<summary>" --project <id> --context "..." --acceptance "..."',
      '',
      'Do NOT edit, create, delete, commit, stash, reset or push a file in any project. Another',
      'task is reading those same files as you work. The todos you file are the deliverable, and',
      'each one runs later in its own isolated worktree. Report what you filed, per project.',
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
