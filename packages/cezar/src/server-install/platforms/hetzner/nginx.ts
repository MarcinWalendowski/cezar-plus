import { X_CEZAR_PRINCIPAL_HEADER, X_CEZAR_SIGNATURE_HEADER } from '../../../supervisor/forwarded-principal.ts';

/**
 * nginx vhost generation for the `hetzner` platform (D4, D5, D10, spec
 * `.ai/specs/2026-08-06-org-team-auth-onboarding.md`). Pure string generators only — no sudo, no
 * file writes, no `nginx -t`/`systemctl reload`. Unit 6 (`server-install/platforms/hetzner.ts`) is
 * the `InstallStep` orchestrator that calls these functions and writes their output through
 * `server-install/steps.ts`'s existing `sudoStep`/`writeRootFileCmd` idiom — the same split
 * `ubuntu-vps.ts#nginxVhost` already has from its own `nginxProxyStep`. Test by asserting on the
 * generated strings, the discipline `ubuntu-vps.test.ts` and this platform's own
 * `systemd-unit.test.ts` already established (feeding a generator's own output back into the real
 * code it must agree with, rather than a hand-written stand-in that can silently drift).
 *
 * Deliberately NOT in `ubuntu-vps.ts`, and does not edit `ubuntu-vps.ts#nginxVhost`: that vhost's
 * shape — one process, one shared uid, `auth_basic` + htpasswd as the perimeter — is a different
 * design from D4/D10's per-org uid boundary with OIDC behind an `auth_request` subrequest, not a
 * variant of it. **This is a fresh-install platform, not an in-place upgrade of `ubuntu-vps`**:
 * `server-install/engine.ts` pins a host's platform at first install (`state.platform !==
 * strategy.id` throws) and there is no migration path from an `auth_basic` vhost to this one —
 * "OIDC replaces `auth_basic`" is true of what `--platform hetzner` provisions on a clean host, not
 * something this module (or any part of phase 7) rewrites into an existing `ubuntu-vps` install.
 * Turning one into the other is `cezar server-uninstall` on the old platform, then a clean
 * `--platform hetzner` run — the engine's own guard is what enforces that, not this file.
 *
 * ## Routing model (D10)
 *
 * One BASE domain, one supervisor login host on it (`CEZ_PUBLIC_URL`'s own host — D9's
 * exact-match `redirect_uri` rule means there is only ever ONE), and every org hostname a
 * SUBDOMAIN of that same base domain, which is what makes a `Domain=.<base>` session cookie
 * (`CEZ_SESSION_COOKIE_DOMAIN`, `systemd-unit.ts`) visible on every org's own host — the mechanism
 * the `auth_request` subrequest below depends on to see the browser's cookie at all. Two vhosts:
 *
 *   - `supervisorVhost` — the login host. `/auth/*` and the cockpit shell the onboarding wizard
 *     renders in proxy to the supervisor's own loopback port; `/internal/*` is marked `internal;`
 *     and answers 404, exactly as it is on the org vhost (`cezar supervisor`, unit 1 — this file
 *     only routes to it, never shapes it).
 *
 *     **CORRECTED 2026-08-07 (repair stage): this vhost used to publish `/internal/*` to the
 *     internet.** It had one `location /` proxying everything, so `curl https://login.<base>/
 *     internal/orgs` enumerated every tenant and `curl -X DELETE …/internal/project-teams/
 *     by-root?root=…` destroyed a D4 claim — from anywhere, with no credential, on the one host
 *     the whole deployment guarantees is public (D9 registers its `redirect_uri` there). The org
 *     vhost had it right and this module's own docblock asserted the safe version for both,
 *     which is how it survived review as "exposure is local-only". Both halves are fixed: the
 *     supervisor now also requires a bearer credential on `/internal/*`
 *     (`supervisor/internal-auth.ts`), and this vhost no longer publishes it. Either alone would
 *     have left the other as the only thing standing.
 *   - `orgVhost` — one per org, on its own subdomain. `/auth/` and `/internal/` still go to the
 *     SAME supervisor loopback port (so `/auth/me` / `/auth/logout` work same-site on the org's own
 *     host without a cross-origin fetch); `/internal/` is nginx `internal;` — reachable only via
 *     this vhost's own `auth_request` subrequest, never by a direct external client, so it is not a
 *     second, unauthenticated way to reach the supervisor's `/internal/orgs/*` surface. Everything
 *     else (`/`) runs `auth_request /internal/auth-check` first: on 2xx nginx captures the two
 *     `forwarded-principal.ts` headers the supervisor's response carried and re-injects them
 *     (`proxy_set_header`, which REPLACES whatever a client sent — there is no way for a request to
 *     arrive at the org process with a client-supplied value surviving) before proxying to the
 *     ORG's own loopback port; on 401 nginx answers 401 directly and the org process is never
 *     reached at all. This gates the WHOLE org host, including the SPA shell itself, per D10's own
 *     text ("`/` runs `auth_request` ... then proxies", no carve-out for static assets) — an
 *     anonymous visit to an org host gets a bare 401, not a login screen, which differs from phase
 *     1-5's single-process behaviour (the SPA shell renders unauthenticated there so its own JS can
 *     show a login prompt). That is a real UX difference worth the next reader's attention, but it
 *     is what D10 specifies, not a gap this module introduces: a browser only ever reaches an org
 *     host after the supervisor's login host has already set the shared session cookie.
 *
 *     **`/api/v1/health` is gated too, and that is a deliberate difference from every other
 *     deployment** (NOTED 2026-08-07 at the repair stage, after a reviewer flagged it as a
 *     possible oversight). Elsewhere health is CORS-open and exempt from `requirePrincipal`,
 *     because the bookmarklet's port sweep runs before any cookie for the origin exists — a
 *     LOOPBACK discovery feature. On a public, multi-tenant org host the same payload names the
 *     boot project and the repository behind it to anyone on the internet, with
 *     `Access-Control-Allow-Origin: *`. The spec's own Risks entry already had to redact
 *     `projects` for exactly this reason. So there is no carve-out here: an external uptime check
 *     against an org host gets 401, which is a real operational limitation worth documenting
 *     (`docs/server-install/hetzner.md` says so) rather than a leak worth opening.
 *
 * If the supervisor itself is unreachable, nginx's `auth_request` treats the subrequest failure as
 * an error and the org host answers 5xx rather than falling open to the org process with no
 * principal attached — fail closed, no special-casing needed here.
 *
 * ## WebSocket upgrade (`/api/v1/ws`, D6)
 *
 * `verifyWsUpgrade` (`server/server.ts`) is a SECOND check the org process runs itself, because the
 * upgrade is attached to the raw HTTP server and never passes through Hono middleware (or nginx's
 * `auth_request`, for that matter — the handshake still goes through `location /` and is gated by
 * it exactly like any other request to `/`). It compares the browser's own `Host`/`Origin` headers
 * against each other, so nginx must forward them UNMODIFIED (`proxy_set_header Host $host`, never
 * the org's own `127.0.0.1:<port>`) — the same as the plain-HTTP case below, no special case
 * needed. What IS special: nginx will only complete a WebSocket handshake with the upstream if it
 * forwards `Connection: upgrade` for an upgrade request and an ordinary `Connection` value
 * otherwise — SSE needs `proxy_buffering off` and a live `Connection` on the very same `location /`
 * cezar's run-event stream already relies on, so one fixed `Connection` value cannot serve both.
 * `wsUpgradeMapSnippet`'s `$cezar_connection_upgrade` map is what lets ONE location serve SSE, plain
 * HTTP and the WS upgrade without breaking any of them. `map` is an `http{}`-context directive:
 * declaring it once per vhost file errors with "duplicate map variable declaration" the moment a
 * second org is provisioned, so it is its own generator, meant to be written to ONE shared file
 * (e.g. `/etc/nginx/conf.d/cezar-upgrade.conf`, included once regardless of org count) rather than
 * folded into either vhost function below.
 *
 * ## Header names are IMPORTED, not re-typed (D3's own history)
 *
 * `X_CEZAR_PRINCIPAL_HEADER`/`X_CEZAR_SIGNATURE_HEADER` come from `supervisor/forwarded-principal.ts`
 * rather than being spelled out again here as string literals. That file's own docblock explains
 * why a signed header exists at all; the reason THIS file imports the two names rather than
 * hardcoding `'x-cezar-principal'`/`'x-cezar-principal-sig'` is the exact failure D3's own history
 * names once already in this repo — `server.ts`'s `LOCAL_PRINCIPAL` kept in sync with
 * `auth/principal.ts`'s `LOCAL_IDENTITY` "by convention, not by shared code" until nothing asserted
 * they matched. nginx cannot import a TypeScript module, but this generator can, so the header
 * spelling nginx forwards and the spelling the org process verifies against
 * (`readForwardedPrincipalHeaders`) are guaranteed to agree at TYPECHECK time rather than by two
 * humans copying the same string into two files.
 */

/** The `http{}`-context `map` every vhost this platform writes depends on for its `Connection`
 *  header — see this module's own doc comment for why it cannot live inside a `server{}` block.
 *  Exported so a test (or unit 6's install step) can assert it is written exactly once. */
export const CEZAR_CONNECTION_UPGRADE_VAR = '$cezar_connection_upgrade';

/** Written once per host (not once per vhost) to a shared, `http{}`-context config file — e.g.
 *  `/etc/nginx/conf.d/cezar-upgrade.conf` on a Debian/Ubuntu layout, where `nginx.conf` already
 *  includes `conf.d/*.conf` inside its `http {}` block ahead of `sites-enabled/*`. Declaring this
 *  `map` a second time (one per org vhost) is a NGINX CONFIG ERROR ("duplicate map variable
 *  declaration"), not a harmless redundancy — unit 6 must write it exactly once regardless of how
 *  many orgs are provisioned, mirroring how `ubuntu-vps.ts`'s multi-instance nginx sites already
 *  share one `nginx.conf`/`sites-enabled` directory without re-declaring anything http-scoped. */
export function wsUpgradeMapSnippet(): string {
  return `# Managed by cezar server-install --platform hetzner — do not edit by hand.
# Shared by every vhost this platform writes (org + supervisor) — declared ONCE, http{} context.
# Standard nginx WebSocket-proxying idiom: forward "Connection: upgrade" only when the client
# actually asked to upgrade, so the SAME location can proxy plain HTTP, SSE and the WS handshake.
map $http_upgrade ${CEZAR_CONNECTION_UPGRADE_VAR.slice(1)} {
    default upgrade;
    ''      close;
}
`;
}

/** nginx forbids most punctuation, whitespace and control characters in a bare token
 *  (`server_name`, a proxied header value assembled from one) — reject anything that could break
 *  out of the generated config's syntax rather than trust the caller validated it. `hostname` here
 *  is provisioning-time operator input (`--domain`) or an org slug turned into a subdomain, the
 *  same trust level `ubuntu-vps.ts`'s own `HOSTNAME_RE` gates before ITS `nginxVhost` is called —
 *  this is defense in depth, not a substitute for that validation, which stays unit 6's job (this
 *  file owns no CLI prompt or flag parsing to hang a `validate:` callback off of). */
function assertSafeNginxToken(value: string, what: string): void {
  if (!value || /[\s{};"'\\]/.test(value)) {
    throw new Error(`${what} is not safe to embed in an nginx config: ${JSON.stringify(value)}`);
  }
}

function assertValidPort(port: number, what: string): void {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${what} must be an integer 1-65535, got ${port}`);
  }
}

/** nginx's `auth_request_set`/`proxy_set_header` variable that reads a header nginx's OWN
 *  `auth_request` subrequest response carried — `$upstream_http_<header, dashes as underscores>`.
 *  Derived from the real header name rather than hand-spelled so the two can never drift apart. */
function upstreamHttpVar(headerName: string): string {
  return `$upstream_http_${headerName.replace(/-/g, '_')}`;
}

export interface SupervisorVhostOptions {
  /** The deployment's ONE login host — `CEZ_PUBLIC_URL`'s own hostname (D9's exact-match
   *  `redirect_uri`; `systemd-unit.ts#SupervisorSystemdUnitOptions.publicUrl` carries the same
   *  value as a full URL, this is just its bare hostname for `server_name`). */
  hostname: string;
  /** The supervisor's own hard-bound loopback port (`systemd-unit.ts#SupervisorSystemdUnitOptions.port`,
   *  `cezar supervisor --port <port>`). */
  supervisorPort: number;
}

/**
 * The supervisor's own vhost — the base/login host. A single upstream (no `auth_request`: the
 * supervisor terminates auth itself, and the login/callback routes are precisely the ones that
 * cannot require an already-resolved session to reach). Structurally the single-upstream shape
 * `ubuntu-vps.ts#nginxVhost` already has, minus `auth_basic` (D9's OIDC/Google flow is the
 * perimeter here) and with the WS-safe `Connection` header this module's docblock explains.
 */
export function supervisorVhost(opts: SupervisorVhostOptions): string {
  assertSafeNginxToken(opts.hostname, 'hostname');
  assertValidPort(opts.supervisorPort, 'supervisorPort');
  return `# Managed by cezar server-install --platform hetzner — do not edit by hand.
# The deployment's one login host (CEZ_PUBLIC_URL) — everything here proxies to the supervisor.
server {
    listen 80;
    listen [::]:80;
    server_name ${opts.hostname};

    # See ubuntu-vps.ts#nginxVhost for why this is valid on the plain :80 block: it only takes
    # effect once TLS (unit 7) adds a 443 ssl listener, and multiplexes cezar's long-lived SSE
    # run-event streams over one connection so the browser's ~6-per-origin HTTP/1.1 cap never
    # blocks further requests.
    http2 on;

    # The supervisor's /internal/* control surface is NOT published on the public login host.
    # It carries D4's root -> org mapping and every org's process record (including the secret
    # that signs that org's forwarded principals); this is the one hostname the deployment
    # guarantees is internet-facing, so publishing it here would put the whole control plane on
    # the internet. Org vhosts reach /internal/auth-check by proxying straight to
    # 127.0.0.1:<supervisorPort> from their own auth_request subrequest — they never traverse
    # this server block, so nothing legitimate loses reachability.
    #
    # \`internal;\` alone already 404s an external request; the explicit \`return 404\` makes the
    # answer identical for an internal redirect too, so no future location here can accidentally
    # open it by adding one.
    location /internal/ {
        internal;
        return 404;
    }

    location / {
        proxy_pass http://127.0.0.1:${opts.supervisorPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket upgrade, SSE and plain HTTP share this one location — see wsUpgradeMapSnippet.
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection ${CEZAR_CONNECTION_UPGRADE_VAR};

        # cezar streams SSE (run events). Never buffer it, or the cockpit goes mute.
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
`;
}

export interface OrgVhostOptions {
  /** This org's public hostname — a subdomain of the deployment's one base domain
   *  (`OrgProcessRecord#hostname`, `supervisor/org-process-registry.ts`). */
  hostname: string;
  /** This org's hard-bound loopback port (`OrgProcessRecord#loopbackPort`; the same value
   *  `systemd-unit.ts#orgSystemdUnit`'s `ExecStart --port` carries — D10: "the org's port must be a
   *  hard bind", `CEZ_PORT_STRICT=1`, or this value silently stops matching what nginx forwards to). */
  orgPort: number;
  /** The (one, shared) supervisor's own hard-bound loopback port — same value every org vhost on
   *  this host points `/auth/`, `/internal/` and the `auth_request` subrequest at. */
  supervisorPort: number;
}

/**
 * One org's vhost — routes by hostname (D5: no new URL segment, org is decided by which process
 * answers). `/auth/` and `/internal/` go to the supervisor; `/` runs `auth_request` against the
 * supervisor's `/internal/auth-check` and, only on success, proxies to this org's OWN process with
 * the signed forwarded-principal headers attached. See this module's own doc comment for the full
 * routing model, the WS-upgrade reasoning and why `/` gates the whole host including the SPA shell.
 */
export function orgVhost(opts: OrgVhostOptions): string {
  assertSafeNginxToken(opts.hostname, 'hostname');
  assertValidPort(opts.orgPort, 'orgPort');
  assertValidPort(opts.supervisorPort, 'supervisorPort');
  return `# Managed by cezar server-install --platform hetzner — do not edit by hand.
# One org's hostname (a subdomain of the deployment's base domain). No HTTP Basic-Auth challenge
# here — OIDC/Google, terminated by the supervisor, is this platform's perimeter (D9/D10); this
# vhost only forwards the supervisor's signed verdict to this org's own process, it never checks
# a credential itself.
server {
    listen 80;
    listen [::]:80;
    server_name ${opts.hostname};

    http2 on;

    # nginx's own auth_request target — reachable only via the internal redirect below, and marked
    # internal; itself so a direct external request never resolves it either. Proxies straight
    # through to the supervisor's real /internal/auth-check (no URI segment after the port, so
    # nginx forwards the matched request URI unchanged).
    location /internal/ {
        internal;
        proxy_pass http://127.0.0.1:${opts.supervisorPort};
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Host $host;
        proxy_set_header Cookie $http_cookie;
        proxy_set_header X-Original-URI $request_uri;
        proxy_set_header X-Original-Method $request_method;
    }

    # /auth/login, /auth/callback, /auth/me, /auth/logout, /auth/onboarding/* — same-site on this
    # org's own host, unauthenticated by nginx (the supervisor's own routes decide what each needs).
    location /auth/ {
        proxy_pass http://127.0.0.1:${opts.supervisorPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        # 401 here means "no valid session" — nginx answers 401 directly and this org's own
        # process is never reached (D10: "No session ⇒ plain 401, same as every other
        # unauthenticated /api/v1/* request today"). A supervisor that is unreachable fails this
        # subrequest closed too — nginx never falls back to proxying with no principal attached.
        auth_request /internal/auth-check;
        auth_request_set $cezar_principal ${upstreamHttpVar(X_CEZAR_PRINCIPAL_HEADER)};
        auth_request_set $cezar_principal_sig ${upstreamHttpVar(X_CEZAR_SIGNATURE_HEADER)};

        proxy_pass http://127.0.0.1:${opts.orgPort};
        proxy_http_version 1.1;
        # Host/Origin are forwarded UNMODIFIED — verifyWsUpgrade (server.ts) compares the
        # browser's own Host against its own Origin on the WS handshake, so this must stay the
        # request's real Host, never this org's own loopback address.
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # The signed principal REPLACES whatever a client sent — proxy_set_header overwrites, it
        # never appends, so there is no way for a caller-supplied value to survive alongside this.
        proxy_set_header ${X_CEZAR_PRINCIPAL_HEADER} $cezar_principal;
        proxy_set_header ${X_CEZAR_SIGNATURE_HEADER} $cezar_principal_sig;

        # WebSocket upgrade, SSE and plain HTTP share this one location — see wsUpgradeMapSnippet.
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection ${CEZAR_CONNECTION_UPGRADE_VAR};

        # cezar streams SSE (run events). Never buffer it, or the cockpit goes mute.
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
`;
}
