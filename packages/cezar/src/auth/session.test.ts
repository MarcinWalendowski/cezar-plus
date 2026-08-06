import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { identityDir } from '../paths.ts';
import { IdentityStore } from './identity-store.ts';
import {
  createSession,
  destroySession,
  logoutCookie,
  SESSION_COOKIE_NAME,
  SessionService,
  sessionResolver,
} from './session.ts';

const dirs: string[] = [];

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-session-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Builds a `Cookie:` header the way a browser (or the raw WS upgrade request) would send it. */
function cookieHeader(id: string): string {
  return `${SESSION_COOKIE_NAME}=${id}`;
}

/** Sets up an org (with its atomic default team), a signed-in user and a membership — the state
 *  `../auth/routes.ts` (not this unit) produces via `oidc.ts` + `identity-store.ts` before ever
 *  calling `createSession`. Returns everything a test needs to assert against. */
async function signedInUser(store: IdentityStore, overrides: { role?: 'owner' | 'admin' | 'member' } = {}) {
  const { org, defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });
  const { user } = await store.findOrCreateUser({ issuer: 'https://accounts.google.com', subject: 'sub-1', email: 'alice@acme.test' });
  await store.createMembership({ userId: user.id, orgId: org.id, role: overrides.role ?? 'owner' });
  return { org, team: defaultTeam, user };
}

describe('SessionService', () => {
  it('round-trips createSession → resolveFromCookieHeader into a fully-populated session Principal', async () => {
    const store = IdentityStore.open(await directory());
    const service = SessionService.create(store, { authProvider: () => 'oidc' });
    const { org, team, user } = await signedInUser(store);

    const created = await service.createSession(user.id);
    expect(created.cookie).toContain(`${SESSION_COOKIE_NAME}=${created.id}`);
    expect(created.cookie).toContain('HttpOnly');
    expect(created.cookie).toContain('Secure');
    expect(created.cookie).toContain('SameSite=Lax');
    expect(created.cookie).toContain('Path=/');

    const principal = service.resolveFromCookieHeader(cookieHeader(created.id));
    expect(principal).toEqual({ kind: 'session', userId: user.id, orgId: org.id, teamId: team.id, role: 'owner' });
  });

  it('resolves the org role a user was actually granted, not a hardcoded one', async () => {
    const store = IdentityStore.open(await directory());
    const service = SessionService.create(store, { authProvider: () => 'oidc' });
    const { user } = await signedInUser(store, { role: 'member' });

    const created = await service.createSession(user.id);
    expect(service.resolveFromCookieHeader(cookieHeader(created.id))?.role).toBe('member');
  });

  it('rejects a tampered id (flipped character, same length)', async () => {
    const store = IdentityStore.open(await directory());
    const service = SessionService.create(store, { authProvider: () => 'oidc' });
    const { user } = await signedInUser(store);
    const created = await service.createSession(user.id);
    const tampered = `${created.id.slice(0, -1)}${created.id.at(-1) === 'a' ? 'b' : 'a'}`;

    expect(service.resolveFromCookieHeader(cookieHeader(tampered))).toBeNull();
    // The genuine id still works — the rejection above was about the id's content, not some
    // accidental breakage of the whole session.
    expect(service.resolveFromCookieHeader(cookieHeader(created.id))?.userId).toBe(user.id);
  });

  it('rejects a malformed id (wrong length, non-hex, empty) before ever touching the store', async () => {
    const store = IdentityStore.open(await directory());
    const service = SessionService.create(store, { authProvider: () => 'oidc' });
    const { user } = await signedInUser(store);
    const created = await service.createSession(user.id);

    expect(service.resolveFromCookieHeader(cookieHeader(`${created.id}00`))).toBeNull();
    expect(service.resolveFromCookieHeader(cookieHeader(created.id.slice(0, 8)))).toBeNull();
    expect(service.resolveFromCookieHeader(cookieHeader('z'.repeat(64)))).toBeNull(); // non-hex
    expect(service.resolveFromCookieHeader(cookieHeader(''))).toBeNull();
  });

  it('rejects an expired session on READ, independent of any sweep', async () => {
    let now = new Date('2026-08-01T00:00:00.000Z');
    const store = IdentityStore.open(await directory(), { now: () => now });
    const service = SessionService.create(store, { authProvider: () => 'oidc', now: () => now });
    const { user } = await signedInUser(store);
    const created = await service.createSession(user.id, 60_000); // 1 minute TTL

    now = new Date('2026-08-01T00:00:59.000Z'); // 59s later: still valid
    expect(service.resolveFromCookieHeader(cookieHeader(created.id))).not.toBeNull();

    now = new Date('2026-08-01T00:01:01.000Z'); // 61s later: expired
    expect(service.resolveFromCookieHeader(cookieHeader(created.id))).toBeNull();

    // Nothing swept the row — a second reader against the same untouched file, at the same
    // moment, independently rejects it too. The correctness lives in the read, not in a cleanup
    // pass that ran in between (there wasn't one).
    const freshReader = SessionService.create(store, { authProvider: () => 'oidc', now: () => now });
    expect(freshReader.resolveFromCookieHeader(cookieHeader(created.id))).toBeNull();
  });

  it('destroySession invalidates server-side — the exact cookie no longer resolves', async () => {
    const store = IdentityStore.open(await directory());
    const service = SessionService.create(store, { authProvider: () => 'oidc' });
    const { user } = await signedInUser(store);
    const created = await service.createSession(user.id);
    expect(service.resolveFromCookieHeader(cookieHeader(created.id))).not.toBeNull();

    const destroyed = await service.destroySession(created.id);
    expect(destroyed).toBe(true);

    // Simulates a client that never cleared its own cookie: the same header that used to work
    // must now fail, which is the difference between server-side and client-side invalidation.
    expect(service.resolveFromCookieHeader(cookieHeader(created.id))).toBeNull();
  });

  it('destroying an unknown or already-destroyed id is a no-op, not an error', async () => {
    const store = IdentityStore.open(await directory());
    const service = SessionService.create(store, { authProvider: () => 'oidc' });
    await expect(service.destroySession('does-not-exist')).resolves.toBe(false);
    const { user } = await signedInUser(store);
    const created = await service.createSession(user.id);
    await service.destroySession(created.id);
    await expect(service.destroySession(created.id)).resolves.toBe(false);
  });

  it('resolves null for no cookie header, an unrelated cookie, and an empty header — never throws', () => {
    const service = SessionService.create(IdentityStore.open('/does/not/matter'), { authProvider: () => 'oidc' });
    expect(service.resolveFromCookieHeader(undefined)).toBeNull();
    expect(service.resolveFromCookieHeader('')).toBeNull();
    expect(service.resolveFromCookieHeader('other=1; another=2')).toBeNull();
  });

  it('finds the session cookie alongside unrelated cookies, in either position', async () => {
    const store = IdentityStore.open(await directory());
    const service = SessionService.create(store, { authProvider: () => 'oidc' });
    const { user } = await signedInUser(store);
    const created = await service.createSession(user.id);

    expect(service.resolveFromCookieHeader(`theme=dark; ${SESSION_COOKIE_NAME}=${created.id}`)).not.toBeNull();
    expect(service.resolveFromCookieHeader(`${SESSION_COOKIE_NAME}=${created.id}; theme=dark`)).not.toBeNull();
  });

  it('a valid, unexpired session for a user with no org membership yet resolves to null (D8 onboarding not finished)', async () => {
    const store = IdentityStore.open(await directory());
    const service = SessionService.create(store, { authProvider: () => 'oidc' });
    const { user } = await store.findOrCreateUser({ issuer: 'https://accounts.google.com', subject: 'sub-2' });

    const created = await service.createSession(user.id);
    expect(service.resolveFromCookieHeader(cookieHeader(created.id))).toBeNull();
  });

  it('never resolves a principal when the configured auth provider is "none" (defensive — should be unreachable in practice)', async () => {
    const store = IdentityStore.open(await directory());
    const service = SessionService.create(store, { authProvider: () => 'none' });
    const { user } = await signedInUser(store);
    const created = await service.createSession(user.id);

    expect(service.resolveFromCookieHeader(cookieHeader(created.id))).toBeNull();
  });

  it('picks the oldest membership when a user belongs to more than one org', async () => {
    const store = IdentityStore.open(await directory());
    const service = SessionService.create(store, { authProvider: () => 'oidc' });
    const { org: firstOrg, user } = await signedInUser(store);
    const { org: secondOrg } = await store.createOrg({ name: 'Beta', slug: 'beta' });
    await store.createMembership({ userId: user.id, orgId: secondOrg.id, role: 'member' });

    const created = await service.createSession(user.id);
    expect(service.resolveFromCookieHeader(cookieHeader(created.id))?.orgId).toBe(firstOrg.id);
  });

  it("picks the org's default (first) team when a second team exists", async () => {
    const store = IdentityStore.open(await directory());
    const service = SessionService.create(store, { authProvider: () => 'oidc' });
    const { org, team: defaultTeam, user } = await signedInUser(store);
    await store.createTeam({ orgId: org.id, name: 'Engineering', slug: 'engineering' });

    const created = await service.createSession(user.id);
    expect(service.resolveFromCookieHeader(cookieHeader(created.id))?.teamId).toBe(defaultTeam.id);
  });
});

describe('logoutCookie', () => {
  it('clears the session cookie under the same name with Max-Age=0', () => {
    const cleared = logoutCookie();
    expect(cleared).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('HttpOnly');
    expect(cleared).toContain('Secure');
    expect(cleared).toContain('SameSite=Lax');
  });
});

describe('sessionResolver / createSession / destroySession (the exported seam, real identityDir())', () => {
  afterEach(async () => {
    await rm(identityDir(), { recursive: true, force: true });
  });

  it('is wired to the same identity store as `sessionResolver`: create → resolve → destroy → resolve', async () => {
    // A second store instance pointed at the SAME directory as the module's internal singleton —
    // `IdentityStore` caches nothing (see its own doc comment), so this reads/writes exactly what
    // the exported `createSession`/`sessionResolver` do, without this test reaching into the
    // module's private singleton.
    const setup = IdentityStore.open(identityDir());
    const { org, team, user } = await signedInUser(setup);

    const created = await createSession(user.id);
    // The real singleton reads `CEZ_AUTH` via `resolveAuthProvider` — unset in this test process,
    // which resolves to `'none'` and (correctly, per the defensive guard) yields no principal. The
    // wiring itself — that `createSession`/`sessionResolver` share state — is what this test
    // proves, via the org/team/role becoming resolvable the moment `CEZ_AUTH` says otherwise.
    process.env.CEZ_AUTH = 'oidc';
    try {
      expect(sessionResolver.resolveFromCookieHeader(cookieHeader(created.id))).toEqual({
        kind: 'session',
        userId: user.id,
        orgId: org.id,
        teamId: team.id,
        role: 'owner',
      });
    } finally {
      delete process.env.CEZ_AUTH;
    }

    await destroySession(created.id);
    process.env.CEZ_AUTH = 'oidc';
    try {
      expect(sessionResolver.resolveFromCookieHeader(cookieHeader(created.id))).toBeNull();
    } finally {
      delete process.env.CEZ_AUTH;
    }
  });

  it('resolveFromCookieHeader satisfies the SessionResolver contract on no cookie at all', () => {
    expect(sessionResolver.resolveFromCookieHeader(undefined)).toBeNull();
  });
});
