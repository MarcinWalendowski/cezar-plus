import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  CLUSTER_PROTOCOL,
  CLUSTER_PROTOCOL_MAJOR,
  clusterEnrollCommandsSchema,
  clusterEnrollResponseSchema,
  clusterJoinResponseSchema,
  storedClusterEnrollCodeSchema,
  storedClusterNodeIdentitySchema,
  type ClusterEnrollCommands,
  type ClusterEnrollRequest,
  type ClusterEnrollResponse,
  type ClusterJoinRequest,
  type ClusterJoinResponse,
  type ClusterNodeId,
  type ClusterProtocol,
  type StoredClusterEnrollCode,
  type StoredClusterNodeIdentity,
} from '@loki-labs/better-cezar-contract';
import { clusterHomeDir, ensureNodeIdentity, loadNodeIdentity, nodeIdentityPath } from './node-identity.ts';
import type { ClusterHomeOptions } from './node-identity.ts';
import { storeNodeSecret } from './node-secrets.ts';
// `peers.ts` imports `withEnrollCodesLease` FROM this file — this is a deliberate circular import
// between two files this package owns, and it is safe because every use on both sides is inside an
// async function BODY, never at module-evaluation time, and both `readPeers`/`upsertNode` here and
// `withEnrollCodesLease` there are hoisted `function` declarations, not `const` arrow bindings.
import { readPeers, upsertNode } from './peers.ts';
import { assertCezarHomeWriteIsSandboxed } from '../paths.ts';

/**
 * Enrollment: minting a single-use join code, redeeming it, revoking it, and the per-node HMAC
 * secret every link frame is signed with (spec
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D17 + "Security and blast radius").
 *
 * **What is being granted here is large, and the design reflects that.** Enrolling a node means the
 * hub can start bypass-permissions agent processes on that machine with that machine's credentials
 * — on the Mac, the keychain, the ssh agent, the git identity, iMessage and the browser profile.
 * That is the same magnitude of grant as adding a person to production cezar, and it gets the same
 * care: outbound-only redemption (nothing ever listens on the spoke), a code stored as a SHA-256
 * digest and never raw, `acceptsDispatch` off by default, and revocation on BOTH sides — a hub-side
 * revoke alone does not stop a spoke from continuing to push ops.
 *
 * **Two independent gates, and the answer must always say which one refused** (D17): the Cloudflare
 * Access credential, supplied from the operator's environment and never in the pasteable string, and
 * the join code itself. `access-rejected` and `code-expired` are different problems with different
 * fixes, and an operator who cannot tell them apart re-mints codes to fix a credential problem.
 *
 * **CORRECTED 2026-08-23 (D22).** `redeemEnrollmentCode` used to mint the per-node secret, hand it
 * to the joining spoke, and persist it NOWHERE — D17's own "INCOMPLETE" note, found while
 * implementing D20, diagnosed this: the hub could not verify any node, by any transport, because the
 * receiving end of this handshake was never built. It now writes the secret to `node-secrets.ts`'s
 * store, inside this file's own `enroll-codes` lease and BEFORE the code is marked redeemed — see
 * `withEnrollCodesLease` and the call site in `redeemEnrollmentCode` for the ordering and why it is
 * chosen deliberately, not incidentally.
 *
 * **CORRECTED 2026-08-23, same day.** D22 fixed the secret; it did not fix the roster row.
 * `redeemEnrollmentCode` stored a working secret for a node that `peers.ts` had never heard of —
 * invisible to the roster, unstampable by `markNodeSeen`, and, the half that actually mattered,
 * un-revokable: `disableNode` only removed a node's secret for a roster row it found, so this gap
 * made revoke itself unreliable. Fixed by writing the roster row too, inside the same lease, FIRST
 * of the now-three writes — see the call site in `redeemEnrollmentCode` for the crash-point
 * analysis and the invariant it protects, and `peers.ts#disableNode`'s own correction for the other
 * half: secret removal there is no longer gated on the roster row having been found either.
 *
 * The code digest idiom is `auth/org-claim-token.ts`'s, verbatim rather than re-derived. The frame
 * signature idiom is `supervisor/forwarded-principal.ts`'s, also verbatim: sign-then-verify (the
 * CLAIM must be unforgeable; the content is not secret), signature checked with `timingSafeEqual`
 * BEFORE the payload is parsed, and a bounded `issuedAt` window rather than a nonce scheme.
 */

/** Short by design. A code is pasted within a minute of being minted or it is re-minted. */
export const ENROLLMENT_CODE_TTL_MS = 15 * 60 * 1000;

/** The freshness window on a signed frame principal — `forwarded-principal.ts`'s 60s, widened for a
 *  WAN link with real latency and modest clock skew, still short enough that a captured frame is
 *  useless quickly. */
export const LINK_PRINCIPAL_MAX_AGE_MS = 120_000;

/** 128 bits, hex — `auth/org-claim-token.ts#CLAIM_TOKEN_BYTES`'s own size, for the same reason:
 *  unguessable, and this is single-use and short-TTL, so it does not need to be larger than that. */
const ENROLLMENT_SECRET_BYTES = 16;

/** 256 bits — larger than the join code on purpose. This secret is durable: it signs every link
 *  frame for the life of the node, where the join code that bought it is spent in one request. */
const NODE_SECRET_BYTES = 32;

const ENROLL_CODE_PREFIX = 'cezj_';

function encodeEnrollmentToken(hubUrl: string, secret: string): string {
  return `${ENROLL_CODE_PREFIX}${Buffer.from(JSON.stringify({ hubUrl, secret }), 'utf8').toString('base64url')}`;
}

/** `cezj_…` — hub URL and code packed into one opaque token, so the operator pastes one thing. */
export function mintEnrollmentCode(hubUrl: string): string {
  // Caller-supplied (the hub's own configured public URL), not operator input — a malformed value
  // here is a configuration bug, not a redemption-time failure, so it throws rather than degrading.
  new URL(hubUrl);
  const secret = randomBytes(ENROLLMENT_SECRET_BYTES).toString('hex');
  return encodeEnrollmentToken(hubUrl, secret);
}

/** SHA-256 hex. The raw code is never stored, never logged, and cannot be shown again after mint. */
export function hashEnrollmentCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** Constant-time. `false` for every failure mode — absent, malformed, wrong — never a throw. */
export function matchesEnrollmentCode(storedHash: string, supplied: string | undefined): boolean {
  if (supplied === undefined) return false;
  const a = Buffer.from(hashEnrollmentCode(supplied), 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  if (a.length !== b.length) return false; // defensive only: both are always 64 hex chars
  return timingSafeEqual(a, b);
}

/** Splits a `cezj_` token back into its parts. `undefined` on anything malformed — a token this
 *  cezar did not mint is not honoured as an instruction it cannot execute. */
export function parseEnrollmentCode(code: string): { hubUrl: string; secret: string } | undefined {
  if (!code.startsWith(ENROLL_CODE_PREFIX)) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(code.slice(ENROLL_CODE_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (
    !decoded ||
    typeof decoded !== 'object' ||
    typeof (decoded as { hubUrl?: unknown }).hubUrl !== 'string' ||
    typeof (decoded as { secret?: unknown }).secret !== 'string'
  ) {
    return undefined;
  }
  const { hubUrl, secret } = decoded as { hubUrl: string; secret: string };
  if (!secret) return undefined;
  try {
    new URL(hubUrl); // must be an absolute URL — a relative or empty string is not dial-able
  } catch {
    return undefined;
  }
  return { hubUrl, secret };
}

const ENROLL_CODES_FILE = 'enroll-codes.json';
const ENROLL_CODES_LOCK_FILE = 'enroll-codes.lock';
const MAX_RETRY_DELAY_MS = 200;

export function enrollmentCodesPath(env?: NodeJS.ProcessEnv): string {
  return join(clusterHomeDir(env), ENROLL_CODES_FILE);
}

// ---- the enroll-codes store: `~/.cezar/cluster/enroll-codes.json`, hub-only -------------------

/** `.passthrough()` with per-entry salvage: one unreadable code must not evict the rest, and a
 *  corrupt file degrades to empty with one warning rather than failing the boot — the same
 *  discipline `node-identity.ts` and every sibling cluster store applies. */
function readEnrollCodes(options?: ClusterHomeOptions): StoredClusterEnrollCode[] {
  const path = enrollmentCodesPath(options?.env);
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    options?.warn?.('Cluster enrollment codes file is corrupt; treating as empty.');
    return [];
  }
  const list = Array.isArray((raw as { codes?: unknown })?.codes) ? (raw as { codes: unknown[] }).codes : [];
  const codes: StoredClusterEnrollCode[] = [];
  for (const entry of list) {
    const parsed = storedClusterEnrollCodeSchema.safeParse(entry);
    if (parsed.success) codes.push(parsed.data);
    else options?.warn?.('Skipped a malformed row in enroll-codes.json.');
  }
  return codes;
}

function writeEnrollCodes(codes: StoredClusterEnrollCode[], options?: ClusterHomeOptions): void {
  const dir = clusterHomeDir(options?.env);
  const path = enrollmentCodesPath(options?.env);
  assertCezarHomeWriteIsSandboxed(path);
  mkdirSync(dir, { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ codes }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class EnrollCodesLease {
  private released = false;
  constructor(
    private readonly path: string,
    private readonly fd: number,
  ) {}
  release(): void {
    if (this.released) return;
    this.released = true;
    closeSync(this.fd);
    try {
      unlinkSync(this.path);
    } catch {
      // Already removed during shutdown cleanup.
    }
  }
}

/** One non-blocking attempt: open `wx` (fails if the lock already exists), reclaim it if stale (a
 *  crashed writer), else give up — `todos.ts#acquireTodosLease`'s own idiom, applied to this file. */
function acquireEnrollCodesLease(env: NodeJS.ProcessEnv | undefined, staleAfterMs = 10 * 60_000): EnrollCodesLease | undefined {
  const dir = clusterHomeDir(env);
  const path = join(dir, ENROLL_CODES_LOCK_FILE);
  assertCezarHomeWriteIsSandboxed(path);
  mkdirSync(dir, { recursive: true });
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return new EnrollCodesLease(path, fd);
  } catch {
    try {
      if (Date.now() - statSync(path).mtimeMs > staleAfterMs) {
        unlinkSync(path);
        return acquireEnrollCodesLease(env, staleAfterMs);
      }
    } catch {
      // A contender released it first, or the directory is read-only.
    }
    return undefined;
  }
}

async function acquireEnrollCodesLeaseBlocking(env: NodeJS.ProcessEnv | undefined, lockTimeoutMs = 5_000): Promise<EnrollCodesLease> {
  const deadline = Date.now() + lockTimeoutMs;
  let delay = 10;
  for (;;) {
    const lease = acquireEnrollCodesLease(env);
    if (lease) return lease;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`enroll-codes.json write lease stayed held for over ${lockTimeoutMs}ms — another writer may be stuck`);
    }
    await sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
  }
}

/** Takes the lease, runs `fn`, always releases. Every mutation of `enroll-codes.json` goes through
 *  this — in particular `redeemEnrollmentCode`'s check-then-mark, so two spokes racing one code are
 *  serialized into one success and one `code-used` rather than two successes.
 *
 *  Exported (added D22) because it is no longer only this file's own lock: `node-secrets.ts`'s
 *  module docblock says every writer of `node-secrets.json` must serialize through THIS lease
 *  rather than inventing its own — `redeemEnrollmentCode` below is one such writer,
 *  `peers.ts#disableNode` is the other, and both must share the one lock. */
export async function withEnrollCodesLease<T>(options: ClusterHomeOptions | undefined, fn: () => T | Promise<T>): Promise<T> {
  const lease = await acquireEnrollCodesLeaseBlocking(options?.env);
  try {
    return await fn();
  } finally {
    lease.release();
  }
}

function readOwnVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ---- hub side -----------------------------------------------------------------------------------

export interface MintEnrollmentInput extends ClusterEnrollRequest {
  hubUrl: string;
  /** The hub's OWN version, pinned into the rendered `npx` spec rather than `@latest` (D13) — a new
   *  node should start life matched to the hub that minted it. */
  hubVersion: string;
}

/** Returns the raw code exactly once, alongside the record that stores only its digest. */
export async function createEnrollmentCode(
  input: MintEnrollmentInput,
  options?: ClusterHomeOptions,
): Promise<{ response: ClusterEnrollResponse; record: StoredClusterEnrollCode }> {
  return withEnrollCodesLease(options, () => {
    const now = (options?.now ?? (() => new Date()))();
    const ttlMs = input.ttlSeconds ? input.ttlSeconds * 1000 : ENROLLMENT_CODE_TTL_MS;
    const code = mintEnrollmentCode(input.hubUrl);
    const record = storedClusterEnrollCodeSchema.parse({
      codeId: randomUUID(),
      codeHash: hashEnrollmentCode(code),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      nodeName: input.nodeName,
    } satisfies StoredClusterEnrollCode);
    const codes = readEnrollCodes(options);
    codes.push(record);
    writeEnrollCodes(codes, options);

    const commands = renderJoinCommands({ code, hubUrl: input.hubUrl, hubVersion: input.hubVersion });
    const response = clusterEnrollResponseSchema.parse({
      codeId: record.codeId,
      code,
      expiresAt: record.expiresAt,
      commands,
    });
    return { response, record };
  });
}

/**
 * Rendered SERVER-SIDE, never assembled in the cockpit. The assertion package 1b.3 owes is not that
 * the happy shape matches, but that the string does **not** contain the Access client id or secret
 * from a fixture where both are in the environment — a test checking only the shape passes just as
 * well against a command that leaks.
 */
export function renderJoinCommands(input: {
  code: string;
  hubUrl: string;
  hubVersion: string;
}): ClusterEnrollCommands {
  const pkg = `@loki-labs/better-cezar@${input.hubVersion}`;
  return clusterEnrollCommandsSchema.parse({
    join: `npx -y ${pkg} cluster join ${input.code}`,
    provision: `npx -y ${pkg} server-install --platform hetzner --role worker --join ${input.code}`,
  });
}

/** Revoke-before-use. Returns `false` when the code was already redeemed — which is a different
 *  answer from "revoked", and the caller renders it as one. */
export async function revokeEnrollmentCode(codeId: string, options?: ClusterHomeOptions): Promise<boolean> {
  return withEnrollCodesLease(options, () => {
    const codes = readEnrollCodes(options);
    const idx = codes.findIndex((c) => c.codeId === codeId);
    if (idx === -1) return false;
    const existing = codes[idx]!;
    if (existing.redeemedAt) return false; // revoke-before-use failed — a different answer from "revoked"
    if (existing.revokedAt) return true; // idempotent: already in the revoked state
    const now = (options?.now ?? (() => new Date()))().toISOString();
    codes[idx] = { ...existing, revokedAt: now };
    writeEnrollCodes(codes, options);
    return true;
  });
}

/** Single-use: the record is marked redeemed inside the same lease that checks it, so two spokes
 *  racing one code produce one success and one `code-used`. */
export async function redeemEnrollmentCode(
  request: ClusterJoinRequest,
  options?: ClusterHomeOptions,
): Promise<ClusterJoinResponse> {
  // A protocol mismatch is checked before the code even, because it is not a fact about this code —
  // it is a fact about whether this hub and this node can speak to each other at all.
  if (request.protocol.major !== CLUSTER_PROTOCOL_MAJOR) {
    return clusterJoinResponseSchema.parse({
      ok: false,
      reason: 'protocol-major',
      message: `This hub speaks cluster protocol ${CLUSTER_PROTOCOL_MAJOR}.x; the node sent ${request.protocol.major}.${request.protocol.minor}.`,
    });
  }

  return withEnrollCodesLease(options, async () => {
    const codes = readEnrollCodes(options);
    const idx = codes.findIndex((c) => matchesEnrollmentCode(c.codeHash, request.code));
    // Not found and expired are indistinguishable to a redeemer by design: there is no
    // `code-not-found` value in `clusterJoinFailureReasonSchema`, and folding an unrecognized code
    // into the same bucket as an expired one avoids confirming whether a code was ever minted.
    if (idx === -1) {
      return clusterJoinResponseSchema.parse({
        ok: false,
        reason: 'code-expired',
        message: 'This code is not known to this hub.',
      });
    }
    const record = codes[idx]!;
    const now = (options?.now ?? (() => new Date()))();
    // Revocation and time-based expiry both mean "not currently valid to redeem", and share this
    // reason for the same cause: the five wire values in `clusterJoinFailureReasonSchema` have no
    // separate `code-revoked` member. What matters operationally — re-mint, don't retry — is the same
    // for both.
    if (record.revokedAt) {
      return clusterJoinResponseSchema.parse({
        ok: false,
        reason: 'code-expired',
        message: 'This code was revoked before it could be used.',
      });
    }
    if (record.redeemedAt) {
      return clusterJoinResponseSchema.parse({ ok: false, reason: 'code-used' });
    }
    // Enforced on the SERVER's clock (`options.now`, resolved once, right here) — `request` carries
    // no client-claimed timestamp at all, so there is no path by which a caller's notion of "fresh"
    // can override this check.
    if (Date.parse(record.expiresAt) <= now.getTime()) {
      return clusterJoinResponseSchema.parse({ ok: false, reason: 'code-expired' });
    }

    // Matched its own digest, so it must parse — this hub minted it. Guarded anyway: a throw here
    // would be an internal error, not a named enrollment outcome.
    const parsedCode = parseEnrollmentCode(request.code);
    if (!parsedCode) {
      return clusterJoinResponseSchema.parse({
        ok: false,
        reason: 'code-expired',
        message: 'This code could not be read.',
      });
    }

    const hub = await loadNodeIdentity(options);
    if (!hub) {
      // Not a named enrollment outcome: the hub has no identity of its own yet, which means cluster
      // boot has not finished. The route handler that calls this is expected to turn an unexpected
      // throw into a 500, distinct from every deliberate `ok:false` branch above.
      throw new Error(
        'redeemEnrollmentCode: this hub has no identity of its own yet — cluster boot has not run.',
      );
    }

    // CORRECTED 2026-08-23, same day — the roster row is written HERE, first of the three writes
    // this lease now makes, closing a gap found in production reasoning rather than in a crash: this
    // function used to mint and store a working secret for a node with NO `peers.json` row at all,
    // which made that node invisible to the roster, unstampable by `markNodeSeen` (which deliberately
    // never fabricates a row), and — the half that actually matters — un-revokable: `disableNode`
    // could only remove a node's secret for a roster row it found, so a joined-but-unrostered node
    // kept a valid, indefinitely usable credential no matter how many times an operator "revoked" it.
    //
    // The invariant this write order exists to hold, at EVERY crash point below, is: **there is
    // never a stored node secret without a corresponding roster row.** That is what makes revoke
    // reliable, because revoke finds nodes through the roster, and it only holds if the roster row
    // is written strictly BEFORE the secret:
    //  - crash after this write but before the secret write below: an inert roster row with no
    //    working credential — visible, un-authenticatable, and harmless. The code is not yet marked
    //    redeemed, so re-redeeming the SAME code simply upserts this same row again and proceeds;
    //    the invariant never broke.
    //  - crash after the secret write but before the code is marked redeemed (the ordering D22
    //    already pinned, unchanged below): an inert ORPHAN secret behind a roster row that already
    //    exists — recoverable the same way, and still never a secret without a row.
    //  - the one order this rules out is secret-before-roster, which is the exact defect being
    //    fixed here: nothing before this session's fix ever wrote the roster row at all, which is
    //    the degenerate case of "crash" that never resolves — a permanent, unrevokable secret with
    //    nothing in the roster to find it by.
    //
    // Re-join semantics: a node id already in the roster (disabled, or simply reconnecting after a
    // restart) has its row REPLACED, not appended — `upsertNode`'s own full-replace contract — which
    // is also how a stale `disabledAt` gets cleared: redemption itself is the operator's evidence
    // that this node should be active again (a fresh code had to be minted for it to get here), so
    // the rebuilt row carries no `disabledAt` at all, regardless of what the old row said.
    // `nodeName` and `acceptsDispatch` are the two fields `PATCH /cluster/nodes/:nodeId` lets an
    // operator set deliberately, and a re-join — the SPOKE's own action, not the operator's — must
    // not silently undo that choice, so both are carried forward from the existing row when one
    // exists. A brand-new node has no prior row to carry forward from, so `acceptsDispatch` falls
    // back to D11's fail-closed default (off — a newly enrolled node replicates state and runs
    // nothing) rather than anything the joining node claims about itself, and `nodeName` falls back
    // to the name the join request carried.
    const existingPeers = await readPeers(options);
    const existingNode = existingPeers.nodes.find((n) => n.nodeId === request.nodeId);
    await upsertNode(
      {
        nodeId: request.nodeId,
        nodeName: existingNode?.nodeName ?? request.nodeName,
        role: 'spoke',
        labels: request.labels,
        acceptsDispatch: existingNode?.acceptsDispatch ?? false,
        protocol: request.protocol,
        version: request.version,
      },
      options,
    );

    const secret = randomBytes(NODE_SECRET_BYTES).toString('hex');
    // D22: the secret is persisted BEFORE the code is marked redeemed, inside this SAME lease.
    // Ordering is a real choice here, not incidental, because the two writes touch different files
    // and the failure between them is asymmetric: a crash after this line but before the next must
    // leave an INERT orphan secret (nobody can authenticate as a node that never finished
    // redeeming, and the next successful redeem of THIS code overwrites it) rather than a code
    // burned with no secret recorded, which would strand the joining node holding a credential the
    // hub can never verify and unable to re-join without a fresh code from an operator. Prefer the
    // recoverable failure.
    await storeNodeSecret(request.nodeId, secret, options);
    // Marked redeemed inside the SAME lease that just checked it — the whole point of the lease.
    codes[idx] = { ...record, redeemedAt: now.toISOString(), redeemedByNodeId: request.nodeId };
    writeEnrollCodes(codes, options);

    return clusterJoinResponseSchema.parse({
      ok: true,
      nodeId: request.nodeId,
      hubNodeId: hub.nodeId,
      hubUrl: parsedCode.hubUrl,
      secret,
      protocol: CLUSTER_PROTOCOL,
    });
  });
}

// ---- spoke side ---------------------------------------------------------------------------------

const JOIN_TIMEOUT_MS = 10_000;
const CLUSTER_JOIN_PATH = '/api/v1/cluster/join';

/** Dials the hub and redeems. Every failure comes back as one of the five named reasons — the
 *  refusal is a value the CLI and the cockpit both branch on, never prose either of them parses. */
export async function joinCluster(
  input: { code: string; nodeName?: string; protocol: ClusterProtocol },
  options?: ClusterHomeOptions,
): Promise<ClusterJoinResponse> {
  const parsedCode = parseEnrollmentCode(input.code);
  if (!parsedCode) {
    // Nothing has been dialled at this point: the code is parsed before any socket is opened, so
    // no hub was contacted and no claim about reachability has been tested. This branch answered
    // `hub-unreachable` until 2026-08-22 on the argument that the two read alike to an operator —
    // but the value is the triage, not the prose, and `hub-unreachable` sends someone to audit DNS,
    // the tunnel and Access, all three of which are fine. It is also the one enrollment failure the
    // operator holding the screen can fix alone, which is the rule the enum splits on.
    return {
      ok: false,
      reason: 'code-malformed',
      message: 'The pasted code is not a cezar join code; no hub could be determined from it.',
    };
  }

  const identity = await ensureNodeIdentity(
    { role: 'spoke', nodeName: input.nodeName, hubUrl: parsedCode.hubUrl },
    options,
  );

  let response: Response;
  try {
    response = await fetch(new URL(CLUSTER_JOIN_PATH, parsedCode.hubUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: input.code,
        nodeId: identity.nodeId,
        nodeName: input.nodeName ?? identity.nodeName,
        labels: identity.labels,
        protocol: input.protocol,
        version: readOwnVersion(),
      } satisfies ClusterJoinRequest),
      redirect: 'manual',
      signal: AbortSignal.timeout(JOIN_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'hub-unreachable', message: `Could not reach ${parsedCode.hubUrl}.` };
  }

  // Every path on the hub 302s to the Cloudflare Access login when the operator's Access credential
  // is missing or rejected (D17) — a redirect or a 401/403 here is Access refusing the request
  // before it ever reached cezar's own join handler, which always answers a parseable `ok:false`
  // body rather than an HTTP error status.
  if ((response.status >= 300 && response.status < 400) || response.status === 401 || response.status === 403) {
    return {
      ok: false,
      reason: 'access-rejected',
      message: 'Cloudflare Access rejected this request before it reached the hub.',
    };
  }
  if (!response.ok) {
    return { ok: false, reason: 'hub-unreachable', message: `The hub responded with HTTP ${response.status}.` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: 'hub-unreachable', message: 'The hub returned a response that was not JSON.' };
  }
  const parsed = clusterJoinResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, reason: 'protocol-major', message: 'The hub returned a response this node cannot parse.' };
  }
  if (parsed.data.ok) {
    await persistNodeCredential(
      { nodeId: parsed.data.nodeId, hubUrl: parsedCode.hubUrl, secret: parsed.data.secret },
      options,
    );
  }
  return parsed.data;
}

/** Deletes this node's credential. The spoke half of a two-sided revoke, and the half that actually
 *  stops it pushing. */
export async function leaveCluster(options?: ClusterHomeOptions): Promise<void> {
  try {
    unlinkSync(nodeIdentityPath(options?.env));
  } catch {
    // Already gone — leaving a cluster this node was never in is not an error.
  }
}

// ---- frame signing, used by both ends of the link -----------------------------------------------

export interface ClusterFramePrincipal {
  nodeId: ClusterNodeId;
  /** `Date#toISOString()`, matching every other timestamp in this codebase. Bounds how long a
   *  captured frame remains usable. */
  issuedAt: string;
}

export interface SignedClusterFrame {
  principal: string;
  signature: string;
}

/** Mirrors `forwarded-principal.ts#forwardedPrincipalPayloadSchema`: `.strict()`, because both ends
 *  of this link come from the same install of this package — there is no older reader to protect by
 *  tolerating an unknown key here (that tolerance lives one level up, on `ClusterOp.unknown`/`D13`). */
const clusterFramePrincipalSchema = z
  .object({
    nodeId: z.string().min(1),
    issuedAt: z.string().min(1),
  })
  .strict();

function encodeFramePrincipal(principal: ClusterFramePrincipal): string {
  return Buffer.from(JSON.stringify(principal), 'utf8').toString('base64url');
}

function signFramePayload(encodedPrincipal: string, secret: string): string {
  return createHmac('sha256', secret).update(encodedPrincipal).digest('base64url');
}

export function signClusterFrame(principal: ClusterFramePrincipal, secret: string): SignedClusterFrame {
  const encoded = encodeFramePrincipal(principal);
  return { principal: encoded, signature: signFramePayload(encoded, secret) };
}

/** `null` for every failure — missing, tampered, wrong secret, unparseable, stale, or skewed into
 *  the future. Never throws, so the caller's error shape stays one thing. */
export function verifyClusterFrame(
  signed: Partial<SignedClusterFrame> | undefined,
  secret: string,
  options?: { now?: () => Date; maxAgeMs?: number },
): ClusterFramePrincipal | null {
  if (!signed?.principal || !signed.signature || !secret) return null;
  const expected = Buffer.from(signFramePayload(signed.principal, secret));
  const actual = Buffer.from(signed.signature);
  // Length compared before `timingSafeEqual` (which throws, rather than returning false, on a
  // length mismatch) — not a timing leak of the secret, since `expected`'s length is fixed by the
  // HMAC digest encoding and never depends on `secret`'s content. Same shape as
  // `forwarded-principal.ts#verifyForwardedPrincipal`.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(signed.principal, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = clusterFramePrincipalSchema.safeParse(decoded);
  if (!parsed.success) return null;

  const issuedAtMs = Date.parse(parsed.data.issuedAt);
  if (!Number.isFinite(issuedAtMs)) return null;
  const now = (options?.now ?? (() => new Date()))();
  const maxAgeMs = options?.maxAgeMs ?? LINK_PRINCIPAL_MAX_AGE_MS;
  const ageMs = now.getTime() - issuedAtMs;
  // Negative age (issuedAt in the future) is refused too, not clamped to zero — a payload claiming
  // to be from the future is exactly as suspect as one that is stale.
  if (ageMs < 0 || ageMs > maxAgeMs) return null;

  return parsed.data;
}

/** Written `0600` into `~/.cezar/cluster/node.json` by the join flow. Separate from
 *  `saveNodeIdentity` so the secret has exactly one writer. */
export async function persistNodeCredential(
  input: { nodeId: ClusterNodeId; hubUrl: string; secret: string },
  options?: ClusterHomeOptions,
): Promise<StoredClusterNodeIdentity> {
  const existing = await loadNodeIdentity(options);
  const now = (options?.now ?? (() => new Date()))().toISOString();
  const identity = storedClusterNodeIdentitySchema.parse({
    nodeId: input.nodeId,
    nodeName: existing?.nodeName ?? input.nodeId,
    createdAt: existing?.createdAt ?? now,
    role: 'spoke',
    hubUrl: input.hubUrl,
    secret: input.secret,
    acceptsDispatch: existing?.acceptsDispatch ?? false,
    labels: existing?.labels ?? [],
  } satisfies StoredClusterNodeIdentity);

  const dir = clusterHomeDir(options?.env);
  const path = nodeIdentityPath(options?.env);
  assertCezarHomeWriteIsSandboxed(path);
  mkdirSync(dir, { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return identity;
}
