import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeRoot } from '../workspace/projects.ts';

/** The slice of a `RunManager` this needs. Structural on purpose: the sweep must be testable
 *  without building a real manager, and it has no business reaching for anything else. */
export interface ParkSweepManager {
  recheckManualDeployParks(): Promise<number>;
}

export interface RecheckParksDeps {
  /** The boot project's manager — the one `serveCommand` already holds. */
  bootManager: ParkSweepManager;
  /** The boot project's root, so the registry row pointing at it is not swept twice. */
  bootRoot: string;
  /** Lazily builds (or returns) a registered project's context. Absent in a degraded boot, in
   *  which case only the boot project is swept — the behaviour before this existed. */
  contexts?: { context(projectId: string): Promise<{ manager: ParkSweepManager }> };
  /** The project registry. */
  listProjects: () => Promise<readonly { id: string; root: string }[]>;
}

/**
 * Re-probe every `manual-deploy` park in the WHOLE WORKSPACE after a restart, not just the boot
 * project's.
 *
 * **The bug this exists for, measured on prod-host 2026-08-29.** `serveCommand` called
 * `manager.recheckManualDeployParks()` on the boot manager alone. On that box the boot project is
 * `workspace` (`WorkingDirectory=/var/lib/cezar/workspace`, `bootProject: "workspace"`), while
 * every cezar deploy park lives in the separately-registered `cezar` project. So the sweep swept a
 * project that never parks and never touched the one that does: two runs sat parked for three days
 * across an activation that satisfied both of them, and the operator was told in
 * `.ai/deploy-targets.json` that they "should NOT need to press Resolve".
 *
 * Verified directly after the 2026-08-29 activation: live sha was `a04cda25`, the parked run's own
 * probe exited **0** when run by hand in its worktree, and the run was still `waiting` on
 * `manual-deploy`. The probe was right, the deploy was right; nothing asked.
 *
 * **Laziness is preserved deliberately.** Building a `ProjectContext` opens a `RunStore`, activates
 * knowledge/source stores and starts sweeps — the cost the lazy-watcher work exists to avoid — so
 * a project is only ever built when a CHEAP READ of its `runs.json` shows it actually has a park.
 * A workspace of twenty quiet projects opens none of them.
 *
 * The raw read is also the only safe way to look: opening a second `RunStore` over a data dir that
 * may later get a real context is the two-in-memory-copies data-loss bug `project-context.ts`
 * documents at its `boot-root-conflict` guard. This never opens a store; it parses the file and
 * hands off to the context that owns it.
 *
 * Per project, failures are contained: an unreadable registry row, a malformed `runs.json` or a
 * context that refuses to build costs that project its recheck and nothing else. A park left
 * behind is a button press; a throw here would abort the sweep for every project after it.
 */
export async function recheckManualDeployParksEverywhere(deps: RecheckParksDeps): Promise<number> {
  let requeued = 0;
  try {
    requeued += await deps.bootManager.recheckManualDeployParks();
  } catch {
    // The boot project failing must not cost every other project its sweep.
  }
  if (!deps.contexts) return requeued;

  let projects: readonly { id: string; root: string }[] = [];
  try {
    projects = await deps.listProjects();
  } catch {
    return requeued;
  }

  const bootReal = await safeNormalize(deps.bootRoot);
  for (const project of projects) {
    // The boot project is reachable through the registry too, and its context resolver
    // short-circuits to the boot manager — sweeping it again would double-count, not double-work.
    if (bootReal !== undefined && (await safeNormalize(project.root)) === bootReal) continue;
    if (!hasManualDeployPark(project.root)) continue;
    try {
      const ctx = await deps.contexts.context(project.id);
      requeued += await ctx.manager.recheckManualDeployParks();
    } catch {
      // A project that cannot be built keeps its park; every other project still gets swept.
    }
  }
  return requeued;
}

async function safeNormalize(root: string): Promise<string | undefined> {
  try {
    return await normalizeRoot(root);
  } catch {
    return undefined;
  }
}

/**
 * The cheap read that decides whether a project is worth opening: does its `runs.json` contain a
 * run that is `waiting` on a `manual-deploy` handoff?
 *
 * Deliberately tolerant — a missing file, unreadable dir or malformed JSON answers "no park", the
 * direction that costs a button press rather than one that opens a store for a project that has
 * nothing to sweep.
 */
function hasManualDeployPark(root: string): boolean {
  const path = join(root, '.ai/cezar/runs.json');
  try {
    if (!existsSync(path)) return false;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const runs = Array.isArray(parsed) ? parsed : [];
    return runs.some((run) => {
      if (typeof run !== 'object' || run === null) return false;
      const record = run as { status?: unknown; pendingHandoff?: { kind?: unknown } | null };
      return record.status === 'waiting' && record.pendingHandoff?.kind === 'manual-deploy';
    });
  } catch {
    return false;
  }
}
