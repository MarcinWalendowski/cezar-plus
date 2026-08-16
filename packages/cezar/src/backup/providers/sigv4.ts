import { createHmac } from 'node:crypto';
import { sha256Hex } from '../crypto.ts';

/**
 * Hand-rolled AWS Signature Version 4 (SigV4) request signing — `node:crypto` only, no dependency
 * on `aws-sdk` or any signing library (D7, spec `.ai/specs/2026-08-16-provider-agnostic-platform-
 * backup.md` Phase 3). Used by `./s3.ts` to authenticate every request to an S3-compatible backend
 * (R2 / S3 / B2 / MinIO).
 *
 * The four canonical stages (AWS's own naming — see
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html), each exposed as an
 * independently testable pure function so a regression in one stage is caught at that stage, not
 * only at the final signature:
 *
 *  1. **Canonical request** (`buildCanonicalRequest`) — `METHOD\nURI\nQUERY\nHEADERS\n\nSIGNED\n
 *     PAYLOAD_HASH`, hashed with SHA-256.
 *  2. **String to sign** (`buildStringToSign`) — `AWS4-HMAC-SHA256\n<date>\n<scope>\n<creq hash>`.
 *  3. **Signing key** (`deriveSigningKey`) — an HMAC-SHA256 chain: `AWS4<secret>` → date → region →
 *     service → the literal `aws4_request`. Each step re-keys the HMAC with the previous step's
 *     output, so the final key is bound to one day, one region, one service — never reused as-is
 *     for a different date.
 *  4. **Signature + Authorization header** (`calculateSignature`, `buildAuthorizationHeader`) — the
 *     signing key HMACs the string-to-sign; the hex digest is embedded in the `Authorization`
 *     header alongside the access key and credential scope.
 *
 * `signRequest` composes all four for one call, given the pieces `./s3.ts` already has (method,
 * host, an already percent-encoded path, an already-canonicalized query string, and the body). It
 * takes `date` as a parameter (never calls `new Date()` itself) so it stays pure and
 * `sigv4.test.ts` can assert it byte-for-byte against a fixed timestamp.
 *
 * `sigv4.test.ts` asserts every stage against AWS's published SigV4 test-suite "get-vanilla"
 * vector — the only oracle for a hand-rolled signer; anything short of a byte-exact match against
 * an independently published value is not a real test.
 */

/** `x-amz-content-sha256` for a zero-length body — every stage-1 (bodyless) request sends this. */
export const EMPTY_PAYLOAD_SHA256_HEX = sha256Hex(new Uint8Array(0));

const UNRESERVED = /^[A-Za-z0-9\-_.~]$/;

/** AWS's `UriEncode` (SigV4 spec, not `encodeURIComponent`): unreserved characters pass through
 *  literally, everything else is percent-encoded byte-by-byte in **uppercase** hex. `encodeSlash`
 *  defaults to `true` (query-string components always encode `/`); path building passes `false`
 *  per-segment-joined so the separating `/` characters survive. */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const ch of value) {
    if (UNRESERVED.test(ch)) {
      out += ch;
    } else if (ch === '/' && !encodeSlash) {
      out += ch;
    } else {
      for (const byte of Buffer.from(ch, 'utf8')) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    }
  }
  return out;
}

/** Builds a canonical query string: each key/value `UriEncode`-d, then sorted by key (byte order —
 *  safe here since every key this codebase sends, `list-type` / `prefix` / `continuation-token`,
 *  consists only of unreserved characters, so encoding never reorders them). The exact same string
 *  is used both as the signed component and as the literal query string on the wire — AWS rejects
 *  a request whose signed query string doesn't match the one actually sent. */
export function canonicalQueryString(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${uriEncode(key)}=${uriEncode(params[key] ?? '')}`)
    .join('&');
}

/** `YYYYMMDDTHHMMSSZ` — the SigV4 `x-amz-date` format, derived from an ISO instant by stripping the
 *  separators and millisecond fraction. `date.slice(0, 8)` gives the plain `YYYYMMDD` date stamp
 *  the credential scope and signing-key derivation both need. */
export function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export interface CanonicalRequestParams {
  method: string;
  /** Already `uriEncode`-d request path, e.g. `/bucket/key`. */
  canonicalUri: string;
  /** Already built via `canonicalQueryString`, or `''` for none. */
  canonicalQueryString: string;
  /** Lowercase header name → value, for every header that will be signed. */
  signedHeaders: Record<string, string>;
  /** Hex SHA-256 of the request body (`EMPTY_PAYLOAD_SHA256_HEX` for a bodyless request). */
  payloadHashHex: string;
}

/** Stage 1: builds the canonical request string and its `SignedHeaders` list (semicolon-joined,
 *  sorted header names — the same order the `Authorization` header must declare). Header names are
 *  lower-cased and values trimmed per the SigV4 canonicalization rules; this codebase's own signed
 *  headers (`host`, `x-amz-date`, `x-amz-content-sha256`) never need more than that. */
export function buildCanonicalRequest(params: CanonicalRequestParams): {
  canonicalRequestString: string;
  signedHeaderNames: string;
} {
  const names = Object.keys(params.signedHeaders)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${(params.signedHeaders[name] ?? '').trim()}\n`)
    .join('');
  const signedHeaderNames = names.join(';');
  const canonicalRequestString = [
    params.method,
    params.canonicalUri,
    params.canonicalQueryString,
    canonicalHeaders,
    signedHeaderNames,
    params.payloadHashHex,
  ].join('\n');
  return { canonicalRequestString, signedHeaderNames };
}

export interface StringToSignParams {
  amzDate: string;
  /** `<dateStamp>/<region>/<service>/aws4_request`. */
  credentialScope: string;
  canonicalRequestHashHex: string;
}

/** Stage 2. */
export function buildStringToSign(params: StringToSignParams): string {
  return ['AWS4-HMAC-SHA256', params.amzDate, params.credentialScope, params.canonicalRequestHashHex].join('\n');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** Stage 3: the `AWS4<secret>` → date → region → service → `aws4_request` HMAC chain. */
export function deriveSigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/** Stage 4a: HMACs the string-to-sign with the derived signing key. Hex, lowercase (AWS's own
 *  examples and the `get-vanilla` test vector are lowercase hex). */
export function calculateSignature(signingKey: Buffer, stringToSignValue: string): string {
  return createHmac('sha256', signingKey).update(stringToSignValue, 'utf8').digest('hex');
}

export interface AuthorizationHeaderParams {
  accessKeyId: string;
  credentialScope: string;
  signedHeaderNames: string;
  signature: string;
}

/** Stage 4b: assembles the `Authorization` header value. */
export function buildAuthorizationHeader(params: AuthorizationHeaderParams): string {
  return (
    `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${params.credentialScope}, ` +
    `SignedHeaders=${params.signedHeaderNames}, Signature=${params.signature}`
  );
}

export interface SignRequestParams {
  method: string;
  host: string;
  /** Already `uriEncode`-d request path, e.g. `/bucket/key`. */
  canonicalUri: string;
  /** Already built via `canonicalQueryString`, or `''` for none. */
  canonicalQueryString: string;
  body: Uint8Array;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  /** Signing instant. Passed in, never read via `new Date()`, so this stays pure — the caller
   *  (`./s3.ts`) supplies `new Date()` at the call site. */
  date: Date;
}

export interface SignedRequest {
  /** Every header the signature covers, ready to hand to `fetch`. */
  headers: {
    host: string;
    'x-amz-date': string;
    'x-amz-content-sha256': string;
    authorization: string;
  };
}

/** Composes all four stages for one request. `./s3.ts` calls this once per HTTP call; every field
 *  it returns beyond `headers` is a diagnostic seam `sigv4.test.ts` uses to assert the intermediate
 *  stages, not something `s3.ts` needs. */
export function signRequest(params: SignRequestParams): SignedRequest & {
  amzDate: string;
  canonicalRequestString: string;
  stringToSignValue: string;
  signatureHex: string;
} {
  const amzDate = formatAmzDate(params.date);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHashHex = sha256Hex(params.body);
  const signedHeaders = {
    host: params.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHashHex,
  };
  const { canonicalRequestString, signedHeaderNames } = buildCanonicalRequest({
    method: params.method,
    canonicalUri: params.canonicalUri,
    canonicalQueryString: params.canonicalQueryString,
    signedHeaders,
    payloadHashHex,
  });
  const canonicalRequestHashHex = sha256Hex(new TextEncoder().encode(canonicalRequestString));
  const credentialScope = `${dateStamp}/${params.region}/${params.service}/aws4_request`;
  const stringToSignValue = buildStringToSign({ amzDate, credentialScope, canonicalRequestHashHex });
  const signingKey = deriveSigningKey(params.secretAccessKey, dateStamp, params.region, params.service);
  const signatureHex = calculateSignature(signingKey, stringToSignValue);
  const authorization = buildAuthorizationHeader({
    accessKeyId: params.accessKeyId,
    credentialScope,
    signedHeaderNames,
    signature: signatureHex,
  });
  return {
    headers: {
      host: params.host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHashHex,
      authorization,
    },
    amzDate,
    canonicalRequestString,
    stringToSignValue,
    signatureHex,
  };
}
