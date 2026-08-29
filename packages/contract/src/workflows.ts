import { z } from 'zod';
import { runnerSchema } from './health.ts';

/**
 * The WORKFLOWS family: the chain catalog, the save/parse routes, and the planner.
 *
 * This file must NOT import `./runs.ts`: the run record embeds a workflow definition
 * (`RunRecord.workflowDef`), so `runs.ts` imports the two definition schemas below, and a second
 * edge back would be a module cycle — one whose top-level `z.object(…)` calls would hit a TDZ at
 * import time, not a type error. The parallel-variant shapes (`/groups/:groupId/*`), which DO
 * embed the record, live with the run family for the same reason.
 */

// ---- workflows (`GET/POST /workflows`, `DELETE /workflows/:name`, `POST /workflows/parse`) ----

/**
 * One step of a chain: either an agent step (`prompt`/`skill`) or a check step (`command`).
 *
 * `onFail.max` carries a `.default(2)`, exactly as `src/workflows/types.ts` declares it, so the
 * OUTPUT shape the routes serve has `max` present whenever `onFail` is.
 */
export const workflowStepDefSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    // agent step
    prompt: z.string().optional(),
    skill: z.string().optional(),
    model: z.string().optional(),
    /**
     * A reasoning-depth ceiling. Mirrors `effort` in `src/workflows/types.ts`.
     *
     * **Added here 2026-08-24, and it should have been here since 2026-08-21** — the same silent
     * gap {@link workflowStepDefSchema}'s `heavy` comment below describes at length: the parity
     * guard is a MUTUAL ASSIGNABILITY check, so a server-only optional property typechecks green
     * in both directions and the guard says nothing. `GET /workflows` serves the server's own
     * `WorkflowDef` verbatim, so `effort` was already on the wire with no name here; the first
     * consumer to rebuild a step field-by-field from this type would drop it on the way back
     * through `POST /workflows`. Latent while `effort` was Claude-only and set on one built-in
     * step; live now that it carries half of the codex model policy
     * (`.ai/specs/2026-08-24-codex-step-model-and-effort.md`).
     */
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    /**
     * Per-runner overrides of `model` and `effort` for this step. Mirrors `byRunner` in
     * `src/workflows/types.ts` (`.ai/specs/2026-08-24-codex-step-model-and-effort.md`, D1).
     *
     * Declared here for the round-trip reason above, and the consequence is concrete rather than
     * theoretical: `spec-to-deploy` carries a codex model AND effort on six of its eight steps, so
     * a step rebuilt from a contract type that did not know this key would save the built-in
     * workflow back with its whole codex policy silently gone.
     */
    byRunner: z
      .partialRecord(
        runnerSchema,
        z
          .object({
            model: z.string().optional(),
            effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
          })
          .strict(),
      )
      .optional(),
    /** Per-step agent backend override (falls back to the task / config default). */
    runner: runnerSchema.optional(),
    allowedTools: z.array(z.string()).optional(),
    bashAllowlist: z.array(z.string()).optional(),
    // check step
    command: z.string().optional(),
    onFail: z
      .object({
        retry: z.string().min(1),
        max: z.number().int().positive().default(2),
        /**
         * Re-enter the target step's own session on this loop-back rather than starting it cold.
         * Mirrors `resume` in `src/workflows/types.ts`
         * (`.ai/specs/2026-08-29-step-resume-and-two-stage-review.md`, D1); absent = cold, which
         * is what every pre-existing workflow does.
         *
         * Mirrored BY HAND, for the reason `heavy` below already records:
         * `contract-parity.workflows.test.ts` compares the two shapes with a MUTUAL assignability
         * check, and an added OPTIONAL property stays assignable in both directions — so a key
         * added on the server side alone typechecks green and the guard says nothing. `GET
         * /workflows` serves the server's `WorkflowDef` verbatim, so the flag is on the wire
         * already; a consumer rebuilding a step field-by-field from THIS type would drop it on
         * the way back through `POST /workflows`, and the loop-back would go cold again with
         * nothing red.
         */
        resume: z.boolean().optional(),
      })
      .optional(),
    /**
     * This step must hold a slot in the `resources.maxHeavySteps` semaphore for its turn — spec
     * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D14. Mirrors `heavy` in
     * `src/workflows/types.ts`; absent = not heavy.
     *
     * Mirrored here even though the parity guard does not force it. `contract-parity.workflows.
     * test.ts` compares the two shapes with a MUTUAL assignability check, and an added OPTIONAL
     * property stays assignable in both directions — so a `heavy` on the server side alone
     * typechecks green and the guard says nothing. That silence is the hazard: `GET /workflows`
     * serves the server's own `WorkflowDef` verbatim, so the flag is already on the wire, and the
     * first consumer to rebuild a step object field-by-field from THIS type would drop it on the
     * way back through `POST /workflows` — a workflow that silently stops being heavy on its next
     * save. Declared here so the round-trip is closed before anything edits a step.
     */
    heavy: z.boolean().optional(),
    /** Post-condition — what must be TRUE for the step to be green. Mirrors `verify` in
     *  `src/workflows/types.ts`, `max` default included; the run record persists a workflow def,
     *  and `contract-parity.workflows.test.ts` fails the typecheck if the two drift. */
    verify: z
      .union([
        z
          .object({
            builtin: z.enum([
              'everything-committed',
              'all-services-deployed',
              'tested-revision-shipped',
              'merged-into-base',
            ]).optional(),
            command: z.string().min(1).optional(),
            max: z.number().int().nonnegative().default(1),
          })
          .refine((v) => Boolean(v.builtin) !== Boolean(v.command), {
            message: "a step's verify names either a builtin or a command, not both",
          }),
        z
          .array(
            z
              .object({
                builtin: z.enum([
                  'everything-committed',
                  'all-services-deployed',
                  'tested-revision-shipped',
                  'merged-into-base',
                ]).optional(),
                command: z.string().min(1).optional(),
                max: z.number().int().nonnegative().default(1),
              })
              .refine((v) => Boolean(v.builtin) !== Boolean(v.command), {
                message: "a step's verify names either a builtin or a command, not both",
              }),
          )
          .min(1)
          .max(4),
      ])
      .optional(),
  })
  .refine((s) => Boolean(s.command) !== Boolean(s.prompt ?? s.skill), {
    message: 'a step is either an agent step (prompt/skill) or a check step (command), not both',
  });
export type WorkflowStepDef = z.infer<typeof workflowStepDefSchema>;

/** One catalog entry: the built-in `quick-task`, or a `.ai/cezar/workflows/*.yaml` file. */
export const workflowDefSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(workflowStepDefSchema),
  source: z.enum(['built-in', 'file']),
  /** Absent on built-ins — which is exactly what makes them undeletable. */
  path: z.string().optional(),
});
export type WorkflowDef = z.infer<typeof workflowDefSchema>;

/** A workflow file that failed to load. Reported, never fatal — the catalog still answers. */
export const workflowLoadIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});
export type WorkflowLoadIssue = z.infer<typeof workflowLoadIssueSchema>;

/** `GET /workflows` — the catalog plus the files that could not be read. */
export const workflowsResponseSchema = z.object({
  workflows: z.array(workflowDefSchema),
  issues: z.array(workflowLoadIssueSchema),
});
export type WorkflowsResponse = z.infer<typeof workflowsResponseSchema>;

/**
 * `POST /workflows` body: save a chain as `.ai/cezar/workflows/<slug>.yaml`.
 *
 * Exactly one of `steps` / the portable `skills` shorthand — the refinement below is the same
 * XOR the server enforces. Without `overwrite` an existing file answers 409 (`exists: true`).
 */
export const saveWorkflowInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(2_000, 'must be at most 2000 characters').optional(),
    steps: z.array(workflowStepDefSchema).min(1).max(8).optional(),
    skills: z.array(z.string().trim().min(1)).min(1).max(8).optional(),
    overwrite: z.boolean().optional(),
  })
  .refine((b) => Boolean(b.steps) !== Boolean(b.skills), {
    message: 'provide either "steps" or "skills", not both',
  });
export type SaveWorkflowInput = z.infer<typeof saveWorkflowInputSchema>;

/** `POST /workflows` — 201 with where the YAML landed. */
export const saveWorkflowResponseSchema = z.object({
  path: z.string(),
  name: z.string(),
});
export type SaveWorkflowResponse = z.infer<typeof saveWorkflowResponseSchema>;

/** `POST /workflows/parse` (spec 012) — pasted YAML, normalized to plain steps. */
export const parsedWorkflowSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(workflowStepDefSchema),
});
export type ParsedWorkflow = z.infer<typeof parsedWorkflowSchema>;

/**
 * `DELETE /workflows/:name` — file workflows only; built-ins answer 400.
 *
 * `ok` is the LITERAL `true`, not a boolean: the only body carrying it is the success one, and
 * every failure is an `{ error }` status instead. The hand-written DTO said `boolean`, which
 * was wider than the route has ever been.
 */
export const deleteWorkflowResponseSchema = z.object({
  ok: z.literal(true),
  path: z.string(),
});
export type DeleteWorkflowResponse = z.infer<typeof deleteWorkflowResponseSchema>;

// ---- plan (`POST /plan`, spec 008) -------------------------------------------------------

/**
 * The proposed chain for a task. Never a hard failure: a missing CLI, a timeout or an
 * unparseable answer degrade to the one-step quick-task plan with `fallback: true`.
 */
export const planResponseSchema = z.object({
  /** The kebab-case workflow title the planner proposed. Absent on the degraded fallback. */
  name: z.string().optional(),
  steps: z.array(workflowStepDefSchema),
  rationale: z.string(),
  fallback: z.boolean(),
});
export type PlanResponse = z.infer<typeof planResponseSchema>;
