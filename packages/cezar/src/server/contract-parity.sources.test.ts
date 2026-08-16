import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  sourceCollectionsResponseSchema,
  sourceCommentsResponseSchema,
  sourceDocumentResponseSchema,
  sourceDocumentsResponseSchema,
  sourceLogResponseSchema,
  sourceProvidersResponseSchema,
  sourcesListResponseSchema,
} from '@loki-labs/better-cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * `src/contract/sources.ts` must describe EXACTLY what the SOURCES family's routes
 * (`./sources-routes.ts`) send — no wider, no narrower. Same guard and reasoning as
 * `contract-parity.test.ts`.
 *
 * **Scoped to the seven GET routes only, on purpose** — see `contract-parity.knowledge.test.ts`
 * for the full reasoning. `./sources-routes.ts` is an INERT scaffold
 * (`.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D19): every mutator (`POST /sources`,
 * `PUT /sources/:connectionId`, `DELETE /sources/:connectionId`, `POST .../sync`,
 * `POST .../adopt`, `POST .../resolve`) answers ONLY a 409 today, with no success branch yet for
 * `InferResponseType` to read. W4.6 adds those assertions alongside the real handlers.
 *
 * Compile-time; `npm run typecheck` enforces it. The `it()` keeps the file visible as a test.
 */
describe('src/contract sources schemas match the routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  /** `true` only when the two types are assignable BOTH ways. */
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  type Assert<T extends true> = T;

  type Sources200 = InferResponseType<typeof client.api.v1.sources.$get, 200>;
  type SourceProviders200 = InferResponseType<typeof client.api.v1.sources.providers.$get, 200>;
  type SourceCollections200 = InferResponseType<
    (typeof client.api.v1.sources)[':connectionId']['collections']['$get'],
    200
  >;
  type SourceDocuments200 = InferResponseType<
    (typeof client.api.v1.sources)[':connectionId']['documents']['$get'],
    200
  >;
  type SourceDocument200 = InferResponseType<
    (typeof client.api.v1.sources)[':connectionId']['documents'][':docId']['$get'],
    200
  >;
  type SourceComments200 = InferResponseType<
    (typeof client.api.v1.sources)[':connectionId']['comments']['$get'],
    200
  >;
  type SourceLog200 = InferResponseType<(typeof client.api.v1.sources)[':connectionId']['log']['$get'], 200>;

  type _Checks = [
    Assert<Exact<z.infer<typeof sourcesListResponseSchema>, Sources200>>,
    Assert<Exact<z.infer<typeof sourceProvidersResponseSchema>, SourceProviders200>>,
    Assert<Exact<z.infer<typeof sourceCollectionsResponseSchema>, SourceCollections200>>,
    Assert<Exact<z.infer<typeof sourceDocumentsResponseSchema>, SourceDocuments200>>,
    Assert<Exact<z.infer<typeof sourceDocumentResponseSchema>, SourceDocument200>>,
    Assert<Exact<z.infer<typeof sourceCommentsResponseSchema>, SourceComments200>>,
    Assert<Exact<z.infer<typeof sourceLogResponseSchema>, SourceLog200>>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    // Pins the comparator itself: a `Mutual` that degenerated to `true` would make every
    // assertion above vacuous, exactly the trap this file is meant to avoid.
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    const narrower: Mutual<{ a: string; b: number }, { a: string }> = 'route-is-wider';
    expect([wider, narrower]).toEqual(['schema-is-wider', 'route-is-wider']);
  });
});
