import type { TaskAuthor } from '@loki-labs/better-cezar-api-client'
import { describe, expect, it } from 'vitest'
import {
  UNATTRIBUTED_LABEL,
  authorFacet,
  authorFacetLabel,
  authorLabel,
  authorTitle,
  shortTaskId,
  viaPhrase,
} from './task-author.ts'

/**
 * The Author column's pure half (`.ai/specs/2026-08-21-task-author-provenance.md`, Phase 4).
 *
 * The cases that matter are the ones where a WRONG answer would be worse than no answer: an
 * absent author must never render as a category (it is a record older than the field, not a
 * system task), and a `kind`/`via` this cockpit has never heard of must render as itself rather
 * than as the nearest thing it knows — an older cockpit reading a newer server is the normal
 * state of this app, not an edge case.
 */

const at = '2026-08-21T10:00:00.000Z'

function author(over: Partial<TaskAuthor> = {}): TaskAuthor {
  return { kind: 'user', id: 'local', via: 'composer', at, ...over } as TaskAuthor
}

describe('authorLabel', () => {
  it('names the user, preferring the display label over the raw id', () => {
    expect(authorLabel(author({ kind: 'user', id: 'u_123' }))).toBe('u_123')
    expect(authorLabel(author({ kind: 'user', id: 'u_123', label: 'Marcin' }))).toBe('Marcin')
  })

  it('renders an API client as API, never as a user', () => {
    expect(authorLabel(author({ kind: 'api', id: 'local', via: 'composer' }))).toBe('API')
  })

  it('points at the parent task for an agent author', () => {
    const a = author({
      kind: 'agent',
      id: '232ad6d4-58a5-421e-941f-5c24bd5a8452',
      via: 'cli-todo-add',
      parentTaskId: '232ad6d4-58a5-421e-941f-5c24bd5a8452',
      agentSessionId: 'cb916c71-974d-4fca-9aaa-f4c89b871b80',
    })
    expect(authorLabel(a)).toBe('⤷ 232ad6d4')
  })

  it('still renders an agent author whose parent id is missing', () => {
    // The schema's `.refine` makes this unconstructible through the server, but a hand-edited
    // runs.json reaches the cockpit unvalidated — it must not crash the table.
    expect(authorLabel({ kind: 'agent', id: 'x', via: 'cli-todo-add', at } as TaskAuthor)).toBe('agent')
  })

  it('renders an absent author as unattributed, not as a kind', () => {
    expect(authorLabel(undefined)).toBe(UNATTRIBUTED_LABEL)
    expect(authorLabel(undefined)).not.toBe('cezar')
  })

  it('shows a kind it has never heard of as itself', () => {
    expect(authorLabel({ kind: 'webhook', id: 'w', via: 'composer', at } as unknown as TaskAuthor)).toBe('webhook')
  })
})

describe('authorTitle', () => {
  it('always names the surface as well as the actor', () => {
    expect(authorTitle(author({ kind: 'user', id: 'local' }))).toBe('Started by local via the composer')
  })

  it('names the parent task, the session and the step for an agent', () => {
    const a = author({
      kind: 'agent',
      id: '232ad6d4-58a5-421e-941f-5c24bd5a8452',
      via: 'cli-todo-add',
      parentTaskId: '232ad6d4-58a5-421e-941f-5c24bd5a8452',
      agentSessionId: 'cb916c71-974d-4fca-9aaa-f4c89b871b80',
      parentStepId: 'implement',
    })
    expect(authorTitle(a)).toBe(
      'Started by an agent in task 232ad6d4, session cb916c71 (step implement) via cezar todo add',
    )
  })

  it('says why an absent author is absent, rather than guessing', () => {
    expect(authorTitle(undefined)).toContain('created before tasks recorded an author')
  })
})

describe('authorFacet', () => {
  it('keeps distinct users and automations apart', () => {
    expect(authorFacet(author({ kind: 'user', id: 'a' }))).toBe('user:a')
    expect(authorFacet(author({ kind: 'user', id: 'b' }))).toBe('user:b')
    expect(authorFacet(author({ kind: 'automation', id: 'auto-1' }))).toBe('automation:auto-1')
  })

  it('folds every agent-spawned task into ONE bucket, whatever its parent', () => {
    const one = author({ kind: 'agent', id: 'r1', parentTaskId: 'r1', agentSessionId: 's1' })
    const two = author({ kind: 'agent', id: 'r2', parentTaskId: 'r2', agentSessionId: 's2' })
    expect(authorFacet(one)).toBe(authorFacet(two))
  })

  it('gives an absent author its own bucket', () => {
    expect(authorFacet(undefined)).toBe('unattributed')
  })
})

describe('authorFacetLabel', () => {
  it('round-trips the identity-bearing facets back to a readable name', () => {
    expect(authorFacetLabel(authorFacet(author({ kind: 'user', id: 'Marcin' })))).toBe('Marcin')
    expect(authorFacetLabel(authorFacet(author({ kind: 'automation', id: 'nightly' })))).toBe('nightly')
    expect(authorFacetLabel(authorFacet(undefined))).toBe(UNATTRIBUTED_LABEL)
    expect(authorFacetLabel('agent')).toBe('Agent')
  })
})

describe('viaPhrase and shortTaskId', () => {
  it('translates a known surface and passes an unknown one through', () => {
    expect(viaPhrase('todo-autostart')).toBe('autostart')
    expect(viaPhrase('some-future-door')).toBe('some-future-door')
  })

  it('shortens a uuid to its first block', () => {
    expect(shortTaskId('232ad6d4-58a5-421e-941f-5c24bd5a8452')).toBe('232ad6d4')
    expect(shortTaskId('short')).toBe('short')
  })
})
