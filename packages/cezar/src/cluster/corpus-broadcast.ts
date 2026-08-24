import {
  CLUSTER_PROTOCOL,
  clusterCorpusChangedFrameSchema,
  type ClusterCorpusChangedFrame,
  type ClusterDownlinkFrame,
  type ClusterNodeId,
} from '@loki-labs/better-cezar-contract';

/**
 * The HUB side of the `corpus-changed` hint (spec `.ai/specs/2026-08-22-multi-node-cezar-
 * cluster.md`, handoff item **57**, contract `clusterCorpusChangedFrameSchema`). The hub's corpus
 * moved; tell every connected spoke so it sweeps now instead of waiting out its `intervalSeconds`
 * floor.
 *
 * **This module owns the reaction, not the trigger.** What actually changed the corpus on disk —
 * `POST /cluster/corpus/submit`, the reports-drain timer, `/cezar-sync`, a human edit picked up by
 * `knowledge/store.ts`'s own `fs.watch` — is decided elsewhere, by whoever wires `notifyChanged()`
 * up. That mirrors `knowledge/store.ts`'s own two-trigger posture for exactly the reason it states:
 * a single `fs.watch` is not trusted alone, so an explicit call and a filesystem watcher are both
 * legitimate ways to reach the same debounced reaction. `readCorpusVersion` is injected for the
 * same reason — `corpus-store.ts#buildManifest(...).corpusVersion` is the real source, owned by
 * another change in flight; this module only needs "a function that answers the current version".
 *
 * **The frame is a HINT — no paths, no bodies (item 57).** The spoke's answer to it is its own
 * ordinary `?since=` manifest sweep, which is authoritative and scope-enforced hub-side. Had this
 * frame carried the changed paths there would be two accounts of what changed, and a dropped frame
 * would be a silent GAP in a spoke's mirror. As a hint, a dropped frame costs latency only — the
 * spoke's interval sweep still catches it. That asymmetry is the whole design: never be tempted to
 * attach paths or bodies here just because a caller happens to know them.
 *
 * **Debounced, trailing-edge, same shape as `knowledge/store.ts#scheduleReindex`.** A corpus commit
 * touches many files in one burst — churn is measured at ~12 files/24h (item 56/57), so this is
 * about coalescing a single commit's writes into one frame, not about sustained rate. Each
 * `notifyChanged()` call resets the timer rather than queuing a fixed window, exactly like the
 * knowledge store's own per-root debounce, and for the same reason: a burst that is still landing
 * should keep pushing the fire time out rather than fire mid-burst. `CORPUS_BROADCAST_DEBOUNCE_MS`
 * reuses that module's own `DEBOUNCE_MS` (300ms) rather than inventing a second constant for the
 * same "one commit, many files" shape.
 *
 * **A `send()` failure is counted and warned, never silently dropped.** `link-server.ts:102`
 * documents a real past bug of this exact shape — a caller advanced a watermark on a `send` it
 * never checked. This module advances nothing on `send`'s result (there is no watermark here to
 * get wrong), so a `false` is not a correctness problem, but a hub whose sends are ALL silently
 * failing must not look identical to a hub with a quiet corpus — so every failure is folded into
 * one `warn()` call naming which nodes it missed.
 *
 * **Never throws into the caller.** This reacts to a filesystem-shaped event on the hub — a bad
 * `readCorpusVersion()`, a `link.send` that throws, a frame that somehow fails its own schema, all
 * degrade to a `warn()` and the broadcast is simply skipped this round. The next `notifyChanged()`
 * gets a fresh attempt.
 *
 * **Never touches the interval sweep.** Nothing here may disable, lengthen, or skip a spoke's poll
 * — see the module doc on `clusterCorpusChangedFrameSchema` for why the floor must stay a floor.
 */

/** Same value as `knowledge/store.ts`'s own `DEBOUNCE_MS`, and the same justification: one corpus
 *  commit's worth of file writes lands inside this window, not a sustained-rate budget. */
export const CORPUS_BROADCAST_DEBOUNCE_MS = 300;

/** Matches `clusterCorpusChangedFrameSchema`'s own `scope` cap — accumulated across a debounce
 *  burst, so this is a defensive ceiling, not an expected count (D8a names six scopes total). */
const MAX_SCOPE_ENTRIES = 32;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The two `ClusterLinkServer` primitives this module needs (`link-server.ts:593`/`:621`), taken as
 * an interface rather than the concrete class so a test never has to open a real socket.
 */
export interface CorpusBroadcastLink {
  connectedNodes(): readonly ClusterNodeId[];
  send(nodeId: ClusterNodeId, frame: ClusterDownlinkFrame): boolean;
}

export interface CorpusBroadcastSendResult {
  readonly total: number;
  readonly delivered: number;
  readonly failed: readonly ClusterNodeId[];
}

/**
 * The low-level half: given an already-built, already-valid frame, hand it to every currently
 * connected node and report what happened. No debounce, no version lookup — kept separate from
 * `createCorpusBroadcaster` below so "does this reach every connected node, and only connected
 * nodes" is testable without also driving a timer.
 *
 * Zero connected nodes is the ordinary "nobody is mirroring right now" case, not a failure: it
 * sends nothing and warns nothing.
 */
export function broadcastCorpusChangedFrame(
  link: CorpusBroadcastLink,
  frame: ClusterCorpusChangedFrame,
  warn: (message: string) => void = (message) => console.warn(message),
): CorpusBroadcastSendResult {
  const nodeIds = link.connectedNodes();
  const failed: ClusterNodeId[] = [];
  for (const nodeId of nodeIds) {
    let delivered: boolean;
    try {
      delivered = link.send(nodeId, frame);
    } catch (err) {
      delivered = false;
      warn(`cluster corpus broadcast: send to node "${nodeId}" threw: ${errorMessage(err)}`);
    }
    if (!delivered) failed.push(nodeId);
  }
  if (failed.length > 0) {
    warn(
      `cluster corpus broadcast: corpus-changed (version ${frame.corpusVersion}) did not reach ` +
        `${failed.length}/${nodeIds.length} connected node(s) [${failed.join(', ')}] — they fall ` +
        'back to their interval sweep, which still converges (item 57).',
    );
  }
  return { total: nodeIds.length, delivered: nodeIds.length - failed.length, failed };
}

export interface CorpusBroadcasterOptions {
  /** The hub link, or a fake exposing the same two methods. */
  link: CorpusBroadcastLink;
  /** Answers the hub's current corpus version — read fresh at debounce-fire time, never cached
   *  from when `notifyChanged()` was first called, so the version in the frame reflects the whole
   *  burst rather than just its first write. Owned elsewhere (`corpus-store.ts#buildManifest`). */
  readCorpusVersion: () => Promise<string>;
  /** Defaults to `CORPUS_BROADCAST_DEBOUNCE_MS`. Overridable so a test does not have to wait out
   *  300ms of real time per assertion. */
  debounceMs?: number;
  warn?: (message: string) => void;
}

export interface CorpusBroadcaster {
  /**
   * The trigger entry point. Call this whenever the corpus may have changed; this module does not
   * detect changes itself. Safe to call as often as the caller likes — a burst collapses into one
   * frame, debounced `debounceMs` after the LAST call in the burst.
   *
   * `scope` names which top-level corpus directories this particular change touched. Omit it (or
   * pass an empty array) when that is not known — same "unknown, sweep anyway" meaning the contract
   * gives an absent `scope`. Scopes from every call inside one debounce burst are unioned; if ANY
   * call in the burst omitted scope, the whole burst's frame omits it too (a spoke narrowing on
   * scope must never be told less than the truth because one caller happened to know more).
   */
  notifyChanged(scope?: readonly string[]): void;
  /** Cancels a pending debounced broadcast, if any, and drops accumulated scope. For graceful
   *  shutdown / test cleanup — never called by this module itself. */
  stop(): void;
}

export function createCorpusBroadcaster(options: CorpusBroadcasterOptions): CorpusBroadcaster {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const debounceMs = options.debounceMs ?? CORPUS_BROADCAST_DEBOUNCE_MS;
  const { link, readCorpusVersion } = options;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingScopes: Set<string> | undefined;
  let scopeUnknown = false;

  function resetPending(): void {
    pendingScopes = undefined;
    scopeUnknown = false;
  }

  async function runBroadcast(scope: string[] | undefined): Promise<void> {
    let corpusVersion: string;
    try {
      corpusVersion = await readCorpusVersion();
    } catch (err) {
      warn(`cluster corpus broadcast: could not read the corpus version — skipping this hint (${errorMessage(err)})`);
      return;
    }

    const candidate: ClusterCorpusChangedFrame = {
      type: 'corpus-changed',
      protocol: CLUSTER_PROTOCOL,
      corpusVersion,
      ...(scope && scope.length > 0 ? { scope } : {}),
    };
    const parsed = clusterCorpusChangedFrameSchema.safeParse(candidate);
    if (!parsed.success) {
      // Would mean a bug in the object built two lines up (e.g. corpusVersion empty/too long) —
      // never a caller error, since nothing here is caller-supplied except scope and the version.
      warn(`cluster corpus broadcast: built an invalid corpus-changed frame, dropping it (${parsed.error.message})`);
      return;
    }

    try {
      broadcastCorpusChangedFrame(link, parsed.data, warn);
    } catch (err) {
      warn(`cluster corpus broadcast: broadcasting corpus-changed threw: ${errorMessage(err)}`);
    }
  }

  function fire(): void {
    timer = undefined;
    const scope = scopeUnknown || !pendingScopes || pendingScopes.size === 0 ? undefined : [...pendingScopes].slice(0, MAX_SCOPE_ENTRIES);
    resetPending();
    void runBroadcast(scope);
  }

  return {
    notifyChanged(scope) {
      if (scope && scope.length > 0) {
        if (!scopeUnknown) {
          pendingScopes ??= new Set<string>();
          for (const s of scope) pendingScopes.add(s);
        }
      } else {
        scopeUnknown = true;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, debounceMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      resetPending();
    },
  };
}
