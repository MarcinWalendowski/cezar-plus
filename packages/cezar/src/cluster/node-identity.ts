import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import {
  storedClusterNodeIdentitySchema,
  type ClusterCapacityEnforcement,
  type ClusterNodeLabel,
  type ClusterNodeRole,
  type StoredClusterNodeIdentity,
} from '@loki-labs/better-cezar-contract';
import { readAccountIdentity } from '../agent-config/account-identity.ts';
import { chooseIsolation, probeIsolationCapabilities, type BrokerIsolation } from '../core/broker-isolation.ts';
import { agentHomePaths, cezarHomeDir } from '../paths.ts';
import { atomicWriteJsonSync } from '../workspace/config.ts';

/**
 * This node's own identity, credential and DISCOVERED labels —
 * `~/.cezar/cluster/node.json` at `0600` (spec
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D1 · D11 · D14a · D17).
 *
 * D1 is the whole of the configuration story and lives in `clusterModeFromEnv`: `CEZ_CLUSTER=1`
 * alone is a hub, `CEZ_CLUSTER=1` + `CEZ_CLUSTER_HUB=<url>` is a spoke. One knob fewer, and no way
 * to configure a contradiction — so nothing anywhere else may re-derive hub-ness from a second
 * signal.
 *
 * Labels are **probed, never configured** (D12's zero-config rule): platform, which agent CLIs are
 * logged in, whether the Chrome bridge answers, whether cgroups exist. They are persisted for
 * display only and re-discovered every boot, because a label that outlives the capability it names
 * is a lie the scheduler will act on.
 *
 * `ClusterHomeOptions` below is the option bag every module in this directory takes. It is fixed by
 * the cluster scaffold, not by this package: renaming it, or adding a required member, breaks
 * fifteen sibling files.
 */

/** Fixed by the scaffold. `env` for the process environment (never read directly, so a test can
 *  supply one), `now` for the clock, `warn` for the one-line degrade that must never fail a boot. */
export interface ClusterHomeOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  warn?: (message: string) => void;
}

/** D1, and the only place hub-ness is decided. A `spoke` always carries its hub URL, so no consumer
 *  ever has to ask a second question to find out where to dial. */
export type ClusterMode =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly role: 'hub' }
  | { readonly enabled: true; readonly role: 'spoke'; readonly hubUrl: string };

export function clusterModeFromEnv(env?: NodeJS.ProcessEnv): ClusterMode {
  const e = env ?? process.env;
  // Exact `'1'`, matching every other `CEZ_*` boolean in this repo (`server/capabilities.ts`) —
  // not a truthy coercion, so `CEZ_CLUSTER=0` or `CEZ_CLUSTER=true` stay off rather than surprise.
  if (e.CEZ_CLUSTER !== '1') return { enabled: false };
  const hubUrl = e.CEZ_CLUSTER_HUB?.trim();
  if (hubUrl) return { enabled: true, role: 'spoke', hubUrl };
  return { enabled: true, role: 'hub' };
}

/** `~/.cezar/cluster`. Created `0700` on demand; a read-only home degrades to a smaller working
 *  cockpit rather than failing the boot. */
export function clusterHomeDir(env?: NodeJS.ProcessEnv): string {
  return join(cezarHomeDir(env), 'cluster');
}

export function nodeIdentityPath(env?: NodeJS.ProcessEnv): string {
  return join(clusterHomeDir(env), 'node.json');
}

function reportWarning(options: ClusterHomeOptions | undefined, message: string): void {
  (options?.warn ?? ((m: string) => console.warn(m)))(message);
}

/** `undefined` when this node has never joined a cluster. A CORRUPT file degrades to `undefined`
 *  with one warning — never a throw, and never a silently-recreated identity, which would orphan
 *  every lease and pairing this node holds. */
export async function loadNodeIdentity(
  options?: ClusterHomeOptions,
): Promise<StoredClusterNodeIdentity | undefined> {
  const path = nodeIdentityPath(options?.env);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    // Missing — the zero-config "never joined" state. Silent: every node starts here.
    return undefined;
  }
  if (raw.trim() === '') return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    reportWarning(
      options,
      `[cez] node identity ${path} is corrupt — ignoring it (this node re-mints on next cluster boot)`,
    );
    return undefined;
  }
  const result = storedClusterNodeIdentitySchema.safeParse(parsed);
  if (!result.success) {
    reportWarning(
      options,
      `[cez] node identity ${path} is corrupt — ignoring it (this node re-mints on next cluster boot)`,
    );
    return undefined;
  }
  // The file is left on disk untouched — the next `ensureNodeIdentity`/`saveNodeIdentity` is what
  // replaces it, matching `loadWorkspaceConfig`'s and `loadAgentAccounts`' own house rule.
  return result.data;
}

export interface EnsureNodeIdentityInput {
  role: ClusterNodeRole;
  nodeName?: string;
  hubUrl?: string;
}

function defaultNodeName(): string {
  return hostname().trim() || 'cezar-node';
}

/** Mints on first cluster boot and rewrites the discovered labels on every one. Idempotent: the
 *  `nodeId` is minted once and never rotates. */
export async function ensureNodeIdentity(
  input: EnsureNodeIdentityInput,
  options?: ClusterHomeOptions,
): Promise<StoredClusterNodeIdentity> {
  const now = options?.now ?? (() => new Date());
  const existing = await loadNodeIdentity(options);
  const labels = await discoverNodeLabels(options);
  const nodeName = input.nodeName?.trim() || existing?.nodeName || defaultNodeName();

  const identity: StoredClusterNodeIdentity = {
    // Passthrough fields a newer cezar wrote survive an older one's rewrite (D13's spirit, applied
    // to this node's own file too).
    ...existing,
    nodeId: existing?.nodeId ?? randomUUID(),
    nodeName,
    createdAt: existing?.createdAt ?? now().toISOString(),
    role: input.role,
    // Spoke-only, per the contract schema — cleared on a node that is (now) a hub rather than
    // left stale from a role this node no longer has.
    hubUrl: input.role === 'spoke' ? input.hubUrl : undefined,
    // `acceptsDispatch` is D11's own switch, set by `setAcceptsDispatch` — never reset here, or
    // every reboot would silently re-arm/disarm dispatch out from under the operator's choice.
    acceptsDispatch: existing?.acceptsDispatch ?? false,
    // Re-discovered every boot — see the module docblock on why a stale label is a lie.
    labels,
  };

  await saveNodeIdentity(identity, options);
  return identity;
}

/** Atomic tmp+rename at `0600` — the file holds the link secret (D17: deliberately a file the CLI
 *  writes, not an env var, because a credential in the environment on the box must ALSO be named in
 *  `CEZ_ENV_PASSTHROUGH` and forgetting that fails silently). */
export async function saveNodeIdentity(
  identity: StoredClusterNodeIdentity,
  options?: ClusterHomeOptions,
): Promise<void> {
  // Reuses `workspace/config.ts`'s shared atomic writer — same per-writer tmp path, `0600` file /
  // `0700` dir, and `assertCezarHomeWriteIsSandboxed` guard against a leaked-pin test write. Not
  // reimplemented here so this file has exactly one place that knows how an atomic write happens.
  atomicWriteJsonSync(nodeIdentityPath(options?.env), identity);
}

/** D11: default off. Stored on the node record where the cockpit can show it, never in an env var
 *  somebody has to remember they set. */
export async function setAcceptsDispatch(
  accepts: boolean,
  options?: ClusterHomeOptions,
): Promise<StoredClusterNodeIdentity> {
  const existing = await loadNodeIdentity(options);
  if (!existing) {
    // There is no role to mint an identity with here (that only comes from `ensureNodeIdentity`'s
    // caller, which knows whether this boot is a hub or a spoke) — toggling dispatch on a node
    // that has never joined a cluster is a caller bug, not a state this function can degrade.
    throw new Error('[cez] cannot set acceptsDispatch — this node has not joined a cluster yet');
  }
  const identity: StoredClusterNodeIdentity = { ...existing, acceptsDispatch: accepts };
  await saveNodeIdentity(identity, options);
  return identity;
}

// ---- label + enforcement probes ----------------------------------------------------------------
//
// Every probe below is filesystem/environment only — no process spawn, on the same reasoning
// `broker-isolation.ts`'s own probe gives for itself: a probe that runs at every boot should not
// cost a spawn, and a CLI that prints a healthy banner for a state that does not work is a lesson
// this repo has already paid for once (`wrangler whoami`, SPEC-403). Each is exported and
// independently fixturable so "the label is absent when the capability is absent" is provable
// without depending on what this shared dev machine happens to have installed today.

interface LabelProbeFs {
  existsSync(path: string): boolean;
}
const nodeFs: LabelProbeFs = { existsSync };

/** The concrete, checkable proxy this spec names for "signed into Messages"
 *  (`AGENTS.md` → "Definition of Done": "a signed-in Messages account"). */
export function messagesDatabasePath(home: string = homedir()): string {
  return join(home, 'Library', 'Messages', 'chat.db');
}

export function probeImessageLabel(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  fs: LabelProbeFs = nodeFs,
): boolean {
  return platform === 'darwin' && fs.existsSync(messagesDatabasePath(home));
}

/**
 * `device-e2e`: the full precondition list in `AGENTS.md` → "Definition of Done" is SIP disabled +
 * a signed-in Messages account + the repo's prebuilt messaging-CLI binaries. Only the middle one is
 * a NODE-level fact this probe can check — the binaries are per-repo, and `discoverNodeLabels` runs
 * with no project in scope; SIP status has no filesystem signal cheap enough to trust without a
 * subprocess spawn, which this file's probes deliberately avoid (see the section note above).
 *
 * That means checking only `chat.db` risks a false POSITIVE, not a false negative: claiming this
 * label on a Mac with SIP re-enabled, or with those binaries missing, sends a device-e2e task
 * to a node that then fails it. Accepted anyway, for a reason specific to this fleet rather than a
 * general excuse: `chat.db` cannot exist on a VPS worker, so the only node that can ever over-claim
 * this label is the one that genuinely IS the device-e2e machine (Problem §2a) — the failure mode
 * is "the Mac's SIP got re-enabled since last boot", not "a cattle worker claims iMessage".
 */
export function probeDeviceE2eLabel(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  fs: LabelProbeFs = nodeFs,
): boolean {
  return probeImessageLabel(platform, home, fs);
}

const BROWSER_APP_PATHS_DARWIN = ['/Applications/Google Chrome.app', '/Applications/Chromium.app'];
const BROWSER_BIN_NAMES_LINUX = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];

/**
 * `browser`: stands in for "the Chrome bridge answers" (Problem §2a / D12) until that bridge
 * exists to actually ping — nothing in this repo implements it yet (checked: no `chrome-bridge`
 * module anywhere in `packages/cezar/src`). Provisional: accepted because nothing consumes this
 * label yet, so an install-only proxy costs nothing today. A real browser install does NOT verify
 * a logged-in profile, which this probe has no way to reach with zero project context — narrower
 * than the eventual signal, never wider. When the Chrome bridge lands, this probe is REPLACED
 * wholesale by a real ping, not extended with more filesystem heuristics.
 */
export function probeBrowserLabel(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  fs: LabelProbeFs = nodeFs,
): boolean {
  if (platform === 'darwin') {
    return BROWSER_APP_PATHS_DARWIN.some((path) => fs.existsSync(path));
  }
  if (platform === 'linux') {
    const dirs = (env.PATH ?? '').split(':').filter(Boolean);
    return BROWSER_BIN_NAMES_LINUX.some((bin) => dirs.some((dir) => fs.existsSync(`${dir}/${bin}`)));
  }
  return false;
}

/**
 * `cgroup`: "cgroups exist on this node at all" — a broader signal than
 * `detectCapacityEnforcement`'s `'cgroup'` return, which is deliberately narrower (only the
 * `'scope'` isolation mode gets a real per-run cgroup that can carry `MemoryMax`, per D14a). A
 * `delegated` node can legitimately carry this label while still reporting `'none'` enforcement —
 * that is not a contradiction, it is two different questions about the same fact.
 */
export function probeCgroupLabel(
  env: NodeJS.ProcessEnv,
  fs?: { existsSync(path: string): boolean; accessSync(path: string, mode: number): void },
): boolean {
  const caps = probeIsolationCapabilities(env, fs);
  return caps.userScopeAvailable || caps.delegated;
}

/**
 * `claude` / `codex`: filesystem-only "is this CLI actually LOGGED IN", never "is it installed" —
 * `backend-detect.ts`'s `--version` probes answer the latter and say so in their own hints ("if
 * not authenticated, run `claude` once and log in"), which is exactly the `wrangler whoami`
 * mistake (SPEC-403) applied to a coding-agent CLI: a healthy banner for a token that does not
 * work. Package 4.5 provisions a worker and deliberately STOPS at the interactive login step, so a
 * freshly minted worker is normally enrolled, reachable, and unable to run anything — without this
 * label, placement has no way to see that and dispatches work that fails on arrival.
 *
 * Reuses `agent-config/account-identity.ts`'s existing readers — the one place in this repo that
 * already knows where each vendor writes its login (`.claude.json`'s `oauthAccount`;
 * `<CODEX_HOME>/auth.json`'s tokens/API key) — rather than re-deriving that knowledge here. Only
 * `.available` is read; the identity FIELDS that function returns (email, org, plan) are never
 * touched, so nothing about who is logged in ever reaches a node label.
 *
 * `opencode` and `pi` are deliberately never claimed. OpenCode's credentials live in a SQLite DB
 * outside its config dir — `readAccountIdentity`'s own docblock: "cezar cannot read it" — and `pi`
 * documents no per-user home directory at all (`agent-profiles.ts`: "nothing documented"), so
 * `agentHomePaths()` has no path for it to check in the first place. Neither has an honest
 * filesystem-only signal, and the rule below is why that means silence: a label that over-claims
 * sends work to a machine that cannot do it and reports the failure as the task's fault; an absent
 * label queues the work with a stated reason a person can read and act on.
 */
export async function probeAgentCliLoginLabels(env: NodeJS.ProcessEnv): Promise<ClusterNodeLabel[]> {
  const home = agentHomePaths(env);
  const labels: ClusterNodeLabel[] = [];
  if ((await readAccountIdentity('claude', home.claude)).available) labels.push('claude');
  if ((await readAccountIdentity('codex', home.codex)).available) labels.push('codex');
  return labels;
}

/** Probed every boot. A probe that cannot answer omits its label rather than guessing — an absent
 *  label queues a run with a stated reason, a wrong one runs it on a machine that cannot do it. */
export async function discoverNodeLabels(options?: ClusterHomeOptions): Promise<ClusterNodeLabel[]> {
  const env = options?.env ?? process.env;
  const platform = process.platform;
  const labels: ClusterNodeLabel[] = [];
  if (platform === 'darwin') labels.push('macos');
  if (probeImessageLabel(platform)) labels.push('imessage');
  if (probeDeviceE2eLabel(platform)) labels.push('device-e2e');
  if (probeBrowserLabel(env, platform)) labels.push('browser');
  if (probeCgroupLabel(env)) labels.push('cgroup');
  labels.push(...(await probeAgentCliLoginLabels(env)));
  return labels;
}

/** Pure mapping from measured isolation to the claim `detectCapacityEnforcement` reports —
 *  separated out so every branch is testable without real `systemd-run` or a real Darwin host. */
export function capacityEnforcementFor(
  isolation: BrokerIsolation,
  platform: NodeJS.Platform,
): ClusterCapacityEnforcement {
  // Only a real per-run scope (`broker-isolation.ts`'s `'scope'` mode) can carry `MemoryMax` on
  // THIS run's own cgroup — `'delegated'` shares the service's cgroup, so there is nothing
  // per-run to bound.
  if (isolation === 'scope') return 'cgroup';
  if (platform === 'darwin') return 'process-tree';
  return 'none';
}

/**
 * D14a, and the value the node row's `enforcement` field renders. `cgroup` where
 * `broker-isolation.ts`'s transient scope can carry `MemoryMax`; `process-tree` on macOS, which has
 * no cgroups and degrades to cezar's existing `memoryLimitMb` guard; `none` where neither is
 * available. Measured, never assumed — a limit that silently does not exist on one node is worse
 * than one that was never claimed.
 */
export async function detectCapacityEnforcement(
  options?: ClusterHomeOptions,
): Promise<ClusterCapacityEnforcement> {
  const env = options?.env ?? process.env;
  const isolation = chooseIsolation(probeIsolationCapabilities(env));
  return capacityEnforcementFor(isolation, process.platform);
}
