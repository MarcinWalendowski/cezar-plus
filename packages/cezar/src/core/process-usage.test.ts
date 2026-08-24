import { describe, expect, it } from 'vitest';

import {
  aggregateTreeUsage,
  attributeUsagePeaks,
  parsePsOutput,
  readCgroupPeaks,
  resolveRunCgroupDir,
} from './process-usage.ts';
import { RUNS_SLICE } from './broker-isolation.ts';

describe('parsePsOutput', () => {
  it('parses the unix `ps` shape (pid ppid rssKb cpu)', () => {
    const rows = parsePsOutput('  100   1  20480  3.5\n  101 100  10240  1.0\n');
    expect(rows).toEqual([
      { pid: 100, ppid: 1, rssKb: 20480, cpuPct: 3.5 },
      { pid: 101, ppid: 100, rssKb: 10240, cpuPct: 1.0 },
    ]);
  });

  it('parses the Windows PowerShell shape (pid ppid rssKb 0) — same columns, cpu 0', () => {
    // Get-CimInstance Win32_Process emits "PID PPID WorkingSetKB 0".
    const rows = parsePsOutput('4321 4000 51200 0\n4400 4321 12000 0\n');
    expect(rows.map((r) => [r.pid, r.ppid, r.rssKb])).toEqual([
      [4321, 4000, 51200],
      [4400, 4321, 12000],
    ]);
    expect(rows.every((r) => r.cpuPct === 0)).toBe(true);
  });

  it('skips malformed / truncated rows', () => {
    expect(parsePsOutput('garbage\n100 1\n200 1 4096 2.0')).toEqual([
      { pid: 200, ppid: 1, rssKb: 4096, cpuPct: 2.0 },
    ]);
  });
});

describe('aggregateTreeUsage', () => {
  const procs = parsePsOutput(
    ['500 1 100000 10', '501 500 50000 5', '502 501 25000 2', '900 1 999999 99'].join('\n'),
  );

  it('sums RSS over the whole descendant tree, in bytes', () => {
    const usage = aggregateTreeUsage(procs, 500);
    // (100000 + 50000 + 25000) KB * 1024
    expect(usage?.rssBytes).toBe(175000 * 1024);
    expect(usage?.procCount).toBe(3);
  });

  it('returns null when the root pid is gone (no data, not zero)', () => {
    expect(aggregateTreeUsage(procs, 12345)).toBeNull();
  });

  it('does not pull in unrelated trees', () => {
    // pid 900 (999999 KB) is a sibling under init, not under 500 — must not be counted.
    expect(aggregateTreeUsage(procs, 500)?.rssBytes).toBe(175000 * 1024);
  });
});

// Phase 0 of `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`: a run's own cgroup, preferred
// over summed `ps` RSS, on Linux. `platform`/`fs` are injected on every test below so the
// Linux-only path is exercised here on macOS too — never skipped, never assumed.

describe('resolveRunCgroupDir', () => {
  const scopePath = `/user.slice/user-994.slice/user@994.service/${RUNS_SLICE}/cezar-run-abc123.scope`;
  const fsWith = (contents: Record<string, string>) => ({
    readFileSync: (path: string): string => {
      const content = contents[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
  });

  it("resolves the run's own scope directory under /sys/fs/cgroup on Linux", () => {
    const fs = fsWith({ '/proc/500/cgroup': `0::${scopePath}\n` });
    expect(resolveRunCgroupDir(500, 'linux', fs)).toBe(`/sys/fs/cgroup${scopePath}`);
  });

  it('degrades to null on a non-Linux platform, even with a valid cgroup line — macOS has no cgroups', () => {
    const fs = fsWith({ '/proc/500/cgroup': `0::${scopePath}\n` });
    expect(resolveRunCgroupDir(500, 'darwin', fs)).toBeNull();
  });

  it('returns null when /proc/<pid>/cgroup cannot be read (process gone, or this platform has no /proc)', () => {
    expect(resolveRunCgroupDir(500, 'linux', fsWith({}))).toBeNull();
  });

  it('returns null when there is no unified-hierarchy (0::) line', () => {
    const fs = fsWith({ '/proc/500/cgroup': '12:pids:/some/v1/path\n1:name=systemd:/other\n' });
    expect(resolveRunCgroupDir(500, 'linux', fs)).toBeNull();
  });

  it("returns null for a cgroup that is not this run's own scope — delegated/none isolation leaves the pid in a shared cgroup", () => {
    const fs = fsWith({ '/proc/500/cgroup': '0::/system.slice/cezar.service\n' });
    expect(resolveRunCgroupDir(500, 'linux', fs)).toBeNull();
  });

  it('returns null for the slice itself with no .scope suffix — a slice is not one run', () => {
    const fs = fsWith({ '/proc/500/cgroup': `0::/${RUNS_SLICE}\n` });
    expect(resolveRunCgroupDir(500, 'linux', fs)).toBeNull();
  });
});

describe('readCgroupPeaks', () => {
  const dir = `/sys/fs/cgroup/${RUNS_SLICE}/cezar-run-abc123.scope`;
  const fsWith = (contents: Record<string, string>) => ({
    readFileSync: (path: string): string => {
      const content = contents[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
  });

  it('reads memory.peak and converts cpu.stat usage_usec to seconds', () => {
    const fs = fsWith({
      [`${dir}/memory.peak`]: '6442450944\n',
      [`${dir}/cpu.stat`]: 'usage_usec 125000000\nuser_usec 100000000\nsystem_usec 25000000\n',
    });
    expect(readCgroupPeaks(dir, fs)).toEqual({ peakMemoryBytes: 6442450944, cpuSeconds: 125 });
  });

  it('returns null when memory.peak is missing — an older kernel, or the controller not delegated', () => {
    const fs = fsWith({ [`${dir}/cpu.stat`]: 'usage_usec 1000000\n' });
    expect(readCgroupPeaks(dir, fs)).toBeNull();
  });

  it('returns null when cpu.stat is missing', () => {
    const fs = fsWith({ [`${dir}/memory.peak`]: '1000\n' });
    expect(readCgroupPeaks(dir, fs)).toBeNull();
  });

  it('returns null on malformed memory.peak content', () => {
    const fs = fsWith({
      [`${dir}/memory.peak`]: 'not-a-number\n',
      [`${dir}/cpu.stat`]: 'usage_usec 1000000\n',
    });
    expect(readCgroupPeaks(dir, fs)).toBeNull();
  });

  it('returns null when cpu.stat has no usage_usec line', () => {
    const fs = fsWith({
      [`${dir}/memory.peak`]: '1000\n',
      [`${dir}/cpu.stat`]: 'nr_periods 0\nnr_throttled 0\n',
    });
    expect(readCgroupPeaks(dir, fs)).toBeNull();
  });
});

describe('attributeUsagePeaks — the source claim itself, both directions', () => {
  const psPeaks = { peakRssBytes: 5_368_709_120, peakProcCount: 42, peakCpuPct: 310.5 };

  it('reports cgroup when a cgroup reading landed, keeping the ps figures alongside it', () => {
    const cgroup = { peakMemoryBytes: 6_442_450_944, cpuSeconds: 125 };
    expect(attributeUsagePeaks(psPeaks, cgroup)).toEqual({
      ...psPeaks,
      peakMemoryBytes: cgroup.peakMemoryBytes,
      cpuSeconds: cgroup.cpuSeconds,
      source: 'cgroup',
    });
  });

  // Negative control: a test that only checks the cgroup-present case above passes just as well
  // against code that always reports 'cgroup'. This asserts the process-tree case specifically —
  // with no cgroup readable, the source is 'process-tree', the ps numbers are the whole answer,
  // and no memory/cpu figures are invented in their place.
  it('reports process-tree when no cgroup reading ever landed, inventing no memory/cpu figures', () => {
    const result = attributeUsagePeaks(psPeaks, undefined);
    expect(result).toEqual({ ...psPeaks, source: 'process-tree' });
    expect(result.peakMemoryBytes).toBeUndefined();
    expect(result.cpuSeconds).toBeUndefined();
  });
});
