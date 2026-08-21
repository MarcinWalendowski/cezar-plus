import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_DRAIN_MS, DrainController, SSE_RELOAD_EVENT, WS_CLOSE_SERVICE_RESTART, resolveDrainMs } from './drain.ts';

/** P3 of `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`. */

describe('DrainController', () => {
  it('resolves immediately when nothing is in flight', async () => {
    const c = new DrainController();
    const report = await c.drain();
    expect(report).toMatchObject({ clean: true, outstanding: 0, streamsNotified: 0 });
    expect(c.isDraining()).toBe(true);
  });

  it('waits for an in-flight request and reports a clean drain', async () => {
    const c = new DrainController({ drainMs: 1_000 });
    const done = c.begin();
    expect(c.inFlightCount()).toBe(1);
    const draining = c.drain();
    done();
    await expect(draining).resolves.toMatchObject({ clean: true, outstanding: 0 });
  });

  it('gives up at the deadline and reports the request it could not wait for', async () => {
    vi.useFakeTimers();
    try {
      const c = new DrainController({ drainMs: 5_000 });
      c.begin(); // never completes — a wedged handler
      const draining = c.drain();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(draining).resolves.toMatchObject({ clean: false, outstanding: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes every live stream exactly once, before waiting', async () => {
    const order: string[] = [];
    const c = new DrainController({ drainMs: 1_000 });
    c.registerStream(() => order.push('stream-a'));
    c.registerStream(() => order.push('stream-b'));
    const done = c.begin();
    const draining = c.drain();
    // streams are closed synchronously at the top of drain(), before the in-flight wait resolves
    expect(order).toEqual(['stream-a', 'stream-b']);
    done();
    const report = await draining;
    expect(report.streamsNotified).toBe(2);
    expect(c.streamCount()).toBe(0);
  });

  it('a stream that throws on close does not abort the drain', async () => {
    const c = new DrainController();
    c.registerStream(() => {
      throw new Error('already gone');
    });
    const ok = vi.fn();
    c.registerStream(ok);
    await expect(c.drain()).resolves.toMatchObject({ clean: true, streamsNotified: 2 });
    expect(ok).toHaveBeenCalledOnce();
  });

  it('unregistering a stream stops it being closed', async () => {
    const c = new DrainController();
    const closed = vi.fn();
    const off = c.registerStream(closed);
    off();
    await c.drain();
    expect(closed).not.toHaveBeenCalled();
  });

  it('a double end() cannot drive the in-flight count negative', async () => {
    // The failure this guards: an error path and a `finally` both ending the same request would
    // make the counter negative, so a LATER request's completion could never bring it back to 0
    // -- or worse, the drain would call itself clean while a response was still being written.
    const c = new DrainController({ drainMs: 1_000 });
    const done = c.begin();
    done();
    done();
    expect(c.inFlightCount()).toBe(0);
    const second = c.begin();
    expect(c.inFlightCount()).toBe(1);
    const draining = c.drain();
    second();
    await expect(draining).resolves.toMatchObject({ clean: true, outstanding: 0 });
  });

  it('tracks concurrent requests and only settles when the last finishes', async () => {
    const c = new DrainController({ drainMs: 1_000 });
    const a = c.begin();
    const b = c.begin();
    const draining = c.drain();
    a();
    // still one outstanding -- must not have settled
    expect(c.inFlightCount()).toBe(1);
    b();
    await expect(draining).resolves.toMatchObject({ clean: true });
  });
});

describe('wire constants', () => {
  it('uses the close code that means "service restart", not a generic going-away', () => {
    // 1001 (going away) tells a client the peer is leaving; 1012 tells it to come back.
    expect(WS_CLOSE_SERVICE_RESTART).toBe(1012);
    expect(SSE_RELOAD_EVENT).toBe('reload');
  });
});

describe('resolveDrainMs', () => {
  it('defaults when unset', () => {
    expect(resolveDrainMs({})).toBe(DEFAULT_DRAIN_MS);
  });

  it('honours a valid override', () => {
    expect(resolveDrainMs({ CEZ_DRAIN_MS: '1200' })).toBe(1200);
    expect(resolveDrainMs({ CEZ_DRAIN_MS: '0' })).toBe(0);
  });

  it('falls back rather than becoming NaN or negative — the two silent ways to undo the drain', () => {
    expect(resolveDrainMs({ CEZ_DRAIN_MS: 'soon' })).toBe(DEFAULT_DRAIN_MS);
    expect(resolveDrainMs({ CEZ_DRAIN_MS: '-1' })).toBe(DEFAULT_DRAIN_MS);
    expect(resolveDrainMs({ CEZ_DRAIN_MS: '' })).toBe(DEFAULT_DRAIN_MS);
  });

  it('stays under the generated unit\'s TimeoutStopSec by default', () => {
    expect(DEFAULT_DRAIN_MS).toBeLessThan(30_000);
  });
});
