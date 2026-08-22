import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { WorkspaceGrantProject, WorkspaceWorktree } from '@loki-labs/better-cezar-contract';
import { autosaveCommit, createWorktree, removeWorktree, resolveBaseRef } from '../git-worktree.ts';
import { getRepoInfo } from '../server/git.ts';

/**
 * Per-project worktrees for a PARALLEL WORKSPACE RUN
 * (`.ai/specs/2026-08-19-parallel-workspace-runs-worktrees.md`, extended by
 * `.ai/specs/2026-08-20-workspace-run-worktree-isolation.md`).
 *
 * A workspace run used to edit every registered checkout in place, serialized to one at a time by
 * the boot repo's exclusive-tree lease (old spec 2026-08-15 D4). This module replaces that: each
 * granted git REPO is isolated in its own `cez/<id8>` worktree, so N workspace runs run at once
 * without colliding. When the run finishes, `applyWorkspaceWorktrees` lands each worktree's diff
 * back in the real checkout — serialized per repo root — and removes the worktree. A run that ends
 * any other way goes through `discardWorkspaceWorktrees` instead: directory gone, branch kept.
 *
 * **One worktree per REPO, not per registry entry** (spec 2026-08-20, X1). The owner's registry has
 * twelve projects in ten repos: `brand` and `chatbox` are subdirectories of the `monorepo`
 * repo, registered separately. `createWorktree` derives its path from the repo root, so all three
 * entries resolved to one path — and apply-back then fired three times over the same tree
 * concurrently, the winner removing it out from under the losers, whose `git diff` failed with an
 * empty stderr (`failed on apply — kept worktree branch cez/… (diff failed: )`, measured on runs
 * `be31d9e9` and `ec6e8e06`). Collapsing here — keeping the entry whose `root` is the REPO root —
 * makes the apply happen once, with a cwd `git apply` can resolve the patch paths against.
 */

export interface GitResult {
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

/**
 * A git command's failure text, NEVER empty (spec 2026-08-20, X6). `git diff` in a cwd that has
 * been deleted exits non-zero with nothing on either stream, and the report that reached the
 * transcript read `(diff failed: )` — a blank diagnostic that cost a whole session's
 * investigation. A caller-supplied fallback is what makes the report say something.
 */
export function failureDetail(result: GitResult, fallback: string): string {
  return (result.stderr.trim() || result.stdout.trim() || fallback).slice(0, 400);
}

/** Note sink — `emit` in `run.ts`; a no-op default keeps the module usable from a test. */
export type Note = (message: string) => void;

/**
 * Called after each `createWorktree` succeeds inside `materializeWorkspaceWorktrees`'s loop, with
 * a SNAPSHOT of the current deduped entry set (never a per-iteration append — see that function's
 * own doc comment on why). A no-op default keeps every existing caller and test byte-identical to
 * before this hook existed.
 */
export type PersistWorktrees = (snapshot: readonly WorkspaceWorktree[]) => void | Promise<void>;

/** Is `child` the same path as `parent`, or inside it? Segment-wise, never a bare `startsWith`:
 *  `/a/bc` is not inside `/a/b`. */
function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}

/**
 * Establish one `cez/<id8>` worktree per granted git REPO. A project that is missing, not a git
 * repo, or whose worktree cannot be created contributes NO entry — the caller falls back to
 * granting its real root for that one project, exactly as an ordinary in-place run does, so a
 * single unco-operative repo never cranks the whole run to a halt.
 *
 * Several registry entries inside ONE repo (a repo plus two of its subdirectories) collapse to a
 * single entry rooted at the repo root, and the collapse is NOTED, not silent (X2): twelve
 * projects were granted, and a transcript that accounts for ten reads as a bug. `buildWorkspaceGrant`
 * maps each collapsed entry to its own subdirectory inside the shared tree, so every project keeps
 * a path of its own and the repo root itself stays granted.
 *
 * Idempotent through `createWorktree`: a resume that still has its worktrees reuses them.
 *
 * `persist` (spec 2026-08-22-cross-project-worktree-orphan-prune-safety, Solution/Layer 1's
 * write-ordering fix) closes the window where the FIRST worktree created in a multi-project grant
 * sits on disk, fully created, with no `workspaceWorktrees` record anywhere yet — the loop below
 * creates every project's worktree before this function returns, and both production callers
 * (`run.ts`) persist the whole array in ONE `store.updateRun(...)` only after that. A boot-time
 * `pruneOrphans` in the target project firing inside that window finds an unrecorded, unowned-
 * looking directory whose branch (being brand new) also has no unique commits yet — so the
 * branch-reachability net can't save it either. `persist` is called after each `createWorktree`
 * succeeds with a SNAPSHOT of the CURRENT deduped entry set (`[...byWorktreePath.values()].map(v
 * => v.entry)` — the same expression this function's own `return` uses), never a per-iteration
 * append: several registry entries can collapse onto one worktree path, and a later iteration can
 * retroactively rewrite an already-emitted entry's `root`, so appending would write duplicate rows
 * and leave a stale `root` on the incumbent.
 */
export async function materializeWorkspaceWorktrees(
  runId: string,
  projects: readonly WorkspaceGrantProject[],
  note: Note = () => undefined,
  persist: PersistWorktrees = () => undefined,
): Promise<WorkspaceWorktree[]> {
  /** worktree path → the entry we keep, plus every registry entry that resolved to it. */
  const byWorktreePath = new Map<string, { entry: WorkspaceWorktree; members: string[] }>();
  const snapshot = (): WorkspaceWorktree[] => [...byWorktreePath.values()].map((v) => v.entry);
  for (const project of projects) {
    if (project.status === 'missing') continue;
    const repo = await getRepoInfo(project.root);
    if (!repo) {
      note(`${project.name || project.id}: not a git repo — granted in place (no worktree)`);
      continue;
    }
    // Prefer the resolved REPO root as the entry's root: it is the only cwd `git apply` can
    // resolve a repo-root-relative patch against. Fall back to the project root when the two are
    // textually unrelated (a symlinked checkout, where `--show-toplevel` returns the realpath) —
    // that keeps the pre-dedupe behaviour rather than handing the grant a root nothing matches.
    const repoRoot = contains(repo.root, project.root) ? repo.root : project.root;
    // Fork from the repo's current branch; `createWorktree` pins a detached HEAD to its commit.
    const base = (await resolveBaseRef(repoRoot, repo.branch)) ?? repo.branch;
    try {
      const wt = await createWorktree(repoRoot, runId, base);
      const collapsed = byWorktreePath.get(wt.path);
      if (collapsed) {
        collapsed.members.push(project.name || project.id);
        // Registry order is not repo-root-first: if THIS entry is the ancestor, it is the one
        // whose root `git apply` needs, so it replaces the incumbent.
        if (contains(repoRoot, collapsed.entry.root) && repoRoot !== collapsed.entry.root) {
          collapsed.entry = { ...collapsed.entry, root: repoRoot };
        }
      } else {
        byWorktreePath.set(wt.path, {
          entry: { root: repoRoot, worktreePath: wt.path, branch: wt.branch, baseBranch: wt.baseBranch },
          members: [project.name || project.id],
        });
      }
      await persist(snapshot());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      note(`${project.name || project.id}: worktree failed (${message}) — granted in place`);
    }
  }
  for (const { entry, members } of byWorktreePath.values()) {
    if (members.length < 2) continue;
    note(
      `${members.join(', ')} are one git repo (${entry.root}) — they share the single worktree ${
        entry.worktreePath
      }; each project is its own subdirectory inside it`,
    );
  }
  return snapshot();
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
  /** Always set on `conflict`/`failed` (X6) — a blank diagnostic is a defect in its own right. */
  detail?: string;
}

/**
 * Land one worktree's changes in its real checkout, unstaged, beside whatever the user had in
 * progress, then remove the worktree. Commits the worktree first so the diff captures untracked
 * files too, then `git apply --3way --binary` of `base..HEAD` into the real root. A clean apply
 * removes the worktree and branch (W6); a conflict keeps them as the recovery artifact and reports.
 *
 * Never throws: `applyWorkspaceWorktrees` runs these concurrently under `Promise.all`, and one
 * rejection would take the whole apply-back — and the settle that awaits it — down with it.
 */
async function applyOne(wt: WorkspaceWorktree): Promise<ApplyReport> {
  const base = { root: wt.root, branch: wt.branch } as const;
  try {
    if (!existsSync(wt.worktreePath)) {
      return { ...base, outcome: 'nothing', detail: 'worktree already gone' };
    }
    // Capture everything the agent did as commits so the diff is complete (untracked included).
    await autosaveCommit(wt.worktreePath, 'run finalize');
    const patch = await git(wt.worktreePath, ['diff', '--binary', wt.baseBranch, 'HEAD']);
    if (!patch.ok) {
      const vanished = !existsSync(wt.worktreePath);
      return {
        ...base,
        outcome: 'failed',
        detail: `diff failed: ${failureDetail(
          patch,
          vanished
            ? `worktree ${wt.worktreePath} disappeared while applying`
            : `git diff ${wt.baseBranch}..HEAD exited non-zero with no output`,
        )}`,
      };
    }
    if (!patch.stdout.trim()) {
      await removeWorktree(wt.root, wt.worktreePath, wt.branch);
      return { ...base, outcome: 'nothing' };
    }
    return await serializeByRoot(wt.root, async () => {
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
          detail: failureDetail(applied, 'git apply exited non-zero with no output'),
        };
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, outcome: 'failed', detail: (message || 'apply threw with no message').slice(0, 400) };
  }
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

export interface DiscardReport {
  root: string;
  branch: string;
  /** `discarded`: directory gone, branch kept. `kept`: the directory is still there on purpose. */
  outcome: 'discarded' | 'kept';
  detail?: string;
}

/**
 * A workspace run that ended any way OTHER than success (spec 2026-08-20, X3).
 *
 * Spec 2026-08-19's W7 chose "apply on success only" deliberately — landing a half-finished run in
 * twelve real checkouts is worse than not landing it. What it left unowned was the CLEANUP half:
 * `applyWorkspaceRun` had exactly one call site, so a `failed`/`cancelled`/stopped run kept all
 * twelve directories forever. This is the other half: autosave so nothing is lost, remove the
 * DIRECTORY (gigabytes), keep the `cez/<id8>` BRANCH (bytes, and the only recovery artifact). A
 * continuation re-materializes the tree from that branch, so discarding costs nothing but disk.
 *
 * Fails CLOSED: if the autosave refuses or fails, the uncommitted work is not on the branch yet, so
 * the directory is KEPT rather than deleted. Never throws.
 */
export async function discardWorkspaceWorktrees(
  worktrees: readonly WorkspaceWorktree[],
): Promise<DiscardReport[]> {
  const reports: DiscardReport[] = [];
  for (const wt of worktrees) {
    const base = { root: wt.root, branch: wt.branch } as const;
    try {
      if (!existsSync(wt.worktreePath)) {
        reports.push({ ...base, outcome: 'discarded', detail: 'worktree already gone' });
        continue;
      }
      const saved = await autosaveCommit(wt.worktreePath, 'run finalize');
      if (saved === 'refused' || saved === 'failed') {
        reports.push({
          ...base,
          outcome: 'kept',
          detail: `autosave ${saved} — directory kept so nothing uncommitted is lost`,
        });
        continue;
      }
      await removeWorktree(wt.root, wt.worktreePath); // no branch arg: the branch survives
      reports.push(
        existsSync(wt.worktreePath)
          ? { ...base, outcome: 'kept', detail: 'directory could not be removed' }
          : { ...base, outcome: 'discarded' },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reports.push({ ...base, outcome: 'kept', detail: (message || 'discard threw').slice(0, 400) });
    }
  }
  return reports;
}
