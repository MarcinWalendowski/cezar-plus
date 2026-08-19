import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { cpuPercentBetween, parseMemAvailable, readCpuSnapshot } from './host-metrics.ts';

/** Build a minimal `os.CpuInfo` with the given times; only the fields we sum matter. */
function cpu(times: Partial<os.CpuInfo['times']>): os.CpuInfo {
  return {
    model: 'test',
    speed: 0,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0, ...times },
  };
}

describe('readCpuSnapshot', () => {
  it('sums idle and total across every core', () => {
    const snap = readCpuSnapshot([
      cpu({ user: 10, sys: 5, idle: 85 }),
      cpu({ user: 20, sys: 10, idle: 70 }),
    ]);
    expect(snap.idle).toBe(155);
    // (10+5+85) + (20+10+70) = 100 + 100
    expect(snap.total).toBe(200);
  });

  it('counts nice and irq toward total', () => {
    const snap = readCpuSnapshot([cpu({ user: 10, nice: 5, sys: 5, idle: 70, irq: 10 })]);
    expect(snap.total).toBe(100);
    expect(snap.idle).toBe(70);
  });
});

describe('cpuPercentBetween', () => {
  it('is the non-idle share of the elapsed window', () => {
    // 100 total ticks elapsed, 30 of them idle → 70% busy.
    expect(cpuPercentBetween({ idle: 100, total: 100 }, { idle: 130, total: 200 })).toBe(70);
  });

  it('is null when no time elapsed (nothing to diff yet)', () => {
    expect(cpuPercentBetween({ idle: 100, total: 200 }, { idle: 100, total: 200 })).toBeNull();
  });

  it('clamps a fully-idle window to 0', () => {
    expect(cpuPercentBetween({ idle: 0, total: 0 }, { idle: 100, total: 100 })).toBe(0);
  });

  it('clamps a fully-busy window to 100', () => {
    expect(cpuPercentBetween({ idle: 0, total: 0 }, { idle: 0, total: 100 })).toBe(100);
  });
});

describe('parseMemAvailable', () => {
  const meminfo = [
    'MemTotal:       16384000 kB',
    'MemFree:         1000000 kB',
    'MemAvailable:    8192000 kB',
    'Buffers:          200000 kB',
  ].join('\n');

  it('uses MemAvailable, not MemFree, for used bytes', () => {
    const parsed = parseMemAvailable(meminfo);
    expect(parsed).toEqual({
      totalBytes: 16384000 * 1024,
      usedBytes: (16384000 - 8192000) * 1024,
    });
  });

  it('returns null when a required field is missing', () => {
    expect(parseMemAvailable('MemTotal:  16384000 kB')).toBeNull();
    expect(parseMemAvailable('MemAvailable:  8192000 kB')).toBeNull();
  });
});
