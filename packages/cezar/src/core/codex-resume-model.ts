/**
 * `thread/resume` must always state an explicit `model` — an absent key means codex resumes the
 * thread with whatever it wrote into `thread_settings` when the thread was FIRST created, which
 * can be a model cezar's own dispatch guard (`modelForBackend`) already decided not to send
 * (`.ai/specs/2026-08-23-codex-resume-explicit-model.md`). This resolves what to send, in order:
 *
 *   1. the step's own pin, iff codex can actually serve it;
 *   2. the operator's configured default (`readAgentModelSettings`);
 *   3. codex's own current default, read from the live model catalog;
 *   4. nothing — the caller degrades to today's behaviour and says so.
 *
 * A free function rather than a method on `CodexAppServerRunner` so it is unit-testable without
 * spawning a child process, and so `workflows/run.ts` never has to learn about resume-vs-start.
 */
import { readAgentModelSettings } from '../agent-config/models.ts';
import { normalizeModelForBackend } from './model-identity.ts';
import { modelConflictsWithRunner, KNOWN_PRESETS_BY_RUNNER } from './model-presets.ts';
import type { ModelOption } from './runner-model-catalog.ts';

export interface CodexResumeModelInput {
  /**
   * `spec.model`. NOT assumed to have been conflict-checked: the `runContinuation` path reaches
   * `bootstrap()` with an unchecked `record.model` (`workflows/run.ts:3842`), so this resolver
   * re-checks it with `modelConflictsWithRunner(pinned, 'codex')` and falls through when it
   * conflicts, rather than trusting the caller to have already cleared it.
   */
  pinned?: string;
  /** Live catalog reader; `[]` or a throw both mean "unavailable". */
  discover: () => Promise<readonly ModelOption[]>;
  /** Passed to `readAgentModelSettings`; the resumed session's repo root. */
  repoRoot: string;
  /** Passed to `readAgentModelSettings`; defaults to `process.env`. Injected in tests. */
  env?: NodeJS.ProcessEnv;
}

export interface CodexResumeModel {
  model?: string;
  source: 'pinned' | 'config' | 'catalog' | 'unavailable';
}

export async function resolveCodexResumeModel(input: CodexResumeModelInput): Promise<CodexResumeModel> {
  if (input.pinned && !modelConflictsWithRunner(input.pinned, 'codex')) {
    return { model: input.pinned, source: 'pinned' };
  }

  const configured = await configuredResumeModel(input.repoRoot, input.env ?? process.env);
  if (configured) return { model: configured, source: 'config' };

  let catalog: readonly ModelOption[];
  try {
    catalog = await input.discover();
  } catch {
    catalog = [];
  }
  if (catalog.length > 0) {
    const preferred = KNOWN_PRESETS_BY_RUNNER.codex;
    const pick = catalog.find((option) => preferred.includes(option.id)) ?? catalog[0];
    if (pick) return { model: pick.id, source: 'catalog' };
  }

  return { source: 'unavailable' };
}

/**
 * `readAgentModelSettings` returns the strategy's own wire form, which for codex is
 * `` `${provider}/${model}` `` whenever `model_provider` is set to anything other than `openai`
 * (`agent-config/model-settings/codex.ts:16` — a supported, tested configuration:
 * `agent-config/models.test.ts:69` writes `model = "deepseek-chat"` / `model_provider =
 * "deepseek"` and asserts the reader yields `deepseek/deepseek-chat`). `thread/resume`'s `model`
 * param takes a bare slug, so handing that through verbatim would reintroduce the exact 400 this
 * module exists to prevent — normalise it through the same canonical-identity gate every other
 * model on this path already goes through.
 */
async function configuredResumeModel(repoRoot: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const settings = await readAgentModelSettings('codex', repoRoot, env);
    if (!settings.model) return undefined;
    // Unresolvable pairings (a foreign provider prefix that doesn't match `settings.provider`)
    // throw `ModelIdentityError` here — caught below and treated the same as an unreadable
    // config, falling through to the catalog rather than failing the resume.
    return normalizeModelForBackend('codex', settings.model, { configuredProvider: settings.provider })
      ?.backendModel;
  } catch {
    return undefined;
  }
}
