import { randomUUID } from 'node:crypto'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'

/** Browser proof for the frozen input-to-tasks plan and its global filed-task receipt. */
const artifactId = randomUUID().slice(0, 8)
const artifactsDir = resolve('/var/lib/cezar/e2e-artifacts', `composer-dispatch-${artifactId}`)
const sessionId = `e2e-composer-dispatch-${process.pid}`
const fixtureRunId = 'composer-dispatch-fixture'
const projectA = 'fixture-a'
const projectB = 'fixture-b'
const todoA = '11111111-2222-4333-8444-555555555555'
const todoB = '66666666-7777-4888-8999-000000000000'

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
  throw new Error(`cezar e2e: the composer dispatch server never answered at ${url}`)
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

function writeTodos(rootA: string, rootB: string): void {
  const at = new Date().toISOString()
  const author = {
    kind: 'agent',
    id: fixtureRunId,
    via: 'cli-todo-add',
    at,
    parentTaskId: fixtureRunId,
    agentSessionId: 'fixture-agent-session',
    parentStepId: 'file',
  }
  writeFileSync(
    join(rootA, '.ai', 'cezar', 'todos.json'),
    `${JSON.stringify([{ id: todoA, ts: at, summary: 'Update the API project', status: 'todo', author }], null, 2)}\n`,
    'utf8',
  )
  writeFileSync(
    join(rootB, '.ai', 'cezar', 'todos.json'),
    `${JSON.stringify([{ id: todoB, ts: at, summary: 'Update the web project', status: 'todo', author }], null, 2)}\n`,
    'utf8',
  )
}

type WorkspaceRunPayload = {
  run: {
    id: string
    tokensUsed: number
    steps: Array<{ id: string; tokensUsed?: number; sessionId?: string }>
  }
}

async function postWorkspaceRun(baseUrl: string, autoStart: boolean): Promise<WorkspaceRunPayload> {
  const response = await fetch(`${baseUrl}/api/v1/workspace/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: `Composer dispatch ${autoStart ? 'on' : 'off'}`, autoStart }),
  })
  const payload = (await response.json()) as WorkspaceRunPayload
  writeFileSync(join(artifactsDir, `${autoStart ? 'on' : 'off'}-workspace-run.json`), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  expect(response.status).toBe(201)
  return payload
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string
let projectRootA: string
let projectRootB: string

beforeAll(async () => {
  mkdirSync(artifactsDir, { recursive: true })
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-composer-dispatch-'))
  const hostRoot = join(dataRoot, 'host')
  projectRootA = join(dataRoot, 'project-a')
  projectRootB = join(dataRoot, 'project-b')
  initRepo(hostRoot, '# composer dispatch host\n')
  initRepo(projectRootA, '# composer dispatch API project\n')
  initRepo(projectRootB, '# composer dispatch web project\n')

  const cezHome = join(dataRoot, '.cez-home')
  mkdirSync(cezHome, { recursive: true })
  writeFileSync(
    join(cezHome, 'config.json'),
    `${JSON.stringify({
      projects: [
        {
          id: projectA,
          root: realpathSync(projectRootA),
          name: 'Fixture API',
          addedAt: new Date(0).toISOString(),
          source: 'local',
        },
        {
          id: projectB,
          root: realpathSync(projectRootB),
          name: 'Fixture Web',
          addedAt: new Date(0).toISOString(),
          source: 'local',
        },
      ],
    }, null, 2)}\n`,
    'utf8',
  )

  // RunStore reads this index once at boot. Seed the record before spawn so the browser proof
  // exercises the real persisted thread and its filed-todo receipt.
  const hostData = join(hostRoot, '.ai', 'cezar')
  mkdirSync(hostData, { recursive: true })
  const finishedAt = new Date().toISOString()
  writeFileSync(
    join(hostData, 'runs.json'),
    `${JSON.stringify([
      {
        id: fixtureRunId,
        title: 'Composer dispatch fixture',
        workflow: 'input-to-tasks',
        task: 'Fixture run for composer dispatch links',
        status: 'done',
        createdAt: finishedAt,
        finishedAt,
        tokensUsed: 0,
        archived: false,
        autoStart: false,
        steps: [],
        filedTodos: {
          at: finishedAt,
          items: [
            { project: projectA, todoId: todoA, summary: 'Update the API project' },
            { project: projectB, todoId: todoB, summary: 'Update the web project' },
          ],
        },
      },
    ], null, 2)}\n`,
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
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
}, 180_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('composer dispatch mode', () => {
  it('links the persisted receipt to the second registered project on the global board', async () => {
    const empty = (await (await fetch(`${baseUrl}/api/v1/workspace/todos`)).json()) as {
      todos: unknown[]
      projects?: Array<{ id: string; ok?: boolean }>
    }
    writeFileSync(join(artifactsDir, 'workspace-todos-empty.json'), `${JSON.stringify(empty, null, 2)}\n`, 'utf8')
    expect(empty.todos).toHaveLength(0)

    writeTodos(projectRootA, projectRootB)
    const populated = (await (await fetch(`${baseUrl}/api/v1/workspace/todos`)).json()) as {
      todos: Array<{ project: string; todo: { id: string } }>
      projects?: Array<{ id: string; ok?: boolean }>
    }
    writeFileSync(join(artifactsDir, 'workspace-todos-populated.json'), `${JSON.stringify(populated, null, 2)}\n`, 'utf8')
    expect(populated.projects?.filter((project) => project.ok).map((project) => project.id).sort()).toEqual([projectA, projectB])
    expect(populated.todos.map((entry) => `${entry.project}:${entry.todo.id}`).sort()).toEqual([
      `${projectA}:${todoA}`,
      `${projectB}:${todoB}`,
    ])

    browser.goto(`${baseUrl}/p/${bootProject}/tasks/${fixtureRunId}`)
    browser.waitForFunction(`document.querySelector('[data-slot="filed-todos-card"]') !== null`)
    expect(browser.count('[data-slot="filed-todo"]')).toBe(2)
    expect(browser.evaluate(`
      [...document.querySelectorAll('[data-slot="filed-todo-link"]')].map((link) => link.getAttribute('href'))
    `)).toEqual([
      `/tasks?fdetail=${encodeURIComponent(`${projectA}:${todoA}`)}`,
      `/tasks?fdetail=${encodeURIComponent(`${projectB}:${todoB}`)}`,
    ])
    browser.screenshot(join(artifactsDir, 'receipt-links.png'))

    browser.click(`[data-slot="filed-todo"][data-todo-id="${todoB}"] [data-slot="filed-todo-link"]`)
    browser.waitForFunction(
      `location.pathname === '/tasks' && new URLSearchParams(location.search).get('fdetail') === ${JSON.stringify(`${projectB}:${todoB}`)}`,
    )
    const landed = new URL(browser.url())
    expect(landed.pathname).toBe('/tasks')
    expect(landed.searchParams.get('fdetail')).toBe(`${projectB}:${todoB}`)
    browser.waitForFunction(`document.querySelector('[data-slot="filed-task-detail"]') !== null`)
    expect(browser.text('[data-slot="filed-task-id"]')).toBe(todoB)
    browser.screenshot(join(artifactsDir, 'global-detail.png'))
  }, 90_000)

  it('omits dispatch from the OFF plan and shows only two browser step dots', async () => {
    const payload = await postWorkspaceRun(baseUrl, false)
    const run = payload.run
    expect(run.steps.map((step) => step.id)).toEqual(['context', 'file'])
    expect(run.steps.some((step) => step.id === 'dispatch')).toBe(false)
    expect(run.tokensUsed).toBe(0)
    expect(run.steps.every((step) => step.tokensUsed === 0 && step.sessionId === undefined)).toBe(true)

    browser.goto(`${baseUrl}/p/${bootProject}/tasks/${payload.run.id}`)
    browser.waitForFunction(`document.querySelectorAll('[data-slot="step-dot"]').length === 2`)
    expect(browser.count('[data-slot="step-dot"]')).toBe(2)
    expect(String(browser.evaluate('document.body.textContent'))).not.toContain('Start the filed tasks')
    browser.screenshot(join(artifactsDir, 'off-two-step-plan.png'))
  }, 90_000)

  it('retains dispatch in the ON plan', async () => {
    const payload = await postWorkspaceRun(baseUrl, true)
    const run = payload.run
    expect(run.steps.map((step) => step.id)).toEqual(['context', 'file', 'dispatch'])

    browser.goto(`${baseUrl}/p/${bootProject}/tasks/${payload.run.id}`)
    browser.waitForFunction(`document.querySelectorAll('[data-slot="step-dot"]').length === 3`)
    expect(browser.count('[data-slot="step-dot"]')).toBe(3)
    browser.screenshot(join(artifactsDir, 'on-three-step-plan.png'))
  }, 90_000)
})
