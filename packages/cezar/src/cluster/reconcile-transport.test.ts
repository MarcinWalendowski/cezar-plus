import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLUSTER_NODE_ID_HEADER,
  CLUSTER_NODE_PRINCIPAL_HEADER,
  CLUSTER_NODE_SIGNATURE_HEADER,
  hashRequestBody,
  verifyNodeHttpPrincipal,
} from './node-auth.ts';
import { ensureNodeIdentity } from './node-identity.ts';
import { storeNodeSecret } from './node-secrets.ts';
import { applyPairingAction } from './peers.ts';
import { createHttpReconcileTransport } from './reconcile-transport.ts';
import { createClusterRoutes } from '../server/cluster-routes.ts';
import { workspaceConfigPath } from '../paths.ts';
import type { TodoItem } from '../todos.ts';
import { atomicWriteJsonSync, defaultWorkspaceConfig } from '../workspace/config.ts';

/**
 * D21 (`.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, "UNBLOCKED by D22", "AMENDED —
 * `/append` takes its own backup inside its own lease"): the HTTP `RemoteReconcileTransport`,
 * `createHttpReconcileTransport`, run from a spoke against its hub.
 *
 * Two levels, same split `kb-submit-signing.test.ts` uses for the sibling D20 caller:
 *  - "signs every request" — a real local `node:http` server standing in for the hub, captured
 *    request checked with the REAL `verifyNodeHttpPrincipal` (never a re-derivation with the same
 *    signer that produced the headers, which would only prove the signer agrees with itself).
 *  - "end to end against the real hub routes" — `createClusterRoutes` served for real via
 *    `@hono/node-server` (the same `serve()` production uses, `server.ts`), so `list`/`backup`/
 *    `apply` are proven against the actual D21 route bodies, not a fake.
 */

const NODE_ID = 'spoke-1';
const SECRET = 'a-real-per-node-secret';

interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string | undefined>;
  readonly bodyText: string;
}

/** Same idiom as `kb-submit-signing.test.ts#startHub` — real sockets, real headers, so what a
 *  test checks is what the transport actually put on the wire. */
async function startFakeHub(
  respond: (captured: CapturedRequest) => { status: number; body: unknown },
): Promise<{ server: Server; url: string; captured: CapturedRequest[] }> {
  const captured: CapturedRequest[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const record: CapturedRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value]),
        ),
        bodyText: Buffer.concat(chunks).toString('utf8'),
      };
      captured.push(record);
      const { status, body } = respond(record);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address from the fake hub');
  return { server, url: `http://127.0.0.1:${address.port}`, captured };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('createHttpReconcileTransport — signs every request (D20), against a real local hub', () => {
  let hub: { server: Server; url: string; captured: CapturedRequest[] };

  afterEach(async () => {
    await stopServer(hub.server);
  });

  it('floor: list() sends a signed GET, and the REAL verifier accepts it — not a re-derivation with the same signer', async () => {
    const record: TodoItem = { id: 'row-1', summary: 'a real row', priority: 'high' };
    hub = await startFakeHub(() => ({ status: 200, body: { projectKey: 'proj-a', todos: [record] } }));
    const transport = createHttpReconcileTransport({ nodeId: NODE_ID, secret: SECRET, hubUrl: hub.url });

    const rows = await transport.list('proj-a');

    expect(hub.captured).toHaveLength(1);
    const sent = hub.captured[0]!;
    expect(sent.method).toBe('GET');
    expect(sent.path).toBe('/api/v1/cluster/todos/proj-a');
    expect(sent.bodyText).toBe('');

    const verdict = verifyNodeHttpPrincipal(
      { principal: sent.headers[CLUSTER_NODE_PRINCIPAL_HEADER], signature: sent.headers[CLUSTER_NODE_SIGNATURE_HEADER] },
      sent.headers[CLUSTER_NODE_ID_HEADER],
      SECRET,
      { method: sent.method, path: sent.path, bodyHash: hashRequestBody(sent.bodyText) },
    );
    expect(verdict).toEqual({ ok: true, nodeId: NODE_ID });

    // The floor: actual field VALUES came back, not merely a 200 / a count.
    expect(rows).toEqual([record]);
  });

  it('backup() sends a signed POST with an empty body and returns the path the hub reported', async () => {
    hub = await startFakeHub(() => ({ status: 200, body: { path: '/hub/proj-a/.ai/cezar/todos.json.bak' } }));
    const transport = createHttpReconcileTransport({ nodeId: NODE_ID, secret: SECRET, hubUrl: hub.url });

    const path = await transport.backup('proj-a');

    expect(path).toBe('/hub/proj-a/.ai/cezar/todos.json.bak');
    const sent = hub.captured[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.path).toBe('/api/v1/cluster/todos/proj-a/backup');
    expect(sent.bodyText).toBe('');
    const verdict = verifyNodeHttpPrincipal(
      { principal: sent.headers[CLUSTER_NODE_PRINCIPAL_HEADER], signature: sent.headers[CLUSTER_NODE_SIGNATURE_HEADER] },
      sent.headers[CLUSTER_NODE_ID_HEADER],
      SECRET,
      { method: sent.method, path: sent.path, bodyHash: hashRequestBody(sent.bodyText) },
    );
    expect(verdict).toEqual({ ok: true, nodeId: NODE_ID });
  });

  it('apply() sends the rows verbatim as a signed POST, bound to the exact JSON body sent', async () => {
    const adds: TodoItem[] = [{ id: 'peer-1', summary: 'copied from a peer' }];
    hub = await startFakeHub(() => ({ status: 200, body: { appended: adds, backupPath: '/hub/proj-a/.ai/cezar/todos.json.bak' } }));
    const transport = createHttpReconcileTransport({ nodeId: NODE_ID, secret: SECRET, hubUrl: hub.url });

    await transport.apply('proj-a', adds);

    const sent = hub.captured[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.path).toBe('/api/v1/cluster/todos/proj-a/append');
    expect(JSON.parse(sent.bodyText)).toEqual({ todos: adds });
    const verdict = verifyNodeHttpPrincipal(
      { principal: sent.headers[CLUSTER_NODE_PRINCIPAL_HEADER], signature: sent.headers[CLUSTER_NODE_SIGNATURE_HEADER] },
      sent.headers[CLUSTER_NODE_ID_HEADER],
      SECRET,
      { method: sent.method, path: sent.path, bodyHash: hashRequestBody(sent.bodyText) },
    );
    expect(verdict).toEqual({ ok: true, nodeId: NODE_ID });
  });

  it('apply() with no adds sends nothing at all — the hub never sees a request', async () => {
    hub = await startFakeHub(() => ({ status: 200, body: { appended: [], backupPath: 'unused' } }));
    const transport = createHttpReconcileTransport({ nodeId: NODE_ID, secret: SECRET, hubUrl: hub.url });

    await transport.apply('proj-a', []);

    expect(hub.captured).toHaveLength(0);
  });

  it('negative control: a captured signed request does NOT verify against a different path (tamper)', async () => {
    hub = await startFakeHub(() => ({ status: 200, body: { path: 'unused' } }));
    const transport = createHttpReconcileTransport({ nodeId: NODE_ID, secret: SECRET, hubUrl: hub.url });
    await transport.backup('proj-a');
    const sent = hub.captured[0]!;

    const verdict = verifyNodeHttpPrincipal(
      { principal: sent.headers[CLUSTER_NODE_PRINCIPAL_HEADER], signature: sent.headers[CLUSTER_NODE_SIGNATURE_HEADER] },
      sent.headers[CLUSTER_NODE_ID_HEADER],
      SECRET,
      { method: sent.method, path: '/api/v1/cluster/todos/DIFFERENT-PROJECT/backup', bodyHash: hashRequestBody(sent.bodyText) },
    );
    expect(verdict).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('a non-2xx response throws with the hub-stated reason, not a bare "HTTP 401"', async () => {
    hub = await startFakeHub(() => ({ status: 401, body: { error: 'the node signature on this request is invalid', reason: 'bad-signature' } }));
    const transport = createHttpReconcileTransport({ nodeId: NODE_ID, secret: SECRET, hubUrl: hub.url });

    await expect(transport.list('proj-a')).rejects.toThrow(/bad-signature/);
  });
});

describe('createHttpReconcileTransport — end to end against the REAL hub routes (D21)', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let projectRoot: string;
  let server: ServerType;
  let hubUrl: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-reconcile-transport-home-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'cez-reconcile-transport-project-'));
    env = { CEZ_CLUSTER: '1', CEZ_HOME: home };

    const identity = await ensureNodeIdentity({ role: 'hub' }, { env });
    const config = {
      ...defaultWorkspaceConfig(),
      projects: [{ id: 'proj-a', root: projectRoot, name: '', addedAt: '', lastOpenedAt: '', source: 'local' as const }],
    };
    atomicWriteJsonSync(workspaceConfigPath(env), config);
    await applyPairingAction('project-a', { action: 'confirm', nodeId: identity.nodeId, projectId: 'proj-a' }, { env });
    await applyPairingAction('project-a', { action: 'confirm', nodeId: NODE_ID, projectId: 'proj-a-spoke-side' }, { env });
    await storeNodeSecret(NODE_ID, SECRET, { env });

    // `server.ts` mounts `createClusterRoutes` into `workspaceV1`, then `workspaceV1` under
    // `/api/v1` (`V1_PREFIX`) — replicated here with a bare `Hono` wrapper rather than the whole
    // of `createApp`, so this test exercises the real route bodies without dragging in every
    // other domain `server.ts` wires up.
    const clusterRoutes = createClusterRoutes({ version: '0.0.0-test', env });
    const app = new Hono().route('/api/v1', clusterRoutes);
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected a TCP address from the real hub');
    hubUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('list() returns the real row values from the real hub-side todos.json', async () => {
    const dataDir = join(projectRoot, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    const seedRow = { id: 'row-1', summary: 'seeded on the hub', priority: 'high' };
    writeFileSync(join(dataDir, 'todos.json'), JSON.stringify([seedRow], null, 2), 'utf8');

    const transport = createHttpReconcileTransport({ nodeId: NODE_ID, secret: SECRET, hubUrl });
    const rows = await transport.list('project-a');
    expect(rows).toEqual([seedRow]);
  });

  it('backup() then apply() round-trips through the real routes: appended rows land on the hub disk, idempotently', async () => {
    const dataDir = join(projectRoot, '.ai/cezar');
    const transport = createHttpReconcileTransport({ nodeId: NODE_ID, secret: SECRET, hubUrl });

    const backupPath = await transport.backup('project-a');
    expect(backupPath).toBe(join(dataDir, 'todos.json.bak'));
    expect(JSON.parse(readFileSync(backupPath, 'utf8'))).toEqual([]); // nothing on the hub yet

    const incoming: TodoItem = { id: 'peer-1', summary: 'copied from a peer', priority: 'high' };
    await transport.apply('project-a', [incoming]);
    expect(await transport.list('project-a')).toEqual([incoming]);

    // Idempotent by id: applying the same row again changes nothing.
    await transport.apply('project-a', [{ ...incoming, summary: 'a different summary that must NOT land' }]);
    const after = await transport.list('project-a');
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(incoming); // the ORIGINAL values
  });

  it('list() round-trips a row carrying a field this build has never heard of, value intact — the CLIENT-side parse must not reject it (D13)', async () => {
    const dataDir = join(projectRoot, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    // `futureField` names nothing `clusterTodoRecordSchema` declares — a newer node's row, exactly
    // what D13 exists to survive. `storedClusterTodosSnapshotResponseSchema.parse()` is the one
    // real gate on this path: `TodoItem`'s own TYPE has no room for the field, so the assertion
    // below reads it back off the actual runtime object, not off the type.
    const seedRow = { id: 'row-1', summary: 'seeded on the hub', futureField: 'from-a-newer-node' };
    writeFileSync(join(dataDir, 'todos.json'), JSON.stringify([seedRow], null, 2), 'utf8');

    const transport = createHttpReconcileTransport({ nodeId: NODE_ID, secret: SECRET, hubUrl });
    const rows = await transport.list('project-a');
    expect((rows[0] as unknown as Record<string, unknown>).futureField).toBe('from-a-newer-node');
  });

  it('apply() round-trips a row carrying an unknown field without throwing on the response, and it lands on hub disk (D13)', async () => {
    const dataDir = join(projectRoot, '.ai/cezar');
    const transport = createHttpReconcileTransport({ nodeId: NODE_ID, secret: SECRET, hubUrl });

    // Built as a bare object, then cast — same as a spoke a version ahead of this build would
    // actually send, whose local `TodoItem` type carries a field this one does not.
    const incoming = { id: 'peer-1', summary: 'sent by a newer spoke', futureField: 'from-a-newer-node' } as unknown as TodoItem;

    // The hub echoes the appended row back in its response; if the CLIENT-side response schema
    // were `.strict()`, this would throw here even though the hub had already written the row
    // successfully — apply() not throwing is itself part of what this test proves.
    await expect(transport.apply('project-a', [incoming])).resolves.toBeUndefined();

    const onDisk = JSON.parse(readFileSync(join(dataDir, 'todos.json'), 'utf8')) as Array<Record<string, unknown>>;
    expect(onDisk[0]?.futureField).toBe('from-a-newer-node');
  });

  it('listProjects() reads this node\'s OWN local pairing store — no request reaches the hub at all', async () => {
    const spokeHome = mkdtempSync(join(tmpdir(), 'cez-reconcile-transport-spoke-'));
    try {
      const spokeEnv = { CEZ_CLUSTER: '1', CEZ_CLUSTER_HUB: hubUrl, CEZ_HOME: spokeHome };
      // The spoke's own local pairing row, confirmed on the spoke's own side — the hub never sees
      // this call, and a hub unreachable at all must not matter to it.
      await applyPairingAction('project-a', { action: 'confirm', nodeId: NODE_ID, projectId: 'proj-a-spoke-side' }, { env: spokeEnv });

      // Point at a hub that refuses every TCP connection — a real request would throw ECONNREFUSED.
      const transport = createHttpReconcileTransport({ nodeId: NODE_ID, secret: SECRET, hubUrl: 'http://127.0.0.1:1', env: spokeEnv });
      const projects = await transport.listProjects();
      expect(projects).toEqual(['project-a']);
    } finally {
      rmSync(spokeHome, { recursive: true, force: true });
    }
  });

  it('scoping: an unpaired project is refused end to end, surfaced as a real thrown error naming the reason', async () => {
    const transport = createHttpReconcileTransport({ nodeId: NODE_ID, secret: SECRET, hubUrl });
    await expect(transport.list('project-never-paired')).rejects.toThrow(/unpaired-project/);
  });
});
