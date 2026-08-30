import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'

/**
 * V8 for `.ai/specs/2026-08-23-plain-end-structured-question.md`, made executable
 * (`.ai/specs/2026-08-29-plain-end-question-verification.md`, P1) — the owner's 2026-08-22
 * report: a turn that ends with no marker used to render the identical "The agent is paused,
 * waiting for your reply" banner whether the agent asked something real or simply stopped.
 *
 * Crosses the whole seam a unit test cannot: detector → bounded nudge → store → contract →
 * SSE/index projection → cockpit render, against a real server and a real browser, for all
 * three shapes the mock's verbs can drive without an LLM (`mock-claude.mjs:117-118, :250`):
 * a lone prose question (case A), a nudge that upgrades it to structured `CEZ:ASK` chips
 * (case B), and a genuine report that must not invent a question (case C, AC3).
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-plain-end-question-${process.pid}`

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
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`cezar e2e: the plain-end-question server never answered at ${url}`)
}

type RunRecord = { id: string; status: string; waitingReason?: string; waitingQuestion?: string }

async function getRun(url: string, id: string): Promise<RunRecord> {
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/v1/runs/${id}`)
      if (!response.ok) throw new Error(`GET run answered ${response.status}`)
      return (await response.json()) as RunRecord
    } catch (error) {
      lastError = error
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw lastError
}

async function waitForStatus(url: string, id: string, wanted: string[], tries = 160): Promise<string> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const { status } = await getRun(url, id)
    if (wanted.includes(status)) return status
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`cezar e2e: run ${id} never reached status "${wanted.join('/')}"`)
}

const startRun = async (url: string, task: string): Promise<string> => {
  const created = (await (
    await fetch(`${url}/api/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task, workflow: 'quick-task' }),
    })
  ).json()) as { id: string }
  return created.id
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

const scoped = (path: string) => `/p/${bootProject}${path}`

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-plain-end-question-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# plain-end-question e2e fixture repo\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  // `registered-project-roots.ts#suppressBootRegistration` unconditionally suppresses
  // auto-registering the `--repo` launch directory as a workspace project (it only serves it),
  // so a fresh org has `hasProjects: false` and the onboarding gate (below) would otherwise
  // dead-end on "Add your first project" with no way to point it back at THIS server's own
  // boot directory. Pre-registering it in `config.json`, the way `filed-partitions.e2e.ts` does
  // for its own fixture project, sidesteps that: the boot project (`bootProjectId` below) then
  // resolves to this same entry, and finishing the org/team steps is enough to clear the gate.
  const cezHome = join(dataRoot, '.cez-home')
  mkdirSync(cezHome, { recursive: true })
  writeFileSync(
    join(cezHome, 'config.json'),
    `${JSON.stringify({
      projects: [
        {
          id: 'fixture',
          root: realpathSync(dataRoot),
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
    [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)

  // A fresh `CEZ_HOME` has no org yet (`onboarding-gate.ts`'s D14 gate: no dashboard element
  // renders before the first organization exists), so the scoped tasks route redirects to
  // `/onboarding` on first load. Walk org creation and the team-accept step once, the way
  // `filed-partitions.e2e.ts` does, before any case below navigates to a task page. The
  // pre-registered project above means the wizard's project step never has to render.
  // (The bare, unscoped `/tasks` never mounts a route here — it must be the scoped path.)
  browser.goto(`${baseUrl}${scoped('/tasks')}`)
  browser.waitForFunction(`document.querySelector('[data-slot="onboarding-org-name"]') !== null`)
  browser.fill('[data-slot="onboarding-org-name"]', 'fixture-org')
  browser.click('[data-slot="onboarding-org-submit"]')
  browser.waitForFunction(`document.querySelector('[data-slot="onboarding-team-accept"]') !== null`)
  browser.click('[data-slot="onboarding-team-accept"]')

  // The client's own onboarding-entry-probe cache can still read stale between the click above
  // and a real navigation — the server itself is already `hasProjects: true` the instant team
  // creation lands. A fresh full-page `goto` (not a client route push) re-probes cold and
  // resolves correctly, which is what every case below does anyway for its own task URL.
  browser.goto(`${baseUrl}${scoped('/tasks')}`)
  browser.waitForFunction(`location.pathname.endsWith('/tasks')`)
}, 180_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('a plain-end turn is never a dead end (#410)', () => {
  it('case A: a trailing question with no marker renders as the quoted question, composer enabled', async () => {
    const id = await startRun(baseUrl, 'mock:question ship it?')
    await waitForStatus(baseUrl, id, ['waiting'])

    const record = await getRun(baseUrl, id)
    expect(record.waitingReason).toBe('question')
    expect(record.waitingQuestion).toBe('So: merge and deploy now, or hold for review?')

    browser.goto(`${baseUrl}${scoped(`/tasks/${id}`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="waiting-question"]') !== null`)

    const surface = browser.evaluate(`(() => {
      const hint = document.querySelector('[data-slot="paused-hint"]')
      const question = hint?.querySelector('[data-slot="waiting-question"]') ?? null
      const textarea = document.querySelector('[data-slot="composer"] textarea')
      return {
        questionInsideHint: question !== null,
        questionText: question?.textContent ?? null,
        wrapperClass: hint?.className ?? null,
        composerDisabled: textarea?.disabled ?? null,
      }
    })()`) as {
      questionInsideHint: boolean
      questionText: string | null
      wrapperClass: string | null
      composerDisabled: boolean | null
    }

    // Acceptance criterion 1/5: the surface carries WHAT is being asked, not a bare "paused".
    expect(surface.questionInsideHint).toBe(true)
    expect(surface.questionText).toBe('So: merge and deploy now, or hold for review?')
    expect(surface.wrapperClass).toContain('items-start')
    expect(surface.composerDisabled).toBe(false)
    browser.screenshot(`${artifactsDir}/plain-end-question-fallback.png`)

    // V4: the NDJSON evidence the orphaned screenshots on cez/183740fe could never show —
    // the bounded nudge really fired, exactly once, and left a record of it (run.test.ts:1941).
    const ndjson = readFileSync(join(dataRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8')
    const nudgeNotes = ndjson
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; message?: string })
      .filter((event) => event.type === 'note' && event.message?.includes('nudged to re-send'))
    expect(nudgeNotes).toHaveLength(1)
  })

  it('case B: the bounded nudge upgrades the same prose question into tappable, answerable chips', async () => {
    const id = await startRun(baseUrl, 'mock:ask-on-nudge mock:question ship it?')
    browser.goto(`${baseUrl}${scoped(`/tasks/${id}`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="ask-card"]') !== null`)

    const card = browser.evaluate(`(() => {
      const el = document.querySelector('[data-slot="ask-card"]')
      const group = el.querySelector('[role="group"]')
      return {
        resolved: el.dataset.resolved,
        header: group.querySelector('span')?.textContent ?? null,
        options: [...group.querySelectorAll('button')].map((b) => b.querySelector('span span')?.textContent ?? null),
      }
    })()`) as { resolved: string; header: string | null; options: Array<string | null> }
    expect(card.resolved).toBe('false')
    expect(card.header).toBe('Library')
    expect(card.options).toEqual(['date-fns', 'Luxon'])
    // No fallback quote box once the ask has landed — the two surfaces are mutually exclusive.
    expect(browser.count('[data-slot="waiting-question"]')).toBe(0)

    // The negative control: `waitingReason`/`waitingQuestion` are cleared once the ask lands
    // (run.test.ts:1969-1970), proven here through the store → contract → SSE → reducer seam,
    // not just at the engine layer.
    const record = await getRun(baseUrl, id)
    expect(record.waitingReason).toBeUndefined()
    expect(record.waitingQuestion).toBeUndefined()

    // Screenshot while the chips are still on screen — before the tap resolves the card.
    browser.screenshot(`${artifactsDir}/plain-end-question-chips.png`)

    // The owner's literal request: "predefined questions and some suggest answer", asserted.
    browser.click('[data-slot="ask-card"] [role="group"] button:nth-of-type(1)')
    browser.waitForFunction(`document.querySelector('[data-slot="ask-card"][data-resolved="true"]') !== null`)
    expect(browser.text('[data-slot="ask-card"]')).toContain('date-fns')
  })

  it('case C: a genuine report parks cleanly with no invented question (AC3)', async () => {
    const id = await startRun(baseUrl, 'mock:report just do the thing')
    await waitForStatus(baseUrl, id, ['waiting'])

    const record = await getRun(baseUrl, id)
    expect(record.waitingReason).toBe('report')
    expect(record.waitingQuestion).toBeUndefined()

    browser.goto(`${baseUrl}${scoped(`/tasks/${id}`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="paused-hint"]') !== null`)

    const surface = browser.evaluate(`(() => {
      const hint = document.querySelector('[data-slot="paused-hint"]')
      return {
        wrapperClass: hint.className,
        hasQuestion: hint.querySelector('[data-slot="waiting-question"]') !== null,
      }
    })()`) as { wrapperClass: string; hasQuestion: boolean }
    expect(surface.hasQuestion).toBe(false)
    expect(surface.wrapperClass).toContain('items-center')
    browser.screenshot(`${artifactsDir}/plain-end-question-report.png`)
  })
})
