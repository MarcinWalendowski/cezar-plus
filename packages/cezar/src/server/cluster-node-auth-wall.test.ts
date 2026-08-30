import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { localCliAuthor } from '../runs/task-author.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { CLUSTER_PROTOCOL } from '@loki-labs/cezar-plus-contract';
import { ensureNodeIdentity } from '../cluster/node-identity.ts';
import {
  CODE_AUTHENTICATED_CLUSTER_PATHS,
  NODE_AUTHENTICATED_CLUSTER_BASE_PATHS,
  isCodeAuthenticatedClusterPath,
  isNodeAuthenticatedClusterPath,
} from './cluster-routes.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, type SessionResolver } from './server.ts';

/**
 * D20's other half of the auth perimeter (`.ai/specs/2026-08-22-multi-node-cezar-cluster.md`).
 * `auth-perimeter.test.ts` covers the cockpit wall's OWN behaviour — session in, session out. This
 * file covers the seam between that wall and `cluster-routes.ts`'s `requireNodeAuth`: the wall
 * must let a node-authenticated `/cluster/*` request past itself, and `requireNodeAuth` must be
 * the thing that actually authenticates it once it is let through.
 *
 * **The defect this fixes, measured on the live production hub before this package:** with
 * `CEZ_AUTH` set (every real deployment), `GET /api/v1/cluster` answered 401 — expected, it is a
 * cockpit route — but so did `GET /api/v1/cluster/corpus`, `/cluster/todos/*`,
 * `/cluster/allocate/*` and `/cluster/leases/*`, identically to an ordinary cockpit-only route
 * like `/api/v1/todos`. Those five are node-authenticated by design (D20): a spoke has no cockpit
 * session and cannot get one, so the wall was refusing every request D20 exists to admit, and the
 * D21 HTTP reconcile transport could never complete a single round trip against a real deployment.
 *
 * **Why this is the MANDATORY negative control, not an afterthought.** Proving the wall lets these
 * five families through is only half the claim — a wall with a hole proves nothing about whether
 * anything stands behind the hole. Every `it.each` below sends NO node credentials at all and
 * asserts the response is `requireNodeAuth`'s own named 401 (`reason` ∈ {no-credentials,
 * unknown-node, bad-signature, stale-principal}), not the wall's blanket `{error:
 * 'unauthenticated'}` (which carries no `reason` at all) and not a 200/404/500 from a handler that
 * nothing ever gated. A wall exemption with no live `requireNodeAuth` behind it — the
 * "catastrophic and silent" drift the brief for this package warns about — would make this GET
 * either hang, 500, or answer a real route's own status; it would not answer 401 with one of those
 * four names. `node-auth.test.ts` owns the SIGNATURE mechanism itself; this file owns only proving
 * the two wiring points (the wall's exemption, `cluster-routes.ts`'s `.use()` registrations) still
 * agree, end to end, through the real app.
 *
 * **Why they cannot disagree by construction, not just today.** Both wiring points read
 * `NODE_AUTHENTICATED_CLUSTER_BASE_PATHS` (`cluster-routes.ts`) — the wall's exemption calls
 * `isNodeAuthenticatedClusterPath`, built from that exact array, and `createClusterRoutes`
 * `.use()`s `requireNodeAuth` on every entry of the same array in a loop. Neither hand-lists a
 * path of its own. See that array's own doc comment for the full argument; this file is the proof
 * that argument holds through the real, wired-together app, not just at the type level.
 *
 * **EXTENDED 2026-08-24 — there is a SECOND exempt family, on a different credential.**
 * `POST /cluster/join` is admitted too, and is authenticated by the join code in its body rather
 * than by a node signature: the caller is a machine acquiring its first credential. This file
 * previously asserted the opposite (it pinned `/cluster/join` to the wall's blanket 401 as a
 * containment check), which is why `cez cluster join` could not succeed against any hub with
 * `CEZ_AUTH` set. See `isCodeAuthenticatedClusterPath`'s doc in `cluster-routes.ts`.
 */
describe('the cockpit wall admits D20 node-authenticated cluster paths, and only those', () => {
  let repoRoot: string;
  let home: string;
  let store: RunStore;
  let manager: RunManager;
  const savedAuth = process.env.CEZ_AUTH;
  const savedCluster = process.env.CEZ_CLUSTER;
  const savedHome = process.env.CEZ_HOME;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-node-wall-'));
    home = mkdtempSync(join(tmpdir(), 'cez-node-wall-home-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    process.env.CEZ_AUTH = 'oidc';
    process.env.CEZ_CLUSTER = '1';
    process.env.CEZ_HOME = home;
    manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) =>
        store.createRun({ author: localCliAuthor(), title: 't', workflow: '(planned)', task: input.task, steps: [] }),
    } as unknown as RunManager;
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    if (savedAuth === undefined) delete process.env.CEZ_AUTH;
    else process.env.CEZ_AUTH = savedAuth;
    if (savedCluster === undefined) delete process.env.CEZ_CLUSTER;
    else process.env.CEZ_CLUSTER = savedCluster;
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  /** Never authenticates — matches `auth-perimeter.test.ts`'s own "no session" shape. Every test
   *  in this file is about what happens with NO cockpit session, so the resolver's answer is
   *  fixed rather than parameterised. */
  const noSession: SessionResolver = { resolveFromCookieHeader: () => null };

  const makeApp = () =>
    createApp({
      repoRoot,
      store,
      manager,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
      sessionResolver: noSession,
    });

  function json(body: unknown, method = 'POST'): RequestInit {
    return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  }

  // ---- floor: the exempt set is what D20 names, not silently empty --------------------------
  it('floor: the node-authenticated base-path set is non-empty and names exactly D20\'s four families', () => {
    // A silently empty array would make every assertion below vacuous — `it.each([])` runs zero
    // cases and the whole describe block reads green with nothing actually checked.
    expect(NODE_AUTHENTICATED_CLUSTER_BASE_PATHS.length).toBeGreaterThan(0);
    expect([...NODE_AUTHENTICATED_CLUSTER_BASE_PATHS].sort()).toEqual(
      ['/cluster/allocate', '/cluster/corpus', '/cluster/leases', '/cluster/todos'].sort(),
    );
  });

  // ---- the mandatory negative control: exempted from the wall, but a SECOND lock still holds ---
  describe('every exempted path is covered by requireNodeAuth, not merely let through the wall', () => {
    const NO_CREDENTIALS: Array<[label: string, method: string, path: string, init?: RequestInit]> = [
      ['GET /cluster/corpus', 'GET', '/api/v1/cluster/corpus'],
      ['GET /cluster/corpus/*', 'GET', '/api/v1/cluster/corpus/knowledge/decisions.md'],
      [
        'POST /cluster/corpus/submit',
        'POST',
        '/api/v1/cluster/corpus/submit',
        json({ path: 'knowledge/x.md', body: 'hi' }),
      ],
      ['GET /cluster/todos/:projectKey', 'GET', '/api/v1/cluster/todos/workspace-root'],
      ['POST /cluster/todos/:projectKey/backup', 'POST', '/api/v1/cluster/todos/workspace-root/backup', json({})],
      [
        'POST /cluster/todos/:projectKey/append',
        'POST',
        '/api/v1/cluster/todos/workspace-root/append',
        json({ items: [] }),
      ],
      ['POST /cluster/allocate/:kind', 'POST', '/api/v1/cluster/allocate/port', json({})],
      ['POST /cluster/leases/:kind', 'POST', '/api/v1/cluster/leases/port', json({ id: 'p-1', ttlMs: 60_000 })],
      ['DELETE /cluster/leases/:kind/:id', 'DELETE', '/api/v1/cluster/leases/port/p-1'],
    ];

    beforeEach(async () => {
      // `/cluster/allocate/*` and `/cluster/leases/*` are ALSO hub-gated (`requireHub`, registered
      // before `requireNodeAuth` on those two paths — see `cluster-routes.ts`). Without a hub
      // identity, `requireHub`'s own 409 (NOT_A_HUB / NO_IDENTITY) would fire first, which would
      // make this control meaningless for those two entries: it would prove nothing about
      // `requireNodeAuth` at all. Establishing this node as a hub is what lets every entry below
      // actually exercise node-auth, not just the corpus/todos ones.
      await ensureNodeIdentity({ role: 'hub' }, { env: process.env });
    });

    it.each(NO_CREDENTIALS.map(([label]) => label))(
      "%s: no node credentials => 401 with a NAMED node-auth reason, never the wall's blanket unauthenticated",
      async (label) => {
        const [, method, path, init] = NO_CREDENTIALS.find(([name]) => name === label)!;
        const res = await apiRequest(makeApp(), path, { method, ...init });
        expect(res.status).toBe(401);
        const body = (await res.json()) as { error: string; reason?: string };
        expect(['no-credentials', 'unknown-node', 'bad-signature', 'stale-principal']).toContain(body.reason);
        // The wall's own refusal is `{ error: 'unauthenticated' }` with no `reason` field at all
        // (`auth-perimeter.test.ts`) — this is what actually distinguishes "requireNodeAuth
        // answered" from "the wall answered instead and this array's exemption is a no-op".
        expect(body.error).not.toBe('unauthenticated');
      },
    );
  });

  // ---- the converse: everything else under /cluster stays behind the wall -------------------
  describe("the containment check: cockpit-only /cluster routes still 401 at the WALL", () => {
    const COCKPIT_ONLY: Array<[label: string, method: string, path: string, init?: RequestInit]> = [
      ['GET /cluster (roster)', 'GET', '/api/v1/cluster'],
      ['POST /cluster/enroll', 'POST', '/api/v1/cluster/enroll', json({})],
    ];

    it.each(COCKPIT_ONLY.map(([label]) => label))(
      '%s: still answers the blanket unauthenticated 401 with CEZ_AUTH on and no principal',
      async (label) => {
        const [, method, path, init] = COCKPIT_ONLY.find(([name]) => name === label)!;
        const res = await apiRequest(makeApp(), path, { method, ...init });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'unauthenticated' });
      },
    );
  });

  // ---- the join code IS the credential: admitted past the wall, still refused without one ----
  /**
   * **FOUND 2026-08-24 on the production hub, and this file is why it survived.** `POST
   * /cluster/join` used to sit in `COCKPIT_ONLY` above, asserted to answer the wall's blanket 401.
   * That assertion was true of the mechanism and wrong about the outcome: `join` is called by
   * `cluster/enrollment.ts#joinCluster` on the machine BEING ADDED, which has no cockpit session
   * and no way to acquire one, so with `CEZ_AUTH` set — every real deployment — `cez cluster join
   * <code>` could not succeed against any hub that has ever existed. Nothing here asked that
   * question; the suite pinned the wall's behaviour and stopped.
   *
   * The two assertions below are deliberately a PAIR, and neither is sufficient alone:
   *   1. the wall lets it through (not `{ error: 'unauthenticated' }`), and
   *   2. something still refuses an unknown code (`ok: false`, `reason: 'code-expired'`).
   * Without (2) this test would pass just as well against a route that admitted anyone.
   */
  describe('POST /cluster/join is admitted by the wall and authenticated by the CODE instead', () => {
    // `/cluster/join` is ALSO hub-gated (`requireHub`), which answers 409 before the handler runs
    // on a node with no hub identity — measured: without this the assertion below saw 409, not 200.
    // That 409 is itself proof the wall let the request past, but it would make the `code-expired`
    // half of the pair unreachable, which is the half that proves something still refuses.
    beforeEach(async () => {
      await ensureNodeIdentity({ role: 'hub' }, { env: process.env });
    });

    it('with CEZ_AUTH on and NO session, an unknown code reaches redeemEnrollmentCode', async () => {
      const res = await apiRequest(
        makeApp(),
        '/api/v1/cluster/join',
        json({
          code: 'cezj_not-a-real-code',
          nodeId: '11111111-2222-3333-4444-555555555555',
          nodeName: 'joining-node',
          labels: [],
          protocol: CLUSTER_PROTOCOL,
          version: '0.0.0-test',
        }),
      );
      // The wall would have answered 401 `{ error: 'unauthenticated' }` with no `reason` field.
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; reason?: string; error?: string };
      expect(body.error).toBeUndefined();
      // The second lock: an unrecognised code is refused, and folded into `code-expired` so a
      // redeemer cannot probe which codes were ever minted.
      expect(body.ok).toBe(false);
      expect(body.reason).toBe('code-expired');
    });

    it('floor: the code-authenticated set is non-empty and names /cluster/join and nothing else', () => {
      // Same reason as the D20 floor above: an empty array would make the exemption inert and
      // every assertion about it vacuous — and here it would ALSO silently restore the defect.
      expect(CODE_AUTHENTICATED_CLUSTER_PATHS.length).toBeGreaterThan(0);
      expect([...CODE_AUTHENTICATED_CLUSTER_PATHS]).toEqual(['/cluster/join']);
    });

    it('containment: enroll stays session-only, so this is not a blanket widening', () => {
      // The whole justification for admitting `join` is that it cannot mint anything. If `enroll`
      // ever joined it, code minting would be reachable with no session at all — so this assertion
      // is what keeps the exemption honest, and it is checked at the predicate AND, above in
      // COCKPIT_ONLY, through the real app.
      expect(isCodeAuthenticatedClusterPath('/cluster/enroll')).toBe(false);
      expect(isNodeAuthenticatedClusterPath('/cluster/enroll')).toBe(false);
    });
  });

  describe('isCodeAuthenticatedClusterPath: EXACT match, never a prefix', () => {
    it.each([
      ['/cluster/join', true],
      // No legitimate route nests under it, so a `/`-bounded prefix rule would only widen the hole.
      ['/cluster/join/extra', false],
      ['/cluster/joinx', false],
      ['/cluster/enroll', false],
      ['/cluster', false],
      ['', false],
    ] as const)('%s => %s', (path, expected) => {
      expect(isCodeAuthenticatedClusterPath(path)).toBe(expected);
    });
  });

  // ---- unit-level boundary tests on the shared predicate -------------------------------------
  /**
   * `isNodeAuthenticatedClusterPath` itself, isolated from the full app — sharp, fast proof of the
   * `/`-bounded matching rule the two integration describes above cannot cheaply exercise (there
   * is no real `/cluster/corpusextra` or `/cluster/todosomething` ROUTE to send a request to; the
   * predicate has to be asked directly). Matches the Hono wildcard behaviour verified against the
   * installed `hono@4.12.29` during this package's own investigation (`X` + `X/*` never matches a
   * same-prefix neighbour with no `/` boundary) — see the predicate's own doc comment.
   */
  describe('isNodeAuthenticatedClusterPath: a /-bounded prefix test, never a bare startsWith', () => {
    it.each([
      ['/cluster/corpus', true],
      ['/cluster/corpus/knowledge/decisions.md', true],
      ['/cluster/corpusextra', false],
      ['/cluster/todos', true],
      ['/cluster/todos/workspace-root', true],
      ['/cluster/todosomething', false],
      ['/cluster/allocate', true],
      ['/cluster/allocate/spec-number', true],
      ['/cluster/allocated-somehow', false],
      ['/cluster/leases', true],
      ['/cluster/leases/port', true],
      ['/cluster/leasesx', false],
      ['/cluster', false],
      ['/cluster/enroll', false],
      ['/cluster/join', false],
      ['', false],
    ] as const)('%s => %s', (path, expected) => {
      expect(isNodeAuthenticatedClusterPath(path)).toBe(expected);
    });
  });
});
