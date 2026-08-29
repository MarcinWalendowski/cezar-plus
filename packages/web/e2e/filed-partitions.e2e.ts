import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, cezarCli, fixtureServeEnv } from './agent-browser'

/**
 * The Filed board's Active/Backlog split, in a real browser against a real server
 * (`.ai/specs/2026-08-25-split-active-backlog-tables.md`, verification step 9).
 *
 * The acceptance criteria asks for artifacts that PROVE both sections, one sort in each, and both
 * expansions — so this writes a `filed-partitions-verdict.json` alongside the screenshots,
 * recording the row counts and the row-key lists before and after each expansion. A screenshot
 * shows that a table has rows; only the key lists show that the OTHER table's rows did not move,
 * which is the claim the whole design turns on.
 *
 * Modelled on `backlog-composer.e2e.ts`: same boot (throwaway `~/.cezar`, fixture git repo, a
 * `serve` on a free port), same `AgentBrowser` harness.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-filed-partitions-${process.pid}`

/** 60 rows per partition, so both initial counts (20, 30) and both expansions (+10) have room. */
const PER_PARTITION = 60

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
 *  summaries so a priority sort and a task sort both have something to reorder. */
function seedTodos(): unknown[] {
  const priorities = ['high', 'medium', 'low'] as const
  const active = ['in-progress', 'blocked'] as const
  const rows: unknown[] = []
  for (let i = 0; i < PER_PARTITION; i += 1) {
    const stamp = new Date(Date.UTC(2026, 7, 1, 0, 0, i)).toISOString()
    rows.push({
      id: `act-${String(i).padStart(3, '0')}`,
      ts: stamp,
      summary: `Active work item ${String(PER_PARTITION - i).padStart(3, '0')}`,
      status: active[i % active.length],
      priority: priorities[i % priorities.length],
    })
    rows.push({
      id: `bak-${String(i).padStart(3, '0')}`,
      ts: stamp,
      summary: `Backlog work item ${String(PER_PARTITION - i).padStart(3, '0')}`,
      status: 'todo',
      priority: priorities[(i + 1) % priorities.length],
    })
  }
  return rows
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
  writeFileSync(join(projectData, 'todos.json'), `${JSON.stringify(seedTodos(), null, 2)}\n`, 'utf8')

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
}, 180_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

/** Every rendered row key of one partition's table, in DOM order — the thing an "unchanged"
 *  claim has to be made about. */
function rowIds(partition: 'active' | 'backlog'): string[] {
  const js = `Array.from(document.querySelectorAll('[data-slot="filed-${partition}-table"] [data-slot="filed-task-row"]')).map((row) => row.getAttribute('data-todo-id'))`
  return (browser.evaluate(js) as string[]) ?? []
}

function waitForRows(partition: 'active' | 'backlog', count: number): void {
  browser.waitForFunction(
    `document.querySelectorAll('[data-slot="filed-${partition}-table"] [data-slot="filed-task-row"]').length === ${count}`,
  )
}

function showMore(partition: 'active' | 'backlog'): void {
  browser.click(`[data-action="filed-${partition}-show-more"]`)
}

describe('the Filed board splits into Active and Backlog against a live server', () => {
  it('renders both sections, sorts each independently, and expands each without moving the other', () => {
    const verdict: Record<string, unknown> = {}

    browser.goto(`${baseUrl}/tasks`)
    browser.waitForFunction(`document.querySelector('[data-slot="filed-active-table"]') !== null`)
    browser.waitForFunction(`document.querySelector('[data-slot="filed-backlog-table"]') !== null`)
    waitForRows('active', 20)
    waitForRows('backlog', 30)

    // Active ABOVE Backlog, asserted on document position rather than on reading the screenshot.
    expect(
      browser.evaluate(
        `!!(document.querySelector('[data-slot="filed-active-section"]').compareDocumentPosition(document.querySelector('[data-slot="filed-backlog-section"]')) & Node.DOCUMENT_POSITION_FOLLOWING)`,
      ),
    ).toBe(true)
    verdict.initial = { active: rowIds('active').length, backlog: rowIds('backlog').length }
    expect(verdict.initial).toEqual({ active: 20, backlog: 30 })
    browser.screenshot(join(artifactsDir, 'filed-partitions-both-sections.png'))

    // ---- one sort in the Active table ------------------------------------------------------
    browser.click('[data-slot="filed-active-table"] [data-slot="filed-sort-header"][data-column="priority"]')
    browser.waitForFunction(
      `document.querySelector('[data-slot="filed-active-table"] th[aria-sort="ascending"]')?.textContent.trim() === 'Priority'`,
    )
    waitForRows('active', 20)
    verdict.activeSortedByPriority = rowIds('active')
    // The other table did not re-sort: its own key is untouched, and its own request was not
    // re-issued.
    browser.waitForFunction(
      `document.querySelector('[data-slot="filed-backlog-table"] th[aria-sort="descending"]')?.textContent.trim() === 'Age'`,
    )
    browser.screenshot(join(artifactsDir, 'filed-partitions-active-sorted-priority.png'))

    // ---- one sort in the Backlog table -----------------------------------------------------
    browser.click('[data-slot="filed-backlog-table"] [data-slot="filed-sort-header"][data-column="task"]')
    browser.waitForFunction(
      `document.querySelector('[data-slot="filed-backlog-table"] th[aria-sort="ascending"]')?.textContent.trim() === 'Task'`,
    )
    waitForRows('backlog', 30)
    verdict.backlogSortedByTask = rowIds('backlog')
    browser.screenshot(join(artifactsDir, 'filed-partitions-backlog-sorted-task.png'))

    // ---- expand Active: +10, and Backlog must not move -------------------------------------
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

    // ---- expand Backlog: +10, and Active must not move --------------------------------------
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

    mkdirSync(artifactsDir, { recursive: true })
    writeFileSync(
      join(artifactsDir, 'filed-partitions-verdict.json'),
      `${JSON.stringify(verdict, null, 2)}\n`,
      'utf8',
    )
  }, 180_000)
})
