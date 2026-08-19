# Non-disruptive cezar self-deploy / update

**Status:** draft (not implemented)
**Date:** 2026-08-19
**Owner ask:** "ensure that we can deploy/update cezar itself without any disruption."

## TLDR

Deploying a new cezar version to the production host today is a **hard
`systemctl restart cezar.service`**. Because the unit runs `KillMode=control-group` and every
agent run is a child process in that cgroup, a deploy **kills every in-flight run** — and the
deployer itself when it runs on-box (observed live 2026-08-19: the session performing the deploy
was pid 1441357 inside `cezar.service`'s own cgroup). The cockpit's SSE/WS also drop and the
single `--port-strict` port means there is an unavoidable bind gap. This spec makes a
version update safe to run at any time, with no killed runs and no visible cockpit outage.

## Problem — what "disruption" concretely is today

Measured on `prod-host` (Hetzner CX43), 2026-08-19:

- **Unit:** `cezar.service`, `ExecStart=/usr/bin/node /opt/cezar/packages/cezar/dist/index.js
  serve --no-open --bind-host 127.0.0.1 --port 4321 --port-strict`,
  `WorkingDirectory=/var/lib/cezar/workspace`, `KillMode=control-group`, `Restart=on-failure`.
- **Perimeter:** nginx vhost → `proxy_pass http://127.0.0.1:4321` (WebSocket upgrade wired),
  Cloudflare Access in front.
- **Deploy command:** `cezar server-deploy` → `hetzner.redeploy()` = `systemctl daemon-reload &&
  systemctl restart <unit>` then `confirmListening` + a `verifyStep` probe
  (`packages/cezar/src/server-install/platforms/hetzner.ts:1184`). It **restarts**; it does not
  itself deliver code to `/opt/cezar`.
- **State:** plain JSON / NDJSON / Markdown under `.ai/cezar/` — survives a restart.

Five disruption vectors follow from that:

1. **Runs die on restart.** Each agent run is a `claude`/`codex` child in the service cgroup;
   `KillMode=control-group` SIGKILLs the whole tree. A deploy mid-run loses that run's live
   process (its persisted state survives, but the running work does not).
2. **The on-box deployer dies too.** Anything triggering the deploy from inside the cockpit
   (an agent task, this session) is in the same cgroup and is killed mid-cutover — so the
   deploy cannot even report its own success.
3. **HTTP/SSE/WS cutover gap.** `--port-strict` + one port means the new instance cannot bind
   `4321` until the old process has released it; every open `/api/v1/events` and `/api/v1/ws`
   stream drops and in-flight HTTP requests abort.
4. **Code delivery is unmanaged.** `/opt/cezar` is a plain built tree (not a git checkout), with
   no atomic release swap and no rollback path — a half-copied `dist` can be started.
5. **No readiness gate / rollback.** `verifyStep` runs *after* the restart, so a broken build is
   already serving (or crash-looping under `Restart=on-failure`) before it is caught.

## Solution

Four independent, individually-shippable changes. Phase 1 removes the worst harm (killed runs)
and is worth doing even alone; Phases 2–4 make the HTTP layer and the release truly seamless.

### Phase 1 — Detach run processes from the server cgroup (biggest win)

Launch each agent run in its **own** transient scope / dedicated slice
(`systemd-run --scope --slice=cezar-runs.slice …`, or `Delegate=yes` with a per-run child
cgroup), not as a bare child of `cezar.service`. Then restarting the HTTP server no longer
touches running agents. On boot the server **re-attaches** to still-live runs from the persisted
`.ai/cezar/` state + a per-run pidfile, resuming the SSE stream. Deliverable: a restart during an
active run leaves the run running and its output intact.

### Phase 2 — Zero-downtime HTTP cutover (blue-green behind nginx)

nginx is already the perimeter, so use it. Run two instances on two ports (e.g. 4321 / 4322).
Deploy: start the new release on the idle port → health + readiness gate → **`nginx -s reload`**
(graceful: nginx drains existing upstream connections onto the old instance and routes new ones
to the new) → stop the old instance once its connections have drained. Cutover gap at the client
= 0. (Alternative considered: systemd socket activation with a shared listening socket that
survives restarts so connections queue during the swap — rejected as second choice because nginx
already fronts the service and gives us health-gated flips and instant rollback for free.)

### Phase 3 — Atomic release + instant rollback

`/opt/cezar` becomes a symlink → `/opt/cezar/releases/<version-or-sha>`. Deploy builds/stages a
new release dir off the live path, then flips the symlink atomically. Keep the last N releases;
rollback = flip the symlink back + reload — seconds, no rebuild.

### Phase 4 — Self-safe, health-gated deployer

Run the deploy as a **transient unit outside** `cezar.service`'s cgroup (`systemd-run`), so
cutting over or restarting the service never kills the deployer (fixes vector 2 — the bug this
spec was written from). Gate the traffic flip on a real readiness probe (deeper than `/health`);
**fail closed** — if readiness fails, never flip, and auto-rollback the symlink. `server-deploy`
grows a `--strategy=blue-green` path that runs this sequence; the current restart stays as
`--strategy=restart` for the single-user local case where a blip is fine.

## Data models / interfaces

- `cezar-runs.slice` (new) — cgroup slice owning all run scopes, never restarted by a deploy.
- `/opt/cezar/releases/<id>/` + `/opt/cezar → current` symlink; a `releases.json` ledger
  `{current, previous, releases: [{id, builtAt, version, sha}]}`.
- Per-run pidfile + the existing `.ai/cezar/` run record, enough to re-attach after a server
  restart.
- `server-deploy --strategy=blue-green|restart` (default stays `restart` until Phase 2 lands).

## Risks

- **Run re-attach correctness.** The server must reliably re-adopt a detached run and its stream;
  a missed re-attach orphans a running agent. Mitigate with a pidfile + liveness check + a
  reconcile pass on boot.
- **Two instances, one state dir.** During cutover both instances share `.ai/cezar/`. cezar uses
  a single-writer lock; blue-green must ensure runs stay owned by the instance that spawned them
  and that append-only NDJSON stays safe for a concurrent reader. Define ownership explicitly.
- **nginx reload race.** The upstream flip and drain must be ordered so no request lands on a
  stopped instance; stop the old instance only after `reload` + a drain delay.
- **Cloudflare Access / auth continuity.** The perimeter must treat both ports identically.

## Verification (plan the test up front)

- **E2E, the acceptance test:** start a long-running agent task, trigger `server-deploy` mid-run,
  assert (a) the run process survives and completes with its steps intact, (b) the cockpit's SSE
  reconnects within its backoff with **zero lost events** (seq dedup proves it), (c) HTTP cutover
  gap measured at the client = 0, (d) the deployer process survives to report success,
  (e) a forced-bad build never flips traffic and auto-rolls-back. Record video/artifacts.
- **Unit:** release symlink flip + rollback ledger; run-scope launch + boot re-attach reconcile.
- **Gates:** typecheck / lint / test green.

## Analytics (name the events now)

`deploy.started`, `deploy.release_built`, `deploy.instance_ready`, `deploy.cutover`
(`gap_ms`, `inflight_runs`), `deploy.drained`, `deploy.rollback` — each with `version`, `sha`,
`strategy`. The `inflight_runs` at cutover and `gap_ms` are the numbers that prove "non-disruptive."

## Out of scope

- Multi-host / horizontal scale-out (this is one box).
- Changing the state format; all of the above works on the existing JSON/NDJSON/Markdown.
