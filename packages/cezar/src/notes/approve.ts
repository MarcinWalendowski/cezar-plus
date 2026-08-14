import { randomUUID } from 'node:crypto';
import type { ApproveNoteInput, ApproveNoteResponse } from '@open-mercato/cezar-contract';
import { AGENT_MODELS_LOCKED_ERROR, agentModelsLocked } from '../core/agent-model-policy.ts';
import type { RunRecord } from '../runs/store.ts';
import { NOTE_TO_SPEC_WORKFLOW, type WorkflowDef } from '../workflows/types.ts';
import { loadWorkflows } from '../workflows/load.ts';
import type { NotePipelineFailure } from './pipeline.ts';
import type { NoteStore } from './store.ts';
import type { StoredNote } from './types.ts';

/**
 * Approval — the ONLY path from a note to a run (P2.3, spec
 * `.ai/specs/2026-08-14-note-to-spec-pipeline.md`).
 *
 * ## This file may build a project context, and the triage pass may not
 *
 * `./processor.ts` is guarded against ever reaching the run machinery, because a cross-project
 * READ that built contexts would resume interrupted agent runs in every registered repository as
 * a side effect of someone typing a note. Approval is the opposite case: a person has read one
 * proposal and asked for a run in one named repository, and building that project's context is
 * what starting a run there *means*. The asymmetry is deliberate, is why `NotePipeline` is an
 * interface rather than a direct import, and is bounded by the fact that only the projects a
 * person explicitly approved are ever touched.
 *
 * ## The claim is taken BEFORE the run starts
 *
 * `store.claimProposal` checks and sets `createdRunId` under the store's own lock, and only then
 * does `startRun` happen. Getting that order wrong makes a double-click produce two agent runs in
 * two repositories from one approval — invisible, expensive, and impossible to undo. In this
 * order the worst case is a claimed proposal whose run never started, which is visible in the UI
 * and released back for a retry right here in the failure path.
 *
 * ## Partial success is normal
 *
 * Three proposals where one project's folder has been deleted is two runs and one refusal, not a
 * 4xx. All-or-nothing PER proposal, partial ACROSS them, reported in one 200 body — because a
 * 4xx would make "two of three started" unreadable, and re-approving to find out would start the
 * two again.
 */

export interface NoteApproverProject {
  id: string;
  root: string;
  status: 'ok' | 'missing' | 'not-git';
}

export interface NoteApproverDeps {
  store: NoteStore;
  listProjects: () => Promise<readonly NoteApproverProject[]>;
  /**
   * Start a run in one project. Threaded as a callback rather than taken as a `ProjectContexts`
   * so this module has no import path to the run machinery either — the wiring in `server.ts`
   * closes over `contexts.context(id)` and this file stays testable without one.
   */
  startRun: (projectId: string, workflow: WorkflowDef, task: string, options: StartOptions) => Promise<RunRecord>;
  warn?: (message: string) => void;
}

export interface StartOptions {
  runner?: RunRecord['runner'];
  model?: string;
  agentProfile?: string;
}

export class NoteApprover {
  constructor(private readonly deps: NoteApproverDeps) {}

  async approve(
    noteId: string,
    input: ApproveNoteInput,
  ): Promise<{ ok: true; body: ApproveNoteResponse } | NotePipelineFailure> {
    const note = this.deps.store.get(noteId);
    if (!note) return { ok: false, status: 404, error: 'not found' };
    const pass = note.pass;
    // A re-process in another tab replaces the pass, so the proposal ids in this body may name
    // rows that no longer exist — or worse, DIFFERENT rows that happen to share an id. Refusing
    // on a stale pass is what keeps "approve p1" from approving something the user never read.
    if (!pass || pass.id !== input.passId) {
      return { ok: false, status: 409, error: 'this note has been re-analysed since — reload it' };
    }

    const projects = new Map((await this.deps.listProjects()).map((p) => [p.id, p] as const));
    const created: ApproveNoteResponse['created'] = [];
    const rejected: ApproveNoteResponse['rejected'] = [];

    for (const requested of input.proposals) {
      const proposal = pass.proposals.find((row) => row.id === requested.id);
      if (!proposal) {
        rejected.push({ proposalId: requested.id, status: 404, error: 'no such proposal on this pass' });
        continue;
      }
      // A per-row edit from the review screen wins over what the pass proposed — retargeting a
      // project or rewriting the brief is the point of a review gate.
      const projectId = requested.projectId ?? proposal.projectId;
      const task = requested.task ?? proposal.task;
      const project = projects.get(projectId);

      if (!project) {
        rejected.push({ proposalId: requested.id, projectId, status: 404, error: `unknown project: ${projectId}` });
        continue;
      }
      if (project.status === 'missing') {
        rejected.push({ proposalId: requested.id, projectId, status: 409, error: `the folder for ${projectId} is gone` });
        continue;
      }
      const model = requested.model;
      if (model?.trim() && agentModelsLocked(project.root)) {
        rejected.push({ proposalId: requested.id, projectId, status: 409, error: AGENT_MODELS_LOCKED_ERROR });
        continue;
      }

      // THE CLAIM, before anything is started. See the module doc.
      const placeholder = `pending_${randomUUID()}`;
      const claim = await this.deps.store.claimProposal(noteId, requested.id, placeholder);
      if (!claim.claimed) {
        rejected.push({
          proposalId: requested.id,
          projectId,
          status: 409,
          error: claim.runId
            ? `already started as run ${claim.runId}`
            : 'this proposal could not be claimed',
        });
        continue;
      }

      try {
        const workflow = await this.resolveWorkflow(project.root, requested.workflow ?? proposal.workflow);
        const run = await this.deps.startRun(projectId, workflow, task, {
          ...(requested.runner ?? proposal.runner ? { runner: requested.runner ?? proposal.runner } : {}),
          ...(model ? { model } : {}),
          ...(requested.agentProfile ?? proposal.agentProfile
            ? { agentProfile: requested.agentProfile ?? proposal.agentProfile }
            : {}),
        });
        await this.deps.store.recordResultingTask(noteId, {
          proposalId: requested.id,
          projectId,
          runId: run.id,
          kind: 'spec',
        });
        created.push({ proposalId: requested.id, projectId, runId: run.id });
      } catch (error) {
        // The claim is released, so the row is retryable rather than stuck holding a placeholder
        // for a run that does not exist. This is the whole reason claiming first is safe.
        await this.deps.store.releaseProposal(noteId, requested.id);
        const message = error instanceof Error ? error.message : String(error);
        this.deps.warn?.(`Could not start the spec run for ${projectId}: ${message}`);
        rejected.push({ proposalId: requested.id, projectId, status: 400, error: message });
      }
    }

    const after = this.deps.store.get(noteId);
    return {
      ok: true,
      body: { note: (after ?? note) as StoredNote, created, rejected },
    };
  }

  /**
   * The workflow the spec run uses.
   *
   * Always `note-to-spec` unless the proposal named one the project actually has: approving a
   * proposal starts an INVESTIGATION, and a repo's own `deploy` workflow is not that. A named
   * workflow that has since been deleted degrades to the built-in rather than failing the row —
   * the contract's `unknown-workflow` issue says exactly this ("falls back on approval").
   */
  private async resolveWorkflow(root: string, named: string | undefined): Promise<WorkflowDef> {
    const { workflows } = await loadWorkflows(root);
    if (named) {
      const match = workflows.find((workflow) => workflow.name === named);
      if (match) return match;
    }
    return workflows.find((workflow) => workflow.name === NOTE_TO_SPEC_WORKFLOW.name) ?? NOTE_TO_SPEC_WORKFLOW;
  }
}
