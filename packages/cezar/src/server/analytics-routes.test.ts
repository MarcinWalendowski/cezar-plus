import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAnalyticsRoutes } from './analytics-routes.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import type { ProjectApiEnv } from './server.ts';
import { analyticsFilePath } from '../workspace/analytics-store.ts';

/**
 * `POST /api/v1/workspace/analytics` (`.ai/specs/2026-08-25-split-active-backlog-tables.md`, D7).
 *
 * These run against the REAL store, in a pinned `CEZ_HOME`: the thing worth testing is that a
 * request produces a file with the right contents and that a disabled install produces none, and
 * an injected writer would prove neither.
 */

const savedHome = process.env.CEZ_HOME;
const savedFlag = process.env.CEZ_ANALYTICS;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cez-analytics-'));
  process.env.CEZ_HOME = home;
  delete process.env.CEZ_ANALYTICS;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.CEZ_HOME;
  else process.env.CEZ_HOME = savedHome;
  if (savedFlag === undefined) delete process.env.CEZ_ANALYTICS;
  else process.env.CEZ_ANALYTICS = savedFlag;
});

function app() {
  return new Hono<ProjectApiEnv>().route('/api/v1', createAnalyticsRoutes());
}

async function post(body: unknown, init: RequestInit = {}) {
  return apiRequest(app(), '/api/v1/workspace/analytics', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });
}

function todayLines(): string[] {
  const path = analyticsFilePath(new Date());
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
}

describe('POST /api/v1/workspace/analytics', () => {
  it('accepts a batch, answers 202 {accepted}, and writes one NDJSON line per event', async () => {
    const res = await post({
      events: [
        { event: 'filed_tasks.sorted', ts: '2026-08-25T10:00:00.000Z', props: { partition: 'active' } },
        { event: 'filed_tasks.show_more', ts: '2026-08-25T10:00:01.000Z', props: { from: 20, to: 30 } },
      ],
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 2 });
    const lines = todayLines();
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toEqual({
      event: 'filed_tasks.sorted',
      ts: '2026-08-25T10:00:00.000Z',
      props: { partition: 'active' },
    });
  });

  it('appends rather than replacing — a second batch joins the first', async () => {
    await post({ events: [{ event: 'a', ts: '2026-08-25T10:00:00.000Z' }] });
    await post({ events: [{ event: 'b', ts: '2026-08-25T10:00:01.000Z' }] });
    expect(todayLines().map((line) => (JSON.parse(line) as { event: string }).event)).toEqual(['a', 'b']);
  });

  it('CEZ_ANALYTICS=0 answers 202 {accepted: 0} and creates NO file at all', async () => {
    process.env.CEZ_ANALYTICS = '0';
    const res = await post({ events: [{ event: 'filed_tasks.sorted', ts: '2026-08-25T10:00:00.000Z' }] });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 0 });
    expect(existsSync(join(home, 'analytics'))).toBe(false);
    // Wire-indistinguishable from a healthy install that dropped a batch, which is the point: the
    // client has nothing to branch on and therefore nothing to leak about the setting.
  });

  it('an empty batch and a bodyless POST are both 202 {accepted: 0}, never 400', async () => {
    expect(await (await post({ events: [] })).json()).toEqual({ accepted: 0 });
    const bodyless = await apiRequest(app(), '/api/v1/workspace/analytics', { method: 'POST' });
    expect(bodyless.status).toBe(202);
    expect(await bodyless.json()).toEqual({ accepted: 0 });
  });

  it('caps the batch at 50 — a 51-event request is a 400 naming the field', async () => {
    const events = Array.from({ length: 51 }, (_, i) => ({ event: `e${i}`, ts: '2026-08-25T10:00:00.000Z' }));
    const res = await post({ events });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error).toContain('events');
    expect(todayLines()).toHaveLength(0);
    // …and exactly 50 is fine, so the bound is inclusive.
    expect(await (await post({ events: events.slice(0, 50) })).json()).toEqual({ accepted: 50 });
  });

  it('TRUNCATES an over-long prop value rather than 400ing the batch that carried it', async () => {
    const res = await post({
      events: [{ event: 'filed_tasks.sorted', ts: '2026-08-25T10:00:00.000Z', props: { note: 'x'.repeat(500) } }],
    });
    expect(res.status).toBe(202);
    const props = (JSON.parse(todayLines()[0] as string) as { props: { note: string } }).props;
    expect(props.note).toHaveLength(200);
  });

  it('keeps at most 12 props', async () => {
    const props: Record<string, number> = {};
    for (let i = 0; i < 20; i += 1) props[`k${i}`] = i;
    await post({ events: [{ event: 'wide', ts: '2026-08-25T10:00:00.000Z', props }] });
    const written = (JSON.parse(todayLines()[0] as string) as { props: Record<string, number> }).props;
    expect(Object.keys(written)).toHaveLength(12);
  });

  it('an event name over 64 characters is a 400 naming the field', async () => {
    const res = await post({ events: [{ event: 'x'.repeat(65), ts: '2026-08-25T10:00:00.000Z' }] });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('event');
  });
});
