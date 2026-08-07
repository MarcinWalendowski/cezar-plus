import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('IdentityStore — org/team creation (D8)', () => {
  it('creates an org and its default team in one write, at private permissions', async () => {
    const dir = await directory();
    const store = IdentityStore.open(dir);
    const { org, defaultTeam } = await store.createOrg({
      name: 'Acme',
      slug: 'acme',
    });

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
    const { defaultTeam } = await store.createOrg({
      name: 'Acme',
      slug: 'acme',
    });
    const renamed = await store.renameTeam(defaultTeam.id, 'Acme HQ');
    expect(renamed.name).toBe('Acme HQ');
    expect(renamed.slug).toBe(defaultTeam.slug);
    expect(renamed.orgId).toBe(defaultTeam.orgId);
    await expect(store.renameTeam('does-not-exist', 'x')).rejects.toMatchObject(
      { code: 'team-not-found' },
    );
  });

  it("adds a later team to an existing org (engineering, marketing — the spec's own example)", async () => {
    const store = IdentityStore.open(await directory());
    const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const eng = await store.createTeam({
      orgId: org.id,
      name: 'Engineering',
      slug: 'engineering',
    });
    const mkt = await store.createTeam({
      orgId: org.id,
      name: 'Marketing',
      slug: 'marketing',
    });
    expect(
      store
        .listTeams(org.id)
        .map((t) => t.slug)
        .sort(),
    ).toEqual(['engineering', 'general', 'marketing']);
    expect(eng.orgId).toBe(org.id);
    expect(mkt.orgId).toBe(org.id);
  });

  it('createTeam refuses an unknown org', async () => {
    const store = IdentityStore.open(await directory());
    await expect(
      store.createTeam({ orgId: 'nope', name: 'X', slug: 'x' }),
    ).rejects.toMatchObject({
      code: 'org-not-found',
    });
  });
});

describe('IdentityStore — duplicate inserts are refused, never last-write-wins', () => {
  it('refuses a second org with the same slug, and only one org is ever persisted', async () => {
    const dir = await directory();
    const store = IdentityStore.open(dir);
    await store.createOrg({ name: 'Acme', slug: 'acme' });
    await expect(
      store.createOrg({ name: 'Acme Two', slug: 'acme' }),
    ).rejects.toBeInstanceOf(IdentityStoreError);
    await expect(
      store.createOrg({ name: 'Acme Two', slug: 'acme' }),
    ).rejects.toMatchObject({ code: 'org-slug-taken' });
    expect(store.listOrgs()).toHaveLength(1);
    expect(store.listOrgs()[0]?.name).toBe('Acme'); // the first write survives — no clobber
  });

  it('refuses a second team with the same slug inside one org, but allows the same slug in a different org', async () => {
    const store = IdentityStore.open(await directory());
    const { org: orgA } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const { org: orgB } = await store.createOrg({ name: 'Beta', slug: 'beta' });
    await store.createTeam({
      orgId: orgA.id,
      name: 'Engineering',
      slug: 'engineering',
    });
    await expect(
      store.createTeam({
        orgId: orgA.id,
        name: 'Eng (dup)',
        slug: 'engineering',
      }),
    ).rejects.toMatchObject({
      code: 'team-slug-taken',
    });
    // UNIQUE (org_id, slug) — the same slug in a different org is fine.
    await expect(
      store.createTeam({
        orgId: orgB.id,
        name: 'Engineering',
        slug: 'engineering',
      }),
    ).resolves.toMatchObject({
      slug: 'engineering',
    });
  });

  it('findOrCreateUser is idempotent on (issuer, subject) — one row, refreshed profile fields, never a duplicate', async () => {
    const dir = await directory();
    const store = IdentityStore.open(dir);
    const first = await store.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'sub-1',
      email: 'a@example.com',
      name: 'Ann',
    });
    expect(first.created).toBe(true);

    const second = await store.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'sub-1',
      email: 'ann@example.com',
      name: 'Ann Smith',
    });
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
    const { user } = await store.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'sub-1',
    });
    const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    await store.createMembership({
      userId: user.id,
      orgId: org.id,
      role: 'owner',
    });
    await expect(
      store.createMembership({
        userId: user.id,
        orgId: org.id,
        role: 'member',
      }),
    ).rejects.toMatchObject({
      code: 'membership-exists',
    });
    expect(store.listOrgMembers(org.id)).toHaveLength(1);
    expect(store.getMembership(user.id, org.id)?.role).toBe('owner'); // first write survives
  });

  it('createMembership validates both foreign keys', async () => {
    const store = IdentityStore.open(await directory());
    const { user } = await store.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'sub-1',
    });
    const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    await expect(
      store.createMembership({ userId: 'nope', orgId: org.id, role: 'member' }),
    ).rejects.toMatchObject({
      code: 'user-not-found',
    });
    await expect(
      store.createMembership({
        userId: user.id,
        orgId: 'nope',
        role: 'member',
      }),
    ).rejects.toMatchObject({
      code: 'org-not-found',
    });
  });

  it('refuses a second session with the same id', async () => {
    const store = IdentityStore.open(await directory());
    const { user } = await store.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'sub-1',
    });
    const expiresAt = new Date(Date.now() + 60_000);
    await store.createSession({ id: 'session-1', userId: user.id, expiresAt });
    await expect(
      store.createSession({ id: 'session-1', userId: user.id, expiresAt }),
    ).rejects.toMatchObject({
      code: 'session-id-taken',
    });
  });
});

describe('IdentityStore — project_teams (D4)', () => {
  it('one root belongs to exactly one org — a second registration of the same root is refused', async () => {
    const store = IdentityStore.open(await directory());
    const { org: orgA, defaultTeam: teamA } = await store.createOrg({
      name: 'Acme',
      slug: 'acme',
    });
    const { org: orgB, defaultTeam: teamB } = await store.createOrg({
      name: 'Beta',
      slug: 'beta',
    });
    const projectDir = await directory('cezar-identity-project-');

    await store.createProjectTeam({
      projectRoot: projectDir,
      orgId: orgA.id,
      teamId: teamA.id,
    });
    await expect(
      store.createProjectTeam({
        projectRoot: projectDir,
        orgId: orgB.id,
        teamId: teamB.id,
      }),
    ).rejects.toMatchObject({
      code: 'project-root-taken',
    });
    expect(store.listProjectTeams()).toHaveLength(1);
  });

  it('normalizes to a realpath — a symlink and its target collapse to the SAME key, not two', async () => {
    const store = IdentityStore.open(await directory());
    const { org, defaultTeam } = await store.createOrg({
      name: 'Acme',
      slug: 'acme',
    });
    const projectDir = await directory('cezar-identity-project-');
    const linkDir = join(tmpdir(), `cezar-identity-link-${randomUUID()}`);
    symlinkSync(projectDir, linkDir);
    dirs.push(linkDir); // afterEach's rm() unlinks the symlink itself, never the target

    await store.createProjectTeam({
      projectRoot: linkDir,
      orgId: org.id,
      teamId: defaultTeam.id,
    });
    // Registering the REAL path a second time must collide with the symlink's registration —
    // exactly the "two processes over one .ai/cezar" scenario D4 names, if this were not true.
    await expect(
      store.createProjectTeam({
        projectRoot: projectDir,
        orgId: org.id,
        teamId: defaultTeam.id,
      }),
    ).rejects.toMatchObject({
      code: 'project-root-taken',
    });
    expect(store.listProjectTeams()).toHaveLength(1);
  });

  it('collapses a case-differing spelling on a case-insensitive filesystem — `realpathSync.native`, not the JS `realpathSync`', async () => {
    const store = IdentityStore.open(await directory());
    const { org, defaultTeam } = await store.createOrg({
      name: 'Acme',
      slug: 'acme',
    });
    // `mkdtemp` gives a lowercase-ish random suffix, so force a name with real case to flip.
    const parent = await directory('cezar-identity-caseparent-');
    const onDisk = join(parent, 'ProjectRoot');
    mkdirSync(onDisk);
    const lowercased = join(parent, 'projectroot');
    if (!existsSync(lowercased)) {
      // A genuinely case-sensitive filesystem (Linux ext4 in CI): the other spelling does not
      // exist, so the property under test does not apply. Asserting the precondition rather than
      // returning silently — a skipped test and a passing one look identical otherwise.
      expect(existsSync(lowercased)).toBe(false);
      return;
    }

    // Claim it by its lowercase spelling. `realpathSync.native` asks the OS, which answers with
    // the on-disk case; Node's JS `realpathSync` would echo the query back, and the two spellings
    // would then be two PRIMARY KEYs over one `.ai/cezar` — D4's silent-history-loss case.
    const claim = await store.createProjectTeam({
      projectRoot: lowercased,
      orgId: org.id,
      teamId: defaultTeam.id,
    });
    expect(claim.projectRoot).toBe(realpathSync.native(onDisk));
    expect(store.getProjectTeam(realpathSync.native(onDisk))?.orgId).toBe(
      org.id,
    );
    await expect(
      store.createProjectTeam({
        projectRoot: onDisk,
        orgId: org.id,
        teamId: defaultTeam.id,
      }),
    ).rejects.toMatchObject({
      code: 'project-root-taken',
    });
    expect(store.listProjectTeams()).toHaveLength(1);
  });

  it('refuses to link a project root to a team that belongs to a different org', async () => {
    const store = IdentityStore.open(await directory());
    const { org: orgA } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const { defaultTeam: teamB } = await store.createOrg({
      name: 'Beta',
      slug: 'beta',
    });
    const projectDir = await directory('cezar-identity-project-');
    await expect(
      store.createProjectTeam({
        projectRoot: projectDir,
        orgId: orgA.id,
        teamId: teamB.id,
      }),
    ).rejects.toMatchObject({
      code: 'team-org-mismatch',
    });
  });

  it('createProjectTeam validates the org and the team exist', async () => {
    const store = IdentityStore.open(await directory());
    const { defaultTeam } = await store.createOrg({
      name: 'Acme',
      slug: 'acme',
    });
    const projectDir = await directory('cezar-identity-project-');
    await expect(
      store.createProjectTeam({
        projectRoot: projectDir,
        orgId: 'nope',
        teamId: defaultTeam.id,
      }),
    ).rejects.toMatchObject({
      code: 'org-not-found',
    });
    const { org } = await store.createOrg({ name: 'Beta', slug: 'beta' });
    await expect(
      store.createProjectTeam({
        projectRoot: projectDir,
        orgId: org.id,
        teamId: 'nope',
      }),
    ).rejects.toMatchObject({
      code: 'team-not-found',
    });
  });
});

describe('IdentityStore — updateProjectTeam (5c: reassign a claimed root to a different team, D4)', () => {
  it('reassigns a root to a different team in the SAME org — orgId is untouched (D4)', async () => {
    const store = IdentityStore.open(await directory());
    const { org, defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const eng = await store.createTeam({ orgId: org.id, name: 'Engineering', slug: 'engineering' });
    const projectDir = await directory('cezar-identity-project-');
    // `createProjectTeam` stores a REALPATH of its input (D4's own PRIMARY KEY discipline — see
    // its doc comment), which can differ from `projectDir` itself on a platform where the temp dir
    // is a symlink (macOS `/tmp` -> `/private/tmp`) — so every lookup below keys on the row's own
    // `projectRoot`, never the raw `directory()` string, exactly like `getProjectTeam` callers
    // elsewhere in this file already must.
    const claim = await store.createProjectTeam({ projectRoot: projectDir, orgId: org.id, teamId: defaultTeam.id });

    const updated = await store.updateProjectTeam(claim.projectRoot, eng.id);
    expect(updated.teamId).toBe(eng.id);
    expect(updated.orgId).toBe(org.id); // the org claim itself never moves — only which team inside it
    expect(updated.projectRoot).toBe(claim.projectRoot);
    expect(store.getProjectTeam(claim.projectRoot)).toEqual(updated);
  });

  it('refuses a root with no existing claim — this reassigns, it does not create', async () => {
    const store = IdentityStore.open(await directory());
    const { defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    await expect(
      store.updateProjectTeam('/never/registered', defaultTeam.id),
    ).rejects.toMatchObject({ code: 'project-root-not-found' });
  });

  it('refuses an unknown teamId', async () => {
    const store = IdentityStore.open(await directory());
    const { org, defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const projectDir = await directory('cezar-identity-project-');
    const claim = await store.createProjectTeam({ projectRoot: projectDir, orgId: org.id, teamId: defaultTeam.id });

    await expect(
      store.updateProjectTeam(claim.projectRoot, 'does-not-exist'),
    ).rejects.toMatchObject({ code: 'team-not-found' });
    // the existing claim is untouched by the refused attempt
    expect(store.getProjectTeam(claim.projectRoot)?.teamId).toBe(defaultTeam.id);
  });

  it("CROSS-ORG: refuses moving a root to a team from a DIFFERENT org — checked against the EXISTING row's orgId, not a caller-supplied one, so a reassignment can never smuggle a root across D4's boundary", async () => {
    const store = IdentityStore.open(await directory());
    const { org: orgA, defaultTeam: teamA } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const { defaultTeam: teamB } = await store.createOrg({ name: 'Beta', slug: 'beta' });
    const projectDir = await directory('cezar-identity-project-');
    const claim = await store.createProjectTeam({ projectRoot: projectDir, orgId: orgA.id, teamId: teamA.id });

    await expect(
      store.updateProjectTeam(claim.projectRoot, teamB.id),
    ).rejects.toMatchObject({ code: 'team-org-mismatch' });
    // still org A's, still on its original team — the mismatch left nothing written
    expect(store.getProjectTeam(claim.projectRoot)).toMatchObject({ orgId: orgA.id, teamId: teamA.id });
  });
});

describe('IdentityStore — deleteTeam (5c, D2 — refuse rather than reassign or orphan)', () => {
  it('deletes a team that has no projects assigned to it', async () => {
    const store = IdentityStore.open(await directory());
    const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const eng = await store.createTeam({ orgId: org.id, name: 'Engineering', slug: 'engineering' });
    await store.deleteTeam(eng.id);
    expect(store.listTeams(org.id).map((t) => t.id)).not.toContain(eng.id);
  });

  it('refuses an unknown teamId', async () => {
    const store = IdentityStore.open(await directory());
    await expect(store.deleteTeam('does-not-exist')).rejects.toMatchObject({
      code: 'team-not-found',
    });
  });

  it("THE DECISION: refuses to delete a team that still has a project assigned to it — never silently orphans the project, never silently reassigns it", async () => {
    const store = IdentityStore.open(await directory());
    const { org, defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const eng = await store.createTeam({ orgId: org.id, name: 'Engineering', slug: 'engineering' });
    const projectDir = await directory('cezar-identity-project-');
    const claim = await store.createProjectTeam({ projectRoot: projectDir, orgId: org.id, teamId: eng.id });

    await expect(store.deleteTeam(eng.id)).rejects.toMatchObject({
      code: 'team-has-projects',
    });
    // the team survives...
    expect(store.listTeams(org.id).map((t) => t.id)).toContain(eng.id);
    // ...and the project's assignment is untouched — not orphaned, not silently moved to another team
    expect(store.getProjectTeam(claim.projectRoot)?.teamId).toBe(eng.id);
    // the org's OTHER team (the default one) is unaffected by the refusal
    expect(store.listTeams(org.id).map((t) => t.id)).toContain(defaultTeam.id);
  });

  it('the documented escape hatch: reassign the project first (updateProjectTeam), THEN delete succeeds', async () => {
    const store = IdentityStore.open(await directory());
    const { org, defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const eng = await store.createTeam({ orgId: org.id, name: 'Engineering', slug: 'engineering' });
    const projectDir = await directory('cezar-identity-project-');
    const claim = await store.createProjectTeam({ projectRoot: projectDir, orgId: org.id, teamId: eng.id });

    await expect(store.deleteTeam(eng.id)).rejects.toMatchObject({ code: 'team-has-projects' });
    await store.updateProjectTeam(claim.projectRoot, defaultTeam.id);
    await expect(store.deleteTeam(eng.id)).resolves.toBeUndefined();
    expect(store.listTeams(org.id).map((t) => t.id)).not.toContain(eng.id);
    expect(store.getProjectTeam(claim.projectRoot)?.teamId).toBe(defaultTeam.id);
  });

  /**
   * ADDED 2026-08-07 (5b/5c/8 repair stage). Every case above creates a SECOND team first, which
   * is why none of them could see this: an org's last team is project-free on a fresh org, so it
   * passed `team-has-projects` and was deleted. `session.ts#resolveIdentity` resolves
   * `principal.teamId` as `listTeams(orgId)[0]` and returns `null` when there is none, so a
   * team-less org resolves NO principal for ANY of its members — a permanent lockout with no
   * in-product recovery (`claimOrg`'s legacy branch needs zero orgs, its D11 branch needs an
   * unclaimed one, `/internal/*` has no team-create verb, and even a fresh invitee redeems into a
   * `null` principal).
   */
  it("THE OTHER DECISION: refuses to delete an org's LAST team — a team-less org resolves no principal for anyone", async () => {
    const store = IdentityStore.open(await directory());
    const { org, defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    expect(store.listTeams(org.id)).toHaveLength(1);

    await expect(store.deleteTeam(defaultTeam.id)).rejects.toMatchObject({ code: 'team-is-last' });
    expect(store.listTeams(org.id).map((t) => t.id)).toEqual([defaultTeam.id]);
  });

  it('the guard is per-ORG, not global: org B having a team does not make org A deletable down to zero', async () => {
    const store = IdentityStore.open(await directory());
    const { org: orgA, defaultTeam: teamA } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    await store.createOrg({ name: 'Beta', slug: 'beta' });
    await store.createTeam({ orgId: orgA.id, name: 'Engineering', slug: 'engineering' });

    // Two teams in org A now: deleting one is fine, deleting the survivor is not.
    await expect(store.deleteTeam(teamA.id)).resolves.toBeUndefined();
    const [survivor] = store.listTeams(orgA.id);
    await expect(store.deleteTeam(survivor!.id)).rejects.toMatchObject({ code: 'team-is-last' });
  });
});

describe('IdentityStore — D8 first-user bootstrap (claimOrg, legacy branch — orgId absent)', () => {
  it('creates the org, its default team, and an owner membership in one write', async () => {
    const store = IdentityStore.open(await directory());
    const { user } = await store.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'sub-1',
    });
    const { org, defaultTeam, membership } = await store.claimOrg({
      userId: user.id,
      name: 'Acme',
      slug: 'acme',
    });

    expect(org.slug).toBe('acme');
    expect(defaultTeam.orgId).toBe(org.id);
    expect(defaultTeam.name).toBe('General');
    expect(membership).toEqual({
      userId: user.id,
      orgId: org.id,
      role: 'owner',
    });
    expect(store.getMembership(user.id, org.id)?.role).toBe('owner');
    expect(store.listTeams(org.id)).toEqual([defaultTeam]);
  });

  it('refuses a second bootstrap once any org exists — the second user needs an invite instead', async () => {
    const store = IdentityStore.open(await directory());
    const { user: first } = await store.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'sub-1',
    });
    await store.claimOrg({ userId: first.id, name: 'Acme', slug: 'acme' });

    const { user: second } = await store.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'sub-2',
    });
    await expect(
      store.claimOrg({ userId: second.id, name: 'Beta', slug: 'beta' }),
    ).rejects.toMatchObject({
      code: 'org-already-bootstrapped',
    });
    // The loser gets nothing — no second org, no membership for them anywhere.
    expect(store.listOrgs()).toHaveLength(1);
    expect(store.listMemberships(second.id)).toEqual([]);
  });

  it('refuses an unknown user without touching disk', async () => {
    const dir = await directory();
    const store = IdentityStore.open(dir);
    await expect(
      store.claimOrg({ userId: 'nope', name: 'Acme', slug: 'acme' }),
    ).rejects.toMatchObject({
      code: 'user-not-found',
    });
    expect(store.listOrgs()).toEqual([]);
  });

  it('hardcodes the granted role to owner regardless of what a caller might otherwise expect', async () => {
    const store = IdentityStore.open(await directory());
    const { user } = await store.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'sub-1',
    });
    const { membership } = await store.claimOrg({
      userId: user.id,
      name: 'Acme',
      slug: 'acme',
    });
    expect(membership.role).toBe('owner');
  });

  it('THE RACE: two users bootstrapping simultaneously on an empty deployment — exactly one wins, exactly one org is ever created', async () => {
    const dir = await directory();
    // Two separate store instances over the SAME directory, mirroring two different requests
    // landing on the single supervisor process at once (D4) — IdentityStore keeps no in-memory
    // cache (see the class's own module doc), so this is exactly as consistent as one instance
    // handling two concurrent calls, and it proves the real O_EXCL lease is what serializes them
    // rather than any accident of sharing one JS object.
    const storeA = IdentityStore.open(dir, { lockRetryMs: 5 });
    const storeB = IdentityStore.open(dir, { lockRetryMs: 5 });

    const { user: userA } = await storeA.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'sub-a',
    });
    const { user: userB } = await storeB.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'sub-b',
    });

    const [resultA, resultB] = await Promise.allSettled([
      storeA.claimOrg({ userId: userA.id, name: 'Acme', slug: 'acme' }),
      storeB.claimOrg({ userId: userB.id, name: 'Beta', slug: 'beta' }),
    ]);

    const outcomes = [resultA, resultB];
    const fulfilled = outcomes.filter((r) => r.status === 'fulfilled');
    const rejected = outcomes.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'org-already-bootstrapped',
    });

    // Exactly one org, one team, one membership survive — no partial state from the loser.
    expect(storeA.listOrgs()).toHaveLength(1);
    const winningOrg = storeA.listOrgs()[0]!;
    expect(storeA.listTeams(winningOrg.id)).toHaveLength(1);
    expect(storeA.listOrgMembers(winningOrg.id)).toHaveLength(1);
    expect(storeA.listOrgMembers(winningOrg.id)[0]?.role).toBe('owner');

    // The loser's user has no membership anywhere — they genuinely need an invite now.
    const winnerUserId = storeA.listOrgMembers(winningOrg.id)[0]?.userId;
    const loserUserId = winnerUserId === userA.id ? userB.id : userA.id;
    expect(storeA.listMemberships(loserUserId)).toEqual([]);
  });
});

// ---- D11: claiming a SECOND (and later) org that already exists (claimOrg, claim branch — orgId
// present). Added 2026-08-07, 5b/5c/8 scaffold pass → Fill unit 7. The org here is always minted by
// `createOrg` (the admin-only `POST /internal/orgs`'s store call, per D11) rather than `claimOrg`'s
// own legacy branch — that mirrors production exactly: `claimOrg`'s claim branch never creates an
// org, it only ever attaches an owner to one `createOrg` already made. ------------------------------
describe('IdentityStore — D11 claim-an-unclaimed-org (claimOrg, claim branch — orgId present)', () => {
  it('attaches the caller as owner of an org createOrg already made, reusing its EXISTING default team (never a second one)', async () => {
    const store = IdentityStore.open(await directory());
    const { org, defaultTeam } = await store.createOrg({
      name: 'Acme Two',
      slug: 'acme2',
      claimTokenHash: 'irrelevant-to-the-store',
    });
    const { user } = await store.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'org-two-owner',
    });

    const result = await store.claimOrg({ userId: user.id, orgId: org.id });
    expect(result.org).toEqual(org);
    expect(result.defaultTeam).toEqual(defaultTeam);
    expect(result.membership).toEqual({
      userId: user.id,
      orgId: org.id,
      role: 'owner',
    });
    expect(store.getMembership(user.id, org.id)?.role).toBe('owner');
    // Still exactly one team — `createOrg`'s own default, not a second one this call minted.
    expect(store.listTeams(org.id)).toEqual([defaultTeam]);
  });

  it('refuses to claim an org that already has an owner — a second claim on the SAME org', async () => {
    const store = IdentityStore.open(await directory());
    const { org } = await store.createOrg({ name: 'Acme Two', slug: 'acme2' });
    const { user: first } = await store.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'first-claimant',
    });
    await store.claimOrg({ userId: first.id, orgId: org.id });

    const { user: second } = await store.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'second-claimant',
    });
    await expect(
      store.claimOrg({ userId: second.id, orgId: org.id }),
    ).rejects.toMatchObject({
      code: 'org-already-claimed',
    });
    expect(store.listOrgMembers(org.id)).toHaveLength(1);
    expect(store.listMemberships(second.id)).toEqual([]);
  });

  it('refuses an unknown org id without touching disk', async () => {
    const store = IdentityStore.open(await directory());
    const { user } = await store.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'claimant',
    });
    await expect(
      store.claimOrg({ userId: user.id, orgId: 'does-not-exist' }),
    ).rejects.toMatchObject({
      code: 'org-not-found',
    });
  });

  it('refuses an unknown user without touching disk', async () => {
    const store = IdentityStore.open(await directory());
    const { org } = await store.createOrg({ name: 'Acme Two', slug: 'acme2' });
    await expect(
      store.claimOrg({ userId: 'nope', orgId: org.id }),
    ).rejects.toMatchObject({
      code: 'user-not-found',
    });
    expect(store.listOrgMembers(org.id)).toEqual([]);
  });

  it('hardcodes the granted role to owner in the claim branch too', async () => {
    const store = IdentityStore.open(await directory());
    const { org } = await store.createOrg({ name: 'Acme Two', slug: 'acme2' });
    const { user } = await store.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'claimant',
    });
    const { membership } = await store.claimOrg({
      userId: user.id,
      orgId: org.id,
    });
    expect(membership.role).toBe('owner');
  });

  // ---- THE cross-claim negative: what actually makes D11's per-org code a boundary --------------
  //
  // `IdentityStore#claimOrg` never sees a raw token at all — token verification is the ROUTE's job
  // (`onboarding-routes.ts`, against `org.claimTokenHash` via `./org-claim-token.ts#matchesOrgClaimToken`),
  // so the store-level property under test here is narrower than "org A's code can't claim org B" (that
  // full claim is `onboarding-routes.test.ts`'s job, below). What THIS store must guarantee is the half
  // token verification depends on: claiming org B by ID never touches org A's rows, regardless of which
  // org a caller believes they are claiming — i.e. there is no cross-org bleed at the id-keyed layer
  // underneath the token check.
  it("claiming org B by id never claims, touches, or reads org A's membership — the store-side half of the cross-org boundary", async () => {
    const store = IdentityStore.open(await directory());
    const { org: orgA } = await store.createOrg({
      name: 'Acme One',
      slug: 'acme1',
    });
    const { org: orgB } = await store.createOrg({
      name: 'Acme Two',
      slug: 'acme2',
    });
    const { user } = await store.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'org-b-owner',
    });

    await store.claimOrg({ userId: user.id, orgId: orgB.id });

    // Org B is claimed...
    expect(store.getMembership(user.id, orgB.id)?.role).toBe('owner');
    // ...and org A — which this call never named — has NO members at all.
    expect(store.listOrgMembers(orgA.id)).toEqual([]);
    expect(store.getMembership(user.id, orgA.id)).toBeUndefined();
  });

  /**
   * ADDED 2026-08-07 (5b/5c/8 repair stage). Every guard above is about the ORG ("does this org
   * already have a member"); none was about the CALLER. So a user who already owned org A could
   * claim org B, get a second, inert membership (F4: `session.ts#resolveIdentity` takes
   * `listMemberships(userId)[0]`) — and permanently consume org B's one-shot claim doing it. The
   * assertion that matters is the last one: the refusal must leave the org CLAIMABLE.
   */
  it("refuses a claimant who already belongs to an org — and leaves the org claimable by someone who doesn't", async () => {
    const store = IdentityStore.open(await directory());
    const { org: orgA } = await store.createOrg({ name: 'Acme One', slug: 'acme1' });
    const { org: orgB } = await store.createOrg({ name: 'Acme Two', slug: 'acme2' });
    const { user: operator } = await store.findOrCreateUser({ issuer: 'https://idp.example', subject: 'operator' });
    await store.claimOrg({ userId: operator.id, orgId: orgA.id });

    await expect(store.claimOrg({ userId: operator.id, orgId: orgB.id })).rejects.toMatchObject({
      code: 'user-already-member',
    });
    expect(store.listMemberships(operator.id).map((m) => m.orgId)).toEqual([orgA.id]);
    expect(store.listOrgMembers(orgB.id)).toEqual([]);

    const { user: intended } = await store.findOrCreateUser({ issuer: 'https://idp.example', subject: 'org-b-owner' });
    await expect(store.claimOrg({ userId: intended.id, orgId: orgB.id })).resolves.toMatchObject({
      membership: { role: 'owner' },
    });
  });

  it('the LEGACY branch is untouched by that check — a first-ever user has no membership by construction', async () => {
    const store = IdentityStore.open(await directory());
    const { user } = await store.findOrCreateUser({ issuer: 'https://idp.example', subject: 'first-ever' });
    await expect(store.claimOrg({ userId: user.id, name: 'Acme', slug: 'acme' })).resolves.toMatchObject({
      membership: { role: 'owner' },
    });
  });
});

describe('IdentityStore — invites (D8: "subsequent users need an invite")', () => {
  it('creates an invite scoped to an org, redeemable via its own id', async () => {
    const store = IdentityStore.open(await directory());
    const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const expiresAt = new Date(Date.now() + 60_000);
    const invite = await store.createInvite({
      id: 'inv-1',
      orgId: org.id,
      role: 'member',
      expiresAt,
    });

    expect(invite).toMatchObject({
      id: 'inv-1',
      orgId: org.id,
      role: 'member',
    });
    expect(invite.consumedAt).toBeUndefined();
    expect(store.getInvite('inv-1')).toEqual(invite);
    expect(store.listOrgInvites(org.id)).toEqual([invite]);
  });

  it('an invite may pre-assign a team, validated against the org', async () => {
    const store = IdentityStore.open(await directory());
    const { org, defaultTeam } = await store.createOrg({
      name: 'Acme',
      slug: 'acme',
    });
    const invite = await store.createInvite({
      id: 'inv-1',
      orgId: org.id,
      teamId: defaultTeam.id,
      role: 'admin',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(invite.teamId).toBe(defaultTeam.id);
  });

  it('createInvite validates org and team the same way createProjectTeam does', async () => {
    const store = IdentityStore.open(await directory());
    const { org: orgA, defaultTeam: teamA } = await store.createOrg({
      name: 'Acme',
      slug: 'acme',
    });
    const { org: orgB } = await store.createOrg({ name: 'Beta', slug: 'beta' });
    const expiresAt = new Date(Date.now() + 60_000);

    await expect(
      store.createInvite({
        id: 'i1',
        orgId: 'nope',
        role: 'member',
        expiresAt,
      }),
    ).rejects.toMatchObject({
      code: 'org-not-found',
    });
    await expect(
      store.createInvite({
        id: 'i1',
        orgId: orgA.id,
        teamId: 'nope',
        role: 'member',
        expiresAt,
      }),
    ).rejects.toMatchObject({
      code: 'team-not-found',
    });
    await expect(
      store.createInvite({
        id: 'i1',
        orgId: orgB.id,
        teamId: teamA.id,
        role: 'member',
        expiresAt,
      }),
    ).rejects.toMatchObject({ code: 'team-org-mismatch' });
  });

  it('refuses a second invite with the same id', async () => {
    const store = IdentityStore.open(await directory());
    const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const expiresAt = new Date(Date.now() + 60_000);
    await store.createInvite({
      id: 'inv-1',
      orgId: org.id,
      role: 'member',
      expiresAt,
    });
    await expect(
      store.createInvite({
        id: 'inv-1',
        orgId: org.id,
        role: 'admin',
        expiresAt,
      }),
    ).rejects.toMatchObject({
      code: 'invite-id-taken',
    });
  });

  it("redeeming grants the invite's role AND consumes the invite in one write", async () => {
    const dir = await directory();
    const store = IdentityStore.open(dir);
    const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const { user } = await store.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'sub-1',
    });
    const invite = await store.createInvite({
      id: 'inv-1',
      orgId: org.id,
      role: 'admin',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const { invite: consumed, membership } = await store.redeemInvite({
      id: invite.id,
      userId: user.id,
    });
    expect(membership).toEqual({
      userId: user.id,
      orgId: org.id,
      role: 'admin',
    });
    expect(consumed.consumedByUserId).toBe(user.id);
    expect(consumed.consumedAt).toBeTruthy();

    // Both halves landed together, verified from a FRESH store instance reading disk — not this
    // instance's own idea of what it just wrote.
    const reopened = IdentityStore.open(dir);
    expect(reopened.getMembership(user.id, org.id)?.role).toBe('admin');
    expect(reopened.getInvite(invite.id)).toBeUndefined(); // consumed invites read as absent
    expect(reopened.listOrgInvites(org.id)[0]?.consumedByUserId).toBe(user.id); // but history survives
  });

  it('redeemInvite refuses an unknown invite', async () => {
    const store = IdentityStore.open(await directory());
    const { user } = await store.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'sub-1',
    });
    await expect(
      store.redeemInvite({ id: 'nope', userId: user.id }),
    ).rejects.toMatchObject({ code: 'invite-not-found' });
  });

  it('redeemInvite refuses an already-consumed invite (no second membership from the same invite)', async () => {
    const store = IdentityStore.open(await directory());
    const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const { user: first } = await store.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'sub-1',
    });
    const { user: second } = await store.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'sub-2',
    });
    const invite = await store.createInvite({
      id: 'inv-1',
      orgId: org.id,
      role: 'member',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await store.redeemInvite({ id: invite.id, userId: first.id });

    await expect(
      store.redeemInvite({ id: invite.id, userId: second.id }),
    ).rejects.toMatchObject({
      code: 'invite-already-consumed',
    });
    expect(store.listMemberships(second.id)).toEqual([]);
  });

  it('redeemInvite refuses an expired invite', async () => {
    const store = IdentityStore.open(await directory(), {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const { user } = await store.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'sub-1',
    });
    const invite = await store.createInvite({
      id: 'inv-1',
      orgId: org.id,
      role: 'member',
      expiresAt: new Date('2026-01-01T00:05:00.000Z'),
    });

    const expiredView = IdentityStore.open(store.dir, {
      now: () => new Date('2026-01-01T00:10:00.000Z'),
    });
    await expect(
      expiredView.redeemInvite({ id: invite.id, userId: user.id }),
    ).rejects.toMatchObject({
      code: 'invite-expired',
    });
    expect(expiredView.listMemberships(user.id)).toEqual([]);
  });

  it('redeemInvite refuses an unknown user', async () => {
    const store = IdentityStore.open(await directory());
    const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const invite = await store.createInvite({
      id: 'inv-1',
      orgId: org.id,
      role: 'member',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      store.redeemInvite({ id: invite.id, userId: 'nope' }),
    ).rejects.toMatchObject({ code: 'user-not-found' });
  });

  it('redeemInvite refuses when the user already has a membership in that org', async () => {
    const store = IdentityStore.open(await directory());
    const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const { user } = await store.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'sub-1',
    });
    await store.createMembership({
      userId: user.id,
      orgId: org.id,
      role: 'owner',
    });
    const invite = await store.createInvite({
      id: 'inv-1',
      orgId: org.id,
      role: 'member',
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      store.redeemInvite({ id: invite.id, userId: user.id }),
    ).rejects.toMatchObject({ code: 'membership-exists' });
    // The pre-existing membership's role is untouched — redemption never downgrades an existing owner.
    expect(store.getMembership(user.id, org.id)?.role).toBe('owner');
  });

  /**
   * ADDED 2026-08-07 (5b/5c/8 repair stage). The case above only covers a membership in the SAME
   * org. A membership in a DIFFERENT one used to sail through: the write landed, and
   * `session.ts#resolveIdentity` then ignored it forever (F4 — `listMemberships(userId)[0]`), while
   * `consumedAt` was stamped in the same guarded write so the token could never be re-spent. The
   * two assertions after the rejection are the point: nothing written, nothing burnt.
   */
  it('redeemInvite refuses a user who already belongs to ANOTHER org — and does not consume the invite', async () => {
    const store = IdentityStore.open(await directory());
    const { org: orgA } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const { org: orgB } = await store.createOrg({ name: 'Beta', slug: 'beta' });
    const { user } = await store.findOrCreateUser({ issuer: 'https://idp.example', subject: 'sub-1' });
    await store.createMembership({ userId: user.id, orgId: orgA.id, role: 'member' });
    const invite = await store.createInvite({
      id: 'inv-cross-org',
      orgId: orgB.id,
      role: 'owner',
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(store.redeemInvite({ id: invite.id, userId: user.id })).rejects.toMatchObject({
      code: 'user-already-member',
    });
    expect(store.listMemberships(user.id).map((m) => m.orgId)).toEqual([orgA.id]);
    // Unconsumed — a fresh, org-less user can still redeem exactly this token.
    expect(store.getInvite(invite.id)?.consumedAt).toBeUndefined();
    const { user: fresh } = await store.findOrCreateUser({ issuer: 'https://idp.example', subject: 'sub-fresh' });
    await expect(store.redeemInvite({ id: invite.id, userId: fresh.id })).resolves.toMatchObject({
      membership: { orgId: orgB.id, role: 'owner' },
    });
  });

  it('THE RACE: two users redeeming the SAME invite simultaneously — exactly one succeeds', async () => {
    const dir = await directory();
    const seed = IdentityStore.open(dir);
    const { org } = await seed.createOrg({ name: 'Acme', slug: 'acme' });
    const { user: userA } = await seed.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'sub-a',
    });
    const { user: userB } = await seed.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'sub-b',
    });
    const invite = await seed.createInvite({
      id: 'inv-1',
      orgId: org.id,
      role: 'member',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const storeA = IdentityStore.open(dir, { lockRetryMs: 5 });
    const storeB = IdentityStore.open(dir, { lockRetryMs: 5 });
    const [resultA, resultB] = await Promise.allSettled([
      storeA.redeemInvite({ id: invite.id, userId: userA.id }),
      storeB.redeemInvite({ id: invite.id, userId: userB.id }),
    ]);

    const fulfilled = [resultA, resultB].filter(
      (r) => r.status === 'fulfilled',
    );
    const rejected = [resultA, resultB].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'invite-already-consumed',
    });
    expect(seed.listOrgMembers(org.id)).toHaveLength(1);
  });

  it('revokeInvite deletes an active invite, and is idempotent for unknown/consumed/expired ones', async () => {
    const store = IdentityStore.open(await directory(), {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const { user } = await store.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'sub-1',
    });

    // Active invite: revoke actually removes it.
    const active = await store.createInvite({
      id: 'inv-active',
      orgId: org.id,
      role: 'member',
      expiresAt: new Date('2026-01-01T00:05:00.000Z'),
    });
    expect(await store.revokeInvite(active.id)).toBe(true);
    expect(store.getInvite(active.id)).toBeUndefined();
    expect(store.listOrgInvites(org.id)).toEqual([]); // fully gone, no dead row left behind

    // Unknown invite: no-op.
    expect(await store.revokeInvite('never-existed')).toBe(false);

    // Consumed invite: no-op, and its history (who redeemed it) survives the revoke call.
    const consumable = await store.createInvite({
      id: 'inv-consumed',
      orgId: org.id,
      role: 'member',
      expiresAt: new Date('2026-01-01T00:05:00.000Z'),
    });
    await store.redeemInvite({ id: consumable.id, userId: user.id });
    expect(await store.revokeInvite(consumable.id)).toBe(false);
    expect(
      store.listOrgInvites(org.id).find((i) => i.id === consumable.id)
        ?.consumedByUserId,
    ).toBe(user.id);

    // Expired invite: no-op, and it is also retained (not silently purged by a revoke call).
    const expired = await store.createInvite({
      id: 'inv-expired',
      orgId: org.id,
      role: 'member',
      expiresAt: new Date('2025-01-01T00:00:00.000Z'),
    });
    expect(await store.revokeInvite(expired.id)).toBe(false);
    expect(
      store.listOrgInvites(org.id).find((i) => i.id === expired.id),
    ).toBeDefined();
  });
});

describe('IdentityStore — a membership is never inferred, only ever explicitly granted (regression)', () => {
  it('signing in and having an unredeemed invite sitting around grants NOTHING by itself', async () => {
    const store = IdentityStore.open(await directory());
    const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const { user } = await store.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'sub-1',
    });
    await store.createInvite({
      id: 'inv-1',
      orgId: org.id,
      role: 'admin',
      expiresAt: new Date(Date.now() + 60_000),
    });

    // The user exists and an invite exists for the SAME org — but nobody redeemed it, so the
    // user has no membership, which is what `session.ts`'s `resolveFromCookieHeader` (untouched by
    // this unit) keys "resolves to no principal, and every /api/* route 401s" on — see
    // `session.test.ts`'s own "a valid, unexpired session for a user with no org membership yet
    // resolves to null" test and `server/auth-perimeter.test.ts`'s 401 matrix, both re-run
    // unmodified by this session's gates.
    expect(store.listMemberships(user.id)).toEqual([]);
  });
});

describe('IdentityStore — sessions', () => {
  it('an expired session reads as absent, and deleteSession is idempotent logout', async () => {
    const store = IdentityStore.open(await directory(), {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const { user } = await store.findOrCreateUser({
      issuer: 'https://idp.example',
      subject: 'sub-1',
    });
    const session = await store.createSession({
      id: 'sess-1',
      userId: user.id,
      expiresAt: new Date('2026-01-01T00:05:00.000Z'),
    });
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
    await expect(
      store.createSession({
        id: 's',
        userId: 'nope',
        expiresAt: new Date(Date.now() + 1000),
      }),
    ).rejects.toMatchObject({
      code: 'user-not-found',
    });
  });
});

describe('IdentityStore — the write lease actually serializes concurrent writers', () => {
  it('a write blocked on a held lease waits, then re-reads fresh disk state instead of clobbering it', async () => {
    const dir = await directory();
    const store = IdentityStore.open(dir, {
      lockRetryMs: 5,
      lockTimeoutMs: 2_000,
    });

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
        orgs: [
          {
            id: 'other-id',
            name: 'Other Org',
            slug: 'other',
            createdAt: new Date().toISOString(),
          },
        ],
        teams: [],
        users: [],
        memberships: [],
        projectTeams: [],
        sessions: [],
      }),
    );
    externalLease?.release();

    await writePromise;
    expect(
      store
        .listOrgs()
        .map((o) => o.slug)
        .sort(),
    ).toEqual(['acme', 'other']);
  });

  it('gives up with lease-timeout rather than hanging forever when the lease never frees', async () => {
    const dir = await directory();
    const store = IdentityStore.open(dir, {
      lockRetryMs: 5,
      lockTimeoutMs: 40,
    });
    const externalLease = store.acquireLease();
    expect(externalLease).toBeDefined();

    await expect(
      store.createOrg({ name: 'Acme', slug: 'acme' }),
    ).rejects.toMatchObject({ code: 'lease-timeout' });
    // The write never got past the lease, so it never touched the snapshot file at all.
    expect(existsSync(join(dir, 'identity.json'))).toBe(false);

    externalLease?.release();
    await expect(
      store.createOrg({ name: 'Acme', slug: 'acme' }),
    ).resolves.toMatchObject({ org: { slug: 'acme' } });
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

describe('IdentityStore — uniqueness checks run INSIDE the lease, under real interleaving', () => {
  // These two are deliberately NOT the "await A, then await B and expect it to reject" shape
  // already covered above (that only proves serial rejection — a check run once at import time
  // would still pass it). Both calls below are issued in the SAME synchronous tick, with no
  // `await` between them, so both start executing before either has acquired the lease. If the
  // uniqueness check ran against a snapshot read BEFORE the lease was taken — the exact bug D7
  // exists to forbid ("write it as one guarded helper... or the guarantee decays to 'every caller
  // remembered'") — both callers would see an empty/pre-collision snapshot, both would pass their
  // check, and both writes would land, producing two rows with the same slug. The real
  // implementation re-reads the snapshot fresh only once the lease is actually held
  // (`guardedWrite`), so the second writer's check runs against the first writer's already-written
  // row and loses — that is what these tests prove.
  it('two truly concurrent createOrg calls for the same slug: exactly one wins, one is refused', async () => {
    const dir = await directory();
    const store = IdentityStore.open(dir, { lockRetryMs: 5 });

    const results = await Promise.allSettled([
      store.createOrg({ name: 'Acme One', slug: 'acme' }),
      store.createOrg({ name: 'Acme Two', slug: 'acme' }),
    ]);

    const fulfilled = results.filter(
      (
        r,
      ): r is PromiseFulfilledResult<
        Awaited<ReturnType<typeof store.createOrg>>
      > => r.status === 'fulfilled',
    );
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(IdentityStoreError);
    expect(rejected[0]?.reason).toMatchObject({ code: 'org-slug-taken' });

    // Only the winner's org (and its default team) is ever on disk — never both, never neither.
    expect(store.listOrgs()).toHaveLength(1);
    expect(store.listOrgs()[0]?.slug).toBe('acme');
    expect(store.listOrgs()[0]?.name).toBe(fulfilled[0]!.value.org.name);
  });

  it('two truly concurrent createTeam calls for the same (org, slug): exactly one wins, one is refused', async () => {
    const store = IdentityStore.open(await directory(), { lockRetryMs: 5 });
    const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });

    const results = await Promise.allSettled([
      store.createTeam({
        orgId: org.id,
        name: 'Engineering A',
        slug: 'engineering',
      }),
      store.createTeam({
        orgId: org.id,
        name: 'Engineering B',
        slug: 'engineering',
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'team-slug-taken' });

    // The default "general" team plus exactly one "engineering" — never two.
    expect(
      store
        .listTeams(org.id)
        .map((t) => t.slug)
        .sort(),
    ).toEqual(['engineering', 'general']);
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
    await store.createTeam({
      orgId: org.id,
      name: 'Marketing',
      slug: 'marketing',
    });
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
