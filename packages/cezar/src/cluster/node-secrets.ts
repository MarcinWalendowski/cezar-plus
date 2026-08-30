import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClusterNodeId } from '@loki-labs/cezar-plus-contract';
import { clusterHomeDir, type ClusterHomeOptions } from './node-identity.ts';
import { assertCezarHomeWriteIsSandboxed } from '../paths.ts';

/**
 * D22 of `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`: the hub-side store mapping a node id
 * to the per-node HMAC secret `enrollment.ts#redeemEnrollmentCode` mints. This is the receiving end
 * that was missing entirely until this file — D17's "INCOMPLETE" note (found 2026-08-23 while
 * implementing D20) diagnosed the gap: the hub minted a secret, handed it to the joining spoke, and
 * persisted it nowhere, so `node-auth.ts#lookupNodeSecret` and `link-server.ts#authenticateLinkUpgrade`'s
 * injected `lookupSecret` both answered `undefined` for every caller and every node-authenticated
 * route (and the link itself) refused by construction. D22 is the resolution; this file is it.
 *
 * **Its own file, not `peers.json`.** `GET /api/v1/cluster` serves the roster straight from
 * `peers.json`, and the contract's served node shape has no `secret` field at all, deliberately — a
 * secret stored alongside the roster is one careless `readPeers()` away from being handed to every
 * spoke, i.e. from giving each node every other node's credential. So this store lives at its own
 * path, `<clusterHomeDir>/node-secrets.json`, `0600`, keyed by node id, and is never rendered by any
 * route. The one read this file exports, `lookupNodeSecret`, answers a SINGLE node's secret by id —
 * there is deliberately no "list all" accessor. Nothing in this codebase needs one, and adding one
 * is an invitation to render it somewhere it should not be.
 *
 * **Plaintext at rest, and this is deliberate, not an oversight.** `enrollment.ts` stores enrollment
 * CODES as a SHA-256 digest, because redemption only ever needs an equality check. This store cannot
 * use that idiom: HMAC verification (`node-auth.ts#verifyNodeHttpPrincipal`,
 * `enrollment.ts#verifyClusterFrame`) needs the actual secret to recompute `HMAC(payload, secret)` —
 * that cannot be done from a digest of `secret`. A store that hashed these would fail every
 * signature and read as a signing bug, not a hardening; the next reader who notices plaintext here
 * will otherwise "fix" it into a digest and quietly break every node on the cluster. The protection
 * is file mode (`0600`, `0700` parent) and the fact that a hub compromised enough to read `0600`
 * files in cezar's home already owns the process holding these same secrets in memory.
 *
 * **Locking is NOT this file's job.** `enrollment.ts#redeemEnrollmentCode` writes a fresh node's
 * secret and marks its enrollment code redeemed inside ONE lease — `enrollment.ts`'s own
 * `enroll-codes` write lease — secret written FIRST, code marked redeemed second, in that order,
 * because a crash between the two writes must strand only an inert orphan secret, never a joining
 * node holding a credential the hub can never verify (D22's own reasoning). That lease is what
 * serializes every writer of this file; the functions below take no lock of their own and MUST be
 * called with that lease already held. `peers.ts#disableNode`, this file's other writer, does the
 * same rather than inventing a second lock that could race the first.
 */

const NODE_SECRETS_FILE = 'node-secrets.json';

export function nodeSecretsPath(env?: NodeJS.ProcessEnv): string {
  return join(clusterHomeDir(env), NODE_SECRETS_FILE);
}

function reportWarning(options: ClusterHomeOptions | undefined, message: string): void {
  (options?.warn ?? ((m: string) => console.warn(m)))(message);
}

/** Per-entry salvage, matching every sibling store in this directory: one unreadable VALUE is
 *  dropped rather than evicting the whole map, and a corrupt file degrades to empty with one
 *  warning rather than throwing. */
function readNodeSecretsMap(options?: ClusterHomeOptions): Record<string, string> {
  const path = nodeSecretsPath(options?.env);
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    reportWarning(
      options,
      `[cez] node secrets ${path} is corrupt — ignoring it (secrets re-populate as nodes re-join)`,
    );
    return {};
  }
  const record = (raw as { secrets?: unknown } | null)?.secrets;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    reportWarning(
      options,
      `[cez] node secrets ${path} is corrupt — ignoring it (secrets re-populate as nodes re-join)`,
    );
    return {};
  }
  let dropped = 0;
  const out: Record<string, string> = {};
  for (const [nodeId, value] of Object.entries(record as Record<string, unknown>)) {
    if (typeof value === 'string' && value.length > 0) out[nodeId] = value;
    else dropped++;
  }
  if (dropped > 0) {
    reportWarning(options, `[cez] node secrets ${path} — dropped ${dropped} unreadable row(s), kept the rest`);
  }
  return out;
}

/** Atomic tmp+rename, `0600` file / `0700` parent — `workspace/config.ts#atomicWriteJsonSync`'s own
 *  idiom, not reused directly because that helper writes the value verbatim and this file always
 *  wraps it as `{ secrets }`.
 *
 *  **CORRECTED 2026-08-23, same day, before this shipped.** This said `mode: 0o700` was *"passed on
 *  every call (not only the first) because Node's `mkdirSync` only applies a mode to a directory it
 *  actually creates — a caller relying on some OTHER writer to have created `clusterHomeDir()` first
 *  must not silently inherit a looser mode from it."* The first half is true and the conclusion does
 *  not follow: passing a mode does nothing on a directory that already exists, so the stated
 *  protection was exactly the case the code did NOT handle. And that case is the only one that
 *  happens in production — `ensureNodeIdentity`, `writeEnrollCodes` and the enroll-codes lock all
 *  create this same directory with `mkdirSync(dir, { recursive: true })` and no mode at all, and all
 *  of them run before any node redeems a code. So the real directory is whatever the umask gave the
 *  first writer, typically `0755`. Hence the explicit `chmodSync` below, which applies regardless of
 *  who created it. The exposure this closes is listing, not reading — every file in here is written
 *  `0600` — but D22's whole premise is that file mode IS the protection, so a claim about it has to
 *  be true. */
function writeNodeSecretsMap(secrets: Record<string, string>, options?: ClusterHomeOptions): void {
  const dir = clusterHomeDir(options?.env);
  const path = nodeSecretsPath(options?.env);
  assertCezarHomeWriteIsSandboxed(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ secrets }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * Writes NODE_ID's secret, overwriting any prior value for that id — "newest wins" (D22): a
 * re-join replaces rather than appends, so re-enrolling a node rotates its credential as a side
 * effect rather than leaving a stale one usable alongside the new one. MUST be called with
 * `enrollment.ts`'s `enroll-codes` write lease already held — see the module docblock.
 */
export async function storeNodeSecret(
  nodeId: ClusterNodeId,
  secret: string,
  options?: ClusterHomeOptions,
): Promise<void> {
  const secrets = readNodeSecretsMap(options);
  secrets[nodeId] = secret;
  writeNodeSecretsMap(secrets, options);
}

/**
 * Removes NODE_ID's secret — the credential-revoking half of `peers.ts#disableNode` (D22:
 * "removed on revoke"). Returns `false` when the node had no stored secret, which is not an error:
 * a node that never finished enrollment, or was already disabled, has nothing here to remove. MUST
 * be called with the `enroll-codes` lease held, same as `storeNodeSecret` — see the module
 * docblock for why this file must never grow a second lock.
 */
export async function removeNodeSecret(
  nodeId: ClusterNodeId,
  options?: ClusterHomeOptions,
): Promise<boolean> {
  const secrets = readNodeSecretsMap(options);
  if (!(nodeId in secrets)) return false;
  delete secrets[nodeId];
  writeNodeSecretsMap(secrets, options);
  return true;
}

/**
 * THE read, and the only one exported: one node's secret by id, `undefined` for a node the hub does
 * not (or no longer) recognise — including simply because this file has never been written yet,
 * which must degrade to "no secrets stored" rather than throw (cezar is a released package; a
 * missing file is normal state, not corruption). This is what `cluster-routes.ts` wires into
 * `node-auth.ts`'s `lookupSecret` and what `link-server.ts`'s `ClusterLinkServer` defaults its own
 * `lookupSecret` to — the same store answers both, because the same per-node secret signs both the
 * HTTP family (D20) and the link's own frames (D17). No "list all" accessor is exported — see the
 * module docblock for why.
 */
export async function lookupNodeSecret(
  nodeId: ClusterNodeId,
  options?: ClusterHomeOptions,
): Promise<string | undefined> {
  return readNodeSecretsMap(options)[nodeId];
}
