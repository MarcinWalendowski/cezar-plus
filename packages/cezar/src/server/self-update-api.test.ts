import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RegistryCache } from '../self-update/registry.ts';
import { SelfUpdateService } from '../self-update/service.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, type Principal } from './server.ts';

/**
 * `/api/v1/workspace/self-update` (self-update PoC). The load-bearing security property: a
 * HOSTED cockpit (`CEZ_REMOTE`) may only apply a version that is forward IN TIME. Installing a
 * published package cannot inject code, but installing an older one can — every hosted guard
 * (the `/api/*` request-origin check #426, the `localHandoff` 409 on agent-config writes that
 * closes the hooks RCE path) lives in the running version, so moving back to a release that
 * predates them re-opens exactly what they close. A local cockpit keeps the whole picker.
 *
 * The registry is stubbed: the unit gate stays hermetic (no npmjs.org round trip), and the
 * stubbed publish dates encode the trap that semver order alone misses — cezar's nightlies are
 * `<next-version>-nightly.<date>.<run>`, so `0.13.0-nightly.20260901.3` OUTRANKS the running
 * `0.12.1` while having been published nineteen days before it.
 */
describe('the self-update API', () => {
  const RUNNING = '0.12.1';
  const registryDocument = {
    'dist-tags': { latest: '0.13.0', nightly: '0.13.0-nightly.20260901.3' },
    versions: {
      '0.11.1': {},
      '0.12.0': {},
      '0.12.1': {},
      '0.13.0-nightly.20260901.3': {},
      '0.13.0': {},
    },
    time: {
      '0.11.1': '2026-08-01T00:00:00.000Z',
      '0.12.0': '2026-09-01T00:00:00.000Z',
      '0.12.1': '2026-09-20T00:00:00.000Z',
      // Published BEFORE the running 0.12.1, yet semver-newer than it. The trap.
      '0.13.0-nightly.20260901.3': '2026-09-01T03:00:00.000Z',
      '0.13.0': '2026-09-27T00:00:00.000Z',
    },
  };

  let repoRoot: string;
  let home: string;
  let store: RunStore;
  let app: Hono;
  const prevRemote = process.env.CEZ_REMOTE;
  const prevHome = process.env.CEZ_HOME;
  const prevAuth = process.env.CEZ_AUTH;
  let principal: Principal | null;

  beforeEach(() => {
    delete process.env.CEZ_REMOTE;
    process.env.CEZ_AUTH = 'oidc';
    principal = { kind: 'session', userId: 'u1', orgId: 'o1', teamId: 't1', role: 'owner' };
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-selfupdate-'));
    home = mkdtempSync(join(tmpdir(), 'cez-selfupdate-home-'));
    process.env.CEZ_HOME = home;
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    const stubFetch = (async () =>
      new Response(JSON.stringify(registryDocument), { status: 200 })) as unknown as typeof fetch;
    const selfUpdate = new SelfUpdateService({
      pkgName: '@loki-labs/cezar-plus',
      version: RUNNING,
      entry: join(home, 'somewhere', 'dist', 'index.js'),
      restart: () => {},
      env: { ...process.env, CEZ_HOME: home },
      registry: new RegistryCache('@loki-labs/cezar-plus', stubFetch),
    });
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: RUNNING, selfUpdate, sessionResolver: { resolveFromCookieHeader: () => principal } });
  });
  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    if (prevRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = prevRemote;
    if (prevHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = prevHome;
    if (prevAuth === undefined) delete process.env.CEZ_AUTH;
    else process.env.CEZ_AUTH = prevAuth;
  });

  const apply = (version: string) =>
    apiRequest(app, '/api/v1/workspace/self-update/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version }),
    });
  const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

  it('lets members read status but refuses every self-update mutation before validation', async () => {
    principal = { ...principal!, role: 'member' };
    expect((await apiRequest(app, '/api/v1/workspace/self-update')).status).toBe(200);
    for (const [path, method] of [['refresh', 'POST'], ['channel', 'PUT'], ['apply', 'POST']]) {
      const res = await apiRequest(app, `/api/v1/workspace/self-update/${path}`, { method, headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(403);
    }
  });

  it('allows an administrator to reach the validated update service', async () => {
    principal = { ...principal!, role: 'admin' };
    expect((await apply('')).status).toBe(400);
    expect((await apiRequest(app, '/api/v1/workspace/self-update/refresh', { method: 'POST' })).status).toBe(200);
  });

  it('refuses anonymous hosted update mutations', async () => {
    process.env.CEZ_REMOTE = '1';
    delete process.env.CEZ_AUTH;
    expect((await apply('0.13.0')).status).toBe(403);
  });

  it('requires a valid hosted session before updating', async () => {
    process.env.CEZ_REMOTE = '1';
    principal = null;
    expect((await apply('0.13.0')).status).toBe(401);
  });

  it('answers the status with the running version and an install kind', async () => {
    const res = await apiRequest(app, '/api/v1/workspace/self-update');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; installKind: string; job: unknown };
    expect(body.version).toBe(RUNNING);
    expect(['managed', 'global-npm', 'npx', 'checkout', 'unknown']).toContain(body.installKind);
    expect(body.job).toBeNull();
  });

  it('rejects a body that is not a plain version string', async () => {
    for (const version of ['', 'https://evil.example/x.tgz', '../../etc', 'a'.repeat(65)]) {
      expect((await apply(version)).status).toBe(400);
    }
  });

  it('refuses an older or equal version in hosted mode', async () => {
    process.env.CEZ_REMOTE = '1';
    for (const target of ['0.11.1', '0.12.0', RUNNING, '0.11.1+local']) {
      const res = await apply(target);
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toContain('is not newer than the running');
    }
  });

  // The whole point of the publish-date check: semver order alone would wave this one through.
  it('refuses a semver-newer version that was published BEFORE the running one', async () => {
    process.env.CEZ_REMOTE = '1';
    const res = await apply('0.13.0-nightly.20260901.3');
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toContain('was published before the running');
  });

  it('refuses a prerelease the registry cannot date, when the running version is a release', async () => {
    process.env.CEZ_REMOTE = '1';
    const res = await apply('0.99.0-nightly.20260101.1');
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toContain('gave no publish date to check it against');
  });

  it('lets a genuinely newer version past the hosted guard', async () => {
    process.env.CEZ_REMOTE = '1';
    const res = await apply('0.13.0');
    expect(res.status).toBe(409);
    // Past the forward-only guard: what refuses now is the install-kind capability, not it.
    const error = await errorOf(res);
    expect(error).not.toContain('can only update forward');
    expect(error).toMatch(/could not tell how it was installed|npx|npm -g|git checkout/);
  });

  it('never applies the forward-only rule to a local cockpit', async () => {
    for (const target of ['0.11.1', RUNNING, '0.13.0-nightly.20260901.3']) {
      const res = await apply(target);
      expect(res.status).toBe(409);
      expect(await errorOf(res)).not.toContain('can only update forward');
    }
  });
});
