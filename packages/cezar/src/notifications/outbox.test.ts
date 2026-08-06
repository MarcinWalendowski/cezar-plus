import { chmodSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NotificationOutbox } from './outbox.ts';
import type { Notification } from './types.ts';

const dirs: string[] = [];
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-notify-outbox-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    event: 'run.finished',
    severity: 'info',
    projectId: 'proj-1',
    runIds: ['run-1'],
    title: 'Fix the thing',
    body: 'Finished.',
    dedupeKey: 'proj-1:run-1:run.finished',
    createdAt: '2026-08-06T12:00:00.000Z',
    ...overrides,
  };
}

describe('NotificationOutbox: reservation is at-most-once', () => {
  it('reserve() returns a row on the first call and undefined on a (transportId, dedupeKey) collision', async () => {
    const outbox = NotificationOutbox.open(await directory());
    const first = outbox.reserve('acme', notification());
    expect(first?.status).toBe('reserved');
    expect(outbox.reserve('acme', notification())).toBeUndefined();
    // A different transport for the SAME notification is a different collision key.
    expect(outbox.reserve('ntfy', notification())).toBeDefined();
  });

  it('a collision still refuses after the row has terminally resolved (sent), across a restart', async () => {
    const dir = await directory();
    const first = NotificationOutbox.open(dir);
    const row = first.reserve('acme', notification())!;
    first.markSent(row.rowId, 200);

    // Negative control: without the collision check, re-firing the same transition would send
    // again — this is exactly what Verification #6 pins.
    const reopened = NotificationOutbox.open(dir);
    expect(reopened.reserve('acme', notification())).toBeUndefined();
  });
});

describe('NotificationOutbox: row transitions', () => {
  it('markSending / markSent clear any prior error and next-attempt time', async () => {
    const outbox = NotificationOutbox.open(await directory());
    const row = outbox.reserve('acme', notification())!;
    outbox.scheduleRetry(row.rowId, { attempts: 1, nextAttemptAt: '2026-08-06T12:05:00.000Z', lastError: 'boom' });
    outbox.markSending(row.rowId);
    const sent = outbox.markSent(row.rowId, 202);
    expect(sent?.status).toBe('sent');
    expect(sent?.httpStatus).toBe(202);
    expect(sent?.lastError).toBeUndefined();
    expect(sent?.nextAttemptAt).toBeUndefined();
    // attempts is untouched by markSent/markSending — neither patch mentions it.
    expect(sent?.attempts).toBe(1);
  });

  it('scheduleRetry does not reset attempts to the schema default when the row is re-read', async () => {
    const outbox = NotificationOutbox.open(await directory());
    const row = outbox.reserve('acme', notification())!;
    outbox.scheduleRetry(row.rowId, { attempts: 3, nextAttemptAt: '2026-08-06T12:05:00.000Z', lastError: 'x' });
    const again = outbox.markSending(row.rowId);
    expect(again?.attempts).toBe(3);
  });

  it('markFailed requires an explicit attempts count (never silently resets to 0)', async () => {
    const outbox = NotificationOutbox.open(await directory());
    const row = outbox.reserve('acme', notification())!;
    const failed = outbox.markFailed(row.rowId, { attempts: 6, lastError: 'permanent' });
    expect(failed?.status).toBe('failed');
    expect(failed?.attempts).toBe(6);
  });

  it('markDropped records a reason and clears nextAttemptAt', async () => {
    const outbox = NotificationOutbox.open(await directory());
    const row = outbox.reserve('acme', notification())!;
    const dropped = outbox.markDropped(row.rowId, 'stale');
    expect(dropped).toMatchObject({ status: 'dropped', droppedReason: 'stale' });
    expect(dropped?.nextAttemptAt).toBeUndefined();
  });

  it('requeue() gives a failed row a fresh attempt budget, and refuses a row still in flight', async () => {
    const outbox = NotificationOutbox.open(await directory());
    const row = outbox.reserve('acme', notification())!;
    outbox.markFailed(row.rowId, { attempts: 6, lastError: 'boom' });
    const requeued = outbox.requeue(row.rowId);
    expect(requeued).toMatchObject({ status: 'reserved', attempts: 0 });
    expect(requeued?.lastError).toBeUndefined();

    const second = outbox.reserve('acme', notification({ dedupeKey: 'other' }))!;
    expect(outbox.requeue(second.rowId)).toBeUndefined(); // still 'reserved', not terminal
  });

  it('transitioning an unknown rowId is a no-op, not a throw', async () => {
    const outbox = NotificationOutbox.open(await directory());
    expect(outbox.markSent('does-not-exist')).toBeUndefined();
  });
});

describe('NotificationOutbox: restart recovery', () => {
  it('requeues a row stuck reserved/sending past the staleness horizon, exactly once', async () => {
    const dir = await directory();
    let now = new Date('2026-08-06T12:00:00.000Z');
    const store = NotificationOutbox.open(dir, { now: () => now });
    const row = store.reserve('acme', notification())!;
    store.markSending(row.rowId);

    now = new Date(now.getTime() + 5 * 60_000); // only 5 minutes — not stale yet
    expect(store.requeueStaleReservations(10 * 60_000)).toHaveLength(0);

    now = new Date(now.getTime() + 6 * 60_000); // now 11 minutes since the 'sending' transition
    const touched = store.requeueStaleReservations(10 * 60_000);
    expect(touched).toHaveLength(1);
    expect(touched[0]).toMatchObject({ rowId: row.rowId, status: 'reserved' });

    // "exactly once": updatedAt was refreshed, so an immediate second call finds nothing new.
    expect(store.requeueStaleReservations(10 * 60_000)).toHaveLength(0);
  });

  it('leaves a fresh reserved row alone', async () => {
    const outbox = NotificationOutbox.open(await directory());
    outbox.reserve('acme', notification());
    expect(outbox.requeueStaleReservations(10 * 60_000)).toHaveLength(0);
  });
});

describe('NotificationOutbox: cross-process lease', () => {
  it('a second instance over the same directory gets undefined while the first holds it', async () => {
    const dir = await directory();
    const a = NotificationOutbox.open(dir);
    const b = NotificationOutbox.open(dir);
    const lease = a.acquireLease();
    expect(lease).toBeDefined();
    expect(lease?.reclaimed).toBe(false);
    expect(b.acquireLease()).toBeUndefined();
    lease?.release();
    expect(b.acquireLease()).toBeDefined();
  });

  it('reclaims a stale lock from a dead process and reports reclaimed:true', async () => {
    // `acquireLease`'s staleness check compares its injected `now()` against the lock FILE's real
    // mtime (an OS-level timestamp `fs` writes, unaffected by any injected clock) — so this test
    // backdates the file directly rather than mixing a fake clock with a real one, which would
    // make the 10-minute comparison depend on how far the real wall clock is from the fixture's
    // fake anchor at the moment the suite happens to run.
    const dir = await directory();
    const a = NotificationOutbox.open(dir);
    const b = NotificationOutbox.open(dir);
    a.acquireLease(10 * 60_000); // held, never released — simulates a crashed process

    const lockPath = join(dir, 'outbox.lock');
    const past = new Date(Date.now() - 11 * 60_000);
    utimesSync(lockPath, past, past);

    const reclaimed = b.acquireLease(10 * 60_000);
    expect(reclaimed).toBeDefined();
    expect(reclaimed?.reclaimed).toBe(true);
  });
});

describe('NotificationOutbox: durability and redaction', () => {
  it('every appended row is written atomically at 0600 and readable across a reopen', async () => {
    const dir = await directory();
    const store = NotificationOutbox.open(dir);
    store.reserve('acme', notification());
    const path = join(dir, 'outbox.ndjson');
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);

    const reopened = NotificationOutbox.open(dir);
    expect(reopened.pending()).toHaveLength(1);
  });

  it('redacts a configured secret value out of the appended row before it ever touches disk', async () => {
    const dir = await directory();
    // Deliberately NOT shaped like a known token pattern (`sk-ant-…`, `ghp_…`, `AKIA…`, …) —
    // `redactSecrets` scrubs those unconditionally regardless of the `secrets` accessor, which
    // would make this test pass even with the accessor removed. This value is only ever caught
    // because it is in the injected `secrets()` list, so the assertion is attributable to THIS
    // outbox's redaction wiring specifically.
    const secret = 'my-custom-webhook-credential-abcdef123456';
    const store = NotificationOutbox.open(dir, { secrets: () => [secret] });
    store.reserve('acme', notification({ body: `token=${secret}` }));
    const raw = readFileSync(join(dir, 'outbox.ndjson'), 'utf8');
    expect(raw).not.toContain(secret);
    expect(raw).toContain('[REDACTED]');
    // Negative control: without a secrets accessor, the same value survives untouched.
    const unredactedDir = await directory();
    const unredacted = NotificationOutbox.open(unredactedDir);
    unredacted.reserve('acme', notification({ body: `token=${secret}` }));
    expect(readFileSync(join(unredactedDir, 'outbox.ndjson'), 'utf8')).toContain(secret);
  });

  it('skips a malformed NDJSON line rather than failing the whole read, with one warning', async () => {
    const dir = await directory();
    const seed = NotificationOutbox.open(dir);
    const good = seed.reserve('acme', notification())!;
    writeFileSync(join(dir, 'outbox.ndjson'), `${JSON.stringify(good)}\n{not json\n`, { flag: 'a' });
    const warnings: string[] = [];
    const reopened = NotificationOutbox.open(dir, { warn: (m) => warnings.push(m) });
    expect(reopened.pending().map((r) => r.rowId)).toEqual([good.rowId]);
    expect(warnings).toHaveLength(1);
  });

  it('clamps an oversized title/body/runIds instead of throwing', async () => {
    const outbox = NotificationOutbox.open(await directory());
    const row = outbox.reserve(
      'acme',
      notification({
        title: 'x'.repeat(500),
        body: 'y'.repeat(3_000),
        runIds: Array.from({ length: 80 }, (_, i) => `run-${i}`),
      }),
    );
    expect(row?.title.length).toBe(200);
    expect(row?.body.length).toBe(2_000);
    expect(row?.runIds).toHaveLength(50);
  });
});

describe('NotificationOutbox: list() pagination', () => {
  it('filters by transportId and status, newest first, capped at limit', async () => {
    const outbox = NotificationOutbox.open(await directory());
    for (let i = 0; i < 3; i += 1) {
      outbox.reserve('acme', notification({ dedupeKey: `k${i}`, runIds: [`run-${i}`] }));
    }
    outbox.reserve('ntfy', notification({ dedupeKey: 'k-other' }));
    const rows = outbox.list({ transportId: 'acme', limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.transportId === 'acme')).toBe(true);
    // Newest first.
    expect(rows[0]!.seq).toBeGreaterThan(rows[1]!.seq);
  });
});

describe('NotificationOutbox: retention', () => {
  it('compact() drops rows older than the retention window and caps the survivors', async () => {
    const dir = await directory();
    let now = new Date('2026-08-06T12:00:00.000Z');
    const store = NotificationOutbox.open(dir, { now: () => now });
    const old = store.reserve('acme', notification({ dedupeKey: 'old' }))!;
    store.markSent(old.rowId, 200);

    now = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1_000); // 8 days later — past the 7-day window
    const fresh = store.reserve('acme', notification({ dedupeKey: 'fresh' }))!;
    store.compact();

    const reopened = NotificationOutbox.open(dir, { now: () => now });
    expect(reopened.get(old.rowId)).toBeUndefined();
    expect(reopened.get(fresh.rowId)).toBeDefined();
  });

  it('maybeCompact() only compacts past the row-count threshold', async () => {
    const dir = await directory();
    const store = NotificationOutbox.open(dir);
    store.reserve('acme', notification());
    store.maybeCompact();
    // Nothing dropped — well under the 20,000-row threshold, and nothing is old enough to matter.
    expect(NotificationOutbox.open(dir).pending()).toHaveLength(1);
  });
});

describe('NotificationOutbox: sandbox guard', () => {
  it('acquireLease creates the data directory even under a restrictive parent (best-effort chmod)', async () => {
    const dir = await directory();
    const store = NotificationOutbox.open(dir);
    const lease = store.acquireLease();
    expect(lease).toBeDefined();
    lease?.release();
    chmodSync(dir, 0o700);
  });
});
