/**
 * **The hub's answer to "where should this todo run" — the one caller `createHubDispatcher` never
 * had.**
 *
 * Everything below this module already existed and was tested: `buildPlacementCandidates` reads the
 * roster, `placeRun` ranks it, `createHubDispatcher` builds the frame, correlates the reply and
 * refuses a double-dispatch. Nothing invoked any of it. This module is the adapter between the
 * autostart reconcile pass (which knows a todo, a workflow and a repo root) and the placement stack
 * (which speaks `ClusterProjectKey` and `PlacementRequest`).
 *
 * **It answers `local` far more often than it answers `remote`, and that is correct, not a
 * degradation.** A project this hub has not PAIRED has no `ClusterProjectKey` at all, so the cluster
 * has nothing to say about it and the honest answer is the single-node one. Anything else would
 * strand an ordinary todo the moment `CEZ_CLUSTER=1` was set.
 */
import type {
  ClusterNodeId,
  ClusterProjectKey,
  StoredClusterNodeIdentity,
  WorkflowDef,
} from '@loki-labs/cezar-plus-contract';
import type { HubDispatcher } from './hub-dispatch.ts';
import type { HubSeqAllocator } from './hub-seq.ts';
import type { TodoStartConfirmer, TodoStartOptions } from '../todos.ts';
import { buildPlacementCandidates } from './hub-candidates.ts';
import { readPeers } from './peers.ts';
import type { TodoAutostartDispatch, TodoDispatchOutcome } from '../todo-autostart.ts';
import type { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { workspaceConfigPath } from '../paths.ts';
import { getHeadCommit, getRepoInfo } from '../server/git.ts';

export interface HubAutostartDispatchDeps {
  dispatcher: HubDispatcher;
  /** This hub's own identity — the source of the hub candidate, and of "is this placement local". */
  identity: StoredClusterNodeIdentity;
  /** This process's live workspace load, measured rather than claimed (D14/D47). */
  semaphore: WorkspaceSemaphore;
  /** `linkServer.connectedNodes()`. A GETTER for the same reason `HubDispatcherDeps#linkServer` is:
   *  the link does not exist yet when this is constructed. */
  connectedNodeIds: () => readonly ClusterNodeId[];
  /** The hub's own `hubSeq` counter — the same allocator the inbound op path uses, so a claim this
   *  hub grants ITSELF is numbered from the one sequence and can replicate outward like any other.
   *  Without it a hub-authored record carries no `hubSeq` and can never reach a spoke at all. */
  allocateHubSeq: HubSeqAllocator['allocate'];
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
  now?: () => Date;
}

/**
 * `repoRoot` → the paired `ClusterProjectKey`, or `undefined` when this hub has no CONFIRMED
 * pairing for it.
 *
 * Two hops, both already the authority elsewhere: the workspace config maps a root to a
 * `projectId` (the same lookup `cluster-routes.ts#resolveHubTodosRoot` makes in reverse), and
 * `peers.pairings` maps this hub's `projectId` to the cluster-wide key. **`confirmedAt` is
 * required, not decorative** — an unconfirmed pairing is a proposal, and dispatching against one
 * would send work for a project the other side never agreed shares an identity with this one.
 */
async function pairedProjectKey(
  repoRoot: string,
  hubNodeId: ClusterNodeId,
  env: NodeJS.ProcessEnv | undefined,
  warn: ((m: string) => void) | undefined,
): Promise<ClusterProjectKey | undefined> {
  const config = await loadWorkspaceConfig(workspaceConfigPath(env));
  const project = config.projects.find((p) => p.root === repoRoot);
  if (!project) return undefined;
  const peers = await readPeers({ env, warn });
  const pairing = peers.pairings.find((p) => p.byNode[hubNodeId]?.projectId === project.id);
  if (!pairing) return undefined;
  if (!pairing.byNode[hubNodeId]?.confirmedAt) return undefined;
  return pairing.projectKey;
}

export function createHubAutostartDispatch(deps: HubAutostartDispatchDeps): TodoAutostartDispatch {
  const warn = deps.warn ?? (() => {});
  const now = deps.now ?? (() => new Date());

  /**
   * The hub's acknowledgement of its OWN claim. Allocates from the same `hubSeq` counter the
   * inbound op path uses, so the record is numbered in the one sequence and is replicable — which
   * is also the fix for "a hub-authored todo never gets a hubSeq, so it can never reach a spoke".
   *
   * Deliberately does NOT go through `applyOpAtHub`: that path exists to serialize an op that
   * arrived from ELSEWHERE and to record it against `opId` for replay dedupe. There is no inbound
   * op here and nothing to dedupe against, and `markStartedWithClaim` performs the write itself
   * under the todos lease the moment this resolves — routing through the op applier would write
   * the same fields twice.
   */
  const hubSelfConfirm =
    (projectKey: ClusterProjectKey): TodoStartConfirmer =>
    async (claim) => {
      const range = await deps.allocateHubSeq({ scope: 'project', projectKey, count: 1 });
      return {
        // Bounded to 64 chars by the contract; a todo id is 36, so this fits with room to spare.
        opId: `hub-local:${claim.todoId}`,
        hubSeq: range.from,
        accepted: true,
        // The hub is the node that ran it, and `startedOn` is what the board renders.
        fields: { startedOn: deps.identity.nodeId },
      };
    };

  /**
   * **The one definition of "what kind of claim is a local start here".**
   *
   * `place()` and `localStartOptions` both need it and used to be the only caller each — two
   * copies of a two-branch rule, which is how the halves drift. Keyed on the pairing because that
   * is what makes a project clustered: `CEZ_CLUSTER=1` is a property of the NODE, and most
   * projects on a hub have no peer that could hold a competing claim.
   */
  const claimFor = (projectKey: ClusterProjectKey | undefined): TodoStartOptions =>
    projectKey === undefined
      ? { clustered: false }
      : { clustered: true, confirmStart: hubSelfConfirm(projectKey) };

  return {
    async localStartOptions({ repoRoot }): Promise<TodoStartOptions> {
      return claimFor(await pairedProjectKey(repoRoot, deps.identity.nodeId, deps.env, deps.warn));
    },

    async place(input): Promise<TodoDispatchOutcome> {
      const projectKey = await pairedProjectKey(input.repoRoot, deps.identity.nodeId, deps.env, deps.warn);
      if (!projectKey) {
        // Not a cluster project. Not an error, and deliberately not a refusal: a hub runs its own
        // unpaired projects exactly as a single-node cezar does.
        //
        // **`clustered: false` is that sentence applied to the CLAIM, and it is load-bearing.**
        // `CEZ_CLUSTER=1` is a property of the NODE, but being clustered is a property of the
        // PROJECT: most projects on a hub have no pairing and no peer that could ever hold a
        // competing claim. Left to the environment, `markStarted` would ask a hub that has nobody
        // to ask, refuse `hub-unconfirmed`, and write nothing — so every unpaired todo on a
        // clustered hub would start, fail to stamp, and be started again by the next pass.
        return { start: 'local', startOptions: claimFor(undefined) };
      }

      const repoInfo = await getRepoInfo(input.repoRoot);
      const candidates = await buildPlacementCandidates(
        {
          projectKey,
          hubIdentity: deps.identity,
          connectedNodeIds: deps.connectedNodeIds(),
          now: now(),
          semaphore: deps.semaphore,
          // A node holds the project when THIS hub has a confirmed pairing row for it. The same
          // `confirmedAt` gate `pairedProjectKey` applied to the hub, applied per candidate — one
          // rule, read from one file, rather than two implementations that agree today.
          holdsProject: async (key: ClusterProjectKey, nodeId: ClusterNodeId): Promise<boolean> => {
            const peers = await readPeers({ env: deps.env, warn: deps.warn });
            const pairing = peers.pairings.find((p) => p.projectKey === key);
            return pairing?.byNode[nodeId]?.confirmedAt !== undefined;
          },
        },
        { env: deps.env, warn: deps.warn },
      );

      const attempt = await deps.dispatcher.dispatch({
        todoId: input.todo.id,
        request: {
          projectKey,
          // D12: with no origin there is nowhere for a second node to fetch the work FROM, so
          // placement pins to whichever candidate already holds the project.
          projectHasOrigin: repoInfo?.remote !== undefined,
          ...(input.todo.placement !== undefined ? { placement: input.todo.placement } : {}),
          // **`touchedPaths` and `activeRuns` are deliberately ABSENT, and that is a stated
          // limitation rather than a default.** `placeRun`'s D19 rung-3 overlap check consumes
          // both; with neither supplied it cannot run, and `PlacementRequest#touchedPaths`' own
          // docblock is explicit that an absent value "must not pretend it did". So on this path
          // two placements whose runs touch the same files are NOT blocked from each other yet.
          // Supplying them means a `collectChanges` git call per placement plus a cluster-wide
          // active-run read; both exist (`GET /cluster/active`, `run-projection.ts#readRemoteRuns`)
          // and neither is wired here. Left honest rather than filled with a fabricated empty list
          // that would read downstream as "checked, and clear".
        },
        candidates,
        // BY VALUE (D12a) — never `{ builtinId }`, which the target would resolve against its own
        // workflow set and could resolve differently.
        workflow: { def: input.workflow satisfies WorkflowDef },
        ...(await headShaFor(input.repoRoot)),
      });

      if (attempt.declined) {
        const existing = attempt.declined.existing;
        return {
          start: 'none',
          reason:
            `dispatch ${existing.dispatchId} to node ${existing.nodeId} is already ` +
            `${existing.status} for this todo — waiting for it rather than dispatching a second copy`,
        };
      }

      const placement = attempt.placement;
      if (!placement) {
        // Unreachable by `HubDispatchAttempt`'s own contract (`placement` is absent ONLY when
        // `declined` is present, and that returned above). Named rather than assumed: falling
        // through to a local start here would be the double-start this whole path exists to avoid.
        warn(
          `cluster hub: dispatch for todo "${input.todo.id}" returned neither a placement nor a ` +
            'decline — refusing to start it locally on an answer this hub cannot read',
        );
        return { start: 'none', reason: 'the hub returned no placement for this todo' };
      }

      if (placement.status === 'blocked') {
        return {
          start: 'none',
          reason: `blocked by run ${placement.blockedBy.runId ?? 'unknown'} on node ${placement.blockedBy.nodeId ?? 'unknown'}`,
        };
      }
      if (placement.status === 'queued') {
        return { start: 'none', reason: placement.detail ?? placement.reason };
      }

      if (placement.nodeId === deps.identity.nodeId) {
        // The hub placed the work on itself, and this project IS paired — so the claim is
        // clustered and needs an acknowledgement. The hub is the thing that would acknowledge it,
        // which is exactly why there is nobody to ask: `confirmStart` is absent in shipped code,
        // so `markStartedWithClaim` refuses `hub-unconfirmed` and writes nothing.
        //
        // **A hub confirming its own claim is not a shortcut past the exactly-once property; it is
        // that property stated where it is trivially true.** The serializer for every claim in the
        // cluster is this process. `markStartedWithClaim` re-reads under the todos lease AFTER
        // this returns and refuses `already-started` if a spoke's op won in between, so a genuine
        // race still resolves the normal way — this only removes a round trip to ourselves.
        return { start: 'local', startOptions: claimFor(projectKey) };
      }

      const sent = attempt.dispatch;
      if (!sent) {
        // A remote placement with no dispatch record. Same posture as above: do NOT fall back to a
        // local start, because the placement said this work belongs elsewhere.
        warn(
          `cluster hub: todo "${input.todo.id}" was placed on node ${placement.nodeId} but no ` +
            'dispatch record was produced — not starting it here',
        );
        return { start: 'none', reason: `placed on node ${placement.nodeId} but no frame was built` };
      }
      // `sent.sent === false` means the node is not connected right now. Still `remote`: the
      // correlation record exists as `pending` and resolves when it reconnects and answers. Starting
      // locally on that basis is exactly the lost-accept duplicate the sweep refuses to create.
      return { start: 'remote', nodeId: sent.nodeId, dispatchId: sent.dispatchId };
    },
  };
}

/** D12a's `expect.headSha`, and omitted entirely when it cannot be read — never a placeholder. The
 *  target REFUSES a dispatch whose expected head it is behind, so a wrong value here is worse than
 *  none: it would make every dispatch refusable for a reason that is not true. */
async function headShaFor(repoRoot: string): Promise<{ expectHeadSha?: string }> {
  const head = await getHeadCommit(repoRoot);
  return head ? { expectHeadSha: head } : {};
}
