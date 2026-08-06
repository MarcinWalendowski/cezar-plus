import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationOutbox } from './outbox.ts';
import { NotificationSender, type NotificationSenderOptions } from './sender.ts';
import type { DeliveryResult, Notification } from './types.ts';

const dirs: string[] = [];
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-notify-sender-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  vi.useRealTimers();
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

const ok: DeliveryResult = { ok: true, durationMs: 1 };
function fail(overrides: Partial<Extract<DeliveryResult, { ok: false }>> = {}): DeliveryResult {
  return { ok: false, retryable: true, error: 'boom', durationMs: 1, ...overrides };
}

describe('NotificationSender: demand-driven timer', () => {
  it('holds no timer before start(), while idle, or once the outbox drains', async () => {
    vi.useFakeTimers();
    const dir = await directory();
    const outbox = NotificationOutbox.open(dir);
    const send = vi.fn(async (): Promise<DeliveryResult> => ok);
    const sender = new NotificationSender({ outbox, send });

    expect(sender.hasTimer()).toBe(false);
    sender.start();
    expect(sender.hasTimer()).toBe(false); // started, but nothing pending yet

    sender.reserve('acme', notification());
    expect(sender.hasTimer()).toBe(true);

    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(1);
    expect(sender.hasTimer()).toBe(false); // drained again

    // Negative control: a fixed setInterval-style timer would still report a handle here — the
    // assertion above only means something because the mechanism actually tears the timer down.
  });

  it('a collision (no new row) never arms a timer', async () => {
    vi.useFakeTimers();
    const dir = await directory();
    const outbox = NotificationOutbox.open(dir);
    const send = vi.fn(async (): Promise<DeliveryResult> => ok);
    const sender = new NotificationSender({ outbox, send });
    sender.start();
    sender.reserve('acme', notification());
    await vi.runAllTimersAsync();
    expect(sender.hasTimer()).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);

    sender.reserve('acme', notification()); // same dedupeKey — collision, no row created
    expect(sender.hasTimer()).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('NotificationSender: retry curve', () => {
  it('delays each retry by min(15min, 2000*2^(attempt-1)) times a seeded jitter factor', async () => {
    vi.useFakeTimers();
    const dir = await directory();
    const outbox = NotificationOutbox.open(dir);
    const at: number[] = [];
    const send = vi.fn(async (): Promise<DeliveryResult> => {
      at.push(Date.now());
      return fail();
    });
    // random() = 0.5 -> jitter factor (0.5 + 0.5) = 1.0, so delay == the base curve exactly.
    const sender = new NotificationSender({ outbox, send, random: () => 0.5 });
    sender.start();
    sender.reserve('acme', notification());

    await vi.advanceTimersByTimeAsync(0);
    expect(at).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(at).toHaveLength(1); // attempt 1 -> 2000ms, not due yet
    await vi.advanceTimersByTimeAsync(1);
    expect(at).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(3_999);
    expect(at).toHaveLength(2); // attempt 2 -> 4000ms
    await vi.advanceTimersByTimeAsync(1);
    expect(at).toHaveLength(3);
  });

  it('an injected retryAfterMs overrides the computed backoff delay', async () => {
    vi.useFakeTimers();
    const dir = await directory();
    const outbox = NotificationOutbox.open(dir);
    let call = 0;
    const at: number[] = [];
    const send = vi.fn(async (): Promise<DeliveryResult> => {
      call += 1;
      at.push(Date.now());
      return call === 1 ? fail({ retryAfterMs: 500 }) : ok;
    });
    // Without the override, random()=0 -> jitter factor 0.5 -> the computed delay would be 1000ms.
    const sender = new NotificationSender({ outbox, send, random: () => 0 });
    sender.start();
    sender.reserve('acme', notification());

    await vi.advanceTimersByTimeAsync(0);
    expect(at).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(at).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(at).toHaveLength(2);
  });

  it('exhausts at 6 attempts and marks the row permanently failed', async () => {
    vi.useFakeTimers();
    const dir = await directory();
    const outbox = NotificationOutbox.open(dir);
    const send = vi.fn(async (): Promise<DeliveryResult> => fail());
    const sender = new NotificationSender({ outbox, send, random: () => 0.5 });
    sender.start();
    sender.reserve('acme', notification());
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(6);
    const row = outbox.list({ transportId: 'acme' })[0];
    expect(row?.status).toBe('failed');
    expect(row?.attempts).toBe(6);
  });

  it('a non-retryable failure is not retried at all', async () => {
    vi.useFakeTimers();
    const dir = await directory();
    const outbox = NotificationOutbox.open(dir);
    const send = vi.fn(async (): Promise<DeliveryResult> => fail({ retryable: false, error: 'bad request' }));
    const sender = new NotificationSender({ outbox, send });
    sender.start();
    sender.reserve('acme', notification());
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(1);
    const row = outbox.list({ transportId: 'acme' })[0];
    expect(row?.status).toBe('failed');
    expect(row?.lastError).toBe('bad request');
  });
});

describe('NotificationSender: circuit breaker', () => {
  it('five consecutive failures flip the transport to degraded with a backoffUntil', async () => {
    vi.useFakeTimers();
    const dir = await directory();
    const outbox = NotificationOutbox.open(dir);
    const send = vi.fn(async (): Promise<DeliveryResult> => fail());
    const sender = new NotificationSender({ outbox, send, random: () => 0.5 });
    sender.start();
    sender.reserve('acme', notification());
    await vi.runAllTimersAsync();

    const health = sender.health('acme');
    expect(health.status).toBe('degraded');
    expect(health.consecutiveFailures).toBeGreaterThanOrEqual(5);
    expect(health.backoffUntil).toBeDefined();
  });

  it('a success resets consecutiveFailures, clears backoffUntil, and returns status to ok', async () => {
    vi.useFakeTimers();
    const dir = await directory();
    const outbox = NotificationOutbox.open(dir);
    let call = 0;
    const send = vi.fn(async (): Promise<DeliveryResult> => {
      call += 1;
      return call <= 4 ? fail() : ok;
    });
    const sender = new NotificationSender({ outbox, send, random: () => 0.5 });
    sender.start();
    sender.reserve('acme', notification());
    await vi.runAllTimersAsync();

    expect(send).toHaveBeenCalledTimes(5);
    const health = sender.health('acme');
    expect(health.status).toBe('ok');
    expect(health.consecutiveFailures).toBe(0);
    expect(health.backoffUntil).toBeUndefined();
    expect(health.lastSuccessAt).toBeDefined();
    expect(health.counters.sent).toBe(1);
  });
});

describe('NotificationSender: staleness ceiling', () => {
  it('a row older than maxAgeMs closes dropped:stale on its next consideration instead of being sent again', async () => {
    vi.useFakeTimers();
    const dir = await directory();
    const outbox = NotificationOutbox.open(dir);
    const send = vi.fn(async (): Promise<DeliveryResult> => fail());
    const sender = new NotificationSender({ outbox, send, maxAgeMs: 1_000, random: () => 0.5 });
    sender.start();
    sender.reserve('acme', notification());

    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1); // first attempt happens before it is stale

    // The retry was scheduled for +2000ms; maxAgeMs is 1000ms, so by the time it is next
    // considered the row is stale and must be dropped rather than sent again.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(send).toHaveBeenCalledTimes(1);
    const row = outbox.list({ transportId: 'acme' })[0];
    expect(row).toMatchObject({ status: 'dropped', droppedReason: 'stale' });
  });
});

describe('NotificationSender: a throwing send() cannot escape attempt()', () => {
  it('coerces a synchronous throw into a retryable failure and keeps the row alive', async () => {
    vi.useFakeTimers();
    const dir = await directory();
    const outbox = NotificationOutbox.open(dir);
    const send: NotificationSenderOptions['send'] = () => {
      throw new Error('boom');
    };
    const sender = new NotificationSender({ outbox, send, random: () => 0.5 });
    sender.start();
    expect(() => sender.reserve('acme', notification())).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    const row = outbox.list({ transportId: 'acme' })[0];
    expect(row?.status).toBe('reserved'); // scheduled for retry, not lost
    expect(row?.lastError).toContain('boom');
  });
});

describe('NotificationSender: cross-process lease', () => {
  it('the second instance gets no lease, never wakes, and never calls send', async () => {
    const dir = await directory();
    const outboxA = NotificationOutbox.open(dir);
    const outboxB = NotificationOutbox.open(dir);
    const sendA = vi.fn(async (): Promise<DeliveryResult> => ok);
    const sendB = vi.fn(async (): Promise<DeliveryResult> => ok);
    const senderA = new NotificationSender({ outbox: outboxA, send: sendA });
    const senderB = new NotificationSender({ outbox: outboxB, send: sendB, warn: () => {} });

    senderA.start();
    senderB.start();
    expect(senderB.hasTimer()).toBe(false);

    senderB.reserve('acme', notification());
    expect(senderB.hasTimer()).toBe(false);
    expect(sendB).not.toHaveBeenCalled();

    senderA.stop();
  });
});

describe('NotificationSender: at-most-once across a restart', () => {
  it('firing the same notification again after reopening still sends exactly once total', async () => {
    vi.useFakeTimers();
    const dir = await directory();
    const send = vi.fn(async (): Promise<DeliveryResult> => ok);

    const outbox1 = NotificationOutbox.open(dir);
    const sender1 = new NotificationSender({ outbox: outbox1, send });
    sender1.start();
    sender1.reserve('acme', notification());
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(1);
    sender1.stop();

    const outbox2 = NotificationOutbox.open(dir);
    const sender2 = new NotificationSender({ outbox: outbox2, send });
    sender2.start();
    sender2.reserve('acme', notification()); // identical dedupeKey — collision
    expect(sender2.hasTimer()).toBe(false);
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('NotificationSender: restart recovery', () => {
  it('start() requeues a row a previous process left stuck sending, and bumps its requeued counter', async () => {
    vi.useFakeTimers();
    const dir = await directory();
    const outbox = NotificationOutbox.open(dir);
    const row = outbox.reserve('acme', notification())!;
    outbox.markSending(row.rowId); // simulates the crash: never resolved

    vi.advanceTimersByTime(11 * 60_000); // the "next process" boots minutes later

    const send = vi.fn(async (): Promise<DeliveryResult> => ok);
    const reopened = NotificationOutbox.open(dir);
    const sender = new NotificationSender({ outbox: reopened, send });
    sender.start();
    await vi.runAllTimersAsync();

    expect(send).toHaveBeenCalledTimes(1);
    expect(sender.health('acme').counters.requeued).toBe(1);
  });
});
