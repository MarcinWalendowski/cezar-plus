import { z } from 'zod';

/**
 * `POST /api/v1/workspace/analytics/events` — the browser-reachable half of the workspace
 * analytics sink (`.ai/specs/2026-08-26-filed-task-detail-page.md`).
 *
 * A companion to the run-scoped `type: 'metric'` events `RunStore.appendEvent()` already writes
 * (`run.workflow.selected`, `run.step.stopped`, …): those describe something that happened
 * INSIDE a run, and this describes something that happened with NO run to belong to — opening a
 * filed task's detail page, before Start has ever been clicked. Same `noun.verb_past` grammar,
 * same lowercase dotted key.
 */

/** `noun.verb_past`, at least two dotted segments so a bare word can never land in the log.
 *  Bounded so a malformed client can never write an unbounded key. */
export const analyticsEventSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/),
  /** Flat, scalar-only, at most 16 keys, never free text, never a task summary — this file is
   *  written by a browser and read by a human, and an unbounded value is how a task's own body
   *  ends up in a log nobody meant to keep. */
  props: z
    .record(z.string().max(64), z.union([z.string().max(200), z.number(), z.boolean()]))
    .refine((p) => Object.keys(p).length <= 16, 'at most 16 props'),
});
export type AnalyticsEvent = z.infer<typeof analyticsEventSchema>;

export const analyticsEventsRequestSchema = z.object({
  events: z.array(analyticsEventSchema).min(1).max(20),
});
export type AnalyticsEventsRequest = z.infer<typeof analyticsEventsRequestSchema>;

/** The server stamps `ts` (ISO, server clock) and `v: 1` on each line itself — the client cannot
 *  set either. Not the wire response shape (that is {@link AnalyticsEventsResponse}); this is
 *  what one line of `<CEZ_HOME>/analytics/events.ndjson` actually holds. */
export const storedAnalyticsEventSchema = analyticsEventSchema.extend({
  ts: z.string(),
  v: z.literal(1),
});
export type StoredAnalyticsEvent = z.infer<typeof storedAnalyticsEventSchema>;

export const analyticsEventsResponseSchema = z.object({ accepted: z.number().int() });
export type AnalyticsEventsResponse = z.infer<typeof analyticsEventsResponseSchema>;
