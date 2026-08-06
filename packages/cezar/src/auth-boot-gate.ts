import { resolveAuthProvider, resolveCapabilities } from './server/capabilities.ts';
import type { AuthProvider } from '@open-mercato/cezar-contract';

/**
 * D1's boot gate (spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`), as a pure decision
 * plus its two messages — deliberately NOT inline in `serveCommand`.
 *
 * Two defects made this its own module rather than eight lines in `src/index.ts`:
 *
 *  1. **Nothing could test it there.** `src/index.ts` is the CLI entry: importing it runs the
 *     CLI, so no unit test can reach `serveCommand`, and the only end-to-end alternative is
 *     spawning `cezar serve` — which, if the gate were ever broken, would boot a real server on
 *     a real port inside the suite. A mutation that replaced the refusal with `if (false && …)`
 *     therefore left all five gates green. Everything that decides *anything* now lives here,
 *     where `auth-boot-gate.test.ts` walks all five rows of D1's table; the call site is reduced
 *     to `if (!gate.proceed) return;`.
 *  2. **It ran too late.** The gate sat after `initWorkspace` (writes `~/.cezar`),
 *     `reclaimWorktrees` (DELETES worktree directories) and `manager.recover()` (re-queues and
 *     resumes interrupted agent runs). "Refuses to boot" was therefore doing all of that first —
 *     a hosted box with no auth would resume other people's runs and only then decline to serve.
 *     This module reads nothing but `env` and `bindHost`, so the call site can now sit at the
 *     very top of `serveCommand`, before any of it.
 *
 * `hosted` is `!resolveCapabilities(env, bindHost).localHandoff` — the SAME predicate the
 * request-origin guard and `activateOptionalStores` read, never a second hand-rolled "is this
 * hosted" test that could disagree with them about what hosted means.
 */

/** The five rows of D1's table, collapsed to what the caller must do. `provider` is carried on
 *  every outcome that proceeds so the caller never re-reads `CEZ_AUTH` and never has to decide
 *  again whether to load the `auth/` tree. */
export interface AuthBootGate {
  /** `false` only for the refusal: hosted, no `CEZ_AUTH`, and no `CEZ_ALLOW_UNAUTHENTICATED=1`. */
  readonly proceed: boolean;
  /** `'none'` means the caller must NOT import anything under `src/auth/` (D1: unset ⇒ zero I/O). */
  readonly provider: AuthProvider;
  /** Printed by the caller, or by `runAuthBootGate` below. Absent when there is nothing to say —
   *  the npm zero-config default prints nothing at all, exactly as before this change. */
  readonly message?: string;
  /** Which sink `message` belongs on: the refusal is an error, the opt-out is a warning. */
  readonly severity?: 'warn' | 'error';
}

/**
 * The refusal names the actual consequence rather than "auth required" (D1 spells this out): an
 * operator reading it has to be able to tell that the thing at stake is shell execution, not a
 * missing login screen.
 */
const REFUSAL =
  '\ncezar refuses to boot: hosted mode with no authentication exposes shell execution to\n' +
  'anyone who can reach this port (POST /api/v1/workflows → spawn bash). Set CEZ_AUTH, or\n' +
  'CEZ_ALLOW_UNAUTHENTICATED=1 if your network is the perimeter.\n';

const OPT_OUT_WARNING =
  '\n  ⚠ hosted mode with no authentication (CEZ_ALLOW_UNAUTHENTICATED=1) — shell\n' +
  '    execution is reachable by anyone who can reach this port\n' +
  '    (POST /api/v1/workflows → spawn bash). This is opt-in: your network is the\n' +
  '    perimeter, cezar is not. Set CEZ_AUTH to change that.\n';

export function resolveAuthBootGate(env: NodeJS.ProcessEnv, bindHost?: string): AuthBootGate {
  const provider = resolveAuthProvider(env);
  const hosted = !resolveCapabilities(env, bindHost).localHandoff;
  if (provider !== 'none') return { proceed: true, provider };
  if (!hosted) return { proceed: true, provider };
  // Hosted with no provider: the operator either said "my network is the perimeter" out loud, or
  // did not choose at all. D1's whole point is that the second case is a refusal — nobody exposes
  // a shell by forgetting a variable.
  if (env.CEZ_ALLOW_UNAUTHENTICATED === '1') {
    return { proceed: true, provider, message: OPT_OUT_WARNING, severity: 'warn' };
  }
  return { proceed: false, provider, message: REFUSAL, severity: 'error' };
}

/** Sinks, injected so a test can assert the message and the non-zero exit WITHOUT spawning the
 *  CLI (which, on a broken gate, would start a real server) and without setting the test
 *  process's own `process.exitCode`. */
export interface AuthBootGateIo {
  warn(message: string): void;
  error(message: string): void;
  /** Called with `1` exactly when the gate refuses. The default sets `process.exitCode` rather
   *  than calling `process.exit()`: the CLI returns from `serveCommand` and lets the event loop
   *  drain, and at this point in boot nothing has been started that could hold it open. */
  exit(code: number): void;
}

const DEFAULT_IO: AuthBootGateIo = {
  warn: (message) => console.log(message),
  error: (message) => console.error(message),
  exit: (code) => {
    process.exitCode = code;
  },
};

/** `resolveAuthBootGate` plus its side effects. Returns the gate so the caller's whole
 *  responsibility is `if (!gate.proceed) return;` — everything that could be wrong about the
 *  decision, the wording, or the exit code is pinned by `auth-boot-gate.test.ts`. */
export function runAuthBootGate(
  env: NodeJS.ProcessEnv,
  bindHost?: string,
  io: AuthBootGateIo = DEFAULT_IO,
): AuthBootGate {
  const gate = resolveAuthBootGate(env, bindHost);
  if (gate.message) (gate.severity === 'error' ? io.error : io.warn)(gate.message);
  if (!gate.proceed) io.exit(1);
  return gate;
}
