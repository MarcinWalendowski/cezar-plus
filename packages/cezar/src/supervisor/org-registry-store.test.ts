import { existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OrgProcessRegistryError, OrgProcessRegistryStore, type OrgProcessRegistrationInput } from './org-registry-store.ts';

const dirs: string[] = [];

async function directory(prefix = 'cezar-org-registry-'): Promise<string> {
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

function registration(overrides: Partial<OrgProcessRegistrationInput> = {}): OrgProcessRegistrationInput {
  return {
    orgId: 'org_acme',
    orgSlug: 'acme',
    unixUser: 'cez-acme',
    cezHome: '/var/lib/cezar/orgs/acme',
    loopbackPort: 4400,
    hostname: 'acme.cezar.example.com',
    platformId: 'hetzner',
    supervisorSecret: 'x'.repeat(32),
    ...overrides,
  };
}

describe('OrgProcessRegistryStore — register (the "start" half)', () => {
  it('registers an org, active, at private permissions, restart-durable on disk', async () => {
    const dir = await directory();
    const store = OrgProcessRegistryStore.open(dir);
    const record = await store.register(registration());

    expect(record.status).toBe('active');
    expect(record.orgId).toBe('org_acme');
    expect(store.list()).toEqual([record]);
    expect(store.getActiveByOrgId('org_acme')).toEqual(record);
    expect(store.getActiveByHostname('acme.cezar.example.com')).toEqual(record);
    expect(store.getActiveBySlug('acme')).toEqual(record);

    const path = join(dir, 'org-process-registry.json');
    await expect(stat(path).then((s) => s.mode & 0o777)).resolves.toBe(0o600);
    await expect(stat(dir).then((s) => s.mode & 0o777)).resolves.toBe(0o700);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    // Restart survival: a FRESH store instance over the same directory sees the same record —
    // there is no in-memory registry to lose across a process restart.
    const reopened = OrgProcessRegistryStore.open(dir);
    expect(reopened.getActiveByOrgId('org_acme')).toEqual(record);
  });

  it('refuses to start a second process for an org that already has an active one (D4)', async () => {
    const dir = await directory();
    const store = OrgProcessRegistryStore.open(dir);
    await store.register(registration());
    await expect(store.register(registration({ hostname: 'acme-2.cezar.example.com', loopbackPort: 4401 }))).rejects.toBeInstanceOf(
      OrgProcessRegistryError,
    );
    await expect(store.register(registration({ hostname: 'acme-2.cezar.example.com', loopbackPort: 4401 }))).rejects.toMatchObject({
      code: 'org-already-provisioned',
    });
    // Only the first record persisted — the refused call wrote nothing.
    expect(store.list()).toHaveLength(1);
  });

  it('refuses a hostname already routed to a DIFFERENT org\'s active process', async () => {
    const dir = await directory();
    const store = OrgProcessRegistryStore.open(dir);
    await store.register(registration({ orgId: 'org_acme', orgSlug: 'acme' }));
    await expect(
      store.register(registration({ orgId: 'org_beta', orgSlug: 'beta', loopbackPort: 4401 /* same hostname */ })),
    ).rejects.toMatchObject({ code: 'hostname-taken' });
  });

  it('refuses a loopback port already bound to a DIFFERENT org\'s active process', async () => {
    const dir = await directory();
    const store = OrgProcessRegistryStore.open(dir);
    await store.register(registration({ orgId: 'org_acme', orgSlug: 'acme' }));
    await expect(
      store.register(registration({ orgId: 'org_beta', orgSlug: 'beta', hostname: 'beta.cezar.example.com' /* same port */ })),
    ).rejects.toMatchObject({ code: 'port-taken' });
  });

  it('a deprovisioned org frees its hostname AND port for reuse — by itself or another org', async () => {
    const dir = await directory();
    const store = OrgProcessRegistryStore.open(dir);
    await store.register(registration({ orgId: 'org_acme', orgSlug: 'acme' }));
    await store.deprovision('org_acme');

    // Re-provisioning the SAME org onto the same hostname/port succeeds now that the old record
    // is no longer active.
    const reprovisioned = await store.register(registration({ orgId: 'org_acme', orgSlug: 'acme' }));
    expect(reprovisioned.status).toBe('active');
    expect(store.getActiveByOrgId('org_acme')).toEqual(reprovisioned);

    // History is kept, not overwritten — two rows for org_acme, one deprovisioned and one active.
    expect(store.list().filter((r) => r.orgId === 'org_acme')).toHaveLength(2);
  });
});

describe('OrgProcessRegistryStore — deprovision (the "stop" half)', () => {
  it('flips status to deprovisioned and clears getActive* reads, keeping the row for history', async () => {
    const dir = await directory();
    const store = OrgProcessRegistryStore.open(dir);
    await store.register(registration());

    await expect(store.deprovision('org_acme')).resolves.toBe(true);
    expect(store.getActiveByOrgId('org_acme')).toBeUndefined();
    expect(store.getActiveByHostname('acme.cezar.example.com')).toBeUndefined();
    // ADDED 2026-08-07 (repair stage): the third `getActive*` read was named in this test's own
    // title and then not asserted, so `getActiveBySlug`'s `status === 'active'` filter was the one
    // of the three no test could see removed — mutation testing confirmed it survived. A slug is
    // the most reusable key of the three (a deprovisioned "acme" is exactly what a re-provisioned
    // "acme" is called), so resurrecting a stale row here would route a live hostname at a dead
    // org's record.
    expect(store.getActiveBySlug('acme')).toBeUndefined();
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.status).toBe('deprovisioned');
  });

  it('is idempotent — deprovisioning an unknown or already-deprovisioned org is not an error', async () => {
    const dir = await directory();
    const store = OrgProcessRegistryStore.open(dir);
    await expect(store.deprovision('does-not-exist')).resolves.toBe(false);

    await store.register(registration());
    await store.deprovision('org_acme');
    await expect(store.deprovision('org_acme')).resolves.toBe(false);
  });
});

describe('OrgProcessRegistryStore — reads degrade gracefully, never throw', () => {
  it('a missing registry file reads as empty, not an error', async () => {
    const dir = await directory();
    const store = OrgProcessRegistryStore.open(dir);
    expect(store.list()).toEqual([]);
    expect(store.getActiveByOrgId('org_acme')).toBeUndefined();
  });

  it('a corrupt registry file reads as empty, with one warning, and does not crash the next write', async () => {
    const dir = await directory();
    writeFileSync(join(dir, 'org-process-registry.json'), '{not json');
    const warnings: string[] = [];
    const store = OrgProcessRegistryStore.open(dir, { warn: (m) => warnings.push(m) });
    expect(store.list()).toEqual([]);
    expect(warnings).toHaveLength(1);
    await expect(store.register(registration())).resolves.toMatchObject({ status: 'active' });
  });
});

describe('OrgProcessRegistryStore — the write lease actually serializes concurrent writers', () => {
  it('a write blocked on a held lease waits, then re-reads fresh disk state instead of clobbering it', async () => {
    const dir = await directory();
    const store = OrgProcessRegistryStore.open(dir, { lockRetryMs: 5, lockTimeoutMs: 2_000 });

    const externalLease = store.acquireLease();
    expect(externalLease).toBeDefined();

    const writePromise = store.register(registration({ orgId: 'org_acme', orgSlug: 'acme' }));
    let settled = false;
    void writePromise.then(() => {
      settled = true;
    });

    await sleep(60);
    expect(settled).toBe(false);

    // A different "writer" finishes its own transaction directly on disk, then releases the
    // lease. If `register` above resumed from a snapshot read BEFORE this point, its write would
    // stomp this org out of existence.
    writeFileSync(
      join(dir, 'org-process-registry.json'),
      JSON.stringify({
        version: 1,
        orgs: [
          {
            orgId: 'org_other',
            orgSlug: 'other',
            unixUser: 'cez-other',
            cezHome: '/var/lib/cezar/orgs/other',
            loopbackPort: 4500,
            hostname: 'other.cezar.example.com',
            platformId: 'hetzner',
            supervisorSecret: 'y'.repeat(32),
            status: 'active',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    externalLease?.release();

    await writePromise;
    expect(store.list().map((r) => r.orgSlug).sort()).toEqual(['acme', 'other']);
  });

  it('gives up with lease-timeout rather than hanging forever when the lease never frees', async () => {
    const dir = await directory();
    const store = OrgProcessRegistryStore.open(dir, { lockRetryMs: 5, lockTimeoutMs: 40 });
    const externalLease = store.acquireLease();
    expect(externalLease).toBeDefined();

    await expect(store.register(registration())).rejects.toMatchObject({ code: 'lease-timeout' });
    expect(existsSync(join(dir, 'org-process-registry.json'))).toBe(false);

    externalLease?.release();
    await expect(store.register(registration())).resolves.toMatchObject({ status: 'active' });
  });

  it('reclaims a lease held longer than the stale window', async () => {
    const dir = await directory();
    const store = OrgProcessRegistryStore.open(dir, { staleLeaseMs: 1_000 });
    const first = store.acquireLease();
    expect(first).toBeDefined();
    expect(store.acquireLease()).toBeUndefined();
    const lockPath = join(dir, 'org-process-registry.lock');
    const past = new Date(Date.now() - 5_000);
    utimesSync(lockPath, past, past);
    expect(store.acquireLease()).toBeDefined();
  });
});
