import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Context, MiddlewareHandler } from 'hono';
import type { ClusterNodeId } from '@loki-labs/better-cezar-contract';
import { LINK_PRINCIPAL_MAX_AGE_MS } from './enrollment.ts';

/**
 * D20 of `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`: the `/api/v1/cluster/*` HTTP family
 * authenticates the NODE, with a signed freshness-bounded principal, before it serves any route
 * that returns content scoped to one node.
 *
 * **Extending the link's mechanism, not inventing a second one.** `enrollment.ts#signClusterFrame` /
 * `verifyClusterFrame` already do exactly this for the WS link upgrade — HMAC-SHA256 over a
 * base64url-encoded JSON payload, `timingSafeEqual` before the payload is ever parsed, a bounded
 * `issuedAt` window rather than a nonce scheme — keyed on the same per-node secret enrollment mints
 * (D17). This file reuses that idiom verbatim rather than reusing those two functions directly,
 * because an HTTP request is not a persistent connection: the link's principal (`{nodeId,
 * issuedAt}`) is bound once, at connect time, and every frame after that rides the same socket. An
 * HTTP request has no socket to trust — each one is its own bearer of intent — so the signed
 * payload here additionally binds the METHOD, PATH and a hash of the BODY (`NodeHttpPrincipal`
 * below). Without that binding, a captured header pair would be freshness-bounded but not
 * REQUEST-bound: it could be replayed against a different route, or with a different body, inside
 * its validity window. `clusterFramePrincipalSchema` is `.strict()` and has no room for those
 * fields, and it is enrollment.ts's own, not this package's, to widen — so this is a sibling
 * payload shape on the same mechanism, exactly how `enrollment.ts` itself is a sibling payload
 * shape on `supervisor/forwarded-principal.ts`'s original one.
 *
 * **Freshness window: `enrollment.ts#LINK_PRINCIPAL_MAX_AGE_MS` (120s), not
 * `forwarded-principal.ts`'s own 60s default.** The brief for this package points at
 * `forwarded-principal.ts`'s options rather than a fresh number — 120s already IS that number,
 * widened once for exactly this WAN, hub-to-spoke context ("a WAN link with real latency and
 * modest clock skew", `enrollment.ts`'s own comment). This HTTP family crosses the identical WAN
 * hop the link does — both traverse the same identity-aware proxy in front of the hub — so reusing the
 * already-derived cluster constant is more specific than reusing the LAN-loopback default it was
 * itself derived from, and it means there is exactly one place that number lives for this feature
 * rather than two that could drift apart.
 *
 * **What this file does NOT do: decide where the hub persists a node's secret.**
 * `redeemEnrollmentCode` (`enrollment.ts`) mints a per-node secret and hands it to the joining
 * spoke, but — verified by reading every write in `enrollment.ts` and `peers.ts` — nothing
 * anywhere persists that secret HUB-side, keyed by node id, for a later request to look up. This
 * is not a gap introduced here: the WS link has the identical gap today
 * (`link-server.ts#ClusterLinkServer`'s own `lookupSecret` is injected and, per
 * `.ai/runs/2026-08-22-multi-node-cezar-cluster/PLAN.md`'s "Found during implementation" table,
 * wired to nothing real yet either). `peers.json` is the wrong place for it regardless of who
 * builds it — that roster is what a node's OWN cockpit mirrors from the hub, so a secret stored
 * there would hand every spoke every other spoke's credential. So `createNodeAuthMiddleware`
 * below takes `lookupSecret` as an injected function, exactly like `authenticateLinkUpgrade`
 * does, and stays correct and fully testable independent of where that store ends up living.
 * `cluster-routes.ts` wires a default that always answers `undefined` — fails closed, and is
 * honest about the gap rather than papering over it — until a package builds the real store.
 */

// ---- the three headers a claimed node presents, mirroring `link-server.ts`'s shape -------------

/** Unsigned. Used ONLY to pick which node's secret to attempt verification against — trust never
 *  rests on this header alone, the same "defense in depth" `link-server.ts#authenticateLinkUpgrade`
 *  practices: the verified payload's OWN `nodeId` is cross-checked against this one before a
 *  request is admitted, so the two can only ever agree if the signature actually checks out. */
export const CLUSTER_NODE_ID_HEADER = 'x-cezar-node-id';
export const CLUSTER_NODE_PRINCIPAL_HEADER = 'x-cezar-node-principal';
export const CLUSTER_NODE_SIGNATURE_HEADER = 'x-cezar-node-signature';

// ---- the signed payload ---------------------------------------------------------------------

/**
 * `.strict()` for the same reason `clusterFramePrincipalSchema` is: both ends of this exchange run
 * the same install of this package, so there is no older reader to tolerate an unknown key for.
 *
 * `path` is the request's pathname exactly as the SERVER sees it via Hono's `c.req.path` — e.g.
 * `/api/v1/cluster/corpus/submit`. No origin, no query string. A signer must construct the same
 * string the verifying server will compute, which is why this is spelled out rather than left to
 * be discovered by a future caller reverse-engineering a 401.
 */
const nodeHttpPrincipalSchema = z
  .object({
    nodeId: z.string().min(1),
    issuedAt: z.string().min(1),
    method: z.string().min(1).max(10),
    path: z.string().min(1).max(2048),
    /** sha256 hex of the raw request body, or of the empty string for a bodyless request — see
     *  `hashRequestBody`. Binding it is what makes a captured header pair unusable against a
     *  request carrying a different body, not merely a different route. */
    bodyHash: z.string().min(1).max(128),
  })
  .strict();
export type NodeHttpPrincipal = z.infer<typeof nodeHttpPrincipalSchema>;

export interface SignedNodeHttpPrincipal {
  /** Value for `CLUSTER_NODE_PRINCIPAL_HEADER` — base64url-encoded JSON. */
  readonly principal: string;
  /** Value for `CLUSTER_NODE_SIGNATURE_HEADER` — base64url HMAC-SHA256 of `principal`. */
  readonly signature: string;
}

function encodePrincipal(principal: NodeHttpPrincipal): string {
  return Buffer.from(JSON.stringify(principal), 'utf8').toString('base64url');
}

function signPayload(encodedPrincipal: string, secret: string): string {
  return createHmac('sha256', secret).update(encodedPrincipal).digest('base64url');
}

/** sha256 hex of the raw request body. `''` for a bodyless request (every GET/DELETE in this
 *  family) — `hashRequestBody('')` is a fixed, well-known value, not a special case the verifier
 *  has to branch on. */
export function hashRequestBody(bodyText: string): string {
  return createHash('sha256').update(bodyText, 'utf8').digest('hex');
}

/**
 * The CALLER side, and the low-level half of it — prefer `signedNodeRequestHeaders` below, which
 * cannot be handed a body it did not hash.
 *
 * **CORRECTED 2026-08-23.** This docblock read *"Not wired to any client in this package"* and
 * listed both callers as divergences still to be updated, which was true the hour it was written
 * and false by the end of the same day: `cez kb submit` (`packages/cezar/src/index.ts`, which
 * previously sent NO auth headers at all) and `sources/cezar-hub/provider.ts` (which sent the
 * superseded `Authorization: Bearer` + `x-cezar-node-id` pair) both sign through this file now.
 * What is still unwired is the HUB side — see the module header on the missing secret store.
 */
export function signNodeHttpPrincipal(principal: NodeHttpPrincipal, secret: string): SignedNodeHttpPrincipal {
  const encoded = encodePrincipal(principal);
  return { principal: encoded, signature: signPayload(encoded, secret) };
}

export interface SignedNodeRequestInput {
  readonly nodeId: string;
  readonly secret: string;
  readonly method: string;
  /** The URL the request will actually be sent to. Only `pathname` is signed — see below. */
  readonly url: URL;
  /** The EXACT string that will be sent as the body. `''` for a bodyless request. */
  readonly bodyText?: string;
  readonly now?: () => number;
}

/**
 * Builds the three headers a caller sends, from the request it is actually about to make.
 *
 * This exists because the one way to get D20 wrong is subtle and silent: sign over a body that is
 * not byte-for-byte the body you send. `JSON.stringify` called twice on the same object is not
 * guaranteed to produce the same string across engine versions or after an innocuous refactor, so
 * a caller that stringifies once for `hashRequestBody` and again for `fetch`'s `body` verifies
 * fine in a unit test and fails as `bad-signature` in production — the least diagnosable of the
 * four reasons, because it reads as tampering. Taking `bodyText` as a STRING and returning it
 * alongside the headers makes the two the same value by construction; there is nothing left for a
 * test to enforce.
 *
 * **`url.pathname`, deliberately, and not `url.pathname + url.search`.** The verifier binds
 * against Hono's `c.req.path`, which excludes the query string (`nodeHttpPrincipalSchema` says so
 * on `path`). Signing the search string here would make every request with a query parameter fail
 * `bad-signature` on arrival — so the asymmetry is load-bearing, not an oversight. It does mean a
 * captured header pair can be replayed against the same path with DIFFERENT query parameters
 * inside its 120s window, which is why no route in this family may put anything security-relevant
 * in the query string; scope every answer to `getAuthenticatedClusterNode(c).nodeId` instead.
 */
export function signedNodeRequestHeaders(input: SignedNodeRequestInput): {
  readonly headers: Record<string, string>;
  readonly body: string;
} {
  const bodyText = input.bodyText ?? '';
  const signed = signNodeHttpPrincipal(
    {
      nodeId: input.nodeId,
      issuedAt: new Date(input.now ? input.now() : Date.now()).toISOString(),
      method: input.method,
      path: input.url.pathname,
      bodyHash: hashRequestBody(bodyText),
    },
    input.secret,
  );
  return {
    headers: {
      [CLUSTER_NODE_ID_HEADER]: input.nodeId,
      [CLUSTER_NODE_PRINCIPAL_HEADER]: signed.principal,
      [CLUSTER_NODE_SIGNATURE_HEADER]: signed.signature,
    },
    body: bodyText,
  };
}

// ---- verification, as a discriminated verdict rather than a null -------------------------------

/**
 * Splits on what the operator (or the agent process acting on their behalf) can do next — the
 * same rule `enrollment.ts`'s own join-failure enum follows: re-enroll fixes `unknown-node`,
 * re-signing with a synced clock fixes `stale-principal`, neither fixes `bad-signature` (something
 * altered the request or the secret is wrong), and `no-credentials` means the caller never tried to
 * authenticate as a node at all — which on a route that requires it is a caller bug, not a
 * transient condition.
 *
 * `internal` is not one of the four above: it is reserved for `lookupSecret` throwing (a store
 * that exists later might fail to read), and is rendered as a 500, not a 401 — the caller did
 * nothing wrong, the hub did.
 */
export type NodeAuthFailureReason = 'no-credentials' | 'unknown-node' | 'bad-signature' | 'stale-principal';

export type NodeAuthVerdict =
  | { readonly ok: false; readonly reason: NodeAuthFailureReason }
  | { readonly ok: true; readonly nodeId: ClusterNodeId };

/** What the signed principal must match on the ACTUAL, arriving request — computed by the
 *  middleware from the live `Context`, never trusted from a client-supplied field. */
export interface NodeHttpRequestBinding {
  readonly method: string;
  readonly path: string;
  readonly bodyHash: string;
}

export interface VerifyNodeHttpPrincipalOptions {
  now?: () => Date;
  maxAgeMs?: number;
}

/**
 * The hub side. Unlike `verifyClusterFrame` (which returns `null` for every failure alike, so its
 * one caller re-verifies with an unbounded age window just to tell "stale" from "wrong" apart),
 * this returns the distinction directly — signature-and-binding are checked first, freshness only
 * once those pass, so "correctly signed for this exact request, just old" and "signed for a
 * different request, or with the wrong secret" can never be confused by construction rather than
 * by a second pass.
 *
 * Signature is verified with `timingSafeEqual` BEFORE the payload is parsed or any of its fields
 * are read — the same ordering `forwarded-principal.ts#verifyForwardedPrincipal` and
 * `enrollment.ts#verifyClusterFrame` both already commit to.
 */
export function verifyNodeHttpPrincipal(
  signed: Partial<SignedNodeHttpPrincipal> | undefined,
  claimedNodeId: string | undefined,
  secret: string | undefined,
  binding: NodeHttpRequestBinding,
  options: VerifyNodeHttpPrincipalOptions = {},
): NodeAuthVerdict {
  if (!claimedNodeId || !signed?.principal || !signed.signature) return { ok: false, reason: 'no-credentials' };
  if (!secret) return { ok: false, reason: 'unknown-node' };

  const expected = Buffer.from(signPayload(signed.principal, secret));
  const actual = Buffer.from(signed.signature);
  // Length compared before `timingSafeEqual` (which throws rather than returning false on a length
  // mismatch) — not a timing leak of the secret, since `expected`'s length is fixed by the HMAC
  // digest encoding and never depends on `secret`'s content. Same shape as `verifyClusterFrame`.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'bad-signature' };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(signed.principal, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad-signature' };
  }
  const parsed = nodeHttpPrincipalSchema.safeParse(decoded);
  if (!parsed.success) return { ok: false, reason: 'bad-signature' };
  const principal = parsed.data;

  // The claim must match what was ACTUALLY signed. A tampered outer node-id header picks the
  // wrong secret and never reaches this line (the HMAC compare above fails first); a tampered
  // path/method/body on an otherwise-genuine, replayed header pair reaches here and is caught by
  // this comparison instead — the signature is valid FOR THE ORIGINAL REQUEST, not this one.
  if (
    principal.nodeId !== claimedNodeId ||
    principal.method !== binding.method ||
    principal.path !== binding.path ||
    principal.bodyHash !== binding.bodyHash
  ) {
    return { ok: false, reason: 'bad-signature' };
  }

  const issuedAtMs = Date.parse(principal.issuedAt);
  if (!Number.isFinite(issuedAtMs)) return { ok: false, reason: 'bad-signature' };
  const now = (options.now ?? (() => new Date()))();
  const maxAgeMs = options.maxAgeMs ?? LINK_PRINCIPAL_MAX_AGE_MS;
  const ageMs = now.getTime() - issuedAtMs;
  // Negative age (issuedAt in the future) is refused too, not clamped to zero — a payload claiming
  // to be from the future is exactly as suspect as one that is stale (same reasoning as
  // `verifyClusterFrame`).
  if (ageMs < 0 || ageMs > maxAgeMs) return { ok: false, reason: 'stale-principal' };

  return { ok: true, nodeId: principal.nodeId };
}

// ---- the Hono middleware, and reading its result back out of the context -----------------------

/** What a handler downstream of `createNodeAuthMiddleware` reads to learn who is asking. Deliberately
 *  narrow — just the id, nothing else the payload carried — because scoping an answer to a node
 *  needs its identity, not its request metadata. */
export interface ClusterNodeContext {
  readonly nodeId: ClusterNodeId;
}

type ClusterNodeAuthEnv = { Variables: { clusterNode: ClusterNodeContext } };

const CLUSTER_NODE_CONTEXT_VAR = 'clusterNode' as const;

/** Reads the identity `createNodeAuthMiddleware` established, from any handler on a gated path.
 *  `undefined` on a path the middleware never ran for — a handler on an unauthenticated route has
 *  no caller identity to read, by construction. Cast idiom matches `server.ts#approverOf`'s own
 *  `c as unknown as Context<{Variables:{principal:Principal}}>` — reading a context variable that
 *  is not part of the route family's own `ProjectApiEnv`, without widening that shared type for a
 *  variable only this family's gated routes ever set. */
export function getAuthenticatedClusterNode(c: Context): ClusterNodeContext | undefined {
  return (c as unknown as Context<ClusterNodeAuthEnv>).get(CLUSTER_NODE_CONTEXT_VAR);
}

const NODE_AUTH_MESSAGE: Record<NodeAuthFailureReason, string> = {
  'no-credentials': 'no node credentials were presented on this request',
  'unknown-node': 'this node is not known to the hub — enroll it first (`cez cluster join <code>`)',
  'bad-signature': 'the node signature on this request is invalid',
  'stale-principal': "the signed principal on this request is too old — check the node's clock and retry",
};

export interface NodeAuthMiddlewareOptions {
  /** Resolves a claimed node id to its enrollment secret. `undefined` for a node the hub does not
   *  (or no longer) recognise — see the module docblock for why no real implementation is wired
   *  here by default. */
  lookupSecret: (nodeId: ClusterNodeId) => Promise<string | undefined>;
  now?: () => Date;
  maxAgeMs?: number;
}

/**
 * Gates one path onto the node-authenticated set (D20 constraint 1: a route joins by its PATH,
 * via `.use()`, never by a handler remembering to call this). Reads the raw body to hash it
 * BEFORE any downstream JSON validator does — safe because Hono's `HonoRequest#json()` reads
 * through the same `text` body-cache key `c.req.text()` populates (verified against
 * `hono/dist/request.js`), so a validator running after this middleware sees the identical body,
 * not a second, empty read of an already-consumed stream.
 */
export function createNodeAuthMiddleware(options: NodeAuthMiddlewareOptions): MiddlewareHandler {
  return async (c, next) => {
    const claimedNodeId = c.req.header(CLUSTER_NODE_ID_HEADER);
    const principal = c.req.header(CLUSTER_NODE_PRINCIPAL_HEADER);
    const signature = c.req.header(CLUSTER_NODE_SIGNATURE_HEADER);

    let secret: string | undefined;
    if (claimedNodeId) {
      try {
        secret = await options.lookupSecret(claimedNodeId);
      } catch {
        return c.json(
          { error: 'looking up this node’s credential failed unexpectedly', reason: 'internal' },
          500,
        );
      }
    }

    const bodyText = await c.req.text().catch(() => '');
    const verdict = verifyNodeHttpPrincipal(
      { principal, signature },
      claimedNodeId,
      secret,
      { method: c.req.method, path: c.req.path, bodyHash: hashRequestBody(bodyText) },
      { now: options.now, maxAgeMs: options.maxAgeMs },
    );

    if (!verdict.ok) {
      return c.json({ error: NODE_AUTH_MESSAGE[verdict.reason], reason: verdict.reason }, 401);
    }
    (c as unknown as Context<ClusterNodeAuthEnv>).set(CLUSTER_NODE_CONTEXT_VAR, { nodeId: verdict.nodeId });
    await next();
  };
}
