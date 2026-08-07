import { describe, expect, it } from 'vitest';
import {
  emptyOrgProcessRegistry,
  orgProcessRecordSchema,
  orgProcessRegistrySchema,
  type OrgProcessRecord,
} from './org-process-registry.ts';

function record(overrides: Partial<OrgProcessRecord> = {}): OrgProcessRecord {
  return {
    orgId: 'org_acme',
    orgSlug: 'acme',
    unixUser: 'cez-acme',
    cezHome: '/var/lib/cezar/orgs/acme',
    loopbackPort: 4400,
    hostname: 'acme.cezar.example.com',
    platformId: 'hetzner',
    supervisorSecret: 'x'.repeat(32),
    status: 'active',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('orgProcessRecordSchema', () => {
  it('accepts a fully-formed record', () => {
    expect(orgProcessRecordSchema.safeParse(record()).success).toBe(true);
  });

  it('rejects a platformId other than the one closed literal', () => {
    const result = orgProcessRecordSchema.safeParse({ ...record(), platformId: 'ubuntu-vps' });
    expect(result.success).toBe(false);
  });

  it('rejects a secret shorter than 32 chars — the minimum this schema will accept as an HMAC key', () => {
    const result = orgProcessRecordSchema.safeParse({ ...record(), supervisorSecret: 'too-short' });
    expect(result.success).toBe(false);
  });

  it('rejects a port outside the valid TCP range', () => {
    expect(orgProcessRecordSchema.safeParse({ ...record(), loopbackPort: 70_000 }).success).toBe(false);
    expect(orgProcessRecordSchema.safeParse({ ...record(), loopbackPort: 0 }).success).toBe(false);
  });

  it('is .passthrough() — an unknown key from a newer writer survives a round-trip', () => {
    const withExtra = { ...record(), futureField: 'kept' };
    const parsed = orgProcessRecordSchema.parse(withExtra);
    expect((parsed as typeof withExtra).futureField).toBe('kept');
  });
});

describe('orgProcessRegistrySchema / emptyOrgProcessRegistry', () => {
  it('the empty registry validates against its own schema', () => {
    expect(orgProcessRegistrySchema.safeParse(emptyOrgProcessRegistry()).success).toBe(true);
  });

  it('accepts a registry with multiple orgs, each independently validated', () => {
    const registry = { version: 1 as const, orgs: [record({ orgSlug: 'acme' }), record({ orgSlug: 'beta', orgId: 'org_beta', hostname: 'beta.cezar.example.com' })] };
    expect(orgProcessRegistrySchema.safeParse(registry).success).toBe(true);
  });

  it('rejects a registry carrying one invalid org row rather than silently dropping it', () => {
    const registry = { version: 1 as const, orgs: [record(), { ...record(), loopbackPort: -1 }] };
    // Deliberately whole-array validation here, unlike `identity-store.ts`'s per-entry salvage —
    // this schema is the CONTRACT; whichever store Fill unit 1 builds around it decides its own
    // salvage policy, the same separation `identitySnapshotSchema`'s own doc comment describes.
    expect(orgProcessRegistrySchema.safeParse(registry).success).toBe(false);
  });
});
