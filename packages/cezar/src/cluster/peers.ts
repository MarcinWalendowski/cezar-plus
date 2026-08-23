import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';
import {
  CLUSTER_PROTOCOL,
  clusterPairingSchema,
  storedClusterNodeSchema,
  storedClusterPairingSchema,
  storedClusterPeersSchema,
  type ClusterCapacity,
  type ClusterNodeId,
  type ClusterPairing,
  type ClusterPairingAction,
  type ClusterPairingProposal,
  type ClusterPairingSignal,
  type ClusterPresenceFrame,
  type ClusterProjectAdvert,
  type ClusterProjectKey,
  type ClusterRepoFreshness,
  type StoredClusterNode,
  type StoredClusterPairing,
  type StoredClusterPeers,
} from '@loki-labs/better-cezar-contract';
import { currentHostMetrics } from '../core/host-metrics.ts';
import { getHeadCommit, getRepoInfo, getStatus } from '../server/git.ts';
import { workspaceConfigPath } from '../paths.ts';
import { atomicWriteJsonSync, loadWorkspaceConfig, type WorkspaceProject } from '../workspace/config.ts';
import { withEnrollCodesLease } from './enrollment.ts';
import {
  clusterHomeDir,
  detectCapacityEnforcement,
  loadNodeIdentity,
  type ClusterHomeOptions,
} from './node-identity.ts';
import { removeNodeSecret } from './node-secrets.ts';

/**
 * The roster, the pairing store, and the presence a node advertises about itself —
 * `~/.cezar/cluster/peers.json` (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`,
 * D2 · D11 · D14 · D14a + "A cheap side-benefit worth taking").
 *
 * **Pairing is proposed by machine and confirmed by a human, and it fails closed** (D2). Two signals
 * propose — a normalized `origin` URL where `git rev-parse --git-common-dir` is the project's own
 * (so a worktree can never pose as its parent repo), and identical slug *and* basename — and neither
 * ever auto-confirms, because Problem §6 has a live counter-example for each. A wrong pairing writes
 * another repo's backlog into your repo. An unpaired project is visibly "not paired" and replicates
 * nothing; a project that exists on only one node is simply never paired and stays local.
 *
 * **A spoke advertises only what it has confirmed.** The hub cannot address a project the spoke has
 * not paired — the last item of the spec's blast-radius list, and it is enforced here, at the point
 * that builds the advert, rather than by trusting the hub not to ask.
 *
 * **Capacity is a claim, and it is rendered with its age.** `presence` carries what this node
 * believes about itself; nothing here treats another node's number as fact. `enforcement: 'none'` is
 * a stated limitation, not a blank — a limit that silently does not exist is worse than one never
 * claimed (D14a). Offline is "asleep since HH:MM", a state, not a red error.
 */

function reportWarning(options: ClusterHomeOptions | undefined, message: string): void {
  (options?.warn ?? ((m: string) => console.warn(m)))(message);
}

function nowIso(options: ClusterHomeOptions | undefined): string {
  return (options?.now ?? (() => new Date()))().toISOString();
}

export function peersPath(env?: NodeJS.ProcessEnv): string {
  return join(clusterHomeDir(env), 'peers.json');
}

const EMPTY_PEERS: StoredClusterPeers = { nodes: [], pairings: [] };

/** `.passthrough()` with per-entry salvage: one unreadable node row must not evict the roster, and
 *  a corrupt file degrades to empty with one warning rather than failing the boot. */
export async function readPeers(options?: ClusterHomeOptions): Promise<StoredClusterPeers> {
  const path = peersPath(options?.env);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    // Missing — the zero-config "no roster yet" state. Silent: every node starts here.
    return EMPTY_PEERS;
  }
  if (raw.trim() === '') return EMPTY_PEERS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    reportWarning(options, `[cez] cluster roster ${path} is corrupt — ignoring it (starts empty, re-populates as nodes report in)`);
    return EMPTY_PEERS;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    reportWarning(options, `[cez] cluster roster ${path} is corrupt — ignoring it (starts empty, re-populates as nodes report in)`);
    return EMPTY_PEERS;
  }

  const record = parsed as Record<string, unknown>;
  const rawNodes = Array.isArray(record.nodes) ? record.nodes : [];
  const rawPairings = Array.isArray(record.pairings) ? record.pairings : [];

  let dropped = 0;
  const nodes: StoredClusterNode[] = [];
  for (const entry of rawNodes) {
    const result = storedClusterNodeSchema.safeParse(entry);
    if (result.success) nodes.push(result.data);
    else dropped++;
  }
  const pairings: StoredClusterPairing[] = [];
  for (const entry of rawPairings) {
    const result = storedClusterPairingSchema.safeParse(entry);
    if (result.success) pairings.push(result.data);
    else dropped++;
  }
  if (dropped > 0) {
    reportWarning(options, `[cez] cluster roster ${path} — dropped ${dropped} unreadable row(s), kept the rest`);
  }

  // Re-validate the ALREADY-salvaged data through the full (strict-per-element) schema so
  // defaults/passthrough at the top level still apply. Every element is now guaranteed valid, so
  // this re-parse cannot itself fail.
  return storedClusterPeersSchema.parse({ ...record, nodes, pairings });
}

/** Read-modify-write merge, same shape as `agent-accounts.ts`'s `mergeWriteAgentAccounts`: re-read,
 *  apply `mutator`, atomic-rename write. Two processes editing different nodes converge instead of
 *  dropping each other's — last-writer-wins only inside the tiny read→rename window. */
async function mergeWritePeers(
  mutator: (peers: StoredClusterPeers) => StoredClusterPeers | void,
  options?: ClusterHomeOptions,
): Promise<StoredClusterPeers> {
  const current = await readPeers(options);
  const next = mutator(current) ?? current;
  atomicWriteJsonSync(peersPath(options?.env), next);
  return next;
}

export async function upsertNode(
  node: StoredClusterNode,
  options?: ClusterHomeOptions,
): Promise<StoredClusterNode> {
  const validated = storedClusterNodeSchema.parse(node);
  await mergeWritePeers((peers) => {
    const nodes = peers.nodes.filter((n) => n.nodeId !== validated.nodeId);
    nodes.push(validated);
    return { ...peers, nodes };
  }, options);
  return validated;
}

/** Stamps `lastSeenAt` and the node's advertised capacity WITH the time it was claimed, so nothing
 *  downstream can present a sleeping laptop's last boast as current. */
export async function markNodeSeen(
  nodeId: ClusterNodeId,
  presence: ClusterPresenceFrame,
  options?: ClusterHomeOptions,
): Promise<StoredClusterNode | undefined> {
  const now = nowIso(options);
  let updated: StoredClusterNode | undefined;
  await mergeWritePeers((peers) => {
    const idx = peers.nodes.findIndex((n) => n.nodeId === nodeId);
    if (idx === -1) return peers; // unknown node — nothing to stamp, never fabricate a row
    const existing = peers.nodes[idx]!;
    updated = {
      ...existing,
      lastSeenAt: now,
      capacity: presence.capacity,
      capacityAt: now,
      ...(presence.hostMetrics ? { hostMetrics: presence.hostMetrics } : {}),
      ...(presence.repoDrift ? { repoDrift: presence.repoDrift } : {}),
      ...(presence.corpus ? { corpus: presence.corpus } : {}),
    };
    const nodes = [...peers.nodes];
    nodes[idx] = updated;
    return { ...peers, nodes };
  }, options);
  return updated;
}

/** The hub half of a two-sided revoke. The spoke half — deleting its credential — is
 *  `enrollment.ts`'s `leaveCluster`, and without it a revoked spoke keeps pushing ops.
 *
 *  **D22, added 2026-08-23: also removes the node's stored secret**, or a disabled node's
 *  signatures keep verifying — until this, `disableNode` was a roster edit and nothing else. The
 *  removal takes `enrollment.ts`'s `enroll-codes` write lease (`withEnrollCodesLease`), the SAME
 *  lease `redeemEnrollmentCode` holds while it writes a node's secret — `node-secrets.ts`'s module
 *  docblock is explicit that every writer of that file must share the one lease rather than each
 *  inventing its own lock, which could otherwise race the other. Only attempted when the roster edit
 *  actually found the node, so disabling an unknown id stays a cheap no-op rather than taking a lock
 *  for nothing. */
export async function disableNode(nodeId: ClusterNodeId, options?: ClusterHomeOptions): Promise<boolean> {
  const now = nowIso(options);
  let found = false;
  await mergeWritePeers((peers) => {
    const idx = peers.nodes.findIndex((n) => n.nodeId === nodeId);
    if (idx === -1) return peers;
    found = true;
    const nodes = [...peers.nodes];
    nodes[idx] = { ...nodes[idx]!, disabledAt: now };
    return { ...peers, nodes };
  }, options);
  if (found) {
    await withEnrollCodesLease(options, () => removeNodeSecret(nodeId, options));
  }
  return found;
}

/** Normalized for comparison only — scheme, credentials, trailing `.git` and case folded away. The
 *  normalization is one function because two spellings of one remote must never propose two
 *  pairings, and two different remotes must never collapse into one. */
export function normalizeOriginUrl(url: string): string {
  let s = url.trim();
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (hasScheme) {
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  } else {
    // SCP-like syntax (`git@host:owner/repo.git`) — the `:` after the host is a path separator,
    // not a port. Rewritten to the same `host/owner/repo` shape the scheme branch produces, so
    // `git@github.com:acme/x.git` and `https://github.com/acme/x.git` compare equal.
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(s);
    if (scp) s = `${scp[1]}/${scp[2]}`;
  }
  s = s.replace(/^[^@/]+@/, ''); // strip userinfo (credentials in an https:// URL)
  s = s.replace(/\/+$/, '');
  s = s.replace(/\.git$/i, '');
  return s.toLowerCase();
}

async function realpathOrResolve(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolvePath(p);
  }
}

const execFileAsync = promisify(execFile);

/** Run git, never throw — degradation is the caller's policy, matching `server/git.ts`'s own
 *  never-throw `git()` idiom (each file in this repo keeps its own tiny copy rather than sharing
 *  one — `agent-config/seed.ts` and `server/git.ts` already do the same). */
async function runGit(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf8',
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
}

/** `false` when `git rev-parse --git-common-dir` points outside `root` — a worktree, which the
 *  `origin` pairing signal must never be admissible for (D2, Problem §6's live counter-example). */
async function isOwnGitCommonDir(root: string): Promise<boolean> {
  const res = await runGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!res.ok) return false;
  const commonDir = res.stdout.trim();
  if (!commonDir) return false;
  const [rootReal, commonOwnerReal] = await Promise.all([
    realpathOrResolve(root),
    realpathOrResolve(dirname(commonDir)), // strip the trailing `.git` segment
  ]);
  return rootReal === commonOwnerReal;
}

async function buildProjectAdvert(
  projectId: string,
  root: string,
  projectKey?: ClusterProjectKey,
): Promise<ClusterProjectAdvert> {
  const [info, ownGitCommonDir] = await Promise.all([getRepoInfo(root), isOwnGitCommonDir(root)]);
  return {
    projectId,
    ...(projectKey ? { projectKey } : {}),
    slug: projectId,
    basename: basename(root),
    ...(info?.remote ? { originUrl: info.remote } : {}),
    ownGitCommonDir,
  };
}

interface ConfirmedLocalProject {
  projectKey: ClusterProjectKey;
  projectId: string;
  root: string;
}

/** This node's own confirmed pairings, cross-referenced against its LOCAL project registry so a
 *  pairing whose project was since deregistered here quietly drops out rather than reporting a
 *  root that no longer exists. Shared by `advertisedProjects` and `collectPresence`'s repoDrift. */
function confirmedProjectsForNode(
  peers: StoredClusterPeers,
  nodeId: ClusterNodeId,
  projectsById: ReadonlyMap<string, WorkspaceProject>,
): ConfirmedLocalProject[] {
  const out: ConfirmedLocalProject[] = [];
  for (const pairing of peers.pairings) {
    const member = pairing.byNode[nodeId];
    if (!member?.confirmedAt) continue; // proposed-but-unconfirmed — never advertised (D2)
    const project = projectsById.get(member.projectId);
    if (!project) continue;
    out.push({ projectKey: pairing.projectKey, projectId: member.projectId, root: project.root });
  }
  return out;
}

async function projectsById(options: ClusterHomeOptions | undefined): Promise<Map<string, WorkspaceProject>> {
  const config = await loadWorkspaceConfig(workspaceConfigPath(options?.env));
  return new Map(config.projects.map((p) => [p.id, p]));
}

/** What this node exposes on `hello`: **confirmed pairings only**, plus the inputs D2's proposal is
 *  computed from and the `originUrl` absence that pins a remote-less project (D12). */
export async function advertisedProjects(
  options?: ClusterHomeOptions,
): Promise<ClusterProjectAdvert[]> {
  const identity = await loadNodeIdentity(options);
  if (!identity) return []; // never joined a cluster — nothing to advertise

  const [peers, byId] = await Promise.all([readPeers(options), projectsById(options)]);
  const confirmed = confirmedProjectsForNode(peers, identity.nodeId, byId);
  return Promise.all(confirmed.map((c) => buildProjectAdvert(c.projectId, c.root, c.projectKey)));
}

function pairKey(nodeId: string, projectId: string): string {
  return `${nodeId} ${projectId}`;
}

/** Hub-side. Pure over the adverts it is given, so the two signals are testable without a second
 *  machine. Never returns a confirmed pairing — only proposals, which are inert until a human acts. */
export function proposePairings(
  advertsByNode: ReadonlyMap<ClusterNodeId, readonly ClusterProjectAdvert[]>,
  existing: readonly ClusterPairing[],
  options?: ClusterHomeOptions,
): ClusterPairingProposal[] {
  const now = nowIso(options);

  const alreadyPaired = new Set<string>();
  for (const pairing of existing) {
    for (const [nodeId, member] of Object.entries(pairing.byNode)) {
      alreadyPaired.add(pairKey(nodeId, member.projectId));
    }
  }

  const nodeIds = [...advertsByNode.keys()].sort();
  const proposals: ClusterPairingProposal[] = [];
  const claimed = new Set<string>(); // members already turned into a proposal THIS pass

  const tryPropose = (
    signal: ClusterPairingSignal,
    nodeA: ClusterNodeId,
    advertA: ClusterProjectAdvert,
    nodeB: ClusterNodeId,
    advertB: ClusterProjectAdvert,
  ): void => {
    const keyA = pairKey(nodeA, advertA.projectId);
    const keyB = pairKey(nodeB, advertB.projectId);
    if (alreadyPaired.has(keyA) || alreadyPaired.has(keyB)) return;
    if (claimed.has(keyA) || claimed.has(keyB)) return;
    claimed.add(keyA);
    claimed.add(keyB);
    proposals.push({
      projectKey: advertA.projectKey ?? advertB.projectKey ?? randomUUID(),
      signal,
      members: [
        { nodeId: nodeA, projectId: advertA.projectId },
        { nodeId: nodeB, projectId: advertB.projectId },
      ],
      proposedAt: now,
    });
  };

  // Signal (a): origin — normalized match, and NEVER across a worktree (Problem §6: a worktree
  // reports its parent's origin verbatim, so `ownGitCommonDir` is what keeps it from posing as
  // the repo it was checked out from).
  for (let i = 0; i < nodeIds.length; i++) {
    for (let j = i + 1; j < nodeIds.length; j++) {
      const nodeA = nodeIds[i]!;
      const nodeB = nodeIds[j]!;
      for (const advertA of advertsByNode.get(nodeA) ?? []) {
        if (!advertA.originUrl || !advertA.ownGitCommonDir) continue;
        for (const advertB of advertsByNode.get(nodeB) ?? []) {
          if (!advertB.originUrl || !advertB.ownGitCommonDir) continue;
          if (normalizeOriginUrl(advertA.originUrl) !== normalizeOriginUrl(advertB.originUrl)) continue;
          tryPropose('origin', nodeA, advertA, nodeB, advertB);
        }
      }
    }
  }

  // Signal (b): identical slug AND basename — only for pairs signal (a) did not already claim
  // (`tryPropose`'s own `claimed` check), so one real match is never proposed twice.
  for (let i = 0; i < nodeIds.length; i++) {
    for (let j = i + 1; j < nodeIds.length; j++) {
      const nodeA = nodeIds[i]!;
      const nodeB = nodeIds[j]!;
      for (const advertA of advertsByNode.get(nodeA) ?? []) {
        for (const advertB of advertsByNode.get(nodeB) ?? []) {
          if (advertA.slug !== advertB.slug || advertA.basename !== advertB.basename) continue;
          tryPropose('slug-and-basename', nodeA, advertA, nodeB, advertB);
        }
      }
    }
  }

  return proposals;
}

/** `confirm` writes `confirmedAt` for one node's local project; `unpair` removes it. Confirmation is
 *  per node because that is the grant being made: this repo, on that machine. */
export async function applyPairingAction(
  projectKey: ClusterProjectKey,
  action: ClusterPairingAction,
  options?: ClusterHomeOptions,
): Promise<ClusterPairing | undefined> {
  const now = nowIso(options);
  let result: ClusterPairing | undefined;

  await mergeWritePeers((peers) => {
    const idx = peers.pairings.findIndex((p) => p.projectKey === projectKey);

    if (action.action === 'confirm') {
      const existing: StoredClusterPairing = idx === -1 ? { projectKey, byNode: {} } : peers.pairings[idx]!;
      const next: StoredClusterPairing = {
        ...existing,
        byNode: {
          ...existing.byNode,
          [action.nodeId]: { nodeId: action.nodeId, projectId: action.projectId, confirmedAt: now },
        },
      };
      result = clusterPairingSchema.parse(next);
      const pairings = [...peers.pairings];
      if (idx === -1) pairings.push(next);
      else pairings[idx] = next;
      return { ...peers, pairings };
    }

    // unpair
    if (idx === -1) {
      result = undefined;
      return peers; // nothing to unpair — a no-op, not an error
    }
    const existing = peers.pairings[idx]!;
    const byNode = { ...existing.byNode };
    delete byNode[action.nodeId];
    if (Object.keys(byNode).length === 0) {
      // The last member unpaired — the record represents nothing, so it is dropped rather than
      // kept around as an empty shell a later reader might mistake for "paired, with nobody in it".
      result = undefined;
      return { ...peers, pairings: peers.pairings.filter((_, i) => i !== idx) };
    }
    const next: StoredClusterPairing = { ...existing, byNode };
    result = clusterPairingSchema.parse(next);
    const pairings = [...peers.pairings];
    pairings[idx] = next;
    return { ...peers, pairings };
  }, options);

  return result;
}

/** All-zero SHA — git's own plumbing convention for "no commit" (used by pre-receive hooks), reused
 *  here for the one edge case `getHeadCommit` cannot answer: an unborn branch. `headSha` is
 *  required and non-empty on the wire, and this is the honest way to say "there isn't one yet"
 *  without inventing a lie shaped like a real commit. */
const NULL_SHA = '0'.repeat(40);

/**
 * `HEAD` vs `origin/main`, dirty count, and **`MERGE_HEAD`** for one paired project. The last field
 * is the one the record has already paid for: the box's `chat` checkout sat six hours mid-conflict
 * with no merge in progress, showing one ordinary dirty file while every pull silently failed. A
 * push is not delivery, and `dirty: 1` never said so.
 */
export async function collectRepoFreshness(
  projectKey: ClusterProjectKey,
  root: string,
  options?: ClusterHomeOptions,
): Promise<ClusterRepoFreshness> {
  const [headSha, aheadBehind, mergeHead, dirtyEntries] = await Promise.all([
    getHeadCommit(root),
    // `--left-right --count A...B` prints "<A-only>\t<B-only>" on one line — commits ONLY in
    // origin/main (behind) then commits ONLY in HEAD (ahead). Fixed to `origin/main` per the
    // spec's own field, never the branch's own (possibly different) configured upstream.
    runGit(root, ['rev-list', '--left-right', '--count', 'origin/main...HEAD']),
    runGit(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']),
    getStatus(root).catch(() => []),
  ]);

  let behind = 0;
  let ahead = 0;
  if (aheadBehind.ok) {
    const [behindStr, aheadStr] = aheadBehind.stdout.trim().split(/\s+/);
    behind = Number(behindStr) || 0;
    ahead = Number(aheadStr) || 0;
  }
  // No local `origin/main` ref (never fetched, or the project genuinely has none) degrades to
  // 0/0 — the honest "nothing to compare" answer; the schema has no separate "unknown" state for
  // these two fields.

  return {
    projectKey,
    headSha: headSha ?? NULL_SHA,
    ahead,
    behind,
    dirty: dirtyEntries.length,
    merging: mergeHead.ok && mergeHead.stdout.trim().length > 0,
  };
}

/**
 * Live D14 counts THIS node is holding right now — `active` slots and steps currently inside a
 * heavy step. `collectPresence` has no boot-time reference to the running `WorkspaceSemaphore`
 * (only `ClusterHomeOptions` is threaded this deep, and that bag is fixed by the scaffold), so the
 * caller that DOES hold one injects the live numbers here. Absent means nothing has wired live
 * counts in yet: both report 0, which is an honest "idle" claim rather than a refusal to build a
 * frame at all — `maxParallel`/`maxHeavySteps` (the BOUNDS, read from `~/.cezar/config.json` below)
 * are unaffected either way.
 */
export interface CollectPresenceOptions extends ClusterHomeOptions {
  liveCapacity?: { active: number; heavyActive: number };
}

/** The heartbeat this node sends: two capacity numbers (D14), host metrics, per-project drift, and
 *  the corpus mirror's own freshness (D8a) — a stale mirror has no natural error, so it is reported
 *  on every beat rather than discovered at dispatch. */
export async function collectPresence(
  options?: CollectPresenceOptions,
): Promise<ClusterPresenceFrame> {
  const [identity, config, enforcement] = await Promise.all([
    loadNodeIdentity(options),
    loadWorkspaceConfig(workspaceConfigPath(options?.env)),
    detectCapacityEnforcement(options),
  ]);
  const live = options?.liveCapacity ?? { active: 0, heavyActive: 0 };

  const capacity: ClusterCapacity = {
    maxParallel: config.resources.maxParallel,
    active: live.active,
    ...(config.resources.maxHeavySteps !== undefined
      ? { maxHeavySteps: config.resources.maxHeavySteps }
      : {}),
    heavyActive: live.heavyActive,
    enforcement,
  };

  let repoDrift: ClusterRepoFreshness[] = [];
  if (identity) {
    const [peers, byId] = await Promise.all([readPeers(options), projectsById(options)]);
    const confirmed = confirmedProjectsForNode(peers, identity.nodeId, byId);
    repoDrift = await Promise.all(confirmed.map((c) => collectRepoFreshness(c.projectKey, c.root, options)));
  }

  return {
    type: 'presence',
    protocol: CLUSTER_PROTOCOL,
    capacity,
    hostMetrics: currentHostMetrics(),
    repoDrift: repoDrift.slice(0, 200),
  };
}
