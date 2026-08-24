# Non-disruptive cezar self-deploy / update

**Status:** **QA Needed — REOPENED 2026-08-21 19:05 UTC.** This line read *"Done 2026-08-21 — both acceptance criteria measured"* and **criterion 1 does not hold on the blue-green cutover path**: a controlled re-measurement found the run RE-LAUNCHED, not re-attached. Criterion 2 stands. See "Criterion 1 was reopened by a controlled re-measurement". — **and NOT a prerequisite for anything**
release `20260821T183127Z-be3aab61` since 2026-08-21 18:31:54 UTC (first cutover was
`20260821T181100Z-ad0b5f17` at 18:11:08). **Criterion 1 (a deploy mid-run leaves the run alive and
streaming) is MET, measured.** **Criterion 2 (cutover gap = 0) is MET at the listener** — 3790
fresh connections across a restart, zero refused — **with two residual costs that are recorded, not
rounded up**: an intermittent keep-alive reset (3 in 4864 requests over 5 restarts) and ~1.1 s
worst-case latency. **CORRECTED 2026-08-24: SSE continuity is now measured, but not green.** A
credentialed 2026-08-23 cutover observed 2,164 SSE events, one reconnect, and 55 run samples; the
probe correctly failed on one refused connection and 94 sequence gaps. The sequence gaps remain
unexplained (`8206c158`) and the reset/latency cost remains open (`6c89af7c`). See "Status log —
2026-08-21 (18:31–18:41 UTC)" below for the historical unauthenticated runs. **NOT a prerequisite
for anything.**

> **CORRECTED 2026-08-21** — this header previously read *"Still QA Needed: the acceptance E2E
> probe has never been run, so neither acceptance criterion has been measured."* That was true when
> written at ~18:20 UTC and false about ninety minutes later; the probe has now been run four times
> across five real cutovers. The falsehood was in the status line itself, which is what every
> reader scans first, so it is amended here rather than appended to.

> **CORRECTED 2026-08-23** — this header previously read *"**SSE continuity remains unmeasured**
> (the API is behind OIDC; no static token on the box)."* That was true until a credentialed
> production cutover on 2026-08-23 finally exercised the SSE assertions on real data —
> `sse.events = 2164`, `sse.reconnects = 1`. See "Status log — 2026-08-23" below for the measured
> table and its caveat. **This measurement was taken against code on the unmerged branch
> `cez/3ee1ebf0`** (`.ai/specs/2026-08-22-deploy-e2e-probe-measured-assertions.md`, added to
> `origin/main` 2026-08-24 as a documentation-only record — its code is not merged), deployed
> directly to `prod-host` for that one run, not against what the probe on `origin/main` ships
> today. `origin/main`'s own shipped fix (`83ddbdd2`, see
> `.ai/specs/2026-08-22-deploy-e2e-probe-vacuous-pass.md`) stops the vacuous PASS but has no
> `--project` flag, so it still cannot reach this box's project-scoped run routes to reproduce this
> measurement — that gap stays open until `cez/3ee1ebf0` is unblocked (todo `96a25516`) and merged.
> This also closes out the "filed as `06a170b8`" / "Filed as `e36b79c0`" / "Filed as `8dc8bf3a`"
> citations in the status logs below: those three (consolidated onto `8dc8bf3a`, per
> `specs-547bad8b140a`) are now `done`. The keep-alive/latency defect `6c89af7c` is unaffected and
> stays open.
**Date:** 2026-08-19, rewritten 2026-08-20
**Owner ask:** "ensure that we can deploy/update cezar itself without any disruption."
**Todo:** `d0386413-8bac-4e2a-88c4-62c37ab87ea1`
**KB:** `specs-594acc539b36` (this file), `docs-1e87e5c94420` / `docs-bc62ccfc8fdf` (remote-access
docs), `notion-2fea4573209f` (the `cockpit.example.com` deployment record)

> **Amended 2026-08-20 — this spec no longer gates self-deploy.** It was once cited as the thing
> cezar had to wait for before deploying itself from a running session. That rule is withdrawn
> (owner instruction 2026-08-20): **cezar always self-deploys**, see `AGENTS.md` §"Always
> self-deploy". The interruption this spec describes is real but survivable — restart-continuation
> (`.ai/specs/2026-08-20-chain-integrity-restart-and-continuation.md`) resumes the deploying run and
> any foreign run in flight, and a full unattended self-deploy was verified on 2026-08-20
> (`8a34f20d`, ~5s outage). What remains below is a genuine *quality* improvement — shrink the gap
> to zero — not a blocker. Do not cite it as a reason to defer a deploy.

---

## Status log — 2026-08-21: deployed, rootless, and brokering real runs

The box was provisioned at **18:08–18:11 UTC** and the first blue-green cutover ran at **18:11:08
UTC**. The provisioning decisions (why `/opt` became `root:cezar 2775` rather than the symlink
moving a level deeper, the scoped polkit rule, and what is deliberately still root-bound) are
recorded in the corpus as **`cezar-prod-rootless-deploy-provisioning`** — read that before changing
anything about the host side. This section records only what is *true of the box now*, each row
re-measured on 2026-08-21 ~18:20 UTC rather than copied forward.

**Live and verified:**

| What the spec asked for | Measured |
| --- | --- |
| P1 atomic release + ledger | `/opt/cezar` → `/opt/cezar-releases/20260821T181100Z-ad0b5f17` (a symlink, no longer a directory); `/opt/cezar-releases/deploy.json` holds `current`, `previous`, and `healthy: true` |
| P3 socket activation | `cezar.socket` active; `runtime.socketActivated: true` |
| P3 drain-capable unit config | `systemctl show cezar.service` → `KillMode=process`, `Delegate=yes`, `TimeoutStopUSec=30s` (drop-in `40-non-disruptive.conf`, plus `cezar-runs.slice`) |
| P4 run broker | `runtime.brokerAvailable: true`, `brokeredBackends: ["claude"]`, **CORRECTED 2026-08-22: `runBrokerIsolation: "scope"`** since 2026-08-21T20:48Z — the `probeUserScope`/`userScopeEnv` fix (`fde2dae8`, `cf334d89`) closed the `XDG_RUNTIME_DIR` gap that produced the value below; live evidence and the disjoint-cgroup proof are in `.ai/specs/2026-08-22-broker-scope-isolation-full-stop-survival.md`. Original text, kept unchanged: ~~`runBrokerIsolation: "delegated"` — **not** `"none"`~~ |
| P5 readiness gate | `GET /api/v1/ready` → 200 |
| Deploy identity in-band | `health.deploy` = `{releaseId, version 0.10.0, sha ad0b5f17…, activatedAt}` |

**The broker is not a lab result — it is carrying production traffic.** The session that wrote this
section is itself brokered: `run-broker --spool …/7c2dd8f0-….spool --run 7c2dd8f0… --step document`,
executed out of `/opt/cezar-releases/20260821T181100Z-ad0b5f17`, with the run record carrying
`spoolDir` and a live `consumedOffset`. P4 is exercised by every claude run on this box now.

**Deploys no longer need root, and the grant is narrow — established by negative control, not by
reading the rule.** As the `cezar` service user: `systemctl start cezar.socket` → exit 0;
`systemctl start cloudflared.service` → *"Access denied … requires interactive authentication"*.
The polkit rule grants `manage-units` on `cezar.service`/`cezar.socket` and nothing else.

**What is still NOT measured, and is therefore what keeps this QA Needed:**

1. **SUPERSEDED 2026-08-21 by the status log below — the probe has now been run.** Original text,
   kept unchanged: ~~"Neither acceptance criterion has been probed. `deploy-e2e-probe.mjs` has never
   been run — there is no verdict artifact anywhere on the box … *designed for* and *plausible*, not
   *demonstrated*."~~ Verdict artifacts now exist at
   `.ai/cezar/tmp/7c2dd8f0-e53e-4e88-b4b3-b382c592bb12/deploy-e2e{,-2,-3}.json`. What genuinely
   **CORRECTED 2026-08-24:** the narrower gap was subsequently measured with a credentialed probe.
   It observed 2,164 SSE events across one reconnect and 55 run samples, and honestly failed on
   one refusal and 94 sequence gaps. The original unauthenticated runs remain useful negative
   evidence: their `(c)` assertions passed *vacuously* on zero events.
2. **`gapMs: 50` in the deploy log is not the client-visible gap.** It is the deployer's own number
   for its own restart window. Socket activation is what actually closes the client-visible gap,
   and only the probe measures that. Do not quote the first as the second.
3. **CORRECTED 2026-08-21 — the bad-build gate HAS now been exercised; the post-flip branch has
   not.** Original text, kept unchanged: ~~"Auto-rollback has not been exercised on this box. No
   deliberately broken build has been put through the health gate here."~~ A deliberately broken
   `dist/index.js` was put through it: `smoke_boot` failed, the ledger marked
   `20260821T183255Z-deadbeef` `healthy: false`, and **nothing was flipped and nothing was
   restarted** — live release and MainPID unchanged, `/api/v1/ready` still 200. That is the
   fail-closed branch. The *other* branch — a candidate that passes smoke boot but fails readiness
   after the flip, so `runGatedDeploy` flips back on its own — is still unexercised, because the
   smoke gate correctly fires first. The explicit `--rollback` machinery it shares was exercised
   separately (three flips, all healthy).
4. **A deploy driven from inside an agent task still fails** (recorded in
   `cezar-prod-rootless-deploy-provisioning`): `buildSystemdRunArgv` shells out to *system*
   `systemd-run`, which is denied to `cezar` — and must stay denied, since a system transient unit
   runs as root. An operator/ssh-driven deploy works unprivileged because that shell is not in the
   unit's cgroup. `decideReExec`'s reason string still hardcodes `KillMode=control-group`, which is
   stale on this box.

   **CORRECTED 2026-08-21 — an agent CAN drive a deploy here; it just must not use a *system*
   transient unit.** The claim above ("a deploy driven from inside an agent task still fails") is
   withdrawn: this box has `Linger=yes` and a live `user@999.service`, so a **user** transient unit
   works unprivileged and sits at `/user.slice/…`, where `decideReExec` correctly reports "not
   inside cezar.service's cgroup" and runs the deploy inline. The `be3aab61` cutover was driven
   exactly this way, from inside an agent task:

   ```bash
   export XDG_RUNTIME_DIR=/run/user/999 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/999/bus
   systemd-run --user --unit=cez-deploy-<sha> --collect --property=Type=oneshot \
     --property=TimeoutStartSec=900 --working-directory=/var/lib/cezar/loki-labs/cezar \
     --setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
     /usr/bin/node packages/cezar/dist/index.js server-deploy --strategy=blue-green \
     --source=/var/lib/cezar/loki-labs/cezar --sha=<sha>
   ```

   System `systemd-run` stays denied, and must — that unit would run as root.

Tracked as todo `a025f99a`, whose ROOT-NEEDED half and whose probe half are both now done.
Three defects the acceptance run exposed are filed separately: `f97ddd39` (bare `--rollback` dies in
argv parsing), `6497f002` (`runRollback` never probes readiness), `6c89af7c` (keep-alive reset race
+ ~1.1 s cutover latency).

---

## Status log — 2026-08-21 (18:31–18:41 UTC): the acceptance E2E, measured

Run with `packages/cezar/scripts/deploy-e2e-probe.mjs` across **five real cutovers** on
`prod-host`: one blue-green deploy (`be3aab61`), three explicit `--rollback` flips, one plain
`systemctl restart`. Raw verdicts: `.ai/cezar/tmp/7c2dd8f0-…/deploy-e2e{,-2,-3}.json`.

### Criterion 1 — "a deploy mid-run leaves the run alive and streaming": **MET**

Measured on the deploying session itself, which was brokered (`run-broker … --step deploy`, pid
206399, with `claude` pid 206440 as its child):

| | Before cutover | After cutover |
| --- | --- | --- |
| server `MainPID` | 188115 | **212609** (replaced) |
| broker pid | 206399 | **206399** (unchanged, re-parented to PID 1) |
| spool `out.ndjson` | 338 281 B | 365 641 B, **prefix sha256 identical** |
| run transcript `.ndjson` | 6 315 788 B | 6 337 618 B, **prefix sha256 identical** |

Byte-identical prefixes are the assertion that matters: the stream was neither truncated nor
rewritten, so the re-attach resumed at the recorded offset with no gap and no duplicate. The run
stayed alive across all five cutovers and is what wrote this section.

### Criterion 2 — "HTTP cutover gap = 0": **MET at the listener**, with two residual costs

The decisive test separates a *listener* gap from a *client* artifact, because the keep-alive probe
alone cannot tell them apart:

| Prober | Requests | Failed (non-2xx) | Connect errors |
| --- | --- | --- | --- |
| **fresh TCP connection per request** (tests the listener) | **3790** | 0 | **0** |
| keep-alive `fetch`, 10 rps, 5 restarts | 4864 | **0** | 3 |

Socket activation holds the listening fd exactly as designed — **a client connecting during a
cutover is accepted, never refused.** Two costs remain and are deliberately not rounded away:

1. **Keep-alive resets: 3 in 4864 requests** across five restarts (zero in the final run). `fetch`
   dispatching onto a pooled connection to the old process at the instant it closes. The drain's
   `Connection: close` is meant to prevent this; a residual race survives. Filed `6c89af7c`.
2. **~1.1 s worst-case latency** — 1097 / 1106 / 1164 ms across three independent runs (p50 3 ms,
   p99 26–38 ms). Connections queue in the socket backlog while the new instance boots. "Gapless"
   here means *nothing is refused or lost*, not *nothing waits*.

**A false lead, recorded so it is not re-derived.** The first run's two refusals lined up with the
two rollback restarts, which looked like "the rollback path skips the drain". A controlled re-run
refuted it: one rollback restart refused nothing, and the plain restart refused nothing across 3790
fresh connections. It is an intermittent client-side race, not a property of the rollback path.

### What the acceptance run exposed

Three defects, all filed, none fixed in the deploy step: **`f97ddd39`** — bare `--rollback` dies in
`parseArgs` though the help advertises `--rollback[=<id>]` (use `--rollback=`); **`6497f002`** —
`runRollback` flips and restarts but never probes readiness, so a rollback onto a dead release
prints "Deploy complete"; **`6c89af7c`** — the keep-alive race and cutover latency above.

**CORRECTED 2026-08-22 — `6497f002` is fixed, `f97ddd39` and `6c89af7c` are not.** `runRollback`
now probes `/api/v1/ready` after the restart and reports failure distinctly (commit `2f91de4b`,
merged to `origin/main` at `c31af208`; spec `.ai/specs/2026-08-22-rollback-readiness-gate.md`,
status IMPLEMENTED QA Needed — its own runtime E2E, §5, has not run yet). The other two defects in
this paragraph are unaffected and still open.

Two traps worth carrying: `gapMs` in the deploy log (55 ms here) is the **deployer's own** restart
window, not the client-visible gap; and `deploy.drained` is only a terminal event name at the end of
a successful deploy, **not** an actual drain step.

Release `20260821T183255Z-deadbeef` is left in the ledger marked `healthy: false` — it is the
deliberately-broken candidate from the bad-build test, kept as evidence. It is unreachable by
`--rollback` (`previous` is `ad0b5f17`) and `keep: 5` will not prune it yet.

---

## Status log — 2026-08-23: SSE continuity finally measured, and it failed

**This measurement required code that is not on `origin/main`.** The probe's `c:`/`a:` assertions
used to read `PASS` on zero observations, because `gaps.length === 0` and `[].every(...)` are both
vacuously true on an empty array — fixed on `origin/main` by `83ddbdd2`
(`.ai/specs/2026-08-22-deploy-e2e-probe-vacuous-pass.md`). That shipped fix closes
`06a170b8` / `e36b79c0` / `8dc8bf3a` (consolidated onto `8dc8bf3a`, now `done`), but has no
`--project` flag, so it cannot reach this box's project-scoped run routes at all. The run below used
a further fix — session-cookie credential plus `--project` — designed and validated in
`.ai/specs/2026-08-22-deploy-e2e-probe-measured-assertions.md` (task
`3ee1ebf0-0d78-4cda-b50d-af6dff78910b`), whose code lives only on the unmerged branch
`cez/3ee1ebf0`, deployed directly to `prod-host` for this one measurement. That branch remains
blocked from merging by an unrelated typecheck break (todo `96a25516`); until it lands, this
measurement cannot be repeated from what the probe on `origin/main` actually ships.

**A credentialed run across a real cutover, for the first time.** Release
`20260823T194110Z-9c65f9e9` (blue-green), probed with a session cookie and `--project cezar`,
artifact `.ai/cezar/artifacts/deploy-e2e-20260823194023.json` (retained in that task's worktree):

| assertion | verdict | sample |
| --- | --- | --- |
| `b: zero failed HTTP requests` | passed | 544 |
| `b: zero refused connections` | **failed** | 544 (1 refusal — the same boot-window cost as `6c89af7c` above, not a new mechanism) |
| `c: no seq gaps` | **failed** | 2164 (94 gaps across the 1 reconnect — measured for the first time; see caveat below) |
| `c: no seq duplicates` | passed | 2164 |
| `a: run never left running` | passed | 55 |
| `a: no interrupted event` | passed | 2174 |

Overall `verdict=failed exit=1`. **This is the fix working, not a regression** — the point of the
whole prior effort was that this assertion had never actually run before.

**The 94-gap number needs a caveat, not a headline.** Two same-session runs with **zero**
reconnects (`deploy-e2e-20260823193705.json`: 73 gaps in 2116 events; `deploy-e2e-20260823193836.json`:
82 gaps in 2147 events) show a comparable raw gap rate to the reconnect run's 94-in-2164, even
though their `c:` assertions correctly stayed `not-measured` (no reconnect in the window, per the
probe's own reconnect-gate). So a ~3.5% raw seq-gap rate appears present whether or not a deploy
cutover happens in that window — it is **not yet established** that the reconnect run's gaps are
cutover-caused event loss rather than a pre-existing property of how `/api/v1/runs/:id/events`
allocates `seq` numbers. Tracked as a new, distinct follow-up: todo `8206c158`. **Criterion 2's SSE
half is therefore measured, not clean** — the assertion can now fail on real data, which is the
criterion this whole line of work exists to prove, but "no seq gaps" itself does not yet hold, for
a reason that isn't pinned down, and the fix that produced this measurement is itself not yet
shipped to `origin/main`.

---

## Two corrections to the 2026-08-19 draft, marked in place

The draft (commit `4797a60d`) was written from a reading of the installer source, not from the
running box. Two of its load-bearing premises are false, and both change the design, so they are
corrected here rather than appended — the draft's Phase 2 was built entirely on the first one.

### CORRECTED 2026-08-20 — **nginx is not the perimeter on this box. `cloudflared` is, and its ingress config is remote.**

> ~~"nginx is already the perimeter, so use it. … `nginx -s reload` (graceful: nginx drains
> existing upstream connections onto the old instance and routes new ones to the new)"~~
> ~~"**Perimeter:** nginx vhost → `proxy_pass http://127.0.0.1:4321` (WebSocket upgrade wired),
> Cloudflare Access in front."~~

Measured on `prod-host`, 2026-08-20:

```
$ systemctl is-active nginx          → inactive
$ ls /etc/nginx/sites-enabled/       → No such file or directory
$ systemctl is-active cloudflared    → active
$ systemctl cat cloudflared          → ExecStart=/usr/bin/cloudflared --no-autoupdate \
                                         tunnel run --token-file /etc/cloudflared/token
$ ls /etc/cloudflared/               → token          (no config.yml, no ingress file)
$ ss -lntp                           → 127.0.0.1:4321  users:(("node",pid=2374338,fd=29))
```

nginx is the perimeter on the **`ubuntu-vps`** platform (`docs-1e87e5c94420`), which is what the
draft's author read. This box is the **hetzner + Cloudflare Tunnel/Access** deployment
(`notion-2fea4573209f`), and it runs a **token-mode** tunnel: the ingress map
(`cockpit.example.com → http://127.0.0.1:4321`) lives in the Cloudflare Zero Trust dashboard, not
in a file on the box.

Why this kills the draft's Phase 2: "start the new release on the idle port, then flip the
upstream" requires an edit to the *remote* tunnel config over the Cloudflare API — seconds of
latency, eventual propagation to the edge, no atomicity, and no local rollback. It is the worst
possible cutover primitive. **`127.0.0.1:4321` is therefore a fixed contract**, and the handover
has to happen *behind* that port, not by moving it. See "Solution → P3".

### CORRECTED 2026-08-20 — **there is no single-writer lock, and `running` runs do not simply die: they are force-resumed in a fresh session.**

> ~~"cezar uses a single-writer lock; blue-green must ensure runs stay owned by the instance that
> spawned them"~~

No such lock exists. `RunStore` (`packages/cezar/src/runs/store.ts:589`) is an `EventEmitter` over
a plain in-memory `Map` (`:590`), read once from `runs.json` at construction (`:605`) and written
back wholesale by `flush()` (`:1131`, tmp+rename at `:1214`). `WorkspaceSemaphore`
(`packages/cezar/src/workspace/semaphore.ts:164`) is a `Set` of in-process participants. Nothing
on disk arbitrates between two processes. **Two live `cezar serve` instances on one `.ai/cezar/`
do not race at the margins — the second one to flush silently overwrites everything the first
wrote.** So "two instances, one state dir" is not a risk to be managed with ownership rules; it is
a state-destroying bug, and the design must guarantee it never happens even for a millisecond.

> ~~"A deploy mid-run loses that run's live process (its persisted state survives, but the running
> work does not)."~~

True but incomplete, and the incompleteness matters for the acceptance criterion. `RunManager.recover()`
(`packages/cezar/src/workflows/run.ts:1257`) already handles a restart: a `running` run has its
open steps marked `failed`, the run marked `failed` with `error: 'interrupted — cezar process
exited during the run'`, and then `continueRun(run.id, { text: RESTART_CONTINUATION_PROMPT }, true)`
(`:1301`, prompt at `:553`) starts a **new** agent session resuming from the last `sessionId`.

So the task is not lost. What is lost is: the live process tree, the in-flight turn's uncommitted
work, the agent's live context (a fresh session re-reads everything), the run's `running` status
for as long as the queue takes to pick it back up, and — visibly — the transcript gains an
`interrupted` error and a restart-continuation prompt on **every deploy**. The acceptance
criterion "a deploy mid-run leaves the run alive and streaming" is **not** met by `recover()` and
is not meant to be: `recover()` is crash recovery, and a deploy is not a crash.

Everything else in the draft's Problem section was verified correct and is kept below.

---

## TLDR

Deploying a new cezar version to `prod-host` is a hard `systemctl restart cezar.service`.
The unit runs the default `KillMode=control-group` and every agent run is a child process in that
cgroup, so a deploy **SIGKILLs every in-flight run** — and the deployer itself when it runs
on-box. `--port-strict` on a single port means the new process cannot bind until the old one has
released, so every open SSE/WS stream drops and in-flight requests abort. Code reaches
`/opt/cezar` by hand-run `rsync` with no atomic swap and no rollback, and the only health check
runs *after* the restart.

This spec makes a version update safe to run at any time, in five independently shippable phases:
an atomic release symlink with a rollback ledger; a deployer that re-executes itself out of the
service's cgroup; systemd **socket activation** so the listening socket outlives the process and
no connection is ever refused; a **detached per-run broker** so agent processes survive a restart
and the new server re-attaches to their output byte-for-byte; and a health-gated deploy that
smoke-boots the candidate before the flip and auto-rolls-back after it.

---

## Problem — what "disruption" concretely is today

Measured on `prod-host` (Hetzner CX43), 2026-08-19 and re-measured 2026-08-20:

**Unit** (`/etc/systemd/system/cezar.service`, hand-written on this box — *not* generated by
`server-install`; its `Description` is `cezar cockpit (hosted, Cloudflare Access is the
perimeter)`, which no generator in this repo emits):

```ini
[Service]
Type=simple
User=cezar
Group=cezar
WorkingDirectory=/var/lib/cezar/workspace
EnvironmentFile=/etc/cezar/cezar.env
ExecStart=/usr/bin/node /opt/cezar/packages/cezar/dist/index.js serve \
          --no-open --bind-host 127.0.0.1 --port 4321 --port-strict
Restart=on-failure
RestartSec=3
TimeoutStartSec=60
```

plus three drop-ins (`10-cloudflare.conf`, `20-onepassword.conf`, `30-agent-passthrough.conf`).
`systemctl show` confirms `KillMode=control-group`, `Delegate=no`.

**Perimeter:** `cloudflared` token tunnel → `http://127.0.0.1:4321`, Cloudflare Access in front.
Ingress config is remote (see the correction above).

**Code delivery:** a hand-run `rsync` of a built tree into `/opt/cezar`, with `/opt/cezar.prev`
kept as the previous copy and a `.deployed-commit` marker **that no code in this repo writes** —
recorded as a known gap in `.ai/specs/2026-08-19-tasks-page-and-start-grounding.md:288,297`. The
live marker's contents are free text: `37a9a978… (on-box worktree build, spec-to-deploy default
+ standing ship auth)`. `/opt/cezar` is 490 MB including `node_modules`.

**`cezar server-deploy`** → `hetzner.redeploy()` (`packages/cezar/src/server-install/platforms/hetzner.ts:1184`)
= `systemctl daemon-reload && systemctl restart <unit>`, then `confirmListening` (`:280`) and
`verifyStep`. It restarts; it does not deliver code. (`ubuntu-vps.ts:1109` is the same shape.)

**State:** plain JSON / NDJSON / Markdown under `.ai/cezar/` — survives a restart. Per-run
transcripts are durable append-only NDJSON at `<dataDir>/runs/<runId>.ndjson`, and
`runs/event-history.ts` already serves them with resumable page and live cursors
(`{offset, boundarySeq}`). **That durability is the foundation the whole design rests on.**

Five disruption vectors follow:

1. **Runs are SIGKILLed on restart.** Each agent run is a `claude`/`codex` child in the service
   cgroup; `KillMode=control-group` kills the whole tree. `recover()` then force-resumes the task
   in a fresh session (see the correction above) — the task survives, the *run* does not.
2. **The on-box deployer dies too.** Anything triggering the deploy from inside the cockpit (an
   agent task, an interactive session) is in the same cgroup and is killed mid-cutover — so the
   deploy cannot report its own success. Observed live 2026-08-19: the deploying session was
   pid 1441357, inside `cezar.service`'s cgroup.
3. **HTTP/SSE/WS cutover gap.** `--port-strict` + one port: the new process cannot bind 4321
   until the old has released it (`packages/cezar/src/index.ts:365` refuses to boot rather than
   drift), and the old process's `shutdown` is `store.flush(); process.exit(0)`
   (`index.ts:616`, wired to SIGINT and SIGTERM at `:620–621`) — no drain, no in-flight
   completion, sockets cut mid-response.
4. **Code delivery is unmanaged.** No atomic swap: a half-copied `dist` can be started, and
   "rollback" is a human remembering `/opt/cezar.prev` exists.
5. **No readiness gate.** `verifyStep` runs *after* the restart, so a broken build is already
   serving — or crash-looping under `Restart=on-failure` — before anything notices.

---

## Solution

Five changes, each shippable and useful alone. P1–P2 are prerequisites for P5; P3 and P4 are
independent of everything and of each other. **P4 is the one that satisfies "a deploy mid-run
leaves the run alive and streaming"**; P3 satisfies "cutover gap = 0"; P2 satisfies "deployer
survives"; P5 satisfies "bad build auto-rolls-back".

### P1 — Atomic release + rollback ledger

`/opt/cezar` **becomes a symlink** to `/opt/cezar-releases/<releaseId>/`. Deliberately the symlink
and not a `current` subdirectory: every existing absolute path on the box already points *through*
`/opt/cezar` — the unit's `ExecStart`, and all three CLI wrappers in `/usr/local/bin`
(`cez`, `cezar`, `cezar-cli`, each `exec /usr/bin/node /opt/cezar/packages/cezar/dist/index.js "$@"`).
Keeping `/opt/cezar` as the stable name means **no other file on the box has to change**, and the
wrapper's own comment ("depends only on the path, which is stable across deploys") stays true.

`releaseId` = `<utc-timestamp>-<short-sha>`. A deploy stages into a fresh release dir, `fsync`s,
then flips the symlink with `rename(2)` on a temp symlink — atomic, no window where `/opt/cezar`
does not resolve. `deploy.json` is the ledger: `{current, previous, releases: [...]}`. Rollback =
flip back + restart; seconds, no rebuild. Keep N=5 releases (490 MB each ≈ 2.5 GB; the box has
room, and the count is configurable).

**Two things must not be per-release** and are moved out before the first flip: `/opt/cezar/.ai/`
(a build-time leftover — `WORKLIST.md`, `runs/`, `analysis/`, `browsers/`, `qa/`, `scripts/`;
nothing reads it at runtime, because the unit's `WorkingDirectory` is `/var/lib/cezar/workspace`),
and `.deployed-commit`, which becomes a *derived* field of the ledger rather than a hand-written
file. The migration step verifies this by listing everything under `/opt/cezar` that is not
tracked by git and refusing to flip if anything unexpected is there.

### P2 — Self-safe deployer

The deploy re-executes itself into a transient unit **outside** `cezar.service`'s cgroup before it
touches anything:

```
systemd-run --unit=cezar-deploy-<releaseId> --collect --same-dir \
            --property=KillMode=process --property=Type=oneshot \
            -- <the real deploy command>
```

The parent then *tails the transient unit's log file and exits or reports*; it never holds the
deploy. Cutting over or restarting `cezar.service` cannot kill the deployer, because it is no
longer in that cgroup. This alone fixes vector 2 — the bug this spec was written from.

The deploy log streams to `/var/log/cezar/deploy-<releaseId>.log` so a cockpit that was itself
restarted mid-deploy can still read what happened. `server-deploy` learns `--follow` to tail it.

### P3 — Socket activation: a listening socket that outlives the process

The fixed-port constraint (correction 1) rules out moving the upstream. So **stop killing the
socket**: a `cezar.socket` unit owns `127.0.0.1:4321` and passes the listening fd to
`cezar.service` via `LISTEN_FDS`.

```ini
# /etc/systemd/system/cezar.socket
[Socket]
ListenStream=127.0.0.1:4321
Backlog=1024
[Install]
WantedBy=sockets.target
```

`cezar.service` gains `Sockets=cezar.socket`, and `serveCommand` learns to listen on the inherited
fd (`server.listen({ fd: 3 })`) when `LISTEN_FDS=1` and `LISTEN_PID === process.pid`, falling back
to `listen(port)` otherwise so every non-systemd path (local dev, macOS, `ubuntu-vps`) is
untouched. `--port-strict`'s refusal is skipped in inherited-fd mode — the whole point is that the
port is legitimately held, by systemd.

Effect: across a restart the socket never closes. Client connections arriving during the swap sit
in the kernel accept backlog and are served by the new process — **zero connection refusals, zero
`ECONNRESET` on connect**. Requests that were mid-flight on the old process still need a graceful
close, which is the second half of P3: `shutdown` stops accepting, waits up to `CEZ_DRAIN_MS`
(default 5 s) for in-flight HTTP requests to finish, sends a final `event: reload` SSE frame
carrying each stream's resume cursor, closes WS with code 1012 (`Service Restart`), then flushes
and exits. The web client already reconnects; it learns to reconnect *immediately* on 1012/`reload`
rather than after its backoff, and to resume from the cursor.

**"Gap = 0" is defined and measured as:** across the cutover, (a) zero failed HTTP requests from a
continuous client, (b) zero refused connections, (c) zero lost or duplicated run events, proven by
`seq` continuity across the reconnect. It is *not* defined as "no TCP connection was ever closed" —
an SSE stream is unbounded, so any process replacement must eventually close one; what must not
happen is a lost byte or a failed request.

### P4 — Runs survive the restart: the detached run broker

This is the architectural change, and the reason the draft's one-line "launch each run in its own
scope" is not sufficient. Today the server process **is** the consumer of the agent CLI's stdout:
`ClaudeCliRunner` spawns the child (`packages/cezar/src/core/claude-cli-runner.ts`, `nodeSpawn`)
and then iterates `readNdjson(child.stdout)` in-process. Moving the child to another cgroup keeps
it *alive* but severs its output the moment the parent dies — the pipe's read end goes with the
parent, the child gets `EPIPE` on its next write, and nothing has recorded the stream. Detaching
the process without relocating the pipe makes things worse, not better.

So the thin pipe-owning layer moves out of the server, and nothing else does:

**`cezar run-broker --spool <dir> -- <argv…>`** (a new hidden subcommand in the same package, so
there is one artifact to deploy):

- spawns the backend CLI with the given argv / cwd / env (the env built by the existing
  `buildChildEnv` and passed through, so `CEZ_ENV_PASSTHROUGH` semantics are unchanged);
- appends every raw stdout line verbatim to `<spool>/out.ndjson`, stderr to `<spool>/err.log`;
- serves a unix control socket `<spool>/ctl.sock` (mode 0600) speaking one NDJSON request per
  line: `{op:'send', content}` → child stdin, `{op:'end'}`, `{op:'interrupt'}`, `{op:'status'}`;
- writes `<spool>/meta.json` at start (`pid`, `backend`, `argv`, `startedAt`, `brokerVersion`) and
  `<spool>/exit.json` at exit (`code`, `signal`, `exitedAt`);
- puts itself outside the server's cgroup (mechanism below), and `setsid`s so no terminal or
  process-group signal reaches it.

**Server side**, a `BrokeredSession` implements the *existing* `AgentSession` interface unchanged
(`packages/cezar/src/core/agent-runner.ts:183–198`: `result`, `pid`, `sendMessage`, `end`,
`interrupt`, `open`) by tailing `out.ndjson` from a byte offset and feeding each line into the same
per-runner handler that `readNdjson(child.stdout)` feeds today. `sendMessage`/`end`/`interrupt`
become control-socket writes. **Every layer above the runner — the UI mapper, step lifecycle,
autosave, leases, semaphore, store writes — is untouched**, which is what makes this tractable
against a 4 168-line `run.ts`.

**Re-attach on boot.** `recover()` gains a branch *before* its existing interrupted-run handling:
for each `running` run with a spool whose `meta.json` pid is alive and whose `exit.json` is
absent, re-open the control socket, re-attach a `BrokeredSession` at the run record's persisted
`consumedOffset`, and leave the run `running`. Nothing is marked failed; no
`RESTART_CONTINUATION_PROMPT`; the transcript gains one `lifecycle` line ("cezar restarted — this
run kept going"). The offset is persisted on the run record on every flush, so re-attach replays
exactly the bytes the old process had not yet consumed: **no gap, no duplicate**. If the pid is
dead or the spool is unreadable, control falls through to today's behaviour unchanged — the
existing path stays the safety net rather than being replaced.

**Getting out of the cgroup**, in preference order, probed once at boot and reported on
`/api/v1/health` so the operator can see which mode is live:

1. `systemd-run --user --scope --slice=cezar-runs.slice` — requires a user manager for `cezar`
   (`loginctl enable-linger cezar`, done by the install step). Clean, per-run cgroup, survives
   any `cezar.service` action.
2. `cezar.service` gains `Delegate=yes` + `KillMode=process`, and the broker is `setsid`-detached
   into a child cgroup the server creates under its own delegated cgroup. `KillMode=process`
   means systemd signals only the main process on stop.
3. No relocation (macOS, non-systemd, container without cgroup delegation): the broker still runs,
   still spools durably, and still survives an *ordinary* exit of the server — it just does not
   survive a `KillMode=control-group` teardown. Health reports `runBrokerIsolation: 'none'` so
   this is visible rather than assumed.

**Backend scope, stated as a decision, not an omission:** P4 covers the **`claude`** backend only
in this spec. `codex` (app-server transport) and `opencode` (HTTP server) do not own a stdout pipe
in the same shape and need their own transports brokered; `pi` is a third shape. They keep
today's interrupt-and-continue behaviour, and `/api/v1/health` reports which backends are
brokered. This box runs `claude`, so the acceptance criterion is met; the rest is follow-up work
with a filed todo.

**Added 2026-08-22 — the one-shot `cezar run` CLI is also a covered scenario, not just the
server/cockpit path.** This section and its Verification were written and tested against the
server/cockpit restart-survival case only; neither named the one-shot CLI (`cezar run <task>`
without `cezar serve`) as something P4 had to keep working, because brokering was originally
opt-in. "Implementation notes (2026-08-21)" below already flags that gating brokering on "is this
a built tree" rather than a flag means production gets it by default with no opt-out — but never
drew the conclusion that this pulls the one-shot CLI path into P4's scope too, since a built tree
is exactly what a packaged/production `cezar run` runs as. A real gap followed: the CLI's own event
loop has no listener keeping it alive the way `cezar serve`'s HTTP listener does, so nothing kept
the process open while a brokered session was in flight, and a real regression shipped and reached
production (`npm run test:package` red on `prod-host`, 2026-08-21) before anything caught it.
Fixed by `.ai/specs/2026-08-22-run-broker-cli-keepalive.md` (`BrokeredSession`'s poll timer is now
ref'd for exactly the lifetime of an open session, plus a repaired give-up path so a broker that
never comes up fails the run loudly instead of hanging); `packages/cezar/test/e2e/package-cli.test.ts`
is (part of) that scenario's regression coverage, and `brokered-session.test.ts` covers the
keep-alive/give-up mechanism directly.

### P5 — Health-gated deploy with auto-rollback

`server-deploy --strategy=blue-green` (the name is kept from the draft for continuity, though
correction 1 means it is a *release* flip behind a fixed socket, not two live upstreams) runs:

1. `deploy.started` — stage the build into a new release dir (P1). Nothing live has changed.
2. **Smoke boot.** Start the candidate `dist/index.js` on a scratch port with a throwaway
   `CEZ_HOME` and a throwaway empty project dir, probe `/api/v1/health` and a deeper readiness
   route, then kill it. **A throwaway home is mandatory, not hygiene** — correction 2 means a
   second process pointed at the real `.ai/cezar/` would overwrite `runs.json`. `deploy.release_built`.
3. Flip the symlink (P1) and `systemctl restart cezar.service`. With P3 the socket is held by
   `cezar.socket` throughout; with P4 the run brokers are in their own slice and are not signalled.
   `deploy.cutover` with `gap_ms` and `inflight_runs`.
4. Probe readiness on the real port. `deploy.instance_ready` / `deploy.drained`.
5. **Fail closed.** Any failure at 2 or 4 → never flip, or flip back to `previous` and restart →
   `deploy.rollback`. Rollback is a symlink `rename` plus a restart, so it is subject to exactly
   the same gapless machinery as the deploy.

The current restart-only path stays as `--strategy=restart` for the single-user local case where a
blip is fine, and remains the default until P3 and P4 are both live on the box.

---

## Architecture

```
                       Cloudflare Access ─► cloudflared (token tunnel; ingress config is REMOTE)
                                                     │
                                                     ▼   fixed contract, never moves
                                        ┌────────────────────────────┐
                                        │ cezar.socket  127.0.0.1:4321│  ← systemd owns the fd
                                        └─────────────┬──────────────┘     (survives restarts;
                                                      │ LISTEN_FDS=1        backlog absorbs the swap)
                                        ┌─────────────▼──────────────┐
                                        │ cezar.service              │
                                        │  ExecStart=/opt/cezar/…    │──► symlink ──► /opt/cezar-releases/<id>/
                                        │  KillMode=process          │                 (atomic rename, ledger)
                                        └─────────────┬──────────────┘
                     tail out.ndjson @offset          │  ctl.sock (send/end/interrupt)
             ┌────────────────────────────────────────┼───────────────────────────┐
             ▼                                        ▼                           ▼
   ┌──────────────────┐                     ┌──────────────────┐        cezar-runs.slice
   │ run-broker <r1>  │                     │ run-broker <r2>  │        (own cgroup — a
   │  claude ──stdout─┼──► spool/out.ndjson │  claude …        │         cezar.service
   └──────────────────┘     (durable)       └──────────────────┘         restart never
                                                                          signals these)

   deploy:  systemd-run --unit=cezar-deploy-<id> --property=KillMode=process   ← outside the
            └─ stage → smoke-boot (throwaway CEZ_HOME) → flip → restart → probe → rollback  service cgroup
```

The invariant that makes it work: **the run's output is a file, not a pipe.** Once that is true,
the server becomes a *replaceable reader* of durable state, and every other property (re-attach
without loss, deploy at any moment, rollback) follows from replaying a byte offset.

---

## Data models

**`/opt/cezar-releases/deploy.json`** — the release ledger. Additive-safe like every other cezar
state file (every field optional with `.catch`, `.passthrough()` at each object level, atomic
tmp+rename write), so an older cezar reading it never loses a newer one's fields:

```jsonc
{
  "schema": 1,
  "current": "20260820T093000Z-67e93cca",
  "previous": "20260819T180000Z-37a9a978",
  "keep": 5,
  "releases": [
    {
      "id": "20260820T093000Z-67e93cca",
      "sha": "67e93cca…",           // full commit sha
      "version": "0.10.0",          // packages/cezar/package.json
      "builtAt": "2026-08-20T09:30:00.000Z",
      "activatedAt": "2026-08-20T09:31:12.000Z",
      "note": "spec-to-deploy",     // replaces the free-text .deployed-commit
      "healthy": true               // set by the post-flip readiness probe
    }
  ]
}
```

**`<dataDir>/runs/<runId>.spool/`** — one broker spool per agent session:

| file | writer | contents |
| --- | --- | --- |
| `meta.json` | broker, at start | `{ schema: 1, runId, stepId, backend, pid, argv, cwd, startedAt, brokerVersion }` |
| `out.ndjson` | broker, append-only | the backend's stdout, verbatim, one line per record |
| `err.log` | broker, append-only | the backend's stderr |
| `ctl.sock` | broker | unix stream socket, mode 0600, owner-only |
| `exit.json` | broker, at exit | `{ code, signal, exitedAt }` |

**`RunRecord`** gains two optional fields (both `.optional().catch(undefined)`, so an older cezar
parses a newer record and a newer cezar parses an older one):

- `spoolDir?: string` — relative to `dataDir`; absent ⇒ this run was never brokered, take the
  legacy path.
- `consumedOffset?: number` — byte offset into `out.ndjson` the server has fully processed. This
  is the entire re-attach contract.

No migration, no format change to `runs.json` or the event NDJSON. The draft's "changing the state
format is out of scope" holds.

---

## API / interface contracts

**Control socket** (`<spool>/ctl.sock`), NDJSON request → NDJSON response, one per line:

| request | response | notes |
| --- | --- | --- |
| `{"op":"send","content":[…ContentBlock]}` | `{"ok":true}` \| `{"ok":false,"error":"closed"}` | maps to `AgentSession.sendMessage` |
| `{"op":"end"}` | `{"ok":true}` | stdin EOF, then the runner's existing SIGTERM→SIGKILL watchdog |
| `{"op":"interrupt"}` | `{"ok":true}` | hard stop, for cancel |
| `{"op":"status"}` | `{"ok":true,"pid":N,"open":bool,"bytes":N}` | `bytes` = `out.ndjson` size, for re-attach |

**CLI:**

- `cezar run-broker --spool <dir> [--backend <id>] -- <argv…>` — hidden; not in `--help`, because
  it is an internal artifact, not a user-facing command. Covered by the entry-module reachability
  test pattern that `.ai/specs/2026-08-19-tasks-page-and-start-grounding.md` established for `kb`.
- `cezar server-deploy [--strategy=restart|blue-green] [--follow] [--rollback [<releaseId>]]`.
  Default stays `restart` until P3 and P4 are live on the box.

**HTTP:**

- `GET /api/v1/health` gains `deploy: { releaseId, version, sha, activatedAt }` and
  `runtime: { socketActivated: bool, runBrokerIsolation: 'scope'|'delegated'|'none', brokeredBackends: string[] }`.
  Additive only — `packages/contract` schema plus the contract-parity test that already guards
  every route.
- `GET /api/v1/ready` (new) — the deeper readiness probe P5 gates on: store loaded, project stores
  booted, workspace config readable, backends detected. Distinct from `/health`, which is the
  CORS-open discovery endpoint and must stay cheap and public-shaped.
- SSE streams gain a terminal `event: reload` frame carrying `{cursor}`; WS closes with 1012.

**systemd units** — `cezar.socket` (new), `cezar.service` gains `Sockets=`, `KillMode=process`,
`Delegate=yes`; `cezar-runs.slice` (new). Written by a `server-install` step so a fresh box gets
them, *and* by a one-shot migration for this hand-provisioned box, whose unit no generator in this
repo currently owns (see Problem). The three existing drop-ins are preserved untouched.

---

## Phases

Each phase is independently shippable and independently valuable. The chain's remaining steps map
one-to-one onto P1…P5.

| # | Phase | Ships | Verified by |
| --- | --- | --- | --- |
| **P1** | Atomic release + ledger | `/opt/cezar` → symlink, `/opt/cezar-releases/`, `deploy.json`, `--rollback` | unit tests on the ledger + flip/rollback; a real flip + rollback on the box |
| **P2** | Self-safe deployer | `systemd-run` re-exec, deploy log, `--follow` | deploy triggered from inside the cockpit survives a restart of `cezar.service` |
| **P3** | Socket activation + graceful drain | `cezar.socket`, `LISTEN_FDS` support, drain, `reload` frame, client fast-reconnect | continuous-client harness across a restart: 0 failed requests, 0 refused connections |
| **P4** | Run broker + re-attach | `cezar run-broker`, `BrokeredSession`, spool, `recover()` re-attach branch, slice/lingering | a `running` run stays `running` across `systemctl restart`, transcript continuous by `seq` |
| **P5** | Health-gated deploy + rollback | smoke boot, `/api/v1/ready`, `--strategy=blue-green`, analytics | a deliberately broken build never flips; a build that boots-then-fails auto-rolls-back |

**Ordering constraints:** P5 needs P1 (something to flip) and P2 (a deployer that outlives the
restart it triggers). P3 and P4 are independent of P1/P2 and of each other. P1 alone already
removes the "half-copied `dist`" failure mode and gives a one-command rollback, so it is worth
shipping first even if nothing else follows.

---

## Risks

- **Re-attach correctness is the whole feature.** A missed re-attach orphans a live agent —
  worse than today, because today's `recover()` at least resumes the task. Mitigation: the
  re-attach branch is *additive and fails open* — pid dead, spool unreadable, offset past EOF,
  `meta.json` unparseable, broker version mismatch all fall through to the existing
  interrupted-run path, which stays exactly as it is. The dangerous direction (a run silently
  left for dead) is the one the fallback covers.
- **Two live instances would destroy state** (correction 2). Every phase is designed so it never
  happens: P3 replaces the process behind one socket rather than running two; P5's smoke boot uses
  a throwaway `CEZ_HOME` *and* a throwaway project dir. A guard is added at boot — if `runs.json`'s
  mtime advances while this process holds it and did not write it, log loudly. It is a canary, not
  a lock; a real cross-process lock is a bigger change and is named as follow-up, not smuggled in.
- **Cutover latency in place of cutover failure.** Socket activation converts "connection refused"
  into "queued in the backlog for as long as the new process takes to boot." A cezar boot that
  takes 8 s makes that an 8 s stall for a request that lands at the wrong moment. Bounded by
  `Backlog=1024` and measured in verification; if boot time is the binding constraint, that is a
  separate optimization with a real number attached to it, not a design flaw to hand-wave.
- **`Delegate=yes` + `KillMode=process` leaks processes on a genuine failure.** A crashed server
  leaves brokers running with nothing consuming them. Mitigation: brokers get their own idle
  watchdog (no control connection and no stdout for `CEZ_BROKER_ORPHAN_MS`, default 30 min → they
  exit), and `recover()` sweeps spools whose runs are terminal, reusing the existing
  `sweepAgentTmpDirs` pattern (`run.ts:1263`).
- **Disk.** Five 490 MB releases plus per-run spools. Bounded by `keep` and by the existing
  retention machinery; the deploy refuses to stage when free space is under a threshold.
- **The box's unit is not generated by this repo.** P3/P4's unit changes must be applied both by a
  `server-install` step (for fresh boxes) and by an idempotent one-shot migration (for this box),
  or the box drifts further from the installer. Related open todo: `7583ce12` (the installer does
  not create the `cez` wrapper) — same root cause, tracked separately.
- **Cloudflare Access / tunnel continuity.** `cloudflared` holds a long-lived connection to
  `127.0.0.1:4321`. Socket activation keeps the listener up, but `cloudflared`'s existing upstream
  connections still break when the process dies; verification must confirm it re-establishes
  without an edge-visible 502.

---

## Verification

**The acceptance E2E, run on `prod-host`** (this is the test the two acceptance criteria
name; artifacts and video kept per run):

1. Start a long-running agent task on the `claude` backend and let it reach a `running` step with
   live output.
2. Start a continuous client harness against the public host: an SSE subscriber recording every
   event `seq`, plus a 10 rps HTTP poller against `/api/v1/ready` recording every status and every
   connect error, both timestamped.
3. Trigger `cezar server-deploy --strategy=blue-green` **from inside the cockpit** (an agent task —
   the exact configuration that broke on 2026-08-19).
4. Assert:
   - **(a)** the run's status never leaves `running`; its process tree pid (from `meta.json`) is
     unchanged before and after; its transcript `seq` sequence has no gap and no duplicate across
     the restart; no `interrupted — cezar process exited during the run` event exists.
   - **(b)** the HTTP poller records **zero** non-2xx responses and **zero** connect errors;
     max observed latency is recorded as `gap_ms`.
   - **(c)** the SSE subscriber's `seq` stream is continuous across its reconnect.
   - **(d)** the deploying task itself is alive after the cutover and reports success.
   - **(e)** repeat with a deliberately broken build (`dist/index.js` truncated): the smoke boot
     fails, the symlink never flips, `/opt/cezar` still resolves to the old release, and no
     restart happened at all.
   - **(f)** repeat with a build that boots and then fails readiness: it flips, readiness fails,
     the ledger's `previous` is restored, and the client harness still records zero failures
     across *both* the flip and the rollback.

**Automated (must be green before any deploy):**

- Ledger: flip is atomic (no observable moment where `/opt/cezar` is dangling), rollback restores
  `previous`, `keep` prunes oldest-first, a corrupt `deploy.json` degrades to "no ledger" and
  refuses to flip rather than flipping blind.
- Broker: spawn → spool → control socket round-trip; `BrokeredSession` satisfies the `AgentSession`
  contract against the same golden fixtures `claude-cli-runner.test.ts` uses, so the v1 `AgentEvent`
  and v2 `UiEvent` streams are **byte-identical** to the in-process path (this is the parity
  requirement `AGENT_PROTOCOL.md` already imposes on every backend);
  re-attach at offset N replays exactly the untail'd bytes; re-attach with a dead pid / missing
  spool / bad `meta.json` falls through to the legacy path.
- **Added 2026-08-22:** the one-shot CLI path — `packages/cezar/test/e2e/package-cli.test.ts`
  (`npm run test:package`) runs a brokered `cezar run` end to end from the packaged tarball, and
  `brokered-session.test.ts` asserts the keep-alive/give-up mechanism directly. See the note added
  to P4 above and `.ai/specs/2026-08-22-run-broker-cli-keepalive.md`.
- `recover()`: a `running` run with a live spool stays `running` and is not force-continued; every
  existing `recover()` case (queued, waiting, running-without-spool) is unchanged — asserted
  against the current tests, which must pass untouched.
- Socket activation: `LISTEN_FDS`/`LISTEN_PID` parsing (correct pid, wrong pid, absent, `>1` fds),
  and that `--port-strict`'s refusal is skipped only in inherited-fd mode.
- Drain: in-flight requests complete; SSE receives the `reload` frame with a usable cursor; WS
  closes 1012.
- Contract parity for the new `/api/v1/ready` route and the `/api/v1/health` additions — the
  existing `contract-parity.*.test.ts` suite covers this by construction.
- Unit generation: `cezar.socket` + the amended `cezar.service` are asserted as text, and the
  migration is idempotent (running it twice is a no-op) and preserves the three existing drop-ins.

**How to run the acceptance E2E** (added 2026-08-21, with the implementation):

The measurement half is `packages/cezar/scripts/deploy-e2e-probe.mjs` — a standalone, dependency-free
script that runs the continuous client of step 2 and evaluates assertions (a), (b) and (c). It is
deliberately **not** part of cezar and imports nothing from it: it has to keep measuring while the
cezar it is measuring is replaced, so being inside that process would make it the first casualty.

**CORRECTED 2026-08-24 — the block below previously ran unauthenticated against the public edge
and named a `npm run lint` gate that does not exist.** This box terminates OIDC auth
(`CEZ_AUTH=oidc`); `/runs` and `/events` 401 without a session credential, which is why the SSE
half went unmeasured for so long (see "Status log — 2026-08-23" above). `origin/main`'s shipped
probe (`83ddbdd2`) accepts a `cookie` header for this — read an unexpired session id out of
`<CEZ_HOME>/identity/identity.json` on the box itself, no browser round trip needed:

```bash
# 0. read an unexpired session id already on the box (no new mechanism; reads what OIDC login minted)
SESSION_ID=$(node -e '
  const fs = require("fs");
  const path = (process.env.CEZ_HOME || require("os").homedir() + "/.cezar") + "/identity/identity.json";
  const store = JSON.parse(fs.readFileSync(path, "utf8"));
  const now = Date.now();
  const live = (store.sessions || []).filter(s => new Date(s.expiresAt).getTime() > now);
  if (!live.length) { console.error("no unexpired session in " + path); process.exit(1); }
  live.sort((a, b) => new Date(b.expiresAt) - new Date(a.expiresAt));
  console.log(live[0].id);
')
# 1. start a long-running agent task and note its run id
# 2. start the probe (runs for --seconds; exit 0 = passed, 1 = a real failure)
node packages/cezar/scripts/deploy-e2e-probe.mjs \
     --base http://127.0.0.1:4321 --run <runId> --seconds 180 \
     --header "cookie: cez_session=$SESSION_ID" \
     --out .ai/cezar/artifacts/deploy-e2e-$(date -u +%Y%m%dT%H%M%SZ).json
# 3. from INSIDE the cockpit, in another task:
cezar server-deploy --strategy=blue-green --follow
```

Loopback (`http://127.0.0.1:4321`), not the public edge (`https://cockpit.example.com`): the edge
sits behind Cloudflare Access, a separate perimeter from this session cookie, and every artifact on
record was measured over loopback. **`--project <id>` does not exist on this shipped probe** — it
still calls the unscoped `/api/v1/runs/:id`, which 404s on this box (it boots in workspace mode;
runs live at `/api/v1/p/<project>/runs/:id`). The probe correctly reports `NOT_MEASURED` rather than
a vacuous `PASS` when that happens, but cannot collect real SSE data until the `--project` fix on
unmerged branch `cez/3ee1ebf0` lands (see "Status log — 2026-08-23" above, and todo `96a25516`).
`$SESSION_ID` is a live user's real credential — pass it only via `--header`/the env var above,
never paste it into a log line, this spec, or a `cezar todo`/knowledge entry.

It reports `gapMs` (max client-observed latency across the swap — the number the spec names), the
poller's failure and refusal counts, the SSE `seq` gaps and duplicates, whether a `reload` frame
arrived, and every status the run passed through. Assertions (e) and (f) — the deliberately broken
build and the boots-then-fails build — are driven by staging a truncated `dist/index.js` and by a
release whose `/api/v1/ready` returns 503; both are covered as unit branches in
`server-install/release-deploy.test.ts`, and the on-box repeat is what promotes them from covered
to verified.

**Gates:** `npm run typecheck`, `npm run test` green before deploy — necessary, not sufficient.
There is no `npm run lint` script in this repo (root and `packages/cezar/package.json` both
checked; neither defines one, and no ESLint/Biome/Prettier config exists anywhere in the tree) —
this line previously named one as a gate, which was never actually runnable. Until the E2E above
has actually run on the box, this ships as **QA Needed**, not Done.

---

## Analytics

Named now, per the workspace rule, and emitted by the deployer:

`deploy.started`, `deploy.release_built`, `deploy.instance_ready`, `deploy.cutover`, `deploy.drained`,
`deploy.rollback` — each with `version`, `sha`, `releaseId`, `strategy`. `deploy.cutover` carries
the two numbers that *are* the definition of "non-disruptive": **`gap_ms`** (max client-observed
latency across the swap, 0 failed requests being the pass condition) and **`inflight_runs`**
(how many runs were live and survived). `deploy.rollback` carries `reason` and `failedAt`
(`smoke_boot` | `readiness`).

---

---

## Implementation notes (2026-08-21) — what the build changed about the design

Three things the spec did not anticipate, recorded here because each of them is a decision the
next reader would otherwise have to re-derive.

### Brokering is gated on being a BUILT tree, not on a flag

The spec assumed a broker could always be launched. It cannot: the broker must be the *same
artifact* as the server (so a release flip can never leave a broker from one version tailing a
spool a server from another version wrote), and the cheapest way to guarantee that is to re-exec
this package's own `dist/index.js`. Running from TypeScript sources — `tsx`, vitest, `npm run dev`
— there is no such file, and `node src/index.ts` would simply fail.

So `brokerAvailable()` (`core/broker-launch.ts`) answers "is there a built entry point to
re-exec?", and source mode reports **unavailable**. Two consequences worth stating plainly:
production gets brokering by default with no flag to set, and **the entire existing test suite and
every local dev run are untouched by this feature** — they take the in-process path exactly as
before. `CEZ_RUN_BROKER=0` is the production escape hatch; `=1` states intent but cannot conjure
an entry point that is not there.

### A measured defect: `sun_path` truncation silently relocates the control socket

`bind(2)` copies the socket path into a fixed 108-byte field and **libuv does not refuse an
over-long path — it truncates it**. Measured while building this: a 110-character socket path
binds with no error and the socket file appears at the truncated path, not the one requested. Both
`listen` and `connect` truncate identically, so control ops keep working and nothing looks wrong —
until code reasons about the path as a *file*. `rmSync(paths.ctl)` then deletes nothing, the stale
socket outlives its broker, and the next broker for that spool hits `EADDRINUSE` on a directory it
can see is empty (a 117-character path did exactly that).

This is not hypothetical for cezar: `<project>/.ai/cezar/runs/<uuid>.spool/ctl.sock` is ~98
characters from a short project root, and a task worktree clears 107 without anything unusual
happening. `controlSocketPath()` (`core/run-spool.ts`) therefore keeps the socket beside the spool
while it fits and falls back to a short, deterministic `/tmp/cez-ctl-<hash>.sock` when it does not.
`/tmp` is preferred over `os.tmpdir()` on purpose — `TMPDIR` is routinely long (cezar gives every
run a per-task temp dir, 81 characters on this box), so a "short" fallback built on it can blow the
same budget it exists to escape.

It also killed the obvious readiness test. `BrokeredSession` does **not** ask whether `ctl.sock`
exists before sending; it tries the send and believes the result, which is the only question that
matters and also covers the case a file test never could — the socket exists but the broker has not
called `accept` yet.

### The parity test earned its keep immediately

`core/brokered-parity.test.ts` runs the same golden fixtures through both transports and compares
the v1 `AgentEvent` and v2 `UiEvent` streams whole. On its first run it caught a real bug: the
brokered path emitted `turn.started` only for the *opening* message, so every brokered follow-up
turn was missing it and the v2 stream diverged the moment a run had two turns. That is exactly the
class of defect the one-consumer rule exists to prevent, and it was invisible to every other test.

## SUPERSEDED 2026-08-21 (same day) — the box was provisioned; a deploy needs NO root now. The privilege wall below is history, not current state.

> **SUPERSEDED 2026-08-21 18:11 UTC.** Everything in this section was true when measured at
> ~14:50 UTC and is false as a description of the box today. The four root commands were run, in an
> adapted form, at 18:08–18:11 UTC: `/opt` was made `root:cezar 2775` so the release symlink can be
> replaced without root, linger was enabled for `cezar`, `cezar.socket` + the
> `40-non-disruptive.conf` drop-in + `cezar-runs.slice` were installed, and a **scoped polkit rule**
> (`manage-units` on `cezar.service`/`cezar.socket` only) was added. **`cezar server-deploy
> --strategy=blue-green` now runs as the `cezar` service user with no root and no sudo**, and the
> first such deploy is live. See "Status log — 2026-08-21" above for the re-measured state, and the
> corpus note `cezar-prod-rootless-deploy-provisioning` for the provisioning decisions and their
> blast radius.
>
> **CORRECTED 2026-08-21 (same day) — the "one surviving clause" did not survive either.** It is
> struck through below because it was the last sentence in this banner still telling a reader to go
> find an operator, and `07f5c274` had already made that false. An agent task deploys itself here:
> `decideReExec` reads the unit's `KillMode`, finds `process` on this box, and takes **no** transient
> unit at all — see "The agent-driven deploy gap, closed and measured (2026-08-21, second pass)"
> below for the fix and the five cutovers that measured it. Re-verified 2026-08-21 ~20:5x UTC on
> `prod-host`: `systemctl show cezar.service -p KillMode` → `KillMode=process`.
>
> > ~~**One clause below survives and is still load-bearing:** a deploy driven from *inside* an agent
> > task still fails, because `buildSystemdRunArgv` needs a *system* `systemd-run` transient unit,
> > which `cezar` is correctly denied. Drive the cutover as an operator or from a detached unit.~~
>
> The original text is kept unchanged below because those measurements are the reason the grants
> are shaped the way they are — do not re-derive them, and do not read them as the state of the box.

**The code is on `main`; it has never been deployed, and this session could not deploy it.** That
is not a scheduling gap, it is a permissions wall, and it is worth stating precisely because the
whole design assumes an actor who can install units.

Measured on `prod-host` as the `cezar` service user, which is the uid every agent task runs
as:

```
$ sudo -ln                 → sudo: Sorry, user cezar may not run sudo on prod-host
$ ls -ld /opt              → drwxr-xr-x root root        (not writable by cezar)
$ [ -w /etc/systemd/system ] → false
$ systemctl daemon-reload  → Access denied ... requires interactive authentication
$ ls /etc/polkit-1/rules.d → (no rule mentioning cezar)
$ systemd-run --user --scope → Failed to connect to user scope bus
                               ($DBUS_SESSION_BUS_ADDRESS / $XDG_RUNTIME_DIR unset)
```

Four consequences, each of which blocks a different phase:

1. **P1 cannot migrate.** `/opt/cezar` is owned by `cezar`, so its *contents* are writable, but
   `/opt` itself is root-owned — so `cezar-releases/` cannot be created beside it and `/opt/cezar`
   cannot be renamed aside. The release layout needs one `mkdir` and one `mv` in a root-owned
   directory.
2. **P3 cannot install socket activation.** `cezar.socket`, the `40-non-disruptive.conf` drop-in
   and `cezar-runs.slice` all live in `/etc/systemd/system`, and none of it takes effect without
   `systemctl daemon-reload`.
3. **P4 falls back to its weakest isolation.** There is no user manager for `cezar` (no linger), so
   `systemd-run --user --scope --slice=cezar-runs.slice` — `chooseIsolation`'s preferred mode — is
   unavailable. Without the `Delegate=yes` drop-in from (2) either, `chooseIsolation` resolves to
   **`none`**, which `describeIsolation` correctly reports as degraded: runs share the server
   cgroup and a `KillMode=control-group` restart still kills them. The machinery is right; the host
   simply is not configured for it yet.
4. **Nothing can restart the service.** So even a plain in-place code update cannot be activated.

**The unblock is four root commands**, and they are deliberately ordered so the box keeps working
if you stop after any of them. Run as root on the box, from a checkout at `954c6a55` or later:

```bash
# 1. release layout + units, still inert (dry-run first — omit --yes to see the plan)
/usr/bin/node <checkout>/packages/cezar/dist/index.js server-migrate-releases --yes

# 2. let the service user own its runs' cgroups, and give it a user manager for P4 mode 1
loginctl enable-linger cezar

# 3. load the socket + drop-in + slice
systemctl daemon-reload && systemctl enable --now cezar.socket

# 4. the first real cutover, health-gated and self-rolling-back
/usr/bin/node <checkout>/packages/cezar/dist/index.js server-deploy --strategy=blue-green --follow
```

**Do not substitute `systemctl restart cezar.service` for step 4.** That is the exact failure this
spec exists to remove, and until step 3 has loaded `KillMode=process` it still kills every
in-flight run and the deploying session with them.

**A second, independent reason an agent session cannot drive step 4 itself.** Even with root, the
agent performing the deploy is a child of `cezar.service` and its stdout is a pipe to the cockpit
process being replaced. `KillMode=process` saves the *process*, but the reader of its pipe dies, so
the session cannot report what happened. Only a run started *after* brokering is live survives
usefully — which is the feature, and also why the first cutover has to be driven by an operator or
by a detached unit, not by a task inside the cockpit. The E2E harness
(`packages/cezar/scripts/deploy-e2e-probe.mjs`) is deliberately dependency-free and writes its
verdict to a file for exactly this reason.

## E2E results (2026-08-21, this session) — measured, including what did not pass

Driven **from inside an agent task**, which is the configuration that previously could not deploy
at all. Artifacts in `/var/lib/cezar/e2e-artifacts/`.

**Criterion 1 — a deploy mid-run leaves the run alive and streaming: MET, observed on the
deploying session itself.** Broker pid 231420 (claude child 231428) was alive before the 18:58
cutover, and after it the broker was still alive with **ppid=1** — re-parented, not killed — while
the replacement server re-attached to its spool and this session kept streaming without an
`interrupted` event. `KillMode=process` is what makes that true; the broker is a child, and only
the main process is signalled.

**Criterion 2 — the deployer survives, and a bad build rolls back: MET.**

| what | evidence |
| --- | --- |
| deployer survives | the deploy ran to completion from inside the cgroup it restarted, after the `KillMode` fix removed the transient-unit dependency (`07f5c274`) |
| bad build never flips | release `20260821T185909Z-07f5c274`, `healthy: false`, `failedAt: smoke_boot` — "Nothing was flipped and nothing was restarted" |
| boot-then-fail auto-rolls-back | release `20260821T190232Z-07f5c274`, `healthy: false`, note `e2e-readiness-fail`, followed by `20260821T190241Z` `healthy: true` as `current` |

**Criterion 2 — the client-visible gap: met at the HTTP listener, with two costs kept rather than
rounded away.**

| probe run | requests | failed (non-2xx) | connect errors | max latency | p50 / p99 |
| --- | --- | --- | --- | --- | --- |
| `deploy-e2e-agentdriven.json` | 998 | 0 | 0 | 62 ms | 3 / 6 ms |
| `deploy-e2e-measured-cutover.json` | 722 | 0 | 0 | 1127 ms | 3 / 91 ms |
| `cutover-probe.json` | 1185 | 0 | **1** | 1096 ms | 3 / 16 ms |

Two things are deliberately NOT claimed as clean:

1. **One connect error in 1185 requests.** Zero non-2xx across all three runs, but that single
   refusal means "zero refused connections" does not hold universally. It is one event in 2905
   total requests; it is recorded rather than averaged away.
2. **The SSE half was never measured.** Every probe run logged 20 × `events answered 401`: the
   `/events` stream requires authentication in hosted mode and the probe sends none. So `seq`
   continuity across a reconnect — the spec's own definition of "no lost events" — is **unproven
   by this run**. Criterion 1's transcript continuity was verified by other means (the run stayed
   `running` and its spool kept a byte-identical prefix), but the SSE assertion itself did not
   execute. Filed as follow-up.

**`gapMs` is not the client-visible gap.** The deployer's own `gapMs: 50` from an earlier ssh-driven
deploy measures its restart window; the numbers above are what a continuous client actually saw.
The two are different quantities and must not be quoted interchangeably.

## What was measured, and what only looks measured (2026-08-21, agent-driven)

Four cutovers on `prod-host`, all driven **from inside an agent task** — the path that could
not run at all until `07f5c274`. Artifacts in `/var/lib/cezar/e2e-artifacts/`.

**Genuinely measured, and passing:**

| Claim | Evidence |
| --- | --- |
| The deployer survives | The deploy logged `cezar.service stops with KillMode=process — a restart signals only its main process, not this deployer`, never reached for a transient unit, and reported its own success. |
| A deploy mid-run leaves the run alive | This session WAS the in-flight run. Its broker survived every cutover, re-parented to PID 1, and the replacement server re-attached to the spool at the persisted offset. Probe: `a: run never left running` and `a: no interrupted event`, both non-vacuous. |
| HTTP cutover gap = 0 | `deploy-e2e-agentdriven.json`: **998/998 requests OK, 0 failed, 0 refused connections**, max latency `gapMs 62`, p50 3 ms, p99 6 ms. |
| A bad build never flips | Release `20260821T185909Z` failed the smoke gate; ledger records `healthy: false`; the log says "Nothing was flipped and nothing was restarted". |
| Boot-then-fail auto-rolls-back | Release `20260821T190232Z`: `instance_ready` → `cutover (gapMs 49)` → readiness failed → `deploy.rollback failedAt=readiness` → symlink restored to `20260821T190113Z`, ledger `healthy: false`, service and socket active, `/api/v1/ready` 200. |

**HISTORICAL RESULT — CORRECTED 2026-08-24 by a credentialed run.** The probe
subscribes to `/api/v1/events` with no credential. This box is hosted (`CEZ_AUTH=oidc`), so every
attempt returned **401** and `sse.events` stayed **0**. The assertions `c: no seq gaps` and
`c: no seq duplicates` therefore passed **vacuously**: an empty sequence has neither. So criterion
2's *SSE* clause is **unverified** — its HTTP clause is verified, and the artifact does not
distinguish the two. An assertion that cannot fail is not an assertion; filed as `06a170b8`.
The repaired probe later observed 2,164 SSE events across a real cutover and returned FAILED for
94 sequence gaps, so this paragraph describes the old harness and no longer describes current
measurement status.

**Two costs kept rather than rounded away.** An earlier probe run over the same window recorded
**1 refused connection in 1185 requests** with `gapMs 1096` — the ~1.1 s worst case while a new
instance boots, consistent with what `f0d48513` measured (3 keep-alive resets in 4864 requests).
"Gap = 0" is true for the *measured* cutover and is a statement about failed requests, not about
latency: the socket backlog converts a refusal into a wait, and that wait is as long as the new
process takes to answer.

## What the E2E actually measured (2026-08-21, second pass)

An earlier pass recorded five cutovers and read as a clean result. Re-running it after the
agent-driven deploy path was fixed produced a **failing** verdict and, more importantly, showed
that most of the passes were vacuous. Both facts are recorded here rather than smoothed over,
because a vacuous PASS is worse than a FAIL — it is indistinguishable from success.

### The probe's own verdict

```
PASS  b: zero failed HTTP requests
FAIL  b: zero refused connections     ← 1 refusal at t=74.5s of 1185 requests
PASS  c: no seq gaps                  ← VACUOUS: sse.events = 0
PASS  c: no seq duplicates            ← VACUOUS: sse.events = 0
PASS  a: run never left running       ← VACUOUS: run.statuses = [], sawKeptGoing = false
PASS  a: no interrupted event         ← VACUOUS: same
passed: false
```

### What was genuinely measured

| run | requests | non-2xx | refused | worst latency | p50 / p99 |
| --- | --- | --- | --- | --- | --- |
| `cutover-probe.json` (spans 3 cutovers) | 1185 | **0** | **1** | 1127 ms | 3 / 16 ms |
| `deploy-e2e-agentdriven.json` | 998 | **0** | 0 | 62 ms | 3 / 6 ms |
| `deploy-e2e-measured-cutover.json` | 722 | **0** | 0 | 1127 ms | 3 / 91 ms |

Artifacts: `/var/lib/cezar/e2e-artifacts/`.

**Zero non-2xx responses across 2 905 requests** spanning four real cutovers is a real result and
the strongest evidence the design works. But **one refused connection** is not zero, so the
criterion as written ("gap = 0") is **not met**. The worst-case ~1.1 s is the new instance's boot
window: socket activation converts a refusal into queueing, and the spec predicted exactly this
cost (Risks → "Cutover latency in place of cutover failure"). The single refusal is the case where
the backlog did not absorb it; `6c89af7c` tracks it.

### What was NOT measured in this historical pass, and why it mattered

**The SSE half measured nothing.** Every subscribe returned 401 (20 attempts per run,
`sse.events = 0`): this box terminates OIDC and the probe carries no credential, and loopback is
not exempt. So "HTTP/SSE cutover gap = 0" is proven for unary HTTP and **unproven for SSE**. The
run-level assertions are vacuous for the same reason — `run.statuses` was empty, so "never left
running" passed over no observations at all. Filed as `e36b79c0`, whose first acceptance criterion
is that the probe must report UNMEASURED rather than PASS on an empty event list. **CORRECTED
2026-08-24:** commit `83ddbdd2` on `origin/main` implements that guard, and the later credentialed
production run observed 2,164 events rather than laundering an empty sample into PASS.

### Criterion 1 IS met, on independent evidence

Not from the probe — from the deploying session itself. Across the cutovers at 18:58, 19:00, 19:01
and 19:02, this task's own broker (pid 231420) stayed alive and **re-parented to PID 1**, its
`claude` child (231428) stayed under it, and the session kept streaming through every restart with
no `interrupted` event and no lost transcript. That is the criterion, observed first-hand on the
process doing the observing. `KillMode=process` plus the spool is what makes it true.

### The two failure paths

- **Bad build never flips: PROVEN.** Release `20260821T185909Z-07f5c274` failed its smoke gate and
  is recorded `healthy: false`; nothing was flipped and nothing was restarted. `20260821T190232Z`
  did the same later. Fail-closed works.
- **Boot-then-fail auto-rollback: STILL UNPROVEN.** No build was manufactured that boots and then
  fails readiness. Fabricating one on the production box was judged not worth the risk at this
  stage; it remains the one claim in P5 with no live evidence, and `6497f002` (runRollback never
  probes readiness) is a known defect on that same path.
  **CORRECTED 2026-08-22 — `6497f002` is fixed** (`runRollback` now probes readiness; see the
  correction under "What the acceptance run exposed" above). This bullet's own claim, "boot-then-fail
  auto-rollback unproven", is unaffected — it is about `runGatedDeploy`'s P5 gate, not `runRollback`,
  and still has no live evidence.

## Criterion 1 was reopened by a controlled re-measurement (2026-08-21 19:05 UTC)

**This section supersedes the "Criterion 1 ... is MET, measured" claim above.** That claim is left
in place below, unedited, because it was made in good faith from a real observation — but a
controlled single-cutover measurement contradicts it, and the contradiction is not subtle.

**What was measured.** One `server-deploy --strategy=blue-green`, driven from inside an agent task,
with nothing else deploying concurrently (the earlier run was polluted: TWO cutovers landed inside
its 120 s window, `20260821T190101Z` and `20260821T190113Z`).

| | before 19:02:41 | after 19:02:46 |
| --- | --- | --- |
| broker pid | 231420 alive | **gone** |
| claude pid | 231428 alive | **gone** |
| spool size | 21026 B | 24532 B |
| same-length prefix sha256 | `35201d24…` | **differs** |
| `meta.json` broker | 231420 | **262531**, `startedAt 19:02:48.576Z` |

The spool was rewritten from byte zero rather than appended to, and `meta.json` names a broker
started one second *after* the deploy finished. `RunManager.recover()` did not take its re-attach
branch; it treated the run as interrupted and started a fresh session. **Criterion 1 — "a deploy
mid-run leaves the run alive and streaming" — is therefore not met on this path.**

**The contrast that makes it diagnosable, not mysterious:** earlier in the same session a plain
`systemctl stop → start` DID leave broker 231420 alive, re-parented to PID 1, and this session kept
streaming across it. The broker survives a bare restart and does not survive the cutover. Three
suspects, in order, in todo `45813876`: `consumedOffset`/`spoolDir` never persisted onto the run
record; the release flip moving the install path so the new process resolves a different runs dir;
or the deploy stopping the unit in a way that reaches the broker (isolation is `delegated`, not
`scope`).

**And the harness said everything was fine.** `deploy-e2e-probe.mjs` printed `passed: true` with all
six assertions PASS on that same cutover, while its own payload recorded `sse.events: 0`,
`run.statuses: []` and twenty `events answered 401` errors — the box is hosted, so `/api/v1/events`
and `/api/v1/runs` refuse an unauthenticated local client, and the probe scored its criterion-1 and
seq-continuity assertions over an empty set. A harness that green-lights a criterion it never
observed is worse than none: it launders "unmeasured" into "passed". Filed as `58e5954c`.

**What DOES stand, measured on the same controlled cutover** (`final-cutover.json`): 573 requests at
10 rps against `/api/v1/ready`, **0 failed responses, 0 connect errors**, p50 3 ms, p99 243 ms, max
1129 ms. Zero refusals across a real process replacement is criterion 2 at the listener, and it is
the socket-activation design working. The 1129 ms worst case is the new instance booting behind a
held socket — latency, not failure, exactly the trade the spec predicted.

**Also verified on this pass:** the deployer survives, and an agent-driven deploy no longer reaches
for a privilege it was refused — the deploy logged *"cezar.service stops with KillMode=process — a
restart signals only its main process, not this deployer"* and never created a transient unit
(`07f5c274`). The bad-build gate fired for real: release `20260821T185909Z-07f5c274` is recorded
`[unhealthy]`, nothing flipped and nothing restarted.

## The agent-driven deploy gap, closed and measured (2026-08-21, second pass)

`f0d48513` recorded five operator-driven cutovers and reported both criteria met. This pass closed
the one path it could not use — a deploy driven from **inside an agent task** — and, in measuring
it, found that part of what the probe reported was never actually observed.

### What was fixed

`buildSystemdRunArgv` shelled out to a **system** `systemd-run`. An operator over ssh never hit it
(`decideReExec` returns false there — not inside the unit's cgroup); an agent task IS inside
`cezar.service`'s cgroup, took the re-exec branch, and died on *"Access denied … requires
interactive authentication"*. The tempting fix — a polkit grant on `cezar-deploy-*` — is
root-equivalent under a narrow name, because a system transient unit runs as root by default. Both
legitimate fixes shipped in `07f5c274`:

- **Read the unit's `KillMode` and skip the escape when it is already `process`** (the one that
  carries this box). Checked *before* `systemdRunAvailable`, so a migrated host logs "no escape
  needed" rather than "no escape possible" — those read very differently at 3am. An unreadable
  `KillMode` is treated as dangerous, never optimistically skipped.
- **Ask the USER manager** when not root, for a host that has not been migrated. This needed one
  thing no plan mentioned and only running it revealed: inside `cezar.service`, `XDG_RUNTIME_DIR`
  and `DBUS_SESSION_BUS_ADDRESS` are **unset**, so `systemd-run --user` fails with "Failed to
  connect to user scope bus" *even with `Linger=yes`*. Over ssh a login session sets them, which is
  exactly why the gap stayed invisible. `userBusEnv()` supplies them.

Live proof, from inside this task: `deploy: cezar.service stops with KillMode=process — a restart
signals only its main process, not this deployer`, followed by a completed cutover. No transient
unit was requested at all.

### What the cutovers measured

Four agent-driven cutovers plus one deliberate failure, artifacts in `/var/lib/cezar/e2e-artifacts/`:

| run | poll ok/total | non-2xx | connect errors | `deploy.cutover gapMs` |
| --- | --- | --- | --- | --- |
| `deploy-e2e-measured-cutover` | 722/722 | 0 | 0 | 55 |
| `final-cutover` | 573/573 | 0 | 0 | — |
| `cutover-probe` | 1443/1444 | 0 | 1 | — |
| `rollback-probe` | 670/671 | 0 | 1 | — |

**`gapMs: 55` is the DEPLOYER's own restart window, not the client-visible gap.** They are different
numbers and conflating them would overstate the result; the client-visible figure is the poll
column, and on the two clean runs it is *zero failed requests out of 722 and 573*.

**Both failure paths fired for real.** A stale `dist` produced a genuine bad build: `smoke_boot`
failed, and — exactly as designed — *nothing was flipped and nothing was restarted*. Separately the
ledger records `20260821T190232Z-07f5c274` with `note: e2e-readiness-fail, healthy: false`,
followed immediately by a healthy release: the readiness gate rolled back on its own.

### What was NOT measured in these historical runs, and must not be read as passing

**`/api/v1/events` answered 401 in all five runs**, because this box is hosted-mode with OIDC and
the probe sends no credential. The SSE subscriber therefore observed **zero** events — and the
probe still reported `c: no seq gaps` and `c: no seq duplicates` as PASS, because
`gaps.length === 0` is trivially true on an empty sample (`deploy-e2e-probe.mjs:204`). The run
assertions are vacuous the same way: `run.statuses` is `[]` and `sawInterrupted` never flips, yet
both report PASS. `maxLatencyMs` came back `null` in every artifact. **CORRECTED 2026-08-24:** a
credentialed production run subsequently observed 2,164 SSE events, one reconnect, and 55 run
samples. It returned FAILED on one refusal and 94 sequence gaps; todo `8206c158` owns the new gap
finding.

So of the six assertions, **two carry real data** (the HTTP poll pair) and four had nothing behind
them. Two runs reported `passed: true` on that basis. Filed as `8dc8bf3a`.

**Criterion 1 — do NOT read this pass as supporting it.** Mid-session this run observed its own
broker (pid 231420) alive and re-parented to PID 1 with its `claude` child (231428) under it, and
recorded that as survival. That observation was real but it was taken across the plain
stop/start used to re-arm `cezar.socket`, not across a blue-green cutover — and it does not
generalise. By the end of the pass pid 231420 was **gone** and the spool's `meta.json` named a new
broker (262531, started 19:02:48), i.e. the run had been **re-launched, not re-attached**. That is
the same conclusion the controlled re-measurement reached independently, and it is why the header
reopened criterion 1 at 19:05 UTC. Incidental survival of one restart is not evidence of
re-attachment; the controlled measurement is authoritative and this paragraph defers to it.

**Status therefore stays QA Needed**, but the reason is corrected: criterion 1 is reopened (the
cutover path re-launches rather than re-attaches), and the now-measured SSE half of criterion 2
failed with 94 sequence gaps. The HTTP measurement also retained one real refusal/boot-window
cost. Calling this Done would round measured failures up to a green tick; todos `8206c158` and
`6c89af7c` preserve those distinct follow-ups. Todo `8dc8bf3a` is done because the harness itself
now refuses vacuous PASS and successfully collected authenticated samples.

## Out of scope (decisions, not omissions)

- **Multi-host / horizontal scale-out.** One box.
- **A real cross-process lock on `.ai/cezar/`.** Correction 2 makes the case that one is missing,
  and the canary above makes its absence visible, but every phase here is designed to never need
  it. Filed as follow-up.
- **Brokering `codex` / `opencode` / `pi`.** P4 covers `claude` only; see "Backend scope" above.
  `/api/v1/health` reports which backends are brokered so this is visible, not assumed.
- **Changing the state format.** Two optional `RunRecord` fields and one new ledger file; nothing
  existing is migrated.
- **Moving the tunnel ingress or introducing nginx on this box.** Correction 1 rules the first out
  as a cutover primitive; the second is a new perimeter component this design does not need.
