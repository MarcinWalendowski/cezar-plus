import type {
  ClusterDispatchFrame,
  ClusterDispatchRefusalReason,
  ClusterFreshnessFrame,
  ClusterNodeId,
  ClusterPlacementResult,
  ClusterProjectKey,
} from '@loki-labs/better-cezar-contract';
import { buildDispatch, type BuildDispatchInput } from './dispatch.ts';
import { placeRun, type PlacementCandidate, type PlacementRequest } from './placement.ts';
import type { ClusterHomeOptions } from './node-identity.ts';
import type { ClusterLinkServer } from './link-server.ts';

/**
 * Milestone C, steps 1+2 and decision C-f (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`,
 * "Milestone C — THE PLAN, surveyed and decided 2026-08-23"): the HUB's half of a dispatch —
 * placing a run, emitting the frame, and remembering the attempt long enough to learn how it
 * ended. `placement.ts` (`placeRun`) and `dispatch.ts` (`buildDispatch`) are both pure and both
 * fully tested with zero production callers before this file; this is what makes them reachable.
 *
 * **This module decides WHERE and SENDS; it never starts a run, and nothing here is wired into a
 * live run-start trigger.** `dispatch()` is a function a future caller invokes when a todo needs
 * placing — "a caller that picks a node when a run starts" (Milestone C step 1) — but no such
 * caller exists yet in this change; wiring one up is a behavioural change to a production hub
 * (`prod-host`) and is deliberately left for later. What that caller would need: the same
 * `todoId`/`workflow`/`request`/`candidates` shape `HubDispatchInput` already takes, resolved the
 * way `todo-autostart.ts#startAutostartTodo` resolves them for a LOCAL start (C-a) — this module
 * intentionally does not resolve them itself, so a wiring caller has to bring the roster.
 *
 * **C-f — what this module answers.** `hub-router.ts`'s `freshness` case used to say of itself:
 * *"nothing downstream (dispatch, placement, the cockpit) can read a freshness claim this handler
 * received."* `recordFreshnessReply` is that downstream: `hub-router.ts` now accepts an optional
 * `HubDispatchCorrelationDeps` and, when a caller wires one, routes every `freshness` reply here.
 * `dispatchId` — minted once, in `buildDispatch`, "precisely to correlate an attempt that never
 * became a run" (`dispatch.ts`'s own docblock) — finally has somewhere to land.
 *
 * **D48 — both verdicts now correlate exactly, by `dispatchId`, the same way.** The first version
 * of this module inferred an acceptance from `(nodeId, projectKey)` against the pending set,
 * because `clusterFreshnessFrameSchema` used to carry `dispatchId` only inside `refused` — the
 * same frame type doubles as the routine freshness beat "sent on change and whenever an offer is
 * answered" (the frame's own doc comment), so a bare accept was indistinguishable from an ordinary
 * beat by anything but timing. That inference was already provably ambiguous: `overlappingRun`
 * (D19 rung 3) keeps two dispatches from racing on the same project's same PATHS, but nothing stops
 * two non-overlapping dispatches to one node's one PROJECT from being in flight at once — and
 * `(nodeId, projectKey)` cannot tell those apart. That gap is why `clusterFreshnessFrameSchema`
 * now carries an `accepted: { dispatchId, runId }` block symmetric with `refused` (see that
 * field's own docblock in `packages/contract/src/cluster.ts`): the ambiguity argument above is the
 * reason the field exists, not a limitation this module lives with.
 *
 * **`runId` is not a correlation nicety — it is how the hub learns which run its dispatch produced
 * (C-a2, corrected by C-a3).** An earlier version of this docblock said the hub stamps the
 * dispatched todo once `recordFreshnessReply` resolves an acceptance — that is not implementable:
 * a claim IS `startedTaskId` (`hub-apply.ts#claimFields`), and the run id does not exist until the
 * spoke's `startRun` mints it, so the hub has nothing to claim with at dispatch time. What actually
 * happens: the spoke stamps its own todo, optimistically and with `humanIntent: true` (the
 * confirmed start of a run it just caused, not the scheduler-denied escape hatch), the moment
 * `startRun` returns, and the ordinary outbox flush carries that claim op to the hub, where
 * `applyOpAtHub` serializes it against any other claim the normal way. So this module's correlation
 * store has nothing to write to the todo record. What `runId` is for instead: it is the only place
 * a dispatched run's id is ever visible to the hub without polling `GET /cluster/active` and
 * guessing by `todoId` — which is what Milestone D's relay subscription needs, and what
 * `onAccepted` (`HubDispatcherDeps`) exists to hand off.
 *
 * **In-memory only, matching `hub-router.ts`'s own `watermarks`/`replayHold` precedent, not
 * `hub-seq.ts`/`op-history.ts`'s persisted stores.** A hub restart (this hub blue-green deploys
 * ~10x/day) forgets every pending dispatch. That is the safe direction: the run itself is either
 * started by the target node (in ITS OWN store) or never started at all — nothing durable depends
 * on this hub remembering the attempt — and a forgotten record simply reads as `sweepUnanswered`
 * would have read it anyway, one restart early. Nothing here bounds the map's growth once
 * resolved; that is fine while nothing production calls `dispatch()`, and is a known cost for
 * whoever wires the trigger to add (a periodic prune of long-resolved entries, the same shape as
 * `cluster-routes.ts`'s own `pruneTimer` for `op-history.ts`).
 */

/** Generous relative to the 30s presence-heartbeat cadence (`spoke-runtime.ts`'s
 *  `DEFAULT_HEARTBEAT_MS`) on purpose: a dispatch reply is a direct response to the `dispatch`
 *  frame, not tied to that beat, so it is expected back in well under one heartbeat when the link
 *  is healthy. This bound is for "the link dropped mid-flight or the node died mid-handshake"
 *  (D15's own phrase), not a deadline ordinary work should ever approach. */
export const DEFAULT_DISPATCH_TIMEOUT_MS = 90_000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** In-flight or terminal state of one dispatch attempt, as this hub instance sees it. */
export type HubDispatchStatus = 'pending' | 'accepted' | 'refused' | 'unanswered';

export interface HubDispatchRecord {
  readonly dispatchId: string;
  readonly todoId: string;
  readonly projectKey: ClusterProjectKey;
  readonly nodeId: ClusterNodeId;
  /** ISO. When this attempt was sent (or would have been, had the link been up). */
  readonly sentAt: string;
  readonly status: HubDispatchStatus;
  /** Only on `status: 'refused'`. */
  readonly refusal?: {
    readonly reason: ClusterDispatchRefusalReason;
    readonly detail?: string;
  };
  /** Only on `status: 'accepted'` — the run this dispatch produced, from the wire frame's own
   *  `accepted.runId` (D48). Nothing here mints or guesses it. This is what `onAccepted`
   *  (`HubDispatcherDeps`) hands off — not to stamp the todo (the spoke does that itself, see
   *  C-a3), but so a caller can act on knowing which run a dispatch became, e.g. subscribing to
   *  its relay stream (Milestone D). */
  readonly runId?: string;
  /** ISO. Set the moment `status` left `'pending'`. */
  readonly resolvedAt?: string;
}

export interface HubDispatchInput {
  todoId: string;
  /** `placeRun`'s own input — carries `projectKey`, `placement`, `projectHasOrigin`,
   *  `touchedPaths`, `activeRuns`. */
  request: PlacementRequest;
  /** The live roster to place among — the same candidates `placeRun` ranks. */
  candidates: readonly PlacementCandidate[];
  /** By value, never by name (D12a) — carried into the dispatch frame verbatim. */
  workflow: ClusterDispatchFrame['workflow'];
  /** The commit the hub believes the target is on. Only meaningful on a REMOTE placement. */
  expectHeadSha?: string;
  /** Set only by a human overriding a freshness refusal, never by the scheduler. */
  override?: boolean;
}

export interface HubDispatchAttempt {
  /** Absent only when `declined` is present (C-a3) — every other outcome (blocked, queued, placed
   *  local or remote) always computes and returns a real placement. */
  placement?: ClusterPlacementResult;
  /** Present only when `placement.status === 'placed'` AND the chosen node is not this hub —
   *  Verification (a): a LOCAL placement builds and sends no frame at all, so this stays absent
   *  rather than carrying a hollow "sent to myself" record. */
  dispatch?: {
    dispatchId: string;
    nodeId: ClusterNodeId;
    /** Whether `ClusterLinkServer.send` actually delivered the frame right now. `false` means the
     *  node was not connected — the correlation record still exists as `'pending'` and is resolved
     *  the same way once it reconnects and answers, or reaches `'unanswered'` via
     *  `sweepUnanswered`. */
    sent: boolean;
  };
  /** C-a3 — present when `dispatch()` refused the WHOLE attempt outright, before ever calling
   *  `placeRun`, because `input.todoId` already has an outstanding dispatch (`'pending'`) or one
   *  that already produced a run (`'accepted'`). Deliberately a NAMED reason rather than an absent
   *  `dispatch` field: "declined to double-dispatch" and "placed locally, no frame needed" are
   *  different facts a caller may render differently, and leaving this as a silent no-op would
   *  make the two indistinguishable. See `dispatch()`'s own docblock for what this guard does and
   *  does not close. */
  declined?: {
    reason: 'already-dispatched';
    /** The outstanding record that caused the refusal — whatever its current `nodeId`/`status`. */
    existing: HubDispatchRecord;
  };
}

export interface HubDispatcherDeps extends ClusterHomeOptions {
  /** This hub's own node id — a placement landing here is LOCAL, not a dispatch. */
  hubNodeId: ClusterNodeId;
  /** A GETTER, not the `ClusterLinkServer` instance itself, so this module can be built and fully
   *  exercised — including a "node not connected" send failure — without ever standing up a real
   *  link. Same reasoning as `cluster-routes.ts#buildHubReplication`'s own `linkServer` parameter:
   *  see that function's docblock for why closing over a `let` assigned synchronously right after
   *  construction is safe. */
  linkServer: () => ClusterLinkServer | undefined;
  /**
   * C-a2/C-a3 — the "this dispatch became a real run" notification. Called exactly once,
   * fire-and-forget (a throw or a rejection is caught and warned, never left uncaught and never
   * allowed to block the reply that triggered it), the moment `recordFreshnessReply` resolves a
   * dispatch as `'accepted'`.
   *
   * **This is not a stamp hook — an earlier version of this docblock said it was, and that was
   * wrong (C-a3).** The hub cannot stamp a dispatched todo: a claim IS `startedTaskId`
   * (`hub-apply.ts#claimFields`), and the run id does not exist until the spoke's `startRun` mints
   * it, so the hub has nothing to claim with at the moment this hook fires. What actually stamps
   * the todo: the spoke itself, optimistically and with `humanIntent: true` (the confirmed start of
   * a run it just caused, not the scheduler-denied escape hatch `todos.ts:840` guards against), the
   * moment `startRun` returns — and the ordinary outbox flush carries that claim op to the hub,
   * where `applyOpAtHub` serializes it against any other claim the normal way. This hook's caller
   * does not need to write anything to the todo record.
   *
   * **What it is for instead.** `record.runId` is the only place a dispatched run's id is ever
   * visible to the hub without polling `GET /cluster/active` and guessing by `todoId` — which is
   * exactly what Milestone D's relay subscription needs (subscribing to the stream a specific run
   * produces), and what any other "the hub wants to react to a dispatch becoming a run" consumer
   * would need too. Omit to receive nothing; every existing test exercises that default. */
  onAccepted?: (record: HubDispatchRecord) => void | Promise<void>;
}

export interface HubDispatcher {
  /** Places the work, and — only for a REMOTE placement — builds and sends the dispatch frame and
   *  records it as `'pending'`. A `'blocked'` or `'queued'` placement (or a LOCAL `'placed'` one)
   *  never reaches the link at all. C-a3: refuses the whole attempt via `declined` — without ever
   *  calling `placeRun` — when `input.todoId` already has a `'pending'` or `'accepted'` dispatch
   *  outstanding, so one todo can never produce two real runs through this function. */
  dispatch(input: HubDispatchInput): Promise<HubDispatchAttempt>;
  /** Routes one `freshness` reply from `nodeId` into the correlation store. Both `refused` and
   *  `accepted` (D48) correlate exactly by `dispatchId`; a frame carrying neither is a routine
   *  freshness beat and resolves nothing. Returns the record this call resolved, or `[]` — for an
   *  unrelated beat, an unmatched/already-resolved id, or a sender/target mismatch. Never throws:
   *  a malformed correlation is a warning, not a crash. */
  recordFreshnessReply(nodeId: ClusterNodeId, frame: ClusterFreshnessFrame): HubDispatchRecord[];
  /** One record by id, whatever its current status — `undefined` if this hub instance never
   *  dispatched (or has forgotten) that id. */
  get(dispatchId: string): HubDispatchRecord | undefined;
  /** Every dispatch still `'pending'`, for a caller that wants to render or sweep them. */
  listPending(): HubDispatchRecord[];
  /** Moves every `'pending'` record older than `timeoutMs` (default `DEFAULT_DISPATCH_TIMEOUT_MS`)
   *  to `'unanswered'` — the named terminal state a dispatch that is never answered must reach,
   *  rather than sitting `'pending'` forever. A caller owns the timer that calls this
   *  periodically (the same split `cluster-routes.ts`'s `pruneTimer`/`op-history.ts#prune` use) —
   *  nothing here starts one itself, so constructing a `HubDispatcher` has no side effect. */
  sweepUnanswered(input?: { timeoutMs?: number }): HubDispatchRecord[];
}

export function createHubDispatcher(deps: HubDispatcherDeps): HubDispatcher {
  const now = deps.now ?? (() => new Date());
  const warn = deps.warn ?? (() => {});

  /** Every dispatch this hub instance has attempted, pending or resolved. See this module's own
   *  docblock, "In-memory only", for why never persisting and never pruning a resolved entry is
   *  the deliberate, safe-for-now choice. */
  const records = new Map<string, HubDispatchRecord>();

  const setRecord = (record: HubDispatchRecord): HubDispatchRecord => {
    records.set(record.dispatchId, record);
    return record;
  };

  /** C-a3 — the duplicate-dispatch guard. An outstanding attempt for this todoId is one this hub
   *  itself dispatched, is still `'pending'` or already `'accepted'`; a `'refused'` or
   *  `'unanswered'` one is terminal and does not block a fresh attempt (a refused dispatch must
   *  not strand its todo forever). Deliberately a linear scan over `records`, not a second
   *  `todoId`-keyed index — this map holds one hub's in-flight dispatches, not its whole todo
   *  history, so it is small and short-lived by construction (see this module's own "In-memory
   *  only" section). */
  function outstandingFor(todoId: string): HubDispatchRecord | undefined {
    for (const record of records.values()) {
      if (record.todoId === todoId && (record.status === 'pending' || record.status === 'accepted')) {
        return record;
      }
    }
    return undefined;
  }

  async function dispatch(input: HubDispatchInput): Promise<HubDispatchAttempt> {
    const outstanding = outstandingFor(input.todoId);
    if (outstanding) {
      // (C-a3) Refuse the WHOLE attempt — never even ask `placeRun` — so a caller cannot read
      // this as "placed locally, nothing to send" (see `declined`'s own docblock on
      // `HubDispatchAttempt`). What this does NOT close: this hub's own records are in-memory
      // (this module's "In-memory only" section), so a hub restart forgets the outstanding
      // dispatch and the guard lapses with it; and a spoke's own local autostart racing this
      // dispatch is invisible to a hub-side guard entirely. Both are D41 proper, not this guard's
      // job — see the spec.
      warn(
        `cluster hub: declined to dispatch todo "${input.todoId}" — dispatch "${outstanding.dispatchId}" ` +
          `to "${outstanding.nodeId}" is already ${outstanding.status} for it; refusing to double-dispatch`,
      );
      return { declined: { reason: 'already-dispatched', existing: outstanding } };
    }

    const placement = placeRun(input.request, input.candidates);
    if (placement.status !== 'placed') return { placement };

    if (placement.nodeId === deps.hubNodeId) {
      // LOCAL placement (Verification a) — this hub runs the work itself; no frame is built or
      // sent for it. Left to the future run-start caller to actually start, the same way it would
      // start any other local run.
      return { placement };
    }

    const buildInput: BuildDispatchInput = {
      todoId: input.todoId,
      projectKey: input.request.projectKey,
      // `ClusterTodoPlacement`'s two fields are both optional (`{}` is a valid, unpinned value);
      // `BuildDispatchInput.placement` is required, so an absent request-side placement becomes
      // the empty object rather than being dropped.
      placement: input.request.placement ?? {},
      targetNodeId: placement.nodeId,
      workflow: input.workflow,
      ...(input.expectHeadSha !== undefined ? { expectHeadSha: input.expectHeadSha } : {}),
      ...(input.override !== undefined ? { override: input.override } : {}),
    };
    const frame = await buildDispatch(buildInput, deps);

    setRecord({
      dispatchId: frame.dispatchId,
      todoId: input.todoId,
      projectKey: input.request.projectKey,
      nodeId: placement.nodeId,
      sentAt: now().toISOString(),
      status: 'pending',
    });

    const sent = deps.linkServer()?.send(placement.nodeId, frame) ?? false;
    if (!sent) {
      warn(
        `cluster hub: dispatch ${frame.dispatchId} for todo "${input.todoId}" addressed to ` +
          `"${placement.nodeId}" could not be sent (link offline or node not connected) — left ` +
          'pending; the next reconnect may still answer it, or `sweepUnanswered` resolves it',
      );
    }

    return { placement, dispatch: { dispatchId: frame.dispatchId, nodeId: placement.nodeId, sent } };
  }

  function recordFreshnessReply(nodeId: ClusterNodeId, frame: ClusterFreshnessFrame): HubDispatchRecord[] {
    if (frame.refused) {
      const dispatchId = frame.refused.dispatchId;
      const existing = records.get(dispatchId);
      if (!existing || existing.status !== 'pending') {
        // (d): a reply whose dispatchId matches nothing pending is not silently swallowed.
        warn(
          `cluster hub: freshness reply from "${nodeId}" refused dispatch "${dispatchId}" ` +
            `(${frame.refused.reason}) but this hub has no PENDING record for that id — already ` +
            'resolved, sent by a previous hub process, or never dispatched by this one; nothing to ' +
            'correlate',
        );
        return [];
      }
      if (existing.nodeId !== nodeId) {
        // The socket's authenticated identity always wins over frame content (`hub-router.ts`'s
        // own "second load-bearing guard" principle) — a dispatchId this hub minted and addressed
        // to one node should never be replied to by another. Refused as suspicious rather than
        // resolved, matching this codebase's posture for every other identity mismatch on the wire.
        warn(
          `cluster hub: dispatch "${dispatchId}" was sent to "${existing.nodeId}" but its refusal ` +
            `arrived from "${nodeId}" — NOT resolved; left pending`,
        );
        return [];
      }
      return [
        setRecord({
          ...existing,
          status: 'refused',
          refusal: {
            reason: frame.refused.reason,
            ...(frame.refused.detail !== undefined ? { detail: frame.refused.detail } : {}),
          },
          resolvedAt: now().toISOString(),
        }),
      ];
    }

    if (frame.accepted) {
      const dispatchId = frame.accepted.dispatchId;
      const existing = records.get(dispatchId);
      if (!existing || existing.status !== 'pending') {
        // (d): a reply whose dispatchId matches nothing pending is not silently swallowed —
        // mirrors the identical guard on the refusal branch above.
        warn(
          `cluster hub: freshness reply from "${nodeId}" accepted dispatch "${dispatchId}" ` +
            `(run "${frame.accepted.runId}") but this hub has no PENDING record for that id — ` +
            'already resolved, sent by a previous hub process, or never dispatched by this one; ' +
            'nothing to correlate',
        );
        return [];
      }
      if (existing.nodeId !== nodeId) {
        // Same identity-mismatch posture as the refusal branch above — refused as suspicious
        // rather than resolved.
        warn(
          `cluster hub: dispatch "${dispatchId}" was sent to "${existing.nodeId}" but its ` +
            `acceptance arrived from "${nodeId}" — NOT resolved; left pending`,
        );
        return [];
      }
      const resolved = setRecord({
        ...existing,
        status: 'accepted',
        runId: frame.accepted.runId,
        resolvedAt: now().toISOString(),
      });
      // C-a2/C-a3 — fire-and-forget, deliberately: this is a notification (`onAccepted`'s own
      // docblock), not a request/reply this function waits on. A throw or a rejected promise is
      // caught and warned so a caller's own failure can never surface as an uncaught rejection off
      // the back of a `freshness` frame the router already returned a reply for.
      try {
        // `Promise.resolve(...)` uniformly wraps a `void` return, a resolved promise, or a
        // rejected one — `.catch` below covers the async-rejection case. It does NOT cover
        // `onAccepted` throwing SYNCHRONOUSLY (that throw happens while evaluating the call
        // expression, before `Promise.resolve` ever runs), which is what the outer `try` is for.
        void Promise.resolve(deps.onAccepted?.(resolved)).catch((err: unknown) => {
          warn(`cluster hub: onAccepted threw for dispatch "${dispatchId}": ${errorMessage(err)}`);
        });
      } catch (err) {
        warn(`cluster hub: onAccepted threw for dispatch "${dispatchId}": ${errorMessage(err)}`);
      }
      return [resolved];
    }

    // Neither `refused` nor `accepted` — a routine freshness beat unrelated to any dispatch
    // ("sent on change and whenever an offer is answered", the frame's own doc comment). A no-op,
    // not a warning: most freshness frames this hub ever sees are exactly this.
    return [];
  }

  function get(dispatchId: string): HubDispatchRecord | undefined {
    return records.get(dispatchId);
  }

  function listPending(): HubDispatchRecord[] {
    return [...records.values()].filter((record) => record.status === 'pending');
  }

  function sweepUnanswered(input?: { timeoutMs?: number }): HubDispatchRecord[] {
    const timeoutMs = input?.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
    const cutoff = now().getTime() - timeoutMs;
    const expired: HubDispatchRecord[] = [];
    for (const record of records.values()) {
      if (record.status !== 'pending') continue;
      if (new Date(record.sentAt).getTime() > cutoff) continue;
      expired.push(setRecord({ ...record, status: 'unanswered', resolvedAt: now().toISOString() }));
    }
    return expired;
  }

  return { dispatch, recordFreshnessReply, get, listPending, sweepUnanswered };
}
