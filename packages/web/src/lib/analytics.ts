import { postAnalytics } from '@/api/client'
import { ANALYTICS_MAX_EVENTS_PER_BATCH } from '@loki-labs/better-cezar-api-client'

/**
 * Product-usage events (`.ai/specs/2026-08-25-split-active-backlog-tables.md`, D7).
 *
 * **The first analytics in this cockpit.** A grep for `analytics|telemetry|posthog|logEvent|
 * emitEvent` across `packages/web/src` found nothing before this file, so there was no sink to
 * wire into and "analytics ship" had to mean building the smallest honest one.
 *
 * Three rules, and they are the whole design:
 *
 * 1. **It never blocks a render and never throws into a component.** `track()` appends to an
 *    in-memory buffer and returns; every path out of the flush is wrapped, and a failed POST is
 *    dropped rather than retried. A measurement that can break the page it measures is worse than
 *    no measurement.
 * 2. **At most one request in flight.** A burst of header clicks produces one batch, not one
 *    request per click, and a slow server cannot pile up connections behind a user who is just
 *    clicking.
 * 3. **Bounded in memory.** The buffer is capped; past the cap the OLDEST events are dropped,
 *    because a cockpit left open on a machine that cannot reach its own server must not grow an
 *    unbounded array. Newest-wins is the right side to keep: the recent events are the ones a
 *    reader is asking about.
 *
 * The sink is local (`~/.cezar/analytics/`) and nothing here leaves the machine — see
 * `BACKWARD_COMPATIBILITY.md` §9.
 */

export type AnalyticsProps = Record<string, string | number | boolean>

interface BufferedEvent {
  event: string
  ts: string
  props?: AnalyticsProps
}

/** Four batches' worth. Past this the buffer drops from the front. */
const MAX_BUFFERED = ANALYTICS_MAX_EVENTS_PER_BATCH * 4

let buffer: BufferedEvent[] = []
let scheduled = false
let inFlight = false

/** `requestIdleCallback` where it exists (every browser this cockpit targets except Safari), a
 *  macrotask otherwise. Never a microtask: the point is to land AFTER the render that caused it. */
function schedule(run: () => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => run(), { timeout: 2_000 })
    return
  }
  setTimeout(run, 0)
}

async function flush(): Promise<void> {
  scheduled = false
  if (inFlight || buffer.length === 0) return
  const batch = buffer.slice(0, ANALYTICS_MAX_EVENTS_PER_BATCH)
  buffer = buffer.slice(batch.length)
  inFlight = true
  try {
    await postAnalytics({ events: batch })
  } catch {
    // Dropped on purpose. The events are advisory; retrying them would mean holding a failed
    // batch across a page the user is still using, and the sink is already best-effort on the
    // server side too.
  } finally {
    inFlight = false
  }
  // Anything that arrived while the request was out goes in the next batch.
  if (buffer.length > 0) scheduleFlush()
}

function scheduleFlush(): void {
  if (scheduled) return
  scheduled = true
  schedule(() => {
    void flush()
  })
}

/**
 * Record one event. Fire-and-forget: it returns immediately, and nothing a caller does with the
 * return value can make a component wait on the sink.
 */
export function track(event: string, props?: AnalyticsProps): void {
  try {
    buffer.push({ event, ts: new Date().toISOString(), ...(props === undefined ? {} : { props }) })
    if (buffer.length > MAX_BUFFERED) buffer = buffer.slice(buffer.length - MAX_BUFFERED)
    scheduleFlush()
  } catch {
    // `track` is called from render effects. It must be impossible for it to throw upward.
  }
}

/** Test seam: drain and flush synchronously, so a test never has to await an idle callback. */
export async function __flushAnalyticsForTests(): Promise<void> {
  scheduled = false
  await flush()
}

/** Test seam: forget everything buffered, so one test's events cannot reach another's assertions. */
export function __resetAnalyticsForTests(): void {
  buffer = []
  scheduled = false
  inFlight = false
}
