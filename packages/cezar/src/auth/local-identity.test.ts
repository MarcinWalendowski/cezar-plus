import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IdentityStore } from './identity-store.ts';
import {
  adoptRegisteredProjectIntoLocalOrg,
  invalidateLocalOrgIdentityCache,
  resolveLocalOrgIdentity,
} from './local-identity.ts';

const dirs: string[] = [];

async function directory(prefix = 'cezar-local-identity-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Like `directory()`, but realpath-normalized (`.native`, matching
 *  `IdentityStore#createProjectTeam`'s own normalization — see that method's doc comment) — for a
 *  path handed to `adoptRegisteredProjectIntoLocalOrg`/`createProjectTeam`/`getProjectTeam` as a
 *  PROJECT ROOT specifically. Without this, macOS's `/var` → `/private/var` temp-dir symlink makes
 *  `mkdtemp`'s raw return value a different string than the realpath `createProjectTeam` stores as
 *  the `project_teams` PRIMARY KEY, and a later `getProjectTeam(rawPath)` look-up in the SAME test
 *  misses the row it just wrote. */
async function projectDirectory(): Promise<string> {
  return realpathSync.native(await directory('cezar-local-identity-project-'));
}

// The cache this module exposes is a single module-level slot (by design — see the module's own
// doc comment on why that's the right shape in production). Every test here therefore starts and
// ends with it reset, exactly the discipline the module doc asks callers exercising more than one
// `CEZ_HOME` in one process to follow.
beforeEach(() => {
  invalidateLocalOrgIdentityCache();
});
afterEach(async () => {
  invalidateLocalOrgIdentityCache();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('resolveLocalOrgIdentity — the never-onboards case (D13: one stat, creates nothing)', () => {
  it('returns null on a clean CEZ_HOME with no identity.json', async () => {
    const dir = await directory();
    expect(resolveLocalOrgIdentity(dir)).toBeNull();
  });

  it('creates no identity directory and no identity.json file as a side effect of resolving', async () => {
    const dir = await directory();
    resolveLocalOrgIdentity(dir);
    expect(existsSync(join(dir, 'identity.json'))).toBe(false);
  });

  it('does NOT cache the "none" answer past a write from another handle — cross-process staleness fix (D13 repair round 4)', async () => {
    const dir = await directory();
    expect(resolveLocalOrgIdentity(dir)).toBeNull();

    // Simulate the store being written by some other means (a second `cezar serve` sharing this
    // `CEZ_HOME`, a `cezar projects add` CLI invocation, or — as a same-process stand-in for either,
    // since `IdentityStore` itself keeps no in-memory cache and always reads the file fresh — a
    // second store handle here) WITHOUT this module being told to invalidate. Before the fingerprint
    // check, this second call kept trusting the cached 'none' forever — exactly the defect the D13
    // repair-round-4 fix closes: a reader that never learns the org exists files every project it
    // touches under nothing, permanently. `identity.json`'s mtime/size moved when `claimOrg` wrote,
    // so the next resolution must notice regardless of who wrote it.
    const store = IdentityStore.open(dir);
    const { user } = await store.findOrCreateLocalUser();
    const { org, defaultTeam } = await store.claimOrg({
      userId: user.id,
      name: 'Solo',
      slug: 'solo',
    });

    expect(resolveLocalOrgIdentity(dir)).toEqual({
      userId: user.id,
      orgId: org.id,
      teamId: defaultTeam.id,
      role: 'owner',
    });
  });
});

describe('resolveLocalOrgIdentity — a resolved local org (D13: auth off, org created)', () => {
  it('resolves the local user\'s userId/orgId/teamId/role once claimOrg has run', async () => {
    const dir = await directory();
    const store = IdentityStore.open(dir);
    const { user } = await store.findOrCreateLocalUser();
    const { org, defaultTeam } = await store.claimOrg({
      userId: user.id,
      name: 'Solo Org',
      slug: 'solo-org',
    });

    const identity = resolveLocalOrgIdentity(dir);
    expect(identity).toEqual({
      userId: user.id,
      orgId: org.id,
      teamId: defaultTeam.id,
      role: 'owner',
    });
  });

  it('reuses the SAME local user row findOrCreateLocalUser produced — issuer/subject "local"/"local"', async () => {
    const dir = await directory();
    const store = IdentityStore.open(dir);
    const { user } = await store.findOrCreateLocalUser();
    expect(user.issuer).toBe('local');
    expect(user.subject).toBe('local');

    await store.claimOrg({ userId: user.id, name: 'Solo', slug: 'solo' });
    expect(resolveLocalOrgIdentity(dir)?.userId).toBe(user.id);
  });

  it('caches the resolved identity — deleting the underlying identity.json after resolution does not un-resolve it', async () => {
    const dir = await directory();
    const store = IdentityStore.open(dir);
    const { user } = await store.findOrCreateLocalUser();
    const { org } = await store.claimOrg({ userId: user.id, name: 'Solo', slug: 'solo' });

    const first = resolveLocalOrgIdentity(dir);
    expect(first?.orgId).toBe(org.id);

    await rm(join(dir, 'identity.json'));
    // Still cached — no re-read happened, so the deletion is invisible until invalidated.
    expect(resolveLocalOrgIdentity(dir)).toEqual(first);
  });

  it('invalidateLocalOrgIdentityCache() forces a fresh read on the next call', async () => {
    const dir = await directory();
    expect(resolveLocalOrgIdentity(dir)).toBeNull(); // caches 'none'

    const store = IdentityStore.open(dir);
    const { user } = await store.findOrCreateLocalUser();
    const { org, defaultTeam } = await store.claimOrg({
      userId: user.id,
      name: 'Solo',
      slug: 'solo',
    });

    invalidateLocalOrgIdentityCache();
    expect(resolveLocalOrgIdentity(dir)).toEqual({
      userId: user.id,
      orgId: org.id,
      teamId: defaultTeam.id,
      role: 'owner',
    });
  });

  it('notices which team is "the" team changing after a resolution has already cached the old one — cross-process fix, second required direction (D13 repair round 4)', async () => {
    const dir = await directory();
    const store = IdentityStore.open(dir);
    const { user } = await store.findOrCreateLocalUser();
    const { org, defaultTeam: firstTeam } = await store.claimOrg({
      userId: user.id,
      name: 'Solo',
      slug: 'solo',
    });

    const cached = resolveLocalOrgIdentity(dir);
    expect(cached?.teamId).toBe(firstTeam.id);

    // Behind the resolver's back, and WITHOUT calling invalidateLocalOrgIdentityCache: a second
    // team is created, then the first (the one this process already resolved and cached) is
    // deleted. `listTeams(orgId)[0]` — the exact selection `resolveLocalOrgIdentity` and
    // `session.ts#resolveIdentity` both make — now names the second team. Before the fingerprint
    // check this stayed invisible for the rest of the process's life; `identity.json`'s mtime/size
    // moved on both writes, so the next resolution must pick it up.
    const secondTeam = await store.createTeam({
      orgId: org.id,
      name: 'Marketing',
      slug: 'marketing',
    });
    await store.deleteTeam(firstTeam.id);

    const resolved = resolveLocalOrgIdentity(dir);
    expect(resolved?.teamId).toBe(secondTeam.id);
    expect(resolved?.orgId).toBe(org.id);
    expect(resolved?.userId).toBe(user.id);
  });
});

describe('resolveLocalOrgIdentity — partial state degrades to null, never throws (D13)', () => {
  it('a local user row with no membership yet (the window between findOrCreateLocalUser and claimOrg) resolves null', async () => {
    const dir = await directory();
    const store = IdentityStore.open(dir);
    await store.findOrCreateLocalUser(); // identity.json now exists, but no org/membership yet

    expect(resolveLocalOrgIdentity(dir)).toBeNull();
  });

  it('does not cache the partial-state null as unconditionally permanent — invalidation still allows resolving afterward', async () => {
    const dir = await directory();
    const store = IdentityStore.open(dir);
    const { user } = await store.findOrCreateLocalUser();
    expect(resolveLocalOrgIdentity(dir)).toBeNull();

    const { org } = await store.claimOrg({ userId: user.id, name: 'Solo', slug: 'solo' });
    invalidateLocalOrgIdentityCache();
    expect(resolveLocalOrgIdentity(dir)?.orgId).toBe(org.id);
  });
});

describe('adoptRegisteredProjectIntoLocalOrg — FIX 5 (D13 repair pass): filing is ongoing, not one-shot', () => {
  it('is a no-op when no local org exists yet — creates no identity.json', async () => {
    const dir = await directory();
    const projectDir = await projectDirectory();

    await adoptRegisteredProjectIntoLocalOrg(dir, projectDir);

    expect(existsSync(join(dir, 'identity.json'))).toBe(false);
  });

  it('files a project under the local org\'s default team once one exists', async () => {
    const dir = await directory();
    const projectDir = await projectDirectory();
    const store = IdentityStore.open(dir);
    const { user } = await store.findOrCreateLocalUser();
    const { org, defaultTeam } = await store.claimOrg({ userId: user.id, name: 'Solo', slug: 'solo' });

    await adoptRegisteredProjectIntoLocalOrg(dir, projectDir);

    expect(store.getProjectTeam(projectDir)).toEqual({
      projectRoot: projectDir,
      orgId: org.id,
      teamId: defaultTeam.id,
    });
  });

  it('is idempotent — filing the SAME root twice does not throw', async () => {
    const dir = await directory();
    const projectDir = await projectDirectory();
    const store = IdentityStore.open(dir);
    const { user } = await store.findOrCreateLocalUser();
    await store.claimOrg({ userId: user.id, name: 'Solo', slug: 'solo' });

    await adoptRegisteredProjectIntoLocalOrg(dir, projectDir);
    await expect(adoptRegisteredProjectIntoLocalOrg(dir, projectDir)).resolves.toBeUndefined();
  });

  it('reads the resolver\'s cache, not a fresh read — reflects an org created earlier in the SAME process without a second onboarding call', async () => {
    const dir = await directory();
    const projectDir = await projectDirectory();
    const store = IdentityStore.open(dir);
    const { user } = await store.findOrCreateLocalUser();
    const { org, defaultTeam } = await store.claimOrg({ userId: user.id, name: 'Solo', slug: 'solo' });
    invalidateLocalOrgIdentityCache();
    // Warm the cache exactly the way `POST /auth/onboarding/org` leaves it (invalidated, then
    // resolved fresh on the next read) rather than asserting anything about caching mechanics here
    // — this test is about the ADOPTION reading whatever the resolver currently reports.
    resolveLocalOrgIdentity(dir);

    await adoptRegisteredProjectIntoLocalOrg(dir, projectDir);

    expect(store.getProjectTeam(projectDir)?.orgId).toBe(org.id);
    expect(store.getProjectTeam(projectDir)?.teamId).toBe(defaultTeam.id);
  });
});

describe('resolveLocalOrgIdentity — mirrors session.ts#resolveIdentity\'s "oldest membership, oldest team" selection', () => {
  it('picks listMemberships(userId)[0] and listTeams(orgId)[0], the same fields session.ts reads', async () => {
    const dir = await directory();
    const store = IdentityStore.open(dir);
    const { user } = await store.findOrCreateLocalUser();
    const { org, defaultTeam } = await store.claimOrg({
      userId: user.id,
      name: 'Solo',
      slug: 'solo',
    });

    expect(store.listMemberships(user.id)[0]?.orgId).toBe(org.id);
    expect(store.listTeams(org.id)[0]?.id).toBe(defaultTeam.id);
    expect(resolveLocalOrgIdentity(dir)).toEqual({
      userId: user.id,
      orgId: org.id,
      teamId: defaultTeam.id,
      role: 'owner',
    });
  });
});
