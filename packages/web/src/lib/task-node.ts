import type { ClusterActiveRun, ClusterNode, TodoItem } from '@loki-labs/better-cezar-api-client'
import { shortAge } from '@/lib/format'

/**
 * The pure half of the "which worker is processing this?" cell
 * (`.ai/specs/2026-08-22-multi-node-cezar-cluster.md`): resolving a todo's `startedOn`
 * (hub-confirmed run claim) or `placement.node` (a pin, not yet claimed) against the cluster
 * roster. Sits beside `lib/task-author.ts` — the same split for the Author cell — so the honesty
 * rules below are unit-testable without mounting anything.
 *
 * `todoItemSchema` carries exactly these two cluster fields — `contract/src/cluster.ts`'s own
 * docblock calls them "the only two anything renders" — and nothing here invents a third. The
 * other four cluster fields (`pendingSince`, `pendingFields`, `hubSeq`, `tombstone`) are sync
 * bookkeeping that never reaches the cockpit-facing `TodoItem` shape at all.
 *
 * `resolveRunNode`/`runNodeFreshness` below (2026-08-24) are the RUN-side counterpart, added once
 * the runs surfaces (the global Tasks board, the run detail header) needed the same "which worker"
 * answer for a `RunRecord`/`RunIndexEntry`, which carries no node field at all (unlike a todo's
 * `startedOn`/`placement.node`) — see `resolveRunNode`'s own doc for how a run's node is inferred
 * instead.
 */

export type TaskNodeSource = 'started' | 'placement'
export type TaskNodeKind = 'self' | 'known' | 'unknown'

export interface TaskNodeInfo {
  /** `'started'`: the hub confirmed a run claim (`startedOn`) — a stronger fact than a pin, and
   *  rendered as such. `'placement'`: no run has been claimed yet; this is only where the todo is
   *  pinned to run, a request the scheduler may still honour differently. */
  source: TaskNodeSource
  kind: TaskNodeKind
  nodeId: string
  /** The roster name, for `kind: 'known'` only. Absent for `'self'` ("this node" is the label)
   *  and `'unknown'` (a node id the roster no longer carries). */
  name?: string
}

/** Node ids are a bounded free-form string (`clusterNodeIdSchema`, up to 64 chars), not
 *  guaranteed to be a UUID — spec fixtures use plain names like `hub-node-1`. Only truncate the
 *  rare long one rather than always slicing to a fixed prefix, which would mangle a short,
 *  already-readable id. */
export function shortNodeId(id: string): string {
  return id.length > 20 ? `${id.slice(0, 12)}…` : id
}

/**
 * `startedOn` wins over `placement.node`: a todo that has actually started tells you WHERE it
 * runs, a stronger fact than where it was merely pinned. Returns `undefined` when the todo makes
 * no node claim at all — the common case today (measured 2026-08-24: every todo in production has
 * `startedOn: null`, including ones that ran, because the field is only written from a cluster
 * `ack`).
 *
 * Callers MUST render that `undefined` as an honest empty state, never as "local" or "this
 * machine" — absence here means no node has claimed this todo, which is a different fact from
 * "running here", and asserting the latter would be false for every row today.
 */
export function resolveTaskNode(
  todo: Pick<TodoItem, 'startedOn' | 'placement'>,
  nodes: readonly ClusterNode[],
  selfNodeId: string | undefined,
): TaskNodeInfo | undefined {
  const nodeId = todo.startedOn ?? todo.placement?.node
  if (!nodeId) return undefined
  const source: TaskNodeSource = todo.startedOn ? 'started' : 'placement'
  if (selfNodeId !== undefined && nodeId === selfNodeId) return { source, kind: 'self', nodeId }
  const match = nodes.find((node) => node.nodeId === nodeId)
  if (match) return { source, kind: 'known', nodeId, name: match.nodeName }
  // A node id the roster no longer carries — revoked, or a stale reading from before a rename.
  // Rendered as the id itself (never blank): blank would be indistinguishable from "no claim at
  // all", and those are opposite facts.
  return { source, kind: 'unknown', nodeId }
}

/** The short cell label. */
export function taskNodeLabel(info: TaskNodeInfo): string {
  if (info.kind === 'self') return 'this node'
  if (info.kind === 'known') return info.name ?? info.nodeId
  return `unknown node (${shortNodeId(info.nodeId)})`
}

/** The tooltip sentence — the fuller claim behind the short label. */
export function taskNodeTitle(info: TaskNodeInfo): string {
  const verb = info.source === 'started' ? 'Running on' : 'Pinned to'
  if (info.kind === 'self') return `${verb} this node`
  if (info.kind === 'known') return `${verb} ${info.name}`
  return `${verb} a node not on the current roster (id ${info.nodeId})`
}

// ---- runs: "which worker ran/is running this?" ---------------------------------------------------

/**
 * A `RunRecord`/`RunIndexEntry` carries no node field at all — unlike a todo, whose
 * `startedOn`/`placement.node` names the node directly, a run's node is INFERRED:
 *
 *  - Its id appears in `GET /api/v1/cluster/active` (D19 rung 4) — this node's mirror of what
 *    other linked nodes report as in flight — naming a DIFFERENT node: render that node.
 *  - Its id does not appear there at all: it is local by construction (D1 — a run's record lives
 *    only on the node that ran it, in that project's own `runs.json`), so it is THIS node's own
 *    run. Requires a confirmed `selfNodeId` to say so honestly; while that identity has not
 *    resolved yet, `undefined` is the honest "not yet known" answer, never a guessed id.
 *
 * `source` is always `'started'` — a run, unlike a todo pin, has definitely started wherever it
 * is attributed to, so `taskNodeLabel`/`taskNodeTitle`'s "Running on" framing applies to every
 * outcome, finished or not; the row's own status pill is what says whether it is still running.
 *
 * Reuses `TaskNodeInfo` and every rendering function above verbatim — the "which worker" grammar
 * (self/known/unknown, the label, the tooltip) does not change by asking about a run instead of a
 * todo, only the INPUT that decides it does.
 */
export function resolveRunNode(
  runId: string,
  activeRuns: readonly ClusterActiveRun[],
  nodes: readonly ClusterNode[],
  selfNodeId: string | undefined,
): TaskNodeInfo | undefined {
  const elsewhere = activeRuns.find((run) => run.runId === runId)
  if (elsewhere) {
    if (selfNodeId !== undefined && elsewhere.nodeId === selfNodeId) {
      return { source: 'started', kind: 'self', nodeId: elsewhere.nodeId }
    }
    const match = nodes.find((node) => node.nodeId === elsewhere.nodeId)
    if (match) return { source: 'started', kind: 'known', nodeId: elsewhere.nodeId, name: match.nodeName }
    return { source: 'started', kind: 'unknown', nodeId: elsewhere.nodeId }
  }
  if (selfNodeId === undefined) return undefined
  return { source: 'started', kind: 'self', nodeId: selfNodeId }
}

export interface RunNodeFreshness {
  /** `shortAge`'s compact form ("12m", "3h") — the age of the resolved node's OWN `lastSeenAt`,
   *  never `ClusterActiveResponse.asOf` (the most recent reading across the WHOLE roster, which
   *  would make a stale node's run look current — see `useRunNodeRoster`'s own doc). */
  ageText: string
}

/** A node's presence older than this reads as stale rather than current — the same threshold
 *  `cluster-section.tsx`'s `PRESENCE_FRESH_MS` uses for the roster row's own presence badge. Kept
 *  as an independent constant rather than an import: the roster row and a run's node cell are two
 *  different judgement calls that happen to agree today, not one shared knob. */
const RUN_NODE_STALE_MS = 60_000

/**
 * Honesty rule: a run resolved to another node must show THAT node's own staleness, not the
 * roster-wide `asOf`. Returns `undefined` — nothing rendered — for every case that has no honest
 * age to give: `'self'` (this cockpit IS this node; asking whether it is stale has no honest
 * answer, same reasoning as `cluster-section.tsx`'s `derivePresence`), `'unknown'` (the node is
 * not on the roster at all, so there is no `lastSeenAt` to read), a `'known'` node that has never
 * connected (`lastSeenAt` absent), or one whose last reading is still within the fresh window.
 */
export function runNodeFreshness(
  info: TaskNodeInfo | undefined,
  nodes: readonly ClusterNode[],
  now: number,
): RunNodeFreshness | undefined {
  if (!info || info.kind !== 'known') return undefined
  const node = nodes.find((candidate) => candidate.nodeId === info.nodeId)
  if (!node?.lastSeenAt) return undefined
  const age = now - new Date(node.lastSeenAt).getTime()
  if (age < RUN_NODE_STALE_MS) return undefined
  return { ageText: shortAge(node.lastSeenAt, now) }
}
