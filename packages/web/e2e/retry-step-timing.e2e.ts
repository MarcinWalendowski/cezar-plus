import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import record from './fixtures/retry-timing-run.record.json'

/**
 * The retry tree and the aggregate clock, in a real browser — the E2E `main`'s own
 * `.ai/specs/2026-08-29-step-retry-timing.md` shipped without.
 *
 * PROVENANCE, because the two halves come from different places. The harness, the fixture and
 * these three assertions were written on branch `cez/6ed5bc42` against a SECOND, independent
 * implementation of the same feature (`.ai/specs/2026-08-29-per-retry-step-timing.md`, now
 * superseded — `main` shipped first). That branch's engine and UI changes were dropped on merge;
 * this file was kept and re-pointed at what actually shipped, because a real-browser E2E is the
 * one thing `main`'s version lacked. Re-pointing was not cosmetic — the two designs differ in
 * both the stored shape (`{n, startedAt, endedAt}` vs `{startedAt, finishedAt}`) and the DOM
 * (always-visible sibling rows vs a `×N` badge that toggles a `step-attempts` block), so the
 * fixture was renamed field-by-field and the traversal rewritten.
 *
 * It follows `task-thread.e2e.ts` exactly, because that file already solves this shape: write the
 * run record into a temp `dataRoot` BEFORE boot (the store reads `runs.json` once at startup, and
 * a terminal status keeps `recover()` off it), spawn the packaged CLI, wait for
 * `/api/v1/health`, then drive a real Chrome at it.
 *
 * The fixture (`fixtures/retry-timing-run.record.json`) is a `gate`/`work` record — a `gate` step
 * with `onFail.retry: work, max: 2` whose three attempts take 1s/2s/3s, normalized to exact
 * millisecond intervals (1000/2000/3000ms on `gate`, 2000ms on each `work` attempt) so the
 * rendered strings are pinned by arithmetic rather than by how loaded the box was when the run
 * was captured — see fixtures/README.md for the provenance note. Both steps are `done` and the
 * run is `done`, so `activeStepIndex` falls through to the LAST step: the collapsed summary clock
 * is `gate`'s, which is what makes the aggregate assertion below meaningful.
 *
 * `.ai/scripts/e2e.sh` exits 0 with `TEST_E2E_STATUS=skipped` wherever no browser can launch, so
 * this file does not run on most machines. The numbers it asserts are therefore ALSO pinned in
 * jsdom by `src/routes/task-thread/retry-timing-fixture.test.ts`, which runs under a plain
 * `npm test` — keep the two in step: the intervals and the `0:06` total appear in both.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-retry-timing-${process.pid}`

const RUN = record
const RUN_ID: string = RUN.id

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
  throw new Error(`cezar e2e: the fixture server never answered at ${url}`)
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string
let recordingPath: string
let recordingStarted = false

const scoped = (path: string) => `/p/${bootProject}${path}`

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-retry-timing-'))
  mkdirSync(join(dataRoot, '.ai/cezar/runs'), { recursive: true })
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify([RUN], null, 2), 'utf8')

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)

  // Assert the fixture parses BEFORE touching the browser, so a schema drift fails as a schema
  // error at the first assertion rather than as an unexplained missing DOM node forty lines later.
  const scopedRun = (await (await fetch(`${baseUrl}/api/v1/p/${bootProject}/runs/${RUN_ID}`)).json()) as {
    steps: Array<{ id: string; attempts?: unknown[]; iterations: number }>
  }
  const gate = scopedRun.steps.find((s) => s.id === 'gate')
  expect(gate?.attempts).toHaveLength(3)
  expect(gate?.iterations).toBe(3)

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
  browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}`)
  browser.waitForFunction(`document.querySelector('[data-slot="workflow-steps"]') !== null`)

  // Start recording after the first real navigation, not right after `AgentBrowser.open` — `open`
  // starts no browser, `goto` is the first call that actually drives anything.
  recordingPath = join(artifactsDir, 'retry-timing.webm')
  try {
    browser.startRecording(recordingPath)
    recordingStarted = true
  } catch {
    // Not verified headless on every box this runs on (Phase 2 item 8) — the two screenshots
    // below remain the retained evidence, and the run's own gate notes must say video is
    // unavailable rather than report a pass that did not happen.
    recordingStarted = false
  }
}, 120_000)

afterAll(() => {
  if (recordingStarted) {
    try {
      browser.stopRecording(recordingPath)
    } catch {
      /* reported as unavailable in the implementing run's gate notes, per the module doc above */
    }
  }
  browser?.close()
  server?.kill()
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('retry step timing', () => {
  it('the collapsed summary shows the AGGREGATE, not the last attempt', () => {
    // Scoped to the collapsible trigger, not a bare selector: both `StepClock` call sites render
    // the same `[data-slot="step-duration"]` element, so an unscoped query would match the
    // summary clock and every expanded row's clock once the rail opens.
    const collapsed = browser.evaluate(
      `document.querySelector('[data-slot="workflow-steps"] > button [data-slot="step-duration"]')?.textContent?.trim() ?? null`,
    )
    expect(collapsed).toBe('0:06')
    browser.screenshot(join(artifactsDir, 'retry-timing-collapsed.png'))
  })

  it('the `gate` breakdown is BEHIND the ×N badge, not rendered until it is pressed', () => {
    browser.click('[data-slot="workflow-steps"] > button')
    browser.waitForFunction(`document.querySelector('[data-slot="step-rail"]') !== null`)

    // The negative half, and worth asserting: the badge is a BUTTON only when a step has more
    // than one recorded attempt, so "no breakdown on screen" is also exactly what a fixture that
    // lost its `attempts` array would look like. Pin the collapsed state AND the control first.
    expect(browser.evaluate(`document.querySelectorAll('[data-slot="step-attempt"]').length`)).toBe(0)
    expect(
      browser.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll('[data-slot="step-row"]'))
          .find((el) => el.textContent.includes('Gate'))
        const badge = row?.querySelector('[data-slot="step-iterations"]')
        return badge ? [badge.tagName, badge.getAttribute('aria-expanded'), badge.textContent.trim()].join('|') : null
      })()`),
    ).toBe('BUTTON|false|×3')
  })

  it('pressing it reveals three attempt rows for `gate`, in order', () => {
    // `StepAttempts` renders as a SIBLING of the row inside the same fragment, so the breakdown
    // is the row's next element in the rail — not a descendant of it.
    browser.evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('[data-slot="step-row"]'))
        .find((el) => el.textContent.includes('Gate'))
      row.querySelector('[data-slot="step-iterations"]').click()
      return true
    })()`)
    browser.waitForFunction(`document.querySelector('[data-slot="step-attempts"]') !== null`)

    const rows = browser.evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('[data-slot="step-row"]'))
        .find((el) => el.textContent.includes('Gate'))
      const block = row.nextElementSibling
      if (!block || !block.matches('[data-slot="step-attempts"]')) return null
      return Array.from(block.querySelectorAll('[data-slot="step-attempt"]'))
        .map((el) => el.textContent.trim().replace(/\\s+/g, ' '))
    })()`) as string[] | null
    expect(rows).toHaveLength(3)
    expect(rows).toEqual(['attempt 1 · 0:01', 'attempt 2 · 0:02', 'attempt 3 · 0:03'])
  })

  it('the expanded headline agrees with the collapsed one — the task\'s "total time as step time"', () => {
    const collapsed = browser.evaluate(
      `document.querySelector('[data-slot="workflow-steps"] > button [data-slot="step-duration"]')?.textContent?.trim() ?? null`,
    )
    const expanded = browser.evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('[data-slot="step-row"]'))
        .find((el) => el.textContent.includes('Gate'))
      return row?.querySelector('[data-slot="step-duration"]')?.textContent?.trim() ?? null
    })()`)
    expect(expanded).toBe('0:06')
    expect(expanded).toBe(collapsed)
    browser.screenshot(join(artifactsDir, 'retry-timing-expanded.png'))
  })
})
