# Host machine CPU% / memory% in the dashboard header

**Status:** implemented (QA needed — runtime E2E in the cockpit not yet run)
**Date:** 2026-08-19

## TLDR

Show the current whole-**host** CPU% and memory% in the Tasks overview header, polled
every few seconds from a new workspace-level `GET /api/v1/host-metrics` endpoint.

## Problem

The cockpit shows **per-run** process CPU/RSS (the `cpu`/`memory` run-table columns fed by
`core/process-usage.ts`), but nothing shows how loaded the underlying host is. On a shared
box (e.g. the Hetzner CX43 running `cockpit.example.com`) the owner wants an at-a-glance
read of host CPU and memory pressure while runs are executing.

This is host-level, not process-level: it answers "how hot is the machine", the sum across
every process, not just cezar's run trees.

## Solution

1. **Sampler** (`core/host-metrics.ts`): a shared, unref'd 2s timer computing host CPU% from
   `os.cpus()` idle/total deltas between ticks, and memory% from `MemAvailable` in
   `/proc/meminfo` on Linux (falls back to `os.freemem()` elsewhere — `freemem` counts
   reclaimable page cache as used and overstates pressure, so the Linux production host reads
   `MemAvailable`). CPU% is `null` until the first interval elapses.
2. **Endpoint** `GET /api/v1/host-metrics` — a new workspace-level Hono family, modelled on
   `healthRoutes`. Inherits the global `/api/v1` auth perimeter (NOT added to the health
   CORS/auth exemptions — it is not a public discovery route).
3. **Contract** `contract/src/host-metrics.ts` (zod schema + inferred type), barrelled in
   `index.ts`, checked by a `contract-parity.host-metrics.test.ts` mirroring the health one.
4. **Client** `getHostMetrics` fetcher + `useHostMetrics` React-Query hook polling every 3s
   (no event stream backs it, so the interval is the sole freshness mechanism).
5. **UI**: a compact `CpuIcon nn%  MemoryStickIcon nn%` stat in the sticky desktop overview
   header, before the search box.

## Data model / API contract

`GET /api/v1/host-metrics` → `HostMetricsResponse`:

```ts
{
  cpuPercent: number | null,   // 0–100, null until first sample interval elapses
  memoryPercent: number,       // 0–100
  cpuCount: number,            // logical CPUs
  memoryUsedBytes: number,
  memoryTotalBytes: number,
  sampledAt: number,           // epoch ms of this read
}
```

Additive, workspace-level. Does not touch the `/health` payload (a protected control surface —
`BACKWARD_COMPATIBILITY.md §2`; a diff there is a failure, not an update).

## Risks

- **`os.freemem` overstates usage on Linux.** Mitigated by reading `MemAvailable` on Linux.
- **CPU% needs two samples.** First read before the timer ticks returns `cpuPercent: null`;
  the UI renders `—` until the first real sample.
- **Shared-timer lifecycle.** Unref'd so it never holds the process open; started lazily on
  first read.

## Verification

- Unit: `core/host-metrics.test.ts` — CPU% delta math and Linux `MemAvailable` parse are pure
  and tested against canned snapshots.
- Contract: `contract-parity.host-metrics.test.ts` (tsc-enforced, both directions).
- Gates: `./tools/typecheck`, `./tools/lint`, `./tools/test`.
- E2E (QA needed): load the cockpit, confirm the header shows live CPU%/mem% and updates.
