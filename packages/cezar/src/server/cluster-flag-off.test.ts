import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { composeSystemPrompt, TOOL_BUDGET_DOCTRINE } from '../workflows/run.ts';
import { HANDOFF_INSTRUCTIONS } from '../handoff.ts';
import { knowledgeSystemPrompt } from '../knowledge/prompt.ts';
import { workspaceGrantSystemPrompt } from '../workspace/granted-roots.ts';
import { nodeIdentityPath } from '../cluster/node-identity.ts';
import type { UpgradeCapableServer } from '../cluster/link-server.ts';
import { startClusterRuntime } from './cluster-routes.ts';
import { createApp, projectRouteManifest, startServer, type ServerDeps } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/** `startClusterRuntime` (package 1.5) requires a real upgrade-capable server to attach a hub link
 *  to. Every call in THIS file is either flag-off or "no identity on disk yet", so none of them
 *  ever reaches that attach — a bare, never-`listen()`ed `http.Server` satisfies the type without
 *  needing a port. */
function fakeUpgradeServer(): UpgradeCapableServer {
  return createServer();
}

/**
 * **Verification 12** of `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`: with `CEZ_CLUSTER`
 * unset, a cezar that has the cluster code compiled into it is a cezar with no cluster — nothing
 * armed, nothing served, nothing written, and not a byte of prompt.
 *
 * Modelled on `automations-gate.test.ts`, which is the precedent this family follows in every
 * respect: the gate is registered on EXPLICIT paths (never `use('*')`, which `route()` would
 * re-register over the whole `/api/v1` prefix including the CORS-open `/health` the cockpit boots
 * from), and off means `409` naming the flag rather than `404`.
 *
 * **The spec's Verification 12 originally asked for `404` here and was corrected to `409` during
 * implementation.** Two reasons, both load-bearing: `404` is already spoken by this family with a
 * different meaning (`DELETE /cluster/nodes/:nodeId` answers it for an unknown node id, so a
 * client could not tell "no such node" from "clustering is off"), and `automations` — the closest
 * precedent, a feature that likewise has no settings section when off — answers `409` naming its
 * flag for every route of its family. The cockpit half of Verification 12 is unchanged: the
 * settings route `/settings/cluster` really is a `404`, asserted in
 * `packages/web/src/routes/settings/settings.test.tsx` where the registry's `capability` gate
 * lives.
 *
 * Four of the five claims are asserted here; the fifth (nav + route absent) is the web test above.
 */

/** Every route of the family, in the spelling `cluster-routes.ts` registers. */
const CLUSTER_ROUTES: Array<[label: string, path: string, init?: RequestInit]> = [
  ['GET /cluster', '/api/v1/cluster'],
  ['POST /cluster/enroll', '/api/v1/cluster/enroll', json({})],
  ['DELETE /cluster/enroll/:codeId', '/api/v1/cluster/enroll/code_1', { method: 'DELETE' }],
  ['POST /cluster/join', '/api/v1/cluster/join', json({ code: 'CEZ-AAAA-BBBB' })],
  ['PATCH /cluster/nodes/:nodeId', '/api/v1/cluster/nodes/node_1', json({ acceptsDispatch: false }, 'PATCH')],
  ['DELETE /cluster/nodes/:nodeId', '/api/v1/cluster/nodes/node_1', { method: 'DELETE' }],
  ['GET /cluster/pairings', '/api/v1/cluster/pairings'],
  ['POST /cluster/pairings/:projectKey', '/api/v1/cluster/pairings/workspace-root', json({ action: 'accept' })],
  ['GET /cluster/corpus', '/api/v1/cluster/corpus'],
  ['GET /cluster/corpus/*', '/api/v1/cluster/corpus/knowledge/decisions.md'],
  ['POST /cluster/corpus/submit', '/api/v1/cluster/corpus/submit', json({ path: 'knowledge/x.md', body: 'hi' })],
  ['GET /cluster/active', '/api/v1/cluster/active'],
  ['POST /cluster/allocate/:kind', '/api/v1/cluster/allocate/port', json({})],
  ['POST /cluster/leases/:kind', '/api/v1/cluster/leases/port', json({ id: 'p-1' })],
  ['DELETE /cluster/leases/:kind/:id', '/api/v1/cluster/leases/port/p-1', { method: 'DELETE' }],
];

function json(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

describe('cluster is inert with CEZ_CLUSTER unset (spec verification 12)', () => {
  let repoRoot: string;
  let dataDir: string;
  let home: string;
  let store: RunStore;
  const savedCluster = process.env.CEZ_CLUSTER;
  const savedHub = process.env.CEZ_CLUSTER_HUB;
  const savedHome = process.env.CEZ_HOME;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-cluster-off-'));
    dataDir = join(repoRoot, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    home = mkdtempSync(join(tmpdir(), 'cez-cluster-off-home-'));
    store = RunStore.open(dataDir);
    process.env.CEZ_HOME = home;
    delete process.env.CEZ_CLUSTER;
    delete process.env.CEZ_CLUSTER_HUB;
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    if (savedCluster === undefined) delete process.env.CEZ_CLUSTER;
    else process.env.CEZ_CLUSTER = savedCluster;
    if (savedHub === undefined) delete process.env.CEZ_CLUSTER_HUB;
    else process.env.CEZ_CLUSTER_HUB = savedHub;
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    vi.restoreAllMocks();
  });

  const app = (over: Partial<ServerDeps> = {}) =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', ...over });

  describe('the API surface', () => {
    it.each(CLUSTER_ROUTES.map(([label]) => label))(
      '%s answers 409 with a reason naming the flag',
      async (label) => {
        const [, path, init] = CLUSTER_ROUTES.find(([name]) => name === label)!;
        const res = await apiRequest(app(), path, init);
        expect(res.status).toBe(409);
        // Not `toBe(409)` alone, on purpose. The corpus routes answer 409 for their OWN reason
        // (package 3b.2 has not landed), so a status-only assertion would pass against a gate that
        // never ran for three of these fifteen paths. The flag name is what distinguishes them.
        expect(((await res.json()) as { error: string }).error).toContain('CEZ_CLUSTER');
      },
    );

    // The regression the explicit-path registration exists for: `clusterRoutes` is mounted with
    // `.route('/', …)` beside two dozen unrelated sub-apps, and `route()` re-registers a sub-app's
    // MIDDLEWARE under the mount prefix — so a guard written as `use('*')` would 409 the entire
    // `/api/v1` surface, `/health` included, and the cockpit would not boot.
    it('gates only its own family — health and its neighbours are untouched', async () => {
      const built = app();
      expect((await apiRequest(built, '/api/v1/health')).status).toBe(200);
      expect((await apiRequest(built, '/api/v1/runs')).status).toBe(200);
      expect((await apiRequest(built, '/api/v1/todos')).status).toBe(200);
      expect((await apiRequest(built, '/api/v1/workflows')).status).toBe(200);
    });

    // The mirror image of `automations-gate.test.ts`'s "gates the project-scoped mirror too": a
    // cluster answers for the WHOLE workspace, so the family is chained into `workspaceV1` only
    // and there is deliberately no `/p/:projectId` spelling to protect. A 409 here would mean the
    // family had leaked into the project mount and grown a second surface with no consumer.
    it('has no project-scoped mirror to gate', async () => {
      const built = app();
      // POSITIVE CONTROL, and the reason this test is not vacuous. `expect(404)` alone is satisfied
      // by "the cluster family is absent from the project mount" AND by "the project mount does not
      // exist at all in this builder" — and an absent mount is not something this file proves
      // anywhere else (the suites that do exercise `/api/v1/p/:projectId` build their apps
      // differently). So assert the mount is alive and populated FIRST, from the app's own
      // registrations rather than by probing a path that could itself be retired:
      // `projectRouteManifest` is derived from `app.routes`, so it cannot drift from the code.
      const scoped = projectRouteManifest(built);
      expect(scoped.length).toBeGreaterThan(0);
      expect(scoped.filter((r) => r.path.startsWith('/cluster'))).toEqual([]);

      const res = await apiRequest(built, '/api/v1/p/default/cluster');
      expect(res.status).toBe(404);
    });

    it('reports the capability as off on health, which is what the nav gate reads', async () => {
      const res = await apiRequest(app(), '/api/v1/health');
      const body = (await res.json()) as { capabilities: Record<string, boolean> };
      // Present and false — never absent. `capabilities` is an exhaustive record the cockpit reads
      // key by key; a missing key and a false key are the same thing to `Boolean(caps.cluster)`
      // today and stop being the same the moment anyone writes `caps.cluster ?? true`.
      expect(Object.hasOwn(body.capabilities, 'cluster')).toBe(true);
      expect(body.capabilities.cluster).toBe(false);
    });
  });

  describe('the disk', () => {
    it('writes nothing under ~/.cezar/cluster or .ai/cezar/cluster, even after every route is hit', async () => {
      const built = app();
      for (const [, path, init] of CLUSTER_ROUTES) await apiRequest(built, path, init);
      startClusterRuntime({ version: '0.0.0-test', server: fakeUpgradeServer(), resolveDispatchManager: async () => undefined })();

      expect(existsSync(join(home, 'cluster'))).toBe(false);
      expect(existsSync(join(dataDir, 'cluster'))).toBe(false);
      // A floor: `CEZ_HOME` really is pinned at the temp dir, so "nothing there" is a fact about
      // the pin and not about a path nobody ever resolves. `readdirSync` throws if the dir is
      // missing, which would itself fail this line.
      expect(readdirSync(home)).not.toContain('cluster');
    });
  });

  describe('the background runtime', () => {
    it('arms no timer and says nothing', () => {
      const interval = vi.spyOn(globalThis, 'setInterval');
      const warn = vi.fn();
      const stop = startClusterRuntime({ version: '0.0.0-test', warn, server: fakeUpgradeServer(), resolveDispatchManager: async () => undefined });
      expect(interval).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(() => stop()).not.toThrow();
    });

    // The negative control for the case above, and the one this test was re-pointed at when
    // activation landed (package 1.5): with the flag on and no identity ever enrolled on this
    // node (a fresh `home`, per `beforeEach`), the function is reached, actually loads
    // `~/.cezar/cluster/node.json` from disk, finds nothing, and says so by name — not a canned
    // "not implemented yet" string. `loadNodeIdentity` is the one async step
    // (`readFile`), so the warning lands on a later tick than this call; `vi.waitFor` is what
    // makes waiting for it non-flaky rather than racing real disk I/O with a bare microtask.
    it('is reached and gated by the flag, not merely unimplemented', async () => {
      process.env.CEZ_CLUSTER = '1';
      const warn = vi.fn();
      const stop = startClusterRuntime({ version: '0.0.0-test', warn, server: fakeUpgradeServer(), resolveDispatchManager: async () => undefined });
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      expect(warn.mock.calls[0]?.[0]).toContain('CEZ_CLUSTER=1');
      expect(warn.mock.calls[0]?.[0]).toContain('no cluster identity');
      expect(warn.mock.calls[0]?.[0]).toContain(nodeIdentityPath()); // reads process.env.CEZ_HOME, pinned to `home` above
      expect(() => stop()).not.toThrow();
    });

    it('the API answers for real once the flag is on, so the 409s above are the gate speaking', async () => {
      process.env.CEZ_CLUSTER = '1';
      const built = app();

      // No identity on this node, so the roster is honest rather than refused.
      const roster = await apiRequest(built, '/api/v1/cluster');
      expect(roster.status).toBe(200);

      // And `/cluster/join` now answers with ITS OWN reason, which is the check that the
      // `toContain('CEZ_CLUSTER')` assertions above were not passing on this message by accident.
      // Not `/cluster/corpus` any more (superseded 2026-08-23, D20): that route now requires a
      // signed node principal first (`node-auth.ts`), so an unauthenticated request there answers
      // node-auth's 401 rather than the corpus stub's 409 — a real, correct refusal from a
      // DIFFERENT gate, not a regression of this one. `/cluster/join` is deliberately excluded
      // from node-auth (a joining node has no secret yet to sign with, D20 §"which routes"), so it
      // still reaches `requireHub`'s own 409 with no credentials of any kind, which is exactly the
      // "a different gate is speaking" case this assertion exists to prove.
      const join = await apiRequest(built, '/api/v1/cluster/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'cezj_not-a-real-code' }),
      });
      expect(join.status).toBe(409);
      const error = ((await join.json()) as { error: string }).error;
      expect(error).not.toContain('CEZ_CLUSTER');
      expect(error).toContain('no cluster identity');

      const health = await apiRequest(built, '/api/v1/health');
      expect(((await health.json()) as { capabilities: { cluster: boolean } }).capabilities.cluster).toBe(
        true,
      );
    });
  });

  describe('the agent system prompt', () => {
    /**
     * Composed the way `workflows/run.ts` composes it for every agent step — skill body, the run's
     * extra prompt, the tool-budget doctrine, the handoff contract, the workspace grant, the
     * knowledge block — under each flag state.
     *
     * `vi.resetModules()` + a dynamic re-import is what makes this non-vacuous: every part above is
     * a MODULE-LEVEL constant, so a plain flag flip inside one process would leave them frozen at
     * whatever they were when the file first imported, and a `CEZ_CLUSTER === '1' ? …` read at
     * module scope — the exact thing this asserts nobody added — would sail through. Re-importing
     * re-evaluates them.
     */
    const composeUnder = async (flag: string | undefined): Promise<string> => {
      if (flag === undefined) delete process.env.CEZ_CLUSTER;
      else process.env.CEZ_CLUSTER = flag;
      vi.resetModules();
      const run = await import('../workflows/run.ts');
      const handoff = await import('../handoff.ts');
      const knowledge = await import('../knowledge/prompt.ts');
      const grants = await import('../workspace/granted-roots.ts');
      return run.composeSystemPrompt(
        'SKILL BODY',
        'EXTRA PROMPT',
        run.TOOL_BUDGET_DOCTRINE,
        handoff.HANDOFF_INSTRUCTIONS,
        grants.workspaceGrantSystemPrompt({
          projects: [{ id: 'p1', name: 'proj-one', root: '/tmp/proj-one', status: 'ok' }],
          roots: ['/tmp/proj-one'],
          isolated: false,
          paths: new Map(),
        }),
        knowledge.knowledgeSystemPrompt(undefined),
      );
    };

    it('is byte-identical with the flag on and off', async () => {
      const off = await composeUnder(undefined);
      const on = await composeUnder('1');
      expect(on).toBe(off);
      expect(on.length).toBe(off.length);
    });

    it('really composed a prompt — the comparison above is not two empty strings', async () => {
      // The floor. `composeSystemPrompt` drops blank parts, so a refactor that emptied every
      // constant would make "identical" trivially true; these markers are the proof that the
      // string under comparison is the real agent prompt.
      const off = await composeUnder(undefined);
      expect(off).toContain('SKILL BODY');
      expect(off).toContain('EXTRA PROMPT');
      expect(off).toContain(TOOL_BUDGET_DOCTRINE);
      expect(off).toContain(HANDOFF_INSTRUCTIONS);
      expect(off.length).toBeGreaterThan(500);
      // And nothing anywhere in it says anything about a cluster.
      expect(off.toLowerCase()).not.toContain('cluster');
    });

    it('composes the same parts this test names — pinned against the real call site', () => {
      // Guards the fixture itself: if `run.ts` stopped exporting one of these, or
      // `workspaceGrantSystemPrompt`/`knowledgeSystemPrompt` moved, the dynamic imports above
      // would throw rather than silently compose a shorter prompt. Kept as a static import too so
      // `tsc` sees the same symbols the dynamic path resolves at runtime.
      expect(typeof composeSystemPrompt).toBe('function');
      expect(typeof workspaceGrantSystemPrompt).toBe('function');
      expect(typeof knowledgeSystemPrompt).toBe('function');
      expect(TOOL_BUDGET_DOCTRINE.length).toBeGreaterThan(0);
      expect(HANDOFF_INSTRUCTIONS.length).toBeGreaterThan(0);
    });
  });

  /**
   * The upgrade path, which none of the HTTP cases above can reach: `/api/v1/cluster/link` is a
   * raw `'upgrade'` on the `http.Server`, not a Hono route, so it has no status code to assert and
   * both drift guards are blind to it.
   *
   * What is being pinned is `server.ts`'s argument to `attachUpgradeFallback`, not the fallback
   * itself (`ws.test.ts` owns that). The first version of this wiring named `CLUSTER_LINK_PATH`
   * unconditionally, on the reasoning that an unowned-but-listed path merely "hangs instead of
   * being killed, which is strictly safer". With the flag off it is not safer: nothing in the
   * process will ever answer that upgrade, so every attempt parks a socket that is neither replied
   * to nor closed — an unbounded fd leak on a switched-off feature, reachable by anyone who can
   * reach the port.
   */
  describe('the WebSocket upgrade at /api/v1/cluster/link', () => {
    const booted: Array<{ close: () => void }> = [];

    afterEach(() => {
      for (const server of booted.splice(0)) server.close();
    });

    /** Boots a REAL server on an ephemeral port — `attachUpgradeFallback` is wired inside
     *  `startServer`, so nothing short of a listening server exercises the argument under test. */
    async function boot(): Promise<number> {
      const { server } = startServer(
        { repoRoot, store, manager: { isActive: () => false } as unknown as RunManager, version: '0.0.0-test' },
        0,
      );
      booted.push(server);
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      return (server.address() as AddressInfo).port;
    }

    /** Sends a real WebSocket handshake and reports whether the SERVER hung up within `waitMs`. */
    async function handshakeClosed(port: number, path: string, waitMs = 500): Promise<boolean> {
      const socket = connect(port, '127.0.0.1');
      return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          socket.destroy();
          resolve(false);
        }, waitMs);
        timer.unref();
        socket.on('close', () => {
          clearTimeout(timer);
          resolve(true);
        });
        socket.on('error', () => {
          clearTimeout(timer);
          resolve(true);
        });
        socket.on('connect', () => {
          socket.write(
            `GET ${path} HTTP/1.1\r\n` +
              `Host: 127.0.0.1:${port}\r\n` +
              'Upgrade: websocket\r\n' +
              'Connection: Upgrade\r\n' +
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
              'Sec-WebSocket-Version: 13\r\n\r\n',
          );
        });
      });
    }

    it('is destroyed, not parked, while the flag is off', async () => {
      expect(await handshakeClosed(await boot(), '/api/v1/cluster/link')).toBe(true);
    });

    it('negative control: with CEZ_CLUSTER=1 the same handshake is NOT destroyed', async () => {
      // The other direction, and the only thing that makes the case above mean anything: a server
      // that hung up on every upgrade would satisfy it. With the flag on the path is owned — by
      // the link server once activation attaches it, and until then the handshake waits, which is
      // the right error for a node dialling a hub that is still booting.
      //
      // A bounded wait is honest here because a stall is exactly what is being asserted: the claim
      // is "the server had not hung up after 500ms", not "it never will".
      process.env.CEZ_CLUSTER = '1';
      expect(await handshakeClosed(await boot(), '/api/v1/cluster/link')).toBe(false);
    });

    it('floor: a path nothing has ever owned is destroyed under both flag states', async () => {
      // Proves the flag-off case decides on OWNERSHIP rather than refusing every upgrade, and that
      // the flag-on case is specific to the cluster path rather than a server that stopped
      // destroying anything at all.
      expect(await handshakeClosed(await boot(), '/api/v1/nobody-owns-this')).toBe(true);
      process.env.CEZ_CLUSTER = '1';
      expect(await handshakeClosed(await boot(), '/api/v1/nobody-owns-this')).toBe(true);
    });
  });
});
