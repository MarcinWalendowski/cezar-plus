import { serve, type ServerType } from '@hono/node-server';
import type { AuthProvider } from '@loki-labs/better-cezar-contract';
import { identityDir } from '../paths.ts';
import { resolveAuthProvider } from '../server/capabilities.ts';
import { IdentityStore } from '../auth/identity-store.ts';
import {
  bootstrapClaim,
  bootstrapClaimBanner,
  type BootstrapClaim,
} from '../auth/bootstrap-claim.ts';
import { sessionResolver } from '../auth/session.ts';
import { authRoutes } from '../auth/routes.ts';
import { onboardingRoutes } from '../auth/onboarding-routes.ts';
import { inviteRoutes } from '../auth/invite-routes.ts';
import { teamRoutes } from '../auth/team-routes.ts';
import { createSupervisorApp, type SupervisorAppDeps } from './server.ts';
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

/** Everything `buildSupervisorApp` cannot supply itself: the two stores (which open a real
 *  `CEZ_HOME`) and the admin credential (which reads `process.env`). Every OTHER field of
 *  `SupervisorAppDeps` is a module-scope singleton this file imports, which is exactly the wiring
 *  the function below exists to make testable. */
export type SupervisorAppEnvironment = Pick<
  SupervisorAppDeps,
  'identityStore' | 'orgProcessRegistry' | 'adminToken'
>;

/**
 * The route wiring, split out of `startSupervisor` so it can be exercised without binding a port
 * — **ADDED 2026-08-07 (5b/5c/8 repair stage), because it was the one place nothing tested.**
 *
 * `SupervisorAppDeps` making `inviteRoutes`/`teamRoutes` REQUIRED enforces the field's *presence*,
 * never its *value*: replacing both arguments below with `new Hono()` left all 382 test files and
 * 6851 tests green, because the only suite that proves the supervisor serves those seven routes
 * (`./server.test.ts`) builds its own deps, and `./index.test.ts` covered the boot gate and nothing
 * else. That is the same "mounted on one topology and not the other" regression the integration
 * pass already had to fix once — arriving through the one call site with no test — and on the D10
 * topology it means every `/auth/invites*` and `/auth/teams*` request 404s, which is the only
 * topology where a second org (and therefore 5b/5c) exists at all.
 *
 * `supervisor/index.test.ts` now drives the app this returns and asserts each `/auth/*` family
 * answers its own 401, never a 404 — so blanking either singleton fails a test instead of shipping.
 */
export function buildSupervisorApp(environment: SupervisorAppEnvironment): ReturnType<typeof createSupervisorApp> {
  return createSupervisorApp({
    authRoutes,
    onboardingRoutes,
    inviteRoutes,
    teamRoutes,
    sessionResolver,
    ...environment,
  });
}

/**
 * Everything `cezar supervisor` prints at boot, as lines — **pure, and split out at the 5b/5c/8
 * repair stage because the deployment-wide bootstrap code was never printed by this process at
 * all.**
 *
 * `serveCommand` prints `bootstrapClaimBanner(...)` on its `CEZ_AUTH`-on path; `startSupervisor`
 * did not, and on a `--platform hetzner` install the supervisor is the ONLY process that mounts
 * `POST /auth/onboarding/org`. So the default `generated` mode minted a fresh 128-bit code at every
 * start, the onboarding wizard refused every claim with 403 without it, and the operator had no way
 * to read it — `docs/server-install/hetzner.md` even told them to run
 * `journalctl -u cezar-hetzner-<instance> | grep -i bootstrap`, which matched nothing. The
 * deployment's FIRST organization was therefore unclaimable on the one platform this whole
 * spec is written for, unless the operator happened to pin `CEZ_AUTH_BOOTSTRAP_TOKEN` at install.
 *
 * Same module instance the route checks (`../auth/bootstrap-claim.ts`'s `bootstrapClaim` const, via
 * the ESM module cache) — never a second `resolveBootstrapClaim` that would mint a second code and
 * print one while the route demands the other.
 *
 * Pure and exported so `index.test.ts` can assert the code IS among the lines, which is the exact
 * regression above; `startSupervisor` below keeps only the `console.log` loop, on the same
 * "a CLI-entry side effect is untestable by construction" reasoning `auth-boot-gate.ts` documents.
 */
export function supervisorBootLines(input: {
  readonly provider: AuthProvider;
  readonly port: number;
  readonly claim: BootstrapClaim;
  readonly hasOrg: boolean;
}): string[] {
  const lines = [`\n  cezar supervisor — auth provider: ${input.provider}, port ${input.port}\n`];
  const banner = bootstrapClaimBanner(input.claim, input.hasOrg);
  if (banner) lines.push(banner);
  return lines;
}

/**
 * The real, process-lifetime boot: `if (!gate.proceed) return undefined;` first (mirroring
 * `serveCommand`'s own reduced call site around `auth-boot-gate.ts`), then opens the two stores and
 * hands them to `buildSupervisorApp` above — which is where the ALREADY-BUILT,
 * already-tested `auth/routes.ts#authRoutes` / `auth/onboarding-routes.ts#onboardingRoutes` /
 * `auth/invite-routes.ts#inviteRoutes` / `auth/team-routes.ts#teamRoutes` /
 * `auth/session.ts#sessionResolver` singletons — mounted "exactly as a phase 1-3 single-process
 * deployment does today" (D10) — plus this pass's own `IdentityStore`/`OrgProcessRegistryStore`
 * into `./server.ts#createSupervisorApp`, and starts listening.
 *
 * **The last two arrived at the 5b/5c/8 integration pass**, and importing them here is what makes
 * 5b's invites and 5c's team management reachable on a hosted deployment at all: nginx's per-org
 * vhost proxies `location /auth/` to THIS process, never to the org's own
 * (`server-install/platforms/hetzner/nginx.ts`), so a route mounted only by `serveCommand` works on
 * a laptop and 404s on exactly the host phases 5b/5c/8 were written for. Both are plain synchronous
 * singletons like `onboardingRoutes`, and both open their `IdentityStore` against `identityDir()` —
 * which, under D10, is the supervisor's own `CEZ_HOME` and the only identity directory on the box.
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

  const app = buildSupervisorApp({
    identityStore,
    orgProcessRegistry,
    // The operator-tooling credential for `/internal/*` (`./internal-auth.ts`). Read here rather
    // than inside the app so the app stays a pure function of its deps — and left `undefined`
    // when unset, which closes the admin surface rather than opening it.
    adminToken: process.env.CEZ_SUPERVISOR_ADMIN_TOKEN,
  });

  const server = serve({ fetch: app.fetch, port: options.port, hostname: options.bindHost ?? '127.0.0.1' });
  // Best-effort, exactly as `serveCommand` does it: an identity store that cannot be read must not
  // stop the supervisor from booting, and an unreadable store reads as "no org" anyway
  // (`readSnapshot` degrades to empty), so this errs towards printing the code.
  let hasOrg = false;
  try {
    hasOrg = identityStore.listOrgs().length > 0;
  } catch {
    // unreadable identity home — treat as un-onboarded and print the code
  }
  for (const line of supervisorBootLines({
    provider: gate.provider,
    port: options.port,
    claim: bootstrapClaim,
    hasOrg,
  }))
    console.log(line);
  return server;
}
