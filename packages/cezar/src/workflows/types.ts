import { z } from 'zod';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { POSTCONDITION_IDS } from './postconditions.ts';

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
    /** claude CLI's own `--effort` (low|medium|high|xhigh|max) — a mechanical reasoning-depth
     *  ceiling, mirroring `model` above. No normalization table: unlike `model`, `effort` is not
     *  a per-backend alias, it is a fixed five-value enum the claude CLI defines directly.
     *  Claude-only (`.ai/specs/2026-08-21-run-tests-reasoning-ceiling.md`) — the codex and
     *  opencode runners never read it. */
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
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
    verify: z
      .object({
        builtin: z.enum(POSTCONDITION_IDS).optional(),
        command: z.string().min(1).optional(),
        max: z.number().int().nonnegative().default(1),
      })
      .refine((v) => Boolean(v.builtin) !== Boolean(v.command), {
        message: 'a step\'s verify names either a builtin or a command, not both',
      })
      .optional(),
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
    if (s.model || s.runner || s.allowedTools || s.bashAllowlist || s.onFail || s.verify) return null;
    skills.push(s.skill);
  }
  return skills.length ? skills : null;
}

export function stepKind(step: WorkflowStepDef): 'agent' | 'check' {
  return step.command ? 'check' : 'agent';
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

/** The one exception above — see {@link SPEC_TO_DEPLOY_STEP_MODEL}. */
const SPEC_REVIEW_MODEL = 'opus';

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
      model: SPEC_TO_DEPLOY_STEP_MODEL,
      // Narrowed by the P1 split: the record sweep moved to `context`, so this step's window holds
      // the brief and the code it names rather than the raw search output. `Task` is deliberately
      // NOT granted here — the writing is the one job that must not be delegated, for the reason
      // the prompt gives.
      allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Bash'],
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
        'Change NO other file in this step. When the spec file exists, declare its path on its own',
        'line: `CEZ:SPEC_PATH=<repo-relative path>`. The next step reviews it.',
      ].join('\n'),
    },
    {
      id: 'review-spec',
      name: 'Review the spec',
      model: SPEC_REVIEW_MODEL,
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
        'Everything after this step acts on the spec: it gets implemented, committed, PUSHED to a',
        'remote and DEPLOYED. You are the last checkpoint before that. Read the spec in full, open',
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
        '  CEZ:REVIEW=revise   — a real defect. State each one plainly and say what would fix it;',
        '                        your report is handed to the spec step as its instructions.',
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
        'End your report with what you implemented and any assumptions you made.',
      ].join('\n'),
    },
    {
      id: 'run-tests',
      name: 'Run the tests',
      model: SPEC_TO_DEPLOY_STEP_MODEL,
      effort: RUN_TESTS_STEP_EFFORT,
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
        '- Read this repo\'s own docs for environment traps that make its gates LIE before you',
        '  conclude a suite is unrunnable here (in this repo: AGENTS.md § Validation — `NODE_ENV=',
        '  production` makes `npm ci` install zero devDependencies, and a cockpit session exports',
        '  knobs the server suites assert on). The measured run rediscovered both the hard way and',
        '  paid three full `npm test` runs for it.',
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
      name: 'Commit & push / merge',
      model: SPEC_TO_DEPLOY_STEP_MODEL,
      // The step is green only if the tree is CLEAN and (where a remote is reachable) nothing is
      // unpushed — owner instruction 2026-08-20 on run `23221162`, which reported `status=done`
      // leaving 7 modified and 5 untracked files and no commit: "everything must be committed in
      // the commit step". One re-run first, carrying the list of files it left behind.
      verify: { builtin: 'everything-committed', max: 1 },
      // Owner decision 2026-08-19 ("commit & push/merge"): a SCOPED remote-reaching grant — git
      // (incl. `git push`, branch/merge plumbing) and `gh pr` only. This is the one step that ships
      // to the remote. It is still an allowlist, NOT unrestricted bash: no arbitrary shell, only the
      // version-control verbs shipping needs. `cez kb` is not here — documenting is the next step.
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
      bashAllowlist: [
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
      ],
      prompt: [
        'The change is implemented and its tests pass. SHIP it, following THIS repository\'s own',
        'conventions — do not impose a workflow the repo does not use.',
        '',
        'Original task, for context:',
        '{{task}}',
        '',
        '1. Commit whatever is staged/uncommitted with a clear message (imperative, lowercase prefix',
        '   — `feat:`/`fix:`/`chore:`… — referencing the spec, e.g. "feat: implement <spec>").',
        '2. Ship it the way this repo ships: check recent `git log` / a CONTRIBUTING doc / the KB for',
        '   whether it pushes a branch directly, or opens a PR (`gh pr create`) and merges it',
        '   (`gh pr merge`). Follow that. If `main` is protected, open a PR rather than forcing a push.',
        '3. If self-merging is the repo\'s convention, merge; if review is expected, leave the PR open',
        '   and say so.',
        '',
        'If pushing or merging is not possible or not authorized here (no remote, protected branch,',
        'no credentials), commit locally and REPORT that plainly — do not force it. End your report',
        'with the commit(s), the branch, and the push/PR/merge result.',
      ].join('\n'),
    },
    {
      id: 'document',
      name: 'Document the decision',
      model: SPEC_TO_DEPLOY_STEP_MODEL,
      // This step COMMITS too (spec status, KB, tracker), so it inherits the same post-condition:
      // a record written into an uncommitted file is a record the next session never reads.
      verify: { builtin: 'everything-committed', max: 1 },
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
        'git push',
        'gh pr',
        'cez kb',
      ],
      prompt: [
        'The change for this task is implemented, tested, and shipped. Now WRITE THE RECORD STRAIGHT',
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
        'Commit the doc/spec edits and push them the same way the change was shipped (branch push or',
        'PR). If pushing is not authorized here, commit locally and say so. End your report listing',
        'what you recorded and where.',
      ].join('\n'),
    },
    {
      id: 'deploy',
      name: 'Deploy',
      model: SPEC_TO_DEPLOY_STEP_MODEL,
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
