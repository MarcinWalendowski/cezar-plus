import { describe, expect, it } from 'vitest';
import {
  EMPTY_PAYLOAD_SHA256_HEX,
  buildAuthorizationHeader,
  buildCanonicalRequest,
  buildStringToSign,
  calculateSignature,
  canonicalQueryString,
  deriveSigningKey,
  formatAmzDate,
  signRequest,
  uriEncode,
} from './sigv4.ts';

/**
 * N7 — SigV4 against AWS's published test-suite vectors. This is the only oracle for a hand-rolled
 * signer (Risks: "Hand-rolled SigV4 is the riskiest no-dep bet"): every expected value below is
 * copied verbatim from AWS's official `aws-sig-v4-test-suite` "get-vanilla" case (`get-vanilla.creq`
 * / `.sts` / `.authz`), and independently re-derived by hand (Python `hmac`/`hashlib`) before being
 * pasted here — so this test is checked against the spec, not against this module's own output.
 *
 * Fixture: request `GET https://example.amazonaws.com/`, only header `Host: example.amazonaws.com`,
 * signed at `x-amz-date: 20150830T123600Z` for `us-east-1`/`service` with access key `AKIDEXAMPLE`
 * and secret `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY`. Each stage is asserted on its own so a
 * regression in canonical-request building, string-to-sign assembly, or signing-key derivation is
 * caught at that stage — not only by a final signature mismatch that gives no clue which stage
 * broke.
 */

const VECTOR = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'service',
  amzDate: '20150830T123600Z',
  host: 'example.amazonaws.com',
  // Published `get-vanilla.creq` (the exact canonical request text).
  canonicalRequestString: [
    'GET',
    '/',
    '',
    'host:example.amazonaws.com',
    'x-amz-date:20150830T123600Z',
    '',
    'host;x-amz-date',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  ].join('\n'),
  // sha256("") — also what EMPTY_PAYLOAD_SHA256_HEX must equal.
  emptyPayloadHashHex: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  // sha256(canonicalRequestString) — the 4th line of the published `get-vanilla.sts`.
  canonicalRequestHashHex: 'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63',
  // Published `get-vanilla.sts`, verbatim.
  stringToSign: [
    'AWS4-HMAC-SHA256',
    '20150830T123600Z',
    '20150830/us-east-1/service/aws4_request',
    'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63',
  ].join('\n'),
  // Published `get-vanilla.authz` signature component.
  signatureHex: '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  credentialScope: '20150830/us-east-1/service/aws4_request',
} as const;

describe('EMPTY_PAYLOAD_SHA256_HEX', () => {
  it('equals sha256("") per the published vector', () => {
    expect(EMPTY_PAYLOAD_SHA256_HEX).toBe(VECTOR.emptyPayloadHashHex);
  });
});

describe('formatAmzDate', () => {
  it('formats an ISO instant as YYYYMMDDTHHMMSSZ', () => {
    expect(formatAmzDate(new Date('2015-08-30T12:36:00.000Z'))).toBe(VECTOR.amzDate);
  });
});

describe('buildCanonicalRequest — stage 1', () => {
  it('matches the published get-vanilla.creq exactly', () => {
    const { canonicalRequestString, signedHeaderNames } = buildCanonicalRequest({
      method: 'GET',
      canonicalUri: '/',
      canonicalQueryString: '',
      signedHeaders: { host: VECTOR.host, 'x-amz-date': VECTOR.amzDate },
      payloadHashHex: EMPTY_PAYLOAD_SHA256_HEX,
    });
    expect(canonicalRequestString).toBe(VECTOR.canonicalRequestString);
    expect(signedHeaderNames).toBe('host;x-amz-date');
  });
});

describe('buildStringToSign — stage 2', () => {
  it('matches the published get-vanilla.sts exactly, given the published canonical-request hash', () => {
    const sts = buildStringToSign({
      amzDate: VECTOR.amzDate,
      credentialScope: VECTOR.credentialScope,
      canonicalRequestHashHex: VECTOR.canonicalRequestHashHex,
    });
    expect(sts).toBe(VECTOR.stringToSign);
  });
});

describe('deriveSigningKey + calculateSignature — stage 3 + 4', () => {
  it('produces the published get-vanilla signature from the published string-to-sign', () => {
    const signingKey = deriveSigningKey(VECTOR.secretAccessKey, '20150830', VECTOR.region, VECTOR.service);
    const signature = calculateSignature(signingKey, VECTOR.stringToSign);
    expect(signature).toBe(VECTOR.signatureHex);
  });
});

describe('buildAuthorizationHeader', () => {
  it('assembles the Authorization header from the published pieces', () => {
    const header = buildAuthorizationHeader({
      accessKeyId: VECTOR.accessKeyId,
      credentialScope: VECTOR.credentialScope,
      signedHeaderNames: 'host;x-amz-date',
      signature: VECTOR.signatureHex,
    });
    expect(header).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });
});

describe('signRequest — end-to-end composition', () => {
  /**
   * `signRequest` always signs THREE headers (`host`, `x-amz-date`, `x-amz-content-sha256`) —
   * every S3-compatible backend expects `x-amz-content-sha256` to be part of `SignedHeaders`, not
   * just present on the wire. AWS's published `get-vanilla` vector above is deliberately the
   * bare two-header case (no content-hash header at all), so it doesn't apply byte-for-byte to
   * this composition. This vector extends it: same access key/secret/date/region/service/host/
   * payload as `get-vanilla`, plus the `x-amz-content-sha256` header, hand-derived with the exact
   * same algorithm (Python `hashlib`/`hmac`, independent of this module) rather than copied from
   * this code's own output — so it still catches a wiring regression (wrong header set, wrong
   * argument order into a stage) even though it isn't one of AWS's named test files.
   */
  const THREE_HEADER_VECTOR = {
    canonicalRequestHashHex: 'bd2af82b09d2569ab8594ef6bcc1638c8675cb753915d0f401b2f40ecde6f823',
    stringToSign: [
      'AWS4-HMAC-SHA256',
      '20150830T123600Z',
      '20150830/us-east-1/service/aws4_request',
      'bd2af82b09d2569ab8594ef6bcc1638c8675cb753915d0f401b2f40ecde6f823',
    ].join('\n'),
    signatureHex: '726c5c4879a6b4ccbbd3b24edbd6b8826d34f87450fbbf4e85546fc7ba9c1642',
  } as const;

  it('reproduces the hand-derived three-header vector from raw inputs alone', () => {
    const result = signRequest({
      method: 'GET',
      host: VECTOR.host,
      canonicalUri: '/',
      canonicalQueryString: '',
      body: new Uint8Array(0),
      accessKeyId: VECTOR.accessKeyId,
      secretAccessKey: VECTOR.secretAccessKey,
      region: VECTOR.region,
      service: VECTOR.service,
      date: new Date('2015-08-30T12:36:00.000Z'),
    });

    expect(result.amzDate).toBe(VECTOR.amzDate);
    expect(result.stringToSignValue).toBe(THREE_HEADER_VECTOR.stringToSign);
    expect(result.signatureHex).toBe(THREE_HEADER_VECTOR.signatureHex);
    expect(result.headers.host).toBe(VECTOR.host);
    expect(result.headers['x-amz-date']).toBe(VECTOR.amzDate);
    expect(result.headers['x-amz-content-sha256']).toBe(VECTOR.emptyPayloadHashHex);
    expect(result.headers.authorization).toBe(
      `AWS4-HMAC-SHA256 Credential=${VECTOR.accessKeyId}/${VECTOR.credentialScope}, ` +
        `SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${THREE_HEADER_VECTOR.signatureHex}`,
    );
  });
});

describe('uriEncode', () => {
  it('leaves unreserved characters untouched', () => {
    expect(uriEncode('abcXYZ019-_.~')).toBe('abcXYZ019-_.~');
  });

  it('percent-encodes reserved characters in uppercase hex', () => {
    expect(uriEncode('a b/c')).toBe('a%20b%2Fc');
  });

  it('keeps `/` literal when encodeSlash is false', () => {
    expect(uriEncode('a/b c', false)).toBe('a/b%20c');
  });
});

describe('canonicalQueryString', () => {
  it('sorts keys and encodes both keys and values', () => {
    expect(canonicalQueryString({ 'list-type': '2', prefix: 'a b/c' })).toBe('list-type=2&prefix=a%20b%2Fc');
  });

  it('produces the same string regardless of input key order', () => {
    const a = canonicalQueryString({ prefix: 'p', 'continuation-token': 't', 'list-type': '2' });
    const b = canonicalQueryString({ 'list-type': '2', 'continuation-token': 't', prefix: 'p' });
    expect(a).toBe(b);
    expect(a).toBe('continuation-token=t&list-type=2&prefix=p');
  });
});
