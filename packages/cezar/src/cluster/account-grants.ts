import type {
  ClusterAccountGrant,
  ClusterAccountGrantDecision,
  ClusterNodeId,
  StoredClusterLease,
} from '@loki-labs/better-cezar-contract';
import type { ClusterHomeOptions } from './node-identity.ts';
import { acquireLease, leasesHeldBy, readLeases, releaseLease } from './leases.ts';
import { ASSUMED_LIMIT_COOLDOWN_MS } from '../workspace/agent-account-usage.ts';

/**
 * Agent-account grants across nodes: one coherent utilisation at the hub, and a usage-limit hold
 * observed on one node parking the others (spec
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D14 · §4; PLAN 3.3).
 *
 * **This is a different resource from host capacity, and conflating the two is the defect this file
 * exists to avoid.** `ClusterCapacity` bounds what a machine can physically run; an account grant
 * bounds subscription spend. A node can have capacity and no grant, or a grant and no capacity, and
 * **each refusal names which** — an operator told only "queued" will add a machine to fix a
 * subscription ceiling. Problem §4 is explicit that every node draining the same one subscription is
 * the ceiling money cannot move; a second box does not raise it.
 *
 * **This file CONSUMES `cluster/leases.ts`, it does not co-edit it.** The lease is the primitive;
 * the accounting is the policy. They were split in the plan for exactly this reason, so a change to
 * one is not a change to both. Two of the three lease kinds `leases.ts` reserves for "genuinely a
 * resource" are spent here: `account` for the grant itself and `limit-hold` for the fleet-wide park.
 * (`usage-aggregation`, the third, is not consumed by this file — nothing here needs a cross-node
 * mutex beyond what `leases.ts`'s own per-`(kind, id)` exclusivity already gives; it is left for
 * whichever future need named it.)
 *
 * **A lease `id` is one string** (`leasesPath` schema: `min(1).max(200)`, no field for `accountKey`
 * on the record). An `account` grant is per **run**, not per account — two runs on the same account
 * must be two leases — so the lease id has to carry both. It is `JSON.stringify([accountKey,
 * runId])`: unambiguous regardless of what characters either half contains, unlike a delimiter this
 * file would have to hope neither half ever produces. A `limit-hold` lease, by contrast, really is
 * keyed on the account alone (`id = accountKey`) — there is one hold per account, not one per run.
 *
 * The derived-count discipline from `agent-account-usage.ts` carries over verbatim: *"a count
 * persisted here would be incremented at dispatch and decremented at completion, so every crash,
 * SIGKILL and power cut leaks a permanent phantom … a derived count is wrong for as long as it takes
 * to re-read, which is never."* So in-flight usage is derived from live grants with TTLs, never
 * incremented and decremented — `clusterAccountUtilisation` and `readAccountGrants` both read
 * `leases.ts`'s store fresh and drop anything past its own `expiresAt`, regardless of whether a sweep
 * has run yet. A lease a sweep has not yet evicted is still stale the instant its clock runs out.
 *
 * **Fail-closed vs fail-open, and they are not the same call.** `requestAccountGrant` is the safety
 * path — CLAUDE.md's "fail closed on any path that can lose money or data" — so a lease-store read
 * that errors refuses the grant (`no-lease`) rather than silently treating "could not check for a
 * hold" as "no hold". `clusterAccountUtilisation` / `readAccountGrants` are dashboards, not gates:
 * on the same error they degrade to an empty read (with one warning), matching every other
 * best-effort read in this workspace home.
 */

/** Mirrors `clusterLeaseRequestSchema`'s own bounds in `packages/contract/src/cluster.ts`. Kept in
 *  sync by hand — this file does not import zod internals from the contract schema to derive them —
 *  because a request this file builds must be valid before it ever reaches `leases.ts`. */
const MIN_LEASE_TTL_MS = 1_000;
const MAX_LEASE_TTL_MS = 3_600_000;

/** No renewal loop lives in this file (that is the caller's job, same as any other lease), so the
 *  default favours few round-trips over a long run: the contract's own TTL ceiling, one hour. */
export const DEFAULT_ACCOUNT_GRANT_TTL_MS = MAX_LEASE_TTL_MS;

function clampTtlMs(ttlMs: number): number {
  if (!Number.isFinite(ttlMs)) return DEFAULT_ACCOUNT_GRANT_TTL_MS;
  return Math.min(Math.max(Math.round(ttlMs), MIN_LEASE_TTL_MS), MAX_LEASE_TTL_MS);
}

function reportWarning(options: ClusterHomeOptions | undefined, message: string): void {
  (options?.warn ?? ((m: string) => console.warn(m)))(message);
}

function isLive(expiresAt: string, nowMs: number): boolean {
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) && parsed > nowMs;
}

/** The one place an `account` lease id is built or read back. See the module header for why it is
 *  JSON rather than a delimiter. */
function encodeGrantLeaseId(accountKey: string, runId: string): string {
  return JSON.stringify([accountKey, runId]);
}

/** `undefined` on anything that is not this file's own encoding — a hand-edited or foreign lease
 *  row is skipped by the caller rather than crashing the whole aggregate (the salvage discipline
 *  every store in this workspace home already follows). */
function decodeGrantLeaseId(id: string): { accountKey: string; runId: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(id);
  } catch {
    return undefined;
  }
  if (
    Array.isArray(parsed) &&
    parsed.length === 2 &&
    typeof parsed[0] === 'string' &&
    typeof parsed[1] === 'string'
  ) {
    return { accountKey: parsed[0], runId: parsed[1] };
  }
  return undefined;
}

export interface AccountGrantRequest {
  accountKey: string;
  nodeId: ClusterNodeId;
  runId: string;
  ttlMs?: number;
}

/** Hub-side. Grants, or refuses with the reason NAMED — `account-at-limit`, `limit-hold`,
 *  `no-lease`, `unknown-account` — and, where it is known, when to retry. */
export async function requestAccountGrant(
  request: AccountGrantRequest,
  options?: ClusterHomeOptions,
): Promise<ClusterAccountGrantDecision> {
  const accountKey = request.accountKey.trim();
  if (!accountKey) {
    return { granted: false, reason: 'unknown-account' };
  }

  const now = options?.now ?? (() => new Date());
  const nowMs = now().getTime();

  // The whole grant decision is one fail-closed block: a lease-store error here must refuse, never
  // silently read as "no hold, no conflict" — see the module header.
  try {
    // A limit hold observed on ANY node parks EVERY node's request for this account — it is a fact
    // about the account, not about whichever machine happened to hit it first (E6).
    const leases = await readLeases(options);
    const hold = leases.find(
      (lease) => lease.kind === 'limit-hold' && lease.id === accountKey && isLive(lease.expiresAt, nowMs),
    );
    if (hold) {
      return { granted: false, reason: 'limit-hold', retryAt: hold.expiresAt };
    }

    const ttlMs = clampTtlMs(request.ttlMs ?? DEFAULT_ACCOUNT_GRANT_TTL_MS);
    const leaseId = encodeGrantLeaseId(accountKey, request.runId);
    const response = await acquireLease('account', request.nodeId, { id: leaseId, ttlMs }, options);
    if (!response.acquired) {
      // The only way this specific (accountKey, runId) pair is already held is a duplicate/racing
      // request for the exact same grant — the closest named reason for a resource conflict on the
      // account itself. There is no numeric per-account concurrency ceiling configured anywhere in
      // this workspace today (Open questions Q2a: the spec explicitly refuses to guess that number),
      // so this reason does not (yet) fire for "too many concurrent runs on one account" — only for
      // this exact conflict.
      return { granted: false, reason: 'account-at-limit', retryAt: response.expiresAt };
    }

    const grant: ClusterAccountGrant = {
      accountKey,
      nodeId: request.nodeId,
      runId: request.runId,
      grantedAt: response.lease.acquiredAt,
      expiresAt: response.lease.expiresAt,
    };
    return { granted: true, grant };
  } catch (error) {
    reportWarning(
      options,
      `[cez] account grant for ${accountKey} could not reach the lease store — refusing (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
    return { granted: false, reason: 'no-lease' };
  }
}

/** Released at run end. A missed release costs one TTL, not a permanent phantom — which is why the
 *  grant carries an expiry rather than relying on this being called. */
export async function releaseAccountGrant(
  runId: string,
  nodeId: ClusterNodeId,
  options?: ClusterHomeOptions,
): Promise<boolean> {
  let held: StoredClusterLease[];
  try {
    held = await leasesHeldBy(nodeId, options);
  } catch (error) {
    reportWarning(
      options,
      `[cez] could not read leases held by ${nodeId} to release run ${runId} (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
    return false;
  }
  const lease = held.find((entry) => entry.kind === 'account' && decodeGrantLeaseId(entry.id)?.runId === runId);
  if (!lease) return false;
  try {
    return await releaseLease('account', lease.id, nodeId, options);
  } catch (error) {
    reportWarning(
      options,
      `[cez] could not release the account grant for run ${runId} (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
    return false;
  }
}

export interface AccountHoldReport {
  accountKey: string;
  nodeId: ClusterNodeId;
  /** The provider's own reset instant, when it gave one. Absent means "closed, reopening unknown" —
   *  which is a different state from "open", and must not be rendered as one. */
  resetsAt?: string;
  observedAt: string;
}

/** How long a hold stands when the provider did not say when it resets. Reuses
 *  `agent-account-usage.ts`'s own bound rather than inventing a second number for the same idea —
 *  see that file's `ASSUMED_LIMIT_COOLDOWN_MS` for why an unbounded hold would deadlock the fleet
 *  the same way an unbounded per-node `limited` entry deadlocks the balancer. */
function holdTtlMs(report: AccountHoldReport, nowMs: number): number {
  if (report.resetsAt) {
    const resetsAtMs = Date.parse(report.resetsAt);
    if (Number.isFinite(resetsAtMs)) {
      const untilReset = resetsAtMs - nowMs;
      if (untilReset > 0) return clampTtlMs(untilReset);
    }
  }
  return ASSUMED_LIMIT_COOLDOWN_MS;
}

/** A limit hold observed on ONE node parks every other node on that account. The hold is a fact
 *  about the account, not about the machine that happened to hit it — the whole reason this is
 *  hub-side and not per node. */
export async function reportAccountHold(
  report: AccountHoldReport,
  options?: ClusterHomeOptions,
): Promise<void> {
  const now = options?.now ?? (() => new Date());
  const nowMs = now().getTime();
  const ttlMs = holdTtlMs(report, nowMs);

  // Best-effort renewal detection only: if this node already holds the hold lease, pass its
  // fencingToken so this call re-asserts/extends it rather than racing a fresh acquire against
  // itself. A failure to read is not safety-critical here — either way we still attempt to record
  // the hold below, and the fact already stands the moment ANY node's report lands.
  let fencingToken: number | undefined;
  try {
    const existing = await readLeases(options);
    const current = existing.find((lease) => lease.kind === 'limit-hold' && lease.id === report.accountKey);
    if (current && current.holderNodeId === report.nodeId && isLive(current.expiresAt, nowMs)) {
      fencingToken = current.fencingToken;
    }
  } catch {
    // Degrade to a fresh acquire attempt below — see the comment above.
  }

  // Deliberately NOT wrapped to swallow errors: this is the write that makes the safety property
  // hold (E6). A caller that cannot record a fleet-wide hold needs to know, the same way a failed
  // write anywhere else that guards money or data is surfaced rather than eaten (CLAUDE.md → "fail
  // closed on any path that can lose money or data"). A refusal because another node already holds
  // it live is not an error: the fact it would have recorded already stands.
  const response = await acquireLease('limit-hold', report.nodeId, { id: report.accountKey, ttlMs, fencingToken }, options);
  if (!response.acquired) {
    reportWarning(
      options,
      `[cez] account hold for ${report.accountKey}: ${response.heldBy} already holds it until ${response.expiresAt} — leaving that hold in place`,
    );
  }
}

export interface ClusterAccountUtilisation {
  accountKey: string;
  /** Derived from live grants, never a persisted counter — see the module header. */
  activeGrants: number;
  byNode: Record<ClusterNodeId, number>;
  holdUntil?: string;
}

/** One coherent picture across the fleet. The cockpit's account rows read this rather than summing
 *  per-node numbers that were sampled at different instants. */
export async function clusterAccountUtilisation(
  options?: ClusterHomeOptions,
): Promise<ClusterAccountUtilisation[]> {
  const now = options?.now ?? (() => new Date());
  const nowMs = now().getTime();

  let leases: StoredClusterLease[];
  try {
    leases = await readLeases(options);
  } catch (error) {
    reportWarning(
      options,
      `[cez] cluster account utilisation: could not read the lease store, showing nothing (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
    return [];
  }

  const holds = new Map<string, StoredClusterLease>();
  const buckets = new Map<string, { activeGrants: number; byNode: Record<ClusterNodeId, number> }>();

  for (const lease of leases) {
    if (!isLive(lease.expiresAt, nowMs)) continue; // stale — never rendered as live headroom
    if (lease.kind === 'limit-hold') {
      holds.set(lease.id, lease);
      continue;
    }
    if (lease.kind !== 'account') continue;
    const decoded = decodeGrantLeaseId(lease.id);
    if (!decoded) continue; // foreign or corrupt row — salvage, not a crash
    const bucket = buckets.get(decoded.accountKey) ?? { activeGrants: 0, byNode: {} };
    bucket.activeGrants += 1;
    bucket.byNode[lease.holderNodeId] = (bucket.byNode[lease.holderNodeId] ?? 0) + 1;
    buckets.set(decoded.accountKey, bucket);
  }

  // Union of accounts with a live grant OR a live hold, so a held-but-currently-idle account still
  // shows up rather than disappearing the moment its last grant expires.
  const accountKeys = new Set<string>([...buckets.keys(), ...holds.keys()]);

  return Array.from(accountKeys, (accountKey) => {
    const bucket = buckets.get(accountKey) ?? { activeGrants: 0, byNode: {} };
    const hold = holds.get(accountKey);
    const entry: ClusterAccountUtilisation = {
      accountKey,
      activeGrants: bucket.activeGrants,
      byNode: bucket.byNode,
    };
    if (hold) entry.holdUntil = hold.expiresAt;
    return entry;
  });
}

/** Live grants, for the derive above and for a revoke. */
export async function readAccountGrants(options?: ClusterHomeOptions): Promise<ClusterAccountGrant[]> {
  const now = options?.now ?? (() => new Date());
  const nowMs = now().getTime();

  let leases: StoredClusterLease[];
  try {
    leases = await readLeases(options);
  } catch (error) {
    reportWarning(
      options,
      `[cez] account grants: could not read the lease store, showing nothing (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
    return [];
  }

  const grants: ClusterAccountGrant[] = [];
  for (const lease of leases) {
    if (lease.kind !== 'account') continue;
    if (!isLive(lease.expiresAt, nowMs)) continue;
    const decoded = decodeGrantLeaseId(lease.id);
    if (!decoded) continue;
    grants.push({
      accountKey: decoded.accountKey,
      nodeId: lease.holderNodeId,
      runId: decoded.runId,
      grantedAt: lease.acquiredAt,
      expiresAt: lease.expiresAt,
    });
  }
  return grants;
}

/**
 * D15: when the hub is unreachable at dispatch, the spoke balances **locally** and marks the
 * dispatch `unattributed` for the hub to reconcile. Nothing blocks on the link — a spoke with no hub
 * is an ordinary cezar cockpit. The reconciliation is what keeps the hub's utilisation honest
 * afterwards, rather than pretending the spend did not happen.
 */
export async function reconcileUnattributed(
  nodeId: ClusterNodeId,
  grants: readonly ClusterAccountGrant[],
  options?: ClusterHomeOptions,
): Promise<number> {
  const now = options?.now ?? (() => new Date());
  const nowMs = now().getTime();

  let reconciled = 0;
  for (const grant of grants) {
    if (grant.nodeId !== nodeId) {
      // Not this spoke's own record to reconcile — attributing it anyway would misrepresent whose
      // spend it was. Per-entry salvage: skip and keep going rather than aborting the batch.
      reportWarning(
        options,
        `[cez] reconcileUnattributed: grant for run ${grant.runId} names node ${grant.nodeId}, not ${nodeId} — skipped`,
      );
      continue;
    }
    const expiresAtMs = Date.parse(grant.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
      // Already expired by the time the link came back — nothing left to reserve, and forcing it
      // into the ledger would just create a phantom that has to expire again.
      continue;
    }
    try {
      const response = await acquireLease(
        'account',
        nodeId,
        { id: encodeGrantLeaseId(grant.accountKey, grant.runId), ttlMs: clampTtlMs(expiresAtMs - nowMs) },
        options,
      );
      if (response.acquired) reconciled += 1;
      // A refusal here means the hub already independently knows this exact grant (e.g. it was
      // already reconciled, or another node raced to the same id) — not an error, not double-counted.
    } catch (error) {
      reportWarning(
        options,
        `[cez] reconcileUnattributed: could not reconcile run ${grant.runId} on ${grant.accountKey} (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  }
  return reconciled;
}
