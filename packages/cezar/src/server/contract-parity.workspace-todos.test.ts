import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { workspaceTodosResponseSchema } from '@loki-labs/better-cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * `src/contract/workspace-todos.ts` must describe EXACTLY what `GET /api/v1/workspace/todos`
 * (`./workspace-todos-routes.ts`) sends — no wider, no narrower. Same guard and reasoning as
 * `contract-parity.test.ts`; same shape as `contract-parity.workspace-runs.test.ts` for the
 * sibling read-only workspace family.
 *
 * This family is read-only (no mutator to check parity for), so there is exactly one route here.
 *
 * Compile-time; `npm run typecheck` enforces it. The `it()` keeps the file visible as a test.
 */
describe('src/contract workspace-todos schema matches the route exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  /** `true` only when the two types are assignable BOTH ways. */
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  type Assert<T extends true> = T;

  type WorkspaceTodos200 = InferResponseType<typeof client.api.v1.workspace.todos.$get, 200>;

  type _Checks = [Assert<Exact<z.infer<typeof workspaceTodosResponseSchema>, WorkspaceTodos200>>];

  it('is enforced by tsc, not at runtime', () => {
    // Pins the comparator itself: a `Mutual` that degenerated to `true` would make every
    // assertion above vacuous, exactly the trap this file is meant to avoid.
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    const narrower: Mutual<{ a: string; b: number }, { a: string }> = 'route-is-wider';
    expect([wider, narrower]).toEqual(['schema-is-wider', 'route-is-wider']);
  });
});
