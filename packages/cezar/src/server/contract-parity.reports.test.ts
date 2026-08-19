import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  reportApproveResponseSchema,
  reportDetailResponseSchema,
  reportDismissResponseSchema,
  reportProcessPendingResponseSchema,
  reportReopenResponseSchema,
  reportsResponseSchema,
} from '@loki-labs/better-cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * `packages/contract/src/reports.ts` must describe EXACTLY what the REPORTS family
 * (`./workspace-reports-routes.ts`) sends — no wider, no narrower. Same guard and same reasoning as
 * `contract-parity.knowledge.test.ts`: each schema is checked against the ROUTE's own inferred
 * type, in BOTH directions, because one-way assignability stays green on real drift.
 *
 * Unlike the KNOWLEDGE family when it was a scaffold, every route here has a real success branch
 * from the start, so all six are asserted — there is no "the 200 does not exist yet" exemption to
 * claim.
 *
 * **The paths below are `api.v1.workspace.reports…` and that is load-bearing, not cosmetic**
 * (CHANGED 2026-08-19). This family moved from `/api/v1/reports` to `/api/v1/workspace/reports`,
 * and the old routes are DELETED rather than kept alongside — two surfaces over one triage store is
 * a second place to make the same decision. Because these are property lookups on the inferred
 * `AppType`, a route that failed to move would not merely mismatch: `api.v1.reports` would stop
 * existing and this file would fail to compile, which is the guard doing its job.
 *
 * Compile-time; `npm run typecheck` enforces it. The `it()` keeps the file visible as a test.
 */
describe('src/contract reports schemas match the routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  /** `true` only when the two types are assignable BOTH ways. */
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  type Assert<T extends true> = T;

  type Reports = typeof client.api.v1.workspace.reports;
  type Reports200 = InferResponseType<Reports['$get'], 200>;
  type ReportDetail200 = InferResponseType<Reports[':key']['$get'], 200>;
  type ReportApprove200 = InferResponseType<Reports[':key']['approve']['$post'], 200>;
  type ReportDismiss200 = InferResponseType<Reports[':key']['dismiss']['$post'], 200>;
  type ReportReopen200 = InferResponseType<Reports[':key']['reopen']['$post'], 200>;
  type ProcessPending200 = InferResponseType<Reports['process-pending']['$post'], 200>;

  type _Checks = [
    Assert<Exact<z.infer<typeof reportsResponseSchema>, Reports200>>,
    Assert<Exact<z.infer<typeof reportDetailResponseSchema>, ReportDetail200>>,
    Assert<Exact<z.infer<typeof reportApproveResponseSchema>, ReportApprove200>>,
    Assert<Exact<z.infer<typeof reportDismissResponseSchema>, ReportDismiss200>>,
    Assert<Exact<z.infer<typeof reportReopenResponseSchema>, ReportReopen200>>,
    Assert<Exact<z.infer<typeof reportProcessPendingResponseSchema>, ProcessPending200>>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    // Pins the comparator itself: a `Mutual` that degenerated to `true` would make every
    // assertion above vacuous, exactly the trap this file is meant to avoid.
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    const narrower: Mutual<{ a: string; b: number }, { a: string }> = 'route-is-wider';
    expect([wider, narrower]).toEqual(['schema-is-wider', 'route-is-wider']);
  });
});
