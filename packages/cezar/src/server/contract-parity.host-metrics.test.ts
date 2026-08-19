import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { hostMetricsResponseSchema } from '@loki-labs/better-cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * `hostMetricsResponseSchema` must describe EXACTLY what `GET /api/v1/host-metrics` sends — the
 * same both-directions discipline as `contract-parity.test.ts` (see its header for why one-way
 * assignability is not enough). Compile-time; `npm run typecheck` enforces it.
 */
describe('src/contract host-metrics schema matches the route exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  type Assert<T extends true> = T;

  type HostMetrics200 = InferResponseType<(typeof client.api.v1)['host-metrics']['$get'], 200>;

  type _Checks = [Assert<Exact<z.infer<typeof hostMetricsResponseSchema>, HostMetrics200>>];

  it('is enforced by tsc, not at runtime', () => {
    expect(true).toBe(true);
  });
});
