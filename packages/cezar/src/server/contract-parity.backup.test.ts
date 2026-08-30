import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  backupOverviewResponseSchema,
  backupSnapshotsResponseSchema,
} from '@loki-labs/cezar-plus-contract';
import type { AppType } from './app-type.ts';

/**
 * `src/contract/backup.ts` must describe EXACTLY what the backup GETs send — no wider, no
 * narrower. Same guard and reasoning as `contract-parity.workspace-todos.test.ts`.
 *
 * Only the two GETs are asserted: they have a real `200` branch (the scaffold answers the
 * schema-valid empty payload). The mutators answer `409` only until the engine lands (Phases 5–6),
 * so they have no `200` type to infer from yet — asserting them now would be vacuous. Their
 * response schemas (`backupRunResponseSchema`, etc.) are added to this file when their handlers
 * gain a success branch — the `contract-parity.knowledge.test.ts` precedent.
 *
 * Compile-time; `npm run typecheck` enforces it. The `it()` keeps the file visible as a test.
 */
describe('src/contract backup schemas match the routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  /** `true` only when the two types are assignable BOTH ways. */
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  type Assert<T extends true> = T;

  type Backup200 = InferResponseType<typeof client.api.v1.backup.$get, 200>;
  type Snapshots200 = InferResponseType<typeof client.api.v1.backup.snapshots.$get, 200>;

  type _Checks = [
    Assert<Exact<z.infer<typeof backupOverviewResponseSchema>, Backup200>>,
    Assert<Exact<z.infer<typeof backupSnapshotsResponseSchema>, Snapshots200>>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    // Pins the comparator itself: a `Mutual` that degenerated to `true` would make every
    // assertion above vacuous, exactly the trap this file is meant to avoid.
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    const narrower: Mutual<{ a: string; b: number }, { a: string }> = 'route-is-wider';
    expect([wider, narrower]).toEqual(['schema-is-wider', 'route-is-wider']);
  });
});
