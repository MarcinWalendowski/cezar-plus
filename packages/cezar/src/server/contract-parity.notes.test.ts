import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { noteResponseSchema, notesListResponseSchema } from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

/**
 * `src/contract/notes.ts` must describe EXACTLY what the NOTES family's routes
 * (`./notes-routes.ts`) send — no wider, no narrower. Same guard and reasoning as
 * `contract-parity.test.ts`.
 *
 * **Scoped to the two GET routes only, on purpose** — see `contract-parity.knowledge.test.ts` for
 * the full reasoning. `./notes-routes.ts` is an INERT scaffold
 * (`.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D19): every mutator (`POST /workspace/notes`,
 * `PATCH`/`DELETE /workspace/notes/:noteId`, `POST .../process`, `POST .../approve`,
 * `POST .../reject`) answers ONLY a 409 today, with no success branch yet for
 * `InferResponseType` to read. P2.3 adds those assertions alongside the real handlers.
 *
 * Compile-time; `npm run typecheck` enforces it. The `it()` keeps the file visible as a test.
 */
describe('src/contract notes schemas match the routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  /** `true` only when the two types are assignable BOTH ways. */
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  type Assert<T extends true> = T;

  type NotesList200 = InferResponseType<typeof client.api.v1.workspace.notes.$get, 200>;
  type Note200 = InferResponseType<(typeof client.api.v1.workspace.notes)[':noteId']['$get'], 200>;

  type _Checks = [
    Assert<Exact<z.infer<typeof notesListResponseSchema>, NotesList200>>,
    Assert<Exact<z.infer<typeof noteResponseSchema>, Note200>>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    // Pins the comparator itself: a `Mutual` that degenerated to `true` would make every
    // assertion above vacuous, exactly the trap this file is meant to avoid.
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    const narrower: Mutual<{ a: string; b: number }, { a: string }> = 'route-is-wider';
    expect([wider, narrower]).toEqual(['schema-is-wider', 'route-is-wider']);
  });
});
