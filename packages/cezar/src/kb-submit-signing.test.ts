import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLUSTER_NODE_ID_HEADER,
  CLUSTER_NODE_PRINCIPAL_HEADER,
  CLUSTER_NODE_SIGNATURE_HEADER,
  hashRequestBody,
  verifyNodeHttpPrincipal,
} from './cluster/node-auth.ts';
import { persistNodeCredential } from './cluster/enrollment.ts';
import { nodeIdentityPath } from './cluster/node-identity.ts';

const execFile = promisify(execFileCallback);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(packageRoot, 'src/index.ts');
// Absolute, not the bare specifier `tsx` — see `runs-cli-wiring.test.ts`'s own comment on why: a
// child spawned in a temp cwd with no `node_modules` fails `--import tsx` with ERR_MODULE_NOT_FOUND
// before the entry module ever loads, which looks exactly like the wiring itself being broken.
const tsxLoader = createRequire(import.meta.url).resolve('tsx');

/**
 * `cez kb submit` (`index.ts#runKbSubmitCommand`) signs its POST with
 * `cluster/node-auth.ts#signedNodeRequestHeaders` (D20) instead of the unauthenticated POST it
 * used to send. `runKbSubmitCommand` is deliberately not exported and cannot be imported directly
 * to unit-test — `index.ts` runs `main()` unconditionally at module scope (`main().catch(...)`,
 * no `import.meta.main` guard), so any import of this module executes the real CLI dispatch. This
 * file drives it the only correct way: a SUBPROCESS through the real entry point (the same idiom
 * `runs-cli-wiring.test.ts` / `knowledge/cli-wiring.test.ts` use), against a REAL local HTTP
 * server standing in for the hub, which captures the request as it actually arrived and checks it
 * with the real `verifyNodeHttpPrincipal` — never a re-derivation with the signer that produced the
 * headers, which would only prove the signer agrees with itself.
 *
 * `signedNodeRequestHeaders` itself (body/hash-equals-what-was-sent, the header set, replay
 * negative controls) is covered generically in `cluster/node-auth.test.ts`. What is only true of
 * THIS caller — and so only provable here — is that `runKbSubmitCommand` actually calls it with
 * the node's real identity and the real request, that a node with no stored secret refuses instead
 * of signing with one, and that a 401 `unknown-node` response is translated into a message naming
 * the known hub-side gap rather than a generic "the hub refused — HTTP 401".
 */

const NODE_ID = 'node-1';
const SECRET = 'a-real-per-node-secret';
const UNKNOWN_NODE_MESSAGE = 'this node is not known to the hub — enroll it first (`cez cluster join <code>`)';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface CapturedSubmit {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string | undefined>;
  readonly bodyText: string;
}

/** A real local HTTP server standing in for the hub — `respond` decides the status/body for each
 *  request it captures. Real sockets, real headers, so what the test checks is what the CLI
 *  actually put on the wire, not a mock's idea of it. */
async function startHub(
  respond: (captured: CapturedSubmit) => { status: number; body: unknown },
): Promise<{ server: Server; url: string; captured: CapturedSubmit[] }> {
  const captured: CapturedSubmit[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const record: CapturedSubmit = {
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
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address from the fake hub');
  return { server, url: `http://127.0.0.1:${address.port}`, captured };
}

async function stopHub(server: Server): Promise<void> {
  await new Promise<void>((res) => server.close(() => res()));
}

/** Writes a spoke identity into a fresh `CEZ_HOME`, the way `cez cluster join` would — via that
 *  flow's own writer, not a hand-built JSON fixture. `secret: null` reproduces a node whose
 *  identity file predates D17/D20 (or was hand-edited): `nodeId`/`hubUrl`/`role` present, no
 *  secret on disk. (`null`, not a default-valued `undefined` — a caller that PASSES `undefined`
 *  explicitly must still mean "strip it", which a defaulted parameter would silently overrule.) */
async function spokeHome(hubUrl: string, secret: string | null = SECRET): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'cez-kb-submit-home-'));
  dirs.push(home);
  await persistNodeCredential({ nodeId: NODE_ID, hubUrl, secret: secret ?? '' }, { env: { CEZ_HOME: home } });
  if (secret === null) {
    // `persistNodeCredential` always writes a `secret` (its INPUT type requires a string, even
    // though the stored FIELD is optional) — write the file back without it, matching the
    // corrupted/pre-D17 shape this test means to reproduce.
    const { readFile, writeFile } = await import('node:fs/promises');
    const path = nodeIdentityPath({ CEZ_HOME: home });
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    delete raw.secret;
    await writeFile(path, JSON.stringify(raw), { mode: 0o600 });
  }
  return home;
}

async function runKbSubmit(args: string[], home: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const cwd = await mkdtemp(join(tmpdir(), 'cez-kb-submit-cwd-'));
  dirs.push(cwd);
  try {
    const { stdout, stderr } = await execFile(
      process.execPath,
      ['--import', tsxLoader, entry, 'kb', 'submit', ...args],
      { cwd, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, CEZ_HOME: home, CEZ_CLUSTER: '1' } },
    );
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

describe('cez kb submit signs with node-auth (D20)', () => {
  // One real CLI run, captured once and reused by the negative controls below — they exercise
  // `verifyNodeHttpPrincipal` against variations of this ACTUAL signed header pair, not a fresh
  // subprocess per assertion.
  let hub: { server: Server; url: string; captured: CapturedSubmit[] };
  let sent: CapturedSubmit;
  let cliResult: { stdout: string; stderr: string; code: number };

  beforeAll(async () => {
    hub = await startHub(() => ({ status: 200, body: { ok: true, path: 'knowledge/x.md', corpusVersion: 'v2' } }));
    const home = await spokeHome(hub.url);
    cliResult = await runKbSubmit(['knowledge/x.md', '--content', 'hello from a spoke'], home);
    expect(hub.captured).toHaveLength(1); // floor: the hub actually received a request
    sent = hub.captured[0]!;
  }, 60_000);

  afterAll(async () => stopHub(hub.server));

  it('floor: the request carried a body and was a POST, before anything about its headers is trusted', () => {
    expect(sent.method).toBe('POST');
    expect(sent.bodyText.length).toBeGreaterThan(0);
    expect(JSON.parse(sent.bodyText)).toMatchObject({ path: 'knowledge/x.md', body: 'hello from a spoke' });
  });

  it('the real verifier accepts the captured request, over exactly what was sent', () => {
    const verdict = verifyNodeHttpPrincipal(
      { principal: sent.headers[CLUSTER_NODE_PRINCIPAL_HEADER], signature: sent.headers[CLUSTER_NODE_SIGNATURE_HEADER] },
      sent.headers[CLUSTER_NODE_ID_HEADER],
      SECRET,
      { method: sent.method, path: sent.path, bodyHash: hashRequestBody(sent.bodyText) },
    );
    expect(verdict).toEqual({ ok: true, nodeId: NODE_ID });
    expect(cliResult.code).toBe(0);
  });

  it('sends no Authorization/bearer credential', () => {
    expect(sent.headers.authorization).toBeUndefined();
    expect(Object.values(sent.headers).some((value) => typeof value === 'string' && value.includes('Bearer'))).toBe(false);
  });

  it('negative control: the same signed headers do not verify against a different path', () => {
    const verdict = verifyNodeHttpPrincipal(
      { principal: sent.headers[CLUSTER_NODE_PRINCIPAL_HEADER], signature: sent.headers[CLUSTER_NODE_SIGNATURE_HEADER] },
      sent.headers[CLUSTER_NODE_ID_HEADER],
      SECRET,
      { method: sent.method, path: '/api/v1/cluster/todos/backup', bodyHash: hashRequestBody(sent.bodyText) },
    );
    expect(verdict).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('negative control: the same signed headers do not verify against a different body', () => {
    const verdict = verifyNodeHttpPrincipal(
      { principal: sent.headers[CLUSTER_NODE_PRINCIPAL_HEADER], signature: sent.headers[CLUSTER_NODE_SIGNATURE_HEADER] },
      sent.headers[CLUSTER_NODE_ID_HEADER],
      SECRET,
      { method: sent.method, path: sent.path, bodyHash: hashRequestBody('a body this submit never carried') },
    );
    expect(verdict).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('negative control: the same signed headers do not verify once the freshness window has passed', () => {
    const verdict = verifyNodeHttpPrincipal(
      { principal: sent.headers[CLUSTER_NODE_PRINCIPAL_HEADER], signature: sent.headers[CLUSTER_NODE_SIGNATURE_HEADER] },
      sent.headers[CLUSTER_NODE_ID_HEADER],
      SECRET,
      { method: sent.method, path: sent.path, bodyHash: hashRequestBody(sent.bodyText) },
      { now: () => new Date(Date.now() + 130_000) }, // > LINK_PRINCIPAL_MAX_AGE_MS (120s)
    );
    expect(verdict).toEqual({ ok: false, reason: 'stale-principal' });
  });
});

describe('cez kb submit — refusals that must fail closed rather than sign with nothing', () => {
  it('refuses, with a stated reason, and sends no request when this node has no secret on file', async () => {
    const hub = await startHub(() => ({ status: 200, body: { ok: true, path: 'x', corpusVersion: 'v1' } }));
    try {
      const home = await spokeHome(hub.url, null);
      const result = await runKbSubmit(['knowledge/x.md', '--content', 'hi'], home);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('this node has no cluster secret on file');
      expect(result.stderr).toContain('cez cluster join');
      expect(hub.captured).toHaveLength(0); // never signed with an empty-string secret
    } finally {
      await stopHub(hub.server);
    }
  }, 60_000);
});

describe('cez kb submit — the 401 unknown-node message names the known D20 gap', () => {
  it('does not report a bare "HTTP 401", and does not repeat the misleading "enroll it first" advice', async () => {
    const hub = await startHub(() => ({ status: 401, body: { error: UNKNOWN_NODE_MESSAGE, reason: 'unknown-node' } }));
    try {
      const home = await spokeHome(hub.url);
      const result = await runKbSubmit(['knowledge/x.md', '--content', 'hi'], home);

      expect(result.code).toBe(1);
      expect(result.stderr).not.toContain('HTTP 401');
      expect(result.stderr).not.toContain('enroll it first');
      expect(result.stderr).toContain('401 unknown-node');
      expect(result.stderr).toMatch(/does not yet.*persist per-node secrets/);
      expect(result.stderr).toMatch(/not a problem with this node's enrollment or this write/);
    } finally {
      await stopHub(hub.server);
    }
  }, 60_000);

  it('a different 401 reason (e.g. a bad signature) still shows the middleware\'s own accurate message, unchanged', async () => {
    const hub = await startHub(() => ({
      status: 401,
      body: { error: 'the node signature on this request is invalid', reason: 'bad-signature' },
    }));
    try {
      const home = await spokeHome(hub.url);
      const result = await runKbSubmit(['knowledge/x.md', '--content', 'hi'], home);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('the hub refused — the node signature on this request is invalid');
      expect(result.stderr).not.toContain('known D20 gap');
    } finally {
      await stopHub(hub.server);
    }
  }, 60_000);
});
