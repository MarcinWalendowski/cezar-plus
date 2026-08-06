import { afterEach, describe, expect, it, vi } from 'vitest';
import { DueScheduler } from './due-scheduler.ts';

afterEach(() => { vi.useRealTimers(); });

describe('DueScheduler', () => {
  it('arms no timer before start(), and none while the due set is empty', () => {
    const scheduler = new DueScheduler<{ id: string }>({ collectDue: () => [], run: async () => undefined });
    scheduler.schedule();
    expect(scheduler.hasTimer()).toBe(false);
    scheduler.start();
    scheduler.schedule();
    expect(scheduler.hasTimer()).toBe(false);
  });

  it('arms exactly one timer for the earliest of several due entries', () => {
    vi.useFakeTimers();
    const now = Date.now();
    const scheduler = new DueScheduler<{ id: string }>({
      collectDue: () => [
        { at: now + 5_000, value: { id: 'late' } },
        { at: now + 1_000, value: { id: 'earliest' } },
        { at: now + 9_000, value: { id: 'latest' } },
      ],
      run: async () => undefined,
      now: () => now,
    });
    scheduler.start();
    scheduler.schedule();
    expect(scheduler.hasTimer()).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('runs the earliest due entry and re-arms from a freshly recomputed due set', async () => {
    vi.useFakeTimers();
    const ran: string[] = [];
    let tick = 0;
    const scheduler = new DueScheduler<{ id: string }>({
      collectDue: () => {
        tick += 1;
        // First pass: one entry due now. After it runs, the due set is empty.
        return tick === 1 ? [{ at: Date.now(), value: { id: 'only' } }] : [];
      },
      run: async (value) => { ran.push(value.id); },
    });
    scheduler.start();
    scheduler.schedule();
    await vi.runAllTimersAsync();
    expect(ran).toEqual(['only']);
    expect(scheduler.hasTimer()).toBe(false);
  });

  it('swallows a run() rejection and still re-arms afterward', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const scheduler = new DueScheduler<{ id: string }>({
      collectDue: () => {
        calls += 1;
        return calls <= 2 ? [{ at: Date.now(), value: { id: 'x' } }] : [];
      },
      run: async () => { throw new Error('boom'); },
    });
    scheduler.start();
    scheduler.schedule();
    await vi.runAllTimersAsync();
    // Rejected once, re-armed, fired again, then the due set went empty.
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(scheduler.hasTimer()).toBe(false);
  });

  it('does not re-arm after stop(), even if stop() lands while run() is in flight', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = new DueScheduler<{ id: string }>({
      collectDue: () => [{ at: Date.now(), value: { id: 'x' } }],
      run: async () => { await inFlight; },
    });
    scheduler.start();
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(0); // fires the timer, run() is now in flight
    scheduler.stop();
    release!();
    await vi.advanceTimersByTimeAsync(0); // let the finally() callback run
    expect(scheduler.hasTimer()).toBe(false);
  });

  it('cancel() clears a pending timer without marking the scheduler stopped', () => {
    vi.useFakeTimers();
    const scheduler = new DueScheduler<{ id: string }>({
      collectDue: () => [{ at: Date.now() + 5_000, value: { id: 'x' } }],
      run: async () => undefined,
    });
    scheduler.start();
    scheduler.schedule();
    expect(scheduler.hasTimer()).toBe(true);
    scheduler.cancel();
    expect(scheduler.hasTimer()).toBe(false);
    // Not stopped: a later schedule() call still arms.
    scheduler.schedule();
    expect(scheduler.hasTimer()).toBe(true);
  });

  // Negative control: without start(), schedule() must be a no-op even with due entries
  // waiting. A version of schedule() that ignored `stopped` would pass every test above
  // (they all call start() first) and only this one would catch it.
  it('NEGATIVE CONTROL: schedule() is inert before start() even with due entries present', () => {
    vi.useFakeTimers();
    const scheduler = new DueScheduler<{ id: string }>({
      collectDue: () => [{ at: Date.now(), value: { id: 'x' } }],
      run: async () => undefined,
    });
    scheduler.schedule();
    expect(scheduler.hasTimer()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
