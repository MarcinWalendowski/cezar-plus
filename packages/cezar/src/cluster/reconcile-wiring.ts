import { join } from 'node:path';
import type { ClusterNodeId, ClusterProjectKey } from '@loki-labs/cezar-plus-contract';
import { workspaceConfigPath } from '../paths.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { loadNodeIdentity, type ClusterHomeOptions } from './node-identity.ts';
import { readPeers } from './peers.ts';
import { createHttpReconcileTransport } from './reconcile-transport.ts';
import type { RemoteReconcileTransport } from './reconcile.ts';

/**
 * The production wiring that turns a bare `reconcileAll` call into a real spoke-against-its-hub
 * one (D21, `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`) — resolves the peer, this node's
 * own identity, three refusals (no identity / this node is the hub / no secret on file), that the
 * named peer really is this node's hub, and the two pieces `ReconcileOptions` leaves optional:
 * `resolveLocalDataDir` and `remote` (`createHttpReconcileTransport`).
 *
 * Extracted out of `index.ts`'s `case 'reconcile':` because a second caller is about to need the
 * exact same wiring: the cluster runtime arms a periodic reconcile when the server starts. If that
 * caller re-derived this, the CLI and the timer could disagree about which projects reconcile, or
 * about which refusals apply, with nothing red to catch the drift — one concept, enforced once.
 *
 * **Refusals are returned as DATA, not printed.** The CLI wants to print-and-exit-1; a periodic
 * timer wants to warn once and keep its schedule. So every failure path here returns a named
 * `refusal` plus the exact human `message` the CLI used to print directly — the caller decides
 * what to do with it. `edgeHeaders` (D23, Cloudflare Access) is deliberately NOT resolved or
 * passed here: `createHttpReconcileTransport` already resolves it itself from the environment
 * (`edge-auth.ts#resolveEdgeAuthHeaders`) when omitted, so re-resolving it in this file would just
 * be a second place for that logic to drift from the one in `reconcile-transport.ts`.
 */

export type SpokeReconcileWiringRefusal =
  | 'no-identity'
  | 'not-a-spoke'
  | 'no-secret'
  | 'peer-is-not-our-hub'
  | 'no-peer';

export interface SpokeReconcileWiringOptions {
  readonly peerNodeId: ClusterNodeId;
  readonly resolveLocalDataDir: (projectKey: ClusterProjectKey) => string;
  readonly remote: RemoteReconcileTransport;
  readonly env?: NodeJS.ProcessEnv;
}

export type SpokeReconcileWiring =
  | { readonly ok: true; readonly options: SpokeReconcileWiringOptions }
  | { readonly ok: false; readonly refusal: SpokeReconcileWiringRefusal; readonly message: string };

/**
 * `peerNodeId` omitted: falls back to the one other node in the roster, refusing rather than
 * guessing when there is none or more than one — the same failure-closed reasoning the CLI's own
 * `soleClusterPeer()` carried (reconciling against the wrong peer writes another repo's backlog
 * into this one). Mirrors that helper's exact messages under the single `'no-peer'` refusal; it
 * runs BEFORE the identity checks below, in the same order the CLI ran it in, so which refusal
 * wins when several conditions are true at once is unchanged.
 */
async function resolveSolePeer(
  homeOptions: ClusterHomeOptions,
): Promise<{ readonly ok: true; readonly peerNodeId: ClusterNodeId } | { readonly ok: false; readonly message: string }> {
  const self = await loadNodeIdentity(homeOptions);
  const peers = await readPeers(homeOptions);
  const others = peers.nodes.filter((node) => node.nodeId !== self?.nodeId && !node.disabledAt);
  if (others.length === 1) return { ok: true, peerNodeId: others[0]!.nodeId };
  if (others.length === 0) {
    return { ok: false, message: 'cez cluster reconcile: no other node in the roster to reconcile against' };
  }
  return {
    ok: false,
    message: `cez cluster reconcile: name the peer with --peer <nodeId> — the roster holds ${others.length}: ${others
      .map((node) => node.nodeId)
      .join(', ')}`,
  };
}

export async function resolveSpokeReconcileWiring(input: {
  readonly peerNodeId?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<SpokeReconcileWiring> {
  const homeOptions: ClusterHomeOptions = { env: input.env };

  let peerNodeId: ClusterNodeId;
  if (input.peerNodeId !== undefined) {
    peerNodeId = input.peerNodeId;
  } else {
    const resolved = await resolveSolePeer(homeOptions);
    if (!resolved.ok) return { ok: false, refusal: 'no-peer', message: resolved.message };
    peerNodeId = resolved.peerNodeId;
  }

  const identity = await loadNodeIdentity(homeOptions);
  if (!identity) {
    return {
      ok: false,
      refusal: 'no-identity',
      message: 'cez cluster reconcile: this node has no cluster identity — run `cez cluster join <code>` first',
    };
  }
  if (identity.role !== 'spoke' || !identity.hubUrl) {
    return {
      ok: false,
      refusal: 'not-a-spoke',
      message:
        'cez cluster reconcile: this node IS the hub — reconcile dials OUT from a spoke to its hub, and a hub reconciling against a spoke is out of scope (D21); there is nothing to dial from here',
    };
  }
  if (!identity.secret) {
    return {
      ok: false,
      refusal: 'no-secret',
      message:
        'cez cluster reconcile: this node has no cluster secret on file — re-run `cez cluster join <code>` to re-enroll',
    };
  }

  const peers = await readPeers(homeOptions);
  if (peers.nodes.find((node) => node.nodeId === peerNodeId)?.role !== 'hub') {
    return {
      ok: false,
      refusal: 'peer-is-not-our-hub',
      message: `cez cluster reconcile: ${peerNodeId} is not this node's hub — reconcile only runs from a spoke against its own hub (reachable at ${identity.hubUrl})`,
    };
  }

  // `resolveLocalDataDir`: a confirmed pairing's `byNode[thisNodeId].projectId` → the workspace
  // project registry's `root` (`ReconcileOptions`'s own doc, package 2.4's report). Built ONCE,
  // synchronously, from THIS pass's own snapshot of `peers`/the registry — the SAME `peers` object
  // just read for the hub-role check above, never re-read per project — so a pairing edited
  // mid-run cannot make one project's resolution disagree with another's inside the same pass.
  const config = await loadWorkspaceConfig(workspaceConfigPath(input.env));
  const projectsById = new Map(config.projects.map((project) => [project.id, project]));
  const localDataDirByProject = new Map<string, string>();
  for (const pairing of peers.pairings) {
    const member = pairing.byNode[identity.nodeId];
    if (!member?.confirmedAt) continue;
    const project = projectsById.get(member.projectId);
    if (project) localDataDirByProject.set(pairing.projectKey, join(project.root, '.ai/cezar'));
  }

  return {
    ok: true,
    options: {
      peerNodeId,
      resolveLocalDataDir: (projectKey) => {
        const dataDir = localDataDirByProject.get(projectKey);
        if (!dataDir) {
          // `listProjects()` and this map are built from the SAME `peers` snapshot, so this is a
          // wiring bug, not a caller mistake — named rather than a bare `undefined!` cast.
          throw new Error(`cez cluster reconcile: no confirmed local project for "${projectKey}"`);
        }
        return dataDir;
      },
      remote: createHttpReconcileTransport({
        nodeId: identity.nodeId,
        secret: identity.secret,
        hubUrl: identity.hubUrl,
        env: input.env,
      }),
      env: input.env,
    },
  };
}
