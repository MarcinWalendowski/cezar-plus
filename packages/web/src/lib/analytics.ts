import { postAnalyticsEvents } from '@/api/client'

/**
 * Fire-and-forget analytics delivery (spec 2026-08-29-step-retry-timing §Analytics), the
 * browser's one caller of `postAnalyticsEvents`. Delegates and swallows the rejection — no
 * await for the caller to block on, no retry, no queue, no batching. One event on one deliberate
 * click needs none of those, and a queue would be state to get wrong.
 *
 * The mirror image of the route's own fail-open contract
 * (`workspace-analytics-routes.ts`): neither side may let analytics break the thing it measures.
 */
export function track(name: string, props: Record<string, string | number | boolean>): void {
  void postAnalyticsEvents([{ name, props }]).catch(() => {})
}
