import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANCEL,
  PreflightError,
  type InstallContext,
  type InstallStep,
  type PlatformStrategy,
  type ServerState,
  type StepArtifact,
} from '../types.ts';
import {
  depCheckStep,
  hasPasswordlessSudo,
  HOSTNAME_RE,
  owned,
  requireManualLogin,
  shared,
  shquote,
  StepAborted,
  StepCancelled,
  sudoStep,
  verifyCommand,
} from '../steps.ts';
import { listServerInstances } from '../state.ts';
import { isNpxExecStart, refreshNpxCacheForRedeploy, serviceExecStart } from './ubuntu-vps.ts';
import {
  agentCredentialLoginCommands,
  createCezHomeCommand,
  createOrgUserCommand,
  orgCezHome,
  orgHomeDir,
  orgProjectRoot,
  orgUnixUsername,
  orgUserProvisioningStep,
} from './hetzner/provision-user.ts';
import { orgSystemdUnit, supervisorSystemdUnit } from './hetzner/systemd-unit.ts';
import { orgVhost, supervisorVhost, wsUpgradeMapSnippet } from './hetzner/nginx.ts';
import { createTlsStep, publicUrlForDomain } from './hetzner/tls.ts';
import { serverConfigDir } from '../../paths.ts';

/**
 * The `hetzner` platform strategy (D4/D10, spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`,
 * phase 7). Unit 6 in D10's ownership map — the `InstallStep` orchestrator over the pure
 * generators units 2/3/4/7 already built (`./hetzner/{provision-user,systemd-unit,nginx,tls}.ts`).
 * Nothing in this file spawns a process, opens a socket, or writes to this machine directly:
 * every privileged effect goes through `sudoStep`, exactly like `ubuntu-vps.ts`.
 *
 * ## Two provisioning targets, one platform
 *
 * `cezar server-install --platform hetzner --domain <login-host>` (no `--org-slug`) provisions the
 * deployment's ONE **supervisor** — its own unix user, its own `CEZ_HOME`, the `cezar supervisor`
 * systemd unit (OIDC/Google, D9), and the nginx vhost that terminates `/auth/*` and `/internal/*`.
 *
 * `cezar server-install --platform hetzner --domain <org-hostname> --org-slug <slug>` provisions
 * ONE **org** — its own unix user, its own `CEZ_HOME`, a `cezar serve` systemd unit that trusts the
 * supervisor's forwarded, signed principal (`CEZ_AUTH=supervisor`, D10) rather than terminating
 * auth itself, and the nginx vhost that runs `auth_request` against the supervisor before proxying.
 *
 * `ctx.state.orgSlug` is what distinguishes the two (`isSupervisorMode` below) — absent means
 * supervisor, present means org. Each target is its own named `server-install` instance, keyed by
 * `--domain` exactly like `ubuntu-vps.ts`'s multi-instance feature (`instanceSlug`,
 * `~/.cezar/server-instances/<slug>.json`) — reusing that mechanism rather than inventing a second
 * one is what gives every generated path here a `cezar-hetzner-<instance>` name distinct from BOTH
 * `ubuntu-vps`'s own `cezar`/`cezar-<slug>` names (no cross-platform collision on one host) and
 * every other hetzner instance on the same host.
 *
 * ## "OIDC replaces auth_basic" and "TLS is not optional" (this task's own framing)
 *
 * There is no htpasswd/`auth_basic` anywhere in this file. The supervisor terminates real OIDC or
 * Google (D9); an org's vhost never checks a credential itself, it forwards nginx's own
 * `auth_request` verdict (`./hetzner/nginx.ts`'s own doc comment has the full routing model). TLS
 * is REQUIRED, not `optional: true` like `ubuntu-vps.ts`'s `sslStep` — see `./hetzner/tls.ts`'s
 * module doc comment for why a plain-HTTP hetzner deployment silently breaks every login (the
 * session cookie is `Secure` unconditionally).
 *
 * ## Idempotent, and safe on a failed re-run
 *
 * Every step's `check()` mirrors `ubuntu-vps.ts`'s own discipline: resumable via the engine's
 * `server.json` step ledger, and self-healing via a structural probe (`test -f`, `systemctl
 * is-enabled`) when the ledger is missing or stale, so re-running never re-prompts for or
 * re-generates a secret that already exists on disk (`orgSystemdStep`/`supervisorSystemdStep` only
 * write `CEZ_SUPERVISOR_SECRET` / the OIDC client secret once — see their own comments). A failed
 * run leaves exactly the steps that succeeded `done` and the rest `pending`/`failed`; nothing here
 * deletes a working host's config on a LATER step's failure, and `server-uninstall` (via each
 * step's `undo`) reverses only what a `done` step actually created.
 *
 * ## Registering the org with its supervisor — automated (CORRECTED 2026-08-07, repair stage)
 *
 * This section used to say the hand-off "does not exist yet", naming a route
 * (`POST /internal/orgs/register`) that was never built, while the route that WAS built
 * (`POST /internal/org-processes`, `supervisor/server.ts`) shipped in the same pass. So the
 * installer printed a manual note — one that omitted `orgId`, which the schema requires and no
 * printed field supplied, and which echoed the org's `CEZ_SUPERVISOR_SECRET` into the operator's
 * terminal, scrollback and any CI transcript (the exact disclosure D10's Risks entry forbids by
 * name). Both are closed: `orgRegistrationStep` below resolves the slug to an `orgId` against
 * `GET /internal/orgs/:slug` and POSTs the registration itself, in ONE root shell command that
 * reads both secrets out of their `0600` files and never puts either in argv or on screen.
 *
 * The credential that makes that possible is `CEZ_SUPERVISOR_ADMIN_TOKEN`, minted into the
 * supervisor's own `EnvironmentFile=` at supervisor-provisioning time. It exists because the
 * bootstrap is genuinely circular — the first registration for an org is the call that CREATES
 * that org's secret, so it cannot authenticate with one — and an operator with sudo on the box can
 * read a root-owned file while a remote attacker cannot.
 *
 * ## Creating the org itself — ADDED 2026-08-07 (5b/5c/8 scaffold pass, D11, unit 8)
 *
 * Everything above assumes the `Org` row already exists. Until this step, nothing made that true
 * for a second-and-later org: `bootstrapFirstOrg`'s `orgs.length > 0` guard made
 * `POST /auth/onboarding/org` unreachable the moment any org existed, and the supervisor's
 * `/internal/orgs*` routes were `GET`-only — so `orgRegistrationStep` above always 404'd resolving
 * `orgId`, silently, the exact failure mode this task was told to close. `orgCreateStep` (`org-create`
 * in `steps()`, positioned before every other org-specific step) creates it via the new admin-only
 * `POST /internal/orgs` (D11's first half — "the org row... created by the installer") and prints
 * the one-time bootstrap claim code the org's intended owner needs to claim it (D11's second half,
 * unchanged: "the first user to sign in at that org's hostname with that org's bootstrap code").
 *
 * ## Worker role — ADDED for Phase 4 (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`)
 *
 * A THIRD `hetzner` target, `--role worker`: a cluster spoke, not a cockpit for an org. Reuses
 * this platform's own building blocks (`orgUserProvisioningStep`'s dedicated-unix-user shape,
 * `sudoStep`, the same idempotent check()/run() discipline) rather than a parallel script — the
 * exact thing Problem §2b names as the failure this row exists to avoid: `cez
 * server-migrate-releases` had to exist because the live `hel1` unit was hand-written and no
 * generator authored it. A second bespoke worker-provisioning path would guarantee a third.
 *
 * A worker needs neither `--domain` nor nginx/TLS: spokes dial OUT to the hub (TLDR: "spokes dial
 * out to it"), so nothing inbound ever reaches this box, and `preflight` below skips both the
 * hostname requirement and the "must not be root" check the supervisor/org paths enforce — D17's
 * minted one-liner runs `npx … server-install --platform hetzner --role worker --join cezj_…` AS
 * ROOT on a bare VPS.
 *
 * Step order mirrors the plan's own description exactly: dependencies, a dedicated unix user +
 * `CEZ_HOME` + project root (reusing `orgUserProvisioningStep` under the reserved pseudo-slug
 * `worker`, below), repo checkouts, the D14/D14a admission caps written into `config.json`, the
 * systemd unit (`CEZ_CLUSTER=1`, `CEZ_ENV_PASSTHROUGH`), the agent CLI **logins** — the one
 * genuinely interactive step, so it STOPS the run (`requireManualLogin`, `steps.ts`) rather than
 * finishing and reporting a worker that cannot run anything — and last, `cez cluster join` with
 * the hub's token, so the very first presence report already carries accurate "which agent CLIs
 * are logged in" labels instead of a stale "none" from before the logins landed.
 *
 * **A real gap this row could not close on its own, stated rather than hidden.** `--role` and
 * `--join` are not, as of this change, parseable `server-install` flags: `index.ts`'s
 * `serverCommand`, `engine.ts#RunOptions` and `types.ts#serverStateSchema` would each need one
 * small additive field/line to carry them from argv into `ctx.state`, and none of those three
 * files are this change's to edit (index.ts is a different package's; the other two sit outside
 * this row's owns-list). Every worker-mode branch below therefore reads `ctx.state.role` /
 * `ctx.state.clusterJoinToken` / `ctx.state.workerRepoUrls` / `ctx.state.workerEnvPassthrough`
 * through `workerState()`, a local cast — safe because `serverStateSchema` is `.passthrough()`, so
 * these keys already survive a real load+save round-trip today (`state.ts#saveServerState` writes
 * `ctx.state` verbatim; `loadServerState`'s `.passthrough()` parse keeps them on the way back in).
 * The step list, preflight and redeploy logic are therefore fully built and fully testable now —
 * every test below drives them by constructing `ctx.state` directly, the same way every other test
 * in this file already does — but `--role worker` is not reachable from the actual command line
 * until that small amount of upstream plumbing lands.
 */

// ---- shared naming / mode ---------------------------------------------------------------------

/** Reserved — collides with the supervisor's own derived unix user (`orgUnixUsername('supervisor')`
 *  below). A real org may never claim this slug. */
const SUPERVISOR_PSEUDO_SLUG = 'supervisor';

/**
 * The org slug as everything downstream sees it. **ADDED 2026-08-07 (repair stage): the reserved-
 * slug guard was defeated by one leading space.** `preflight` compared `ctx.state.orgSlug` to
 * `SUPERVISOR_PSEUDO_SLUG` with strict equality on the RAW value while
 * `provision-user.ts#orgUnixUsername` trims before validating, so `--org-slug " supervisor"`
 * passed the guard and then derived `cez-supervisor` — provisioning an org COCKPIT (`cezar serve`,
 * i.e. `POST /api/v1/workflows` → `spawn('bash', …)`) as the supervisor's own uid, with `CEZ_HOME`
 * pointed at the home holding every org's identity, sessions and secrets. Normalising once, here,
 * and reading only the normalised value is what makes the guard and the derivation agree by
 * construction rather than by two authors trimming the same way.
 */
function orgSlugOf(ctx: InstallContext): string | undefined {
  const slug = (ctx.state.orgSlug ?? '').trim();
  return slug ? slug : undefined;
}

function isSupervisorMode(ctx: InstallContext): boolean {
  return orgSlugOf(ctx) === undefined && !isWorkerMode(ctx);
}

/** Reserved — collides with the worker's own derived unix user (`orgUnixUsername('worker')`
 *  below), the same reason `SUPERVISOR_PSEUDO_SLUG` is reserved. A real org may never claim it. */
const WORKER_PSEUDO_SLUG = 'worker';

/**
 * Extra `ServerState` fields the worker role reads and writes — not (yet) part of
 * `types.ts#serverStateSchema`. See this file's own module docblock, "Worker role" section, for
 * why: threading `--role`/`--join` through `index.ts`, `engine.ts#RunOptions` and the schema is
 * outside this change's owns-list. `serverStateSchema`'s `.passthrough()` is what makes reading
 * and writing these through a cast safe — they round-trip through a real `save()`/`load()` today.
 */
interface WorkerExtraState {
  /** `--role worker`. Absent (the default) leaves supervisor/org mode exactly as before. */
  role?: 'worker';
  /** `--join <code>` — the hub-minted, single-use enrollment code (D17). Consumed once by
   *  `worker-enroll` below; not itself a durable credential, so passing it as a CLI argument to
   *  `cezar cluster join` mirrors D17's own rendered command shape rather than inventing a second
   *  input channel for it. */
  clusterJoinToken?: string;
  /** Recorded by `worker-checkouts` on its first prompt, so a resumed run doesn't ask twice. */
  workerRepoUrls?: string[];
  /** Recorded by `worker-systemd` on its first prompt. Comma-separated env var NAMES (never
   *  values) forwarded into agent runs — see the systemd unit generator below. */
  workerEnvPassthrough?: string;
  /** Recorded by `worker-login` once the operator confirms the agent CLI logins are done, so a
   *  re-run's `check()` can skip re-asking (see `requireManualLogin`, `steps.ts`). */
  workerLoginsConfirmed?: boolean;
}

/** The one place `ctx.state` is cast to read/write the worker-only fields above. */
function workerState(ctx: InstallContext): ServerState & WorkerExtraState {
  return ctx.state as ServerState & WorkerExtraState;
}

function isWorkerMode(ctx: InstallContext): boolean {
  return workerState(ctx).role === 'worker';
}

/** Trimmed, or `undefined` for a blank/absent token — mirrors `orgSlugOf`'s own normalisation. */
function joinTokenOf(ctx: InstallContext): string | undefined {
  const token = (workerState(ctx).clusterJoinToken ?? '').trim();
  return token ? token : undefined;
}

/** The unix user this instance's process runs as — the supervisor's own pseudo-slug, the
 *  worker's own pseudo-slug, or the real org's, through the SAME derivation `provision-user.ts`
 *  (unit 2) already built and tested, so there is exactly one place `cez-<slug>` is computed
 *  (that file's own docblock: "import, do not recompute"). */
function resolveUnixUser(ctx: InstallContext): string {
  if (isWorkerMode(ctx)) return orgUnixUsername(WORKER_PSEUDO_SLUG);
  return orgUnixUsername(orgSlugOf(ctx) ?? SUPERVISOR_PSEUDO_SLUG);
}

/** Prefixed `cezar-hetzner-` (never bare `cezar`/`cezar-<slug>`) so this platform's units/vhosts
 *  never collide with `ubuntu-vps.ts`'s own naming on a host that (however unlikely) runs both. */
function unitName(ctx: InstallContext): string {
  return `cezar-hetzner-${ctx.instance}.service`;
}
function vhostAvailable(ctx: InstallContext): string {
  return `/etc/nginx/sites-available/cezar-hetzner-${ctx.instance}`;
}
function vhostEnabled(ctx: InstallContext): string {
  return `/etc/nginx/sites-enabled/cezar-hetzner-${ctx.instance}`;
}
function environmentFilePath(ctx: InstallContext): string {
  return `${serverConfigDir()}/hetzner-${ctx.instance}.env`;
}

/** `wsUpgradeMapSnippet()` is `http{}`-context and must be written ONCE per host, not once per
 *  vhost (`./hetzner/nginx.ts`'s own doc comment — a second declaration is an nginx config error).
 *  Fixed path, same content every time, so re-writing it for a second instance is a harmless
 *  no-op overwrite rather than a duplicate declaration. */
const SHARED_UPGRADE_MAP_PATH = '/etc/nginx/conf.d/cezar-hetzner-upgrade.conf';

function requireDomain(ctx: InstallContext): string {
  const domain = (ctx.state.domain ?? '').trim();
  if (!domain) throw new StepAborted('no --domain recorded for this hetzner instance');
  return domain;
}

/** The deployment's one supervisor instance, found by scanning every `server-install` record on
 *  this host (`ubuntu-vps.ts` never needs this — its instances are peers; hetzner's org instances
 *  each depend on the ONE supervisor instance already existing, D10's "provision the supervisor
 *  first" ordering). `undefined` when none is provisioned yet. */
function findSupervisorInstance(): { instance: string; state: ServerState } | undefined {
  return listServerInstances().find((i) => i.state.platform === 'hetzner' && !i.state.orgSlug);
}

/** The dry-run placeholder, exported so a test can assert the LOOKUP branch against a value that
 *  is not this one — two tests that both seed the supervisor at the fallback's own number cannot
 *  tell "looked it up" from "returned the constant", which is exactly what mutation testing found
 *  (replacing this function's whole body with `return 4321` kept 242 tests green). */
export const SUPERVISOR_PORT_DRY_RUN_FALLBACK = 4321;

/** The supervisor's own hard-bound loopback port — every org vhost's `auth_request`/`/auth/`/
 *  `/internal/` proxying targets this. Real org runs are guaranteed a supervisor record by
 *  `preflight` below; the fallback here only serves a `CEZ_DRY_RUN` preview with no supervisor
 *  provisioned yet, so a placeholder port keeps the preview walkable rather than throwing. */
function resolveSupervisorPort(ctx: InstallContext): number {
  if (isSupervisorMode(ctx)) return ctx.state.primaryPort;
  return findSupervisorInstance()?.state.primaryPort ?? SUPERVISOR_PORT_DRY_RUN_FALLBACK;
}

/** `/etc/cezar/hetzner-<supervisor instance>.env` — the root-owned `0600` file carrying the
 *  supervisor's OIDC client secret and `CEZ_SUPERVISOR_ADMIN_TOKEN`. Derived from the recorded
 *  supervisor instance, never from the org's own `ctx.instance`. */
function supervisorEnvironmentFilePath(): string | undefined {
  const supervisor = findSupervisorInstance();
  return supervisor ? `${serverConfigDir()}/hetzner-${supervisor.instance}.env` : undefined;
}

/** The admin credential `supervisor/internal-auth.ts` checks. 32 bytes of entropy, hex — the same
 *  shape and length as an org's `CEZ_SUPERVISOR_SECRET`, since both are bearer tokens compared
 *  in constant time and neither is ever typed by a human. */
function mintSecret(): string {
  return randomBytes(32).toString('hex');
}

// ---- privileged-file-write helpers (duplicated from ubuntu-vps.ts, which exports neither — the
// same allowance D10's ownership map gives units 3/7 for this exact idiom) -----------------------

/** Base64 so a copy-paste of the command survives newlines/quoting untouched — see
 *  `ubuntu-vps.ts#writeRootFileCmd` / `./hetzner/tls.ts#writeRootFileCommand`, neither exported. */
function writeRootFileCmd(path: string, content: string, extra = ''): string {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const dir = path.slice(0, path.lastIndexOf('/')) || '/';
  return `install -d -m 0755 ${shquote(dir)} && printf %s ${shquote(b64)} | base64 --decode > ${shquote(path)}${extra ? ` && ${extra}` : ''}`;
}

/**
 * A root-owned, `0600` secret file fed on STDIN (the htpasswd idiom in `ubuntu-vps.ts`) — never
 * base64'd into argv, never echoed into a sudo-note transcript (D10: "never `printf %s <content>`
 * into the operator's terminal").
 *
 * **CORRECTED 2026-08-07 (repair stage): the mode is set BEFORE the content lands.** This was
 * `cat > <path> && chmod 0600 <path>`, so `cat` created the file under root's umask (`0644` on
 * Debian) and the `chmod` was a separate, later syscall — a window in which any local uid,
 * including a sibling org's (the exact threat D10 cites), could `open(2)` it and read
 * `CEZ_SUPERVISOR_SECRET` or the OIDC client secret through the retained fd afterwards. The shape
 * was inherited from `ubuntu-vps.ts`'s htpasswd write, where the payload is an apr1 hash on a
 * single-tenant box; here it is the cross-tenant signing key. `install -m 0600 /dev/null <path>`
 * creates it empty at the right mode first, and the redirect only ever truncates an
 * already-locked file. The `chmod` is kept as a belt-and-braces no-op for a pre-existing file
 * whose mode was widened by hand.
 */
function writeRootSecretFileCmd(path: string): string {
  const dir = path.slice(0, path.lastIndexOf('/')) || '/';
  const quoted = shquote(path);
  return (
    `install -d -m 0755 ${shquote(dir)} && install -m 0600 /dev/null ${quoted} && ` +
    `chmod 0600 ${quoted} && cat > ${quoted}`
  );
}

// ---- ExecStart resolution (local re-implementation — `ubuntu-vps.ts#resolveExecStart` is a
// private, unexported closure; `serviceExecStart`, the pure part, IS exported and reused here) ---

async function resolveHetznerExecStart(ctx: InstallContext): Promise<string> {
  const node = process.execPath;
  const pkgRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const entry = join(pkgRoot, 'dist', 'index.js');
  let npxPath = join(dirname(node), 'npx');
  if (ctx.dryRun) return serviceExecStart({ node, pkgRoot, entry, entryExists: true, npxPath });
  if (!existsSync(npxPath)) {
    const found = (await ctx.runner.capture('bash', ['-lc', 'command -v npx'])).stdout.trim().split('\n').pop()?.trim();
    if (found) npxPath = found;
  }
  let globalBin: string | undefined;
  if (!existsSync(entry) && !/[/\\]_npx[/\\]/.test(pkgRoot)) {
    const out = (await ctx.runner.capture('bash', ['-lc', 'command -v cezar-cli || command -v cezar'])).stdout.trim();
    globalBin = out.split('\n').map((s) => s.trim()).filter(Boolean).pop();
    if (!globalBin) {
      ctx.ui.warn(
        `Could not locate a built cezar-plus to run (${entry} missing, no global cezar-cli) — ` +
          `install it (npm i -g cezar-cli) or build the checkout, then re-run with --reconfigure.`,
      );
    }
  }
  return serviceExecStart({ node, pkgRoot, entry, entryExists: existsSync(entry), npxPath, globalBin });
}

async function confirmListening(ctx: InstallContext, port: number): Promise<void> {
  if (ctx.dryRun) return;
  const sp = ctx.ui.spinner();
  sp.start(`Waiting for cezar to start on 127.0.0.1:${port}…`);
  let up = false;
  for (let i = 0; i < 15 && !up; i++) {
    const code = (await ctx.runner.capture('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${port}/`])).stdout.trim();
    up = code !== '' && code !== '000';
    if (!up && i < 14) await ctx.runner.capture('sh', ['-c', 'sleep 1']);
  }
  sp.stop(up ? 'cezar is running.' : 'cezar did not come up.');
  if (!up) {
    ctx.ui.warn(
      `cezar is not answering on 127.0.0.1:${port} yet — nginx will 502/504 until it is.\n` +
        `Check the service:\n  • sudo systemctl status ${unitName(ctx)}\n  • sudo journalctl -u ${unitName(ctx)} -n 50 --no-pager`,
    );
  }
}

// ---- supervisor: unix user --------------------------------------------------------------------

/**
 * The supervisor's own dedicated unix user + `CEZ_HOME` — same isolation posture D4 asks of an
 * org (`./hetzner/provision-user.ts`'s module doc comment), applied to the process that holds
 * every org's identity and secrets. Reuses that unit's exported primitives directly rather than
 * its composed `orgUserProvisioningStep`, which also trusts `ctx.repoRoot` for git worktree writes
 * and prints agent-CLI login instructions — neither applies to the supervisor, which never runs
 * `cezar serve`, never touches a project's git worktrees, and never spawns an agent.
 */
function supervisorUserProvisioningStep(): InstallStep {
  const username = orgUnixUsername(SUPERVISOR_PSEUDO_SLUG);
  const home = orgHomeDir(username);
  const cezHome = orgCezHome(username);
  return {
    id: 'supervisor-user',
    title: 'Dedicated unix user + CEZ_HOME for the supervisor (D10)',
    async check(ctx) {
      if (ctx.dryRun) return false;
      return (await verifyCommand(ctx, 'id', ['-u', username])) && (await verifyCommand(ctx, 'test', ['-d', cezHome]));
    },
    async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
      await sudoStep(ctx, {
        description:
          `Create the dedicated unix user "${username}" for the cezar supervisor — the single process ` +
          `that ever opens <CEZ_HOME>/identity/*.json (D10), so it gets its own uid rather than sharing ` +
          `the operator's or any org's.`,
        command: createOrgUserCommand(username, SUPERVISOR_PSEUDO_SLUG),
        verify: (c) => verifyCommand(c, 'id', ['-u', username]),
      });
      await sudoStep(ctx, {
        description: `Create the supervisor's CEZ_HOME (${cezHome}).`,
        command: createCezHomeCommand(username),
        verify: (c) => verifyCommand(c, 'test', ['-d', cezHome]),
      });
      return {
        artifacts: [
          shared('unix-user', {
            name: username,
            path: home,
            removeHint: `sudo userdel -r ${username}   # deletes every org's identity, session and infrastructure records`,
          }),
        ],
      };
    },
    async undo(ctx, created) {
      const user = (created?.artifacts ?? []).find((a) => a.type === 'unix-user');
      if (!user) return;
      ctx.ui.note(
        `The supervisor's unix user and its home were left in place — deleting it destroys every org's ` +
          `identity/session state.\nRemove it yourself if you're sure:\n${user.removeHint ?? ''}`,
        'supervisor user',
      );
    },
  };
}

// ---- supervisor: systemd unit + OIDC/Google credentials -----------------------------------------

const AUTH_PROVIDER_OPTIONS = [
  { value: 'oidc' as const, label: 'Generic OIDC (Keycloak, Authentik, …)' },
  { value: 'google' as const, label: 'Google (pinned issuer)' },
];

/**
 * Collects the supervisor's OIDC/Google credentials (once — see below) and writes the `cezar
 * supervisor` systemd unit. Bundled into one step, not two, because the unit's own text depends on
 * `authProvider` (`supervisorSystemdUnit`'s `Environment=CEZ_AUTH=`): splitting credential capture
 * from unit generation would need `authProvider` to survive a process restart between them, and
 * `InstallContext.prefs` is memory-only (`ubuntu-vps.ts`'s own `prefs.cockpit` doc comment: "Absent
 * on a resume…"). `ctx.state.hetznerAuthProvider` is what actually survives the restart, so a later
 * `--reconfigure` run that finds the env file already written skips the prompts and reads it back.
 */
function supervisorSystemdStep(): InstallStep {
  const username = orgUnixUsername(SUPERVISOR_PSEUDO_SLUG);
  const cezHome = orgCezHome(username);
  return {
    id: 'supervisor-systemd',
    title: 'cezar supervisor systemd unit (OIDC/Google credentials, D9/D10)',
    async check(ctx) {
      if (ctx.dryRun) return false;
      const envOk = await verifyCommand(ctx, 'test', ['-f', environmentFilePath(ctx)]);
      const unitOk = await verifyCommand(ctx, 'systemctl', ['is-enabled', unitName(ctx)]);
      return envOk && unitOk;
    },
    async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
      const envFile = environmentFilePath(ctx);
      const domain = requireDomain(ctx);
      const envAlreadyWritten = !ctx.dryRun && (await verifyCommand(ctx, 'test', ['-f', envFile]));
      let authProvider: 'oidc' | 'google' = ctx.state.hetznerAuthProvider ?? 'oidc';

      if (!envAlreadyWritten) {
        const providerAnswer = await ctx.ui.select<'oidc' | 'google'>({
          message: 'Auth provider the supervisor terminates (D9)',
          options: AUTH_PROVIDER_OPTIONS,
          initialValue: 'oidc',
        });
        if (providerAnswer === CANCEL) throw new StepCancelled();
        authProvider = providerAnswer;

        const lines: string[] = [];
        if (authProvider === 'oidc') {
          const issuer = await ctx.ui.text({
            message: 'OIDC issuer (…/.well-known/openid-configuration is discovered from it)',
            placeholder: 'https://idp.example.com/realms/main',
            validate: (v) => (v.trim() ? undefined : 'issuer is required'),
          });
          if (issuer === CANCEL) throw new StepCancelled();
          lines.push(`CEZ_OIDC_ISSUER=${String(issuer).trim()}`);
        }
        const clientId = await ctx.ui.text({
          message: 'OAuth client ID',
          validate: (v) => (v.trim() ? undefined : 'client id is required'),
        });
        if (clientId === CANCEL) throw new StepCancelled();
        const clientSecret = await ctx.ui.password({
          message: 'OAuth client secret',
          validate: (v) => (v.trim() ? undefined : 'client secret is required'),
        });
        if (clientSecret === CANCEL) throw new StepCancelled();
        lines.push(`CEZ_OIDC_CLIENT_ID=${String(clientId).trim()}`, `CEZ_OIDC_CLIENT_SECRET=${String(clientSecret).trim()}`);

        const bootstrapAnswer = await ctx.ui.text({
          message: 'Pin a bootstrap claim code? (blank = cezar-plus mints + prints a random one at every start, D8 amendment 2)',
          placeholder: '',
        });
        const bootstrapToken = bootstrapAnswer === CANCEL ? '' : String(bootstrapAnswer).trim();
        if (bootstrapToken) lines.push(`CEZ_AUTH_BOOTSTRAP_TOKEN=${bootstrapToken}`);

        // The operator-tooling credential for the supervisor's `/internal/*` surface
        // (`supervisor/internal-auth.ts`). Minted here, written into the same root-owned 0600
        // file, and never shown: `orgRegistrationStep` reads it back out of that file inside a
        // root shell when it registers an org. Absent ⇒ the supervisor's admin surface is closed
        // entirely, which is why it is written unconditionally rather than prompted for.
        lines.push(`CEZ_SUPERVISOR_ADMIN_TOKEN=${mintSecret()}`);

        if (!ctx.dryRun) {
          await sudoStep(ctx, {
            description:
              `Write ${envFile} — the supervisor's OIDC/Google client secret (and optional pinned ` +
              `bootstrap code). Root-owned, 0600, referenced by the unit's EnvironmentFile= (never ` +
              `Environment=, which \`systemctl show\` leaks to any local user — D10).`,
            command: writeRootSecretFileCmd(envFile),
            input: `${lines.join('\n')}\n`,
            inputLabel: 'supervisor OIDC/Google secrets',
            verify: (c) => verifyCommand(c, 'test', ['-f', envFile]),
          });
        } else {
          ctx.ui.info(`DRY RUN — would write ${envFile} with the supervisor's OIDC/Google secrets (root:root, 0600).`);
        }
        ctx.state.hetznerAuthProvider = authProvider;
      }

      const execStart = await resolveHetznerExecStart(ctx);
      const unit = supervisorSystemdUnit({
        // The supervisor's OWN home, not `ctx.repoRoot` (the operator's checkout) — see
        // `systemd-unit.ts#SupervisorSystemdUnitOptions.workingDirectory`.
        workingDirectory: orgHomeDir(username),
        execStart,
        port: ctx.state.primaryPort,
        unixUser: username,
        cezHome,
        publicUrl: publicUrlForDomain(domain),
        authProvider,
        sessionCookieDomain: `.${domain}`,
        environmentFile: envFile,
      });
      const unitPath = `/etc/systemd/system/${unitName(ctx)}`;
      await sudoStep(ctx, {
        description: 'Install the supervisor systemd unit, start it now, and enable it at boot.',
        command: writeRootFileCmd(unitPath, unit, `systemctl daemon-reload && systemctl enable --now ${unitName(ctx)}`),
        verify: (c) => verifyCommand(c, 'systemctl', ['is-enabled', unitName(ctx)]),
      });
      await confirmListening(ctx, ctx.state.primaryPort);

      return {
        artifacts: [
          owned('service', { name: unitName(ctx), scope: 'system', path: unitPath }),
          owned('config', { path: envFile }),
        ],
      };
    },
    async undo(ctx, created) {
      const svc = (created?.artifacts ?? []).find((a) => a.type === 'service');
      if (svc) {
        await sudoStep(ctx, {
          description: 'Disable and remove the supervisor systemd unit.',
          command: `systemctl disable --now ${unitName(ctx)}; rm -f /etc/systemd/system/${unitName(ctx)} && systemctl daemon-reload`,
          verify: (c) => verifyCommand(c, 'sh', ['-c', `! systemctl is-enabled ${unitName(ctx)}`]),
        });
      }
      const env = (created?.artifacts ?? []).find((a) => a.type === 'config');
      if (env?.path) {
        ctx.ui.note(
          `${env.path} (OIDC/Google client secret) was left in place — remove it yourself if you're sure:\n  sudo rm -f ${env.path}`,
          'supervisor secrets',
        );
      }
    },
  };
}

// ---- org: systemd unit + supervisor-trust secret -------------------------------------------------

/**
 * Writes this org's `CEZ_SUPERVISOR_SECRET` (once — see the module doc comment on why this pass
 * cannot also hand it to the supervisor's own registry automatically) and its `cezar serve`
 * systemd unit. Bundled for the identical reason `supervisorSystemdStep` is: the unit text depends
 * on the `EnvironmentFile=` path existing, not its content, so ordering is flexible, but the SECRET
 * must be generated at most once, and `check()` below is what makes a resumed/redeployed run see
 * that and skip regenerating it.
 */
function orgSystemdStep(orgSlug: string): InstallStep {
  const username = orgUnixUsername(orgSlug);
  const cezHome = orgCezHome(username);
  return {
    id: 'org-systemd',
    title: `cezar serve systemd unit for org "${orgSlug}" (CEZ_AUTH=supervisor, D10)`,
    async check(ctx) {
      if (ctx.dryRun) return false;
      const envOk = await verifyCommand(ctx, 'test', ['-f', environmentFilePath(ctx)]);
      const unitOk = await verifyCommand(ctx, 'systemctl', ['is-enabled', unitName(ctx)]);
      return envOk && unitOk;
    },
    async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
      const envFile = environmentFilePath(ctx);
      requireDomain(ctx); // fail fast on a half-recorded instance, before anything privileged runs
      const envAlreadyWritten = !ctx.dryRun && (await verifyCommand(ctx, 'test', ['-f', envFile]));

      if (!envAlreadyWritten) {
        const secret = mintSecret(); // 64 hex chars, well over orgProcessRecordSchema's .min(32)
        // CEZ_SUPERVISOR_PORT rides in the SAME file as the secret rather than a plain unit
        // Environment= line: `supervisor/registry-client.ts` (Fill unit 5) requires BOTH
        // `CEZ_SUPERVISOR_PORT` and `CEZ_SUPERVISOR_SECRET` to be set for `CEZ_AUTH=supervisor` to
        // work at all, and `orgSystemdUnit` (systemd-unit.ts, Fill unit 3 — not this file's to
        // edit) only ever emits the secret's path via `EnvironmentFile=`, never the port itself.
        // Writing both here, in the ONE file this step already owns, closes that gap without
        // touching a file outside this unit's ownership — and the port isn't secret-shaped, so
        // co-locating it costs nothing.
        const port = resolveSupervisorPort(ctx);
        if (!ctx.dryRun) {
          await sudoStep(ctx, {
            description:
              `Write ${envFile} — CEZ_SUPERVISOR_PORT + CEZ_SUPERVISOR_SECRET, what this org's process ` +
              `needs to reach its supervisor and verify a forwarded principal against it ` +
              `(supervisor/registry-client.ts, supervisor/forwarded-principal.ts). Root-owned, 0600, ` +
              `EnvironmentFile= only (D10: never a plain Environment= line for the secret).`,
            command: writeRootSecretFileCmd(envFile),
            input: `CEZ_SUPERVISOR_PORT=${port}\nCEZ_SUPERVISOR_SECRET=${secret}\n`,
            inputLabel: 'CEZ_SUPERVISOR_PORT / CEZ_SUPERVISOR_SECRET',
            verify: (c) => verifyCommand(c, 'test', ['-f', envFile]),
          });
        } else {
          ctx.ui.info(`DRY RUN — would write ${envFile} with CEZ_SUPERVISOR_PORT=${port} and a freshly generated CEZ_SUPERVISOR_SECRET.`);
        }
        // NOT printed. This value authenticates every request to this org's process and signs
        // every forwarded principal for it; echoing it into the operator's terminal puts it in
        // scrollback, in `script`/tmux logs and in any CI transcript, which is the disclosure
        // D10's Risks entry forbids by name — and this step took care to feed it on stdin two
        // lines above precisely so it would never appear. The registration hand-off it used to
        // exist for is automated now (`orgRegistrationStep`), reading the secret back out of the
        // 0600 file inside a root shell instead of out of a human's clipboard.
        ctx.ui.info(
          `Generated CEZ_SUPERVISOR_SECRET for org "${orgSlug}" and wrote it to ${envFile} (root:root, 0600). ` +
            `It is deliberately not shown — the next step registers this org with the supervisor by reading ` +
            `it back from that file.`,
        );
      }

      const execStart = await resolveHetznerExecStart(ctx);
      const unit = orgSystemdUnit({
        // This org's OWN project root, never the operator's checkout: `cezar serve` opens its
        // (leaseless) `RunStore` at `<WorkingDirectory>/.ai/cezar`, so a shared value here is
        // D4's silent run-history loss. See `provision-user.ts#orgProjectRoot`.
        workingDirectory: orgProjectRoot(username),
        execStart,
        port: ctx.state.primaryPort,
        unixUser: username,
        cezHome,
        environmentFile: envFile,
      });
      const unitPath = `/etc/systemd/system/${unitName(ctx)}`;
      await sudoStep(ctx, {
        description: `Install the org "${orgSlug}" systemd unit, start it now, and enable it at boot.`,
        command: writeRootFileCmd(unitPath, unit, `systemctl daemon-reload && systemctl enable --now ${unitName(ctx)}`),
        verify: (c) => verifyCommand(c, 'systemctl', ['is-enabled', unitName(ctx)]),
      });
      await confirmListening(ctx, ctx.state.primaryPort);

      return {
        artifacts: [
          owned('service', { name: unitName(ctx), scope: 'system', path: unitPath }),
          owned('config', { path: envFile }),
        ],
      };
    },
    async undo(ctx, created) {
      const svc = (created?.artifacts ?? []).find((a) => a.type === 'service');
      if (svc) {
        await sudoStep(ctx, {
          description: `Disable and remove org "${orgSlug}"'s systemd unit.`,
          command: `systemctl disable --now ${unitName(ctx)}; rm -f /etc/systemd/system/${unitName(ctx)} && systemctl daemon-reload`,
          verify: (c) => verifyCommand(c, 'sh', ['-c', `! systemctl is-enabled ${unitName(ctx)}`]),
        });
      }
      const env = (created?.artifacts ?? []).find((a) => a.type === 'config');
      if (env?.path) {
        ctx.ui.note(
          `${env.path} (CEZ_SUPERVISOR_SECRET) was left in place — remove it yourself, and deprovision ` +
            `"${orgSlug}" from the supervisor's own registry, if you're sure:\n  sudo rm -f ${env.path}`,
          'org secrets',
        );
      }
    },
  };
}

// ---- org: create the Org row with the supervisor (D11) -------------------------------------------

/**
 * A starting point for the "Display name" prompt below, editable by the operator before it's sent.
 * Same "capitalize a label" idiom `auth/onboarding-routes.ts#orgNameFromEmailDomain` already uses
 * for the self-serve flow's own name default — just off `--org-slug` instead of an email domain,
 * since the installer has no email to derive one from.
 */
function defaultOrgNameFromSlug(orgSlug: string): string {
  return orgSlug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export interface OrgCreateCommandOptions {
  /** `/etc/cezar/hetzner-<supervisor instance>.env` — carries `CEZ_SUPERVISOR_ADMIN_TOKEN`. */
  supervisorEnvFile: string;
  supervisorPort: number;
  orgSlug: string;
  orgName: string;
}

/**
 * The one root shell command that creates this org's `Org` row via `POST /internal/orgs` (D11:
 * "the org row — created by the installer through a new admin-only `POST /internal/orgs`,
 * authenticated by `CEZ_SUPERVISOR_ADMIN_TOKEN`") and prints the one-time bootstrap claim code the
 * response carries.
 *
 * **The admin token stays inside the shell** — read out of its `0600` file into a shell variable
 * and sent as a bearer header, the same `orgRegistrationCommand` discipline of never putting a
 * secret in argv or a sudo-note transcript. `name`/`slug` are NOT secrets (the slug is already
 * `--org-slug`, typed into argv by the operator to invoke this install in the first place), so they
 * travel as an ordinary base64'd JSON body — base64 rather than inline JSON so neither value has to
 * be shell- or JSON-escaped here (`writeRootFileCmd`'s own idiom, reused for the same reason: "a
 * copy-paste of the command survives newlines/quoting untouched").
 *
 * **The bootstrap token IS meant to be printed**, unlike `CEZ_SUPERVISOR_SECRET` — it has to leave
 * the machine to reach the org's actual owner (`createInternalOrgResponseSchema`'s own doc comment:
 * "the claim code has to leave the machine to reach the actual owner"). So, unlike
 * `orgRegistrationCommand`'s POST which discards its response to `/dev/null`, this one captures the
 * response and parses the token back out to echo it with a label, rather than leaving it inside a
 * raw JSON blob.
 */
export function orgCreateCommand(opts: OrgCreateCommandOptions): string {
  const bodyB64 = Buffer.from(JSON.stringify({ name: opts.orgName, slug: opts.orgSlug }), 'utf8').toString('base64');
  return [
    'set -eu',
    `ADMIN="$(sed -n 's/^CEZ_SUPERVISOR_ADMIN_TOKEN=//p' ${shquote(opts.supervisorEnvFile)} | head -n1)"`,
    `[ -n "$ADMIN" ] || { echo "no CEZ_SUPERVISOR_ADMIN_TOKEN in ${opts.supervisorEnvFile} — re-run the supervisor install with --reconfigure supervisor-systemd" >&2; exit 1; }`,
    `RESP="$(printf %s ${shquote(bodyB64)} | base64 --decode | curl -sS -f -X POST -H 'content-type: application/json' -H "Authorization: Bearer $ADMIN" --data-binary @- http://127.0.0.1:${opts.supervisorPort}/internal/orgs)"`,
    `TOKEN="$(printf '%s' "$RESP" | sed -n 's/.*"bootstrapToken":"\\([^"]*\\)".*/\\1/p')"`,
    `[ -n "$TOKEN" ] || { echo "org created but no bootstrapToken in the response — cannot hand off the claim code" >&2; exit 1; }`,
    'echo',
    `echo "org ${opts.orgSlug} created. One-time bootstrap claim code for its owner (hand this off out of band — it will not be shown again):"`,
    'echo "  $TOKEN"',
  ].join('\n');
}

/**
 * Creates the second-and-later org's `Org` row — D11's first half, and the gap D11's own text
 * names by number: "provisioning a second org's infrastructure is now fully automated, and there is
 * still no way to create the org it would serve." Positioned before EVERY other org-specific step
 * in `steps()`, `org-register` included: it needs the org to exist before there is anything to
 * register, and putting it first means a failure here (bad admin token, name rejected, supervisor
 * unreachable) leaves nothing to undo — no unix user, no `CEZ_HOME`, no systemd unit, no secret
 * file. `orgRegistrationCommand`'s own abort message used to send the operator to "the onboarding
 * wizard" to create a second org — the one thing D11 says a browser request must never be allowed
 * to do — so that message is corrected below, in the same change that makes this step exist.
 */
function orgCreateStep(orgSlug: string): InstallStep {
  /** Mirrors `orgRegistrationStep`'s own `isRegistered` idiom exactly: one probe against
   *  `GET /internal/orgs/:slug`, used as BOTH `check()` and the post-write `verify`, so "already
   *  created" and "did it take" cannot disagree. The org row is idempotent to create by
   *  construction this way: re-running an install against an org that already exists on the
   *  supervisor skips this step (via `check()`) rather than erroring or minting a second row. */
  const orgExists = async (ctx: InstallContext): Promise<boolean> => {
    if (ctx.dryRun) return false;
    const supervisorEnv = supervisorEnvironmentFilePath();
    if (!supervisorEnv) return false;
    if (!(await hasPasswordlessSudo(ctx))) return false;
    const probe =
      `set -eu\n` +
      `ADMIN="$(sed -n 's/^CEZ_SUPERVISOR_ADMIN_TOKEN=//p' ${shquote(supervisorEnv)} | head -n1)"\n` +
      `[ -n "$ADMIN" ] || exit 1\n` +
      `curl -sS -f -H "Authorization: Bearer $ADMIN" ` +
      `http://127.0.0.1:${resolveSupervisorPort(ctx)}/internal/orgs/${shquote(orgSlug)} >/dev/null`;
    return (await ctx.runner.capture('sudo', ['-n', 'bash', '-lc', probe])).code === 0;
  };

  return {
    id: 'org-create',
    title: `Create org "${orgSlug}" with the supervisor (D11 POST /internal/orgs)`,
    check: orgExists,
    async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
      if (ctx.dryRun) {
        ctx.ui.info(
          `DRY RUN — would create org "${orgSlug}" via POST /internal/orgs and print its one-time bootstrap claim code.`,
        );
        return { artifacts: [] };
      }
      // Checked BEFORE the prompt below: no point asking the operator for a name if there is
      // nowhere to send it, and this is the exact silent-401-later failure mode named in this
      // task — surface it here, loudly, rather than downstream.
      const supervisorEnv = supervisorEnvironmentFilePath();
      if (!supervisorEnv) {
        throw new StepAborted(
          'no supervisor instance is recorded on this host — cannot find its EnvironmentFile to read CEZ_SUPERVISOR_ADMIN_TOKEN. ' +
            'Run `cezar server-install --platform hetzner --domain <login-host>` first (D10: "the supervisor\'s OWN unit first").',
        );
      }
      const nameAnswer = await ctx.ui.text({
        message: `Display name for org "${orgSlug}" (shown in the onboarding wizard)`,
        initialValue: defaultOrgNameFromSlug(orgSlug),
        validate: (v) => (v.trim() ? undefined : 'org name is required'),
      });
      if (nameAnswer === CANCEL) throw new StepCancelled();
      const orgName = String(nameAnswer).trim();

      const command = orgCreateCommand({
        supervisorEnvFile: supervisorEnv,
        supervisorPort: resolveSupervisorPort(ctx),
        orgSlug,
        orgName,
      });
      await sudoStep(ctx, {
        description:
          `Create org "${orgSlug}" (D11 POST /internal/orgs). Prints its one-time bootstrap claim code — copy ` +
          `it now and hand it to the org's intended owner out of band; it is never shown again.`,
        command,
        verify: orgExists,
      });
      return { artifacts: [owned('config', { path: `supervisor:org:${orgSlug}` })] };
    },
    async undo(ctx) {
      // There is no delete route for an `Org` row (only `/internal/org-processes` can be
      // deprovisioned) — an org's identity, once claimed, may carry real members and history, so
      // this leaves it in place rather than inventing a destructive call nothing else exposes. Same
      // posture `supervisorUserProvisioningStep`'s own undo already takes for the unix user.
      ctx.ui.note(
        `Org "${orgSlug}" was left registered with the supervisor — there is no delete route for an Org row yet. ` +
          `Remove it by hand once one exists, if you're sure nobody has claimed it.`,
        'org identity',
      );
    },
  };
}

// ---- org: register the process with its supervisor ------------------------------------------------

export interface OrgRegistrationCommandOptions {
  /** `/etc/cezar/hetzner-<supervisor instance>.env` — carries `CEZ_SUPERVISOR_ADMIN_TOKEN`. */
  supervisorEnvFile: string;
  /** `/etc/cezar/hetzner-<this org's instance>.env` — carries `CEZ_SUPERVISOR_SECRET`. */
  orgEnvFile: string;
  supervisorPort: number;
  orgSlug: string;
  unixUser: string;
  cezHome: string;
  loopbackPort: number;
  hostname: string;
}

/**
 * The one root shell command that registers this org's process with its supervisor.
 *
 * **Everything sensitive stays inside the shell.** The admin token and the org's
 * `CEZ_SUPERVISOR_SECRET` are read out of their `0600` files into shell variables and interpolated
 * into a `curl` body on stdin — never into argv (visible in `/proc/<pid>/cmdline` to any local
 * uid), never into a sudo-note transcript, never onto the operator's screen. This is the same
 * reasoning `writeRootSecretFileCmd` already applies to writing them, applied to reading them
 * back.
 *
 * **`orgId` is resolved here, not guessed.** D10 specified that the installer resolve
 * `--org-slug` against the supervisor's `/internal/orgs/:slug` before provisioning; it never did,
 * so `--org-slug` accepted any string, and the manual note this replaces omitted `orgId`
 * altogether — the one field `registerOrgProcessInputSchema` requires and no printed value
 * supplied. A slug the supervisor does not know fails the `curl -f` here with a 404 and aborts
 * the step, which is the honest answer: there is nothing to register.
 *
 * `sed -n 's/^KEY=//p' | head -n1` rather than sourcing the file: an `EnvironmentFile` is
 * systemd's format, not the shell's, and `.`-ing it would execute whatever a value happens to
 * look like.
 */
export function orgRegistrationCommand(opts: OrgRegistrationCommandOptions): string {
  const readVar = (file: string, key: string): string =>
    `sed -n 's/^${key}=//p' ${shquote(file)} | head -n1`;
  // `%s` for every interpolated value, so a shell variable's content is never re-parsed.
  const body =
    `{"orgId":"%s","orgSlug":"%s","unixUser":"%s","cezHome":"%s",` +
    `"loopbackPort":${opts.loopbackPort},"hostname":"%s","platformId":"hetzner","supervisorSecret":"%s"}`;
  return [
    'set -eu',
    `ADMIN="$(${readVar(opts.supervisorEnvFile, 'CEZ_SUPERVISOR_ADMIN_TOKEN')})"`,
    `SECRET="$(${readVar(opts.orgEnvFile, 'CEZ_SUPERVISOR_SECRET')})"`,
    `[ -n "$ADMIN" ] || { echo "no CEZ_SUPERVISOR_ADMIN_TOKEN in ${opts.supervisorEnvFile} — re-run the supervisor install with --reconfigure supervisor-systemd" >&2; exit 1; }`,
    `[ -n "$SECRET" ] || { echo "no CEZ_SUPERVISOR_SECRET in ${opts.orgEnvFile}" >&2; exit 1; }`,
    `ORG_JSON="$(curl -sS -f -H "Authorization: Bearer $ADMIN" http://127.0.0.1:${opts.supervisorPort}/internal/orgs/${shquote(opts.orgSlug)})"`,
    `ORG_ID="$(printf '%s' "$ORG_JSON" | sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p')"`,
    // CORRECTED 2026-08-07 (5b/5c/8 scaffold pass, unit 8): this used to say "create it in the
    // onboarding wizard first" — wrong advice the moment `org-create` exists, and wrong on its own
    // terms even before then: D11 says a browser request must NEVER create an org. `org-create`
    // (above) runs earlier in this SAME `steps()` list, so this branch firing means IT failed or
    // was skipped (e.g. a targeted `--reconfigure org-register` without re-running `org-create`),
    // not that the org was never meant to exist.
    `[ -n "$ORG_ID" ] || { echo "the supervisor knows no org with slug ${opts.orgSlug} — the org-create step should have created it; re-run server-install (or --reconfigure org-create) first" >&2; exit 1; }`,
    `printf '%s' "$(printf '${body}' "$ORG_ID" ${shquote(opts.orgSlug)} ${shquote(opts.unixUser)} ${shquote(opts.cezHome)} ${shquote(opts.hostname)} "$SECRET")" ` +
      `| curl -sS -f -X POST -H 'content-type: application/json' -H "Authorization: Bearer $ADMIN" ` +
      `--data-binary @- http://127.0.0.1:${opts.supervisorPort}/internal/org-processes >/dev/null`,
  ].join('\n');
}

/**
 * Hands this org's `CEZ_SUPERVISOR_SECRET` to the supervisor's `OrgProcessRegistryStore`, which is
 * what makes `/internal/auth-check` able to route to it at all — until the record exists,
 * `resolveAuthCheck` answers `org-has-no-active-process` and nginx 401s every request to this org
 * host, forever (and `hetzner.ts#verifyStep`'s org-mode success criterion is *also* a 401, so
 * nothing downstream can tell the two apart — which is why this is its own step with its own
 * `check()` rather than a best-effort tail of `orgSystemdStep`).
 */
function orgRegistrationStep(orgSlug: string): InstallStep {
  const username = orgUnixUsername(orgSlug);
  const cezHome = orgCezHome(username);

  /** "Already registered" = the supervisor answers with a record for this org's hostname. One
   *  function, used as BOTH the step's `check()` and its post-write `verify` — so "is it already
   *  done" and "did it take effect" can never disagree, which is the failure `hetzner.ts`'s other
   *  steps were caught being unable to detect (a `check()` that wrongly reports done makes the
   *  engine skip the step and print "already present"). Root, because the token is `0600`. */
  const isRegistered = async (ctx: InstallContext): Promise<boolean> => {
    if (ctx.dryRun) return false;
    const supervisorEnv = supervisorEnvironmentFilePath();
    if (!supervisorEnv) return false;
    if (!(await hasPasswordlessSudo(ctx))) return false;
    const domain = requireDomain(ctx);
    const probe =
      `set -eu\n` +
      `ADMIN="$(sed -n 's/^CEZ_SUPERVISOR_ADMIN_TOKEN=//p' ${shquote(supervisorEnv)} | head -n1)"\n` +
      `[ -n "$ADMIN" ] || exit 1\n` +
      `curl -sS -f -H "Authorization: Bearer $ADMIN" ` +
      `"http://127.0.0.1:${resolveSupervisorPort(ctx)}/internal/org-processes?hostname=${encodeURIComponent(domain)}" ` +
      `| grep -q '"hostname"'`;
    return (await ctx.runner.capture('sudo', ['-n', 'bash', '-lc', probe])).code === 0;
  };

  return {
    id: 'org-register',
    title: `Register org "${orgSlug}" with the supervisor (D10 /internal/org-processes)`,
    check: isRegistered,
    async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
      const supervisorEnv = supervisorEnvironmentFilePath();
      if (!supervisorEnv) {
        throw new StepAborted(
          'no supervisor instance is recorded on this host — cannot find its EnvironmentFile to read CEZ_SUPERVISOR_ADMIN_TOKEN',
        );
      }
      const domain = requireDomain(ctx);
      const command = orgRegistrationCommand({
        supervisorEnvFile: supervisorEnv,
        orgEnvFile: environmentFilePath(ctx),
        supervisorPort: resolveSupervisorPort(ctx),
        orgSlug,
        unixUser: username,
        cezHome,
        loopbackPort: ctx.state.primaryPort,
        hostname: domain,
      });
      if (ctx.dryRun) {
        ctx.ui.info(
          `DRY RUN — would resolve org "${orgSlug}" against the supervisor's /internal/orgs/:slug and POST its ` +
            `process record (unixUser, cezHome, loopbackPort, hostname + the secret read from ${environmentFilePath(ctx)}) ` +
            `to /internal/org-processes.`,
        );
        return { artifacts: [] };
      }
      await sudoStep(ctx, {
        description:
          `Register org "${orgSlug}" with the supervisor. Reads CEZ_SUPERVISOR_ADMIN_TOKEN and this org's ` +
          `CEZ_SUPERVISOR_SECRET out of their root-owned 0600 files and POSTs the record — neither value is ` +
          `printed, and neither appears in argv.`,
        command,
        verify: isRegistered,
      });
      return { artifacts: [owned('config', { path: `supervisor:org-process:${orgSlug}` })] };
    },
    async undo(ctx) {
      const supervisorEnv = supervisorEnvironmentFilePath();
      if (!supervisorEnv) return;
      // Deprovision is a real, reversible registry write — unlike the unix user and its home,
      // nothing irreplaceable is destroyed, and LEAVING it makes the supervisor keep routing to a
      // unit that no longer exists. `|| true`: an already-absent record is the desired state.
      await sudoStep(ctx, {
        description: `Deprovision org "${orgSlug}" from the supervisor's org-process registry.`,
        command:
          `set -eu\n` +
          `ADMIN="$(sed -n 's/^CEZ_SUPERVISOR_ADMIN_TOKEN=//p' ${shquote(supervisorEnv)} | head -n1)"\n` +
          `[ -n "$ADMIN" ] || exit 0\n` +
          `ORG_JSON="$(curl -sS -f -H "Authorization: Bearer $ADMIN" http://127.0.0.1:${resolveSupervisorPort(ctx)}/internal/orgs/${shquote(orgSlug)} || true)"\n` +
          `ORG_ID="$(printf '%s' "$ORG_JSON" | sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p')"\n` +
          `[ -n "$ORG_ID" ] || exit 0\n` +
          `curl -sS -X DELETE -H "Authorization: Bearer $ADMIN" http://127.0.0.1:${resolveSupervisorPort(ctx)}/internal/org-processes/"$ORG_ID" >/dev/null || true`,
        verify: async () => true,
      });
    },
  };
}

// ---- worker: repo checkouts ---------------------------------------------------------------------

/** A filesystem-safe directory name from a git remote URL — `git@host:org/repo.git` and
 *  `https://host/org/repo.git` both become `repo`. Falls back to `repo` for anything that yields
 *  nothing usable, so a clone destination is never empty or `.`. */
function repoSlugFromUrl(url: string): string {
  const base =
    url
      .trim()
      .replace(/\.git$/i, '')
      .split(/[/:]/)
      .filter(Boolean)
      .pop() ?? 'repo';
  return base.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase() || 'repo';
}

/** Clone `url` into `dest` AS `username`, idempotently — a bare `git clone` into an existing
 *  `.git` would fail on a re-run, so this checks first (same "guard, don't fail" shape
 *  `trustProjectRootCommand` in `provision-user.ts` already uses for its own idempotency). Never
 *  writes as root: `sudo -u <user> -H` inside the already-root `sudoStep` body, the exact nesting
 *  `trustProjectRootCommand` establishes. */
function cloneRepoCommand(username: string, url: string, dest: string): string {
  return `test -d ${shquote(`${dest}/.git`)} || sudo -u ${username} -H git clone ${shquote(url)} ${shquote(dest)}`;
}

/**
 * Prompts once for the repos this worker should have checked out before it can be dispatched work
 * (Phase 4: "Adds repo checkouts"). Blank = skip — mirrors `provision-user.ts`'s own established
 * pattern for an org's `workspace`: created and trusted, real repositories "registered afterwards,
 * through the cockpit" rather than demanded up front. The list is recorded on `ctx.state` (see
 * `WorkerExtraState#workerRepoUrls`) so a resumed run does not prompt twice, and `check()` re-reads
 * that recorded list rather than re-deriving it from whatever happens to exist on disk.
 */
function workerCheckoutsStep(): InstallStep {
  return {
    id: 'worker-checkouts',
    title: 'Repo checkouts for dispatched work (Phase 4)',
    async check(ctx) {
      if (ctx.dryRun) return false;
      const urls = workerState(ctx).workerRepoUrls;
      if (!urls) return false; // never asked yet
      const username = resolveUnixUser(ctx);
      const root = orgProjectRoot(username);
      for (const url of urls) {
        if (!(await verifyCommand(ctx, 'test', ['-d', `${root}/${repoSlugFromUrl(url)}/.git`]))) return false;
      }
      return true;
    },
    async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
      const username = resolveUnixUser(ctx);
      const root = orgProjectRoot(username);
      let urls = workerState(ctx).workerRepoUrls;
      if (!urls) {
        const answer = await ctx.ui.text({
          message:
            'Repos this worker should check out now (comma-separated git remote URLs; blank = register them later through the cockpit)',
          placeholder: 'git@github.com:org/chat.git, git@github.com:org/cezar.git',
        });
        if (answer === CANCEL) throw new StepCancelled();
        urls = String(answer)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        workerState(ctx).workerRepoUrls = urls;
      }
      if (urls.length === 0) {
        ctx.ui.info('No repos given — register them later through the cockpit.');
        return { artifacts: [] };
      }
      const artifacts: StepArtifact[] = [];
      for (const url of urls) {
        const slug = repoSlugFromUrl(url);
        const dest = `${root}/${slug}`;
        await sudoStep(ctx, {
          description: `Clone ${url} into ${dest}, as ${username}.`,
          command: cloneRepoCommand(username, url, dest),
          verify: (c) => verifyCommand(c, 'test', ['-d', `${dest}/.git`]),
        });
        artifacts.push(owned('checkout', { name: slug, path: dest }));
      }
      return { artifacts };
    },
    async undo(ctx, created) {
      const checkouts = (created?.artifacts ?? []).filter((a) => a.type === 'checkout');
      if (checkouts.length === 0) return;
      ctx.ui.note(
        checkouts.map((a) => `rm -rf ${a.path}`).join('\n'),
        "Repo checkouts were left in place — remove them yourself if you're sure (uncommitted work may live there)",
      );
    },
  };
}

// ---- worker: admission caps (D14/D14a) -----------------------------------------------------------

/** `install -d`/`tee` as `username`, never as root — mirrors `cloneRepoCommand`'s nesting. No
 *  atomic tmp+rename: this is a first-write-only provisioning step, not cezar's own runtime
 *  writer, and nothing else races it at provisioning time. */
function writeUserFileCommand(username: string, path: string, content: string): string {
  const dir = path.slice(0, path.lastIndexOf('/')) || '/';
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const quoted = shquote(path);
  return (
    `install -d -m 0700 -o ${username} -g ${username} ${shquote(dir)} && ` +
    `printf %s ${shquote(b64)} | base64 --decode | sudo -u ${username} -H tee ${quoted} > /dev/null && ` +
    `sudo -u ${username} -H chmod 0600 ${quoted}`
  );
}

/** D14's table, "CX43 worker (8/16)" row: `maxParallel: 8`, `maxHeavySteps: 2`. The D14a
 *  memory/CPU-weight keys are deliberately left unset here — `resourcesSchema`'s own defaults
 *  (`workspace/config.ts`) are `null` (bound not set), which is the safe value for a node this
 *  install has never measured; tune it later through the cockpit once real load says how. */
const WORKER_RESOURCES_CONFIG = { resources: { maxParallel: 8, maxHeavySteps: 2 } };

function workerResourcesStep(): InstallStep {
  return {
    id: 'worker-resources',
    title: 'Admission caps for this worker (D14: maxParallel 8 / maxHeavySteps 2)',
    async check(ctx) {
      if (ctx.dryRun) return false;
      const username = resolveUnixUser(ctx);
      return verifyCommand(ctx, 'test', ['-f', `${orgCezHome(username)}/config.json`]);
    },
    async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
      const username = resolveUnixUser(ctx);
      const path = `${orgCezHome(username)}/config.json`;
      await sudoStep(ctx, {
        description:
          `Write ${path} — maxParallel: 8, maxHeavySteps: 2 (D14's CX43-worker row). cezar-plus's own ` +
          'config.json schema merges this with its other defaults the first time it boots here.',
        command: writeUserFileCommand(username, path, `${JSON.stringify(WORKER_RESOURCES_CONFIG, null, 2)}\n`),
        verify: (c) => verifyCommand(c, 'test', ['-f', path]),
      });
      return { artifacts: [owned('config', { path })] };
    },
    async undo() {
      // config.json lives inside CEZ_HOME, which the unix-user artifact's own undo note already
      // covers — nothing separate to reverse here.
    },
  };
}

// ---- worker: systemd unit (CEZ_CLUSTER, CEZ_ENV_PASSTHROUGH) --------------------------------------

/** Local duplicate of `systemd-unit.ts`'s own private `sysd`/PATH helpers — that file exports
 *  neither (same allowance its own top comment already takes for `ubuntu-vps.ts#sysd`: "duplicated
 *  … rather than exporting a symbol from a file this task does not own"). systemd expands a
 *  literal `%` in `Environment=`/`ExecStart=` values, so it must be doubled. */
function workerSysd(s: string): string {
  return s.replace(/%/g, '%%');
}
function workerPathEnvValue(): string {
  const dirs = [dirname(process.execPath), ...(process.env.PATH ?? '').split(':'), '/usr/local/bin', '/usr/bin', '/bin'].filter(
    (d, i, a) => d && d !== '.' && a.indexOf(d) === i,
  );
  return workerSysd(dirs.join(':'));
}

interface WorkerSystemdUnitOptions {
  workingDirectory: string;
  execStart: string;
  port: number;
  unixUser: string;
  cezHome: string;
  /** Comma-separated env var NAMES (never values) — `CEZ_ENV_PASSTHROUGH`. `''` omits the line
   *  entirely rather than writing it empty, so an unconfigured worker's unit stays byte-identical
   *  to one that predates this field. */
  envPassthrough: string;
}

/**
 * systemd unit for a cluster worker's `cezar serve` process. Deliberately its own generator, not
 * `orgSystemdUnit`/`supervisorSystemdUnit` (`./hetzner/systemd-unit.ts`, not this row's to edit):
 * neither shape fits — a worker terminates no auth of its own (`orgSystemdUnit`'s
 * `CEZ_AUTH=supervisor` would claim a supervisor relationship that does not exist here) and
 * terminates no OIDC/Google login (`supervisorSystemdUnit`'s whole reason for being). `CEZ_CLUSTER=1`
 * is the flag that turns the link on at all (spec Verification #12, "flag off" — its absence must
 * leave a plain cezar cockpit with no cluster machinery armed).
 */
function workerSystemdUnit(opts: WorkerSystemdUnitOptions): string {
  const passthroughLine = opts.envPassthrough
    ? `Environment=CEZ_ENV_PASSTHROUGH=${workerSysd(opts.envPassthrough)}\n`
    : '';
  return `# Managed by cezar server-install --platform hetzner --role worker — do not edit by hand.
[Unit]
Description=cezar worker (cluster spoke)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${workerSysd(opts.unixUser)}
WorkingDirectory=${workerSysd(opts.workingDirectory)}
Environment=CEZ_REMOTE=1
Environment=CEZ_CLUSTER=1
Environment=CEZ_HOME=${workerSysd(opts.cezHome)}
${passthroughLine}Environment=PATH=${workerPathEnvValue()}
ExecStart=${workerSysd(opts.execStart)} serve --no-open --port ${opts.port}
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectProc=invisible
ProtectControlGroups=yes
ProtectKernelTunables=yes
RestrictSUIDSGID=yes

[Install]
WantedBy=multi-user.target
`;
}

function workerSystemdStep(): InstallStep {
  return {
    id: 'worker-systemd',
    title: 'cezar worker systemd unit (CEZ_CLUSTER=1)',
    async check(ctx) {
      if (ctx.dryRun) return false;
      return verifyCommand(ctx, 'systemctl', ['is-enabled', unitName(ctx)]);
    },
    async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
      let envPassthrough = workerState(ctx).workerEnvPassthrough;
      if (envPassthrough === undefined) {
        const answer = await ctx.ui.text({
          message:
            'Host env var NAMES to forward into this worker\'s agent runs (comma-separated; blank = none — see CEZ_ENV_PASSTHROUGH)',
          placeholder: '',
        });
        if (answer === CANCEL) throw new StepCancelled();
        envPassthrough = String(answer).trim();
        workerState(ctx).workerEnvPassthrough = envPassthrough;
      }

      const username = resolveUnixUser(ctx);
      const execStart = await resolveHetznerExecStart(ctx);
      const unit = workerSystemdUnit({
        workingDirectory: orgHomeDir(username),
        execStart,
        port: ctx.state.primaryPort,
        unixUser: username,
        cezHome: orgCezHome(username),
        envPassthrough,
      });
      const unitPath = `/etc/systemd/system/${unitName(ctx)}`;
      await sudoStep(ctx, {
        description: 'Install the worker systemd unit, start it now, and enable it at boot.',
        command: writeRootFileCmd(unitPath, unit, `systemctl daemon-reload && systemctl enable --now ${unitName(ctx)}`),
        verify: (c) => verifyCommand(c, 'systemctl', ['is-enabled', unitName(ctx)]),
      });
      await confirmListening(ctx, ctx.state.primaryPort);

      return { artifacts: [owned('service', { name: unitName(ctx), scope: 'system', path: unitPath })] };
    },
    async undo(ctx, created) {
      const svc = (created?.artifacts ?? []).find((a) => a.type === 'service');
      if (!svc) return;
      await sudoStep(ctx, {
        description: 'Disable and remove the worker systemd unit.',
        command: `systemctl disable --now ${unitName(ctx)}; rm -f /etc/systemd/system/${unitName(ctx)} && systemctl daemon-reload`,
        verify: (c) => verifyCommand(c, 'sh', ['-c', `! systemctl is-enabled ${unitName(ctx)}`]),
      });
    },
  };
}

// ---- worker: agent CLI logins — the one step that must stop --------------------------------------

/**
 * The interactive gate Phase 4 names explicitly: "the run must stop and say so rather than
 * half-provisioning silently". A worker that enrolls but cannot run anything is worse than one
 * that never finished — see this file's module docblock. Positioned AFTER the systemd unit (so the
 * worker's own `CEZ_HOME` already exists for the agent CLIs to write credentials into) and BEFORE
 * enrollment (so the very first presence report already carries real "which agent CLIs are logged
 * in" labels rather than a stale "none").
 */
function workerLoginStep(): InstallStep {
  return {
    id: 'worker-login',
    title: 'Agent CLI logins for this worker — the one step this installer cannot script',
    async check(ctx) {
      if (ctx.dryRun) return false;
      return workerState(ctx).workerLoginsConfirmed === true;
    },
    async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
      if (ctx.dryRun) {
        ctx.ui.info('DRY RUN — would stop here for the agent CLI logins.');
        return { artifacts: [] };
      }
      const username = resolveUnixUser(ctx);
      const logins = agentCredentialLoginCommands(username);
      await requireManualLogin(ctx, {
        description: `${username} needs its OWN agent CLI credentials — signing in as yourself does not reach it.`,
        commands: logins.map((l) => l.command),
        note: `Everyone who can run code as ${username} can act as this worker (D4's isolation note, applied here).`,
      });
      workerState(ctx).workerLoginsConfirmed = true;
      return { artifacts: [] };
    },
    async undo() {
      // Nothing owned: the agent CLIs' own credential stores live under CEZ_HOME, covered by the
      // unix-user artifact's own undo note.
    },
  };
}

// ---- worker: enroll with the hub (D17) -------------------------------------------------------------

function workerEnrollStep(): InstallStep {
  return {
    id: 'worker-enroll',
    title: 'cez cluster join — enroll this worker with the hub (D17)',
    async check(ctx) {
      if (ctx.dryRun) return false;
      const username = resolveUnixUser(ctx);
      // `cluster/node-identity.ts` (Phase 1) writes this file on successful enrollment — its
      // presence is "already enrolled", the same "probe the artefact, not a flag" discipline
      // `org-register`'s own `isRegistered` uses above.
      return verifyCommand(ctx, 'test', ['-f', `${orgCezHome(username)}/cluster/node.json`]);
    },
    async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
      const token = joinTokenOf(ctx);
      if (!token) {
        throw new StepAborted(
          "no cluster join code recorded for this install — provision with --join <code>, minted from the hub's " +
            'Cluster settings ("Add node").',
        );
      }
      if (ctx.dryRun) {
        ctx.ui.info('DRY RUN — would run: cezar cluster join <code> (redacted) as the worker user.');
        return { artifacts: [] };
      }
      const username = resolveUnixUser(ctx);
      const execStart = await resolveHetznerExecStart(ctx);
      const nodeJsonPath = `${orgCezHome(username)}/cluster/node.json`;
      await sudoStep(ctx, {
        description:
          'Enroll this worker with the hub — redeems the single-use join code minted by the cockpit\'s "Add node".',
        command: `sudo -u ${username} -H ${shquote(execStart)} cluster join ${shquote(token)}`,
        verify: (c) => verifyCommand(c, 'test', ['-f', nodeJsonPath]),
      });
      return { artifacts: [owned('config', { path: nodeJsonPath })] };
    },
    async undo(ctx) {
      // A real, reversible registry write on the hub, not local irreplaceable state — `cez cluster
      // revoke` is the decommission path (Phase 4's own text), out of scope for this step's undo.
      ctx.ui.note(
        `This worker is still enrolled with the hub — run \`cez cluster revoke\` from the hub (or its ` +
          `cockpit) if you're decommissioning it, before destroying this VPS.`,
        'cluster enrollment',
      );
    },
  };
}

// ---- worker: verify -------------------------------------------------------------------------------

/** No nginx/TLS to probe (a worker terminates no inbound HTTP) — confirms only that the process
 *  itself is up, the same loopback probe `confirmListening` already performs for every other
 *  mode, plus one more curl so a failure here is loud rather than a later, unrelated dispatch
 *  timeout. */
function workerVerifyStep(): InstallStep {
  return {
    id: 'worker-verify',
    title: 'Verify the worker process is up',
    async check() {
      return false; // always re-verify; it creates nothing
    },
    async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
      if (ctx.dryRun) {
        ctx.ui.info('DRY RUN — would verify the worker process is listening.');
        return { artifacts: [] };
      }
      const port = ctx.state.primaryPort;
      await confirmListening(ctx, port);
      const upstreamCode = (
        await ctx.runner.capture('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${port}/`])
      ).stdout.trim();
      if (upstreamCode === '' || upstreamCode === '000') {
        throw new StepAborted(
          `cezar is not answering on 127.0.0.1:${port}. Diagnostics:\n` +
            `  • sudo systemctl status ${unitName(ctx)}\n` +
            `  • sudo journalctl -u ${unitName(ctx)} -n 50 --no-pager`,
        );
      }
      ctx.ui.success(`Worker is running (systemd unit ${unitName(ctx)}, loopback port ${port}).`);
      return { artifacts: [] };
    },
    async undo() {
      // nothing created
    },
  };
}

// ---- nginx: shared upgrade map + one vhost -------------------------------------------------------

async function ensureSharedNginxUpgradeMap(ctx: InstallContext): Promise<void> {
  await sudoStep(ctx, {
    description:
      'Write the shared WebSocket-upgrade map (http{}-context, declared once per host regardless of ' +
      'instance count — see ./hetzner/nginx.ts).',
    command: writeRootFileCmd(SHARED_UPGRADE_MAP_PATH, wsUpgradeMapSnippet(), 'nginx -t'),
    verify: (c) => verifyCommand(c, 'test', ['-f', SHARED_UPGRADE_MAP_PATH]),
  });
}

function nginxStep(): InstallStep {
  return {
    id: 'nginx',
    title: 'nginx vhost (D10 routing model)',
    async check(ctx) {
      if (ctx.dryRun) return false;
      const nginxOk = await verifyCommand(ctx, 'nginx', ['-v']);
      const mapOk = await verifyCommand(ctx, 'test', ['-f', SHARED_UPGRADE_MAP_PATH]);
      const vhostOk = await verifyCommand(ctx, 'test', ['-f', vhostEnabled(ctx)]);
      return nginxOk && mapOk && vhostOk;
    },
    async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
      const nginxWasPresent = await verifyCommand(ctx, 'nginx', ['-v']);
      await sudoStep(ctx, {
        description: 'Install nginx.',
        command: 'apt-get update && apt-get install -y nginx',
        verify: (c) => verifyCommand(c, 'nginx', ['-v']),
      });

      await ensureSharedNginxUpgradeMap(ctx);

      const domain = requireDomain(ctx);
      const vhost = isSupervisorMode(ctx)
        ? supervisorVhost({ hostname: domain, supervisorPort: ctx.state.primaryPort })
        : orgVhost({ hostname: domain, orgPort: ctx.state.primaryPort, supervisorPort: resolveSupervisorPort(ctx) });

      const vhostAvail = vhostAvailable(ctx);
      const vhostEnbl = vhostEnabled(ctx);
      await sudoStep(ctx, {
        description: `Write the ${isSupervisorMode(ctx) ? 'supervisor' : `org "${orgSlugOf(ctx)}"`} nginx vhost, enable it, and reload nginx.`,
        // `nginx -t` runs BEFORE the symlink, and the symlink is removed again if the reload
        // fails. CORRECTED 2026-08-07 (repair stage): this used to be
        // `ln -sf … && nginx -t && systemctl reload nginx`, which enables the site first — so a
        // vhost nginx rejects (the `http2 on;` directive needs nginx >= 1.25.1, and Ubuntu 22.04
        // ships 1.18) was left symlinked into `sites-enabled/`, making every LATER `nginx -t` or
        // reload on the whole box fail, including for unrelated sites. Meanwhile the step's own
        // `verify` is `test -f <symlink>`, which passes on exactly that broken state, so it
        // recorded `done`. Testing the config through a temporary symlink and rolling it back on
        // failure means a rejected vhost leaves the host exactly as it found it.
        command:
          writeRootFileCmd(
            vhostAvail,
            vhost,
            `ln -sf ${shquote(vhostAvail)} ${shquote(vhostEnbl)} && ` +
              `{ nginx -t && systemctl reload nginx; } || { rm -f ${shquote(vhostEnbl)}; nginx -t >/dev/null 2>&1 && systemctl reload nginx; false; }`,
          ),
        verify: (c) => verifyCommand(c, 'test', ['-f', vhostEnbl]),
      });

      const artifacts: StepArtifact[] = [owned('file', { path: vhostAvail }), owned('symlink', { path: vhostEnbl })];
      if (!nginxWasPresent) artifacts.push(shared('package', { name: 'nginx', removeHint: 'sudo apt-get remove -y nginx' }));
      return { artifacts };
    },
    async undo(ctx, created) {
      const vhostEnbl = vhostEnabled(ctx);
      await sudoStep(ctx, {
        description: 'Remove this instance\'s nginx vhost, reload nginx.',
        command: `rm -f ${shquote(vhostEnbl)} ${shquote(vhostAvailable(ctx))} && { nginx -t && systemctl reload nginx || true; }`,
        verify: (c) => verifyCommand(c, 'sh', ['-c', `! test -f ${shquote(vhostEnbl)}`]),
      });
      // The shared upgrade map and the nginx package itself are left in place — they may still
      // serve a sibling hetzner instance on this host (`shared`, same "list, don't remove" pattern
      // ubuntu-vps.ts uses for its own multi-instance nginx sites).
      const pkgs = (created?.artifacts ?? []).filter((a) => a.type === 'package');
      if (pkgs.length > 0) {
        ctx.ui.note(pkgs.map((a) => a.removeHint ?? a.name ?? '').filter(Boolean).join('\n'), 'Possibly used elsewhere — remove manually if unwanted');
      }
    },
  };
}

// ---- verify -----------------------------------------------------------------------------------

function verifyStep(): InstallStep {
  return {
    id: 'identity',
    title: 'Verify the deployment end-to-end (process + nginx + TLS)',
    async check() {
      return false; // always re-verify; it creates nothing
    },
    async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
      if (ctx.dryRun) {
        ctx.ui.info('DRY RUN — would verify the process is up and nginx routes/gates it correctly.');
        return { artifacts: [] };
      }
      const port = ctx.state.primaryPort;
      const domain = requireDomain(ctx);
      const upstreamCode = (
        await ctx.runner.capture('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${port}/`])
      ).stdout.trim();
      const upstreamUp = upstreamCode !== '' && upstreamCode !== '000';

      const https = ctx.state.publicUrl?.startsWith('https://') ?? false;
      const base = https ? 'https://127.0.0.1/' : 'http://127.0.0.1/';
      const tls = https ? ['-k'] : [];
      const publicCode = (
        await ctx.runner.capture('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', ...tls, '-H', `Host: ${domain}`, base])
      ).stdout.trim();

      const problems: string[] = [];
      if (!upstreamUp) problems.push(`cezar is not listening on 127.0.0.1:${port} — nginx will 502/504 until it is`);
      // TLS is REQUIRED on this platform, and this is where that stops being a claim. The certbot
      // sub-step is `skippable: true` (`./hetzner/tls.ts`), and `steps.ts` turns a skip into
      // `StepSkipped` unattended under `--yes` — so a DNS or rate-limit failure used to complete
      // the install on plain HTTP, at which point the browser refuses to store the session cookie
      // (`auth/session.ts` emits `Secure` unconditionally) and every sign-in silently fails while
      // this step printed "is live at …". ADDED 2026-08-07 at the repair stage.
      if (!https) {
        problems.push(
          'TLS is not in place (CEZ_PUBLIC_URL is not https) — the session cookie is Secure, so no browser ' +
            'will store it and every sign-in fails silently. Re-run with --reconfigure tls once DNS for ' +
            `${domain} points at this host`,
        );
      }
      if (isSupervisorMode(ctx)) {
        if (!/^[23]\d\d$/.test(publicCode)) {
          problems.push(`the login host did not answer 2xx/3xx through nginx (got "${publicCode || '000'}")`);
        }
      } else if (publicCode !== '401') {
        problems.push(`an anonymous request through nginx did not get 401 (got "${publicCode || '000'}") — auth_request may not be wired correctly, or the supervisor is unreachable`);
      }

      if (problems.length > 0) {
        ctx.ui.error(
          `The ${isSupervisorMode(ctx) ? 'supervisor' : `org "${orgSlugOf(ctx)}"`} deployment is NOT fully working yet:\n` +
            problems.map((p) => `  • ${p}`).join('\n') +
            `\n\nDiagnostics on the server:\n` +
            `  • sudo systemctl status ${unitName(ctx)}\n` +
            `  • sudo journalctl -u ${unitName(ctx)} -n 50 --no-pager\n` +
            `  • sudo systemctl status nginx && sudo nginx -t\n` +
            `  • sudo ss -ltnp | grep -E ':80|:443|:${port}'`,
        );
        throw new StepAborted('deployment verification failed — see the diagnostics above');
      }

      ctx.ui.success(
        `${isSupervisorMode(ctx) ? 'Supervisor' : `Org "${orgSlugOf(ctx)}"`} is live at ${ctx.state.publicUrl ?? `https://${domain}`}.`,
      );
      return { artifacts: [] };
    },
    async undo() {
      // nothing created
    },
  };
}

// ---- the platform strategy ----------------------------------------------------------------------

export const hetzner: PlatformStrategy = {
  id: 'hetzner',
  label: 'Hetzner (or any bare Linux VPS) — OIDC/Google + per-org process isolation',
  async preflight(ctx: InstallContext) {
    // A worker has no HTTP surface, no supervisor topology and no --org-slug — see this file's
    // module docblock, "Worker role". Its own, much shorter preflight branches off first so the
    // domain/org-slug checks below never see it.
    if (isWorkerMode(ctx)) {
      // Shape-only, so it runs even in dry-run — the exact same placement `hetzner requires
      // --domain` gets below for supervisor/org mode: a shape error is a "you typed this wrong",
      // not an OS/privilege probe a preview has no business running.
      if (!joinTokenOf(ctx)) {
        throw new PreflightError(
          '--role worker requires --join <code> — mint one from the hub\'s Cluster settings ("Add node").',
        );
      }
      if (ctx.dryRun) {
        ctx.ui.info('DRY RUN — skipping OS/privilege preflight for the worker role.');
        return;
      }
      const uname = await ctx.runner.capture('uname', ['-s']);
      if (!uname.stdout.includes('Linux')) throw new PreflightError('hetzner requires Linux.');
      if ((await ctx.runner.capture('apt-get', ['--version'])).code !== 0) {
        throw new PreflightError('hetzner requires apt (Debian/Ubuntu).');
      }
      // Deliberately NO "must not be root" check here, unlike supervisor/org mode below: D17's
      // minted one-liner runs `npx … --role worker --join …` as root on a bare VPS (Phase 4).
      return;
    }

    const domain = (ctx.state.domain ?? '').trim();
    if (!domain || !HOSTNAME_RE.test(domain)) {
      throw new PreflightError(
        'hetzner requires --domain <hostname> — the supervisor\'s login host, or one org\'s own subdomain of it.',
      );
    }
    // NORMALISED, not raw. `--org-slug " supervisor"` used to pass this guard (strict equality on
    // the untrimmed value) and then derive `cez-supervisor` in `provision-user.ts`, which trims —
    // handing an org's `cezar serve` cockpit the supervisor's uid, home and every org's secrets.
    // See `orgSlugOf`'s own doc comment.
    const orgSlug = orgSlugOf(ctx);
    if (orgSlug === SUPERVISOR_PSEUDO_SLUG) {
      throw new PreflightError(
        `"${SUPERVISOR_PSEUDO_SLUG}" is a reserved --org-slug (it names the supervisor's own dedicated unix user) — pick a different org slug.`,
      );
    }
    if (orgSlug === WORKER_PSEUDO_SLUG) {
      throw new PreflightError(
        `"${WORKER_PSEUDO_SLUG}" is a reserved --org-slug (it names a cluster worker's own dedicated unix user) — pick a different org slug.`,
      );
    }
    if (orgSlug) {
      try {
        orgUnixUsername(orgSlug);
      } catch (err) {
        throw new PreflightError(err instanceof Error ? err.message : String(err));
      }
      // One org, one instance. Instance identity is keyed on `--domain` (`instanceSlug`), but the
      // unix user and `CEZ_HOME` are keyed on `--org-slug` — so provisioning the same org on a
      // second hostname produced TWO enabled units, both `User=cez-<slug>`, both
      // `CEZ_HOME=/home/cez-<slug>/.cezar`, both `WorkingDirectory=/home/cez-<slug>/workspace`,
      // on two ports. That is two processes over one leaseless `.ai/cezar`: Problem §4 verbatim,
      // reached from the other direction than the shared-`WorkingDirectory` defect. ADDED
      // 2026-08-07 at the repair stage.
      const sibling = listServerInstances().find(
        (i) => i.state.platform === 'hetzner' && (i.state.orgSlug ?? '').trim() === orgSlug && i.state.domain !== domain,
      );
      if (sibling) {
        throw new PreflightError(
          `org "${orgSlug}" is already provisioned on this host as "${sibling.state.domain}" — one org gets one ` +
            'process, one unix user and one CEZ_HOME (D4). Two units for one org would put two processes on ' +
            "one project's .ai/cezar, which RunStore has no lease for. Uninstall that instance first, or pick " +
            'a different --org-slug.',
        );
      }
    }

    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — skipping OS/privilege/supervisor-topology preflight.');
      return;
    }
    const uname = await ctx.runner.capture('uname', ['-s']);
    if (!uname.stdout.includes('Linux')) throw new PreflightError('hetzner requires Linux.');
    if ((await ctx.runner.capture('apt-get', ['--version'])).code !== 0) {
      throw new PreflightError('hetzner requires apt (Debian/Ubuntu).');
    }
    if ((await ctx.runner.capture('id', ['-u'])).stdout.trim() === '0') {
      throw new PreflightError('run server-install as a normal sudo-capable user, not root.');
    }

    if (orgSlug) {
      const supervisor = findSupervisorInstance();
      if (!supervisor) {
        throw new PreflightError(
          'no supervisor is provisioned on this host yet — run `cezar server-install --platform hetzner ' +
            '--domain <login-host>` first (D10: "the supervisor\'s OWN unit first").',
        );
      }
      const base = (supervisor.state.domain ?? '').trim();
      if (!base || domain === base || !domain.endsWith(`.${base}`)) {
        throw new PreflightError(
          `org hostname "${domain}" must be a subdomain of the supervisor's base domain "${base || '?'}" ` +
            '(D10: one base domain, org hostnames are its subdomains — the auth_request subrequest depends ' +
            'on the shared session cookie that topology gives).',
        );
      }
    }
  },
  steps(ctx: InstallContext): InstallStep[] {
    if (isWorkerMode(ctx)) {
      // Order matches the plan's own description exactly (Phase 4): deps, dedicated unix user +
      // CEZ_HOME + project root (reusing `orgUserProvisioningStep` under the reserved pseudo-slug
      // — see the module docblock's "Worker role" section for why reusing it beats a parallel
      // path), repo checkouts, admission caps, the systemd unit, the interactive login STOP, and
      // enrollment last — so the first presence report already has real agent-CLI labels.
      return [
        depCheckStep(),
        // The second argument is the LABEL, not a second slug: `WORKER_PSEUDO_SLUG` is a real
        // slug but not a real org, so the step's default `org "<slug>"` phrasing rendered
        // `org "worker"` to the operator. The commands and the artifact are identical either way
        // — only the words describing them change.
        orgUserProvisioningStep(WORKER_PSEUDO_SLUG, 'this cluster worker'),
        workerCheckoutsStep(),
        workerResourcesStep(),
        workerSystemdStep(),
        workerLoginStep(),
        workerEnrollStep(),
        workerVerifyStep(),
      ];
    }
    if (isSupervisorMode(ctx)) {
      return [supervisorUserProvisioningStep(), supervisorSystemdStep(), nginxStep(), buildTlsStep(ctx), verifyStep()];
    }
    const orgSlug = orgSlugOf(ctx) as string;
    // `org-create` (D11) runs FIRST among the org-specific steps, ahead even of the unix user: it
    // needs nothing but the supervisor's admin token, so a failure there (bad token, rejected name,
    // supervisor unreachable) leaves nothing provisioned to undo. `org-register` sits between the
    // unit and nginx on purpose: the org's process record must exist before nginx's `auth_request`
    // can resolve this hostname to it, and it needs the unit's `EnvironmentFile` (written by
    // `org-systemd`) to read the secret back out of, and the `Org` row `org-create` just made
    // (read back via `GET /internal/orgs/:slug`) to resolve `orgId`.
    return [
      depCheckStep(),
      orgCreateStep(orgSlug),
      orgUserProvisioningStep(orgSlug),
      orgSystemdStep(orgSlug),
      orgRegistrationStep(orgSlug),
      nginxStep(),
      buildTlsStep(ctx),
      verifyStep(),
    ];
  },
  async redeploy(ctx: InstallContext) {
    const name = unitName(ctx);
    const execStart = (await ctx.runner.capture('systemctl', ['show', name, '-p', 'ExecStart'])).stdout;
    // #696's npx-cache trap applies here exactly as it does to ubuntu-vps.ts's own redeploy —
    // reused verbatim rather than re-implemented.
    if (isNpxExecStart(execStart)) refreshNpxCacheForRedeploy(ctx, execStart);
    if (ctx.dryRun) {
      ctx.ui.info(`DRY RUN — would restart ${name} and re-verify.`);
      return;
    }
    ctx.ui.info(`Redeploying — restarting ${name} to pick up the new version.`);
    await sudoStep(ctx, {
      description: 'Reload systemd and restart the service.',
      command: `systemctl daemon-reload && systemctl restart ${name}`,
      verify: (c) => verifyCommand(c, 'systemctl', ['is-active', name]),
    });
    await confirmListening(ctx, ctx.state.primaryPort);
    // Worker mode has no nginx/TLS to re-check (see workerVerifyStep's own doc comment) — throws
    // StepAborted in either branch if the deployment isn't fully working.
    if (isWorkerMode(ctx)) await workerVerifyStep().run(ctx);
    else await verifyStep().run(ctx);
  },
};

/**
 * TLS is the one step whose options depend on which OTHER paths this run resolved (`vhostAvailable`,
 * `unitName` for the renewal-guard hook's `publicUrlConfigFile`) — built inline in `steps()` rather
 * than as a module-level `InstallStep` constant, the same reason `orgSystemdStep`/nginx above take
 * `ctx`-derived values rather than closing over a fixed one.
 */
function buildTlsStep(ctx: InstallContext): InstallStep {
  return createTlsStep({
    domain: requireDomain(ctx),
    vhostPath: vhostAvailable(ctx),
    role: isSupervisorMode(ctx) ? 'supervisor' : 'org',
    publicUrlConfigFile: isSupervisorMode(ctx) ? `/etc/systemd/system/${unitName(ctx)}` : undefined,
  });
}
