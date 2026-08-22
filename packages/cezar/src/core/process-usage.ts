/**
 * Live process telemetry for the Runs table (#348): while any run has a
 * registered backend process, ONE `ps` snapshot every ~2 s is aggregated per
 * run over the process's full descendant tree (the CLI plus every Bash child
 * an agent spawned) into `{ cpuPct, rssBytes, procCount }`.
 *
 * Design constraints, in order:
 *  - never affect a run — a missing/failing `ps` (Windows, exotic containers)
 *    degrades silently to "no data";
 *  - one shared sampler, not one per run — N parallel runs still cost a
 *    single `ps` every tick, and the timer is unref()ed and stopped the
 *    moment the registry empties, so an idle cockpit spawns nothing;
 *  - parsing + tree aggregation are pure functions, testable against canned
 *    `ps` output (scripts/test-process-usage.mjs).
 *
 * Phase 0 of `.ai/specs/2026-08-22-multi-node-cezar-cluster.md` adds a second measurement path:
 * on Linux, a run's own transient scope (`core/broker-isolation.ts`'s `RUNS_SLICE`) has a cgroup,
 * and `memory.peak` / `cpu.stat` read from it are the figures the host actually enforces against
 * — unlike the summed `ps` RSS above, which double-counts shared pages across the tree. Same
 * degrade-silently rule applies: a missing/unreadable cgroup file is normal (macOS has none at
 * all), never an error, and the fallback is the existing `ps` path, never a thrown run.
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { RUNS_SLICE } from './broker-isolation.ts';

/** One aggregated sample for a run's process tree. */
export interface ProcessUsage {
  /** Sum of `%cpu` across the tree — can exceed 100 on multi-core work. */
  cpuPct: number;
  /** Sum of resident set sizes, in bytes. */
  rssBytes: number;
  /** Number of live processes in the tree, the root included. */
  procCount: number;
}

/** One parsed `ps` row (`pid ppid rss %cpu`; rss is in KB, ps's unit). */
export interface ProcStat {
  pid: number;
  ppid: number;
  rssKb: number;
  cpuPct: number;
}

/**
 * Parse `ps -axo pid=,ppid=,rss=,%cpu=` output (the `=` suffixes suppress
 * headers on darwin and linux alike). Malformed lines are skipped — `ps`
 * racing process exits can truncate rows.
 */
export function parsePsOutput(text: string): ProcStat[] {
  const out: ProcStat[] = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const rssKb = Number(parts[2]);
    const cpuPct = Number(parts[3]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    out.push({
      pid,
      ppid,
      rssKb: Number.isFinite(rssKb) && rssKb > 0 ? rssKb : 0,
      cpuPct: Number.isFinite(cpuPct) && cpuPct > 0 ? cpuPct : 0,
    });
  }
  return out;
}

/**
 * Aggregate the full descendant tree rooted at `rootPid` from one `ps`
 * snapshot. Null when the root is gone (process exited between register and
 * sample) — callers treat that as "no data", not zero usage.
 */
export function aggregateTreeUsage(procs: ProcStat[], rootPid: number): ProcessUsage | null {
  const byPid = new Map<number, ProcStat>();
  const children = new Map<number, number[]>();
  for (const p of procs) {
    byPid.set(p.pid, p);
    const siblings = children.get(p.ppid);
    if (siblings) siblings.push(p.pid);
    else children.set(p.ppid, [p.pid]);
  }
  if (!byPid.has(rootPid)) return null;

  let cpuPct = 0;
  let rssKb = 0;
  let procCount = 0;
  const queue = [rootPid];
  const seen = new Set<number>(); // pid-reuse in a torn snapshot can't loop us
  while (queue.length > 0) {
    const pid = queue.pop() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const p = byPid.get(pid);
    if (!p) continue;
    cpuPct += p.cpuPct;
    rssKb += p.rssKb;
    procCount += 1;
    for (const child of children.get(pid) ?? []) queue.push(child);
  }
  return { cpuPct: Math.round(cpuPct * 10) / 10, rssBytes: rssKb * 1024, procCount };
}

// ---- cgroup peaks (Linux only; D14a's own scope) ---------------------------

/** Cgroup-sourced peaks for one run — `memory.peak` and `cpu.stat`'s `usage_usec`, converted. */
export interface CgroupPeaks {
  peakMemoryBytes: number;
  cpuSeconds: number;
}

/**
 * Attribution for a run's persisted usage figures: which measurement path produced them. A
 * `ps`-summed number and a cgroup `memory.peak` are not interchangeable — the caller (the node
 * health panel's `enforcement` field, spec D14a) must never mistake one for the other.
 *
 * `'none'` never appears inside a peaks object — `unregisterRunProcess` returns `undefined`
 * rather than a zero-filled one when no sample of any kind ever landed (the process died before
 * the first tick, or `ps` itself is unavailable). Absent means NOT MEASURED, never zero, the same
 * rule `RunRecord`'s own optional usage fields follow. The value exists in this union so a caller
 * that already has an `undefined` peaks result can name that state with the same vocabulary.
 */
export type UsageSource = 'cgroup' | 'process-tree' | 'none';

/** Minimal read surface the cgroup probes need — an inline interface, not `Pick<typeof
 *  readFileSync, …>`, because `readFileSync`'s overloads (Buffer vs string returns) do not
 *  structurally match a plain `(path, encoding) => string` test fixture. Mirrors
 *  `broker-isolation.ts`'s `{ existsSync, accessSync }` injection. */
interface CgroupFs {
  readFileSync(path: string, encoding: 'utf8'): string;
}

const nodeFs: CgroupFs = { readFileSync };

/**
 * Resolve `pid`'s own cgroup v2 directory under `/sys/fs/cgroup`, restricted to a run's own
 * transient scope (`RUNS_SLICE`, `core/broker-isolation.ts`) — never a shared or parent cgroup,
 * which would attribute other work's usage to this run. Null on any failure: non-Linux, `/proc`
 * unreadable (the process is gone, or this platform has no `/proc`), no unified-hierarchy (`0::`)
 * line, or a cgroup that is not this run's own scope (`delegated`/`none` isolation leaves a run in
 * a cgroup it does not own).
 *
 * `platform`/`fs` are injectable so the Linux-only path is exercised on every dev machine,
 * including the macOS box this was written on — mirrors `probeUserScope` in `broker-isolation.ts`.
 */
export function resolveRunCgroupDir(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  fs: CgroupFs = nodeFs,
): string | null {
  if (platform !== 'linux') return null;
  let text: string;
  try {
    text = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8');
  } catch {
    return null;
  }
  const line = text.split('\n').find((l) => l.startsWith('0::'));
  if (!line) return null;
  const cgroupPath = line.slice('0::'.length).trim();
  if (!cgroupPath.startsWith('/')) return null;
  if (!cgroupPath.includes(`/${RUNS_SLICE}/`) || !cgroupPath.endsWith('.scope')) return null;
  return `/sys/fs/cgroup${cgroupPath}`;
}

/**
 * Read `memory.peak` + `cpu.stat` from a resolved cgroup directory (`resolveRunCgroupDir`). Null
 * on any failure — a missing file (older kernel, controller not delegated), a permission error, or
 * malformed content are all "no data": never thrown, never a failed run.
 */
export function readCgroupPeaks(dir: string, fs: CgroupFs = nodeFs): CgroupPeaks | null {
  try {
    const peakMemoryBytes = Number(fs.readFileSync(`${dir}/memory.peak`, 'utf8').trim());
    if (!Number.isFinite(peakMemoryBytes)) return null;

    const statText = fs.readFileSync(`${dir}/cpu.stat`, 'utf8');
    const usageLine = statText.split('\n').find((l) => l.startsWith('usage_usec '));
    if (!usageLine) return null;
    const usageUsec = Number(usageLine.slice('usage_usec '.length).trim());
    if (!Number.isFinite(usageUsec)) return null;

    return { peakMemoryBytes, cpuSeconds: usageUsec / 1_000_000 };
  } catch {
    return null;
  }
}

// ---- registry + sampler -----------------------------------------------------

export const SAMPLE_INTERVAL_MS = 2_000;

interface Entry {
  pid: number;
  last?: ProcessUsage;
  peakRssBytes: number;
  peakProcCount: number;
  /** High-water mark of the `ps`-summed `cpuPct`, the same way `peakRssBytes` tracks
   *  `rssBytes` — sampled today, persisted by nobody until Phase 0 (`RunRecord.peakCpuPct`). */
  peakCpuPct: number;
  /** Resolved once per session and cached — `/proc/<pid>/cgroup` does not move for a scope's
   *  lifetime, so there is no reason to re-walk it every tick. Left unset (not `null`) on
   *  failure so a startup race (the scope not yet visible on the very first sample) retries
   *  rather than permanently falling back to `process-tree`. */
  cgroupDir?: string;
  /** Latest successful cgroup read. `memory.peak`/`cpu.stat`'s `usage_usec` are already
   *  cumulative high-water marks kept by the kernel, so the latest reading IS the peak —
   *  no max-of-samples needed, unlike the `ps`-derived fields above. */
  cgroup?: CgroupPeaks;
}

type UsageListener = (usage: Record<string, ProcessUsage>) => void;

const entries = new Map<string, Entry>();
const listeners = new Set<UsageListener>();
let timer: NodeJS.Timeout | null = null;
let sampling = false;

/** Start tracking a run's process tree. A re-register (a run's next agent
 *  step) replaces the pid but keeps nothing else — peaks are per session and
 *  the engine maxes them into the run record on unregister. */
export function registerRunProcess(runId: string, pid: number): void {
  entries.set(runId, { pid, peakRssBytes: 0, peakProcCount: 0, peakCpuPct: 0 });
  if (!timer) {
    timer = setInterval(() => void sample(), SAMPLE_INTERVAL_MS);
    timer.unref?.();
    void sample(); // first data point right away, not 2 s late
  }
}

/** One session's peaks, attributed to the path that produced them (Phase 0,
 *  `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`). `peakMemoryBytes`/`cpuSeconds` are
 *  present only when `source` is `'cgroup'` — see `UsageSource`'s docblock for why they are
 *  never backfilled from the `ps` figures when a cgroup is unavailable. */
export interface UsagePeaks {
  peakRssBytes: number;
  peakProcCount: number;
  peakCpuPct: number;
  peakMemoryBytes?: number;
  cpuSeconds?: number;
  source: Exclude<UsageSource, 'none'>;
}

/**
 * The attribution decision itself, pure: cgroup peaks win whenever a cgroup reading ever landed
 * for this session; the `ps`-derived figures are the whole answer when one never did. Exported
 * (alongside `resolveRunCgroupDir`/`readCgroupPeaks`) so this policy is unit-testable without
 * registering a real process or waiting on the sampler's 2 s timer — `unregisterRunProcess` is
 * the only caller in this file.
 */
export function attributeUsagePeaks(
  psPeaks: { peakRssBytes: number; peakProcCount: number; peakCpuPct: number },
  cgroup: CgroupPeaks | undefined,
): UsagePeaks {
  if (cgroup) {
    return {
      ...psPeaks,
      peakMemoryBytes: cgroup.peakMemoryBytes,
      cpuSeconds: cgroup.cpuSeconds,
      source: 'cgroup',
    };
  }
  return { ...psPeaks, source: 'process-tree' };
}

/** Stop tracking; returns the session's peaks (undefined when no sample ever
 *  landed — `ps` unavailable, or the process died before the first tick). */
export function unregisterRunProcess(runId: string): UsagePeaks | undefined {
  const entry = entries.get(runId);
  entries.delete(runId);
  if (entries.size === 0 && timer) {
    clearInterval(timer);
    timer = null;
  }
  if (!entry || entry.peakProcCount === 0) return undefined;
  return attributeUsagePeaks(
    { peakRssBytes: entry.peakRssBytes, peakProcCount: entry.peakProcCount, peakCpuPct: entry.peakCpuPct },
    entry.cgroup,
  );
}

/** Latest sample for one run, if any. */
export function currentUsage(runId: string): ProcessUsage | undefined {
  return entries.get(runId)?.last;
}

/** Latest samples for every registered run that has data. */
export function allUsage(): Record<string, ProcessUsage> {
  const out: Record<string, ProcessUsage> = {};
  for (const [runId, entry] of entries) {
    if (entry.last) out[runId] = entry.last;
  }
  return out;
}

/** Subscribe to fresh samples (fires ~every 2 s while runs are registered);
 *  returns the unsubscribe. The SSE endpoint relays these to the GUI. */
export function onUsage(listener: UsageListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test hook: fan one snapshot out to every subscriber without shelling `ps` —
 *  lets unit tests prove a dispose()d subscriber stops receiving ticks. */
export function emitUsageForTest(snapshot: Record<string, ProcessUsage>): void {
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {
      // mirror sample(): one broken listener never kills the fan-out
    }
  }
}

async function sample(): Promise<void> {
  if (sampling || entries.size === 0) return;
  sampling = true;
  try {
    const text = await runPs();
    if (text === null) return; // ps unavailable — degrade to no data
    const procs = parsePsOutput(text);
    for (const entry of entries.values()) {
      const usage = aggregateTreeUsage(procs, entry.pid);
      entry.last = usage ?? undefined;
      if (usage) {
        entry.peakRssBytes = Math.max(entry.peakRssBytes, usage.rssBytes);
        entry.peakProcCount = Math.max(entry.peakProcCount, usage.procCount);
        entry.peakCpuPct = Math.max(entry.peakCpuPct, usage.cpuPct);
      }
      // Cgroup path: no-op on macOS (probe fails once, cheaply) and on any run whose isolation
      // left it outside its own scope — see resolveRunCgroupDir's degrade rules.
      entry.cgroupDir ??= resolveRunCgroupDir(entry.pid) ?? undefined;
      if (entry.cgroupDir) {
        const cgroupPeaks = readCgroupPeaks(entry.cgroupDir);
        if (cgroupPeaks) entry.cgroup = cgroupPeaks;
      }
    }
    if (listeners.size > 0) {
      const snapshot = allUsage();
      for (const listener of listeners) {
        try {
          listener(snapshot);
        } catch {
          // a broken SSE stream must not kill the sampler
        }
      }
    }
  } finally {
    sampling = false;
  }
}

/** One system-wide snapshot in the `pid ppid rssKb cpu` shape `parsePsOutput` expects; null on
 *  any failure. Unix uses `ps`; Windows uses PowerShell's Win32_Process (WorkingSetSize → KB,
 *  cpu reported as 0 — the memory guard only needs RSS). */
function runPs(): Promise<string | null> {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $([math]::Round($_.WorkingSetSize/1024)) 0\" }",
        ],
        { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        (err, stdout) => resolve(err ? null : stdout),
      );
    });
  }
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,rss=,%cpu='],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}
