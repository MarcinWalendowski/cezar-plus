import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createS3BackupProvider } from './s3.ts';
import type { S3ProviderConfig } from '../provider-types.ts';
import { sha256Hex } from '../crypto.ts';

/**
 * Deterministic, no-live-server tests for the `s3` `BackupProvider` (Phase 3). Every test stubs
 * `global.fetch` and asserts what the provider sent (method, path-style URL, signing headers)
 * and/or how it interprets a stubbed response (200 body, 404 ⇒ `null`, a `ListBucketResult`
 * page). The `sigv4.test.ts` file is the actual signature oracle (AWS's published vectors); this
 * file only checks that `s3.ts` *wires* signing in — every signed request must carry an
 * `Authorization: AWS4-HMAC-SHA256 ...` header, an `x-amz-date`, and an `x-amz-content-sha256`.
 *
 * One optional integration test at the bottom runs against a real S3-compatible endpoint when
 * `CEZ_BACKUP_TEST_S3_ENDPOINT` is set; it `it.skip`s otherwise, so `npm test` never needs a
 * network or credentials.
 */

const config: S3ProviderConfig = {
  kind: 's3',
  endpoint: 'https://example.r2.cloudflarestorage.com',
  bucket: 'my-bucket',
  region: 'auto',
  prefix: 'cezar/',
  accessKeyId: 'TESTKEYID',
  secretAccessKey: 'TESTSECRETKEY',
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

/** Stubs `global.fetch` with a canned response sequence (repeating the last entry once exhausted)
 *  and returns the array every call gets recorded into. */
function stubFetch(responses: Response[]): Call[] {
  const calls: Call[] = [];
  let index = 0;
  global.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!response) throw new Error('stubFetch: no response configured');
    return response;
  }) as unknown as typeof fetch;
  return calls;
}

function assertSigned(headers: Record<string, string>): void {
  expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=TESTKEYID\//);
  expect(headers['X-Amz-Date']).toMatch(/^\d{8}T\d{6}Z$/);
  expect(headers['X-Amz-Content-Sha256']).toMatch(/^[0-9a-f]{64}$/);
}

describe('createS3BackupProvider — put', () => {
  it('issues a PUT to the path-style URL, signed, with content-length', async () => {
    const calls = stubFetch([new Response(null, { status: 200 })]);
    const provider = createS3BackupProvider(config);
    const bytes = new TextEncoder().encode('hello world');

    await provider.put('blobs/ab/cd', bytes);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).toBe('https://example.r2.cloudflarestorage.com/my-bucket/blobs/ab/cd');
    assertSigned(calls[0]!.headers);
    expect(calls[0]?.headers['Content-Length']).toBe(String(bytes.byteLength));
    expect(calls[0]?.headers['X-Amz-Content-Sha256']).toBe(sha256Hex(bytes));
  });

  it('throws with the status and a body snippet on a non-2xx response', async () => {
    // A `Response` body can only be read once, so this asserts both facts off a single call
    // rather than two separate `.rejects.toThrow` calls against the same stubbed response.
    stubFetch([new Response('access denied', { status: 403, statusText: 'Forbidden' })]);
    const provider = createS3BackupProvider(config);

    let error: unknown;
    try {
      await provider.put('object', new Uint8Array([1]));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('403');
    expect((error as Error).message).toContain('access denied');
  });
});

describe('createS3BackupProvider — get', () => {
  it('round-trips a stubbed 200 body exactly', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 254]);
    stubFetch([new Response(bytes, { status: 200 })]);
    const provider = createS3BackupProvider(config);

    const back = await provider.get('blobs/ab/cd');
    expect(back).not.toBeNull();
    expect(Array.from(back ?? [])).toEqual(Array.from(bytes));
  });

  it('returns null on a stubbed 404, never throws', async () => {
    stubFetch([new Response(null, { status: 404 })]);
    const provider = createS3BackupProvider(config);

    await expect(provider.get('missing')).resolves.toBeNull();
  });

  it('signs the GET request', async () => {
    const calls = stubFetch([new Response(new Uint8Array(0), { status: 200 })]);
    const provider = createS3BackupProvider(config);

    await provider.get('blobs/ab/cd');

    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe('https://example.r2.cloudflarestorage.com/my-bucket/blobs/ab/cd');
    assertSigned(calls[0]!.headers);
  });
});

describe('createS3BackupProvider — head', () => {
  it('returns null on a stubbed 404', async () => {
    stubFetch([new Response(null, { status: 404 })]);
    const provider = createS3BackupProvider(config);

    await expect(provider.head('missing')).resolves.toBeNull();
  });

  it('reports size from the content-length header on success', async () => {
    stubFetch([new Response(null, { status: 200, headers: { 'content-length': '42' } })]);
    const provider = createS3BackupProvider(config);

    await expect(provider.head('blobs/ab/cd')).resolves.toEqual({ size: 42 });
  });

  it('issues a HEAD request, signed', async () => {
    const calls = stubFetch([new Response(null, { status: 200, headers: { 'content-length': '0' } })]);
    const provider = createS3BackupProvider(config);

    await provider.head('blobs/ab/cd');

    expect(calls[0]?.method).toBe('HEAD');
    assertSigned(calls[0]!.headers);
  });
});

describe('createS3BackupProvider — delete', () => {
  it('treats a 204 as success', async () => {
    const calls = stubFetch([new Response(null, { status: 204 })]);
    const provider = createS3BackupProvider(config);

    await expect(provider.delete('blobs/ab/cd')).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe('DELETE');
    assertSigned(calls[0]!.headers);
  });

  it('treats a 404 as success (idempotent delete)', async () => {
    stubFetch([new Response(null, { status: 404 })]);
    const provider = createS3BackupProvider(config);

    await expect(provider.delete('missing')).resolves.toBeUndefined();
  });

  it('throws on a real failure status', async () => {
    stubFetch([new Response('nope', { status: 500 })]);
    const provider = createS3BackupProvider(config);

    await expect(provider.delete('blobs/ab/cd')).rejects.toThrow(/500/);
  });
});

describe('createS3BackupProvider — list', () => {
  const pageOne = new Response(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ListBucketResult>',
      '<Contents><Key>cezar/blobs/ab/cd</Key></Contents>',
      '<Contents><Key>cezar/blobs/ef/gh</Key></Contents>',
      '<NextContinuationToken>token-123</NextContinuationToken>',
      '</ListBucketResult>',
    ].join(''),
    { status: 200 },
  );
  const pageTwo = new Response(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ListBucketResult>',
      '<Contents><Key>cezar/snapshots/2026-01-01T00:00:00.000Z.manifest.enc</Key></Contents>',
      '</ListBucketResult>',
    ].join(''),
    { status: 200 },
  );

  it('parses Keys out of the XML and follows NextContinuationToken across pages', async () => {
    const calls = stubFetch([pageOne, pageTwo]);
    const provider = createS3BackupProvider(config);

    const keys = await provider.list('cezar/');

    expect(keys).toEqual(['cezar/blobs/ab/cd', 'cezar/blobs/ef/gh', 'cezar/snapshots/2026-01-01T00:00:00.000Z.manifest.enc']);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe('https://example.r2.cloudflarestorage.com/my-bucket?list-type=2&prefix=cezar%2F');
    expect(calls[1]?.url).toBe(
      'https://example.r2.cloudflarestorage.com/my-bucket?continuation-token=token-123&list-type=2&prefix=cezar%2F',
    );
    assertSigned(calls[0]!.headers);
  });

  it('returns [] for a page with no Contents and no continuation token', async () => {
    stubFetch([new Response('<?xml version="1.0"?><ListBucketResult></ListBucketResult>', { status: 200 })]);
    const provider = createS3BackupProvider(config);

    await expect(provider.list('cezar/nothing-here/')).resolves.toEqual([]);
  });
});

describe('live S3-compatible integration (optional)', () => {
  const endpoint = process.env.CEZ_BACKUP_TEST_S3_ENDPOINT;
  const maybeIt = endpoint ? it : it.skip;

  maybeIt('round-trips put/get/delete against a real endpoint', async () => {
    const liveConfig: S3ProviderConfig = {
      kind: 's3',
      endpoint: endpoint ?? '',
      bucket: process.env.CEZ_BACKUP_TEST_S3_BUCKET ?? 'cezar-backup-test',
      region: process.env.CEZ_BACKUP_TEST_S3_REGION ?? 'auto',
      prefix: '',
      accessKeyId: process.env.CEZ_BACKUP_TEST_S3_KEY ?? '',
      secretAccessKey: process.env.CEZ_BACKUP_TEST_S3_SECRET ?? '',
    };
    const provider = createS3BackupProvider(liveConfig);
    const key = `sigv4-integration-test/${Date.now()}.bin`;
    const bytes = new TextEncoder().encode('cezar s3 provider integration probe');

    await provider.put(key, bytes);
    const back = await provider.get(key);
    expect(back && new TextDecoder().decode(back)).toBe('cezar s3 provider integration probe');
    await provider.delete(key);
    await expect(provider.get(key)).resolves.toBeNull();
  });
});
