import { Hono } from 'hono';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { jsonZodValidator } from '../server/validators.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import type { Principal, SessionResolver } from '../server/server.ts';
import { createRequireOrgAdmin, getOrgAdminPrincipal, requireOrgAdmin } from './require-org-admin.ts';

/**
 * `createRequireOrgAdmin`'s own behaviour (D12), exercised standalone against a fake
 * `SessionResolver` — the same "fake only what's genuinely external" split
 * `auth-perimeter.test.ts` uses for `requirePrincipal`: the resolver's real implementation
 * (`session.ts`) is covered in its own suite, and faking it here lets these assert the
 * middleware's own branches without a signed cookie per case.
 */

function principal(role: Principal['role']): Principal {
  return { kind: 'session', userId: 'u1', orgId: 'o1', teamId: 't1', role };
}

function resolverFor(value: Principal | null): SessionResolver {
  return { resolveFromCookieHeader: () => value };
}

const bodySchema = z.object({ name: z.string().min(1) });

/** One representative admin route: the middleware, then a validator, then a handler that reads
 *  the stashed principal back — the exact chain shape a real Fill unit route is expected to use. */
function buildApp(resolver: SessionResolver): Hono {
  const admin = createRequireOrgAdmin(resolver);
  return new Hono().post('/admin-action', admin, jsonZodValidator(bodySchema), (c) => {
    const p = getOrgAdminPrincipal(c);
    return c.json({ ok: true, actedAs: p.userId });
  });
}

const MALFORMED = '{}'; // fails `bodySchema` — only reachable if the gate let it through

describe('createRequireOrgAdmin — D12 role gate', () => {
  it('403s a `member`, BEFORE the body validator ever runs', async () => {
    const app = buildApp(resolverFor(principal('member')));
    const res = await apiRequest(app, '/admin-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: MALFORMED,
    });
    // A leak here would be 400 (the validator's own error), not 403 — the same
    // authorization-before-validation ordering `supervisor/server.ts`'s `requireAdmin` pins.
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden: this action requires an owner or admin role' });
  });

  it('admits an `owner`', async () => {
    const app = buildApp(resolverFor(principal('owner')));
    const res = await apiRequest(app, '/admin-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'engineering' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, actedAs: 'u1' });
  });

  it('admits an `admin`', async () => {
    const app = buildApp(resolverFor(principal('admin')));
    const res = await apiRequest(app, '/admin-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'marketing' }),
    });
    expect(res.status).toBe(200);
  });

  it('401s with no principal at all', async () => {
    const app = buildApp(resolverFor(null));
    const res = await apiRequest(app, '/admin-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
  });

  it('401s a non-session principal, defensively (unreachable in production — see the module doc)', async () => {
    const local: Principal = { kind: 'local', userId: 'local', orgId: 'default', teamId: 'default', role: 'owner' };
    const app = buildApp(resolverFor(local));
    const res = await apiRequest(app, '/admin-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(401);
  });

  it('still enforces the body schema for an admin caller — the gate precedes validation, it does not replace it', async () => {
    const app = buildApp(resolverFor(principal('owner')));
    const res = await apiRequest(app, '/admin-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: MALFORMED,
    });
    expect(res.status).toBe(400);
  });

  it('stashes the resolved principal on context for the handler to read back, rather than re-resolving', async () => {
    const seen: (string | undefined)[] = [];
    const resolver: SessionResolver = {
      resolveFromCookieHeader: (cookie) => {
        seen.push(cookie);
        return { kind: 'session', userId: 'u-42', orgId: 'o1', teamId: 't1', role: 'owner' };
      },
    };
    const app = buildApp(resolver);
    const res = await apiRequest(app, '/admin-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'cez_session=abc' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect((await res.json()) as { actedAs: string }).toEqual({ ok: true, actedAs: 'u-42' });
    // Exactly once: the handler reads `getOrgAdminPrincipal`, not a second call to the resolver.
    expect(seen).toEqual(['cez_session=abc']);
  });
});

describe('requireOrgAdmin — the real, process-lifetime singleton', () => {
  it('is a usable middleware function, wired against ./session.ts (no crash at import time)', () => {
    expect(typeof requireOrgAdmin).toBe('function');
  });
});
