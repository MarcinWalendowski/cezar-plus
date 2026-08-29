import { postAnalyticsEvents } from '@/api/client'
import type { AnalyticsEvent } from '@loki-labs/better-cezar-api-client'

/**
 * The workspace analytics sink's ONE client entry point
 * (`.ai/specs/2026-08-29-filed-task-detail-page.md`): build the event, deliver it, forget it.
 *
 * **Fail-open and silent, on purpose.** No toast, no retry, no queue — an analytics failure must
 * never be a thing the user is told about, and must never block the render it describes. The
 * `noun.verb_past` grammar (`todo.detail_opened`) matches the run-scoped `type: 'metric'` events
 * `RunStore.appendEvent()` already writes; this is the companion for something that happened with
 * no run to belong to.
 */
export function trackEvent(name: AnalyticsEvent['name'], props: AnalyticsEvent['props']): void {
  void postAnalyticsEvents([{ name, props }]).catch(() => {})
}
