import { describe, expect, it } from 'vitest';

import { detectedParallelism, halfParallelism, positiveIntEnvOr } from './search-parallelism.ts';

describe('detectedParallelism', () => {
  it('returns a positive integer', () => {
    const n = detectedParallelism();
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(1);
  });
});

describe('halfParallelism', () => {
  // The three core counts the spec itself measures (Problem §2a/§2b): the box and a CX43
  // worker are both 8 vCPU, the owner's Mac is 16 cores.
  it('halves an 8-vCPU box to 4', () => {
    expect(halfParallelism(8)).toBe(4);
  });

  it('halves a 16-core Mac to 8', () => {
    expect(halfParallelism(16)).toBe(8);
  });

  it('floors an odd core count rather than rounding up', () => {
    expect(halfParallelism(9)).toBe(4);
  });

  it('never returns less than 1, even on a single-core box', () => {
    expect(halfParallelism(1)).toBe(1);
  });

  it('floor(1/2) alone would be 0 — the floor(1) guard is load-bearing', () => {
    // Negative control: without `Math.max(1, ...)` this would be 0, which downstream callers
    // (vitest's maxWorkers, ripgrep's --threads) must never receive — 0 means "never runs",
    // not "unbounded".
    expect(halfParallelism(1)).not.toBe(0);
  });

  it('defaults to the detected core count when called with no argument', () => {
    expect(halfParallelism()).toBe(Math.max(1, Math.floor(detectedParallelism() / 2)));
  });
});

describe('positiveIntEnvOr', () => {
  it('uses the override when it is a positive integer string', () => {
    expect(positiveIntEnvOr('5', () => 999)).toBe(5);
  });

  it('floors a fractional override', () => {
    expect(positiveIntEnvOr('5.7', () => 999)).toBe(5);
  });

  it('falls back when undefined', () => {
    expect(positiveIntEnvOr(undefined, () => 3)).toBe(3);
  });

  it('falls back when empty or whitespace-only', () => {
    expect(positiveIntEnvOr('', () => 3)).toBe(3);
    expect(positiveIntEnvOr('   ', () => 3)).toBe(3);
  });

  it('falls back when not a number', () => {
    expect(positiveIntEnvOr('not-a-number', () => 3)).toBe(3);
  });

  it('falls back on 0 — a typo must not silently mean "never runs"', () => {
    expect(positiveIntEnvOr('0', () => 3)).toBe(3);
  });

  it('falls back on a negative value', () => {
    expect(positiveIntEnvOr('-2', () => 3)).toBe(3);
  });

  it('falls back on Infinity/NaN-shaped input', () => {
    expect(positiveIntEnvOr('Infinity', () => 3)).toBe(3);
    expect(positiveIntEnvOr('NaN', () => 3)).toBe(3);
  });
});
