import { describe, expect, it } from 'vitest'

import type { RunEvent, UiItem } from '@loki-labs/better-cezar-api-client'

import { IDLE_TIMEOUT_MS, QUIET_MS, STALE_MS, lastEventAt, lastLine, liveStatus } from './live-status'
import { reduceThread } from './thread-state'

/**
 * The status line's whole load-bearing logic, tested without a DOM: what the agent is doing, the
 * tail of what it is streaming, and how quiet it has gone (spec
 * 2026-08-20-live-run-status-line-and-timer §Verification).
 *
 * Every fixture goes through `reduceThread` rather than hand-building a `ThreadState`, so these
 * are claims about the real event streams the cockpit receives — including the ephemeral
 * `item.delta` frames, which are the "stream the last line" behaviour the owner asked for.
 */

const T0 = Date.parse('2026-08-20T12:00:00.000Z')
const at = (ms: number) => new Date(T0 + ms).toISOString()

/** One stamped wire line. */
const line = (seq: number, type: string, rest: Record<string, unknown> = {}, ms = 0): RunEvent =>
  ({ seq, ts: at(ms), type, ...rest }) as RunEvent

const tool = (over: Record<string, unknown> = {}): UiItem =>
  ({
    kind: 'tool',
    id: 'item_1',
    name: 'Bash',
    toolKind: 'execute',
    title: 'Ran npm test',
    status: 'running',
    ...over,
  }) as UiItem

const status = (events: RunEvent[], now: number, activity?: 'monitoring') =>
  liveStatus({ state: reduceThread(events, { activeTurn: true }), events, now, activity })

describe('liveStatus — what the agent is doing', () => {
  it('a running execute tool: the item OWN title, and the LAST streamed output line', () => {
    const events = [
      line(1, 'turn.started', { turnId: 'turn_1' }),
      line(2, 'item.started', { item: tool() }, 1_000),
      line(3, 'item.delta', { itemId: 'item_1', field: 'output', delta: 'RUN v3 packages/web\n' }, 4_000),
      line(
        4,
        'item.delta',
        { itemId: 'item_1', field: 'output', delta: 'apps/web: 214 passed, 3 skipped (12.4s)\n' },
        9_000,
      ),
    ]
    const live = status(events, T0 + 10_000)
    // The headline is `UiToolItem.title` verbatim, so this line and the tool card below it can
    // never describe the same call two different ways.
    expect(live.headline).toBe('Ran npm test')
    expect(live.detail).toBe('apps/web: 214 passed, 3 skipped (12.4s)')
    expect(live.detail).not.toContain('RUN v3')
    // 9s since `item.started` (seq 2), 1s since the newest frame (seq 4).
    expect(live.itemMs).toBe(9_000)
    expect(live.silentMs).toBe(1_000)
    expect(live.tone).toBe('normal')
    expect(live.subagent).toBe(false)
  })

  it('a reasoning item still streaming reads Thinking, with the tail of its text', () => {
    const events = [
      line(1, 'item.started', { item: { kind: 'reasoning', id: 'item_2', text: '' } }),
      line(2, 'item.delta', { itemId: 'item_2', field: 'reasoning', delta: 'First I check the\nwire' }, 2_000),
    ]
    const live = status(events, T0 + 2_000)
    expect(live.headline).toBe('Thinking')
    expect(live.detail).toBe('wire')
  })

  it('an assistant message reads Writing, with the tail of its prose', () => {
    const events = [
      line(1, 'item.started', {
        item: { kind: 'message', id: 'item_3', role: 'assistant', text: 'Fixing it now.' },
      }),
    ]
    expect(status(events, T0).headline).toBe('Writing')
    expect(status(events, T0).detail).toBe('Fixing it now.')
  })

  it("a subagent's item is flagged, not hidden — real work, just not the main session's", () => {
    const events = [
      line(1, 'item.started', { item: tool({ id: 'parent', toolKind: 'task', title: 'Task: review' }) }),
      line(2, 'item.started', {
        item: tool({ id: 'child', parentItemId: 'parent', title: 'Read run-header.tsx' }),
      }),
    ]
    const live = status(events, T0)
    expect(live.subagent).toBe(true)
    expect(live.headline).toBe('Read run-header.tsx')
  })

  it('an empty stream degrades to a bare Working — no detail, no clocks, no throw', () => {
    expect(status([], T0)).toEqual({
      headline: 'Working',
      detail: undefined,
      itemMs: undefined,
      silentMs: 0,
      tone: 'normal',
      subagent: false,
    })
  })

  it('a thread whose only lines carry no item still reads Working', () => {
    const events = [line(1, 'note', { text: 'step started' }), line(2, 'lifecycle', { text: 'cloning' })]
    expect(status(events, T0).headline).toBe('Working')
    expect(status(events, T0).detail).toBeUndefined()
  })

  it('never throws on malformed frames (the reducer totality rule applies here too)', () => {
    const events = [
      line(1, 'item.started', { item: null }),
      line(2, 'item.started', { item: { kind: 'nope' } }),
      { seq: 3, type: 'item.started' } as unknown as RunEvent,
      line(4, 'item.delta', { itemId: 'ghost', field: 'output', delta: 'x' }),
    ]
    expect(() => status(events, T0)).not.toThrow()
    expect(status(events, T0).headline).toBe('Working')
  })

  it('a tool whose title never resolved falls back to Working rather than an empty headline', () => {
    const events = [line(1, 'item.started', { item: tool({ title: '   ' }) })]
    expect(status(events, T0).headline).toBe('Working')
  })
})

describe('liveStatus — silence is measured, never diagnosed', () => {
  const streamed = (): RunEvent[] => [
    line(1, 'item.started', { item: tool() }, 0),
    line(2, 'item.delta', { itemId: 'item_1', field: 'output', delta: 'compiling\n' }, 1_000),
  ]

  const toneAfter = (silentForMs: number, activity?: 'monitoring') =>
    status(streamed(), T0 + 1_000 + silentForMs, activity).tone

  it.each<[number, string]>([
    [0, 'normal'],
    [QUIET_MS - 1, 'normal'],
    [QUIET_MS, 'quiet'],
    [STALE_MS - 1, 'quiet'],
    [STALE_MS, 'stale'],
    [IDLE_TIMEOUT_MS, 'stale'],
  ])('silent for %d ms reads %s', (silentForMs, expected) => {
    expect(toneAfter(silentForMs)).toBe(expected)
  })

  it('a monitoring run stays normal at EVERY silence — it is quiet on purpose (#490)', () => {
    for (const silentForMs of [0, QUIET_MS, STALE_MS, IDLE_TIMEOUT_MS, 10 * IDLE_TIMEOUT_MS]) {
      expect(toneAfter(silentForMs, 'monitoring'), `${silentForMs}ms`).toBe('normal')
    }
  })

  it('clamps a future timestamp to 0 rather than reporting a negative silence', () => {
    // The server stamps `ts`; a browser clock a few seconds behind it must not print `-3s`.
    expect(status(streamed(), T0 - 5_000).silentMs).toBe(0)
    expect(status(streamed(), T0 - 5_000).itemMs).toBe(0)
  })

  it('the display thresholds stay well under the bound that actually ends a step', () => {
    // The UI warns long before anything is killed, and the tooltip names the real number so the
    // two clocks read as related rather than as two unexplained countdowns.
    expect(QUIET_MS).toBeLessThan(STALE_MS)
    expect(STALE_MS).toBeLessThan(IDLE_TIMEOUT_MS)
    expect(IDLE_TIMEOUT_MS).toBe(30 * 60_000)
  })
})

describe('lastEventAt', () => {
  it('takes the newest parseable ts, scanning from the end', () => {
    expect(lastEventAt([line(1, 'note', {}, 0), line(2, 'note', {}, 5_000)])).toBe(T0 + 5_000)
  })

  it('skips an unparseable timestamp rather than returning NaN', () => {
    const events = [line(1, 'note', {}, 3_000), { seq: 2, ts: 'not a date', type: 'note' } as RunEvent]
    expect(lastEventAt(events)).toBe(T0 + 3_000)
  })

  it('is undefined for an empty list', () => {
    expect(lastEventAt([])).toBeUndefined()
  })
})

describe('lastLine', () => {
  it('takes the last NON-EMPTY line, trimmed', () => {
    expect(lastLine('one\ntwo\n\n  \n')).toBe('two')
  })

  it('treats a carriage return as a break, so a progress bar shows its current frame', () => {
    expect(lastLine('[##   ] 30%\r[#####] 90%')).toBe('[#####] 90%')
  })

  it('strips ANSI so a cursor-control sequence is not mistaken for content', () => {
    const esc = String.fromCharCode(27)
    expect(lastLine(`${esc}[2K${esc}[32mPASS${esc}[0m src/a.test.ts`)).toBe('PASS src/a.test.ts')
  })

  it('clips a 4 000-character line to one bounded, ellipsised line', () => {
    const clipped = lastLine('x'.repeat(4_000))!
    expect(clipped.length).toBeLessThan(200)
    expect(clipped.endsWith('…')).toBe(true)
  })

  it.each([undefined, '', '   \n\n'])('has no detail for %j', (text) => {
    expect(lastLine(text)).toBeUndefined()
  })
})
