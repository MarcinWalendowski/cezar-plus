import { z } from 'zod';

/**
 * The WORKSPACE GIT overview — `GET /api/v1/workspace/git`, a read-only, server-side aggregate
 * of every registered project's git state (`CEZ_WORKSPACE_VIEWS=1`). See
 * `.ai/specs/2026-08-14-cross-project-git-overview.md`.
 *
 * The read path (`WorkspaceGitIndex`) shells `git` against each project's bare root path — it
 * never calls `contexts.context(id)`, because building a context prunes orphans, reclaims
 * worktrees and recovers every interrupted run in that project, none of which a git status page
 * needs or should trigger.
 *
 * **Flag-off shape (D1, matching the workspace runs family).** With `CEZ_WORKSPACE_VIEWS` unset
 * (or `CEZ_SINGLE_PROJECT=1`, which reports the capability false), `GET /workspace/git` answers
 * 200 with a schema-valid empty payload — never 404. Read-only, so there is no mutator to 409.
 */

export const workspaceGitDirtySchema = z.object({
  staged: z.number().int(),
  unstaged: z.number().int(),
  untracked: z.number().int(),
});
export type WorkspaceGitDirty = z.infer<typeof workspaceGitDirtySchema>;

export const workspaceGitHeadSchema = z.object({
  hash: z.string(),
  subject: z.string(),
  author: z.string(),
  when: z.string(),
});
export type WorkspaceGitHead = z.infer<typeof workspaceGitHeadSchema>;

/**
 * One project's row. A failed project (missing root, non-git root, a `git` failure, or a
 * deadline trip) is `ok: false` with `reason` set — a ROW, never a dropped entry, matching
 * `WorkspaceProjectHealth`'s degradation contract in the runs family.
 *
 * `ahead`/`behind` are optional and NEVER defaulted to `0`: absent means "no upstream to compare
 * against", present (including `0`) means "compared, and this is the answer" — two different
 * facts a default would collapse into one.
 */
export const workspaceGitProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  ok: z.boolean(),
  reason: z.string().optional(),
  branch: z.string().optional(),
  detached: z.boolean().optional(),
  upstream: z.string().optional(),
  ahead: z.number().int().optional(),
  behind: z.number().int().optional(),
  dirty: workspaceGitDirtySchema.optional(),
  head: workspaceGitHeadSchema.optional(),
});
export type WorkspaceGitProject = z.infer<typeof workspaceGitProjectSchema>;

/** `GET /workspace/git`. Registry order — sorting dirty-first is a later decision, not a silent
 *  default (the spec's Risks section). */
export const workspaceGitResponseSchema = z.object({
  projects: z.array(workspaceGitProjectSchema),
  bootProject: z.string(),
});
export type WorkspaceGitResponse = z.infer<typeof workspaceGitResponseSchema>;
