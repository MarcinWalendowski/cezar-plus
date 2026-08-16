import { z } from 'zod';
import { createRunInputBaseSchema, runRecordSchema } from './runs.ts';

/**
 * `POST /api/v1/workspace/runs` (`.ai/specs/2026-08-15-cross-project-workspace-run.md`) — the
 * composer's Workspace submit path: **one run, not scoped to any project**, that reads and writes
 * in every registered project directory.
 *
 * Workspace-level, like `./workspace-todos.ts` and `./workspace-runs.ts` — never
 * `/p/:projectId`-prefixed, because the whole point is that no project is named.
 *
 * **SUPERSEDES `./task-fanout.ts`, deleted with this spec.** That route answered the same submit
 * by splitting one request into N per-project todos. The owner's verdict on it, in full: *"i don't
 * want to have task per each project — it should be still one task that makes me one output and
 * apply changes across all directories/projects"*. So this route starts ONE run instead of filing
 * N tasks, and it starts it immediately — the fan-out's ~60 s analysis pass, and every surface
 * built to make that wait visible, are gone with it.
 *
 * **A run has to live in some project's `runs.json`**, because every `RunManager` is bound to a
 * repository. It lives in the boot project's — the same repo every other workspace-level pass
 * already runs in. `project` in the response names that slug so the caller can navigate to the
 * thread. That is a storage fact and nothing more: the run's cwd holds none of the work, and its
 * grant covers every registered project.
 */

/**
 * Deliberately built by OMISSION from `createRunInputBaseSchema` rather than by re-listing the
 * keys: `task`, `model`, `runner`, `agentProfile`, `systemPrompt`, `images`, `autonomous`,
 * `generateFollowups`, `workflow`/`steps` mean exactly what they mean for `POST /runs`, and a
 * hand-copied list would drift the first time one of them gains a bound.
 *
 * The three that are dropped are dropped because a workspace run FIXES them:
 *  - `worktree` — there is no single repo to branch. Forced in-place, server-side.
 *  - `variants` — variants exist to isolate parallel attempts in worktrees; see above.
 *  - `todoId` — that is the inbox's "start this filed task" audit trail, and it is per-project.
 *
 * **`.strict()`, unlike `POST /runs`**, and specifically because of those three. Zod strips an
 * unknown key by default, so a client asking for `worktree: true` would get a 201 and a run with
 * no worktree — "we heard you and did something else", which for a run that edits real checkouts
 * is the worst available answer. Strict makes it "we heard you and refused". The cost is that a
 * key added to `createRunInputBaseSchema` later is a 400 here until someone decides what it means
 * for a workspace run, which is the right way round for this route.
 */
export const workspaceRunStartInputSchema = createRunInputBaseSchema
  .omit({ worktree: true, variants: true, todoId: true })
  .strict()
  .refine((b) => !(b.workflow && b.steps), {
    message: 'provide "workflow" or "steps", not both',
  });
export type WorkspaceRunStartInput = z.input<typeof workspaceRunStartInputSchema>;

export const workspaceRunStartResponseSchema = z.object({
  run: runRecordSchema,
  /** The registry slug of the project whose `runs.json` holds this run — the boot project. The
   *  client needs it to build the thread URL (`/p/<project>/tasks/<run.id>`), and it is never
   *  hardcoded client-side because the boot project's slug is allocated at boot. */
  project: z.string(),
  /** What the run was granted, as it was granted — after containment dedupe, so this is the
   *  directory list, not the project list. Rendered rather than assumed: a workspace run whose
   *  grant collapsed to one directory, or to none, must not look like one that reached
   *  everything. */
  grantedRoots: z.array(z.string()),
});
export type WorkspaceRunStartResponse = z.infer<typeof workspaceRunStartResponseSchema>;
