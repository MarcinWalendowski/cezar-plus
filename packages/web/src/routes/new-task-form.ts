// A contract VALUE, not a type: which runners cezar can interrogate for a live catalog is decided
// once, by the schema `GET /api/v1/models` validates with, so the picker and the route cannot
// disagree about who has discovery. It narrows `Runner` to `ModelDiscoveryRunner`.
import { runnerDiscoversModels } from '@loki-labs/cezar-plus-api-client'
import type {
  BackendCheck,
  LockableRunner,
  CreateRunInput,
  CreateRunResponse,
  WorkspaceRunStartInput,
  AttachmentInput,
  DispatchIntent,
  ModelDiscoveryRunner,
  Runner,
  RunnerModelCatalogResponse,
  Skill,
  WorkflowDef,
} from '@loki-labs/cezar-plus-api-client'

/**
 * The new-task form's picker rules and its POST body, as pure functions — the exact semantics
 * of the legacy form (web/app.js: `RUNNERS`, `MODELS_BY_RUNNER`, `renderChrome`,
 * `defaultTaskSource`, the submit handler), kept apart from the component so every rule is
 * table-testable and so drift from legacy is a diff in ONE file, not a scavenger hunt.
 */

// Both live in `@/lib/task-source` — the shared picker and the automations editor read them, and
// a `components/` module must not import from `routes/`. Re-exported so every existing caller of
// this module keeps working.
import { QUICK_TASK, type TaskSource } from '@/lib/task-source'

export { QUICK_TASK, type TaskSource }

/** Prepend `source` to the recency list (newest first), dropping any earlier occurrence of the
 *  same source+ref, and cap the length. Pure so the picker's recency sort is table-testable. */
export function pushRecentSource(
  recent: readonly TaskSource[] | undefined,
  source: TaskSource,
  cap = 24,
): TaskSource[] {
  const rest = (recent ?? []).filter((s) => !(s.source === source.source && s.ref === source.ref))
  return [source, ...rest].slice(0, cap)
}

export interface RunnerOption {
  id: Runner
  label: string
  desc: string
}

/** The agent-backend catalog (legacy `RUNNERS`). Installation-only compatibility surfaces use
 *  `availableRunners`; the new-task composer filters this catalog by connected provider status. */
export const RUNNERS: readonly RunnerOption[] = [
  { id: 'claude', label: 'claude', desc: 'Claude Code CLI' },
  { id: 'codex', label: 'codex', desc: 'OpenAI Codex (app-server)' },
  { id: 'junie', label: 'junie', desc: 'JetBrains Junie CLI' },
  { id: 'opencode', label: 'opencode', desc: 'OpenCode (serve)' },
  { id: 'cursor', label: 'cursor', desc: 'Cursor Agent CLI' },
  { id: 'pi', label: 'pi', desc: 'pi CLI (provider/model)' },
  { id: 'copilot', label: 'copilot', desc: 'GitHub Copilot CLI (ACP)' },
]

export interface ModelPreset {
  id: string
  label: string
  desc: string
}

/**
 * Static model presets per runner. `id: ''` is always "auto" — no model flag, the runner decides.
 *
 * For a runner that discovers (`MODEL_DISCOVERY_RUNNERS` — claude, codex, opencode, cursor) this list is
 * only the FALLBACK, used when the host catalog has nothing to offer; a live catalog replaces it.
 * Nothing dated may be listed for those — pinned ids (`claude-opus-4-8`, `gpt-5.1-codex`) are
 * exactly the drift discovery exists to end (#794 for OpenCode, #784 for Claude). Claude
 * therefore keeps only its tier aliases, which stay true across every rollout because the CLI
 * resolves them itself; Codex, OpenCode and Cursor list `auto` alone. pi has no host catalog yet, so its
 * entries are the real picker contents rather than a fallback.
 */
export const MODELS_BY_RUNNER: Record<Runner, readonly ModelPreset[]> = {
  claude: [
    { id: '', label: 'auto', desc: 'Pick the best model per step' },
    { id: 'opus', label: 'opus', desc: 'Deep reasoning for hard tasks' },
    { id: 'sonnet', label: 'sonnet', desc: 'Fast and cheap' },
    { id: 'haiku', label: 'haiku', desc: 'Fastest — simple, scoped tasks' },
  ],
  codex: [
    { id: '', label: 'auto', desc: 'Use your Codex default model' },
  ],
  opencode: [
    { id: '', label: 'auto', desc: 'Use your OpenCode default model' },
  ],
  junie: [
    { id: '', label: 'auto', desc: 'Use your Junie default model' },
  ],
  cursor: [
    { id: '', label: 'auto', desc: 'Use your Cursor default model' },
  ],
  // pi selects a model with the same `provider/model` convention as opencode.
  pi: [
    { id: '', label: 'auto', desc: 'Use your pi default model' },
    { id: 'anthropic/claude-opus-4-8', label: 'claude-opus-4.8', desc: 'via Anthropic' },
    { id: 'anthropic/claude-sonnet-5', label: 'claude-sonnet-5', desc: 'via Anthropic' },
    { id: 'openai/gpt-5.1', label: 'gpt-5.1', desc: 'via OpenAI' },
  ],
  // Copilot has no host catalog here (it stays out of `MODEL_DISCOVERY_RUNNERS`), and its own
  // catalog is fetched from GitHub per account, so nothing dated can be listed truthfully. `auto`
  // is Copilot's own documented value for "let Copilot pick" (`copilot --help`), and the field
  // stays free text for anything the account is entitled to.
  copilot: [
    { id: '', label: 'auto', desc: 'Let Copilot pick the model' },
  ],
}

/**
 * Bare id shapes that name a backend's OWN vendor. Structural rather than dated, which is the
 * point: once the preset lists stopped naming releases (#784, and Codex before it) a
 * list-membership test could no longer tell that `claude-opus-4-8` is Anthropic's, so the check
 * moved to the shape every such id shares — including ones that do not exist yet.
 *
 * Anchored on a BARE id on purpose. A gateway id names its provider explicitly
 * (`anthropic/claude-…`, `openai/gpt-…`) and is a legitimate custom model on a backend that
 * accepts one, so it is left alone here.
 */
const NATIVE_MODEL_ID_PREFIX: Partial<Record<Runner, RegExp>> = {
  claude: /^claude[-.]/,
  codex: /^gpt[-.]/,
}

/** Runners that pick with the canonical `provider/model` convention and span every provider the
 *  host has configured, so an id they list is never EXCLUSIVE to them: pi offers
 *  `openai/gpt-5.1` as a preset and OpenCode serves the very same model from the very same
 *  provider. Their presets are therefore skipped when judging another runner's id.
 *
 *  This is the cockpit's half of the rule the server states structurally — a runner with no
 *  default provider cannot be contradicted, which is why `KNOWN_PRESETS_BY_RUNNER.pi` is empty
 *  in `packages/cezar/src/core/model-presets.ts`. Without it, adding pi's presets here would
 *  silently strip a pinned OpenCode model from the OpenCode picker.
 *
 *  It exempts a runner's PRESET LIST, never the vendor shapes above: those name a vendor's own
 *  native id space (`claude-…`, `gpt-…`), which a `provider/model` runner cannot claim either
 *  way, so a bare vendor id stays a cross-runner mismatch on pi and OpenCode as much as it is
 *  on the other backends. */
const PROVIDER_SPANNING_RUNNERS: readonly Runner[] = ['opencode', 'pi']

/** Keep recognized presets from another backend out of a runner's custom-model escape hatch
 * (#480).
 * Unknown ids remain valid custom models; only a known cross-runner mismatch is discarded. */
export function modelConflictsWithRunner(model: string, runner: Runner): boolean {
  if (!model || MODELS_BY_RUNNER[runner].some((preset) => preset.id === model)) return false
  if (NATIVE_MODEL_ID_PREFIX[runner]?.test(model)) return false
  return Object.entries(MODELS_BY_RUNNER).some(
    ([other, presets]) =>
      other !== runner &&
      !PROVIDER_SPANNING_RUNNERS.includes(other as Runner) &&
      presets.some((preset) => preset.id !== '' && preset.id === model),
  ) || Object.entries(NATIVE_MODEL_ID_PREFIX).some(
    ([other, prefix]) => other !== runner && prefix.test(model),
  )
}

export function modelsForRunner(
  runner: Runner,
  catalog?: RunnerModelCatalogResponse,
  customIds: readonly (string | null | undefined)[] = [],
): readonly ModelPreset[] {
  const presets = MODELS_BY_RUNNER[runner] ?? MODELS_BY_RUNNER.claude
  const discovered = runnerDiscoversModels(runner) ? (catalog?.models ?? []) : []
  // A live catalog REPLACES the presets rather than extending them: the whole point is that the
  // host CLI, not this file, decides which models exist. The presets come back the moment
  // discovery has nothing — a missing, old or logged-out CLI leaves a usable picker, never an
  // `auto`-only one (#784).
  const base = discovered.length > 0 ? [autoPreset(presets)] : [...presets]
  const seen = new Set(base.map((model) => model.id))
  // `discovered` is already empty for a runner without discovery, so no second gate is needed.
  for (const model of discovered) {
    if (!model.id || seen.has(model.id)) continue
    seen.add(model.id)
    base.push({ id: model.id, label: model.label || model.id, desc: model.description })
  }
  // Native settings may contain a provider-specific/custom id that is not in
  // cezar's static catalog. Keep it representable so the initial selection
  // matches the agent's own configured default on every backend.
  for (const id of customIds) {
    if (!id || seen.has(id) || modelConflictsWithRunner(id, runner)) continue
    seen.add(id)
    base.push({ id, label: id, desc: 'Custom or legacy model' })
  }
  return base
}

/** `auto` survives every discovery outcome — it is cezar's own entry (no `--model` at all), not
 *  something a CLI can stop offering. */
function autoPreset(presets: readonly ModelPreset[]): ModelPreset {
  return presets.find((preset) => preset.id === '') ?? { id: '', label: 'auto', desc: '' }
}

/** How each discovery runner is named in the picker's status line. Keyed by
 *  `ModelDiscoveryRunner` on purpose: a runner gaining discovery cannot forget its label here. */
const DISCOVERY_RUNNER_LABEL: Record<ModelDiscoveryRunner, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  junie: 'Junie',
  cursor: 'Cursor',
}

export function modelCatalogStatus(
  runner: Runner,
  catalog?: RunnerModelCatalogResponse,
  failed = false,
): string | undefined {
  if (!runnerDiscoversModels(runner)) return undefined
  const name = DISCOVERY_RUNNER_LABEL[runner]
  if (catalog?.stale) return `Using cached ${name} model list`
  if (failed || catalog?.source === 'unavailable') return `Latest ${name} models unavailable`
  return undefined
}

/** Which runners the pill offers, from the health checks (legacy `renderChrome`). The `claude`
 *  fallback when nothing is detected is deliberate legacy behavior: the form must always have
 *  a runner, and claude is the default engine. */
export function availableRunners(checks: readonly BackendCheck[]): Runner[] {
  const available = RUNNERS.map((r) => r.id).filter((id) =>
    checks.some((c) => c.name === id && c.available),
  )
  return available.length > 0 ? available : ['claude']
}

/** The effective runner: the user's pick when still installed, else the configured default
 *  when installed, else the first available (legacy preselection order). */
export function resolveRunner(
  picked: Runner | null,
  available: readonly Runner[],
  preferred: Runner,
): Runner {
  if (picked !== null && available.includes(picked)) return picked
  if (available.includes(preferred)) return preferred
  return available[0] ?? 'claude'
}

/**
 * The global engine lock (`.ai/specs/2026-08-29-global-provider-toggle.md`, D6), reduced to what
 * this host can actually honour: the locked provider when it is connected, else `null`.
 *
 * One function rather than the same `&& available.includes(...)` at four call sites, because the
 * `else` branch is the subtle half and it is D3's ruling, not a convenience: **the toggle overrides
 * every SETTING and never AVAILABILITY.** A lock naming a provider that is not connected therefore
 * changes nothing on the screen — the pickers render free, which is exactly what dispatch will do
 * with it, because `downgradePinnedRunner` still outranks the lock server-side. The alternative,
 * showing one locked row for a provider that cannot run, is a picker with no working choice in it
 * and no way to see that.
 *
 * Takes `available` rather than reading provider status itself so it stays pure: every caller
 * already holds the list, and three of the four hold a DIFFERENT one (the composer's connected
 * runners, a continuation's usable ones, the pill's own prop).
 */
export function effectiveLock(
  lock: LockableRunner | null | undefined,
  available: readonly Runner[],
): LockableRunner | null {
  return lock != null && available.includes(lock) ? lock : null
}

/** The runner field shared by every NEW-run surface. Explicit/sticky intent always rides the
 * request; only an untouched pick matching the active project's known default may be omitted. */
export function runnerOverride(
  runner: Runner,
  defaultRunner: Runner | undefined,
  explicit = false,
): Runner | undefined {
  return !explicit && runner === defaultRunner ? undefined : runner
}

/** The effective model: the user's pick when it exists in the selected runner's presets, else
 *  the configured per-runner default (Settings → Agents `defaultModels`, R6 1.5) when IT is a
 *  known preset, else auto (`''`). An explicit pick — including picking auto — always beats
 *  the configured default (`picked: ''` is a pick; only `null` means "never touched").
 *  Deliberately STRICTER than legacy, which kept a stale `taskModel` in state while displaying
 *  auto — here what is displayed is what is sent. */
export function resolveModel(
  picked: string | null,
  runner: Runner,
  defaults?: Partial<Record<Runner, string>>,
  catalog?: RunnerModelCatalogResponse,
): string {
  const models = modelsForRunner(runner, catalog, [picked, defaults?.[runner]])
  if (picked !== null && models.some((m) => m.id === picked)) return picked
  const preset = defaults?.[runner]
  if (preset !== undefined && models.some((m) => m.id === preset)) return preset
  return ''
}

export function sourceExists(
  source: TaskSource,
  skills: readonly Skill[],
  workflows: readonly WorkflowDef[],
): boolean {
  return source.source === 'skill'
    ? skills.some((s) => s.name === source.ref)
    : workflows.some((w) => w.name === source.ref)
}

/**
 * The effective source: the first candidate that still exists, else `null` — the composer's
 * "None" default (2026-08-15). "None" sends neither `workflow` nor `steps`
 * (`buildCreateRunBody` below); the server resolves that to quick-task, so this no longer has to
 * guess one client-side.
 *
 * **CORRECTED 2026-08-15 (owner: "no workflow should be selected by default").** The candidate
 * list used to be `[draft.source, uiState.lastTask]` — the draft pick, then the workflow used on
 * the previous task. That second candidate is gone. It made "None is the cold default" true only
 * on a machine that had never run anything: everyone else got a preselected workflow, which is
 * the thing the owner asked twice to stop. Stickiness *within* a project's own composer draft
 * stays — a pick you made and can see is not a default.
 *
 * `undefined` and `null` are still not interchangeable in `candidates`, because this takes a
 * list: `undefined` means "no opinion, keep looking" and `null` means "explicit None, stop".
 * With one candidate they now reach the same answer; the distinction is kept because the
 * signature is a list and a future second candidate would need it again. A candidate naming a
 * since-deleted skill/workflow is neither — it is skipped and the search continues.
 */
export function resolveSource(
  candidates: readonly (TaskSource | null | undefined)[] | TaskSource | null | undefined,
  skills: readonly Skill[],
  workflows: readonly WorkflowDef[],
): TaskSource | null {
  for (const candidate of Array.isArray(candidates) ? candidates : [candidates]) {
    if (candidate === undefined) continue
    if (candidate === null) return null
    if (sourceExists(candidate, skills, workflows)) return candidate
  }
  return null
}

/**
 * The exact `POST /api/runs` body the legacy form sends:
 *  - a skill runs as a one-step inline chain (spec 008's API — the same shape the inbox and
 *    the bookmarklet auto-start use): `steps: [{ id: 'task', name, skill, prompt: '{{task}}' }]`;
 *  - a workflow goes by name;
 *  - NO source (`null` — the composer's empty state) goes by the built-in `quick-task` name,
 *    because `POST /runs` requires exactly one of `workflow`/`steps`. That name is also what
 *    the server resolves an inbox/bookmarklet run to, so "nothing selected" and "quick-task
 *    selected" are the same run, which is exactly why the picker offers only one of them;
 *  - an explicit/sticky `runner` always rides the request; an untouched runner is omitted only
 *    when it equals the active project's known default (unknown defaults and connected fallbacks
 *    stay explicit);
 *  - `model`/`variants`/`images` only when they say something (`''`/1/empty mean "default").
 */
export function buildCreateRunBody(opts: {
  task: string
  /** `null` is the composer's "None" pick (2026-08-15) — omits both `workflow` and `steps`, so
   *  the server resolves quick-task itself. */
  source: TaskSource | null
  model: string
  /** Native coding-agent settings stay visible, but a locked model is never a request override. */
  modelsLocked?: boolean
  runner: Runner
  /** True when the draft contains a sticky/user runner choice rather than an untouched default. */
  runnerExplicit?: boolean
  defaultRunner?: Runner
  /** Per-task agent account (spec 2026-07-29-agent-profiles) — the composer's override of the
   *  project's own selection, applying to `runner`. Absent/empty follows the project. */
  agentProfile?: string | null
  variants: number
  images: readonly AttachmentInput[]
  /** false → run in the repo working tree, no worktree (single runs only). Sent only when
   *  explicitly off; the default (isolated worktree) stays implicit. */
  worktree?: boolean
  /** true → autonomous run (never pauses for the user). Sent only when on. */
  autonomous?: boolean
  /** Composer review-step toggles (`.ai/specs/2026-08-30-composer-review-step-toggles.md`).
   *  Default on (today's behaviour) — sent only when explicitly turned OFF, mirroring `worktree`. */
  reviewSameModel?: boolean
  reviewCrossModel?: boolean
  /** false → do not ask the agent for follow-up todos. Sent only when off. */
  generateFollowups?: boolean
  /** The inbox entry this composer was prefilled from (`/new?…&todo=`, #374) — sent back so
   *  the server records the started run on it. Empty/absent for every other launch.
   *  Independent of `generateFollowups`: starting a task FROM a follow-up still marks that
   *  entry started, even when the new task itself won't generate follow-ups of its own. */
  todoId?: string
  /** The Dispatch toggle (spec 2026-09-10-dispatch): `{}` is the bare toggle — split it, engine
   *  defaults — and the keys are the limits from its settings. `null`/absent = off, and the key
   *  stays off the wire: its PRESENCE is what makes the server compose the dispatch-mode prompt
   *  and force the worktree. */
  dispatch?: DispatchIntent | null
}): CreateRunInput {
  const {
    task,
    source,
    model,
    modelsLocked,
    runner,
    runnerExplicit,
    defaultRunner,
    agentProfile,
    variants,
    images,
    worktree,
    autonomous,
    reviewSameModel,
    reviewCrossModel,
    generateFollowups,
    todoId,
    dispatch,
  } = opts
  return {
    task,
    // `source === null` (None): omit both keys on the wire — the server resolves quick-task.
    ...(source === null
      ? {}
      : source.source === 'skill'
        ? { steps: [{ id: 'task', name: source.ref, skill: source.ref, prompt: '{{task}}' }] }
        : { workflow: source.ref }),
    model: modelsLocked ? undefined : model || undefined,
    runner: runnerOverride(runner, defaultRunner, runnerExplicit),
    // Sent only when the user picked one — an absent key is "follow the project", which is what
    // every launch that never touched the control means.
    agentProfile: agentProfile || undefined,
    variants: variants > 1 ? variants : undefined,
    images: images.length > 0 ? [...images] : undefined,
    // Off only matters for a single run — variants always isolate.
    worktree: worktree === false && variants <= 1 ? false : undefined,
    autonomous: autonomous === true ? true : undefined,
    // Default on (today's behaviour) — sent only when explicitly turned off, same "untouched
    // means byte-identical to today" rule `worktree` follows above.
    reviewSameModel: reviewSameModel === false ? false : undefined,
    reviewCrossModel: reviewCrossModel === false ? false : undefined,
    generateFollowups: generateFollowups === false ? false : undefined,
    todoId: todoId || undefined,
    dispatch: dispatch ?? undefined,
  }
}

/**
 * `POST /workspace/runs` — the composer's Workspace submit
 * (`.ai/specs/2026-08-15-cross-project-workspace-run.md`).
 *
 * Delegates to `buildCreateRunBody` rather than re-serializing, so a skill pick still becomes an
 * inline step, a locked model is still dropped, and `runnerOverride` still decides whether the
 * runner is sent — three rules that a hand-written second body would silently get wrong the first
 * time one of them changed. Only the three keys a workspace run FIXES are removed:
 * `variants`/`worktree` (there is no repository to isolate into) and `todoId` (per-project inbox
 * provenance). The route rejects them anyway; dropping them here means the client never asks for
 * something the server will ignore.
 */
export function buildWorkspaceRunBody(
  opts: Omit<Parameters<typeof buildCreateRunBody>[0], 'variants' | 'worktree' | 'todoId'> & {
    /** Start the todos this run files, instead of leaving them on their boards
     *  (`.ai/specs/2026-08-25-workspace-scope-routes-tasks.md`, Phase 3). Omitted from the body
     *  unless it is `true`: `workspaceRunStartInputSchema` is `.strict()`, and keeping the default
     *  submission byte-identical to the one this composer sent before the flag existed is what
     *  makes "off" indistinguishable from "an older cockpit". */
    autoStart?: boolean
  },
): WorkspaceRunStartInput {
  const { autoStart, ...rest } = opts
  const {
    variants: _variants,
    worktree: _worktree,
    todoId: _todoId,
    ...body
  } = buildCreateRunBody({ ...rest, variants: 1 })
  return { ...body, ...(autoStart === true ? { autoStart: true } : {}) }
}

/** The one workflow a WORKSPACE-scoped run may pick (`.ai/specs/2026-08-25-workspace-scope-routes-
 *  tasks.md`, Phase 3). Spelled out here rather than imported: the catalog crosses the wire as
 *  plain names, and `packages/cezar/src/workflows/types.ts` is server-side. If the two spellings
 *  ever drift, this pill goes EMPTY rather than wrong — see `workflowsForScope`. */
export const WORKSPACE_WORKFLOW = 'input-to-tasks'

/**
 * The workflow rows the source picker offers, for a scope.
 *
 * At workspace scope a run routes work rather than doing it: it reads every project, files todos,
 * and may not edit a project file at all (Phase 1). Every other workflow in the catalog —
 * `spec-to-deploy` and its codex sibling above all — is a chain of implement/commit/deploy steps
 * that structurally cannot run under that grant, so offering one is offering a run that will fail
 * politely halfway through.
 *
 * FILTERED, not disabled: a greyed-out `spec-to-deploy` still reads as "supported, just not right
 * now". And the same filtered list feeds `resolveSource`, not only the menu — a draft that still
 * names `spec-to-deploy` from before the user switched to Workspace then resolves to NOTHING,
 * which the server reads as "no workflow named" and defaults to `input-to-tasks`. Filtering only
 * the menu would leave that stale draft submitting the old workflow with no control on screen
 * showing it.
 */
export function workflowsForScope(
  workflows: readonly WorkflowDef[],
  workspace: boolean,
): WorkflowDef[] {
  return workspace ? workflows.filter((w) => w.name === WORKSPACE_WORKFLOW) : [...workflows]
}

/** The automation editor persists the exact New task serialization, with only the transport-
 * specific `task` key renamed to `prompt`. Images and inbox provenance are deliberately absent:
 * an automation is a reusable template, not one browser submission. */
export function buildAutomationTask(
  opts: Parameters<typeof buildCreateRunBody>[0],
): Omit<CreateRunInput, 'task' | 'images' | 'todoId'> & { prompt: string } {
  const { task, images: _images, todoId: _todoId, ...body } = buildCreateRunBody(opts)
  return { prompt: task, ...body }
}

/** Where a successful POST navigates: the run's thread — for ×2/×3 the FIRST variant's thread,
 *  exactly what legacy `handleStarted` selects. */
export function startedRunPath(response: CreateRunResponse): string {
  const first = 'runs' in response ? response.runs[0] : response
  return first ? `/tasks/${first.id}` : '/'
}
