import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLUSTER_PROTOCOL,
  type ClusterPresenceFrame,
  type ClusterProjectAdvert,
  type StoredClusterNode,
} from '@loki-labs/better-cezar-contract';
import { createEnrollmentCode, redeemEnrollmentCode } from './enrollment.ts';
import { hashRequestBody, signNodeHttpPrincipal, verifyNodeHttpPrincipal, type NodeHttpPrincipal } from './node-auth.ts';
import { ensureNodeIdentity } from './node-identity.ts';
import { lookupNodeSecret, nodeSecretsPath, storeNodeSecret } from './node-secrets.ts';
import { registerProject } from '../workspace/projects.ts';
import {
  advertisedProjects,
  applyPairingAction,
  collectPresence,
  collectRepoFreshness,
  disableNode,
  markNodeSeen,
  normalizeOriginUrl,
  peersPath,
  proposePairings,
  readPeers,
  upsertNode,
} from './peers.ts';

/**
 * Package 1.4 of `.ai/runs/2026-08-22-multi-node-cezar-cluster/PLAN.md` — roster, pairing store,
 * presence (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D2 · D11 · D14 · D14a).
 */
describe('cluster/peers', () => {
  const originalHome = process.env.CEZ_HOME;
  let home: string;
  let repos: string;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-cluster-home-'));
    repos = mkdtempSync(join(realpathSync(tmpdir()), 'cez-cluster-repos-'));
    process.env.CEZ_HOME = home; // paths.ts sends all workspace paths here
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repos, { recursive: true, force: true });
  });

  function makeStoredNode(overrides: Partial<StoredClusterNode> = {}): StoredClusterNode {
    return {
      nodeId: 'node-a',
      nodeName: 'Node A',
      role: 'spoke',
      labels: [],
      acceptsDispatch: false,
      protocol: CLUSTER_PROTOCOL,
      version: '0.10.0',
      ...overrides,
    };
  }

  function makePresence(overrides: Partial<ClusterPresenceFrame> = {}): ClusterPresenceFrame {
    return {
      type: 'presence',
      protocol: CLUSTER_PROTOCOL,
      capacity: { maxParallel: 8, active: 1, heavyActive: 0, enforcement: 'none' },
      repoDrift: [],
      ...overrides,
    };
  }

  const makeRepo = (name: string): string => {
    const dir = join(repos, name);
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'], {
      cwd: dir,
    });
    return dir;
  };

  // ---- peersPath / readPeers -------------------------------------------------------------------

  describe('peersPath / readPeers', () => {
    it('points at peers.json under the cluster home dir', () => {
      expect(peersPath({ CEZ_HOME: home })).toBe(join(home, 'cluster', 'peers.json'));
    });

    it('a missing file degrades to an empty roster, silently', async () => {
      const warnings: string[] = [];
      const peers = await readPeers({ warn: (m) => warnings.push(m) });
      expect(peers).toEqual({ nodes: [], pairings: [] });
      expect(warnings).toEqual([]);
    });

    it('a corrupt file degrades to empty with one warning, never throws', async () => {
      const path = peersPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{ not json', 'utf8');
      const warnings: string[] = [];
      const peers = await readPeers({ warn: (m) => warnings.push(m) });
      expect(peers).toEqual({ nodes: [], pairings: [] });
      expect(warnings).toHaveLength(1);
    });

    it('per-entry salvage: one unreadable node row is dropped, the rest of the roster survives', async () => {
      const good = makeStoredNode({ nodeId: 'node-good' });
      const path = peersPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          nodes: [good, { nodeId: 'node-bad' /* missing every other required field */ }],
          pairings: [],
        }),
        'utf8',
      );
      const warnings: string[] = [];
      const peers = await readPeers({ warn: (m) => warnings.push(m) });
      expect(peers.nodes.map((n) => n.nodeId)).toEqual(['node-good']);
      expect(warnings).toHaveLength(1);
    });
  });

  // ---- upsertNode / disableNode / markNodeSeen -------------------------------------------------

  describe('upsertNode / disableNode', () => {
    it('adds a node and upserting again by the same id replaces it, never duplicates', async () => {
      await upsertNode(makeStoredNode({ nodeId: 'n1', nodeName: 'first' }));
      await upsertNode(makeStoredNode({ nodeId: 'n1', nodeName: 'renamed' }));
      const peers = await readPeers();
      expect(peers.nodes).toHaveLength(1);
      expect(peers.nodes[0]?.nodeName).toBe('renamed');
    });

    it('disableNode stamps disabledAt and returns true; an unknown id returns false untouched', async () => {
      await upsertNode(makeStoredNode({ nodeId: 'n1' }));
      const now = new Date('2026-08-22T10:00:00.000Z');
      const found = await disableNode('n1', { now: () => now });
      expect(found).toBe(true);
      const missing = await disableNode('does-not-exist');
      expect(missing).toBe(false);
      const peers = await readPeers();
      expect(peers.nodes[0]?.disabledAt).toBe(now.toISOString());
    });

    // Spec Verification 26: the negative control is the BEFORE half — a signature that verified
    // must be shown verifying before disableNode ever runs, or this test proves nothing about
    // revocation and everything about a store that never worked in the first place.
    it('disableNode removes the stored secret — a signature that verified BEFORE now refuses unknown-node AFTER (Verification 26)', async () => {
      await upsertNode(makeStoredNode({ nodeId: 'n1' }));
      await storeNodeSecret('n1', 'n1-secret');

      const binding = { method: 'GET', path: '/cluster/corpus', bodyHash: hashRequestBody('') };
      const principal: NodeHttpPrincipal = { nodeId: 'n1', issuedAt: new Date().toISOString(), ...binding };

      // BEFORE: the negative control — prove the signature verifies while the secret is still
      // there, using the SAME store `disableNode` is about to write to.
      const signedBefore = signNodeHttpPrincipal(principal, 'n1-secret');
      const secretBefore = await lookupNodeSecret('n1');
      expect(verifyNodeHttpPrincipal(signedBefore, 'n1', secretBefore, binding)).toEqual({ ok: true, nodeId: 'n1' });

      expect(await disableNode('n1')).toBe(true);

      // AFTER: the secret is gone, so an otherwise-identical signed request now refuses
      // unknown-node — the credential-revoking half of the two-sided revoke, not just a roster edit.
      expect(await lookupNodeSecret('n1')).toBeUndefined();
      const principalAfter: NodeHttpPrincipal = { ...principal, issuedAt: new Date().toISOString() };
      const signedAfter = signNodeHttpPrincipal(principalAfter, 'n1-secret');
      const secretAfter = await lookupNodeSecret('n1');
      expect(verifyNodeHttpPrincipal(signedAfter, 'n1', secretAfter, binding)).toEqual({
        ok: false,
        reason: 'unknown-node',
      });
    });

    // Isolated unit test of Part 2 of this session's fix, independent of `redeemEnrollmentCode`
    // (Part 1): constructs the defect's exact pre-condition directly — a stored secret with NO
    // roster row at all — by calling `storeNodeSecret` without ever calling `upsertNode`. This is
    // the state that (before this session) `redeemEnrollmentCode` always left behind, and it is
    // also the state a legacy install could already have on disk from before Part 1 shipped, so the
    // guard has to hold on its own, not only in combination with Part 1.
    it('disableNode removes the secret even when the node has NO roster row — revocation must not depend on the roster (Part 2, in isolation)', async () => {
      await storeNodeSecret('ghost-node', 'ghost-secret');
      expect(await lookupNodeSecret('ghost-node')).toBe('ghost-secret');

      const found = await disableNode('ghost-node');
      // `found`'s MEANING is unchanged — there never was a roster row, so this is still `false`.
      expect(found).toBe(false);

      // But the credential is gone regardless — the whole point of decoupling the two.
      expect(await lookupNodeSecret('ghost-node')).toBeUndefined();
    });
  });

  // ---- redeemEnrollmentCode → disableNode: the roster-row gap fixed this session --------------
  //
  // The `disableNode` test above proves revocation works once a roster row exists, but it gets
  // there with `upsertNode` — a hand-built fixture that was never the bug. The actual defect was
  // that `redeemEnrollmentCode` (`enrollment.ts`) never called `upsertNode` at all, so a node that
  // only ever went through the real join path had no roster row for `disableNode` to find. These
  // two tests drive the REAL join path end to end, with no manual roster row, no mocks.
  describe('redeemEnrollmentCode → disableNode (real join path, no manual roster row)', () => {
    async function realJoin(nodeId: string) {
      const { response } = await createEnrollmentCode({ hubUrl: 'https://hub.example', hubVersion: '0.10.0' });
      return redeemEnrollmentCode({
        code: response.code,
        nodeId,
        nodeName: `worker-${nodeId}`,
        labels: ['linux'],
        protocol: CLUSTER_PROTOCOL,
        version: '0.10.0',
      });
    }

    // THE security regression test (task brief). Before this session's fix, `redeemEnrollmentCode`
    // wrote a secret and nothing else — no roster row — so `disableNode` (gated on finding the row)
    // returned `false` and never called `removeNodeSecret`. This test proves the full, real
    // sequence: join, then revoke, then the credential is actually gone.
    it('a node that only ever went through redeemEnrollmentCode is ACTUALLY revoked by disableNode', async () => {
      await ensureNodeIdentity({ role: 'hub' });
      const joined = await realJoin('spoke-real-join');
      expect(joined.ok).toBe(true);
      if (!joined.ok) return;

      // Visible: redemption ALONE produced a roster row.
      const afterJoin = await readPeers();
      expect(afterJoin.nodes.find((n) => n.nodeId === 'spoke-real-join')).toBeDefined();

      // Authenticatable: the stored secret is exactly the one handed to the spoke.
      expect(await lookupNodeSecret('spoke-real-join')).toBe(joined.secret);

      expect(await disableNode('spoke-real-join')).toBe(true);

      // ACTUALLY revoked, not just hidden from the roster.
      expect(await lookupNodeSecret('spoke-real-join')).toBeUndefined();
    });

    // Write-order negative control (mutation test 3 per the task brief): the invariant
    // `redeemEnrollmentCode` protects is "never a stored secret without a roster row", which only
    // holds if the roster row is written BEFORE the secret. Blocking the secret store's own tmp
    // path forces `storeNodeSecret` to throw after the roster write has already landed; if a future
    // edit reordered the two writes (secret first), this same crash would land BEFORE the roster
    // write ever ran, and the first assertion below would go red.
    it('a crash between the roster write and the secret write leaves the roster row and NO secret (write-order negative control)', async () => {
      await ensureNodeIdentity({ role: 'hub' });
      const { response } = await createEnrollmentCode({ hubUrl: 'https://hub.example', hubVersion: '0.10.0' });

      const blockedTmp = `${nodeSecretsPath()}.tmp`;
      mkdirSync(blockedTmp, { recursive: true });
      try {
        await expect(
          redeemEnrollmentCode({
            code: response.code,
            nodeId: 'spoke-crash',
            nodeName: 'worker-crash',
            labels: [],
            protocol: CLUSTER_PROTOCOL,
            version: '0.10.0',
          }),
        ).rejects.toThrow();
      } finally {
        rmSync(blockedTmp, { recursive: true, force: true });
      }

      const peers = await readPeers();
      expect(peers.nodes.find((n) => n.nodeId === 'spoke-crash')).toBeDefined();
      expect(await lookupNodeSecret('spoke-crash')).toBeUndefined();
    });
  });

  describe('markNodeSeen — a claim rendered with its age, not an error state', () => {
    it('a node that has never reported has no lastSeenAt at all', async () => {
      await upsertNode(makeStoredNode({ nodeId: 'n1' }));
      const peers = await readPeers();
      // Absent, not a sentinel — this IS the representable "never connected" state a renderer
      // distinguishes from "asleep since HH:MM" (both are states, never a red error).
      expect(peers.nodes[0]?.lastSeenAt).toBeUndefined();
    });

    it('stamps lastSeenAt and capacityAt with the time the claim was made, and a later beat overwrites (not accumulates) it', async () => {
      await upsertNode(makeStoredNode({ nodeId: 'n1' }));
      const t1 = new Date('2026-08-22T09:00:00.000Z');
      const t2 = new Date('2026-08-22T09:40:00.000Z');

      const first = await markNodeSeen('n1', makePresence({ capacity: { maxParallel: 8, active: 2, heavyActive: 1, enforcement: 'cgroup' } }), {
        now: () => t1,
      });
      expect(first?.lastSeenAt).toBe(t1.toISOString());
      expect(first?.capacityAt).toBe(t1.toISOString());
      expect(first?.capacity?.active).toBe(2);

      const second = await markNodeSeen('n1', makePresence({ capacity: { maxParallel: 8, active: 0, heavyActive: 0, enforcement: 'cgroup' } }), {
        now: () => t2,
      });
      expect(second?.lastSeenAt).toBe(t2.toISOString());
      expect(second?.capacityAt).toBe(t2.toISOString());
      expect(second?.capacity?.active).toBe(0); // the LATEST claim, not a merge of both

      const peers = await readPeers();
      expect(peers.nodes).toHaveLength(1); // one row, updated in place — never duplicated
    });

    it('an unknown node id is a no-op: returns undefined and fabricates no row', async () => {
      const result = await markNodeSeen('ghost', makePresence());
      expect(result).toBeUndefined();
      const peers = await readPeers();
      expect(peers.nodes).toEqual([]);
    });
  });

  // ---- normalizeOriginUrl ------------------------------------------------------------------------

  describe('normalizeOriginUrl', () => {
    it('two spellings of the SAME remote (https-with-credentials vs SSH scp-form) normalize equal', () => {
      const https = normalizeOriginUrl('https://tok3n:x@github.com/Acme-Org/chat.git');
      const ssh = normalizeOriginUrl('git@github.com:Acme-Org/chat.git');
      expect(https).toBe(ssh);
      expect(https).toBe('github.com/acme-org/chat');
    });

    it('two DIFFERENT remotes never collapse into one', () => {
      const chat = normalizeOriginUrl('git@github.com:Acme-Org/chat.git');
      const cezar = normalizeOriginUrl('git@github.com:open-mercato/cezar.git');
      expect(chat).not.toBe(cezar);
    });

    it('is case-insensitive and ignores a trailing slash', () => {
      expect(normalizeOriginUrl('HTTPS://GitHub.com/Acme/Repo/')).toBe('github.com/acme/repo');
    });
  });

  // ---- advertisedProjects — D2 / Security §6: confirmed pairings only ---------------------------

  describe('advertisedProjects', () => {
    it('never joined a cluster: advertises nothing', async () => {
      const adverts = await advertisedProjects();
      expect(adverts).toEqual([]);
    });

    it('an unpaired project is NOT exposed, even though it exists locally (negative control)', async () => {
      const identity = await ensureNodeIdentity({ role: 'spoke', hubUrl: 'https://hub.example' });
      const pairedRoot = makeRepo('paired-project');
      const unpairedRoot = makeRepo('unpaired-project');
      const paired = await registerProject(pairedRoot);
      await registerProject(unpairedRoot);

      await applyPairingAction('pk-paired', {
        action: 'confirm',
        nodeId: identity.nodeId,
        projectId: paired.id,
      });

      const adverts = await advertisedProjects();
      // A test that only checked "the paired project appears" would pass even if BOTH did —
      // asserting the exact set is what proves the unpaired one is excluded.
      expect(adverts.map((a) => a.projectId)).toEqual([paired.id]);
      expect(adverts[0]?.projectKey).toBe('pk-paired');
    });

    it('the SAME project, confirmed, DOES appear — the positive half of the control above', async () => {
      const identity = await ensureNodeIdentity({ role: 'hub' });
      const root = makeRepo('solo-project');
      const project = await registerProject(root);
      await applyPairingAction('pk-solo', { action: 'confirm', nodeId: identity.nodeId, projectId: project.id });

      const adverts = await advertisedProjects();
      expect(adverts.map((a) => a.projectId)).toEqual([project.id]);
    });
  });

  // ---- proposePairings — pure, hub-side --------------------------------------------------------

  describe('proposePairings', () => {
    const advert = (over: Partial<ClusterProjectAdvert>): ClusterProjectAdvert => ({
      projectId: 'p',
      slug: 'chat',
      basename: 'chat',
      ownGitCommonDir: true,
      ...over,
    });

    it('matches on normalized origin across two nodes', () => {
      const advertsByNode = new Map([
        ['hub', [advert({ projectId: 'p-hub', originUrl: 'https://github.com/Acme-Org/chat.git' })]],
        ['mac', [advert({ projectId: 'p-mac', originUrl: 'git@github.com:Acme-Org/chat.git' })]],
      ]);
      const proposals = proposePairings(advertsByNode, []);
      expect(proposals).toHaveLength(1);
      expect(proposals[0]?.signal).toBe('origin');
      expect(proposals[0]?.members).toHaveLength(2);
      // Never auto-confirmed — inert until a human acts (D2).
      for (const member of proposals[0]!.members) expect(member.confirmedAt).toBeUndefined();
    });

    it('a worktree never poses as its parent repo — same origin, but NOT its own git-common-dir', () => {
      const advertsByNode = new Map([
        [
          'hub',
          [advert({ projectId: 'chat', slug: 'chat', basename: 'chat', originUrl: 'git@github.com:Acme-Org/chat.git', ownGitCommonDir: true })],
        ],
        [
          'mac',
          [
            advert({
              projectId: 'chat-wt-spec-101',
              // Different slug/basename too (the worktree's OWN registry entry), so this case
              // tests the origin signal in isolation — the Problem §6 worktree example.
              slug: 'chat-wt-spec-101',
              basename: 'chat-wt-spec-101',
              originUrl: 'git@github.com:Acme-Org/chat.git', // a worktree reports its parent's origin verbatim
              ownGitCommonDir: false,
            }),
          ],
        ],
      ]);
      const proposals = proposePairings(advertsByNode, []);
      expect(proposals).toEqual([]);
    });

    it('falls back to identical slug AND basename when there is no origin', () => {
      const advertsByNode = new Map([
        ['hub', [advert({ projectId: 'p-hub', slug: 'workspace-root', basename: 'workspace-root' })]],
        ['mac', [advert({ projectId: 'p-mac', slug: 'workspace-root', basename: 'workspace-root' })]],
      ]);
      const proposals = proposePairings(advertsByNode, []);
      expect(proposals).toHaveLength(1);
      expect(proposals[0]?.signal).toBe('slug-and-basename');
    });

    it('never re-proposes a pair that is already in `existing`', () => {
      const advertsByNode = new Map([
        ['hub', [advert({ projectId: 'p-hub', originUrl: 'git@github.com:acme/x.git' })]],
        ['mac', [advert({ projectId: 'p-mac', originUrl: 'git@github.com:acme/x.git' })]],
      ]);
      const existing = [
        {
          projectKey: 'pk-1',
          byNode: {
            hub: { nodeId: 'hub', projectId: 'p-hub', confirmedAt: '2026-08-01T00:00:00.000Z' },
            mac: { nodeId: 'mac', projectId: 'p-mac', confirmedAt: '2026-08-01T00:00:00.000Z' },
          },
        },
      ];
      const proposals = proposePairings(advertsByNode, existing);
      expect(proposals).toEqual([]);
    });
  });

  // ---- applyPairingAction --------------------------------------------------------------------

  describe('applyPairingAction', () => {
    it('confirm creates a pairing and writes confirmedAt for that node', async () => {
      const result = await applyPairingAction('pk-1', { action: 'confirm', nodeId: 'hub', projectId: 'chat' });
      expect(result?.projectKey).toBe('pk-1');
      expect(result?.byNode.hub?.confirmedAt).toBeTruthy();
      const peers = await readPeers();
      expect(peers.pairings).toHaveLength(1);
    });

    it('confirm from a second node ADDS a member rather than replacing the first', async () => {
      await applyPairingAction('pk-1', { action: 'confirm', nodeId: 'hub', projectId: 'chat' });
      const result = await applyPairingAction('pk-1', { action: 'confirm', nodeId: 'mac', projectId: 'chat' });
      expect(Object.keys(result?.byNode ?? {}).sort()).toEqual(['hub', 'mac']);
    });

    it('unpair removes just that node, leaving the other member intact', async () => {
      await applyPairingAction('pk-1', { action: 'confirm', nodeId: 'hub', projectId: 'chat' });
      await applyPairingAction('pk-1', { action: 'confirm', nodeId: 'mac', projectId: 'chat' });
      const result = await applyPairingAction('pk-1', { action: 'unpair', nodeId: 'mac', projectId: 'chat' });
      expect(Object.keys(result?.byNode ?? {})).toEqual(['hub']);
    });

    it('unpairing the last member removes the whole pairing record', async () => {
      await applyPairingAction('pk-1', { action: 'confirm', nodeId: 'hub', projectId: 'chat' });
      const result = await applyPairingAction('pk-1', { action: 'unpair', nodeId: 'hub', projectId: 'chat' });
      expect(result).toBeUndefined();
      const peers = await readPeers();
      expect(peers.pairings).toEqual([]);
    });

    it('unpairing a pairing that does not exist is a no-op', async () => {
      const result = await applyPairingAction('does-not-exist', { action: 'unpair', nodeId: 'hub', projectId: 'chat' });
      expect(result).toBeUndefined();
    });
  });

  // ---- collectRepoFreshness — MERGE_HEAD is the field the record already paid for ---------------

  describe('collectRepoFreshness', () => {
    /** A working repo pushed level with a bare `origin`, so `origin/main` resolves locally. */
    function makeRepoWithOrigin(name: string): string {
      const bare = join(repos, `${name}-bare.git`);
      mkdirSync(bare, { recursive: true });
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare });

      const work = makeRepo(name);
      writeFileSync(join(work, 'README.md'), 'hello\n');
      execFileSync('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', 'add', '-A'], { cwd: work });
      execFileSync('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '-q', '-m', 'seed'], { cwd: work });
      execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: work });
      execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: work });
      execFileSync('git', ['fetch', '-q', 'origin'], { cwd: work });
      return work;
    }

    it('a plain dirty tree with NO merge in progress reports merging:false', async () => {
      const root = makeRepoWithOrigin('dirty-only');
      writeFileSync(join(root, 'scratch.txt'), 'uncommitted\n');

      const freshness = await collectRepoFreshness('pk-1', root);
      expect(freshness.merging).toBe(false);
      expect(freshness.dirty).toBeGreaterThan(0);
      expect(freshness.ahead).toBe(0);
      expect(freshness.behind).toBe(0);
    });

    it('MERGE_HEAD present is reported as merging:true — the six-hour failure case', async () => {
      const root = makeRepoWithOrigin('conflicted');
      const file = join(root, 'shared.txt');

      execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: root });
      writeFileSync(file, 'from feature\n');
      execFileSync('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', 'add', '-A'], { cwd: root });
      execFileSync('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '-q', '-m', 'feature'], { cwd: root });

      execFileSync('git', ['checkout', '-q', 'main'], { cwd: root });
      writeFileSync(file, 'from main\n');
      execFileSync('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', 'add', '-A'], { cwd: root });
      execFileSync('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '-q', '-m', 'main-change'], { cwd: root });

      // Conflicting merge — git exits non-zero here, which IS the point: MERGE_HEAD is left behind.
      try {
        execFileSync('git', ['merge', 'feature'], { cwd: root, stdio: 'ignore' });
      } catch {
        // expected — a real conflict
      }

      const freshness = await collectRepoFreshness('pk-1', root);
      expect(freshness.merging).toBe(true);
      expect(freshness.dirty).toBeGreaterThan(0); // the same event ALSO shows up as an ordinary dirty file
    });

    it('a project ahead of origin/main reports it, distinct from a project level with it', async () => {
      const level = makeRepoWithOrigin('level');
      const levelFreshness = await collectRepoFreshness('pk-level', level);
      expect(levelFreshness.ahead).toBe(0);
      expect(levelFreshness.behind).toBe(0);

      const ahead = makeRepoWithOrigin('ahead');
      writeFileSync(join(ahead, 'more.txt'), 'more\n');
      execFileSync('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', 'add', '-A'], { cwd: ahead });
      execFileSync('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '-q', '-m', 'ahead'], { cwd: ahead });

      const aheadFreshness = await collectRepoFreshness('pk-ahead', ahead);
      expect(aheadFreshness.ahead).toBe(1);
      expect(aheadFreshness.behind).toBe(0);
    });

    it('a non-repo root degrades to a safe default rather than throwing', async () => {
      const plain = join(repos, 'not-a-repo');
      mkdirSync(plain, { recursive: true });
      const freshness = await collectRepoFreshness('pk-x', plain);
      expect(freshness).toMatchObject({ ahead: 0, behind: 0, dirty: 0, merging: false });
      expect(freshness.headSha).toHaveLength(40);
    });
  });

  // ---- collectPresence ------------------------------------------------------------------------

  describe('collectPresence', () => {
    it('builds a full frame: static bounds from config, injected live counts, host metrics', async () => {
      const { mergeWriteWorkspaceConfig } = await import('../workspace/config.ts');
      await mergeWriteWorkspaceConfig((config) => {
        config.resources.maxParallel = 8;
        config.resources.maxHeavySteps = 2;
      });

      const presence = await collectPresence({ liveCapacity: { active: 3, heavyActive: 1 } });
      expect(presence.type).toBe('presence');
      expect(presence.protocol).toEqual(CLUSTER_PROTOCOL);
      expect(presence.capacity).toMatchObject({ maxParallel: 8, maxHeavySteps: 2, active: 3, heavyActive: 1 });
      expect(['cgroup', 'process-tree', 'none']).toContain(presence.capacity.enforcement);
      expect(presence.hostMetrics).toBeDefined();
      expect(presence.repoDrift).toEqual([]); // never joined a cluster — nothing paired to report
    });

    it('reports repoDrift ONLY for confirmed pairings, mirroring advertisedProjects', async () => {
      const identity = await ensureNodeIdentity({ role: 'hub' });
      const pairedRoot = makeRepo('presence-paired');
      const unpairedRoot = makeRepo('presence-unpaired');
      const paired = await registerProject(pairedRoot);
      await registerProject(unpairedRoot);
      await applyPairingAction('pk-presence', { action: 'confirm', nodeId: identity.nodeId, projectId: paired.id });

      const presence = await collectPresence();
      expect(presence.repoDrift.map((d) => d.projectKey)).toEqual(['pk-presence']);
    });

    it('defaults live capacity to 0/0 (an honest idle claim) when nothing injects it', async () => {
      const presence = await collectPresence();
      expect(presence.capacity.active).toBe(0);
      expect(presence.capacity.heavyActive).toBe(0);
    });
  });
});
