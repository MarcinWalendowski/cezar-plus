import { describe, expect, it } from 'vitest'

import type { ProjectListEntry, RunIndexEntry } from '@loki-labs/cezar-plus-api-client'

import {
  NO_FILTERS,
  UNTAGGED,
  WORKSPACE_GROUP,
  WORKSPACE_LABEL,
  activeFacetCount,
  allStatuses,
  canReset,
  resetCount,
  allWorkflows,
  facetCounts,
  filterGlobalTasks,
  groupGlobalTasks,
  hasActiveFilters,
  inFlightGlobalTasks,
  tagValuesOf,
  tasksExcludingFacet,
  GROUP_BY_OPTIONS,
  SEARCH_PARAMS,
  DEFAULT_URL_STATE,
  urlStateFromSearchParams,
  urlStateToSearchParams,
  toGlobalTasks,
  toggleFacetValue,
  toggleGroupBy,
  truncatedProjectNames,
  type GlobalTaskFilters,
  type GlobalTasksUrlState,
} from './global-tasks'
import { allProjectTags } from './project-tags'
import { parseFiledDetailKey } from './filed-tasks'

/**
 * The global Tasks page's behavior, as a table. What matters here and nowhere else:
 * tags belong to PROJECTS (so grouping by tag fans a task out across every tag its repo
 * carries), facets are sets that OR inside and AND across, and a run whose project has left the
 * registry still renders.
 */

function project(overrides: Partial<ProjectListEntry> & { id: string }): ProjectListEntry {
  return {
    name: overrides.id,
    root: `/repos/${overrides.id}`,
    addedAt: '2026-07-01T10:00:00Z',
    lastOpenedAt: '2026-07-01T10:00:00Z',
    source: 'local',
    status: 'ok',
    ...overrides,
  }
}

function run(overrides: Partial<RunIndexEntry> & { id: string; projectId: string }): RunIndexEntry {
  return {
    title: overrides.id,
    status: 'done',
    createdAt: '2026-07-14T10:00:00Z',
    archived: false,
    workflow: 'quick-task',
    ...overrides,
  }
}

// api + web are one piece of work ("storefront"); infra is its own; loose carries no tags.
const PROJECTS: ProjectListEntry[] = [
  project({ id: 'api', name: 'API', tags: ['backend', 'storefront'] }),
  project({ id: 'web', name: 'Web', tags: ['storefront'] }),
  project({ id: 'infra', name: 'Infra', tags: ['infra'] }),
  project({ id: 'loose', name: 'Loose' }),
]

const RUNS: RunIndexEntry[] = [
  run({ id: 'a1', projectId: 'api', title: 'Add checkout endpoint', status: 'running', branch: 'feat/checkout' }),
  run({ id: 'w1', projectId: 'web', title: 'Checkout page', status: 'review', workflow: 'plan-first' }),
  run({ id: 'i1', projectId: 'infra', title: 'Bump the runner', status: 'done' }),
  run({ id: 'l1', projectId: 'loose', title: 'Tidy the scripts', status: 'done' }),
  run({ id: 'old', projectId: 'api', title: 'Filed away', status: 'done', archived: true }),
]

const tasks = toGlobalTasks(RUNS, PROJECTS)
const filters = (overrides: Partial<GlobalTaskFilters> = {}): GlobalTaskFilters => ({
  ...NO_FILTERS,
  ...overrides,
})
const ids = (list: readonly { run: RunIndexEntry }[]) => list.map((task) => task.run.id)

describe('toGlobalTasks', () => {
  it('resolves each run to its project name and the project’s tags', () => {
    const api = tasks.find((task) => task.run.id === 'a1')
    expect(api?.projectName).toBe('API')
    expect(api?.tags).toEqual(['backend', 'storefront'])
  })

  it('keeps a run whose project has left the registry, falling back to the raw id', () => {
    const orphan = toGlobalTasks([run({ id: 'x', projectId: 'gone' })], PROJECTS)[0]
    expect(orphan?.project).toBeUndefined()
    expect(orphan?.projectName).toBe('gone')
    expect(orphan?.tags).toEqual([])
  })

  it('preserves the server’s newest-first order rather than inventing its own', () => {
    expect(ids(tasks)).toEqual(['a1', 'w1', 'i1', 'l1', 'old'])
  })
})

/**
 * A WORKSPACE run (`.ai/specs/2026-08-15-cross-project-workspace-run.md`) is stored in the boot
 * project's `runs.json` because a `RunManager` has to be bound to a repository — "a storage fact,
 * not a scoping claim", D1's own words. It is about every registered project, so the board must
 * not present the boot repo as its home.
 */
describe('workspace runs', () => {
  // The owner's own install: the boot repo is a dedicated, unregistered scaffold, so it has no
  // registry row at all — which is why nothing here appears in `PROJECTS`.
  const workspaceRun = run({ id: 'ws', projectId: 'cockpit-boot', title: 'Bump the lint rule', workspace: true })
  const bootRun = run({ id: 'boot', projectId: 'cockpit-boot', title: 'Tidy the scaffold' })

  it('labels a workspace run `Workspace` rather than the repo its record lives in', () => {
    // The mutation: `projectName: project?.name || run.projectId`, ignoring `run.workspace`. The
    // cell, this label and the group-by-project heading all read this one field, so reverting it
    // silently puts `cockpit-boot` back in all three.
    const [task] = toGlobalTasks([workspaceRun], PROJECTS)
    expect(task?.projectName).toBe(WORKSPACE_LABEL)
  })

  it('leaves an ORDINARY run that lives in the boot repo showing its own project', () => {
    // The control that keeps the label from becoming "anything in the boot repo": labelling every
    // boot-repo row `Workspace` fails here. Unregistered, so it falls back to the raw id exactly
    // as any other unknown project does.
    const [task] = toGlobalTasks([bootRun], PROJECTS)
    expect(task?.projectName).toBe('cockpit-boot')
  })

  it('groups the two apart, even though they share a project id', () => {
    // Keyed on `projectId` alone the two would land in one group whose heading is whichever row
    // arrived first — a heading decided by a coin flip. The mutation: drop the `run.workspace`
    // branch from `groupGlobalTasks`.
    const groups = groupGlobalTasks(toGlobalTasks([workspaceRun, bootRun], PROJECTS), 'project')
    // Sorted by key for the assertion: the two are the same size, so their ORDER is the module's
    // ordinary size-then-label tie-break and not what this test is about.
    expect(
      groups.map((group) => [group.key, group.label, ...group.tasks.map((task) => task.run.id)]).sort(),
    ).toEqual([
      [WORKSPACE_GROUP, WORKSPACE_LABEL, 'ws'],
      ['cockpit-boot', 'cockpit-boot', 'boot'],
    ].sort())
  })
})

/**
 * `spec-to-deploy` is the workflow the server resolves to when a run names none (the 2026-08-19
 * default change), so it is what nearly every row carries — and printed raw it reads as a choice
 * somebody made. It displays as `default`. **Display only**: the stored name, the API body, the CLI
 * flag and the facet VALUE are all still `spec-to-deploy`, which is what
 * `BACKWARD_COMPATIBILITY.md` protects. (`quick-task`, the old floor, is now an ordinary named pick
 * and shows itself verbatim — covered by `tasks-table.test.ts`.)
 */
describe('the spec-to-deploy display name', () => {
  const wf = (id: string, workflow: string) => run({ id, projectId: 'api', workflow })

  it('groups under the identity but heads the group with the display name', () => {
    // The mutation: `push(task.run.workflow, task.run.workflow, …)`. The key must stay the raw
    // name — it is the group's identity, and a label in a key is how display text leaks into
    // state — while the heading a reader sees is the display text.
    const groups = groupGlobalTasks(
      toGlobalTasks([wf('a', 'spec-to-deploy'), wf('b', 'plan-first')], PROJECTS),
      'workflow',
    )
    expect(groups.map((group) => [group.key, group.label]).sort()).toEqual(
      [
        ['spec-to-deploy', 'default'],
        ['plan-first', 'plan-first'],
      ].sort(),
    )
  })

  it('is findable by BOTH spellings — what the column prints and what the record stores', () => {
    // The mutation: drop either `task.run.workflow` or `displayWorkflowName(...)` from `haystack`.
    // Typing what the column shows must find the row; so must typing the name the API, the CLI
    // and every existing bookmark still use.
    const tasks = toGlobalTasks([wf('a', 'spec-to-deploy'), wf('b', 'plan-first')], PROJECTS)
    const matched = (query: string) =>
      filterGlobalTasks(tasks, filters({ query }), 'active').map((task) => task.run.id)
    expect(matched('default')).toEqual(['a'])
    expect(matched('spec-to-deploy')).toEqual(['a'])
    // The control: the mapping must not make every row match either word.
    expect(matched('plan-first')).toEqual(['b'])
  })

  it('filters on the stored name, so a shared `?workflow=spec-to-deploy` link still works', () => {
    // The display-only contract, made testable. The facet VALUE is the identity; renaming it
    // would silently break every URL anyone has already shared or bookmarked.
    const tasks = toGlobalTasks([wf('a', 'spec-to-deploy'), wf('b', 'plan-first')], PROJECTS)
    expect(allWorkflows(tasks)).toEqual(['plan-first', 'spec-to-deploy'])
    expect(
      filterGlobalTasks(tasks, filters({ workflows: ['spec-to-deploy'] }), 'active').map((t) => t.run.id),
    ).toEqual(['a'])
    // And not on the label — `default` is not a workflow anybody can filter by.
    expect(filterGlobalTasks(tasks, filters({ workflows: ['default'] }), 'active')).toEqual([])
  })
})

describe('option lists', () => {
  it('dedupes tags across projects, case-insensitively, and sorts them', () => {
    expect(allProjectTags(PROJECTS)).toEqual(['backend', 'infra', 'storefront'])
    expect(
      allProjectTags([project({ id: 'a', tags: ['API'] }), project({ id: 'b', tags: ['api'] })]),
    ).toEqual(['API'])
  })

  it('derives workflows and statuses from the tasks actually present', () => {
    expect(allWorkflows(tasks)).toEqual(['plan-first', 'quick-task'])
    expect(allStatuses(tasks)).toEqual(['done', 'review', 'running'])
  })
})

describe('filterGlobalTasks', () => {
  it('splits active from archived', () => {
    expect(ids(filterGlobalTasks(tasks, NO_FILTERS, 'active'))).toEqual(['a1', 'w1', 'i1', 'l1'])
    expect(ids(filterGlobalTasks(tasks, NO_FILTERS, 'archived'))).toEqual(['old'])
  })

  it('ORs values inside one facet', () => {
    const picked = filterGlobalTasks(tasks, filters({ workflows: ['plan-first'] }), 'active')
    expect(ids(picked)).toEqual(['w1'])
    expect(ids(filterGlobalTasks(tasks, filters({ statuses: ['running', 'done'] }), 'active'))).toEqual([
      'a1',
      'i1',
      'l1',
    ])
  })

  it('has no project facet — picking a project is a link to its own page, not a filter', () => {
    expect(Object.keys(NO_FILTERS)).toEqual(['query', 'tags', 'statuses', 'workflows'])
  })

  it('ANDs across facets', () => {
    const picked = filterGlobalTasks(
      tasks,
      filters({ tags: ['storefront'], statuses: ['running'] }),
      'active',
    )
    expect(ids(picked)).toEqual(['a1'])
  })

  it('matches a tag on the PROJECT, so one tag reaches several repos', () => {
    expect(ids(filterGlobalTasks(tasks, filters({ tags: ['storefront'] }), 'active'))).toEqual([
      'a1',
      'w1',
    ])
  })

  it('matches a tag regardless of case', () => {
    expect(ids(filterGlobalTasks(tasks, filters({ tags: ['STOREFRONT'] }), 'active'))).toEqual([
      'a1',
      'w1',
    ])
  })

  it('finds the untagged projects through the sentinel', () => {
    expect(ids(filterGlobalTasks(tasks, filters({ tags: [UNTAGGED] }), 'active'))).toEqual(['l1'])
  })

  it('requires every query token, matching title, project, workflow, branch and tags', () => {
    expect(ids(filterGlobalTasks(tasks, filters({ query: 'checkout' }), 'active'))).toEqual([
      'a1',
      'w1',
    ])
    // Two tokens from two different fields: the project name and the title.
    expect(ids(filterGlobalTasks(tasks, filters({ query: 'web checkout' }), 'active'))).toEqual(['w1'])
    expect(ids(filterGlobalTasks(tasks, filters({ query: 'feat/checkout' }), 'active'))).toEqual(['a1'])
    expect(ids(filterGlobalTasks(tasks, filters({ query: 'infra' }), 'active'))).toEqual(['i1'])
  })

  it('does not match the run id — the table never prints it', () => {
    expect(filterGlobalTasks(tasks, filters({ query: 'a1' }), 'active')).toEqual([])
  })
})

/**
 * The Running section's row set (`.ai/specs/2026-08-19-tasks-page-and-start-grounding.md`, D1).
 *
 * The fixture above only has `running`/`review`/`done`, so these build their own: the point of the
 * section is which statuses count as in flight, and a set that never contains a `queued` or an
 * auto-resuming row cannot tell a correct answer from one that just happens to match.
 */
describe('inFlightGlobalTasks', () => {
  const LIVE_RUNS: RunIndexEntry[] = [
    run({ id: 'q', projectId: 'api', status: 'queued', createdAt: '2026-07-14T09:00:00Z' }),
    run({ id: 'q2', projectId: 'api', status: 'queued', createdAt: '2026-07-14T08:00:00Z' }),
    run({ id: 'r', projectId: 'api', status: 'running' }),
    run({ id: 'w', projectId: 'web', status: 'waiting' }),
    run({ id: 'rev', projectId: 'web', status: 'review' }),
    run({ id: 'sched', projectId: 'infra', status: 'failed', autoResumeAt: '2026-07-14T12:00:00Z' }),
    run({ id: 'done', projectId: 'infra', status: 'done' }),
    run({ id: 'failed', projectId: 'infra', status: 'failed' }),
    run({ id: 'cancelled', projectId: 'loose', status: 'cancelled' }),
    run({ id: 'gone', projectId: 'loose', status: 'running', archived: true }),
  ]
  const live = toGlobalTasks(LIVE_RUNS, PROJECTS)

  it('keeps every status that is work, and drops every status that is an outcome', () => {
    const inFlight = ids(inFlightGlobalTasks(live, 'active'))
    expect(new Set(inFlight)).toEqual(new Set(['q', 'q2', 'r', 'w', 'rev', 'sched']))
    // The negative control that makes the assertion above mean something: without it, a helper
    // that simply returned everything would pass.
    expect(inFlight).not.toContain('done')
    expect(inFlight).not.toContain('failed')
    expect(inFlight).not.toContain('cancelled')
  })

  it('preserves the page order rather than imposing a second one', () => {
    // A FILTER, not a sort (see the helper's own note): the first cut ranked these by status
    // weight, which silently re-ordered rows the rest of the page renders in index order. The
    // fixture is deliberately in an order no status ranking would produce.
    expect(ids(inFlightGlobalTasks(live, 'active'))).toEqual(['q', 'q2', 'r', 'w', 'rev', 'sched'])
  })

  it('drops an archived run even when its status says running', () => {
    // `bucketOf` answers on status alone, so this row IS "in flight" by status and must still be
    // dropped — the archived split is what `sortRuns` applies, and the helper is built from its
    // output for exactly this case.
    expect(ids(inFlightGlobalTasks(live, 'active'))).not.toContain('gone')
  })

  it('is empty on the archived view — nothing archived is in flight', () => {
    expect(inFlightGlobalTasks(live, 'archived')).toEqual([])
  })

  it('is empty when nothing is running, which is what hides the section entirely', () => {
    const settled = toGlobalTasks(
      [run({ id: 'd', projectId: 'api', status: 'done' })],
      PROJECTS,
    )
    expect(inFlightGlobalTasks(settled, 'active')).toEqual([])
  })

  it('steps aside entirely when an explicit grouping is chosen', () => {
    // Pinning is the DEFAULT organisation, not a layer over the chosen one. Lifting rows out
    // while `groupBy: 'tag'` is in force would empty the very boxes the reader asked for.
    for (const groupBy of ['project', 'tag', 'status', 'workflow'] as const) {
      expect(inFlightGlobalTasks(live, 'active', groupBy)).toEqual([])
    }
    // …and the default is still the pinned one, which is what makes the line above a narrowing
    // rather than a switch that happens to be off.
    expect(ids(inFlightGlobalTasks(live, 'active', 'none')).length).toBeGreaterThan(0)
  })

  it('is a view over the ALREADY-FILTERED list, so the page filters reach it', () => {
    const narrowed = filterGlobalTasks(live, filters({ tags: ['infra'] }), 'active')
    expect(ids(inFlightGlobalTasks(narrowed, 'active'))).toEqual(['sched'])
  })
})

describe('groupGlobalTasks', () => {
  const active = filterGlobalTasks(tasks, NO_FILTERS, 'active')

  it('renders one unlabeled group when grouping is off', () => {
    const groups = groupGlobalTasks(active, 'none')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.label).toBe('')
    expect(ids(groups[0]!.tasks)).toEqual(['a1', 'w1', 'i1', 'l1'])
  })

  it('fans a task out across every tag its project carries', () => {
    const groups = groupGlobalTasks(active, 'tag')
    expect(groups.map((group) => group.label)).toEqual([
      'storefront', // 2 tasks — biggest first
      'backend',
      'infra',
      'Untagged', // always last: leftovers, not a group
    ])
    expect(ids(groups.find((group) => group.label === 'storefront')!.tasks)).toEqual(['a1', 'w1'])
    expect(ids(groups.find((group) => group.label === 'backend')!.tasks)).toEqual(['a1'])
  })

  it('groups by project, status and workflow without fanning out', () => {
    expect(groupGlobalTasks(active, 'project').map((group) => group.label).sort()).toEqual([
      'API',
      'Infra',
      'Loose',
      'Web',
    ])
    const byStatus = groupGlobalTasks(active, 'status')
    expect(byStatus.reduce((total, group) => total + group.tasks.length, 0)).toBe(active.length)
    expect(groupGlobalTasks(active, 'workflow').map((group) => group.key).sort()).toEqual([
      'plan-first',
      'quick-task',
    ])
  })
})

describe('facet counts', () => {
  it('counts a facet against the list the OTHER facets leave', () => {
    // Tags are pinned to `storefront`; the workflow counts must reflect that, so a workflow with
    // no storefront work says 0 instead of promising rows that are not there.
    const current = filters({ tags: ['storefront'] })
    const counts = facetCounts(
      tasksExcludingFacet(tasks, current, 'active', 'workflows'),
      (task) => [task.run.workflow],
    )
    expect(counts.get('plan-first')).toBe(1)
    expect(counts.get('quick-task')).toBe(1)
    // `i1`/`l1` are outside the storefront tag, so their workflow does not count twice.
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(2)
  })

  it('counts the untagged bucket through the same value function the filter uses', () => {
    const counts = facetCounts(filterGlobalTasks(tasks, NO_FILTERS, 'active'), tagValuesOf)
    expect(counts.get('storefront')).toBe(2)
    expect(counts.get(UNTAGGED)).toBe(1)
  })

  it('excludes only the named facet, keeping the rest applied', () => {
    const current = filters({ statuses: ['done'], tags: [UNTAGGED] })
    // Dropping the status facet leaves the tag one in force.
    expect(ids(tasksExcludingFacet(tasks, current, 'active', 'statuses'))).toEqual(['l1'])
  })
})

describe('group-by is a toggle, not a radio', () => {
  it('offers no "None" option — nothing pressed IS not grouped', () => {
    expect(GROUP_BY_OPTIONS.map((option) => option.value)).toEqual([
      'project',
      'tag',
      'status',
      'workflow',
    ])
  })

  it('turns a grouping on, and releases it when it is already the one in force', () => {
    expect(toggleGroupBy('none', 'tag')).toBe('tag')
    expect(toggleGroupBy('tag', 'tag')).toBe('none')
    // Pressing a different one switches rather than releasing.
    expect(toggleGroupBy('tag', 'project')).toBe('project')
  })
})

describe('filter state helpers', () => {
  it('toggles a value in and out without mutating', () => {
    const before = ['a']
    expect(toggleFacetValue(before, 'b')).toEqual(['a', 'b'])
    expect(toggleFacetValue(before, 'a')).toEqual([])
    expect(before).toEqual(['a'])
  })

  it('counts only facet values, not the query', () => {
    expect(activeFacetCount(filters({ query: 'x' }))).toBe(0)
    expect(activeFacetCount(filters({ tags: ['a'], statuses: ['b'], workflows: ['c'] }))).toBe(3)
  })

  it('treats a non-empty query as an active filter', () => {
    expect(hasActiveFilters(NO_FILTERS)).toBe(false)
    expect(hasActiveFilters(filters({ query: '  ' }))).toBe(false)
    expect(hasActiveFilters(filters({ query: 'x' }))).toBe(true)
    expect(hasActiveFilters(filters({ tags: [UNTAGGED] }))).toBe(true)
  })
})

describe('canReset / resetCount', () => {
  it('covers a grouping applied with no filters at all', () => {
    // Otherwise the button hides and the table sits boxed up with nothing to click.
    expect(canReset({ filters: NO_FILTERS, groupBy: 'none' })).toBe(false)
    expect(canReset({ filters: NO_FILTERS, groupBy: 'tag' })).toBe(true)
    expect(canReset({ filters: filters({ tags: ['a'] }), groupBy: 'none' })).toBe(true)
    expect(canReset({ filters: filters({ query: 'x' }), groupBy: 'none' })).toBe(true)
  })

  it('counts every narrowing the button will undo, grouping and query included', () => {
    // The reported bug: one tag plus a grouping is TWO things applied, and the button said (1).
    expect(resetCount({ filters: filters({ tags: ['a'] }), groupBy: 'tag' })).toBe(2)
    expect(resetCount({ filters: NO_FILTERS, groupBy: 'none' })).toBe(0)
    expect(resetCount({ filters: filters({ query: 'x' }), groupBy: 'none' })).toBe(1)
    // Whitespace is not a filter.
    expect(resetCount({ filters: filters({ query: '  ' }), groupBy: 'none' })).toBe(0)
    expect(
      resetCount({
        filters: filters({ query: 'x', tags: ['a', 'b'], statuses: ['done'] }),
        groupBy: 'project',
      }),
    ).toBe(5)
  })
})

describe('URL state', () => {
  const state = (over: Partial<GlobalTasksUrlState> = {}): GlobalTasksUrlState => ({
    ...DEFAULT_URL_STATE,
    ...over,
  })
  const roundTrip = (over: Partial<GlobalTasksUrlState> = {}) =>
    urlStateFromSearchParams(urlStateToSearchParams(state(over)))

  it('emits nothing for a bare page, so /tasks stays a bare /tasks', () => {
    expect(urlStateToSearchParams(DEFAULT_URL_STATE).toString()).toBe('')
  })

  it('round-trips every facet, the grouping and the view', () => {
    const over = {
      filters: {
        query: 'checkout',
        tags: ['storefront', 'infra'],
        statuses: ['running', 'review'],
        workflows: ['plan-first'],
      },
      groupBy: 'tag' as const,
      view: 'archived' as const,
    }
    expect(roundTrip(over)).toEqual(state(over))
  })

  it('repeats a key per value rather than joining them', () => {
    // A separator would be breakable by a tag that contains it; repeating cannot be.
    const params = urlStateToSearchParams(state({ filters: filters({ tags: ['a,b', 'c'] }) }))
    expect(params.getAll(SEARCH_PARAMS.tag)).toEqual(['a,b', 'c'])
  })

  it('carries the untagged bucket as its own flag', () => {
    // Not a `tag` value: the sentinel's leading space would serialize confusingly, and spelled
    // without it, it would be ambiguous with a repo actually tagged `untagged`.
    const params = urlStateToSearchParams(state({ filters: filters({ tags: [UNTAGGED, 'infra'] }) }))
    expect(params.get(SEARCH_PARAMS.untagged)).toBe('1')
    expect(params.getAll(SEARCH_PARAMS.tag)).toEqual(['infra'])
    expect(urlStateFromSearchParams(params).filters.tags).toEqual(['infra', UNTAGGED])
  })

  it('spells only the archived view, because active is the default', () => {
    expect(urlStateToSearchParams(state({ view: 'active' })).has(SEARCH_PARAMS.archived)).toBe(false)
    expect(urlStateToSearchParams(state({ view: 'archived' })).get(SEARCH_PARAMS.archived)).toBe('1')
    expect(urlStateFromSearchParams(new URLSearchParams('archived=1')).view).toBe('archived')
    expect(urlStateFromSearchParams(new URLSearchParams('')).view).toBe('active')
  })

  it('trims the query and omits an empty one', () => {
    expect(urlStateToSearchParams(state({ filters: filters({ query: '   ' }) })).toString()).toBe('')
    expect(
      urlStateToSearchParams(state({ filters: filters({ query: '  hi  ' }) })).get(
        SEARCH_PARAMS.query,
      ),
    ).toBe('hi')
  })

  it('omits the grouping when there is none, and names it when there is', () => {
    expect(urlStateToSearchParams(DEFAULT_URL_STATE).has(SEARCH_PARAMS.groupBy)).toBe(false)
    expect(urlStateToSearchParams(state({ groupBy: 'project' })).get(SEARCH_PARAMS.groupBy)).toBe(
      'project',
    )
  })

  it('round-trips the Filed section’s own facets and sort under their `f`-prefixed keys', () => {
    const over = {
      filedFilters: { statuses: ['blocked', 'done'], priorities: ['high'] },
      filedSort: 'created-asc' as const,
    }
    expect(roundTrip(over)).toEqual(state(over))
    const params = urlStateToSearchParams(state(over))
    expect(params.getAll('fstatus')).toEqual(['blocked', 'done'])
    expect(params.getAll('fpriority')).toEqual(['high'])
    expect(params.get('fsort')).toBe('created-asc')
  })

  it('round-trips a Filed detail deep link without changing the other URL state', () => {
    const over = {
      filedDetail: 'web:todo-42',
      filedSort: 'created-asc' as const,
    }
    expect(roundTrip(over)).toEqual(state(over))
    expect(urlStateToSearchParams(state(over)).get(SEARCH_PARAMS.filedDetail)).toBe('web:todo-42')
  })

  it('never lets the Filed facets collide with the runs facets sharing the same param names', () => {
    // `SEARCH_PARAMS.status` (runs) and `FILED_SEARCH_PARAMS.status` (filed todos) both use the
    // key name `status` internally — the wire values must stay `status` and `fstatus`, or one
    // facet silently narrows the other's rows.
    const over = {
      filters: filters({ statuses: ['running'] }),
      filedFilters: { statuses: ['blocked'], priorities: [] },
    }
    const params = urlStateToSearchParams(state(over))
    expect(params.getAll(SEARCH_PARAMS.status)).toEqual(['running'])
    expect(params.getAll('fstatus')).toEqual(['blocked'])
    expect(roundTrip(over)).toEqual(state(over))
  })

  it('omits the Filed sort key at the default, since created-desc is what a bare page means', () => {
    expect(urlStateToSearchParams(DEFAULT_URL_STATE).has('fsort')).toBe(false)
    expect(urlStateFromSearchParams(new URLSearchParams('')).filedSort).toBe('created-desc')
  })

  it('drops an unknown Filed status/priority/sort rather than letting it through unchecked', () => {
    const params = new URLSearchParams('fstatus=bogus&fstatus=blocked&fpriority=urgent&fsort=title-asc')
    const parsed = urlStateFromSearchParams(params)
    expect(parsed.filedFilters.statuses).toEqual(['blocked'])
    expect(parsed.filedFilters.priorities).toEqual([])
    expect(parsed.filedSort).toBe('created-desc')
  })

  it('forgives whatever a pasted or hand-edited URL carries', () => {
    // An unknown grouping is not grouped — never a blank page.
    expect(urlStateFromSearchParams(new URLSearchParams('group=bogus')).groupBy).toBe('none')
    expect(urlStateFromSearchParams(new URLSearchParams(''))).toEqual(DEFAULT_URL_STATE)
    // Empty values are dropped rather than becoming a filter matching nothing.
    expect(urlStateFromSearchParams(new URLSearchParams('tag=&status=')).filters).toEqual(NO_FILTERS)
    expect(urlStateFromSearchParams(new URLSearchParams('untagged=yes')).filters.tags).toEqual([])
    // Anything but the exact flag is the default view.
    expect(urlStateFromSearchParams(new URLSearchParams('archived=yes')).view).toBe('active')
  })
})

describe('parseFiledDetailKey', () => {
  it('splits the first colon and rejects empty sides', () => {
    expect(parseFiledDetailKey('web:todo-42')).toEqual({ project: 'web', todoId: 'todo-42' })
    expect(parseFiledDetailKey('web:todo:42')).toEqual({ project: 'web', todoId: 'todo:42' })
    expect(parseFiledDetailKey(':todo-42')).toBeNull()
    expect(parseFiledDetailKey('web:')).toBeNull()
    expect(parseFiledDetailKey('web')).toBeNull()
  })
})

describe('truncatedProjectNames', () => {
  it('names the capped projects, falling back to the raw id', () => {
    expect(truncatedProjectNames(['api', 'gone'], PROJECTS)).toEqual(['API', 'gone'])
  })
})

/**
 * `fasort` / `fbsort` through the page's ONE codec
 * (`.ai/specs/2026-08-25-split-active-backlog-tables.md`, D6, verification step 5). The two keys
 * are composed here rather than written by a second `URLSearchParams` writer — the page doctrine
 * is one function that reads the address bar and one that writes it.
 */
describe('URL state — the two Filed table sorts', () => {
  const state = (over: Partial<GlobalTasksUrlState> = {}): GlobalTasksUrlState => ({
    ...DEFAULT_URL_STATE,
    ...over,
  })

  it('the defaults emit no key at all, so a bare /tasks stays bare', () => {
    expect(urlStateToSearchParams(DEFAULT_URL_STATE).toString()).toBe('')
    expect(urlStateToSearchParams(state({ filedActiveSort: { column: 'age', dir: 'desc' } })).toString()).toBe('')
  })

  it('round-trips each table independently', () => {
    const params = urlStateToSearchParams(
      state({
        filedActiveSort: { column: 'priority', dir: 'asc' },
        filedBacklogSort: { column: 'task', dir: 'desc' },
      }),
    )
    expect(params.get('fasort')).toBe('priority:asc')
    expect(params.get('fbsort')).toBe('task:desc')
    const back = urlStateFromSearchParams(params)
    expect(back.filedActiveSort).toEqual({ column: 'priority', dir: 'asc' })
    expect(back.filedBacklogSort).toEqual({ column: 'task', dir: 'desc' })
  })

  it('one table sorted leaves the other at its default, and emits only one key', () => {
    const params = urlStateToSearchParams(state({ filedBacklogSort: { column: 'status', dir: 'asc' } }))
    expect(params.get('fasort')).toBeNull()
    expect(params.get('fbsort')).toBe('status:asc')
  })

  it('a hand-edited or older URL degrades to the default rather than to a blank table', () => {
    const parsed = urlStateFromSearchParams(new URLSearchParams('fasort=garbage:sideways&fbsort=node:asc'))
    expect(parsed.filedActiveSort).toEqual(DEFAULT_URL_STATE.filedActiveSort)
    expect(parsed.filedBacklogSort).toEqual(DEFAULT_URL_STATE.filedBacklogSort)
  })

  it('`fasort=created-desc` resolves through the legacy alias instead of falling back', () => {
    const parsed = urlStateFromSearchParams(new URLSearchParams('fasort=created-asc'))
    expect(parsed.filedActiveSort).toEqual({ column: 'age', dir: 'asc' })
  })

  it('`fsort` — the ARCHIVED table’s key — still parses exactly as it did', () => {
    const parsed = urlStateFromSearchParams(new URLSearchParams('fsort=created-asc'))
    expect(parsed.filedSort).toBe('created-asc')
    // …and is untouched by the two new keys sitting beside it on the same URL.
    const both = urlStateFromSearchParams(new URLSearchParams('fsort=created-asc&fasort=task:desc'))
    expect(both.filedSort).toBe('created-asc')
    expect(both.filedActiveSort).toEqual({ column: 'task', dir: 'desc' })
  })
})
