import { describe, expect, it } from 'vitest';
import { createSourceConnectionInputSchema, updateSourceConnectionInputSchema } from '@loki-labs/cezar-plus-contract';
import { defaultIntervalSecondsForKind, minIntervalSecondsForKind, sourceConnectionSchema } from './types.ts';

/**
 * The `cezar-hub` 60s floor (item 56 / D8a of `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`).
 * The owner's near-real-time-sync requirement was unreachable by configuration: EVERY kind shared
 * one `intervalSeconds` floor of 300s, so 60s was rejected outright for a `cezar-hub` connection
 * exactly as it would be for a Notion one. `cezar-hub` talks to our OWN box over the enrollment
 * tunnel, where — under the manifest + `hash` + `?since=` design — a no-change sweep costs one
 * small HTTP request, unlike a genuine third-party API a 300s floor exists to protect. Every test
 * below carries the negative half its own docblock demands: a per-kind floor that quietly reverted
 * to a global one would still pass a test that only checks the positive case.
 */

const BASE = {
  id: 'proj-1',
  revision: 1,
  name: 'Test connection',
  enabled: true,
  mode: 'mirror' as const,
  collections: [],
  watchComments: false,
  maxDocuments: 5_000,
  maxBodyBytes: 524_288,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
};

describe('sourceConnectionSchema — per-kind intervalSeconds floor', () => {
  it('accepts 60s for kind "cezar-hub"', () => {
    const result = sourceConnectionSchema.safeParse({ ...BASE, kind: 'cezar-hub', intervalSeconds: 60 });
    expect(result.success).toBe(true);
  });

  it('NEGATIVE CONTROL: still refuses 60s for any other kind (notion) — proves the floor is per-kind, not a global floor that got quietly lowered', () => {
    const result = sourceConnectionSchema.safeParse({ ...BASE, kind: 'notion', intervalSeconds: 60 });
    expect(result.success).toBe(false);
  });

  it('refuses 59s even for "cezar-hub" — the floor is a floor, not a suggestion', () => {
    const result = sourceConnectionSchema.safeParse({ ...BASE, kind: 'cezar-hub', intervalSeconds: 59 });
    expect(result.success).toBe(false);
  });

  it('still refuses 299s for kind "notion" (the pre-existing 300s floor is unchanged for every other kind)', () => {
    const result = sourceConnectionSchema.safeParse({ ...BASE, kind: 'notion', intervalSeconds: 299 });
    expect(result.success).toBe(false);
  });

  it('still accepts 300s for kind "notion"', () => {
    const result = sourceConnectionSchema.safeParse({ ...BASE, kind: 'notion', intervalSeconds: 300 });
    expect(result.success).toBe(true);
  });
});

describe('minIntervalSecondsForKind / defaultIntervalSecondsForKind', () => {
  it('declares a 60s floor and default for "cezar-hub"', () => {
    expect(minIntervalSecondsForKind('cezar-hub')).toBe(60);
    expect(defaultIntervalSecondsForKind('cezar-hub')).toBe(60);
  });

  it('NEGATIVE CONTROL: every other kind keeps the 300s floor and 900s default', () => {
    expect(minIntervalSecondsForKind('notion')).toBe(300);
    expect(defaultIntervalSecondsForKind('notion')).toBe(900);
    // An unregistered/unknown kind string is not a way to buy a lower floor either.
    expect(minIntervalSecondsForKind('some-future-kind')).toBe(300);
    expect(defaultIntervalSecondsForKind('some-future-kind')).toBe(900);
  });
});

/**
 * `@loki-labs/cezar-plus-contract`'s wire-side input schemas — the `POST /sources` and
 * `PUT /sources/:connectionId` request bodies — MIRROR `sourceConnectionSchema`'s floor rather
 * than sharing it (the contract package cannot import from this one; see both files' headers), so
 * this is a second, independent proof the same floor actually landed on the wire boundary a caller
 * hits, not just in the on-disk storage schema `SourceStore` parses against.
 */
describe('contract createSourceConnectionInputSchema / updateSourceConnectionInputSchema — the wire-side mirror of the floor', () => {
  it('POST /sources: accepts 60s for kind "cezar-hub"', () => {
    const result = createSourceConnectionInputSchema.safeParse({ kind: 'cezar-hub', name: 'Hub', intervalSeconds: 60 });
    expect(result.success).toBe(true);
  });

  it('NEGATIVE CONTROL: POST /sources still refuses 60s for kind "notion"', () => {
    const result = createSourceConnectionInputSchema.safeParse({ kind: 'notion', name: 'Notion', intervalSeconds: 60 });
    expect(result.success).toBe(false);
  });

  it('POST /sources: refuses 59s even for "cezar-hub"', () => {
    const result = createSourceConnectionInputSchema.safeParse({ kind: 'cezar-hub', name: 'Hub', intervalSeconds: 59 });
    expect(result.success).toBe(false);
  });

  it('POST /sources: an omitted intervalSeconds is left to the server default, never floor-checked against undefined', () => {
    const result = createSourceConnectionInputSchema.safeParse({ kind: 'cezar-hub', name: 'Hub' });
    expect(result.success).toBe(true);
  });

  it('PUT /sources/:id: accepts 60s for kind "cezar-hub" (the `.extend()`ed schema keeps the same floor)', () => {
    const result = updateSourceConnectionInputSchema.safeParse({
      kind: 'cezar-hub',
      name: 'Hub',
      intervalSeconds: 60,
      expectedRevision: 1,
    });
    expect(result.success).toBe(true);
  });

  it('NEGATIVE CONTROL: PUT /sources/:id still refuses 60s for kind "notion"', () => {
    const result = updateSourceConnectionInputSchema.safeParse({
      kind: 'notion',
      name: 'Notion',
      intervalSeconds: 60,
      expectedRevision: 1,
    });
    expect(result.success).toBe(false);
  });
});
