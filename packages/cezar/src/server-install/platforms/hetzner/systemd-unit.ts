import { dirname } from 'node:path';

/**
 * systemd unit generation for the `hetzner` platform (D4/D10, spec
 * `.ai/specs/2026-08-06-org-team-auth-onboarding.md`). Two units, not one:
 *
 *  - `orgSystemdUnit` — one per organization, running `cezar serve` under that org's OWN
 *    dedicated unix user and `CEZ_HOME` (D4's uid boundary). Authenticates through the
 *    supervisor's forwarded-principal channel (`CEZ_AUTH=supervisor`, D10) rather than
 *    terminating auth itself.
 *  - `supervisorSystemdUnit` — exactly one per deployment, running `cezar supervisor` (a new
 *    subcommand, Fill unit 1) under its OWN dedicated unix user and `CEZ_HOME` (never equal to
 *    any org's or the operator's real `~/.cezar`) — the single process that ever opens
 *    `<CEZ_HOME>/identity/*.json` (D10).
 *
 * Deliberately NOT in `ubuntu-vps.ts`, and does not edit `ubuntu-vps.ts#systemdUnit`: that unit's
 * shape — one process, shared uid, fronted by nginx `auth_basic` — is a different design from
 * D4's per-org uid boundary, not a variant of it (an existing `ubuntu-vps` host cannot be
 * converted to `hetzner` in place either; `engine.ts` pins a host's platform once installed).
 * `ubuntu-vps.ts`'s `%`-escaping helper (`sysd`) is a private, unexported closure inside its
 * `systemdUnit` function, so it is duplicated below (3 lines) rather than exporting a symbol from
 * a file this task does not own.
 */

/** systemd expands `%` specifiers (e.g. from an nvm dir name) in `Environment=`/`ExecStart=`
 *  values — a literal `%` must be doubled or the unit fails to load. Duplicated from
 *  `ubuntu-vps.ts#systemdUnit`'s private `sysd` (not exported there — see this file's top
 *  comment). */
function sysd(s: string): string {
  return s.replace(/%/g, '%%');
}

/** The operator's own PATH plus the node dir running this installer, so the spawned cockpit can
 *  find `claude`/`codex`/`gh` at runtime — systemd's own default PATH has none of those. Same
 *  derivation as `ubuntu-vps.ts#systemdUnit` (duplicated for the same reason as `sysd` above). */
function pathEnvValue(): string {
  const dirs = [dirname(process.execPath), ...(process.env.PATH ?? '').split(':'), '/usr/local/bin', '/usr/bin', '/bin'].filter(
    (d, i, a) => d && d !== '.' && a.indexOf(d) === i,
  );
  return sysd(dirs.join(':'));
}

/**
 * Hardening every unit this platform writes carries.
 *
 * **ADDED 2026-08-07 (phase 6/7 repair stage).** D4's boundary is a uid, and a uid alone leaves
 * `/tmp` shared across every org on the box — `server/git-changes.ts` builds a scratch git index
 * there under a PREDICTABLE name (`cez-scratch-index-<pid>-<seq>`, and pids are world-readable in
 * `/proc`), so a sibling org can pre-create the lock (a cross-org DoS on the diff route) and, with
 * git's default `0644`, read the index's full tracked-path listing for the life of the call.
 * `PrivateTmp=yes` closes that whole class; the rest are the standard systemd hardening set for a
 * service that has no business writing outside its own home.
 *
 * `ProtectHome=` is deliberately ABSENT: this service's entire state lives in `/home/cez-<slug>`
 * (`CEZ_HOME`, the project root, the agent CLIs' credentials), so `ProtectHome=yes`/`read-only`
 * would break it outright, and `ProtectHome=tmpfs` with a `BindPaths=` exception would be a second
 * spelling of the `0700` lock the provisioning step already applies. `ProtectSystem=full` rather
 * than `strict`: `full` makes `/usr`, `/boot` and `/etc` read-only while leaving `/var` and `/tmp`
 * writable, and `strict` would need an explicit `ReadWritePaths=` for every path an agent CLI
 * touches — a list nothing can enumerate, since the whole product runs third-party CLIs.
 */
const HARDENING = [
  'NoNewPrivileges=yes',
  'PrivateTmp=yes',
  'ProtectSystem=full',
  'ProtectProc=invisible',
  'ProtectControlGroups=yes',
  'ProtectKernelTunables=yes',
  'RestrictSUIDSGID=yes',
].join('\n');

export interface OrgSystemdUnitOptions {
  /**
   * `WorkingDirectory=` — **this org's OWN project root**
   * (`provision-user.ts#orgProjectRoot`, `/home/cez-<slug>/workspace`), never the operator's
   * checkout and never a path any other org's unit also names.
   *
   * **CORRECTED 2026-08-07 (repair stage).** This field was `repoRoot` and this doc said "the
   * same value on every org's unit on one host: the code is shared, only state (`CEZ_HOME`)
   * differs per org (D4)". The first half is true of the CODE (`ExecStart` still points at one
   * shared install) and false of what `WorkingDirectory` actually decides: `cezar serve` opens
   * its `RunStore` at `<cwd>/.ai/cezar` and auto-registers that directory as its boot project, so
   * every org process was reading and rewriting ONE leaseless `runs.json`. See
   * `provision-user.ts#orgProjectRoot` for the full reasoning and the D4 clause it restores.
   */
  workingDirectory: string;
  /** Absolute ExecStart command. Reuse `ubuntu-vps.ts#serviceExecStart` (exported) to resolve
   *  it — this file does not duplicate that resolution, only the unit text around it. */
  execStart: string;
  /** The org's hard-bound loopback port (`OrgProcessRecord#loopbackPort`,
   *  `supervisor/org-process-registry.ts`) — nginx's `proxy_pass` for this org is rendered with
   *  this exact value at provisioning time, so it must never silently drift (D10: "the org's port
   *  must be a hard bind", `CEZ_PORT_STRICT` below). */
  port: number;
  /** The org's dedicated, no-login unix user (`OrgProcessRecord#unixUser`) — D4's uid boundary
   *  IS this value; there is no rootless `systemctl --user` fallback here the way
   *  `ubuntu-vps.ts#autostartStep` prefers for a single-tenant install. */
  unixUser: string;
  /** The org's dedicated `CEZ_HOME` (`OrgProcessRecord#cezHome`) — never equal to any other
   *  org's or the supervisor's own. Set explicitly via `Environment=` rather than relying on
   *  `User=` having resolved `$HOME` correctly first: defense in depth for the single
   *  highest-value cross-tenant leak this design has. */
  cezHome: string;
  /** `EnvironmentFile=` path (root-owned, `0600`) carrying `CEZ_SUPERVISOR_SECRET`
   *  (`OrgProcessRecord#supervisorSecret`) — D10: "a secret in `Environment=` is readable by any
   *  local user, any org's uid included". Written by whichever install step lays down the
   *  record; this generator only references the path, never the secret value. */
  environmentFile: string;
}

/**
 * systemd unit for one org's `cezar serve` process.
 *
 * `CEZ_AUTH=supervisor` is D10's design for this process: trust the supervisor's signed,
 * forwarded principal (`supervisor/forwarded-principal.ts`) rather than terminate auth itself.
 * `resolveAuthProvider` (`server/capabilities.ts`) and `authProviderSchema`
 * (`packages/contract/src/health.ts`) recognise the literal, `src/index.ts`'s `serveCommand` has
 * a `'supervisor'` branch that wires `supervisor/forwarded-session.ts`'s resolver, and
 * `systemd-unit.test.ts` feeds this unit's own `Environment=` lines into the real
 * `resolveAuthBootGate` AND the real resolver, the same pairing discipline `ubuntu-vps.test.ts`
 * applies to the `ubuntu-vps` unit. (This docblock previously said in bold that the two literals
 * "do not yet recognise" the value and that the pairing assertion was "a named, red assertion" —
 * both landed at fill unit 5 and the assertion was green; corrected 2026-08-07 at the repair
 * stage, because a comment predicting red on a green test misleads the next reader worse than no
 * comment.)
 *
 * Never `CEZ_ALLOW_UNAUTHENTICATED=1` — that flag states "my network is the perimeter", which is
 * false here: nginx's `auth_request` against the supervisor is the actual perimeter. Writing both
 * would make the unit boot green for the wrong reason (a real auth channel plus a "there is no
 * auth" declaration sitting next to it).
 *
 * `CEZ_PORT_STRICT=1` is this generator's own naming for D10's hard-bind opt-in — the spec names
 * `--port-strict` as one option and "an env var of the same shape as every other `CEZ_*` opt-in"
 * as the other; every other boolean toggle in this codebase (`CEZ_ALLOW_UNAUTHENTICATED`,
 * `CEZ_REMOTE`, `CEZ_KB`, `CEZ_NOTES`, …) is the env-var form, so this generator follows that
 * precedent rather than inventing a new CLI flag. Fill unit 6 (`index.ts`'s `serve` argument
 * parsing) must implement the variable for it to do anything — an unrecognised `process.env` key
 * is inert, not a crash (unlike `parseArgs`'s strict-mode unknown-flag throw), so this generator
 * does not need that unit to land first to be internally consistent.
 *
 * Always `scope: system` / `User=<unixUser>` — no rootless-user-bus branch, unlike
 * `ubuntu-vps.ts#autostartStep`: D4's isolation is the dedicated unix user itself.
 */
export function orgSystemdUnit(opts: OrgSystemdUnitOptions): string {
  return `# Managed by cezar server-install --platform hetzner — do not edit by hand.
[Unit]
Description=cezar cockpit (org: ${opts.unixUser})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${sysd(opts.unixUser)}
WorkingDirectory=${sysd(opts.workingDirectory)}
Environment=CEZ_REMOTE=1
Environment=CEZ_AUTH=supervisor
Environment=CEZ_HOME=${sysd(opts.cezHome)}
Environment=CEZ_PORT_STRICT=1
Environment=PATH=${pathEnvValue()}
EnvironmentFile=${sysd(opts.environmentFile)}
ExecStart=${sysd(opts.execStart)} serve --no-open --port ${opts.port}
Restart=on-failure
RestartSec=5
${HARDENING}

[Install]
WantedBy=multi-user.target
`;
}

export interface SupervisorSystemdUnitOptions {
  /** `WorkingDirectory=` — the supervisor's own `0700` home (`provision-user.ts#orgHomeDir` of
   *  its pseudo-slug user), not the operator's checkout. CORRECTED 2026-08-07 alongside
   *  `OrgSystemdUnitOptions#workingDirectory`: the supervisor never opens a `RunStore`, so it had
   *  no data-loss exposure, but pointing a service at another user's home is how you get a
   *  200/CHDIR start failure the moment that home is `0750` (Ubuntu's `HOME_MODE` default). */
  workingDirectory: string;
  /** Absolute ExecStart command (see `OrgSystemdUnitOptions#execStart`). */
  execStart: string;
  port: number;
  /** The supervisor's own dedicated, no-login unix user — never any org's, never the operator's
   *  real account. Same "own dedicated unix user, own dedicated home" posture D4 asks of an org,
   *  applied here because this process holds every org's identity and secrets (D10: "the single
   *  highest-value target on the box"). */
  unixUser: string;
  /** The supervisor's own dedicated `CEZ_HOME` — never equal to any org's `CEZ_HOME` or to the
   *  operator's real `~/.cezar`. This is where `<CEZ_HOME>/identity/*.json` (D7) and
   *  `supervisor/org-process-registry.ts`'s store live. */
  cezHome: string;
  /** `CEZ_PUBLIC_URL` — the supervisor's own login host, exact and absolute (D9: the OIDC
   *  `redirect_uri` is derived from it). D10's one-base-domain topology means this is the ONLY
   *  registered `redirect_uri` for the whole deployment, regardless of org count. */
  publicUrl: string;
  /** The supervisor terminates real auth (D10) — `oidc` or `google`, never `'supervisor'` (that
   *  value only ever appears on an ORG unit, trusting THIS process). */
  authProvider: 'oidc' | 'google';
  /** `CEZ_SESSION_COOKIE_DOMAIN` — must be the shared base domain (`Domain=.<base-domain>`) so
   *  the session cookie this login host sets is visible to nginx's `auth_request` subrequest on
   *  every org's subdomain (D10: "Domain= cookie scoping" — without it, org hostnames never see
   *  the supervisor's cookie and every `auth_request` 401s). */
  sessionCookieDomain: string;
  /** `EnvironmentFile=` path carrying the supervisor's own secrets (`CEZ_OIDC_CLIENT_SECRET`
   *  and, if pinned, `CEZ_AUTH_BOOTSTRAP_TOKEN`) — same "never `Environment=`" rule D10 states
   *  for the per-org `CEZ_SUPERVISOR_SECRET`. */
  environmentFile: string;
}

/**
 * systemd unit for the deployment's ONE supervisor process (`cezar supervisor` — a new
 * subcommand, Fill unit 1; this file only renders the unit text, it does not implement the
 * subcommand). Forced to a **system**-scope unit under its own dedicated unix user, deliberately
 * not the rootless `systemctl --user` path `ubuntu-vps.ts#autostartStep` defaults to — that path
 * has no way to express a per-supervisor (or per-org) unix user at all, and this is the one
 * process on the box worth the extra provisioning weight to isolate (D10).
 *
 * `CEZ_AUTH` here names a REAL provider (`oidc`/`google`), never `'supervisor'` — this process
 * terminates auth, it does not trust a forwarded principal, so `resolveAuthProvider` already
 * recognises this value today and the pairing test below is expected to be green from the start
 * (unlike `orgSystemdUnit`'s, which names the still-missing literal).
 */
export function supervisorSystemdUnit(opts: SupervisorSystemdUnitOptions): string {
  return `# Managed by cezar server-install --platform hetzner — do not edit by hand.
[Unit]
Description=cezar supervisor (auth + org routing)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${sysd(opts.unixUser)}
WorkingDirectory=${sysd(opts.workingDirectory)}
Environment=CEZ_REMOTE=1
Environment=CEZ_AUTH=${opts.authProvider}
Environment=CEZ_HOME=${sysd(opts.cezHome)}
Environment=CEZ_PUBLIC_URL=${sysd(opts.publicUrl)}
Environment=CEZ_SESSION_COOKIE_DOMAIN=${sysd(opts.sessionCookieDomain)}
Environment=PATH=${pathEnvValue()}
EnvironmentFile=${sysd(opts.environmentFile)}
ExecStart=${sysd(opts.execStart)} supervisor --no-open --port ${opts.port}
Restart=on-failure
RestartSec=5
${HARDENING}

[Install]
WantedBy=multi-user.target
`;
}
