import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLUSTER_PROTOCOL,
  type ClusterJoinRequest,
  type ClusterJoinResponse,
  type ClusterProtocol,
  type StoredClusterNodeIdentity,
} from '@loki-labs/better-cezar-contract';

/**
 * `cluster/enrollment.ts` (package 1.2, spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`,
 * D17 + "Security and blast radius"). Mirrors `auth/org-claim-token.test.ts`'s shape for the
 * digest contract it reuses, plus `supervisor/forwarded-principal.test.ts`'s shape for the frame
 * signature it reuses.
 *
 * `cluster/node-identity.ts` (package 1.1) is mocked below, and stays mocked. **Corrected
 * 2026-08-23:** the original reason was that 1.1 was a sibling package under construction and every
 * one of its exports still threw `not implemented` — that is no longer true, 1.1 is implemented and
 * has its own suite. The mock stays for the reason that outlives the construction: it keeps this
 * file exercising enrollment.ts's OWN logic, so a regression in identity-file handling fails 1.1's
 * tests and not also these. The mock is a faithful re-implementation of what 1.1's doc comments
 * promise (`~/.cezar/cluster/node.json`, `.passthrough()`, labels/acceptsDispatch preserved across
 * writes), not a stand-in that asserts nothing.
 */

let homeDir: string;

function identityFilePath(): string {
  return join(homeDir, 'node.json');
}

function readIdentityFile(): StoredClusterNodeIdentity | undefined {
  if (!existsSync(identityFilePath())) return undefined;
  try {
    return JSON.parse(readFileSync(identityFilePath(), 'utf8')) as StoredClusterNodeIdentity;
  } catch {
    return undefined;
  }
}

function seedHubIdentity(nodeId = 'hub-1'): void {
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(
    identityFilePath(),
    JSON.stringify({
      nodeId,
      nodeName: 'hub',
      createdAt: '2026-01-01T00:00:00.000Z',
      role: 'hub',
      acceptsDispatch: false,
      labels: [],
    }),
  );
}

vi.mock('./node-identity.ts', () => ({
  clusterHomeDir: (): string => homeDir,
  nodeIdentityPath: (): string => identityFilePath(),
  loadNodeIdentity: async (): Promise<StoredClusterNodeIdentity | undefined> => readIdentityFile(),
  ensureNodeIdentity: async (input: {
    role: 'hub' | 'spoke';
    nodeName?: string;
    hubUrl?: string;
  }): Promise<StoredClusterNodeIdentity> => {
    const existing = readIdentityFile();
    const identity: StoredClusterNodeIdentity = {
      nodeId: existing?.nodeId ?? `node-${Math.random().toString(36).slice(2, 10)}`,
      nodeName: input.nodeName ?? existing?.nodeName ?? 'test-node',
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      role: input.role,
      hubUrl: input.hubUrl ?? existing?.hubUrl,
      secret: existing?.secret,
      acceptsDispatch: existing?.acceptsDispatch ?? false,
      labels: existing?.labels ?? ['macos', 'browser'],
    };
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(identityFilePath(), JSON.stringify(identity), { mode: 0o600 });
    return identity;
  },
}));

import {
  ENROLLMENT_CODE_TTL_MS,
  LINK_PRINCIPAL_MAX_AGE_MS,
  createEnrollmentCode,
  enrollmentCodesPath,
  hashEnrollmentCode,
  joinCluster,
  leaveCluster,
  matchesEnrollmentCode,
  mintEnrollmentCode,
  parseEnrollmentCode,
  persistNodeCredential,
  redeemEnrollmentCode,
  renderJoinCommands,
  revokeEnrollmentCode,
  signClusterFrame,
  verifyClusterFrame,
} from './enrollment.ts';
import { lookupNodeSecret } from './node-secrets.ts';

beforeEach(() => {
  homeDir = mkdtempSync(join(realpathSync(tmpdir()), 'cez-enrollment-'));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe('mintEnrollmentCode / parseEnrollmentCode', () => {
  it('round-trips the hub URL and a fresh secret through the cezj_ prefix', () => {
    const code = mintEnrollmentCode('https://cezar.example.com');
    expect(code.startsWith('cezj_')).toBe(true);
    const parsed = parseEnrollmentCode(code);
    expect(parsed?.hubUrl).toBe('https://cezar.example.com');
    expect(parsed?.secret).toMatch(/^[0-9a-f]{32}$/);
  });

  it('mints a different secret every time, even for the same hub', () => {
    const a = mintEnrollmentCode('https://cezar.example.com');
    const b = mintEnrollmentCode('https://cezar.example.com');
    expect(a).not.toBe(b);
  });

  it('returns undefined for anything this cezar did not mint — never honoured as an instruction', () => {
    const badHubUrl = Buffer.from(JSON.stringify({ hubUrl: 'not a url', secret: 'x' }), 'utf8').toString('base64url');
    const noSecret = Buffer.from(JSON.stringify({ hubUrl: 'https://hub.example' }), 'utf8').toString('base64url');
    const notJson = Buffer.from('"just a string"', 'utf8').toString('base64url');
    for (const bad of ['', 'not-a-code', 'cezj_', 'cezj_not-base64url!!', `cezj_${notJson}`, `cezj_${badHubUrl}`, `cezj_${noSecret}`]) {
      expect(parseEnrollmentCode(bad)).toBeUndefined();
    }
  });
});

describe('hashEnrollmentCode / matchesEnrollmentCode', () => {
  it('is deterministic and produces a 64-hex-char digest — same idiom as hashOrgClaimToken', () => {
    const code = mintEnrollmentCode('https://hub.example');
    expect(hashEnrollmentCode(code)).toBe(hashEnrollmentCode(code));
    expect(hashEnrollmentCode(code)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('two different codes hash to two different digests', () => {
    const a = mintEnrollmentCode('https://hub.example');
    const b = mintEnrollmentCode('https://hub.example');
    expect(hashEnrollmentCode(a)).not.toBe(hashEnrollmentCode(b));
  });

  it('matchesEnrollmentCode accepts the exact code and rejects everything else, never throwing', () => {
    const code = mintEnrollmentCode('https://hub.example');
    const hash = hashEnrollmentCode(code);
    expect(matchesEnrollmentCode(hash, code)).toBe(true);
    for (const supplied of [undefined, '', 'wrong', code.toUpperCase(), `${code}x`, code.slice(0, -1)]) {
      expect(matchesEnrollmentCode(hash, supplied)).toBe(false);
    }
  });
});

describe('renderJoinCommands', () => {
  it('pins the hub version and embeds only the opaque code — the spec\'s exact shape', () => {
    const commands = renderJoinCommands({ code: 'cezj_abc', hubUrl: 'https://hub.example', hubVersion: '0.10.0' });
    expect(commands.join).toBe('npx -y @loki-labs/better-cezar@0.10.0 cluster join cezj_abc');
    expect(commands.provision).toBe(
      'npx -y @loki-labs/better-cezar@0.10.0 server-install --platform hetzner --role worker --join cezj_abc',
    );
  });

  it('never renders the hub URL as a separate argument — it only ever rides inside the opaque code', () => {
    const commands = renderJoinCommands({ code: 'cezj_abc', hubUrl: 'https://hub.example', hubVersion: '0.10.0' });
    expect(commands.join).not.toContain('hub.example');
    expect(commands.provision).not.toContain('hub.example');
  });

  // NEGATIVE CONTROL (the assertion package 1b.3 owes, per the module docblock): a fixture where a
  // real Access client id and secret are BOTH in the environment must not leak into the rendered
  // string. A test that only checks the happy shape passes just as well against a command that
  // leaks; this one would catch a future "helpfully" embed it.
  it('never contains an Access client id or secret, even when both are set in the environment', () => {
    const savedId = process.env.TUNNEL_SERVICE_TOKEN_ID;
    const savedSecret = process.env.TUNNEL_SERVICE_TOKEN_SECRET;
    process.env.TUNNEL_SERVICE_TOKEN_ID = 'access-client-id-must-never-appear';
    process.env.TUNNEL_SERVICE_TOKEN_SECRET = 'access-client-secret-must-never-appear';
    try {
      const commands = renderJoinCommands({ code: 'cezj_abc', hubUrl: 'https://hub.example', hubVersion: '0.10.0' });
      const rendered = JSON.stringify(commands);
      expect(rendered).not.toContain(process.env.TUNNEL_SERVICE_TOKEN_ID);
      expect(rendered).not.toContain(process.env.TUNNEL_SERVICE_TOKEN_SECRET);
    } finally {
      if (savedId === undefined) delete process.env.TUNNEL_SERVICE_TOKEN_ID;
      else process.env.TUNNEL_SERVICE_TOKEN_ID = savedId;
      if (savedSecret === undefined) delete process.env.TUNNEL_SERVICE_TOKEN_SECRET;
      else process.env.TUNNEL_SERVICE_TOKEN_SECRET = savedSecret;
    }
  });
});

describe('enrollmentCodesPath', () => {
  it('lives under the cluster home directory as enroll-codes.json', () => {
    expect(enrollmentCodesPath()).toBe(join(homeDir, 'enroll-codes.json'));
  });
});

describe('createEnrollmentCode', () => {
  it('defaults to the 15-minute TTL when none is given', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const { record } = await createEnrollmentCode({ hubUrl: 'https://hub.example', hubVersion: '0.10.0' }, { now: () => now });
    expect(record.expiresAt).toBe(new Date(now.getTime() + ENROLLMENT_CODE_TTL_MS).toISOString());
  });

  it('honours a custom ttlSeconds', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const { record } = await createEnrollmentCode(
      { hubUrl: 'https://hub.example', hubVersion: '0.10.0', ttlSeconds: 60 },
      { now: () => now },
    );
    expect(record.expiresAt).toBe(new Date(now.getTime() + 60_000).toISOString());
  });

  // NEGATIVE CONTROL 1 (per the task brief): the raw code is never persisted, in memory or on disk —
  // only its digest is. Asserting "redeem works" alone passes against code that stores the code in
  // the clear; this checks the record AND the actual file written to the sandboxed home dir.
  it('returns the raw code exactly once and persists only its SHA-256 digest', async () => {
    const { response, record } = await createEnrollmentCode({
      hubUrl: 'https://cezar.example.com',
      hubVersion: '0.10.0',
      nodeName: 'worker-2',
    });

    expect(response.code.startsWith('cezj_')).toBe(true);
    expect(record.codeHash).toBe(hashEnrollmentCode(response.code));
    expect('code' in record).toBe(false);
    expect(JSON.stringify(record)).not.toContain(response.code);

    const onDisk = readFileSync(enrollmentCodesPath(), 'utf8');
    expect(onDisk).not.toContain(response.code);
    expect(onDisk).toContain(record.codeHash);
  });
});

describe('revokeEnrollmentCode', () => {
  it('revokes an unredeemed code', async () => {
    const { record } = await createEnrollmentCode({ hubUrl: 'https://hub.example', hubVersion: '0.10.0' });
    expect(await revokeEnrollmentCode(record.codeId)).toBe(true);
  });

  it('is idempotent — revoking an already-revoked code still reports true', async () => {
    const { record } = await createEnrollmentCode({ hubUrl: 'https://hub.example', hubVersion: '0.10.0' });
    expect(await revokeEnrollmentCode(record.codeId)).toBe(true);
    expect(await revokeEnrollmentCode(record.codeId)).toBe(true);
  });

  it('returns false for a code that does not exist', async () => {
    expect(await revokeEnrollmentCode('no-such-code-id')).toBe(false);
  });
});

describe('redeemEnrollmentCode', () => {
  const protocol: ClusterProtocol = CLUSTER_PROTOCOL;

  function joinRequest(code: string, overrides: Partial<ClusterJoinRequest> = {}): ClusterJoinRequest {
    return {
      code,
      nodeId: 'spoke-1',
      nodeName: 'worker-2',
      labels: ['linux'],
      protocol,
      version: '0.10.0',
      ...overrides,
    };
  }

  beforeEach(() => {
    seedHubIdentity();
  });

  it('redeems a fresh code and returns a per-node secret', async () => {
    const { response } = await createEnrollmentCode({ hubUrl: 'https://hub.example', hubVersion: '0.10.0' });
    const result = await redeemEnrollmentCode(joinRequest(response.code));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hubNodeId).toBe('hub-1');
      expect(result.nodeId).toBe('spoke-1');
      expect(result.hubUrl).toBe('https://hub.example');
      expect(result.secret.length).toBeGreaterThan(0);
      expect(result.protocol).toEqual(protocol);
    }
  });

  // Spec Verification 23: the STORED secret is the exact value handed to the spoke — asserting the
  // value, not merely that node-secrets.json exists, is the whole point of this test.
  it('persists the exact secret handed to the spoke, readable back via node-secrets.ts (Verification 23)', async () => {
    const { response } = await createEnrollmentCode({ hubUrl: 'https://hub.example', hubVersion: '0.10.0' });
    const result = await redeemEnrollmentCode(joinRequest(response.code));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = await lookupNodeSecret('spoke-1');
    expect(stored).toBe(result.secret);
  });

  // Spec Verification 25: the write order D22 pins is secret-first, code-second, and this is the
  // test that PROVES that ordering rather than restating it. The enroll-codes write's own tmp path
  // is pre-occupied by a directory, so `writeEnrollCodes`'s `writeFileSync` throws EISDIR — while
  // `storeNodeSecret`'s differently-named tmp file is completely unaffected, so a write-order bug
  // (redeem-first) would make this test's "still redeems afterwards" assertion fail: the code would
  // already be burned.
  it('ordering negative control: an enroll-codes write failing AFTER the secret write leaves the code unredeemed and still redeemable (Verification 25)', async () => {
    const { response } = await createEnrollmentCode({ hubUrl: 'https://hub.example', hubVersion: '0.10.0' });

    const blockedTmp = `${enrollmentCodesPath()}.tmp`;
    mkdirSync(blockedTmp, { recursive: true });
    try {
      await expect(redeemEnrollmentCode(joinRequest(response.code))).rejects.toThrow();
    } finally {
      rmSync(blockedTmp, { recursive: true, force: true });
    }

    // The secret write ran FIRST and completed — an inert orphan, exactly D22's chosen failure.
    expect(await lookupNodeSecret('spoke-1')).toBeDefined();

    // The code write never completed (writeEnrollCodes threw before its renameSync), so the SAME
    // code is still redeemable — the direct evidence that it was never marked redeemed.
    const retried = await redeemEnrollmentCode(joinRequest(response.code));
    expect(retried.ok).toBe(true);
  });

  // NEGATIVE CONTROL 2: single-use really is single-use — the second redemption of the SAME code
  // returns the `code-used` VALUE, not a generic failure.
  it('a second redemption of the same code returns code-used, not a generic failure', async () => {
    const { response } = await createEnrollmentCode({ hubUrl: 'https://hub.example', hubVersion: '0.10.0' });
    const first = await redeemEnrollmentCode(joinRequest(response.code));
    expect(first.ok).toBe(true);
    const second = await redeemEnrollmentCode(joinRequest(response.code, { nodeId: 'spoke-2' }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('code-used');
  });

  // NEGATIVE CONTROL 3: expiry is enforced on the SERVER's clock. `ClusterJoinRequest` carries no
  // client-claimed freshness field at all, so the only clock in play is `options.now` — this proves
  // moving THAT clock past `expiresAt` is what flips the outcome, on an otherwise byte-identical
  // request.
  it('expiry is decided by the redeemer\'s own clock, on an unchanged request', async () => {
    const mintedAt = new Date('2026-01-01T00:00:00.000Z');
    const { response } = await createEnrollmentCode(
      { hubUrl: 'https://hub.example', hubVersion: '0.10.0', ttlSeconds: 60 },
      { now: () => mintedAt },
    );
    const request = joinRequest(response.code);

    const justBeforeExpiry = new Date(mintedAt.getTime() + 59_000);
    const stillGood = await redeemEnrollmentCode(request, { now: () => justBeforeExpiry });
    expect(stillGood.ok).toBe(true);
  });

  it('the SAME code, redeemed after its expiry, returns code-expired', async () => {
    const mintedAt = new Date('2026-01-01T00:00:00.000Z');
    const { response } = await createEnrollmentCode(
      { hubUrl: 'https://hub.example', hubVersion: '0.10.0', ttlSeconds: 60 },
      { now: () => mintedAt },
    );
    const afterExpiry = new Date(mintedAt.getTime() + 61_000);
    const result = await redeemEnrollmentCode(joinRequest(response.code), { now: () => afterExpiry });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('code-expired');
  });

  // NEGATIVE CONTROL 4: revocation beats redemption.
  it('revoke, then redeem, and it fails', async () => {
    const { response, record } = await createEnrollmentCode({ hubUrl: 'https://hub.example', hubVersion: '0.10.0' });
    expect(await revokeEnrollmentCode(record.codeId)).toBe(true);
    const result = await redeemEnrollmentCode(joinRequest(response.code));
    expect(result.ok).toBe(false);
  });

  it('revokeEnrollmentCode itself returns false — not "revoked" — once a code is already redeemed', async () => {
    const { response, record } = await createEnrollmentCode({ hubUrl: 'https://hub.example', hubVersion: '0.10.0' });
    const redeemed = await redeemEnrollmentCode(joinRequest(response.code));
    expect(redeemed.ok).toBe(true);
    expect(await revokeEnrollmentCode(record.codeId)).toBe(false);
  });

  it('a code this hub never minted is refused, never accepted', async () => {
    const foreignCode = mintEnrollmentCode('https://hub.example');
    const result = await redeemEnrollmentCode(joinRequest(foreignCode));
    expect(result.ok).toBe(false);
  });

  it('refuses a protocol MAJOR mismatch by its own named reason, before even looking at the code', async () => {
    const { response } = await createEnrollmentCode({ hubUrl: 'https://hub.example', hubVersion: '0.10.0' });
    const result = await redeemEnrollmentCode(
      joinRequest(response.code, { protocol: { major: protocol.major + 1, minor: 0 } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('protocol-major');
  });
});

describe('joinCluster', () => {
  const protocol: ClusterProtocol = CLUSTER_PROTOCOL;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // The `not.toHaveBeenCalled()` line is the whole point of this case, and it is what condemned the
  // reason this test originally asserted: it PROVES no request left the process, so answering
  // `hub-unreachable` would be a claim about DNS, the tunnel and Access made without touching any
  // of them. `code-malformed` is also the only enrollment failure the operator reading it can fix
  // alone, which is the rule `clusterJoinFailureReasonSchema` splits members on.
  it('refuses a malformed code as code-malformed, without making any network call', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await joinCluster({ code: 'not-a-real-code', protocol });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('code-malformed');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Negative control on the pair, so the two never collapse back into one value: a code that parses
  // and names a hub that genuinely cannot be dialled DOES answer `hub-unreachable`, and it gets
  // there by actually attempting the call. Without this, narrowing every failure to `code-malformed`
  // would pass the case above.
  it('still answers hub-unreachable for a well-formed code whose hub cannot be dialled', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await joinCluster({ code: mintEnrollmentCode('https://hub.invalid'), protocol });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('hub-unreachable');
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('dials the hub URL packed into the code and persists the returned secret', async () => {
    const code = mintEnrollmentCode('https://hub.example');
    const okResponse: ClusterJoinResponse = {
      ok: true,
      nodeId: 'spoke-9',
      hubNodeId: 'hub-1',
      hubUrl: 'https://hub.example',
      secret: 'deadbeef'.repeat(4),
      protocol,
    };
    let capturedUrl = '';
    let capturedBody: ClusterJoinRequest | undefined;
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body)) as ClusterJoinRequest;
      return new Response(JSON.stringify(okResponse), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await joinCluster({ code, nodeName: 'worker-2', protocol });

    expect(capturedUrl).toBe('https://hub.example/api/v1/cluster/join');
    expect(capturedBody?.code).toBe(code);
    expect(capturedBody?.nodeName).toBe('worker-2');
    expect(result).toEqual(okResponse);

    const persisted = readIdentityFile();
    expect(persisted?.secret).toBe(okResponse.secret);
    expect(persisted?.hubUrl).toBe('https://hub.example');
  });

  it('a Cloudflare Access redirect is reported as access-rejected', async () => {
    const code = mintEnrollmentCode('https://hub.example');
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 302 })) as unknown as typeof fetch;
    const result = await joinCluster({ code, protocol });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('access-rejected');
  });

  it('a 403 from Access is also access-rejected', async () => {
    const code = mintEnrollmentCode('https://hub.example');
    globalThis.fetch = vi.fn(async () => new Response('Forbidden', { status: 403 })) as unknown as typeof fetch;
    const result = await joinCluster({ code, protocol });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('access-rejected');
  });

  it('a network failure is hub-unreachable, never access-rejected — the two gates stay distinct', async () => {
    const code = mintEnrollmentCode('https://hub.example');
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const result = await joinCluster({ code, protocol });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('hub-unreachable');
  });

  it('a hub-side refusal is passed through verbatim, never remapped to a different reason', async () => {
    const code = mintEnrollmentCode('https://hub.example');
    const refusal: ClusterJoinResponse = { ok: false, reason: 'code-expired' };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(refusal), { status: 200 })) as unknown as typeof fetch;
    const result = await joinCluster({ code, protocol });
    expect(result).toEqual(refusal);
  });

  it('a response this node cannot parse is reported as protocol-major', async () => {
    const code = mintEnrollmentCode('https://hub.example');
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ garbage: true }), { status: 200 })) as unknown as typeof fetch;
    const result = await joinCluster({ code, protocol });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('protocol-major');
  });
});

describe('leaveCluster', () => {
  it('deletes the node credential file, so a later verify has nothing to check against', async () => {
    await persistNodeCredential({ nodeId: 'spoke-1', hubUrl: 'https://hub.example', secret: 'abc' });
    expect(existsSync(identityFilePath())).toBe(true);
    await leaveCluster();
    expect(existsSync(identityFilePath())).toBe(false);
  });

  it('leaving a cluster this node was never in is not an error', async () => {
    await expect(leaveCluster()).resolves.toBeUndefined();
  });
});

describe('persistNodeCredential', () => {
  it('writes the secret at 0600 and preserves labels/acceptsDispatch already on disk', async () => {
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      identityFilePath(),
      JSON.stringify({
        nodeId: 'spoke-1',
        nodeName: 'worker-2',
        createdAt: '2026-01-01T00:00:00.000Z',
        role: 'spoke',
        acceptsDispatch: true,
        labels: ['macos', 'browser'],
      }),
    );

    const identity = await persistNodeCredential({ nodeId: 'spoke-1', hubUrl: 'https://hub.example', secret: 'topsecret' });

    expect(identity.secret).toBe('topsecret');
    expect(identity.acceptsDispatch).toBe(true);
    expect(identity.labels).toEqual(['macos', 'browser']);
    expect(identity.createdAt).toBe('2026-01-01T00:00:00.000Z');

    const mode = statSync(identityFilePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates a fresh record when none exists yet', async () => {
    const identity = await persistNodeCredential({ nodeId: 'spoke-1', hubUrl: 'https://hub.example', secret: 'topsecret' });
    expect(identity.acceptsDispatch).toBe(false);
    expect(identity.labels).toEqual([]);
    expect(identity.role).toBe('spoke');
  });
});

describe('signClusterFrame / verifyClusterFrame', () => {
  const secret = 'link-secret';

  it('round-trips a fresh, correctly signed principal', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const signed = signClusterFrame({ nodeId: 'spoke-1', issuedAt: now.toISOString() }, secret);
    const verified = verifyClusterFrame(signed, secret, { now: () => now });
    expect(verified).toEqual({ nodeId: 'spoke-1', issuedAt: now.toISOString() });
  });

  it('returns null for a tampered principal — the claim must be unforgeable', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const signed = signClusterFrame({ nodeId: 'spoke-1', issuedAt: now.toISOString() }, secret);
    const tamperedPrincipal = Buffer.from(JSON.stringify({ nodeId: 'attacker', issuedAt: now.toISOString() }), 'utf8').toString(
      'base64url',
    );
    expect(verifyClusterFrame({ principal: tamperedPrincipal, signature: signed.signature }, secret, { now: () => now })).toBeNull();
  });

  it('returns null when verified with the wrong secret', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const signed = signClusterFrame({ nodeId: 'spoke-1', issuedAt: now.toISOString() }, secret);
    expect(verifyClusterFrame(signed, 'a-different-secret', { now: () => now })).toBeNull();
  });

  it('returns null once the principal is older than maxAgeMs', () => {
    const issuedAt = new Date('2026-01-01T00:00:00.000Z');
    const signed = signClusterFrame({ nodeId: 'spoke-1', issuedAt: issuedAt.toISOString() }, secret);
    const later = new Date(issuedAt.getTime() + LINK_PRINCIPAL_MAX_AGE_MS + 1);
    expect(verifyClusterFrame(signed, secret, { now: () => later })).toBeNull();
  });

  it('still verifies one second before maxAgeMs elapses', () => {
    const issuedAt = new Date('2026-01-01T00:00:00.000Z');
    const signed = signClusterFrame({ nodeId: 'spoke-1', issuedAt: issuedAt.toISOString() }, secret);
    const justBefore = new Date(issuedAt.getTime() + LINK_PRINCIPAL_MAX_AGE_MS - 1_000);
    expect(verifyClusterFrame(signed, secret, { now: () => justBefore })).not.toBeNull();
  });

  it('returns null for a principal claiming to be from the future', () => {
    const issuedAt = new Date('2026-01-01T00:10:00.000Z');
    const signed = signClusterFrame({ nodeId: 'spoke-1', issuedAt: issuedAt.toISOString() }, secret);
    const earlier = new Date('2026-01-01T00:00:00.000Z');
    expect(verifyClusterFrame(signed, secret, { now: () => earlier })).toBeNull();
  });

  it('never throws — missing, empty, or malformed input all return null', () => {
    expect(verifyClusterFrame(undefined, secret)).toBeNull();
    expect(verifyClusterFrame({}, secret)).toBeNull();
    expect(verifyClusterFrame({ principal: 'x', signature: 'y' }, secret)).toBeNull();
    expect(verifyClusterFrame({ principal: 'x', signature: 'y' }, '')).toBeNull();
  });
});
