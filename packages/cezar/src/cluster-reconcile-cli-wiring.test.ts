import { serve, type ServerType } from '@hono/node-server';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { CLUSTER_PROTOCOL } from '@loki-labs/cezar-plus-contract';
import { persistNodeCredential } from './cluster/enrollment.ts';
import { ensureNodeIdentity } from './cluster/node-identity.ts';
import { storeNodeSecret } from './cluster/node-secrets.ts';
import { applyPairingAction, upsertNode } from './cluster/peers.ts';
import { createClusterRoutes } from './server/cluster-routes.ts';
import { workspaceConfigPath } from './paths.ts';
import { atomicWriteJsonSync, defaultWorkspaceConfig } from './workspace/config.ts';

const execFile = promisify(execFileCallback);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(packageRoot, 'src/index.ts');
// Absolute, not the bare specifier `tsx` — `kb-submit-signing.test.ts`'s own note on why: a child
// spawned in a temp cwd with no `node_modules` fails `--import tsx` before the entry module ever
// loads, which looks exactly like the wiring itself being broken.
const tsxLoader = createRequire(import.meta.url).resolve('tsx');

/**
 * `cez cluster reconcile` (`index.ts`, `case 'reconcile'`) — D21
 * (`.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, "UNBLOCKED by D22"). Not exported and
 * cannot be unit-tested directly — `index.ts` runs `main()` unconditionally at module scope, so
 * any import executes the real CLI dispatch (the same constraint `kb-submit-signing.test.ts` and
 * `runs-cli-wiring.test.ts` document for their own commands). Driven the only correct way: a real
 * subprocess through the entry point, against a REAL hub — `createClusterRoutes` served for real
 * via `@hono/node-server` — so this proves the actual wire behaviour, not a mock's idea of it.
 *
 * What is only true of THIS wiring, and so only provable here: **dry-run is the default
 * posture** (a bare `cez cluster reconcile`, no flags, must not write) and `--apply` is the one
 * way to opt into a real write. `reconcileProject`'s own dry-run mechanics (byte-identical
 * before/after, no `.bak`) are already covered transport-agnostically in `cluster/reconcile.test.ts`;
 * this file is the one place that can catch a CLI wiring regression that silently drops the
 * `dryRun` computation — the exact bug found and fixed while wiring this command (`values['dry-run']
 * === true || values.apply !== true`; the scaffold this replaced defaulted `--dry-run` itself to
 * `false`, which would have made a bare invocation WRITE).
 */

const HUB_HOME_PREFIX = 'cez-reconcile-cli-hub-home-';
const SPOKE_HOME_PREFIX = 'cez-reconcile-cli-spoke-home-';
const HUB_PROJECT_PREFIX = 'cez-reconcile-cli-hub-project-';
const SPOKE_PROJECT_PREFIX = 'cez-reconcile-cli-spoke-project-';
const CWD_PREFIX = 'cez-reconcile-cli-cwd-';

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const SPOKE_NODE_ID = 'spoke-1';
const SECRET = 'a-real-per-node-secret';
const PROJECT_KEY = 'shared-project';

function todosFile(projectRoot: string): string {
  return join(projectRoot, '.ai/cezar/todos.json');
}

function writeSeedTodos(projectRoot: string, rows: Array<Record<string, unknown>>): void {
  const dataDir = join(projectRoot, '.ai/cezar');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(todosFile(projectRoot), JSON.stringify(rows, null, 2), 'utf8');
}

async function runReconcile(args: string[], spokeHome: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const cwd = tempDir(CWD_PREFIX);
  try {
    const { stdout, stderr } = await execFile(
      process.execPath,
      ['--import', tsxLoader, entry, 'cluster', 'reconcile', ...args, '--json'],
      { cwd, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, CEZ_HOME: spokeHome, CEZ_CLUSTER: '1' } },
    );
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

describe('cez cluster reconcile — dry-run is the default posture (D21)', () => {
  let hubHome: string;
  let spokeHome: string;
  let hubProjectRoot: string;
  let spokeProjectRoot: string;
  let hubEnv: NodeJS.ProcessEnv;
  let server: ServerType;
  let hubUrl: string;

  beforeEach(async () => {
    hubHome = tempDir(HUB_HOME_PREFIX);
    spokeHome = tempDir(SPOKE_HOME_PREFIX);
    hubProjectRoot = tempDir(HUB_PROJECT_PREFIX);
    spokeProjectRoot = tempDir(SPOKE_PROJECT_PREFIX);
    hubEnv = { CEZ_CLUSTER: '1', CEZ_HOME: hubHome };

    // ---- hub side: identity, local project registry, pairing, stored secret ----
    const hubIdentity = await ensureNodeIdentity({ role: 'hub' }, { env: hubEnv });
    expect(hubIdentity.nodeId).toBeTruthy();
    const hubConfig = {
      ...defaultWorkspaceConfig(),
      projects: [{ id: 'hub-proj', root: hubProjectRoot, name: '', addedAt: '', lastOpenedAt: '', source: 'local' as const }],
    };
    atomicWriteJsonSync(workspaceConfigPath(hubEnv), hubConfig);
    await applyPairingAction(PROJECT_KEY, { action: 'confirm', nodeId: hubIdentity.nodeId, projectId: 'hub-proj' }, { env: hubEnv });
    await applyPairingAction(PROJECT_KEY, { action: 'confirm', nodeId: SPOKE_NODE_ID, projectId: 'spoke-proj' }, { env: hubEnv });
    await storeNodeSecret(SPOKE_NODE_ID, SECRET, { env: hubEnv });

    const clusterRoutes = createClusterRoutes({ version: '0.0.0-test', env: hubEnv });
    const app = new Hono().route('/api/v1', clusterRoutes);
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected a TCP address from the real hub');
    hubUrl = `http://127.0.0.1:${address.port}`;

    // ---- spoke side: joined identity (naming the real hub id + url), roster entry for the hub
    // (so `soleClusterPeer()` auto-selects it with no `--peer`), local project registry, pairing ----
    await persistNodeCredential({ nodeId: SPOKE_NODE_ID, hubUrl, secret: SECRET }, { env: { CEZ_HOME: spokeHome } });
    await upsertNode(
      { nodeId: hubIdentity.nodeId, nodeName: 'hub', role: 'hub', labels: [], acceptsDispatch: false, protocol: CLUSTER_PROTOCOL, version: '0.0.0-test' },
      { env: { CEZ_HOME: spokeHome } },
    );
    const spokeConfig = {
      ...defaultWorkspaceConfig(),
      projects: [{ id: 'spoke-proj', root: spokeProjectRoot, name: '', addedAt: '', lastOpenedAt: '', source: 'local' as const }],
    };
    atomicWriteJsonSync(workspaceConfigPath({ CEZ_HOME: spokeHome }), spokeConfig);
    await applyPairingAction(
      PROJECT_KEY,
      { action: 'confirm', nodeId: SPOKE_NODE_ID, projectId: 'spoke-proj' },
      { env: { CEZ_HOME: spokeHome } },
    );

    // Seed BOTH sides with a row only the OTHER side has, so a real (non-dry) reconcile would
    // have something to write — the floor every assertion below depends on.
    writeSeedTodos(hubProjectRoot, [{ id: 'hub-row', summary: 'only on the hub' }]);
    writeSeedTodos(spokeProjectRoot, [{ id: 'spoke-row', summary: 'only on the spoke' }]);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('a bare invocation (no flags) writes NOTHING — byte-identical todos.json on both sides, no .bak created', async () => {
    const hubBefore = readFileSync(todosFile(hubProjectRoot), 'utf8');
    const spokeBefore = readFileSync(todosFile(spokeProjectRoot), 'utf8');

    const result = await runReconcile([], spokeHome);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { dryRun: boolean; reports: Array<{ projectKey: string }> };
    expect(parsed.dryRun).toBe(true); // the floor: the CLI itself reports it stayed a dry run
    expect(parsed.reports.map((r) => r.projectKey)).toEqual([PROJECT_KEY]);

    expect(readFileSync(todosFile(hubProjectRoot), 'utf8')).toBe(hubBefore);
    expect(readFileSync(todosFile(spokeProjectRoot), 'utf8')).toBe(spokeBefore);
    expect(() => readFileSync(`${todosFile(hubProjectRoot)}.bak`, 'utf8')).toThrow(); // no backup taken
    expect(() => readFileSync(`${todosFile(spokeProjectRoot)}.bak`, 'utf8')).toThrow();
  }, 60_000);

  it('--dry-run explicitly still writes nothing (same guarantee, named rather than defaulted)', async () => {
    const hubBefore = readFileSync(todosFile(hubProjectRoot), 'utf8');
    const result = await runReconcile(['--dry-run'], spokeHome);
    expect(result.code).toBe(0);
    expect(readFileSync(todosFile(hubProjectRoot), 'utf8')).toBe(hubBefore);
  }, 60_000);

  it('--apply performs the real merge — both rows land on both sides', async () => {
    const result = await runReconcile(['--apply'], spokeHome);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { dryRun: boolean };
    expect(parsed.dryRun).toBe(false);

    const hubAfter = JSON.parse(readFileSync(todosFile(hubProjectRoot), 'utf8')) as Array<{ id: string }>;
    const spokeAfter = JSON.parse(readFileSync(todosFile(spokeProjectRoot), 'utf8')) as Array<{ id: string }>;
    expect(hubAfter.map((t) => t.id).sort()).toEqual(['hub-row', 'spoke-row']);
    expect(spokeAfter.map((t) => t.id).sort()).toEqual(['hub-row', 'spoke-row']);
  }, 60_000);

  it('--dry-run wins over --apply when both are given — never depends on flag order', async () => {
    const hubBefore = readFileSync(todosFile(hubProjectRoot), 'utf8');
    const result = await runReconcile(['--apply', '--dry-run'], spokeHome);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { dryRun: boolean };
    expect(parsed.dryRun).toBe(true);
    expect(readFileSync(todosFile(hubProjectRoot), 'utf8')).toBe(hubBefore);
  }, 60_000);
});
