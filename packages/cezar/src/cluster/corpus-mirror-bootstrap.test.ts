import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLUSTER_CORPUS_DEFAULT_SCOPE, type StoredClusterNodeIdentity } from '@loki-labs/cezar-plus-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { CEZAR_HUB_SOURCE_KIND } from '../sources/cezar-hub/provider.ts';
import { SourceStore } from '../sources/store.ts';
import { ensureCorpusMirrorConnection } from './corpus-mirror-bootstrap.ts';

/**
 * Package closing the gap the 2026-08-24 handoff measured (spec
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, S5/D8a): nothing in production ever created
 * a `cezar-hub` `SourceConnection`, so a spoke mirrored nothing, forever, silently. Every test here
 * has a negative half, per the handoff's own "Verification" list for S5.
 */

const dirs: string[] = [];
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cez-corpus-mirror-bootstrap-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function spokeIdentity(overrides: Partial<StoredClusterNodeIdentity> = {}): StoredClusterNodeIdentity {
  return {
    nodeId: 'node-1',
    nodeName: 'worker-1',
    createdAt: new Date(0).toISOString(),
    role: 'spoke',
    hubUrl: 'https://hub.example',
    secret: 'shh',
    acceptsDispatch: false,
    labels: [],
    ...overrides,
  };
}

function hubIdentity(overrides: Partial<StoredClusterNodeIdentity> = {}): StoredClusterNodeIdentity {
  return {
    nodeId: 'hub-1',
    nodeName: 'the-hub',
    createdAt: new Date(0).toISOString(),
    role: 'hub',
    acceptsDispatch: false,
    labels: [],
    ...overrides,
  };
}

describe('ensureCorpusMirrorConnection — creates on a spoke (S5)', () => {
  it('creates a cezar-hub connection carrying the hub URL and the FULL default scope', async () => {
    const dataDir = await directory();
    const identity = spokeIdentity({ hubUrl: 'https://hub.example' });

    const result = ensureCorpusMirrorConnection({ dataDir, identity });

    expect(result.status).toBe('created');
    expect(result.connectionId).toBeDefined();

    const store = SourceStore.open(dataDir);
    const connections = store.list();
    expect(connections).toHaveLength(1);
    const connection = connections[0]!;
    expect(connection.kind).toBe(CEZAR_HUB_SOURCE_KIND);
    expect((connection as Record<string, unknown>).hubUrl).toBe('https://hub.example');
    // Assert the CONTENTS, not merely that a scope is present — the default changed 2026-08-24 to
    // all six scopes (knowledge/domains/changelog/tasks/reports/raw-input); a `.length > 0`
    // assertion would not have caught it still being the old four-scope default.
    expect((connection as Record<string, unknown>).scope).toEqual([...CLUSTER_CORPUS_DEFAULT_SCOPE]);
    expect(CLUSTER_CORPUS_DEFAULT_SCOPE).toEqual(['knowledge', 'domains', 'changelog', 'tasks', 'reports', 'raw-input']);
    expect(connection.enabled).toBe(true);
    expect(connection.mode).toBe('mirror');
  });

  it('honours an explicit narrower scope instead of the default', async () => {
    const dataDir = await directory();
    const result = ensureCorpusMirrorConnection({
      dataDir,
      identity: spokeIdentity(),
      scope: ['knowledge', 'domains'],
    });
    expect(result.status).toBe('created');
    const store = SourceStore.open(dataDir);
    const connection = store.list()[0]!;
    expect((connection as Record<string, unknown>).scope).toEqual(['knowledge', 'domains']);
  });
});

describe('ensureCorpusMirrorConnection — idempotent (Verification 4)', () => {
  it('arming twice yields exactly ONE connection, not two', async () => {
    const dataDir = await directory();
    const identity = spokeIdentity();

    const first = ensureCorpusMirrorConnection({ dataDir, identity });
    const second = ensureCorpusMirrorConnection({ dataDir, identity });

    expect(first.status).toBe('created');
    expect(second.status).toBe('already-provisioned');
    expect(second.connectionId).toBe(first.connectionId);

    // Negative control: count the connections directly rather than trusting the return status —
    // a function that appends a new connection on every call would also report a "success"-shaped
    // status of its own if this assertion were skipped.
    const store = SourceStore.open(dataDir);
    expect(store.list()).toHaveLength(1);
  });

  it('a human-created cezar-hub connection under a different id also counts as "already has one"', async () => {
    const dataDir = await directory();
    const store = SourceStore.open(dataDir);
    store.create(
      {
        kind: CEZAR_HUB_SOURCE_KIND,
        name: 'hand-rolled',
        enabled: false,
        mode: 'mirror',
        intervalSeconds: 900,
        collections: [],
        watchComments: false,
        maxDocuments: 5_000,
        maxBodyBytes: 524_288,
        hubUrl: 'https://hub.example',
      },
      'operators-own-connection',
    );

    const result = ensureCorpusMirrorConnection({ dataDir, identity: spokeIdentity({ hubUrl: 'https://hub.example' }) });

    expect(result.status).toBe('already-provisioned');
    expect(result.connectionId).toBe('operators-own-connection');
    expect(SourceStore.open(dataDir).list()).toHaveLength(1);
  });

  it('reconciles a stale hubUrl on re-enrollment, leaving every other field untouched', async () => {
    const dataDir = await directory();
    ensureCorpusMirrorConnection({ dataDir, identity: spokeIdentity({ hubUrl: 'https://hub-a.example' }), scope: ['knowledge'] });

    const result = ensureCorpusMirrorConnection({ dataDir, identity: spokeIdentity({ hubUrl: 'https://hub-b.example' }) });

    expect(result.status).toBe('reconciled-hub-url');
    const store = SourceStore.open(dataDir);
    const connections = store.list();
    expect(connections).toHaveLength(1);
    const connection = connections[0]!;
    expect((connection as Record<string, unknown>).hubUrl).toBe('https://hub-b.example');
    // The operator's own narrower scope survives the reconcile — only hubUrl was provably wrong.
    expect((connection as Record<string, unknown>).scope).toEqual(['knowledge']);
    expect(connection.revision).toBe(2);
  });

  it('does not reconcile (or touch revision) when the hub URL already matches', async () => {
    const dataDir = await directory();
    const identity = spokeIdentity({ hubUrl: 'https://hub.example' });
    ensureCorpusMirrorConnection({ dataDir, identity });

    const result = ensureCorpusMirrorConnection({ dataDir, identity });

    expect(result.status).toBe('already-provisioned');
    expect(SourceStore.open(dataDir).list()[0]!.revision).toBe(1);
  });
});

describe('ensureCorpusMirrorConnection — a hub never mirrors itself (S5)', () => {
  it('creates nothing on a hub node, and names the reason', async () => {
    const dataDir = await directory();

    const result = ensureCorpusMirrorConnection({ dataDir, identity: hubIdentity() });

    expect(result.status).toBe('skipped-hub-node');
    expect(result.reason).toBeTruthy();
    // Negative control: assert the connection count directly, not just the returned status — a
    // function that ignored the hub check and created one anyway could still return a status the
    // caller happens to read as "nothing to do".
    const store = SourceStore.open(dataDir);
    expect(store.list()).toHaveLength(0);
  });

  it('creates nothing with no identity at all (never joined a cluster)', async () => {
    const dataDir = await directory();
    const result = ensureCorpusMirrorConnection({ dataDir, identity: undefined });
    expect(result.status).toBe('skipped-no-identity');
    expect(SourceStore.open(dataDir).list()).toHaveLength(0);
  });

  it('creates nothing when a spoke identity is missing hubUrl (corrupt/hand-edited)', async () => {
    const dataDir = await directory();
    const identity = spokeIdentity();
    delete (identity as { hubUrl?: string }).hubUrl;
    const result = ensureCorpusMirrorConnection({ dataDir, identity });
    expect(result.status).toBe('skipped-no-hub-url');
    expect(SourceStore.open(dataDir).list()).toHaveLength(0);
  });
});

describe('ensureCorpusMirrorConnection — never throws into the boot path (constraint 3)', () => {
  it('a failure opening the store surfaces as a warning and the function still resolves', async () => {
    const base = await directory();
    // A file where a directory needs to exist — `SourceStore.open`'s own `mkdirSync(dataDir,
    // {recursive:true})` throws ENOTDIR trying to create a directory under it.
    const blocker = join(base, 'blocker');
    writeFileSync(blocker, 'not a directory');
    const dataDir = join(blocker, 'sources');

    const warnings: string[] = [];
    let threw = false;
    let result: ReturnType<typeof ensureCorpusMirrorConnection> | undefined;
    try {
      result = ensureCorpusMirrorConnection({
        dataDir,
        identity: spokeIdentity(),
        warn: (message) => warnings.push(message),
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result?.status).toBe('failed');
    expect(result?.reason).toBeTruthy();
    expect(warnings.some((w) => w.includes('could not open the sources store'))).toBe(true);
  });
});
