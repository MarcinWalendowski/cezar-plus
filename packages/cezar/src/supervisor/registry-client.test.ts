import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdentityStore } from '../auth/identity-store.ts';
import { createSupervisorApp } from './server.ts';
import { OrgProcessRegistryStore } from './org-registry-store.ts';
import { RegistryClientError, openRegistryClient } from './registry-client.ts';

/**
 * Unit tests only — `fetchImpl` is always injected, never a live server, per this task's safety
 * rules ("writing an installer, not running one" extends to never binding a port for this pass
 * either). Each test builds a minimal `Response`-shaped fake rather than pulling in a real `fetch`
 * polyfill, since the client only ever reads `.ok`, `.status` and `.json()`.
 *
 * These mocked-fetch tests are exactly what let the client and `supervisor/server.ts` drift apart
 * silently the first time (see `registry-client.ts`'s own module doc comment on the CORRECTED
 * 2026-08-07 wire contract) — each side mocked its OWN idea of the other and both suites stayed
 * green. The `describe('openRegistryClient — against a REAL createSupervisorApp', …)` block below
 * closes that gap the way `ubuntu-vps.test.ts` closes the equivalent one for the generated systemd
 * unit: feed the REAL other side's output back in, never a hand-rolled fake of it. No port is
 * bound — `Hono#request` is an in-process call, the same mechanism `server/loopback-request.testkit.ts`
 * uses everywhere else in this repo.
 */

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const baseOptions = { port: '4000', secret: 'a-very-long-shared-secret-value-1234' };

describe('openRegistryClient — configuration', () => {
  it('throws not-configured when the port is missing', () => {
    expect(() => openRegistryClient({ secret: 's' })).toThrow(RegistryClientError);
    try {
      openRegistryClient({ secret: 's' });
    } catch (err) {
      expect(err).toBeInstanceOf(RegistryClientError);
      expect((err as RegistryClientError).code).toBe('not-configured');
    }
  });

  it('throws not-configured when the secret is missing', () => {
    expect(() => openRegistryClient({ port: '4000' })).toThrow(RegistryClientError);
  });

  it('reads CEZ_SUPERVISOR_PORT / CEZ_SUPERVISOR_SECRET from the environment when not passed explicitly', async () => {
    const savedPort = process.env.CEZ_SUPERVISOR_PORT;
    const savedSecret = process.env.CEZ_SUPERVISOR_SECRET;
    process.env.CEZ_SUPERVISOR_PORT = '4321';
    process.env.CEZ_SUPERVISOR_SECRET = 'env-secret';
    try {
      const fetchImpl = vi.fn(async (url: string) => {
        expect(url).toBe('http://127.0.0.1:4321/internal/teams?orgId=org_a');
        return fakeResponse(200, { teams: [] });
      });
      const client = openRegistryClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
      await client.listTeams('org_a');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      if (savedPort === undefined) delete process.env.CEZ_SUPERVISOR_PORT;
      else process.env.CEZ_SUPERVISOR_PORT = savedPort;
      if (savedSecret === undefined) delete process.env.CEZ_SUPERVISOR_SECRET;
      else process.env.CEZ_SUPERVISOR_SECRET = savedSecret;
    }
  });
});

describe('openRegistryClient — request shape', () => {
  it('sends the bearer secret on every call, and targets the loopback supervisor port', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://127.0.0.1:4000/internal/project-teams/by-root?root=%2Frepo%2Facme');
      expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${baseOptions.secret}`);
      return fakeResponse(200, { projectTeam: null });
    });
    const client = openRegistryClient({ ...baseOptions, fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.getProjectTeam('/repo/acme');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sends root as a query parameter, never split into raw path segments', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(`http://127.0.0.1:4000/internal/project-teams/by-root?root=${encodeURIComponent('/repo/with spaces/acme')}`);
      return fakeResponse(200, { released: true });
    });
    const client = openRegistryClient({ ...baseOptions, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.deleteProjectTeam('/repo/with spaces/acme');
    expect(result).toBe(true);
  });

  it('POSTs createProjectTeam with a JSON body and content-type header', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
      expect(JSON.parse(init.body as string)).toEqual({ projectRoot: '/repo/acme', orgId: 'org_a', teamId: 'team_a' });
      // 201 + `{ projectTeam }`, no `ok` field — the actual `supervisor/server.ts` success shape.
      return fakeResponse(201, { projectTeam: { projectRoot: '/repo/acme', orgId: 'org_a', teamId: 'team_a' } });
    });
    const client = openRegistryClient({ ...baseOptions, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.createProjectTeam({ projectRoot: '/repo/acme', orgId: 'org_a', teamId: 'team_a' });
    expect(result).toEqual({ ok: true, projectTeam: { projectRoot: '/repo/acme', orgId: 'org_a', teamId: 'team_a' } });
  });
});

describe('openRegistryClient — reads', () => {
  it('listProjectTeams sends orgId/teamId as query params and returns the array', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('http://127.0.0.1:4000/internal/project-teams?orgId=org_a&teamId=team_a');
      return fakeResponse(200, { projectTeams: [{ projectRoot: '/r', orgId: 'org_a', teamId: 'team_a' }] });
    });
    const client = openRegistryClient({ ...baseOptions, fetchImpl: fetchImpl as unknown as typeof fetch });
    const rows = await client.listProjectTeams({ orgId: 'org_a', teamId: 'team_a' });
    expect(rows).toEqual([{ projectRoot: '/r', orgId: 'org_a', teamId: 'team_a' }]);
  });

  it('getProjectTeam returns undefined for an unclaimed root, answered as a REAL 404 (not a 200 null body)', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(404, { error: 'no org/team claim on /repo/unclaimed' }));
    const client = openRegistryClient({ ...baseOptions, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await client.getProjectTeam('/repo/unclaimed')).toBeUndefined();
  });

  it('getProjectTeam also tolerates a 200 with a null body, if the wire ever sends one', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, { projectTeam: null }));
    const client = openRegistryClient({ ...baseOptions, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await client.getProjectTeam('/repo/unclaimed')).toBeUndefined();
  });

  it('getTeamById returns undefined, not null, for an unknown team', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, { team: null }));
    const client = openRegistryClient({ ...baseOptions, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await client.getTeamById('team_ghost')).toBeUndefined();
  });
});

describe('openRegistryClient — createProjectTeam error codes', () => {
  // `supervisor/server.ts` does not send a `code` field today (gap 2, module doc comment) — these
  // exercise the discriminated-result PATH for when it does, at the HTTP status the real handler
  // already answers with for each `IdentityStoreError` code (404 for the two "not found" codes,
  // 409 for the two "conflict" codes).
  it('surfaces project-root-taken as a discriminated result, not a thrown error', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(409, { error: 'taken', code: 'project-root-taken' }));
    const client = openRegistryClient({ ...baseOptions, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.createProjectTeam({ projectRoot: '/r', orgId: 'org_a', teamId: 'team_a' });
    expect(result).toEqual({ ok: false, code: 'project-root-taken' });
  });

  it.each([
    ['org-not-found', 404],
    ['team-not-found', 404],
    ['team-org-mismatch', 409],
  ] as const)('surfaces %s the same way', async (code, status) => {
    const fetchImpl = vi.fn(async () => fakeResponse(status, { error: code, code }));
    const client = openRegistryClient({ ...baseOptions, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.createProjectTeam({ projectRoot: '/r', orgId: 'org_a', teamId: 'team_a' });
    expect(result).toEqual({ ok: false, code });
  });

  it('throws unexpected (fail LOUD) rather than guessing a code, against the real wire shape with no `code` field', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(409, { error: 'this project is already registered to a different organization' }));
    const client = openRegistryClient({ ...baseOptions, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.createProjectTeam({ projectRoot: '/r', orgId: 'org_a', teamId: 'team_a' })).rejects.toMatchObject({
      code: 'unexpected',
    });
  });
});

describe('openRegistryClient — failure posture', () => {
  it('throws unreachable on a network error, never silently returning an empty/undefined value', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = openRegistryClient({ ...baseOptions, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.getProjectTeam('/repo/acme')).rejects.toMatchObject({ code: 'unreachable' });
    await expect(client.listProjectTeams({ orgId: 'org_a' })).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('throws unreachable on a timeout (AbortError)', async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    });
    const client = openRegistryClient({ ...baseOptions, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.getProjectTeam('/repo/acme')).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('throws unauthorized on 401, distinct from a network failure', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(401, { error: 'unauthorized' }));
    const client = openRegistryClient({ ...baseOptions, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.getProjectTeam('/repo/acme')).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('throws unauthorized on 403 (org mismatch on an org-scoped read)', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(403, { error: 'forbidden' }));
    const client = openRegistryClient({ ...baseOptions, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.listTeams('org_not_mine')).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('throws unexpected on a malformed 200 body, never coercing it to a default', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, { surprise: true }));
    const client = openRegistryClient({ ...baseOptions, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.getProjectTeam('/repo/acme')).rejects.toMatchObject({ code: 'unexpected' });
  });

  it('throws unexpected on a 500', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(500, { error: 'boom' }));
    const client = openRegistryClient({ ...baseOptions, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.deleteProjectTeam('/repo/acme')).rejects.toMatchObject({ code: 'unexpected' });
    // Negative control for the retry below: a 500 is an answer the supervisor actually gave, not a
    // transport blip, so it is NOT retried. Without this the retry could quietly widen to "any
    // failure" and nothing would notice.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

/**
 * ADDED 2026-08-07 (phase 6/7 repair stage). `server.ts#releaseRootClaim` runs this AFTER
 * `removeProject` has already succeeded, so a transient failure does not fail loudly into a clean
 * state — it orphans a `project_teams` row for a root that no longer exists, which a later
 * re-registration silently inherits. Before phase 6 that write was local, behind D7's `O_EXCL`
 * lease; it is now a loopback fetch, where a supervisor mid-`systemctl reload` is ordinary.
 *
 * Every test here fails if the `try/catch` in `deleteProjectTeam` is deleted, and the last three
 * fail if it is widened past `unreachable` or copied onto another method — which is the point: a
 * retry on `createProjectTeam` would turn a lost response into a permanent, wrong
 * `project-root-taken`.
 */
describe('openRegistryClient — deleteProjectTeam retries ONCE on a transport blip', () => {
  /** Fails the first `attemptsThatFail` calls the way a real connection refusal does, then answers. */
  function flakyFetch(attemptsThatFail: number, body: unknown = { released: true }) {
    let calls = 0;
    return vi.fn(async () => {
      calls += 1;
      if (calls <= attemptsThatFail) throw new Error('ECONNREFUSED');
      return fakeResponse(200, body);
    });
  }

  it('a single unreachable is absorbed — the claim is released, not orphaned', async () => {
    const fetchImpl = flakyFetch(1);
    const client = openRegistryClient({ ...baseOptions, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.deleteProjectTeam('/repo/acme')).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('the retry sends the SAME request — same method, same root — not a fresh guess at the path', async () => {
    const seen: Array<{ url: string; method: string | undefined }> = [];
    let calls = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method });
      calls += 1;
      if (calls === 1) throw new Error('ECONNREFUSED');
      return fakeResponse(200, { released: true });
    });
    const client = openRegistryClient({ ...baseOptions, fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.deleteProjectTeam('/repo/acme app');
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]?.method).toBe('DELETE');
    // The root stays a single encoded query parameter across the retry — a re-encode bug would
    // release a DIFFERENT root than the one the first attempt aimed at.
    expect(seen[0]?.url).toContain(`root=${encodeURIComponent('/repo/acme app')}`);
  });

  it('ONCE, not forever — a supervisor that is really down still fails, and fails as unreachable', async () => {
    const fetchImpl = flakyFetch(99);
    const client = openRegistryClient({ ...baseOptions, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.deleteProjectTeam('/repo/acme')).rejects.toMatchObject({ code: 'unreachable' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry unauthorized — a rejected credential is a decision, not a blip', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(403, { error: 'forbidden' }));
    const client = openRegistryClient({ ...baseOptions, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.deleteProjectTeam('/repo/acme')).rejects.toMatchObject({ code: 'unauthorized' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a malformed body — the call reached the supervisor and got an answer', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, { surprise: true }));
    const client = openRegistryClient({ ...baseOptions, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.deleteProjectTeam('/repo/acme')).rejects.toMatchObject({ code: 'unexpected' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('no OTHER method retries — createProjectTeam must not turn a lost response into project-root-taken', async () => {
    // The non-idempotent one. If the retry is ever copy-pasted onto this method, a write that
    // succeeded but whose response was lost comes back as `project-root-taken` on attempt two, and
    // the org is permanently told a root it just claimed belongs to someone else.
    const created = flakyFetch(1, { projectTeam: { root: '/repo/acme', orgId: 'org_a', teamId: 'team_a' } });
    const clientA = openRegistryClient({ ...baseOptions, fetchImpl: created as unknown as typeof fetch });
    await expect(
      clientA.createProjectTeam({ projectRoot: '/repo/acme', orgId: 'org_a', teamId: 'team_a' }),
    ).rejects.toMatchObject({ code: 'unreachable' });
    expect(created).toHaveBeenCalledTimes(1);

    // And the reads stay single-shot too: `mayActOnRoot` is deliberately fail-CLOSED, so a second
    // attempt only doubles the latency in front of the same 409 the caller is going to get.
    const read = flakyFetch(1, { projectTeam: null });
    const clientB = openRegistryClient({ ...baseOptions, fetchImpl: read as unknown as typeof fetch });
    await expect(clientB.getProjectTeam('/repo/acme')).rejects.toMatchObject({ code: 'unreachable' });
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('openRegistryClient — against a REAL createSupervisorApp (no mocked fetch)', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function directory(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  async function realProjectDir(): Promise<string> {
    const parent = await directory('cezar-registry-client-project-');
    const dir = join(parent, 'repo');
    mkdirSync(dir);
    return realpathSync.native(dir);
  }

  /**
   * Builds a real `createSupervisorApp` (temp `IdentityStore` + `OrgProcessRegistryStore`, both
   * under `os.tmpdir()` — never the developer's real `~/.cezar`, per this task's safety rules) and
   * a `makeOrg` factory whose clients call straight into it via `Hono#request` — no port, no
   * process.
   *
   * **CORRECTED 2026-08-07 (repair stage): one client per ORG, each holding that org's own
   * `supervisorSecret`, because that is the only thing the supervisor now accepts.** These tests
   * used to share a single client against an `/internal/*` surface that checked no credential at
   * all, so a test could create org A and org B and drive both through one connection — an
   * arrangement no real deployment can produce (each org process reads its own
   * `CEZ_SUPERVISOR_SECRET` out of its own root-owned `EnvironmentFile`). Registering the process
   * is also what MAKES the secret a live credential (`internal-auth.ts` reverse-looks-up over
   * active records), so this factory is the in-process twin of what
   * `hetzner.ts#orgRegistrationStep` does on a real host.
   */
  async function buildClientAgainstRealApp() {
    const identityStore = IdentityStore.open(await directory('cezar-registry-client-identity-'));
    const orgProcessRegistry = OrgProcessRegistryStore.open(await directory('cezar-registry-client-orgproc-'));
    const app = createSupervisorApp({
      authRoutes: new Hono(),
      onboardingRoutes: new Hono(),
      sessionResolver: { resolveFromCookieHeader: () => null },
      identityStore,
      orgProcessRegistry,
    });
    const fetchImpl = (async (input: string, init?: RequestInit) => app.request(input, init)) as unknown as typeof fetch;
    let port = 4400;
    const makeOrg = async (slug: string, name: string) => {
      const { org, defaultTeam } = await identityStore.createOrg({ name, slug });
      const secret = `${slug}-`.padEnd(48, 'x');
      await orgProcessRegistry.register({
        orgId: org.id,
        orgSlug: slug,
        unixUser: `cez-${slug}`,
        cezHome: `/home/cez-${slug}/.cezar`,
        loopbackPort: port++,
        hostname: `${slug}.cezar.example.com`,
        platformId: 'hetzner',
        supervisorSecret: secret,
      });
      return { org, defaultTeam, secret, client: openRegistryClient({ port: '4000', secret, fetchImpl }) };
    };
    return { identityStore, orgProcessRegistry, makeOrg, fetchImpl };
  }

  it('createProjectTeam -> getProjectTeam -> listProjectTeams -> deleteProjectTeam round-trips end to end', async () => {
    const { makeOrg } = await buildClientAgainstRealApp();
    const { client, org, defaultTeam } = await makeOrg('acme', 'Acme');
    const root = await realProjectDir();

    const created = await client.createProjectTeam({ projectRoot: root, orgId: org.id, teamId: defaultTeam.id });
    expect(created).toEqual({ ok: true, projectTeam: { projectRoot: root, orgId: org.id, teamId: defaultTeam.id } });

    const fetched = await client.getProjectTeam(root);
    expect(fetched).toEqual({ projectRoot: root, orgId: org.id, teamId: defaultTeam.id });

    const listed = await client.listProjectTeams({ orgId: org.id });
    expect(listed).toEqual([{ projectRoot: root, orgId: org.id, teamId: defaultTeam.id }]);

    const released = await client.deleteProjectTeam(root);
    expect(released).toBe(true);

    // The real D4 assertion this whole unit exists for: once released, the root reads back as
    // genuinely unclaimed through the client — not a thrown error, `undefined`, matching
    // `IdentityStore#getProjectTeam`'s own never-throws-for-absent contract carried over HTTP.
    expect(await client.getProjectTeam(root)).toBeUndefined();
  });

  it('getProjectTeam on a root nobody has ever claimed returns undefined, not a thrown error', async () => {
    const { makeOrg } = await buildClientAgainstRealApp();
    const { client } = await makeOrg('acme', 'Acme');
    const root = await realProjectDir();
    expect(await client.getProjectTeam(root)).toBeUndefined();
  });

  it('createProjectTeam refuses a root already claimed by a DIFFERENT org — D4 held across the real HTTP boundary', async () => {
    const { makeOrg } = await buildClientAgainstRealApp();
    const { client, org: orgA, defaultTeam: teamA } = await makeOrg('acme', 'Acme');
    const { client: clientB, org: orgB, defaultTeam: teamB } = await makeOrg('beta', 'Beta');
    const root = await realProjectDir();

    const first = await client.createProjectTeam({ projectRoot: root, orgId: orgA.id, teamId: teamA.id });
    expect(first.ok).toBe(true);

    // Gap 2 is closed (2026-08-07 integration pass): `supervisor/server.ts` now sends `code`
    // alongside `error`, so this resolves the discriminated result rather than throwing
    // `unexpected`. That distinction is load-bearing rather than cosmetic — `server.ts`'s
    // `registerFolder` answers `project-root-taken` with D4's cross-org 409 wording and rethrows
    // everything else, so while this threw, the ONE refusal D4 exists to produce was a 500.
    const second = await clientB.createProjectTeam({ projectRoot: root, orgId: orgB.id, teamId: teamB.id });
    expect(second).toEqual({ ok: false, code: 'project-root-taken' });

    // …and the claim is still org A's: a refused create must not have partially applied.
    expect(await client.getProjectTeam(root)).toEqual({ projectRoot: root, orgId: orgA.id, teamId: teamA.id });
  });

  it('a symlinked, relative, and trailing-slash spelling of the SAME root all collapse to one claim', async () => {
    const { makeOrg } = await buildClientAgainstRealApp();
    const { client, org, defaultTeam } = await makeOrg('acme', 'Acme');
    const parent = await directory('cezar-registry-client-symlink-');
    const real = join(parent, 'repo');
    mkdirSync(real);
    const canonical = realpathSync.native(real);
    const link = join(parent, 'repo-link');
    symlinkSync(real, link);

    // `createProjectTeam` resolves whatever spelling it is handed to the SAME realpath server-side
    // (`identity-store.ts#createProjectTeam`'s own `realpathSync.native`, reused unmodified over
    // HTTP — see this file's module doc comment) — this client never re-implements that
    // normalization, per this task's own instruction.
    const created = await client.createProjectTeam({ projectRoot: `${real}/`, orgId: org.id, teamId: defaultTeam.id });
    expect(created).toEqual({ ok: true, projectTeam: { projectRoot: canonical, orgId: org.id, teamId: defaultTeam.id } });

    // The already-normalized-caller contract (`getProjectTeam`/`deleteProjectTeam` take an
    // already-realpath'd root, matching `IdentityStore`'s own documented contract) means a caller
    // must normalize before calling these two — asserted here by resolving the symlink ourselves,
    // the same way `server.ts`'s four call sites already do via `normalizeRoot`.
    const viaSymlink = realpathSync.native(link);
    expect(viaSymlink).toBe(canonical);
    expect(await client.getProjectTeam(viaSymlink)).toEqual({ projectRoot: canonical, orgId: org.id, teamId: defaultTeam.id });
  });

  /**
   * Gap 1 is closed (2026-08-07 integration pass) — these two used to assert a 404 against the real
   * app. They now round-trip, which is what makes `server.ts#withTeams` able to annotate the board
   * in supervisor mode (it swallowed the old throw and silently returned every project
   * unannotated, so D5's team filter was dead) and `server.ts#registerFolder` able to validate an
   * explicit `teamId` instead of 500ing on it.
   */
  it('listTeams round-trips the caller org\'s teams against the real app', async () => {
    const { makeOrg } = await buildClientAgainstRealApp();
    const { client, org, defaultTeam } = await makeOrg('acme', 'Acme');

    const teams = await client.listTeams(org.id);
    expect(teams).toEqual([{ id: defaultTeam.id, orgId: org.id, name: defaultTeam.name, slug: defaultTeam.slug }]);
  });

  /**
   * Each org's client sees exactly its own teams — never a merged list, and never the neighbour's.
   *
   * **CORRECTED 2026-08-07 (repair stage).** This used to drive BOTH orgs through one client and
   * assert each id came back with the right teams, which proved only that the supervisor filtered
   * by the `orgId` it was handed. It could not see the question that actually matters across a
   * tenancy boundary: what happens when org A NAMES org B. The answer is now 403 (and a
   * `RegistryClientError`, since no client-facing code path should ever ask), so the filter is not
   * the boundary — the credential is.
   */
  it('each org\'s client sees its own teams, and naming another org is refused outright', async () => {
    const { makeOrg } = await buildClientAgainstRealApp();
    const { client: clientA, org: orgA, defaultTeam: teamA } = await makeOrg('acme', 'Acme');
    const { client: clientB, org: orgB, defaultTeam: teamB } = await makeOrg('beta', 'Beta');

    expect((await clientA.listTeams(orgA.id)).map((t) => t.id)).toEqual([teamA.id]);
    expect((await clientB.listTeams(orgB.id)).map((t) => t.id)).toEqual([teamB.id]);

    await expect(clientA.listTeams(orgB.id)).rejects.toBeInstanceOf(RegistryClientError);
    await expect(clientB.listTeams(orgA.id)).rejects.toBeInstanceOf(RegistryClientError);
  });

  it('getTeamById resolves a real team, and answers undefined (not a throw) for an unknown id', async () => {
    const { makeOrg } = await buildClientAgainstRealApp();
    const { client, org, defaultTeam } = await makeOrg('acme', 'Acme');

    expect(await client.getTeamById(defaultTeam.id)).toEqual({
      id: defaultTeam.id,
      orgId: org.id,
      name: defaultTeam.name,
      slug: defaultTeam.slug,
    });
    // `undefined`, never a throw — `registerFolder` distinguishes "no such team ⇒ 400 unknown
    // team" from "the registry call failed", and only the first is a client error.
    expect(await client.getTeamById('team_does_not_exist')).toBeUndefined();
  });
});
