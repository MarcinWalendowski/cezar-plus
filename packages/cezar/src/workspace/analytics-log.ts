import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AnalyticsEvent, StoredAnalyticsEvent } from '@loki-labs/cezar-plus-contract';
import { analyticsLogPath, assertCezarHomeWriteIsSandboxed } from '../paths.ts';

/**
 * `<CEZ_HOME>/analytics/events.ndjson` — the workspace-scoped analytics sink
 * (`.ai/specs/2026-08-26-filed-task-detail-page.md`). One NDJSON line per browser-emitted event, a
 * companion to the run-scoped `type: 'metric'` events `RunStore.appendEvent()` already writes:
 * those describe something that happened INSIDE a run; this describes something that happened
 * with no run to belong to (opening a filed task's detail page, before Start has ever been
 * clicked).
 *
 * Same shape as `cluster/oplog.ts`'s `appendOps`, the repo's existing NDJSON-append precedent:
 * append-only, `fs.appendFile` with `{mode: 0o600}` after `fs.mkdir(..., {recursive:true,
 * mode:0o700})`, fail-open (every error is caught, warned once through `console.warn` and
 * swallowed — a read-only home, a full disk, or an `EACCES` degrades analytics to nothing, never
 * fails the caller), no cross-process lease (a torn line costs one measurement and there is no
 * reader to corrupt, `oplog.ts:21-24`'s own trade for the same reason).
 */

/** ~30k events at ~160 bytes/line. One generation of rotation, so the ceiling is 2×MAX ≈ 10 MB,
 *  forever. No repo precedent for log rotation exists — every other NDJSON here is run-scoped and
 *  bounded by the run — so this scheme is stated in full rather than borrowed. */
export const ANALYTICS_LOG_MAX_BYTES = 5_000_000;

/** Serialized appends: one module-level promise chain, so concurrent requests in this process
 *  append in order and never interleave a partial line. The chain never rejects — `writeOne`
 *  swallows its own errors — so one dropped event never blocks the ones behind it. */
let queue: Promise<void> = Promise.resolve();

function reportDrop(path: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(
    `[cez] failed to write the analytics log ${path} — the event is dropped, analytics degrades to nothing (${message})`,
  );
}

function rotatedPath(path: string): string {
  return join(dirname(path), 'events.1.ndjson');
}

/** Rotate the current file to `events.1.ndjson` (replacing any previous generation) when it is
 *  at or over the size cap, BEFORE this append — so the line that trips the cap starts the next
 *  generation rather than landing in the one being rotated away. A missing file is not rotated;
 *  there is nothing to rotate. */
async function rotateIfNeeded(path: string): Promise<void> {
  let size: number;
  try {
    size = (await fs.stat(path)).size;
  } catch {
    return;
  }
  if (size < ANALYTICS_LOG_MAX_BYTES) return;
  await fs.rename(path, rotatedPath(path));
}

/** Only the EXACT string `'0'` turns the sink off — `CEZ_ANALYTICS=false`, `=off` and an empty
 *  `=` all leave it on, the same "exact value" discipline every other switch in
 *  `BACKWARD_COMPATIBILITY.md` §1 already uses. */
function isAnalyticsDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.CEZ_ANALYTICS === '0';
}

async function writeOne(event: AnalyticsEvent, env: NodeJS.ProcessEnv): Promise<void> {
  if (isAnalyticsDisabled(env)) return;
  const path = analyticsLogPath();
  try {
    // Sandbox-guarded like every other `CEZ_HOME` writer: under vitest with an unpinned `CEZ_HOME`
    // this throws, which the catch below turns into a warning instead of a write — so a leaked
    // test degrades to a dropped event rather than rewriting the developer's real `~/.cezar`.
    assertCezarHomeWriteIsSandboxed(path, env);
    await rotateIfNeeded(path);
    const stored: StoredAnalyticsEvent = { ...event, ts: new Date().toISOString(), v: 1 };
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await fs.appendFile(path, `${JSON.stringify(stored)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    reportDrop(path, err);
  }
}

/** Append one event. Never throws and never rejects — every failure is caught, warned and
 *  swallowed inside {@link writeOne}. Callers may await it (tests do, to observe the write) or
 *  fire-and-forget it (the route does, per its own 202-before-fsync contract). */
export function appendAnalyticsEvent(
  event: AnalyticsEvent,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  queue = queue.then(() => writeOne(event, env));
  return queue;
}
