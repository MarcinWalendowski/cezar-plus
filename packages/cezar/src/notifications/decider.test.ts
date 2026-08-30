import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notificationLogStatusSchema, transportHealthCountersSchema } from '@loki-labs/cezar-plus-contract';
import {
  EVENT_CATALOG,
  applyQuietHours,
  applyRateLimit,
  coalesce,
  createRateBucketState,
  decide,
  decideProviderAuthRequired,
  isQuietHours,
  mapRunTransition,
  type RunSnapshot,
} from './decider.ts';
import { NOTIFICATION_EVENTS, type Notification } from './types.ts';

const NOW = Date.parse('2026-08-06T12:00:00Z');
const BOOT_AT = NOW - 60_000; // well outside the default boot-grace window

function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: 'run-1',
    projectId: 'proj-1',
    title: 'Fix the thing',
    status: 'running',
    ...overrides,
  };
}

describe('notifications/decider: mapRunTransition (the one mapping table)', () => {
  it('first sight never notifies', () => {
    expect(mapRunTransition(undefined, run({ status: 'failed' }))).toBeNull();
  });

  it('an unchanged status never notifies', () => {
    expect(mapRunTransition('running', run({ status: 'running' }))).toBeNull();
    expect(mapRunTransition('failed', run({ status: 'failed' }))).toBeNull();
  });

  it('activity "monitoring" never notifies, ever — independent of which status it is paired with', () => {
    // A synthetic (today, unreachable) combination: proves the guard is an absolute rule, not
    // one that merely happens to agree with "running never notifies" by coincidence.
    // Negative control: with the `activity === 'monitoring'` clause removed, this exact input
    // (previous 'running', new 'waiting') maps to `run.needs-you` — see the assertion right
    // below it, which is identical apart from the missing `activity` field.
    expect(mapRunTransition('running', run({ status: 'waiting', activity: 'monitoring' }))).toBeNull();
    expect(mapRunTransition('running', run({ status: 'waiting' }))?.event).toBe('run.needs-you');
  });

  it('status -> failed with autoResumeAt yields run.usage-limit, never run.failed', () => {
    const mapped = mapRunTransition('running', run({ status: 'failed', autoResumeAt: '2026-08-06T18:00:00Z' }));
    expect(mapped).toEqual({ event: 'run.usage-limit', severity: 'info' });
  });

  it('negative control: status -> failed WITHOUT autoResumeAt yields run.failed, not run.usage-limit', () => {
    const mapped = mapRunTransition('running', run({ status: 'failed' }));
    expect(mapped).toEqual({ event: 'run.failed', severity: 'urgent' });
  });

  it('status -> waiting yields run.needs-you', () => {
    expect(mapRunTransition('running', run({ status: 'waiting' }))).toEqual({
      event: 'run.needs-you',
      severity: 'urgent',
    });
  });

  it('status -> review yields run.review', () => {
    expect(mapRunTransition('running', run({ status: 'review' }))).toEqual({
      event: 'run.review',
      severity: 'warn',
    });
  });

  it('status -> done yields run.finished', () => {
    expect(mapRunTransition('running', run({ status: 'done' }))).toEqual({
      event: 'run.finished',
      severity: 'info',
    });
  });

  it('status -> running, queued, and cancelled are deliberately not notify-worthy', () => {
    expect(mapRunTransition('queued', run({ status: 'running' }))).toBeNull();
    expect(mapRunTransition('done', run({ status: 'queued' }))).toBeNull();
    expect(mapRunTransition('running', run({ status: 'cancelled' }))).toBeNull();
  });

  it('the event enum contains no permission.* member', () => {
    expect(Object.keys(EVENT_CATALOG).some((event) => event.startsWith('permission.'))).toBe(false);
    expect(NOTIFICATION_EVENTS.every((event) => event in EVENT_CATALOG)).toBe(true);
  });
});

describe('notifications/decider: decide()', () => {
  it('boot grace records without sending: transitions inside the window produce nothing', () => {
    const previous = new Map([['run-1', 'running' as const]]);
    const notifications = decide(previous, [run({ status: 'failed' })], BOOT_AT + 1_000, { bootAt: BOOT_AT });
    expect(notifications).toEqual([]);
  });

  it('negative control: the identical transition just past the boot-grace window DOES send', () => {
    const previous = new Map([['run-1', 'running' as const]]);
    const notifications = decide(previous, [run({ status: 'failed' })], BOOT_AT + 10_001, { bootAt: BOOT_AT });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.event).toBe('run.failed');
  });

  it('no replay storm: 20 pre-existing runs across every status produce zero sends at boot', () => {
    const statuses = ['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled'] as const;
    const runs: RunSnapshot[] = Array.from({ length: 20 }, (_, i) =>
      run({ runId: `run-${i}`, status: statuses[i % statuses.length] }),
    );
    // First sight (empty previous map) at a boot-grace-cleared instant.
    const notifications = decide(new Map(), runs, BOOT_AT + 20_000, { bootAt: BOOT_AT });
    expect(notifications).toEqual([]);
  });

  it('run.needs-you carries the last ask text, and run.review carries the PR url', () => {
    const previous = new Map([
      ['run-1', 'running' as const],
      ['run-2', 'running' as const],
    ]);
    const runs = [
      run({ runId: 'run-1', status: 'waiting', askText: 'Which branch should I target?' }),
      run({ runId: 'run-2', status: 'review', pullRequestUrl: 'https://github.com/x/y/pull/1' }),
    ];
    const notifications = decide(previous, runs, NOW, { bootAt: BOOT_AT });
    expect(notifications.find((n) => n.event === 'run.needs-you')?.body).toBe('Which branch should I target?');
    const review = notifications.find((n) => n.event === 'run.review');
    expect(review?.body).toContain('https://github.com/x/y/pull/1');
    expect(review?.url).toBe('https://github.com/x/y/pull/1');
  });

  it('a current prose question outranks stale ask text in run.needs-you', () => {
    const previous = new Map([['run-1', 'running' as const]]);
    const [notification] = decide(previous, [run({
      status: 'waiting',
      askText: 'Which old option?',
      waitingReason: 'question',
      waitingQuestion: 'Merge and deploy, or hold?',
    })], NOW, { bootAt: BOOT_AT });
    expect(notification?.body).toBe('Merge and deploy, or hold?');
  });

  it('dedupe key is projectId:runId:event', () => {
    const previous = new Map([['run-1', 'running' as const]]);
    const [n] = decide(previous, [run({ status: 'failed' })], NOW, { bootAt: BOOT_AT });
    expect(n?.dedupeKey).toBe('proj-1:run-1:run.failed');
  });

  describe('queue.drained (Q8: derived, default off)', () => {
    it('stays silent when the active count never reaches zero', () => {
      const previous = new Map([
        ['run-1', 'queued' as const],
        ['run-2', 'running' as const],
      ]);
      const runs = [run({ runId: 'run-1', status: 'running' }), run({ runId: 'run-2', status: 'running' })];
      const notifications = decide(previous, runs, NOW, { bootAt: BOOT_AT, queueDrainedEnabled: true });
      expect(notifications.some((n) => n.event === 'queue.drained')).toBe(false);
    });

    it('fires on an active-count 1->0 transition where something finished in the window', () => {
      const previous = new Map([['run-1', 'running' as const]]);
      const runs = [run({ runId: 'run-1', status: 'done' })];
      const notifications = decide(previous, runs, NOW, { bootAt: BOOT_AT, queueDrainedEnabled: true });
      expect(notifications.some((n) => n.event === 'queue.drained' && n.projectId === 'proj-1')).toBe(true);
    });

    it('is silent by default even when the count reaches zero (opt-in per transport)', () => {
      const previous = new Map([['run-1', 'running' as const]]);
      const runs = [run({ runId: 'run-1', status: 'done' })];
      const notifications = decide(previous, runs, NOW, { bootAt: BOOT_AT }); // queueDrainedEnabled omitted
      expect(notifications.some((n) => n.event === 'queue.drained')).toBe(false);
    });

    it('is computed per project: one project draining does not fire for another still active', () => {
      const previous = new Map([
        ['run-1', 'running' as const],
        ['run-2', 'running' as const],
      ]);
      const runs = [
        run({ runId: 'run-1', projectId: 'proj-a', status: 'done' }),
        run({ runId: 'run-2', projectId: 'proj-b', status: 'running' }),
      ];
      const notifications = decide(previous, runs, NOW, { bootAt: BOOT_AT, queueDrainedEnabled: true });
      const drained = notifications.filter((n) => n.event === 'queue.drained');
      expect(drained).toHaveLength(1);
      expect(drained[0]?.projectId).toBe('proj-a');
    });
  });
});

describe('notifications/decider: decideProviderAuthRequired', () => {
  it('always fires, deep-linking to the failed provider, deduped on the same identity provider-auth-runtime.ts uses', () => {
    const n = decideProviderAuthRequired(
      { projectId: 'proj-1', provider: 'claude', authFailureId: 'auth-1' },
      NOW,
    );
    expect(n.event).toBe('provider.auth-required');
    expect(n.severity).toBe('urgent');
    expect(n.dedupeKey).toBe('proj-1:provider:claude:auth-1');
  });
});

describe('notifications/decider: coalesce()', () => {
  function notification(overrides: Partial<Notification> = {}): Notification {
    return {
      event: 'run.finished',
      severity: 'info',
      projectId: 'proj-1',
      runIds: ['r'],
      title: 'run',
      body: 'Finished.',
      dedupeKey: 'k',
      createdAt: new Date(NOW).toISOString(),
      ...overrides,
    };
  }

  it('merges 12 same-project, same-severity notifications into 5 named runs plus "and N more"', () => {
    const notifications = Array.from({ length: 12 }, (_, i) =>
      notification({ title: `run-${i}`, runIds: [`run-${i}`], dedupeKey: `k${i}` }),
    );
    const merged = coalesce(notifications);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.body).toBe('run-0, run-1, run-2, run-3, run-4 and 7 more');
    expect(merged[0]?.runIds).toHaveLength(12);
  });

  it('batches never mix projects', () => {
    const notifications = [
      notification({ projectId: 'proj-a', title: 'a1' }),
      notification({ projectId: 'proj-a', title: 'a2', dedupeKey: 'k2' }),
      notification({ projectId: 'proj-b', title: 'b1', dedupeKey: 'k3' }),
    ];
    const merged = coalesce(notifications);
    expect(merged).toHaveLength(2);
    expect(merged.map((n) => n.projectId).sort()).toEqual(['proj-a', 'proj-b']);
  });

  it('batches never mix severity classes, even within one project', () => {
    const notifications = [
      notification({ severity: 'urgent', title: 'u1' }),
      notification({ severity: 'urgent', title: 'u2', dedupeKey: 'k2' }),
      notification({ severity: 'info', title: 'i1', dedupeKey: 'k3' }),
    ];
    const merged = coalesce(notifications);
    expect(merged).toHaveLength(2);
  });

  it('leaves a single notification untouched', () => {
    const [n] = coalesce([notification()]);
    expect(n).toEqual(notification());
  });
});

describe('notifications/decider: quiet hours', () => {
  const window = { start: '22:00', end: '07:00' };

  it('passes only urgent, with allowUrgent true', () => {
    const gate = { quietHours: window, quietHoursAllowUrgent: true, now: Date.parse('2026-08-06T23:00:00Z') };
    const urgent: Notification = {
      event: 'run.failed',
      severity: 'urgent',
      projectId: 'p',
      runIds: [],
      title: 't',
      body: 'b',
      dedupeKey: 'k1',
      createdAt: new Date(gate.now).toISOString(),
    };
    const info: Notification = { ...urgent, severity: 'info', event: 'run.finished', dedupeKey: 'k2' };
    const { allowed, held } = applyQuietHours([urgent, info], gate);
    expect(allowed).toEqual([urgent]);
    expect(held).toEqual([info]);
  });

  it('holds urgent too when quietHoursAllowUrgent is false', () => {
    const gate = { quietHours: window, quietHoursAllowUrgent: false, now: Date.parse('2026-08-06T23:00:00Z') };
    const urgent: Notification = {
      event: 'run.failed',
      severity: 'urgent',
      projectId: 'p',
      runIds: [],
      title: 't',
      body: 'b',
      dedupeKey: 'k1',
      createdAt: new Date(gate.now).toISOString(),
    };
    expect(applyQuietHours([urgent], gate).held).toEqual([urgent]);
  });

  it('outside the window, everything passes regardless of severity', () => {
    const gate = { quietHours: window, quietHoursAllowUrgent: true, now: Date.parse('2026-08-06T12:00:00Z') };
    const info: Notification = {
      event: 'run.finished',
      severity: 'info',
      projectId: 'p',
      runIds: [],
      title: 't',
      body: 'b',
      dedupeKey: 'k1',
      createdAt: new Date(gate.now).toISOString(),
    };
    expect(applyQuietHours([info], gate).allowed).toEqual([info]);
  });

  it('wraps midnight correctly at the boundaries (22:00 inclusive, 07:00 exclusive)', () => {
    // Pinned to UTC explicitly: `window` carries no `timezone`, and this must stay correct
    // (and host-independent) regardless of which zone the machine running the suite defaults to.
    const utcWindow = { ...window, timezone: 'UTC' };
    expect(isQuietHours({ quietHours: utcWindow, now: Date.parse('2026-08-06T22:00:00Z') })).toBe(true);
    expect(isQuietHours({ quietHours: utcWindow, now: Date.parse('2026-08-06T21:59:00Z') })).toBe(false);
    expect(isQuietHours({ quietHours: utcWindow, now: Date.parse('2026-08-07T06:59:00Z') })).toBe(true);
    expect(isQuietHours({ quietHours: utcWindow, now: Date.parse('2026-08-07T07:00:00Z') })).toBe(false);
  });

  it('an absent timezone behaves identically to the host\'s own, explicitly named', () => {
    // Host-independent on purpose: whatever zone this happens to run in, omitting `timezone`
    // must agree with naming that same zone explicitly (the type's documented default).
    const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = Date.parse('2026-08-06T21:59:00Z');
    expect(isQuietHours({ quietHours: window, now })).toBe(isQuietHours({ quietHours: { ...window, timezone: hostZone }, now }));
  });

  it('DST: a 22:00-07:00 window does not become a 25-hour silence across the US fall-back transition', () => {
    // 2026-11-01 is when America/New_York falls back (clocks repeat 01:00-02:00 local).
    // Both instants below are 01:30 LOCAL time, one on each side of the transition — a fixed
    // UTC-offset implementation would misclassify one of them; the wall-clock read must not.
    const beforeFallback = Date.parse('2026-11-01T01:30:00-04:00'); // EDT, still quiet (01:30 < 07:00)
    const afterFallback = Date.parse('2026-11-01T01:30:00-05:00'); // EST, same local wall time
    const tz = 'America/New_York';
    expect(isQuietHours({ quietHours: { ...window, timezone: tz }, now: beforeFallback })).toBe(true);
    expect(isQuietHours({ quietHours: { ...window, timezone: tz }, now: afterFallback })).toBe(true);

    // And on ordinary (non-transition) days on each side, the local 07:00 boundary itself is
    // still exactly where the window ends — proving it stays 9 WALL-CLOCK hours regardless of
    // which absolute UTC offset is in effect that week.
    const sevenAmEdt = Date.parse('2026-10-30T07:00:00-04:00'); // EDT, before the transition
    const sevenAmEst = Date.parse('2026-11-02T07:00:00-05:00'); // EST, after the transition
    expect(isQuietHours({ quietHours: { ...window, timezone: tz }, now: sevenAmEdt })).toBe(false);
    expect(isQuietHours({ quietHours: { ...window, timezone: tz }, now: sevenAmEst })).toBe(false);
  });

  it('DST: the same window is correct across the US spring-forward transition', () => {
    // 2026-03-08 is when America/New_York springs forward (02:00 local jumps to 03:00).
    const beforeSpringForward = Date.parse('2026-03-01T06:30:00-05:00'); // EST, a week earlier, 06:30 local
    const afterSpringForward = Date.parse('2026-03-09T06:30:00-04:00'); // EDT, the day after, same local wall time
    const tz = 'America/New_York';
    expect(isQuietHours({ quietHours: { ...window, timezone: tz }, now: beforeSpringForward })).toBe(true);
    expect(isQuietHours({ quietHours: { ...window, timezone: tz }, now: afterSpringForward })).toBe(true);
  });

  it('a zero-length window (start === end) never blocks anything', () => {
    expect(isQuietHours({ quietHours: { start: '09:00', end: '09:00' }, now: Date.parse('2026-08-06T09:00:00Z') })).toBe(
      false,
    );
  });
});

describe('notifications/decider: rate limiting (token bucket)', () => {
  const rate = { perHour: 10, burst: 4, perMinute: 2 };

  function notification(i: number): Notification {
    return {
      event: 'run.finished',
      severity: 'info',
      projectId: 'p',
      runIds: [`r${i}`],
      title: `t${i}`,
      body: 'b',
      dedupeKey: `k${i}`,
      createdAt: new Date(NOW).toISOString(),
    };
  }

  it('admits up to burst, folding the rest into suppressedSinceRefill rather than dropping', () => {
    const notifications = Array.from({ length: 6 }, (_, i) => notification(i));
    const bucket = createRateBucketState(NOW);
    // Give the bucket its full burst by refilling from a state that already has tokens: seed via
    // a state whose refilledAt is far enough in the past that it has fully refilled to burst.
    const seeded = { ...bucket, tokens: rate.burst, refilledAt: NOW };
    const result = applyRateLimit(notifications, rate, NOW, seeded);
    expect(result.allowed).toHaveLength(2); // hard perMinute ceiling of 2, even though burst is 4
    expect(result.suppressed).toHaveLength(4);
    expect(result.bucket.suppressedSinceRefill).toBe(4);
    expect(result.summary).toBeUndefined(); // still over budget this round — no summary yet
  });

  it('emits exactly one "N suppressed" summary once the bucket has room and nothing new is suppressed', () => {
    const overBudget = { tokens: 0, refilledAt: NOW, suppressedSinceRefill: 5 };
    // An hour later the bucket has fully refilled (perHour: 10, burst: 4).
    const later = NOW + 60 * 60 * 1000;
    const result = applyRateLimit([], rate, later, overBudget);
    expect(result.suppressed).toHaveLength(0);
    expect(result.summary).toEqual({
      count: 5,
      title: '5 notifications suppressed',
      body: '5 notifications were held by the rate limit and are visible in the log.',
    });
    expect(result.bucket.suppressedSinceRefill).toBe(0); // the run closes out, doesn't accumulate forever
  });

  it('never emits a summary while nothing was ever suppressed', () => {
    const bucket = createRateBucketState(NOW);
    const result = applyRateLimit([], rate, NOW, bucket);
    expect(result.summary).toBeUndefined();
  });

  it('the perMinute ceiling applies even when tokens are available', () => {
    const notifications = Array.from({ length: 3 }, (_, i) => notification(i));
    const fullyStocked = { tokens: 100, refilledAt: NOW, suppressedSinceRefill: 0 };
    const result = applyRateLimit(notifications, { perHour: 1000, burst: 100, perMinute: 2 }, NOW, fullyStocked);
    expect(result.allowed).toHaveLength(2);
    expect(result.suppressed).toHaveLength(1);
  });
});

describe('notifications/decider: the one mapping table lives here (source-level guard)', () => {
  const RUN_STATUS_LITERALS = ['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled'];

  /**
   * The seven words MINUS the ones a different, contract-defined vocabulary this directory
   * legitimately owns also spells — derived from the contract, never hand-listed, so a word added
   * to either enum moves this set with it.
   *
   * Why the subtraction exists: `NotificationLogStatus`
   * (`reserved|sending|sent|failed|dropped` — the outbox ROW lifecycle) and the transport health
   * counters (`sent|failed|dropped|suppressed|...`) both spell `failed`, and no regex can tell
   * `row.status === 'failed'` (a log row) from `run.status === 'failed'` (a run) — only a type
   * checker can. Every occurrence this guard flagged in `outbox.ts`/`sender.ts` was one of those,
   * or a `` `failed` `` code span in a doc comment; not one was a RunStatus literal. Since the
   * counter key must be spelled somewhere under this directory and every file here is scanned,
   * a word-level rule over the full seven is not satisfiable by any correct implementation.
   *
   * The single-word blind spot this opens (a lone `=== 'failed'` against a RUN somewhere else in
   * this directory) is covered by the type-name leg below: a file cannot branch on a run's status
   * without getting that status from `RunStatus`/`RunSnapshot`/`RunRecord`.
   */
  const FOREIGN_VOCABULARY = new Set<string>([
    ...notificationLogStatusSchema.options,
    ...Object.keys(transportHealthCountersSchema.shape),
  ]);
  const SCANNED_LITERALS = RUN_STATUS_LITERALS.filter((word) => !FOREIGN_VOCABULARY.has(word));

  // A quote immediately followed by one of the scanned words and the SAME quote character right
  // after — precise enough not to flag "operation failed" or similar prose inside a longer
  // quoted string, only a bare RunStatus literal used as a value.
  const BARE_LITERAL_RE = new RegExp(`(['"\`])(${SCANNED_LITERALS.join('|')})\\1`);

  /** The run vocabulary cannot be branched on without being named. Catches the typed route into a
   *  second mapping table, including one that spells only a single status. */
  const RUN_TYPE_RE = /\b(RunStatus|RunSnapshot|RunRecord)\b/;

  const notificationsDir = dirname(fileURLToPath(import.meta.url));
  const EXEMPT_FILES = new Set(['decider.ts', 'decider.test.ts']);

  function listTsFiles(dir: string): string[] {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => join(entry.parentPath, entry.name));
  }

  /** Prose is not a mapping table: a doc comment explaining the outbox lifecycle writes
   *  `` `failed` `` in backticks, which is markdown, not a value. */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  it('no file other than decider.ts contains a bare RunStatus string literal', () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(notificationsDir)) {
      const base = file.split('/').pop() ?? file;
      if (EXEMPT_FILES.has(base)) continue;
      const code = stripComments(readFileSync(file, 'utf8'));
      if (BARE_LITERAL_RE.test(code)) offenders.push(base);
    }
    expect(offenders).toEqual([]);
  });

  it('no file other than decider.ts names RunStatus/RunSnapshot/RunRecord at all', () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(notificationsDir)) {
      const base = file.split('/').pop() ?? file;
      if (EXEMPT_FILES.has(base)) continue;
      const code = stripComments(readFileSync(file, 'utf8'));
      if (RUN_TYPE_RE.test(code)) offenders.push(base);
    }
    expect(offenders).toEqual([]);
  });

  it('negative control: the scan above actually catches a bare literal when one is present', () => {
    const poisoned = "export const x = status === 'waiting';";
    expect(BARE_LITERAL_RE.test(poisoned)).toBe(true);
    expect(BARE_LITERAL_RE.test("export const x = 'this operation waiting loudly';")).toBe(false);
    // The subtraction is real and bounded: exactly the words a contract-defined sibling enum in
    // this directory also owns are exempt, and nothing else is.
    expect(SCANNED_LITERALS).toEqual(['queued', 'running', 'waiting', 'review', 'done', 'cancelled']);
  });

  it('negative control: the type-name scan catches a run-typed import, and comment stripping does not blind either scan', () => {
    expect(RUN_TYPE_RE.test("import type { RunStatus } from '@loki-labs/cezar-plus-contract';")).toBe(true);
    expect(RUN_TYPE_RE.test('const x = 1;')).toBe(false);
    // Stripping removes comments only — code on the same line as a trailing comment survives.
    expect(stripComments("const s = 'waiting'; // a `waiting` run")).toContain("'waiting'");
    expect(stripComments('/** a `waiting` run */')).not.toContain('waiting');
    expect(stripComments("const url = 'https://x.invalid/a';")).toContain('https://x.invalid/a');
  });

  // Matches an actual import specifier (`import { wantsAttention } from '...'`, `import type
  // {...}`, multi-named), not a prose mention — `decider.ts`'s own header explains the rule by
  // naming the function, which must not itself trip the guard it documents.
  const WANTS_ATTENTION_IMPORT_RE = /import\s+[^;]*\bwantsAttention\b[^;]*\bfrom\b/;

  it('wantsAttention is imported nowhere under src/notifications/', () => {
    // Excludes this test file itself, which necessarily contains a synthetic import string in
    // its own negative control right below — every other file, including decider.ts, is in
    // scope and must genuinely have no such import.
    const offenders: string[] = [];
    for (const file of listTsFiles(notificationsDir)) {
      const base = file.split('/').pop() ?? file;
      if (base === 'decider.test.ts') continue;
      const content = readFileSync(file, 'utf8');
      if (WANTS_ATTENTION_IMPORT_RE.test(content)) offenders.push(base);
    }
    expect(offenders).toEqual([]);
  });

  it('negative control: the import scan above actually catches an import, and ignores a mere mention', () => {
    expect(WANTS_ATTENTION_IMPORT_RE.test("import { wantsAttention } from './attention.ts';")).toBe(true);
    expect(WANTS_ATTENTION_IMPORT_RE.test('// wantsAttention is never imported here')).toBe(false);
  });
});
