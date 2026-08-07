# Unreleased

## ⚠️ Breaking
- **A hosted cezar with no authentication now refuses to boot.** If you run with `CEZ_REMOTE=1`
  or a non-loopback `--bind-host` and set neither `CEZ_AUTH` nor `CEZ_ALLOW_UNAUTHENTICATED=1`,
  `cezar serve` exits non-zero at startup — before it touches `~/.cezar`, reclaims a worktree or
  resumes a run — and prints why. **Local installs, which is the npm default, are completely
  unaffected.** The fix is one line: `CEZ_ALLOW_UNAUTHENTICATED=1` if your network or reverse
  proxy is the perimeter, or `CEZ_AUTH=oidc|google` to require a sign-in. Hosts installed with
  `cezar server-install --platform ubuntu-vps` get the flag written into their systemd unit
  automatically (that platform puts nginx `auth_basic` in front), so they keep booting with no
  action from you. The reason it is a refusal and not a warning: cezar executes agents, and
  `POST /api/v1/workflows` takes a free-form `command` that a check step runs through
  `spawn('bash', ['-lc', …])` — "no auth" has to be something you chose, not a variable you
  forgot. It does not enforce authentication; it enforces choosing.

## ✨ Features
- ✨ **Optional sign-in: generic OIDC or Google, off by default.** Set `CEZ_AUTH=oidc` (with
  `CEZ_PUBLIC_URL`, `CEZ_OIDC_ISSUER`, `CEZ_OIDC_CLIENT_ID`, `CEZ_OIDC_CLIENT_SECRET`) or
  `CEZ_AUTH=google` and every API route, both SSE streams and the WebSocket upgrade require a
  session cookie; `/auth/login`, `/auth/callback`, `/auth/logout` and `/auth/me` appear. It is
  Authorization Code + PKCE with `state` and `nonce` verified, the ID-token signature checked
  against the provider's JWKS, `state` single-use *and* bound to the browser that started the
  flow, `redirect_uri` derived from `CEZ_PUBLIC_URL` at boot and never from a forwarded header,
  an `HttpOnly; Secure; SameSite=Lax` cookie, logout that invalidates server-side rather than
  only clearing the cookie, and optional group → role mapping that grants nothing for a group
  you did not map. Google is the same code path with a pinned issuer, not a second flow.
  **With `CEZ_AUTH` unset nothing changes at all**: no identity storage is created, no session
  middleware is mounted, no login route is registered, the auth modules are never even imported,
  and the health payload is byte-identical.
  **CORRECTED 2026-08-07 by D13 (see the "Local-mode onboarding" entry below): "nothing changes at
  all", "no identity storage is created" and "the auth modules are never even imported" no longer
  hold without qualification.** On a loopback bind — the npm default — `CEZ_AUTH` unset now also
  lets a local user create an organization and workspaces, and the auth modules ARE imported on
  that path (though still doing no filesystem I/O at import time). A user who never opens
  `/onboarding` still creates nothing, so that half of the sentence above survives unqualified.
  **What does not change, ever, on this path: authentication itself** — no session middleware is
  mounted, no login route is registered, and the health payload stays byte-identical. Identity
  lives in `~/.cezar/identity/*.json` behind
  the same `O_EXCL` write lease the source and automation stores already use — no new dependency,
  and every uniqueness rule (one org per slug, one team slug per org, one user per
  `(issuer, subject)`, one membership per pair, **one project root in exactly one organization**)
  is enforced inside that lease rather than at each call site.
  **CORRECTED 2026-08-07 (phases 5b/5c/8): the sentence below is superseded, and the fact
  changed, not merely the reason for it — see the "Second organizations, invites and team
  management" entry further down for the current shape.**
  **Signing in is not tenancy — a hosted cezar still holds exactly one organization.** The
  per-organization process boundary now exists (`cezar supervisor` + `server-install --platform
  hetzner`, below) — but nothing yet creates a second organization to put behind it, so today's
  deployments still share one process, one filesystem and the host's own agent credentials
  within their one org: **members of an organization can run code as one another — invite
  accordingly.** And "everyone who signs in" is currently *one person*: the first user to name
  an organization owns it, everyone after that is told they need an invite, and the invite
  surface is not built yet — see the organizations entry below.
- 🔒 **Cross-org isolation: a real OS process boundary (`cezar supervisor`,
  `server-install --platform hetzner`).** A new dedicated `cezar supervisor` process terminates
  auth and holds identity for the whole deployment; each organization's `cezar serve` instead
  runs `CEZ_AUTH=supervisor`, under its own unix user with its own `CEZ_HOME`, provisioned by
  `cezar server-install --platform hetzner --domain <org-host> --org-slug <slug>`. nginx does an
  `auth_request` subrequest to the supervisor, which signs the resolved principal with a
  per-org secret (`CEZ_SUPERVISOR_SECRET`) before forwarding to that org's own loopback port —
  a forged header from a sibling process on the same host fails verification at the org's own
  process, not just at nginx. Two organizations provisioned this way share no filesystem and no
  process. Provisioning an org is end-to-end: the installer mints that org's secret, writes it to
  a root-owned `0600` `EnvironmentFile` and **registers the org with the supervisor itself**,
  reading both credentials back inside a root shell so neither is ever printed or passed in
  `argv`; uninstalling deprovisions the record rather than leaving the supervisor routing at a
  unit that no longer exists. **CORRECTED 2026-08-07 (phases 5b/5c/8): the next sentence is
  superseded — see the "Second organizations, invites and team management" entry further down.**
  **This still does not make cezar multi-tenant today**: onboarding
  refuses to create a second organization, and there is no other surface that creates one — so
  the installer's org-registration step resolves `--org-slug` against the supervisor and stops
  there. So this ships the isolation a second organization would need, not a second organization.
  `--platform ubuntu-vps` and `--platform macosx-ngrok` are unaffected and unchanged.
  Also new alongside it: `CEZ_SESSION_COOKIE_DOMAIN` (unset = today's host-only cookie, byte for
  byte; the supervisor's unit sets `.<base-domain>` so one sign-in is visible on every org's
  hostname) and `CEZ_SUPERVISOR_ADMIN_TOKEN` (the supervisor's own provisioning credential —
  **unset closes that surface** rather than opening it). A project can no longer be allocated the
  slug `internal`: the generated org vhost answers that prefix itself, so such a project would
  work locally and 404 when hosted. Reservations are forward-only — a project already holding the
  slug keeps it.
- ✨ **Organizations, teams and a first-run onboarding wizard (`/onboarding`).** With `CEZ_AUTH`
  set, signing in lands on a three-step wizard: name your organization, accept (or rename) its
  default team, add your first project. The org and its default team are created in one atomic
  write, so a half-finished onboarding can never strand an organization with no team, and the
  wizard is resumable — an already-onboarded user is sent straight into the cockpit. Registered
  projects carry an optional `teamId`/`teamName` that Settings → Projects can filter by, and
  **one project root belongs to exactly one organization**, enforced at registration and on
  removal (two processes over one `.ai/cezar` would destroy each other's run history silently).
  A second person who signs in is told they need an invite rather than being walked into a form
  that will refuse them. **With `CEZ_AUTH` unset none of this exists**: no wizard is reachable
  from anywhere, the project listing carries no team fields, and no identity file is created or
  even opened. **CORRECTED 2026-08-07 by D13 (see the "Local-mode onboarding"
  entry below): this no longer describes every `CEZ_AUTH`-unset deployment.** On a loopback bind —
  the npm default — the wizard IS now reachable at `/onboarding`, the project listing CAN carry
  team fields once a local org exists, and the identity file IS created the moment that local user
  completes it. What is unaffected is authentication: no session, no cookie, no 401, ever.
- 🔒 **A fresh authenticated deployment now needs its bootstrap code to be claimed.** The first
  user to name an organization becomes its owner, and an owner can run shell commands on the
  host — so with `CEZ_AUTH=google` the issuer is pinned but the audience is every Google account
  on the internet. While `CEZ_AUTH` is set and no organization exists yet, cezar mints a random
  code at each start and prints it to its own log (`journalctl -u cezar`); the wizard asks for
  it and refuses without it. **Nothing to configure for the default.** Pin your own with
  `CEZ_AUTH_BOOTSTRAP_TOKEN`, or opt back into "whoever signs in first" with
  `CEZ_AUTH_BOOTSTRAP_OPEN=1`. The code stops being printed, and stops granting anything, once
  the organization exists.
- ✨ **Second organizations, invites and team management (phases 5b/5c/8).** `POST
  /internal/orgs` — admin-only, authenticated by `CEZ_SUPERVISOR_ADMIN_TOKEN` — creates the org
  row for every organization after the deployment's first; `server-install --platform hetzner
  --org-slug <slug>` calls it as part of provisioning, closing the gap the two entries above
  describe (isolation fully automated, nothing to put behind it). `bootstrapFirstOrg` is renamed
  `claimOrg`: absent an org id it is unchanged — still the deployment's own self-serve first-org
  bootstrap; given one it is the new claim path — the first person to sign in **at the
  deployment's login host** and enter that organization's slug plus its own per-org claim code
  (never the deployment-wide one the first organization's owner holds) becomes its owner. The
  onboarding screen a membership-less user lands on carries an "I have an organization code"
  disclosure for exactly that, collapsed by default so the common case (wait for an invite) still
  reads as the common case. *(An earlier draft of this entry said "at that org's own hostname",
  which named a host that serves no wizard: an org's own process runs `CEZ_AUTH=supervisor` and
  mounts no `/auth/*` route. The claim is keyed on the slug in the request body plus that org's
  claim-token hash; the hostname is never read.)* A signed-in user with no membership can now be
  invited rather than told to wait on a surface that doesn't exist: `owner`/`admin` create and
  revoke invites (`/auth/invites`), and create, rename and delete teams (`/auth/teams`), so the
  board's team filter can finally hold more than the one default team. Moving a project between
  its org's teams is a new `teamId` field on `PATCH /api/v1/projects/:id`, and — unlike the
  `/auth/teams` verbs beside it — **any member of the org can do it today**, since a team is
  grouping metadata rather than a scope and moving a project between two of them grants and
  removes no access at all. Whether that field should be `owner`/`admin` like the rest of team
  management is recorded as an open question in the spec (D12), not decided by omission. **`role`
  gates org administration and never code
  execution**: `member` still reaches `POST /api/v1/workflows` and every other agent-run surface
  exactly as `owner`/`admin` do, because everyone in an org already shares one unix user and one
  set of agent credentials — a role check in front of code execution would only look like a
  boundary. **What has not changed: none of this has been run against a real, two-organization
  host yet** — QA Needed, see the spec's Verification section.
- ✨ **Local-mode onboarding: the zero-config npm default can now organize projects into
  workspaces, with no sign-in of any kind (D13, phase 9).** Opening `http://127.0.0.1:<port>` for
  the first time — `CEZ_AUTH` unset, loopback bind, the npm default — now offers to create an
  **organization**, then one or more **workspaces** ("Engineering", "Marketing"), through the same
  `/onboarding` wizard and the same `/auth/onboarding*`/`/auth/teams*` routes a real deployment
  uses, gated by whether the bind is loopback rather than by `CEZ_AUTH`. Every already-registered
  project — including the one `cezar serve` booted in — is adopted into the default workspace in
  the same write that creates the org, so the first run never produces an org with an empty
  project list. **This is not an authorization change**: anyone who can reach a loopback port can
  already `POST /api/v1/workflows` and get a shell, so an org here partitions the user's own work;
  it grants nothing and withholds nothing. No session middleware, no cookie, no login route, no
  401 — ever, on this path. A user who never opens the wizard still creates nothing under
  `<CEZ_HOME>/identity` (one `stat`, no `mkdir`); a hosted, `CEZ_ALLOW_UNAUTHENTICATED=1`
  deployment is a different topology and is deliberately NOT eligible — this is keyed on the BIND
  being loopback, never on `CEZ_AUTH` alone, so an intentionally-exposed instance cannot hand
  org-one ownership to the first stranger who reaches it. Local mode stays single-org (creating a
  second is refused, same as hosted) and cannot switch between orgs. Gates (typecheck, full
  `vitest` suite) are green; no real-device/browser E2E has been run for this entry — QA Needed.
- ✨ **The cockpit is now gated on onboarding (D14, owner decision — reverses D13's "decline"
  behaviour above).** No dashboard element — sidebar, nav, banner, command palette — renders until
  the first organization exists; the onboarding wizard is the entire surface until then. This
  applies to every deployment the probe can answer `needs-org` for, local mode included, and is
  keyed on that probe's answer alone, never on a flag or on `CEZ_AUTH`: a hosted, `CEZ_AUTH` unset,
  `CEZ_ALLOW_UNAUTHENTICATED=1` deployment (no `/auth/*` mounted at all) is excluded because the
  probe answers `unavailable` there, not because the gate special-cases it. **The consequence,
  stated rather than left to be discovered:** `npx cezar` used to open straight into a working
  cockpit; it now opens into a mandatory onboarding wall on first launch. That is a deliberate
  product change, not an accident of the auth work. **Not yet done, named rather than implied:**
  D14 also calls for removing D13's "Not now" decline button and its Settings re-entry link as dead
  code, and for a Settings → Account section that surfaces `POST /auth/logout` (unmounted since
  phase 3, with no caller anywhere in the cockpit until now) — neither has landed in this pass.
  QA Needed either way.
- ✨ **Agent accounts: run one project on your work login and another on your personal one.**
  The same CLI logged in twice — `CLAUDE_CONFIG_DIR=~/.claude-klaudiusz claude`, or `CODEX_HOME` for
  Codex — is now something cezar can address. Add the extra config folder under **Settings → Agent
  accounts**, pick which account each project uses in **Settings → Agents**, and override it for a
  single task from the composer. Each account reports its own connection state and gets its own
  **Connect**, and "Open in → Claude CLI" hands the terminal the account that actually ran the
  work, so `--resume` lands on the right conversation instead of silently starting a fresh one.
  Each agent gets its own tab, showing whether it is installed, its version, and its logins.
  **Show details** on a login reveals the email, organization and plan it is signed in as, and
  opens any of that account's own config files — `settings.json`, `CLAUDE.md`, `config.toml`,
  `AGENTS.md` — resolved inside *that* folder rather than the default account's, through the same
  **Open in…** menu the task thread uses, so you can pick the system default or any editor the
  machine has. Identity is opt-in
  by construction: it has its own request, made only when you expand a row, so nothing carries an
  email until you ask.
  Zero-config is untouched: with one login there is no new control anywhere, and no new variable in
  any spawned process. Accounts live in their own `~/.cezar/agent-accounts.json` rather than a key
  in `config.json`, so switching to an older cezar and back cannot lose them — a version that has
  never heard of accounts does not open that file. cezar does not go looking for accounts (a folder
  is one because you said so, and you can type a path that does not exist yet), and it never
  silently falls back to another account when the one you chose is unavailable,
  because that would bill the wrong subscription while the UI said otherwise. OpenCode is not
  supported yet: it keeps credentials outside its config folder, so a second folder would change
  settings without changing the account. Spec: `.ai/specs/2026-07-29-agent-profiles.md`.

## 🔧 Changed
- 🔧 **`GET /api/v1/health` no longer names your repositories to the unauthenticated internet
  when `CEZ_AUTH` is set.** That route is CORS-open and deliberately exempt from the sign-in
  check — the bookmarklet's port sweep runs before any cookie exists — but its `projects[].name`
  list is every registered repository, readable cross-origin by any page. It is now `[]` for a
  request with no valid session on an authenticated deployment; `bootProject` and every other
  field are unchanged, and **with `CEZ_AUTH` unset the payload is byte-identical to before.**
- 🔧 The cockpit's onboarding wizard is code-split, so the zero-config install no longer
  downloads or parses it (≈7 kB off the entry chunk).
- 🔧 **Global settings shows a "Teams" item on every deployment, including the zero-config one,
  where the pane then explains the feature needs `CEZ_AUTH`.** Named here rather than quietly
  fixed: the only way to hide it would be a client-side probe on the auth-off default (the exact
  I/O that default exists to avoid) or a `capabilities.auth` key, which is the one thing the
  spec's Risks section forbids and a test enforces. Everything behind the item is inert — one
  request, no writes, no identity file — and the section's own doc comment records the trade.

## 🐛 Fixes
*(All of the below are in unreleased code — phases 5b/5c/8 and their repair stage — so nothing
here regressed a shipped release.)*
- 🔒 **`cezar supervisor` never printed the bootstrap code, which made a `--platform hetzner`
  deployment's first organization unclaimable.** `cezar serve` printed it; the supervisor did not
  — and on that platform the supervisor is the only process that serves the onboarding wizard. The
  default mode therefore minted a fresh code at every restart, the wizard refused every claim
  without it, and `docs/server-install/hetzner.md` told operators to grep a journal that never
  contained it. The only installs that could be claimed were ones that had pinned
  `CEZ_AUTH_BOOTSTRAP_TOKEN` by hand.
- 🔒 **A mis-aimed organization claim, or an invite redeemed by someone who already belongs
  somewhere, used to be irreversible.** Both paths now refuse with `409` and leave the code or
  invite unspent, instead of burning a single-use credential to produce a membership that grants
  nothing — one project root maps to exactly one organization, so a second membership is inert by
  construction, and there is no member-removal surface yet to undo it with.
- 🔒 **Deleting an organization's last team locked every one of its members out.** Every
  membership resolves through a team, so an organization with zero teams could not be signed into
  by anybody, including its owner, and had no route that could create one. `DELETE /auth/teams/:id`
  now refuses the last team.
- 🔒 **Two `/auth/*` routes parsed and validated an unauthenticated caller's request body before
  checking who they were**, answering `400` with the field-by-field schema instead of `401`. The
  sign-in check is now middleware on both, so the ordering is inherited by any route added later
  rather than re-decided.
- 🔒 **`GET /internal/project-teams/by-root` answered for any organization**, while the `PATCH`
  and `DELETE` beside it were org-scoped — so one organization's per-org secret could read which
  organization owns a given project root, and probe roots outside its own filesystem.
- 🔒 **The org-process registry accepted the same `CEZ_SUPERVISOR_SECRET` for two organizations**,
  which would have let either one's process authenticate as the other. Registration now refuses a
  secret already held by a different org's active record.
- 🐛 A slug that the wire schema accepted but the identity store rejected (`Acme Inc`, `-x`, 400
  characters) answered `500` instead of `400` on team creation and org creation.

# 0.9.2 (2026-08-04)

## ⚠️ Breaking
- **The HTTP API moved to `/api/v1`.** Every route answers under `/api/v1/…` (project-scoped:
  `/api/v1/p/<projectId>/…`) and the WebSocket bus is `/api/v1/ws`; the unversioned `/api/*`
  spelling is gone. The bundled cockpit ships in lockstep, so a normal upgrade needs nothing from
  you — this only matters if you script the API directly, where the fix is adding `/v1`.
  `GET /api/v1/health` is still the CORS-open discovery endpoint, historical run transcripts keep
  rendering (old image URLs are upgraded when read), and saved bookmarklets are unaffected.
  Versioning is what lets the typed client describe the whole surface and makes a future `v2` an
  additive mount rather than an edit to every route.

## ✨ Features
- ✨ **The two mixed-format routes do real HTTP content negotiation.** `GET /api/v1/repo/commit/:sha`
  (legacy text blob or structured commit payload) and `GET /api/v1/runs/:id/files` (JSON listing or
  an image's raw bytes) now honour the request's `Accept` header, answer `Vary: Accept`, and set a
  `Content-Type` confirming what they actually sent. Purely additive: the `?structured=`/`?raw=`
  flags still decide whenever the request carries one, `*/*` (what `fetch` and `curl` send) is read
  as "no preference" and keeps each route's existing default, so every current caller's answer is
  byte-identical. What is new is that a client that really does ask — an `<img>`, a browser
  navigation — gets the other representation without the flag, under the same allowlist, size cap
  and sandbox CSP as before.
- ✨ **Finished tasks now carry a read/unread marker (#767).** A done or failed run you have not
  opened since it finished reads as *unread* — its row is promoted (brighter, semibold) and wears a
  small trailing violet dot — while everything you have already seen dims back. The Tasks nav item
  shows how many are unread, opening a task's thread clears it, and a "Mark all read" sweep clears
  the lot. Unread is a deliberately separate channel from the status dot, which keeps saying
  done/failed, so "what happened" and "have I seen it" never collapse into one signal.

## 🔧 Changed
- Every mutating route is now visible to the typed client, `POST /api/v1/todos/:id/start` included.
  Its body used to be parsed inside the handler to keep "unknown id 404s before the body is
  validated"; a small existence guard registered *before* the body validator keeps that status
  order while the body becomes part of the route type. A bodyless POST still 201s and a malformed
  one still 400s.
- **Validation errors (`400 {error}`) are worded differently and now name the field.** Two causes:
  zod 4 rewrote its default messages (`Required` → `Invalid input: expected string, received
  undefined`), and each issue is now prefixed with its path — `task: must be at most 100000
  characters` where it used to be `task must be at most 100000 characters` for a handful of fields
  and an unattributed sentence for the rest. **The `{ error: string }` shape and the 400 status are
  unchanged**, and the message was never a pinned contract (BACKWARD_COMPATIBILITY.md §2 pins the
  shape, not the text) — but a script matching on the exact wording will need updating, and the
  cockpit shows the new text verbatim in its toasts.
- Every mutating route now validates its body as route middleware rather than inside the handler,
  and the query string / path params of 17 more routes are validated too. Behaviour is unchanged
  by design, including the tolerant cases (a body sent without a JSON content-type, a malformed
  body, and a repeated query key such as `?refresh=1&refresh=1`, which still takes the first
  value). The point is that the typed client can now check request bodies, params and queries at
  compile time.

## 🐛 Fixes
- 🐛 **Running the test suite no longer wipes your project registry.** A merge-write resolved
  `~/.cezar/config.json` twice — once to read, once to write, after the `await` — and
  `cezarHomeDir()` re-reads `CEZ_HOME` on every call, so a test that lost its sandbox pin
  mid-flight (a timeout was enough) read the temp home and wrote the real one, replacing every
  project with the fixture's. The path is now resolved once per merge-write, the whole server
  suite runs with `CEZ_HOME` pinned to a per-worker sandbox, and a write into the real `~/.cezar`
  from a vitest process is refused outright. The same one-path fix lands in the `ui-state.json` twin.
- 🐛 **The registry survives a lost config file.** Every merge-write that leaves projects behind
  also writes `~/.cezar/config.json.bak`, and cezar restores from that snapshot when the config
  file is missing, empty, or corrupt. Removing `~/.cezar` still resets cezar completely; removing
  only `config.json` no longer loses the project list. A config that parses and is simply empty is
  left alone — that is a user who removed their last project, not a lost registry.
- 🐛 **Structured questions render as a form, not raw JSON (#757).** When an agent asked a
  structured question, the Ask card could fall back to printing the raw JSON payload; it now renders
  the real question with its options, and long question text wraps instead of overflowing.
- 🐛 **Subagent sessions render like the main thread (#756).** A subagent's transcript now goes
  through the same session renderer as the top-level thread, so its messages, tools and reasoning
  look identical instead of a stripped-down variant.
- 🐛 **The task diff stat stops counting a repointed HEAD's branch (#751).** When a task's worktree
  HEAD was repointed onto another branch, the ± diff stat folded in that branch's whole history; it
  is now anchored at HEAD so it counts only the task's own changes, and the Changes tab says so when
  a repointed HEAD has narrowed what it shows.

# 0.9.1 (2026-07-24)

## Highlights
A stabilization release that hardens single-project mode and sharpens the cockpit. Project edits and the registry are now correctly gated and isolated when `CEZ_SINGLE_PROJECT` is set (#625, #626), the diff and task commit list are virtualized for snappier scrolling on large runs (#599), and browser tabs finally carry project-aware titles (#543). Codex sessions read more clearly with labeled image-view tool calls and context compaction (#593, #596), while streamed deltas coalesce into whole text events (#633). A batch of run-fidelity fixes keeps task titles, issue-number provenance, and tool issue links accurate (#623, #539, #538).

## ✨ Features
- ✨ Project-aware browser page titles (fixes #543). (#592) *(@pkarw)*

## 🐛 Fixes
- ⚡ **Settings → Agent accounts opens instantly.** The account listing used to probe every agent's
  login while you waited — one CLI shell-out per agent plus one per account, 2.5s on a machine with
  four accounts. Which login an agent uses is operating knowledge that changes only when you run
  `claude auth login`, so cezar now warms every account — extra logins included — once at boot and
  keeps it in memory instead of re-probing every few seconds; the listing serves what it holds and never spawns anything (the rule
  `/api/v1/health` already follows). A *disconnected* answer is still re-checked within seconds,
  because that one blocks starting a run — so logging in from a terminal is not punished with a
  ten-minute wait. Same machine, same accounts: 2.5s → 12ms.
- **An added agent account can now be signed in from cezar.** The account row grows Connect and
  Check again; Connect opens a terminal aimed at that account's config dir rather than the default
  one. Previously the pane pointed at a Connect button that did not exist.
- **A task now says which agent, account and model produced it**, as text in the header
  (`claude · Klaudiusz · opus`) rather than hidden behind an icon; the account is the one the step actually spawned under, so a resumed
  task reports the login that owns its session rather than whatever the project is set to now.
- ✨ **Settings → Agent accounts now sets the default agent, account and models once, not per repo.**
  A project that has chosen nothing now follows the machine-wide default — and a project that HAS
  chosen is never moved by changing it, so a global tweak cannot quietly re-point work you already
  configured. Models merge per agent, so pinning one repo's Claude model keeps the machine's Codex
  preset.
- **Settings → Agents picks the default agent and its account in one click.** "Default runner" and
  the separate account picker were two fields answering one question; they are now a single flat
  list — `claude · Default`, `claude · Klaudiusz`, `codex` — matching the composer. The runner still
  goes to the repo's committable config and the account to your machine only, so a teammate keeps
  their own. With no extra logins it is the control it always was.
- **The composer's runner pill now lists agents and logins as one flat list** — `claude · Default`,
  `claude · Klaudiusz`, `codex` — instead of a separate account pill beside it. Every row is a
  concrete thing that can run the task, so which subscription it will bill is readable without
  opening anything. It starts on whatever the repo is set to and any row overrides it for that task
  alone. An agent with one login stays one row, so a machine with no extra accounts sees the list it
  always saw.
- **fix(server): `GET /api/v1/providers/status` no longer stalls for ~1–3s whenever its cache
  lapses.** It shares the same knowledge as the accounts listing and had the same problem from the
  other side: any provider you are not signed into pulled the whole response onto a five-second
  window, so one reader in every five seconds paid for three CLI spawns. Reads are now
  stale-while-revalidate (what `/api/v1/health` already does) and the run gate re-checks a provider
  before refusing to start a run, instead of the cache being kept young to protect it. Measured on
  the built server: reads that alternated between 3ms and 817ms are now 1–7ms across every cache
  window, while "Check again" (`?refresh=1`) still blocks for the real answer.
- 🐛 **`CLAUDE_CONFIG_DIR` is honoured.** A host that relocates Claude Code's config folder was
  invisible to the Agent config pane, which kept showing `~/.claude`. Related: the MCP listing read
  `~/.claude.json` from the wrong place under an override — that file is a *sibling* of the default
  folder but lives *inside* a relocated one.
- 🐛 **`CEZ_CLAUDE_BIN` counts as "installed".** The environment probe hardcoded a bare `claude`,
  unlike every other call site, so a host whose only install is at a custom path reported Claude as
  missing — dropping it from the composer and the installer's dependency step even though runs
  would have worked.
- ⚡ Virtualize the diff and the task commit list. (#599) *(@patzick)*
- 🐛 Repair concatenated task titles (fixes #623). (#627) *(@pkarw)*
- 🐛 Prevent single-project registry leak (fixes #626). (#629) *(@pkarw)*
- 🔐 Gate project edits in single-project mode (fixes #625). (#630) *(@pkarw)*
- 🐛 Label Codex image view tool calls (fixes #593). (#631) *(@pkarw)*
- 🐛 Keep the composer's runner and model aligned. (#632) *(@pkarw)*
- 🔄 Coalesce codex/opencode streamed deltas into whole v1 text events. (#633) *(@pkarw)*
- 🐛 Link per-project resource limits (fixes #634). (#635) *(@pkarw)*
- 🐛 Preserve task title message boundaries. (#636) *(@pkarw)*
- 🐛 Label Codex context compaction (fixes #596). (#639) *(@pkarw)*
- 🐛 Avoid boot slug collisions (fixes #558). (#641) *(@pkarw)*
- 🐛 Track issue number provenance (fixes #539). (#642) *(@pkarw)*
- 🐛 Keep tool issue links display-only (fixes #538). (#643) *(@pkarw)*
- 🐛 Auto-refresh the team-repo cache so codex reviews use current skills. (#644) *(@pkarw)*

## 📝 Specs & Documentation
- 📝 Document `CEZ_SINGLE_PROJECT` mode. (#597) *(@pkarw)*

## 🚀 CI/CD & Infrastructure
- 🚀 Pin `CEZ_HOME` in specs that boot their own server. (#619) *(@pat-lewczuk)*
- 🚀 Cover detached launcher lifecycle (fixes #574). (#640) *(@pkarw)*

## 👥 Contributors

- @pkarw
- @patzick
- @pat-lewczuk

# 0.9.0 (2026-07-21)

## Highlights
<!-- TODO: Highlights — auto-update-changelog leaves this blank for the human author to fill in. -->

## ✨ Features
- ✨ Edit the coding agents' own config files (global vs local, raw + highlighted). (#418) *(@pkarw)*
- ✨ Canonical provider/model identity shared across runners (fixes #405). (#466) *(@pat-lewczuk)*
- ✨ Runner + model selection for the Continue flow (fixes #401). (#468) *(@pat-lewczuk)*
- ✨ AskUser structured questions across claude, codex & opencode (fixes #473). (#502) *(@pkarw)*
- ✨ Multi-project workspace — per-user registry, project-scoped cockpit, config migrations (fixes #520). (#521) *(@pkarw)*
- ✨ Discover PR/issue refs from skill report lines and GitHub links. (#534) *(@pkarw)*
- ✨ Grouped sub-agent display — Agents dock + drill-down sheet (fixes #474). (#550) *(@pkarw)*
- ✨ Render full timeline (commits, labels, merges) with per-commit CI markers (fixes #525). (#552) *(@pkarw)*
- ✨ Stack, edit and remove prompt messages on a queued run (fixes #472). (#553) *(@pkarw)*
- ✨ Link clone root to project settings (fixes #561). (#571) *(@pkarw)*
- ✨ Separate browse and checkout roots. (#572) *(@pkarw)*

## 🔒 Security
- 🔒 Guard the localhost API against CSRF and DNS rebinding (fixes #426). (#467) *(@pat-lewczuk)*

## 🐛 Fixes
- 📦 Never push a release commit to protected main. (#514) *(@pat-lewczuk)*
- 🔄 Stop GitHub nav item flickering — stale-while-revalidate forge probe. (#516) *(@pat-lewczuk)*
- 🔄 Resolve a stale local base ref to `origin/<base>` to stop phantom diffs. (#518) *(@pat-lewczuk)*
- 🐛 Skill pickers order most-used → project → global (fixes #519). (#523) *(@pkarw)*
- 🐛 Label Skill and Agent tool rows in the Session tab (fixes #529). (#532) *(@pkarw)*
- 🐛 Name the autosave trigger in the commit subject + refuse conflicted trees (#471). (#533) *(@pkarw)*
- 🐛 Keep reasoning text alive across replay and drop empty "Thinking" rows (fixes #528). (#536) *(@pkarw)*
- 🐛 A custom hand-off prompt extends the item context instead of replacing it (fixes #524). (#541) *(@pkarw)*
- 🐛 Preserve thinking across resumed steps (fixes #556). (#564) *(@pkarw)*
- 🐛 Isolate cross-backend continuation sessions (fixes #562). (#566) *(@pkarw)*
- 🔐 Default to full permissions (fixes #563). (#568) *(@pkarw)*
- 🔄 Refresh checkout root after save (fixes #567). (#569) *(@pkarw)*
- 🐛 Make picker tiers deterministic (fixes #555). (#570) *(@pkarw)*
- 🐛 Render reasoning snapshot arrays. (#573) *(@pkarw)*
- 🐛 Show queued task references immediately (fixes #554). (#578) *(@pkarw)*
- 🐛 Bridge subagents and native questions (fixes #565). (#579) *(@pkarw)*
- 🐛 Scope subtasks by session id (fixes #551). (#587) *(@pkarw)*

## 📝 Specs & Documentation
- 📝 Multi-project workspace — per-user `~/.cezar` registry, project-scoped cockpit, config migrations. (#517) *(@pkarw)*
- 📝 Grouped sub-agent display within a single session. (#522) *(@pkarw)*
- 📝 GitHub tab timeline events (commits, labels, merges) + per-commit CI markers. (#527) *(@pkarw)*
- 📝 Worktree file editing from the Files tab (#530). (#531) *(@pkarw)*
- 📝 Stack, edit and remove prompt messages on a queued run. (#537) *(@pkarw)*
- 📝 Correct the linting constraint — oxlint, not typescript-eslint. (#560) *(@patzick)*
- 📝 Discover latest Codex models. (#585) *(@pkarw)*

## 🚀 CI/CD & Infrastructure
- 🚀 Migrate to TypeScript 7 (native compiler). (#559) *(@patzick)*

## 👥 Contributors

- @pkarw
- @pat-lewczuk
- @patzick
