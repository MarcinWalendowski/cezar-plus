import type { BackupProvider, S3ProviderConfig } from '../provider-types.ts';
import { canonicalQueryString, signRequest, uriEncode } from './sigv4.ts';

/**
 * The `s3` backup provider (Phase 3) — a `BackupProvider` (`../provider-types.ts`) over any
 * S3-compatible object store (R2 / S3 / B2 / MinIO), authenticated with hand-rolled SigV4
 * (`./sigv4.ts`). `node:crypto` (via `sigv4.ts`) + native `fetch` only — no `aws-sdk`, no XML
 * library (D7).
 *
 * **Path-style URLs**, not virtual-hosted (`${endpoint}/${bucket}/${key}`) — the config's
 * `endpoint` is whatever host the user points at (an R2 account endpoint, a MinIO instance, a
 * bucket-less S3-compatible URL), so bucket-in-path is the one addressing scheme that works
 * everywhere without assuming DNS-level bucket routing.
 *
 * **`config.prefix` is not applied here.** Per the `BackupProvider` contract
 * (`../provider-types.ts`'s module doc): "the configured `prefix` is applied by the engine before
 * it calls these, so a provider stores exactly the key it is given." The snapshot engine (Phase 5)
 * is what reads `config.prefix` and folds it into the `key` argument before calling `put`/`get`/
 * etc.; this provider treats `key` as the literal, already-final S3 object key — exactly like
 * `./local.ts` treats its `key` argument as already-final relative to `config.path`.
 *
 * Reads answer `null` for a `404` (the seam's "not there is a normal answer" contract); every other
 * non-2xx status on any call throws with the HTTP status and a short response-body snippet, so a
 * caller sees *why* a request failed rather than an opaque throw.
 */
export function createS3BackupProvider(config: S3ProviderConfig): BackupProvider {
  const endpointOrigin = config.endpoint.replace(/\/+$/, '');
  const host = new URL(endpointOrigin).host;
  const bucketSegment = uriEncode(config.bucket, false);

  function objectPath(key: string): string {
    const segments = key.split('/').map((segment) => uriEncode(segment, false));
    return `/${bucketSegment}/${segments.join('/')}`;
  }

  async function signedFetch(params: {
    method: string;
    path: string;
    query?: Record<string, string>;
    body?: Uint8Array;
  }): Promise<Response> {
    const body = params.body ?? new Uint8Array(0);
    const query = params.query ? canonicalQueryString(params.query) : '';
    const signed = signRequest({
      method: params.method,
      host,
      canonicalUri: params.path,
      canonicalQueryString: query,
      body,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: config.region,
      service: 's3',
      date: new Date(),
    });
    const url = `${endpointOrigin}${params.path}${query ? `?${query}` : ''}`;
    const headers: Record<string, string> = {
      'X-Amz-Date': signed.headers['x-amz-date'],
      'X-Amz-Content-Sha256': signed.headers['x-amz-content-sha256'],
      Authorization: signed.headers.authorization,
    };
    const hasBody = params.method === 'PUT' || params.method === 'POST';
    if (hasBody) {
      headers['Content-Length'] = String(body.byteLength);
    }
    return fetch(url, {
      method: params.method,
      headers,
      body: hasBody ? body : undefined,
    });
  }

  async function assertOk(response: Response, op: string): Promise<void> {
    if (response.ok) return;
    const snippet = (await response.text().catch(() => '')).slice(0, 200);
    throw new Error(`S3 ${op} failed: ${response.status} ${response.statusText} — ${snippet}`);
  }

  return {
    kind: 's3',

    async put(key, bytes) {
      const response = await signedFetch({ method: 'PUT', path: objectPath(key), body: bytes });
      await assertOk(response, 'put');
    },

    async get(key) {
      const response = await signedFetch({ method: 'GET', path: objectPath(key) });
      if (response.status === 404) return null;
      await assertOk(response, 'get');
      return new Uint8Array(await response.arrayBuffer());
    },

    async head(key) {
      const response = await signedFetch({ method: 'HEAD', path: objectPath(key) });
      if (response.status === 404) return null;
      await assertOk(response, 'head');
      const sizeHeader = response.headers.get('content-length');
      return { size: sizeHeader ? Number(sizeHeader) : 0 };
    },

    async list(prefix) {
      const keys: string[] = [];
      let continuationToken: string | undefined;
      do {
        const query: Record<string, string> = { 'list-type': '2', prefix };
        if (continuationToken) query['continuation-token'] = continuationToken;
        const response = await signedFetch({ method: 'GET', path: `/${bucketSegment}`, query });
        await assertOk(response, 'list');
        const xml = await response.text();
        for (const match of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) {
          keys.push(decodeXmlEntities(match[1] ?? ''));
        }
        const tokenMatch = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
        continuationToken = tokenMatch ? decodeXmlEntities(tokenMatch[1] ?? '') : undefined;
      } while (continuationToken);
      return keys;
    },

    async delete(key) {
      const response = await signedFetch({ method: 'DELETE', path: objectPath(key) });
      if (response.status === 204 || response.status === 404) return;
      await assertOk(response, 'delete');
    },
  };
}

/** The minimal XML entity set S3 keys can contain (`&`, `<`, `>`, `"`, `'`), plus numeric
 *  references — enough to recover an exact key from a `ListBucketResult` body without a real XML
 *  parser (D7). Order matters: `&amp;` must decode last, or a literal `&lt;` produced by decoding
 *  `&amp;lt;` would be wrong — matching how every hand-rolled XML-entity decoder handles `&amp;`. */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}
