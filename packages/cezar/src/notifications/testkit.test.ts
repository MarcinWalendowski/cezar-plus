import { describe, expect, it } from 'vitest';
import type { Notification } from './types.ts';
import { createFakeClock, recordingTransport } from './testkit.ts';

/** W2.4 acceptance: "`testkit.ts` exports `recordingTransport()` with verdicts ok / retryable /
 *  hard-fail / hang plus a fake clock". */

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

describe('recordingTransport', () => {
  it('records every send() call it receives, in order', async () => {
    const transport = recordingTransport();
    const controller = new AbortController();
    await transport.send(notification({ runIds: ['run-1'] }), controller.signal);
    await transport.send(notification({ runIds: ['run-2'] }), controller.signal);
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]!.notification.runIds).toEqual(['run-1']);
    expect(transport.calls[1]!.notification.runIds).toEqual(['run-2']);
  });

  it('verdict "ok" succeeds', async () => {
    const transport = recordingTransport({ verdict: 'ok' });
    await expect(transport.send(notification(), new AbortController().signal)).resolves.toEqual({
      ok: true,
      durationMs: expect.any(Number),
    });
  });

  it('verdict "retryable" fails with retryable:true', async () => {
    const transport = recordingTransport({ verdict: 'retryable' });
    await expect(transport.send(notification(), new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      retryable: true,
    });
  });

  it('verdict "hard-fail" fails with retryable:false', async () => {
    const transport = recordingTransport({ verdict: 'hard-fail' });
    await expect(transport.send(notification(), new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      retryable: false,
    });
  });

  it('verdict "hang" never settles on its own, and rejects once the caller\'s signal aborts', async () => {
    const transport = recordingTransport({ verdict: 'hang' });
    const controller = new AbortController();
    let settled = false;
    const pending = transport.send(notification(), controller.signal).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    controller.abort(new Error('caller gave up'));
    await expect(pending).rejects.toThrow('caller gave up');
  });

  it('a function verdict is re-evaluated per call, letting a test model recovery over time', async () => {
    let calls = 0;
    const transport = recordingTransport({ verdict: () => (calls++ < 2 ? 'retryable' : 'ok') });
    const signal = new AbortController().signal;
    expect(await transport.send(notification(), signal)).toMatchObject({ ok: false });
    expect(await transport.send(notification(), signal)).toMatchObject({ ok: false });
    expect(await transport.send(notification(), signal)).toMatchObject({ ok: true });
  });

  it('healthcheck reflects the same verdict: ok/retryable read healthy, hard-fail/hang read unhealthy', async () => {
    await expect(recordingTransport({ verdict: 'ok' }).healthcheck(new AbortController().signal)).resolves.toMatchObject({ ok: true });
    await expect(recordingTransport({ verdict: 'retryable' }).healthcheck(new AbortController().signal)).resolves.toMatchObject({
      ok: true,
    });
    await expect(recordingTransport({ verdict: 'hard-fail' }).healthcheck(new AbortController().signal)).resolves.toMatchObject({
      ok: false,
    });
  });

  it('defaults to a stable id, "webhook" kind, and reasonable capabilities so a bare recordingTransport() satisfies NotificationTransport', () => {
    const transport = recordingTransport();
    expect(transport.kind).toBe('webhook');
    expect(typeof transport.id).toBe('string');
    expect(transport.capabilities.maxTitleChars).toBeGreaterThan(0);
  });

  it('an explicit id and capabilities override the defaults', () => {
    const transport = recordingTransport({ id: 'custom-id', capabilities: { maxTitleChars: 1, maxBodyChars: 1, links: 'none', markdown: false, batch: false, idempotencyKey: false } });
    expect(transport.id).toBe('custom-id');
    expect(transport.capabilities.maxTitleChars).toBe(1);
  });
});

describe('createFakeClock', () => {
  it('starts at the given initial value, defaulting to 0', () => {
    expect(createFakeClock().now()).toBe(0);
    expect(createFakeClock(1_000).now()).toBe(1_000);
  });

  it('advance() moves the clock forward (or backward) and returns the new time', () => {
    const clock = createFakeClock(100);
    expect(clock.advance(50)).toBe(150);
    expect(clock.now()).toBe(150);
    expect(clock.advance(-25)).toBe(125);
  });

  it('set() jumps to an absolute value', () => {
    const clock = createFakeClock(100);
    expect(clock.set(9_999)).toBe(9_999);
    expect(clock.now()).toBe(9_999);
  });

  it('feeds a transport\'s injected now(), so durationMs is measured off the injected clock rather than the real wall clock', async () => {
    // recordingTransport reads `now()` once at entry and once at exit; a verdict of 'ok' resolves
    // synchronously with no `await` between those two reads (there is no I/O to wait on), so this
    // advances the clock as a side effect of the FIRST read, simulating the elapsed work a real
    // transport's fetch would otherwise take real wall-clock time to do.
    const clock = createFakeClock(1_000);
    let reads = 0;
    const now = () => {
      const value = clock.now();
      if (reads++ === 0) clock.advance(42);
      return value;
    };
    const transport = recordingTransport({ now });
    const result = await transport.send(notification(), new AbortController().signal);
    expect(result).toMatchObject({ ok: true, durationMs: 42 });
  });
});
