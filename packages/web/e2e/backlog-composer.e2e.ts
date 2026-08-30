import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, cezarCli, fixtureServeEnv } from './agent-browser'

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-backlog-composer-${process.pid}`

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
  throw new Error(`cezar e2e: the backlog server never answered at ${url}`)
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

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-backlog-'))
  const hostRoot = join(dataRoot, 'host')
  const projectRoot = join(dataRoot, 'fixture')
  initRepo(hostRoot, '# backlog e2e host\n')
  initRepo(projectRoot, '# backlog e2e fixture\n')

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
  browser.setViewport(1440, 900)

  // A project registered in a fresh CEZ_HOME still has no organization, so the asynchronous
  // onboarding gate can replace an initially-rendered composer after the first interaction.
  // Complete local onboarding before the feature walk, then navigate cold so the client's
  // onboarding-entry probe cannot retain its pre-creation result.
  browser.goto(`${baseUrl}/tasks`)
  browser.waitForFunction(`document.querySelector('[data-slot="onboarding-org-name"]') !== null`)
  browser.fill('[data-slot="onboarding-org-name"]', 'fixture-org')
  browser.click('[data-slot="onboarding-org-submit"]')
  browser.waitForFunction(
    `document.querySelector('[data-slot="onboarding-team-accept"]') !== null || !location.pathname.startsWith('/onboarding')`,
  )
  if (browser.count('[data-slot="onboarding-team-accept"]') > 0) {
    browser.click('[data-slot="onboarding-team-accept"]')
  }
  browser.goto(`${baseUrl}/p/fixture/new`)
  browser.waitForFunction(`location.pathname === '/p/fixture/new'`)
}, 180_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('the project-scoped Backlog composer against a live dry-run server', () => {
  it('files exactly one unstarted todo and lands on the global Filed board', async () => {
    const before = (await (await fetch(`${baseUrl}/api/v1/workspace/todos`)).json()) as {
      todos: unknown[]
      projects?: Array<{ id: string; ok?: boolean }>
    }
    expect(before.projects?.some((project) => project.id === 'fixture' && project.ok === true)).toBe(true)
    expect(before.todos).toHaveLength(0)

    browser.goto(`${baseUrl}/p/fixture/new`)
    browser.waitForFunction(`document.querySelector('[data-route="new"]') !== null`)
    browser.waitForFunction(`document.querySelector('[data-slot="mode-backlog"]') !== null`)
    browser.click('[data-slot="mode-backlog"]')
    browser.waitForFunction(
      `document.querySelector('[data-slot="mode-backlog"]')?.getAttribute('aria-checked') === 'true'`,
    )
    expect(browser.url()).toMatch(/\/p\/fixture\/new$/)
    browser.fill('[data-slot="composer"] textarea', 'File this from the browser, do not start it.')
    browser.screenshot(join(artifactsDir, 'backlog-composer-armed.png'))

    browser.click('[aria-label="File task"]')
    browser.waitForFunction(`location.pathname === '/tasks'`)

    const todos = (await (await fetch(`${baseUrl}/api/v1/p/fixture/todos`)).json()) as Array<{
      summary?: string
      status?: string
      startedTaskId?: string
      origin?: string
      author?: { via?: string }
    }>
    expect(todos).toHaveLength(1)
    expect(todos[0]?.summary).toBe('File this from the browser, do not start it.')
    // The current todo contract leaves status absent for a newly filed task. Absence is the
    // unstarted state here, while startedTaskId is the explicit run linkage.
    expect(todos[0]?.status).toBeUndefined()
    expect(todos[0]?.startedTaskId).toBeUndefined()
    expect(todos[0]?.origin).toBe('composer')
    expect(todos[0]?.author?.via).toBe('todo-create-route')

    expect(await (await fetch(`${baseUrl}/api/v1/p/fixture/runs`)).json()).toHaveLength(0)
    expect(await (await fetch(`${baseUrl}/api/v1/runs`)).json()).toHaveLength(0)

    browser.waitForFunction(
      `document.querySelector('[data-slot="filed-tasks"]')?.textContent.includes('File this from the browser')`,
    )
    expect(browser.count('[data-slot="filed-tasks-empty"]')).toBe(0)
    browser.screenshot(join(artifactsDir, 'backlog-filed-row.png'))
  }, 90_000)
})
