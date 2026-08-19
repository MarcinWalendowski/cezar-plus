import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceGrantProject, WorkspaceWorktree } from '@loki-labs/better-cezar-contract';
import { autosaveCommit, createWorktree, removeWorktree, resolveBaseRef } from '../git-worktree.ts';
import { getRepoInfo } from '../server/git.ts';

/**
 * Per-project worktrees for a PARALLEL WORKSPACE RUN
 * (`.ai/specs/2026-08-19-parallel-workspace-runs-worktrees.md`).
 *
 * A workspace run used to edit every registered checkout in place, serialized to one at a time by
 * the boot repo's exclusive-tree lease (old spec 2026-08-15 D4). This module replaces that: each
 * granted git project is isolated in its own `cez/<id8>` worktree, so N workspace runs run at once
 * without colliding. When the run finishes, `applyWorkspaceWorktrees` lands each worktree's diff
 * back in the real checkout — serialized per project root — and removes the worktree.
 */

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run git, never throw — degradation is the caller's policy (mirrors `git-worktree.ts`). */
function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
}

/** Note sink — `emit` in `run.ts`; a no-op default keeps the module usable from a test. */
export type Note = (message: string) => void;

/**
 * Establish one `cez/<id8>` worktree per granted git project. A project that is missing, not a git
 * repo, or whose worktree cannot be created contributes NO entry — the caller falls back to
 * granting its real root for that one project, exactly as an ordinary in-place run does, so a
 * single unco-operative repo never cranks the whole run to a halt.
 *
 * Idempotent through `createWorktree`: a resume that still has its worktrees reuses them.
 */
export async function materializeWorkspaceWorktrees(
  runId: string,
  projects: readonly WorkspaceGrantProject[],
  note: Note = () => undefined,
): Promise<WorkspaceWorktree[]> {
  const worktrees: WorkspaceWorktree[] = [];
  for (const project of projects) {
    if (project.status === 'missing') continue;
    const repo = await getRepoInfo(project.root);
    if (!repo) {
      note(`${project.name || project.id}: not a git repo — granted in place (no worktree)`);
      continue;
    }
    // Fork from the project's current branch; `createWorktree` pins a detached HEAD to its commit.
    const base = (await resolveBaseRef(project.root, repo.branch)) ?? repo.branch;
    try {
      const wt = await createWorktree(project.root, runId, base);
      worktrees.push({
        root: project.root,
        worktreePath: wt.path,
        branch: wt.branch,
        baseBranch: wt.baseBranch,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      note(`${project.name || project.id}: worktree failed (${message}) — granted in place`);
    }
  }
  return worktrees;
}

/**
 * Per-root apply serialization. The only remaining collision point once runs are isolated is two
 * runs applying to the SAME real repo at the same instant; chaining on the root closes it. Module
 * state is safe because every workspace run lives in one process (the boot manager).
 */
const applyTails = new Map<string, Promise<void>>();

function serializeByRoot<T>(root: string, task: () => Promise<T>): Promise<T> {
  const previous = applyTails.get(root) ?? Promise.resolve();
  const run = previous.then(task, task);
  // Keep the tail alive but swallow errors so one failure does not reject the next waiter.
  applyTails.set(
    root,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export type ApplyOutcome = 'applied' | 'nothing' | 'conflict' | 'failed';

export interface ApplyReport {
  root: string;
  branch: string;
  outcome: ApplyOutcome;
  detail?: string;
}

/**
 * Land one worktree's changes in its real checkout, unstaged, beside whatever the user had in
 * progress, then remove the worktree. Commits the worktree first so the diff captures untracked
 * files too, then `git apply --3way --binary` of `base..HEAD` into the real root. A clean apply
 * removes the worktree and branch (W6); a conflict keeps them as the recovery artifact and reports.
 */
async function applyOne(wt: WorkspaceWorktree): Promise<ApplyReport> {
  const base = { root: wt.root, branch: wt.branch } as const;
  if (!existsSync(wt.worktreePath)) {
    return { ...base, outcome: 'nothing', detail: 'worktree already gone' };
  }
  // Capture everything the agent did as commits so the diff is complete (untracked included).
  await autosaveCommit(wt.worktreePath, 'run finalize');
  const patch = await git(wt.worktreePath, ['diff', '--binary', wt.baseBranch, 'HEAD']);
  if (!patch.ok) {
    return { ...base, outcome: 'failed', detail: `diff failed: ${patch.stderr.trim()}` };
  }
  if (!patch.stdout.trim()) {
    await removeWorktree(wt.root, wt.worktreePath, wt.branch);
    return { ...base, outcome: 'nothing' };
  }
  return serializeByRoot(wt.root, async () => {
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), 'cez-apply-'));
      const patchFile = join(dir, 'changes.patch');
      await writeFile(patchFile, patch.stdout, 'utf8');
      // --3way merges against the real tree using the shared object db, so the user's in-progress
      // edits survive; --whitespace=nowarn keeps a noisy but valid patch from being rejected.
      const applied = await git(wt.root, [
        'apply',
        '--3way',
        '--binary',
        '--whitespace=nowarn',
        patchFile,
      ]);
      if (applied.ok) {
        await removeWorktree(wt.root, wt.worktreePath, wt.branch);
        return { ...base, outcome: 'applied' as const };
      }
      // Non-zero: either a genuine content conflict (3-way left markers) or an unappliable patch.
      // Either way the branch is the recovery point — keep it and say where it is.
      return {
        ...base,
        outcome: 'conflict' as const,
        detail: (applied.stderr.trim() || applied.stdout.trim()).slice(0, 400),
      };
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

/**
 * Apply every worktree back to its real checkout (W4), each root serialized against the others.
 * Runs the roots concurrently — the per-root chain is the only ordering that matters — and returns
 * one report per worktree so the caller can note what landed and what was kept for review.
 */
export async function applyWorkspaceWorktrees(
  worktrees: readonly WorkspaceWorktree[],
): Promise<ApplyReport[]> {
  return Promise.all(worktrees.map((wt) => applyOne(wt)));
}
