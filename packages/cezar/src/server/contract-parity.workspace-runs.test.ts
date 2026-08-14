import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { workspaceRunsResponseSchema } from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * `src/contract/workspace-runs.ts` must describe EXACTLY what `GET /api/v1/workspace/runs`
 * (`./workspace-runs-routes.ts`) sends — no wider, no narrower. Same guard and reasoning as
 * `contract-parity.test.ts`.
 *
 * This family is read-only (D19's 409 half was exercised by `contract-parity.notes.test.ts`,
 * removed with F3 feature B on 2026-08-14 — `.ai/specs/2026-08-14-remove-notes-capture-inbox.md`;
 * the knowledge, sources and notifications parity files still cover it), so there is exactly one
 * route to check, and it is already fully implemented in the
 * inert scaffold (a constant, schema-valid empty payload — `.ai/runs/2026-08-06-cezar-central-hub/
 * PLAN.md` D19). W4.10 replaces the constant with the real `WorkspaceRunIndex` read; this file
 * does not need to change when it does, since the response SHAPE stays the same.
 *
 * Compile-time; `npm run typecheck` enforces it. The `it()` keeps the file visible as a test.
 */
describe('src/contract workspace-runs schema matches the route exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  /** `true` only when the two types are assignable BOTH ways. */
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  type Assert<T extends true> = T;

  type WorkspaceRuns200 = InferResponseType<typeof client.api.v1.workspace.runs.$get, 200>;

  type _Checks = [Assert<Exact<z.infer<typeof workspaceRunsResponseSchema>, WorkspaceRuns200>>];

  it('is enforced by tsc, not at runtime', () => {
    // Pins the comparator itself: a `Mutual` that degenerated to `true` would make every
    // assertion above vacuous, exactly the trap this file is meant to avoid.
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    const narrower: Mutual<{ a: string; b: number }, { a: string }> = 'route-is-wider';
    expect([wider, narrower]).toEqual(['schema-is-wider', 'route-is-wider']);
  });
});
