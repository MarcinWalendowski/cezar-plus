import { describe, expect, it } from 'vitest';
import {
  CLUSTER_ACCESS_CLIENT_ID_HEADER,
  CLUSTER_ACCESS_CLIENT_SECRET_HEADER,
  ClusterEdgeAuthConfigError,
  resolveEdgeAuthHeaders,
} from './edge-auth.ts';

/**
 * `resolveEdgeAuthHeaders` (Cloudflare Access edge credential, `edge-auth.ts`'s own module doc) —
 * distinct from and never a substitute for D20 node auth (`node-auth.test.ts` covers that).
 */

const CLIENT_ID = 'a1b2c3d4-e5f6-47a8-9b0c-1d2e3f4a5b6c.access';
// A distinctive value so a test can assert it never appears anywhere this file's guards emit —
// long enough (over MIN_SECRET_LEN in core/secret-redaction.ts) to look like a real credential,
// but this module has nothing to do with that redaction path; this is a marker string, not a real
// secret being scrubbed.
const CLIENT_SECRET = 'zz9-VERY-DISTINCTIVE-SECRET-MARKER-8k2p7q-zz9';

describe('resolveEdgeAuthHeaders — the zero-config path', () => {
  it('returns undefined when neither env var is set', () => {
    expect(resolveEdgeAuthHeaders({})).toBeUndefined();
  });

  it('returns undefined when both are set to an empty/whitespace string (treated as unset, matching CEZ_CLUSTER_HUB\'s own trim idiom)', () => {
    expect(
      resolveEdgeAuthHeaders({ CEZ_CLUSTER_ACCESS_CLIENT_ID: '  ', CEZ_CLUSTER_ACCESS_CLIENT_SECRET: '' }),
    ).toBeUndefined();
  });

  it('defaults to process.env when no env argument is given', () => {
    const prevId = process.env.CEZ_CLUSTER_ACCESS_CLIENT_ID;
    const prevSecret = process.env.CEZ_CLUSTER_ACCESS_CLIENT_SECRET;
    delete process.env.CEZ_CLUSTER_ACCESS_CLIENT_ID;
    delete process.env.CEZ_CLUSTER_ACCESS_CLIENT_SECRET;
    try {
      expect(resolveEdgeAuthHeaders()).toBeUndefined();
    } finally {
      if (prevId === undefined) delete process.env.CEZ_CLUSTER_ACCESS_CLIENT_ID;
      else process.env.CEZ_CLUSTER_ACCESS_CLIENT_ID = prevId;
      if (prevSecret === undefined) delete process.env.CEZ_CLUSTER_ACCESS_CLIENT_SECRET;
      else process.env.CEZ_CLUSTER_ACCESS_CLIENT_SECRET = prevSecret;
    }
  });
});

describe('resolveEdgeAuthHeaders — both set', () => {
  it('returns exactly the two Cloudflare Access service-token headers, values intact', () => {
    const headers = resolveEdgeAuthHeaders({
      CEZ_CLUSTER_ACCESS_CLIENT_ID: CLIENT_ID,
      CEZ_CLUSTER_ACCESS_CLIENT_SECRET: CLIENT_SECRET,
    });
    expect(headers).toEqual({
      'CF-Access-Client-Id': CLIENT_ID,
      'CF-Access-Client-Secret': CLIENT_SECRET,
    });
    // The exported constants are the SAME strings actually used — not a parallel literal that
    // could drift from what a caller merges into a real request.
    expect(CLUSTER_ACCESS_CLIENT_ID_HEADER).toBe('CF-Access-Client-Id');
    expect(CLUSTER_ACCESS_CLIENT_SECRET_HEADER).toBe('CF-Access-Client-Secret');
    expect(Object.keys(headers!)).toEqual([CLUSTER_ACCESS_CLIENT_ID_HEADER, CLUSTER_ACCESS_CLIENT_SECRET_HEADER]);
  });

  it('trims surrounding whitespace off both values', () => {
    const headers = resolveEdgeAuthHeaders({
      CEZ_CLUSTER_ACCESS_CLIENT_ID: `  ${CLIENT_ID}  `,
      CEZ_CLUSTER_ACCESS_CLIENT_SECRET: `\t${CLIENT_SECRET}\n`,
    });
    expect(headers).toEqual({
      'CF-Access-Client-Id': CLIENT_ID,
      'CF-Access-Client-Secret': CLIENT_SECRET,
    });
  });
});

describe('resolveEdgeAuthHeaders — half-configuration fails closed, LOUDLY (test both halves)', () => {
  it('throws ClusterEdgeAuthConfigError naming the missing SECRET when only the ID is set', () => {
    expect(() => resolveEdgeAuthHeaders({ CEZ_CLUSTER_ACCESS_CLIENT_ID: CLIENT_ID })).toThrow(
      ClusterEdgeAuthConfigError,
    );
    try {
      resolveEdgeAuthHeaders({ CEZ_CLUSTER_ACCESS_CLIENT_ID: CLIENT_ID });
      expect.unreachable('expected resolveEdgeAuthHeaders to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ClusterEdgeAuthConfigError);
      const e = err as ClusterEdgeAuthConfigError;
      expect(e.missingVar).toBe('CEZ_CLUSTER_ACCESS_CLIENT_SECRET');
      expect(e.presentVar).toBe('CEZ_CLUSTER_ACCESS_CLIENT_ID');
      expect(e.message).toContain('CEZ_CLUSTER_ACCESS_CLIENT_SECRET');
      expect(e.message).toContain('CEZ_CLUSTER_ACCESS_CLIENT_ID');
    }
  });

  it('throws ClusterEdgeAuthConfigError naming the missing ID when only the SECRET is set', () => {
    expect(() => resolveEdgeAuthHeaders({ CEZ_CLUSTER_ACCESS_CLIENT_SECRET: CLIENT_SECRET })).toThrow(
      ClusterEdgeAuthConfigError,
    );
    try {
      resolveEdgeAuthHeaders({ CEZ_CLUSTER_ACCESS_CLIENT_SECRET: CLIENT_SECRET });
      expect.unreachable('expected resolveEdgeAuthHeaders to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ClusterEdgeAuthConfigError);
      const e = err as ClusterEdgeAuthConfigError;
      expect(e.missingVar).toBe('CEZ_CLUSTER_ACCESS_CLIENT_ID');
      expect(e.presentVar).toBe('CEZ_CLUSTER_ACCESS_CLIENT_SECRET');
      expect(e.message).toContain('CEZ_CLUSTER_ACCESS_CLIENT_ID');
      expect(e.message).toContain('CEZ_CLUSTER_ACCESS_CLIENT_SECRET');
    }
  });

  it('negative control: a FULL configuration (both set) must NOT throw — the guard fires on exactly one var missing, not on any set var at all', () => {
    expect(() =>
      resolveEdgeAuthHeaders({
        CEZ_CLUSTER_ACCESS_CLIENT_ID: CLIENT_ID,
        CEZ_CLUSTER_ACCESS_CLIENT_SECRET: CLIENT_SECRET,
      }),
    ).not.toThrow();
  });
});

describe('resolveEdgeAuthHeaders — the secret VALUE never appears in anything this module emits', () => {
  /** Every string this module could plausibly "emit" outside the returned headers object itself:
   *  the error's message, its own `name`, `String(error)`, and its JSON-serialised own-properties
   *  (what a naive `logger.error({ err })` call would end up writing). The returned headers object
   *  legitimately carries the secret — that is the whole point of a successful resolution — so it
   *  is deliberately excluded from this sweep; this test is only about the FAILURE path, where the
   *  half-credential that WAS supplied must never leak into a diagnostic. */
  function emittedSurfaces(err: ClusterEdgeAuthConfigError): string[] {
    return [err.message, err.name, String(err), JSON.stringify({ ...err, message: err.message, name: err.name })];
  }

  it('ID-only failure: the secret is never sent (there is nothing to leak — the ID-only case never had a secret value)', () => {
    // Symmetric case, included for completeness: nothing here reads a secret at all when only
    // the id was supplied, so there is nothing that COULD leak. The meaningful assertion is the
    // one below, where the secret WAS actually supplied.
    try {
      resolveEdgeAuthHeaders({ CEZ_CLUSTER_ACCESS_CLIENT_ID: CLIENT_ID });
      expect.unreachable('expected resolveEdgeAuthHeaders to throw');
    } catch (err) {
      for (const surface of emittedSurfaces(err as ClusterEdgeAuthConfigError)) {
        expect(surface).not.toContain(CLIENT_SECRET);
      }
    }
  });

  it('SECRET-only failure: the secret VALUE that WAS supplied never appears in the error at all', () => {
    try {
      resolveEdgeAuthHeaders({ CEZ_CLUSTER_ACCESS_CLIENT_SECRET: CLIENT_SECRET });
      expect.unreachable('expected resolveEdgeAuthHeaders to throw');
    } catch (err) {
      for (const surface of emittedSurfaces(err as ClusterEdgeAuthConfigError)) {
        expect(surface).not.toContain(CLIENT_SECRET);
      }
    }
  });
});
