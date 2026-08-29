import { z } from 'zod';

/**
 * `POST /api/v1/workspace/analytics` — the product-usage sink
 * (`.ai/specs/2026-08-25-split-active-backlog-tables.md`, D7).
 *
 * **There was nothing to extend.** A grep across `packages/web/src` for
 * `analytics|telemetry|posthog|logEvent|emitEvent` found nothing; the only precedent was
 * aspirational `TODO(analytics):` markers left in prose. So "analytics ship" could not mean "wire
 * into the existing sink" — it had to mean building the smallest honest one.
 *
 * **Local only, and on by default.** Events are appended to `~/.cezar/analytics/YYYY-MM-DD.ndjson`
 * on the user's own machine and never leave it, which is the same footing as `runs/<id>.ndjson`.
 * `CEZ_ANALYTICS=0` disables emission entirely, and the route then answers `202 {accepted: 0}`
 * without writing, so a disabled install is indistinguishable on the wire from a healthy one that
 * dropped a batch. Off-by-default was considered and rejected: an event that never fires on any
 * real install is not shipped analytics, it is a comment.
 *
 * **Bounded by construction**, so a bug in a call site cannot fill a disk or leak a task's text:
 * the name, the prop count, each value's length and the batch size are all capped below, and an
 * over-long value is TRUNCATED rather than rejected — dropping a batch because one label grew is
 * a worse failure than storing a shortened one.
 *
 * Workspace-level and single-mount, never mirrored under `/api/v1/p/:projectId`
 * (`BACKWARD_COMPATIBILITY.md` §2, the rule every workspace family follows).
 */

export const ANALYTICS_MAX_EVENTS_PER_BATCH = 50;
export const ANALYTICS_MAX_EVENT_NAME = 64;
export const ANALYTICS_MAX_PROPS = 12;
export const ANALYTICS_MAX_PROP_VALUE = 200;
/** Days a daily file survives. Pruned on write, so a cockpit that is never opened never grows. */
export const ANALYTICS_RETENTION_DAYS = 30;

/** A prop value. Never free-text task content: the three events this repo emits carry a
 *  partition, a column, a direction and row counts, and nothing that came from a todo. */
export const analyticsPropSchema = z.union([z.string(), z.number(), z.boolean()]);

export const analyticsEventSchema = z.object({
  event: z.string().min(1).max(ANALYTICS_MAX_EVENT_NAME),
  /** ISO 8601, stamped by the client so a batched flush does not collapse several actions onto
   *  one arrival time. */
  ts: z.string().min(1).max(64),
  props: z.record(z.string(), analyticsPropSchema).optional(),
});
export type AnalyticsEvent = z.infer<typeof analyticsEventSchema>;

export const analyticsIngestInputSchema = z.object({
  events: z.array(analyticsEventSchema).max(ANALYTICS_MAX_EVENTS_PER_BATCH),
});
export type AnalyticsIngestInput = z.infer<typeof analyticsIngestInputSchema>;

/** `202 {accepted}` — how many events were written. `0` with `CEZ_ANALYTICS=0`, and `0` for an
 *  empty batch. Never 404s, never 409s: a sink that rejects is a sink whose caller has to care. */
export const analyticsIngestResponseSchema = z.object({
  accepted: z.number().int(),
});
export type AnalyticsIngestResponse = z.infer<typeof analyticsIngestResponseSchema>;
