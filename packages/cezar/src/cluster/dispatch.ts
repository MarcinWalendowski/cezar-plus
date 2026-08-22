import { randomUUID } from 'node:crypto';
import { CLUSTER_PROTOCOL, clusterDispatchFrameSchema } from '@loki-labs/better-cezar-contract';
import type {
  ClusterCorpusStatus,
  ClusterDispatchFrame,
  ClusterDispatchRefusalReason,
  ClusterFreshnessFrame,
  ClusterNodeId,
  ClusterProjectKey,
  ClusterRepoFreshness,
  ClusterTodoPlacement,
} from '@loki-labs/better-cezar-contract';
import type { ClusterHomeOptions } from './node-identity.ts';

/**
 * Dispatch: building an offer on the hub, and **refusing it on the spoke** (spec
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D11 · D12a · D15 · D15a · D8a).
 *
 * **The spoke is the boundary that enforces.** `acceptsDispatch` is stored on both sides and the
 * spoke refuses work it has not opted into **regardless of what the hub sends** — the same reasoning
 * as `supervisor/forwarded-principal.ts`: *"a forged header is rejected by the ORG PROCESS ITSELF
 * regardless of what reached it or how."* Default is off: a newly enrolled node replicates state and
 * runs nothing.
 *
 * **The workflow travels by value, never by name** (D12a). `WORKFLOWS_DIR` is inside the gitignored
 * `.ai/cezar/`, so a repo-local workflow never travels by git and the target may simply not have the
 * one the dispatcher named. Sending a name and hoping is how a run silently executes a different
 * chain from the one that was asked for. The definition is re-validated against `workflowDefSchema`
 * on arrival, by the node that will run it.
 *
 * **A stale target is refused by default, with the reason named.** The target's checkout may be
 * behind, dirty, or wedged mid-conflict — the box's own `chat` checkout sat six hours in exactly
 * that state, showing one ordinary dirty file while every pull failed. An explicit override exists;
 * the default is refusal, because "it ran, on the wrong commit, on a machine you weren't looking at"
 * is the expensive outcome. A stale **corpus** refuses on the same grounds and names the corpus: a
 * knowledge read has no natural error, so an agent on a five-day-old mirror follows knowledge-first
 * by reading nothing and reports success.
 *
 * **The negative control is what makes the refusal tests mean anything** (PLAN P10): a FRESH mirror
 * must not refuse, or every assertion passes against a node that refuses everything.
 *
 * D15/D15a scope the offline behaviour rather than ordering it: a person clicking ▶ Run proceeds, a
 * todo this node authored proceeds, and autostarting a REPLICATED todo refuses with a stated reason
 * (`waiting for the hub to confirm the claim`). Without the scope split one rule quietly wins and
 * nobody notices which.
 *
 * **This module decides; it never starts a run, and it never mints a run id.** `offerDispatch`'s
 * `DispatchOutcome.dispatchId` correlates the ATTEMPT, not what it produced — it is
 * `input.frame.dispatchId` echoed back, present on both the accepted and refused branches, because
 * an attempt is a real event even when no run ever starts. The actual run's id is minted by
 * `RunManager.startRun` (`workflows/run.ts`, via `store.createRun`) and is the CALLER's to obtain
 * and report, after it reads `accepted: true` here and starts the run itself — the same
 * decision/start split `todo-autostart.ts`'s `startAutostartTodo` already draws for a local start.
 * Minting a second id here would give one run two identities; a consumer that keys on run id
 * (package 4.4's relay streams events BY run id) handed this one would subscribe to a run that
 * never existed, silently and forever.
 */

/** How far behind the hub's corpus version a mirror may be before a dispatch is refused. A bound,
 *  not a heuristic, and rendered beside the node so it is legible before it bites. */
export const DEFAULT_CORPUS_STALENESS_MS = 60 * 60 * 1000;

export interface BuildDispatchInput {
  todoId: string;
  projectKey: ClusterProjectKey;
  placement: ClusterTodoPlacement;
  targetNodeId: ClusterNodeId;
  /** A built-in id, or the resolved definition to carry inline. Resolved on the HUB, at build time —
   *  never left for the target to look up. */
  workflow: ClusterDispatchFrame['workflow'];
  /** The commit the hub believes the target is on (D12a). */
  expectHeadSha?: string;
  /** Set only by a human overriding a freshness refusal, never by the scheduler. */
  override?: boolean;
}

export function buildDispatch(
  input: BuildDispatchInput,
  options?: ClusterHomeOptions,
): Promise<ClusterDispatchFrame> {
  // `targetNodeId` decides WHERE this frame is sent (the caller's routing concern, over the link)
  // — it is not a field of the frame itself, which only says what to run, where, and on what
  // commit. It is accepted here so a caller building a dispatch and addressing it can do both from
  // one input, matching `DispatchAcceptanceInput` on the receiving side; `options` is accepted for
  // the same reason every sibling module's build function takes it, and unused here — nothing in
  // this frame is clock- or env-dependent.
  const frame: ClusterDispatchFrame = {
    type: 'dispatch',
    protocol: CLUSTER_PROTOCOL,
    // Minted here, not by the caller: it is what correlates this offer with its later acceptance
    // or refusal, and with an `unattributed` run the hub reconciles if the link drops mid-flight
    // (D15). One mint site means it can never collide with a caller's own id scheme.
    dispatchId: randomUUID(),
    todoId: input.todoId,
    projectKey: input.projectKey,
    placement: input.placement,
    // By value, never by name (D12a) — `input.workflow` already carries either a built-in id or
    // the resolved definition; this function does not resolve one, it only carries what the
    // caller resolved.
    workflow: input.workflow,
    ...(input.expectHeadSha !== undefined ? { expect: { headSha: input.expectHeadSha } } : {}),
    ...(input.override !== undefined ? { override: input.override } : {}),
  };
  // Validated before it ever reaches the wire — the same posture every other frame-building
  // function in this codebase takes at a system boundary (Zod at the boundary, not just on read).
  return Promise.resolve(clusterDispatchFrameSchema.parse(frame));
}

export interface DispatchAcceptanceInput {
  frame: ClusterDispatchFrame;
  acceptsDispatch: boolean;
  paired: boolean;
  freshness: ClusterRepoFreshness;
  corpus?: ClusterCorpusStatus;
  corpusStalenessBoundMs?: number;
  capacityAvailable: boolean;
  now?: () => Date;
}

/** Spoke-side. `undefined` means accept — the refusal is the value, so "no reason" cannot be
 *  confused with "some reason we failed to name". */
export function dispatchRefusalReason(
  input: DispatchAcceptanceInput,
): ClusterDispatchRefusalReason | undefined {
  // D11 — the spoke enforces its OWN policy regardless of what the hub sent, and regardless of
  // `override`: `override` exists only to override a FRESHNESS refusal (D12a's own wording), never
  // this one. Checked first because every other check is about THIS work, and a node that never
  // opted in refuses all of it without needing to look at any of them.
  if (!input.acceptsDispatch) return 'dispatch-not-accepted';

  // No pairing, no repo on this node to check freshness against — refuse before asking anything
  // that assumes a paired checkout exists.
  if (!input.paired) return 'unpaired-project';

  // D12a: refuse a target that is behind, dirty, or mid-conflict — naming which — unless a human
  // set `override` on the frame (never the scheduler, per the frame's own doc comment). `merging`
  // is checked first: a checkout wedged mid-conflict is the worse of the three, and a mid-conflict
  // checkout is usually also `dirty`, so checking dirt first would name the less useful reason.
  if (!input.frame.override) {
    if (input.freshness.merging) return 'merging';
    if (input.freshness.behind > 0) return 'behind';
    if (input.freshness.dirty > 0) return 'dirty';
  }

  // D8a: a stale corpus mirror refuses too, naming the corpus — a knowledge read has no natural
  // error, so this is not skippable by the freshness override above. Overriding "this checkout is
  // old" is not a statement about "run this agent knowledge-blind"; the two are different risks.
  if (isCorpusStale(input.corpus, { boundMs: input.corpusStalenessBoundMs, now: input.now })) {
    return 'corpus-stale';
  }

  if (!input.capacityAvailable) return 'at-capacity';

  // `unknown-workflow` is a member of the wire enum but not decided here: this function only sees
  // what `DispatchAcceptanceInput` carries, and that never includes workflow validity — the
  // definition is re-validated against `workflowDefSchema` ON ARRIVAL (this file's own top
  // docblock), by whichever module actually resolves and runs it. That module is not owned by
  // this package (see the report for package 4.3).
  return undefined;
}

/** Specific, never prose the UI must parse (the wire field's own doc comment) — which corpus
 *  version, how many commits, how many dirty files. One branch per reason so a reason added to the
 *  enum later fails typecheck here rather than silently rendering nothing. */
function dispatchRefusalDetail(
  reason: ClusterDispatchRefusalReason,
  input: DispatchAcceptanceInput,
): string {
  switch (reason) {
    case 'dispatch-not-accepted':
      return 'this node has not enabled acceptsDispatch';
    case 'unpaired-project':
      return `project ${input.frame.projectKey} is not paired with this node`;
    case 'merging':
      return 'checkout is mid-conflict (MERGE_HEAD present)';
    case 'behind':
      return `checkout is ${input.freshness.behind} commit(s) behind origin`;
    case 'dirty':
      return `checkout has ${input.freshness.dirty} dirty file(s)`;
    case 'corpus-stale':
      return input.corpus
        ? `corpus mirror at version ${input.corpus.version}, fetched ${input.corpus.fetchedAt}, is stale`
        : 'corpus mirror is stale';
    case 'at-capacity':
      return 'no capacity available on this node';
    case 'unknown-workflow':
      return 'workflow definition is not recognised on this node';
  }
}

export interface DispatchOutcome {
  accepted: boolean;
  /** The frame sent back to the hub either way: a freshness report, carrying `refused` when it is
   *  one. The hub can then render WHICH check failed rather than "nothing happened". */
  reply: ClusterFreshnessFrame;
  /**
   * Correlates this dispatch ATTEMPT — never the run it may or may not have produced. Mirrors
   * `input.frame.dispatchId` verbatim; not minted here, and present on both branches, because a
   * dispatch attempt is a real event even when no run ever starts (refused, target asleep, node
   * died mid-handshake) — an attempt record is not a run record, and collapsing them would lose
   * every attempt that never became one, which is exactly what "queued, nobody knows why" needs.
   *
   * **This is not the run's id and must never be conflated with one.** This module decides
   * accept/refuse; it does not hold a `RunManager` and cannot mint the real run id — `startRun`
   * (`workflows/run.ts`) self-mints its own via `store.createRun`, the same way
   * `todo-autostart.ts`'s `startAutostartTodo` calls `project.manager.startRun` for a local start.
   * The CALLER that holds the `RunManager` starts the run after reading `accepted: true` here and
   * reports the run's own id back once `startRun` returns. Handing a consumer that keys on run id
   * — package 4.4's relay streams events BY run id — this attempt id instead would subscribe it
   * to a run that never existed: silent, and forever.
   */
  dispatchId: string;
}

/** The spoke's whole answer to an offer: check, then start or refuse. Never starts and then checks. */
export function offerDispatch(
  input: DispatchAcceptanceInput,
  options?: ClusterHomeOptions,
): Promise<DispatchOutcome> {
  const warn = options?.warn ?? (() => {});

  // The freshness frame is sent EITHER WAY (this frame's own doc comment): a refusal is the same
  // answer with a reason attached, not a different frame. Built once, up front, so the accepted
  // and refused branches below cannot drift into reporting different repo facts.
  const freshnessReport: ClusterFreshnessFrame = {
    type: 'freshness',
    protocol: CLUSTER_PROTOCOL,
    projectKey: input.freshness.projectKey,
    headSha: input.freshness.headSha,
    ahead: input.freshness.ahead,
    behind: input.freshness.behind,
    dirty: input.freshness.dirty,
    merging: input.freshness.merging,
  };

  // Check, THEN start or refuse (this function's own doc comment) — every refusal reason is
  // decided before anything below has any side effect.
  const reason = dispatchRefusalReason(input);

  if (reason !== undefined) {
    warn(`[cez] cluster dispatch ${input.frame.dispatchId} refused: ${reason}`);
    return Promise.resolve({
      accepted: false,
      dispatchId: input.frame.dispatchId,
      reply: {
        ...freshnessReport,
        refused: {
          dispatchId: input.frame.dispatchId,
          reason,
          detail: dispatchRefusalDetail(reason, input),
        },
      },
    });
  }

  // Accepted. This module's job ends at the decision — it never mints a run id (see
  // `DispatchOutcome.dispatchId`'s own doc comment for why that would be a live bug, not a
  // convenience). Actually starting the workflow, the way `todo-autostart.ts`'s
  // `startAutostartTodo` calls `project.manager.startRun`, is the caller's job: it holds the
  // `RunManager` this module deliberately does not.
  return Promise.resolve({
    accepted: true,
    dispatchId: input.frame.dispatchId,
    reply: freshnessReport,
  });
}

/** True when the mirror is past its bound. `undefined` corpus is NOT stale — a node that mirrors
 *  nothing is a different state from a node whose mirror is old, and refusing both would refuse
 *  every node that never opted in. */
export function isCorpusStale(
  corpus: ClusterCorpusStatus | undefined,
  input?: { boundMs?: number; now?: () => Date },
): boolean {
  // A node that mirrors nothing (never opted into the D8a mirror at all) is a DIFFERENT state from
  // a node whose mirror is old — refusing both would refuse every node that never opted in.
  if (!corpus) return false;

  const boundMs = input?.boundMs ?? DEFAULT_CORPUS_STALENESS_MS;
  const now = (input?.now ?? (() => new Date()))();
  const fetchedAt = new Date(corpus.fetchedAt).getTime();
  // An unparsable fetch stamp cannot be proven fresh — treat it the same as "past its bound"
  // rather than trusting a corpus whose own freshness claim cannot be read.
  if (Number.isNaN(fetchedAt)) return true;

  return now.getTime() - fetchedAt > boundMs;
}

/**
 * D15a's scope split, as one function rather than an ordering. A person's ▶ Run and a todo this node
 * authored proceed with the link down; a REPLICATED todo's autostart refuses and says why. The
 * refusal is a stated, rendered state — never a silent skip.
 */
export function mayStartWithoutHub(input: {
  trigger: 'human' | 'autostart';
  authoredHere: boolean;
}): { allowed: true } | { allowed: false; reason: string } {
  // A person clicking ▶ Run, or `cez run`, proceeds regardless of authorship — a human is
  // asserting intent on THIS host, and D15 says nothing blocks on the link for that.
  if (input.trigger === 'human') return { allowed: true };

  // Autostarting a todo this node authored proceeds too — it was never anyone else's to start, so
  // there is no foreign claim the hub needs to confirm.
  if (input.authoredHere) return { allowed: true };

  // Autostarting a REPLICATED todo needs the hub's confirmation (D15a) — refuses, and says why,
  // rather than silently skipping or silently starting a duplicate the moment the hub reconnects.
  return { allowed: false, reason: 'waiting for the hub to confirm the claim' };
}
