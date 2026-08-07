# Remote access — Hetzner (one process per organization)

Host cezar on a Linux box where **each organization gets its own unix user, its
own home, and its own process**, behind a real sign-in (OIDC or Google) instead
of one shared password.

Despite the name there is nothing Hetzner-specific in it: it is an Ubuntu/Debian
installer, named after the box it was built and tested against. Pick it over
[`ubuntu-vps`](./ubuntu-vps.md) when you want people to sign in **as themselves**
and you want a boundary *between* tenants. Pick `ubuntu-vps` when one shared
login in front of one shared cockpit is what you actually want — it is a much
smaller install.

**How it's wired.** Every cezar process stays loopback-bound. **nginx** is the
only public surface. One extra process, the **supervisor**, terminates auth: it
runs the OIDC/Google flow, owns the session cookie, and owns the only copy of
the identity store. For a request to an org's hostname, nginx asks the
supervisor "who is this?" with an `auth_request` subrequest and, only on a 2xx,
proxies to that org's own process with a **signed** principal header attached.

```
                     ┌──────────────────────────────────────────────┐
  browser ──HTTPS──► │ nginx (:443)                                 │
                     │                                              │
                     │  login.example.com  ─────────────────────────┼──► supervisor
                     │                                              │    127.0.0.1:PS
                     │  acme.example.com                            │    user cez-supervisor
                     │    /auth/     ───────────────────────────────┼──► supervisor
                     │    /          auth_request ──► supervisor    │
                     │               ───(2xx + signed principal)────┼──► org "acme"
                     │                                              │    127.0.0.1:PA
                     │  beta.example.com                            │    user cez-acme
                     │    /          auth_request ──► supervisor    │
                     │               ───(2xx + signed principal)────┼──► org "beta"
                     └──────────────────────────────────────────────┘    127.0.0.1:PB
                                                                          user cez-beta
```

The isolation is an **OS boundary, not an application check**: `cez-acme` and
`cez-beta` are different unix users with `0700` homes, different `CEZ_HOME`s,
different working directories and different systemd units. Nothing in the app
has to remember to filter.

> **Within one organization, everything is shared, and that is on purpose.**
> Everyone who signs in to an org shares that org's one process, one filesystem
> and the host's own `claude`/`codex` credentials — so **members of an
> organization can run code as one another. Invite accordingly.** The boundary
> above sits *between* organizations; it was never meant to separate one member
> of an org from another.

---

## Read this before you start: a hosted deployment can now host more than one organization

**CORRECTED 2026-08-07 (phases 5b/5c/8): this heading, and the section below it, replace the
superseded "you can host exactly one organization today" section kept immediately after this
one — the falsehood was in that heading, not only its body, so amending only the body would have
left a reader scanning headings carrying away the wrong claim.** See the spec's D11
(`.ai/specs/2026-08-06-org-team-auth-onboarding.md`).

`POST /internal/orgs` — admin-only, authenticated by `CEZ_SUPERVISOR_ADMIN_TOKEN` — creates the
organization row for every organization after the deployment's first. The **org** install below
calls it as part of provisioning: it resolves `--org-slug <slug>` against the supervisor and, if
no organization by that slug exists yet, creates one before provisioning that organization's unix
user, systemd unit, nginx vhost and `org-register` step — closing the wall the superseded section
describes (infrastructure fully automated, nothing to put behind it).

The first person to sign in **at the deployment's login host** (`login.example.com` below — NOT
the organization's own hostname) and enter that organization's **slug** plus **its own** per-org
claim code — printed once at creation, never the deployment-wide code the very first
organization's owner holds — becomes its owner.

> **CORRECTED 2026-08-07, same day, at the 5b/5c/8 repair stage: the sentence above first read
> "the first person to sign in *at that organization's own hostname*", which names a host where
> the claim cannot happen at all.** An organization's own process runs `CEZ_AUTH=supervisor` and
> deliberately mounts none of the `/auth/*` routes (`packages/cezar/src/index.ts` — no login
> surface on a loopback port every local uid can reach, and no identity store under D4's per-org
> uid boundary). `POST /auth/onboarding/org` exists only on the supervisor, and its claim branch
> is keyed on the `orgSlug` in the request body plus that org's `claimTokenHash` — the hostname
> the browser is on is never read. Following the original instruction would have meant sitting on
> `acme.login.example.com` waiting for a wizard that is not served there.

A second and
later member of any organization now joins by invite rather than never at all
(`owner`/`admin`-only), and `owner`/`admin` can create, rename and reassign teams. `role` gates
that kind of organization administration and never code execution: **members of an organization
can run code as one another. Invite accordingly** (unchanged from ["How it's
wired"](#remote-access-hetzner-one-process-per-organization) above) — a `member` reaches
`POST /api/v1/workflows` exactly as an `owner` does, because both share the one unix user
provisioning below gives their organization.

**What has not changed: none of this has been run against a real, two-organization Hetzner
host.** Everything above is built and unit/route-tested in this repo; see the spec's
Verification section for the current QA-Needed list before treating a live multi-org deployment
as proven.

---

### Superseded 2026-08-07: "you can host exactly one organization today"

Kept for the reasoning it still carries about what per-org isolation buys you even before an
org-creation surface exists — not as a current description of this platform's capability, which
the corrected section above replaces.

The isolation described above is real, built and tested. **What is missing is
the ability to create a second organization.**

The first person to sign in claims the deployment and becomes its owner (with a
bootstrap code, below). `POST /auth/onboarding/org` — the only place an
organization row is ever created — refuses once *any* organization exists, and
no route or command creates a second one. The supervisor's own org endpoints are
reads.

Provisioning a second org's *infrastructure* is fully automated
(`--org-slug <slug>` does the unix user, the unit, the vhost and the
registration). It just fails at the point where it asks the supervisor for the
organization named `<slug>` and is told there isn't one.

So today this platform gives you: **real per-org isolation, and one org.** It is
worth installing if you want sign-in-as-yourself with the isolation already in
place for when the org-creation surface lands. It is not worth installing if you
need two tenants this week.

---

## Prerequisites

- Ubuntu/Debian with `apt`, reachable over SSH.
- A **normal, sudo-capable user** (the installer refuses to run as root).
- At least one logged-in agent CLI — `claude`, `codex`, or OpenCode.
- **An identity provider.** Either a generic OIDC provider (Keycloak, Authentik,
  Auth0, Okta…) or Google. You need a client ID and client secret, and you must
  be able to register a redirect URI.
- **DNS.** One base domain plus a hostname per organization, all pointing at the
  box:
  - `login.example.com` → the supervisor (this is the deployment's base domain)
  - `acme.login.example.com` → org `acme`
  - Each org hostname **must be a subdomain of the base domain** — preflight
    refuses otherwise. That is not stylistic: the session cookie is issued with
    `Domain=.login.example.com`, and a hostname outside that suffix never
    receives it, so its `auth_request` sees no cookie and 401s forever.
- **Ports 80/443 free.** This platform installs and owns nginx; there is no
  `--external-proxy` mode for it.
- **TLS is mandatory**, not optional. The session cookie is `Secure`
  unconditionally, so on plain HTTP no browser will store it and every sign-in
  fails silently. The final verify step fails the install if `CEZ_PUBLIC_URL` is
  not `https://`.

---

## Install

Two runs, in this order. **The supervisor first** — an org install refuses if no
supervisor is provisioned on the host.

### 1. The supervisor

```bash
npx cezar-cli server-install --platform hetzner --domain login.example.com
```

You will be asked for:

| Prompt | Notes |
|---|---|
| Auth provider | `oidc` or `google`. With `google` the issuer is pinned; with `oidc` you also give the issuer URL and discovery runs against `<issuer>/.well-known/openid-configuration`. |
| OAuth client ID / client secret | Register `https://login.example.com/auth/callback` as the redirect URI with your provider. |
| Bootstrap claim code | Leave blank and cezar mints a random one at every start and prints it to its own log. Type one to pin it. See [Claiming the deployment](#claiming-the-deployment). |
| Let's Encrypt email | Renewal notices. |

Steps it runs: `supervisor-user` → `supervisor-systemd` → `nginx` → `tls` →
`identity` (the end-to-end verify).

### 2. An organization

```bash
npx cezar-cli server-install --platform hetzner \
  --domain acme.login.example.com --org-slug acme
```

Steps: `deps` → `org-create` → `org-user` → `org-systemd` → `org-register` →
`nginx` → `tls` → `identity`.

**CORRECTED 2026-08-07 (phases 5b/5c/8): `org-create` is new and runs first among the
org-specific steps, before even the unix user** — it needs nothing but the supervisor's
admin token, so a failure there (bad token, rejected name, supervisor unreachable) leaves
nothing provisioned to undo. It calls the admin-only `POST /internal/orgs` (D11) to create
the organization row for `--org-slug` if it does not already exist, and prints the one-time
per-org bootstrap claim code its intended owner needs — see [Claiming the
deployment](#claiming-the-deployment). The two paragraphs below, about `org-register` and
about `--org-slug` resolution aborting because "a second org stops today", describe the
pre-`org-create` state and are kept for the reasoning about why `org-register` sits where it
does, not as a current description — see the corrected section at the top of this page.

`org-register` is the one that hands this org's freshly minted
`CEZ_SUPERVISOR_SECRET` to the supervisor, which is what makes the
`auth_request` able to resolve this hostname to a process at all. Until that
record exists the supervisor answers `org-has-no-active-process` and nginx 401s
every request to the host, forever. It runs as one root shell command that reads
both credentials out of their `0600` files — **neither secret is ever printed,
and neither appears in `argv`.**

It also resolves `--org-slug` against the supervisor first, and aborts with
*"the supervisor knows no org with slug X — create it in the onboarding wizard
first"* if that organization does not exist. Which, per the section above, is
where a second org stops today.

---

## What it puts on the box

| Thing | Path |
|---|---|
| Supervisor unix user | `cez-supervisor`, home `/home/cez-supervisor` (`0700`) |
| Org unix user | `cez-<slug>`, home `/home/cez-<slug>` (`0700`), locked (no password) |
| Org `CEZ_HOME` | `/home/cez-<slug>/.cezar` (`0700`) |
| Org project root | `/home/cez-<slug>/workspace` (`0700`) — the unit's `WorkingDirectory` |
| systemd units | `/etc/systemd/system/cezar-hetzner-<instance>.service` (system scope, one per install) |
| Secrets | `/etc/cezar/hetzner-<instance>.env` — root-owned, `0600`, referenced by `EnvironmentFile=` |
| nginx vhost | `/etc/nginx/sites-available/cezar-hetzner-<instance>` (symlinked into `sites-enabled`) |
| Shared nginx map | `/etc/nginx/conf.d/cezar-hetzner-upgrade.conf` — written once per host, not once per vhost |

**Secrets go in `EnvironmentFile=`, never `Environment=`.** `systemctl show`
prints `Environment=` lines to any local user; an `EnvironmentFile` is read by
systemd as root and never echoed back. Non-secret settings (`CEZ_HOME`,
`CEZ_PORT_STRICT`, the public URL) stay on plain `Environment=` lines where they
are easy to inspect.

Each org's unit is hardened: `NoNewPrivileges`, `PrivateTmp`,
`ProtectSystem=full`, `ProtectProc=invisible`, `ProtectControlGroups`,
`ProtectKernelTunables`, `RestrictSUIDSGID`. **`ProtectHome` is deliberately
absent** — cezar's whole job is reading and writing that user's own home
(`CEZ_HOME`, the project root, the agent CLIs' credentials), so protecting it
would break the product; the `0700` home is the actual lock.

Each org's unit also sets `CEZ_PORT_STRICT=1`. Its nginx `proxy_pass` names a
specific loopback port baked in at provisioning time, so a process that
"helpfully" drifted to the next free port would not be a startup failure — it
would be another org's traffic routed into the wrong process.

---

## Claiming the deployment

There are **two different codes**, and they claim different things. Both are answered at the
**login host** — an organization's own hostname serves no `/auth/*` route at all.

### The first organization — the deployment-wide bootstrap code

The first user to sign in and name an organization becomes its owner, and an
owner can run shell commands on this host. With `--platform hetzner` and
`CEZ_AUTH=google` the issuer is pinned but the *audience* is every Google
account on the internet, so arriving first must not be enough.

While no organization exists, the supervisor mints a random **bootstrap code**
at every start and prints it to its own log. The onboarding wizard asks for it
and refuses with 403 without it.

```bash
sudo journalctl -u cezar-hetzner-<instance> -n 50 --no-pager | grep -i bootstrap
```

> **FIXED 2026-08-07 (phases 5b/5c/8 repair stage): until this release the command above matched
> nothing, and this section was describing a claim nobody could complete.** `cezar serve` printed
> the code on its `CEZ_AUTH`-on path; `cezar supervisor` never did — and on this platform the
> supervisor is the only process that mounts `POST /auth/onboarding/org`. So the default mode
> minted a fresh code at every restart, the wizard refused every claim without it, and the operator
> had no way to read it: a `--platform hetzner` install was unclaimable unless the bootstrap prompt
> below had been answered with a pinned value. `startSupervisor` now prints the same banner
> `serve` does, from the same module instance the route checks
> (`packages/cezar/src/supervisor/index.ts#supervisorBootLines`).

Pin your own value instead by answering the bootstrap prompt during install (it
becomes `CEZ_AUTH_BOOTSTRAP_TOKEN` in the supervisor's env file). The code stops
being printed, and stops granting anything, the moment the organization exists.

### Every organization after that — its own per-org claim code

The deployment-wide code above is spent, and deliberately cannot claim a second organization:
org one's owner already holds it, and D11's whole point is that holding it must not make them the
owner of every organization on the box.

Instead, `server-install --platform hetzner --org-slug <slug>`'s `org-create` step prints that
organization's **own** single-use claim code, once, at provisioning time. It is not written to any
log and cannot be re-derived — if it is lost, delete the organization and provision it again.
Hand it to that organization's intended owner out of band, along with the slug.

They then sign in at **`https://login.example.com`** (the login host — *not*
`https://<slug>.login.example.com`, which runs `CEZ_AUTH=supervisor` and serves no wizard), open
"I have an organization code" on the onboarding screen, and enter the slug and the code. That
makes them that organization's `owner`; everyone else joins by an invite an `owner`/`admin` mints
from the cockpit.

A wrong code and a slug that names no organization answer the identical 403, on purpose — telling
them apart would let anyone enumerate which organizations exist on the deployment.

---

## Updating / redeploying a new version

Per instance, same as the other platforms. **`--domain` alone selects which one**
— `--org-slug` is only meaningful on `server-install`; every later run reads it
back out of that instance's recorded state, so there is no way for a redeploy to
disagree with the install about which org it is acting on:

```bash
# the supervisor
npx cezar-cli server-deploy --platform hetzner --domain login.example.com

# one org
npx cezar-cli server-deploy --platform hetzner --domain acme.login.example.com
```

It restarts the unit and re-runs the full end-to-end verify, so "deployed" means
the thing actually answers correctly through nginx.

---

## Uninstall

```bash
npx cezar-cli server-uninstall --platform hetzner --domain acme.login.example.com
```

`undo` reverses only what a completed step actually created, and it
**deprovisions the org from the supervisor's registry** rather than leaving the
supervisor routing at a unit that no longer exists.

Two things it deliberately does not destroy: the org's `/etc/cezar/…env` secret
file (it tells you the exact `rm` to run), and the org's unix user and home —
that home holds the org's whole workspace, and no installer should delete it for
you.

---

## Troubleshooting

**Every request to an org host returns 401, including for a user who is
definitely signed in.** Four separate causes produce this identical symptom, so
check them in order:

1. **The org has no process record** — `org-register` never completed. This is
   the most common one, and note that the install's own success criterion for an
   org host is *also* a 401 (an anonymous request should be challenged), so a
   passing install does not rule it out. Re-run with `--reconfigure org-register`.
2. **The cookie is host-only.** Check the supervisor unit has
   `Environment=CEZ_SESSION_COOKIE_DOMAIN=.<base-domain>`. Without it the browser
   never sends the session cookie to `acme.<base>`, so the subrequest sees
   nothing to verify. Only the supervisor's unit carries this — an org's process
   never issues or clears a session cookie.
3. **The org hostname is not a subdomain of the base domain.** Same consequence
   as (2), from the other direction. Preflight refuses this, but a hand-edited
   vhost can reintroduce it.
4. **The supervisor is down or unreachable.** `auth_request` fails **closed** —
   nginx never falls back to proxying without a principal. Check
   `systemctl status` on the supervisor's unit.

**`the supervisor knows no org with slug X`** — expected, and not a bug in your
setup: see [the one-organization limit](#read-this-before-you-start-you-can-host-exactly-one-organization-today).

**Sign-in appears to work and then nothing is remembered.** Almost always TLS:
the cookie is `Secure`, so a plain-HTTP deployment silently drops it. The verify
step refuses to pass on non-HTTPS for exactly this reason. Re-run with
`--reconfigure tls` once DNS points at the host.

**General diagnostics** (the installer prints these for you on failure):

```bash
sudo systemctl status  cezar-hetzner-<instance>
sudo journalctl -u     cezar-hetzner-<instance> -n 50 --no-pager
sudo systemctl status nginx && sudo nginx -t
sudo ss -ltnp | grep -E ':80|:443'
```

---

Guides: **[Ubuntu / Debian VPS](./ubuntu-vps.md)** · **[macOS + ngrok](./macosx-ngrok.md)** · **[Overview](./README.md)**
