import { join } from 'node:path';
import type { StoredClusterNodeIdentity } from '@loki-labs/better-cezar-contract';
import { createCezarHubSourceProvider, type CezarHubSourceProviderOptions } from '../sources/cezar-hub/provider.ts';
import { FileSourceSink } from '../sources/sink.ts';
import { SourceStore } from '../sources/store.ts';
import { runSourceSync, type SourceSyncOptions, type SourceSyncResult } from '../sources/sync.ts';
import type { SourceProvider } from '../sources/provider-types.ts';
import type { SourceConnection, SourceSink } from '../sources/types.ts';
import { ensureCorpusMirrorConnection, type EnsureCorpusMirrorConnectionInput } from './corpus-mirror-bootstrap.ts';

/**
 * The keystone the 2026-08-24 handoff measured missing (spec
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, item **56** / D8a / **S5**, cadence item
 * **57**): `corpus-mirror-bootstrap.ts` provisions a `cezar-hub` `SourceConnection`, but nothing
 * ever DRIVES it — `sources/scheduler.ts#WorkspaceSourceScheduler` has zero production
 * constructors (its own docblock: *"Nothing wires this scheduler into the boot flow yet"*), so a
 * provisioned connection sat forever unswept, silently: `knowledge/prompt.ts#loadKnowledgeSummary`
 * returns `undefined`, the agent's system prompt has no knowledge block, and a knowledge-blind
 * agent reports success. This file closes that gap for a SPOKE: provision, then keep sweeping,
 * forever, on a floor interval, plus immediately whenever the hub hints the corpus moved.
 *
 * **Deliberately NOT `WorkspaceSourceScheduler`.** That scheduler's `intervalSeconds`/`nextDueAt`
 * machinery is built for a workspace of arbitrary, independently-configured connections (Notion,
 * ...) and is unwired for a reason bigger than this package — see its own docblock. The corpus
 * mirror is cluster infrastructure with exactly one connection kind, one fixed floor (item 57), and
 * a PUSH half the generic scheduler has no frame to receive. Reusing it here would mean either
 * wiring the whole coordinator/`ProjectSourceHandle` abstraction for a single always-known kind, or
 * fighting its `nextDueAt` persistence to get push-then-coalesce semantics it was never built for.
 * A small, purpose-built interval + trigger, sitting entirely in this one new file, is the honest
 * shape — `ensureCorpusMirrorConnection` and `runSourceSync` are called, never reimplemented.
 *
 * **Not gated on `CEZ_SOURCES`, on purpose (constraint 5 of the dispatch brief).** That flag gates
 * the user-facing external-connector feature — Notion et al.'s routes, UI, and store
 * (`server/project-context.ts#activateOptionalStores`). The corpus mirror is cluster
 * infrastructure the cluster feature itself depends on; making it depend on an unrelated,
 * independently-toggled feature flag would be a hidden coupling that fails silently (a cluster
 * node with `CEZ_SOURCES` unset would link up looking healthy and mirror nothing, with no error
 * anywhere naming why). `corpus-mirror-bootstrap.ts` already takes this position — opening its own
 * `SourceStore` directly rather than reading the flag — and this file follows the same posture for
 * the same reason.
 *
 * **Spoke only.** A hub's corpus is already on disk where it lives; `ensureCorpusMirrorConnection`
 * already refuses to provision on a hub, but that check alone would still arm a 60s timer on a hub
 * that does nothing every tick. `startCorpusMirrorRuntime` checks the SAME identity up front and
 * arms no timer at all when this node is a hub, or has no cluster identity yet, or (a spoke with a
 * corrupt/hand-edited identity file) has no `hubUrl` — three names for "nothing to mirror into",
 * each returned as a distinct, named `status` rather than folded into one.
 *
 * **Interval is a fixed floor this file owns, never `connection.intervalSeconds`.** Item 57: *"push
 * is the optimization, the interval is what bounds a lost push … the interval stays a floor and
 * must never be raised to 'we have push now'."* `DEFAULT_INTERVAL_MS` (60_000) is that floor,
 * armed unconditionally by `startCorpusMirrorRuntime` and never touched by `triggerSweep`. The
 * connection's own `intervalSeconds` (used by `WorkspaceSourceScheduler`'s `nextDueAt` machinery,
 * which nothing wires up for this connection — see above) plays no role here; this runtime is its
 * own, independent clock. **Known divergence, flagged rather than silently left**:
 * `corpus-mirror-bootstrap.ts`'s `DEFAULT_INTERVAL_SECONDS` still hardcodes 900s (pre-dating the
 * `cezar-hub`-kind 60s floor `sources/types.ts#SOURCE_KIND_INTERVAL_POLICY` now allows) — that
 * stored value is cosmetic for this runtime (never read for cadence), but misleading to a human
 * reading `sources.json` expecting it to reflect real behaviour. Left to `corpus-mirror-bootstrap.ts`'s
 * owner, not fixed here (out of this package's file scope).
 *
 * **Coalescing (constraint 4).** `runSourceSync`'s own lease (`store.acquireLease()`) refuses a
 * concurrent run and returns silently (`notRunResult`) — relying on that ALONE would mean a push
 * arriving mid-sweep is simply lost, which is exactly the silent-gap failure mode D8a is written
 * against. This file adds a layer above the lease: `sweeping` + `followUpRequested` flags, so a
 * trigger arriving while a sweep is in flight (from the timer OR another push) never starts a
 * second concurrent pass, but always causes exactly ONE more pass once the current one finishes —
 * see `runCycle` below. A burst of N triggers during one in-flight sweep costs at most 2 sweep
 * passes total (the one already running, plus one coalesced follow-up), never N, and never zero.
 *
 * **A sweep failure never stops the timer (constraint 6).** Every layer here —
 * `listProjects`, `ensureConnection`, `openStore`, `createProvider`, `createSink`, `runSync` — is
 * wrapped so a thrown/rejected failure is `warn()`-ed and the sweep pass simply ends; the interval
 * that scheduled it, and any later push, are untouched. `dispose()`'s timer is `unref()`'d so a CLI
 * process can still exit with a corpus mirror armed.
 */

const DEFAULT_INTERVAL_MS = 60_000;

export type CorpusMirrorRuntimeStatus = 'armed' | 'refused-no-identity' | 'refused-hub-node' | 'refused-no-hub-url';

export interface CorpusMirrorRuntimeHandle {
  status: CorpusMirrorRuntimeStatus;
  /** Present on every `refused-*` status — see `ensureCorpusMirrorConnection`'s own
   *  `CorpusMirrorBootstrapResult#reason` for the sibling convention this mirrors. */
  reason?: string;
  /**
   * Sweep now instead of waiting for the interval — this is what
   * `spoke-runtime.ts#SpokeRuntimeDeps.onCorpusChanged` should be wired to (wrap it:
   * `onCorpusChanged: () => handle.triggerSweep()`; the frame itself carries no paths/bodies to
   * read, item 57's whole design). Never throws and never rejects — a failure is `warn()`-ed, same
   * as an interval-driven sweep. Safe to call on a `refused-*` handle (resolves immediately, does
   * nothing) so a caller need not branch on `status` before wiring this up.
   *
   * The returned promise resolves once every pass this call caused — including a coalesced
   * follow-up if this call arrived mid-sweep — has finished; it does NOT mean this call started a
   * NEW pass (see `runCycle`'s doc for why joining an in-flight cycle is the correct behaviour for
   * coalescing, and why "did this call wait for the interval" is still answerable from a test: the
   * first sweep pass of any cycle starts synchronously with the triggering call, before any
   * `await` back to the caller).
   */
  triggerSweep: () => Promise<void>;
  /** Stops the interval timer and refuses every future `triggerSweep`. Idempotent. Does not abort
   *  a sweep pass already in flight — that pass still finishes and reports the same way it always
   *  would; this only guarantees nothing NEW starts after it returns. */
  dispose: () => void;
}

export interface CorpusMirrorRuntimeDeps {
  /** This node's cluster identity, exactly as `cluster/node-identity.ts#loadNodeIdentity` returns
   *  it — a single snapshot read once at `startCorpusMirrorRuntime` time (matching
   *  `corpus-mirror-bootstrap.ts`'s own input shape), not re-read per tick. A re-enrollment onto a
   *  different hub while this runtime is already running is out of this file's scope — restart the
   *  runtime with the fresh identity, the same way any other identity-derived cluster component
   *  would need to. */
  identity: StoredClusterNodeIdentity | undefined;
  /**
   * Which projects to mirror the corpus into, as `<root>/.ai/cezar` `dataDir` values — the same
   * shape `corpus-mirror-bootstrap.ts#EnsureCorpusMirrorConnectionInput.dataDir` and
   * `server/project-context.ts#build()` use. A function, not a static array, and re-invoked at the
   * START of every sweep pass (interval or push): a project confirmed after this runtime starts
   * (a new pairing) begins mirroring on the very next pass with no restart, the same "discovered
   * from disk, not injected once" posture `spoke-runtime.ts#discoverOutboxProjects` already gives
   * the todo outbox flush.
   */
  listProjects: () => Promise<readonly string[]> | readonly string[];
  /** Forwarded verbatim to `ensureCorpusMirrorConnection` on every sweep pass, and to the
   *  constructed provider (S4: "scope is a per-node value the node reports"). Omit to use
   *  `ensureCorpusMirrorConnection`'s own default (every scope) — see that function's doc. */
  scope?: readonly string[];
  /** Default `DEFAULT_INTERVAL_MS` (60_000) — the floor. See this module's header before changing
   *  it: it is a deliberate spec value (item 57), not a tuning knob. */
  intervalMs?: number;
  now?: () => Date;
  warn?: (message: string) => void;
  /** Test seam; defaults to the real `ensureCorpusMirrorConnection`. */
  ensureConnection?: (input: EnsureCorpusMirrorConnectionInput) => ReturnType<typeof ensureCorpusMirrorConnection>;
  /** Test seam; defaults to the real `runSourceSync`. Every negative-half test in this module's
   *  suite injects a fake here (and for `ensureConnection` below) specifically so no test needs
   *  real fs, real network, or real timers. */
  runSync?: (options: SourceSyncOptions) => Promise<SourceSyncResult>;
  /** Test seam; defaults to `SourceStore.open`. */
  openStore?: (dataDir: string) => SourceStore;
  /** Test seam; defaults to a thin wrapper over `createCezarHubSourceProvider`. */
  createProvider?: (connection: SourceConnection, options: CezarHubSourceProviderOptions) => SourceProvider;
  /** Test seam; defaults to `new FileSourceSink(dataDir, connectionId, { now })`. */
  createSink?: (dataDir: string, connectionId: string) => SourceSink;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Reads a `.passthrough()` field back off a stored connection without widening
 *  `SourceConnection`'s typed shape — same posture as `corpus-mirror-bootstrap.ts#stringField`,
 *  for the array-valued `scope` field instead of a string one. */
function storedScope(connection: SourceConnection): readonly string[] | undefined {
  const value = (connection as Record<string, unknown>).scope;
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? (value as string[]) : undefined;
}

function noopHandle(status: CorpusMirrorRuntimeStatus, reason: string): CorpusMirrorRuntimeHandle {
  return {
    status,
    reason,
    triggerSweep: () => Promise.resolve(),
    dispose: () => {},
  };
}

export function startCorpusMirrorRuntime(deps: CorpusMirrorRuntimeDeps): CorpusMirrorRuntimeHandle {
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const now = deps.now ?? (() => new Date());
  const identity = deps.identity;

  // Same three gates `ensureCorpusMirrorConnection` applies per project, applied here ONCE before
  // arming anything — a hub (or an identity-less/hubUrl-less node) gets no timer at all, not a
  // timer that ticks forever calling a bootstrap that always refuses.
  if (!identity) {
    const reason = 'this node has no cluster identity on disk yet — arming no corpus mirror timer until it joins a cluster';
    warn(`cluster corpus mirror: ${reason}`);
    return noopHandle('refused-no-identity', reason);
  }
  if (identity.role === 'hub') {
    const reason = 'this node IS the hub — arming no corpus mirror timer (a hub does not mirror itself)';
    return noopHandle('refused-hub-node', reason);
  }
  if (!identity.hubUrl) {
    const reason = "this node's identity is a spoke with no hubUrl recorded — arming no corpus mirror timer until it re-enrolls";
    warn(`cluster corpus mirror: ${reason}`);
    return noopHandle('refused-no-hub-url', reason);
  }
  // Rebound to a definitely-non-undefined const: the three guards above narrow `identity` at THIS
  // point in the function body, but that narrowing does not carry into the nested closures below
  // (`sweepProject` et al.) — a plain TS limitation for captured outer variables, not a real
  // possibility of `identity` becoming undefined later.
  const nodeIdentity: StoredClusterNodeIdentity = identity;

  const ensureConnection = deps.ensureConnection ?? ensureCorpusMirrorConnection;
  const runSync = deps.runSync ?? runSourceSync;
  const openStore = deps.openStore ?? ((dataDir: string) => SourceStore.open(dataDir, { now, warn }));
  const createProvider =
    deps.createProvider ??
    ((connection: SourceConnection, options: CezarHubSourceProviderOptions): SourceProvider => createCezarHubSourceProvider(connection, options));
  const createSink = deps.createSink ?? ((dataDir: string, connectionId: string): SourceSink => new FileSourceSink(dataDir, connectionId, { now }));

  /**
   * One provider instance per connection, reused across sweeps.
   *
   * **This is what makes "a no-change sweep costs exactly ONE request" true in production rather
   * than only in a test.** The provider coalesces `detect()` and `pollChanges()` onto a single
   * manifest fetch using in-memory state (keyed `scope|since`), and `detect()` cannot be handed the
   * persisted `corpusVersion` — its interface takes no arguments — so it relies on the instance's
   * own `lastKnownCorpusVersion`. Constructing a fresh provider each sweep throws that away, and
   * every tick then costs TWO requests: `detect()`'s full-manifest probe (2,173 doc entries, no
   * `since`) plus `pollChanges()`'s real delta. `WorkspaceSourceScheduler` has exactly that
   * behaviour (`resolveSourceProvider` per tick, no caching) and this runtime originally copied it.
   *
   * Keyed by connection id and cleared on dispose. Safe to hold: the provider carries no
   * per-sweep state beyond that cache, and `runSourceSync`'s lease — not the provider — is what
   * serializes overlapping work.
   */
  const providersByConnection = new Map<string, SourceProvider>();

  let disposed = false;
  let sweeping = false;
  let followUpRequested = false;
  let currentCycle: Promise<void> | null = null;

  async function sweepProject(dataDir: string): Promise<void> {
    const bootstrap = ensureConnection({ dataDir, identity: nodeIdentity, scope: deps.scope, now, warn });
    if (!bootstrap.connectionId) return; // ensureConnection itself already warned the named reason

    const store = openStore(dataDir);
    const connection = store.get(bootstrap.connectionId);
    if (!connection) {
      warn(
        `cluster corpus mirror: connection "${bootstrap.connectionId}" was just provisioned for "${dataDir}" but is missing from the store — skipping this pass`,
      );
      return;
    }

    const providerOptions: CezarHubSourceProviderOptions = {
      hubUrl: nodeIdentity.hubUrl,
      nodeId: nodeIdentity.nodeId,
      secret: nodeIdentity.secret,
      scope: deps.scope ?? storedScope(connection),
      now: () => now().getTime(),
    };
    let provider = providersByConnection.get(connection.id);
    if (!provider) {
      provider = createProvider(connection, providerOptions);
      providersByConnection.set(connection.id, provider);
    }
    const sink = createSink(dataDir, connection.id);

    await runSync({ connection, store, sink, provider, mirrorRoot: join(dataDir, 'sources'), now });
  }

  async function sweepOnce(): Promise<void> {
    let projects: readonly string[];
    try {
      projects = await deps.listProjects();
    } catch (err) {
      warn(`cluster corpus mirror: could not list projects to mirror: ${errorMessage(err)}`);
      return;
    }
    for (const dataDir of projects) {
      try {
        await sweepProject(dataDir);
      } catch (err) {
        warn(`cluster corpus mirror: sweep failed for "${dataDir}": ${errorMessage(err)}`);
      }
    }
  }

  /**
   * The coalescing engine. `followUpRequested` is a boolean, not a counter or a queue — any number
   * of triggers arriving while `sweeping` is true collapse into exactly one more pass through the
   * `do/while` below, run only after the CURRENT pass finishes. A trigger that arrives after this
   * cycle has already re-checked `followUpRequested` (i.e. during its own final pass, with nothing
   * else queued) starts a brand new cycle rather than joining this one — `sweeping` is still true
   * at that instant so it is folded into THIS cycle's next iteration instead; the two cases are
   * indistinguishable to a caller and both honour "never drop a push, never stack sweeps".
   */
  async function runCycle(): Promise<void> {
    sweeping = true;
    try {
      do {
        followUpRequested = false;
        await sweepOnce();
      } while (followUpRequested && !disposed);
    } finally {
      sweeping = false;
      currentCycle = null;
    }
  }

  function triggerSweep(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (sweeping) {
      followUpRequested = true;
      return currentCycle ?? Promise.resolve();
    }
    const cycle = runCycle();
    currentCycle = cycle;
    return cycle;
  }

  const timer = setInterval(() => {
    void triggerSweep();
  }, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    // Drop the cached providers with the timer. A disposed runtime holding live provider instances
    // would keep their manifest caches (and the node secret they close over) reachable for as long
    // as the handle is referenced.
    providersByConnection.clear();
  }

  return { status: 'armed', triggerSweep, dispose };
}
