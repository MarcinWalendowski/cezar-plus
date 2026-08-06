import { existsSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { IdentityStore, IdentityStoreError } from './identity-store.ts';

const dirs: string[] = [];

async function directory(prefix = 'cezar-identity-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('IdentityStore — org/team creation (D8)', () => {
  it('creates an org and its default team in one write, at private permissions', async () => {
    const dir = await directory();
    const store = IdentityStore.open(dir);
    const { org, defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });

    expect(org.slug).toBe('acme');
    expect(defaultTeam.name).toBe('General');
    expect(defaultTeam.slug).toBe('general');
    expect(defaultTeam.orgId).toBe(org.id);
    expect(store.listTeams(org.id)).toEqual([defaultTeam]);

    const path = join(dir, 'identity.json');
    await expect(stat(path).then((s) => s.mode & 0o777)).resolves.toBe(0o600);
    await expect(stat(dir).then((s) => s.mode & 0o777)).resolves.toBe(0o700);
    // No lingering .tmp after a completed write.
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('accepts a caller-supplied default team name/slug (D8: org name defaulted from the OIDC claim, editable)', async () => {
    const store = IdentityStore.open(await directory());
    const { defaultTeam } = await store.createOrg({
      name: 'Acme',
      slug: 'acme',
      defaultTeamName: 'Everyone',
      defaultTeamSlug: 'everyone',
    });
    expect(defaultTeam.name).toBe('Everyone');
    expect(defaultTeam.slug).toBe('everyone');
  });

  it('renameTeam only renames — slug and org membership are untouched', async () => {
    const store = IdentityStore.open(await directory());
    const { defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const renamed = await store.renameTeam(defaultTeam.id, 'Acme HQ');
    expect(renamed.name).toBe('Acme HQ');
    expect(renamed.slug).toBe(defaultTeam.slug);
    expect(renamed.orgId).toBe(defaultTeam.orgId);
    await expect(store.renameTeam('does-not-exist', 'x')).rejects.toMatchObject({ code: 'team-not-found' });
  });

  it('adds a later team to an existing org (engineering, marketing — the spec\'s own example)', async () => {
    const store = IdentityStore.open(await directory());
    const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const eng = await store.createTeam({ orgId: org.id, name: 'Engineering', slug: 'engineering' });
    const mkt = await store.createTeam({ orgId: org.id, name: 'Marketing', slug: 'marketing' });
    expect(store.listTeams(org.id).map((t) => t.slug).sort()).toEqual(['engineering', 'general', 'marketing']);
    expect(eng.orgId).toBe(org.id);
    expect(mkt.orgId).toBe(org.id);
  });

  it('createTeam refuses an unknown org', async () => {
    const store = IdentityStore.open(await directory());
    await expect(store.createTeam({ orgId: 'nope', name: 'X', slug: 'x' })).rejects.toMatchObject({
      code: 'org-not-found',
    });
  });
});

describe('IdentityStore — duplicate inserts are refused, never last-write-wins', () => {
  it('refuses a second org with the same slug, and only one org is ever persisted', async () => {
    const dir = await directory();
    const store = IdentityStore.open(dir);
    await store.createOrg({ name: 'Acme', slug: 'acme' });
    await expect(store.createOrg({ name: 'Acme Two', slug: 'acme' })).rejects.toBeInstanceOf(IdentityStoreError);
    await expect(store.createOrg({ name: 'Acme Two', slug: 'acme' })).rejects.toMatchObject({ code: 'org-slug-taken' });
    expect(store.listOrgs()).toHaveLength(1);
    expect(store.listOrgs()[0]?.name).toBe('Acme'); // the first write survives — no clobber
  });

  it('refuses a second team with the same slug inside one org, but allows the same slug in a different org', async () => {
    const store = IdentityStore.open(await directory());
    const { org: orgA } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const { org: orgB } = await store.createOrg({ name: 'Beta', slug: 'beta' });
    await store.createTeam({ orgId: orgA.id, name: 'Engineering', slug: 'engineering' });
    await expect(store.createTeam({ orgId: orgA.id, name: 'Eng (dup)', slug: 'engineering' })).rejects.toMatchObject({
      code: 'team-slug-taken',
    });
    // UNIQUE (org_id, slug) — the same slug in a different org is fine.
    await expect(store.createTeam({ orgId: orgB.id, name: 'Engineering', slug: 'engineering' })).resolves.toMatchObject({
      slug: 'engineering',
    });
  });

  it('findOrCreateUser is idempotent on (issuer, subject) — one row, refreshed profile fields, never a duplicate', async () => {
    const dir = await directory();
    const store = IdentityStore.open(dir);
    const first = await store.findOrCreateUser({ issuer: 'https://idp.example', subject: 'sub-1', email: 'a@example.com', name: 'Ann' });
    expect(first.created).toBe(true);

    const second = await store.findOrCreateUser({ issuer: 'https://idp.example', subject: 'sub-1', email: 'ann@example.com', name: 'Ann Smith' });
    expect(second.created).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    // Profile metadata refreshed from the latest claims — it is not the identity key (see
    // userSchema's doc), so the newer value is what should be on disk.
    expect(second.user.email).toBe('ann@example.com');
    expect(second.user.name).toBe('Ann Smith');

    const raw = JSON.parse(readFileSync(join(dir, 'identity.json'), 'utf8'));
    expect(raw.users).toHaveLength(1);
  });

  it('refuses a second membership for the same (user, org) pair', async () => {
    const store = IdentityStore.open(await directory());
    const { user } = await store.findOrCreateUser({ issuer: 'https://idp.example', subject: 'sub-1' });
    const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    await store.createMembership({ userId: user.id, orgId: org.id, role: 'owner' });
    await expect(store.createMembership({ userId: user.id, orgId: org.id, role: 'member' })).rejects.toMatchObject({
      code: 'membership-exists',
    });
    expect(store.listOrgMembers(org.id)).toHaveLength(1);
    expect(store.getMembership(user.id, org.id)?.role).toBe('owner'); // first write survives
  });

  it('createMembership validates both foreign keys', async () => {
    const store = IdentityStore.open(await directory());
    const { user } = await store.findOrCreateUser({ issuer: 'https://idp.example', subject: 'sub-1' });
    const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    await expect(store.createMembership({ userId: 'nope', orgId: org.id, role: 'member' })).rejects.toMatchObject({
      code: 'user-not-found',
    });
    await expect(store.createMembership({ userId: user.id, orgId: 'nope', role: 'member' })).rejects.toMatchObject({
      code: 'org-not-found',
    });
  });

  it('refuses a second session with the same id', async () => {
    const store = IdentityStore.open(await directory());
    const { user } = await store.findOrCreateUser({ issuer: 'https://idp.example', subject: 'sub-1' });
    const expiresAt = new Date(Date.now() + 60_000);
    await store.createSession({ id: 'session-1', userId: user.id, expiresAt });
    await expect(store.createSession({ id: 'session-1', userId: user.id, expiresAt })).rejects.toMatchObject({
      code: 'session-id-taken',
    });
  });
});

describe('IdentityStore — project_teams (D4)', () => {
  it('one root belongs to exactly one org — a second registration of the same root is refused', async () => {
    const store = IdentityStore.open(await directory());
    const { org: orgA, defaultTeam: teamA } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const { org: orgB, defaultTeam: teamB } = await store.createOrg({ name: 'Beta', slug: 'beta' });
    const projectDir = await directory('cezar-identity-project-');

    await store.createProjectTeam({ projectRoot: projectDir, orgId: orgA.id, teamId: teamA.id });
    await expect(store.createProjectTeam({ projectRoot: projectDir, orgId: orgB.id, teamId: teamB.id })).rejects.toMatchObject({
      code: 'project-root-taken',
    });
    expect(store.listProjectTeams()).toHaveLength(1);
  });

  it('normalizes to a realpath — a symlink and its target collapse to the SAME key, not two', async () => {
    const store = IdentityStore.open(await directory());
    const { org, defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const projectDir = await directory('cezar-identity-project-');
    const linkDir = join(tmpdir(), `cezar-identity-link-${randomUUID()}`);
    symlinkSync(projectDir, linkDir);
    dirs.push(linkDir); // afterEach's rm() unlinks the symlink itself, never the target

    await store.createProjectTeam({ projectRoot: linkDir, orgId: org.id, teamId: defaultTeam.id });
    // Registering the REAL path a second time must collide with the symlink's registration —
    // exactly the "two processes over one .ai/cezar" scenario D4 names, if this were not true.
    await expect(store.createProjectTeam({ projectRoot: projectDir, orgId: org.id, teamId: defaultTeam.id })).rejects.toMatchObject({
      code: 'project-root-taken',
    });
    expect(store.listProjectTeams()).toHaveLength(1);
  });

  it('refuses to link a project root to a team that belongs to a different org', async () => {
    const store = IdentityStore.open(await directory());
    const { org: orgA } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const { defaultTeam: teamB } = await store.createOrg({ name: 'Beta', slug: 'beta' });
    const projectDir = await directory('cezar-identity-project-');
    await expect(store.createProjectTeam({ projectRoot: projectDir, orgId: orgA.id, teamId: teamB.id })).rejects.toMatchObject({
      code: 'team-org-mismatch',
    });
  });

  it('createProjectTeam validates the org and the team exist', async () => {
    const store = IdentityStore.open(await directory());
    const { defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const projectDir = await directory('cezar-identity-project-');
    await expect(store.createProjectTeam({ projectRoot: projectDir, orgId: 'nope', teamId: defaultTeam.id })).rejects.toMatchObject({
      code: 'org-not-found',
    });
    const { org } = await store.createOrg({ name: 'Beta', slug: 'beta' });
    await expect(store.createProjectTeam({ projectRoot: projectDir, orgId: org.id, teamId: 'nope' })).rejects.toMatchObject({
      code: 'team-not-found',
    });
  });
});

describe('IdentityStore — sessions', () => {
  it('an expired session reads as absent, and deleteSession is idempotent logout', async () => {
    const store = IdentityStore.open(await directory(), { now: () => new Date('2026-01-01T00:00:00.000Z') });
    const { user } = await store.findOrCreateUser({ issuer: 'https://idp.example', subject: 'sub-1' });
    const session = await store.createSession({ id: 'sess-1', userId: user.id, expiresAt: new Date('2026-01-01T00:05:00.000Z') });
    expect(store.getSession('sess-1')).toEqual(session);

    const expiredView = IdentityStore.open(store.dir, {
      now: () => new Date('2026-01-01T00:10:00.000Z'),
    });
    expect(expiredView.getSession('sess-1')).toBeUndefined();

    expect(await store.deleteSession('sess-1')).toBe(true);
    expect(await store.deleteSession('sess-1')).toBe(false); // idempotent
    expect(store.getSession('sess-1')).toBeUndefined();
  });

  it('createSession validates the user exists', async () => {
    const store = IdentityStore.open(await directory());
    await expect(store.createSession({ id: 's', userId: 'nope', expiresAt: new Date(Date.now() + 1000) })).rejects.toMatchObject({
      code: 'user-not-found',
    });
  });
});

describe('IdentityStore — the write lease actually serializes concurrent writers', () => {
  it('a write blocked on a held lease waits, then re-reads fresh disk state instead of clobbering it', async () => {
    const dir = await directory();
    const store = IdentityStore.open(dir, { lockRetryMs: 5, lockTimeoutMs: 2_000 });

    // Simulate a second writer already mid-transaction: it has the lease, and this instance
    // knows nothing about it (a fresh `IdentityStore` has no in-memory state to be stale, so the
    // only way this test can be meaningful is a REAL held lease, not an in-process ordering
    // accident — see the class's own module doc on why reads/writes are never cached).
    const externalLease = store.acquireLease();
    expect(externalLease).toBeDefined();

    const writePromise = store.createOrg({ name: 'Acme', slug: 'acme' });
    let settled = false;
    void writePromise.then(() => {
      settled = true;
    });

    // Give the guarded write several retry cycles' worth of time to prove it is actually
    // *waiting* on the lease rather than failing fast or silently skipping.
    await sleep(60);
    expect(settled).toBe(false);

    // The "other writer" finishes ITS OWN transaction: a different org, written directly to
    // disk, then the lease is released. If `createOrg` above resumes from a snapshot it read
    // BEFORE this point (a stale cache), its write would stomp this org out of existence. If it
    // re-reads fresh under the lease — which `guardedWrite` is supposed to do — both must survive.
    writeFileSync(
      join(dir, 'identity.json'),
      JSON.stringify({
        version: 1,
        orgs: [{ id: 'other-id', name: 'Other Org', slug: 'other', createdAt: new Date().toISOString() }],
        teams: [],
        users: [],
        memberships: [],
        projectTeams: [],
        sessions: [],
      }),
    );
    externalLease?.release();

    await writePromise;
    expect(store.listOrgs().map((o) => o.slug).sort()).toEqual(['acme', 'other']);
  });

  it('gives up with lease-timeout rather than hanging forever when the lease never frees', async () => {
    const dir = await directory();
    const store = IdentityStore.open(dir, { lockRetryMs: 5, lockTimeoutMs: 40 });
    const externalLease = store.acquireLease();
    expect(externalLease).toBeDefined();

    await expect(store.createOrg({ name: 'Acme', slug: 'acme' })).rejects.toMatchObject({ code: 'lease-timeout' });
    // The write never got past the lease, so it never touched the snapshot file at all.
    expect(existsSync(join(dir, 'identity.json'))).toBe(false);

    externalLease?.release();
    await expect(store.createOrg({ name: 'Acme', slug: 'acme' })).resolves.toMatchObject({ org: { slug: 'acme' } });
  });

  it('exposes the same "one shot, stale-reclaim, else undefined" lease idiom as the sibling stores', async () => {
    const dir = await directory();
    const store = IdentityStore.open(dir);
    const first = store.acquireLease();
    expect(first).toBeDefined();
    expect(store.acquireLease()).toBeUndefined();
    first?.release();
    expect(store.acquireLease()).toBeDefined();
  });

  it('reclaims a lease held longer than the stale window', async () => {
    const dir = await directory();
    const store = IdentityStore.open(dir, { staleLeaseMs: 1_000 });
    const first = store.acquireLease();
    expect(first).toBeDefined();
    expect(store.acquireLease()).toBeUndefined();
    const lockPath = join(dir, 'identity.lock');
    const past = new Date(Date.now() - 5_000);
    utimesSync(lockPath, past, past);
    expect(store.acquireLease()).toBeDefined();
  });
});

describe('IdentityStore — degraded reads, never a throw', () => {
  it('degrades a corrupt identity.json to an empty snapshot plus one warning', async () => {
    const dir = await directory();
    writeFileSync(join(dir, 'identity.json'), '{not json');
    const warnings: string[] = [];
    const store = IdentityStore.open(dir, { warn: (w) => warnings.push(w) });
    expect(() => store.listOrgs()).not.toThrow();
    expect(store.listOrgs()).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('salvages valid rows and drops a malformed one, with one warning per table', async () => {
    const dir = await directory();
    const store = IdentityStore.open(dir);
    const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const path = join(dir, 'identity.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.orgs.push({ id: 'broken' }); // missing required fields
    writeFileSync(path, JSON.stringify(raw));

    const warnings: string[] = [];
    const reopened = IdentityStore.open(dir, { warn: (w) => warnings.push(w) });
    expect(reopened.listOrgs().map((o) => o.id)).toEqual([org.id]);
    expect(warnings).toHaveLength(1);
  });

  it('preserves unknown fields through a read+write round trip (forward-compat, .passthrough())', async () => {
    const dir = await directory();
    const store = IdentityStore.open(dir);
    const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const path = join(dir, 'identity.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.future = { kept: true };
    raw.orgs[0].futureField = 'kept-too';
    writeFileSync(path, JSON.stringify(raw));

    // An unrelated later write must not drop what it doesn't understand.
    await store.createTeam({ orgId: org.id, name: 'Marketing', slug: 'marketing' });
    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    expect(persisted.future).toEqual({ kept: true });
    expect(persisted.orgs[0].futureField).toBe('kept-too');
  });

  it('missing identity.json reads as empty and creates nothing on disk (D7: created lazily)', async () => {
    const dir = await directory();
    const store = IdentityStore.open(dir);
    expect(store.listOrgs()).toEqual([]);
    expect(store.getSession('anything')).toBeUndefined();
    expect(existsSync(join(dir, 'identity.json'))).toBe(false);
    expect(existsSync(dir)).toBe(true); // the dir itself came from mkdtemp, not the store
  });
});
