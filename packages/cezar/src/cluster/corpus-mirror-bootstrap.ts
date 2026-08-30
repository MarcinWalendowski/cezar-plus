import { CLUSTER_CORPUS_DEFAULT_SCOPE, type StoredClusterNodeIdentity } from '@loki-labs/cezar-plus-contract';
import { CEZAR_HUB_SOURCE_KIND } from '../sources/cezar-hub/provider.ts';
import { SourceStore } from '../sources/store.ts';
import { defaultIntervalSecondsForKind, type SourceConnection } from '../sources/types.ts';

/**
 * Closes the gap the 2026-08-24 handoff measured on production (spec
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, design **S5**, decision **D8a**):
 * `sources/cezar-hub/provider.ts` and its `SOURCE_PROVIDERS` row are real, but **nothing in
 * production ever creates a `cezar-hub` `SourceConnection`** — so a worker mirrors nothing,
 * forever, and the failure is silent: `knowledge/prompt.ts#loadKnowledgeSummary` returns
 * `undefined`, the agent's system prompt simply has no knowledge block, and a knowledge-blind
 * agent reports success.
 *
 * **S5 — the connection is provisioned by the cluster runtime, not by a human.** This is that
 * provisioning: given one project's `dataDir` and this node's own cluster identity, ensure a
 * `cezar-hub` connection exists in that project's `sources.json`, idempotently. It does not start
 * a sweep (`sources/sync.ts#runSourceSync` scheduling is separate — see that module and
 * `sources/scheduler.ts`), and it does not gate on `CEZ_SOURCES` — the store this opens is the
 * same on-disk file `server/project-context.ts#activateOptionalStores` opens when that flag is
 * set, so provisioning the connection before the flag is even on means nothing further blocks the
 * mirror once it is.
 *
 * **The connection lives per PROJECT, not once per node.** `sources.json` sits at
 * `<project.root>/.ai/cezar/sources.json` (`server/project-context.ts`'s own `dataDir`), and the
 * read side (`knowledge/prompt.ts#loadKnowledgeSummary(dataDir)`, and — with `CEZ_KB=1` — F1's own
 * `SourceSink` writing straight into that project's knowledge roots) is exactly as project-scoped.
 * So this function takes one `dataDir` and one caller loops it over every project this node should
 * mirror the corpus into — seen at the call site below.
 *
 * **Never throws into the boot path (constraint 3).** Every failure mode — no identity, this node
 * IS the hub, a spoke identity missing `hubUrl`, `SourceStore.open` itself throwing, `store.create`
 * / `store.update` throwing — comes back as a `CorpusMirrorBootstrapResult` with a named `reason`,
 * the same "warn and degrade" posture `startClusterRuntime` already uses for every other arm-time
 * check in this feature.
 */

/**
 * Fixed, deterministic id (matches `PROJECT_ID_RE`) rather than `randomUUID()` (`SourceStore`'s own
 * default): makes the connection findable by id for reconciliation, and means two arms racing at
 * the file level converge on ONE id instead of leaving two orphaned connections behind — see the
 * module's own "Called twice" test.
 *
 * **A tombstoned id is a human's decision, not a bug to route around.** If an operator deletes
 * this exact connection, `store.create` refuses to reuse its (tombstoned) id — this function does
 * NOT fall back to a fresh random id in that case, which would silently resurrect a mirror the
 * operator just turned off. That refusal surfaces as `status: 'failed'` below, with the reason
 * named, rather than as a duplicate connection under a different id.
 */
const CORPUS_MIRROR_CONNECTION_ID = 'cezar-hub-corpus-mirror';
const CORPUS_MIRROR_CONNECTION_NAME = 'cezar hub — corpus mirror';

/**
 * `maxDocuments`/`maxBodyBytes` are the schema's own defaults (5,000 docs / 512 KiB), which
 * comfortably cover the corpus measured 2026-08-24 (2,173 files / 13 MB).
 *
 * **`intervalSeconds` is NOT the schema default and must not be hardcoded** (corrected 2026-08-24,
 * same day as the original). It was `900`, copied from the field default — but the per-kind
 * interval policy landed the same day and gives `cezar-hub` a **60s** default and floor, against
 * the 300s that still protects rate-limited third-party connectors. A hardcoded 900 here is not
 * merely conservative: `corpus-mirror-runtime.ts` keeps its own 60s clock and never reads this
 * field, so the number would have been a **lie told to a human** reading `sources.json` — the file
 * would say the mirror syncs every 15 minutes while it actually syncs every minute. Ask the policy;
 * do not restate it. Two hand-kept copies of one number is what the policy table exists to prevent.
 */
const DEFAULT_MAX_DOCUMENTS = 5_000;
const DEFAULT_MAX_BODY_BYTES = 524_288;

export interface EnsureCorpusMirrorConnectionInput {
  /** This project's `<root>/.ai/cezar` directory — same value `server/project-context.ts`'s
   *  `build()` computes and passes to `SourceStore.open`. */
  dataDir: string;
  /** This node's own cluster identity, exactly as `cluster/node-identity.ts#loadNodeIdentity`
   *  returns it. `undefined` (never joined a cluster) and `role: 'hub'` both refuse — checked
   *  here, not left to the caller, so "only a spoke provisions this" cannot be skipped by calling
   *  this function from the wrong branch. */
  identity: StoredClusterNodeIdentity | undefined;
  /** Which top-level corpus directories to mirror. Defaults to `CLUSTER_CORPUS_DEFAULT_SCOPE` —
   *  every scope, per the owner's 2026-08-24 "everything should be on by default" instruction.
   *  Override to narrow a specific node (D8a's disposable-VPS-worker carve-out). Stored on the
   *  connection as a `.passthrough()` field for observability only — S4 places the live scope
   *  decision with whoever constructs the running provider (`deps.scope`), not with the stored
   *  connection; nothing here widens `SourceConnection`'s typed contract. */
  scope?: readonly string[];
  now?: () => Date;
  warn?: (message: string) => void;
}

export type CorpusMirrorBootstrapStatus =
  | 'created'
  | 'already-provisioned'
  | 'reconciled-hub-url'
  | 'skipped-no-identity'
  | 'skipped-hub-node'
  | 'skipped-no-hub-url'
  | 'failed';

export interface CorpusMirrorBootstrapResult {
  status: CorpusMirrorBootstrapStatus;
  connectionId?: string;
  /** Present on every non-`'created'`/`'already-provisioned'` outcome — the named reason `warn()`
   *  was also given, so a caller that only has the return value (as every test here does) can
   *  assert on the same words a human would see in the log. */
  reason?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Reads a `.passthrough()` field back off a stored connection without widening
 *  `SourceConnection`'s typed shape — mirrors how `sources-routes.ts` never assumes an unlisted
 *  field beyond what it explicitly maps. */
function stringField(connection: SourceConnection, key: string): string | undefined {
  const value = (connection as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

export function ensureCorpusMirrorConnection(input: EnsureCorpusMirrorConnectionInput): CorpusMirrorBootstrapResult {
  const warn = input.warn ?? ((message: string) => console.warn(message));
  const identity = input.identity;

  if (!identity) {
    const reason = 'this node has no cluster identity on disk yet — arming nothing until it joins a cluster';
    warn(`cluster corpus mirror: ${reason}`);
    return { status: 'skipped-no-identity', reason };
  }

  // S5 + D8a's own framing: a hub does not mirror itself, the corpus is already on disk there.
  if (identity.role === 'hub') {
    const reason = 'this node IS the hub — the corpus is already on disk here, refusing to mirror it to itself';
    return { status: 'skipped-hub-node', reason };
  }

  const hubUrl = identity.hubUrl;
  if (!hubUrl) {
    const reason = "this node's identity is a spoke with no hubUrl recorded — arming nothing until it re-enrolls";
    warn(`cluster corpus mirror: ${reason}`);
    return { status: 'skipped-no-hub-url', reason };
  }

  const scope = input.scope && input.scope.length > 0 ? [...input.scope] : [...CLUSTER_CORPUS_DEFAULT_SCOPE];

  let store: SourceStore;
  try {
    store = SourceStore.open(input.dataDir, { now: input.now, warn });
  } catch (err) {
    const reason = `could not open the sources store at "${input.dataDir}": ${errorMessage(err)}`;
    warn(`cluster corpus mirror: ${reason}`);
    return { status: 'failed', reason };
  }

  // Idempotency check is a KIND scan, not an id lookup — an operator's own hand-created cezar-hub
  // connection (a custom name, a narrower `maxDocuments`, whatever) counts as "already has one"
  // exactly as much as one this function created itself. "Leave it alone" means all of it, not
  // just the fields we happen to recognize.
  const existing = store.list().find((connection) => connection.kind === CEZAR_HUB_SOURCE_KIND);
  if (existing) {
    const storedHubUrl = stringField(existing, 'hubUrl');
    if (storedHubUrl === hubUrl) {
      return { status: 'already-provisioned', connectionId: existing.id };
    }
    // Re-enrolled against a different hub since this connection was created — the stored pointer
    // is now provably stale. Reconcile ONLY `hubUrl`; every other field (including `scope`, which
    // an operator may have deliberately narrowed) is carried through unchanged — "leave it alone"
    // still holds for everything this function did not just prove wrong.
    try {
      // `store.update` itself merges `{...current, ...input}` before persisting (`store.ts`), so
      // every OTHER passthrough field on `existing` (in particular `scope`) survives this update
      // untouched without being restated here — only the fields this function must actively
      // decide (the required, typed ones, plus the one field being reconciled) are listed.
      const reconciled = store.update(existing.id, existing.revision, {
        kind: existing.kind,
        name: existing.name,
        enabled: existing.enabled,
        mode: existing.mode,
        intervalSeconds: existing.intervalSeconds,
        collections: existing.collections,
        watchComments: existing.watchComments,
        maxDocuments: existing.maxDocuments,
        maxBodyBytes: existing.maxBodyBytes,
        hubUrl,
      } as Omit<SourceConnection, 'id' | 'revision' | 'createdAt' | 'updatedAt'>);
      warn(
        `cluster corpus mirror: connection "${existing.id}" pointed at a stale hub ` +
          `(${storedHubUrl ?? '(none)'}) — reconciled to ${hubUrl} after this node re-enrolled`,
      );
      return { status: 'reconciled-hub-url', connectionId: reconciled.id };
    } catch (err) {
      const reason = `found a stale hub pointer on connection "${existing.id}" (was ${storedHubUrl ?? '(none)'}, now ${hubUrl}) but could not reconcile it: ${errorMessage(err)}`;
      warn(`cluster corpus mirror: ${reason}`);
      return { status: 'failed', connectionId: existing.id, reason };
    }
  }

  try {
    const connection = store.create(
      {
        kind: CEZAR_HUB_SOURCE_KIND,
        name: CORPUS_MIRROR_CONNECTION_NAME,
        enabled: true,
        mode: 'mirror',
        intervalSeconds: defaultIntervalSecondsForKind(CEZAR_HUB_SOURCE_KIND),
        collections: [],
        watchComments: false,
        maxDocuments: DEFAULT_MAX_DOCUMENTS,
        maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
        hubUrl,
        scope,
      } as Omit<SourceConnection, 'id' | 'revision' | 'createdAt' | 'updatedAt'>,
      CORPUS_MIRROR_CONNECTION_ID,
    );
    return { status: 'created', connectionId: connection.id };
  } catch (err) {
    const message = errorMessage(err);
    const reason = message.includes('unavailable')
      ? `connection id "${CORPUS_MIRROR_CONNECTION_ID}" is unavailable (likely tombstoned by a prior ` +
        'delete) — not resurrecting it under a new id, which would fight that deletion'
      : `could not create the corpus mirror connection: ${message}`;
    warn(`cluster corpus mirror: ${reason}`);
    return { status: 'failed', reason };
  }
}
