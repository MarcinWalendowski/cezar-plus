import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, cezarCli, fixtureServeEnv } from './agent-browser'

/**
 * The Filed board's Active/Backlog split, in a real browser against a real server
 * (`.ai/specs/2026-08-25-split-active-backlog-tables.md`, verification step 9, closed out by
 * `.ai/specs/2026-08-29-verify-active-backlog-e2e.md`).
 *
 * The acceptance criteria asks for artifacts that PROVE both sections, one sort in each, and both
 * expansions — so this writes a `filed-partitions-verdict.json` alongside the screenshots,
 * recording the row counts and the row-key lists before and after each expansion, the ACTUAL
 * network requests each interaction issued (D6), and the analytics events it produced (D7). A
 * screenshot shows that a table has rows; only the key lists show that the OTHER table's rows did
 * not move, and only the request log shows that the other table's data was not re-fetched — which
 * is the claim the whole two-request design rests on.
 *
 * Modelled on `backlog-composer.e2e.ts`: same boot (throwaway `~/.cezar`, fixture git repo, a
 * `serve` on a free port), same `AgentBrowser` harness.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-filed-partitions-${process.pid}`

/** 60 rows per partition, so both initial counts (20, 30) and both expansions (+10) have room. */
const PER_PARTITION = 60

interface FixtureTodo {
  id: string
  ts: string
  summary: string
  status: string
  priority: 'high' | 'medium' | 'low'
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(port))
    })
  })
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error(`cezar e2e: the filed-partitions server never answered at ${url}`)
}

function initRepo(path: string, readme: string): void {
  mkdirSync(path, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(path, 'README.md'), readme, 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')
}

/** `PER_PARTITION` non-`todo` rows and `PER_PARTITION` `todo` rows, with distinct priorities and
 *  summaries so a priority sort and a task sort both have something to reorder. Computed once, at
 *  module load, so the fixture beforeAll writes and the expected-order computation the `it` block
 *  needs are guaranteed to agree — there is no second call that could drift from the first. */
function seedTodos(): FixtureTodo[] {
  const priorities = ['high', 'medium', 'low'] as const
  const active = ['in-progress', 'blocked'] as const
  const rows: FixtureTodo[] = []
  for (let i = 0; i < PER_PARTITION; i += 1) {
    const stamp = new Date(Date.UTC(2026, 7, 1, 0, 0, i)).toISOString()
    rows.push({
      id: `act-${String(i).padStart(3, '0')}`,
      ts: stamp,
      summary: `Active work item ${String(PER_PARTITION - i).padStart(3, '0')}`,
      status: active[i % active.length]!,
      priority: priorities[i % priorities.length]!,
    })
    rows.push({
      id: `bak-${String(i).padStart(3, '0')}`,
      ts: stamp,
      summary: `Backlog work item ${String(PER_PARTITION - i).padStart(3, '0')}`,
      status: 'todo',
      priority: priorities[(i + 1) % priorities.length]!,
    })
  }
  return rows
}

const FIXTURE_TODOS = seedTodos()
const FIXTURE_ACTIVE = FIXTURE_TODOS.filter((row) => row.status !== 'todo')
const FIXTURE_BACKLOG = FIXTURE_TODOS.filter((row) => row.status === 'todo')

const PRIORITY_RANK: Record<FixtureTodo['priority'], number> = { high: 0, medium: 1, low: 2 }

/**
 * The expected total order for one `(column, dir)`, mirroring the server's own comparator
 * (`packages/cezar/src/workspace/todo-ordering.ts`'s `compareFiledEntries`) rather than importing
 * it: codepoint compare (lowercased, never `localeCompare`), and every comparison falls through to
 * the composite `project:id` key ASCENDING regardless of `dir` — the tie-break the prefix property
 * (a Show more can only append) depends on.
 */
function expectedOrder(
  rows: readonly FixtureTodo[],
  column: 'priority' | 'task',
  dir: 'asc' | 'desc',
): string[] {
  const key = (row: FixtureTodo): number | string =>
    column === 'priority' ? PRIORITY_RANK[row.priority] : row.summary.toLowerCase()
  const sorted = [...rows].sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    const primary = ka < kb ? -1 : ka > kb ? 1 : 0
    const oriented = dir === 'asc' ? primary : -primary
    if (oriented !== 0) return oriented
    const rowA = `fixture:${a.id}`
    const rowB = `fixture:${b.id}`
    return rowA < rowB ? -1 : rowA > rowB ? 1 : 0
  })
  return sorted.map((row) => `fixture:${row.id}`)
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-filed-'))
  const hostRoot = join(dataRoot, 'host')
  const projectRoot = join(dataRoot, 'fixture')
  initRepo(hostRoot, '# filed partitions e2e host\n')
  initRepo(projectRoot, '# filed partitions e2e fixture\n')

  const projectData = join(projectRoot, '.ai', 'cezar')
  mkdirSync(projectData, { recursive: true })
  writeFileSync(join(projectData, 'todos.json'), `${JSON.stringify(FIXTURE_TODOS, null, 2)}\n`, 'utf8')

  const cezHome = join(dataRoot, '.cez-home')
  mkdirSync(cezHome, { recursive: true })
  writeFileSync(
    join(cezHome, 'config.json'),
    `${JSON.stringify({
      projects: [
        {
          id: 'fixture',
          root: realpathSync(projectRoot),
          name: 'fixture',
          addedAt: new Date(0).toISOString(),
          source: 'local',
        },
      ],
    })}\n`,
    'utf8',
  )

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [cezarCli, 'serve', '--repo', hostRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 1400)

  // The fixture writes a `projects` entry straight into `config.json` (above) with no org
  // adoption — exactly the state `hasProjects === false` fires on
  // (`onboarding-gate.ts:101-106`, `onboarding-routes.ts:319-320`), so `/tasks` redirects to
  // `/onboarding` on first load. Walk it before any table assertion runs, waiting on
  // post-creation STATE rather than a timer (Risk 4).
  browser.goto(`${baseUrl}/tasks`)
  browser.waitForFunction(`document.querySelector('[data-slot="onboarding-org-name"]') !== null`)
  browser.fill('[data-slot="onboarding-org-name"]', 'fixture-org')
  browser.click('[data-slot="onboarding-org-submit"]')
  browser.waitForFunction(
    `document.querySelector('[data-slot="onboarding-team-accept"]') !== null || !location.pathname.startsWith('/onboarding')`,
  )
  browser.goto(`${baseUrl}/tasks`)
  browser.waitForFunction(`location.pathname.endsWith('/tasks')`)
}, 180_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

/** Every rendered row key of one partition's table, in DOM order, as the composite
 *  `<project>:<todoId>` key (D6) — a workspace board is cross-project, and the row carries both
 *  `data-project` and `data-todo-id` (`global-tasks.tsx:1703-1704`), so a todo id alone is not a
 *  row identity here. */
function rowIds(partition: 'active' | 'backlog'): string[] {
  const js = `Array.from(document.querySelectorAll('[data-slot="filed-${partition}-table"] [data-slot="filed-task-row"]')).map((row) => row.getAttribute('data-project') + ':' + row.getAttribute('data-todo-id'))`
  return (browser.evaluate(js) as string[]) ?? []
}

function waitForRows(partition: 'active' | 'backlog', count: number): void {
  browser.waitForFunction(
    `document.querySelectorAll('[data-slot="filed-${partition}-table"] [data-slot="filed-task-row"]').length === ${count}`,
  )
}

/**
 * Wait for the table's rows to equal an EXACT expected sequence, not merely for the header's
 * `aria-sort` and an unchanged row count. `useWorkspaceTodoPage` sets
 * `placeholderData: keepPreviousData` (`api/queries.ts:2528-2535`) — deliberate, so Show more
 * feels like an expansion — which also means the OLD rows plus an optimistically-flipped header
 * both hold true the instant the click lands, before the sorted page has arrived. Only comparing
 * the actual row order proves the sort itself completed.
 */
function waitForExactOrder(partition: 'active' | 'backlog', expected: readonly string[]): void {
  const predicate =
    `Array.from(document.querySelectorAll('[data-slot="filed-${partition}-table"] [data-slot="filed-task-row"]'))` +
    `.map((row) => row.getAttribute('data-project') + ':' + row.getAttribute('data-todo-id')).join(',') === ` +
    JSON.stringify(expected.join(','))
  browser.waitForFunction(predicate)
}

function showMore(partition: 'active' | 'backlog'): void {
  browser.click(`[data-action="filed-${partition}-show-more"]`)
}

interface RequestPhase {
  phase: string
  count: number
  urls: string[]
}

/** `performance.getEntriesByType('resource')`, filtered to the route under test — provider-
 *  neutral and pull-based (D6): the seam has 15 synchronous one-shot operations and no event
 *  subscription, so an actual `page.on('request')` listener cannot survive across the CLI's
 *  process boundary. A browser API works identically under any provider. */
function clearRequests(): void {
  browser.evaluate('performance.clearResourceTimings()')
}

function captureRequests(phase: string, log: RequestPhase[]): void {
  const urls =
    (browser.evaluate(
      `performance.getEntriesByType('resource').filter((e) => e.name.includes('/workspace/todos')).map((e) => e.name)`,
    ) as string[]) ?? []
  log.push({ phase, count: urls.length, urls })
}

/** Poll `<CEZ_HOME>/analytics/events.ndjson` (D7) for up to 10s — the client buffer flushes on an
 *  idle callback with a 2,000ms timeout (`lib/analytics.ts:52-58`), so a single read right after
 *  the last interaction can race the flush. */
async function readAnalyticsEvents(): Promise<{ name: string; props: Record<string, unknown> }[]> {
  const path = join(dataRoot, '.cez-home', 'analytics', 'events.ndjson')
  let lines: { name: string; props: Record<string, unknown> }[] = []
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      lines = readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line))
      const hasActiveView = lines.some(
        (l) => l.name === 'todo.filed_partition_viewed' && l.props.partition === 'active',
      )
      const hasBacklogView = lines.some(
        (l) => l.name === 'todo.filed_partition_viewed' && l.props.partition === 'backlog',
      )
      const hasSorted = lines.some((l) => l.name === 'todo.filed_sorted')
      const showMoreCount = lines.filter((l) => l.name === 'todo.filed_show_more').length
      if (hasActiveView && hasBacklogView && hasSorted && showMoreCount >= 2) return lines
    } catch {
      /* not written yet, or the flush hasn't landed */
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error(`cezar e2e: analytics events never reached ${path} with the expected shape (got ${lines.length} lines)`)
}

async function writeDeployedRequestsArtifact(phases: RequestPhase[]): Promise<void> {
  // `CEZ_E2E_SERVER_CLI` is set only by the deployed pass's own command
  // (`.ai/specs/2026-08-29-verify-active-backlog-e2e.md` D6) — its presence, not a path
  // comparison, is what distinguishes "this run drove a deployed build" from a local one.
  const deployed = Boolean(process.env.CEZ_E2E_SERVER_CLI)
  let liveSha: string | null = null
  try {
    const ready = (await (await fetch(`${baseUrl}/api/v1/ready`)).json()) as { deploy?: { sha?: string } }
    liveSha = ready.deploy?.sha ?? null
  } catch {
    liveSha = null
  }
  mkdirSync(artifactsDir, { recursive: true })
  writeFileSync(
    join(artifactsDir, 'filed-partitions-deployed-requests.json'),
    `${JSON.stringify(
      {
        serverCli: cezarCli,
        deployed,
        liveSha,
        phases,
        capturedVia: "performance.getEntriesByType('resource'), cleared before each phase",
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

describe('the Filed board splits into Active and Backlog against a live server', () => {
  it(
    'renders both sections, sorts each independently, and expands each without moving the other',
    async () => {
      const verdict: Record<string, unknown> = {}
      const requestLog: RequestPhase[] = []

      // ---- load: both partitions fetched once, and only once --------------------------------
      clearRequests()
      browser.goto(`${baseUrl}/tasks`)
      browser.waitForFunction(`document.querySelector('[data-slot="filed-active-table"]') !== null`)
      browser.waitForFunction(`document.querySelector('[data-slot="filed-backlog-table"]') !== null`)
      waitForRows('active', 20)
      waitForRows('backlog', 30)
      captureRequests('load', requestLog)
      // The onboarding gate did not reappear (Risk 4, point 6) — a re-shown gate would otherwise
      // read as "the Active table has 0 rows", a feature bug it is not.
      expect(browser.url()).toMatch(/\/tasks$/)

      // Active ABOVE Backlog, asserted on document position rather than on reading the screenshot.
      expect(
        browser.evaluate(
          `!!(document.querySelector('[data-slot="filed-active-section"]').compareDocumentPosition(document.querySelector('[data-slot="filed-backlog-section"]')) & Node.DOCUMENT_POSITION_FOLLOWING)`,
        ),
      ).toBe(true)
      verdict.initial = { active: rowIds('active').length, backlog: rowIds('backlog').length }
      expect(verdict.initial).toEqual({ active: 20, backlog: 30 })
      browser.screenshot(join(artifactsDir, 'filed-partitions-both-sections.png'))

      const loadPhase = requestLog.find((p) => p.phase === 'load')
      expect(loadPhase?.count).toBe(2)
      expect(loadPhase?.urls.some((u) => u.includes('partition=active'))).toBe(true)
      expect(loadPhase?.urls.some((u) => u.includes('partition=backlog'))).toBe(true)

      // ---- one sort in the Active table -------------------------------------------------------
      clearRequests()
      browser.click('[data-slot="filed-active-table"] [data-slot="filed-sort-header"][data-column="priority"]')
      const activeSortedExpected = expectedOrder(FIXTURE_ACTIVE, 'priority', 'asc').slice(0, 20)
      waitForExactOrder('active', activeSortedExpected)
      verdict.activeSortedByPriority = rowIds('active')
      expect(verdict.activeSortedByPriority).toEqual(activeSortedExpected)
      // The other table did not re-sort: its own header is untouched.
      expect(
        browser.evaluate(
          `document.querySelector('[data-slot="filed-backlog-table"] th[aria-sort="descending"]')?.textContent.trim()`,
        ),
      ).toBe('Age')
      browser.screenshot(join(artifactsDir, 'filed-partitions-active-sorted-priority.png'))
      captureRequests('sort-active', requestLog)
      const sortActivePhase = requestLog.find((p) => p.phase === 'sort-active')
      expect(sortActivePhase?.count).toBe(1)
      expect(sortActivePhase?.urls[0]).toContain('partition=active')
      expect(sortActivePhase?.urls[0]).toContain('sort=priority')
      expect(sortActivePhase?.urls[0]).toContain('dir=asc')

      // ---- one sort in the Backlog table ------------------------------------------------------
      clearRequests()
      browser.click('[data-slot="filed-backlog-table"] [data-slot="filed-sort-header"][data-column="task"]')
      const backlogSortedExpected = expectedOrder(FIXTURE_BACKLOG, 'task', 'asc').slice(0, 30)
      waitForExactOrder('backlog', backlogSortedExpected)
      verdict.backlogSortedByTask = rowIds('backlog')
      expect(verdict.backlogSortedByTask).toEqual(backlogSortedExpected)
      browser.screenshot(join(artifactsDir, 'filed-partitions-backlog-sorted-task.png'))
      captureRequests('sort-backlog', requestLog)
      const sortBacklogPhase = requestLog.find((p) => p.phase === 'sort-backlog')
      expect(sortBacklogPhase?.count).toBe(1)
      expect(sortBacklogPhase?.urls[0]).toContain('partition=backlog')
      expect(sortBacklogPhase?.urls[0]).toContain('sort=task')
      expect(sortBacklogPhase?.urls[0]).toContain('dir=asc')

      // ---- expand Active: +10, and Backlog must not move ---------------------------------------
      clearRequests()
      const backlogBefore = rowIds('backlog')
      const activeBefore = rowIds('active')
      showMore('active')
      waitForRows('active', 30)
      const activeAfter = rowIds('active')
      const backlogDuringActiveExpansion = rowIds('backlog')
      verdict.activeExpansion = {
        activeBefore,
        activeAfter,
        // The prefix property, visible in the artifact: an expansion appends and never reorders.
        appendedOnly: activeAfter.slice(0, activeBefore.length).join() === activeBefore.join(),
        backlogBefore,
        backlogAfter: backlogDuringActiveExpansion,
        backlogUnchanged: backlogDuringActiveExpansion.join() === backlogBefore.join(),
      }
      expect(activeAfter).toHaveLength(30)
      expect(activeAfter.slice(0, 20)).toEqual(activeBefore)
      expect(backlogDuringActiveExpansion).toEqual(backlogBefore)
      browser.screenshot(join(artifactsDir, 'filed-partitions-active-expanded.png'))
      captureRequests('expand-active', requestLog)
      const expandActivePhase = requestLog.find((p) => p.phase === 'expand-active')
      expect(expandActivePhase?.count).toBe(1)
      expect(expandActivePhase?.urls[0]).toContain('partition=active')
      expect(expandActivePhase?.urls[0]).toContain('limit=30')

      // ---- expand Backlog: +10, and Active must not move ---------------------------------------
      clearRequests()
      showMore('backlog')
      waitForRows('backlog', 40)
      const backlogAfter = rowIds('backlog')
      const activeDuringBacklogExpansion = rowIds('active')
      verdict.backlogExpansion = {
        backlogBefore,
        backlogAfter,
        appendedOnly: backlogAfter.slice(0, backlogBefore.length).join() === backlogBefore.join(),
        activeBefore: activeAfter,
        activeAfter: activeDuringBacklogExpansion,
        activeUnchanged: activeDuringBacklogExpansion.join() === activeAfter.join(),
      }
      expect(backlogAfter).toHaveLength(40)
      expect(backlogAfter.slice(0, 30)).toEqual(backlogBefore)
      expect(activeDuringBacklogExpansion).toEqual(activeAfter)
      browser.screenshot(join(artifactsDir, 'filed-partitions-backlog-expanded.png'))
      captureRequests('expand-backlog', requestLog)
      const expandBacklogPhase = requestLog.find((p) => p.phase === 'expand-backlog')
      expect(expandBacklogPhase?.count).toBe(1)
      expect(expandBacklogPhase?.urls[0]).toContain('partition=backlog')
      expect(expandBacklogPhase?.urls[0]).toContain('limit=40')

      // ---- analytics reach disk (D7) ------------------------------------------------------------
      const analyticsEvents = await readAnalyticsEvents()
      const showMoreEvents = analyticsEvents.filter((e) => e.name === 'todo.filed_show_more')
      expect(showMoreEvents).toHaveLength(2)
      verdict.analytics = {
        partitionViewed: [
          analyticsEvents.some((e) => e.name === 'todo.filed_partition_viewed' && e.props.partition === 'active')
            ? 'active'
            : undefined,
          analyticsEvents.some((e) => e.name === 'todo.filed_partition_viewed' && e.props.partition === 'backlog')
            ? 'backlog'
            : undefined,
        ].filter((v): v is string => v !== undefined),
        sorted: analyticsEvents
          .filter((e) => e.name === 'todo.filed_sorted')
          .map((e) => ({ partition: e.props.partition, column: e.props.column, dir: e.props.dir })),
        showMore: showMoreEvents.map((e) => ({
          partition: e.props.partition,
          from: e.props.from,
          to: e.props.to,
          increment: e.props.increment,
        })),
      }
      expect(verdict.analytics).toMatchObject({
        partitionViewed: expect.arrayContaining(['active', 'backlog']),
        showMore: expect.arrayContaining([
          { partition: 'active', from: 20, to: 30, increment: 10 },
          { partition: 'backlog', from: 30, to: 40, increment: 10 },
        ]),
      })

      verdict.requests = requestLog

      mkdirSync(artifactsDir, { recursive: true })
      writeFileSync(
        join(artifactsDir, 'filed-partitions-verdict.json'),
        `${JSON.stringify(verdict, null, 2)}\n`,
        'utf8',
      )

      await writeDeployedRequestsArtifact(requestLog)
    },
    180_000,
  )
})
