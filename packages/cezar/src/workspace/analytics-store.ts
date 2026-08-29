import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ANALYTICS_MAX_PROPS,
  ANALYTICS_MAX_PROP_VALUE,
  ANALYTICS_RETENTION_DAYS,
  type AnalyticsEvent,
} from '@loki-labs/better-cezar-contract';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from '../paths.ts';

/**
 * The product-usage sink behind `POST /api/v1/workspace/analytics`
 * (`.ai/specs/2026-08-25-split-active-backlog-tables.md`, D7).
 *
 * **One append-only NDJSON file per day**, under its own `~/.cezar/analytics/` directory rather
 * than a key in `config.json` — the reason `agent-accounts.json` states in
 * `BACKWARD_COMPATIBILITY.md` §9: a cezar that has never heard of this file does not open it, so
 * a downgrade cannot silently drop it. A daily file also makes the retention rule a `rm` of whole
 * files rather than a rewrite of one growing file.
 *
 * **Never throws into the request.** A sink whose failure can fail the page it measures is worse
 * than no sink; the route reports what was written and moves on.
 *
 * **Never blocks on a clock the caller controls.** The file name comes from the SERVER's day, not
 * from the event's own `ts` — a client with a wrong clock (or a deliberately crafted `ts`) must
 * not be able to write into a file the pruner has already passed.
 */

export function analyticsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(cezarHomeDir(env), 'analytics');
}

/** `YYYY-MM-DD` in UTC. UTC, not local, so a machine that moves timezone does not write two files
 *  for one day or reuse one file for two. */
export function analyticsDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function analyticsFilePath(at: Date, env: NodeJS.ProcessEnv = process.env): string {
  return join(analyticsDir(env), `${analyticsDayKey(at)}.ndjson`);
}

/** `CEZ_ANALYTICS=0` disables emission. Anything else — including unset — is on: an event that
 *  never fires on any real install is not shipped analytics. */
export function analyticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_ANALYTICS !== '0';
}

/**
 * Cap the props: at most {@link ANALYTICS_MAX_PROPS} keys, each value stringified and truncated to
 * {@link ANALYTICS_MAX_PROP_VALUE} characters.
 *
 * TRUNCATED, not rejected. A batch dropped because one label grew past the cap loses the other 49
 * events with it, and the cap exists to bound the file, not to police the caller.
 */
function boundProps(props: AnalyticsEvent['props']): Record<string, string | number | boolean> {
  const bounded: Record<string, string | number | boolean> = {};
  if (!props) return bounded;
  for (const [key, value] of Object.entries(props).slice(0, ANALYTICS_MAX_PROPS)) {
    bounded[key.slice(0, ANALYTICS_MAX_PROP_VALUE)] =
      typeof value === 'string' ? value.slice(0, ANALYTICS_MAX_PROP_VALUE) : value;
  }
  return bounded;
}

/** Drop day files older than {@link ANALYTICS_RETENTION_DAYS}. Best effort: a file that cannot be
 *  read or removed is skipped, never fatal. */
function prune(dir: string, now: Date): void {
  const cutoff = analyticsDayKey(new Date(now.getTime() - ANALYTICS_RETENTION_DAYS * 86_400_000));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const match = /^(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(name);
    if (!match || (match[1] as string) >= cutoff) continue;
    try {
      rmSync(join(dir, name));
    } catch {
      // A file another process holds open is not this request's problem.
    }
  }
}

/**
 * Append a batch. Returns how many events reached disk — `0` when analytics are off, when the
 * batch is empty, or when the write failed.
 *
 * `at` is injected so the route (and the tests) decide the day rather than this module reading a
 * clock it cannot be tested against.
 */
export function appendAnalyticsEvents(
  events: readonly AnalyticsEvent[],
  options: { at?: Date; env?: NodeJS.ProcessEnv } = {},
): number {
  const env = options.env ?? process.env;
  if (!analyticsEnabled(env) || events.length === 0) return 0;
  const at = options.at ?? new Date();
  const dir = analyticsDir(env);
  assertCezarHomeWriteIsSandboxed(dir, env);
  try {
    mkdirSync(dir, { recursive: true });
    const lines = events
      .map((event) => JSON.stringify({ event: event.event, ts: event.ts, props: boundProps(event.props) }))
      .join('\n');
    appendFileSync(join(dir, `${analyticsDayKey(at)}.ndjson`), `${lines}\n`, 'utf8');
  } catch {
    // The sink is best effort by design. A full disk must not fail the page it measures.
    return 0;
  }
  prune(dir, at);
  return events.length;
}

/** Whether a day file exists — for tests and for a future `cez analytics` reader. */
export function analyticsFileExists(at: Date, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return statSync(analyticsFilePath(at, env)).isFile();
  } catch {
    return false;
  }
}
