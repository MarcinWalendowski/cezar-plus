import {
  CLUSTER_PROTOCOL,
  type ClusterDownlinkFrame,
  type ClusterFreshnessFrame,
  type ClusterPresenceFrame,
  type ClusterUplinkFrame,
} from '@loki-labs/better-cezar-contract';
import { collectPresence as collectClusterPresence } from './peers.ts';

/**
 * The spoke's own presence loop, and its answer to everything the hub sends down the link (spec
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D8a · D11 · D12a · D13 · D15).
 *
 * **This makes a node LINKED and VISIBLE. It does not make it USEFUL yet.** Every `heartbeatMs` it
 * reports capacity, host metrics and repo drift (D14/D14a) over `link.send`, so the roster and the
 * cockpit's Settings section (Phase 1b) stop lying about who is out there. Two things this module
 * deliberately does NOT do, both later milestones — do not read "handles downlink frames" as either:
 *
 *  - **Replication is not applied.** A `replica` frame is logged and dropped, on purpose.
 *    `replica.ts#applyReplicaFrame` exists and has no production caller yet — wiring it needs the
 *    todo store's replicated-apply plumbing, which belongs to a later milestone, not this one.
 *  - **Dispatched work is refused, not run.** This node cannot execute a foreign `dispatch` yet, so
 *    it answers with a `freshness` frame carrying `refused: { reason: 'dispatch-not-accepted' }`
 *    rather than staying silent — a hub that hears nothing back cannot tell "refused" from "dead
 *    link" from "crashed mid-run" (D12a's whole point: named reasons, never absence).
 *
 * **The heartbeat never queues a missed beat.** `send()` returning `false` means the link is
 * offline, reconnecting, or over its per-tick send budget — a normal transient state, not an error
 * (`link-client.ts`'s own doc). A presence frame is a claim about *now*; the hub stamps whatever it
 * receives with its OWN arrival time (`peers.ts#markNodeSeen` → `capacityAt`), so replaying a
 * backlog of missed beats on reconnect would let a machine that has slept for an hour arrive
 * claiming "capacity as of an hour ago", stamped as current. Every tick computes a fresh presence
 * and attempts exactly one send; nothing is buffered between ticks, so there is nothing to replay.
 */

/** Matches the hub's own expected presence cadence. */
const DEFAULT_HEARTBEAT_MS = 30_000;

/** The subset of `ClusterLinkClient` this runtime needs — narrowed so a test can drive it with a
 *  plain fake and no socket. */
export interface SpokeLink {
  send(frame: ClusterUplinkFrame): boolean;
  on(event: 'frame', listener: (frame: ClusterDownlinkFrame) => void): unknown;
  off(event: 'frame', listener: (frame: ClusterDownlinkFrame) => void): unknown;
}

export interface SpokeRuntimeDeps {
  link: SpokeLink;
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
  /** Default 30_000. */
  heartbeatMs?: number;
  /** Test hook; defaults to `cluster/peers.ts#collectPresence`. */
  collectPresence?: () => Promise<ClusterPresenceFrame>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Wires the presence heartbeat and downlink handling onto an already-dialled `SpokeLink`.
 *
 * Returns a disposer that stops the heartbeat and detaches every listener. Idempotent.
 */
export function startSpokeRuntime(deps: SpokeRuntimeDeps): () => void {
  const warn = deps.warn;
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const collectPresence =
    deps.collectPresence ?? ((): Promise<ClusterPresenceFrame> => collectClusterPresence({ env: deps.env, warn }));

  let disposed = false;
  // Guards against a slow `collectPresence()` still being in flight when the next tick fires —
  // never two overlapping presence collections (git subprocesses) racing each other.
  let beatInFlight = false;
  // Set on the first missed beat of an outage, cleared on the next delivered one — so a long
  // outage warns ONCE, not once per missed beat.
  let outageWarned = false;

  const beat = async (): Promise<void> => {
    if (disposed || beatInFlight) return;
    beatInFlight = true;
    try {
      let frame: ClusterPresenceFrame;
      try {
        frame = await collectPresence();
      } catch (err) {
        warn?.(`cluster spoke: presence collection failed, skipping this beat: ${errorMessage(err)}`);
        return;
      }
      if (disposed) return; // dispose() ran while collectPresence() was in flight
      const sent = deps.link.send(frame);
      if (sent) {
        outageWarned = false;
      } else if (!outageWarned) {
        outageWarned = true;
        warn?.(
          'cluster spoke: presence heartbeat not delivered (link offline or over budget) — will keep beating silently until it recovers',
        );
      }
    } finally {
      beatInFlight = false;
    }
  };

  const handleDispatch = async (dispatchId: string, projectKey: string): Promise<void> => {
    let presence: ClusterPresenceFrame;
    try {
      presence = await collectPresence();
    } catch (err) {
      warn?.(`cluster spoke: cannot decline dispatch ${dispatchId} — presence collection failed: ${errorMessage(err)}`);
      return;
    }
    if (disposed) return;
    const drift = presence.repoDrift.find((d) => d.projectKey === projectKey);
    if (!drift) {
      // `clusterFreshnessFrameSchema` extends the repo-freshness fields (headSha, ahead, behind,
      // dirty, merging) UNCONDITIONALLY — even a plain "not accepted" refusal has to carry them.
      // Without a matching `repoDrift` entry (project not paired/confirmed on this node) there is
      // no truthful value for any of them, and fabricating one puts a lie on the wire. Decline to
      // answer at all rather than decline falsely.
      warn?.(
        `cluster spoke: cannot decline dispatch ${dispatchId} truthfully — no repo-freshness data for project "${projectKey}" (not paired/confirmed here)`,
      );
      return;
    }
    const decline: ClusterFreshnessFrame = {
      type: 'freshness',
      protocol: CLUSTER_PROTOCOL,
      projectKey: drift.projectKey,
      headSha: drift.headSha,
      ahead: drift.ahead,
      behind: drift.behind,
      dirty: drift.dirty,
      merging: drift.merging,
      refused: { dispatchId, reason: 'dispatch-not-accepted' },
    };
    if (!deps.link.send(decline)) {
      warn?.(
        `cluster spoke: could not deliver the decline for dispatch ${dispatchId} (link offline) — the next presence beat is the fallback`,
      );
    }
  };

  const onFrame = (frame: ClusterDownlinkFrame): void => {
    if (disposed) return;
    switch (frame.type) {
      case 'dispatch':
        handleDispatch(frame.dispatchId, frame.projectKey).catch((err: unknown) => {
          warn?.(`cluster spoke: dispatch handling threw for ${frame.dispatchId}: ${errorMessage(err)}`);
        });
        break;
      case 'replica':
        // Not wired in this increment — see the module doc. `frame.projectKey` is absent for a
        // cluster-scope change, so fall back to `scope` rather than rendering "undefined".
        warn?.(
          `cluster spoke: ignoring replicated changes for ${frame.projectKey ?? frame.scope} — replication is not wired in this build`,
        );
        break;
      case 'relay':
        warn?.(`cluster spoke: relay requested for run ${frame.runId} — relay is not built yet`);
        break;
      case 'welcome':
      case 'refuse':
      case 'ack':
        // 'welcome'/'refuse' are owned by `ClusterLinkClient` itself; 'ack' is expected traffic
        // that needs no action here. None of the three is a gap, so none warns.
        break;
    }
  };

  deps.link.on('frame', onFrame);
  beat().catch((err: unknown) => {
    warn?.(`cluster spoke: initial presence beat threw: ${errorMessage(err)}`);
  });
  const timer = setInterval(() => {
    beat().catch((err: unknown) => {
      warn?.(`cluster spoke: presence beat threw: ${errorMessage(err)}`);
    });
  }, heartbeatMs);
  // A CLI process must be able to exit with a link still open; the heartbeat must never be the
  // thing holding the event loop alive.
  timer.unref?.();

  return (): void => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    deps.link.off('frame', onFrame);
  };
}
