import { Hono } from 'hono';
import {
  analyticsIngestInputSchema,
  type AnalyticsIngestResponse,
} from '@loki-labs/better-cezar-contract';
import type { ProjectApiEnv } from './server.ts';
import { jsonZodValidator } from './validators.ts';
import { appendAnalyticsEvents } from '../workspace/analytics-store.ts';

/**
 * `POST /api/v1/workspace/analytics` — the product-usage sink
 * (`.ai/specs/2026-08-25-split-active-backlog-tables.md`, D7). See
 * `../workspace/analytics-store.ts` for the file itself; this is only the route.
 *
 * **Workspace-level, single-mount**, never mirrored under `/api/v1/p/:projectId` — every
 * workspace family follows that rule (`BACKWARD_COMPATIBILITY.md` §2), and an event that named a
 * project would be measuring the wrong thing anyway: the surfaces this instruments are
 * cross-project boards.
 *
 * **Answers `202`, never 404, never 409.** A sink that can reject is a sink whose caller has to
 * care about the answer, and the client here deliberately does not — it drops a failed flush
 * silently rather than retrying into a page it must never block.
 *
 * `CEZ_ANALYTICS=0` is read PER REQUEST inside the store, not snapshotted at mount: the same
 * discipline the backup family follows, so toggling the variable does not need a restart to take
 * effect, and a disabled install answers `202 {accepted: 0}` — wire-indistinguishable from a
 * healthy one that dropped a batch.
 */

export interface AnalyticsRouteDeps {
  /** Test seam: the writer. Defaults to the real NDJSON append. */
  append?: (events: Parameters<typeof appendAnalyticsEvents>[0]) => number;
}

export function createAnalyticsRoutes(deps: AnalyticsRouteDeps = {}) {
  const append = deps.append ?? ((events) => appendAnalyticsEvents(events));

  return new Hono<ProjectApiEnv>().post(
    '/workspace/analytics',
    // `absent: { events: [] }` — a bodyless POST is an empty batch, not a 400. It costs nothing to
    // accept and means a client that flushed a race-emptied buffer does not surface an error to a
    // user who did nothing wrong.
    jsonZodValidator(analyticsIngestInputSchema, { absent: { events: [] } }),
    (c) => {
      const { events } = c.req.valid('json');
      const body: AnalyticsIngestResponse = { accepted: append(events) };
      return c.json(body, 202);
    },
  );
}
