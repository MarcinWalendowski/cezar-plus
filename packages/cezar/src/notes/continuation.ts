import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.ts';
import type { RunRecord } from '../runs/store.ts';
import { AUTONOMOUS_IMPLEMENTATION_WORKFLOW, type WorkflowDef } from '../workflows/types.ts';
import { loadWorkflows } from '../workflows/load.ts';
import type { NoteStore } from './store.ts';

/**
 * The trigger half of PLAN D27 Phase 3 (`.ai/specs/2026-08-15-autonomous-implementation-
 * continuation.md`): when a spec run for an AUTONOMOUS note reaches `done`, start one
 * implementation run in the same project against the spec that run wrote — no second
 * "Start implementation" click.
 *
 * **Layering mirrors `approve.ts`, reversed.** `NoteApproverDeps.startRun` is threaded as a
 * callback specifically so `notes/` has no import path to the run machinery
 * (`workflows/run.ts`'s `RunManager`). This file needs the same discipline in the OTHER
 * direction: `workflows/run.ts` must have no import path back into `notes/`, so it cannot call
 * this class directly either. `server.ts` is where both directions meet — it subscribes to each
 * project's `RunStore`'s own `'run'` event (already public, no `RunManager` import required) and
 * hands this class a `startRun` callback closing over that SAME project's manager, exactly the
 * way it already builds `noteApprover`'s.
 *
 * **This file may never build a `ProjectContext`.** It is instantiated once per already-built
 * context (`server.ts`), bound to that one project — never given a `listProjects`/`contexts`
 * handle of its own — so there is no path from here back to the triage-side "never build a
 * context on the read path" guarantee `notes/processor.ts` protects (see its own module doc and
 * `processor.test.ts`).
 */

export interface NoteContinuationStartOptions {
  /** Self-continuing, no "needs you" — nobody is watching an unattended implementation run. This
   *  is exactly the run shape (`RunManager`'s own `#autonomous`, an open session self-continuing
   *  turn after turn rather than parking at `waiting`) the turn-level step-budget fix (`30ff1847`)
   *  was built to bound — the two decisions are connected, not coincidental: an unattended run that
   *  never asks for you is precisely the one that needs `stepBudgetOverride` below to be real. */
  autonomous: true;
  /** PLAN D27 Phase 3's bound: set only when this project's own `config.stepBudget` is 0/unset —
   *  see `startOptions()`'s own doc comment below. */
  stepBudgetOverride?: number;
}

export interface NoteContinuationDeps {
  store: NoteStore;
  /** For messages and diagnostics only — never used to resolve a project. */
  projectId: string;
  /** The one project this trigger instance is bound to — used to resolve a repo-local
   *  `autonomous-implementation` workflow override and this project's own `stepBudget`. */
  projectRoot: string;
  /** Start a run in THIS project. See the module doc for why this is a callback rather than an
   *  import. */
  startRun: (
    workflow: WorkflowDef,
    task: string,
    options: NoteContinuationStartOptions,
  ) => Promise<RunRecord>;
  warn?: (message: string) => void;
}

/**
 * Default step budget for an autonomous continuation when this project's own `config.stepBudget`
 * is 0/unset — PLAN D27 Phase 3's "trap", named in the spec's own Phase 3 note: Phase 1 kept the
 * repo-wide default at unlimited on purpose (a nonzero ceiling would have changed the behaviour of
 * every existing manual and retry-heavy run the moment it shipped), which means an autonomous run
 * started under that default would otherwise be genuinely unbounded — and the step budget is the
 * *only* bound the owner chose for this feature.
 *
 * Chosen over refusing to start when no budget is configured: refusing would silently defeat
 * "continue automatically" — the whole point of this spec — for the overwhelmingly common case of
 * a project that never touched `stepBudget`, trading a visible feature for a silent no-op nobody
 * asked for. This default applies to THIS run only (`RunRecord.stepBudgetOverride`); the repo-wide
 * default stays unlimited for every manually-started run, unchanged.
 *
 * Same order of magnitude as `MAX_AUTO_CONTINUES` (`workflows/run.ts`) — a different mechanism,
 * chosen independently, not derived from it (see PLAN D27's own note on the two never being
 * conflated) — enough turns for a real implement-and-gate task while remaining a real ceiling.
 */
export const AUTONOMOUS_DEFAULT_STEP_BUDGET = 40;

export class NoteContinuationTrigger {
  constructor(private readonly deps: NoteContinuationDeps) {}

  /**
   * Called for every `'run'` event this project's store reports — every field write on every run,
   * not only a terminal one (see `server.ts`'s wiring, which subscribes to the store's own event
   * rather than a purpose-built "settled" signal). Fast no-op unless `run` is a `done`,
   * `kind: 'spec'` run belonging to an autonomous note whose implementation leg is not yet
   * claimed, so it is safe and cheap to call from a hot, high-frequency event, and safe to call
   * repeatedly for the same run (the claim below makes a second call a no-op).
   */
  async onRunSettled(run: RunRecord): Promise<void> {
    if (run.status !== 'done') return; // only a clean finish — never any other terminal state
    const found = this.deps.store.findResultingRun(run.id, 'spec');
    if (!found) return; // not a note-to-spec run at all
    const { note, proposalId } = found;
    if (note.autonomous !== true) return; // the owner's explicit per-note opt-in
    const proposal = note.pass?.proposals.find((p) => p.id === proposalId);
    if (!proposal) return;
    if (proposal.implementationRunId) return; // already claimed or started

    const placeholder = `pending_${randomUUID()}`;
    const claim = await this.deps.store.claimImplementation(note.id, proposalId, placeholder);
    if (!claim.claimed) return; // lost a double-trigger race — the other caller owns this proposal

    try {
      const workflow = await this.resolveWorkflow();
      const options = await this.startOptions();
      const implRun = await this.deps.startRun(workflow, this.taskFor(run), options);
      await this.deps.store.recordResultingTask(note.id, {
        proposalId,
        projectId: proposal.projectId,
        runId: implRun.id,
        kind: 'implementation',
      });
    } catch (error) {
      await this.deps.store.releaseImplementationClaim(note.id, proposalId);
      this.deps.warn?.(
        `[cez] autonomous continuation failed for note ${note.id} / proposal ${proposalId} in ` +
          `project ${this.deps.projectId}: ${describe(error)}`,
      );
    }
  }

  /**
   * "The spec that run just wrote" (the spec's own "Architecture" section) — `run.declaredSpecPath`
   * when the spec run declared one (see `runs/task-markers.ts`'s `CEZ:SPEC_PATH=`). A run that
   * finished without declaring one (an agent that skipped the closing instruction, or an older
   * build) still gets a continuation rather than a silent no-op — the note named real work — but
   * the task says plainly that the path was not detected, rather than inventing one: the same
   * "worth being able to see, not paper over" reasoning `declaredSpecPath`'s own doc comment gives.
   */
  private taskFor(run: RunRecord): string {
    if (run.declaredSpecPath) return `Implement the spec at ${run.declaredSpecPath}.`;
    return (
      `Implement the spec written by run ${run.id}. Its path was not automatically detected — ` +
      'find the spec file that run added before implementing it.'
    );
  }

  /** `AUTONOMOUS_IMPLEMENTATION_WORKFLOW` unless this project defines its own `autonomous-
   *  implementation` workflow file — the same override precedent `approve.ts`'s own
   *  `resolveWorkflow` sets for `note-to-spec`. */
  private async resolveWorkflow(): Promise<WorkflowDef> {
    const { workflows } = await loadWorkflows(this.deps.projectRoot);
    const match = workflows.find((w) => w.name === AUTONOMOUS_IMPLEMENTATION_WORKFLOW.name);
    return match ?? AUTONOMOUS_IMPLEMENTATION_WORKFLOW;
  }

  /**
   * `autonomous: true` (self-continuing, no "needs you" — nobody is watching) plus the
   * bound-enforcement decision for PLAN D27 Phase 3's "trap": this project's own
   * `config.stepBudget` when it configured one (`undefined` here defers to it, exactly like every
   * manually-started run), else `AUTONOMOUS_DEFAULT_STEP_BUDGET` for THIS run only. "Autonomous and
   * unbounded" must be unreachable — see `AUTONOMOUS_DEFAULT_STEP_BUDGET`'s own doc comment for why
   * a default was chosen over refusing to start.
   */
  private async startOptions(): Promise<NoteContinuationStartOptions> {
    const config = await loadConfig(this.deps.projectRoot);
    return {
      autonomous: true,
      stepBudgetOverride: config.stepBudget > 0 ? undefined : AUTONOMOUS_DEFAULT_STEP_BUDGET,
    };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
