# Eight tasks at once: bound the burst, then spread across nodes

**Status:** Partial — implemented 2026-08-23, **not yet verified**
**Date:** 2026-08-22
**Revised:** 2026-08-22 (same day), twice — after the owner corrected the premise, then after the
owner set the node economics
**Implemented:** 2026-08-23. All of Phase 0 and every cluster module named below is written and
covered by tests. The gate (`typecheck`, `build`, `test:unit`, `test:package`, `vitest run`) was run
**on `prod-host`**, in a copy of the tree with its own `npm install` — not on the Mac, which
under load (`fseventsd` pegged, load ~9) fails dozens of integration tests on their timeouts and
never finished a full run. The one red on the box is `knowledge/catalog.test.ts` C18, a CPU-per-MiB
budget with no host normalisation that fails identically at **pristine HEAD** on that machine; it is
a standing red there, not a result of this work. The gate was re-run **after** merging
`origin/main` and it is that run — 562 of 563 files green, typecheck 0 — that authorises the push:
the merge itself broke 12 tests in files it never touched textually, by making `instanceId` a
required field of a fresh broker launch. What is **not** done is the measurement: the C0/C1 decision gate this
spec's own Stage 0 puts in front of Phases 1+ has not been captured, so the throughput claim is
designed-for, not measured; C1–C4 need `maxParallel` / `maxHeavySteps` / a memory bound written
into `prod-host`'s `~/.cezar/config.json` first, and C3 cannot run on the Mac at all
(`isolation: 'none'` applies no bound to blame). E2 has no runnable path yet — `cez cluster
reconcile` still lacks a request/response transport. Open items:
`.ai/runs/2026-08-22-multi-node-cezar-cluster/PLAN.md` → "Found during implementation".

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

**One writer, one order — the hub.** Revised 2026-08-22 on the owner's direction (*"single source
of truth … working agents are pushing info to some master … data is very up to date"*), replacing an
earlier CRDT design. Every tier-1 mutation is an op sent to the hub, applied there in arrival order,
pushed back down as a replica. Spokes read locally and instantly, write optimistically with a
`pendingSince` marker, and flush a **derived** outbox — so a hub blip means *pending*, never
*failed*, and D15 (every local write survives the link being down) still holds. This deletes most of
the hard part: **no hybrid logical clock, no per-field LWW merge, no convergence proof** —
`cluster/clock.ts` and `cluster/merge.ts` never get written. Per-field granularity survives as the
*shape of an op*, so two spokes editing different fields of one todo both land. And the headline
hazard dissolves rather than being guarded: with one machine assigning order, `markStarted` is
simply the one write that is **never optimistic**.

**Coordination between agents is the hub arbitrating, not agents negotiating** (D19). Eight
concurrent runs over four real repos collide four ways, and they are not equally hard: the exact
duplicate is already gone (hub-confirmed claims); spec-number collision is the one where multi-node
makes things *worse* unless the hub actually reserves; file overlap is caught by refusing the
placement and naming the other run; and "what else is in flight" is a **read** (`cez cluster
active`) over the `Bash`+`cez` surface agents already have. A chat channel is the last rung and
deliberately deferred — two LLM agents can agree on something wrong as easily as something right,
every exchange spends the subscription that is already the ceiling, and anything one agent writes
for another is an injection surface that must stay attributed data, never prompt.

**The knowledge corpus is the one thing that moves in exactly one direction.** It stays
single-writer on the hub — that property is what the 2026-08-19 cutover bought — but every node
that runs an agent needs it **on disk**, because an agent reads knowledge as `--add-dir` paths, not
as an API, and a node without it produces no knowledge prompt block *at all*, silently. So spokes
sweep a **pull-only, read-only mirror** through cezar's existing `sources/` connector (one new
provider file, one registry row: tombstones, watermarks, quarantine and `notifyChanged` all already
built and tested), scoped per node so 196 files of user reports never land on a machine we plan to
destroy. 13 MB and ~115 KB of churn a day — the cost is nothing, the correctness is everything.

**A fleet you cannot see is a fleet you will not run.** So the cockpit gets its own stage
(**Phase 1b**, before any state replicates): one Settings section listing every node with the two
numbers admission actually uses (`active/maxParallel`, `heavyActive/maxHeavySteps`), which
enforcement it really has (`cgroup` on Linux, `process-tree` on the Mac, or `none` — stated, never
implied), its labels, its repo drift, and the age of its last presence. Adding a node is one
minted, copyable line — `npx -y @loki-labs/better-cezar@<hub version> cluster join cezj_…` — whose
token is **single-use and short-lived by design**, because a command rendered in a UI ends up in
screenshots and shell histories, and because every path on the hub 302s to Cloudflare Access, which
rules `curl … | sh` out entirely (D17).

The single most important thing in this document *was* a refusal — **replication must not ship
before the claim lease** — and D4's move to a hub-linearized write path is what dissolves it. When
one machine assigns the order, there is no second lease to disagree with the first: `markStarted`
becomes the one write that is **never optimistic**, confirmed by the hub before a run starts, and
everything else stays optimistic and local. The hazard is worth keeping in view anyway, because it
explains why the ordering rule exists at all: `todo-autostart.ts` turns `autostart: true` into a live agent run from an
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

### 4a. The Mac is already reading a five-day-old record, and nothing says so

Not a risk this design introduces — a live condition it uncovered. Measured 2026-08-22: the Mac's
cockpit runs with **`CEZ_KB=1`** and its knowledge manifest still registers the `notion` root at
`/Users/mw/loki-labs/notion-export`, the **retired** cold backup. **2082 files, newest mtime
2026-08-17 22:17**, against **2140** on the box — the record is **58 documents ahead**, and the
Mac's catalog has not reindexed since 2026-08-17 either.

An agent run from that cockpit is therefore granted `--add-dir` onto a frozen corpus, because an
agent's knowledge interface is **filesystem paths**, not an API: `workflows/run.ts` feeds
`knowledgeSummary.roots.map(r => r.path)` into `additionalDirectories` and `claude-cli-runner.ts`
emits one `--add-dir` per root. Knowledge-first is rule 1 of `AGENTS.md`, so the agent obeys it, on
a five-day-old copy, and reports success.

**Two separate failures, and they need separate fixes.** A node with *no* corpus produces **no
knowledge block at all** (`loadKnowledgeSummary` returns `undefined`, the block is simply absent —
indistinguishable from "this project has no knowledge"). A node with a *stale* corpus produces a
confident wrong answer. The first is what a fresh VPS worker would do; the second is what the Mac
does today. D8a addresses both: put the corpus on the node, and **stamp it** so its age is a thing
you can see.

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

### 9. Eight agents on four repos will collide, and only some collisions are worth a mechanism

The goal is 8 concurrent tasks against a workspace of 12 registered projects where **4 repos carry
essentially all the work**. Concurrency that high on a base that narrow means overlap is the normal
case, not the exception. Four distinct collisions, and they are not equally hard:

| collision | what it costs | already solved? |
|---|---|---|
| **Two nodes start the same todo** | two agent sessions of one subscription, two worktrees, one result | **yes** — `markStarted` is hub-confirmed and never optimistic (D4) |
| **Two agents allocate the same spec number** | two specs share an identity; already happened here twice (SPEC-356, SPEC-357, both on 2026-08-03) | **no, and multi-node makes it worse** — `chat/tools/next-spec` unions refs and worktrees *on this disk* and, in its own words, "still reserves nothing". A spoke's uncommitted worktree is invisible to it entirely |
| **Two agents edit the same files** | a merge conflict discovered at push, after both did the work | no |
| **Two agents solve the same problem, differently** | duplicated work, and two contradictory decisions in the record | no |

The last one is what the owner is pointing at, and it is the one where the obvious fix is the wrong
one. See D19: the answer is the hub **arbitrating**, not the agents **negotiating**.

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

**Tier 1 — hub-linearized, replicated down to every node (D4)**

| entity | store | scope |
|---|---|---|
| todos | `.ai/cezar/todos.json` (merged in place) | project |
| run **index projection** | `~/.cezar/cluster/runs-remote.json` (new, additive) | project |
| reports triage decisions | `~/.cezar/reports-triage.json` | workspace |
| **captured notes** (`~/.cezar/notes.json`) | the capture inbox | workspace |
| node roster, pairings, placement rules | `~/.cezar/cluster/*` (new) | workspace |

`notes.json` is here because it was **missing from every tier in the first two drafts** — a plain
omission, not a decision. It is a capture inbox: the whole point is filing a thought from whichever
machine you are sitting at, which is exactly the Mac, and a capture that reaches only the laptop it
was typed on is the same failure as the hand-mirrored backlog in §1. Its *processing* (the Loop,
`notes/pipeline.ts`) is a different matter and stays hub-leased with the other schedulers in Phase
5 — a note processed twice creates the work twice.

**Tier 2 — hub-authoritative, spokes call through**

| thing | why it cannot be replicated |
|---|---|
| todo **claim lease** (who may start it) | mutual exclusion needs one decider; `markStarted` is the one write that never applies optimistically (D4) |
| agent-account **grant** + usage aggregate + limit holds | one subscription, N hosts |
| **scheduler ownership** (automations, sources, backup) | a schedule ticked twice does the work twice |
| the KB corpus (`notion-export`) — hub is the only writer, spokes get a **pull-only read mirror** | see D8/D8a: the Mac copy is *deliberately* retired, and a second writer is what the cutover killed |

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

**D4 — The hub linearizes every write. Spokes hold a read replica and a durable write outbox.**

**SUPERSEDED 2026-08-22 (same day), on the owner's direction**, which is a better fit for this
workload than what this decision originally said. Owner: *"it's very important that knowledge base,
tasks list etc is coming from a single source of truth and working agents are pushing info to some
master, and data is very up to date."* The previous text is kept below, unchanged, because the
*field granularity* it argued for survives — what changes is **who decides the order**.

> ~~**D4 — Convergence is per-field last-writer-wins on a hybrid logical clock, not per-record.**
> The 10 real `chat` conflicts differ on `status` vs `archivedAt`; per-record LWW would discard one
> node's edit outright. Each replicated record carries an optional `cv` (cluster version): a record
> clock plus a clock for each *conflict-prone* field that has actually been written (`status`,
> `priority`, `archivedAt`, `summary`, `context`, `whatToDo`, `acceptanceCriteria`). Ordering is
> `(lamport, nodeId)` — nodeId only as a deterministic tiebreak. An LWW-register per field **is** a
> CRDT; that is all the convergence this data shape needs, and it needs no dependency. Wall-clock
> LWW is rejected outright … the *normal* state of the Mac is suspend/resume, and a laptop that
> resumes with a stale clock silently mis-orders every write it makes, with no error anywhere. The
> HLC costs one integer and removes the question.~~

**What it is now.** Every mutation of tier-1 state is an **op sent to the hub**, applied there in
arrival order, and pushed back down to every spoke as a replica update. There is one writer and one
order, so there is no merge to get right:

- **Reads are local and instant** — a spoke serves its board from its own replica, so a hub blip
  never blanks the cockpit and an asleep Mac still shows the last known state (D15 survives intact).
- **Writes are optimistic locally and confirmed at the hub.** The local record is updated
  immediately and marked `pendingSince`; the outbox is **re-derived** from records carrying that
  marker, so D5's crash-safety reasoning is preserved exactly — a lost tail loses nothing, because
  the marker is written inside the same `O_EXCL` lease as the value.
- **The hub's decision is the truth, and a correction is visible.** If the hub's applied result
  differs from the optimistic local value, the replica push corrects it and the cockpit shows that
  it changed, rather than silently swapping the value under the reader.

**Per-field granularity survives, as the shape of an op rather than as merge semantics.** An op
carries only the fields it changed. Two spokes that queued edits to *different* fields of one todo
while partitioned both land, because the hub applies them in sequence. Had ops carried whole
records, the second would clobber the first — same failure the old D4 was written to avoid, reached
by a different route.

**What drops out of the build, which is the practical argument.** No hybrid logical clock, no
`(lamport, nodeId)` ordering, no per-field LWW merge, no anti-entropy convergence proof:
`cluster/clock.ts` and `cluster/merge.ts` disappear, and `ops.ts` keeps derivation and compaction
while losing its merge half. Ordering is decided in one place by arrival, which is a real total
order rather than a synthesized one — and the Mac's suspend/resume clock problem, which is the
reason the old design needed an HLC at all, stops being anyone's problem.

**The one write that is never optimistic: `markStarted`.** A run may only start once the hub has
confirmed the claim, because an optimistic local start on a partitioned spoke is exactly the
double-start this spec exists to prevent. Everything else — status, priority, text, archive — is
optimistic and reconciled. This is a much narrower rule than guarding replication behind a lease,
and it is the *architecture* removing the hazard rather than a guard defending against it: with the
hub serializing claims there is no second lease to disagree with the first.

**What this does not fix, and must not be claimed to:** the 110-row divergence that already exists
predates every clock and every hub. It is still resolved by the classifying reconcile in Phase 2,
which refuses to pick a winner for the 10 unclocked conflicts. A single source of truth prevents
*future* divergence; it cannot adjudicate divergence that happened before it existed.

**D5 — The state carries the pending marker; the outbox is a derived shipping queue.**
*(Heading amended 2026-08-22 with D4: it said "carries the clock", and there is no clock any more.
The property that mattered is unchanged.)*
Ops are *not* the source of truth. Each record's `pendingSince` marker — formerly its `cv` — is
written **inside the existing `O_EXCL` lease, in the same write as the change**, so the marker and
the value can never disagree. The outbox (`.ai/cezar/cluster/ops.ndjson`) is a compactable queue
derived from that, and a crash that loses the tail loses nothing: a boot-time scan re-derives unsent
ops from the records still marked pending, against the last hub acknowledgement.

This property is *more* load-bearing under D4 than it was before, not less. When the hub is the only
writer, a lost outbox entry is a **lost write** rather than a merge that resolves later — so the
outbox must never be the only place an intent exists. Deriving it from the records themselves is
what makes that true by construction rather than by careful flushing.

This follows the reasoning already written into `agent-account-usage.ts` for in-flight run counts:
*"a count persisted here would be incremented at dispatch and decremented at completion, so every
crash, SIGKILL and power cut leaks a permanent phantom … a derived count is wrong for as long as it
takes to re-read, which is never."*

**D5a — Unstamped records are healed on read, and the replicator reads through `readTodos`.**
Not every todo arrives through `createTodo`. `handoff.ts`'s `FOLLOWUP_INSTRUCTIONS` tells the agent
to append a raw object straight into `CEZ_TODOS_FILE` — no `id`, no marker. `readRaw` already
handles exactly this for ids (*"entries without an id get one assigned … the file is rewritten
(under the lock) on this read"*), so the pending stamp extends a proven, idempotent heal-on-read
rather than inventing a second one. (Reworded with D4; it said `cv`.)

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

**D8 — The KB corpus has exactly one writer, the hub. Spokes get a pull-only read mirror.**
`~/loki-labs/notion-export` on the Mac is a *deliberately retired* cold backup (production cutover
2026-08-19). A "sync everything" cluster would silently make it live again and re-create exactly the
drift the cutover killed. So the corpus is **never** bidirectional and a spoke never writes into its
own copy. This is the one place where the obvious behaviour is the wrong one, so it is a decision
rather than an omission.

**CORRECTED 2026-08-22 (same day) — the single-writer rule stands; the MECHANISM was wrong.** This
decision read: ~~"Spokes read the corpus **through the hub** (`/api/v1/workspace/knowledge`) with a
read-only local cache, marked read-only, never written back."~~ That serves the *cockpit* and
cannot serve an *agent*, which is the consumer that matters once a worker runs work. Measured in
the code: an agent's knowledge access is **filesystem paths**, not an API — `workflows/run.ts`
passes `knowledgeSummary.roots.map(r => r.path)` into `additionalDirectories`, which
`claude-cli-runner.ts` turns into one `--add-dir <path>` per root, and `loadKnowledgeSummary` reads
the *persisted catalog for that node's own dataDir*. A worker with no corpus on disk therefore has
no roots to grant, no catalog to summarize, and **no knowledge block in its system prompt at all** —
and it fails **silently**: `loadKnowledgeSummary` returns `undefined` and the prompt block is simply
absent, which is indistinguishable from "this project has no knowledge". Knowledge-first is the
first rule in `AGENTS.md`; a node that cannot read the record would follow it by reading nothing and
report success. Replaced by a real mirror on disk — **D8a**.

**D8a — The corpus mirror is a source connector, not a new transport.**
cezar already has a tested one-way document-mirroring machine, built for exactly this shape:
`sources/` (spec `2026-08-06-external-source-connectors-notion.md`), whose own registry docblock
says *"a second provider is one new file plus one row in `SOURCE_PROVIDERS` — no contract change,
no route change, no UI change"*. The hub becomes a provider (`kind: 'cezar-hub'`), and the spoke
sweeps it. What that buys, none of which has to be designed again:

- **watermark-resumable sweeps** with backoff and full jitter, and `truncated` distinguished from
  failed — a spoke that was asleep resumes rather than refetching;
- **explicit tombstones**, never absence-diffing — the sweep's own docblock is emphatic that a
  document's absence from one delta is not evidence of deletion, which is the bug a hand-rolled
  rsync-shaped mirror would ship;
- **`quarantine`**, whose contract is *"the incoming body is quarantined; the local body is left
  byte-identical"* — precisely the right behaviour when a local file has diverged, i.e. when
  something on this node wrote into the mirror. Silently overwriting it would destroy evidence;
  silently keeping it would fork the record;
- **`notifyChanged`** after every commit, *"required after every sweep, never best effort"* — so
  the KB index picks the mirror up with no restart;
- **`adopt`**, a one-way cutover out of the read-only mirror into the writable root, already built.

Two properties this design must add on top, because they are cluster-specific:

1. **The sweep is node-local and therefore takes no scheduler lease.** It writes only this node's
   own mirror, so the Phase 5 test — *"does a second tick do the work a second time, anywhere but
   here?"* — answers no. Leasing it would be the wrong instinct.
2. **The mirror is scoped, and `reports/` is the reason.** 196 files of user reports carrying
   phones and chat ids. Mirroring them to a rebuild-on-a-whim VPS worker spreads PII to machines
   whose whole premise is that they are disposable. Default mirror set for a worker:
   `knowledge/`, `domains/`, `changelog/`, `tasks/`. `reports/` and `raw-input/` are opt-in per
   node, off by default, and the cockpit says which set a node holds — an agent must never be left
   guessing whether "not found" means absent or unmirrored.

**Sync cost is not the constraint here; correctness is.** Measured 2026-08-22: the corpus is
**13 MB / 2140 files** (tasks 636 · changelog 832 · knowledge 433 · reports 196 · raw-input 33 ·
domains 9) and churns **19 files / 115 KB in 24 h** (31 files / 182 KB in 48 h). A full snapshot is
one HTTP response; a day of deltas is a rounding error against the 58 ms link. So spend the design
budget on being auditably correct — divergence detection, tombstones, staleness — and not on being
clever about bytes. (Careful with the obvious measurement: every file's mtime is ≥ 2026-08-17
because that is when the import wrote them all, so "files changed in the last 7 days" returns the
whole corpus and means nothing.)

**This is not a hypothetical, and the evidence is the Mac, today.** Measured 2026-08-22 while
writing this section: the Mac's cockpit is running (`serve --repo /Users/mw/loki-labs`, pid 38230)
with **`CEZ_KB=1`**, and its knowledge manifest still registers `notion` →
`/Users/mw/loki-labs/notion-export`, `readOnly: true`. That tree is the **retired** cold backup —
**2082 files, newest mtime 2026-08-17 22:17**, against the box's **2140**, so the record is **58
documents ahead**. The Mac's own catalog was last written 2026-08-17 22:17 and has not reindexed
since; neither document written to the record today exists there. So a Mac agent asked to do
knowledge-first work right now is granted `--add-dir` onto a five-day-old corpus and told nothing.
The retired copy did not need a cluster to become a hazard — it already is one, silently, and the
staleness stamp below is the part that would have said so.

**A stale mirror must be loud, because a knowledge read has no natural error.** A wrong commit
throws; a corpus that is four hours behind just returns an older answer, confidently. So the mirror
carries the hub's corpus version and its own fetch time, the cockpit's node row renders corpus
freshness **beside** repo drift (they fail the same way and belong side by side), and a dispatch to
a node whose mirror is stale past a bound is **refused with that reason named** — the same shape as
D12a's refusal of a checkout that is behind or mid-conflict, for the same reason: "it ran, against
stale knowledge, on a machine you weren't looking at" is the expensive outcome.

**And a spoke's knowledge WRITES go to the hub, or nowhere.** The `notion` root is already
`readOnly: true` in the live manifest on the box, so `cez kb write` is refused everywhere by
machinery that exists (`READ_ONLY_ROOT_REFUSAL`). That is not sufficient on a spoke, because
`--add-dir` grants the agent write access to the mirror path directly — it can create a file the
`readOnly` flag never sees. Two halves, and both are needed: the sweep **quarantines** a diverged
file rather than overwriting it (so the write is preserved and visible rather than destroyed), and
`cez kb submit` forwards a document to the hub over the link so there is a *correct* path that is
easier than the wrong one. A rule that only forbids, without offering the affordance it replaces,
gets routed around.

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
picked up on the next pass. So the cluster path is: **send the claim op → wait for the hub's
acknowledgement, which carries the applied `startedTaskId`/`startedOn` → then start.** This is the
one write D4 exempts from optimistic local application, and the exemption is the whole of it. The
local, single-node path is unchanged; nothing about a cezar install with clustering off moves.

**Simplified 2026-08-22 with D4.** This read *"acquire the claim lease → stamp … → then start"*,
and added that a TTL lease is reclaimable so the durable idempotency key had to be the replicated
stamp rather than the lease. Under a hub that linearizes, the two collapse into one thing: the hub
applies the claim op or it does not, and its acknowledgement **is** the stamp. There is no separate
lease to expire, no second holder to race, and no window between acquiring and stamping — which was
the window this decision existed to close. What survives verbatim is the ordering itself: **confirm
before start, never start-then-record.**

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

**D15a — …but autostarting a todo this node did not author needs the hub's confirmation.**
D15 (every local write survives the link being down) and the confirm-before-start rule pull in
opposite directions, so they get **scopes, not an ordering**:

| the node is doing | link down |
|---|---|
| a person clicks ▶ Run, or `cez run` | **proceeds** — a human is asserting intent on this host |
| autostarting a todo **this node authored** | **proceeds** — it was never anyone else's to start |
| autostarting a **replicated** todo | **refuses**, and says why (`waiting for the hub to confirm the claim`) |

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

**INCOMPLETE, found 2026-08-23 while implementing D20 — the hub mints the per-node secret and then
throws it away. RESOLVED the same day by D22 below, which decides where it goes; read that for the
answer and this for the diagnosis.** `redeemEnrollmentCode` (`cluster/enrollment.ts`) generates
`randomBytes(NODE_SECRET_BYTES)`, marks the code redeemed, returns the secret to the joining node
— and **persists it nowhere.** `cluster/peers.ts` contains the string `secret` zero times, and the
contract's node schema says outright *"It has no `secret` field at all"*. Verified by grep across
`packages/cezar/src` and `packages/contract/src`: no hub-side store maps a node id to its secret.

The consequence is larger than D20. **The hub cannot verify any node, by any transport.**
`verifyClusterFrame` needs that secret, so the LINK's own per-frame authentication (D17's *"the
secret every link frame is signed with"*) is equally unusable on the hub side — this is not a gap
D20 introduced, it is one D20 tripped over. The pieces on the spoke are all correct; the half that
was never built is the receiving end.

So the enrollment story reads as complete and is not: a node can join, be recorded in the roster,
and hold a secret that nothing on the other side can check. Until a hub-side store exists,
`node-auth.ts`'s `lookupNodeSecret` correctly fails closed (`unknown-node` for every caller), which
means **every node-authenticated route answers a refusal by construction** — the honest posture,
and the reason D21's todos routes are not being wired yet: routes that can only 401 are worse than
routes that do not exist.

Building it is not a one-liner and should not be treated as one. Where the secret lands is a
security decision: `peers.json` is the wrong home unless it is proven that nothing renders it —
`GET /api/v1/cluster` serves the roster, and the contract removed `secret` from the served node
shape *on purpose*.

**SUPERSEDED 2026-08-23 by D22 — the sketch that stood here was right in outline and wrong in one
detail that matters.** It read: *"The likely answer is a separate `0600` store keyed by node id,
written inside the same lease that marks the code redeemed (so a crash cannot leave a node holding a
secret the hub never recorded), with revocation removing it."* D22 keeps all of that and pins the
**ordering**, which the sketch left open by saying only "inside the same lease": the secret must be
written **before** the code is marked redeemed. Same lease, two files, and the failure is asymmetric
— redeem-first strands a node holding a credential the hub never stored *and* a code it can never
redeem again, while secret-first strands only an inert orphan. D22 also settles the question the
sketch did not raise at all: the secret is stored in **plaintext**, because HMAC verification needs
the key itself and digest-at-rest (correct for enrollment codes, which only need equality) would
fail every signature here.

**D19 — Agents coordinate by the hub arbitrating, not by talking to each other.**
The owner's ask (*"agents should be able to communicate with each other via the master hub"*) is the
right problem — Problem §9 — and worth being precise about, because "let the agents talk" is the
expensive answer to most of it. Three reasons a chat channel is the wrong default here: two LLM
agents can agree on something wrong as easily as something right, and there is no assertion that
catches it; every exchange spends the **same subscription pool that is already the ceiling** (§4);
and the failures in §9 are *coordination* problems, which one arbiter solves deterministically and
two negotiators solve probabilistically.

So a ladder, cheapest and most deterministic first. Build downward only while the rung above is
insufficient:

1. **Claim, don't announce.** Already the design: `markStarted` is hub-confirmed, so the exact
   duplicate never happens. Nothing to add.
2. **Reserve what is genuinely scarce, at the hub.** Spec numbers are the case with a track record.
   `next-spec` reads one disk and reserves nothing, so two spokes will collide *more* readily than
   two local sessions do. A hub allocator that actually hands out a number and records it is small,
   exact, and removes a whole class. **Multi-node makes this a regression if it is skipped** — worth
   saying plainly, because it is the one place where the cluster makes something worse rather than
   just not-better.
3. **Refuse overlapping placement, with the other run named.** The hub knows every active run: its
   todo, its project, its branch, and — via `collectChanges` on the owning node, one git call at
   dispatch — its touched paths. Before placing, ask whether an active run already holds this
   project and overlapping files. If so, **queue with a reason that names the other run**, don't
   start and hope. This is deterministic, costs no tokens, and catches the collision *before* the
   work is wasted rather than at push time.
4. **Let an agent read what else is in flight.** Agents already have `Bash` and `cez` on PATH, so
   this needs no MCP server and no new transport: `cez cluster active` returns in-flight runs with
   their todo summary, node, branch and touched paths. They also already write status — `handoff.ts`
   seeds a per-run journal and the system prompt tells the agent to keep its Progress log current —
   so the content exists; what is missing is that it is readable from another run. A **read** is
   bounded, cacheable, and inspectable in the transcript in a way a conversation is not.
5. **An attributed inbox — last, narrowest, and still not a chat.** For the genuine mid-flight case
   ("I am changing the shape of this shared type"), an agent posts a finding to the hub and the next
   agent to touch that project sees it on its next `cez` call. Asynchronous, one-directional,
   durable. No turn-taking, no waiting on a peer, no deadlock. **Defer this until 2-4 prove
   insufficient**, and say so rather than building it speculatively.

**The rule that constrains rungs 4 and 5, and it is not optional: agent-authored text read by
another agent is an injection surface.** The corpus is human-curated; a cross-agent channel is not.
So anything one agent wrote and another reads is **data, attributed and framed as a report** — *"run
`r_123` on `worker-2` reported: …"* — never merged into a system prompt, never able to grant a
capability, name a tool, or widen an allowlist. cezar already holds this line elsewhere: the
knowledge prompt block admits only tags matching `/^[a-z0-9][a-z0-9 _-]{0,31}$/`, dropping anything
else entirely rather than truncating it, precisely so no document-derived text can carry
punctuation, a URL, or a newline into the prompt. Rungs 4 and 5 inherit that discipline or they do
not ship.

**And one thing that is emphatically not on the ladder: a shared writable scratchpad.** Two agents
editing one file is the collision, not the cure.

**D20 — The cluster HTTP family authenticates the NODE, with the link's own signed
freshness-bounded principal, before it serves any data route.** Added 2026-08-23, during
implementation.

Every route under `/api/v1/cluster/*` today is gated on two things and only two: `CEZ_CLUSTER=1`
(`requireCluster`) and, on some paths, "this node is the hub" (`requireHub`). Neither of those is
authentication. That was harmless while the family carried only control operations whose payloads
are the node's own roster, and it stops being harmless the moment a route returns **content** —
which is why `GET /cluster/corpus` and `GET /cluster/corpus/*path` are parked at 409
`CORPUS_PENDING` rather than serving, and why `cluster/reconcile.ts` refused to invent a transport
for a peer's todo list.

Cloudflare Access in front of the production hub is not the answer to this. It is an outer
perimeter that gates *people* and today admits any principal holding the org's service token; it
says nothing about which **node** is asking, and the mirror scope in D8a is per-node by
construction. A data route that cannot name its caller cannot scope its answer.

The mechanism is already decided and already built, for the link: *"Signed freshness-bounded
principal per `supervisor/forwarded-principal.ts`"*. Extend it from the WS upgrade to the HTTP
family rather than inventing a second scheme —

- the signing key is the **per-node HMAC secret** enrollment already mints and writes `0600`
  (`cluster/enrollment.ts`, D17), so nothing new is stored and nothing durable is pasteable;
- the payload names the node and the request, and is **freshness-bounded**, so a captured header
  is not a standing credential — which a bare `Authorization: Bearer <secret>` would be;
- verification is `verifyForwardedPrincipal`'s existing constant-time path, not a new comparison.

This **supersedes the auth shape package 3b.1 invented** (`Authorization: Bearer` +
`x-cezar-node-id`), which was flagged at the time as invented rather than specified and left for
3b.2 to match or revise. This revises it. A bearer secret over a route family with no replay window
is the weaker half of a choice that was never actually made.

Two properties that are the point of writing this down rather than adding a middleware quietly:
**a route joins the authenticated set by its path, never by remembering to call a helper** — the
same argument `requireCluster`'s docblock already makes, and the same failure it already avoided
once. And **a node authenticates as itself, not as "a node"**: the identity the middleware
establishes is what scopes the answer, so an authenticated spoke asking for a project it is not
paired with gets the same refusal as a stranger.

**D21 — Reconcile reads over HTTP and writes over the ops path; only the SNAPSHOT is new.**
Added 2026-08-23, during implementation.

`cluster/reconcile.ts` landed complete and unwired: `RemoteReconcileTransport` is an interface with
no implementation, so `cez cluster reconcile` throws a named error and **E2 — the 110-row backfill
that motivated this entire design — has no runnable path.** The gap is smaller than it looks, and
naming which half is actually missing is what keeps it small.

Of the transport's four methods, three already have rails. `apply` is "append these rows to the
peer", which is what an `ops` frame carrying creates already is (D4/D5); `backup` is a local write
on the receiving side; `listProjects` is the confirmed-pairings list the roster already serves. Only
`list` — *give me your full todo list for this project* — has no primitive, because the link is
deliberately fire-and-forget and event-streamed, with no request/response (D16 reconciles
periodically precisely because there is nothing to ask).

So: **one new read.** `GET /api/v1/cluster/todos/:projectKey` on the hub, returning a snapshot of
that project's `todos.json`, scoped to a **confirmed pairing** with the authenticated node (D20).
Reconcile then runs **from the spoke against the hub**, which is the direction E2 needs and the only
direction that is addressable anyway — a spoke dials out and has no inbound address (Problem §7,
and the reason the link is an outbound WS in the first place).

Two consequences worth stating rather than discovering:

- **This is a snapshot, not a subscription.** It is the one-off backfill for rows that predate the
  link. Once a project's rows are flowing as ops, reconcile is the periodic *check* D16 describes,
  not the transport. Nothing should grow to depend on polling this route.
- **A hub reconciling against a spoke is out of scope, and stays out.** Not an omission: there is
  no address to reach. If it is ever wanted, the answer is a request/response frame family on the
  existing link, not a second HTTP surface.

The real merge stays owner-gated per P9 — `--dry-run` is the default posture, and writing 110 rows
into the record every session reads first is a data change that deserves the owner present. What
D21 changes is that the dry run becomes **runnable at all**.

**UNBLOCKED 2026-08-23 by D22** — the paragraph below said these routes were held back because a
node-authenticated route could only ever answer 401. The hub-side secret store now exists, so that
reason is spent and D21 is buildable. The rest of the paragraph still describes why it was right to
wait, and is kept for that.

**AMENDED 2026-08-23 — `/append` takes its own backup, inside its own lease.** Building `/backup`
and `/append` as two independent HTTP calls would re-create, and widen, a hazard already logged
against `reconcileProject`: the `.bak` is written outside the lease that guards the write it
protects, so a concurrent `createTodo`/`updateTodo`/`markStarted` landing in between is handled
correctly by the append (which re-reads fresh under the lease) and is **absent from the backup**.
Across a network the gap is not microseconds, it is a round trip. A backup that can be older than
the state it backs up is worse than none, because it is trusted — restoring from it silently rolls
back an unrelated write.

So `POST /cluster/todos/:projectKey/append` performs backup-then-append **within one lease** on the
hub, and the `.bak` write is idempotent so a preceding `/backup` call does not conflict with it.
`/backup` remains a route because the transport's own contract calls `backup()` before the first
mutation of a pass *whether or not that peer ends up receiving any adds* — the zero-adds case has no
append to ride along with. The two are therefore not redundant: `/backup` covers "a pass is about to
write something, somewhere", `/append`'s internal backup covers "this specific append is protected
by a snapshot taken under the same lock it will write through".

**AMENDED 2026-08-23 — the wire record must be a passthrough twin of a strict schema, not a strict schema.** The first implementation made `clusterTodoRecordSchema` `.strict()` with all 26 fields spelled out, dropping D13's unknown-field tolerance for this one shape. That was chosen to satisfy a **typechecking** problem — `contract-parity.cluster.test.ts`'s generic `Mutual<Schema, Route>` check disagrees with itself when a passthrough object's index signature is compared inside a generic type alias — and it traded a data guarantee to buy it, which is the wrong direction.

Measured, not argued: a single row carrying one field this build does not know is `REJECTED — unrecognized_keys`, which fails the **entire** snapshot response, and gets a `/append` **400 before the append runs**. `todos.ts`'s own D13 docblock says why that shape is wrong and names this exact scenario: *"wrong the moment a newer node in the cluster writes a field this build has never heard of."* Reconcile is the lossless cross-node backfill, and a hub and a spoke on different machines upgrade at different times — version skew is the normal state of this system, not an edge case. The failure also reads as corrupt data rather than as version skew.

Use the split this repo already uses twice (`todoSchema`/`storedTodoSchema`, `clusterOpSchema`/`storedClusterOpSchema`): keep `clusterTodoRecordSchema` plain for the TYPE and the parity check, and validate the wire with `storedClusterTodoRecordSchema = clusterTodoRecordSchema.passthrough()`. The type keeps its shape, the runtime keeps its tolerance, and the parity check never sees an index signature. Note the route comment claiming *"the wire shape is passthrough-by-design"* was left from the abandoned attempt and described the code accurately only BEFORE `.strict()` landed — a stale comment that made the defect read as intentional.

**LANDED 2026-08-23** (superseding the "NOT YET IMPLEMENTED" paragraph below, kept for the ordering
rationale it still states correctly). The three routes, the HTTP `RemoteReconcileTransport`
(`cluster/reconcile-transport.ts`), and `cez cluster reconcile`'s CLI wiring (`index.ts`) are all
built, on top of D22's real secret store — see the Verification paragraph after D22's own, below.

~~NOT YET IMPLEMENTED, and deliberately so (2026-08-23).~~ D21 is a decision, not a landed route.
The three routes are blocked behind the D17 correction above: with no hub-side node-secret store,
`node-auth.ts` fails closed and a node-authenticated route can only ever refuse. Shipping
`GET /cluster/todos/:projectKey` today would add a route that answers 401 by construction, which
reads as "built" in every list that counts routes and is strictly worse than its absence. The
order is: hub-side secret store → D20's gate actually verifying someone → D21's routes → the
transport and CLI wiring → E2's dry run. The `/cluster/todos/*` path is already registered in the
authenticated set (`cluster-routes.ts`'s D20 block) so the route inherits the gate the moment it
exists, rather than depending on a second person remembering.

**D22 — The hub stores each node's secret in its own `0600` file, in PLAINTEXT, written before the
code is marked redeemed.**

This is the correction to D17 above, and it unblocks both D20 and the link. `redeemEnrollmentCode`
mints `randomBytes(NODE_SECRET_BYTES)`, returns it to the joining spoke, and persists it nowhere —
so `node-auth.ts#lookupNodeSecret` answers `undefined` for everyone and `verifyClusterFrame` has no
receiving end either. Four decisions, each of which someone would otherwise get wrong in a
defensible-looking way.

**Its own file, not `peers.json`.** `GET /api/v1/cluster` serves the roster, and the contract's
served node shape says outright that it has no `secret` field — deliberately. A secret stored
alongside the roster is one careless `readPeers()` away from being handed to every spoke, i.e. from
giving each node every other node's credential. So: `nodeSecretsPath()` → `<clusterHomeDir>/node-secrets.json`,
`0600`, keyed by node id, sibling to `node.json` and `enroll-codes.json`, and **never rendered by any
route**. The one function that reads it returns a single node's secret by id; there is no "list all"
accessor to be tempted by.

**Plaintext at rest, and this is the part that looks wrong and is not.** D17 stores enrollment codes
as a digest precisely because redemption only needs an *equality* check, and it would be natural —
and wrong — to apply the same reasoning here. HMAC verification needs the actual key: you cannot
recompute `HMAC(payload, secret)` from a digest of `secret`. A store that hashed these would fail
every signature and read as a signing bug rather than a design mistake. The protection is therefore
file mode and the fact that a hub compromised enough to read `0600` files in cezar's home already
owns the process that holds the secrets in memory. Say this in the file's own docblock, because the
next reader will otherwise "fix" it.

**Written BEFORE the code is marked redeemed, inside the same `withEnrollCodesLease`.** The two
writes touch different files, so ordering is a real choice with an asymmetric failure. Redeem-first
means a crash between the writes leaves the code burned and no secret stored: the node holds a
credential the hub can never verify, and cannot re-join without an operator minting a new code —
unrecoverable from the node's side. Secret-first means a crash leaves an orphan secret for a node
that never completed enrollment, which is inert (nobody can authenticate as that node without
holding the secret, and it is overwritten on the next successful redeem of the same code). Prefer
the recoverable failure. Note the lease being held is `enroll-codes`', not a lease on the secrets
file — correct here because that lease already serialises the only path that writes a secret, but
it means anything else that ever writes this file must take the same lease, not a new one.

**Removed on revoke, replaced on re-join.** `disableNode` drops the entry, so disabling a node
actually revokes its ability to authenticate rather than only hiding it from the roster — today
`disableNode` is a roster edit and nothing else, which would leave a disabled node's signatures
still verifying. A node re-joining replaces its entry rather than appending: one secret per node id,
always the newest, so a re-enroll rotates the credential as a side effect.

**What this unblocks, in order:** `cluster-routes.ts` wires `lookupNodeSecret` to this store instead
of the fail-closed default, `link-server.ts#authenticateLinkUpgrade`'s injected `lookupSecret` gets
the same store (which is what fixes the link's own per-frame auth, not just HTTP), then D21's todos
routes stop being routes that can only 401, then the reconcile transport, then E2's dry run.

**Verification.** (23) A redeemed enrollment writes a readable secret whose value is the one handed
to the spoke — assert the value, not that the file exists. (24) The stored secret verifies a real
`signNodeHttpPrincipal` from that node end-to-end through `createNodeAuthMiddleware`, and a
different node's id does not. (25) Negative control on ordering: make the enroll-codes write throw
after the secret write and assert the code is NOT marked redeemed and the same code still redeems
afterwards. (26) `disableNode` removes the secret, and a signature that verified before it now
refuses `unknown-node` — the negative control being that it verified *before*, or the test proves
nothing. (27) The secrets file is `0600` and its parent is not world-readable, asserted on the mode
bits. (28) No route response anywhere contains a stored secret: drive `GET /api/v1/cluster` with two
enrolled nodes and assert neither secret appears in the serialised body.

**Verification, added 2026-08-23 (D21 landed — the three routes, the transport, and the CLI
wiring).** Continues the numbering above; additive to items 20–22, which describe the same routes
at spec-time and still hold. (29) `/append`'s own backup runs inside its own lease, proven by
obstruction rather than restated: pre-occupy the append write's tmp path (`todos.json.tmp` as a
directory — `enrollment.test.ts`'s own EISDIR trick) so the append half fails, and assert the
backup still landed holding pre-mutation state while the data file itself is untouched
(`todos.test.ts`); then, under the same obstruction, race a concurrent local write against the
doomed call and assert it cannot land until the doomed call's lease releases — composing
`backupTodos()` then a separate `appendTodosPreservingIds()` (the shape the amendment rejected, since
`backupTodos` alone takes no lease) lets the concurrent write land inside the backup instead, and
mutating to that composition is what turns this test red. (30) The transport signs every request
with the real signer and the real verifier accepts it — `verifyNodeHttpPrincipal` against a
captured request, never a re-derivation with the same signer that produced the headers
(`reconcile-transport.test.ts`) — for `list`/`backup`/`apply` each, against both a bare local hub
and the real `createClusterRoutes` served over a real socket (`@hono/node-server`). Also: the hub
routes scope by a CONFIRMED pairing only, proven with the SAME authenticated node succeeding for a
project it is paired with and refused for one it is not, in the same test
(`cluster-routes.test.ts`). (31) `cez cluster reconcile`'s dry-run is the DEFAULT posture, proven
end to end through a real subprocess CLI invocation against a real hub server
(`cluster-reconcile-cli-wiring.test.ts`): a bare invocation with no flags writes nothing on either
side (`todos.json` byte-identical before/after, no `.bak` created), `--apply` performs the real
merge, and `--dry-run` wins when both are given, regardless of flag order. This is also the
regression test for a bug found while wiring the command: the scaffold's original
`'dry-run': { default: false }` meant a bare invocation would WRITE, silently reversing D21's own
stated default (`node:util`'s `parseArgs` has no `--no-x` negation, so the fix adds `--apply` as
the explicit opt-in rather than trying to default `--dry-run` to `true`).

**OPEN, and it contradicts this decision — do not wire Stage 1.5 until it is settled (found
2026-08-23).** D21 says above that "the real merge remains owner-gated by P9", and the CLI ships
dry-run-by-default because of it. `cluster/reconcile.ts`'s `PeriodicReconcileOptions.run` docblock
says the production caller is "a **non-dry-run** `reconcileAll` against every peer this node is
linked to". Both are in the tree. The disagreement is not cosmetic: the safety property that makes
an unattended pass sound is that `divergent-unclocked` rows are refused, but the divergence this
design exists for is **110 rows present on one side only**, which is precisely the class a
non-dry-run pass *does* merge. Arming the periodic reconcile therefore performs **E2**,
automatically and unattended, the first time two nodes link. `CEZ_CLUSTER` is currently unset on
`prod-host`, so nothing is armed and there is no urgency — which is also why this will not
announce itself. Full statement of the options in
`.ai/runs/2026-08-22-multi-node-cezar-cluster/PLAN.md`. Whichever way it is decided, the losing
statement gets corrected in place. (32) **D13's unknown-field
tolerance survives the wire in every direction**, asserted on the field's VALUE rather than on the
request succeeding: a row carrying a field this build has never heard of round-trips (a) out through
`GET /cluster/todos/:projectKey` (`cluster-routes.test.ts`), (b) back in through the transport's
client-side parse (`reconcile-transport.test.ts`), and (c) through `POST .../append` — present in
the response AND on the hub's disk afterwards, so it survives the WRITE and not merely the reply.
Each row is seeded straight to disk rather than through any zod-typed helper, so the seed itself
proves nothing and only the round trip does. **Mutation-checked, and the two halves are guarded in
different places** — reverting `storedClusterTodoRecordSchema` to `.strict()` reddens exactly the
three transport/append tests and leaves the snapshot-route one green, because the route never parses
the contract schema at all (`c.json()` only types the handler's return); that one is guarded by
`todos.ts#storedTodoSchema`, and reverting THAT to `.strict()` reddens exactly it. This exists
because the wire record was first written `.strict()` to settle a typing problem, which traded away
the one property the reconcile path exists for. The fix is a passthrough TWIN, not a wider response
schema: `contract-parity.cluster.test.ts` compares the response schema against Hono's
`InferResponseType`, which cannot carry an index signature, so a passthrough response schema fails
parity by construction.

**D23 — The cluster's only transport is a Cloudflare tunnel, so every hub-bound request crosses a
SECOND, independent gate — and the two must never be confused for each other.** Owner decision,
2026-08-23: *"of course the whole cluster should be only on CF tunnels."* The hub does not listen on
a public port and will not be given one — measured on the production hub, it binds `127.0.0.1:4321`
and is published only through a token-managed tunnel fronted by Cloudflare Access.

This makes two gates in series, and the ordering matters: **Access proves you may reach the port;
the node principal (D20 for HTTP, D17 for the link) proves WHICH NODE you are.** Neither substitutes
for the other. An edge credential is not identity — it is shared by every node that has one and says
nothing about who is calling — so nothing in cezar may ever read it as authentication. Conversely a
valid node principal is worthless if the request never arrives.

Both spoke-to-hub paths needed the edge credential added, because neither could carry one: the link
client (`cluster/link-client.ts`) dials with exactly the three node-auth headers, and the D21 HTTP
transport (`cluster/reconcile-transport.ts`) signs with D20 and nothing else. Measured before
building anything: `GET https://<hub host>/api/v1/health` answers **302 both with and without** the
existing Access service token, because that token is scoped to the SSH application only. So the
symptom of not doing this is not a clean refusal — it is a link that reconnects forever against a
redirect, and a reconcile that fails with an HTML body.

Consequences that fall out of it, and are why this is a decision rather than a config note:

- The credential is resolved from the environment (`cluster/edge-auth.ts`) and injected, never
  hard-coded, and **a half-configuration fails closed and loudly** — one variable set without the
  other would otherwise present as an unexplained 403 loop.
- **The node-auth headers win on any key collision.** An edge credential must never be able to
  overwrite the node principal, or the outer gate could weaken the inner one.
- The credential is never logged, and never sent anywhere but the configured hub.
- **The two variables are treated ASYMMETRICALLY by cezar's own agent-env allowlist, and the
  asymmetry is load-bearing.** Verified against the live regex 2026-08-23: `agent-env.ts` forwards
  any `CEZ_*` name that is not secret-shaped, and `SECRET_NAME_RE` matches `SECRET`. So
  `CEZ_CLUSTER_ACCESS_CLIENT_ID` **is** inherited by a spawned agent while
  `CEZ_CLUSTER_ACCESS_CLIENT_SECRET` **is not**. An agent inside a run therefore sees exactly one
  half of the credential — which is precisely the case the fail-closed rule above turns into a
  named, visible error rather than an unauthenticated request. That is the design working, not a
  bug: the loud failure is strictly better than a silent 403 loop. The operational consequence is
  the same two-step rule the Cloudflare API token already follows on the box — to let an agent run
  a cluster command, the SECRET must ALSO be named in `CEZ_ENV_PASSTHROUGH`, and skipping that
  second step fails as "the agent cannot see it".
- Access applications are keyed on hostname AND path, so the cluster family can be governed
  separately from the cockpit's human policy. Both cluster paths (`/api/v1/cluster/link` and D21's
  todo routes) already share the `/api/v1/cluster` prefix, so one application covers both and no new
  tunnel route or DNS record is needed.

**D24 — The node-authenticated cluster routes are exempt from the cockpit auth wall, and the
exemption list and the node-auth list are ONE definition.** Found by measurement on the production
hub while wiring D23, with a control:

```
GET /api/v1/health   -> 200                            (exempt)
GET /api/v1/cluster  -> 401 {"error":"unauthenticated"}
GET /api/v1/todos    -> 401                            (control: an ordinary authed route)
```

`server.ts`'s `app.use('/api/*', ...)` exempts only `/health` and `/ready`. Everything else requires
a **cockpit principal** — which a spoke has no way to obtain. So the entire D20/D21 HTTP family
answered 401 before `requireCluster`/`requireNodeAuth` ever ran, on every deployment with `CEZ_AUTH`
set, which is every real one. The 401 rather than the flag-off 409 is the proof the wall fires first.
The WebSocket link was never affected: an upgrade never reaches Hono.

The exemption covers exactly the five node-authenticated prefixes — `/cluster/corpus`,
`/cluster/corpus/*`, `/cluster/todos/*`, `/cluster/allocate/*`, `/cluster/leases/*` — and nothing
else. `/cluster` (the roster), `/cluster/enroll*` and `/cluster/join` stay behind the wall: they are
cockpit routes, and widening the exemption to `/cluster/*` would put enrollment-code minting on the
open internet.

**The structural half is the point.** This is one concept enforced at two places, and the drift
direction that matters is catastrophic and silent: a path exempted from the wall but not covered by
`requireNodeAuth` is completely unauthenticated. So both are derived from a single exported
definition, and the guard test asserts every exempt path is node-authenticated AND that each refuses
an uncredentialed request with one of node-auth's four named reasons — with a floor assertion, so an
empty derived list cannot pass vacuously as "all clear".

**D25 — Redeeming an enrollment code writes the roster row, in the same lease as the secret; and
revoking a credential never depends on a roster row existing.** A defect found 2026-08-23 while
wiring the link, not a new design: `enrollment.ts#redeemEnrollmentCode` minted a per-node secret and
**wrote no roster row at all**. The only production `upsertNode` call in the package is
`PATCH /cluster/nodes/:nodeId`, which begins `if (!current) return 404` and can therefore only update
a row that already exists. Nothing created one.

So a node that ran `cezar cluster join` successfully held a working credential and did not exist in
`peers.json`. Four consequences chained off that one missing write, and the third is a security
defect:

1. Invisible — absent from the cockpit roster and from the `welcome` frame's roster.
2. Unstampable — `markNodeSeen` deliberately never fabricates a row, so every heartbeat was dropped.
3. **Revoke did not revoke.** `disableNode` removed the node's secret only `if (found)`, and `found`
   is "the roster row existed". For a joined-but-unrostered node it returned `false` and
   `removeNodeSecret` was never called, leaving a valid, indefinitely usable credential behind an
   operator who believed they had revoked it.
4. `PATCH /cluster/nodes/:nodeId` answered 404 for a node that genuinely joined.

The invariant the fix establishes, which is what makes revocation reliable at all: **there is never a
stored node secret without a corresponding roster row.** The roster write goes inside the existing
`withEnrollCodesLease` — never a second lock, per `node-secrets.ts`'s own rule — ordered so the
invariant holds at every crash point. Separately, `disableNode` now attempts secret removal
unconditionally: revoking a credential must not be conditional on roster state, precisely because the
case where the row is missing is the case where revocation matters most. Its return value still means
"the roster row was found", because `DELETE /cluster/nodes/:nodeId` reads it for a 404 — the return
value and the revocation are deliberately decoupled.

**The residual this leaves, stated rather than quietly closed.** A node enrolled BEFORE this fix
already has a stored secret and no roster row, on disk, right now. The unconditional removal above
revokes it — but only if someone knows its node id, and D22 deliberately exports **no list-all
accessor** for `node-secrets.json` (a "list every node's credential" call is an invitation to render
it somewhere it should not be, which is exactly why it does not exist). So an orphaned secret from
before this fix is revocable in principle and not enumerable in practice.

Deliberately NOT fixed with a startup repair. The two candidate repairs are both worse than the
residual: dropping every secret without a roster row would revoke every node that legitimately
joined before the fix — which, pre-fix, is *all* of them — and synthesising a roster row from a
secret would fabricate roster state from a credential, inverting the direction of trust the whole
design rests on. The honest remedy for a real occurrence is to delete `node-secrets.json` and
re-join, since redemption re-mints; that is a documented operator action, not a silent migration.

Measured exposure, 2026-08-23: no cluster state exists on the production hub
(`/var/lib/cezar/.cezar/cluster/` absent) and `CEZ_CLUSTER` is set in none of its environment
files, so nothing here is affected. The feature is flag-gated and its link never worked, so the
realistic population is nodes enrolled by someone experimenting with `cez cluster join` against a
hub whose link could not have replicated anything anyway.

**D26 — The link client bounds a handshake that gets no reply, because nothing else in `dial()`
can.** Found 2026-08-23 while making package 1.5's activation E2E pass, and it is a production
defect, not a test artifact.

Every failure path in `ClusterLinkClient.dial()` is edge-triggered: `unexpected-response` on an HTTP
refusal, `close` on a socket that opens and then dies. Both funnel into `disconnect()` ->
`scheduleReconnect()`, and `ws.on('error', ...)` is deliberately a no-op because an error is always
followed by a close. An upgrade that receives **no reply at all** fires none of the three. The client
then sits in `connecting` **forever** — no error, no close, no retry — and `health()` reads
`connecting`, not `offline`, so no caller can tell a permanently wedged link from a slow one. D15b's
reconnect ladder cannot help: it is only ever entered from `disconnect()`.

This is reachable, and not only at startup. This server's own `attachUpgradeFallback` deliberately
does not destroy a socket whose path it recognizes but whose handler has not registered yet ("the
hang IS the safer error"), which is exactly the window between `startServer` returning and
`startClusterRuntime`'s `await loadNodeIdentity` resolving. A hub that redeploys often reopens that
window on every restart; a spoke that dials into it never returns on its own. The symptom in the
cockpit is the worst kind: a node that is simply, permanently, quietly absent.

**Measured, not reasoned about.** Against a server that listens and registers a silent `upgrade`
listener, a client with no `handshakeTimeout` emitted nothing whatsoever for 900ms and would have
waited indefinitely; with one it emitted `error('Opening handshake has timed out')` then `close`. It
is the `close`, not the error, that reaches `disconnect()`. Note the shape matters: a server that
registers **no** `upgrade` listener does not reproduce this — Node answers through the ordinary
request handler and the client gets `unexpected-response`, a path that already worked. A test built
on that weaker server would pass against the bug.

So `dial()` now passes `handshakeTimeout` (`DEFAULT_LINK_HANDSHAKE_TIMEOUT_MS`, overridable per
client). Regression test: `cluster/link-client-handshake-wedge.test.ts`, which carries the silent-
upgrade server, a negative control on the replying path, and fails
`expected 'connecting' not to be 'connecting'` when the option is removed.

**What this says about the other two link ends.** The same question — "what happens if the peer
simply never answers?" — has not been asked of `ClusterLinkServer`'s read side or of the reconcile
transport's `fetch` calls (which today pass no signal or timeout). Neither is known to be broken;
both are unmeasured. Listed in the open questions rather than assumed fine.

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
  ops.ts               op shapes, derive-from-pending, compaction, outbox flush
  oplog.ts             append/read/compact `.ai/cezar/cluster/ops.ndjson`
  replica.ts           apply a hub replica push over local + pending state (pure)
  link-client.ts       spoke: outbound WS, resume watermarks, backoff
  link-server.ts       hub: /api/v1/cluster/link upgrade + frame routing
  enrollment.ts        code mint/redeem, per-node HMAC secret (0600)
  leases.ts            hub: account + scheduler leases, TTL + renew (claims are not
                       leases any more — the hub's ack IS the stamp, D4/D9a)
  allocate.ts          hub: reserving allocator for scarce ids (spec numbers, D19)
  placement.ts         label matching, queue-with-reason (pure)
  peers.ts             roster + pairings store, presence
  reconcile.ts         periodic full reconcile + `cez cluster reconcile`
  node-auth.ts         D20: sign/verify a node principal on the HTTP family, keyed on
                       enrollment's per-node HMAC secret
  reconcile-transport.ts  D21: RemoteReconcileTransport over the hub's todos routes
packages/cezar/src/server/cluster-routes.ts
packages/contract/src/cluster.ts
packages/web/src/routes/settings/cluster-section.tsx    Phase 1b: the fleet panel + Add node
packages/cezar/src/sources/cezar-hub/provider.ts       Phase 3b: the hub as a source (D8a)
```

Plus one extension rather than a new module: `server-install/platforms/hetzner.ts` gains a
**worker role** (checkouts, CLI logins, cgroup caps, enrollment) alongside the org-cockpit role it
installs today — see Phase 4.

Vertical slice following the `automations` convention — *"not modular; no plugin seam exists"*.

### What is touched in existing code, and how little

- `todos.ts` — `applyHubReplica`, and a `pendingSince` stamp inside the existing lease on every writer
  (`createTodo`, `updateTodo`, `markStarted`, `clearStartedTaskId`, delete) — `markStarted` being
  the one that waits for the hub rather than applying optimistically (D4).
- `todo-autostart.ts` — **two** changes, not one, and it is worth saying so: (a) a guard, start only
  once the hub has acknowledged the claim (a no-op returning `true` when clustering is off); (b) the
  D9a confirm-before-start ordering **on the cluster path only**, leaving the existing
  act-then-stamp path exactly as it is when clustering is off.
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
  pair. What opt-in buys is behavioural — no index, no watcher, no timer, no **live** route (the
  family answers 200-with-`enabled: false` / 409 rather than 404 — corrected 2026-08-22, see
  Verification 12), no nav item, no
  prompt bytes.
- `workspace-runs-routes.ts` — union the remote projection into the workspace runs list.
- `sources/registry.tsx`'s `SOURCE_PROVIDERS` — **one** row (`cezar-hub`). The seam's own docblock
  promises a provider costs one file plus one row, with no contract, route or UI change; this is
  the first outside test of that claim, and if it turns out to cost more, say so rather than
  widening the seam quietly.
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

**Phase 2 — Hub-linearized todos: read replica down, write outbox up. Dispatch and autostart still
cluster-disabled.**
Pairing UI, `pendingSince` stamping inside the existing lease, outbox derivation and compaction,
`applyHubReplica`, resume from `hubSeq`, `cez cluster reconcile [--dry-run]`. This is the phase that
delivers the owner's *"single source of truth, agents pushing to a master, data very up to date"* —
reads stay local and instant, writes are optimistic-then-confirmed, and the hub decides the order. A replicated todo carrying `autostart` is **never** started by
a node that did not create it — asserted as a negative control, not a comment.

The first real job is merging the divergence that already exists, and **it cannot be done by the
merge rule**, because every one of those records predates the clock. The reconcile therefore
classifies rather than resolves:

| class | today | action |
|---|---|---|
| present on one node only | 103 (`cezar`) + 7 (`chat`) | **add**, stamped as authored by the node that has it |
| present on both, identical | 579 (`chat`) + 33 (`cezar`) | stamp both, no change |
| present on both, **differing, neither ever saw the hub** | 10 (`chat`) | **refuse to pick.** List them and ask |

(`aside` 8 and `career-kit` 1 match on counts; they were not diffed by id, so the reconcile must
report them rather than the spec assuming them.)

A disagreement that predates the hub is not a conflict any ordering can settle — there is no
"later", only two values. Auto-picking one would be the most believable wrong answer available, so the tool
prints the pair and takes an explicit choice (`--take-hub` / `--take-spoke` / interactive). Dry-run
first; `todos.json.bak` written on both sides before the first write.

**Phase 3 — Hub-confirmed claims, and the leases that are still leases.**
The **claim** is no longer a lease: the hub applies the claim op and its acknowledgement is the
stamp (D9a as simplified by D4), which is what re-enables autostart for replicated todos, now
exactly-once by construction. What genuinely remains lease-shaped lands here too, because it guards
a resource rather than a record: **agent-account grants**, usage aggregation and cluster-wide limit
holds. Plus the run index projection.

**Phase 3b — Corpus mirror: a worker that cannot read the record cannot do the work.**
Ordered here, immediately before dispatch, because Phase 4 is the first time a node other than the
hub runs an agent, and knowledge-first is rule 1 of `AGENTS.md`. Shipping Phase 4 without this
produces a worker that follows the rule by reading nothing and reports success (D8's correction).

`sources/cezar-hub/provider.ts` plus one row in `SOURCE_PROVIDERS` (D8a): a spoke sweeps the hub's
corpus into a `readOnly` mirror root, tombstones included, `notifyChanged` after every commit so the
index follows with no restart. Then the three things that make it honest rather than merely working:
a **fetch time + hub corpus version** on the mirror, rendered in the node row beside repo drift; a
**dispatch refusal** when the mirror is stale past its bound, naming that reason; and **quarantine
plus `cez kb submit`** so a local write is preserved and visible, and has a correct path to the hub
instead of only a prohibition.

Mirror scope is per node and `reports/` is off by default — 196 files carrying phones and chat ids
have no business on a machine whose premise is that it gets destroyed. The cockpit shows which set
a node holds, so "not found" is never ambiguous between *absent from the record* and *not mirrored
here*.

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

**Coordination lands here too, rungs 2-4 of D19**, because Phase 4 is when two nodes first run
work at the same time: a **hub allocator** for scarce shared identities (spec numbers first —
`next-spec` reserves nothing, and a spoke's uncommitted worktree is invisible to it, so skipping
this makes multi-node *worse* than one machine); **overlap refusal at placement**, where a dispatch
into a project an active run already holds with overlapping paths queues with the other run named
rather than starting and hoping; and `cez cluster active`, a **read** an agent can make over the
`Bash`+`cez` surface it already has. Rung 5, the inbox, is deliberately not in this phase.

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

// .ai/cezar/cluster/ops.ndjson         (derived OUTBOX, compactable; re-derivable from
//                                        records still marked pending — D5)
{ opId, nodeId, ts, scope: 'project'|'workspace',
  projectKey?, entity: 'todo'|'run'|'triage',
  entityId, op: 'upsert'|'tombstone',
  fields?: Record<string, unknown>,     // ONLY what changed (D4: per-field op granularity)
  unknown?: Record<string, unknown> }   // D13: relayed verbatim by an older node

// The hub assigns the order. `hubSeq` is the hub's own monotonic counter, echoed back on
// acknowledgement and carried on every replica push, so a spoke resumes from a number it
// did not invent. No lamport, no node clock — D4 superseded both.
```

Additive on `todoSchema`, all optional — an existing entry with none of them still validates, which
is the same contract every field added since 2026-08-15 has kept:

```ts
pendingSince?:  string                  // set on optimistic local write, cleared on hub ack
pendingFields?: string[]                // WHICH keys are owed — see the amendment below
hubSeq?:        number                  // last hub order this record was confirmed at
tombstone?: { at: string }
placement?: { node?: string; requires?: string[] }
startedOn?:     string                  // nodeId; hub-confirmed only, never optimistic (D4)
```

**AMENDED 2026-08-22 during implementation — `pendingFields` was missing, and without it D4's
central property could not be built.** This list originally carried `pendingSince` alone.
`pendingSince` is a scalar: it says *that* a record is owed to the hub, never *which fields* are.
So a derive-from-records outbox (D5) has nothing to narrow on and can only send the record's whole
content, which is exactly what D4 above forbids:

> *"An op carries only the fields it changed. Two spokes that queued edits to different fields of
> one todo while partitioned both land, because the hub applies them in sequence. Had ops carried
> whole records, the second would clobber the first — same failure the old D4 was written to
> avoid."*

That is not a hypothetical here. The 110-row reconcile this design exists for has **10 disagreeing
`chat` rows, and they disagree on `status` and `archivedAt`** — field-level, on the two fields the
board writes most. Whole-record ops throw one side of every one of those away.

Found by package 2.1, which could not close it from inside its own scope and flagged it rather than
shipping whole-record ops quietly. It was invisible from either side alone: 2.1's tests prove
derivation and compaction are correct, 2.2's prove the hub applies per-field ops correctly, and
both pass while nothing ever *emits* a per-field op. Two suites agreeing with themselves and not
with each other.

`pendingFields` is written **inside the same `O_EXCL` lease as the value**, exactly as
`pendingSince` already is and for the same reason: marker and value cannot disagree, so the outbox
stays re-derivable and a lost `ops.ndjson` tail stays harmless (D5). The failure mode it introduces
is a writer that changes a field without naming it, which then never syncs — silent, so the lease
is not optional bookkeeping, it is the mechanism. Every write path in `todos.ts` that stamps
`pendingSince` must union the keys it touched into `pendingFields` in the same operation, and the
hub's ack clears both together.

Compaction unions field sets, never replaces them: two owed ops for one entity collapse to one op
owing the union of their fields. A tombstone still clears the accumulator (package 2.1's own
property test caught a pre-tombstone value resurrecting through a later upsert, and that fix
stands — a later upsert is a fresh recreation, not a patch onto pre-delete content).

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
                                            code-malformed | code-used | hub-unreachable |
                                            protocol-major   (code-malformed CORRECTED IN
                                            2026-08-22: client-local, never sent by the hub)
DELETE /api/v1/cluster/nodes/:nodeId        hub: revoke
PATCH  /api/v1/cluster/nodes/:nodeId        acceptsDispatch, name  (spoke re-enforces)
GET    /api/v1/cluster/corpus                hub: manifest — { corpusVersion, docs:
                                            [{path, hash, size, mtime}] }, scoped to the
                                            asking node's mirror set (D8a)
GET    /api/v1/cluster/corpus/*path         hub: one document body
POST   /api/v1/cluster/corpus/submit        spoke -> hub: forward a knowledge write
                                            (`cez kb submit`). The ONLY write direction
                                            that exists for the corpus
GET    /api/v1/cluster/todos/:projectKey     hub: a paired project's todos.json snapshot
                                            (D21). Node-authenticated (D20) and scoped to a
                                            CONFIRMED pairing — the one read reconcile has
                                            no rail for. Snapshot, never a subscription
POST   /api/v1/cluster/todos/:projectKey/backup   hub: write todos.json.bak before a
                                            reconcile pass mutates either side (D21)
POST   /api/v1/cluster/todos/:projectKey/append   hub: append rows verbatim, idempotent by
                                            id — the receiving half of reconcile (D21)
GET    /api/v1/cluster/active               in-flight runs across the cluster: todo
                                            summary, node, branch, touched paths.
                                            Backs `cez cluster active` (D19 rung 4)
POST   /api/v1/cluster/allocate/:kind       hub: hand out and RECORD a scarce shared
                                            identity (`spec-number` first). Actually
                                            reserves — unlike `next-spec` (D19 rung 2)
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
→ ops     { scope, projectKey?, ops[] }               spoke -> hub outbox flush
← ack     { scope, projectKey?, throughHubSeq }       hub's assigned order, echoed back
← replica { scope, projectKey?, changes[], hubSeq }   hub -> spoke, the only write-down path
← dispatch{ todoId, projectKey, placement,                        Phase 4
            workflow: { builtinId } | { def },                    D12a: by value, never by name
            expect?: { headSha } }                                D12a: refuse a stale target
→ freshness{ projectKey, headSha, ahead, behind, dirty, merging } asked before every dispatch
→ presence{ capacity: { maxParallel, active, maxHeavySteps, heavyActive,      D14: what the
                        enforcement: 'cgroup' | 'process-tree' | 'none' },    scheduler fills
            hostMetrics, repoDrift[],
            corpus: { version, fetchedAt, scope[], quarantined } }            D8a: stale
                                                                             knowledge has
                                                                             no natural error
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
| **Two agents duplicate or contradict each other's work** — 8 concurrent runs over 4 real repos | D19's ladder, cheapest rung first: hub-confirmed claims, a hub allocator that actually reserves, overlap refusal at placement naming the other run, and a readable `cez cluster active`. Not a chat channel: two LLM agents can agree on something wrong as easily as something right, and every exchange spends the subscription that is already the ceiling |
| **A cross-agent channel becomes an injection surface** — agent-written text lands in another agent's context shaped like instructions | rungs 4-5 carry agent-authored content as **attributed data** ("run `r_123` on `worker-2` reported: …"), never merged into a system prompt, never able to name a tool or widen an allowlist — the discipline `knowledge/prompt.ts` already enforces with `KNOWLEDGE_TAG_RE`, which drops non-matching text entirely rather than truncating it |
| **Double-started run** (the headline hazard) | structurally removed by D4: the hub applies the claim op and its acknowledgement *is* the stamp, so there is no second lease to race and no window between acquiring and stamping. Phase 2 still disables replicated autostart outright; the negative control asserts a node that has not been acknowledged does not start |
| **Shared subscription burned twice** | cluster account grants + shared limit holds (Phase 3); degraded fallback marks the dispatch `unattributed` rather than blocking |
| **Wrong pairing writes a foreign backlog into a repo** | confirm-once pairing, never slug-only *and* never origin-only (a worktree shares its parent's origin — Problem §6); unpaired = replicates nothing; `--dry-run` before the first reconcile; `todos.json.bak` written before the first merge |
| **A dispatched run builds on stale or wedged code** | pre-dispatch freshness report; refuse behind / mid-conflict targets by default, override explicit (D12a) |
| **Lost field edit** | ops carry only the fields they changed and the hub applies them in sequence (D4), with a fixture built from the 10 real conflicting `chat` rows |
| **A queued write is lost with the outbox** — under one writer, a lost intent is a lost write, not a merge that resolves later | the outbox is **derived** from records marked `pendingSince` inside the same `O_EXCL` lease as the value (D5); test 5b deletes `ops.ndjson` outright and asserts the same ops come back |
| **An optimistic value is silently corrected** — the reader sees a number change with no account of why | the hub's applied result replaces it **and flags it as corrected**; test 5a asserts the flag, not just the value |
| **A hub deploy wipes the lease table** — ~10 blue-green restarts/day, each a re-acquire window | leases persisted on the hub; a reconnecting spoke re-asserts what it holds; resume-from-watermark, backoff with full jitter (D15b) |
| **A long free-text field silently replaced** (`summary`, `whatToDo`) | ops are per field, so only the edited field moves — and the losing value stays readable in the outbox/op history for the retention window; the cockpit shows "changed on `<node>`" rather than presenting it as always having been that |
| **An old node truncates the cluster's history** | unknown fields stored and re-emitted (D13); protocol-major mismatch refuses with a stated reason |
| **Op log growth** | compaction to the latest op per entity + bounded retention; a partition older than the window falls back to full snapshot reconcile, never a partial merge that reads as complete |
| **Watcher goes quiet after Mac sleep** | periodic reconcile is the floor, not the watcher (D16); last-successful-reconcile is a rendered health signal |
| **Hub is a single point of failure** | it is one for *coordination*, never for local work (D15). A spoke with no hub is an ordinary cockpit. Stated as a bound, not hidden |
| **Retired Mac corpus resurrected** — a "sync everything" cluster makes the frozen copy live again | D8: one writer, the hub. The mirror is pull-only and the `notion` root is already `readOnly: true` in the live manifest, so no code path writes back; the only write direction is `POST /cluster/corpus/submit` |
| **A worker runs knowledge-blind and says nothing** — `loadKnowledgeSummary` returns `undefined` and the prompt block is simply absent, which reads as "this project has no knowledge" | D8a puts the corpus on the worker's disk, where the agent's `--add-dir` interface can actually reach it; a node reports its mirror scope and freshness on `presence`, and E9 asserts a dispatched run on a fresh worker can quote a corpus document rather than asserting a file exists |
| **A stale mirror answers confidently** — an old corpus returns an older answer, never an error | fetch time + hub corpus version on the mirror, rendered beside repo drift; dispatch refuses past a staleness bound with that reason named (D12a's shape) |
| **PII spread to disposable machines** — `reports/` is 196 files of phones and chat ids | mirror scope is per node, `reports/` and `raw-input/` opt-in and off by default; the cockpit shows which set a node holds so "not found" is never ambiguous |
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

Unit (pure, in `cluster/replica.ts`, `placement.ts`, `ops.ts`) — **rewritten with D4**; the HLC
ordering and per-field-merge tests are gone with the machinery they covered:

1. Hub order is respected: two ops applied in hub sequence produce the sequenced result, and
   replaying them out of order produces the **same** result (the apply is idempotent and
   order-declared, not order-sensitive).
2. Per-field ops: two spokes queue edits to **different** fields of one todo, hub applies both →
   **both survive**. *Negative control:* the same fixture with whole-record ops loses one — assert
   that, so the test cannot pass against the shape it exists to reject.
   **AMENDED 2026-08-22: the ops must come from `deriveTodoOps`, not be hand-built.** As first
   written this was satisfiable — and was satisfied — by a fixture the test author typed, which
   proves the *apply* side and says nothing about whether anything ever emits such an op. It did
   not: `deriveTodoOps` sent whole records, because `pendingSince` alone cannot say which fields
   are owed (see the `pendingFields` amendment in Data Models). So this test and 2.1's derivation
   tests both passed while the property they exist for was absent from the system. Drive this one
   end to end: two real records, each edited on a different field through `todos.ts`'s own write
   path, ops **derived**, applied at the hub in sequence, both edits present. A hand-built fixture
   for the apply side may stay, as its own case, clearly labelled as testing apply in isolation.
3. Tombstone and resurrection: a tombstone applied at a later `hubSeq` wins; an upsert at a later
   `hubSeq` un-tombstones. Both directions, so neither accidental erasure nor accidental
   resurrection can pass.
4. An op carrying an unknown field round-trips through an older reader unchanged (D13).
5. Compaction preserves the applied result exactly for a randomised op sequence (property-style).
5a. **Optimistic write, then contradiction.** A local optimistic value that the hub's applied result
   disagrees with is **replaced and flagged as corrected**, never silently swapped. Assert the flag,
   not just the value — a silent correction is indistinguishable from the write having never
   happened.
5b. **The outbox is re-derivable.** Delete `ops.ndjson` entirely, re-scan, and the same unsent ops
   come back from the records marked `pendingSince`. This is the whole of D5's crash-safety claim
   and it is one test.
6. Placement: unmet `requires` → `queued` with a reason naming the node, and **never** a start.
   - **6b — overlap refusal** (D19 rung 3): dispatching into a project an active run already holds
     with overlapping paths queues and **names the other run**. *Negative controls, both needed:*
     the same project with **non**-overlapping paths **does** dispatch (otherwise the rule is just
     "one run per project", which is not what was asked for), and an overlapping run that has
     **finished** does not block (otherwise the check leaks and the board wedges).
   - **6c — the allocator actually reserves** (D19 rung 2): N concurrent `allocate/spec-number`
     calls return N **distinct** numbers. Assert distinctness across the whole set, not
     pairwise-on-two — the failure mode is a duplicate anywhere in a burst, and two calls is the
     one case a racy implementation usually gets right.
   - **6a** — a project whose `origin` is absent is **never** placed off its holding node, even
     when that node is the most loaded and a remote-less-capable peer is idle. *Negative control:*
     the same fixture with an `origin` present **does** get placed on the peer — otherwise the test
     passes because placement did nothing at all, which is the cheapest way for this assertion to
     be vacuous. And assert the `queuedReason` is the remote-less one, not "at capacity"; a rule
     that reports the wrong reason is a rule the next person deletes as redundant.

Integration (two servers in one vitest process, two `CEZ_HOME` temp dirs, linked over loopback):

7. Convergence on hub order: 200 interleaved writes from both spokes → after the outbox drains,
   **all three nodes hold byte-identical state**, and it equals what the hub applied. Assert against
   the hub's own result, not merely that the two spokes agree — two spokes can agree with each other
   and both be wrong about what the record says.
8. **Partition**: link down → both sides still accept local writes, marked pending → reconnect →
   the outbox drains and no write was refused while the link was down (D15). *Plus the half that is
   easy to omit:* a write made during the partition is visible on the **other** spoke afterwards,
   which is the thing the user actually asked for and which "it converged locally" does not prove.
9. **Exactly-once start**: one `autostart` todo replicated to two nodes → exactly one run.
   *Prove the test fails without the fix* — a regression test written after the diagnosis passes
   against the bug more often than anyone expects. **CORRECTED 2026-08-23: do NOT do this with
   `git stash`, which this line originally instructed.** `~/loki-labs/cezar` is one working tree
   shared by every agent in a fan-out, so `git stash push` takes *everyone's* uncommitted work, not
   the one file you meant — roughly a hundred files across ~20 packages when an agent did exactly
   this on 2026-08-23. A pop that conflicts, or a peer writing during the window, is unrecoverable,
   and `.ai/cezar` is gitignored so part of the state would not be in the stash to restore at all.
   The blast radius, not the intent, is what makes it wrong; the same applies to `git checkout .`,
   `git reset --hard` and `git clean -fd`. Instead: copy the guard's file to a scratchpad, revert
   **only** that file (`git checkout -- <that one path>`, and only if you are its sole writer),
   run, then restore from the copy and verify byte-identical. Or cheaper and always safe: assert
   the guard's own condition directly, so the test cannot pass with the guard removed.
10. **Exactly-once across a lease wipe**: node A claims and starts; delete the hub's lease store and
    restart the hub (simulating a blue-green deploy); node B must **not** start a second run,
    because the replicated `startedTaskId` stamp — not the lease — is the durable key (D9a, D15b).
11. **Stamp-before-start ordering**: kill node A between `markStarted` and `startRun` → the todo is
    stamped and un-started, and no second node picks it up; the failure mode is a *visible pending
    start*, never a duplicate.
12. **Flag off**: with `CEZ_CLUSTER` unset — no timers armed, no file
    created under `~/.cezar/cluster` or `.ai/cezar/cluster`, `capabilities.cluster === false`, the
    Cluster section absent from the settings nav **and** its cockpit route a 404 (the registry's
    `capability` gate drops both, and asserting only the nav would pass against a reachable orphan
    route), and the agent system prompt byte-identical.

    **CORRECTED 2026-08-22 during implementation — the API answers 409, not 404 and not 200.**
    This item said ~~`/api/v1/cluster*` → 404~~ and Architecture's "no route" implied the same. It
    took two wrong answers to get here, and both are worth recording because each was defended with
    a real argument:

    - I first ruled **200 with `enabled: false`**, from `sources.ts`'s documented contract
      (*"every `GET` answers 200 with a schema-valid empty payload and every mutator answers 409 —
      never 404"*). Wrong: that shape exists because the **Sources section is always rendered** and
      needs a body to draw "not configured" with. A cluster that is off has no section, so a 200
      would be inventing a reader.
    - The contract scaffold then argued **404** from exactly that observation. Also wrong, and the
      closest precedent settles it: **automations** is a feature with *no* settings section at all
      when off — the same "no surface, no caller" property — and `server.ts` answers
      `409 AUTOMATIONS_OFF` for **every route of the family**.

    The argument neither of us made, and the one that decides it: **404 already means something
    else in this codebase.** `sources-routes.ts` returns 404 for `UNKNOWN_CONNECTION`. If flag-off
    also 404s, a caller cannot distinguish *clustering is off* from *no such node id* — in a design
    whose whole premise is that a refusal names itself. So: **the family answers `409` with a
    stated reason while `CEZ_CLUSTER` is unset**, the routes stay chained into `AppType`, and
    `capabilities.cluster` (always present, `false` when off) is how the cockpit knows not to ask.

    Consequently `clusterOverviewResponseSchema` carries **no `enabled` field** — with 409 there is
    no served body to put it in, and a field that can only ever read `true` invites a branch that
    never runs. The **cockpit's settings route stays absent** (the registry's `capability` gate
    drops nav and route together); that is a different surface and the orphan-route reasoning above
    is untouched.

13. A node-authenticated link socket **cannot** subscribe to cockpit WS topics, and a
    browser-origin socket **cannot** send `ops`.
14. Hub unreachable at dispatch → a run a person starts by hand still starts, dispatch recorded
    `unattributed`; a **replicated** todo's autostart refuses with a stated reason (D15a). Both
    halves asserted — one without the other is the rule silently collapsing to its neighbour.
15. **Heal-on-read**: a raw agent append (no `id`, no marker) is stamped once, and a second read
    changes nothing (idempotent), and the derived op carries the id the file kept.
16. **Corpus sweep, tombstone half** (D8a): delete a document on the hub → it is tombstoned on the
    spoke. *Negative control:* a document that merely fails to appear in one watermark-filtered
    delta is **not** deleted — that is the exact bug the `sources` sweep's own docblock warns about,
    so the test has to distinguish an explicit tombstone from an absence.
17. **Divergence is quarantined, never overwritten and never merged.** Write a differing body into
    a mirrored path on the spoke, sweep, and assert the local body is **byte-identical** afterwards
    and the path is reported quarantined. Both halves: asserting only "quarantined" passes against
    code that also clobbered the file.
18. **Mirror scope is honoured and legible.** With `reports/` off, no report file exists on the
    spoke **and** the node reports a scope that excludes it. The second assertion is the point —
    without it, "not found" and "not mirrored" are the same observation.
19. **A stale mirror refuses a dispatch, with that reason.** Advance the hub's `corpusVersion`, hold
    the spoke's mirror back past the bound, dispatch → refused, reason names the corpus. *Negative
    control:* a fresh mirror does not refuse, so the test cannot pass against a node that refuses
    everything.

20. **The HTTP family authenticates the node, and says which failure it is** (D20). One case per
    named refusal — no credentials, bad signature, stale/replayed, unknown node — each reaching
    *that* reason and not a neighbour: a test asserting "some 401" cannot tell a forged signature
    from an expired one, which is the whole point of naming them. **The replay case is the one that
    distinguishes D20 from the bearer scheme it supersedes**, so without it the change is
    decorative. Plus a positive floor that asserts the **identity** the middleware established, not
    merely a 200 — a handler that ignores the principal returns 200 too. And the two boundaries:
    with `CEZ_CLUSTER` unset the family still answers 409 with the flag's reason (auth must not
    turn a flag-off refusal into a 401), and a node that has never enrolled — and so holds no
    secret — can still reach whatever route it joins through, proven by a test rather than by
    inspection.
21. **The todos snapshot serves a paired project and refuses an unpaired one** (D21). Both halves:
    an authenticated node with a **confirmed** pairing gets the rows, and the *same* node asking
    for a project it is not paired with is refused — asserting only the happy path passes against
    a route that serves everything to anyone enrolled. *Negative control on the append half:*
    replaying the same append twice adds no duplicate row (idempotent by id), and a row already
    present on the receiving side is skipped rather than rewritten — reconcile never rewrites a
    field, so a test that only counts rows would miss a mutated one. Assert the field values, not
    the count.
22. **`cez cluster reconcile --dry-run` runs end to end and writes nothing** (D21). Against a live
    pair: it classifies, reports counts, and `backupPaths` is **empty** — with the standing warning
    that an empty list must not be read as "nothing to back up". Then the floor that makes it
    meaningful: assert the receiving side's `todos.json` is byte-identical afterwards. A dry run
    that reports correctly and mutated anyway is the failure this catches, and a count assertion
    alone cannot see it.

23. **Every auth-wall exemption is node-authenticated** (D24). The list of exempted paths is derived
    from the single shared definition, not typed into the test, and for EACH one an uncredentialed
    request is refused with one of node-auth's four named reasons rather than reaching a handler.
    *Floor assertion:* the derived list is non-empty and of the expected length — an empty list
    would otherwise satisfy every other assertion and read as "all clear". *Containment half:*
    `/cluster` (roster), `/cluster/enroll` and `/cluster/join` still answer the wall's 401 with
    `CEZ_AUTH` on and no principal. Mutation controls: adding a bogus path to the exempt list, and
    removing one `requireNodeAuth` registration, must each redden this.

    **Path normalisation verified independently, with the attack shape rather than the happy
    path** (2026-08-23, against the installed Hono + `@hono/node-server`, by probing a live server
    and printing what the middleware actually received):

    ```
    /api/v1/cluster/todos/../enroll     -> wall sees "/api/v1/cluster/enroll"
    /api/v1/cluster/todos/%2e%2e/enroll -> wall sees "/api/v1/cluster/enroll"
    /api/v1/cluster/todos?q=1           -> wall sees "/api/v1/cluster/todos"
    /api/v1/cluster/todosomething       -> stays distinct
    ```

    This is the check that matters: the exemption is a prefix test, so the obvious attack is to
    smuggle a cockpit-only path past it as `/cluster/todos/../enroll`. Both the raw and the
    percent-encoded form are resolved by the WHATWG `URL` parser **before** the middleware runs, so
    the smuggled request arrives as `/cluster/enroll`, misses the exempt set, and gets the wall's
    401 — the correct answer. The query string is already excluded, and the `/`-bounded matcher is
    what keeps `/cluster/todosomething` from matching `/cluster/todos` (a bare `startsWith` would
    have admitted it).

24. **A node secret never outlives its roster row, and revoke removes it either way** (D25). Redeem a
    code with the real functions and no mocks: assert `lookupNodeSecret` returns a secret AND the
    roster row exists; `disableNode`; assert `lookupNodeSecret` is now `undefined`. *The negative
    control is mandatory and is the whole point:* this test must FAIL against the pre-fix behaviour.
    A test that passes on both sides is not testing the defect. Also assert a re-join after a revoke
    clears `disabledAt`, so a deliberately re-enrolled node comes back usable.

25. **The edge credential is additive and cannot weaken node auth** (D23). Three halves. *No-op:*
    with no edge variables set, the dial headers and the fetch headers are EXACTLY what they are
    today — this is the backward-compatibility guarantee for installed users and the most important
    assertion in the group. *Precedence:* on a key collision the three node-auth headers win, so an
    edge credential can never overwrite the node principal. *Fail-closed:* exactly one of the two
    variables set is a named, visible error, never a silent fallback to unauthenticated — the
    alternative symptom is a 403 reconnect loop with no explanation. Plus: the secret never appears
    in anything emitted, mutation-checked so the assertion cannot pass vacuously.

26. **Presence is a statement about now, and the disposer really disposes.** Two negative controls
    on the spoke heartbeat that a "does not throw" test cannot give: after disposing, advance the
    clock a long way and assert the send count did not move (an empty disposer passes the naive
    test); and across an offline stretch, assert exactly ONE beat is sent on reconnect, not a
    backlog — a replayed stale beat would let a sleeping machine's old capacity claim arrive as
    current, which is exactly what `markNodeSeen`'s `capacityAt` stamp exists to prevent.

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
  fetch failure). **A fourth path, added 2026-08-22 during implementation: paste a mangled code**
  (drop a character) → `code-malformed`, **not** `hub-unreachable`. It was written as
  `hub-unreachable` on the argument that the two read alike to an operator; they do not act alike.
  `joinCluster` parses the code before it opens a socket, so nothing about DNS, the tunnel or
  Access was ever tested — the unit test for that branch asserts `fetch` was never called and then
  asserted the hub was unreachable. It is also the only enrollment failure the person reading the
  screen can fix without anyone else, which is the rule the enum now splits members on: two values
  when the operator's next move differs, one when it does not (a hub answering HTTP 500 stays
  `hub-unreachable`, because retry-or-call-the-hub-owner is the same move as a hub that is down).
  Finally revoke an unredeemed code from the UI and confirm it cannot be redeemed.
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
- **E5d** Knowledge on a worker, end to end and asserted at the **agent's** level, not the file
  system's: provision a fresh worker, dispatch a task whose prompt requires a fact that exists only
  in the corpus, and assert the agent **quotes it**. Asserting "the files are on disk" is the
  vacuous version — the whole failure this guards against is files present but never granted
  (`--add-dir`) or never indexed, which leaves the prompt block silently absent. Then the negative
  control that makes it mean something: run the same task on a node with the mirror **disabled**
  and confirm it visibly cannot answer, rather than inventing an answer.
- **E6** Account grants: dispatch from both nodes at once → the hub's account panel shows one
  coherent utilisation, and a limit hold observed on one node parks the other.
- **E7** Sleep/resume: close the Mac for an hour with pending ops on both sides; on wake, drain and converge
  with no manual step, and confirm the periodic reconcile — not the watcher — is what recovered it
  (kill the watcher first).
- **E8** Revoke the Mac from the hub → its ops are refused and its credential is gone; re-enroll.

### Analytics

Events named while designing, per the workspace rule: `cluster.node_enrolled`,
`cluster.link_up` / `link_down` (with duration), `cluster.ops_applied` (count, scope, lag ms),
`cluster.conflict_resolved` (entity, field, winner node), `cluster.lease_granted` / `denied`,
`cluster.dispatch_placed` (node, labels, queue wait), `cluster.dispatch_refused_overlap` (the other
run's id — a rising count is the signal that the backlog is being sliced too finely, not that the
guard is noisy), `cluster.identity_allocated` (kind), `cluster.reconcile_completed`
(adds/updates/conflicts, duration), and for Phase 1b `cluster.code_minted` /
`cluster.code_redeemed` / `cluster.code_expired_unused` (the three together answer "did the
one-liner actually work for people", which a mint count alone cannot) plus
`cluster.corpus_swept` (docs changed, tombstoned, bytes, duration, resulting `corpusVersion`),
`cluster.corpus_quarantined` (path — a non-zero count means something on a node is writing into a
read-only mirror, which is a finding, not a metric), `cluster.dispatch_refused_stale_corpus`, and
`cluster.join_failed` **carrying the named reason** — an access rejection and a stale code have
different fixes and must not aggregate into one number. No analytics sink exists in this repo today — stated, not
invented; these are the names to use when one lands.

## What remains, and what it takes to get this Mac running work

> **HANDOFF STATE — updated 2026-08-23, written to survive a session change.**
> Read this block first; it is the current truth and is kept current after every action.
>
> ### THE BLOCKER — found AND FIXED 2026-08-23 (`cez cluster init`)
>
> **FIXED. Read the diagnosis below for why it mattered; the fix is at the end of this block.**
>
> **No production code path could mint a HUB identity, so `prod-host` could never activate as
> a hub.** Verified by hand, not inferred:
> - `ensureNodeIdentity({ role: 'hub' })` appears **only in test files** across all of
>   `packages/cezar/src`. Checked with `grep -a` (four `.ts` files in this repo misclassify as
>   binary, so a plain grep would under-report).
> - The one production `ensureNodeIdentity` call is `enrollment.ts:539`, inside `joinCluster`, and
>   it mints `role: 'spoke'`.
> - `createEnrollmentCode` (`enrollment.ts:299`) writes only a code record. It never touches node
>   identity.
> - `cez cluster` has exactly five subcommands — `enroll`, `join`, `active`, `reconcile`, `revoke`.
>   There is **no `init`**.
> - `startClusterRuntime` refuses to arm without an identity on disk (deliberately: it warns and
>   arms nothing rather than guessing).
>
> So the real sequence on the box is: set `CEZ_CLUSTER=1`, restart, get a "no cluster identity"
> warning, arm nothing; run `cez cluster enroll`, get a code, still no hub identity; the link server
> never attaches, so no spoke can connect with that code anyway.
>
> **Why every test passes anyway:** the activation E2E calls `ensureNodeIdentity({role:'hub'})`
> directly, which is something no shipped code does. A green loopback round trip is therefore NOT
> evidence that a real hub can start. This is the same shape as D24 — a suite that is entirely
> correct about a path production cannot reach.
>
> **THE FIX, landed 2026-08-23: `cez cluster init`.** A sixth subcommand alongside
> `enroll`/`join`/`active`/`reconcile`/`revoke`, in `index.ts`. It calls
> `ensureNodeIdentity({ role: 'hub' })` and prints the node id and the identity path.
>
> - **Idempotent** — `ensureNodeIdentity` reuses an existing `nodeId`, so a re-run reports
>   `already a hub` with the same id rather than minting a second one.
> - **Refuses a role change** — a node already joined as a spoke holds its hub's URL and a secret
>   that hub knows it by; silently overwriting the role strands both sides. It tells the operator to
>   `cez cluster revoke --self` first.
> - **Deliberately NOT self-minting in `startClusterRuntime`.** Arming a hub identity as a side
>   effect of a process restart is how two boxes quietly become two hubs with no shared roster.
>   Becoming a hub is a decision made once, which is exactly the idiom `enroll`/`join` already use.
>
> **Verified against the built binary, not just typechecked** (fresh `CEZ_HOME`, `CEZ_CLUSTER=1`):
> 1. `cluster init` -> `hub identity created: 191046e2-…`, `cluster/node.json` written.
> 2. re-run -> `already a hub: 191046e2-…`, same id.
> 3. `cluster enroll` -> mints a real join code. **This is the step that returned nothing usable
>    before**, and is the whole point of the fix.
>
> Note the whole `cez cluster` family is gated on `CEZ_CLUSTER=1`; without it every subcommand
> (including `init`) exits with "clustering is off".
>
> **One operational trap the test surfaced:** the join code EMBEDS the hub URL, from
> `clusterHubUrl()` — `CEZ_CLUSTER_HUB` / `CEZ_COCKPIT_URL` if set, else the installed server's
> `domain` as `https://<domain>`, else `http://127.0.0.1:<port>`. A code minted where none of those
> resolve to a publicly reachable name carries **loopback**, and the Mac cannot join with it. On the
> box, confirm the code says `https://cockpit.example.com` before pasting it anywhere — do not
> assume it.
>
> ### Committed and pushed — where to pick this up
>
> **Branch: `feat/multi-node-cluster`, NOT `main`.** This surprised this session and will surprise
> the next one: the session began reporting `main`, but the work is on a feature branch, and local
> `main` (`adeaa759`) is 12 commits behind `origin/main` and carries none of this. `git push origin
> main` therefore fails with "remote contains work that you do not have" — that is the local `main`
> being stale, not a problem with the work.
>
> - `9638d5c1` — the session's work, one commit.
> - `3f00d234` — merge of `origin/main` (6 commits, the codex-resume-explicit-model work). Clean, no
>   conflicts, though it did touch `server/server.ts`, which this branch also changes.
> - Pushed to **`origin/feat/multi-node-cluster`**. Never pushed to `upstream`, and never should be.
> - Not merged to `main`, and no PR opened — that is the owner's call.
>
> ### The deploy path — why merging to `main` is a HARD prerequisite for any E2E
>
> Measured on the box 2026-08-23. `/opt/cezar` is a symlink into `/opt/cezar-releases/`, named
> `<timestamp>-<commit>`; it read `20260823T083733Z-84fb8237` — i.e. the box was running
> `origin/main`'s merge commit, deployed the same morning. `cezar.service` runs
> `/opt/cezar/packages/cezar/dist/index.js serve` as `User=cezar` with
> `WorkingDirectory=/var/lib/cezar/workspace`.
>
> **The box tracks `main`, and agents on it self-deploy several times a day.** So nothing on
> `feat/multi-node-cluster` can reach production — `cez cluster init` included — until that branch
> is merged to `main`. Sequence it in this order, because each step is useless without the one
> before:
>
> 1. Merge `feat/multi-node-cluster` -> `main` (owner's call; this repo visibly uses PRs).
> 2. Let the box deploy, or deploy it, and confirm `/opt/cezar` points at a release whose commit
>    contains the cluster work. **Check the symlink target, not the branch** — the release dir names
>    the commit, and `dist` mtime is BUILD time, not deploy time.
> 3. `cez cluster init` on the box, then `CEZ_CLUSTER=1` in the service env, then restart.
> 4. Confirm the join code carries `https://cockpit.example.com` and not loopback.
> 5. Only then does the Access service-token policy matter, and only then can the Mac join.
>
> ### Where the code stands
>
> Landed and green this session: hub-router, spoke-runtime, edge-auth (D23), the auth-wall seam
> (D24), enrollment roster row (D25), reconcile-wiring, the CLI entry guard, relay affordance fixes
> (`spoolDir` + widened `LOCAL_PATH_RE` + producer-side `name`/`url` projection in `run.ts`), the
> link activation wiring, and the handshake-wedge fix (D26).
>
> **Nothing is committed yet.** 28 files dirty, 13 untracked. Commit message drafted at
> `<scratchpad>/commitmsg.txt`.
>
> ### Gate status — run gates on the BOX, never the Mac
>
> The Mac sits at load ~10 and produces timing flakes (`workspace-parallel`, `cluster-flag-off`
> both flake there and both pass on the box). Method:
> `git ls-files -co --exclude-standard` -> `rsync --files-from` to `/var/lib/cezar/gate-cluster/`
> on `prod-host` -> `npm ci` -> `git init && commit` (required: `build:stamp` runs
> `git rev-parse HEAD`) -> gates with `CEZ_VITEST_MAX_WORKERS=3`.
>
> **Verify the trees match before trusting a result.** This bit twice in one session: a file list
> can be identical while contents differ. Compare a manifest —
> `md5 -q $(cat files) | sort | md5 -q` on the Mac against
> `md5sum $(cat files) | cut -d' ' -f1 | sort | md5sum` on the box.
>
> **Result on a proven-identical PRE-MERGE tree (commit `9638d5c1`): 579 test files passed, 1
> failed, 1 skipped of 581.** The single failure is C18 — a CPU budget calibrated on an M4 Max that
> fails identically at pristine HEAD. That IS the green result here. Ownership audit: 0 files not
> owned by `cezar`.
>
> **The MERGED tree (`3f00d234`) was then gated too, and is green: 581 test files passed, 1 failed,
> 2 skipped of 584** — the one failure again C18. typecheck 0, build 0, `test:unit` 0,
> `test:package` 0. So the merge of `origin/main` is safe; this was worth running rather than
> assuming, since a clean textual merge has previously taken this repo from 559/560 to 12 failures
> in files the merge never touched.
>
> Also not covered by that run: `cez cluster init` was added after it. Covered instead by typecheck,
> a real build, its three CLI test files (17/17), and a functional test against the built binary.
>
> ### Standing constraints that are easy to get wrong
>
> - Push to **`origin` only, never `upstream`**. Never a bare `git push`.
> - Shared checkout: **no `git stash`, `git checkout .`, `git reset --hard`, `git clean`** — other
>   sessions have uncommitted work here. Compare against HEAD with `git show HEAD:<path>`.
> - Write the box's corpus as `cezar`, never root. End any box session with
>   `find /var/lib/cezar -not -user cezar | wc -l` (must be 0).
> - cezar is **published with real users** (`@loki-labs/better-cezar` v0.10.0) — normal backward
>   compatibility applies. The pre-launch waiver is scoped to `chat/` only.
> - There is no lint or prettier config in this repo. `prettier --check` fails on untouched HEAD
>   files; house style is hand-maintained single quotes.


**Written 2026-08-23, after the session that landed D23/D24/D25 and the link.** Everything below was
verified against the tree rather than recalled — every symbol named here was confirmed to exist at
the path given, and every "no production caller" claim was measured as described below rather than
remembered.

### The state to hold in your head

Almost every cluster module is **built and unit-tested in isolation, and connected to nothing.**
That is not a criticism of the work — it is the shape the plan chose, so twenty packages could land
in parallel without fighting over one file. But it means "the module exists and its tests are green"
says nothing about whether the feature runs, and the last three defects found (D23, D24, D25) were
all in the seams *between* modules, invisible from inside any of them.

Milestone A changed that for the LINK itself — `hub-router` and `spoke-runtime` now have real
callers. Nothing below does. Measured 2026-08-23 **after** activation landed, counting every
non-test mention and then reading each one: production call sites outside the symbol's own module,
where a docblock mention and a same-module self-call are not callers.

| symbol | module | production callers |
|---|---|---|
| `placeRun` | `cluster/placement.ts` | **0** |
| `eligibleCandidates` | `cluster/placement.ts` | **0** — one hit, `placeRun` in the same file |
| `buildDispatch` | `cluster/dispatch.ts` | **0** |
| `offerDispatch` | `cluster/dispatch.ts` | **0** — one hit, its own docblock |
| `applyReplicaFrame` | `cluster/replica.ts` | **0** — one hit, a comment in `spoke-runtime.ts:20` |
| `startRelay`, `relayTail` | `cluster/relay.ts` | **0** — all hits are its own module docblock |
| `watchRunProjection` | `cluster/run-projection.ts` | **0** — one hit, a self re-arm at `:110` |

### Milestone A — a LINKED node. *Landed 2026-08-23; unverified against a real second machine.*

A node that enrolls, connects, and is visible: its heartbeat, capacity and repo drift reach the hub
and the roster shows it. **This does not replicate state and does not run work.**

- `cluster/hub-router.ts` — `hello`→`welcome`, `presence`→`markNodeSeen`. Built, 11 tests.
- `cluster/spoke-runtime.ts` — presence heartbeat, dispatch decline, downlink handling. Built.
- `cluster/edge-auth.ts` + both transports — D23. Built.
- The auth-wall seam — D24. Built.
- Enrollment writes the roster row — D25. Built.
- **Activation** — landed. `startClusterRuntime` now takes a **required** `server:
  UpgradeCapableServer` and is called from `server/server.ts` (~7324) rather than `createApp`,
  because `ClusterLinkServer.attach()` needs a real listening server. It constructs
  `ClusterLinkServer` + `createHubFrameRouter` on a hub (`cluster-routes.ts` ~976) and
  `ClusterLinkClient` + `startSpokeRuntime` on a spoke (~1005). The `server` field is deliberately
  non-optional: an optional one lets a caller forget it and get a hub that boots looking healthy and
  is silently unreachable — the same failure shape as D23/D24/D25.

### Milestone B — REPLICATED state. *Not built.*

The ops chain. Nothing in it is connected, though several pieces exist:

| piece | where | status |
|---|---|---|
| derive ops from local todo writes | `cluster/ops.ts#deriveTodoOps` | exists |
| pack them into a frame | `cluster/ops.ts#packOpsFrame` | exists |
| the outbox itself | `todos.ts` `pendingSince`/`pendingFields` | **derived, never flushed** — no loop sends it |
| hub applies an ops frame | `cluster/hub-router.ts` `ops` case | **warns and returns `[]`** |
| hub oplog append | `cluster/oplog.ts#appendOps` | exists, no caller |
| **`hubSeq` allocation** | — | **does not exist anywhere** |
| hub emits `ack` | — | **not built** (deliberately: never fake an ack) |
| spoke applies an ack | `todos.ts` (~908–939) | **exists already** |
| hub fans out `replica` | — | **not built** |
| spoke applies `replica` | `cluster/replica.ts#applyReplicaFrame` | exists, **zero callers** |

The genuinely missing designs, as opposed to missing wiring, are: **`hubSeq` allocation and
persistence** (a monotonic per-scope counter that survives a hub restart — the hub blue-green
deploys ~10×/day, so an in-memory counter is not an option), **per-node watermark tracking** so
`welcome.resumeFrom` can stop being `[]`, and **outbox flush scheduling** (when to send, how to
bound a burst, what to do when the link is down mid-flush).

Note the ordering constraint that makes this harder than a queue: **D9a requires the claim op to be
confirmed before the run starts.** A cross-node duplicate is two agents on two machines spending one
subscription twice, so the claim is the one write that never applies optimistically. That path has
to exist before dispatch is safe.

### Milestone C — a WORKER that runs dispatched work. *Not built. This is the one the question is about.*

**"Linked" and "worker" are different milestones, and Milestone A is not most of the way to C.**
Today `spoke-runtime.ts` explicitly *declines* every dispatch — truthfully, with a real
repo-freshness reading, which is the honest placeholder rather than the feature.

To run one real task on this Mac, dispatched from the VPS hub:

1. **Hub-side placement.** `placeRun`/`eligibleCandidates`/`headroom` are pure and complete; nothing
   calls them. Needs a caller that picks a node when a run starts and decides hub-local vs remote.
2. **Hub emits `dispatch`.** `buildDispatch` exists; the hub has no code that sends the frame.
3. **Spoke accepts instead of declining.** `offerDispatch` and `dispatchRefusalReason` exist and are
   the acceptance logic; `spoke-runtime.ts`'s decline path is where they slot in. `mayStartWithoutHub`
   and `isCorpusStale` already encode when a node may proceed.
4. **The spoke actually runs it** — worktree creation, the run pipeline, the broker. This is the
   largest single item and touches `workflows/run.ts`, the second-largest file in the package at
   6,545 lines (only `server/server.ts` is bigger, at 7,527).
5. **The claim path (Milestone B) must exist first**, or two nodes can start the same todo.
6. **Foreign-run visibility**, or you cannot see what your Mac is doing: `run-projection.ts` (0
   callers) plus relay, below.
7. **Corpus freshness (D8a)** — a node with a stale mirror must refuse rather than run against old
   knowledge. Routes exist and are node-authenticated; the sweep is partial.

**Honest estimate of order:** C is larger than A and B combined, and 4 is most of it.

**Implementation detail for step 4, surveyed 2026-08-23 so the next session need not re-derive it.**
The spoke does not need new run machinery — it needs to call the existing entry point with a
faithfully translated input:

- **The entry point is `RunManager.startRun(workflow, input)`** (`workflows/run.ts:1339`), taking
  `StartRunInput extends ExecuteRunInput & { author: TaskAuthor }`. `startVariants` (`:1428`) is the
  fan-out sibling. `RunManager` also already owns `cancel`, `isActive`, `finish`, `continueRun` and
  `recordTurnEnd` — the whole lifecycle a dispatched run needs to report on.
- **What `dispatch` actually carries** (`clusterDispatchFrameSchema`): `dispatchId`, `todoId`,
  `projectKey`, `placement`, `workflow`, optional `expect: { headSha }`, optional `override`.
  Deliberately **no path, no worktree, no session and no handoff target** — the schema's own doc
  forbids adding one, because a foreign run must never request "open in terminal" on someone
  else's host. So the spoke resolves every local affordance itself; none may arrive over the wire.
- **The gap is a translation, not a new pipeline**: `todoId` + `projectKey` -> the local todo record
  (which is why **Milestone B has to land first** — without replication the spoke may not hold that
  row at all) -> a `StartRunInput` with `author` set to something that marks it dispatched, not
  locally authored.
- **`expect.headSha` is a refusal gate, not advice** (D12a): the target re-checks its own HEAD and
  refuses if behind or mid-conflict, **naming which**. The default is refusal; `override` is set
  only by a human, never by the scheduler. `dispatch.ts#isCorpusStale` and `mayStartWithoutHub`
  already encode the sibling conditions.
- **Report back on the `freshness` frame**, which is also where a refusal rides — the contract keeps
  exactly ten frames and folds "cannot take work" into the same frame that answers "can you take
  work". `spoke-runtime.ts` already sends this correctly for its decline path; accepting is the same
  code with a different verdict.

### Milestone D — WATCHING a foreign run. *Not built.*

`startRelay`/`relayTail` exist with 0 callers. Needs the cockpit run view to drive the 0→1/1→0
subscription, the hub to send `relay-request` downlink, and the spoke to answer with `relay` uplink
(`hub-router.ts` currently warns on both). **Two real defects were found here 2026-08-23 and fixed
before any of it ships** — see the D9 note above on `spoolDir` and the image-event spread.

### The ops work, which is not code

1. **Cloudflare Access must admit a machine.** The existing service token is scoped to the SSH
   application and answers **302** against the cockpit hostname — verified, with and without it. A
   service-token policy has to be added and its credential given to the spoke as
   `CEZ_CLUSTER_ACCESS_CLIENT_ID` / `_SECRET`.
2. **`CEZ_CLUSTER=1` on the hub.** Verified absent from every file in `/etc/cezar/` today, and there
   is no `/var/lib/cezar/.cezar/cluster/` — the hub has never run with clustering on.
3. **Deploy the build carrying all of the above**, then `cez cluster enroll` on the hub and
   `cez cluster join <code>` on the Mac.
4. **Remember the env asymmetry** (D23): `..._CLIENT_SECRET` matches `SECRET_NAME_RE` and is stripped
   from every agent child env, while `..._CLIENT_ID` is not — so an agent sees half a credential and
   hits `edge-auth.ts`'s fail-closed named error. For an agent to run a cluster command the secret
   must ALSO be named in `CEZ_ENV_PASSTHROUGH`. Verified on the box 2026-08-23, that file today reads:

   ```
   CEZ_ENV_PASSTHROUGH=OP_SERVICE_ACCOUNT_TOKEN,CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID
   ```

   `CEZ_CLUSTER_ACCESS_CLIENT_SECRET` has to be appended to it. Note this is only needed for an
   AGENT to run cluster commands; the cezar server itself reads the service env directly and needs
   only step 2.

### Known open questions, carried rather than closed

- **May the periodic reconcile write unattended? — the CONTRADICTION is resolved; the DECISION is
  still the owner's.** Measured 2026-08-23: `startPeriodicReconcile` has **zero production callers**
  (two references outside its own tests — its definition, and a note in `server/cluster-routes.ts`
  recording that activation deliberately does not arm it), and `dryRun` is a required option with no
  default. So the docblock's "in production, a non-dry-run `reconcileAll`" was describing a caller
  that does not exist — an intent written in the present tense, which a reader would fairly take
  either as "a non-dry-run pass is already running" or as "arming one non-dry-run is just
  implementing the documented design". Neither is true. The docblock is now corrected in place, with
  the original kept below it.
  **What is still open:** whether the first real caller runs dry or not. The wiring exists
  (`cluster/reconcile-wiring.ts`), so this is a decision, not work. The divergence in play is ~110
  one-side-only rows — exactly the class a non-dry-run pass merges — so it stays owner-gated.
  Whoever arms it must correct that docblock again to say which way it went.
- **`authFailureId` / `provider`** in `server/provider-auth-runtime.ts` — classified `safe` in the
  relay inventory, but a cross-node retry-proxy risk could not be ruled out. Worth a second look
  before relay ships.
- **Orphaned secrets** predating D25 are revocable but not enumerable — see D25's residual note.
- **Does either other link end hang the same way D26 did?** `ClusterLinkServer`'s read side and the
  reconcile transport's `fetch` calls carry no timeout or abort signal today. Neither is known to be
  broken; both are simply unmeasured, and D26 is the reason to stop assuming. The cheap check is the
  one that found D26: stand up a peer that accepts the connection and then says nothing at all.

## Non-goals

Not HA and not failover — the hub is a coordination SPOF by design (D15 bounds the damage). Not
multi-tenant. Not a live-run migration. Not a second code-sync mechanism — git remains it. Not a
cluster-wide `maxParallel` (D14). **Not *replication* of the KB corpus** — corrected 2026-08-22
from a flat "not the KB corpus": spokes do get a **pull-only read mirror** (D8a), because an agent
reads knowledge as files on its own disk. What stays out of scope is the bidirectional half: no
spoke ever writes into the record, which is the property the 2026-08-19 cutover bought and the one
this design refuses to spend.

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
7. **What does a worker's mirror include by default?** The spec proposes `knowledge/`, `domains/`,
   `changelog/`, `tasks/` on, `reports/` and `raw-input/` off — reports carry phones and chat ids.
   The cost of being wrong is asymmetric: too narrow means an agent occasionally cannot see a
   report it needed and says so; too wide means PII on a rebuilt-at-will VPS. Confirm the default,
   or say reports should be mirrored and accept that.
8. **Does this go upstream?** `open-mercato/cezar` is never pushed to, but this is a general
   feature. If it should stay fork-private, say so before Phase 1 — it changes nothing technically
   and everything about how the flags are documented.
