import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  knowledgeDocumentResponseSchema,
  knowledgeDocumentsResponseSchema,
  knowledgeProposalsResponseSchema,
  knowledgeResponseSchema,
  knowledgeSearchResponseSchema,
} from '@loki-labs/cezar-plus-contract';
import type { AppType } from './app-type.ts';

/**
 * `src/contract/knowledge.ts` must describe EXACTLY what the KNOWLEDGE family's routes
 * (`./knowledge-routes.ts`) send — no wider, no narrower. Same guard and same reasoning as
 * `contract-parity.test.ts`: each schema is checked against the ROUTE's own inferred type, in
 * BOTH directions, because one-way assignability is green on real drift.
 *
 * **Scoped to the four GET routes only, on purpose.** `./knowledge-routes.ts` is an INERT scaffold
 * (`.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D19): every mutator (`POST /knowledge`,
 * `PUT /knowledge/:id`, `DELETE /knowledge/:id`, `POST /knowledge/proposals/apply`,
 * `POST /knowledge/reindex`) answers ONLY a 409 today — there is no 201/200 success branch in the
 * handler yet, so `InferResponseType<route, 201>` has nothing to infer FROM. Asserting parity
 * against a response that does not exist would not catch drift; it would just be wrong. W4.1 adds
 * those five assertions in the same change that gives each mutator its real success branch.
 *
 * Compile-time; `npm run typecheck` enforces it. The `it()` keeps the file visible as a test.
 */
describe('src/contract knowledge schemas match the routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  /** `true` only when the two types are assignable BOTH ways. */
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  type Assert<T extends true> = T;

  type Knowledge200 = InferResponseType<typeof client.api.v1.knowledge.$get, 200>;
  type KnowledgeSearch200 = InferResponseType<typeof client.api.v1.knowledge.search.$get, 200>;
  type KnowledgeDocuments200 = InferResponseType<typeof client.api.v1.knowledge.documents.$get, 200>;
  type KnowledgeProposals200 = InferResponseType<typeof client.api.v1.knowledge.proposals.$get, 200>;
  type KnowledgeDocument200 = InferResponseType<(typeof client.api.v1.knowledge)[':id']['$get'], 200>;

  type _Checks = [
    Assert<Exact<z.infer<typeof knowledgeResponseSchema>, Knowledge200>>,
    Assert<Exact<z.infer<typeof knowledgeSearchResponseSchema>, KnowledgeSearch200>>,
    Assert<Exact<z.infer<typeof knowledgeDocumentsResponseSchema>, KnowledgeDocuments200>>,
    Assert<Exact<z.infer<typeof knowledgeProposalsResponseSchema>, KnowledgeProposals200>>,
    Assert<Exact<z.infer<typeof knowledgeDocumentResponseSchema>, KnowledgeDocument200>>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    // Pins the comparator itself: a `Mutual` that degenerated to `true` would make every
    // assertion above vacuous, exactly the trap this file is meant to avoid.
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    const narrower: Mutual<{ a: string; b: number }, { a: string }> = 'route-is-wider';
    expect([wider, narrower]).toEqual(['schema-is-wider', 'route-is-wider']);
  });
});
