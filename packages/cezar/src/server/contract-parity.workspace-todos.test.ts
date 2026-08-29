import type { InferRequestType, InferResponseType } from 'hono/client';
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

  /**
   * The QUERY side (2026-08-25-split-active-backlog-tables.md). `queryZodValidator` is middleware
   * precisely so the query shape reaches the route type — parsing inside the handler would leave
   * `hc` accepting anything (see `./validators.ts`). The cases below are the proof that it did.
   *
   * Note WHICH shape reaches `hc`: `queryZodValidator` publishes the schema's OUTPUT as the
   * request type (Hono declares the validator's request parameter as a conditional type, which is
   * not an inference site), so `limit` is a `number` here and the facets are arrays, even though
   * the wire carries strings. Pinned rather than worked around — the client builds the same shape
   * and `hc` stringifies on the way out.
   */
  type WorkspaceTodosRequest = InferRequestType<typeof client.api.v1.workspace.todos.$get>;

  it('every query key is optional — the legacy no-params call still type-checks', () => {
    const legacy: WorkspaceTodosRequest = { query: {} };
    expect(legacy.query).toEqual({});
  });

  it('the partitioned call type-checks, including repeated facets and a numeric limit', () => {
    const partitioned: WorkspaceTodosRequest = {
      query: {
        partition: 'active',
        sort: 'priority',
        dir: 'asc',
        view: 'active',
        limit: 20,
        status: ['todo', 'blocked'],
        priority: ['high'],
        q: 'needle',
      },
    };
    expect(partitioned.query.partition).toBe('active');
  });

  it('an unknown key and a bad enum value are both compile errors', () => {
    // @ts-expect-error `bogus` is not a query key this route publishes.
    const unknownKey: WorkspaceTodosRequest = { query: { bogus: '1' } };
    // @ts-expect-error `sideways` is not a direction.
    const badEnum: WorkspaceTodosRequest = { query: { dir: 'sideways' } };
    expect([unknownKey, badEnum]).toHaveLength(2);
  });

  it('is enforced by tsc, not at runtime', () => {
    // Pins the comparator itself: a `Mutual` that degenerated to `true` would make every
    // assertion above vacuous, exactly the trap this file is meant to avoid.
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    const narrower: Mutual<{ a: string; b: number }, { a: string }> = 'route-is-wider';
    expect([wider, narrower]).toEqual(['schema-is-wider', 'route-is-wider']);
  });
});
