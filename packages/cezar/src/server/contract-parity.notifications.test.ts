import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { notificationLogResponseSchema, notificationsResponseSchema } from '@loki-labs/better-cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * `src/contract/notifications.ts` must describe EXACTLY what the NOTIFICATIONS family's routes
 * (`./notifications-routes.ts`) send — no wider, no narrower. Same guard and reasoning as
 * `contract-parity.test.ts`.
 *
 * **Scoped to the two GET routes only, on purpose** — see `contract-parity.knowledge.test.ts` for
 * the full reasoning. `./notifications-routes.ts` is an INERT scaffold
 * (`.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D19): every mutator (`PUT /workspace/
 * notifications`, `POST`/`PUT`/`DELETE .../transports[/:id]`, `POST .../test`,
 * `POST .../log/:rowId/retry`) answers ONLY a 409 today, with no success branch yet for
 * `InferResponseType` to read. W4.7 adds those assertions alongside the real handlers.
 *
 * Compile-time; `npm run typecheck` enforces it. The `it()` keeps the file visible as a test.
 */
describe('src/contract notifications schemas match the routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  /** `true` only when the two types are assignable BOTH ways. */
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  type Assert<T extends true> = T;

  type Notifications200 = InferResponseType<typeof client.api.v1.workspace.notifications.$get, 200>;
  type NotificationsLog200 = InferResponseType<
    typeof client.api.v1.workspace.notifications.log.$get,
    200
  >;

  type _Checks = [
    Assert<Exact<z.infer<typeof notificationsResponseSchema>, Notifications200>>,
    Assert<Exact<z.infer<typeof notificationLogResponseSchema>, NotificationsLog200>>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    // Pins the comparator itself: a `Mutual` that degenerated to `true` would make every
    // assertion above vacuous, exactly the trap this file is meant to avoid.
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    const narrower: Mutual<{ a: string; b: number }, { a: string }> = 'route-is-wider';
    expect([wider, narrower]).toEqual(['schema-is-wider', 'route-is-wider']);
  });
});
