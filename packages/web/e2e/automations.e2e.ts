import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, ensureFixtureReady, fixtureServeEnv, readTestEnv, stopFixtureServer } from './agent-browser'

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-automations-${process.pid}`

let browser: AgentBrowser
let baseUrl: string
let bootProject: string
let sharedBaseUrl: string
let sharedBootProject: string
let server: ChildProcess | undefined
let dataRoot: string | undefined
const created: string[] = []

type Automation = { id: string; name: string; enabled: boolean; kind: string; nextRunAt?: string }

/** Every call closes its socket and retries once: undici reuses keep-alive sockets the server
 *  may have idled out between browser steps, which surfaces as a spurious ECONNRESET. */
const api = async (path: string, init: RequestInit = {}, url = baseUrl): Promise<Response> => {
  const request = () => fetch(`${url}/api/v1${path}`, { ...init, headers: { connection: 'close', ...(init.headers ?? {}) } })
  try {
    return await request()
  } catch {
    return request()
  }
}
const listAutomations = async (): Promise<Automation[]> =>
  ((await (await api('/automations')).json()) as { automations: Automation[] }).automations

/** Click the first button whose visible text is exactly `label` — AgentBrowser clicks by CSS only. */
const clickButton = (label: string) =>
  browser.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((el) => el.textContent.trim().startsWith(${JSON.stringify(label)})); if (!b) throw new Error('no button ' + ${JSON.stringify(label)}); b.click(); return true })()`)
const clickByAriaLabel = (label: string, within = 'body') =>
  browser.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(`${within} [aria-label="${label}"]`)}); if (!b) throw new Error('no control ' + ${JSON.stringify(label)}); b.click(); return true })()`)

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
      // The fixture process has not bound its port yet.
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error(`cezar e2e: opted-in automation fixture did not become healthy at ${url}`)
}

beforeAll(async () => {
  sharedBaseUrl = readTestEnv().baseUrl
  sharedBootProject = await bootProjectId(sharedBaseUrl)
  const sharedHealth = (await (await api('/health', {}, sharedBaseUrl)).json()) as {
    capabilities: { automations: boolean }
  }
  expect(sharedHealth.capabilities.automations, 'the shared cockpit must retain the fork default-off automation capability').toBe(false)

  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-automations-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot!, ...args], { encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dataRoot, 'README.md'), '# isolated automation E2E fixture\n')
  writeFileSync(join(dataRoot, '.gitignore'), '.ai/\n.cez-home/\n')
  git('add', '.')
  git('-c', 'user.name=cezar e2e', '-c', 'user.email=e2e@cezar.test', 'commit', '-qm', 'init')
  // GitHubPoller uses read-only GET requests even in dry-run mode. Point the disposable project's
  // remote at this checkout's existing fork; neither fixture git nor the poll preview pushes it.
  const remote = execFileSync('git', ['-C', resolve(import.meta.dirname, '../../..'), 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()
  git('remote', 'add', 'origin', remote)
  baseUrl = `http://localhost:${await freePort()}`
  server = spawn(process.execPath,
    [cezarCli, 'serve', '--repo', dataRoot, '--port', new URL(baseUrl).port, '--no-open'],
    { cwd: dataRoot, env: fixtureServeEnv(dataRoot, { CEZ_AUTOMATIONS: '1' }), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  await ensureFixtureReady(baseUrl)
  bootProject = await bootProjectId(baseUrl)
  const enabledHealth = (await (await api('/health')).json()) as { capabilities: { automations: boolean } }
  expect(enabledHealth.capabilities.automations, 'the private cockpit must explicitly opt in').toBe(true)
  browser = AgentBrowser.open(sessionId)
  if (process.env.CEZ_E2E_RECORD !== '1') {
    browser.goto('about:blank')
    browser.startRecording(`${artifactsDir}/${sessionId}.webm`)
  }
  browser.setViewport(1440, 900)
}, 60_000)

afterAll(async () => {
  try {
    for (const id of created) {
      const response = await api(`/automations/${id}`, { method: 'DELETE' })
      expect(response.ok, `delete private fixture automation ${id}`).toBe(true)
    }
  } finally {
    try {
      browser?.close()
    } finally {
      await stopFixtureServer(server)
      if (dataRoot) rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5 })
    }
  }
})

describe('Automations', () => {
  // The opted-out shape, asserted in a real browser: nothing about automations is reachable or
  // advertised on the shared cockpit with the fork's default-off capability.
  it('is absent from the sidebar and refuses its API when opted out', async () => {
    browser.goto(`${sharedBaseUrl}/p/${sharedBootProject}/`)
    browser.waitForFunction(`document.querySelector('[data-slot="sidebar"]') !== null`)
    expect(browser.text('[data-slot="sidebar"]')).not.toContain('Automations')

    browser.goto(`${sharedBaseUrl}/p/${sharedBootProject}/automations`)
    browser.waitForFunction(`document.body.textContent.includes('Automations are off')`)
    expect(browser.text('main')).toContain('CEZ_AUTOMATIONS=1')
    browser.screenshot(`${artifactsDir}/automations-disabled.png`)

    const refused = await api('/automations', {}, sharedBaseUrl)
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: string }).error).toContain('CEZ_AUTOMATIONS')
  }, 60_000)

  it('is in the sidebar when enabled, with the empty state and the New automation button', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/automations`)
    browser.waitForFunction(`document.querySelector('[data-slot="sidebar"]') !== null && document.querySelector('[data-route="automations"]') !== null`)
    expect(browser.text('[data-slot="sidebar"]')).toContain('Automations')
    browser.waitForFunction(`document.body.textContent.includes('New automation')`)
    browser.screenshot(`${artifactsDir}/automations-list-initial.png`)
  }, 60_000)

  it('creates a schedule from a template, runs it by hand, shows it in the log, the week view and the rail', async () => {
    const name = `E2E nightly ${process.pid}`

    // The editor, from a built-in template: the palette is open by default on /new.
    browser.goto(`${baseUrl}/p/${bootProject}/automations/new`)
    browser.waitForFunction(`document.querySelector('[data-slot="template-palette"]') !== null`)
    browser.screenshot(`${artifactsDir}/automations-editor-new-templates.png`)
    clickByAriaLabel('Use this: Nightly dependency bump')
    browser.waitForFunction(`document.querySelector('[data-slot="template-palette"]') === null && document.querySelector('[data-slot="editor-schedule"]') !== null`)
    browser.fill('[aria-label="Name"]', name)
    expect(browser.text('[data-slot="editor-cron"]')).toBe('0 4 * * *')
    expect(browser.count('[data-slot="next-runs-preview"]')).toBe(1)
    browser.screenshot(`${artifactsDir}/automations-editor-new-schedule.png`)
    clickButton('Save paused')
    browser.waitForFunction(`location.pathname === '/p/${bootProject}/automations'`)

    const automation = (await listAutomations()).find((item) => item.name === name)
    expect(automation).toMatchObject({ enabled: false, kind: 'schedule' })
    created.push(automation!.id)

    // The list row: paused, the schedule label, and the row's Run now.
    const rowSelector = `[data-slot="automation-row"][data-automation="${automation!.id}"]`
    browser.waitForFunction(`document.querySelector(${JSON.stringify(rowSelector)}) !== null`)
    expect(browser.text(rowSelector)).toContain('paused')
    expect(browser.text(rowSelector)).toContain('every day at 04:00')
    browser.screenshot(`${artifactsDir}/automations-list-paused.png`)

    clickByAriaLabel('Run now', rowSelector)
    // The run lands as an ordinary task with schedule provenance, and the row's last run fills in.
    browser.waitForFunction(`document.querySelector(${JSON.stringify(`${rowSelector} [data-slot="task-link"]`)}) !== null`)
    const runs = (await (await api('/runs')).json()) as Array<{ id: string; automationTrigger?: { automationId: string; trigger: string } }>
    const run = runs.find((item) => item.automationTrigger?.automationId === automation!.id)
    expect(run?.automationTrigger?.trigger).toBe('manual')
    expect((await listAutomations()).find((item) => item.id === automation!.id)?.enabled).toBe(false)

    // The log names the by-hand launch and links the task.
    browser.goto(`${baseUrl}/p/${bootProject}/automations/${automation!.id}/log`)
    browser.waitForFunction(`document.querySelector('[data-slot="log-row"][data-result="manual"]') !== null`)
    expect(browser.text('[data-slot="log-row"][data-result="manual"]')).toContain('Open task')
    browser.screenshot(`${artifactsDir}/automations-log.png`)

    // Enable it: the week view shows its block, the rail lists it.
    expect((await api(`/automations/${automation!.id}/enable`, { method: 'POST' })).status).toBe(200)
    browser.goto(`${baseUrl}/p/${bootProject}/automations?view=week`)
    browser.waitForFunction(`[...document.querySelectorAll('[data-slot="event-block"]')].some((block) => block.textContent.includes(${JSON.stringify(name)}))`)
    browser.screenshot(`${artifactsDir}/automations-week.png`)
    browser.goto(`${baseUrl}/p/${bootProject}/automations?view=day`)
    browser.waitForFunction(`document.querySelector('[data-slot="day-view"]') !== null`)
    browser.screenshot(`${artifactsDir}/automations-day.png`)

    browser.goto(`${baseUrl}/p/${bootProject}/automations`)
    browser.waitForFunction(`document.querySelector(${JSON.stringify(rowSelector)}) !== null && document.querySelector(${JSON.stringify(rowSelector)}).textContent.includes('enabled')`)
    clickButton('Next runs')
    browser.waitForFunction(`document.querySelector('[data-slot="next-runs-rail"]') !== null`)
    expect(browser.text('[data-slot="next-runs-rail"]')).toContain(name)
    // The sheet slides in over 500ms; shoot it settled, not mid-animation.
    browser.waitForFunction(`document.querySelector('[data-slot="next-runs-rail"]').getBoundingClientRect().right <= window.innerWidth + 1 && document.querySelector('[data-slot="next-runs-rail"]').getAttribute('data-state') === 'open' && !document.querySelector('[data-slot="next-runs-rail"]').getAnimations().length`)
    browser.screenshot(`${artifactsDir}/automations-next-runs-rail.png`)
    browser.press('Escape')

    // Pause from the row, then the editor shows the edit header with the last run card.
    browser.waitForFunction(`document.querySelector('[data-slot="next-runs-rail"]') === null`)
    clickByAriaLabel('Pause', rowSelector)
    browser.waitForFunction(`document.querySelector(${JSON.stringify(rowSelector)}).textContent.includes('paused')`)
    browser.goto(`${baseUrl}/p/${bootProject}/automations/${automation!.id}`)
    browser.waitForFunction(`document.querySelector('[data-slot="last-run-card"]') !== null`)
    expect(browser.text('main')).toContain('Edit automation')
    browser.screenshot(`${artifactsDir}/automations-editor-edit.png`)
  }, 120_000)

  it('creates a GitHub poll paused, previews it, enables it from a baseline, and logs both', async () => {
    const name = `E2E issue triage ${process.pid}`
    browser.goto(`${baseUrl}/p/${bootProject}/automations/new`)
    browser.waitForFunction(`document.querySelector('[data-slot="template-palette"]') !== null`)
    clickButton('Hide templates')
    browser.waitForFunction(`document.querySelector('[data-slot="template-palette"]') === null`)
    clickButton('When GitHub changes')
    browser.waitForFunction(`document.querySelector('[data-slot="editor-github"]') !== null`)
    browser.screenshot(`${artifactsDir}/automations-editor-new-github.png`)
    browser.fill('[aria-label="Name"]', name)
    browser.fill('[aria-label="Prompt"]', 'Triage {{github.url}}')
    clickButton('Save paused')
    browser.waitForFunction(`location.pathname === '/p/${bootProject}/automations'`)

    const automation = (await listAutomations()).find((item) => item.name === name)
    expect(automation).toMatchObject({ enabled: false, kind: 'github' })
    created.push(automation!.id)

    const preview = (await (await api(`/automations/${automation!.id}/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'preview' }),
    })).json()) as { checkId: string }
    let check: { status: string; error?: string } = { status: 'queued' }
    for (let attempt = 0; attempt < 60 && !['complete', 'error'].includes(check.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      check = (await (await api(`/automation-checks/${preview.checkId}`)).json()) as { status: string; error?: string }
    }
    expect(check.status, check.error).toBe('complete')

    await api(`/automations/${automation!.id}/enable`, { method: 'POST' })
    browser.goto(`${baseUrl}/p/${bootProject}/automations/${automation!.id}/log`)
    browser.waitForFunction(`document.querySelector('[data-slot="log-row"][data-result="baseline"]') !== null && document.querySelector('[data-slot="log-row"][data-result="preview"]') !== null`)
    expect(browser.text('[data-slot="log-row"][data-result="baseline"]')).toContain('current-time baseline')
  }, 60_000)
})
