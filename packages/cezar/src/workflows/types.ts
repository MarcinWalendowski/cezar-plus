import { z } from 'zod';
import { RUNNER_IDS, type RunnerId } from '../core/agent-runner.ts';
import { POSTCONDITION_IDS } from './postconditions.ts';

const verifyEntrySchema = z
  .object({
    builtin: z.enum(POSTCONDITION_IDS).optional(),
    command: z.string().min(1).optional(),
    max: z.number().int().nonnegative().default(1),
  })
  .refine((v) => Boolean(v.builtin) !== Boolean(v.command), {
    message: "a step's verify names either a builtin or a command, not both",
  });

const verifySchema = z.union([verifyEntrySchema, z.array(verifyEntrySchema).min(1).max(4)]);

/**
 * A workflow is an ordered list of steps. Two step kinds:
 *  - `agent` — one claude CLI run (prompt + optional skill + model + tools);
 *  - `check` — a shell command; exit 0 passes, non-zero can loop back to an
 *    earlier step via `onFail` (bounded by `max`).
 *
 * `{{task}}` in a prompt is replaced with the user's task text. When a check
 * loops back, the failing output is appended to the retried agent's prompt.
 */
export const workflowStepSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    // agent step
    prompt: z.string().optional(),
    skill: z.string().optional(),
    model: z.string().optional(),
    /** A mechanical reasoning-depth ceiling, mirroring `model` above. No normalization table:
     *  unlike `model`, `effort` is not a per-backend alias, it is a fixed five-value enum.
     *
     *  **CORRECTED 2026-08-24 — no longer Claude-only.** This read *"Claude-only
     *  (`.ai/specs/2026-08-21-run-tests-reasoning-ceiling.md`) — the codex and opencode runners
     *  never read it"*, which was true of both runners when it was written and is now true of
     *  opencode alone. The codex app-server takes an `effort` on `turn/start` — *"Override the
     *  reasoning effort for this turn and subsequent turns"*, read off its own
     *  `generate-json-schema` output rather than guessed — and the codex runner sends it since
     *  `.ai/specs/2026-08-24-codex-step-model-and-effort.md`.
     *
     *  `ultra` is deliberately absent even though sol and terra advertise it: this enum is what a
     *  user AUTHORS, and the owner's instruction for that level is "basically never", so leaving
     *  it unauthorable is the cheapest enforcement there is. It also tops out the escalation
     *  ladder at `max` by construction rather than by a comment. */
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    /**
     * Per-runner overrides of `model` and `effort` for THIS step
     * (`.ai/specs/2026-08-24-codex-step-model-and-effort.md`, D1).
     *
     * `byRunner[backend]` wins over the plain `model`/`effort` above; a runner not named here
     * takes them unchanged, so every existing step and every authored workflow behaves exactly as
     * it did. The problem it solves: `spec-to-deploy` names `sonnet` on six steps, and on a codex
     * run `modelForBackend` drops all six as another runner's model, leaving those steps on
     * codex's own default — measured on `prod-host` as `gpt-5.6-sol` with
     * `reasoningEffort: null`, i.e. the most expensive model in the catalog at its shallowest
     * setting, for `Commit & push` and `Deploy` alike.
     *
     * **One field carrying the pair, not two parallel maps.** The owner's task→model table pairs a
     * model WITH an effort (Luna Medium vs Luna XHigh differ only in the second half), so a
     * `modelByRunner` and an `effortByRunner` that could be set independently would let a step
     * name codex's model beside Claude's effort and still typecheck.
     */
    byRunner: z
      .partialRecord(
        z.enum(RUNNER_IDS),
        z
          .object({
            model: z.string().optional(),
            effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
          })
          .strict(),
      )
      .optional(),
    /** Per-step agent backend override (falls back to the task / config default).
     *
     *  Deliberately NOT widened to the legacy `claude-cli` the way the run store's
     *  `runner`/`backend` were (#547). This enum validates two things a user AUTHORS —
     *  workflow YAML, and the inline chain on `POST /runs` — so the selectable set is the
     *  right one, and rejecting `claude-cli` here is a loud load-time error rather than
     *  data loss. It also gates the persisted `workflowDef` (`runs/store.ts`), but nothing
     *  has ever been able to write the legacy id THERE either, because this same enum was
     *  the only way in: there is no legacy shape to keep parseable. */
    runner: z.enum(RUNNER_IDS).optional(),
    allowedTools: z.array(z.string()).optional(),
    bashAllowlist: z.array(z.string()).optional(),
    // check step
    command: z.string().optional(),
    onFail: z
      .object({
        retry: z.string().min(1),
        max: z.number().int().positive().default(2),
      })
      .optional(),
    /**
     * POST-CONDITION (`.ai/specs/2026-08-20-steps-green-only-when-verified.md`): what has to be
     * TRUE about the world for this step to count as done. Without one, a step is green whenever
     * its agent exits without erroring — which is how `commit-push` reported done on run
     * `23221162` leaving 7 modified and 5 untracked files and no commit.
     *
     * `builtin` names an in-process check (`workflows/postconditions.ts`) whose verdict is a
     * sentence; `command` is an arbitrary shell command where exit 0 is the only green. Exactly
     * one of the two. On failure the step is RE-RUN up to `max` times with the verdict appended to
     * its prompt (the same channel a failing `check` step uses), and only then marked `failed`.
     *
     * `max` carries a `.default(1)`, so the OUTPUT shape has it present whenever `verify` is —
     * the same reason `onFail.max` does.
     */
    /**
     * HUMAN APPROVAL GATE (`.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md`,
     * P3). Agent steps only: after this step's turn the run PARKS at `waiting` until
     * `config.approvals.minApprovers` approvals arrive through `POST /runs/:id/approve`.
     *
     * **`approvals.minApprovers` defaults to 0, which means auto-approved** — owner decision
     * 2026-08-20 ("min 1, but by default it should be 'auto approved'"). At 0 the engine takes
     * the exact code path it took before this flag existed, so the zero-config chain is
     * unchanged; the flag only becomes teeth when somebody opts in. That is why the safety value
     * of the review step does NOT rest here — it rests on the agent's own `CEZ:REVIEW` verdict
     * (see `parseReviewVerdict`), which works at the shipped default.
     */
    requiresApproval: z.boolean().optional(),
    /**
     * This step is CPU/memory-heavy, so it must hold a slot in the second semaphore
     * (`resources.maxHeavySteps`) for the duration of its turn — spec
     * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D14.
     *
     * `maxParallel` alone cannot express a bimodal workload: a run sits near 0.5 GB for most of
     * its life and spikes into multiple GB inside `run-tests`. Set the one cap for the spike and
     * the box idles; set it for the median and three runs hit the spike together and thrash. So
     * admission is two numbers — how many runs are admitted at all, and how many may be inside a
     * heavy step at once — and this flag is what tells the second one which steps count.
     *
     * **DECLARED, never inferred from the step's name at runtime.** A name-match would be a
     * second, invisible definition of "heavy" that drifts the moment somebody names a step
     * `tests` or `verify-build`, and it cannot be turned off for a chain that genuinely wants an
     * unbounded step. The catalog's `run-tests` opts in explicitly; anything else that is heavy
     * says so in its own YAML.
     *
     * Absent = not heavy, which is today's behaviour for every step and every existing workflow
     * file. Optional and additive so a persisted `workflowDef` written by an older cezar still
     * parses — see `runs/store.ts`'s `workflowDef` note on why a NARROWING here silently eats
     * queued runs, and why a widening like this one is safe.
     */
    heavy: z.boolean().optional(),
    verify: verifySchema.optional(),
  })
  .refine((s) => Boolean(s.command) !== Boolean(s.prompt ?? s.skill), {
    message: 'a step is either an agent step (prompt/skill) or a check step (command), not both',
  })
  .refine((s) => !(s.requiresApproval && s.command), {
    message: 'requiresApproval belongs to an agent step — a check step has no turn to approve',
  });

/**
 * A workflow file names either full `steps` or the portable `skills` shorthand
 * (spec 012 — what the builder exports): an ordered list of skill names, each
 * becoming one agent step that applies that skill to `{{task}}`.
 */
export const workflowFileSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    steps: z.array(workflowStepSchema).min(1).optional(),
    skills: z.array(z.string().trim().min(1)).min(1).optional(),
  })
  .refine((d) => Boolean(d.steps) !== Boolean(d.skills), {
    message: 'a workflow lists either "steps" or "skills", not both',
  });

export type WorkflowStepDef = z.infer<typeof workflowStepSchema>;
export type WorkflowDoc = z.infer<typeof workflowFileSchema>;

/**
 * A resolved workflow: a catalog entry, or the ad-hoc "(planned)" chain a task
 * was started with. A SCHEMA and not an interface because `RunStore` persists
 * one of these on the run record (`workflowDef`) and has to parse it back —
 * `src/server/contract-parity.workflows.test.ts` is what keeps this shape and
 * the contract's `workflowDefSchema` from drifting.
 */
export const workflowDefSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(workflowStepSchema),
  source: z.enum(['built-in', 'file']),
  path: z.string().optional(),
});

export type WorkflowDef = z.infer<typeof workflowDefSchema>;

/** `skills: [a, b]` → agent steps, one per skill, each running `{{task}}`. */
export function skillsToSteps(skills: string[]): WorkflowStepDef[] {
  const used = new Set<string>();
  return skills.map((skill) => {
    let id = skill;
    for (let n = 2; used.has(id); n++) id = `${skill}-${n}`;
    used.add(id);
    return { id, name: skill, skill, prompt: '{{task}}' };
  });
}

/** Resolve the steps/skills XOR into plain steps. */
export function normalizeWorkflowDoc(doc: WorkflowDoc): {
  name: string;
  description?: string;
  steps: WorkflowStepDef[];
} {
  return {
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    steps: doc.steps ?? skillsToSteps(doc.skills ?? []),
  };
}

/**
 * The inverse of `skillsToSteps`: when every step is a plain "apply this
 * skill to the task" agent step, return the skill list — the workflow can be
 * written in the portable compact form. Anything richer (checks, custom
 * prompts, per-step models/tools, loops) returns null.
 */
export function skillStackOf(steps: WorkflowStepDef[]): string[] | null {
  const skills: string[] = [];
  for (const s of steps) {
    if (stepKind(s) !== 'agent' || !s.skill) return null;
    if (s.prompt !== undefined && s.prompt !== '{{task}}') return null;
    if (s.name !== undefined && s.name !== s.skill) return null;
    // `byRunner` belongs on this list for the same reason `model` does: a step carrying one is
    // not a plain apply-this-skill step, and round-tripping it through the compact skill form
    // would silently discard the per-runner pair.
    if (s.model || s.effort || s.byRunner || s.runner || s.allowedTools || s.bashAllowlist || s.onFail || s.verify) {
      return null;
    }
    skills.push(s.skill);
  }
  return skills.length ? skills : null;
}

export function stepKind(step: WorkflowStepDef): 'agent' | 'check' {
  return step.command ? 'check' : 'agent';
}

/** What a step asks the model layer for, once the backend running it is known. */
export interface StepModelChoice {
  model: string | undefined;
  effort: WorkflowStepDef['effort'];
}

/**
 * Resolve a step's model and reasoning effort FOR THE BACKEND THAT WILL RUN IT
 * (`.ai/specs/2026-08-24-codex-step-model-and-effort.md`, D1).
 *
 * The pair is resolved together and from ONE source: a `byRunner` entry supplies both halves or
 * neither. Mixing them — taking the model from `byRunner` and the effort from the step — is the
 * failure this shape exists to prevent, because the owner's table has rows that differ only in
 * effort, so a half-applied override lands on a row nobody chose.
 *
 * `fallbackModel` is the run-level model (`input.model`), which applies only when neither the
 * override nor the step names one. It is deliberately NOT consulted for effort: there is no
 * run-level effort, and inventing one here would give every step of every run a ceiling.
 *
 * `autoChoice` is the classifier's answer (`.ai/specs/2026-08-24-auto-classify-task-model.md`) and
 * is the LAST resort, below every one of those. It applies only when the layers above named
 * **nothing at all** — not a model, not an effort. A step that names an effort ceiling and no
 * model is not a hole to fill: the ceiling is a deliberate source, and replacing it with a
 * different pair is precisely the mixed-source failure the "both halves or neither" rule above
 * exists to prevent.
 *
 * The guard reads the RESULT (`named`) rather than re-testing the four inputs. Re-deriving
 * "did anybody name something?" from `step`/`fallbackModel` a second time is how the two
 * expressions drift, and this one has to agree with the one directly above it by construction.
 */
export function resolveStepModel(
  step: WorkflowStepDef,
  backend: RunnerId,
  fallbackModel?: string,
  priorFailures = 0,
  autoChoice?: StepModelChoice,
): StepModelChoice {
  const override = step.byRunner?.[backend];
  const named: StepModelChoice =
    override && (override.model !== undefined || override.effort !== undefined)
      ? { model: override.model ?? step.model ?? fallbackModel, effort: override.effort }
      : { model: step.model ?? fallbackModel, effort: step.effort };
  const nothingNamed = named.model === undefined && named.effort === undefined;
  const chosen: StepModelChoice = nothingNamed && autoChoice ? autoChoice : named;
  return escalate(chosen, priorFailures);
}

/**
 * The escalation ladder, exactly where the owner's table puts it: *"Terra/Sol Medium failed → Sol
 * High/Max"* (`.ai/specs/2026-08-24-codex-step-model-and-effort.md`, D4).
 *
 * Deliberately NOT a general "climb one level on any failure". A failing tiny task must not end up
 * on the most expensive model in the catalog, and the table declines to send it there — so the
 * Luna rows do not climb at all, and a step that names no model is left alone rather than given
 * one it never asked for.
 *
 * It tops out at `max`. `ultra` is never reached, because *"Sol Ultra: basically never"* — and it
 * could not be spelled anyway, since it is the one level the `effort` enum omits.
 */
const CODEX_ESCALATION: readonly StepModelChoice[] = [
  { model: 'gpt-5.6-sol', effort: 'high' },
  { model: 'gpt-5.6-sol', effort: 'max' },
];

/** The two rungs the table names as escalating: terra or sol, at `medium`. */
function escalatable(choice: StepModelChoice): boolean {
  if (choice.effort !== 'medium') return false;
  return choice.model === 'gpt-5.6-terra' || choice.model === 'gpt-5.6-sol';
}

function escalate(choice: StepModelChoice, priorFailures: number): StepModelChoice {
  // ONE guard on the attempt count, not two. This read `priorFailures <= 0 || !escalatable(...)`
  // with a `?? choice` on the lookup below, and a mutation removing the `<= 0` half survived the
  // whole suite: the `??` absorbed the out-of-range index and produced identical behaviour. Two
  // mechanisms enforcing one property means neither is provably the one that works.
  if (priorFailures <= 0 || !escalatable(choice)) return choice;
  const rung = CODEX_ESCALATION[Math.min(priorFailures, CODEX_ESCALATION.length) - 1];
  // `priorFailures >= 1` above and `Math.min` below bound the index to 0..length-1, so this is
  // total. The throw is unreachable and says so — it exists to keep the type honest without a
  // fallback that would silently re-absorb a guard someone deletes later.
  if (!rung) throw new Error(`unreachable: escalation rung ${priorFailures} out of range`);
  return rung;
}

/**
 * A guard note prepended to an agent step's prompt when the workflow chains
 * 2+ AGENT steps (#410): every step gets the SAME `input.task` text and shares
 * one run-level handoff journal, so a later step's fresh session can read an
 * earlier step's own "done" signal (its final report, its handoff Resume
 * notes) and — with nothing in its prompt saying otherwise — conclude the
 * OVERALL task is already achieved. Since only the chain's last step honors
 * `CEZ:DONE` as an early-completion signal (`run.ts`'s `interactive` gate),
 * this silently skipped exactly the last selected skill: it ended its first
 * turn with the marker instead of doing its own step's work.
 *
 * `index` is the position in `steps`; both the gate and the "step N of M"
 * numbering count agent steps only. Check steps are shell commands, not
 * sessions the model reasons about, so a workflow with one agent step and any
 * number of checks around it (the README's `implement` + `verify` shape) is
 * not a chain and gets no note — that single-step case stays byte-for-byte
 * unchanged. Returns undefined for check steps.
 */
export function chainStepNote(
  steps: WorkflowStepDef[],
  index: number,
  /** A step being RESUMED after a cezar restart (spec 2026-08-20, P3). The engine and the
   *  prompt have to agree about what `CEZ:DONE` means, or a resumed step reads the handoff
   *  file its own earlier turn wrote and concludes the whole run is achieved. */
  opts: { resumed?: boolean } = {},
): string | undefined {
  const step = steps[index];
  if (!step || stepKind(step) !== 'agent') return undefined;
  const total = steps.filter((s) => stepKind(s) === 'agent').length;
  if (total <= 1) return undefined;
  const position = steps.slice(0, index).filter((s) => stepKind(s) === 'agent').length + 1;
  // `name` first: it is what the author called the step and what the GUI rail
  // shows. A `skill` is only ever a support for the step's goal, so naming it
  // as the goal would displace the task text the note sits above.
  const label = step.name ? `"${step.name}"` : step.skill ? `the "${step.skill}" skill` : 'this step';
  const sentences = [
    `This run is a chain of ${total} agent steps; you are running step ${position} of ${total}.`,
    `Your job in THIS step is ${label} — do its work in full.`,
  ];
  // Only steps that HAVE a predecessor; on step 1 the premise would be false.
  if (position > 1) {
    sentences.push(
      `An earlier step in this same run may already have reported its own work done (in its ` +
        `report, or in this run's handoff file); that does not mean step ${position}'s work is done.`,
    );
  }
  if (opts.resumed) {
    sentences.push(
      `This step was interrupted by a cezar restart and is being resumed — pick it back up rather ` +
        `than starting it over.` +
        (position < total
          ? ` The remaining ${total - position} step(s) of the chain still run after it.`
          : ''),
    );
  }
  sentences.push(
    `Only end this turn with CEZ:DONE once step ${position}'s own goal is achieved, not just the run's overall task.`,
  );
  return sentences.join(' ');
}

/**
 * Structural checks beyond the per-step schema: ids must be unique and every
 * `onFail.retry` must reference an *earlier* step (loops only go backwards).
 * Returns a human-readable problem, or null when the list is sound. Shared by
 * the file loader and the inline-steps / save-workflow API routes (spec 008).
 */
export function stepsIssue(steps: WorkflowStepDef[]): string | null {
  const ids = steps.map((s) => s.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) return `duplicate step id "${dup}"`;
  for (const [i, s] of steps.entries()) {
    if (!s.onFail) continue;
    const target = ids.indexOf(s.onFail.retry);
    if (target < 0 || target >= i) {
      return `step "${s.id}": onFail.retry must reference an earlier step (got "${s.onFail.retry}")`;
    }
  }
  return null;
}

/** Tools an agent step gets when the workflow doesn't say otherwise. */
export const DEFAULT_ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'];

/** The zero-config workflow: one agent step that just does the task. */
export const QUICK_TASK_WORKFLOW: WorkflowDef = {
  name: 'quick-task',
  description: 'One agent run on your task — no ceremony.',
  source: 'built-in',
  steps: [
    {
      id: 'task',
      name: 'Do the task',
      prompt: '{{task}}',
    },
  ],
};

/**
 * The workflow an approved note proposal starts (spec
 * `.ai/specs/2026-08-14-note-to-spec-pipeline.md`). It **investigates and writes a spec, and
 * stops.**
 *
 * That stopping point is the design, not a limitation. The triage pass that produced this task
 * saw a note and a list of run titles — it never opened the repository. This step is where the
 * work is actually understood: inside the target repo, with the tools to read its knowledge base,
 * its specs and its git history. Implementation is a separate decision a person takes afterwards,
 * against a spec they can read.
 *
 * **`allowedTools` deliberately excludes `Bash`** (the default set includes it). The step needs
 * `git log`, so it gets exactly that one command through `bashAllowlist` — a read-only history
 * query. An agent asked to "investigate and write a spec" with a general shell is an agent that
 * can install dependencies, run migrations and push branches while nobody is watching, on the
 * strength of a note somebody typed on their phone.
 */
export const NOTE_TO_SPEC_WORKFLOW: WorkflowDef = {
  name: 'note-to-spec',
  description: 'Investigate a task in this repo and write a spec for it. Does not implement.',
  source: 'built-in',
  steps: [
    {
      id: 'spec',
      name: 'Investigate and write the spec',
      allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Bash'],
      bashAllowlist: ['git log', 'git show', 'git status'],
      prompt: [
        'You are writing a SPEC for the task below. You are NOT implementing it.',
        '',
        'Task:',
        '{{task}}',
        '',
        'Before you write anything, read what this repository already decided:',
        '1. Its knowledge base or decision records, if it has one.',
        '2. Its spec directory, for a precedent of this shape or a spec this extends. Most work',
        '   extends a prior decision rather than starting fresh.',
        '3. `git log` for recent commits touching the area, so the spec describes the code that is',
        '   there now rather than the code you assumed.',
        '',
        'Then write ONE spec file, following this repository’s own naming and section conventions',
        '(match the files already in its spec directory — do not impose a different format). It',
        'must contain: a TLDR, the problem, the solution, the architecture, PHASES broken into',
        'independently shippable steps, data models and API contracts where they apply, risks, and',
        'a verification section naming concrete, executable test steps.',
        '',
        'Cite what you actually read — spec numbers, file paths, commit hashes. If you could not',
        'find something, say so in the spec rather than inventing it.',
        '',
        'Change NO other file. Write no implementation, no migration, no test. When the spec file',
        'exists, declare its path on its own line: `CEZ:SPEC_PATH=<repo-relative path>` — this is',
        'how the note that requested this spec finds it afterwards. Then stop.',
      ].join('\n'),
    },
  ],
};

/**
 * The workflow an autonomous note's spec run continues into, unattended (PLAN D27 Phase 3,
 * `.ai/specs/2026-08-15-autonomous-implementation-continuation.md`). Where `NOTE_TO_SPEC_WORKFLOW`
 * deliberately stops at the spec, this one **implements it, runs this repo's own gates, and
 * commits locally** — the second press the owner asked to remove for notes marked autonomous.
 *
 * **This is a genuine, knowing privilege escalation over `note-to-spec`, not an oversight.** That
 * workflow's own `allowedTools` excludes general `Bash` on purpose — an agent that only
 * investigates and writes has no need for a shell that can install dependencies or touch a
 * remote. An agent that IMPLEMENTS needs a real one: it has to run whatever build/test/lint
 * commands this repo defines, which differ per project and cannot be predicted from here. The
 * escalation is recorded, not hidden — see the spec's "Problem" section, point 1.
 *
 * **This workflow cannot reach a git remote — enforced, not merely prompted.** `bashAllowlist`
 * grants git read/stage/commit and, across the package-manager and task-runner shapes a registered
 * project might use, ONLY the gate-shaped subcommands (`build`/`test`/`lint`/`typecheck`/`check`/
 * `format`) — never a bare `npm run`/`pnpm run`/`yarn run`/`make`. That distinction is the whole
 * guard: a bare prefix would also grant whatever OTHER script a target repo's own
 * `package.json`/`Makefile` happens to define under it — a `deploy`, `release`, or `publish`
 * script, for instance — which is a real path to a remote that naming only the gate verbs closes.
 * No entry is `git push`, or a bare `git` prefix, either. `workflows/types.test.ts` asserts both
 * shapes structurally: no entry matches a `git push` command, and no script-runner/task-runner
 * entry is a bare, subcommand-less prefix.
 *
 * **Installs are the one deliberate, named exception**, not a gap this array quietly leaves open:
 * `npm install`/`ci` (and the pnpm/yarn equivalents) stay broad because an implementing agent
 * genuinely cannot run any gate without its dependencies, and there is no narrower prefix for
 * "install what the lockfile says." Reaching a package registry and executing that package's own
 * lifecycle scripts is a real, accepted trade for that one capability — see the allowlist's own
 * comment, inline, for why it is not narrowed the same way the script runners are.
 */
export const AUTONOMOUS_IMPLEMENTATION_WORKFLOW: WorkflowDef = {
  name: 'autonomous-implementation',
  description: 'Implement a spec end-to-end: code, gates, commit locally. Never pushes.',
  source: 'built-in',
  steps: [
    {
      id: 'implement',
      name: 'Implement the spec',
      allowedTools: DEFAULT_ALLOWED_TOOLS,
      bashAllowlist: [
        // Read-only / discovery.
        'git status',
        'git diff',
        'git log',
        'git show',
        'git branch',
        'git rev-parse',
        // Stage and commit LOCALLY — never `git push`, and no bare `git` prefix that would grant it.
        'git add',
        'git commit',
        // Installs: the one DELIBERATE exception to "gate-shaped subcommands only" below. An
        // implementing agent genuinely needs its dependencies to run any gate at all, and there is
        // no narrower prefix for "install what the lockfile says" — so this is named honestly
        // rather than claimed away: `npm install`/`ci` (and the pnpm/yarn equivalents) reach a
        // package registry by definition and execute that package's own lifecycle scripts. Real,
        // accepted, not a gap this array closes.
        'npm install',
        'npm ci',
        'pnpm install',
        'yarn install',
        // Gate-shaped script-runner subcommands ONLY — a bare 'npm run' (or 'pnpm run'/'yarn
        // run'/'make') is a prefix, and a prefix grants every OTHER script name a target repo's own
        // package.json/Makefile happens to define under it, including a 'deploy'/'release'/
        // 'publish' script. Naming the gate verbs here is what keeps this workflow's own guarantee
        // — no git remote, no registry publish — actually true instead of merely prompted. Prefix
        // matching still covers e.g. `npm run test:unit`, `npm run build:prod`.
        'npm run build',
        'npm run test',
        'npm run lint',
        'npm run typecheck',
        'npm run check',
        'npm run format',
        'npm test',
        'pnpm run build',
        'pnpm run test',
        'pnpm run lint',
        'pnpm run typecheck',
        'pnpm run check',
        'pnpm run format',
        'pnpm test',
        'yarn run build',
        'yarn run test',
        'yarn run lint',
        'yarn run typecheck',
        'yarn run check',
        'yarn run format',
        'yarn test',
        'make test',
        'make build',
        'make check',
        'make lint',
        'cargo build',
        'cargo test',
        'cargo check',
        'go build',
        'go test',
        'go vet',
        'pytest',
        'python -m pytest',
      ],
      prompt: [
        'You are IMPLEMENTING the spec below. Nobody is watching this run — there is no one to ask',
        'a clarifying question, so make reasonable assumptions, note them in your final report, and',
        'proceed.',
        '',
        'Spec:',
        '{{task}}',
        '',
        'Read the spec fully, then implement it: write the code, and the tests its own Verification',
        'section names. Run this repository\'s own gates (typecheck, lint, tests — whatever it uses)',
        'and fix what they find before you stop.',
        '',
        'When the gates are green, COMMIT your changes locally with `git commit`. Do NOT run',
        '`git push` or any command that publishes, deploys, or otherwise reaches outside this',
        'machine — commit only. Pushing is a separate, deliberate decision a person takes later.',
        '',
        'End your report by stating what you implemented, the gate results, and the commit you made.',
      ].join('\n'),
    },
  ],
};

/**
 * The "read the record" opening, as ONE tool call (spec
 * `.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md`, Phase 3).
 *
 * In run `ec6e8e06` this exact opening — read the handoff, list the spec dir, `git log`, search
 * the KB, check the tracker — cost about **fifteen separate round trips** before the agent had
 * read a single line of the code it was there to change. None of those facts depends on any
 * other, so none of them needed its own turn.
 *
 * Every rule the batch obeys is a named risk from that spec: `set +e` (R1 — a `set -e` batch
 * hides every section after the first missing file and the model reads the rest as success), a
 * delimiter per section (R1 — an undelimited blob cannot be read section by section), and a bound
 * per section (R2 — 231 small results flooded into one unbounded `cat` is strictly *worse* than
 * the 231 calls it replaced).
 *
 * Shipped as a literal the agent can paste rather than prose it has to translate: the round trip
 * it saves is the one spent getting the batch syntax wrong.
 */
export const RECORD_READ_RECIPE = [
  '```bash',
  'set +e',
  "say(){ printf '\\n===== %s =====\\n' \"$1\"; }",
  'say HANDOFF; sed -n 1,80p "$CEZ_HANDOFF_FILE"',
  'say SPECS;   ls -1t .ai/specs 2>/dev/null | head -30',
  'say GITLOG;  git log --oneline -15',
  'say KB;      cez kb search "<your query>" 2>&1 | head -40',
  'say TODOS;   cezar todo list 2>&1 | head -20',
  'say CONV;    sed -n 1,60p AGENTS.md 2>/dev/null || sed -n 1,60p CLAUDE.md 2>/dev/null',
  '```',
].join('\n');

/**
 * How an agent step should WRITE A FILE (spec
 * `.ai/specs/2026-08-21-edit-an-existing-file-never-re-emit-it.md`, L1).
 *
 * This exists to argue with an instruction cezar does not own and cannot switch off: bypass
 * permissions mode injects "make file changes with sed, heredocs, or short scripts, rather than
 * using the dedicated Read, Edit, or Write tools" into every Claude-backed step
 * (`core/claude-cli-runner.ts:702` sets `bypassPermissions` unconditionally). That instruction is
 * right for a three-line `sed`, and wrong for changing one paragraph of a 50 KB document. The step
 * prompt is the only lever, and it lands LATER in the transcript than the injected reminder
 * (`run.ts:4300`).
 *
 * Measured on run `70f19253`: 360 tool calls containing zero `Edit` and zero `Write`. Its `spec`
 * step wrote the same document through `cat > … <<'SPECEOF'` twice — 34,845 characters, then
 * 48,618, of which 20,550 were unchanged lines carried for nothing — and its `deploy` step wrote
 * `/tmp/probe-backend.sh` twice with a byte-identical body.
 *
 * NOTE the rule is deliberately CONDITIONAL, and that is measured, not cautious. That `spec`-step
 * rewrite touched 81 separate hunks and grew the file by 14 KB; converted to 81 anchored `Edit`s it
 * would have cost ~65,045 characters against the 48,618 the rewrite spent, in 81 round trips
 * instead of 1. An unconditional "never re-emit" makes that case WORSE. See the spec's § Problem.
 */
export const FILE_WRITE_RECIPE = [
  'CHANGING PART OF A FILE THAT ALREADY EXISTS: use your editor tool, not a heredoc that re-emits',
  'the whole file. On Claude Code that is `Edit` (old_string → new_string) for a change and `Write`',
  'for a file that does not exist yet; on another backend, whatever patch/edit tool it gives you.',
  'This OVERRIDES the standing "make file changes with sed, heredocs, or short scripts" preference,',
  'for file mutation only. Several edits to one file go out as PARALLEL edit calls in ONE turn.',
  '',
  'Why, because this rule is not boilerplate and must not be deleted as such: an edit costs the',
  'CHANGE, a heredoc costs the FILE, and you pay for every character twice — once emitting it, once',
  'carrying it in context afterwards. Measured on run `70f19253`: 360 tool calls, ZERO `Edit`, ZERO',
  '`Write`. Its spec step wrote one document twice — 34,845 characters, then 48,618, of which',
  '20,550 were unchanged lines carried for nothing. Its deploy step wrote the same 1,383-character',
  'script twice, byte-identical. That cost scales with the size of the FILE and not with the size',
  'of your change, so it gets worse the longer the file gets, without limit.',
  '',
  'The honest exception, so do not over-apply this: when you are genuinely rewriting MOST of a',
  'file, re-emitting it is correct and cheaper than dozens of anchored edits. Judge by how much of',
  'the file changes, not by whether it existed. Rewriting a whole file to change three paragraphs',
  'is the failure; rewriting it because three paragraphs are all that survive is not.',
  '',
  'Also still correct, and NOT repealed here:',
  '- Heredocs for a file that does not exist yet, and for a genuinely scripted multi-file transform',
  '  (one script that rewrites twelve call sites). Writing those out as edits is worse.',
  '- The batched `set +e` probe script for READING — that rule is about reading, this one is about',
  '  writing, and they do not conflict.',
  "- Redirecting an expensive command's output to a file and re-slicing it.",
  '',
  'If an edit fails to match, re-read the exact region and retry with a longer, unique anchor. Do',
  'NOT fall back to rewriting the whole file — that is the failure this rule exists to prevent, and',
  'the second attempt costs more than the first.',
].join('\n');

/**
 * The spec reviewer's verdict marker (`.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md`,
 * P2) — `CEZ:REVIEW=pass` or `CEZ:REVIEW=revise`, a sibling of `CEZ:DONE` / `CEZ:SPEC_PATH`.
 *
 * This is the half of the review that works at the SHIPPED DEFAULT. The human gate
 * (`requiresApproval`) defaults to auto-approved, so a review step that only asked a person
 * would be, in AGENTS.md's words, "a mechanism removed and a setting added". The agent's own
 * verdict is what still bites when nobody has configured anything: `revise` loops the chain
 * back to the step named in `onFail.retry`, bounded by `onFail.max`.
 *
 * Read from the END of the turn (like `CEZ:DONE`) so a marker MENTIONED mid-report — this very
 * doc comment, a spec quoting the syntax, a reviewer explaining what it is about to emit — is
 * not mistaken for the verdict. Absent marker = `undefined` = "said nothing", which the caller
 * treats as `pass`: a reviewer that forgets its marker must not wedge the chain.
 */
const REVIEW_VERDICT_RE = /CEZ:REVIEW\s*=\s*(pass|revise)\s*$/i;

export type ReviewVerdict = 'pass' | 'revise';

/** The trailing `CEZ:REVIEW=` verdict of a turn, or undefined when it declared none. */
export function parseReviewVerdict(turnText: string): ReviewVerdict | undefined {
  const match = REVIEW_VERDICT_RE.exec(turnText.trimEnd());
  if (!match) return undefined;
  return match[1]?.toLowerCase() === 'revise' ? 'revise' : 'pass';
}

/** Where the `context` step leaves its brief. An existing convention, not a new one:
 *  `.ai/specs/briefs/2026-08-07-issue-linked-pr-chip.md` predates this spec. */
export const BRIEFS_DIR = '.ai/specs/briefs';

/**
 * The per-step model policy for `spec-to-deploy` (owner instruction 2026-08-21: "writing spec
 * should be sonnet, review spec should be opus, then all the rest should be sonnet again").
 *
 * Naming the model ON THE STEP is what makes this a policy rather than a preference.
 * `runAgentStep` resolves `step.model ?? input.model`, so these WIN over the model picked in the
 * composer — a deliberate trade, and the one real cost of this change: the picker no longer
 * changes what a `spec-to-deploy` run costs. The alternative, `defaultModels`, could not express
 * this at all: it is resolved CLIENT-side in the composer and cannot vary by step.
 *
 * The split is judgement work vs. construction work. `review-spec` is the last checkpoint before
 * a spec is implemented, committed, PUSHED and DEPLOYED, and it is one read-only pass over one
 * file — cheap to run on the better model. The other seven act on an artefact that already
 * exists. Both ids are `KNOWN_PRESETS_BY_RUNNER.claude` members (asserted in `types.test.ts`) and
 * deliberately ALIASES, not pinned version ids, so the chain follows the account's current tier.
 *
 * Spec: `.ai/specs/2026-08-21-per-step-model-policy.md`.
 */
const SPEC_TO_DEPLOY_STEP_MODEL = 'sonnet';

/**
 * The two judgement steps — see {@link SPEC_TO_DEPLOY_STEP_MODEL} and
 * {@link SPEC_AUTHORING_RUNNER}.
 *
 * **Amended 2026-08-22** (owner: *"writing spec + spec review should be by opus always, the rest
 * can be load balanced by codex or claude sonnet"*). `spec` joins `review-spec` on opus; it ran on
 * sonnet under the 2026-08-21 policy. Writing the spec and reviewing it are the two places where
 * the judgement IS the deliverable, and everything downstream is construction against whatever
 * they produce.
 */
const SPEC_AUTHORING_MODEL = 'opus';

/**
 * `spec` and `review-spec` pin the RUNNER as well as the model, and the runner pin is what makes
 * "always opus" true rather than aspirational.
 *
 * `opus` is a Claude alias. On a run started on codex, the model pin alone is dropped by
 * `RunManager.modelForBackend` (it names no model codex serves) and the step would quietly fall
 * back to codex's default — the opposite of always. Naming the runner keeps both halves of the
 * instruction: these two steps are opus, on Claude, whatever the rest of the chain runs on.
 *
 * The other six steps carry no runner, so they follow the run's own — which is what leaves room
 * for the balancing half of the instruction ("the rest can be load balanced by codex or claude
 * sonnet"). Today that balance is per-run and chosen by hand: cezar has no cross-runner routing,
 * because `pool:*` balances ACCOUNTS WITHIN a provider and the backend is already fixed before the
 * pool is consulted. Filed as its own task, with making this whole table configurable in global
 * settings. Spec: `.ai/specs/2026-08-22-failed-turn-reads-as-done.md`.
 */
const SPEC_AUTHORING_RUNNER = 'claude' as const;

/**
 * `run-tests`'s reasoning-depth ceiling (`.ai/specs/2026-08-21-run-tests-reasoning-ceiling.md`,
 * Phase 1). A cezar-spawned `run-tests` step with no `--effort` flag runs at `high` — measured
 * directly against the pinned CLI — and that is the level the 43,583-output-token outlier run
 * ran at. `medium` is a one-notch cut from that measured default, not a guess about an unknown
 * one: enough budget to interpret a gate failure, capped short of the open-ended, iterative
 * root-causing that step's job never asked for.
 */
const RUN_TESTS_STEP_EFFORT = 'medium';

/**
 * The codex half of the per-step policy — the owner's task→model table of 2026-08-24, applied to
 * this workflow (`.ai/specs/2026-08-24-codex-step-model-and-effort.md`, D2):
 *
 * | Task | Model |
 * | --- | --- |
 * | Commits, renaming, spacing, tiny UI changes | Luna Medium/High |
 * | Normal bug fix or a clearly scoped feature | Luna XHigh |
 * | Unclear task that requires exploring several parts of the repo | Terra Medium |
 * | Complex bug, architecture, auth, payments, migrations | Sol Medium |
 * | Terra/Sol Medium failed | Sol High/Max |
 * | Sol Ultra | Basically never |
 *
 * **Why this is needed at all.** Every step below pins a CLAUDE model, and on a codex run
 * `modelForBackend` drops all six as another runner's id — leaving them on codex's own default,
 * measured on `prod-host` as **`gpt-5.6-sol` with `reasoningEffort: null`**, i.e. the most
 * expensive model in the catalog at its shallowest reasoning level, for `Commit & push` and
 * `Deploy` alike. Nobody chose that; it is the absence of a choice.
 *
 * **`implement` is Luna XHigh and not Sol, even for an auth or migration task.** By the time it
 * runs, the architecture decision has been made and reviewed on opus two steps earlier. The
 * table's Sol row is about DECIDING, and `spec`/`review-spec` are where deciding happens — the
 * same judgement-vs-construction split {@link SPEC_TO_DEPLOY_STEP_MODEL} already encodes for
 * Claude.
 *
 * **`gpt-5.4` is not used. RESOLVED 2026-08-24 — the two instructions do not actually conflict.**
 * This paragraph said they "genuinely disagree" and flagged it for the owner; on re-reading the
 * table, the tiny-changes row reads *"Luna Medium/High **or** GPT-5.4"*. It is a disjunction, so
 * naming Luna satisfies it outright — there was never a row this policy could not express. The
 * later, narrower instruction *"in codex use only 5.6"* (2026-08-22) then picks which branch of
 * that `or` to take, which is why `KNOWN_PRESETS_BY_RUNNER.codex` lists the 5.6 family only.
 *
 * Nothing here BLOCKS `gpt-5.4` — an id absent from every runner's preset list fails open, so
 * typing it still works. The built-in workflow and the class table simply do not name it.
 *
 * Every effort here is one all three 5.6 models advertise (`supported_reasoning_levels`, measured
 * from `models_cache.json` on both production accounts: sol and terra `low…ultra`, luna
 * `low…max`), so no catalog check stands between these values and the wire. That is a property of
 * the enum, not luck — `ultra` is the only level the enum omits and the only one luna lacks.
 */
const CODEX_EXPLORE = { model: 'gpt-5.6-terra', effort: 'medium' } as const;

/** Construction against a spec that already exists — the table's "clearly scoped feature" row. */
const CODEX_BUILD = { model: 'gpt-5.6-luna', effort: 'xhigh' } as const;

/** Commits, test runs and deploys — the table's "commits … tiny changes" row, lower half.
 *  `run-tests` lands here rather than on {@link CODEX_BUILD} for the reason
 *  {@link RUN_TESTS_STEP_EFFORT} already gives, which is runner-independent. */
const CODEX_MECHANICAL = { model: 'gpt-5.6-luna', effort: 'medium' } as const;

/** Writing the decision up. The same row as the mechanical steps, upper half: it is prose about
 *  what just happened rather than an edit, and `high` is the half of "Medium/High" that suits
 *  something a human will read as the record. */
const CODEX_WRITE = { model: 'gpt-5.6-luna', effort: 'high' } as const;

/**
 * The fourth row of the owner's table — *"Complex bug, architecture, auth, payments, migrations"*.
 *
 * No `spec-to-deploy` step names it, which is not an oversight: that chain splits the complex work
 * across `spec`/`review-spec`, and both of those pin `SPEC_AUTHORING_RUNNER = 'claude'`, so on a
 * codex run they never reach a codex model at all. It exists for the classifier
 * (`.ai/specs/2026-08-24-auto-classify-task-model.md`), which is the only caller that can land on
 * this row — an ad-hoc "migrate the auth tables" task has no step table to read it from.
 */
const CODEX_COMPLEX = { model: 'gpt-5.6-sol', effort: 'medium' } as const;

/** Spec review is the SOL xhigh judgement pass, with Claude opus as the explicit fallback. */
const CODEX_REVIEW = { model: 'gpt-5.6-sol', effort: 'xhigh' } as const;

/** The version-control grant shared by the commit and merge stages. */
const SHIP_BASH_ALLOWLIST = [
  'git status',
  'git diff',
  'git log',
  'git show',
  'git branch',
  'git rev-parse',
  'git add',
  'git commit',
  'git fetch',
  'git pull',
  'git push',
  'git merge',
  'git checkout',
  'git switch',
  'gh pr',
  'gh repo',
];

/**
 * The four task classes the owner's table names, in ascending cost
 * (`.ai/specs/2026-08-24-auto-classify-task-model.md`).
 *
 * Exported as a `readonly` tuple rather than a bare union because the classifier builds its zod
 * enum and its prompt's allowed-values list from this one array: three copies of four strings is
 * how a fifth class ends up accepted by the schema and never mentioned to the model.
 */
export const TASK_CLASSES = ['tiny', 'scoped', 'explore', 'complex'] as const;
export type TaskClass = (typeof TASK_CLASSES)[number];

/**
 * Class → the codex pair, reusing the SAME constants `spec-to-deploy`'s steps use. Deliberately
 * not a second table of literals: the owner wrote one table, and a `tiny` task and a `commit-push`
 * step are the same row of it. If that row moves, both move together or the two surfaces disagree
 * about what the owner said.
 *
 * There is no Claude half. On Claude an unpinned step gets the CLI's own default, which is a
 * reasonable model at a reasonable setting; on codex it gets `gpt-5.6-sol` at `null` effort, the
 * one cell the table never selects. The asymmetry in the code mirrors a real asymmetry in the
 * defaults, and inventing a Claude policy here would be inventing one the owner never wrote.
 */
export const CODEX_CLASS_CHOICE: Record<TaskClass, StepModelChoice> = {
  tiny: CODEX_MECHANICAL,
  scoped: CODEX_BUILD,
  explore: CODEX_EXPLORE,
  complex: CODEX_COMPLEX,
};

/**
 * The Claude half of the same four rows.
 *
 * **Not invented here.** Every tier is already recorded, and this record only arranges them:
 *
 * - `opus` for the row where *the judgement is the deliverable* — owner instruction 2026-08-22,
 *   *"writing spec + spec review should be by opus always"* ({@link SPEC_AUTHORING_MODEL}), and
 *   `AGENTS.md`'s delegation table, which puts architecture decisions, planning and review on the
 *   session model. The owner's own words for this class are "complex bug, architecture, auth,
 *   payments, migrations" — that table's opus column, verbatim.
 * - `sonnet` for construction — the same instruction's *"the rest can be load balanced by codex or
 *   claude sonnet"* ({@link SPEC_TO_DEPLOY_STEP_MODEL}), and `AGENTS.md`'s Sonnet column
 *   (implementing an approved spec, mechanical migrations, a component whose contract is settled).
 * - `haiku` for the cheapest row — cezar's own established cheap-alias role: it is the default
 *   `namerModel` (`.ai/specs/2026-07-17-task-auto-naming.md`) and a shipped
 *   `KNOWN_PRESETS_BY_RUNNER.claude` preset.
 *
 * **Effort separates `scoped` from `explore`, because Claude has no tier between them.** The codex
 * table moves those two rows apart by MODEL (luna → terra); Claude's ladder is haiku/sonnet/opus,
 * and putting `explore` on opus would contradict the instruction that reserves opus for judgement.
 * So both are sonnet and `explore` gets the higher ceiling, which keeps the table's ORDER intact —
 * haiku < sonnet/high < sonnet/xhigh < opus — without inventing a fourth Claude tier.
 *
 * **This changes a default that was previously sane**, unlike the codex half. An unpinned Claude
 * step used to get the CLI's own choice, which was reasonable; it now gets a class-chosen one. That
 * is a policy decision the owner asked for, not a defect repair, and `BACKWARD_COMPATIBILITY.md`
 * says so in those words.
 */
export const CLAUDE_CLASS_CHOICE: Record<TaskClass, StepModelChoice> = {
  tiny: { model: 'haiku', effort: 'medium' },
  scoped: { model: SPEC_TO_DEPLOY_STEP_MODEL, effort: 'high' },
  explore: { model: SPEC_TO_DEPLOY_STEP_MODEL, effort: 'xhigh' },
  complex: { model: SPEC_AUTHORING_MODEL, effort: 'medium' },
};

/**
 * Which runners have a class table at all.
 *
 * `opencode` and `pi` deliberately have none, for the reason `KNOWN_PRESETS_BY_RUNNER` leaves them
 * empty: their model ids are discovered from the host, so any literal here would be one release
 * away from naming a model the user's provider does not have. A runner absent from this record
 * classifies nothing and keeps its own default — the behaviour every runner had before this table
 * existed.
 */
export const CLASS_CHOICE_BY_RUNNER: Partial<Record<RunnerId, Record<TaskClass, StepModelChoice>>> = {
  codex: CODEX_CLASS_CHOICE,
  claude: CLAUDE_CLASS_CHOICE,
};

/**
 * What a task cezar could not classify is treated as (spec D3).
 *
 * `explore` is not a neutral middle — it is chosen for three properties the alternatives lack.
 * It is the honest reading of the row (*"unclear task that requires exploring several parts of the
 * repo"* is what an unclassifiable task is, from here); it is strictly better than the `undefined`
 * it replaces on every axis (cheaper model than sol, a real reasoning level instead of `null`);
 * and it is one of the two rungs {@link CODEX_ESCALATION} recognises, so a failure climbs to
 * `sol high` on its own. A Luna fallback would have no ladder under it.
 */
export const UNCLASSIFIABLE_TASK_CLASS: TaskClass = 'explore';

/**
 * The owner's standard operating pipeline as ONE selectable chain (spec
 * `.ai/specs/2026-08-19-spec-to-deploy-default-workflow.md`): **gather the record → write the
 * spec → review the spec → implement → run tests → commit & push/merge → document → deploy.**
 * Where `note-to-spec` stops at the spec and `autonomous-implementation` stops at a local commit,
 * this runs the whole loop end to end, remote included.
 *
 * **Amended 2026-08-20** (`.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md`,
 * owner ask): the front half is now THREE steps, not one. `context` gathers the record and writes
 * a brief; `spec` writes the spec from that brief; `review-spec` reads both back and returns a
 * `CEZ:REVIEW=pass|revise` verdict, where `revise` loops the chain back to `spec` (bounded at 2)
 * with the review as its instructions. `review-spec` also carries `requiresApproval`, the human
 * gate — dormant at its default (`approvals.minApprovers: 0` = auto-approved) and teeth only when
 * somebody opts in.
 *
 * The early steps reuse the safety patterns already proven above:
 *  - **`context`** and **`spec`** mirror `note-to-spec` — read-only tools plus `cez kb` and
 *    read-only git, and they stop at their artifact;
 *  - **`review-spec`** is read-only WITHOUT `Write`/`Edit`: a reviewer that can edit what it
 *    reviews is not a reviewer;
 *  - **`implement`** and **`run-tests`** reuse `AUTONOMOUS_IMPLEMENTATION_WORKFLOW`'s exact
 *    `bashAllowlist` BY REFERENCE, so they never drift: installs + gate-shaped runner verbs +
 *    git add/commit, but still **no `git push`** and no bare runner prefix. `implement` writes the
 *    code; `run-tests` runs the full gate suite and fixes what it finds.
 *
 * **Two steps are deliberate, knowing privilege escalations over every other built-in — owner
 * decisions, named honestly so the next reader is not surprised:**
 *  - **`commit-push` (owner decision 2026-08-19, "commit & push/merge")** gets a SCOPED grant that
 *    reaches the remote: git add/commit **plus `git push`**, branch/merge plumbing, and `gh pr`
 *    (open/merge a PR). This is the one step that ships to the remote; it is still an allowlist,
 *    not unrestricted bash — only git and gh, never an arbitrary shell.
 *  - **`deploy` (owner decision 2026-08-19, "fixed grant")** gets UNRESTRICTED `Bash` (default
 *    tools, no `bashAllowlist`) because deploy mechanics differ per project and cannot be predicted
 *    from here; it is told to discover and run the target repo's OWN documented deploy scripts.
 *
 * Both reverse the "no unattended deploy/push" stance that `autonomous-implementation` enforces
 * structurally — that guard is left intact THERE; this workflow makes a different, opt-in-per-task
 * trade. A task only reaches these steps by being started on `spec-to-deploy` on purpose.
 */
export const SPEC_TO_DEPLOY_WORKFLOW: WorkflowDef = {
  name: 'spec-to-deploy',
  description: 'Gather the record, write a spec, review it, implement, run tests, commit & push/merge, document, then deploy.',
  source: 'built-in',
  steps: [
    {
      id: 'context',
      name: 'Gather the record',
      model: SPEC_TO_DEPLOY_STEP_MODEL,
      byRunner: { codex: CODEX_EXPLORE },
      // SPLIT OUT of the old combined `spec` step (owner ask 2026-08-20: "seperate gathering
      // knoweldge/context from writing a spec"; spec
      // `.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md`, P1).
      //
      // Why a separate STEP rather than only sub-agents inside the writing step: every workflow
      // step is its own agent session with its own context window (`runAgentStep` mints a fresh
      // `randomUUID()` per step), so the split gives the WRITING step a clean window holding the
      // brief instead of the raw sweep. The `Task` fan-out added to the combined step is kept —
      // it belongs HERE, in the reading step, which is the exploration-bound one.
      //
      // The combined step's `Task` note still applies: `--allowedTools` only GRANTS additively on
      // a Claude run, so naming it is what stops this step silently losing fan-out the day the
      // filed `--disallowedTools` follow-up lands.
      allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Bash', 'Task'],
      // Read-only except the ONE brief it writes. Same known contradiction the combined step
      // carried: `buildAllowedTools` turns each entry into a STARTS-WITH `Bash(<prefix>:*)`, which
      // the batched `set +e` recipe below can never match. Decorative on Claude today; a real
      // conflict for the `--disallowedTools` follow-up to resolve.
      bashAllowlist: ['git log', 'git show', 'git status', 'git diff', 'cez kb', 'sed -n', 'ls', 'cezar todo list'],
      prompt: [
        'You are GATHERING THE RECORD for the task below. You are NOT writing the spec in this',
        'step, and you are NOT implementing anything. Your single deliverable is a BRIEF.',
        '',
        'Task:',
        '{{task}}',
        '',
        'Read what already exists — most work extends a prior decision:',
        '1. The knowledge base / decision records — search it first (`cez kb search "<query>"`,',
        '   `cez kb show <id>`). It is the source of truth for decisions.',
        '2. The task tracker / open todos, for related or duplicate work already in flight.',
        '3. The spec directory, for a precedent of this shape or a spec this extends, and',
        '   `git log`/`git show` for recent commits touching the area, so the brief describes the',
        '   code that is there NOW rather than the code you assumed.',
        '',
        'Gather all of that in ONE call, not five — none of those facts depends on another:',
        '',
        RECORD_READ_RECIPE,
        '',
        'Then go WIDE. Reading the record, mapping the code, and checking for in-flight duplicate',
        'work are independent jobs, so run up to THREE sub-agents (`Task`) on them in parallel in a',
        'single turn and read their findings together. Rules that make this safe rather than merely',
        'fast:',
        '- Sub-agents are READ-ONLY here. They report findings; they write nothing.',
        '- YOU write the brief. A brief assembled out of sub-agent summaries loses the citations',
        '  that make it worth having — those citations are the entire product of this step.',
        '- Give each one a job whose answer is worth a minute of work. Do not fan out to read one',
        '  file; that costs more than it saves.',
        '',
        'Write ONE brief to `' + BRIEFS_DIR + '/<YYYY-MM-DD>-<short-slug>.md` (match the files',
        'already there). It must contain: the problem in this repository\'s own terms; what the',
        'record already decided, with CITATIONS (KB entry ids, spec paths, commit hashes,',
        'file:line); which code is actually involved; any prior decision this would contradict;',
        'and the open questions a spec will have to settle. State what you could NOT find rather',
        'than inventing it.',
        '',
        'Write NOTHING else — no spec, no code, no test. End your report with the brief\'s path and',
        'the three or four facts that most constrain the design, so the next step reads them even',
        'before it opens the file.',
      ].join('\n'),
    },
    {
      id: 'spec',
      name: 'Write the spec',
      model: SPEC_AUTHORING_MODEL,
      runner: SPEC_AUTHORING_RUNNER,
      byRunner: { codex: CODEX_COMPLEX },
      // Narrowed by the P1 split: the record sweep moved to `context`, so this step's window holds
      // the brief and the code it names rather than the raw search output. `Task` is deliberately
      // NOT granted here — the writing is the one job that must not be delegated, for the reason
      // the prompt gives. `Edit` added (spec `.ai/specs/2026-08-21-edit-an-existing-file-never-
      // re-emit-it.md`, L3): decorative on Claude today (the grant only adds), but the prompt below
      // now tells this step to use it, and a step told to use a tool its own grant omits is an
      // inconsistency `444c7db2`'s `--disallowedTools` would turn into a real failure.
      allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'],
      bashAllowlist: ['git log', 'git show', 'git status', 'cez kb', 'sed -n', 'ls'],
      prompt: [
        'You are writing a SPEC for the task below. You are NOT implementing it in this step.',
        '',
        'Task:',
        '{{task}}',
        '',
        'The previous step read the record and left a BRIEF under `' + BRIEFS_DIR + '/` (its path',
        'is in that step\'s report and in this run\'s handoff file). READ IT FIRST — it holds the',
        'citations, the prior decisions and the open questions you are writing against. If the',
        'brief is missing, say so plainly in the spec and do the reading yourself rather than',
        'writing an uncited spec.',
        '',
        'Open the specific files, specs and commits the brief cites. The brief is a map, not a',
        'substitute for the territory: a spec that describes code nobody re-read is how a spec ends',
        'up describing code that is no longer there.',
        '',
        'Then write ONE spec file, following this repository’s own naming and section conventions',
        '(match the files already in its spec directory — do not impose a different format). It',
        'must contain: a TLDR, the problem, the solution, the architecture, PHASES broken into',
        'independently shippable steps, data models and API contracts where they apply, risks, and',
        'a verification section naming concrete, executable test steps.',
        '',
        'Cite what you actually read — KB entry ids, spec numbers, file paths, commit hashes. If you',
        'could not find something, say so in the spec rather than inventing it.',
        '',
        FILE_WRITE_RECIPE,
        '',
        'Change NO other file in this step. When the spec file exists, declare its path on its own',
        'line: `CEZ:SPEC_PATH=<repo-relative path>`. The next step reviews it.',
      ].join('\n'),
    },
    {
      id: 'review-spec',
      name: 'Review the spec',
      model: CODEX_REVIEW.model,
      effort: CODEX_REVIEW.effort,
      runner: 'codex',
      byRunner: { claude: { model: SPEC_AUTHORING_MODEL, effort: 'xhigh' } },
      // P2 of `.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md`.
      //
      // READ-ONLY BY CONSTRUCTION — no `Write`, no `Edit`. A reviewer that can edit what it
      // reviews does not review it, it rewrites it, and the loop-back below stops meaning
      // anything. When it wants changes it says so, and `spec` makes them in a fresh session with
      // the criticism in its prompt.
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
      bashAllowlist: ['git log', 'git show', 'git status', 'git diff', 'cez kb', 'sed -n', 'ls'],
      // A `revise` verdict re-runs `spec` with this step's report appended to its prompt — the
      // same channel a failing check step uses. `max: 2` bounds it: a stubborn reviewer and a
      // stubborn writer would otherwise argue until the step budget ran out.
      onFail: { retry: 'spec', max: 2 },
      // Owner ask 2026-08-20 ("and then approvals from users"). Dormant unless
      // `approvals.minApprovers` >= 1 — see `requiresApproval`'s doc comment.
      requiresApproval: true,
      prompt: [
        'You are REVIEWING the spec the previous step wrote (its path was declared as CEZ:SPEC_PATH,',
        'and is in this run\'s handoff file). You are NOT implementing it, and you must NOT edit it',
        '— you have no write tools, on purpose.',
        '',
        'Original task, for context:',
        '{{task}}',
        '',
        'Everything after this step acts on the spec: it gets implemented, committed, pushed to a',
        'remote and deployed. You are the last checkpoint before that. Read the spec in full, open',
        'the code and prior specs it cites, and answer:',
        '1. Does it solve the task that was actually asked — the whole ask, not a convenient part?',
        '2. Are its claims about the CURRENT code true? Check the citations; a spec built on a file,',
        '   function or flag that no longer exists is worse than no spec.',
        '3. Does it contradict a decision the record already made, without saying so?',
        '4. Are the phases independently shippable, and does the verification section name steps',
        '   somebody could actually execute?',
        '5. What does it leave out that would bite during implementation?',
        '',
        'Then end your report with your verdict on its OWN LAST LINE, exactly one of:',
        '  CEZ:REVIEW=pass     — good enough to build; list any nits above, they will not block.',
        '  CEZ:REVIEW=revise   — a real defect exists.',
        '',
        'A `revise` verdict is handed to the spec step as ITS INSTRUCTIONS, and it acts on it as a change',
        'list to apply, not as prose to re-derive. So write every defect as its own numbered item, in',
        'exactly this shape:',
        '  1. FILE: <a path that resolves from YOUR OWN working directory — check it exists before you',
        '     write it down. If it does not, use an absolute path instead of guessing a repo-relative one;',
        '     a repo can have more than one directory of the same relative name (e.g. a worktree and the',
        '     main checkout each have their own .ai/specs/).>',
        '     SECTION: <the exact heading text the defect is in, e.g. "## Verification"> — or, for a',
        '     missing section, "NEW — insert after <the heading before it>".',
        '     CHANGE: what is wrong, and specifically what the section should say instead. Concrete',
        '     enough to apply directly — not "clarify this part".',
        '',
        'List every defect this way, even several in the same section. If, taken together, the defects',
        'touch MOST of the document rather than isolated sections, say so in one sentence before the',
        'list (e.g. "This needs a structural rewrite: …") — that is the one case where the next step',
        're-emitting the whole file is the right call instead of editing section by section.',
        '',
        'Judge the spec, not its prose. `revise` is for a spec that is wrong, incomplete against the',
        'ask, or built on facts that do not hold — not for one you would have worded differently.',
        'You get at most two revisions, so spend them on defects that matter.',
      ].join('\n'),
    },
    {
      id: 'implement',
      name: 'Implement the spec',
      model: SPEC_TO_DEPLOY_STEP_MODEL,
      byRunner: { codex: CODEX_BUILD },
      allowedTools: DEFAULT_ALLOWED_TOOLS,
      // Reuse the autonomous workflow's guarded allowlist verbatim so the two never drift:
      // installs + gate-shaped runner subcommands only, git add/commit but never `git push`.
      bashAllowlist: AUTONOMOUS_IMPLEMENTATION_WORKFLOW.steps[0]?.bashAllowlist,
      prompt: [
        'You are IMPLEMENTING the spec this run wrote and reviewed (its path was declared as',
        'CEZ:SPEC_PATH in this run\'s handoff). Nobody is watching — make reasonable assumptions,',
        'note them in your report, and proceed.',
        '',
        'Original task, for context:',
        '{{task}}',
        '',
        'Read the spec fully, then implement it: write the code and the tests its own Verification',
        'section names. You MAY run gates as you go to check yourself, but the authoritative test',
        'run and the commit/push are SEPARATE later steps — do NOT `git push` here, and you need not',
        'do the final commit.',
        '',
        'When you run a gate to check yourself, send its output to a file (`cmd >"$f" 2>&1; echo',
        'EXIT=$?`) and wait on the process — never guess with `sleep N`. Then re-read that file for a',
        'different slice instead of re-running the command; a filter is free, the command is not.',
        '',
        FILE_WRITE_RECIPE,
        '',
        'End your report with what you implemented and any assumptions you made.',
      ].join('\n'),
    },
    {
      id: 'run-tests',
      name: 'Run the tests',
      model: SPEC_TO_DEPLOY_STEP_MODEL,
      effort: RUN_TESTS_STEP_EFFORT,
      byRunner: { codex: CODEX_MECHANICAL },
      // THE step the second admission gate exists for (D14). Declared here, on the definition,
      // and never inferred from the id at runtime — see `heavy`'s own doc comment on the step
      // schema above. Measured: a run sits near 0.5 GB for most of its life and spikes into
      // multiple GB inside this step, at a 12.9 % duty cycle. It is also the ONLY built-in step
      // that carries the flag; the gate is otherwise inert, and stays inert for every installed
      // user until they set `resources.maxHeavySteps` themselves.
      heavy: true,
      allowedTools: DEFAULT_ALLOWED_TOOLS,
      // Same guarded allowlist as `implement`, by reference: it can install, run every gate, and
      // edit code to fix a failure — but it cannot reach the remote. `commit-push` does that next.
      bashAllowlist: AUTONOMOUS_IMPLEMENTATION_WORKFLOW.steps[0]?.bashAllowlist,
      prompt: [
        'The previous step implemented the spec. RUN THIS REPOSITORY\'S FULL GATE SUITE now and make',
        'it green before anything is committed or shipped.',
        '',
        'Original task, for context:',
        '{{task}}',
        '',
        'Run the repo\'s own gates — typecheck, lint, and tests, whatever it defines (check its',
        'package.json / Makefile / CI config for the real commands). If any fail, FIX the code and',
        're-run until they pass. Do NOT commit and do NOT `git push` in this step.',
        '',
        'This step is bound by EXECUTION, not by thinking — on a measured run, 617 of its 826',
        'seconds were `npm`. So overlap it instead of watching it:',
        '- Send every gate\'s output to a file and wait on the PROCESS, never on a guessed duration:',
        '    npm test >/tmp/gate-test.log 2>&1; echo "EXIT=$?" >>/tmp/gate-test.log',
        '  Foreground it when you have nothing to overlap — that is one round trip and it cannot',
        '  overshoot. When you DO have other work, start it with `run_in_background`, do that work,',
        '  then wait for the completion signal and read the output file it hands you. If a fresh',
        '  shell must wait on something it did not start, block on the marker rather than guess:',
        '    until grep -q "^EXIT=" /tmp/gate-test.log; do sleep 5; done',
        '  A bare `sleep N` before grepping a log is never the answer: measured across six',
        '  sessions, that guessing cost 16.9 minutes against 10.0 minutes of real gate time.',
        '- Start the dependency install in the BACKGROUND as your first action, before you read',
        '  anything. Then read the repo\'s gate config while it runs.',
        '- Never report a gate you did not read, and never end your turn while one is still',
        '  running. If you run out of work to overlap, block on the marker — do not report.',
        '- Read a DIFFERENT SLICE of the saved log rather than re-running the gate: `grep -n`,',
        '  `sed -n 1,80p` and `tail -40` against the same file are free; the gate is not. Re-run a',
        '  gate only after you have changed code. On a measured run one test file was re-run 11',
        '  times — 230 seconds of pure repetition — only to see a different filter of one output.',
        '- Never background anything that mutates the git index.',
        '- Root `npm test` scrubs its own environment (`NODE_ENV` for `web`, ambient `CEZ_*` and',
        '  in-repo `TMPDIR` for `server`) before running — see',
        '  `2026-08-21-npm-test-gate-environment-scrub.md`. `npm run test:unit` and `npm run',
        '  test:package` are NOT covered by that scrub — both are `node --test` scripts that never',
        '  load it — so read AGENTS.md § Validation for the environment traps before running',
        '  either of those, or any invocation the scrub above doesn\'t cover (`npm ci` before a',
        '  `cezar.service` redeploy, non-vitest tooling), before concluding a suite is unrunnable',
        '  here.',
        '',
        'Once a failure reproduces IDENTICALLY against a control that does not contain this run\'s',
        'change (clean HEAD, the parent checkout, `git stash` — see AGENTS.md\'s own method for why',
        'one shared-cause control is proof, not evidence), that is sufficient to call it "not mine".',
        'Stop there. Do not also A/B environment variables, spawn additional probes, or read the',
        'implicated subsystem\'s source hunting for a root cause — that diagnosis is real work, but',
        'it belongs to whoever picks up the todo, not to a step whose contract is pass/fail. File',
        'what you already have (`cezar todo add`): the failing test, the one repro command, the one',
        'control command, and the shared file/line if the output already shows it. Then move on.',
        '',
        'End your report with the exact gate commands you ran and their results, and QUOTE the',
        'exit-marker line from each saved log (`EXIT=0`, `Test Files  N passed`). That line cannot',
        'exist unless the process actually finished, which is the only thing separating a gate that',
        'passed from a gate you stopped watching. If a gate cannot be made to pass, say so plainly',
        'and stop — do not let the chain ship a red build. Report pass/fail plainly. Quote the',
        'failing test\'s own output verbatim — never re-explain what the diff changed; that is',
        'already in the commit this step is about to hand to `commit-push`.',
      ].join('\n'),
    },
    {
      id: 'commit-push',
      name: 'Commit & push',
      model: SPEC_TO_DEPLOY_STEP_MODEL,
      byRunner: { codex: CODEX_MECHANICAL },
      // The step is green only if the tree is CLEAN and (where a remote is reachable) nothing is
      // unpushed — owner instruction 2026-08-20 on run `23221162`, which reported `status=done`
      // leaving 7 modified and 5 untracked files and no commit: "everything must be committed in
      // the commit step". One re-run first, carrying the list of files it left behind.
      verify: [
        { builtin: 'everything-committed', max: 1 },
        { builtin: 'tested-revision-shipped', max: 1 },
      ],
      // Owner decision 2026-08-19 ("commit & push/merge"): a SCOPED remote-reaching grant — git
      // (incl. `git push`, branch/merge plumbing) and `gh pr` only. This is the one step that ships
      // to the remote. It is still an allowlist, NOT unrestricted bash: no arbitrary shell, only the
      // version-control verbs shipping needs. `cez kb` is not here — documenting is the next step.
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
      bashAllowlist: SHIP_BASH_ALLOWLIST,
      prompt: [
        'The change is implemented and its tests pass. SHIP it, following THIS repository\'s own',
        'conventions — do not impose a workflow the repo does not use.',
        '',
        'Original task, for context:',
        '{{task}}',
        '',
        '1. Commit whatever is staged/uncommitted with a clear message (imperative, lowercase prefix',
        '   — `feat:`/`fix:`/`chore:`… — referencing the spec, e.g. "feat: implement <spec>").',
        '2. Push the task branch the way this repo ships: check recent `git log` / a CONTRIBUTING doc',
        '   / the KB for whether it pushes directly or opens a PR. If `main` is protected, open a PR',
        '   rather than forcing a push. Do not merge the base branch in this step.',
        '',
        'If pushing or merging is not possible or not authorized here (no remote, protected branch,',
        'no credentials), commit locally and REPORT that plainly — do not force it. End your report',
        'with the commit(s), the branch, and the push/PR/merge result.',
      ].join('\n'),
    },
    {
      id: 'merge',
      name: 'Merge into base',
      model: SPEC_TO_DEPLOY_STEP_MODEL,
      byRunner: { codex: CODEX_MECHANICAL },
      verify: [
        { builtin: 'tested-revision-shipped', max: 1 },
        { builtin: 'merged-into-base', max: 1 },
      ],
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
      bashAllowlist: SHIP_BASH_ALLOWLIST,
      prompt: [
        'The change is committed and pushed. LAND it on the repository base branch, following this',
        'repository\'s own conventions.',
        '',
        'Original task, for context:',
        '{{task}}',
        '',
        'Derive the target in this order: the run\'s baseBranch, the repository config baseBranch,',
        'then the remote default branch. Strip an `origin/` prefix and ignore a raw 7 to 40 character',
        'hex SHA when choosing a branch.',
        'Use only the repository\'s established landing mechanism: `gh pr merge` or',
        '`git push <remote> HEAD:refs/heads/<base>`. You may merge the base into the task branch when',
        'needed, but never checkout or switch to the base branch in this task worktree.',
        'When auto-merge is disabled, leave the task parked for the manual merge handoff if the base',
        'is protected. Report the target branch and the landing result.',
      ].join('\n'),
    },
    {
      id: 'document',
      name: 'Document the decision',
      model: SPEC_TO_DEPLOY_STEP_MODEL,
      byRunner: { codex: CODEX_WRITE },
      // This step COMMITS too (spec status, KB, tracker), so it inherits the same post-condition:
      // a record written into an uncommitted file is a record the next session never reads.
      verify: [
        { builtin: 'everything-committed', max: 1 },
        { builtin: 'merged-into-base', max: 1 },
      ],
      // `Task` for the same measured reason the reading step has it: 361 s of model time against
      // 109 s of tool time, and its three reads — what the KB already says, what the spec claims,
      // what the tracker thinks — are independent. It WRITES (Edit/Write are granted), so the
      // read-only bound on the sub-agents is load-bearing, not decorative: concurrent writers in
      // one worktree corrupt each other, which is why `implement` gets no fan-out at all.
      //
      // The GRANT alone did not produce fan-out, and the prompt is why (spec
      // `.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md`, Phase 3). Measured:
      // `context` states the fan-out as its own imperative paragraph with named jobs and rules,
      // and dispatched sub-agents on 3 of 3 runs; this step held the same grant behind a
      // subordinate clause and dispatched on 0 of 2 (`c10864d1` 38 own calls, `7c2dd8f0` 45, both
      // `sub 0`). Same tool, same model, same doctrine — so the clause was promoted to a paragraph
      // in `context`'s voice. If a later run still reports `sub 0` here, the prompt-form
      // hypothesis is falsified: record that, do not iterate the wording a third time.
      allowedTools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash', 'Task'],
      // Runs AFTER `commit-push`, so its own doc/spec/KB commit has to reach the remote too — the
      // same scoped git+gh grant, plus `cez kb` for the knowledge write. Still no arbitrary shell.
      bashAllowlist: [
        'git status',
        'git diff',
        'git log',
        'git show',
        'git add',
        'git commit',
        'git fetch',
        'git merge',
        'git rev-parse',
        'git push',
        'gh pr',
        'cez kb',
      ],
      prompt: [
        'The change for this task is implemented, tested, committed, and landed on the base branch.',
        'Now WRITE THE RECORD STRAIGHT',
        'so the next session reads the truth — in the SAME breath as the code, never later.',
        '',
        'Original task, for context:',
        '{{task}}',
        '',
        'Open with ONE batched read, not one call per source — none of these facts depends on',
        'another:',
        '',
        RECORD_READ_RECIPE,
        '',
        'Then go WIDE. What the knowledge base already says, what the spec claims, and what the',
        'tracker thinks are three independent questions, so run up to THREE sub-agents (`Task`) on',
        'them in parallel in a single turn and read their findings together. Rules that make this',
        'safe rather than merely fast:',
        '- Sub-agents are READ-ONLY here. They report findings; they write nothing. This step holds',
        '  `Edit`/`Write` and works in ONE worktree — concurrent writers corrupt each other.',
        '- YOU do all the writing: the knowledge entry, the spec status, the tracker sync and the',
        '  commit. A record assembled out of sub-agent summaries loses the citations that make it',
        '  worth having.',
        '- Give each one a job whose answer is worth a minute of work. Do not fan out to read one',
        '  file; that costs more than it saves.',
        '',
        'Do all of:',
        '1. Knowledge base — record the durable decision/what shipped where the next session will',
        '   read it (`cez kb` / this repo\'s documented knowledge mechanism). If this change',
        '   corrects or supersedes an earlier decision, MARK the stale entry in place — do not just',
        '   append the new truth beside it.',
        '2. Spec status — set the spec\'s Status to implemented / partial / superseded to match what',
        '   actually landed.',
        '3. Tracker — sync the task/todo state (done, or what remains) so the record and the code do',
        '   not drift.',
        '',
        FILE_WRITE_RECIPE,
        '',
        'Commit the doc/spec edits on the task branch, then land that record on the base branch using',
        'the same mechanism. If pushing is not authorized here, commit locally and say so. End your',
        'report listing',
        'what you recorded and where.',
      ].join('\n'),
    },
    {
      id: 'deploy',
      name: 'Deploy',
      model: SPEC_TO_DEPLOY_STEP_MODEL,
      byRunner: { codex: CODEX_MECHANICAL },
      // Green only when EVERY service in `.ai/deploy-targets.json` probes live — the whole
      // ask: cezar is the UI tree AND the backend service, and shipping one alone used to end this
      // step green. A repo that declares no targets file is RED, not green: "nobody said what this
      // deploys" is not evidence it deployed. See `workflows/postconditions.ts`.
      verify: { builtin: 'all-services-deployed', max: 1 },
      // Fixed grant (owner decision 2026-08-19): UNRESTRICTED Bash on purpose. Deploy mechanics
      // differ per project and cannot be enumerated here, so this step runs the target repo's OWN
      // documented deploy scripts. See this workflow's doc comment for why this reverses the
      // no-unattended-deploy stance the autonomous workflow enforces — a deliberate, opt-in trade.
      allowedTools: DEFAULT_ALLOWED_TOOLS,
      prompt: [
        'The change for this task is implemented, tested, shipped, and documented. Now DEPLOY it',
        'using THIS repository\'s own existing deploy mechanism — do not invent a deploy process.',
        '',
        'Original task, for context:',
        '{{task}}',
        '',
        'Read `.ai/deploy-targets.json` first, if it exists. A target with `"manual": true` is one a',
        'PERSON deploys, for the reason its `manualReason` gives. You must NOT deploy, activate,',
        'restart, flip or otherwise ship it, and you must not work around it. Deploy only the targets',
        'where `manual` is absent or false. If every target is manual, deploy nothing and say so in',
        'your report: the step will park for a human, and that parked state is the correct outcome,',
        'not a failure to route around.',
        '',
        'First DISCOVER how this repo deploys, then run it:',
        '- Look for a deploy script (package.json `deploy`/`release`/`publish`, a `scripts/deploy*`,',
        '  a Makefile target, `wrangler deploy`, a CI/deploy doc in the repo or its knowledge base).',
        '- Read its documented deploy instructions and follow them exactly.',
        '',
        'If you find a clear deploy path, run it and verify it succeeded (check the command output /',
        'health of the deployed service). If this repo has NO documented deploy mechanism, do NOT',
        'improvise or push blindly — stop and report that no deploy path was found, so a person can',
        'decide. End your report with what you deployed, the command you ran, and the result.',
      ].join('\n'),
    },
  ],
};

/**
 * The workflow a run FLOORS to when it names none — the "default workflow" (owner decision
 * 2026-08-19: `spec-to-deploy` replaces `quick-task` here). This is the single source of truth for
 * that name: every floor reads it, so the default moves in one edit instead of drifting across
 * hardcoded literals.
 *
 * **Owner decision 2026-08-20: default EVERYTHING to this workflow — user-initiated AND unattended.**
 * The `POST /runs`/composer, inbox ▶ Run and CLI floors read this constant; the automation
 * fallback (`automations/task-template.ts`) reads it too; and the web integration fallbacks
 * (GitHub-triggered tasks, the bookmarklet, the unknown-skill prefill) now hardcode `spec-to-deploy`
 * to match. An earlier revision deliberately kept those unattended paths on `quick-task` so a
 * CI-triggered or phone-note run could not inherit `git push` + the unrestricted-Bash deploy step;
 * the owner has since asked for the full pipeline everywhere, so that carve-out is removed. (The
 * deploy step still degrades safely: it discovers a repo's own deploy script and stops if there is
 * none, rather than improvising.)
 */
export const DEFAULT_WORKFLOW_NAME = SPEC_TO_DEPLOY_WORKFLOW.name;

/** The default workflow definition itself — the last-resort fallback when a name lookup misses
 *  (e.g. a repo shipped no catalog and the built-in registry was somehow empty). Pairs with
 *  {@link DEFAULT_WORKFLOW_NAME}. */
export const DEFAULT_WORKFLOW: WorkflowDef = SPEC_TO_DEPLOY_WORKFLOW;
