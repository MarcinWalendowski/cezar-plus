import { execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'

/**
 * The agent-browser provider seam. Every e2e spec drives the app through this module and
 * never through a browser library directly, because `.ai/agentic.config.json` names the
 * provider (`browser.provider`) and `.ai/browsers/agent-browser.md` defines the operations.
 * Swapping providers must mean rewriting this file only.
 *
 * Each exported function maps to one operation in that descriptor: open, snapshot, eval/get
 * (assert), screenshot, record (spec 2026-08-29-per-retry-step-timing), close.
 */

const repoRoot = resolve(import.meta.dirname, '../../..')
const descriptorPath = resolve(repoRoot, '.ai/qa/test-env.json')

/**
 * The built CLI a spec spawns when it needs its OWN cezar rather than the shared test env
 * (a pinned `runs.json` fixture, an empty repo, a second project).
 *
 * Exported from here rather than re-derived per spec because it is one fact about the build
 * layout, and it has already moved once: `npm run build` emits the server into the workspace
 * package (`packages/cezar/dist`), not into a root-level `dist/`.
 *
 * `CEZ_E2E_SERVER_CLI` overrides it so the SAME spec can be pointed at a deployed build (the
 * production pass, `.ai/specs/2026-08-29-verify-active-backlog-e2e.md` D6) without a second
 * copy of any of the 19 specs that import this constant.
 */
export const cezarCli = process.env.CEZ_E2E_SERVER_CLI ?? resolve(repoRoot, 'packages/cezar/dist/index.js')

type EnvDescriptor = {
  baseUrl: string
  browser: {
    /** The resolved provider's name (`"agent-browser"`, `"none"` when nothing resolved). */
    provider: string
    installed: boolean
    command: string
    version: string
    notes: string
    /** The launch conditions the probe measured (D2) — applied to every operation this
     *  provider runs. `{}` on a machine that needs none, the expected value on a Mac. */
    env: Record<string, string>
  }
}

/** The shared descriptor written by .ai/scripts/test-env-up.sh — QA and e2e attach to the
 *  exact same instance rather than each booting their own. */
export function readTestEnv(): EnvDescriptor {
  try {
    return JSON.parse(readFileSync(descriptorPath, 'utf8')) as EnvDescriptor
  } catch (cause) {
    throw new Error(`cezar e2e: cannot read ${descriptorPath}. Run \`npm run test:e2e\`, which boots the env first.`, {
      cause,
    })
  }
}

/**
 * The environment for a spec-owned `cezar serve` over a throwaway `dataRoot`.
 *
 * `CEZ_DRY_RUN` is why these boots need no network and no agent login. `CEZ_HOME` is why they
 * are *isolated*: since the multi-project workspace landed, booting in an unregistered folder
 * APPENDS it to `~/.cezar/config.json`, so an unpinned fixture server would (a) litter the
 * developer's real registry with a dead `/tmp/cezar-e2e-…` entry per run and (b) make every
 * spec order-dependent — once the registry holds more than one project the sidebar renders
 * the grouped multi-project shell instead of the flat one these specs assert against.
 * Pinning it inside `dataRoot` means the spec's own `rmSync(dataRoot)` cleans it up too.
 *
 * The shared test env pins the same variable under `.ai/qa/cez-home`
 * (`.ai/scripts/test-env-up.sh`); this is that rule for the specs that boot their own server.
 *
 * **D8: built by allowlist, not by subtraction.** Every inherited `CEZ_*` variable (and
 * `NODE_ENV`) is dropped — enumerated from the environment itself, so a variable added next
 * month is dropped without editing a list — then only what this boot sets deliberately is
 * restored. A spec that wants a `CEZ_*` variable passes it through `extra`; it can no longer
 * inherit one from whatever runner launched the test process (`CEZ_PUBLIC_URL` alone is
 * enough to put a fresh boot into hosted mode, where it refuses to start with no auth
 * configured). `CEZ_ANALYTICS` is forced to `'1'` rather than merely left alone, because
 * `analytics-log.ts` disables the sink on the exact string `'0'` and leaving that to chance
 * would make the analytics assertion in `filed-partitions.e2e.ts` non-deterministic.
 */
const fixtureRoots = new Map<string, string>()

export function fixtureServeEnv(dataRoot: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = resolve(dataRoot, '.cez-home')
  const root = realpathSync(dataRoot)
  if (!root.startsWith(realpathSync(tmpdir()) + '/') || !/cezar-e2e-/.test(root)) {
    throw new Error(`cezar e2e: refusing non-disposable fixture root ${root}`)
  }
  if (home.startsWith(resolve(homedir(), '.cezar'))) throw new Error('cezar e2e: refusing real workspace home')
  if (extra.CEZ_HOME !== undefined && resolve(extra.CEZ_HOME) !== home) {
    throw new Error('cezar e2e: fixture CEZ_HOME cannot escape its disposable root')
  }
  fixtureRoots.set(root, home)
  const base: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'NODE_ENV' || key.startsWith('CEZ_')) continue
    if (value !== undefined) base[key] = value
  }
  return {
    ...base,
    CEZ_DRY_RUN: '1', CEZ_HOME: resolve(dataRoot, '.cez-home'), // guardian: same line, always paired
    CEZ_SKILLS_AUTO_UPDATE: '0',
    CEZ_ANALYTICS: '1',
    ...extra,
  }
}

/**
 * A JSON GET that survives a RESET idle connection.
 *
 * Specs boot a server, drive the browser for tens of seconds, then read the API back. Node's
 * fetch pools the connection opened during the health probe, and reusing a socket the server has
 * since closed surfaces as `ECONNRESET` — a dead connection, never a dead server (the process is
 * still answering the browser at that moment). One retry opens a fresh one.
 */
export async function getJson<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return (await (await fetch(url)).json()) as T
    } catch (error) {
      if (attempt >= 2) throw error
      await new Promise((r) => setTimeout(r, 250))
    }
  }
}

/** Initialize only attested scratch servers through the same onboarding and registration APIs
 * a local user uses. Readiness is explicit: org gates and seed-once registry behavior stay real. */
export async function ensureFixtureReady(baseUrl: string): Promise<string> {
  const url = new URL(baseUrl)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('cezar e2e: refusing non-loopback fixture')
  const health = await getJson<{ repoRoot: string }>(baseUrl + '/api/v1/health')
  const root = realpathSync(health.repoRoot)
  const descriptor = readTestEnv()
  const shared = baseUrl === descriptor.baseUrl && root === realpathSync(repoRoot)
  const fixtureRoot = [...fixtureRoots.keys()].find((fixture) => root === fixture || root.startsWith(fixture + '/'))
  const owned = fixtureRoot !== undefined
  if (!shared && !owned) throw new Error(`cezar e2e: server root is not an attested fixture: ${root}`)
  async function write(path: string, method: string, body: unknown) {
    const response = await fetch(baseUrl + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (response.status === 409 && path === '/api/v1/projects') {
      const existing = await response.json() as {project?: {root:string}}
      const wantedRoot = (body as {root: string}).root
      if (existing.project && realpathSync(existing.project.root) === realpathSync(wantedRoot)) return existing
      throw new Error('cezar e2e: registration conflict names a different fixture root')
    }
    if (!response.ok)
      throw new Error(`cezar e2e: ${method} ${path} failed (${response.status}): ${await response.text()}`)
    return response.json()
  }
  let onboarding = await getJson<{
    state: string
    bootstrapTokenRequired?: boolean
    team?: { name: string }
  }>(baseUrl + '/auth/onboarding')
  if (onboarding.state === 'needs-org' && onboarding.bootstrapTokenRequired === false) {
    await write('/auth/onboarding/org', 'POST', {
      name: 'Disposable E2E workspace',
    })
    onboarding = await getJson<typeof onboarding>(baseUrl + '/auth/onboarding')
    await write('/auth/onboarding/team', 'PATCH', {
      name: onboarding.team?.name ?? 'Default',
    })
  }
  if (onboarding.state !== 'ready') throw new Error(`cezar e2e: fixture onboarding is ${onboarding.state}`)
  const before = await getJson<{ bootProject: string }>(baseUrl + '/api/v1/projects')
  const configPath = fixtureRoot ? resolve(fixtureRoots.get(fixtureRoot)!, 'config.json') : undefined
  const seeded = configPath && existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, 'utf8')) as {projects?: Array<{id:string;root:string}>}).projects ?? []
    : []
  for (const project of seeded) {
    const projectRoot = realpathSync(project.root)
    if (!fixtureRoot || !(projectRoot === fixtureRoot || projectRoot.startsWith(fixtureRoot + '/'))) {
      throw new Error('cezar e2e: seeded project escapes its disposable fixture')
    }
    const registered = await write('/api/v1/projects', 'POST', {root:projectRoot}) as {project:{id:string}}
    if (registered.project.id !== project.id) throw new Error('cezar e2e: seeded registration changed project id')
  }
  await write('/api/v1/projects', 'POST', { root })
  const after = await getJson<{
    bootProject: string
    projects: Array<{ id: string; root: string; unregistered?: boolean }>
  }>(baseUrl + '/api/v1/projects')
  if (
    after.bootProject !== before.bootProject ||
    !after.projects.some((project) => project.id === before.bootProject && !project.unregistered)
  ) {
    throw new Error('cezar e2e: fixture boot registration must preserve its served project id')
  }
  return after.bootProject
}

/** Resolve the served project's real slug after explicit fixture readiness. */
export async function bootProjectId(baseUrl: string): Promise<string> {
  return ensureFixtureReady(baseUrl)
}

/** Wait for the owned HTTP process to exit before removing its home; otherwise shutdown writes
 * can recreate files during rmSync and make cleanup race with the next spec. */
export async function stopFixtureServer(server: ChildProcess | undefined): Promise<void> {
  if (!server) return
  const repoIndex = server.spawnargs.indexOf('--repo')
  const servedRoot = repoIndex >= 0 ? server.spawnargs[repoIndex + 1] : undefined
  const ownedRoot = servedRoot && existsSync(servedRoot)
    ? [...fixtureRoots.keys()].find((root) => { const served = realpathSync(servedRoot); return served === root || served.startsWith(root + '/') })
    : undefined
  const snapshot = () => execFileSync('ps', ['-axo', 'pid=,ppid=,lstart='], {encoding:'utf8'})
    .trim().split('\n').map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
      const [,pid,parent,started] = match ?? []
      if (!pid || !parent || !started) throw new Error('cezar e2e: invalid process snapshot row')
      return {pid:Number(pid), parent:Number(parent), started:started.trim()}
    })
  const starts = new Map<number, string>()
  const descendants = new Set<number>()
  const captureOwned = () => {
    const processRows = snapshot()
    for (const {pid,started} of processRows) if (!starts.has(pid)) starts.set(pid,started)
    if (ownedRoot) {
      const commands = execFileSync('ps', ['-axo', 'pid=,command='], {encoding:'utf8'}).split('\n')
      for (const line of commands) {
        const match = line.trim().match(/^(\d+)\s+(.+)$/)
        if (!match?.[1] || !match[2]) continue
        const pid = Number(match[1])
        const command = match[2]
        const spool = command.match(/(?:^|\s)--spool\s+(\S+)/)?.[1]
        if (starts.has(pid) && command.includes(`${cezarCli} run-broker `) && spool?.startsWith(ownedRoot + '/')) {
          descendants.add(pid)
        }
      }
    }
    let discovered = true
    while (discovered) {
      discovered = false
      for (const {pid, parent} of processRows) {
        if (pid !== server.pid && (parent === server.pid || descendants.has(parent)) && !descendants.has(pid)) {
          descendants.add(pid)
          discovered = true
        }
      }
    }
  }
  captureOwned()
  if (server.exitCode === null && server.signalCode === null) await new Promise<void>((done) => {
    const timeout = setTimeout(() => server.kill('SIGKILL'), 5000)
    server.once('exit', () => { clearTimeout(timeout); done() })
    server.kill('SIGTERM')
  })
  captureOwned()
  const alive = (pid: number): boolean => {
    try {
      const started = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {encoding:'utf8'}).trim()
      return started === starts.get(pid)
    } catch (error) {
      if ((error as {status?:number}).status === 1 || (error as NodeJS.ErrnoException).code === 'ESRCH') return false
      throw error
    }
  }
  for (const pid of [...descendants].reverse()) {
    try { if (alive(pid)) process.kill(pid, 'SIGTERM') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  for (let attempt = 0; [...descendants].some(alive) && attempt < 20; attempt += 1) {
    await new Promise((done) => setTimeout(done, 100))
  }
  for (const pid of descendants) {
    if (alive(pid)) process.kill(pid, 'SIGKILL')
  }
}

export class AgentBrowser {
  private activeRecording: string | undefined
  // A unique session per run, per the descriptor's rules — never attach to a user's profile.
  private constructor(
    private readonly bin: string,
    private readonly session: string,
    private readonly provider: string,
    private readonly launchEnv: Record<string, string>,
  ) {}

  static open(session: string): AgentBrowser {
    const env = readTestEnv()
    const provider = env.browser.provider || 'none'
    if (!env.browser.installed) {
      throw new Error(`cezar e2e: the ${provider} provider is not installed (${env.browser.notes})`)
    }
    const browser = new AgentBrowser(env.browser.command, session, provider, env.browser.env ?? {})
    if (process.env.CEZ_E2E_RECORD === '1') {
      try {
        browser.run(['open', 'about:blank'])
        browser.startRecording(resolve(repoRoot, '.ai/qa/artifacts_e2e', `${session}-${Date.now()}.webm`))
      } catch (error) {
        browser.close()
        throw error
      }
    }
    return browser
  }

  /** One provider invocation. `--json` on every call so results are parsed, not scraped. The
   *  descriptor's `browser.env` (D2's measured launch conditions — e.g. `AGENT_BROWSER_ARGS`,
   *  a short `TMPDIR`) is applied to every child, not just the first: `execFileSync` gives the
   *  child no environment of its own otherwise, so it would silently inherit whatever this
   *  process's own environment happens to be. */
  private run(args: string[]): Record<string, unknown> {
    let stdout: string
    try {
      stdout = execFileSync(this.bin, ['--session', this.session, ...args, '--json'], {
        encoding: 'utf8',
        // A hung browser must fail the spec, not the whole suite's wall clock.
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, ...this.launchEnv },
      })
    } catch (cause) {
      throw new Error(`cezar e2e: ${this.provider} ${args.join(' ')} failed`, {
        cause,
      })
    }
    const parsed = JSON.parse(stdout) as {
      success: boolean
      data?: unknown
      error?: unknown
    }
    if (!parsed.success) {
      throw new Error(`cezar e2e: ${this.provider} ${args.join(' ')} → ${JSON.stringify(parsed.error)}`)
    }
    return (parsed.data ?? {}) as Record<string, unknown>
  }

  /** operation: open */
  goto(url: string): void {
    this.run(['open', url])
  }

  /** operation: snapshot — the accessibility tree, as the string the descriptor documents. */
  snapshot(): string {
    return String(this.run(['snapshot', '-i']).snapshot ?? '')
  }

  /** operation: assert (`get text`) */
  text(selector: string): string {
    return String(this.run(['get', 'text', selector]).text ?? '')
  }

  /** operation: assert (`get url`) */
  url(): string {
    return String(this.run(['get', 'url']).url ?? '')
  }

  /** operation: assert (`is visible`).
   *
   *  Throws when nothing matches — the CLI reports an absent element as a failed query, not as
   *  "not visible". Use `count` for anything that unmounts rather than hides. */
  isVisible(selector: string): boolean {
    return this.run(['is', 'visible', selector]).visible === true
  }

  /** operation: assert (`eval`) — how many nodes match.
   *
   *  The distinction from `isVisible` is real and load-bearing: the desktop sidebar is in the DOM
   *  but display:none, while a closed Radix dialog is not in the DOM at all. Only this can say
   *  which of the two a surface is, and only this can assert absence without erroring. */
  count(selector: string): number {
    return Number(this.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`))
  }

  /** operation: interact (`wait --fn`) — block until a predicate is truthy in the page.
   *
   *  Animated surfaces need this. The drawer slides in over 500ms, so for half a second after the
   *  tap that opened it, it is mounted, "visible", and still entirely off-screen — sampling it in
   *  that window answers every question wrong. */
  waitForFunction(js: string): void {
    this.run(['wait', '--fn', js])
  }

  /** operation: interact (`press`) — a key press against whatever currently has focus. */
  press(key: string): void {
    this.run(['press', key])
  }

  /** operation: interact (`fill`) — set a field's value the way typing would (real input
   *  events, so controlled React inputs — the ⌘K palette's filter — see the change). */
  fill(selector: string, value: string): void {
    this.run(['fill', selector, value])
  }

  /** operation: interact (`mouse move`/`down`/`up`) — a tap at a viewport coordinate.
   *
   *  `click` targets an element's center point and, by design, refuses when something covers it.
   *  A modal backdrop is exactly that case: it spans the viewport, so its center sits under the
   *  drawer it is dimming, and the only honest way to tap the backdrop *beside* the drawer is by
   *  coordinate. */
  tapAt(x: number, y: number): void {
    this.run(['mouse', 'move', String(x), String(y)])
    this.run(['mouse', 'down'])
    this.run(['mouse', 'up'])
  }

  /** operation: interact (`mouse move`/`down`/`up`) — press at one viewport coordinate, move to
   *  another, release. A real, trusted pointer stream, which is the only kind that can exercise
   *  a drag built on pointer capture (`setPointerCapture` rejects a pointer id the browser is
   *  not actually tracking, so a synthetically dispatched PointerEvent cannot test one).
   *
   *  The intermediate move exists because a single jump from press to release is indistinguishable
   *  from a click for anything that samples movement — the sidebar's resize handle reads each
   *  move, so it needs more than one. */
  dragTo(from: { x: number; y: number }, to: { x: number; y: number }): void {
    this.run(['mouse', 'move', String(from.x), String(from.y)])
    this.run(['mouse', 'down'])
    this.run(['mouse', 'move', String(Math.round((from.x + to.x) / 2)), String(Math.round((from.y + to.y) / 2))])
    this.run(['mouse', 'move', String(to.x), String(to.y)])
    this.run(['mouse', 'up'])
  }

  /** operation: assert (`eval`) — for DOM facts no selector query can express, such as a
   *  computed style resolved from a CSS custom property. */
  evaluate(js: string): unknown {
    return this.run(['eval', js]).result
  }

  /** operation: interact (`set viewport`) — the descriptor's "other actions use the matching
   *  CLI command" clause. Responsive layout is a real behavior of this app, so the specs must be
   *  able to ask for an iPhone-sized window rather than assume the default one. */
  setViewport(width: number, height: number): void {
    this.run(['set', 'viewport', String(width), String(height)])
  }

  /** operation: interact (`click`). */
  click(selector: string): void {
    this.run(['click', selector])
  }

  /** operation: interact (`hover`) — hover-revealed affordances (the table's rename pencil)
   *  only exist under a real pointer; tests must produce one, not reach past it. */
  hover(selector: string): void {
    this.run(['hover', selector])
  }

  /** operation: screenshot. The descriptor requires an absolute path — a relative
   *  multi-segment path is read as a selector by the CLI.
   *
   *  `viewport: true` captures the visible viewport only. Full-page capture stitches by
   *  scrolling through the document, which is both pathological on a virtualized thread and
   *  destroys scroll-dependent UI state (it re-pins the thread and unmounts the jump pill) —
   *  any spec asserting such state after the shot must use the viewport mode. */
  screenshot(path: string, { viewport = false } = {}): string {
    const absolute = resolve(path)
    mkdirSync(dirname(absolute), { recursive: true })
    this.run(viewport ? ['screenshot', absolute] : ['screenshot', '--full', absolute])
    if (statSync(absolute).size === 0) throw new Error(`cezar e2e: empty screenshot at ${absolute}`)
    return absolute
  }

  /** operation: record (start). WebM, per the descriptor's `record` operation
   *  (spec 2026-08-29-per-retry-step-timing, Phase 2 item 8) — added alongside `screenshot`
   *  because no e2e spec in this repository could retain video before it. Call AFTER the first
   *  `goto`, never right after `open()`: `open()` starts no browser, it only reads
   *  `.ai/qa/test-env.json` and returns this wrapper, so a `record start` issued before the first
   *  real page load has nothing to record. CEZ_E2E_RECORD primes an empty about:blank context
   *  before returning from open, so recording starts before the test sets viewport or navigates. */
  startRecording(path: string): void {
    if (this.activeRecording) this.stopRecording(this.activeRecording)
    const absolute = resolve(path)
    mkdirSync(dirname(absolute), { recursive: true })
    this.run(['record', 'start', absolute])
    this.activeRecording = absolute
  }

  /** operation: record (stop). Gates on a non-empty file, the same discipline `screenshot`
   *  applies to its PNGs — a `record` that produced nothing is a missing artifact, not a silent
   *  no-op. If `record` turns out not to work headless on the box a spec runs on, that spec must
   *  say so in its own gate notes rather than swallow the assertion. */
  stopRecording(path: string): string {
    const absolute = resolve(path)
    this.run(['record', 'stop'])
    this.activeRecording = undefined
    if (!existsSync(absolute) || statSync(absolute).size === 0) {
      throw new Error(`cezar e2e: empty or missing recording at ${absolute}`)
    }
    return absolute
  }

  /** Finalize required evidence even on a failed spec, then always release its browser. */
  close(): void {
    try {
      if (this.activeRecording) this.stopRecording(this.activeRecording)
    } finally {
      try {
        this.run(['close'])
      } catch {
        /* already closed */
      }
    }
  }
}
