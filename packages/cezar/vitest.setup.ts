import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach } from 'vitest'

// AGENTS.md trap 2: a cockpit session's own ambient CEZ_* knobs (CEZ_ACCOUNT_USAGE, CEZ_KB,
// CEZ_OIDC_*, CEZ_PORT_STRICT, CEZ_PROJECTS_DIR, CEZ_PUBLIC_URL, CEZ_REMOTE, ...) leak into
// every agent-spawned `npm test`, and the server suites assert on exactly those knobs being off
// by default. Unset every CEZ_* except the two identity vars a run legitimately reports through
// (CEZ_HANDOFF_FILE/CEZ_TASK_ID) and the explicit live-vendor contract-test opt-in — a
// LIVE-COMPUTED prefix match, not an enumerated list, because
// AGENTS.md already documents an enumerated version of this same scrub going stale once. A
// suite that means to exercise one of these sets it inside its own test/beforeEach and restores
// it (the precedent CEZ_AUTOMATIONS/CEZ_SINGLE_PROJECT/etc. already establish in this file's
// neighboring test suites) — this hook only removes the ambient value nobody chose.
//
// Runs before `sandboxHome`/`pinSandboxHome()` below: it deletes `CEZ_HOME` too (it starts with
// `CEZ_`), and `pinSandboxHome()` immediately re-sets it to the sandbox value.
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith('CEZ_') &&
    key !== 'CEZ_HANDOFF_FILE' &&
    key !== 'CEZ_TASK_ID' &&
    key !== 'CEZ_LIVE_CLI_CONTRACT'
  ) {
    delete process.env[key]
  }
}

// AGENTS.md trap 4: #785's per-run TMPDIR (agent-tmpdir.ts) points INSIDE the checkout under
// test, so any test that mkdtemp()s under os.tmpdir() and expects the result NOT to be a git
// repo gets one whose upward `git rev-parse` walk finds this checkout's own .git. Deliberately
// realpathSync('/tmp'), not tmpdir() (unlike sandboxHome below) — tmpdir() reads the ambient,
// possibly-poisoned TMPDIR, which is exactly the value being escaped here. /tmp is the one
// directory guaranteed outside every repo on this box, matching AGENTS.md's own manual recipe.
//
// Runs before `sandboxHome` is created below — sandboxHome itself calls tmpdir(), which would
// still resolve inside the repo under a poisoned ambient TMPDIR if this scrub ran after it.
const scrubbedTmp = mkdtempSync(join(realpathSync('/tmp'), 'cez-vitest-tmp-'))
process.env.TMPDIR = scrubbedTmp
process.env.TMP = scrubbedTmp
process.env.TEMP = scrubbedTmp

// Nothing in this suite may write to the developer's own `~/.cezar`. Most cases pin
// `CEZ_HOME` themselves, but the pin is one global for the whole worker and their
// `afterEach` deletes it — so a write that outlives its test (a timeout is enough)
// used to resolve the real home and replace the project registry with the fixture's.
//
// This file removes the unpinned state entirely: every worker gets a sandbox home,
// and the pin is restored around every test, so a case that drops it can only leave
// the NEXT write pointed at the sandbox. A test that wants the unpinned default
// deletes the variable inside its own body (see `src/paths.test.ts`) — that still
// works, because this hook runs after the test, not during it. The write guard in
// `assertCezarHomeWriteIsSandboxed` catches whatever still slips through.
const sandboxHome = mkdtempSync(join(realpathSync(tmpdir()), 'cez-vitest-home-'))

const pinSandboxHome = (): void => {
  if (!process.env.CEZ_HOME) process.env.CEZ_HOME = sandboxHome
}

// `CEZ_AUTH` is a second unpinned global with the same failure mode, and a nastier blast radius.
// It is read PER REQUEST by `requirePrincipal` and by `verifyWsUpgrade`, so an ambient
// `CEZ_AUTH=oidc` — exported in a developer's shell, or left behind by a CI runner — turns every
// `createApp`-based suite red at once: route-parity, versioned-surface, host-guard and the rest
// all start 401ing, and the failure reads as "route parity is broken" rather than "the
// environment lied". (Demonstrated: `CEZ_AUTH=oidc npx vitest run …/route-parity.test.ts` → 6
// failed | 3 passed.) The suites that MEAN to exercise auth set it inside their own tests
// (`server/auth-perimeter.test.ts`, `server/ws.test.ts`, `auth/*.test.ts`) and restore it; this
// only removes the ambient value nobody chose, before any of them run.
//
// Deliberately a delete rather than a save/restore-per-test: unlike `CEZ_HOME` there is no
// sandbox value that would be correct, and the whole point is that the worker must never inherit
// one.
delete process.env.CEZ_AUTH

// Spec `.ai/specs/2026-08-24-isolate-discovered-account-tests.md`: provider-home overrides are
// ambient machine state, not valid defaults for fixture suites. The discovered-account suite
// previously leaked the real `CODEX_HOME` into exact-list assertions, recorded in
// `/tmp/cezar-b3b5719c-control-parent-agent-profiles.log`. Delete both provider overrides rather
// than substituting sandbox paths, because no replacement path is correct for every suite. Keep
// `XDG_CONFIG_HOME` untouched: it is not a provider home, and suites that use it already own it.
delete process.env.CLAUDE_CONFIG_DIR
delete process.env.CODEX_HOME

pinSandboxHome()
beforeEach(pinSandboxHome)
// Registered before any suite's own hooks, so vitest runs it last on the way out —
// after a case's `afterEach` has deleted the pin.
afterEach(pinSandboxHome)
afterAll(() => {
  rmSync(sandboxHome, { recursive: true, force: true })
  rmSync(scrubbedTmp, { recursive: true, force: true })
})
