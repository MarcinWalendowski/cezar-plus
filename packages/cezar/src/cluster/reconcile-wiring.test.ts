import { readFile, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLUSTER_PROTOCOL } from '@loki-labs/better-cezar-contract';
import { persistNodeCredential } from './enrollment.ts';
import { ensureNodeIdentity, nodeIdentityPath } from './node-identity.ts';
import { applyPairingAction, upsertNode } from './peers.ts';
import * as peersModule from './peers.ts';
import { resolveSpokeReconcileWiring } from './reconcile-wiring.ts';
import { workspaceConfigPath } from '../paths.ts';
import { atomicWriteJsonSync, defaultWorkspaceConfig } from '../workspace/config.ts';

/**
 * `cluster/reconcile-wiring.ts` — the D21 production wiring extracted out of `index.ts`'s `case
 * 'reconcile':` (see that file's docblock for why: a second, periodic caller is coming and must not
 * be able to silently disagree with the CLI about refusals or which projects reconcile).
 *
 * **The refusal messages below are copied from `git show HEAD:packages/cezar/src/index.ts`**
 * (the commit this extraction started from), not retyped from memory — the whole point of this
 * suite is proving the extraction preserved them byte-for-byte.
 */

const SECRET = 'a-real-per-node-secret';
const HUB_ID = 'hub-1';
const HUB_URL = 'http://127.0.0.1:0'; // never dialed — resolving the wiring never opens a socket.

const NO_IDENTITY_MESSAGE =
  'cez cluster reconcile: this node has no cluster identity — run `cez cluster join <code>` first';
const NOT_A_SPOKE_MESSAGE =
  'cez cluster reconcile: this node IS the hub — reconcile dials OUT from a spoke to its hub, and a hub reconciling against a spoke is out of scope (D21); there is nothing to dial from here';
const NO_SECRET_MESSAGE =
  'cez cluster reconcile: this node has no cluster secret on file — re-run `cez cluster join <code>` to re-enroll';
function peerIsNotOurHubMessage(peerNodeId: string): string {
  return `cez cluster reconcile: ${peerNodeId} is not this node's hub — reconcile only runs from a spoke against its own hub (reachable at ${HUB_URL})`;
}
const NO_OTHER_NODE_MESSAGE = 'cez cluster reconcile: no other node in the roster to reconcile against';
function ambiguousPeerMessage(otherIds: string[]): string {
  return `cez cluster reconcile: name the peer with --peer <nodeId> — the roster holds ${otherIds.length}: ${otherIds.join(', ')}`;
}

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cez-reconcile-wiring-home-'));
  dirs.push(dir);
  return dir;
}

function tempProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cez-reconcile-wiring-project-'));
  dirs.push(dir);
  return dir;
}

/** A full, valid spoke identity, naming HUB_ID as its hub — the floor every non-refusal test needs. */
async function makeSpokeHome(): Promise<string> {
  const home = tempHome();
  await persistNodeCredential({ nodeId: 'spoke-1', hubUrl: HUB_URL, secret: SECRET }, { env: { CEZ_HOME: home } });
  return home;
}

/** Registers HUB_ID in the roster as an actual hub — needed for the `peer-is-not-our-hub` check to
 *  pass, and for the sole-peer auto-selection tests. */
async function registerHub(home: string, nodeId = HUB_ID): Promise<void> {
  await upsertNode(
    { nodeId, nodeName: 'hub', role: 'hub', labels: [], acceptsDispatch: false, protocol: CLUSTER_PROTOCOL, version: '0.0.0-test' },
    { env: { CEZ_HOME: home } },
  );
}

/** Registers a local project + a confirmed pairing for it under `projectKey`, resolving to
 *  `projectRoot` — the thing `resolveLocalDataDir` is built from. */
async function pairProject(
  home: string,
  spokeNodeId: string,
  projectKey: string,
  projectRoot: string,
): Promise<void> {
  const config = {
    ...defaultWorkspaceConfig(),
    projects: [
      ...defaultWorkspaceConfig().projects,
      { id: projectKey, root: projectRoot, name: '', addedAt: '', lastOpenedAt: '', source: 'local' as const },
    ],
  };
  atomicWriteJsonSync(workspaceConfigPath({ CEZ_HOME: home }), config);
  await applyPairingAction(
    projectKey,
    { action: 'confirm', nodeId: spokeNodeId, projectId: projectKey },
    { env: { CEZ_HOME: home } },
  );
}

describe('resolveSpokeReconcileWiring — refusals, verbatim (D21)', () => {
  it('no-identity: this node has never joined a cluster', async () => {
    const home = tempHome();
    const wiring = await resolveSpokeReconcileWiring({ peerNodeId: 'irrelevant', env: { CEZ_HOME: home } });
    expect(wiring).toEqual({ ok: false, refusal: 'no-identity', message: NO_IDENTITY_MESSAGE });
  });

  it('not-a-spoke: this node IS the hub', async () => {
    const home = tempHome();
    await ensureNodeIdentity({ role: 'hub' }, { env: { CEZ_HOME: home } });
    const wiring = await resolveSpokeReconcileWiring({ peerNodeId: 'irrelevant', env: { CEZ_HOME: home } });
    expect(wiring).toEqual({ ok: false, refusal: 'not-a-spoke', message: NOT_A_SPOKE_MESSAGE });
  });

  it('no-secret: a spoke identity on file with no secret (pre-D17 / corrupted shape)', async () => {
    const home = await makeSpokeHome();
    // `persistNodeCredential`'s own INPUT type requires a `secret` string even though the STORED
    // field is optional — write the identity back without it, the same idiom
    // `kb-submit-signing.test.ts#spokeHome` uses to reproduce this exact shape.
    const path = nodeIdentityPath({ CEZ_HOME: home });
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    delete raw.secret;
    await writeFile(path, JSON.stringify(raw), { mode: 0o600 });

    const wiring = await resolveSpokeReconcileWiring({ peerNodeId: 'irrelevant', env: { CEZ_HOME: home } });
    expect(wiring).toEqual({ ok: false, refusal: 'no-secret', message: NO_SECRET_MESSAGE });
  });

  it('peer-is-not-our-hub: a valid spoke, but the named peer is not (or is not known to be) its hub', async () => {
    const home = await makeSpokeHome();
    const wiring = await resolveSpokeReconcileWiring({ peerNodeId: 'some-other-node', env: { CEZ_HOME: home } });
    expect(wiring).toEqual({
      ok: false,
      refusal: 'peer-is-not-our-hub',
      message: peerIsNotOurHubMessage('some-other-node'),
    });
  });

  it('no-peer: no --peer given, and the roster has no other node', async () => {
    const home = await makeSpokeHome();
    const wiring = await resolveSpokeReconcileWiring({ env: { CEZ_HOME: home } });
    expect(wiring).toEqual({ ok: false, refusal: 'no-peer', message: NO_OTHER_NODE_MESSAGE });
  });

  it('no-peer: no --peer given, and the roster holds more than one candidate', async () => {
    const home = await makeSpokeHome();
    await registerHub(home, 'hub-a');
    await registerHub(home, 'hub-b');
    const wiring = await resolveSpokeReconcileWiring({ env: { CEZ_HOME: home } });
    expect(wiring).toEqual({ ok: false, refusal: 'no-peer', message: ambiguousPeerMessage(['hub-a', 'hub-b']) });
  });

  it('no-peer wins over identity refusals: peer resolution runs FIRST, matching the CLI order', async () => {
    // No identity file at all AND no --peer AND an empty roster — the original CLI called
    // `soleClusterPeer()` before ever loading identity, so `no-peer` must win here, not
    // `no-identity`. This is the ordering the docblock in reconcile-wiring.ts promises to preserve.
    const home = tempHome();
    const wiring = await resolveSpokeReconcileWiring({ env: { CEZ_HOME: home } });
    expect(wiring).toEqual({ ok: false, refusal: 'no-peer', message: NO_OTHER_NODE_MESSAGE });
  });
});

describe('resolveSpokeReconcileWiring — the real wiring (D21/D23)', () => {
  it('builds a working resolveLocalDataDir and remote transport for a confirmed pairing', async () => {
    const home = await makeSpokeHome();
    await registerHub(home);
    const identity = JSON.parse(await readFile(nodeIdentityPath({ CEZ_HOME: home }), 'utf8')) as { nodeId: string };
    const projectRoot = tempProjectRoot();
    await pairProject(home, identity.nodeId, 'shared-project', projectRoot);

    const wiring = await resolveSpokeReconcileWiring({ peerNodeId: HUB_ID, env: { CEZ_HOME: home } });
    expect(wiring.ok).toBe(true);
    if (!wiring.ok) return;

    expect(wiring.options.peerNodeId).toBe(HUB_ID);
    expect(wiring.options.resolveLocalDataDir('shared-project')).toBe(join(projectRoot, '.ai/cezar'));
    expect(() => wiring.options.resolveLocalDataDir('no-such-project')).toThrow(
      'cez cluster reconcile: no confirmed local project for "no-such-project"',
    );
    // Structural — `reconcile-transport.test.ts` already proves the transport's wire behaviour;
    // this just proves a real one was actually built and handed back.
    expect(typeof wiring.options.remote.listProjects).toBe('function');
    expect(typeof wiring.options.remote.list).toBe('function');
    expect(typeof wiring.options.remote.backup).toBe('function');
    expect(typeof wiring.options.remote.apply).toBe('function');
  });

  it('auto-selects the sole other roster node as the peer when --peer is omitted (soleClusterPeer parity)', async () => {
    const home = await makeSpokeHome();
    await registerHub(home);
    const wiring = await resolveSpokeReconcileWiring({ env: { CEZ_HOME: home } });
    expect(wiring.ok).toBe(true);
    if (wiring.ok) expect(wiring.options.peerNodeId).toBe(HUB_ID);
  });
});

describe('resolveSpokeReconcileWiring — single-snapshot property (D21 comment: never re-read peers per project)', () => {
  it('reads the peers store exactly once, regardless of how many confirmed pairings it resolves', async () => {
    const home = await makeSpokeHome();
    await registerHub(home);
    const identity = JSON.parse(await readFile(nodeIdentityPath({ CEZ_HOME: home }), 'utf8')) as { nodeId: string };
    await pairProject(home, identity.nodeId, 'project-a', tempProjectRoot());
    await pairProject(home, identity.nodeId, 'project-b', tempProjectRoot());
    await pairProject(home, identity.nodeId, 'project-c', tempProjectRoot());

    const readPeersSpy = vi.spyOn(peersModule, 'readPeers');

    const wiring = await resolveSpokeReconcileWiring({ peerNodeId: HUB_ID, env: { CEZ_HOME: home } });
    expect(wiring.ok).toBe(true);

    // The floor this test guards: with an EXPLICIT `--peer` (so the sole-peer fallback, which reads
    // peers itself, never runs), correct wiring reads `peers` exactly once and reuses that one
    // snapshot for the hub-role check AND for all three pairings' `resolveLocalDataDir` entries. A
    // regression that re-reads `peers` inside the per-project loop would call this once per project
    // in addition — 4 calls for 3 pairings, not 1 — which is exactly the bug the comment in
    // reconcile-wiring.ts exists to prevent (a pairing edited mid-pass disagreeing with an earlier
    // one resolved in the same pass).
    //
    // Verified live, not just asserted: temporarily rewriting the extraction to call
    // `await readPeers(homeOptions)` inside the `for (const pairing of peers.pairings)` loop (in
    // place of the outer `peers` snapshot) turns this single assertion red — `toHaveBeenCalledTimes`
    // reports 4 instead of 1 — while every other test in this file keeps passing, since none of the
    // refusal paths and no other assertion here depends on call COUNT. Reverted immediately after
    // confirming the failure; see the implementation report for the exact diff used.
    expect(readPeersSpy).toHaveBeenCalledTimes(1);
  });
});
