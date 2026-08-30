import { basename } from 'node:path';
import { getRepoSummary, type RepoSummary } from '../server/git.ts';
import type { WorkspaceGitProject } from '@loki-labs/cezar-plus-contract';

/**
 * `WorkspaceGitIndex` — the workspace git overview's read path
 * (`.ai/specs/2026-08-14-cross-project-git-overview.md`, D2-D5).
 *
 * **READ never instantiates.** This module imports neither `../server/project-context.ts`
 * (`ProjectContexts.context()` recovers and RESUMES interrupted agent runs) nor
 * `../workflows/run.ts` — the same invariant `workspace/run-index.ts` guards, and for the same
 * reason. Unlike that module, it DOES import `../server/git.ts` on purpose: `getRepoSummary` is
 * the one place in this repo that shells `git`, so this aggregate can never drift from the
 * per-project detail views that call the same helper. A structural test on this file's own
 * source text pins both halves, WITH a floor — the `server/git.ts` assertion is what keeps the
 * two negatives from silently passing on an empty file (`git-index.test.ts`).
 *
 * **Dependency-injected, not import-wired** (the `WorkspaceRunIndex` / `AutomationCoordinator`
 * precedent): the registry lookup AND the git-shelling call are both functions the caller
 * supplies, so tests stay hermetic, never touch `~/.cezar`, and can substitute a fake that
 * controls timing.
 *
 * **Bounded concurrency, bounded time, both reported as a row (D3).** At most `concurrency`
 * (default 4) project summaries run at once — 12 registered projects at 2 spawns each is 24
 * processes, not 24 fired simultaneously. Each project also gets its own `deadlineMs` (default
 * 5s) covering the WHOLE summary (not each `git` call individually): a repo on a stalled network
 * mount, or a `git` blocked on an index lock an agent run is holding, must not hang the page. A
 * project that trips either the deadline or any other `git` failure answers `{ok: false, reason}`
 * — a row, never a dropped one. Same for a missing root or a non-git root, neither of which even
 * reaches `getRepoSummary`.
 *
 * **No caching (D5).** `WorkspaceRunIndex` caches on `runs.json`'s `mtimeMs`+`size` because that
 * file is the whole input; a working tree has no equivalent key, and the interesting case — an
 * agent writing files right now — is exactly the case a staleness heuristic gets wrong. Bounded
 * cost (concurrency cap + deadline) stands in for a cache instead.
 */

/** One project this index may read from. Structurally a subset of `workspace/projects.ts`'s
 *  `ProjectListEntry` — injected rather than imported so a unit test never has to touch the real
 *  registry file. Mirrors `WorkspaceRunProjectSource`'s shape exactly (`workspace/run-index.ts`). */
export interface WorkspaceGitProjectSource {
  id: string;
  root: string;
  status: 'ok' | 'missing' | 'not-git' | 'no-commits';
  name: string;
}

export interface WorkspaceGitIndexDeps {
  /** The registry lookup, e.g. `workspace/projects.ts`'s `listProjects()` — injected so tests
   *  never read `~/.cezar`. A rejected promise degrades to an empty index rather than throwing. */
  listProjects: () => Promise<readonly WorkspaceGitProjectSource[]>;
  /** Test seam for the git-shelling call itself. Defaults to the real `getRepoSummary` from
   *  `../server/git.ts`. Overriding this is how the concurrency-cap and deadline tests control
   *  timing without spawning real `git` processes. */
  getRepoSummary?: (root: string) => Promise<RepoSummary>;
  /** Max project summaries in flight at once. Default 4 (D3). */
  concurrency?: number;
  /** Per-project deadline in ms, covering the whole summary. Default 5000 (D3). */
  deadlineMs?: number;
}

export interface WorkspaceGitListResult {
  /** Registry order — a failed project is a row, never a gap (D3). */
  projects: WorkspaceGitProject[];
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_DEADLINE_MS = 5_000;

class DeadlineExceededError extends Error {
  constructor() {
    super('timed out');
  }
}

/** Races `promise` against a timer. On a trip, the timer's rejection wins and the original
 *  promise is left to settle on its own — for a real `git` child process that means the process
 *  itself keeps running in the background rather than being killed, which is the same tradeoff
 *  the spec's Risks section accepts for a stalled network mount or a held index lock: the page
 *  must not hang, and nothing here promises to reclaim the process that caused it. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new DeadlineExceededError()), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (err) => {
        clearTimeout(timer);
        rejectPromise(err);
      },
    );
  });
}

/** Bounded-concurrency map: at most `limit` calls to `fn` in flight at once. A worker pool over a
 *  shared cursor rather than a queue library — project counts here are small (registered repos on
 *  one machine), so the simplest correct shape is the right one. `results` preserves `items`'
 *  order regardless of completion order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length || 1));
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/** `git`'s own stderr where available (an `execFile` failure carries it), the deadline's fixed
 *  message, or the error's own message as a last resort — always a non-empty string. */
function describeFailure(err: unknown): string {
  if (err instanceof DeadlineExceededError) return err.message;
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim();
  return err instanceof Error ? err.message : String(err);
}

export class WorkspaceGitIndex {
  private readonly getSummary: (root: string) => Promise<RepoSummary>;
  private readonly concurrency: number;
  private readonly deadlineMs: number;

  constructor(private readonly deps: WorkspaceGitIndexDeps) {
    this.getSummary = deps.getRepoSummary ?? getRepoSummary;
    this.concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
    this.deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  }

  /** One row per considered project, registry order, each either `ok: true` with the summary
   *  spread in, or `ok: false` with a reason — never a gap. An unreadable registry degrades to
   *  zero rows rather than throwing (the same "an unreadable registry degrades to `projects: []`"
   *  doctrine `WorkspaceRunIndex` follows). */
  async list(): Promise<WorkspaceGitListResult> {
    let sources: readonly WorkspaceGitProjectSource[];
    try {
      sources = await this.deps.listProjects();
    } catch {
      return { projects: [] };
    }

    const projects = await mapWithConcurrency(sources, this.concurrency, async (source): Promise<WorkspaceGitProject> => {
      const name = source.name || basename(source.root);
      if (source.status === 'missing') {
        return { id: source.id, name, ok: false, reason: 'root not found' };
      }
      if (source.status === 'not-git') {
        return { id: source.id, name, ok: false, reason: 'not a git repo' };
      }
      // A repo with no commit reports its own reason rather than falling through to `getSummary`,
      // whose git calls all fail on an unborn HEAD and would surface as whatever `describeFailure`
      // makes of `fatal: ambiguous argument 'HEAD'` — a git error string where a plain fact belongs.
      if (source.status === 'no-commits') {
        return { id: source.id, name, ok: false, reason: 'no commits yet' };
      }
      try {
        const summary = await withDeadline(this.getSummary(source.root), this.deadlineMs);
        return { id: source.id, name, ok: true, ...summary };
      } catch (err) {
        return { id: source.id, name, ok: false, reason: describeFailure(err) };
      }
    });

    return { projects };
  }
}
