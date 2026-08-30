import { Hono } from 'hono';
import {
  analyticsEventsRequestSchema,
  type AnalyticsEvent,
  type AnalyticsEventsResponse,
} from '@loki-labs/cezar-plus-contract';
import { jsonZodValidator } from './validators.ts';
import type { ProjectApiEnv } from './server.ts';
import { appendAnalyticsEvent } from '../workspace/analytics-log.ts';

export interface WorkspaceAnalyticsRouteDeps {
  /** Defaults to the real `appendAnalyticsEvent` (`../workspace/analytics-log.ts`). Injected so a
   *  test can prove the ROUTE swallows a sink failure — synchronous throw or rejection alike —
   *  independent of the real sink's own internal fail-open behaviour. */
  appendEvent?: (event: AnalyticsEvent) => Promise<void> | void;
}

/**
 * `POST /api/v1/workspace/analytics/events` — the browser-reachable half of the workspace
 * analytics sink (`.ai/specs/2026-08-26-filed-task-detail-page.md`), delivering
 * `todo.detail_opened` and any future workspace-scoped event to
 * `<CEZ_HOME>/analytics/events.ndjson`.
 *
 * **Workspace-level and single-mount**, never mirrored under `/api/v1/p/:projectId` — the rule
 * every sibling workspace family follows (`BACKWARD_COMPATIBILITY.md` §2). The project is a PROP
 * on the event, not a URL segment, because one sink serves the whole workspace.
 *
 * **202, not 200 or 204.** The handler validates, hands each event to the sink and returns; it
 * does not await the disk. 202 is the honest code for "accepted, not yet done", and it keeps the
 * client's fire-and-forget contract from depending on write latency. The sink call is wrapped —
 * synchronous throw and rejection both — so a broken sink can never turn an accepted request into
 * a failed one; a client must not have to care whether the operator kept the log.
 */
export function createWorkspaceAnalyticsRoutes(deps: WorkspaceAnalyticsRouteDeps = {}) {
  const appendEvent = deps.appendEvent ?? appendAnalyticsEvent;
  return new Hono<ProjectApiEnv>().post(
    '/workspace/analytics/events',
    jsonZodValidator(analyticsEventsRequestSchema),
    async (c) => {
      const body = c.req.valid('json');
      for (const event of body.events) {
        try {
          void Promise.resolve(appendEvent(event)).catch(() => {});
        } catch {
          // A synchronously-throwing sink is still not the request's problem.
        }
      }
      const response: AnalyticsEventsResponse = { accepted: body.events.length };
      return c.json(response, 202);
    },
  );
}
