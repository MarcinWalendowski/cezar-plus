import { serve, type ServerType } from '@hono/node-server';
import type { AuthProvider } from '@open-mercato/cezar-contract';
import { identityDir } from '../paths.ts';
import { resolveAuthProvider } from '../server/capabilities.ts';
import { IdentityStore } from '../auth/identity-store.ts';
import { sessionResolver } from '../auth/session.ts';
import { authRoutes } from '../auth/routes.ts';
import { onboardingRoutes } from '../auth/onboarding-routes.ts';
import { createSupervisorApp } from './server.ts';
import { orgProcessRegistryDir } from './paths.ts';
import { OrgProcessRegistryStore } from './org-registry-store.ts';

/**
 * `cezar supervisor` (D4/D10, spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`) — boot glue
 * for the process that terminates authentication for every org process behind it. The `src/index.ts`
 * CLI entry's `supervisor` subcommand is this module's only caller (a dynamic `import()`, matching
 * `serveCommand`'s own `CEZ_AUTH`-gated dynamic import of `src/auth/*` — this whole module needs the
 * auth tree unconditionally, so unlike `serveCommand` there is no branch here that skips it, but the
 * CLI's `run`/`init`/`server-install`/etc. commands must never pull this module into their import
 * graph either).
 *
 * **Split into a pure decision + an impure boot, on `auth-boot-gate.ts`'s own precedent.**
 * `resolveSupervisorBootGate`/`runSupervisorBootGate` below are ordinary, importable, unit-testable
 * functions; `startSupervisor` is the real side effect (opens `IdentityStore`/
 * `OrgProcessRegistryStore`, binds a port) and is never called by this repo's own test suite — the
 * task that produced this file runs under an explicit rule against starting a server, opening a
 * listening socket, or touching a real `<CEZ_HOME>` during the session, and `auth-boot-gate.test.ts`
 * already established why a CLI-entry-adjacent side effect is untestable by construction anyway
 * (see that file's own module doc comment).
 */

// ---- the boot gate: pure, tested -----------------------------------------------------------------

export interface SupervisorBootGate {
  /** `false` only when `CEZ_AUTH` is unset/`none`. */
  readonly proceed: boolean;
  readonly provider: AuthProvider;
  /** Printed on refusal; absent on the happy path. */
  readonly message?: string;
}

/**
 * Unlike `auth-boot-gate.ts`'s D1 table (which lets a HOSTED `cezar serve` boot with no auth via
 * `CEZ_ALLOW_UNAUTHENTICATED=1`, because a private network can legitimately be that deployment's
 * whole perimeter), the supervisor has no such escape hatch: its entire reason to exist is BEING
 * the perimeter for every org process behind it (D10). `CEZ_ALLOW_UNAUTHENTICATED=1` says "my
 * network is the perimeter instead of a login", which is incoherent for the one process whose job
 * is producing the signed, per-org principal every org process trusts — there is no "instead" for
 * it to opt into. So this gate has one row, not five: `CEZ_AUTH` must name a real provider, always.
 *
 * **CORRECTED 2026-08-07 (repair stage): `'supervisor'` is not a real provider either, and this
 * gate used to admit it.** `resolveAuthProvider` gained the `'supervisor'` literal at phase 6 fill
 * unit 5, and this function's whole decision was `provider === 'none'` — so a copy-paste of an ORG
 * unit's `Environment=CEZ_AUTH=supervisor` into the supervisor's own unit booted a supervisor that
 * mounts `authRoutes` for a provider `OidcProvider` (`oidc | google`) cannot express, failing at
 * the first login attempt with an opaque message instead of at boot with the one written below for
 * exactly this case. Mutation testing found it: `index.test.ts` enumerated `oidc`/`google` for
 * proceed and `{}`/`none`/`CEZ_ALLOW_UNAUTHENTICATED` for refuse, and the one row phase 6 CREATED
 * appeared in neither list.
 */
const REFUSAL =
  '\ncezar supervisor refuses to boot: CEZ_AUTH must name a real provider (oidc or google).\n' +
  '  The supervisor exists to TERMINATE authentication for every org process behind it (D10) —\n' +
  '  with CEZ_AUTH unset there is no login to terminate, and the forwarded-principal headers it\n' +
  '  would sign for those processes to trust would not correspond to anyone signed in. Set\n' +
  '  CEZ_AUTH=oidc or CEZ_AUTH=google.\n';

const SUPERVISOR_VALUE_REFUSAL =
  '\ncezar supervisor refuses to boot: CEZ_AUTH=supervisor names THIS process, not a provider.\n' +
  '  That value belongs on an ORG unit, where it means "trust the supervisor\'s signed, forwarded\n' +
  '  principal instead of terminating a login" (D10). Setting it here would tell the supervisor to\n' +
  '  trust a supervisor — itself — and there would be no login anywhere in the deployment. Set\n' +
  '  CEZ_AUTH=oidc or CEZ_AUTH=google on this unit; leave CEZ_AUTH=supervisor to the org units.\n';

export function resolveSupervisorBootGate(env: NodeJS.ProcessEnv): SupervisorBootGate {
  const provider = resolveAuthProvider(env);
  if (provider === 'none') return { proceed: false, provider, message: REFUSAL };
  if (provider === 'supervisor') return { proceed: false, provider, message: SUPERVISOR_VALUE_REFUSAL };
  return { proceed: true, provider };
}

/** Sinks, injected so a test can assert the message and the non-zero exit without starting a real
 *  process — the same shape `auth-boot-gate.ts#AuthBootGateIo` uses, for the same reason. */
export interface SupervisorBootGateIo {
  error(message: string): void;
  exit(code: number): void;
}

const DEFAULT_IO: SupervisorBootGateIo = {
  error: (message) => console.error(message),
  exit: (code) => {
    process.exitCode = code;
  },
};

export function runSupervisorBootGate(env: NodeJS.ProcessEnv, io: SupervisorBootGateIo = DEFAULT_IO): SupervisorBootGate {
  const gate = resolveSupervisorBootGate(env);
  if (!gate.proceed) {
    if (gate.message) io.error(gate.message);
    io.exit(1);
  }
  return gate;
}

// ---- the real boot: impure, never executed by this repo's own test suite -------------------------

export interface StartSupervisorOptions {
  readonly port: number;
  readonly bindHost?: string;
}

/**
 * The real, process-lifetime boot: `if (!gate.proceed) return undefined;` first (mirroring
 * `serveCommand`'s own reduced call site around `auth-boot-gate.ts`), then wires the ALREADY-BUILT,
 * already-tested `auth/routes.ts#authRoutes` / `auth/onboarding-routes.ts#onboardingRoutes` /
 * `auth/session.ts#sessionResolver` singletons — mounted "exactly as a phase 1-3 single-process
 * deployment does today" (D10) — plus this pass's own `IdentityStore`/`OrgProcessRegistryStore`
 * into `./server.ts#createSupervisorApp`, and starts listening.
 *
 * Binds `bindHost ?? '127.0.0.1'` — loopback by default, on the same "nginx is the perimeter"
 * posture D4/D10 ask of every org process, not a non-loopback default that would make the
 * single highest-value target on the box (D10's own words) directly internet-reachable.
 */
export async function startSupervisor(options: StartSupervisorOptions): Promise<ServerType | undefined> {
  const gate = runSupervisorBootGate(process.env);
  if (!gate.proceed) return undefined;

  const identityStore = IdentityStore.open(identityDir());
  const orgProcessRegistry = OrgProcessRegistryStore.open(orgProcessRegistryDir());

  const app = createSupervisorApp({
    authRoutes,
    onboardingRoutes,
    sessionResolver,
    identityStore,
    orgProcessRegistry,
    // The operator-tooling credential for `/internal/*` (`./internal-auth.ts`). Read here rather
    // than inside the app so the app stays a pure function of its deps — and left `undefined`
    // when unset, which closes the admin surface rather than opening it.
    adminToken: process.env.CEZ_SUPERVISOR_ADMIN_TOKEN,
  });

  const server = serve({ fetch: app.fetch, port: options.port, hostname: options.bindHost ?? '127.0.0.1' });
  console.log(`\n  cezar supervisor — auth provider: ${gate.provider}, port ${options.port}\n`);
  return server;
}
