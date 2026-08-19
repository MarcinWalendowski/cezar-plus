/**
 * The maximum context window (in tokens) of a run's model — the denominator behind the
 * cockpit's `45k / 200k` Context column (spec 2026-08-19-context-usage-in-tasks-table).
 *
 * Derived from the model STRING because that is all a run records: `run.model` is the free
 * text the caller asked for (`auto`, `opus`, a gateway id) and `run.modelIdentity` is the
 * normalized `provider/model` the run actually resolved to (#405). The identity is checked
 * first so an `auto` run still resolves once its real model is known.
 *
 * `undefined` — not a guessed default — when the model is unrecognized: a non-Claude runner
 * (Codex/OpenCode) whose window we do not model must show only the current figure rather
 * than divide by an invented max. Adding a runner's sizes later is one branch here.
 */

const CLAUDE_STANDARD_WINDOW = 200_000;
const ONE_MILLION_WINDOW = 1_000_000;

/** The max context window for a model, or `undefined` when it is not one we model. */
export function contextWindowForModel(
  model: string | undefined,
  modelIdentity?: string | undefined,
): number | undefined {
  // Identity (the resolved provider/model) wins over the caller's free-text `model`, which
  // can be `auto`; fall back to `model` while the identity is still in flight.
  const text = `${modelIdentity ?? ''} ${model ?? ''}`.toLowerCase();
  if (text.trim() === '') return undefined;
  // The 1M-context beta, marked `[1m]` in the model string, takes precedence over the
  // standard Claude window it would otherwise match.
  if (text.includes('[1m]') || text.includes('1m-context') || text.includes('1000000')) {
    return ONE_MILLION_WINDOW;
  }
  if (
    text.includes('claude') ||
    text.includes('opus') ||
    text.includes('sonnet') ||
    text.includes('haiku')
  ) {
    return CLAUDE_STANDARD_WINDOW;
  }
  return undefined;
}
