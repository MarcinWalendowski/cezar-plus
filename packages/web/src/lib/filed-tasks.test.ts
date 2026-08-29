import { describe, expect, it } from 'vitest'

import type { WorkspaceTodoEntry } from '@loki-labs/better-cezar-api-client'

import {
  DEFAULT_FILED_SORT,
  DEFAULT_FILED_TABLE_SORT,
  FILED_SORTABLE_COLUMNS,
  cycleFiledTableSort,
  filedAriaSort,
  filedPartitionOf,
  formatFiledTableSort,
  isDefaultFiledTableSort,
  parseFiledTableSort,
  FILED_PRIORITY_VALUES,
  FILED_STATUS_VALUES,
  NO_FILED_FILTERS,
  applyFiledPatch,
  filedFacetCounts,
  filedSelectionState,
  filedStatus,
  filedTaskKey,
  filedTasksExcludingFacet,
  filterFiledTasks,
  isFiledPriority,
  isFiledSort,
  isFiledStatus,
  isVisibleFiledEntry,
  matchesFiledView,
  selectedFiledEntries,
  setFiledSelection,
  sortFiledTasks,
  toggleFiledSelection,
  type FiledTaskFilters,
} from './filed-tasks'

/**
 * The Filed table's pure half (2026-08-17-filed-tasks-table-statuses.md): what belongs on
 * Active vs. Archived, the default sort and its reverse, the status/priority facets, and the
 * cache-patch semantics the optimistic archive/restore mutation applies.
 */

function entry(overrides: Partial<WorkspaceTodoEntry['todo']> & { id: string }): WorkspaceTodoEntry {
  return {
    project: 'api',
    todo: {
      ts: '2026-07-14T09:00:00Z',
      summary: overrides.id,
      ...overrides,
    },
  }
}

const filters = (overrides: Partial<FiledTaskFilters> = {}): FiledTaskFilters => ({
  ...NO_FILED_FILTERS,
  ...overrides,
})

const ids = (list: readonly WorkspaceTodoEntry[]) => list.map((e) => e.todo.id)

describe('filedStatus', () => {
  it('reads an absent status as `todo` — the default every legacy entry predates', () => {
    expect(filedStatus(entry({ id: 'a' }))).toBe('todo')
    expect(filedStatus(entry({ id: 'a', status: 'blocked' }))).toBe('blocked')
  })
})

describe('isVisibleFiledEntry', () => {
  it('hides a started entry — Start already turned it into a run', () => {
    expect(isVisibleFiledEntry(entry({ id: 'a' }))).toBe(true)
    expect(isVisibleFiledEntry(entry({ id: 'a', startedTaskId: 'task-1' }))).toBe(false)
  })
})

describe('matchesFiledView', () => {
  it('splits active from archived: not archived and not done vs. either', () => {
    const todo = entry({ id: 'a' })
    const done = entry({ id: 'b', status: 'done' })
    const archived = entry({ id: 'c', archivedAt: '2026-07-15T00:00:00Z' })
    // Both at once: done AND explicitly archived — still exactly one view, not neither.
    const both = entry({ id: 'd', status: 'done', archivedAt: '2026-07-15T00:00:00Z' })

    expect(matchesFiledView(todo, 'active')).toBe(true)
    expect(matchesFiledView(todo, 'archived')).toBe(false)
    expect(matchesFiledView(done, 'active')).toBe(false)
    expect(matchesFiledView(done, 'archived')).toBe(true)
    expect(matchesFiledView(archived, 'active')).toBe(false)
    expect(matchesFiledView(archived, 'archived')).toBe(true)
    expect(matchesFiledView(both, 'archived')).toBe(true)
  })
})

describe('filterFiledTasks', () => {
  const entries: WorkspaceTodoEntry[] = [
    entry({ id: 'todo-1', ts: '2026-07-14T09:00:00Z', priority: 'high' }),
    entry({ id: 'blocked-1', ts: '2026-07-13T09:00:00Z', status: 'blocked', priority: 'low' }),
    entry({ id: 'done-1', ts: '2026-07-12T09:00:00Z', status: 'done' }),
    entry({ id: 'archived-1', ts: '2026-07-11T09:00:00Z', archivedAt: '2026-07-12T00:00:00Z' }),
    // Started: an audit-trail row, invisible on either view regardless of status/archive.
    entry({ id: 'started-1', ts: '2026-07-10T09:00:00Z', status: 'done', startedTaskId: 'task-9' }),
  ]

  it('splits active from archived, with the started row hidden on BOTH', () => {
    expect(ids(filterFiledTasks(entries, NO_FILED_FILTERS, 'active', ''))).toEqual(['todo-1', 'blocked-1'])
    expect(ids(filterFiledTasks(entries, NO_FILED_FILTERS, 'archived', ''))).toEqual(['done-1', 'archived-1'])
    // `started-1` would otherwise qualify for Archived (status: done) — still absent.
    expect(ids(filterFiledTasks(entries, NO_FILED_FILTERS, 'active', ''))).not.toContain('started-1')
    expect(ids(filterFiledTasks(entries, NO_FILED_FILTERS, 'archived', ''))).not.toContain('started-1')
  })

  it('narrows by status', () => {
    expect(ids(filterFiledTasks(entries, filters({ statuses: ['blocked'] }), 'active', ''))).toEqual([
      'blocked-1',
    ])
  })

  it('narrows by priority, and an unset priority never matches a non-empty selection', () => {
    expect(ids(filterFiledTasks(entries, filters({ priorities: ['high'] }), 'active', ''))).toEqual([
      'todo-1',
    ])
    // `todo-1` has a priority; a `low`-only filter must not also return it.
    expect(ids(filterFiledTasks(entries, filters({ priorities: ['low'] }), 'active', ''))).toEqual([
      'blocked-1',
    ])
  })

  it('narrows by the page query, across summary/context/whatToDo, every-token AND', () => {
    const withText: WorkspaceTodoEntry[] = [
      entry({ id: 'a', summary: 'Add a rate limit to /checkout', context: 'Checkout is hot.' }),
      entry({ id: 'b', summary: 'Ship the storefront banner' }),
    ]
    expect(ids(filterFiledTasks(withText, NO_FILED_FILTERS, 'active', 'checkout'))).toEqual(['a'])
    expect(ids(filterFiledTasks(withText, NO_FILED_FILTERS, 'active', 'checkout hot'))).toEqual(['a'])
    expect(ids(filterFiledTasks(withText, NO_FILED_FILTERS, 'active', 'checkout storefront'))).toEqual([])
  })
})

describe('filedTasksExcludingFacet / filedFacetCounts', () => {
  const entries: WorkspaceTodoEntry[] = [
    entry({ id: 'a', priority: 'high', status: 'blocked' }),
    entry({ id: 'b', priority: 'high', status: 'todo' }),
    entry({ id: 'c', priority: 'low', status: 'todo' }),
    // No priority at all — never counted under any priority value.
    entry({ id: 'd', status: 'todo' }),
  ]

  it('counts a facet against the list the OTHER facet leaves', () => {
    const current = filters({ statuses: ['todo'] })
    const counts = filedFacetCounts(
      filedTasksExcludingFacet(entries, current, 'active', '', 'priorities'),
      (e) => e.todo.priority,
    )
    // `a` is excluded by the status pin (blocked), so `high` counts only `b`.
    expect(counts.get('high')).toBe(1)
    expect(counts.get('low')).toBe(1)
    expect([...counts.values()].reduce((sum, n) => sum + n, 0)).toBe(2)
  })
})

describe('sortFiledTasks', () => {
  it('defaults to created-desc — newest first', () => {
    expect(DEFAULT_FILED_SORT).toBe('created-desc')
    const entries: WorkspaceTodoEntry[] = [
      entry({ id: 'old', ts: '2026-07-10T09:00:00Z' }),
      entry({ id: 'new', ts: '2026-07-14T09:00:00Z' }),
      entry({ id: 'mid', ts: '2026-07-12T09:00:00Z' }),
    ]
    expect(ids(sortFiledTasks(entries, 'created-desc'))).toEqual(['new', 'mid', 'old'])
    expect(ids(sortFiledTasks(entries, 'created-asc'))).toEqual(['old', 'mid', 'new'])
  })

  it('sorts an entry with no `ts` LAST, in both directions', () => {
    const entries: WorkspaceTodoEntry[] = [
      entry({ id: 'no-ts', ts: undefined }),
      entry({ id: 'new', ts: '2026-07-14T09:00:00Z' }),
      entry({ id: 'old', ts: '2026-07-10T09:00:00Z' }),
    ]
    expect(ids(sortFiledTasks(entries, 'created-desc'))).toEqual(['new', 'old', 'no-ts'])
    expect(ids(sortFiledTasks(entries, 'created-asc'))).toEqual(['old', 'new', 'no-ts'])
  })

  it('sorts an unparseable `ts` LAST too, rather than crashing', () => {
    const entries: WorkspaceTodoEntry[] = [
      entry({ id: 'garbage', ts: 'not-a-date' }),
      entry({ id: 'new', ts: '2026-07-14T09:00:00Z' }),
    ]
    expect(ids(sortFiledTasks(entries, 'created-desc'))).toEqual(['new', 'garbage'])
    expect(ids(sortFiledTasks(entries, 'created-asc'))).toEqual(['new', 'garbage'])
  })
})

describe('isFiledStatus / isFiledPriority / isFiledSort', () => {
  it('accepts exactly the declared value sets', () => {
    for (const status of FILED_STATUS_VALUES) expect(isFiledStatus(status)).toBe(true)
    expect(isFiledStatus('cancelled')).toBe(false)
    for (const priority of FILED_PRIORITY_VALUES) expect(isFiledPriority(priority)).toBe(true)
    expect(isFiledPriority('urgent')).toBe(false)
    expect(isFiledSort('created-desc')).toBe(true)
    expect(isFiledSort('created-asc')).toBe(true)
    expect(isFiledSort('title-asc')).toBe(false)
  })
})

/**
 * `applyFiledPatch` mirrors the server's `updateTodo` (`packages/cezar/src/todos.ts`) on the
 * cache, so an optimistic row and a server-confirmed one read identically.
 */
describe('applyFiledPatch', () => {
  it('sets status/priority independently, leaving the other field untouched', () => {
    const todo = entry({ id: 'a', priority: 'low' }).todo
    expect(applyFiledPatch(todo, { status: 'blocked' })).toEqual({ ...todo, status: 'blocked' })
    expect(applyFiledPatch(todo, { priority: 'high' })).toEqual({ ...todo, priority: 'high' })
  })

  it('archiving stamps `archivedAt`; restoring REMOVES the key rather than setting it undefined', () => {
    const todo = entry({ id: 'a' }).todo
    const archived = applyFiledPatch(todo, { archived: true })
    expect(archived.archivedAt).toEqual(expect.any(String))

    const restored = applyFiledPatch(archived, { archived: false })
    expect('archivedAt' in restored).toBe(false)
    expect(Object.keys(restored).sort()).toEqual(Object.keys(todo).sort())
  })
})

describe('filed task selection', () => {
  const web = (id: string): WorkspaceTodoEntry => ({
    project: 'web',
    todo: { id, ts: '2026-07-14T09:00:00Z', summary: id },
  })

  it('keys a row by project and id', () => {
    expect(filedTaskKey(entry({ id: 'todo-1' }))).toBe('api:todo-1')
    expect(filedTaskKey(web('todo-1'))).toBe('web:todo-1')
  })

  it('toggles one row on and back off into new sets', () => {
    const empty: ReadonlySet<string> = new Set()
    const one = toggleFiledSelection(empty, 'api:todo-1')
    expect([...one]).toEqual(['api:todo-1'])
    expect(one).not.toBe(empty)
    expect([...toggleFiledSelection(one, 'api:todo-1')]).toEqual([])
  })

  it('sets or unsets a batch without disturbing the rest', () => {
    const start = new Set(['api:todo-9'])
    const on = setFiledSelection(start, ['api:todo-1', 'web:todo-2'], true)
    expect([...on].sort()).toEqual(['api:todo-1', 'api:todo-9', 'web:todo-2'])
    const off = setFiledSelection(on, ['api:todo-1', 'web:todo-2'], false)
    expect([...off]).toEqual(['api:todo-9'])
  })

  it('returns visible selected rows in display order', () => {
    const visible = [web('todo-2'), entry({ id: 'todo-1' })]
    const selected = new Set(['api:todo-1', 'web:todo-2', 'api:todo-hidden'])
    expect(selectedFiledEntries(visible, selected).map(filedTaskKey)).toEqual([
      'web:todo-2',
      'api:todo-1',
    ])
    expect(selectedFiledEntries([entry({ id: 'todo-1' })], selected).map(filedTaskKey)).toEqual([
      'api:todo-1',
    ])
  })

  it('reports all three select-all states and never all of nothing', () => {
    const keys = ['api:todo-1', 'web:todo-2']
    expect(filedSelectionState(keys, new Set())).toBe('none')
    expect(filedSelectionState(keys, new Set(['api:todo-1']))).toBe('some')
    expect(filedSelectionState(keys, new Set(keys))).toBe('all')
    expect(filedSelectionState([], new Set(['api:todo-1']))).toBe('none')
  })
})

/**
 * Per-table sorting (`.ai/specs/2026-08-25-split-active-backlog-tables.md`, D3/D6, verification
 * step 5). The ORDER itself is the server's and is tested there
 * (`workspace/todo-ordering.test.ts`); what these cover is the vocabulary the URL and the header
 * cells speak, and the forgiveness a pasted or hand-edited URL needs.
 */
describe('filed table sorts', () => {
  it('formats and parses the composite grammar', () => {
    expect(formatFiledTableSort({ column: 'priority', dir: 'asc' })).toBe('priority:asc')
    expect(parseFiledTableSort('priority:asc')).toEqual({ column: 'priority', dir: 'asc' })
  })

  it('accepts the LEGACY created-desc / created-asc spellings as aliases for age', () => {
    // Muscle memory from the Archived table's own `fsort`, and from the dropdown this replaced.
    expect(parseFiledTableSort('created-desc')).toEqual({ column: 'age', dir: 'desc' })
    expect(parseFiledTableSort('created-asc')).toEqual({ column: 'age', dir: 'asc' })
  })

  it('anything unrecognised falls back to the default WHOLE, never half-applied', () => {
    for (const raw of ['', 'garbage', 'garbage:sideways', 'age:sideways', 'node:asc', 'age', ':asc', null, undefined]) {
      expect(parseFiledTableSort(raw)).toEqual(DEFAULT_FILED_TABLE_SORT)
    }
  })

  it('`node` is not a sortable column — it means nothing on a single-node cockpit', () => {
    expect(FILED_SORTABLE_COLUMNS).not.toContain('node')
    expect([...FILED_SORTABLE_COLUMNS].sort()).toEqual(['age', 'author', 'priority', 'project', 'status', 'task'])
  })

  it('the click cycle is asc -> desc -> asc on the sorted column, and asc on any other', () => {
    const start = DEFAULT_FILED_TABLE_SORT // age:desc
    const first = cycleFiledTableSort(start, 'age')
    expect(first).toEqual({ column: 'age', dir: 'asc' })
    expect(cycleFiledTableSort(first, 'age')).toEqual({ column: 'age', dir: 'desc' })
    // A different column always starts ascending — there is no third "unsorted" state, because
    // the server must always be asked for SOME order.
    expect(cycleFiledTableSort(first, 'project')).toEqual({ column: 'project', dir: 'asc' })
  })

  it('aria-sort names the sorted column and says `none` for every other sortable one', () => {
    const sort = { column: 'task', dir: 'asc' } as const
    expect(filedAriaSort(sort, 'task')).toBe('ascending')
    expect(filedAriaSort({ column: 'task', dir: 'desc' }, 'task')).toBe('descending')
    expect(filedAriaSort(sort, 'age')).toBe('none')
  })

  it('isDefaultFiledTableSort is what keeps a bare /tasks bare', () => {
    expect(isDefaultFiledTableSort(DEFAULT_FILED_TABLE_SORT)).toBe(true)
    expect(isDefaultFiledTableSort({ column: 'age', dir: 'asc' })).toBe(false)
    expect(isDefaultFiledTableSort({ column: 'task', dir: 'desc' })).toBe(false)
  })

  it('filedPartitionOf: todo (and absent) is Backlog, everything else is Active', () => {
    const entry = (status?: 'todo' | 'in-progress' | 'blocked' | 'done'): WorkspaceTodoEntry => ({
      project: 'api',
      todo: { id: 't', summary: 'x', ...(status === undefined ? {} : { status }) },
    })
    expect(filedPartitionOf(entry())).toBe('backlog')
    expect(filedPartitionOf(entry('todo'))).toBe('backlog')
    expect(filedPartitionOf(entry('in-progress'))).toBe('active')
    expect(filedPartitionOf(entry('blocked'))).toBe('active')
    expect(filedPartitionOf(entry('done'))).toBe('active')
  })
})
