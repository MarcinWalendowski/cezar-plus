# Eight tasks at once: bound the burst, then spread across nodes

**Status:** Proposed
**Date:** 2026-08-22
**Revised:** 2026-08-22 (same day), twice — after the owner corrected the premise, then after the
owner set the node economics

> **CORRECTED 2026-08-22 — the first draft led with "a second node is worth having for
> *capability*, not for compute", and that was wrong.** Owner: *"It's mostly about machine compute:
> right now on 8vcpu max 3/4 tasks can run because of cpu usage for search and running tests. I want
> to run 8 tasks distributed across nodes/workers."* The draft cited the corpus note *"cezar run
> speed is round-trip bound, not box bound"* as if it settled the question. It does not — **that
> note measures the latency of ONE run, and this is a question about the throughput of N.** A single
> run is round-trip bound; eight concurrent runs are bound by whatever the box runs out of first.
> Both statements are true and they are about different quantities.
>
> The goal is **8 concurrent tasks**. The capability argument survives, demoted: it is why *which*
> node matters, not why a second node exists. Everything downstream of the premise changed with it
> — the placement default (D12), the capacity model (D14), and a new Phase 0 that raises
> concurrency on the existing box before any node is added.

## TLDR

Two cezar cockpits already run against the same workspace — `prod-host` (12 registered
projects under `/var/lib/cezar/loki-labs`, always on, public through the tunnel) and the Mac (12
registered projects, 11 of them under `/Users/mw/loki-labs`, where the owner actually sits). They
share a backlog by **hand**: the 2026-08-17 corpus note says *"Both cockpits carry the same entries
with the same ids; a change on one side should be mirrored to the other."* Measured 2026-08-22, five
days later, that mirror has failed in the only direction it could: **110 todos exist on the box and
on neither Mac file, 10 more disagree about their status, and not one entry exists Mac-only.** The
Mac cockpit is a stale read-only window onto work it cannot see.

**The ceiling is a burst, and it is measurable.** Across the 12 largest runs on the box (85.3 h of
step wall time), `run-tests` is **12.9 %** of it — median 7.6 min, p90 45.1 min. But a run in that
step is a different animal from a run outside it: peak process-tree footprint is **0.4–0.6 GB and
1–8 processes** at rest versus **2.2–6.2 GB and 18–50 processes** while testing, on a **15 GB /
8 vCPU** box. Two runs testing simultaneously is ~10 GB; three is the whole machine. That is the
3-to-4 ceiling, and `maxParallel` — which counts *runs* — cannot see it, because it cannot tell an
idle run from one that is about to fork 50 processes.

So the answer is three levers in cost order, and only the third needs a second machine:

1. **Bound the burst.** Each run already executes in its own systemd scope on this box
   (`cezar-run-*.scope` under `cezar-runs.slice`), so `MemoryMax` / `CPUWeight` / `CPUQuota` are one
   property each — plus capping vitest workers and ripgrep threads at the source.
2. **Gate the burst.** Admit many runs but let only *k* be inside a heavy step at once. At 12.9 %
   duty cycle, 8 concurrent runs expect ~1 simultaneous heavy step; a gate of 2 blocks ~6 % of the
   time. **This is what gets 8 tasks onto the existing box** — no cluster required.
3. **Add nodes** for anything beyond one box's ceiling.

**And the Mac is not the small helper this spec first assumed.** It is an **M4 Max, 16 cores,
128 GB RAM, 742 GB free** against the box's 8 shared vCPU and 15 GB — **8.5× the memory**, which is
the axis that actually binds. On memory alone it seats ~8 concurrent *testing* runs where the box
seats 2. The box's value is that it is always on and addressable; the Mac's is that it is the
bigger machine.

The cluster is therefore hub-and-spoke: `hel1` is the **hub** because it is reachable, spokes dial
out to it (measured application-layer round trip Mac → box → Mac through the tunnel: **58 ms
median**, n=10, min 56.8 / max 59.0), a small explicit tier of state replicates in near-real-time,
cluster-scoped leases guard anything that starts work or spends the shared subscription, and each
node advertises **capacity** so the scheduler can fill it. Capability labels — macOS, iMessage, a
browser, a device — then decide *which* eligible node, not whether a second one is worth having.

**A node costs about EUR 20/mo, and the shape of the fleet follows from that.** Owner: *"it's
cheaper to have 3x vps of 8vcpu than 24vcpu machine"* — true, and the measured 12.9 % duty cycle
says why: we are buying **burst**, which is exactly what shared vCPU is for. The dividing line is
shared versus dedicated, not small versus big (§2b: 3 × CX43 ≈ EUR 61/mo for 24 vCPU against
~EUR 339/mo for a 16-vCPU dedicated machine; within the shared line, price is linear). So workers
are **homogeneous CX43-class, `maxHeavySteps: 2` each, no backups, minted by a script** — cattle,
because their entire state is worktrees and caches while the record lives on the hub. The Mac is
the exception: the biggest machine here, and the one that sleeps, so it is a *capability* node that
may take overflow, never a capacity number you can count on. The next ceiling after compute is not
compute — it is the **agent subscription**, for which no measured number exists (§4, Q2a).

**A fleet you cannot see is a fleet you will not run.** So the cockpit gets its own stage
(**Phase 1b**, before any state replicates): one Settings section listing every node with the two
numbers admission actually uses (`active/maxParallel`, `heavyActive/maxHeavySteps`), which
enforcement it really has (`cgroup` on Linux, `process-tree` on the Mac, or `none` — stated, never
implied), its labels, its repo drift, and the age of its last presence. Adding a node is one
minted, copyable line — `npx -y @loki-labs/better-cezar@<hub version> cluster join cezj_…` — whose
token is **single-use and short-lived by design**, because a command rendered in a UI ends up in
screenshots and shell histories, and because every path on the hub 302s to Cloudflare Access, which
rules `curl … | sh` out entirely (D17).

The single most important thing in this document is a refusal: **replication must not ship before
the claim lease.** `todo-autostart.ts` turns `autostart: true` into a live agent run from an
`fs.watch` on `todos.json`, and the "first start wins" guarantee that stops a double start today is
`markStarted`'s **`O_EXCL` file lease**, which is local to one filesystem by construction. Two
nodes are two files and two leases. Replicate todos without a cluster lease and every autostarted
task runs twice, in two worktrees, spending two agent sessions of the same subscription.

## Problem

### 1. The shared backlog has already diverged, and only one direction ever wrote

Measured 2026-08-22 by reading `todos.json` on both hosts and diffing by todo id:

| project | Mac total / open | box total / open | box-only ids | Mac-only ids | same id, different `status`/`archivedAt` |
|---|---|---|---|---|---|
| `chat` | 589 / 83 | 596 / 80 | 7 | 0 | 10 |
| `cezar` | 33 / 8 | **136 / 88** | **103** | 0 | 0 |
| `aside` | 8 / 1 | 8 / 1 | 0 | 0 | 0 |
| `career-kit` | 1 / 0 | 1 / 0 | 0 | 0 | 0 |
| `anymail-mcp` | 0 | *(no file)* | — | — | — |

Two facts fall out of that table, and both shape the design.

**`Mac-only = 0` everywhere.** Every write for five days landed on the box. The Mac cockpit is not a
second workstation, it is a stale mirror — the owner cannot file a task on it and expect anyone,
human or agent, to ever see it. A design that "syncs both ways eventually" is not enough: the Mac
has to become a place where filing work is *safe*, or it will keep not being used.

**The 10 disagreeing `chat` rows are field-level, not row-level.** They differ on `status` and
`archivedAt` — the two fields the Tasks board writes most. A whole-row last-writer-wins merge
resolves those by throwing one side's edit away. That is why D4 below is per-field, not per-record.

### 2. The concurrency ceiling is a burst inside one step, not a per-run cost

Owner, 2026-08-22: *"on 8vcpu max 3/4 tasks can run because of cpu usage for search and running
tests. I want to run 8 tasks distributed across nodes/workers."* `maxParallel` on the box is
currently **5** and is not reachable in practice.

**The workload is bimodal, sharply.** Every run record on the box carrying usage data (n=29,
`peakRssBytes` = summed process-tree RSS, `peakProcCount`):

| band | peak footprint | processes | which runs |
|---|---|---|---|
| at rest | **0.4–0.6 GB** | **1–8** | 17 of 26 `cezar` runs |
| testing | **2.2–6.2 GB** | **18–50** | 9 of 26 `cezar` runs, and **all 3** `chat` runs |

There is nothing in between. A run is ~0.5 GB and 4 processes until it reaches `run-tests`, at which
point vitest spawns roughly one worker per file and it becomes a 40-to-50 process, multi-gigabyte
job. `isolate: false` is not an escape — the corpus records it dying at exit 144 on both machines,
because the suite spawns real processes and one stray spawn takes a shared worker down.

**Against the hardware, that is the whole ceiling.** The box is **8 vCPU (AMD EPYC-Rome), 15 GB
RAM** (≈12 GB available), 122 GB free disk. At ~5 GB per testing run, two concurrent test steps is
~10 GB and three is the entire machine. The observed 3-to-4 limit is what those numbers predict.

**The heavy phase is a small fraction of a run.** Per-step wall time reconstructed from `step-start`
events across the 12 largest runs (85.3 h total):

| step | n | median | p90 | share of wall time |
|---|---|---|---|---|
| `run-tests` | 18 | 7.6 min | 45.1 min | **12.9 %** |
| `commit-push` | 18 | 3.3 min | 40.4 min | 13.9 % |
| `spec` | 66 | 5.5 min | 12.7 min | 8.4 % |
| `implement` | 27 | 7.3 min | 29.3 min | 5.5 % |
| `review-spec` | 60 | 5.6 min | 7.6 min | 6.1 % |

So eight concurrent runs expect **~1** simultaneous heavy step (8 × 0.129), and under a crude
independence assumption fewer than three are heavy ~93 % of the time. **A gate of 2 concurrent heavy
steps supports 8 concurrent runs and blocks about 6 % of the time.** The independence assumption is
the weak part and is exactly why this must be a gate rather than a hope: eight tasks launched
together march through the same workflow in near-lockstep, so their heavy phases correlate. A
semaphore is correct under correlation; a probability is not.

**One number is missing and it is the one the owner named.** cezar samples per-run CPU live
(`process-usage.ts` → `cpuPct`, summed across the descendant tree) and **never persists it** — zero
occurrences in the run NDJSON, no field on `RunRecord`. Memory and process counts are recorded; CPU
is not. So "CPU is the constraint" is a well-founded observation, not a measured one, and this spec
treats closing that gap as Phase 0 work rather than assuming which resource binds first.

`peakRssBytes` also needs a caveat before anyone sizes hardware from it: it is a **sum of `ps` RSS**
across 40-plus node workers, so shared pages are counted many times and the true footprint is
lower. The accurate number is already available and unused — each run runs in its own cgroup on this
box, so `memory.peak` and `cpu.stat` can be read from the scope directly.

### 2a. Which node, once there is more than one

Capacity says *add* a node. Capability says *which*. Both matter — and the point of §2b is that
capacity nodes **should** be interchangeable, which makes the Mac the one node that is not.

What the Mac has that the box does not:

- **Eight and a half times the memory, and twice the cores.** M4 Max, **16 cores / 128 GB RAM /
  742 GB free**, against 8 shared vCPU / 15 GB / 122 GB. Memory is the axis that binds here, so on
  that axis alone the Mac seats ~8 concurrent *testing* runs where the box seats 2. The second node
  is the **bigger** node, which is the opposite of how this spec's first draft framed it.
- **macOS and Apple services** — Messages.db, the `imsg` binaries, FindMy, Contacts, the TCC grants.
  Every device E2E in `AGENTS.md` → "Definition of Done" needs them, and the box cannot run one.
- **The Chrome bridge** and a real logged-in browser profile.
- **The owner's working tree**, including uncommitted work, and their keychain and git identity.

What the box has that the Mac does not: it is **always on**, it has a **stable inbound address**, it
holds the Cloudflare token and the 1Password service account, and it self-deploys. Note that none of
those are compute. The box earns the **hub** role by being reachable, and it is the weaker worker.

Two consequences the design has to carry:

- **The Mac sleeps.** Capacity that disappears when a lid closes is not capacity you can promise, so
  a queued task must degrade to "waiting for `mac`" visibly rather than stalling silently — and the
  hub must still be able to run *something* alone.
- **Work products land where the run ran.** Eight tasks spread over N hosts means eight worktrees
  and eight branches scattered across them. Each node pushes its own branch to `origin`; the review
  gate and diff are rendered from the node that ran it, over the relay. This is also why a worker
  can be cattle (§2b): the durable artefact is the pushed branch, not the disk it was built on —
  but note the corollary, that a node destroyed mid-run destroys unpushed work, so decommission
  drains first.

  **And the corollary has an exception with teeth: 4 of the 12 registered projects have no
  `origin` at all** (§6 — `brand`, `mw-site`, `lokie-chatbox`, and `loki-labs` itself). For those,
  a commit on a worker exists *only* on that worker's disk, so "cattle" would mean losing it on
  rebuild. Placement must therefore refuse to dispatch a remote-less project to a node that is not
  the one holding the record for it, rather than running it somewhere the result cannot leave.
  A machine you plan to destroy must not be the only copy of anything.

### 2b. Scale out on shared vCPU, because that is what the burst is worth paying for

Owner, 2026-08-22: *"it's cheaper to have 3x vps of 8vcpu than 24vcpu machine."* Correct, and the
measured duty cycle says *why* — but the saving is not where it first looks.

All-in monthly, VAT included at 23 %. The anchor is what we actually pay, from 1Password: the
existing box is **EUR 24.22/mo** = server 19.67 + backups 3.93 + IPv4 0.82. Public list prices are
quoted ex-VAT (CX43 EUR 15.99 → 19.67 incl., exactly), so the two reconcile with nothing missing:

| option | vCPU | RAM | EUR/mo incl. VAT |
|---|---|---|---|
| **3 × CX43** (shared) | 24 | 48 GB | **~61** (3 × 19.67 + 3 × 0.82 IPv4, no backups — see below) |
| 2 × CX43 | 16 | 32 GB | ~41 |
| 1 × CX53 (shared) | 16 | 32 GB | ~36 |
| **1 × CCX43 (dedicated)** | **16** | 64 GB | **~339** |

**The real dividing line is shared versus dedicated, not small versus big.** Within the shared line
price is almost exactly linear — 2 × CX43 (~41) against 1 × CX53 (~36) is a wash — so "three small
boxes" wins nothing over "one bigger shared box" on price alone. Against a *dedicated*-vCPU machine
it wins enormously: **~5.5× the cost for two-thirds of the vCPU count**, after the June 2026
increase that roughly doubled CCX pricing while CX rose 30-40 %.

And the 12.9 % duty cycle is precisely the argument for shared vCPU: **we are buying burst.** A
dedicated core is worth paying for when a machine is steadily saturated; ours is idle ~87 % of the
time and then wants everything for seven minutes. That is the workload shared vCPU exists for.

So within the shared line the choice is architectural, and it favours more small nodes:

- **Failure domain.** One node down costs a third of capacity, not all of it. Today it costs all.
- **Rolling restarts.** The hub self-deploys ~10×/day; with N nodes you drain one instead of
  interrupting everything (D15b).
- **It matches the memory shape.** A testing run wants ~5 GB, so a 16 GB node seats 2 heavy steps —
  the same `maxHeavySteps: 2` on every node. Three nodes is 6 concurrent heavy steps, which at
  12.9 % duty cycle supports far more than the 8 runs being asked for.
- **Homogeneous nodes make placement trivial** — identical labels, identical caps, pure
  least-loaded (D12), no special cases.

**What scale-out actually costs, and it is not the VPS bill.** Each node needs a checkout of every
repo, `node_modules` per worktree, worktree retention (already **7.7 GB** on one box, against
160 GB of disk), agent CLI logins, credentials, and — the one that has already bitten — **keeping
its checkout current**, since a push is not delivery. Three nodes is three of all of that. **Node
provisioning must therefore be a script, not a runbook**, before node 3 exists; the marginal cost of
a node has to be minutes, or the fleet silently drifts.

**And half of that script already exists — which changes the work from "write a provisioner" to
"extend one".** `cez server-install --platform hetzner` is a step orchestrator
(`server-install/platforms/hetzner.ts` over pure generators in `hetzner/{provision-user,
systemd-unit,nginx,tls}.ts`) that already creates a dedicated unix user and `CEZ_HOME`, writes the
systemd and socket units, installs the agent CLIs (`claude`, `codex`, `gh`), configures nginx and
TLS, and finishes with an end-to-end verification step. What it stands up is a **cockpit for an
org**, not a worker: no repo checkouts, no agent CLI *logins*, no cgroup caps, no
`CEZ_ENV_PASSTHROUGH`, no cluster enrollment. So the delta is a role, not a new tool — and the
repo's command convention is `server-*`, not a new `node` namespace.

**The evidence that this matters is the box we already have.** `cez server-migrate-releases` exists
with the comment *"the live unit on `prod-host` is hand-written — no generator in this repo
authored it"*. The single node in production was provisioned by hand and then needed a bespoke
one-shot command to be dragged into the layout the installer assumes. **N=1 already drifted from
its own installer.** That is the argument for making the script the only path, stated as a measured
fact rather than a principle.

Which licenses a small saving worth taking: **worker nodes are cattle.** Their state is worktrees,
caches and `node_modules` — all disposable, since the record lives on the hub (tier 1/2). So a
worker takes **no backups** (−EUR 3.93/mo each) and is rebuilt by the provisioning script instead of
restored. Only the hub, which holds the leases and the corpus, is a pet.

**The ceiling money cannot move.** Compute is the cheap constraint; the **agent subscription** is
not. Every node draws on the same pool — two Claude logins and one Codex — and their limits are
per-account 5-hour windows that no VPS purchase widens (Problem §4). There is **no measured number**
for how much concurrency that pool sustains, and this spec does not invent one. Buy nodes to reach
8, then read the account panel (it reports real Claude usage windows) at 8 concurrent **before**
buying nodes 4 through 6 — otherwise the outcome is idle vCPUs waiting on a quota, at EUR 20 each
per month.

### 3. Every exactly-once guarantee cezar owns is a local file lease

This is the load-bearing hazard, and it is worth naming precisely.

`markStarted` (`todos.ts:426`) documents the guarantee: *"First start wins: an entry that already
carries a `startedTaskId` is left untouched … the check shares this lease, so two concurrent
launches cannot both claim the entry."* The lease is `withTodosLease` — an `O_EXCL` open of
`.ai/cezar/todos.lock`. The same idiom guards `identity-store.ts`, `automations/store.ts` and
`sources/store.ts`.

Every one of those is a lock on **one host's filesystem**. Nothing in cezar has ever needed a lock
that spans machines, so nothing has one. The moment two nodes hold copies of the same `todos.json`:

- `todo-autostart.ts` watches the file (`onTodosChanged`) and starts a run for any `autostart: true`
  entry. A replicated write fires that watcher on **both** nodes.
- `markStarted` clears the flag under the local lease — but only *after* `resolveTodoWorkflow` and
  `startRun`, and that clear then has to replicate before the other node's watcher reads the file.
- The two windows are the **same order of magnitude**: a 300 ms watcher debounce
  (`todos.ts:493`) against a ~58 ms link. So the outcome is a coin flip, not a certainty — which is
  the worse failure, because it will pass a smoke test and then double-start on the day it matters.
  It also means the bug **cannot be tuned away**; only a lock that spans both hosts closes it.
- When it loses the flip: two live agents, two worktrees, two sessions of the same Claude
  subscription, and two `startedTaskId` values for one entry.

The same shape applies to every scheduler that *creates* work: the automations poller, the sources
sweep, the reopen sweep, the backup scheduler.

### 4. Every node drains the same one subscription, and that is the ceiling money cannot move

`~/.cezar/agent-accounts.json` on the box sets `defaults: {claude: "pool:*", codex: "pool:*"}` —
balance across claude:default (kontakt@), claude:secondary (owner@) and codex:default.
Those are *subscription* accounts. Their 5-hour windows are a property of the account, not of the
host.

`agent-account-usage.json` is per node. Two nodes balancing independently both compute "the freshest
account" and both route to it — balance equalises utilisation, so it converges on the *same* answer
rather than alternating. And the usage-limit `deadline` hold that parks work when a window shuts is
also per node, so node B keeps dispatching into a limit node A already observed.

Account state is cluster state. Nothing else in this design forces a synchronous cross-node call;
this does, and it is affordable at 58 ms per *dispatch* (against a measured median 6.1 s gap between
an agent's tool calls, one grant per run start is noise).

**This scales differently from everything else in the spec, and in the wrong direction.** Compute
is buyable at ~EUR 20 per node (§2b); the pool is three logins whose 5-hour windows widen for
nobody. So each node added past the point where the pool saturates buys queueing, not throughput —
and the spec has **no measured number** for where that point is. Do not guess one: reach 8
concurrent, read the account panel's real usage windows at that load, then decide about nodes 4-6.

### 5. Node-local state is most of the bytes, and none of it should move

Measured on the box:

| what | size | node-local because |
|---|---|---|
| `worktrees/` (`cezar` 4.8 GB + `chat` 2.9 GB) | **7.7 GB** | a git worktree is a path on a disk |
| run event NDJSON | **145.9 MB across the 46 run files touched in the last 24 h** (file sizes, not bytes written in the window — the order of magnitude is the point); largest single run 12,575 events / 25.7 MB | firehose; only interesting while someone is watching |
| `launch-key`, `identity/`, sessions | — | secrets scoped to one host |
| `~/.claude`, `~/.codex`, `configDir` paths | — | provider credentials |
| project `root`, `browseRoot`, `projectsDir` | — | `/Users/mw/loki-labs` ≠ `/var/lib/cezar/loki-labs` |
| `agent-accounts.json` `selections` | — | **keyed by realpath'd project root** |

A "just rsync `~/.cezar` and `.ai/cezar`" design fails on the last row alone: account selections and
knowledge mounts are keyed by absolute paths that differ per host.

### 6. The identity a cluster needs does not exist yet

`allocateProjectSlug` derives a project id from the directory basename and **deduplicates it against
that node's own registry** (`api`, `api-2`, `api-3`). The two registries happen to agree on most ids
today — that is luck, not identity.

The obvious alternative, the git remote, fails twice over on this very workspace:

- **Not universal.** 4 of the box's 12 registered projects have no `origin` at all — `brand`,
  `mw-site`, `lokie-chatbox`, and `loki-labs` itself (the doctrine repo, deliberately remote-less).
- **Not unique.** The Mac's registry contains `chat-wt-spec-101`, which is a **git worktree of
  `chat`** (`gitdir: …/chat/.git/worktrees/chat-wt-spec-101`) and therefore reports
  `git@github.com:Loki-Labs-AI/chat.git` — the same origin as `chat`. An origin-keyed auto-pair
  would happily pair the box's `chat` with a Mac worktree and write `chat`'s whole backlog into it.

### 7. Reaching the hub is not yet possible with the credential we have

Measured: `GET https://cockpit.example.com/api/v1/health` with the 1Password Access service token
(`Hetzner - prod-host` → `Access Service Token`) returns **302** to the Access login — and the
redirect is Cloudflare's, not cezar's: the signed `meta` JWT in the `Location` carries
`"service_token_status": false, "auth_status": "NONE"`, i.e. Access saw the token and did not accept
it. It is scoped to the *SSH* app (`89109026-…`), not the cockpit app (`431e855c-…`). A
node-to-node link therefore needs either its own service token on the cockpit app's policy, or it
rides the SSH tunnel. This is a provisioning step, not a design question, but it must be in the plan
or Phase 1 stalls on it.

### 8. The nodes are never on the same build

Both report `0.10.0`, but at the moment this spec was started: the box served release
`20260822T151735Z-c09ec8b4`, the box's own checkout sat at `2778fd52`, and the Mac's checkout was
**14 commits behind** `origin/main` (fast-forwarded to write this file — which is itself the point:
it took a deliberate act). The box self-deploys roughly ten times a day. **Version skew is the
steady state, not an incident**, so the link protocol has to survive it deliberately rather than by
luck.

## Solution

### Shape

One **hub**, N **spokes**, and the spokes are meant to be **interchangeable**. A spoke holds a
single outbound WebSocket to the hub and never listens for inbound connections.

```
   ┌──────────────── prod-host  (hub) ─────────────────┐
   │  cockpit.example.com · always on · owns cluster leases  │
   │  the KB corpus · the record · a PET (backed up)         │
   │  also a worker: maxParallel 8, maxHeavySteps 2          │
   └──▲──────────────────▲──────────────────▲────────────────┘
      │ outbound WSS (Cloudflare Tunnel), 58 ms median RTT, measured
      │                  │                  │
 ┌────┴──────────┐ ┌─────┴─────────┐ ┌──────┴────────────────┐
 │ worker-2      │ │ worker-3      │ │ mac                   │
 │ CX43, ~EUR 20 │ │ CX43, ~EUR 20 │ │ M4 Max 16c / 128 GB   │
 │ CATTLE        │ │ CATTLE        │ │ labels: macos,        │
 │ no backups    │ │ no backups    │ │ imessage, browser,    │
 │ heavySteps 2  │ │ heavySteps 2  │ │ device-e2e · SLEEPS   │
 └───────────────┘ └───────────────┘ └───────────────────────┘
   homogeneous, script-provisioned      special capabilities
```

Two classes of spoke, and the distinction is the whole scaling story. **Homogeneous workers**
(CX43-shaped, identical caps and labels, provisioned by script, no backups) are how you buy
throughput: each adds 8 vCPU / 16 GB / 2 heavy-step slots for ~EUR 20/mo. **The Mac** is a
capability node that happens to also be the largest machine in the fleet, and it is the one node
whose availability you cannot promise.

Hub-and-spoke rather than peer-to-peer, for reasons that are facts about this deployment, not
preferences: the Mac has **no inbound address**; the Mac **sleeps**, so a node that was away needs
somewhere durable to catch up from; a VPS worker is cattle that should carry no coordination state
at all; and at N=2..6 a gossip mesh buys nothing and costs a discovery protocol and an anti-entropy
layer.

**The hub is a role, not a new program.** A cezar server with `CEZ_CLUSTER=1` and no
`CEZ_CLUSTER_HUB` is a hub; one with `CEZ_CLUSTER_HUB=<url>` is a spoke. No second daemon, no port
to remember — the *"prefer a proxy-free, daemon-free mechanism"* rule in AGENTS.md → Zero config.

### The three tiers of state

The whole design is this table. Anything not in tier 1 does not replicate.

**Tier 1 — replicated, converges on every node**

| entity | store | scope |
|---|---|---|
| todos | `.ai/cezar/todos.json` (merged in place) | project |
| run **index projection** | `~/.cezar/cluster/runs-remote.json` (new, additive) | project |
| reports triage decisions | `~/.cezar/reports-triage.json` | workspace |
| node roster, pairings, placement rules | `~/.cezar/cluster/*` (new) | workspace |

**Tier 2 — hub-authoritative, spokes call through**

| thing | why it cannot be replicated |
|---|---|
| todo **claim lease** (who may start it) | mutual exclusion is not eventually consistent |
| agent-account **grant** + usage aggregate + limit holds | one subscription, N hosts |
| **scheduler ownership** (automations, sources, backup) | a schedule ticked twice does the work twice |
| the KB corpus (`notion-export`) | see D8 — the Mac copy is *deliberately* retired |

**Tier 3 — never replicated**

Worktrees; run event NDJSON (relayed on demand, not stored twice); `tmp/`; `node_modules`;
`launch-key`; `identity/`; provider credentials and `configDir` paths; project roots, `browseRoot`,
`projectsDir`; `agent-accounts.json` `selections` (realpath-keyed); the git checkouts themselves —
git is already the code sync, and the cluster must not become a second one.

**And `reopen-requests.json`**, which is the other file-watch that starts work. It stays node-local
by consequence rather than by choice: a reopen names a `runId`, runs never migrate (D10), so a
reopen request is only ever meaningful on the node that holds the session. Replicating it would
manufacture a second `todo-autostart` problem for no benefit.

### Decisions

**D1 — The hub is `hel1`, and hub-ness is derived from config, not declared twice.**
`CEZ_CLUSTER=1` alone = hub. `CEZ_CLUSTER=1` + `CEZ_CLUSTER_HUB=<url>` = spoke. One knob fewer, and
no way to configure a contradiction.

**D2 — Project identity is a minted key, paired once, confirmed by a human.**
Each project gets a `projectKey` (uuid) in its registry entry, minted on first cluster boot. Pairing
across nodes is **proposed** by the hub from (a) normalized `git remote get-url origin` **plus
`git rev-parse --git-common-dir` being the project's own** (so a worktree never poses as its parent
repo), then (b) identical slug *and* identical basename; and it is **inert until confirmed once** in
the cockpit. Never auto-paired on either signal alone — Problem §6 has a live counter-example for
each. A wrong pairing writes another repo's backlog into your repo, so this fails closed: an
unpaired project is visibly "not paired" and replicates nothing, and a project that exists on only
one node is simply never paired and stays local.

**D3 — Entity ids are already cluster-safe.** Todos and runs use uuid v4. No id remapping, no
node-prefixing, no merge collisions. This is worth stating because it is the single biggest reason
the merge is tractable.

**D4 — Convergence is per-field last-writer-wins on a hybrid logical clock, not per-record.**
The 10 real `chat` conflicts differ on `status` vs `archivedAt`; per-record LWW would discard one
node's edit outright. Each replicated record carries an optional `cv` (cluster version): a record
clock plus a clock for each *conflict-prone* field that has actually been written
(`status`, `priority`, `archivedAt`, `summary`, `context`, `whatToDo`, `acceptanceCriteria`).
Ordering is `(lamport, nodeId)` — nodeId only as a deterministic tiebreak.

An LWW-register per field **is** a CRDT; that is all the convergence this data shape needs, and it
needs no dependency. cezar takes no runtime dependency of that kind.

Wall-clock LWW is rejected outright. Both hosts report `System clock synchronized: yes` with NTP
active, and a bracketed measurement bounds the skew below ~950 ms (the bracket is dominated by the
link round trip, so the true skew is smaller than that). That sounds safe — but the *normal* state
of the Mac is suspend/resume, and a laptop that resumes with a stale clock silently mis-orders every
write it makes, with no error anywhere. The HLC costs one integer and removes the question.

**D5 — The state carries the clock; the op log is a derived shipping queue.**
Ops are *not* the source of truth. Each record's `cv` is written **inside the existing `O_EXCL`
lease, in the same write as the change**, so the clock and the value can never disagree. The
replication log (`.ai/cezar/cluster/ops.ndjson`) is a compactable queue derived from that, and a
crash that loses the tail loses nothing: a boot-time scan re-derives unsent ops by comparing each
record's `cv` against the last acknowledged watermark.

This follows the reasoning already written into `agent-account-usage.ts` for in-flight run counts:
*"a count persisted here would be incremented at dispatch and decremented at completion, so every
crash, SIGKILL and power cut leaks a permanent phantom … a derived count is wrong for as long as it
takes to re-read, which is never."*

**D5a — Unstamped records are healed on read, and the replicator reads through `readTodos`.**
Not every todo arrives through `createTodo`. `handoff.ts`'s `FOLLOWUP_INSTRUCTIONS` tells the agent
to append a raw object straight into `CEZ_TODOS_FILE` — no `id`, no `cv`. `readRaw` already handles
exactly this for ids (*"entries without an id get one assigned … the file is rewritten (under the
lock) on this read"*), so the `cv` stamp extends a proven, idempotent heal-on-read rather than
inventing a second one.

The consequence is a rule, not a preference: **the replicator must read through `readTodos`, never
parse `todos.json` itself.** Id assignment has to happen before an op is derived, or two nodes can
mint two different ids for the same raw entry and the merge produces a duplicate that no clock can
reconcile.

**D6 — A delete is a tombstone, never a removal.** A bare removal loses to any concurrent patch and
the row resurrects. Tombstones carry the same clock and are compacted after the retention window.

**D7 — Foreign ops are applied *through the store API*, under the existing lease, never by writing
the file.** `todos.ts` gains `applyRemoteTodoOps(dataDir, ops)`, which takes `withTodosLease` like
every other writer. Two consequences, both free: the existing `fs.watch` fires, so the Tasks board
and the WS topics update with **no new read path anywhere**; and a replicated write can never
interleave with a local one.

**D8 — The KB corpus does not replicate. The hub stays its single writer.**
`~/loki-labs/notion-export` on the Mac is a *deliberately retired* cold backup (production cutover
2026-08-19). A "sync everything" cluster would silently make it live again and re-create exactly the
drift the cutover killed. Spokes read the corpus **through the hub** (`/api/v1/workspace/knowledge`)
with a read-only local cache, marked read-only, never written back. This is the one place where the
obvious behaviour is the wrong one, so it is a decision rather than an omission.

**D9 — Run events are relayed on demand, never replicated.** ~146 MB of run NDJSON across a single
day's active files, and a single run can be 25.7 MB. A spoke streams a run's events to the hub only
while at least one viewer is subscribed to that run's topic — the same demand-driven discipline
`server/ws.ts` already implements ("a topic's
publisher starts when its subscriber count goes 0→1 and is stopped at 1→0"). At terminal status the
spoke ships a **bounded tail** (the last N events + the handoff markdown) so the hub's board can
render a finished foreign run without holding the firehose.

**D9a — Across nodes, stamp first and act second — the inverse of the local rule, deliberately.**
`todo-autostart.ts` and `reopen-watch.ts` both act first and stamp second, and both explain why:
*"a crash between the two leaves the row pending, so the next pass continues the run a second time
(a visible `continue-2` …); stamping first would instead lose the reopen silently."* That trade is
correct **on one host**, where the duplicate is visible in the same cockpit, in the same list, to
the same person.

It is the wrong trade across nodes. A cross-node duplicate is two agents, in two worktrees, on two
machines, neither of which can see the other, spending one subscription twice — and the first
symptom is a merge conflict hours later. A lost start is a todo that stays visibly pending and gets
picked up on the next pass. So the cluster path is: **acquire the claim lease → stamp
`startedTaskId`/`startedOn` and emit the op → then start.** The local, single-node path is
unchanged; nothing about a cezar install with clustering off moves.

The lease alone is not sufficient and must not be described as if it were: a TTL lease held by a
node that dies is reclaimable by definition, so the durable idempotency key is the replicated
`startedTaskId` stamp, and the lease is what stops the *race*, not what stops the duplicate.

**D10 — A run never migrates.** Sessions, worktrees and broker scopes are node-local. A run starts
on a node and finishes there. If that node goes away mid-run, the run is marked
`unreachable` **as a separate optional field beside `status`**, never as a new `RunStatus` — the
published-enum rule (`RunStatus` ships in an npm package; this is why budget-stop is
`review` + `stopReason`).

**D11 — A spoke enforces its own dispatch policy.** `acceptsDispatch` is stored on the node record
on both sides, and the **spoke** refuses work it has not opted into, regardless of what the hub
sends. Same reasoning as `supervisor/forwarded-principal.ts`: *"a forged header is rejected by the
ORG PROCESS ITSELF regardless of what reached it or how"* — verify at the boundary that actually
enforces it. Default is **off**: a newly enrolled node replicates state and runs nothing.

**D12 — Placement defaults to the eligible node with the most headroom, and an unmet requirement
queues visibly with a reason that distinguishes *why*.**
A todo may carry `placement: { node?: string; requires?: string[] }`. Labels are **discovered, not
configured** (platform, which agent CLIs are logged in, whether the Chrome bridge answers, hosted
mode) — the zero-config rule.

Resolution order: an explicit `node` pins; else `requires` narrows the eligible set; else **the
eligible node with the most headroom** (`maxParallel − active`, then `maxHeavySteps − heavyActive`,
then a stable tiebreak on nodeId so placement is deterministic in tests).

**REVISED from the first draft, which defaulted to the authoring node.** That default was chosen to
guarantee "nothing changes on day one", and it is the wrong goal: spreading the work *is* the
change being asked for, and a default that keeps every box-filed task on the box leaves the 16-core
/ 128 GB machine idle while the 8 vCPU one queues. Least-loaded is the default; the authoring node
gets no preference beyond the tiebreak.

If no eligible node has headroom the run stays `queued` with a `queuedReason` distinguishing the
three cases that look identical from the board — **no node has the label**, **every eligible node is
at capacity**, or **the node it needs is offline** — and it **never silently runs somewhere else**.

**One eligibility rule is not about labels or headroom at all: a project with no `origin` may only
run on the node that holds it.** 4 of the box's 12 registered projects have none (§6). A run's
durable output is a pushed branch; where there is nothing to push to, the output lives only on that
node's disk — which is precisely the thing §2b says we are willing to destroy. So remote-less
projects are pinned by construction, with a fourth `queuedReason`, and decommissioning
refuses while any remote-less project's only copy is here. The cattle/pet split is a property of
the *data*, not of the hardware, and this is where the two disagree.

**D12a — A dispatch carries its workflow by value, and refuses a stale target.**
Two things the target node does not necessarily have, and neither is obvious until it bites:

- **The workflow.** `WORKFLOWS_DIR = '.ai/cezar/workflows'` sits inside the **gitignored**
  `.ai/cezar/`, so a repo-local workflow never travels by git and a node can simply not have the one
  the dispatcher named. A `dispatch` therefore carries a **built-in id** *or* the resolved
  definition inline, re-validated against `workflowDefSchema` on arrival. Sending a name and hoping
  is how a run silently executes a different chain from the one that was asked for — and adding a
  fifth replicated store to fix it would be worse than sending 2 KB of YAML.
- **The code.** The target's checkout of that project may be behind `origin`, dirty, or wedged
  mid-conflict — the box's own `chat` checkout sat six hours in exactly that state, showing one
  ordinary dirty file while every pull failed. So dispatch is **preceded by a freshness report**
  from the target (`HEAD`, ahead/behind, dirty count, `MERGE_HEAD` present) and **refuses** a target
  that is behind or mid-conflict, naming which. An explicit override exists; the default is refusal,
  because "it ran, on the wrong commit, on a machine you weren't looking at" is the expensive
  outcome.

**D13 — An op a node does not understand is stored and re-emitted, never dropped.**
The box self-deploys ~10×/day and the Mac lags; skew is permanent. On-disk schemas stay
`.passthrough()` with per-entry salvage (the house rule in `agent-accounts.ts`,
`sources/types.ts`, `auth/types.ts`), and the *replication* layer extends it: an older node relays
unknown fields verbatim. Without that, the oldest node in the cluster silently truncates everyone's
history. A **protocol major** mismatch, by contrast, refuses the link with a stated reason and shows
it in the cockpit — a partial apply that looks complete is the worse failure.

**D14 — Admission is two numbers per node, not one, and neither is a cluster-wide cap.**
`WorkspaceSemaphore` protects *the host* — "`maxParallel` and `memoryLimitMb` protect the host, not
a repo" — and that stays true: a cap that protects a machine must be evaluated on that machine.
What changes is that **one count cannot express a bimodal workload.** Set `maxParallel` for the
worst case and the box idles at 2 while every run sits at 0.5 GB; set it for the median and three
runs hit `run-tests` together and the machine thrashes. Today it is set to 5 and neither works.

So each node advertises and enforces two:

| knob | bounds | box (hub, 8 vCPU / 15 GB) | CX43 worker (8 / 16) | Mac (16 / 128) |
|---|---|---|---|---|
| `maxParallel` | runs admitted at all | 8 | 8 | 8+ |
| `maxHeavySteps` (new) | runs inside a CPU/memory-heavy step at once | **2** | **2** | ~8 |

The hub and a CX43 worker are the same shape on purpose (§2b): identical caps, identical labels,
so placement is pure least-loaded with no special cases and a node can be replaced without
re-tuning anything. The Mac is the only row that differs, and its number is a ceiling it can
*offer*, never one the cluster may count on — it sleeps.

`maxHeavySteps` is a second `WorkspaceSemaphore`, taken at step entry and released at step exit,
and it is the mechanism that turns 12.9 % duty cycle into real oversubscription. A step is heavy
when its workflow says so — declared on the step definition, defaulting on for `run-tests`, never
inferred from the step's name at runtime.

The **cluster-wide** number (the owner's 8) is a *target*, reached by dispatch filling nodes up to
their own advertised limits — never a cluster-wide semaphore, which would add a 58 ms round trip to
every admission decision and make an offline hub stop all work everywhere. Nodes report
`{maxParallel, active, maxHeavySteps, heavyActive}` on `presence`; the scheduler places on the node
with the most headroom.

The *account* grant (tier 2) is a separate bound on a separate resource — subscription spend, not
host capacity — and the two must not be conflated. A node can have capacity and no account grant, or
vice versa; each refusal names which.

**D14a — Bound the burst where it is already bounded-able: the cgroup and the tool.**
The gate in D14 decides *how many* heavy steps run; this decides *how big* one is allowed to get.
Both are needed — a gate of 2 over two unbounded 6 GB runs is still 12 GB.

cezar already puts every broker in its own transient scope on Linux (`broker-isolation.ts`:
`systemd-run --user --scope --slice=cezar-runs.slice`), and **sets no resource properties on it
today**. So the enforcement point exists and is unused:

- `MemoryHigh` / `MemoryMax` per scope — reclaim before the box swaps, and kill one run instead of
  the machine. This is the single highest-value line in the whole spec for the 8-task goal.
- `CPUWeight` per scope, and `CPUQuota` only if a node wants a hard slice. Weight over quota by
  default: weight lets one run use the whole box when nothing else wants it, which is exactly right
  for a workload that is idle 87 % of the time.
- The slice (`cezar-runs.slice`) gets its own ceiling, so runs collectively cannot starve
  `cezar.service` itself — the cockpit going unresponsive under load is how you lose the ability to
  *see* the overload.

And at the tool, where the fan-out is actually created: cap vitest's worker pool
(`poolOptions.threads.maxThreads`) and ripgrep's thread count for agent-spawned searches. Both
default to "one per core", which is correct for one job on an idle machine and wrong for eight.

**macOS has no cgroups**, so the Mac enforces the count-and-gate half of this and the per-run
memory ceiling degrades to cezar's existing `memoryLimitMb` process-tree guard. Stated because a
limit that silently does not exist on one node is worse than one that was never claimed — the node
reports which enforcement it actually has, and the cockpit shows it.

**D15 — Every local write survives the link being down.** A spoke with no hub is an ordinary cezar
cockpit that queues ops. Nothing blocks on the link: not a todo write, not a run a person starts by
hand, not the local account fallback (if the hub is unreachable at dispatch the spoke balances
locally and marks the dispatch `unattributed` for the hub to reconcile). AGENTS.md → Zero config:
*"a missing dependency, an absent peer, a read-only home: degrade to a smaller working cockpit,
never fail the boot."*

**D15a — …but autostarting a todo this node did not author needs the lease, and therefore needs the
hub.** D15 and the claim lease pull in opposite directions, so they get **scopes, not an ordering**:

| the node is doing | link down |
|---|---|
| a person clicks ▶ Run, or `cez run` | **proceeds** — a human is asserting intent on this host |
| autostarting a todo **this node authored** | **proceeds** — it was never anyone else's to start |
| autostarting a **replicated** todo | **refuses**, and says why (`waiting for the cluster lease`) |

Without the scope split, one of the two rules quietly wins and nobody notices which: either an
offline Mac double-starts every foreign task the moment the box files one, or a hub blip freezes the
owner's own cockpit. The refusal is a stated, rendered state — never a silent skip.

**D15b — The hub restarts ~10 times a day, so leases are persisted and links resume.**
Blue-green self-deploy is the *normal* operation of `hel1`, measured at ~5 s of outage and five
restarts in 51 minutes on a busy day. An in-memory lease table would therefore be wiped ten times a
day, and every wipe is a window in which a spoke can re-acquire a lease another node still holds —
the exact double-start this design exists to prevent, manufactured by our own deploy cadence.

So: leases live in a file store on the hub under the `O_EXCL` idiom (the hub is one host, so a local
lease is the right primitive there); a reconnecting spoke **re-asserts** the leases it still holds
and the hub honours a re-assertion from the node already recorded as holder; links reconnect with
exponential backoff and **full jitter** (`sources/sync.ts`'s own backoff shape) and resume from
watermarks rather than replaying from zero.

**D16 — The link is periodically reconciled, not only watched.** A watcher that stops firing is
indistinguishable from a quiet system. macOS `fs.watch` is known to go quiet across sleep. So a
low-frequency full reconcile (watermark comparison, then a diff pass) runs regardless of whether any
op arrived, and its last-success time is a health signal the cockpit renders.

**D17 — A node joins with one pasteable line, and that line never carries a durable credential.**
The cockpit mints a code and renders the whole command — hub URL and code packed into one opaque
`cezj_` token, with the hub's **own** version pinned into the `npx` spec rather than `@latest`,
because protocol skew is permanent (D13) and a node should start life matched to the hub that
minted it. The rule that constrains the design is what may appear in that string: a command
rendered in a UI is screenshotted, pasted into chat, and left in the shell history of a machine we
may not own, so only a **single-use, short-TTL, digest-at-rest** code goes in it. The Cloudflare
Access credential — durable, and sufficient to reach the hub — is supplied from the operator's
environment instead, which means enrollment answers **two independent gates** and must say which
one refused it. And it is `npx`, not `curl … | sh`: measured 2026-08-22, every path on
`cockpit.example.com` 302s to the Access login, so a piped installer would feed an HTML login page
to a shell. The npm registry is the one distribution channel in this design that Access does not
sit in front of.

### Rejected alternatives

| rejected | why |
|---|---|
| Shared filesystem (NFS / sshfs / syncthing over `~/.cezar` + `.ai/cezar`) | every mutual-exclusion primitive in cezar is `O_EXCL` on a local FS and silently stops being exclusive; `fs.watch` semantics differ; 7.7 GB of worktrees sit in the same trees; realpath-keyed state is wrong on the other host by construction |
| Peer-to-peer gossip | no inbound address on the Mac; needs discovery + anti-entropy for zero benefit at this N |
| A shared database (SQLite/Postgres) as the store | `node:sqlite` does not exist at cezar's Node ≥20 floor and `better-sqlite3` is a native dep this zero-install CLI already refused once (the org-team-auth spec's own D7, recorded in `auth/types.ts` — not this document's D7); a network DB also breaks the offline guarantee in D15 |
| Modelling a peer node as a `SourceProvider` | that seam is for *external content* with a mirror and a lossiness contract; a peer is a control plane with leases and dispatch. Borrow its watermark/tombstone/budget idiom, not its shape |
| Whole-file sync of `todos.json` | loses concurrent field edits — 10 real rows today — and races the `O_EXCL` writers |
| Migrating a live run between nodes | worktrees, broker scopes and CLI sessions are all node-local; nothing to gain |

## Architecture

### New modules

```
packages/cezar/src/cluster/
  node-identity.ts     nodeId/name/labels; discovered capability probe
  clock.ts             hybrid logical clock; (lamport,nodeId) ordering
  ops.ts               op shapes, derive-from-state, compaction
  oplog.ts             append/read/compact `.ai/cezar/cluster/ops.ndjson`
  merge.ts             per-field LWW merge (pure; the unit-test surface)
  link-client.ts       spoke: outbound WS, resume watermarks, backoff
  link-server.ts       hub: /api/v1/cluster/link upgrade + frame routing
  enrollment.ts        code mint/redeem, per-node HMAC secret (0600)
  leases.ts            hub: claim/account/scheduler leases, TTL + renew
  placement.ts         label matching, queue-with-reason (pure)
  peers.ts             roster + pairings store, presence
  reconcile.ts         periodic full reconcile + `cez cluster reconcile`
packages/cezar/src/server/cluster-routes.ts
packages/contract/src/cluster.ts
packages/web/src/routes/settings/cluster-section.tsx    Phase 1b: the fleet panel + Add node
```

Plus one extension rather than a new module: `server-install/platforms/hetzner.ts` gains a
**worker role** (checkouts, CLI logins, cgroup caps, enrollment) alongside the org-cockpit role it
installs today — see Phase 4.

Vertical slice following the `automations` convention — *"not modular; no plugin seam exists"*.

### What is touched in existing code, and how little

- `todos.ts` — `applyRemoteTodoOps`, and a `cv` stamp inside the existing lease on every writer
  (`createTodo`, `updateTodo`, `markStarted`, `clearStartedTaskId`, delete).
- `todo-autostart.ts` — **two** changes, not one, and it is worth saying so: (a) a guard, start only
  while holding the cluster claim lease (a no-op returning `true` when clustering is off); (b) the
  D9a stamp-before-start ordering **on the cluster path only**, leaving the existing act-then-stamp
  path exactly as it is when clustering is off.
- `server.ts` — one wiring line beside the existing `providerRuntimeAuth.watch` /
  `watchTodoAutostart` block; one route family chained into the builder.
- **Nothing in `runs/store.ts` for the *cluster* half.** `RunStore extends EventEmitter` and already
  emits `run`, `event` and `deleted`, so the run projection is an observer that `watch(store)`es it
  — the shape `provider-auth-runtime.ts` and `notifications/observer.ts` already use, wired through
  the same `onStoreCreated` / `onContextBuilt` hooks so it covers the boot context, every
  already-built context and every later one.

- `capabilities.ts` — `cluster: boolean`, **always present** and `false` when off, like every other
  capability key. Do not re-assert the "flag-off health body is byte-identical" claim: it was
  measured false and corrected in place in that file, and this key makes the body grow by one more
  pair. What opt-in buys is behavioural — no index, no watcher, no timer, no route, no nav item, no
  prompt bytes.
- `workspace-runs-routes.ts` — union the remote projection into the workspace runs list.
- `routes/settings/registry.tsx` — **one** entry (`id: 'cluster'`, `appliesTo: 'workspace'`,
  `capability: 'cluster'`) and the `SettingsCapabilities` alias widened to include `cluster`, so
  the shell that forwards capabilities cannot fall behind the filter that reads them. The registry
  is by its own docblock the one place a section is declared; there is no other layout work.
- `server-install/platforms/hetzner.ts` (+ `steps.ts`) — the **worker role** (Phase 4): checkouts,
  agent CLI logins, cgroup caps, `CEZ_ENV_PASSTHROUGH`, `cez cluster enroll`. An extension of the
  existing step list, not a second provisioning path.
- `.env.example` — `CEZ_CLUSTER` and `CEZ_CLUSTER_HUB`, **in the same commit that introduces them**,
  plus the README env table since both are user-facing. The env contract has one documentation
  surface and an undocumented `CEZ_*` var is a bug, not an omission.

Nothing else in phases 1-5. In particular `RunStatus`, `StepStatus` and every existing `.ai/cezar/`
file format are unchanged, and `RunStore`/`RunRecord` are untouched *by the cluster half*.

**Phase 0 is a separate, smaller diff, and it does touch the store** — the sentence above is about
phases 1-5 only (1b included), and saying "nothing else" without this caveat would have been false:

- `runs/store.ts` — four additive optional fields (`peakCpuPct`, `peakMemoryBytes`, `cpuSeconds`,
  `resourceKill`). Additive and optional, so an older cezar reading a newer `runs.json` is
  unaffected; no published union is widened — in particular `resourceKill` is a **new optional
  field**, not a new `RunStatus` member, because `RunStatus` is published wire enum (C3 still gets
  its named reason, from the field).
- `core/process-usage.ts` — keep a peak for the CPU it already samples, and on Linux prefer the
  run's cgroup (`memory.peak`, `cpu.stat`) over summing `ps` RSS.
- `core/broker-isolation.ts` — pass `--property=` resource properties onto the scope it already
  creates. The scope exists today and carries none.
- `workspace/semaphore.ts` — the second semaphore (`maxHeavySteps`), taken and released around a
  step rather than a run.
- `workflows/types.ts` — a `heavy?: boolean` on the step definition, defaulting on for `run-tests`.
  Declared, never inferred from the step's name at runtime.
- `packages/cezar/vitest.config.ts` and the agent search path — worker/thread caps.

None of that needs a second machine, a link, or a lease, which is exactly why it is Phase 0.

Two knobs only, and neither is a credential: the link secret is written by `cez cluster join`, and
`acceptsDispatch` lives on the node record where the cockpit can show it, not in an env var somebody
has to remember they set.

### HTTP invariants (AGENTS.md → The HTTP API)

Every shape a zod schema in `packages/contract` with its type inferred; routes **chained** into a
family builder so they reach `AppType`; bodies/params/query validated as **middleware** via
`src/server/validators.ts`; everything under `/api/v1`. Wire schemas `.strict()`, on-disk schemas
`.passthrough()`. `contract-parity.cluster.test.ts` both directions.

`packages/contract` is **Node-free by construction** (`types: []` makes a `node:*` import a compile
error) because it is bundled into the browser. The cluster contract holds shapes only — no
`node:crypto`, no `node:fs`. HMAC signing lives in `packages/cezar/src/cluster/`, never in the
contract, and the service may only import the api-client in tests.

### Security and blast radius

Enrolling a node means **the hub can start bypass-permissions agent processes on that machine, with
that machine's credentials** — on the Mac that is the keychain, the ssh agent, the git identity,
iMessage and the browser profile. That is the same magnitude of grant as adding a person to
production cezar (which, per `tools/cezar-prod-admin/README.md`, hands over the whole 1Password
vault), and it gets the same care:

1. **Enrollment is outbound and two-sided.** The hub mints a short-TTL, single-use code, stored as a
   SHA-256 digest, never raw — `auth/org-claim-token.ts`'s existing contract. The spoke redeems it
   by dialling out. Nothing ever listens on the spoke.
2. **The link credential is a per-node HMAC secret**, `0600` in `~/.cezar/cluster/node.json`, and
   every frame carries a signed, freshness-bounded principal — `supervisor/forwarded-principal.ts`,
   verbatim idiom: sign-then-verify (the claim must be unforgeable, the content is not secret), a
   bounded `issuedAt` window rather than a nonce scheme.
3. **Not an env var.** Deliberately: a credential in the environment on the box must also be named
   in `CEZ_ENV_PASSTHROUGH`, and forgetting the second step fails silently as "the agent cannot see
   it". A file the CLI writes at join time has no such trap.
4. **`acceptsDispatch` defaults off** and is enforced spoke-side (D11).
5. **Revocation is two-sided** — hub disables the node *and* the spoke's credential is deleted.
   A hub-side revoke alone does not stop a spoke from continuing to push ops.
6. **A spoke exposes only paired projects.** The hub cannot address a project the spoke has not
   confirmed (D2).

### A cheap side-benefit worth taking

The node health panel shows, per node per paired project, `HEAD` vs `origin/main` (ahead/behind) and
the dirty-file count. That directly surfaces a failure the record has already paid for: the box's
`chat` checkout **sat six hours mid-conflict with no merge in progress**, looking like one ordinary
dirty file while every pull silently failed. A push is not delivery; this makes non-delivery visible.

## Phases

Each phase is independently shippable and independently verifiable. Three rules set the ordering:
**no phase creates shared state without the lease that makes it safe**; **the box gets faster
before it gets a partner** — otherwise a second node just reproduces the same saturation twice; and
**nothing is dispatched to a fleet nobody can see**, which is why the cockpit's Cluster section
(1b) lands before any state replicates rather than after everything works.

**Phase 0 — Raise concurrency on the box that already exists. No cluster.**
This is the phase that delivers the owner's 8, and it needs no link, no replication and no second
machine. In order:

1. **Measure what a run actually costs.** Persist peak CPU beside `peakRssBytes`, and on Linux read
   `memory.peak` / `cpu.stat` from the run's own cgroup instead of summing `ps` RSS. Right now the
   resource this spec is about is the one resource nothing records.
2. **Bound the burst** (D14a): `MemoryHigh`/`MemoryMax` and `CPUWeight` on the run scope, a ceiling
   on `cezar-runs.slice`, capped vitest workers and ripgrep threads.
3. **Gate the burst** (D14): `maxHeavySteps`, declared per workflow step, default 2 on this box.
4. **Raise `maxParallel` to 8** and hold it there while (1) reports what happened.

Ship Phase 0 alone and stop, if it is enough. Everything after it is about going *past* one box —
and Phase 0's measurements are what tell you whether you need to.

**Phase 1 — Identity and link (inert).**
`nodeId`, discovered labels, enrollment, outbound WS, presence, protocol-version handshake,
`capabilities.cluster`. **No state replicates**, and there is no UI yet — Phase 1's surface is the
API and the CLI, so the link can be proven before anything renders it. Provisioning: a cockpit-app
Access service token (see Problem §7). Ship it and nothing about either cockpit's behaviour changes.

**Phase 1b — The Cluster section in the cockpit: see the fleet, and add a node in one command.**
Phase 1 makes a cluster addressable; this makes it *operable*. Without it every answer to "why is
this queued" is an ssh session, and 8 concurrent tasks across N machines is precisely the situation
where nobody wants to ssh.

*One settings section, one registry entry.* `packages/web/src/routes/settings/cluster-section.tsx`
plus one row in `routes/settings/registry.tsx` — `id: 'cluster'`, `appliesTo: 'workspace'` (the
fleet is a property of this machine's cockpit, not of a repo), gated by `capability: 'cluster'`
exactly as `sources` already is, which also means widening the `SettingsCapabilities` alias so the
shell cannot fall behind the filter. That file's own docblock says the registry is *"the ONE place
a section is declared"*, so this is one entry and no layout work.

**What a node row shows** — and the ordering is deliberate, most-actionable first:

| field | source | why it is on the row |
|---|---|---|
| online / offline **+ age of last presence** | link heartbeat | a 40-minute-old reading rendered without its age reads as current |
| role: hub · worker · capability | node record | says whether losing it costs coordination or throughput |
| `active / maxParallel` and `heavyActive / maxHeavySteps` | `presence` (D14) | the two numbers admission actually uses; one bar cannot express a bimodal load |
| **enforcement: `cgroup` · `process-tree` · `none`** | `presence` (D14a) | the Mac has no cgroups, so its memory ceiling is the weaker guard. A limit that silently does not exist on one node is worse than one never claimed |
| labels (`macos`, `imessage`, `browser`, `device-e2e`, …) | discovered, not configured | explains why a `requires:` task can only go one place |
| repo drift per paired project: `HEAD` vs `origin/main`, dirty, `MERGE_HEAD` | `freshness` | the box's `chat` checkout sat six hours mid-conflict showing one ordinary dirty file |
| `acceptsDispatch` toggle · revoke | node record (spoke re-enforces) | D11: the switch is shown where it is read, never as an env var |

Three honesty rules the panel has to carry, because each one is a wrong answer waiting to be
rendered:

1. **A spoke's capacity is a claim, not a measurement.** The hub renders what the node reported and
   labels it as of *when* it reported. Never present a peer's self-report as observed fact.
2. **The four queued reasons must look different** (D12) — *no node carries this label*, *every
   eligible node is at capacity*, *the node it needs is offline*, *this project has no `origin` and
   may only run where it lives*. Collapsing them into "queued" is what sends a person to buy a node
   when the real fix was opening a laptop lid. This one **lands with Phase 4**, since placement is
   what produces the reasons; 1b's job is to make sure the node-level facts behind each of them —
   labels, headroom, presence age — are already on screen when it does. Noted here so it is not
   discovered as a gap after the board starts saying "queued".
3. **Offline is a state, not an error.** The Mac sleeping is normal; the panel says "asleep since
   HH:MM", not a red failure — the same *"a failed navigation is an exit, not an error"* rule.

**Add a node — one command, one paste, and the token is the short-lived half.**
An *Add node* action mints an enrollment code (admin-gated, single-use, short TTL, stored as a
SHA-256 digest per the security section) and renders exactly one copyable line. The hub renders
**its own version** into it rather than `@latest`, because protocol skew is permanent (D13) and a
node minted today should start life matched to the hub that minted it:

```
npx -y @loki-labs/better-cezar@<hub version> cluster join cezj_<opaque>
```

(`0.10.0` today — the hub substitutes its own, so this spec is not the thing that goes stale.)

`cezj_<opaque>` packs the hub URL and the code, so there is nothing else to type or get wrong. The
UI shows the TTL counting down, lets the code be revoked before use, and says plainly that it is
single-use — a code still on screen after it has been redeemed is a code someone will try again.

**The one rule that makes this safe: nothing long-lived goes in the pasteable string.** The
Cloudflare Access credential is *not* embedded, and that is a decision, not an oversight. A command
rendered in a cockpit gets screenshotted, pasted into chat, and left in the shell history of a
machine we may not own; a short-TTL single-use code survives that, an Access service token that
admits the hub does not. So enrollment answers **two different gates** and the UI must say so:
Access decides whether you may reach the hostname at all, the join code decides whether you are
admitted as a node. The operator supplies the Access half from the environment they already have.

**And no `curl … | sh`.** Measured 2026-08-22: **every** path on `cockpit.example.com` returns
**302** to the Access login — `/`, `/api/v1/health`, and any install path alike. So
`curl https://cockpit.example.com/install | sh` pipes an HTML login page into a shell: broken, and
dangerous in the way that is hard to notice. `npx` is used instead because the package comes from
the npm registry, which Access does not gate; the only Access-gated call is the join POST itself.
That call must therefore fail with a **named** reason — *"Cloudflare Access rejected this request"*
distinct from *"code expired or already used"* distinct from *"hub unreachable"*. Three failures
that look identical from a generic network error, and an operator who cannot tell them apart will
re-mint codes to fix a credential problem.

**Phase 2 — Todo replication, with dispatch and autostart cluster-disabled.**
Pairing UI, `cv` stamping, op derivation/compaction, `applyRemoteTodoOps`, watermark resume,
`cez cluster reconcile [--dry-run]`. A replicated todo carrying `autostart` is **never** started by
a node that did not create it — asserted as a negative control, not a comment.

The first real job is merging the divergence that already exists, and **it cannot be done by the
merge rule**, because every one of those records predates the clock. The reconcile therefore
classifies rather than resolves:

| class | today | action |
|---|---|---|
| present on one node only | 103 (`cezar`) + 7 (`chat`) | **add**, stamped as authored by the node that has it |
| present on both, identical | 579 (`chat`) + 33 (`cezar`) | stamp both, no change |
| present on both, **differing, neither has a `cv`** | 10 (`chat`) | **refuse to pick.** List them and ask |

(`aside` 8 and `career-kit` 1 match on counts; they were not diffed by id, so the reconcile must
report them rather than the spec assuming them.)

An unclocked disagreement is not a conflict the LWW register can settle — there is no "later", only
two values. Auto-picking one would be the most believable wrong answer available, so the tool
prints the pair and takes an explicit choice (`--take-hub` / `--take-spoke` / interactive). Dry-run
first; `todos.json.bak` written on both sides before the first write.

**Phase 3 — Cluster leases.**
Claim lease (re-enables autostart for replicated todos, now exactly-once), account grants + usage
aggregation + cluster-wide limit holds, run index projection.

**Phase 4 — Placement, remote dispatch, and a worker you can mint in minutes.**
`placement` on a todo, label matching, queue-with-reason, spoke-side `acceptsDispatch` opt-in,
workflow-by-value and the pre-dispatch freshness refusal (D12a), on-demand live event relay for a
foreign run.

This is the first phase where buying a machine pays, so it is also the phase that must make buying
one cheap: **a worker is minted by a script, and the script is the existing installer with a new
role** — `cez server-install --platform hetzner --role worker`, not a new `cez node` namespace
(§2b: the installer already does the user, units, nginx/TLS and agent-CLI *installs*; a worker adds
repo checkouts, agent CLI **logins**, cgroup caps + `maxHeavySteps`, `CEZ_ENV_PASSTHROUGH`, and
`cez cluster enroll` with the hub's token). Extend the step list and the strategy — do not author a
parallel shell script, which is how the two provisioning paths that already exist
(`server-install` and the hand-built hub) came to disagree.

**The cockpit's *Add node* action (Phase 1b) grows a second variant here**, and it is the same
button with a different target: *enroll an existing cezar* mints
`npx … cluster join cezj_…`, while *provision a new worker* mints
`npx -y @loki-labs/better-cezar@<hub version> server-install --platform hetzner --role worker
--join cezj_…` — run as root on a bare VPS, carrying the same short-TTL single-use code and, still,
**no long-lived credential in the pasteable string**. Same reason `curl … | sh` is not used: every
path on the hub 302s to Access, so the script cannot be fetched anonymously; the npm registry can.

The logins are the one genuinely interactive step, so the run must **stop and say so** rather than
half-provisioning silently. Verified by being the **only** way a worker is ever created: E5b builds
node 3 from zero, and the marginal cost has to be minutes or the fleet drifts and every later
measurement is noise. Corollary, and it is the point of cattle: decommissioning must be equally
boring — `cez cluster revoke` then `cez server-uninstall`, drain first, destroy, no backup to
restore, and a refusal while this node holds the only copy of a remote-less project (D12).

**Phase 5 — Scheduler ownership.**
Automations, sources and backup tick under a cluster lease — each of those creates work or writes
shared state. Retention, the knowledge reindex and the **reopen sweep** stay per node: they act on
node-local resources only (worktrees, a local index, a session this node holds).

The test is not "is it a timer" but **"does a second tick do the work a second time, anywhere but
here?"**

**Rule that fixes this ordering:** *a scheduler may only tick over state it owns exclusively;
replicating that state and leasing its tick land in the same phase.*

## Data models

All on-disk shapes `.passthrough()`, every field optional or `.catch`-defaulted, per-entry salvage,
atomic tmp+rename at `0600`, corrupt file degrades to empty with one warning and never fails boot.

```ts
// ~/.cezar/cluster/node.json          (0600, this node's own identity + credential)
{ nodeId, nodeName, createdAt,
  role: 'hub' | 'spoke',
  hubUrl?, secret?,                     // spoke only
  acceptsDispatch: boolean,             // default false
  labels: string[] }                    // DISCOVERED each boot, persisted for display only

// ~/.cezar/config.json  `resources` — extended, both additive and optional
{ maxParallel: number,                  // existing; box moves 5 -> 8 in Phase 0
  maxHeavySteps?: number,               // NEW (D14). absent = unbounded, i.e. today's behaviour
  runMemoryHighMb?: number | null,      // NEW (D14a) -> scope MemoryHigh, Linux only
  runMemoryMaxMb?: number | null,       // NEW (D14a) -> scope MemoryMax,  Linux only
  runCpuWeight?: number | null,         // NEW (D14a) -> scope CPUWeight,  Linux only
  runsSliceMemoryMaxMb?: number | null } // NEW (D14a) -> ceiling on cezar-runs.slice

// RunRecord — additive, optional, closes the gap in Problem §2
{ peakCpuPct?: number,                  // sampled today, persisted by nobody
  peakMemoryBytes?: number,             // cgroup memory.peak on Linux; NOT the summed-ps figure
  cpuSeconds?: number,                  // cgroup cpu.stat usage_usec
  resourceKill?: { limit: 'memory' | 'cpu'; at: string } }  // C3: never a bare step failure

// ~/.cezar/cluster/peers.json          (roster, replicated)
{ nodes: [{ nodeId, nodeName, labels, lastSeenAt, acceptsDispatch, protocol, version,
            disabledAt? }],
  pairings: [{ projectKey, byNode: { [nodeId]: { projectId, confirmedAt } } }] }

// ~/.cezar/cluster/watermarks.json     (per peer, per scope: last applied + last acked)
// ~/.cezar/cluster/runs-remote.json    (foreign run PROJECTION — no worktreePath, no local paths)

// .ai/cezar/cluster/ops.ndjson         (derived shipping queue, compactable)
{ opId, nodeId, lamport, ts, scope: 'project'|'workspace',
  projectKey?, entity: 'todo'|'run'|'triage',
  entityId, op: 'upsert'|'tombstone',
  fields?: Record<string, unknown>,     // only what changed
  cv: { r: Clock, f?: Record<string, Clock> },
  unknown?: Record<string, unknown> }   // D13: relayed verbatim by an older node

type Clock = { l: number; n: string }   // lamport, nodeId
```

Additive on `todoSchema`, all optional — an existing entry with none of them still validates, which
is the same contract every field added since 2026-08-15 has kept:

```ts
cv?:        { r: Clock; f?: Record<string, Clock> }
tombstone?: { at: string }
placement?: { node?: string; requires?: string[] }
startedOn?: string                      // nodeId; NEVER LWW'd with another node's run id
```

## API contracts

`packages/contract/src/cluster.ts`, `.strict()`, chained into one route family:

```
GET    /api/v1/cluster                      roster, pairings, this node, link health
POST   /api/v1/cluster/enroll               hub: mint a single-use code (admin-gated).
                                            Returns { code, expiresAt, commands: {
                                              join, provision } } — the hub RENDERS the
                                            one-liner, pinning its OWN version (D13), so
                                            the cockpit never assembles it client-side
DELETE /api/v1/cluster/enroll/:codeId       hub: revoke an unredeemed code (Phase 1b)
POST   /api/v1/cluster/join                 spoke: redeem a code (CLI-driven). Failures are
                                            NAMED: access-rejected | code-expired |
                                            code-used | hub-unreachable | protocol-major
DELETE /api/v1/cluster/nodes/:nodeId        hub: revoke
PATCH  /api/v1/cluster/nodes/:nodeId        acceptsDispatch, name  (spoke re-enforces)
GET    /api/v1/cluster/pairings             proposals + confirmed
POST   /api/v1/cluster/pairings/:projectKey confirm / unpair
POST   /api/v1/cluster/leases/:kind         acquire/renew  (claim | account | scheduler)
DELETE /api/v1/cluster/leases/:kind/:id     release
GET    /api/v1/cluster/link                 WS upgrade — node auth ONLY, not the cockpit origin guard
```

The link's upgrade guard is **its own**. `server/ws.ts`'s guard admits browser origins; a node link
must not be admitted by it, and a node-authenticated socket must not gain cockpit topics.

Frames (`.strict()`, versioned `protocol: { major, minor }`):

```
→ hello   { nodeId, protocol, version, labels, watermarks, projects[] }
← welcome { hubNodeId, protocol, roster, pairings, resumeFrom }   | refuse { reason }
↔ ops     { scope, projectKey?, ops[], lamport }      batched, bounded
↔ ack     { scope, projectKey?, throughLamport }
← dispatch{ todoId, projectKey, placement,                        Phase 4
            workflow: { builtinId } | { def },                    D12a: by value, never by name
            expect?: { headSha } }                                D12a: refuse a stale target
→ freshness{ projectKey, headSha, ahead, behind, dirty, merging } asked before every dispatch
→ presence{ capacity: { maxParallel, active, maxHeavySteps, heavyActive,      D14: what the
                        enforcement: 'cgroup' | 'process-tree' | 'none' },    scheduler fills
            hostMetrics, repoDrift[] }
→ relay   { runId, events[] }                                     Phase 4, on demand only
```

Bounded like every other cezar transport: ≤ 256 KB per frame and ≤ 500 ops per `ops` frame (the
cockpit's own client control frames cap at 4 KB — these carry payload, so they get their own,
larger, *stated* bound), plus a per-tick send budget so one node's backlog cannot monopolise the
link. The sender resumes from the last `ack`, so a dropped frame costs a retransmit, never a gap.

A foreign run **never** offers a local-machine affordance. The hub runs hosted (`CEZ_REMOTE=1`),
where `localHandoff` is already `false`; the cluster must not become a way to smuggle "open in
terminal" for a run on somebody else's host.

## Risks

| risk | mitigation |
|---|---|
| **Oversubscription thrashes instead of scaling** — 8 admitted, all correlated into `run-tests` together | `maxHeavySteps` is a semaphore, not a probability (D14); C2 tests the correlated launch specifically; C1's acceptance is *lower* wall time, so admitting 8 and finishing slower fails the phase |
| **A resource kill reads as a broken test** and the agent "fixes" working code | C3 makes it a named resource kill with a reason, never a bare step failure — the same "every mechanism that terminates someone else's work owes the record a reason" rule the stopped-vs-failed work already established |
| **Capacity that sleeps** — the big node is a laptop | queued tasks say "waiting for `mac`" rather than stalling; the hub must remain able to run work alone, so Phase 0's box-side ceiling is the floor of the design, not a stopgap |
| **Double-started run** (the headline hazard) | claim lease before autostart is re-enabled for replicated todos; Phase 2 disables it outright; negative control asserts a node without the lease does not start |
| **Shared subscription burned twice** | cluster account grants + shared limit holds (Phase 3); degraded fallback marks the dispatch `unattributed` rather than blocking |
| **Wrong pairing writes a foreign backlog into a repo** | confirm-once pairing, never slug-only *and* never origin-only (a worktree shares its parent's origin — Problem §6); unpaired = replicates nothing; `--dry-run` before the first reconcile; `todos.json.bak` written before the first merge |
| **A dispatched run builds on stale or wedged code** | pre-dispatch freshness report; refuse behind / mid-conflict targets by default, override explicit (D12a) |
| **Lost field edit** | per-field LWW (D4) with a fixture built from the 10 real conflicting `chat` rows |
| **A hub deploy wipes the lease table** — ~10 blue-green restarts/day, each a re-acquire window | leases persisted on the hub; a reconnecting spoke re-asserts what it holds; resume-from-watermark, backoff with full jitter (D15b) |
| **A long free-text field silently replaced** (`summary`, `whatToDo`) | LWW is per field, so only the edited field moves — and the losing value stays readable in the op log for the retention window; the cockpit shows "changed on `<node>`" rather than presenting it as always having been that |
| **An old node truncates the cluster's history** | unknown fields stored and re-emitted (D13); protocol-major mismatch refuses with a stated reason |
| **Op log growth** | compaction to the latest `cv` per entity + bounded retention; a partition older than the window falls back to full snapshot reconcile, never a partial merge that reads as complete |
| **Watcher goes quiet after Mac sleep** | periodic reconcile is the floor, not the watcher (D16); last-successful-reconcile is a rendered health signal |
| **Hub is a single point of failure** | it is one for *coordination*, never for local work (D15). A spoke with no hub is an ordinary cockpit. Stated as a bound, not hidden |
| **Retired Mac corpus resurrected** | D8: corpus is explicitly out of tier 1; spokes read through the hub, cache read-only |
| **A copy-paste install command leaks a durable credential** — cockpit commands get screenshotted, pasted into chat, and left in shell history on machines we don't own | nothing long-lived goes in the pasteable string: the code is single-use, short-TTL and stored as a digest; the Access credential comes from the operator's environment, never the rendered line. Test 13a asserts the *absence*, not just the shape |
| **Enrollment grants code execution on the Mac** | outbound-only, `acceptsDispatch` off by default and spoke-enforced, per-node credential, two-sided revoke |
| **A destroyed worker takes the only copy of something with it** — 4 of 12 projects have no `origin` | those projects are pinned to their holding node by placement, with their own `queuedReason`; decommission (`cez cluster revoke` + `cez server-uninstall`) drains first and refuses while it holds an unpushable-anywhere copy (D12) |
| **The fleet drifts into N different machines** — each node is its own checkouts, logins, caps and env | provisioning is a script from the first extra node, never a runbook; E5b provisions twice and **diffs the two results**, which is the only assertion that can actually catch drift |
| **Nodes bought past the point the subscription sustains** — idle vCPU at EUR 20/mo each | no number is invented (§4, Q2a): reach 8, read the account panel's real usage windows at that load, then decide on nodes 4-6. The measurement is a gate on the purchase, not a report after it |

## Verification

Planned up front, per the workspace rule that verification is a design input.

### Phase 0 — the capacity claim, which is the one that decides everything else

This is a throughput claim, so it is verified by a load test with a **before** number, not by unit
tests. Run it on the box, twice, with the same eight tasks.

- **C0 — Baseline, recorded before any change.** Launch 8 real tasks at today's settings. Record:
  how many reach `run-tests` concurrently, peak `memory.peak` per scope, `/proc/pressure/cpu` and
  `/proc/pressure/memory` `some avg60` at the worst minute, any OOM kill (`journalctl -k`), and wall
  time to all-8-complete. Expect it to confirm the 3-to-4 ceiling; **if it does not, stop** — the
  premise is wrong and the rest of Phase 0 is solving someone else's problem.
- **C1 — After bounding + gating.** Same 8 tasks. Acceptance: **all 8 admitted and progressing**,
  never more than `maxHeavySteps` in a heavy step at once, no OOM kill, memory PSI `full` stays 0,
  and **wall time to all-8-complete is lower than C0**. That last one is the real gate: a machine
  that admits 8 and finishes slower has been oversubscribed, not scaled.
- **C2 — The correlated launch, which is the case the maths does not cover.** The 12.9 % duty cycle
  assumes independence; eight tasks started together do not have it. Launch 8 *identical* workflows
  simultaneously so their heavy phases align, and assert the gate — not luck — is what holds the
  line: queueing at the gate is expected and fine, thrashing is not.
- **C3 — Negative control on the bound.** Set `MemoryMax` deliberately low, run one testing task,
  and assert it is killed **and reported as a resource kill with a reason**, not as a failed test
  step. A bound whose failure mode is indistinguishable from a code failure will be blamed on the
  code, and the run's own agent will "fix" a test that was never broken.
- **C4 — The cockpit stays responsive at 8.** `cezar-runs.slice` has a ceiling for exactly this;
  assert `/api/v1/health` latency under full load. Losing the ability to observe an overload is how
  an overload becomes an outage.

### Automated

Gates, in order (`AGENTS.md` → Validation), run under the full `CEZ_*` scrub with `TMPDIR` outside
any git repo:
`npm run typecheck` · `npm test` · `npm run test:unit` · `npm run build` · `npm run test:package`.

Unit (pure, in `cluster/merge.ts`, `clock.ts`, `placement.ts`, `ops.ts`):

1. HLC ordering is total and stable under equal lamports (nodeId tiebreak).
2. Per-field merge: two nodes patch **different** fields of one todo → **both survive**.
   *Negative control:* the same fixture under a per-record LWW merge loses one — assert that, so the
   test cannot pass against the design it exists to reject.
3. Tombstone beats a concurrent lower-clock patch; a concurrent **higher**-clock patch beats the
   tombstone (no accidental resurrection, no accidental erasure).
4. An op carrying an unknown field round-trips through an older reader unchanged (D13).
5. Compaction preserves the merge result exactly for a randomised op sequence (property-style).
6. Placement: unmet `requires` → `queued` with a reason naming the node, and **never** a start.
   - **6a** — a project whose `origin` is absent is **never** placed off its holding node, even
     when that node is the most loaded and a remote-less-capable peer is idle. *Negative control:*
     the same fixture with an `origin` present **does** get placed on the peer — otherwise the test
     passes because placement did nothing at all, which is the cheapest way for this assertion to
     be vacuous. And assert the `queuedReason` is the remote-less one, not "at capacity"; a rule
     that reports the wrong reason is a rule the next person deletes as redundant.

Integration (two servers in one vitest process, two `CEZ_HOME` temp dirs, linked over loopback):

7. Convergence: 200 interleaved writes on both sides → identical state on both, both directions.
8. **Partition**: link down → both sides accept local writes → reconnect → converge, and no write
   was refused while the link was down.
9. **Exactly-once start**: one `autostart` todo replicated to two nodes → exactly one run.
   *Prove the test fails without the fix*: `git stash push` the file the guard actually landed in,
   run it, confirm **red**, `git stash pop`. A regression test written after the diagnosis passes
   against the bug more often than anyone expects.
10. **Exactly-once across a lease wipe**: node A claims and starts; delete the hub's lease store and
    restart the hub (simulating a blue-green deploy); node B must **not** start a second run,
    because the replicated `startedTaskId` stamp — not the lease — is the durable key (D9a, D15b).
11. **Stamp-before-start ordering**: kill node A between `markStarted` and `startRun` → the todo is
    stamped and un-started, and no second node picks it up; the failure mode is a *visible pending
    start*, never a duplicate.
12. **Flag off**: with `CEZ_CLUSTER` unset — no timers armed, `/api/v1/cluster*` → 404, no file
    created under `~/.cezar/cluster` or `.ai/cezar/cluster`, `capabilities.cluster === false`, the
    Cluster section absent from the settings nav **and** its route a 404 (the registry's `capability`
    gate drops both, and asserting only the nav would pass against a reachable orphan route), and
    the agent system prompt byte-identical.

Component (Phase 1b, `cluster-section.tsx`), lettered under 12 so the integration numbering
above stays stable:

   - **12a — the minted command carries the code and no long-lived credential.** Assert the
     rendered string matches the expected `npx …` shape *and* assert it does **not** contain the
     Access client id or secret, from a fixture where both are present in the environment. The
     second assertion is the one that matters: a test checking only the happy shape passes just as
     well against a command that leaks.
   - **12b — a stale presence renders its age.** A node last seen 40 minutes ago shows "40m ago",
     not a bare online dot. *Negative control:* a fresh reading renders **no** age badge, so the
     test cannot pass by the badge always being present.
   - **12c — enforcement is rendered, including `none`.** A node reporting `enforcement: 'none'`
     shows it as a stated limitation, and the assertion is on the `none` case specifically — a
     `cgroup`-only test passes against code that renders nothing for the others.
   - **12d — the four queued reasons render four distinct strings** (Phase 4, listed here so it is
     not lost), asserted **pairwise-distinct** rather than each against a literal, so a fifth
     reason that reuses an existing string fails the test.
13. A node-authenticated link socket **cannot** subscribe to cockpit WS topics, and a
    browser-origin socket **cannot** send `ops`.
14. Hub unreachable at dispatch → a run a person starts by hand still starts, dispatch recorded
    `unattributed`; a **replicated** todo's autostart refuses with a stated reason (D15a). Both
    halves asserted — one without the other is the rule silently collapsing to its neighbour.
15. **Heal-on-read**: a raw agent append (no `id`, no `cv`) is stamped once, and a second read
    changes nothing (idempotent), and the derived op carries the id the file kept.

### Runtime E2E — the real pair, and the gate that actually decides

Gates green is necessary, not sufficient. Until these have run the work is **QA Needed**.

- **E1** Enroll the Mac against `cockpit.example.com`; both nodes list each other; kill the link and
  watch both report the peer offline within the heartbeat window.
- **E1b** *Add node*, for real and end to end: mint a code in the cockpit, copy the single line,
  paste it into a shell on the Mac, and watch the node appear in the roster — **timed**, because
  "one command" is a claim about how long it takes someone who is not you. Then the three failure
  paths, each of which must name itself rather than reading as a network blip: redeem the same code
  **twice** (second → `code-used`), let one **expire** unused (→ `code-expired`), and run the
  command with **no Access credential** in the environment (→ `access-rejected`, not a generic
  fetch failure). Finally revoke an unredeemed code from the UI and confirm it cannot be redeemed.
- **E2** `cez cluster reconcile --dry-run` on the real divergence. The plan must name exactly
  **103 `cezar` adds, 7 `chat` adds, 579 + 33 identical, and 10 `chat` rows it refuses to decide**
  (plus whatever it reports for `aside`/`career-kit`, which were never diffed by id). Any other
  shape means the classifier is wrong, so re-measure the diff before believing the tool.
  Decide the 10 explicitly, run it for real, re-diff: both nodes agree field-for-field,
  `todos.json.bak` present on both sides.
- **E3** File a todo in the Mac cockpit → visible on `cockpit.example.com`. **Measure the lag**
  (budget: < 1 s end to end against a 58 ms link) and record the number. Then the reverse.
- **E4** Diverge deliberately: link down, change the same todo's `status` on the Mac and
  `priority` on the box, reconnect → both edits survive on both nodes.
- **E5** Placement: from the box's cockpit, start a `requires: [macos]` task → it runs **on the
  Mac**; its live events render in the box's cockpit while watched, and stop being relayed when the
  view closes. With the Mac asleep, the same task **queues with a reason** and starts nothing.
- **E5a** Dispatch safety: name a workflow that exists **only** on the dispatching node → it still
  runs correctly on the target (carried by value). Then put the target's checkout deliberately
  behind `origin` and mid-conflict → dispatch **refuses** and names which, and the override runs it.
- **E5b** Provisioning: run `cez server-install --platform hetzner --role worker` against a
  **freshly created, untouched** VPS and time it. Acceptance: the node enrolls, reports its labels, and completes a dispatched task with
  no manual step other than the agent CLI logins the script explicitly stops for. Then the part
  that is easy to skip and is the whole point — **do it a second time and diff the two nodes**
  (installed versions, unit files, env names, caps, checkout heads). Two nodes that differ mean the
  script is a runbook wearing a shebang. Finally decommission one of them and assert the
  cluster keeps working and stops trying to place work there. Include the hub in the diff: if
  `prod-host` (hand-built, per §2b) cannot be described by the same role, the role is
  incomplete and the fleet has two provisioning paths again.
- **E5c** Capacity actually multiplied: repeat **C0/C1's eight tasks across the cluster** and
  compare wall time to all-8-complete against the single-box C1 number. This is the only evidence
  that a second machine bought throughput rather than just moved queueing around; a cluster that
  admits 8 and finishes no faster than one box has paid EUR 20/mo for latency.
- **E6** Account grants: dispatch from both nodes at once → the hub's account panel shows one
  coherent utilisation, and a limit hold observed on one node parks the other.
- **E7** Sleep/resume: close the Mac for an hour with pending ops on both sides; on wake, converge
  with no manual step, and confirm the periodic reconcile — not the watcher — is what recovered it
  (kill the watcher first).
- **E8** Revoke the Mac from the hub → its ops are refused and its credential is gone; re-enroll.

### Analytics

Events named while designing, per the workspace rule: `cluster.node_enrolled`,
`cluster.link_up` / `link_down` (with duration), `cluster.ops_applied` (count, scope, lag ms),
`cluster.conflict_resolved` (entity, field, winner node), `cluster.lease_granted` / `denied`,
`cluster.dispatch_placed` (node, labels, queue wait), `cluster.reconcile_completed`
(adds/updates/conflicts, duration), and for Phase 1b `cluster.code_minted` /
`cluster.code_redeemed` / `cluster.code_expired_unused` (the three together answer "did the
one-liner actually work for people", which a mint count alone cannot) plus
`cluster.join_failed` **carrying the named reason** — an access rejection and a stale code have
different fixes and must not aggregate into one number. No analytics sink exists in this repo today — stated, not
invented; these are the names to use when one lands.

## Non-goals

Not HA and not failover — the hub is a coordination SPOF by design (D15 bounds the damage). Not
multi-tenant. Not a live-run migration. Not a second code-sync mechanism — git remains it. Not a
cluster-wide `maxParallel` (D14). Not replication of the KB corpus (D8).

**Not autoscaling.** Worker provisioning is a script a person runs, not a controller that reacts
to load. At this size the reaction time that matters is minutes and the fleet changes monthly — but
the real reason is §4: the next ceiling after compute is the **agent subscription**, which no
autoscaler can widen. A controller optimising on CPU pressure would happily buy machines to wait on
a quota.

**And not doctrine.** `CLAUDE.md` / `AGENTS.md` at the workspace root have their own record (the
box) and their own one-way transport (`tools/doctrine-sync`, pull-only by design, SPEC-531). Those
are repo files, which puts them in tier 3. The cluster must not become a second, bidirectional path
for them — that is precisely how the two copies became unrelated histories in the first place.

## Open questions for the owner

1. **Is Phase 0 enough?** The measurements say 8 concurrent runs probably fit on the *existing* box
   once the heavy step is bounded and gated — 12.9 % duty cycle, ~1 expected simultaneous heavy
   step. If C1 confirms that, the cluster becomes a way to go past 8 and to use the Mac's 128 GB,
   not a prerequisite for 8. Worth deciding whether to ship Phase 0 and re-measure before committing
   to phases 1-5.
2. **A third node instead of, or as well as, the Mac? — recommendation, not a question.** Buy VPS
   workers; treat the Mac as a capability node that may also take overflow when it happens to be
   awake. The Mac is the biggest machine in the fleet (128 GB, 8.5× the box) but it sleeps and it
   is the owner's own workstation — eight agents forking 50 processes each is felt — so it can
   never be *counted on* for a capacity number. A CX43-class worker can: ~EUR 20/mo all-in, never
   sleeps, competes with nobody, and §2b shows the shared-vCPU line is where the price is sane
   (against a dedicated-vCPU machine, ~5.5× the cost for two-thirds of the vCPU). Concretely:
   **homogeneous CX43 workers, `maxHeavySteps: 2` each, no backups (cattle), minted by
   `cez server-install --role worker` and never by hand.** What is genuinely still open is only *how many*, and
   that is not a compute question — see Q2a.
   - **2a — the part that is genuinely open: how many workers before the subscription is the
     ceiling?** Unmeasured, and this spec refuses to guess it. Every node draws the same two Claude
     logins and one Codex, on per-account 5-hour windows that no VPS purchase widens. Reach 8
     concurrent (Phase 0, plus one worker if Phase 0 falls short), read the account panel's real
     usage windows at that load, and only then decide on nodes 4-6. Buying ahead of that number
     buys idle vCPUs waiting on a quota, at EUR 20 each per month.
3. **Which node is the hub?** This spec assumes `hel1` (always on, addressable). Note it is now
   explicitly the *weaker* worker — hub is a reachability role, not a capacity one. Mac-as-hub
   inverts the reachability problem and is not recommended.
4. **Should the Mac accept dispatched work at all in v1**, or only be a place to *file* work and run
   device E2E on request? Default in this spec is off, opt-in — but with the capacity framing that
   default is now the thing standing between you and the 128 GB.
5. **Cockpit-app Access service token, or ride the SSH tunnel?** A token on the cockpit app's policy
   is cleaner and independently revocable; the SSH tunnel needs no Cloudflare change.
6. **Do run *records* replicate in Phase 3, or is one merged board deferred?** Todos are the value;
   runs are the nice-to-have.
7. **Does this go upstream?** `open-mercato/cezar` is never pushed to, but this is a general
   feature. If it should stay fork-private, say so before Phase 1 — it changes nothing technically
   and everything about how the flags are documented.
