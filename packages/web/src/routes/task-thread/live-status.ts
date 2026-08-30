import type { RunActivity, RunEvent, UiItem } from '@loki-labs/cezar-plus-api-client'

import type { ThreadEntry, ThreadState } from './thread-state'

/**
 * What the live status line says — the CLI's grammar, derived entirely client-side from shapes
 * that already reach the browser (spec 2026-08-20-live-run-status-line-and-timer).
 *
 * Pure and total, exactly like the reducer it reads from: called on every render with the whole
 * event list, it must never throw on a malformed frame. An unreadable event costs one event, and
 * an empty thread degrades to the honest bare `Working`.
 */

/** How the silence reads. Never `stuck` — the UI states a measurement, it does not diagnose. */
export type LiveTone = 'normal' | 'quiet' | 'stale'

export interface LiveStatus {
  /** "Ran npm test" | "Read run-header.tsx" | "Thinking" | "Writing" | "Working" */
  headline: string
  /** Last non-empty line of the streaming field, collapsed and truncated. Absent when none. */
  detail?: string
  /** ms since the current item started; absent when no item has started this turn. */
  itemMs?: number
  /** ms since the newest event's `ts`; drives the quiet badge. */
  silentMs: number
  /** 'normal' | 'quiet' (>= QUIET_MS) | 'stale' (>= STALE_MS) — never "stuck". */
  tone: LiveTone
  /** True when the item is a subagent's (`parentItemId` present) — renders the arrow prefix. */
  subagent: boolean
}

/**
 * Silence thresholds. Display-only, and deliberately far below the real bound that ends a step —
 * `DEFAULT_RUN_IDLE_TIMEOUT_MS` (30 min, core/claude-cli-runner.ts): the UI says "this has gone
 * quiet" long before anything is killed, and names the real number in a tooltip so the two clocks
 * read as related rather than as two unexplained countdowns.
 */
export const QUIET_MS = 45_000
export const STALE_MS = 5 * 60_000
/** The backend's inactivity bound, mirrored here only as the tooltip's copy. */
export const IDLE_TIMEOUT_MS = 30 * 60_000

/** A single clipped line; tool output can carry 4 000-character lines and progress-bar spam. */
const DETAIL_MAX_CHARS = 180

const isUiItem = (entry: ThreadEntry): entry is UiItem =>
  entry.kind === 'message' || entry.kind === 'reasoning' || entry.kind === 'tool'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** ANSI CSI noise — tool output is raw terminal bytes, and a bare `[2K` is not a status line. */
const ANSI = new RegExp('\\u001b\\[[0-9;?]*[ -/]*[@-~]', 'g')

/**
 * The tail of a streaming field, as ONE line.
 *
 * A carriage return counts as a line break, so a progress bar that rewrites itself in place
 * yields its CURRENT frame rather than the whole accumulated blob — which is the behaviour that
 * makes this line the anti-"is it stuck" signal.
 */
export function lastLine(text: string | undefined): string | undefined {
  if (typeof text !== 'string' || text === '') return undefined
  const lines = text.replace(ANSI, '').split(/\r\n|\r|\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim()
    if (line !== '') {
      return line.length > DETAIL_MAX_CHARS ? `${line.slice(0, DETAIL_MAX_CHARS)}…` : line
    }
  }
  return undefined
}

/** Newest parseable `RunEvent.ts` as epoch ms, scanning from the end. */
export function lastEventAt(events: RunEvent[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ts = events[i]?.ts
    if (typeof ts !== 'string') continue
    const at = new Date(ts).getTime()
    if (!Number.isNaN(at)) return at
  }
  return undefined
}

/** The newest renderable item across the reduced turns — what the agent is doing right now. */
function newestItem(state: ThreadState): UiItem | undefined {
  for (let t = state.turns.length - 1; t >= 0; t -= 1) {
    const items = state.turns[t]?.items ?? []
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const entry = items[i]
      if (entry && isUiItem(entry)) return entry
    }
  }
  return undefined
}

/** Epoch ms of the `item.started` frame that introduced `itemId`, newest first (ids repeat
 *  across sessions — `item_1` is minted fresh by every codex session). */
function itemStartedAt(events: RunEvent[], itemId: string): number | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (!event || event.type !== 'item.started') continue
    const item = (event as { item?: unknown }).item
    if (!isRecord(item) || item.id !== itemId) continue
    if (typeof event.ts !== 'string') return undefined
    const at = new Date(event.ts).getTime()
    return Number.isNaN(at) ? undefined : at
  }
  return undefined
}

/**
 * The headline: the item's OWN title, not a second description of it.
 *
 * Tool titles come straight from `UiToolItem.title`, which the protocol layer computed once
 * (`toolDisplay()`). Reusing it means the status line and the tool card a few pixels below it can
 * never disagree about what the agent is doing — the same "one canonical function" discipline
 * `lib/attention.ts` documents for status.
 */
function headlineFor(item: UiItem | undefined): string {
  if (!item) return 'Working'
  if (item.kind === 'tool') return item.title.trim() === '' ? 'Working' : item.title
  if (item.kind === 'reasoning') return 'Thinking'
  return 'Writing'
}

/** The field that is actually streaming: a tool's `output`, anything else's `text`. */
function detailFor(item: UiItem | undefined): string | undefined {
  if (!item) return undefined
  return item.kind === 'tool' ? lastLine(item.output) : lastLine(item.text)
}

export function liveStatus(input: {
  state: ThreadState
  events: RunEvent[]
  now: number
  activity?: RunActivity
}): LiveStatus {
  const { state, events, now, activity } = input
  const item = newestItem(state)
  const startedAt = item === undefined ? undefined : itemStartedAt(events, item.id)
  const newest = lastEventAt(events)
  // Clamp both clocks at 0: the server stamps `ts`, and a browser clock a few seconds behind it
  // must not print `-3s` (risk R5, the rule `shortAge` already follows).
  const silentMs = newest === undefined ? 0 : Math.max(0, now - newest)

  // A `monitoring` run is quiet ON PURPOSE — it is working on its own downstream work, and
  // `MonitoringSchedule` already says when the next check lands (spec
  // 2026-07-18-subagent-monitoring-status). Escalating it to amber would make the one status
  // that exists to say "this does not need you" look like it does.
  const tone: LiveTone =
    activity === 'monitoring' ? 'normal'
    : silentMs >= STALE_MS ? 'stale'
    : silentMs >= QUIET_MS ? 'quiet'
    : 'normal'

  return {
    headline: headlineFor(item),
    detail: detailFor(item),
    itemMs: startedAt === undefined ? undefined : Math.max(0, now - startedAt),
    silentMs,
    tone,
    subagent: item?.parentItemId !== undefined,
  }
}
