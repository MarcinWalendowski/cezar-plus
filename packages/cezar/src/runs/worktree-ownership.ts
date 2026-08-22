import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalPath } from '../git-worktree.ts';
import { readRunIndexFromDisk } from './run-index.ts';
import type { RunRecord } from './store.ts';

/**
 * Cross-project ownership check for `pruneOrphans` (spec
 * 2026-08-22-cross-project-worktree-orphan-prune-safety, Layer 1).
 *
 * A parallel WORKSPACE run (`.ai/specs/2026-08-19-parallel-workspace-runs-worktrees.md`) records
 * its per-project worktrees only on the run record in the run's OWN project's `runs.json`
 * (`workspaceWorktrees`) — the TARGET project whose repo the worktree lives inside never gets an
 * entry of its own. So the target project's boot-time `pruneOrphans`, which only ever consults its
 * own `store.listRuns()`, has no way to see that the worktree is still owned. This module answers
 * that question by reading every OTHER registered project's `runs.json` (plus, separately, the
 * workspace boot root's — see `PruneOrphansOptions`'s callers) directly, via `readRunIndexFromDisk`
 * — already built for exactly this kind of read: "which tasks exist" without opening a store or
 * triggering `manager.recover()`, which is what this check needs since it must not resume agents
 * across every other registered project on every ONE project's boot.
 */

export interface ForeignRunSource {
  projectId: string;
  projectName: string;
  runs: RunRecord[];
  /**
   * True when `<root>/.ai/cezar/runs.json` exists and is non-empty but `readRunIndexFromDisk`
   * still returned zero records (corrupt file, or a record failing `runRecordSchema`'s
   * whole-array parse — one bad record blinds the whole file). A missing file, or a file that
   * legitimately parses to `[]`, leaves this `false` — that case really does mean "no owner".
   *
   * A delete-authorization gate must NOT treat `unreadable: true` as "no owner": `[]` and "this
   * project genuinely owns nothing here" are indistinguishable once inside `pruneOrphans` unless
   * something upstream tells them apart, and this field is that signal. See `git-worktree.ts`'s
   * `PruneOrphansOptions.ownershipCheckUnavailable`.
   */
  unreadable: boolean;
}

/**
 * Read every candidate project's `runs.json`, read-only, for the ownership check below.
 *
 * `projects` is caller-assembled: every OTHER registered project (never `currentRoot` — the
 * caller filters that out before calling this), PLUS a synthetic entry for the workspace boot
 * root when one exists and differs from `currentRoot` (Phase 3 of the spec above) — this function
 * itself does not know about boot roots or the registry, it only reads whatever candidates it is
 * handed.
 */
export function loadForeignWorkspaceRunSources(
  currentRoot: string,
  projects: readonly { id: string; name?: string; root: string }[],
): ForeignRunSource[] {
  const currentCanonical = canonicalPath(currentRoot);
  const sources: ForeignRunSource[] = [];
  for (const project of projects) {
    if (canonicalPath(project.root) === currentCanonical) continue;
    const dataDir = join(project.root, '.ai/cezar');
    const runs = readRunIndexFromDisk(dataDir);
    const unreadable = runs.length === 0 && isNonEmptyIndexFile(join(dataDir, 'runs.json'));
    sources.push({
      projectId: project.id,
      projectName: project.name || project.id,
      runs,
      unreadable,
    });
  }
  return sources;
}

/** Does `<root>/.ai/cezar/runs.json` exist and hold at least one byte? Distinguishes "no file at
 *  all" (legitimately no owner) from "a file `readRunIndexFromDisk` could not parse" (unreadable —
 *  the ownership signal cannot be trusted). Never throws: a race between this stat and the file
 *  disappearing reads as "no file", the same as if it had never existed. */
function isNonEmptyIndexFile(indexPath: string): boolean {
  if (!existsSync(indexPath)) return false;
  try {
    return statSync(indexPath).size > 0;
  } catch {
    return false;
  }
}

/**
 * Does any foreign source still claim `worktreePath` (inside `repoRoot`) via a
 * `workspaceWorktrees` entry? Pure, no I/O. Deliberately does NOT filter by `run.status`: a
 * `running`-looking record read cold by `readRunIndexFromDisk` can show `status: 'failed'`
 * (`reconcileLoadedRun` marks any live-looking status as interrupted when read without
 * `keepLive`), while `workspaceWorktrees` itself is untouched by that reconciliation — a still-
 * present entry means "someone else still owns this" whether or not that someone has gotten
 * around to cleaning it up.
 */
export function findForeignWorkspaceOwner(
  repoRoot: string,
  worktreePath: string,
  foreign: readonly ForeignRunSource[],
): { projectName: string; runId: string } | undefined {
  const repoRootCanonical = canonicalPath(repoRoot);
  const worktreeCanonical = canonicalPath(worktreePath);
  for (const source of foreign) {
    for (const run of source.runs) {
      for (const wt of run.workspaceWorktrees ?? []) {
        if (
          canonicalPath(wt.root) === repoRootCanonical &&
          canonicalPath(wt.worktreePath) === worktreeCanonical
        ) {
          return { projectName: source.projectName, runId: run.id };
        }
      }
    }
  }
  return undefined;
}
