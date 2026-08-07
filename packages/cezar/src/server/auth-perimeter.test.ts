import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { registerProject } from '../workspace/projects.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, type Principal, type SessionResolver } from './server.ts';

/**
 * The HTTP half of the auth perimeter (D1/D3/D6, spec
 * `.ai/specs/2026-08-06-org-team-auth-onboarding.md`) — `requirePrincipal`, the `app.use('/api/*')`
 * middleware that turns `CEZ_AUTH` into a 401.
 *
 * **Why this file exists.** Before it, nothing in the repo ever constructed `createApp` with
 * `CEZ_AUTH` set. `auth/session.test.ts` and `auth/routes.test.ts` exercise the resolver and the
 * login routes — modules *beside* the seam — so deleting `if (!principal) return c.json({error:
 * 'unauthenticated'}, 401)` outright left all five gates green. The only security-load-bearing
 * lines added to `server.ts` had zero coverage; this suite and the `verifyWsUpgrade` block in
 * `ws.test.ts` are the two negative controls that fix that, one per transport, because the
 * WebSocket upgrade never passes through Hono and so cannot be covered from here.
 *
 * Everything below drives the REAL middleware through the REAL app. `SessionResolver` is the one
 * stand-in, and deliberately so: it is an injected `ServerDeps` seam whose real implementation
 * (`auth/session.ts`) is already covered against a real `IdentityStore` in its own suite, and
 * faking it is what lets these assert the middleware's own branches — no session, bad session,
 * good session, no resolver at all — without a signed ID token per case.
 */
describe('requirePrincipal — the /api/* auth perimeter', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedRemote = process.env.CEZ_REMOTE;
  const savedAuth = process.env.CEZ_AUTH;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-authperim-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    delete process.env.CEZ_REMOTE;
    delete process.env.CEZ_AUTH;
    process.env.CEZ_DRY_RUN = '1'; // keeps the /api/v1/health probe off the network
    manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) =>
        store.createRun({ title: 't', workflow: '(planned)', task: input.task, steps: [] }),
    } as unknown as RunManager;
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    for (const [key, value] of [
      ['CEZ_REMOTE', savedRemote],
      ['CEZ_AUTH', savedAuth],
      ['CEZ_DRY_RUN', savedDryRun],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const SESSION: Principal = {
    kind: 'session',
    userId: 'u1',
    orgId: 'o1',
    teamId: 't1',
    role: 'member',
  };

  /** Records the cookie header it was handed, so a test can prove the REQUEST's cookie reached the
   *  resolver rather than inferring it from a status code that several branches could produce. */
  function recordingResolver(accept: (cookie: string | undefined) => boolean): SessionResolver & {
    readonly seen: (string | undefined)[];
  } {
    const seen: (string | undefined)[] = [];
    return {
      seen,
      resolveFromCookieHeader: (cookie) => {
        seen.push(cookie);
        return accept(cookie) ? SESSION : null;
      },
    };
  }

  const makeApp = (sessionResolver?: SessionResolver): Hono =>
    createApp({
      repoRoot,
      store,
      manager,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
      sessionResolver,
    });

  /**
   * One representative per shape of protected surface. All three project spellings are here on
   * purpose — the middleware is registered on `/api/*`, and the three-spelling alias set (D5) is
   * exactly the kind of thing a path-keyed gate gets wrong in one spelling only.
   */
  const PROTECTED = [
    ['workspace read', 'GET', '/api/v1/runs'],
    ['bound-project read', 'GET', '/api/v1/config'],
    ['explicit "default" project read', 'GET', '/api/v1/p/default/runs'],
    ['workspace-scoped read', 'GET', '/api/v1/workspace/config'],
    ['filesystem read', 'GET', '/api/v1/fs/browse'],
    ['SSE stream', 'GET', '/api/v1/workspace/events'],
    // The route the spec's Problem §3 is about: a free-form `command` that a check step runs
    // through `spawn('bash', ['-lc', command])`. If exactly one thing in this table must 401,
    // it is this one.
    ['shell-capable write', 'POST', '/api/v1/workflows'],
  ] as const;

  describe('CEZ_AUTH=oidc, no session', () => {
    beforeEach(() => {
      process.env.CEZ_AUTH = 'oidc';
    });

    it.each(PROTECTED)('401s the %s (%s %s)', async (_label, method, path) => {
      const resolver = recordingResolver(() => false);
      const res = await apiRequest(makeApp(resolver), path, {
        method,
        ...(method === 'POST'
          ? { headers: { origin: 'http://127.0.0.1:4321', 'content-type': 'application/json' }, body: '{}' }
          : {}),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthenticated' });
      // The stream in particular must be refused BEFORE it opens: an SSE response that 200s and
      // then carries no events is indistinguishable, from the client, from a quiet server.
      expect(res.headers.get('content-type')).not.toContain('text/event-stream');
    });

    it('checks the cookie the request actually sent, not a value read from elsewhere', async () => {
      const resolver = recordingResolver(() => false);
      await apiRequest(makeApp(resolver), '/api/v1/runs', { headers: { cookie: 'cez_session=deadbeef' } });
      expect(resolver.seen).toEqual(['cez_session=deadbeef']);
    });

    it('refuses a forged cookie the resolver rejects, and admits the one it accepts', async () => {
      const resolver = recordingResolver((cookie) => cookie === 'cez_session=good');
      const app = makeApp(resolver);
      expect((await apiRequest(app, '/api/v1/runs', { headers: { cookie: 'cez_session=forged' } })).status).toBe(401);
      // The positive half is what keeps every 401 above meaningful: without it, "auth on" 401ing
      // everything would be indistinguishable from the middleware being broken.
      expect((await apiRequest(app, '/api/v1/runs', { headers: { cookie: 'cez_session=good' } })).status).toBe(200);
    });

    it('leaves GET /api/v1/health reachable — the CORS-open discovery route (#431)', async () => {
      // Deliberate and narrow (see the middleware's own comment): the bookmarklet port-sweep runs
      // before any cookie for this origin exists, and health carries no per-principal data. The
      // exemption is an exact-path compare, so it does not widen to anything else under /api.
      const res = await apiRequest(makeApp(recordingResolver(() => false)), '/api/v1/health');
      expect(res.status).toBe(200);
      expect((await res.json()) as { version: string }).toHaveProperty('version');
    });

    /**
     * ...but "reachable" is not "the same payload". `projects[].name` is every registered
     * repository's name, and `/api/v1/health` answers `Access-Control-Allow-Origin: *`, so any
     * page on the internet can READ that list, not merely force the request. On a hosted
     * deployment with `CEZ_AUTH` set, repository names are exactly what the login exists to
     * protect — and phase 7's plan is for OIDC to REPLACE the nginx `auth_basic` layer that hides
     * this today. (`repoRoot` was already basename-redacted in hosted mode by #431; this is the
     * same argument applied to the field #431 did not cover.)
     */
    it('redacts the project list for a request with no valid session, and restores it for one with', async () => {
      const home = mkdtempSync(join(tmpdir(), 'cez-authperim-home-'));
      const savedHome = process.env.CEZ_HOME;
      process.env.CEZ_HOME = home;
      try {
        const secret = mkdtempSync(join(realpathSync(tmpdir()), 'cez-acme-secret-client-'));
        await registerProject(secret);
        const app = makeApp(recordingResolver((cookie) => cookie === 'cez_session=good'));

        const anonymous = (await (await apiRequest(app, '/api/v1/health')).json()) as {
          projects: { name: string }[];
          bootProject: string;
        };
        expect(anonymous.projects).toEqual([]);
        expect(JSON.stringify(anonymous)).not.toContain(basename(secret));
        // `bootProject` deliberately stays — the SPA shell's redirect gate reads it before any
        // `/api/v1/*` call can succeed. Asserted so a future reader does not "fix" it by accident.
        expect(anonymous.bootProject).toBeTruthy();

        const signedIn = (await (
          await apiRequest(app, '/api/v1/health', { headers: { cookie: 'cez_session=good' } })
        ).json()) as { projects: { name: string }[] };
        // The positive half: the cockpit's own workspace views read the registry off health
        // (`tasks-overview.tsx`), so redacting it for everyone would break the signed-in product.
        expect(signedIn.projects.map((p) => p.name)).toContain(basename(secret));
        rmSync(secret, { recursive: true, force: true });
      } finally {
        if (savedHome === undefined) delete process.env.CEZ_HOME;
        else process.env.CEZ_HOME = savedHome;
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('is not fooled by a CEZ_AUTH spelling that does not name a provider', async () => {
      // `resolveAuthProvider` maps anything but the two exact spellings to `'none'` — a typo must
      // land on today's zero-config behaviour, never on half-enabled auth.
      process.env.CEZ_AUTH = 'true';
      expect((await apiRequest(makeApp(), '/api/v1/runs')).status).toBe(200);
    });
  });

  it('500s rather than falling back to the local principal when CEZ_AUTH is on but no resolver was wired', async () => {
    // `sessionResolver` is threaded in by `serveCommand` only on the branch that loaded
    // `auth/session.ts`. Missing it means auth was flipped on outside that boot path — and the
    // tempting "no resolver, so treat auth as off" is precisely the forgot-a-variable-exposed-a-
    // shell shape D1's boot refusal exists to rule out. Fail closed, loudly.
    process.env.CEZ_AUTH = 'oidc';
    const res = await apiRequest(makeApp(undefined), '/api/v1/runs');
    expect(res.status).toBe(500);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'server misconfigured: CEZ_AUTH is set but no session resolver was wired',
    });
  });

  describe('CEZ_AUTH unset — the npm zero-config default', () => {
    it.each(PROTECTED)('leaves the %s reachable (%s %s)', async (_label, method, path) => {
      const res = await apiRequest(makeApp(), path, {
        method,
        ...(method === 'POST'
          ? { headers: { origin: 'http://127.0.0.1:4321', 'content-type': 'application/json' }, body: '{}' }
          : {}),
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(500);
    });

    it('never consults a resolver even when one happens to be wired (D1: unset means zero I/O)', async () => {
      const resolver = recordingResolver(() => true);
      expect((await apiRequest(makeApp(resolver), '/api/v1/runs')).status).toBe(200);
      expect(resolver.seen).toEqual([]);
    });

    /**
     * The control for the health redaction two describes up. The spec's Risks section is explicit
     * that "a diff in the auth-off health payload is a failure, not an update" — so the redaction
     * must be gated on `CEZ_AUTH` naming a provider and on nothing else. Verified by mutation:
     * deleting the `resolveAuthProvider(...) === 'none'` early return turns this test red (and
     * only this one, across the suites that touch health), which is what makes the gate falsifiable
     * rather than merely present.
     */
    it('still names every registered project on GET /api/v1/health, and resolves no session to decide it', async () => {
      const home = mkdtempSync(join(tmpdir(), 'cez-authperim-home-off-'));
      const savedHome = process.env.CEZ_HOME;
      process.env.CEZ_HOME = home;
      try {
        const project = mkdtempSync(join(realpathSync(tmpdir()), 'cez-authoff-visible-'));
        await registerProject(project);
        const resolver = recordingResolver(() => true);

        const body = (await (await apiRequest(makeApp(resolver), '/api/v1/health')).json()) as {
          projects: { name: string }[];
        };
        expect(body.projects.map((p) => p.name)).toContain(basename(project));
        expect(resolver.seen).toEqual([]);
        rmSync(project, { recursive: true, force: true });
      } finally {
        if (savedHome === undefined) delete process.env.CEZ_HOME;
        else process.env.CEZ_HOME = savedHome;
        rmSync(home, { recursive: true, force: true });
      }
    });
  });
});
