/**
 * Whole-**host** CPU% / memory% for the dashboard header (spec
 * `.ai/specs/2026-08-19-host-machine-usage-in-dashboard.md`).
 *
 * Host-level, not per-run: this is the sum across every process on the machine, unlike the
 * per-run process-tree sampler in `process-usage.ts`.
 *
 * Design, mirroring `process-usage.ts`:
 *  - ONE shared, unref'd 2 s timer — an idle cockpit still costs nothing to keep the process
 *    alive, and N pollers still trigger a single measurement per tick;
 *  - CPU% is a delta between two `os.cpus()` snapshots, so it is `null` until the first
 *    interval elapses (a single snapshot cannot yield a rate);
 *  - the CPU delta math and the Linux `/proc/meminfo` parse are pure functions, tested against
 *    canned snapshots.
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';

const SAMPLE_INTERVAL_MS = 2_000;

/** Cumulative CPU time across all cores at one instant (ticks; the unit `os.cpus()` reports). */
export interface CpuSnapshot {
  idle: number;
  total: number;
}

/** Sum idle and total CPU time across every logical core. */
export function readCpuSnapshot(cpus: os.CpuInfo[] = os.cpus()): CpuSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

/**
 * CPU% busy over the window between two snapshots, or `null` when the window has no elapsed
 * total time (no diff yet, or the counters did not advance). Clamped to 0–100.
 */
export function cpuPercentBetween(prev: CpuSnapshot, cur: CpuSnapshot): number | null {
  const idleDelta = cur.idle - prev.idle;
  const totalDelta = cur.total - prev.total;
  if (totalDelta <= 0) return null;
  return clampPercent(100 * (1 - idleDelta / totalDelta));
}

/** Total/used memory in bytes. `MemAvailable` from `/proc/meminfo` on Linux — `os.freemem`
 *  counts reclaimable page cache as used and overstates pressure — else `os.freemem`. */
export function readMemory(): { totalBytes: number; usedBytes: number } {
  if (process.platform === 'linux') {
    try {
      const parsed = parseMemAvailable(readFileSync('/proc/meminfo', 'utf8'));
      if (parsed) return parsed;
    } catch {
      // /proc unreadable (exotic container) — fall through to os.freemem.
    }
  }
  const totalBytes = os.totalmem();
  return { totalBytes, usedBytes: totalBytes - os.freemem() };
}

/** Pull `MemTotal` and `MemAvailable` (both in kB) out of `/proc/meminfo` text. */
export function parseMemAvailable(meminfo: string): { totalBytes: number; usedBytes: number } | null {
  const totalKb = matchKb(meminfo, 'MemTotal');
  const availKb = matchKb(meminfo, 'MemAvailable');
  if (totalKb === null || availKb === null || totalKb <= 0) return null;
  const totalBytes = totalKb * 1024;
  return { totalBytes, usedBytes: Math.max(0, totalBytes - availKb * 1024) };
}

function matchKb(meminfo: string, key: string): number | null {
  const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm').exec(meminfo);
  return match ? Number(match[1]) : null;
}

function clampPercent(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

let prevSnapshot: CpuSnapshot | null = null;
let cpuPercent: number | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  const cur = readCpuSnapshot();
  if (prevSnapshot) cpuPercent = cpuPercentBetween(prevSnapshot, cur);
  prevSnapshot = cur;
}

function ensureSampler(): void {
  if (timer) return;
  prevSnapshot = readCpuSnapshot();
  timer = setInterval(tick, SAMPLE_INTERVAL_MS);
  timer.unref?.();
}

/** Current host metrics. Starts the shared sampler on first call. */
export function currentHostMetrics(): {
  cpuPercent: number | null;
  memoryPercent: number;
  cpuCount: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  sampledAt: number;
} {
  ensureSampler();
  const { totalBytes, usedBytes } = readMemory();
  const memoryPercent = totalBytes > 0 ? clampPercent(100 * (usedBytes / totalBytes)) : 0;
  return {
    cpuPercent,
    memoryPercent,
    cpuCount: os.cpus().length,
    memoryUsedBytes: usedBytes,
    memoryTotalBytes: totalBytes,
    sampledAt: Date.now(),
  };
}
