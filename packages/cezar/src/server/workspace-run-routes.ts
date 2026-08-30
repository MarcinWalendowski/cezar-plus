import { Hono } from 'hono';
import {
  workspaceRunStartInputSchema,
  type WorkspaceRunStartResponse,
} from '@loki-labs/cezar-plus-contract';
import { jsonZodValidator } from './validators.ts';
import type { ProjectApiEnv } from './server.ts';
import type { RunRecord } from '../runs/store.ts';
import { INPUT_TO_TASKS_NAME, inputToTasksPlan, type WorkflowDef } from '../workflows/types.ts';
import type { StartRunInput } from '../workflows/run.ts';
import { loadWorkspaceGrant, type WorkspaceGrant } from '../workspace/granted-roots.ts';
import { authorOf } from './request-author.ts';

/**
 * `POST /api/v1/workspace/runs` — the composer's Workspace submit path
 * (`.ai/specs/2026-08-15-cross-project-workspace-run.md`).
 *
 * ONE run, not scoped to any project, granted read/write access to every registered project
 * directory. Replaces the knowledge-grounded task fan-out, which answered the same submit by
 * filing N per-project todos — the mechanism the owner rejected outright.
 *
 * **What this file decides, and what it deliberately does not.** The three things a workspace run
 * fixes are decided here and nowhere else:
 *
 *  1. `worktree: false`, unconditionally. There is no single repository to branch, and an
 *     isolated worktree of the boot repo would isolate nothing that matters while making the run
 *     look sandboxed.
 *
 *     **Corrected 2026-08-20** (spec `2026-08-19-parallel-workspace-runs-worktrees.md`, extended by
 *     `2026-08-20-workspace-run-worktree-isolation.md`). This used to say the consequence was "one
 *     workspace run at a time", because an in-place run takes the boot repo's exclusive
 *     working-tree lease. That has been false since 2026-08-19: a workspace run isolates each
 *     granted git REPO in its own `cez/<id8>` worktree (`workspace/workspace-worktrees.ts`), takes
 *     NO boot-root lease, and is exempt from the non-git single-slot cap in `pump()` — so N
 *     workspace runs run at once, up to `maxParallel`, and their diffs are applied back to the real
 *     checkouts when they settle successfully. `worktree: false` still holds; only its consequence
 *     changed.
 *  2. The grant, read once from the registry here and PERSISTED on the record. Every later step
 *     and every restart re-applies that stored list — see `runRecordSchema.workspaceProjects`.
 *  3. The boot project as the run's home, because a `RunManager` is bound to a repository and
 *     this is the one every workspace-level pass already uses.
 *
 *     **Amended 2026-08-21** (spec `2026-08-21-workspace-boot-repo-and-always-worktrees.md`).
 *     The boot root IS a git repository now — `workspace/boot-repo.ts#ensureBootRepo` init-plus-
 *     commits it at boot, tracking two files with `.ai/` and `.claude/` ignored. Nothing on this
 *     route changes: a workspace run still takes the earlier `isWorkspaceRun` branch and never
 *     touches the boot repo. What changed is what happens to a run that reaches the boot root
 *     WITHOUT the grant this route is the only writer of. Nine other `startRun` call sites omit
 *     it, and such a run used to fall into the ordinary non-git branch — running in the scratch
 *     root itself, holding its exclusive lease, capped at one at a time (measured: run
 *     `50ce87f1`, 85 minutes). `run.ts#adoptWorkspaceGrant` now loads the same grant this route
 *     loads and puts the run back on this path. So a run fixed there is indistinguishable on the
 *     wire from one submitted here, which is the point.
 *
 * Everything else — model policy, provider availability, agent account, workflow resolution — is
 * INJECTED, not re-implemented. Those guards belong to `POST /runs` and must answer identically
 * here; a second copy would drift the first time one of them changed. `server.ts` passes its own.
 *
 * **Ungated.** No `capabilities()` check, for the same reason the route it replaces had none: this
 * is the composer's default submit path on a workspace with more than one project, and gating a
 * main path on a flag nobody sets makes it fail as silence.
 */

export interface WorkspaceRunRouteDeps {
  /** The boot project's registry slug — the response names it so the client can build the thread
   *  URL. Resolved lazily because it is allocated at boot. */
  bootProject: () => Promise<string>;
  /** The boot project's own root and manager. Not `contexts.context(id)`: this context already
   *  exists in the serving process, so starting a workspace run builds nothing. */
  bootRoot: string;
  startRun: (workflow: WorkflowDef, input: StartRunInput) => RunRecord;
  /** `POST /runs`' own workflow resolution, injected whole (project file wins, `quick-task` is
   *  the floor, an unknown name is a 404). Includes the composer review-step toggles
   *  (`.ai/specs/2026-08-30-composer-review-step-toggles.md`) — no-op unless the resolved
   *  workflow carries a matching step id, so `input-to-tasks` (the default here) is unaffected. */
  resolveWorkflow: (
    root: string,
    body: {
      workflow?: string;
      steps?: WorkflowDef['steps'];
      reviewSameModel?: boolean;
      reviewCrossModel?: boolean;
    },
  ) => Promise<{ workflow: WorkflowDef } | { error: string; status: 400 | 404 }>;
  /** `POST /runs`' own pre-start guards, injected whole — model policy, provider availability,
   *  agent account. Returns the error to answer with, or null. */
  guard: (
    root: string,
    workflow: WorkflowDef,
    body: { model?: string; runner?: string; agentProfile?: string },
  ) => Promise<{ error: string; status: 400 | 409 } | null>;
  /** Test seam. Defaults to the real registry read. */
  loadGrant?: () => Promise<WorkspaceGrant>;
}

export function createWorkspaceRunRoutes(deps: WorkspaceRunRouteDeps) {
  const loadGrant = deps.loadGrant ?? loadWorkspaceGrant;

  return new Hono<ProjectApiEnv>().post(
    '/workspace/runs',
    jsonZodValidator(workspaceRunStartInputSchema),
    async (c) => {
      const body = c.req.valid('json');

      // Workspace scope defaults to `input-to-tasks`
      // (`.ai/specs/2026-08-25-workspace-scope-routes-tasks.md`): a workspace run routes work into
      // projects rather than doing it, and that is the workflow that does the routing. A caller
      // naming another workflow still gets it — this is a DEFAULT, not a restriction. The composer
      // offers only this one at workspace scope; the route stays open because cezar is published
      // and rejecting a workflow name that worked yesterday is a breaking change
      // (`BACKWARD_COMPATIBILITY.md`), and because `steps` (an inline chain) must keep working.
      const workflowName = body.workflow ?? (body.steps === undefined ? INPUT_TO_TASKS_NAME : undefined);
      const resolved = await deps.resolveWorkflow(deps.bootRoot, {
        ...(workflowName === undefined ? {} : { workflow: workflowName }),
        ...(body.steps === undefined ? {} : { steps: body.steps as WorkflowDef['steps'] }),
        ...(body.reviewSameModel === undefined ? {} : { reviewSameModel: body.reviewSameModel }),
        ...(body.reviewCrossModel === undefined ? {} : { reviewCrossModel: body.reviewCrossModel }),
      });
      if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
      const workflow = inputToTasksPlan(resolved.workflow, body.autoStart === true);

      const blocked = await deps.guard(deps.bootRoot, workflow, {
        ...(body.model === undefined ? {} : { model: body.model }),
        ...(body.runner === undefined ? {} : { runner: body.runner }),
        ...(body.agentProfile === undefined ? {} : { agentProfile: body.agentProfile }),
      });
      if (blocked) return c.json({ error: blocked.error }, blocked.status);

      const grant = await loadGrant();
      // A workspace with nothing reachable is a 409, never a run: starting an agent in an empty
      // scratch repo and calling it a workspace run would be the exact "it worked, and nothing
      // happened" shape this spec exists to remove.
      if (grant.roots.length === 0) {
        return c.json(
          {
            error:
              'no registered project is on disk — a workspace run has nothing to work in. Add a project first.',
          },
          409,
        );
      }

      const input: StartRunInput = {
        task: body.task,
        ...(body.model === undefined ? {} : { model: body.model }),
        ...(body.runner === undefined ? {} : { runner: body.runner }),
        ...(body.agentProfile === undefined ? {} : { agentProfile: body.agentProfile }),
        ...(body.systemPrompt === undefined ? {} : { systemPrompt: body.systemPrompt }),
        ...(body.autonomous === undefined ? {} : { autonomous: body.autonomous }),
        ...(body.generateFollowups === undefined
          ? {}
          : { generateFollowups: body.generateFollowups }),
        ...(body.images === undefined
          ? {}
          : {
              images: body.images.map((img) => ({
                type: 'image' as const,
                source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
              })),
            }),
        // Who asked (spec 2026-08-21-task-author-provenance) — the same request-derived answer
        // `POST /runs` gives, through the same helper, so the two composer submits can never
        // disagree about who started a task.
        author: authorOf(c, 'workspace-composer'),
        // The decisions this route owns.
        worktree: false,
        workspaceProjects: grant.projects,
        // Absent means false. Recorded when supplied so restart recovery has the original choice.
        ...(body.autoStart === undefined ? {} : { autoStart: body.autoStart }),
      };

      const run = deps.startRun(workflow, input);
      const response: WorkspaceRunStartResponse = {
        run,
        project: await deps.bootProject(),
        grantedRoots: grant.roots,
      };
      return c.json(response, 201);
    },
  );
}
