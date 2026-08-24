/**
 * The per-task draft store (spec `.ai/specs/2026-08-21-per-task-prompt-drafts.md`).
 *
 * A task has THREE boxes you can type an unsent prompt into — the thread composer, the review
 * gate's notes and the approval gate's notes — and until this store existed all three lived in a
 * bare `useState('')` that died on the next tab switch. One entry per (box × run), written
 * synchronously on every change: there is no debounce and therefore no flush to await before
 * navigating, which is the point (D1).
 *
 * localStorage, not the server: `8566a2ed` moved this exact class of state off the API surface,
 * and a half-typed reply describes the browser, not the workspace. Every function is total and
 * never throws — private mode, a full quota or a hand-edited value degrade to "not remembered",
 * never to a broken thread (AGENTS.md § Zero config).
 */

/** One prefix per box: a `review` run can hold review notes AND a composer draft at once, and
 *  three independent writers on one JSON blob would be a read-modify-write race for no gain. */
const PREFIX = {
  prompt: 'cez-task-prompt:',
  reviewNotes: 'cez-task-review-notes:',
  approvalNotes: 'cez-task-approval-notes:',
  handoffNotes: 'cez-task-handoff-notes:',
} as const

export type TaskDraftKind = keyof typeof PREFIX

const PREFIXES = Object.values(PREFIX)

/**
 * The cap on stored drafts, across all three kinds together.
 *
 * A GUESS, not a measurement — there is no number for how many tasks a user half-types into. 100
 * short prompts sit far under the ~5 MB quota, and the reap drops the OLDEST first, so the drafts
 * most likely to matter are the last to go. Unlike the GitHub hand-off store, cezar accumulates
 * hundreds of runs and a run can be deleted while its draft key lives on, so remove-on-empty alone
 * does not bound this.
 */
const MAX_DRAFTS = 100

interface StoredDraft {
  text: string
  /** Epoch ms. Used only to pick reap victims — never shown, never compared for freshness. */
  at: number
}

function keyFor(kind: TaskDraftKind, runId: string): string {
  // Run ids are `randomUUID()` (packages/cezar/src/runs/store.ts), so they are globally unique and
  // need no project scope — the run id IS the scope. This is where the analogy with
  // `new-task-draft.ts` (which needs `:<projectId>`) correctly stops.
  return PREFIX[kind] + runId
}

function isPrefixed(key: string): boolean {
  return PREFIXES.some((prefix) => key.startsWith(prefix))
}

/** Coerce a stored value back to text. A malformed object reads as `''`; a bare string is kept as
 *  text rather than discarded — this store holds nothing but the user's own words, and no schema
 *  is worth throwing those away for (the doctrine `new-task-draft.ts` states for its version bump). */
function parseStored(raw: string): string {
  if (!raw.trimStart().startsWith('{')) {
    try {
      const value: unknown = JSON.parse(raw)
      return typeof value === 'string' ? value : ''
    } catch {
      return raw // never written by this code, but a legacy/hand-edited bare string is still words
    }
  }
  try {
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== 'object') return ''
    const text = (value as Partial<StoredDraft>).text
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

function stampOf(raw: string | null): number {
  if (raw === null || !raw.trimStart().startsWith('{')) return 0 // unstamped ⇒ oldest ⇒ reaped first
  try {
    const value: unknown = JSON.parse(raw)
    const at = value !== null && typeof value === 'object' ? (value as Partial<StoredDraft>).at : undefined
    return typeof at === 'number' && Number.isFinite(at) ? at : 0
  } catch {
    return 0
  }
}

/** An untouched box (never typed into, or already spent by a successful send) answers ''. */
export function readTaskDraft(kind: TaskDraftKind, runId: string): string {
  try {
    const raw = localStorage.getItem(keyFor(kind, runId))
    return raw === null ? '' : parseStored(raw)
  } catch {
    return '' // private mode / bad JSON — the box still works this session
  }
}

/** Empty text REMOVES the entry rather than storing `''` — a spent or untouched box leaves no
 *  trace, so the store never grows with every task ever opened. */
export function writeTaskDraft(kind: TaskDraftKind, runId: string, text: string): void {
  try {
    const key = keyFor(kind, runId)
    if (text === '') localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify({ text, at: Date.now() } satisfies StoredDraft))
  } catch {
    // Storage disabled/full — the box still works this session, it just won't be remembered. No
    // toast: the alternative is one per keystroke, and the React state is authoritative anyway.
  }
}

/**
 * Bound the store to `MAX_DRAFTS`, oldest-first, across all three kinds as ONE population.
 *
 * Called once per thread-composer mount — the composer is the box that mounts on every thread, so
 * it is the one hook that always runs. One `localStorage` pass over a few hundred short keys per
 * thread open, never per keystroke.
 */
export function reapTaskDrafts(): void {
  try {
    const entries: { key: string; at: number }[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key === null || !isPrefixed(key)) continue // never touch a key this store did not write
      entries.push({ key, at: stampOf(localStorage.getItem(key)) })
    }
    if (entries.length <= MAX_DRAFTS) return
    entries.sort((a, b) => a.at - b.at)
    for (const { key } of entries.slice(0, entries.length - MAX_DRAFTS)) localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

/** Test isolation. */
export function resetTaskDrafts(): void {
  try {
    const keys: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key !== null && isPrefixed(key)) keys.push(key)
    }
    for (const key of keys) localStorage.removeItem(key)
  } catch {
    // ignore
  }
}
