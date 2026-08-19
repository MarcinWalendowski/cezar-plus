import { z } from 'zod';

/**
 * `GET /api/v1/host-metrics` — current whole-**host** resource pressure for the dashboard
 * header (spec `.ai/specs/2026-08-19-host-machine-usage-in-dashboard.md`).
 *
 * Host-level, not per-run: the sum across every process on the machine, unlike the per-run
 * process-tree telemetry the Runs table shows (`core/process-usage.ts`). Workspace-level —
 * one host serves every project.
 */
export const hostMetricsResponseSchema = z.object({
  /**
   * 0–100 CPU utilisation across all logical cores, averaged over the last sample interval.
   * `null` until the first interval has elapsed (CPU% is a delta between two `os.cpus()`
   * snapshots, so the very first read has nothing to diff against).
   */
  cpuPercent: z.number().nullable(),
  /** 0–100 memory in use (`MemAvailable` on Linux, else `os.freemem`). */
  memoryPercent: z.number(),
  /** Number of logical CPUs. */
  cpuCount: z.number(),
  memoryUsedBytes: z.number(),
  memoryTotalBytes: z.number(),
  /** Epoch ms this snapshot was read. */
  sampledAt: z.number(),
});
export type HostMetricsResponse = z.infer<typeof hostMetricsResponseSchema>;
