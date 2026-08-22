import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CopyIcon, NetworkIcon, PlusIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import type {
  ClusterCapacity,
  ClusterCapacityEnforcement,
  ClusterEnrollRequest,
  ClusterEnrollResponse,
  ClusterEnrollRevokeResponse,
  ClusterNode,
  ClusterNodePatch,
  ClusterNodeRevokeResponse,
  ClusterOverviewResponse,
  ClusterQueuedReason,
  ClusterRepoFreshness,
} from '@loki-labs/better-cezar-api-client'
import { apiPath, clusterQueuedReasonSchema } from '@loki-labs/better-cezar-api-client'
import { ApiError } from '@/api/client'
import { useHealth } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { StatusDot } from '@/components/status-dot'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { formatDuration, shortAge } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Settings → Cluster (Phase 1b, packages 1b.2 + 1b.3, `.ai/specs/2026-08-22-multi-node-cezar-
 * cluster.md` "Phases → Phase 1b", D17). Workspace scope: the fleet is a property of this
 * machine's cockpit, not of any one repo.
 *
 * `visibleSettingsSections` (`registry.tsx`, package 1b.1, NOT owned here) keeps this section out
 * of the nav and unrouted while `capabilities.cluster` is false — but this file renders its own
 * off state too, on the same `sources-section.tsx` precedent: `capabilities.cluster` is read via
 * `useHealth()` FIRST, and `GET /api/v1/cluster` is fetched only once it reads `true`. That
 * ordering is load-bearing, not defensive polish — `health.ts`'s own docblock (CORRECTED
 * 2026-08-22 during implementation, twice — see its own note and `cluster.ts`'s module header for
 * the full history) is explicit that the flag buys "no route" behaviourally and `/api/v1/cluster*`
 * answers **409** with a stated reason while `CEZ_CLUSTER` is unset (Verification 12; 404 was
 * considered and rejected because it already means `UNKNOWN_CONNECTION`/unknown-node-id on this
 * same route family), so racing the roster fetch ahead of the capability read would 409 on every
 * cold boot before the flag is confirmed on.
 *
 * ## What this file owns, and what it deliberately does not
 *
 * Owned: the node roster (`ClusterOverviewResponse.nodes`), the three honesty rules on how a
 * row renders, and *Add node* (mint / render / copy / revoke a single-use join code). Both the
 * roster GET and the enroll POST/DELETE are called with a hand-rolled `fetch` wrapper below
 * rather than through `@/api/client` + `@/api/queries` — this package's OWNED file list is
 * exactly `cluster-section.tsx` + its test, so it may not add wrapper functions to files it does
 * not own (the same constraint `sources-section.tsx`'s own docblock names for the same reason).
 * `clusterFetch` below is that file's `unwiredSourceMutation` pattern taken one step further:
 * real requests against the documented routes, since this package (unlike Sources at the time it
 * was written) DOES own the route family it is calling.
 *
 * NOT owned, and deliberately not built here: `cluster/enrollment.ts` (still throwing "not
 * implemented" as of this writing — package 1.2) and `server/cluster-routes.ts` (package 1.0/
 * 1b.3's backend half). This component calls the routes the spec's "API contracts" section
 * documents and renders whatever they answer; it does not assume either file is finished.
 *
 * ## The four honesty rules a node row carries (spec, Phase 1b)
 *
 * 1. **A spoke's capacity is a claim, not a measurement** — rendered with `capacityAt`'s age.
 * 2. **Presence is a claim too** — `lastSeenAt` older than a fresh window renders its age
 *    (`derivePresence`/`PresenceBadge`), so a 40-minute-old reading never reads as current.
 * 3. **`enforcement: 'none'` renders as a stated limitation**, not a silently absent field.
 * 4. **Offline is a state, not an error** — a stale/asleep node renders "asleep since HH:MM" in
 *    neutral tone, never the danger tone a real failure gets.
 *
 * ## D12's four queued reasons — rendered here as a static reference, ahead of their owner
 *
 * The spec is explicit that the queued-reason RENDER lands with Phase 4 ("placement is what
 * produces the reasons; 1b's job is to make sure the node-level facts behind each of them are
 * already on screen") and the plan assigns the live wiring to package 4.1, which touches this
 * file again (`cluster-section.tsx` "queued-reason subtree"). This package's own brief asked for
 * the four distinct strings now anyway, so `QueuedReasonsReference` renders them as a static,
 * honestly-labelled reference (sourced from the contract's own enum, not fabricated), not as a
 * live queued-run list — there is no run/placement data to attach them to yet. Package 4.1 should
 * replace this block with the real "queued: <reason>, blocked by <run>" render and may reuse
 * `QUEUED_REASON_COPY`.
 */

// ---- a hand-rolled request layer for the routes this file owns (see module docblock) -----------

function parseJsonSafe(body: string): unknown {
  if (!body) return undefined
  try {
    return JSON.parse(body) as unknown
  } catch {
    return undefined
  }
}

async function clusterFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = apiPath(path)
  let res: Response
  try {
    res = await fetch(url, {
      ...init,
      credentials: 'include',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    })
  } catch (cause) {
    throw new ApiError(0, `cannot reach the cezar server (${url})`, { cause })
  }
  const bodyText = await res.text()
  if (!res.ok) {
    const parsed = parseJsonSafe(bodyText)
    const message =
      parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
        ? ((parsed as { error: string }).error)
        : `${res.status} ${res.statusText || 'request failed'}`
    throw new ApiError(res.status, message)
  }
  if (!bodyText) return undefined as T
  const parsed = parseJsonSafe(bodyText)
  if (parsed === undefined) {
    throw new ApiError(res.status, `the cezar server answered ${path} with a non-JSON body`)
  }
  return parsed as T
}

const CLUSTER_QUERY_KEY = ['cluster', 'overview'] as const

/** `enabled: false` until the capability read confirms the route exists — see the module
 *  docblock on why this ordering is load-bearing, not defensive polish. */
function useClusterOverview(enabled: boolean) {
  return useQuery({
    queryKey: CLUSTER_QUERY_KEY,
    queryFn: ({ signal }) => clusterFetch<ClusterOverviewResponse>('/cluster', { signal }),
    enabled,
  })
}

function useMintEnrollCode() {
  return useMutation({
    mutationFn: (input: ClusterEnrollRequest) =>
      clusterFetch<ClusterEnrollResponse>('/cluster/enroll', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  })
}

function useRevokeEnrollCode() {
  return useMutation({
    mutationFn: (codeId: string) =>
      clusterFetch<ClusterEnrollRevokeResponse>(`/cluster/enroll/${encodeURIComponent(codeId)}`, {
        method: 'DELETE',
      }),
  })
}

function usePatchClusterNode() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ nodeId, patch }: { nodeId: string; patch: ClusterNodePatch }) =>
      // The wire response shape for this route is not separately named in the contract (only the
      // request, `ClusterNodePatch`, is) — treated here as opaque and never read; the roster
      // refetch below is what the row actually renders from.
      clusterFetch<unknown>(`/cluster/nodes/${encodeURIComponent(nodeId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: CLUSTER_QUERY_KEY }),
  })
}

function useRevokeClusterNode() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (nodeId: string) =>
      clusterFetch<ClusterNodeRevokeResponse>(`/cluster/nodes/${encodeURIComponent(nodeId)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: CLUSTER_QUERY_KEY }),
  })
}

// ---- top level ------------------------------------------------------------------------------------

export function ClusterSection() {
  const health = useHealth()

  // Health undecided yet: render neither branch — same reasoning as `sources-section.tsx`'s
  // `SourcesPane`: firing the roster query ahead of a confirmed "on" races the loading window
  // against a flag that may turn out to be off, and off means 409 here, not an empty roster.
  if (health.data === undefined) {
    return (
      <div data-route="settings-cluster" className="flex flex-col gap-4">
        <p data-slot="cluster-health-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
          Loading…
        </p>
      </div>
    )
  }

  const clusterAvailable = health.data.capabilities?.cluster === true

  return (
    <div data-route="settings-cluster" className="flex flex-col gap-4">
      {clusterAvailable ? (
        <ClusterPane />
      ) : (
        <CenteredState
          icon={<NetworkIcon />}
          tone="neutral"
          title="Clustering is off"
          subtitle="Set CEZ_CLUSTER=1 (and CEZ_CLUSTER_HUB on a spoke) and restart cezar to see and enroll other nodes."
          heading="h2"
        />
      )}
    </div>
  )
}

function ClusterPane() {
  const overview = useClusterOverview(true)
  const [now, setNow] = useState(() => Date.now())
  const [addOpen, setAddOpen] = useState(false)

  // Ticks the presence/capacity ages forward. Not a data refetch — no polling doctrine violated
  // (`api/query-client.ts`'s "no polling, the stream says when something changed") — just the
  // clock the honesty-rule badges read from.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(id)
  }, [])

  if (overview.isPending) {
    return (
      <p data-slot="cluster-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading nodes…
      </p>
    )
  }
  if (overview.isError) {
    return (
      <CenteredState
        icon={<NetworkIcon />}
        tone="danger"
        heading="h2"
        title="Cluster did not load"
        subtitle={overview.error.message}
      />
    )
  }
  const data = overview.data

  return (
    <div
      data-slot="cluster-section"
      className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Cluster</h2>
          <p className="text-[13px] text-muted-foreground">
            Every node linked to this hub, what it claims about its own capacity, and how to add
            one.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-action="cluster-add-node"
          onClick={() => setAddOpen(true)}
        >
          <PlusIcon aria-hidden="true" />
          Add node
        </Button>
      </div>

      {data.nodes.length === 0 ? (
        <CenteredState
          icon={<NetworkIcon />}
          tone="neutral"
          heading="h2"
          title="No nodes yet"
          subtitle="Add a node to start distributing work across machines."
          actions={
            <Button
              type="button"
              size="sm"
              data-action="cluster-add-node-empty"
              onClick={() => setAddOpen(true)}
            >
              Add node
            </Button>
          }
        />
      ) : (
        <ul
          data-slot="cluster-node-list"
          className="divide-y divide-border/60 rounded-md border border-border bg-card"
        >
          {data.nodes.map((node) => (
            <NodeRow
              key={node.nodeId}
              node={node}
              isSelf={data.self !== undefined && node.nodeId === data.self.nodeId}
              now={now}
            />
          ))}
        </ul>
      )}

      <QueuedReasonsReference />

      {addOpen ? <AddNodeDialog onOpenChange={setAddOpen} /> : null}
    </div>
  )
}

// ---- one node row ---------------------------------------------------------------------------------

const PRESENCE_FRESH_MS = 60_000

type Presence =
  | { kind: 'self' }
  | { kind: 'revoked' }
  | { kind: 'never-connected' }
  | { kind: 'online' }
  | { kind: 'asleep'; sinceLabel: string; ageText: string }

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Honesty rules 2 + 4: presence is a claim stamped with when it was made, and an old-but-online
 *  reading must never read as current — a node last seen 40 minutes ago is "asleep since HH:MM"
 *  with its age alongside, not a bare online dot. Self is never derived this way: this cockpit is
 *  running on it right now, so asking whether IT is stale is a question with no honest answer. */
function derivePresence(node: ClusterNode, isSelf: boolean, now: number): Presence {
  if (isSelf) return { kind: 'self' }
  if (node.disabledAt) return { kind: 'revoked' }
  if (!node.lastSeenAt) return { kind: 'never-connected' }
  const age = now - new Date(node.lastSeenAt).getTime()
  if (age < PRESENCE_FRESH_MS) return { kind: 'online' }
  return {
    kind: 'asleep',
    sinceLabel: clockTime(node.lastSeenAt),
    ageText: `${shortAge(node.lastSeenAt, now)} ago`,
  }
}

function PresenceBadge({ presence }: { presence: Presence }) {
  if (presence.kind === 'self') {
    return (
      <span
        data-slot="cluster-node-presence"
        data-presence="self"
        className="inline-flex items-center gap-1.5 text-[13px]"
      >
        <StatusDot tone="success" />
        <span className="font-medium text-foreground">This node</span>
      </span>
    )
  }
  if (presence.kind === 'revoked') {
    return (
      <span
        data-slot="cluster-node-presence"
        data-presence="revoked"
        className="inline-flex items-center gap-1.5 text-[13px]"
      >
        <StatusDot tone="danger" />
        <span className="font-medium text-foreground">Revoked</span>
      </span>
    )
  }
  if (presence.kind === 'never-connected') {
    return (
      <span
        data-slot="cluster-node-presence"
        data-presence="never-connected"
        className="inline-flex items-center gap-1.5 text-[13px]"
      >
        <StatusDot tone="neutral" />
        <span className="font-medium text-foreground">Never connected</span>
      </span>
    )
  }
  if (presence.kind === 'online') {
    return (
      <span
        data-slot="cluster-node-presence"
        data-presence="online"
        className="inline-flex items-center gap-1.5 text-[13px]"
      >
        <StatusDot tone="success" />
        <span className="font-medium text-foreground">Online</span>
      </span>
    )
  }
  // `asleep` — a STATE, not an error (spec honesty rule 3): neutral tone, never danger, and the
  // Mac sleeping is the normal case this is for.
  return (
    <span
      data-slot="cluster-node-presence"
      data-presence="asleep"
      className="inline-flex flex-wrap items-center gap-1.5 text-[13px]"
    >
      <StatusDot tone="neutral" />
      <span className="font-medium text-foreground">Asleep since {presence.sinceLabel}</span>
      <span data-slot="cluster-node-presence-age" className="text-soft-foreground">
        {presence.ageText}
      </span>
    </span>
  )
}

/** Honesty rule 1: capacity is a claim, stamped with when it was made — never presented as an
 *  observed fact. Absent `capacity` (a node that has never reported) renders as unreported, never
 *  as zeroes, which would be a false claim of idle capacity. */
function CapacityStat({
  capacity,
  capacityAt,
  now,
}: {
  capacity: ClusterCapacity | undefined
  capacityAt: string | undefined
  now: number
}) {
  if (!capacity) {
    return (
      <p data-slot="cluster-node-capacity-unreported" className="text-[12px] text-soft-foreground">
        Capacity not yet reported.
      </p>
    )
  }
  const heavyText =
    capacity.maxHeavySteps === undefined
      ? `${capacity.heavyActive} heavy (unbounded)`
      : `${capacity.heavyActive}/${capacity.maxHeavySteps} heavy`
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12.5px] text-muted-foreground">
      <span data-slot="cluster-node-capacity-parallel">
        {capacity.active}/{capacity.maxParallel} running
      </span>
      <span data-slot="cluster-node-capacity-heavy">{heavyText}</span>
      {capacityAt ? (
        <span
          data-slot="cluster-node-capacity-age"
          className="text-soft-foreground"
          title={`Claimed at ${capacityAt}`}
        >
          claimed {shortAge(capacityAt, now)} ago
        </span>
      ) : null}
    </div>
  )
}

const ENFORCEMENT_LABEL: Record<ClusterCapacityEnforcement, string> = {
  cgroup: 'cgroup',
  'process-tree': 'process-tree',
  none: 'none',
}

/** Honesty rule 3: `none` is rendered as a STATED limitation, not silence. The Mac has no
 *  cgroups, so its memory ceiling is the weaker guard — a limit that silently does not exist on
 *  one node is worse than one that was never claimed. */
function EnforcementBadge({ enforcement }: { enforcement: ClusterCapacityEnforcement | undefined }) {
  if (!enforcement) return null
  return (
    <div className="flex flex-col gap-1">
      <Badge
        variant="outline"
        data-slot="cluster-node-enforcement"
        data-enforcement={enforcement}
        className="w-fit text-[10.5px]"
      >
        enforcement: {ENFORCEMENT_LABEL[enforcement]}
      </Badge>
      {enforcement === 'none' ? (
        <p data-slot="cluster-node-enforcement-warning" className="text-[12px] text-soft-foreground">
          No resource ceiling is enforced on this node — a runaway task here has nothing to stop
          it.
        </p>
      ) : null}
    </div>
  )
}

function LabelsRow({ labels }: { labels: readonly string[] }) {
  if (labels.length === 0) {
    return (
      <p data-slot="cluster-node-labels-empty" className="text-[12px] text-soft-foreground">
        No labels discovered yet.
      </p>
    )
  }
  return (
    <div data-slot="cluster-node-labels" className="flex flex-wrap gap-1">
      {labels.map((label) => (
        <Badge key={label} variant="secondary" className="text-[11px]">
          {label}
        </Badge>
      ))}
    </div>
  )
}

/** The box's own `chat` checkout sat six hours mid-conflict showing one ordinary dirty file
 *  while every pull silently failed (spec §7/D-field-table) — `merging` is rendered distinctly
 *  from a plain dirty count for exactly that reason. */
function RepoDriftRow({ drift }: { drift: readonly ClusterRepoFreshness[] }) {
  if (drift.length === 0) return null
  return (
    <div data-slot="cluster-node-repo-drift" className="flex flex-col gap-1">
      {drift.map((entry) => (
        <div
          key={entry.projectKey}
          data-slot="cluster-node-repo-drift-row"
          data-project-key={entry.projectKey}
          data-merging={entry.merging}
          className={cn(
            'flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px]',
            entry.merging ? 'text-danger' : 'text-soft-foreground',
          )}
        >
          <span className="font-mono">{entry.headSha.slice(0, 7)}</span>
          <span>
            ↑{entry.ahead} ↓{entry.behind}
          </span>
          {entry.dirty > 0 ? <span>{entry.dirty} dirty</span> : null}
          {entry.merging ? (
            <span data-slot="cluster-node-repo-merging" className="font-medium">
              mid-conflict
            </span>
          ) : null}
        </div>
      ))}
    </div>
  )
}

function NodeRow({ node, isSelf, now }: { node: ClusterNode; isSelf: boolean; now: number }) {
  const presence = derivePresence(node, isSelf, now)
  return (
    <li
      data-slot="cluster-node-row"
      data-node-id={node.nodeId}
      data-role={node.role}
      className="flex flex-col gap-2.5 px-3.5 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-medium text-foreground">{node.nodeName}</span>
          <Badge variant="outline" className="text-[10.5px] uppercase">
            {node.role}
          </Badge>
        </div>
        <PresenceBadge presence={presence} />
      </div>

      <CapacityStat capacity={node.capacity} capacityAt={node.capacityAt} now={now} />
      <EnforcementBadge enforcement={node.capacity?.enforcement} />
      <LabelsRow labels={node.labels} />
      {node.repoDrift ? <RepoDriftRow drift={node.repoDrift} /> : null}
      <NodeActions node={node} disabled={isSelf} />
    </li>
  )
}

/** D11: the `acceptsDispatch` switch is shown where it is READ, never as an env var — and the
 *  spoke re-enforces it regardless of what the hub sends, so this switch is a request, not a
 *  guarantee. Disabled on self: a cockpit does not toggle or revoke the node it is running on. */
function NodeActions({ node, disabled }: { node: ClusterNode; disabled: boolean }) {
  const patchNode = usePatchClusterNode()
  const [confirmRevoke, setConfirmRevoke] = useState(false)

  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
        <Switch
          data-slot="cluster-node-accepts-dispatch"
          checked={node.acceptsDispatch}
          disabled={disabled || patchNode.isPending}
          onCheckedChange={(checked) =>
            patchNode.mutate({ nodeId: node.nodeId, patch: { acceptsDispatch: checked } })
          }
        />
        Accepts dispatch
      </label>
      {!disabled ? (
        <Button
          type="button"
          variant="danger-ghost"
          size="sm"
          data-action="cluster-node-revoke"
          onClick={() => setConfirmRevoke(true)}
        >
          Revoke
        </Button>
      ) : null}
      {patchNode.error ? (
        <p data-slot="cluster-node-dispatch-error" className="w-full text-[12px] text-danger">
          {patchNode.error.message}
        </p>
      ) : null}
      <RevokeNodeDialog node={node} open={confirmRevoke} onOpenChange={setConfirmRevoke} />
    </div>
  )
}

function RevokeNodeDialog({
  node,
  open,
  onOpenChange,
}: {
  node: ClusterNode
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const revokeNode = useRevokeClusterNode()

  useEffect(() => {
    if (open) revokeNode.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, node.nodeId])

  return (
    <Dialog open={open} onOpenChange={(next) => !revokeNode.isPending && onOpenChange(next)}>
      <DialogContent data-slot="cluster-node-revoke-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Revoke {node.nodeName}?</DialogTitle>
          <DialogDescription>
            Deletes this node&apos;s credential on both sides. It stops receiving replicated state,
            and any run it is holding is not migrated — work in progress there is lost unless it
            was already pushed.
          </DialogDescription>
        </DialogHeader>

        {revokeNode.error ? (
          <p data-slot="cluster-node-revoke-error" className="text-[13px] text-danger">
            {revokeNode.error.message}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={revokeNode.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger-ghost"
            data-action="cluster-node-revoke-confirm"
            disabled={revokeNode.isPending}
            onClick={() =>
              revokeNode.mutate(node.nodeId, { onSuccess: () => onOpenChange(false) })
            }
          >
            {revokeNode.isPending ? 'Revoking…' : 'Revoke'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---- D12: the four queued reasons, as a static reference (see module docblock) -------------------

const CLUSTER_QUEUED_REASONS = clusterQueuedReasonSchema.options

const QUEUED_REASON_COPY: Record<ClusterQueuedReason, string> = {
  'no-node-with-label': 'No node carries the label this task requires.',
  'all-eligible-at-capacity': 'Every eligible node is already at capacity.',
  'pinned-node-offline': 'The node this task needs is offline.',
  'project-has-no-origin': 'This project has no origin and may only run on the node that holds it.',
}

function QueuedReasonsReference() {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-slot="cluster-queued-reasons">
      <CollapsibleTrigger
        aria-label={`${open ? 'Hide' : 'Show'} why a task might queue`}
        className="text-[12px] font-medium text-muted-foreground hover:text-foreground"
      >
        {open ? 'Hide' : 'Why a task might queue instead of run'}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5">
        <dl className="flex flex-col gap-1.5">
          {CLUSTER_QUEUED_REASONS.map((reason) => (
            <div
              key={reason}
              data-slot="cluster-queued-reason"
              data-reason={reason}
              className="flex flex-col gap-0.5 text-[12px] sm:flex-row sm:gap-1.5"
            >
              <dt className="shrink-0 font-mono text-soft-foreground">{reason}</dt>
              <dd className="text-muted-foreground">{QUEUED_REASON_COPY[reason]}</dd>
            </div>
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  )
}

// ---- add node (D17) -------------------------------------------------------------------------------

/**
 * Mints a code the instant the dialog opens, renders the hub-rendered `join` command as the
 * primary copyable line (`commands.provision` — Phase 4's worker role — sits behind a disclosure
 * so the primary flow stays "one line to copy"), counts its TTL down, and lets it be revoked
 * before use. Never assembles or edits either command string — whatever the server renders is
 * what gets shown (D17: the hub pins its own version; this dialog must not second-guess it).
 */
function AddNodeDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const mint = useMintEnrollCode()
  const revokeCode = useRevokeEnrollCode()
  const [now, setNow] = useState(() => Date.now())
  const [provisionOpen, setProvisionOpen] = useState(false)

  useEffect(() => {
    mint.mutate({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!mint.data || revokeCode.isSuccess) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [mint.data, revokeCode.isSuccess])

  const expiresAtMs = mint.data ? new Date(mint.data.expiresAt).getTime() : undefined
  const remainingMs = expiresAtMs !== undefined ? Math.max(0, expiresAtMs - now) : undefined
  const expired = remainingMs === 0
  const revoked = revokeCode.isSuccess
  const codeUsable = mint.data !== undefined && !expired && !revoked

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast('Copied.')
    } catch {
      toast('Copy failed.', { tone: 'danger' })
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent data-slot="add-node-dialog">
        <DialogHeader>
          <DialogTitle>Add a node</DialogTitle>
          <DialogDescription>
            One command, pasted on the machine joining the cluster. It answers two independent
            gates: Cloudflare Access decides whether that machine may reach this hub at all —
            supply that credential from its own environment — and this code decides whether it is
            admitted as a node. The code is single-use and short-lived; it never carries the
            Access credential itself.
          </DialogDescription>
        </DialogHeader>

        {mint.isPending ? (
          <p data-slot="add-node-minting" className="text-[13px] text-soft-foreground">
            Minting a code…
          </p>
        ) : mint.isError ? (
          <p data-slot="add-node-error" className="text-[13px] text-danger">
            {mint.error.message}
          </p>
        ) : mint.data ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Run this on the joining machine
              </span>
              <div className="flex items-center gap-2">
                <code
                  data-slot="cluster-join-command"
                  className="min-w-0 flex-1 overflow-x-auto rounded-sm bg-muted px-2 py-1.5 font-mono text-[12px] whitespace-nowrap text-foreground"
                >
                  {mint.data.commands.join}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  disabled={!codeUsable}
                  title="Copy"
                  onClick={() => mint.data && void copy(mint.data.commands.join)}
                >
                  <CopyIcon aria-hidden="true" />
                </Button>
              </div>
            </div>

            <Collapsible open={provisionOpen} onOpenChange={setProvisionOpen}>
              <CollapsibleTrigger className="text-[12px] font-medium text-muted-foreground hover:text-foreground">
                {provisionOpen ? 'Hide' : 'Provisioning a fresh box instead?'}
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-1.5 flex items-center gap-2">
                <code
                  data-slot="cluster-provision-command"
                  className="min-w-0 flex-1 overflow-x-auto rounded-sm bg-muted px-2 py-1.5 font-mono text-[12px] whitespace-nowrap text-foreground"
                >
                  {mint.data.commands.provision}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  disabled={!codeUsable}
                  title="Copy"
                  onClick={() => mint.data && void copy(mint.data.commands.provision)}
                >
                  <CopyIcon aria-hidden="true" />
                </Button>
              </CollapsibleContent>
            </Collapsible>

            <p data-slot="cluster-code-status" className="text-[12px] text-soft-foreground">
              Single-use — the code stops working the instant it is redeemed once.{' '}
              {revoked ? (
                'Revoked.'
              ) : expired ? (
                'Expired.'
              ) : (
                <>
                  Expires in{' '}
                  <span data-slot="cluster-code-ttl">{formatDuration(remainingMs ?? 0)}</span>.
                </>
              )}
            </p>

            {revokeCode.error ? (
              <p data-slot="cluster-code-revoke-error" className="text-[13px] text-danger">
                {revokeCode.error.message}
              </p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          {codeUsable ? (
            <Button
              type="button"
              variant="danger-ghost"
              data-action="cluster-code-revoke"
              disabled={revokeCode.isPending}
              onClick={() => mint.data && revokeCode.mutate(mint.data.codeId)}
            >
              {revokeCode.isPending ? 'Revoking…' : 'Revoke code'}
            </Button>
          ) : null}
          {expired || mint.isError ? (
            <Button
              type="button"
              variant="outline"
              data-action="cluster-code-remint"
              onClick={() => mint.mutate({})}
            >
              Mint a new code
            </Button>
          ) : null}
          <Button type="button" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
