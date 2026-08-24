import { z } from 'zod';
import { loadConfig } from './config.ts';
import type { AgentRunner } from './core/agent-runner.ts';
import type { RunnerId } from './core/agent-runner.ts';
import { createRunner } from './core/runner-factory.ts';
import { parseStructured } from './planner.ts';
import { resolveProfileEnvForRoot } from './workspace/agent-profiles.ts';
import { TASK_CLASSES, UNCLASSIFIABLE_TASK_CLASS, type TaskClass } from './workflows/types.ts';

/**
 * One cheap agent call that sorts a task into a row of the owner's task→model table
 * (`.ai/specs/2026-08-24-auto-classify-task-model.md`).
 *
 * **Why this exists and `spec-to-deploy`'s per-step pins do not cover it.** Those pins reach eight
 * steps of one built-in workflow. Everything else — a task typed into the composer, a notes
 * continuation, a reopen, an automation, `cezar run` from a script — runs a workflow whose steps
 * name no model, and on codex an unnamed model is not a neutral default: it is `gpt-5.6-sol` at
 * `reasoningEffort: null`, the most expensive model in the catalog at its shallowest setting, and
 * the one cell the owner's table never selects. See
 * `.ai/specs/2026-08-24-codex-step-model-and-effort.md` for that measurement.
 *
 * **Discipline copied verbatim from `planChain` and `NoteProcessor.ask`**, because the failure
 * modes are identical: no tools, a hard timeout, ONE retry on an unparseable answer and NO retry
 * on a runner error (a runner that is absent or unauthenticated is not a condition a second
 * identical call improves), and a degraded answer rather than a thrown one. A task is never
 * blocked by this — `.ai/specs/2026-08-23-never-block-a-task.md`.
 *
 * **The degrade is never silent.** {@link TaskClassification.classified} is false and `reason`
 * carries what went wrong, so the caller can say so on the run thread. A fail-soft path with no
 * counter is a quieter outage, not a fixed one — the repo's own record on that is
 * `knowledge/sections/257-…-fail-soft-classification-is-a-whitelist-or-it-is-…`.
 *
 * **It classifies on `config.defaultRunner`, not on the runner the task will use.** The class is a
 * property of the TASK, not of the engine — "migrate the auth tables" is complex work whoever runs
 * it — so there is nothing to gain by forcing the call onto codex, and two things to lose: the
 * CORRECTED 2026-08-24 by `.ai/specs/2026-08-24-codex-dry-run-mock.md`: ~~`CEZ_DRY_RUN` mock only
 * exists for claude and pi~~, it now covers codex too, via `scripts/mock-codex-app-server.mjs`.
 * The second reason still stands unchanged: a codex-only classify would spend the same
 * account's codex quota the run is about to spend. Only the class→model MAPPING is codex-specific,
 * and that lives in `CODEX_CLASS_CHOICE`.
 */

/** 30s, half of `PLANNER_TIMEOUT_MS`. This answers one enum value from a prompt with no catalog
 *  in it; a call still running at 30s is not going to produce a better word at 60. */
const TASK_CLASS_TIMEOUT_MS = 30_000;

/** The `[cez-classify]` marker lets the CEZ_DRY_RUN mock recognize a classification call, exactly
 *  as `[cez-planner]` and `[cez-note-pass]` do for their callers. */
const CLASSIFY_MARKER = '[cez-classify]';

/**
 * How much of the task text the classifier is shown.
 *
 * A task body is unbounded — a pasted stack trace, a whole spec, a transcript — and this call is
 * supposed to be the cheap one. A PREFIX is the right half to keep here, which is not true of
 * truncation in general: a task opens by saying what to do, so the sentence that decides the class
 * is at the top. The truncation is marked in the prompt rather than silent, so the model is not
 * asked to classify a document that appears to stop mid-word for no reason.
 */
const TASK_EXCERPT_CAP = 4_000;

/**
 * The four rows, in the owner's own words. Built from {@link TASK_CLASSES} so the prompt's allowed
 * values and the schema's enum cannot drift apart — a fifth class added to the tuple and not to
 * this record fails to compile rather than being accepted by the schema and never offered to the
 * model.
 */
const CLASS_DESCRIPTIONS: Record<TaskClass, string> = {
  tiny: 'commits, renaming, spacing, tiny UI changes',
  scoped: 'a normal bug fix, or a clearly scoped feature',
  explore: 'an unclear task that requires exploring several parts of the repo',
  complex: 'a complex bug, architecture, auth, payments, or migrations',
};

const TASK_CLASS_SYSTEM_PROMPT = [
  'You classify software tasks by how much reasoning they need. Respond with ONLY a JSON object:',
  '{"class":"<one of the allowed values>","why":"<one short sentence>"}.',
  'Allowed values, and what each means:',
  ...TASK_CLASSES.map((c) => `- "${c}" — ${CLASS_DESCRIPTIONS[c]}`),
  'Judge the work the task asks for, not how politely or how briefly it is written.',
  'A short sentence can describe a migration; a long one can describe a rename.',
  `When two classes fit, pick the more demanding one. When none clearly fits, answer "${UNCLASSIFIABLE_TASK_CLASS}".`,
].join('\n');

const classifyResponseSchema = z.object({
  class: z.enum(TASK_CLASSES),
  /** The model's reason. Read only for the thread note; never parsed, never gated on. */
  why: z.string().max(500).optional(),
});

export interface TaskClassification {
  taskClass: TaskClass;
  /** False when this is the {@link UNCLASSIFIABLE_TASK_CLASS} fallback rather than a model's
   *  answer. The caller says so on the thread; nothing branches on it. */
  classified: boolean;
  /** On a successful classification, the model's one-line reason. On a fallback, what went
   *  wrong. Present in both cases so a transcript never has to infer which happened. */
  reason?: string;
}

export interface ClassifyTaskDeps {
  /** Injected by tests, on `NoteProcessor`'s precedent. */
  runnerFactory?: (backend: RunnerId) => AgentRunner;
}

/**
 * Sort `task` into one of {@link TASK_CLASSES}. Every failure of the CLASSIFICATION — an empty
 * task, a runner error, a timeout, two unparseable answers — answers
 * {@link UNCLASSIFIABLE_TASK_CLASS} with `classified: false` rather than throwing, so a task is
 * never blocked by this (`.ai/specs/2026-08-23-never-block-a-task.md`).
 *
 * It is deliberately **not** wrapped in a blanket try. `loadConfig` and `resolveProfileEnvForRoot`
 * sit outside it: the second documents that it never throws, and the first cannot throw by the time
 * this runs — the run already resolved `config.defaultRunner` at dispatch to pick its backend, so a
 * config this call could choke on is a config that would have failed the run several steps earlier.
 * Catching it here would be decoration over an unreachable path, and decoration is how a caught
 * error later becomes a silent wrong answer instead of a loud one.
 *
 * `repoRoot` is used for the cwd, the config and the agent profile — the call bills the same
 * account the project's tasks bill, which is `planChain`'s rule and exists for the same reason:
 * without it a background pass quietly charges a personal subscription for a project pointed at a
 * work account. On a `pool:*` run the pool's chosen account may differ from the project default;
 * one tiny turn on the default is accepted rather than threading the pool decision in here, which
 * would couple this module to dispatch.
 */
export async function classifyTask(
  repoRoot: string,
  task: string,
  deps: ClassifyTaskDeps = {},
): Promise<TaskClassification> {
  const trimmed = task.trim();
  if (!trimmed) {
    return { taskClass: UNCLASSIFIABLE_TASK_CLASS, classified: false, reason: 'the task is empty' };
  }

  const config = await loadConfig(repoRoot);
  const runnerId = config.defaultRunner;
  const runner = (deps.runnerFactory ?? createRunner)(runnerId);
  const cheap = CHEAPEST_MODEL[runnerId];
  const { env } = await resolveProfileEnvForRoot(repoRoot, runnerId);
  const excerpt = trimmed.slice(0, TASK_EXCERPT_CAP);
  const userPrompt = [
    CLASSIFY_MARKER,
    'Classify this task.',
    '',
    'Task:',
    excerpt,
    ...(excerpt.length < trimmed.length ? ['', '(truncated — classify from the opening above)'] : []),
  ].join('\n');

  let lastError = 'the runner answered nothing this pass could parse';
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      const result = await runner.run({
        systemPrompt: TASK_CLASS_SYSTEM_PROMPT,
        userPrompt,
        cwd: repoRoot,
        // NO TOOLS. The task text is untrusted input and this call exists to read four
        // characters out of it; a shell would be the whole blast radius of the feature.
        allowedTools: [],
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(cheap?.model !== undefined ? { model: cheap.model } : {}),
        ...(cheap?.effort !== undefined ? { effort: cheap.effort } : {}),
        timeoutMs: TASK_CLASS_TIMEOUT_MS,
      });
      text = result.text;
    } catch (error) {
      // Deliberately NOT a retry. See the module doc.
      return { taskClass: UNCLASSIFIABLE_TASK_CLASS, classified: false, reason: describe(error) };
    }
    const parsed = parseStructured(text, classifyResponseSchema);
    if (parsed) {
      return {
        taskClass: parsed.class,
        classified: true,
        ...(parsed.why?.trim() ? { reason: parsed.why.trim() } : {}),
      };
    }
  }
  return { taskClass: UNCLASSIFIABLE_TASK_CLASS, classified: false, reason: lastError };
}

/**
 * The cheapest usable model per runner, for a call that answers one enum value.
 *
 * `codex` can name an `effort` here only because `.ai/specs/2026-08-24-codex-step-model-and-effort.md`
 * plumbed it into `turn/start`; before that the field was Claude-only and this would have been a
 * silently-ignored parameter. `opencode` and `pi` name nothing: their model ids are discovered from
 * the host, so any literal here would be one release away from naming a model the user's provider
 * does not have (the same argument `KNOWN_PRESETS_BY_RUNNER` makes for leaving them empty).
 */
const CHEAPEST_MODEL: Record<RunnerId, { model?: string; effort?: string } | undefined> = {
  claude: { model: 'haiku' },
  codex: { model: 'gpt-5.6-luna', effort: 'low' },
  opencode: undefined,
  pi: undefined,
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
