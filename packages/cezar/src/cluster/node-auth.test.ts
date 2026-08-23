import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  CLUSTER_NODE_ID_HEADER,
  CLUSTER_NODE_PRINCIPAL_HEADER,
  CLUSTER_NODE_SIGNATURE_HEADER,
  createNodeAuthMiddleware,
  getAuthenticatedClusterNode,
  hashRequestBody,
  signNodeHttpPrincipal,
  verifyNodeHttpPrincipal,
  type NodeHttpPrincipal,
} from './node-auth.ts';

const NODE_ID = 'node-a';
const OTHER_NODE_ID = 'node-b';
const SECRET = 'shhh-secret';
const OTHER_SECRET = 'a-different-secret';

function principalFor(overrides: Partial<NodeHttpPrincipal> = {}): NodeHttpPrincipal {
  return {
    nodeId: NODE_ID,
    issuedAt: new Date().toISOString(),
    method: 'GET',
    path: '/api/v1/cluster/corpus',
    bodyHash: hashRequestBody(''),
    ...overrides,
  };
}

function bindingFor(principal: NodeHttpPrincipal) {
  return { method: principal.method, path: principal.path, bodyHash: principal.bodyHash };
}

describe('verifyNodeHttpPrincipal', () => {
  const lookup = async (nodeId: string) => (nodeId === NODE_ID ? SECRET : undefined);

  it('admits a correctly signed, fresh, request-bound principal and reports the real caller', async () => {
    const principal = principalFor();
    const signed = signNodeHttpPrincipal(principal, SECRET);
    const verdict = verifyNodeHttpPrincipal(signed, principal.nodeId, await lookup(principal.nodeId), bindingFor(principal));
    expect(verdict).toEqual({ ok: true, nodeId: NODE_ID });
  });

  it('refuses with no-credentials when no headers are presented at all', () => {
    const binding = { method: 'GET', path: '/api/v1/cluster/corpus', bodyHash: hashRequestBody('') };
    expect(verifyNodeHttpPrincipal(undefined, undefined, undefined, binding)).toEqual({
      ok: false,
      reason: 'no-credentials',
    });
  });

  it('refuses with no-credentials when only some of the three headers are presented', () => {
    const principal = principalFor();
    const signed = signNodeHttpPrincipal(principal, SECRET);
    const binding = bindingFor(principal);
    // principal present, signature missing
    expect(verifyNodeHttpPrincipal({ principal: signed.principal }, principal.nodeId, SECRET, binding)).toEqual({
      ok: false,
      reason: 'no-credentials',
    });
    // claimed node id missing
    expect(verifyNodeHttpPrincipal(signed, undefined, SECRET, binding)).toEqual({
      ok: false,
      reason: 'no-credentials',
    });
  });

  it('refuses with unknown-node when the claimed node has no secret on file', async () => {
    const principal = principalFor({ nodeId: 'ghost-node' });
    const signed = signNodeHttpPrincipal(principal, SECRET);
    const secret = await lookup('ghost-node');
    expect(verifyNodeHttpPrincipal(signed, 'ghost-node', secret, bindingFor(principal))).toEqual({
      ok: false,
      reason: 'unknown-node',
    });
  });

  it('refuses with bad-signature when the secret used to sign does not match the one on file', () => {
    const principal = principalFor();
    const signed = signNodeHttpPrincipal(principal, OTHER_SECRET); // signed with the WRONG secret
    expect(verifyNodeHttpPrincipal(signed, principal.nodeId, SECRET, bindingFor(principal))).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses with bad-signature when the signature bytes are tampered', () => {
    const principal = principalFor();
    const signed = signNodeHttpPrincipal(principal, SECRET);
    const tampered = { principal: signed.principal, signature: `${signed.signature.slice(0, -2)}zz` };
    expect(verifyNodeHttpPrincipal(tampered, principal.nodeId, SECRET, bindingFor(principal))).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses with bad-signature when the outer claimed node-id header disagrees with the signed one', () => {
    const principal = principalFor({ nodeId: NODE_ID });
    const signed = signNodeHttpPrincipal(principal, SECRET);
    // Attacker relabels the unsigned lookup header to pose as a different node while replaying A's
    // genuine signature — this picks node B's secret, which the HMAC was never computed with.
    expect(verifyNodeHttpPrincipal(signed, OTHER_NODE_ID, OTHER_SECRET, bindingFor(principal))).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('tamper: same signature, altered path — refused as bad-signature, not silently admitted', () => {
    const principal = principalFor({ path: '/api/v1/cluster/corpus' });
    const signed = signNodeHttpPrincipal(principal, SECRET);
    const tamperedBinding = { ...bindingFor(principal), path: '/api/v1/cluster/corpus/knowledge/secrets.md' };
    expect(verifyNodeHttpPrincipal(signed, principal.nodeId, SECRET, tamperedBinding)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('tamper: same signature, altered body — refused as bad-signature', () => {
    const principal = principalFor({ method: 'POST', path: '/api/v1/cluster/corpus/submit', bodyHash: hashRequestBody('original') });
    const signed = signNodeHttpPrincipal(principal, SECRET);
    const tamperedBinding = { ...bindingFor(principal), bodyHash: hashRequestBody('swapped-out') };
    expect(verifyNodeHttpPrincipal(signed, principal.nodeId, SECRET, tamperedBinding)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('tamper: same signature, altered node id embedded in the payload — refused as bad-signature', () => {
    // A payload cannot be edited without invalidating the HMAC, so this is exercised via a
    // hand-built signature over a DIFFERENT payload than the one presented — the shape an attacker
    // who could forge a payload would need, and it must still fail.
    const principal = principalFor({ nodeId: NODE_ID });
    const forgedPrincipal = principalFor({ nodeId: OTHER_NODE_ID });
    const signed = signNodeHttpPrincipal(principal, SECRET); // signature is over NODE_ID's payload
    // Presented as if it were OTHER_NODE_ID's, using OTHER_NODE_ID's own (different) secret and
    // header — the signature won't match what OTHER_SECRET would produce for the forged payload.
    expect(
      verifyNodeHttpPrincipal(
        { principal: signed.principal, signature: signed.signature },
        forgedPrincipal.nodeId,
        OTHER_SECRET,
        bindingFor(forgedPrincipal),
      ),
    ).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('replay: a genuinely valid, unaltered principal outside the freshness window is refused as stale-principal, not bad-signature', () => {
    const issuedAt = new Date('2026-01-01T00:00:00.000Z');
    const principal = principalFor({ issuedAt: issuedAt.toISOString() });
    const signed = signNodeHttpPrincipal(principal, SECRET);
    const justInsideWindow = new Date(issuedAt.getTime() + 100_000); // < 120s default
    const justOutsideWindow = new Date(issuedAt.getTime() + 130_000); // > 120s default

    expect(
      verifyNodeHttpPrincipal(signed, principal.nodeId, SECRET, bindingFor(principal), { now: () => justInsideWindow }),
    ).toEqual({ ok: true, nodeId: NODE_ID });

    expect(
      verifyNodeHttpPrincipal(signed, principal.nodeId, SECRET, bindingFor(principal), { now: () => justOutsideWindow }),
    ).toEqual({ ok: false, reason: 'stale-principal' });
  });

  it('refuses an issuedAt claiming to be from the future, past the same window, as stale-principal', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const principal = principalFor({ issuedAt: new Date(now.getTime() + 130_000).toISOString() });
    const signed = signNodeHttpPrincipal(principal, SECRET);
    expect(
      verifyNodeHttpPrincipal(signed, principal.nodeId, SECRET, bindingFor(principal), { now: () => now }),
    ).toEqual({ ok: false, reason: 'stale-principal' });
  });

  it('honours a custom maxAgeMs override', () => {
    const issuedAt = new Date('2026-01-01T00:00:00.000Z');
    const principal = principalFor({ issuedAt: issuedAt.toISOString() });
    const signed = signNodeHttpPrincipal(principal, SECRET);
    const oneSecondLater = new Date(issuedAt.getTime() + 1_000);
    expect(
      verifyNodeHttpPrincipal(signed, principal.nodeId, SECRET, bindingFor(principal), {
        now: () => oneSecondLater,
        maxAgeMs: 500,
      }),
    ).toEqual({ ok: false, reason: 'stale-principal' });
  });
});

describe('hashRequestBody', () => {
  it('is deterministic and distinguishes different bodies, including the empty one', () => {
    expect(hashRequestBody('')).toBe(hashRequestBody(''));
    expect(hashRequestBody('a')).not.toBe(hashRequestBody('b'));
    expect(hashRequestBody('')).not.toBe(hashRequestBody('a'));
  });
});

describe('createNodeAuthMiddleware (as real Hono middleware)', () => {
  function appWith(lookupSecret: (nodeId: string) => Promise<string | undefined>, now?: () => Date) {
    const app = new Hono();
    app.use('/gated/*', createNodeAuthMiddleware({ lookupSecret, ...(now ? { now } : {}) }));
    app.get('/gated/thing', (c) => {
      const node = getAuthenticatedClusterNode(c);
      return c.json({ nodeId: node?.nodeId ?? null });
    });
    app.post('/gated/thing', async (c) => {
      const node = getAuthenticatedClusterNode(c);
      const body = await c.req.json().catch(() => null);
      return c.json({ nodeId: node?.nodeId ?? null, body });
    });
    return app;
  }

  function headersFor(principal: NodeHttpPrincipal, secret: string): Record<string, string> {
    const signed = signNodeHttpPrincipal(principal, secret);
    return {
      [CLUSTER_NODE_ID_HEADER]: principal.nodeId,
      [CLUSTER_NODE_PRINCIPAL_HEADER]: signed.principal,
      [CLUSTER_NODE_SIGNATURE_HEADER]: signed.signature,
    };
  }

  it('floor: a correctly signed request reaches the handler, which reads the real caller identity — not just a 200', async () => {
    const app = appWith(async (nodeId) => (nodeId === NODE_ID ? SECRET : undefined));
    const principal = principalFor({ path: '/gated/thing' });
    const res = await app.request('/gated/thing', { headers: headersFor(principal, SECRET) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodeId: string | null };
    expect(body.nodeId).toBe(NODE_ID); // the assertion that matters: identity, not just status
  });

  it('refuses an unauthenticated request with 401 no-credentials', async () => {
    const app = appWith(async () => SECRET);
    const res = await app.request('/gated/thing');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason: string }).reason).toBe('no-credentials');
  });

  it('refuses an unenrolled node with 401 unknown-node', async () => {
    const app = appWith(async () => undefined);
    const principal = principalFor({ path: '/gated/thing' });
    const res = await app.request('/gated/thing', { headers: headersFor(principal, SECRET) });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason: string }).reason).toBe('unknown-node');
  });

  it('binds the POST body: a tampered body on an otherwise-valid signed request is refused, and the downstream handler never sees a mismatched body silently pass', async () => {
    const app = appWith(async (nodeId) => (nodeId === NODE_ID ? SECRET : undefined));
    const originalBody = JSON.stringify({ path: 'knowledge/x.md', body: 'original' });
    const principal = principalFor({
      method: 'POST',
      path: '/gated/thing',
      bodyHash: hashRequestBody(originalBody),
    });
    const res = await app.request('/gated/thing', {
      method: 'POST',
      headers: { ...headersFor(principal, SECRET), 'content-type': 'application/json' },
      // The ACTUAL body sent differs from what was signed for — the tamper case.
      body: JSON.stringify({ path: 'knowledge/x.md', body: 'swapped' }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason: string }).reason).toBe('bad-signature');
  });

  it('does not break a downstream JSON body validator: the body is still readable after the middleware ran', async () => {
    const app = appWith(async (nodeId) => (nodeId === NODE_ID ? SECRET : undefined));
    const bodyText = JSON.stringify({ hello: 'world' });
    const principal = principalFor({ method: 'POST', path: '/gated/thing', bodyHash: hashRequestBody(bodyText) });
    const res = await app.request('/gated/thing', {
      method: 'POST',
      headers: { ...headersFor(principal, SECRET), 'content-type': 'application/json' },
      body: bodyText,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodeId: string | null; body: unknown };
    expect(body.nodeId).toBe(NODE_ID);
    expect(body.body).toEqual({ hello: 'world' }); // proves `c.req.json()` still worked downstream
  });

  it('replay through the real middleware: a captured, valid pair outside the freshness window is refused as stale-principal', async () => {
    const issuedAt = new Date('2026-01-01T00:00:00.000Z');
    let now = issuedAt;
    const app = appWith(async (nodeId) => (nodeId === NODE_ID ? SECRET : undefined), () => now);
    const principal = principalFor({ path: '/gated/thing', issuedAt: issuedAt.toISOString() });
    const headers = headersFor(principal, SECRET);

    now = new Date(issuedAt.getTime() + 30_000);
    const fresh = await app.request('/gated/thing', { headers });
    expect(fresh.status).toBe(200);

    now = new Date(issuedAt.getTime() + 200_000); // past the 120s default
    const replayed = await app.request('/gated/thing', { headers });
    expect(replayed.status).toBe(401);
    expect(((await replayed.json()) as { reason: string }).reason).toBe('stale-principal');
  });

  it('surfaces a lookupSecret failure as 500 internal, not a 401 that misattributes a hub bug to the caller', async () => {
    const app = appWith(async () => {
      throw new Error('store unavailable');
    });
    const principal = principalFor({ path: '/gated/thing' });
    const res = await app.request('/gated/thing', { headers: headersFor(principal, SECRET) });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { reason: string }).reason).toBe('internal');
  });
});
