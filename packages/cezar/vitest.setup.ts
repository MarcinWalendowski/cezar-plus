import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach } from 'vitest'

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

// AGENTS.md trap 2 scrub (see spec) — live-computed, not enumerated.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('CEZ_') && key !== 'CEZ_HANDOFF_FILE' && key !== 'CEZ_TASK_ID') {
    delete process.env[key]
  }
}

// AGENTS.md trap 4 scrub (see spec).
const scrubbedTmp = mkdtempSync(join(realpathSync('/tmp'), 'cez-vitest-tmp-'))
process.env.TMPDIR = scrubbedTmp
process.env.TMP = scrubbedTmp
process.env.TEMP = scrubbedTmp


pinSandboxHome()
beforeEach(pinSandboxHome)
// Registered before any suite's own hooks, so vitest runs it last on the way out —
// after a case's `afterEach` has deleted the pin.
afterEach(pinSandboxHome)
afterAll(() => {
  rmSync(sandboxHome, { recursive: true, force: true })
})
