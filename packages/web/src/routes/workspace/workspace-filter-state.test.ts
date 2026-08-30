import { describe, expect, it } from 'vitest'

import type { WorkspaceUiState } from '@loki-labs/cezar-plus-api-client'
import {
  parseWorkspaceTasksSearch,
  readStoredWorkspaceTasksFilter,
  resolveWorkspaceTasksFilter,
  sameWorkspaceTasksFilter,
  workspaceTasksSearchParams,
  workspaceTasksUiStatePatch,
} from './workspace-filter-state'

/**
 * `workspace-filter-state.ts` (W4.10), `.ai/specs/2026-08-06-workspace-notes-cross-project.md`
 * "UI/UX" — "Filter state lives in the URL". Pure, so this is table-tested like the sibling
 * `lib/last-location.test.ts`.
 */

describe('parseWorkspaceTasksSearch', () => {
  it('no `projects` param parses to `null` (URL silent, not ALL yet — that decision is the caller\'s)', () => {
    const parsed = parseWorkspaceTasksSearch(new URLSearchParams(''))
    expect(parsed.projects).toBeNull()
    expect(parsed.view).toBeNull()
  })

  it('splits a csv `projects` param, trimming whitespace', () => {
    const parsed = parseWorkspaceTasksSearch(new URLSearchParams('projects=alpha, beta ,gamma'))
    expect(parsed.projects).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('a present-but-empty `projects` param is an explicit "no projects", never `null`', () => {
    const parsed = parseWorkspaceTasksSearch(new URLSearchParams('projects='))
    expect(parsed.projects).toEqual([])
  })

  it('an unrecognized `view` value is treated as absent, not passed through', () => {
    const parsed = parseWorkspaceTasksSearch(new URLSearchParams('view=bogus'))
    expect(parsed.view).toBeNull()
  })

  it('parses a valid `view`', () => {
    expect(parseWorkspaceTasksSearch(new URLSearchParams('view=archived')).view).toBe('archived')
  })
})

describe('readStoredWorkspaceTasksFilter', () => {
  it('undefined ui-state has no stored filter', () => {
    expect(readStoredWorkspaceTasksFilter(undefined)).toBeUndefined()
  })

  it('an absent `workspaceTasks` key has no stored filter', () => {
    expect(readStoredWorkspaceTasksFilter({} as WorkspaceUiState)).toBeUndefined()
  })

  it('reads a well-formed stored filter off the open bag', () => {
    const uiState = { workspaceTasks: { projects: ['alpha', 'beta'], view: 'archived' } } as unknown as WorkspaceUiState
    expect(readStoredWorkspaceTasksFilter(uiState)).toEqual({ projects: ['alpha', 'beta'], view: 'archived' })
  })

  it('a corrupt entry (wrong shape) degrades to "nothing stored", never a throw', () => {
    const uiState = { workspaceTasks: 'not an object' } as unknown as WorkspaceUiState
    expect(readStoredWorkspaceTasksFilter(uiState)).toBeUndefined()
  })

  it('a malformed `projects` value (not a string array) is dropped, `view` alone survives', () => {
    const uiState = { workspaceTasks: { projects: [1, 2], view: 'active' } } as unknown as WorkspaceUiState
    expect(readStoredWorkspaceTasksFilter(uiState)).toEqual({ view: 'active' })
  })
})

describe('resolveWorkspaceTasksFilter', () => {
  const registry = ['alpha', 'beta', 'gamma']

  it('nothing in the URL and nothing stored: ALL projects, `view` defaults to active', () => {
    const resolved = resolveWorkspaceTasksFilter(new URLSearchParams(''), undefined, registry)
    expect(resolved.filter).toEqual({ projects: undefined, view: 'active' })
    expect(resolved.droppedIds).toEqual([])
    expect(resolved.needsUrlRewrite).toBe(false)
  })

  it('the URL always wins over storage — an explicit link is never overridden', () => {
    const stored = { workspaceTasks: { projects: ['gamma'], view: 'archived' } } as unknown as WorkspaceUiState
    const resolved = resolveWorkspaceTasksFilter(new URLSearchParams('projects=alpha,beta&view=active'), stored, registry)
    expect(resolved.filter).toEqual({ projects: ['alpha', 'beta'], view: 'active' })
  })

  it('URL carries no `projects` param: the stored selection is restored', () => {
    const stored = { workspaceTasks: { projects: ['beta'] } } as unknown as WorkspaceUiState
    const resolved = resolveWorkspaceTasksFilter(new URLSearchParams(''), stored, registry)
    expect(resolved.filter.projects).toEqual(['beta'])
    // Restoring from storage alone does not force a URL correction — a bare link stays bare.
    expect(resolved.needsUrlRewrite).toBe(false)
  })

  it('URL carries no `projects` param and nothing is stored: ALL, never none', () => {
    const resolved = resolveWorkspaceTasksFilter(new URLSearchParams(''), {} as WorkspaceUiState, registry)
    expect(resolved.filter.projects).toBeUndefined()
  })

  it('an unknown id in the URL is dropped and the URL is flagged for a rewrite', () => {
    const resolved = resolveWorkspaceTasksFilter(new URLSearchParams('projects=alpha,ghost'), undefined, registry)
    expect(resolved.filter.projects).toEqual(['alpha'])
    expect(resolved.droppedIds).toEqual(['ghost'])
    expect(resolved.needsUrlRewrite).toBe(true)
  })

  it('an unknown id restored from storage is dropped WITHOUT flagging a URL rewrite (the URL never claimed it)', () => {
    const stored = { workspaceTasks: { projects: ['alpha', 'ghost'] } } as unknown as WorkspaceUiState
    const resolved = resolveWorkspaceTasksFilter(new URLSearchParams(''), stored, registry)
    expect(resolved.filter.projects).toEqual(['alpha'])
    expect(resolved.droppedIds).toEqual(['ghost'])
    expect(resolved.needsUrlRewrite).toBe(false)
  })

  it('an explicit empty `projects=` param is honored as a real "no projects" selection', () => {
    const resolved = resolveWorkspaceTasksFilter(new URLSearchParams('projects='), undefined, registry)
    expect(resolved.filter.projects).toEqual([])
    expect(resolved.needsUrlRewrite).toBe(false)
  })

  it('registry not loaded yet: ids pass through unfiltered rather than all reading as unknown', () => {
    const resolved = resolveWorkspaceTasksFilter(new URLSearchParams('projects=alpha,ghost'), undefined, undefined)
    expect(resolved.filter.projects).toEqual(['alpha', 'ghost'])
    expect(resolved.droppedIds).toEqual([])
    expect(resolved.needsUrlRewrite).toBe(false)
  })
})

describe('workspaceTasksSearchParams', () => {
  it('omits `projects` entirely for ALL', () => {
    const params = workspaceTasksSearchParams({ projects: undefined, view: 'active' })
    expect(params.has('projects')).toBe(false)
    expect(params.get('view')).toBe('active')
  })

  it('writes an explicit empty selection as `projects=`, not an absent param', () => {
    const params = workspaceTasksSearchParams({ projects: [], view: 'active' })
    expect(params.get('projects')).toBe('')
  })

  it('joins a selection as csv', () => {
    const params = workspaceTasksSearchParams({ projects: ['alpha', 'beta'], view: 'archived' })
    expect(params.get('projects')).toBe('alpha,beta')
    expect(params.get('view')).toBe('archived')
  })
})

describe('sameWorkspaceTasksFilter', () => {
  it('ALL equals ALL', () => {
    expect(sameWorkspaceTasksFilter({ projects: undefined, view: 'active' }, { projects: undefined, view: 'active' })).toBe(true)
  })

  it('ALL is never equal to an explicit list, even the full registry', () => {
    expect(sameWorkspaceTasksFilter({ projects: undefined, view: 'active' }, { projects: ['alpha'], view: 'active' })).toBe(false)
  })

  it('order matters — the URL and the stored value should not thrash over a reorder', () => {
    expect(sameWorkspaceTasksFilter({ projects: ['a', 'b'], view: 'active' }, { projects: ['b', 'a'], view: 'active' })).toBe(false)
  })

  it('a view change breaks equality', () => {
    expect(sameWorkspaceTasksFilter({ projects: ['a'], view: 'active' }, { projects: ['a'], view: 'archived' })).toBe(false)
  })
})

describe('workspaceTasksUiStatePatch', () => {
  it('ALL projects patches without a `projects` key', () => {
    expect(workspaceTasksUiStatePatch({ projects: undefined, view: 'active' })).toEqual({
      workspaceTasks: { view: 'active' },
    })
  })

  it('an explicit selection is included verbatim', () => {
    expect(workspaceTasksUiStatePatch({ projects: ['alpha'], view: 'archived' })).toEqual({
      workspaceTasks: { projects: ['alpha'], view: 'archived' },
    })
  })
})
