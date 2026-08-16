import type { Runner } from '@loki-labs/better-cezar-api-client'
import type { TaskSource } from './new-task-form'

/**
 * The new-task draft store (spec: "Queued form state survives navigation (draft store)").
 *
 * localStorage-backed so the form is refresh-resilient: stepping away to check a thread — or
 * accidentally reloading the tab — loses nothing. Nulls mean "the user has not chosen", and the
 * form then uses its default. Images are deliberately NOT persisted (multi-MB base64 would blow
 * the ~5 MB localStorage quota); everything the pickers hold is.
 *
 * **Corrected 2026-08-15:** this paragraph used to end "so an untouched draft never shadows a
 * fresher `lastTask` from the server". There is no `lastTask` any more — this store is now the
 * ONLY thing that preselects a source, which is what makes the version marker below matter.
 *
 * Every entry point takes the project the draft belongs to (multi-project spec, step 3.4) —
 * see `storageKey` below for what scopes what.
 */
export interface NewTaskDraft {
  text: string
  /**
   * The source pill's pick for THIS project's composer.
   *
   * **CORRECTED 2026-08-15 (owner: "no workflow should be selected by default").** This used to
   * read: "`undefined` (the untouched default) means 'no draft-local opinion — defer to the
   * persisted `lastTask`'". There is no longer anything to defer to — the cross-session
   * `lastTask` fallback is gone (`resolveSource`, new-task-form.ts), so `undefined` now means
   * exactly **None**, the same as `null`. The two are still spelled differently because
   * `resolveSource` takes a candidate list and `null` must stop the search; they simply no
   * longer differ in outcome here.
   *
   * A pick made in this composer still persists with the rest of the draft — that is a choice
   * the user made and can see, not a default. What no longer happens is a workflow used on some
   * previous task quietly reappearing preselected on the next one.
   */
  source?: TaskSource | null
  runner: Runner | null
  /** Per-task agent account (spec 2026-07-29-agent-profiles). `null` = follow the project's own
   *  selection, which is what every draft that never touched the control means. Sticky like the
   *  other pickers — which login a repo's work runs under is a way of working, not a whim. */
  agentProfile: string | null
  model: string | null
  variants: number
  /** The `Start | Plan first` toggle (#383). Sticky like the pickers: plan-first is a way of
   *  working, not a per-task whim — it survives navigation with the rest of the draft. */
  planFirst: boolean
  /** Worktree opt-out (#worktree-toggle): false runs in the repo working tree. null → the
   *  remembered `lastWorktree` / default (isolated worktree). */
  worktree: boolean | null
  /** Autonomous (#autonomous): true never pauses for the user. null → remembered
   *  `lastAutonomous` / default (off). */
  autonomous: boolean | null
  /** Follow-up generation is default-on. null → remembered value / on. */
  generateFollowups: boolean | null
}

export interface ComposerRunModeInput {
  hasGit: boolean
  variants: number
  planFirst: boolean
  explicitAutonomous: boolean | null
  explicitWorktree: boolean | null
  interactive?: boolean
  configuredAutonomous: boolean | 'source-dependent'
  configuredWorktree: boolean
  /** `null` is the composer's "None" pick (2026-08-15) — never a skill, so it takes the same
   *  `source-dependent` fallback as a workflow. */
  source: TaskSource['source'] | null
}

/** Resolve run-mode values once, in precedence order: hard constraints, explicit draft
 * choices, an interactive-skill recommendation, then the configured (or source-dependent)
 * default. Parallel variants are the only hard Worktree constraint; ordinary workflows can
 * run in place when the user or workspace policy opts out. `configuredAutonomous`/
 * `configuredWorktree` carry the workspace run defaults; `'source-dependent'` autonomy means
 * skills default on and everything else off. */
export function resolveComposerRunMode(input: ComposerRunModeInput): {
  autonomous: boolean
  worktree: boolean
} {
  const autonomousFallback = input.configuredAutonomous === 'source-dependent'
    ? input.source === 'skill'
    : input.configuredAutonomous
  const recommended = input.interactive === true ? false : undefined
  const autonomous = input.planFirst
    ? false
    : (input.explicitAutonomous ?? recommended ?? autonomousFallback)
  const worktree = !input.hasGit
    ? false
    : input.variants > 1
      ? true
      : (input.explicitWorktree ?? recommended ?? input.configuredWorktree)
  return { autonomous, worktree }
}

/**
 * The `/new` header's one-line answer to "where will this run land?" (#793).
 *
 * Derived from the RESOLVED run mode, never assumed. The header used to print the isolation
 * line unconditionally, so it was simply false whenever the Worktree chip was unchecked — or,
 * as in #791, not rendered at all — and it is the first thing a user reads when trying to work
 * out where their run went. Three states, because they send the user to three different places
 * to find their changes.
 *
 * Takes the resolved `worktree` rather than the draft so it cannot disagree with the chip:
 * `resolveComposerRunMode` already folds in the variants constraint, the explicit opt-out, the
 * interactive-skill recommendation and the workspace default. `hasGit` only distinguishes
 * "opted out" from "there is no repository here", which is the difference between a warning
 * and an explanation.
 *
 * `workspace` (`.ai/specs/2026-08-15-cross-project-workspace-run.md`) is a FOURTH state and it
 * wins over the other three, because a workspace run lands somewhere none of them describe: in
 * EVERY registered project's real working tree at once, with no worktree between the agent and
 * the user's uncommitted work. That is the most consequential thing this header can say, and it
 * is the one state where the Worktree chip on screen states a setting this submit ignores.
 *
 * **CORRECTED 2026-08-16.** This parameter was `allAuto`, and the line it printed said "All /
 * Auto files tasks on the board — nothing starts". That was true of the task fan-out, which is
 * deleted: submit now starts one run immediately. A note claiming nothing starts, above a submit
 * that edits twelve checkouts, is the worst possible version of this line to leave behind.
 */
export function composerRunModeNote(input: {
  worktree: boolean
  hasGit: boolean
  workspace?: boolean
}): string {
  if (input.workspace) {
    return 'Runs once across every project — your real checkouts are modified directly, with no worktree.'
  }
  if (input.worktree) return 'Runs in an isolated worktree — review everything before it lands.'
  if (input.hasGit) return 'Runs in the repo working tree — your checkout is modified directly.'
  return 'Runs in place — no git repository detected, so there is no worktree to isolate in.'
}

const EMPTY: NewTaskDraft = {
  text: '',
  // Untouched, not "explicitly None" — see the field doc comment above.
  source: undefined,
  runner: null,
  agentProfile: null,
  model: null,
  variants: 1,
  planFirst: false,
  worktree: null,
  autonomous: null,
  generateFollowups: null,
}

const STORAGE_KEY = 'cez-new-task-draft'

/**
 * Draft schema version, stamped on every write and checked on every read.
 *
 * It exists for exactly one job (2026-08-15, owner: "no workflow should be selected by
 * default"): a draft written **before** the None default shipped can hold a `source` that was
 * never an explicit pick — the composer used to preselect `quick-task` and persist it, so the
 * stored value records the old default rather than a decision. Reading it back would keep
 * showing a preselected workflow on the very machines the change is meant to fix, forever, and
 * no amount of correct new code would clear it.
 *
 * So an unversioned draft keeps its text and every run setting and drops **only** `source`. A
 * blanket key bump would have thrown away half-typed task text to fix a pill, which is a worse
 * trade than the bug.
 */
const DRAFT_VERSION = 2

/**
 * The per-project storage key (multi-project spec, "New task": `cez-new-task-draft:<projectId>`).
 *
 * Drafts are project state — a half-typed task for the shop frontend must not surface in the
 * cezar composer when the project pill swaps scope — so each project gets its own key.
 *
 * `null` (the argument's default) keeps the BARE legacy key. That is the same "unscoped means
 * byte-identical" invariant the rest of step 3.1 keeps (`apiPath`, `queryScope`): the boot
 * project mounts unscoped, so its draft stays exactly where it has always been and a task typed
 * before this upgrade is still there after it. Only non-boot projects pay the suffix.
 */
function storageKey(projectId: string | null): string {
  return projectId === null ? STORAGE_KEY : `${STORAGE_KEY}:${projectId}`
}

/** Coerce arbitrary parsed JSON back into a NewTaskDraft, defaulting anything malformed — the
 *  store must survive a hand-edited or older-shape localStorage value without throwing. */
function normalize(raw: unknown): NewTaskDraft {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  // A draft from before DRAFT_VERSION 2 may carry the OLD preselect-quick-task default in
  // `source` rather than a real pick — see the constant's own comment. Its text and settings are
  // still the user's; only the pill is dropped.
  const sourceTrusted = obj.v === DRAFT_VERSION
  return {
    text: typeof obj.text === 'string' ? obj.text : '',
    // A stored `null` is an explicit None pick from a previous session (JSON round-trips it
    // faithfully, unlike `undefined`) — preserve it. Anything else malformed/absent means
    // untouched, which since 2026-08-15 also resolves to None.
    source: !sourceTrusted
      ? undefined
      : isSource(obj.source)
        ? obj.source
        : obj.source === null
          ? null
          : undefined,
    runner: typeof obj.runner === 'string' ? (obj.runner as Runner) : null,
    agentProfile: typeof obj.agentProfile === 'string' ? obj.agentProfile : null,
    model: typeof obj.model === 'string' ? obj.model : null,
    variants: obj.variants === 2 || obj.variants === 3 ? obj.variants : 1,
    planFirst: obj.planFirst === true,
    worktree: typeof obj.worktree === 'boolean' ? obj.worktree : null,
    autonomous: typeof obj.autonomous === 'boolean' ? obj.autonomous : null,
    generateFollowups:
      typeof obj.generateFollowups === 'boolean' ? obj.generateFollowups : null,
  }
}

function isSource(raw: unknown): raw is TaskSource {
  return (
    !!raw &&
    typeof raw === 'object' &&
    ((raw as TaskSource).source === 'skill' || (raw as TaskSource).source === 'workflow') &&
    typeof (raw as TaskSource).ref === 'string'
  )
}

// In-memory cache mirrors storage so reads stay synchronous and cheap; storage is the source of
// truth across reloads. Keyed by storage key, so one open cockpit holds every project's draft
// independently — swapping the pill back and forth never round-trips through a stale singleton.
const cache = new Map<string, NewTaskDraft>()

export function readDraft(projectId: string | null = null): NewTaskDraft {
  const key = storageKey(projectId)
  const cached = cache.get(key)
  if (cached) return { ...cached }
  let draft: NewTaskDraft
  try {
    const stored = localStorage.getItem(key)
    draft = stored ? normalize(JSON.parse(stored)) : { ...EMPTY }
  } catch {
    draft = { ...EMPTY } // private mode / bad JSON — start clean, still works this session
  }
  cache.set(key, draft)
  return { ...draft }
}

export function writeDraft(next: NewTaskDraft, projectId: string | null = null): void {
  const key = storageKey(projectId)
  cache.set(key, { ...next })
  try {
    // `v` rides the stored JSON only — it is a storage concern, not part of the draft the form
    // holds, so `NewTaskDraft` stays the shape the component reasons about.
    localStorage.setItem(key, JSON.stringify({ ...next, v: DRAFT_VERSION }))
  } catch {
    // Storage disabled/full — the in-memory cache still survives navigation this session.
  }
}

/** After a successful submit: the text is spent, the picker choices remain — the next task
 *  usually runs the same way (legacy keeps its pills too). */
export function clearDraftText(projectId: string | null = null): void {
  writeDraft({ ...readDraft(projectId), text: '' }, projectId)
}

/** Test isolation — drop EVERY project's cache and stored draft, so the next read re-consults
 *  storage (a fresh page). */
export function resetDraft(): void {
  cache.clear()
  try {
    for (const key of Object.keys(localStorage)) {
      if (key === STORAGE_KEY || key.startsWith(`${STORAGE_KEY}:`)) localStorage.removeItem(key)
    }
  } catch {
    // ignore
  }
}
