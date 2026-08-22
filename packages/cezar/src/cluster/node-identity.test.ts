import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultRuntimeDir } from '../core/broker-isolation.ts';
import {
  capacityEnforcementFor,
  clusterHomeDir,
  clusterModeFromEnv,
  detectCapacityEnforcement,
  discoverNodeLabels,
  ensureNodeIdentity,
  loadNodeIdentity,
  messagesDatabasePath,
  nodeIdentityPath,
  probeAgentCliLoginLabels,
  probeBrowserLabel,
  probeCgroupLabel,
  probeDeviceE2eLabel,
  probeImessageLabel,
  saveNodeIdentity,
  setAcceptsDispatch,
} from './node-identity.ts';

/**
 * `~/.cezar/cluster/node.json` (package 1.1 of
 * `.ai/runs/2026-08-22-multi-node-cezar-cluster/PLAN.md`, spec
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`).
 */
describe('cluster/node-identity', () => {
  const originalHome = process.env.CEZ_HOME;
  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const originalCodexHome = process.env.CODEX_HOME;
  let home: string;
  let claudeConfigDir: string;
  let codexHome: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-node-identity-'));
    process.env.CEZ_HOME = home;
    // `saveNodeIdentity` creates `cluster/` on demand via `atomicWriteJsonSync`'s own `mkdirSync`,
    // but a handful of tests below fixture `node.json` directly with `writeFileSync` (to plant
    // corrupt/pre-existing content) before any write through this module ever runs.
    mkdirSync(clusterHomeDir(), { recursive: true });
    // Point both agent CLIs at empty, isolated dirs by default — never the developer's real
    // `~/.claude` / `~/.codex` — so `discoverNodeLabels`'s default run never depends on whether
    // this shared dev machine happens to have a login lying around.
    claudeConfigDir = mkdtempSync(join(tmpdir(), 'cez-node-identity-claude-'));
    codexHome = mkdtempSync(join(tmpdir(), 'cez-node-identity-codex-'));
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(claudeConfigDir, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  });

  describe('clusterModeFromEnv (D1)', () => {
    it('is disabled with CEZ_CLUSTER unset', () => {
      expect(clusterModeFromEnv({})).toEqual({ enabled: false });
    });

    it('is disabled with CEZ_CLUSTER set to anything other than the exact string "1"', () => {
      expect(clusterModeFromEnv({ CEZ_CLUSTER: '0' })).toEqual({ enabled: false });
      expect(clusterModeFromEnv({ CEZ_CLUSTER: 'true' })).toEqual({ enabled: false });
    });

    it('CEZ_CLUSTER_HUB alone, with no CEZ_CLUSTER=1, is still disabled — no way to configure a contradiction', () => {
      expect(clusterModeFromEnv({ CEZ_CLUSTER_HUB: 'https://hub.example' })).toEqual({ enabled: false });
    });

    it('CEZ_CLUSTER=1 alone is a hub', () => {
      expect(clusterModeFromEnv({ CEZ_CLUSTER: '1' })).toEqual({ enabled: true, role: 'hub' });
    });

    it('CEZ_CLUSTER=1 + CEZ_CLUSTER_HUB is a spoke carrying its hub URL', () => {
      expect(clusterModeFromEnv({ CEZ_CLUSTER: '1', CEZ_CLUSTER_HUB: 'https://hub.example' })).toEqual({
        enabled: true,
        role: 'spoke',
        hubUrl: 'https://hub.example',
      });
    });

    it('an empty/whitespace CEZ_CLUSTER_HUB does not count as a hub URL', () => {
      expect(clusterModeFromEnv({ CEZ_CLUSTER: '1', CEZ_CLUSTER_HUB: '   ' })).toEqual({
        enabled: true,
        role: 'hub',
      });
    });
  });

  describe('paths', () => {
    it('clusterHomeDir and nodeIdentityPath honour CEZ_HOME', () => {
      expect(clusterHomeDir()).toBe(join(home, 'cluster'));
      expect(nodeIdentityPath()).toBe(join(home, 'cluster', 'node.json'));
    });
  });

  describe('loadNodeIdentity', () => {
    it('returns undefined, silently, when no file exists yet', async () => {
      const warn = () => {
        throw new Error('must not warn on a missing file — that is the zero-config default');
      };
      await expect(loadNodeIdentity({ warn })).resolves.toBeUndefined();
    });

    it('degrades to undefined with one warning on unparsable JSON — never throws', async () => {
      writeFileSync(nodeIdentityPath(), '{ not json', 'utf8');
      const warnings: string[] = [];
      const result = await loadNodeIdentity({ warn: (m) => warnings.push(m) });
      expect(result).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });

    it('degrades to undefined with one warning when the file lacks a load-bearing field — never throws', async () => {
      // Valid JSON, but missing `nodeId`/`nodeName`/`role`/`createdAt` — the schema has no
      // `.catch` for those, so this whole record is unusable, not half-initialised.
      writeFileSync(nodeIdentityPath(), JSON.stringify({ acceptsDispatch: true }), 'utf8');
      const warnings: string[] = [];
      const result = await loadNodeIdentity({ warn: (m) => warnings.push(m) });
      expect(result).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });

    it('loads a valid file, and .passthrough() keeps an unknown key a newer cezar might have written', async () => {
      const record = {
        nodeId: 'node-1',
        nodeName: 'box',
        createdAt: '2026-08-22T00:00:00.000Z',
        role: 'hub',
        acceptsDispatch: false,
        labels: ['macos'],
        someFutureField: 'kept',
      };
      writeFileSync(nodeIdentityPath(), JSON.stringify(record), 'utf8');
      const result = await loadNodeIdentity();
      expect(result).toMatchObject(record);
    });
  });

  describe('ensureNodeIdentity + saveNodeIdentity', () => {
    it('mints a full, usable identity on first boot — not a half-initialised object', async () => {
      const identity = await ensureNodeIdentity({ role: 'hub' });
      expect(identity.nodeId).toMatch(/^[0-9a-f-]{36}$/);
      expect(identity.nodeName.length).toBeGreaterThan(0);
      expect(identity.role).toBe('hub');
      expect(identity.acceptsDispatch).toBe(false);
      expect(Array.isArray(identity.labels)).toBe(true);
      expect(() => new Date(identity.createdAt).toISOString()).not.toThrow();
      expect(identity.hubUrl).toBeUndefined();
    });

    it('writes node.json at mode 0600', async () => {
      await ensureNodeIdentity({ role: 'hub' });
      expect(statSync(nodeIdentityPath()).mode & 0o777).toBe(0o600);
    });

    it('nodeId is stable across reads — minted once, never rotated (negative control)', async () => {
      const first = await ensureNodeIdentity({ role: 'hub' });
      const second = await ensureNodeIdentity({ role: 'hub' });
      expect(second.nodeId).toBe(first.nodeId);

      const reloaded = await loadNodeIdentity();
      expect(reloaded?.nodeId).toBe(first.nodeId);
    });

    it('preserves createdAt and acceptsDispatch across a reboot, but re-discovers labels', async () => {
      const first = await ensureNodeIdentity({ role: 'hub' });
      await setAcceptsDispatch(true);

      const second = await ensureNodeIdentity({ role: 'hub' });
      expect(second.createdAt).toBe(first.createdAt);
      expect(second.acceptsDispatch).toBe(true);
      expect(second.labels).toEqual(await discoverNodeLabels());
    });

    it('a corrupt file degrades to a fresh, fully usable identity rather than throwing (negative control)', async () => {
      writeFileSync(nodeIdentityPath(), 'not even json', 'utf8');
      const warnings: string[] = [];
      const identity = await ensureNodeIdentity({ role: 'hub' }, { warn: (m) => warnings.push(m) });
      expect(warnings).toHaveLength(1);
      expect(identity.nodeId).toMatch(/^[0-9a-f-]{36}$/);
      expect(identity.role).toBe('hub');
      expect(identity.acceptsDispatch).toBe(false);
    });

    it('a spoke carries its hub URL; a hub carries none', async () => {
      const spoke = await ensureNodeIdentity({ role: 'spoke', hubUrl: 'https://hub.example' });
      expect(spoke.hubUrl).toBe('https://hub.example');

      const hub = await ensureNodeIdentity({ role: 'hub' });
      expect(hub.hubUrl).toBeUndefined();
    });

    it('an explicit nodeName is honoured on mint, and persists on the next boot with no override', async () => {
      const first = await ensureNodeIdentity({ role: 'hub', nodeName: 'worker-2' });
      expect(first.nodeName).toBe('worker-2');
      const second = await ensureNodeIdentity({ role: 'hub' });
      expect(second.nodeName).toBe('worker-2');
    });
  });

  describe('setAcceptsDispatch (D11)', () => {
    it('defaults to false on a freshly minted node', async () => {
      const identity = await ensureNodeIdentity({ role: 'hub' });
      expect(identity.acceptsDispatch).toBe(false);
    });

    it('toggles the stored value and nothing else', async () => {
      const minted = await ensureNodeIdentity({ role: 'hub' });
      const toggled = await setAcceptsDispatch(true);
      expect(toggled.acceptsDispatch).toBe(true);
      expect(toggled.nodeId).toBe(minted.nodeId);

      const off = await setAcceptsDispatch(false);
      expect(off.acceptsDispatch).toBe(false);
    });

    it('refuses to invent an identity for a node that has never joined a cluster', async () => {
      await expect(setAcceptsDispatch(true)).rejects.toThrow(/has not joined a cluster/);
    });
  });

  describe('label probes — discovered, never configured (D12)', () => {
    const fsWith = (present: Set<string>) => ({ existsSync: (p: string) => present.has(p) });

    it('imessage: absent when the Messages database is absent (negative control)', () => {
      const fs = fsWith(new Set());
      expect(probeImessageLabel('darwin', '/Users/nobody', fs)).toBe(false);
    });

    it('imessage: present when the Messages database exists, on darwin only', () => {
      const home = '/Users/someone';
      const fs = fsWith(new Set([messagesDatabasePath(home)]));
      expect(probeImessageLabel('darwin', home, fs)).toBe(true);
      // Same fixture, different platform — the fact does not travel with the file, it is gated
      // on the OS that can actually run Messages.
      expect(probeImessageLabel('linux', home, fs)).toBe(false);
    });

    it('device-e2e follows imessage: absent on a fixture with no Messages database', () => {
      const fs = fsWith(new Set());
      expect(probeDeviceE2eLabel('darwin', '/Users/nobody', fs)).toBe(false);
    });

    it('device-e2e: present on the same fixture that makes imessage present', () => {
      const home = '/Users/someone';
      const fs = fsWith(new Set([messagesDatabasePath(home)]));
      expect(probeDeviceE2eLabel('darwin', home, fs)).toBe(true);
    });

    it('browser: absent on darwin with neither Chrome nor Chromium installed (negative control)', () => {
      const fs = fsWith(new Set());
      expect(probeBrowserLabel({}, 'darwin', fs)).toBe(false);
    });

    it('browser: present on darwin when Chrome.app exists', () => {
      const fs = fsWith(new Set(['/Applications/Google Chrome.app']));
      expect(probeBrowserLabel({}, 'darwin', fs)).toBe(true);
    });

    it('browser: present on linux only when a known binary is actually on PATH', () => {
      const fs = fsWith(new Set(['/usr/bin/google-chrome']));
      expect(probeBrowserLabel({ PATH: '/usr/bin:/bin' }, 'linux', fs)).toBe(true);
      expect(probeBrowserLabel({ PATH: '/opt/bin' }, 'linux', fs)).toBe(false);
    });

    it('cgroup: absent when neither systemd user-scope nor delegation is available (negative control)', () => {
      const fs = {
        existsSync: () => false,
        accessSync: () => {
          throw new Error('no delegated subtree');
        },
      };
      expect(probeCgroupLabel({ PATH: '/usr/bin' }, fs)).toBe(false);
    });

    it('cgroup: present when a systemd-run binary and a live user-manager socket are both simulated', () => {
      const runtimeDir = defaultRuntimeDir(process.getuid?.() ?? 0);
      const present = new Set(['/usr/bin/systemd-run', `${runtimeDir}/systemd/private`]);
      const fs = {
        existsSync: (p: string) => present.has(p),
        accessSync: () => {},
      };
      expect(probeCgroupLabel({ PATH: '/usr/bin' }, fs)).toBe(true);
    });

    it('claude: absent when the config dir has no oauthAccount on record (negative control)', async () => {
      const labels = await probeAgentCliLoginLabels(process.env);
      expect(labels).not.toContain('claude');
    });

    it('claude: present when .claude.json records an oauthAccount', async () => {
      // `CLAUDE_CONFIG_DIR` is set, so `.claude.json` sits INSIDE it (`claudeStateFilePath`'s
      // override rule), not as a sibling.
      writeFileSync(
        join(claudeConfigDir, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'dev@example.com' } }),
        'utf8',
      );
      const labels = await probeAgentCliLoginLabels(process.env);
      expect(labels).toContain('claude');
    });

    it('claude: an installed-but-not-logged-in config dir (settings.json, no oauthAccount) still does not claim the label', async () => {
      // The installed-vs-logged-in distinction this whole probe exists for: a real config dir
      // that simply has no recorded login must not read as "logged in".
      writeFileSync(join(claudeConfigDir, 'settings.json'), JSON.stringify({}), 'utf8');
      const labels = await probeAgentCliLoginLabels(process.env);
      expect(labels).not.toContain('claude');
    });

    it('codex: absent when auth.json is missing (negative control)', async () => {
      const labels = await probeAgentCliLoginLabels(process.env);
      expect(labels).not.toContain('codex');
    });

    it('codex: present when auth.json carries a usable login (API-key form)', async () => {
      writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-test' }), 'utf8');
      const labels = await probeAgentCliLoginLabels(process.env);
      expect(labels).toContain('codex');
    });

    it('opencode and pi are never claimed — no honest filesystem-only signal exists for either', async () => {
      // Even with both CLI config dirs fully "logged in", opencode/pi have no path this probe
      // reads at all, so they can never appear regardless of what is on disk.
      writeFileSync(
        join(claudeConfigDir, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'dev@example.com' } }),
        'utf8',
      );
      writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-test' }), 'utf8');
      const labels = await probeAgentCliLoginLabels(process.env);
      expect(labels).not.toContain('opencode');
      expect(labels).not.toContain('pi');
    });
  });

  describe('discoverNodeLabels', () => {
    it('never claims a label this machine cannot back — every returned label is a bounded string cezar names in the contract', async () => {
      const labels = await discoverNodeLabels();
      const known = new Set(['macos', 'imessage', 'browser', 'device-e2e', 'cgroup', 'claude', 'codex']);
      for (const label of labels) expect(known.has(label)).toBe(true);
    });

    it('picks up an agent CLI login alongside the filesystem/env labels', async () => {
      writeFileSync(
        join(claudeConfigDir, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'dev@example.com' } }),
        'utf8',
      );
      const labels = await discoverNodeLabels();
      expect(labels).toContain('claude');
    });
  });

  describe('capacityEnforcementFor (D14a) — pure, so every branch is provable without real systemd/darwin', () => {
    it('scope isolation always reports cgroup enforcement, on any platform', () => {
      expect(capacityEnforcementFor('scope', 'linux')).toBe('cgroup');
      expect(capacityEnforcementFor('scope', 'darwin')).toBe('cgroup');
    });

    it('non-scope isolation on darwin degrades to process-tree', () => {
      expect(capacityEnforcementFor('delegated', 'darwin')).toBe('process-tree');
      expect(capacityEnforcementFor('none', 'darwin')).toBe('process-tree');
    });

    it('non-scope isolation off darwin reports none — no process-tree guard claimed there', () => {
      expect(capacityEnforcementFor('delegated', 'linux')).toBe('none');
      expect(capacityEnforcementFor('none', 'linux')).toBe('none');
    });
  });

  describe('detectCapacityEnforcement', () => {
    it('answers one of the three named values, and matches the pure mapping for this real host', async () => {
      const enforcement = await detectCapacityEnforcement();
      expect(['cgroup', 'process-tree', 'none']).toContain(enforcement);
    });
  });
});
