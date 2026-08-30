import type { ClusterActiveRun, ClusterNode } from '@loki-labs/cezar-plus-api-client'
import { describe, expect, it } from 'vitest'

import {
  resolveRunNode,
  resolveTaskNode,
  runNodeFreshness,
  shortNodeId,
  taskNodeLabel,
  taskNodeTitle,
} from './task-node'

/**
 * The pure resolver behind "which worker is processing this?" — see `task-node.ts`'s own doc
 * block for why this exists. The honesty rules are the point: absence must not read as "local",
 * and an unresolvable id must not read as blank.
 */

function node(overrides: Partial<ClusterNode> & Pick<ClusterNode, 'nodeId' | 'nodeName'>): ClusterNode {
  return {
    role: 'spoke',
    labels: [],
    acceptsDispatch: true,
    protocol: { major: 1, minor: 0 },
    version: '0.10.0',
    ...overrides,
  }
}

const HUB = node({ nodeId: 'hub-1', nodeName: 'Hub' })
const SPOKE = node({ nodeId: 'spoke-2', nodeName: 'Laptop' })
const NODES: ClusterNode[] = [HUB, SPOKE]

describe('resolveTaskNode', () => {
  it('is undefined when the todo makes no node claim at all — the common-case empty state', () => {
    expect(resolveTaskNode({}, NODES, 'hub-1')).toBeUndefined()
  })

  it('resolves startedOn against the roster as a known, non-self node', () => {
    const info = resolveTaskNode({ startedOn: 'spoke-2' }, NODES, 'hub-1')
    expect(info).toEqual({ source: 'started', kind: 'known', nodeId: 'spoke-2', name: 'Laptop' })
  })

  it('marks startedOn matching the roster self id as "self", not merely "known"', () => {
    const info = resolveTaskNode({ startedOn: 'hub-1' }, NODES, 'hub-1')
    expect(info).toEqual({ source: 'started', kind: 'self', nodeId: 'hub-1' })
  })

  it('negative half of self: the SAME nodeId is "known", not "self", when self is a different node', () => {
    const info = resolveTaskNode({ startedOn: 'hub-1' }, NODES, 'spoke-2')
    expect(info).toEqual({ source: 'started', kind: 'known', nodeId: 'hub-1', name: 'Hub' })
  })

  it('renders an unresolvable startedOn as "unknown" with the id carried, never blank', () => {
    const info = resolveTaskNode({ startedOn: 'ghost-9' }, NODES, 'hub-1')
    expect(info).toEqual({ source: 'started', kind: 'unknown', nodeId: 'ghost-9' })
  })

  it('falls back to placement.node when there is no startedOn yet', () => {
    const info = resolveTaskNode({ placement: { node: 'spoke-2' } }, NODES, 'hub-1')
    expect(info).toEqual({ source: 'placement', kind: 'known', nodeId: 'spoke-2', name: 'Laptop' })
  })

  it('startedOn wins over placement.node when a todo somehow carries both', () => {
    const info = resolveTaskNode({ startedOn: 'hub-1', placement: { node: 'spoke-2' } }, NODES, undefined)
    expect(info).toEqual({ source: 'started', kind: 'known', nodeId: 'hub-1', name: 'Hub' })
  })

  it('placement with no node (requires-only) is still no claim to render', () => {
    expect(resolveTaskNode({ placement: { requires: ['gpu'] } }, NODES, 'hub-1')).toBeUndefined()
  })

  it('an unresolved selfNodeId (no identity yet) never accidentally matches — negative half of self', () => {
    const info = resolveTaskNode({ startedOn: 'hub-1' }, NODES, undefined)
    expect(info?.kind).toBe('known')
  })
})

describe('taskNodeLabel / taskNodeTitle', () => {
  it('labels self as "this node", not the raw id', () => {
    const info = resolveTaskNode({ startedOn: 'hub-1' }, NODES, 'hub-1')!
    expect(taskNodeLabel(info)).toBe('this node')
    expect(taskNodeTitle(info)).toBe('Running on this node')
  })

  it('labels a known node by its roster name', () => {
    const info = resolveTaskNode({ startedOn: 'spoke-2' }, NODES, 'hub-1')!
    expect(taskNodeLabel(info)).toBe('Laptop')
    expect(taskNodeTitle(info)).toBe('Running on Laptop')
  })

  it('labels an unknown node with the id, and says so plainly in the title', () => {
    const info = resolveTaskNode({ startedOn: 'ghost-9' }, NODES, 'hub-1')!
    expect(taskNodeLabel(info)).toBe('unknown node (ghost-9)')
    expect(taskNodeTitle(info)).toContain('not on the current roster')
    expect(taskNodeTitle(info)).toContain('ghost-9')
  })

  it('says "Pinned to", not "Running on", for a placement-only claim', () => {
    const info = resolveTaskNode({ placement: { node: 'spoke-2' } }, NODES, 'hub-1')!
    expect(taskNodeTitle(info)).toBe('Pinned to Laptop')
  })
})

describe('shortNodeId', () => {
  it('leaves a short id untouched', () => {
    expect(shortNodeId('hub-node-1')).toBe('hub-node-1')
  })

  it('truncates a long id with an ellipsis', () => {
    const long = 'a'.repeat(40)
    const short = shortNodeId(long)
    expect(short.endsWith('…')).toBe(true)
    expect(short.length).toBeLessThan(long.length)
  })
})

function activeRun(overrides: Partial<ClusterActiveRun> & Pick<ClusterActiveRun, 'runId' | 'nodeId'>): ClusterActiveRun {
  return {
    summary: 'doing something',
    paths: [],
    ...overrides,
  }
}

describe('resolveRunNode', () => {
  it('is undefined while self is not yet known and the run is not reported elsewhere — honest "not yet known", never a guessed id', () => {
    expect(resolveRunNode('r_1', [], NODES, undefined)).toBeUndefined()
  })

  it('a run not reported in /cluster/active is local by construction: "self"', () => {
    const info = resolveRunNode('r_1', [], NODES, 'hub-1')
    expect(info).toEqual({ source: 'started', kind: 'self', nodeId: 'hub-1' })
  })

  it('the SAME run stays "self" even when /cluster/active is empty — an empty active list is not evidence of anything', () => {
    const info = resolveRunNode('r_1', [], NODES, 'hub-1')
    expect(info?.kind).toBe('self')
  })

  it('a run reported in /cluster/active on ANOTHER node resolves as that known node', () => {
    const info = resolveRunNode('r_1', [activeRun({ runId: 'r_1', nodeId: 'spoke-2' })], NODES, 'hub-1')
    expect(info).toEqual({ source: 'started', kind: 'known', nodeId: 'spoke-2', name: 'Laptop' })
  })

  it('negative half of self vs other: the SAME runId/nodeId pair resolves to "self" when self IS that node', () => {
    const info = resolveRunNode('r_1', [activeRun({ runId: 'r_1', nodeId: 'spoke-2' })], NODES, 'spoke-2')
    expect(info).toEqual({ source: 'started', kind: 'self', nodeId: 'spoke-2' })
  })

  it('a run reported on a node the roster no longer carries resolves as "unknown", never blank or self', () => {
    const info = resolveRunNode('r_1', [activeRun({ runId: 'r_1', nodeId: 'ghost-9' })], NODES, 'hub-1')
    expect(info).toEqual({ source: 'started', kind: 'unknown', nodeId: 'ghost-9' })
  })

  it('only the matching runId is read — an unrelated active run does not leak onto this one', () => {
    const info = resolveRunNode(
      'r_1',
      [activeRun({ runId: 'r_2', nodeId: 'spoke-2' })],
      NODES,
      'hub-1',
    )
    expect(info).toEqual({ source: 'started', kind: 'self', nodeId: 'hub-1' })
  })
})

describe('runNodeFreshness', () => {
  const now = new Date('2026-08-24T12:00:00.000Z').getTime()

  it('undefined for "self" — a node cannot honestly report its own staleness', () => {
    const info = resolveRunNode('r_1', [], NODES, 'hub-1')
    expect(runNodeFreshness(info, NODES, now)).toBeUndefined()
  })

  it('undefined for "unknown" — no roster entry means no lastSeenAt to read', () => {
    const info = resolveRunNode('r_1', [activeRun({ runId: 'r_1', nodeId: 'ghost-9' })], NODES, 'hub-1')
    expect(runNodeFreshness(info, NODES, now)).toBeUndefined()
  })

  it('undefined for a known node whose last reading is within the fresh window', () => {
    const fresh: ClusterNode = { ...SPOKE, lastSeenAt: new Date(now - 10_000).toISOString() }
    const info = resolveRunNode('r_1', [activeRun({ runId: 'r_1', nodeId: 'spoke-2' })], [HUB, fresh], 'hub-1')
    expect(runNodeFreshness(info, [HUB, fresh], now)).toBeUndefined()
  })

  it('renders the age of a stale known node — negative half of the fresh case above', () => {
    const stale: ClusterNode = { ...SPOKE, lastSeenAt: new Date(now - 15 * 60_000).toISOString() }
    const info = resolveRunNode('r_1', [activeRun({ runId: 'r_1', nodeId: 'spoke-2' })], [HUB, stale], 'hub-1')
    expect(runNodeFreshness(info, [HUB, stale], now)).toEqual({ ageText: '15m' })
  })

  it('undefined for a known node that has never connected — absent lastSeenAt is not "stale", it is "no reading at all"', () => {
    const neverConnected: ClusterNode = { ...SPOKE, lastSeenAt: undefined }
    const info = resolveRunNode('r_1', [activeRun({ runId: 'r_1', nodeId: 'spoke-2' })], [HUB, neverConnected], 'hub-1')
    expect(runNodeFreshness(info, [HUB, neverConnected], now)).toBeUndefined()
  })
})
