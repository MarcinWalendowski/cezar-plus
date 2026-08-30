# Remote access — host cezar-plus on a server

By default the cezar-plus cockpit runs on `localhost`. To reach it from another
machine — a shared team box, a VPS, your phone — put an **authenticated public
front** in front of it. cezar-plus ships an interactive, dependency-free installer
that does exactly that, modularized by **platform strategy**.

The wizard never escalates silently: **every privileged command is printed and
verified**, and you choose to run it via `sudo` or paste it into a root shell
yourself. It's idempotent and resumable, and it ends with a real
**authenticated end-to-end check** — so "complete" means the cockpit actually
works behind its login.

```bash
npx cezar-cli server-install   --platform <id>   # install
npx cezar-cli server-deploy    --platform <id>   # redeploy a new version (reload the service)
npx cezar-cli server-uninstall --platform <id>   # reverse it
```

## Available providers

| Provider | `--platform` | Public front | Identity | Autostart | Guide |
|----------|--------------|--------------|----------|-----------|-------|
| **Ubuntu / Debian VPS** | `ubuntu-vps` | nginx + Let's Encrypt (HTTPS) | HTTP Basic-Auth (htpasswd) | systemd | [Step-by-step →](./ubuntu-vps.md) |
| **macOS + ngrok** | `macosx-ngrok` | ngrok tunnel (HTTPS) | ngrok `--basic-auth` | launchd | [Step-by-step →](./macosx-ngrok.md) |
| **Hetzner / any Ubuntu box, one process per org** | `hetzner` | nginx + Let's Encrypt (HTTPS), `auth_request` | **OIDC or Google sign-in** (real accounts, not one shared password) | systemd, one unit **per organization** | [Step-by-step →](./hetzner.md) |

Same engine, different steps — each strategy is a small registry entry, so new
platforms slot in without touching the engine.

> **`hetzner` is the only one with a boundary *between* tenants.** The other two
> put a single shared login in front of a single shared process; everyone who
> gets through is the same unix user. `hetzner` gives each organization its own
> unix user, its own `CEZ_HOME` and its own systemd unit, and routes to it by
> hostname. It is also the only one where you sign in as **yourself** rather than
> as the box. Read its guide before choosing it: it is a bigger install, and it
> needs a wildcard-ish DNS setup and an identity provider.
>
> **CORRECTED 2026-08-07 (phases 5b/5c/8, spec D11).** This paragraph used to end
> "and there is a real limitation about creating the *second* organization that it
> states up front". That limitation is gone: `server-install --platform hetzner
> --org-slug <slug>` now creates the organization as well as its infrastructure,
> via the supervisor's admin-only `POST /internal/orgs`, and prints a one-time
> per-org claim code its intended owner redeems at the login host. What has *not*
> changed is that creating an organization stays an **operator** action — a
> browser request from an existing org's owner cannot create one. See
> [hetzner.md](./hetzner.md).

> **Several domains on one box?** `ubuntu-vps` can host multiple independent
> cockpits — add `--domain <host>` to install/deploy/uninstall a separate
> instance (its own port, nginx site, login and service). A new `--domain` never
> resumes the first install. See
> [Hosting several cockpits on one box](./ubuntu-vps.md#hosting-several-cockpits-on-one-box-multiple-domains).

## How it works (all providers)

1. **Dependencies** — detect the agent CLIs (`claude`/`codex`/`opencode`),
   `gh`, `git`; offer to install what's missing. (Tools in `~/.local/bin` / nvm
   are found via your login-shell PATH.)
2. **Public front** — stand up the reverse proxy / tunnel that terminates
   TLS and challenges every request for a login.
3. **Identity** — a username + password (type your own or auto-generate a
   strong one). cezar-plus stores only a hash; the app stays bound to loopback.
4. **Autostart** — a service (systemd / launchd) that starts cezar-plus now and
   keeps it up across reboots.
5. **Verify** — confirm an anonymous request is challenged **and** an
   authenticated one reaches cezar-plus.

## One unit, every project

The autostart service runs cezar-plus as one unix user, and a cockpit serves that
user's **whole workspace** (`~/.cezar/config.json`), not only the repo you
installed from. Hosting several repos therefore no longer needs one unit per
repo: install once, then add the rest — **Settings → Projects** in the cockpit,
or straight from an ssh session:

```bash
cezar projects                     # what this host serves
cezar projects add /srv/other-repo # register another checkout
cezar projects remove other-repo   # registry entry only — the checkout stays
```

The CLI edits the registry file directly, so it works whether or not the
service is running; the cockpit picks the change up on the next page load.

Need **disjoint** project sets on one box — one cockpit per customer, say? Give
each instance its own home with `CEZ_HOME` (an `Environment=CEZ_HOME=/srv/cezar-homes/shop`
line in its systemd unit / launchd plist). Each home carries its own registry,
global config and server state, so instances share nothing — and `--domain`
already gives them separate ports, nginx sites and logins.

## Redeploying a new version

`npx cezar-cli server-deploy --platform <id>` is the standardized, per-strategy way to
roll out a new cezar-plus: it restarts the service and re-verifies. See each guide's
**Updating / redeploying** section for the checkout-vs-npx details.

To test an unreleased build on a server, pin a preview version
(see [Preview builds](../publishing.md)) — for example roll a box to a PR's
exact snapshot with `npx cezar-cli@<version> server-deploy --platform <id>`,
or track a branch with `npx cezar-cli@develop server-deploy --platform <id>`.

---

Guides: **[Ubuntu / Debian VPS](./ubuntu-vps.md)** · **[macOS + ngrok](./macosx-ngrok.md)** · **[Hetzner, one process per org](./hetzner.md)**
