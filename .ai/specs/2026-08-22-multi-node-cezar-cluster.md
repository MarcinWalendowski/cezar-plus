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
> **THIS BLOCK IS ~1,000 LINES. THE NEXT 40 ARE THE ONES YOU MUST READ; the rest is the record of
> WHY, and is there to be searched, not read start to finish.** If you read only this summary you
> will know what to do next and what not to touch. (Added 2026-08-23 after the block tripled in one
> day — a handoff nobody can finish reading is not a handoff.)
>
> ### D43 — ~~SETTING `CEZ_CLUSTER=1` STARTS THE SAME TODO FOREVER~~ — FIXED 2026-08-23, THE WAY IT WAS ASKED FOR
>
> **FIXED, verified in-source.** `todo-autostart.ts:78` is now `cluster: TodoAutostartCluster | typeof
> CLUSTERING_OFF` — **required, not optional** — so a caller that forgets it is a TYPE ERROR rather
> than a silently disarmed guard, and `server.ts:1622` passes `CLUSTERING_OFF` explicitly. That is the
> right half of the fix and only that half: the D9a gate was **not** made live unilaterally, which
> remains an owner decision (see D41). `grep CLUSTERING_OFF` now enumerates every place clustering is
> switched off. Typecheck EXIT=0; full box gate green apart from the standing C18 red.
>
> **The rule this proves, and the reason it is kept at the top rather than deleted:** *generate the
> wiring or make the field required; never document that a caller ought to set it.* This branch
> produced that same failure three times (D24, D43, and the `readTodosFor` near-miss) before the fix
> changed the type instead of the docs. Original diagnosis kept below, unchanged.
>
> **Latent, not armed — verified 2026-08-23: `CEZ_CLUSTER` is absent from `/etc/cezar/`, from the
> systemd unit and dropins, and from the live server process env on `prod-host`.** So nothing
> is looping today, and merging PR #9 alone does not start it. **But the day someone sets that flag,
> one node — no peer, no hub, no cluster — creates unbounded duplicate runs.**
>
> Measured, three passes of `reconcileAutostartTodos` with a fake RunManager:
> ```
> CEZ_CLUSTER=1     -> ["run-1"], ["run-1","run-2"], ["run-1","run-2","run-3"]
>                      todos.json unchanged: {"autostart": true}     <- never stamped
> CEZ_CLUSTER unset -> ["run-1"], ["run-1"], ["run-1"]
>                      todos.json: {"startedTaskId": "run-1"}        <- stamped, autostart cleared
> ```
>
> **Chain, every link verified in-source:**
> 1. `server.ts:1601` builds `TodoAutostartProject` as `{ repoRoot, dataDir, manager }` and **never
>    sets `cluster`**. On `todo-autostart.ts:58` that field is `cluster?:` — optional — and its own
>    docblock says *"Absent means clustering is off, and that is the whole of the switch."* So the
>    entire D9a autostart gate (`claimStart`, `mayStartWithoutHub`, the `startedOn` checks) is **dead
>    code**, and `mayAutostartTodo` allows on its first line.
> 2. `todos.ts` meanwhile reads clustering from **`process.env`**. One concept, two sources, and they
>    disagree. `todo-autostart.ts:52` claims *"server.ts is the single place that decides, from
>    `clusterModeFromEnv`"* — **that wiring does not exist.**
> 3. So the run starts. Then `markStarted` refuses `hub-unconfirmed` (env says clustered,
>    `confirmStart` has no production implementation at all) and **writes nothing**.
> 4. `reconcileAutostartTodosOnce:284` is `if (!todo.autostart || todo.startedTaskId) continue;`.
>    The refusal withheld the very stamp that line keys on, so both conditions survive and the next
>    pass starts it again. `todo-autostart.ts:132` calls `startedTaskId` *"the durable key"* — it is
>    exactly what the refusal withholds. Every `todos.json` write and every context rebuild fires
>    another pass, and `server.ts:4794` treats the same `false` as harmless bookkeeping
>    (*"The run has already been created by the time we get here"*).
>
> **The general shape, which is why this went unseen:** a guard whose activation is a field the
> caller must remember to pass is off by default, silently, and its own tests pass because they
> construct the object WITH the field. Nothing fails; the feature is simply absent. Compare D24 and
> the `readTodosFor` near-miss the same day — this branch has now produced this failure three times.
> **Generate the wiring or make the field required; do not document that a caller ought to set it.**
>
> Probes: `<scratchpad>/probe-autostart-loop.mts`, `probe-autostart-control.mts`, `probe-markstarted.mts`.
>
> ### D44 — D38 REMOVED THE ONLY ANTI-ENTROPY PASS THE CLUSTER HAD, AND IT WAS ACCIDENTAL
>
> **CORRECTED 2026-08-23, within the hour, before anyone was assigned.** This entry first led with
> D29's oversized-op exclusion, on the reporting agent's diagnosis, and concluded the fix belonged in
> `replica-fanout.ts`. **That framing was wrong and the assignment would have been wasted work.**
> `replica-fanout.ts`'s own docblock is explicit that an excluded op *"will never become representable
> by waiting (its size does not change)"* — and `replay.ts:160` ships each record at its own stored
> `hubSeq`, so a replayed oversized record hits the identical exclusion. **Replay never repaired the
> oversize case, so D38 cannot have broken that repair.** Capping a frame's `hubSeq` below an excluded
> op would re-introduce D29's permanent per-target stall to fix a gap that was already permanent, and
> permanent *by an explicit, reasoned decision* recorded in that file. Original text kept below.
>
> **What is actually true, every link verified in source:**
>
> 1. `spoke-runtime.ts:621` — `state.appliedThroughHubSeq = Math.max(result.appliedThroughHubSeq,
>    preview.appliedThroughHubSeq)`, and `preview` comes from `applyReplicaFrame`, which is
>    `max(applyReplica(...), frame.hubSeq)` (`replica.ts:149`). So `preview >= frame.hubSeq`
>    **unconditionally**: the on-disk apply result can never hold the watermark back. Whatever the
>    frame DECLARES becomes the spoke's position, independent of what actually landed. (The throw path
>    is handled correctly — it returns early without advancing. This is about a write that *reports
>    success*.)
> 2. `replay.ts:160` + `planReplicaFanout`'s watermark filter — replay can only ship records whose
>    stored `hubSeq` is ABOVE the target's watermark. Anything below it is unreachable by replay.
> 3. `hub-router.ts:325` — delete-then-seed on hello. **Pre-D38 `sendHello` hardcoded `watermarks: []`,
>    so the hub deleted the node's watermarks and re-seeded from nothing: every reconnect replayed the
>    entire scope from zero.**
>
> **That full-scope replay was a blanket anti-entropy pass, and nothing in the design named it as one.**
> It healed ANY divergence below the watermark from ANY cause — including causes nobody has enumerated.
> The one this repo has already SEEN is the relevant one: a `todos.json` write that vanished silently
> under a correctly-taken `O_EXCL` lease, no error raised, nothing in either `.bak`. Against a
> success-reporting write that did not durably land, step 1 advances the watermark anyway and step 2
> then makes the record permanently unreachable. Pre-D38 the next reconnect fixed it and no one noticed.
>
> **D38 is correct and must not be reverted.** Reporting the position the runtime holds is right, and
> the hub trusting it is right. The defect is that **repair was a side effect of the hub FORGETTING**,
> and D38 correctly stopped the hub forgetting. The `hub-router.ts:325` comment even predicted this in
> its own words — *"gets more precise if it does"* — without noticing that precision here means the hub
> now believes an assertion the spoke cannot vouch for.
>
> **OWNER DECISION — repair has to become deliberate, and it is a design choice, not a one-file fix.**
> The options, with the trade-off each answers:
>  - **(a) Digest-at-hello.** `hello` carries a per-project content digest; the hub compares it against
>    its own and replays the full scope from zero on mismatch, ignoring the watermark. Restores the
>    blanket property, keeps D38's cheap steady state, and is the only option that catches a cause
>    nobody has enumerated. Costs a digest on both sides and a contract change.
>  - **(b) Periodic full replay**, on a slow timer, independent of reconnect. Simplest; wastes bandwidth
>    proportional to scope size and repairs only as fast as the period.
>  - **(c) Accept it**, and rely on a restart. Defensible *today* precisely because the watermarks are
>    deliberately NOT persisted (`spoke-runtime.ts` docblock: `[]` after a restart is TRUE) — so a
>    process restart still forces a full replay. It stops being defensible the moment anyone persists
>    them, which that docblock currently argues against for a different and still-valid reason.
> **Recommendation: (a), specced, not built inside this branch.** Do NOT assign a `replica-fanout.ts`
> fix — there is nothing there to fix, and the original entry below is retained only so the wrong
> conclusion is not re-derived from scratch.
>
> <details><summary>Original D44 entry, 2026-08-23, superseded within the hour — kept per the
> correct-in-place rule so the wrong path is not walked twice</summary>
>
> > **The repair mechanism and the new reporting path turned out to be the same mechanism, and D38
> > switched it off for exactly the records that needed it.** (Mechanism 1-5 as originally recorded:
> > `replica-fanout.ts:59-60` sets each frame's `hubSeq` to the highest in THAT frame regardless of
> > which bound caused the split; an EXCLUDED op is absent from `changes`; `replica.ts:149` takes the
> > max, so the gap is recorded as applied; `replica.ts:97` then skips a later push of it. The
> > recommendation was *"cap, do not skip"* in `replica-fanout.ts`.) **Wrong because the excluded op is
> > unrepresentable at any time, so there was never a repair to lose — see the correction above.** The
> > general shape of the argument survives; only the cause and the owning file were wrong.
>
> </details>
>
> ### D45 — A TEST THAT PASSED ONLY BECAUSE THE MAC WAS BUSY (FIXED)
>
> `link-client-handshake-wedge.test.ts` passed on the Mac and failed **5/5 on the idle box**. That is
> the inverse of a normal flake, which is why it survived review, and the green was the accident.
>
> **The client was never wedged.** Instrumented on prod-host: it cycles `connecting` (the 150ms
> handshake timeout) -> `offline+retryAt` (~10ms) -> `connecting`, at 159 / 314 / 467 / 622 / 775ms.
> The state the test wants is true ~6% of the time, in a ~10ms window recurring every ~155ms. The test
> SAMPLED `client.health()` every 25ms — and a 25ms periodic sampler beats against a ~155ms periodic
> window, so on an idle box (metronome-regular) the sample phase can sit in the 94% for the whole 4s,
> while a loaded Mac's jitter randomizes the phase and hits almost at once.
>
> Ruled out first, so the attribution is not a guess: `ws` honours `handshakeTimeout` identically on
> both machines (probe: `error` then `close` at ~158ms, readyState 3, Node v22.12.0 and v22.23.2, ws
> 8.21.1 both). And **it is not a D38 regression** — the control, HEAD's own `link-client.ts` dropped
> into the box tree, fails there too.
>
> **Fix: observe the EDGE, never sample the level.** `setHealth` emits `health` on every transition
> (`link-client.ts:213`), subscribed before `start()` (which dials synchronously), with a `withTimeout`
> helper so a failure names what was awaited instead of reading as a generic hook timeout. Verified:
> 5/5 green on the box, green on the Mac, and **mutation-proven** — deleting the `handshakeTimeout`
> option turns it red at 4039ms while the file's negative control stays green (restore md5-verified,
> `7a6fa89039f33ad352f1030471a31eb2` both sides).
>
> **AMENDED — an edge-observer trades a missed-WINDOW race for a missed-EDGE race, and the mutation
> above does not reach it.** Raised by the peer session: dropping `handshakeTimeout` proves the test
> can fail when the behaviour is broken, not that it cannot miss an EARLY edge when the behaviour is
> fine — a listener attached after the transition hangs to the full timeout and reads as "the client
> is wedged", the very false diagnosis this file exists to prevent. The discriminating mutation is to
> move the subscribe BELOW the trigger and check for a TIMEOUT rather than a pass. **Ran it: it still
> passes 2/2.** So safety here comes from neither ordering nor a latch (`EventEmitter` does not replay
> to a late subscriber) but from the first non-`connecting` edge being one whole 150ms handshake
> timeout away. The subscribe is kept above `start()` regardless, since it is the only part that stays
> true if that gap ever shrinks — recorded at the point of use so a refactor does not "tidy" it down.
>
> **The transferable rule: a sampling test's flakiness is set by the RATIO of the window to the sample
> period, and an idle machine makes periodicity WORSE, not better.** Load is not the only thing that
> exposes timing bugs; regularity exposes a different class. Anything edge-triggered has an event —
> use it. And when you replace a sampler with an observer, mutation-test the NEW failure mode (late
> subscribe), not only the old one.
>
> ### GATE — 2026-08-23, on the box, clean tree
>
> `/var/lib/cezar/gate-cluster` (rsync `--delete` mirror of `packages/`, manifests md5-identical to the
> Mac, `node_modules` already present so no `npm ci`):
>
> **`tsc --noEmit` EXIT=0 · vitest 7027 passed / 1 failed / 4 skipped (7032), 405 files passed / 1
> failed / 2 skipped (408).** The single failure is `catalog.test.ts` C18 (`67.0ms` vs a `<40ms`
> budget) — the known standing red on this box, a CPU budget calibrated on the Mac. **That IS the
> green result.**
>
> This is the BRANCH gate, not B6's merged-tree gate. Per the merged-tree rule a green branch gate
> says nothing about the tree that gets pushed, so B6 still has to merge `origin/main` and re-run.
>
> **Do not gate in `/var/lib/cezar/gate-retarget`** — it belongs to the peer session working on
> retarget/account-pool routing. I rsynced into it by mistake and produced a 24-failure run that was
> pure artifact. **A partial-file-list rsync into a shared gate tree MERGES rather than replaces, and
> the mixed tree fails in a way that NAMES THE WRONG OWNER**: whichever side's *tests* survive is the
> side that appears broken, regardless of whose *source* was replaced — so the failure is reported
> against a file that genuinely exists and genuinely fails. A gate directory needs one owner. (The
> peer confirmed nothing of theirs was lost: it is a disposable rsync tree, not a git worktree, their
> own numbers predate it by 28 minutes, and `find /var/lib/cezar -not -user cezar | wc -l` is still 0
> because the sync ran as `cezar`.) Two more box gotchas from them, both of which read as real gate
> failures and are not: `npm run build` dies in an rsync'd tree because `scripts/write-build-stamp.mjs`
> shells `git rev-parse HEAD` and there is no `.git` (it fails AFTER `check:pack ok`), and
> `--reporter=basic` is not a valid vitest reporter in this repo — it exits 1 with a startup error and
> no `Test Files` line at all.
>
> #### WHERE THIS STANDS, 2026-08-23 end of the multi-agent session
>
> - **Milestone B is REACHABLE IN PRODUCTION for the first time.** `cluster-routes.ts:1112` now passes
>   `replication` to `createHubFrameRouter`; the hub allocates, applies, acks and fans out. Proven by
>   deleting the wiring and watching a real-socket E2E fail — run twice, independently. Before today
>   ~1,500 lines of this milestone were tested and had **zero production callers**.
> - **DONE:** B1 · B2 (mutation-checking found 3 real bugs — D31/D32/D33) · B2a (prune timer armed;
>   `prune()` had zero production callers for the life of the branch) · B2b · B3 (the wiring) ·
>   **B4 (replay engine + hub-router wiring + `readTodosFor` supplied and tested)** · D27 · D29 ·
>   D34 · **D28** · **D30** · **D36**. HUB's pass alone carries **22 mutations, all RED and quoted**.
> - **D28's landed fix was SUPERSEDED the same day, and the second one is right.** The first attempt
>   simply never advanced the origin's watermark — safe for live fan-out, but it re-sends a duplicate
>   on every same-`opId` retransmit and leaves B4 resuming the origin from 0 forever. Replaced by a
>   **delivery report on the reply channel**: `ClusterFrameReplies { frames, onWritten? }`
>   (`link-server.ts:93`), with a bare array still legal so no un-owned caller changed. Ack still
>   goes out first — it is frame 0 of the same reply. Mutation-checked in BOTH directions.
> - **D30 is closed, and one of its three root causes was invisible until traced:** `seedWatermark`
>   only overwrote keys the `hello` MENTIONED, and a real `hello` mentions none — so a watermark
>   advanced in a previous session survived every reconnect, uncorrectable. `hub-router.ts:325` now
>   DELETES the node's watermarks before seeding. The Map "leak" was measured and deliberately NOT
>   fixed: bound is ~39 integers on the production box. Nothing to do, and that is the evidence.
> - **D38 IS DONE AND THE THREE HALVES DEMONSTRABLY COMPOSE** — `link-client.ts:111` declares the
>   provider, `spoke-runtime.ts:278` supplies the live reader, `cluster-routes.ts:1173` wires it
>   late-bound. Typecheck exit 0. `link-client.test.ts` 24/24, `hub-router.test.ts` 37/37,
>   `link-server.test.ts` 22/22, `spoke-runtime` 53/53. **7 mutations on the client + 8 on the spoke,
>   all RED.** The one that earns the suite is **N-G — memoise the provider so it is read once**:
>   it kills the reconnect test *and nothing else*, which is what makes that test a claim about
>   FRESHNESS rather than presence. A watermark read once is exactly as useless as a hardcoded `[]`,
>   because the number moves precisely while the link is down. Deliberately NOT a fourth
>   declared-and-unsupplied option.
> - **IN FLIGHT / OPEN:** **D43 (top of this block — highest priority)** · D37 · D39 · D41 · D42 ·
>   B5 (near no-op, see below) · B6 (see below).
>
> #### D38 / D39 — two more found while wiring B4, neither fixed
>
> - **D38: `link-client.ts:352-353` — `sendHello` hardcodes `watermarks: []` and `projects: []`**
>   ("Phase 1 is inert … nothing has replicated yet, so there is nothing to resume from or
>   advertise"). That comment's premise died today: replication landed. So **no spoke ever reports
>   its position**, `seedWatermark` never fires from a real node, and every reconnect replays the
>   WHOLE scope. **This is why B4 must not be read as "replay works" yet** — the hub's half is built
>   and tested; the spoke never asks for anything.
>
>   **CORRECTED before anyone acts on it — "`sendHello` lies" is the wrong framing, and the right one
>   decides the fix.** `spoke-runtime.ts:239` holds those watermarks **in memory only, deliberately**.
>   So after a spoke PROCESS RESTART, reporting `[]` is *truthful* and a full replay is *correct*.
>   The defect is the narrower and far more common case: a reconnect **without** a restart — socket
>   drop, hub restart, network blip — where the runtime still holds live watermarks and `sendHello`
>   discards them. Therefore the fix is **report what the runtime currently knows, and persist
>   NOTHING.** Adding durability here will look like an improvement and is not: it would reassert a
>   position across a restart the module deliberately cannot vouch for, turning a bounded over-send
>   into a silent under-send, which is the one failure direction this feature exists to prevent.
>
>   **It pairs with D30's fix and must land in the same session.** `hub-router.ts:325` now DELETES
>   everything remembered for a node before seeding, so the hub trusts the node's report absolutely.
>   Previously a stale hub-side watermark accidentally suppressed part of the re-replay — accidentally
>   and wrongly. D30 made the hub honest about what the node claims; D38 makes the node's claim true.
>   Shipping the first without the second leaves the hub maximally trusting a report that is always
>   empty.
>
>   **Wired end to end 2026-08-23 across three files and three owners** — `link-client.ts` declares
>   the provider, `spoke-runtime.ts` exposes the position it already computes at `:245`/`:514` and
>   showed to nobody, `cluster-routes.ts:1153` supplies it at construction. Deliberately NOT left as
>   a declared-but-unsupplied option: that is the fourth instance of this branch's signature failure
>   (`readTodosFor`, `prune()`, the whole of Milestone B) and doing it knowingly, today, would be
>   indefensible.
> - **D39: `replay.ts#projectWholeRow` builds `clearedFields` from every absent content key.**
>   Measured: `todoSchema` has 21 content keys, a maximally sparse record yields **20**, and
>   `clusterOpShape.clearedFields` is capped at **32**. Fits today with 11 keys of headroom. Add 12
>   content fields to `todoSchema` and every replay op becomes schema-invalid — and
>   `link-client.parseDownlink` drops the **WHOLE frame**, so replay silently does nothing.
>   **Nothing anywhere validates a synthesized op against `clusterOpShape` before it goes on the
>   wire.** That missing validation is the real defect; the headroom is just how long it stays quiet.
> - **B6 — the box gate HAS run, and was clean.** `/var/lib/cezar/gate-cluster` on `prod-host`
>   is a purpose-built snapshot repo (no remote; commits literally named "gate snapshot 2/3/4", so its
>   `git rev-parse HEAD` tells you NOTHING about what was gated — verify the tree, never the hash).
>   Run 4, 08:57 today: `typecheck` 0 · `build` 0 · `test:unit` 0 · `test:package` 0 · full `npm test`
>   **581 passed / 1 failed / 2 skipped (584)**. The one red is `knowledge/catalog.test.ts > C18`, a
>   CPU-budget ratio calibrated on an M4 Max — **it is the ONE standing red on this box, and
>   581/584-with-only-C18 IS the green result.** (Older notes say 559/560; the suite has grown since.)
>   What is NOT done: re-running it on the CURRENT tree. Run 5 at 12:23 correctly **REFUSED to start**,
>   logging 24 files that differed from the Mac — the "never gate a moving tree" guard doing its job.
>   Reuse `boxgate4.sh` there; it already sets `CEZ_VITEST_MAX_WORKERS=3`, `CI=1` and `nice -n 10`.
>   Reach the box as **`cezar@`**, and the Access token fields are
>   `op://Vault/Server/Access Service Token/CF_ACCESS_CLIENT_ID` and
>   `/CF_ACCESS_CLIENT_SECRET` (exported as `TUNNEL_SERVICE_TOKEN_ID`/`_SECRET` — the names differ,
>   which costs a session ten minutes every time it is rediscovered).
> - **~25% of the whole spec. Milestone C and D are at 0%**, and the spec's own estimate is that C is
>   *larger than A and B combined*.
> - **0% verified on real hardware.** Every test runs both ends of the socket inside one process on
>   the Mac. **Nothing here has ever executed in production, and no two machines have ever paired.**
>   That is the number that matters, and it is blocked on the owner (below).
>
> #### THE THREE THINGS THAT ARE THE OWNER'S CALL, NOT YOURS
>
> 1. **Do not merge PR #9** (`feat/multi-node-cluster` -> `main`, open). It auto-deploys to
>    `prod-host` where the owner's agents run. **Owner's bar, stated 2026-08-23 and verbatim:
>    "let's merge where we have e2e working version, not now."**
>
>    **Read that together with the next sentence, because the two form a deadlock.** The box tracks
>    `main`, so a merge is also the hard prerequisite for any E2E on real hardware — "merge after
>    E2E" and "E2E needs the merge" block each other, and that circularity, not the code, is why this
>    feature is ~25% built and 0% verified on hardware. **Do not resolve it by merging.** The way out
>    that respects the bar is a **two-process E2E on one machine**: hub and spoke as separate OS
>    processes, real WebSocket on a real port, two data dirs, two node identities, real `todos.json`
>    on both sides. That is not two machines and does not exercise the tunnel, but it is the first
>    time this code crosses a process boundary at all — every test today runs BOTH ENDS OF THE SOCKET
>    INSIDE ONE PROCESS, which is exactly how ~1,500 lines stayed green with zero production callers.
>    Started 2026-08-23; if its result is not recorded below, it did not finish.
> 2. **Do not run the Access service-token provisioning script.**
> 3. **3b (`deriveTodoOps` refusing an op too large to ever fit a frame)** changes local write
>    behaviour. Recommended, not built.
>
> #### GIT STATE — MEASURED 2026-08-23, AND TWO REFS IN THIS CHECKOUT LIE TO YOU
>
> - **`origin/main` is `b862ef05`.** Branch head is `961ebcd3`: **12 ahead, 8 behind.**
> - **`refs/heads/main` in this checkout is `adeaa759` — 19 commits behind and NOT an ancestor of
>   `origin/main`.** So `git log main`, and anything diffing against `main`, reports fiction. Compare
>   against `refs/remotes/origin/main` after a fresh fetch, or against
>   `gh api repos/MarcinWalendowski/cezar/commits/main --jq .sha`.
> - **`git fetch origin` FAILS over ssh** — `ssh-add -l` lists the GitHub key but the 1Password agent
>   is locked, so signing fails and git reports *"Please make sure you have the correct access
>   rights, and the repository exists"*, which reads as a permissions problem and is not. Measured:
>   ssh fetch **exit 128**. Working form, no config change:
>   `git -c credential.helper='!gh auth git-credential' fetch https://github.com/MarcinWalendowski/cezar.git 'refs/heads/main:refs/remotes/origin/main'` → exit 0.
> - **Capture that exit code with a redirect, not a pipe.** `git fetch … | tail -3; echo "EXIT=$?"`
>   printed `EXIT=0` over the failure text — that is `tail`'s status, and it nearly went into this
>   spec as "fetch succeeded".
> - **The gate that counts is on the MERGED tree, not the branch.** Being 8 behind is not cosmetic:
>   merging `origin/main` previously took this repo from 559/560 to **12 failed** in files the merge
>   never touched textually. Do not cite a branch-only gate as a pre-push number.
> - **The box may have TWO standing reds, not one** (reported by a parallel session, NOT verified
>   here): `catalog.test.ts` C18 as always, plus `workflows/workspace-parallel.test.ts`
>   (`expected '?? .ai/' to be ''`) — intermittent and pre-existing, failing 2 of 3 targeted runs on
>   one tree and 1 of 3 on a pristine `origin/main` control, and passing on the Mac. **It passed in
>   one full-suite run, so a single green does not clear that file.** Confirm before treating 581/584
>   as the expected shape.
>
> #### THE FIVE THINGS THAT WILL BITE YOU
>
> - **`origin` only, never `upstream`. Never a bare `git push`.**
> - **Shared checkout with OTHER LIVE SESSIONS that commit.** Never `git stash` / `checkout .` /
>   `reset --hard` / `clean`. Re-take a scratchpad backup **immediately before** each mutation — a
>   backup taken minutes ago restores over another agent's work and nothing reports it.
> - **`grep -a`, and QUOTE `--include='*.ts'`.** Four `.ts` files here misclassify as binary and plain
>   grep silently finds nothing in them; an unquoted glob makes every symbol report zero callers.
> - **No lint, no prettier config.** `prettier --check` fails on untouched HEAD files. Not a gate.
> - **Never trust a test result taken while a mutation sweep is live.** One cluster run showed 1 failed
>   / 604 mid-sweep and 604/604 thirty seconds later.
>
> #### ~~IN FLIGHT~~ — ALL FOUR AGENTS FINISHED 2026-08-23. Kept as the ownership map, not a live roster.
>
> **Nothing is half-written any more**: every agent below has completed, `tsc --noEmit` is EXIT=0, and
> the full box gate is green apart from the standing C18 red (see GATE, above). The table is retained
> because it records **which agent owned which file**, which is what you need to interpret a docblock
> that says "reported separately, this file does not own it". The warning below still applies to any
> NEW fan-out you start.
>
> If you are picking this up mid-flight, these files may be half-written. Check `git status` before
> rebuilding anything: **agents on this branch have landed files after reporting them not delivered**
> (`op-history.ts` did exactly that, and `hub-apply.ts` did it again the same day).
>
> | Owner | Files it alone may edit | Doing |
> | --- | --- | --- |
> | HUB | `hub-router.ts` + test, `link-server.ts` + test | D28 origin half · D30 · **then B4 wiring** |
> | REPLAY-TEST | `cluster/replay.test.ts` (new) | tests + mutation-check for `replay.ts` |
> | SPOKE | `spoke-runtime.ts` + test | D35's real dead end · pre-`welcome` replica frame |
> | REVIEW-REPLAY | *(read-only)* | adversarial review of Design B |
>
> **`replay.ts` landed today with NO test file and NO production caller** — verified with
> `grep -a --include='*.ts'`, the only form of that negative that is trustworthy here (`ops.ts` and
> `notifications/decider.ts` misclassify as binary, so a plain grep finds nothing in them, silently).
> It is therefore the exact shape of the thing that produced this whole day's defect list: a green,
> unreachable module. **Wiring it is tracked as required, not optional.** Its own docblock says so.
>
> #### B5 IS SMALLER THAN IT LOOKS (checked 2026-08-23, do not re-spend an agent on this)
>
> B5's headline item was the `'todos.lock'` literal declared twice — `todos.ts:181` and
> `hub-apply.ts:111`, both module-private, so a rename of one would silently stop the two processes
> sharing a lock and cost a lost write with nothing red. **That class is already closed by test.**
> `hub-apply.test.ts:235` asserts it from the only side that proves anything: one hardcoded lock path
> must block a `todos.ts` writer AND a `hub-apply` writer *in the same test*, because asserting only
> the `todos.ts` side stays true no matter what `hub-apply` names its own lock. It is mutation-verified
> (renaming `TODOS_LOCK_FILE` in `hub-apply.ts` leaves `applied` true). A `todosLockPath(dataDir)`
> export is now tidiness, not a defect fix — worth doing, worth doing last. What is left of B5 is the
> `toNodeWire`/`toPairingWire` duplication between `hub-router.ts` and `cluster-routes.ts`, and
> `hub-router.ts`'s own docblock argues that one is deliberate (package boundary, straight field-copy).
> So B5 may be close to a no-op. Confirm before scheduling it.
>
> #### D36 — EVERY REPLICATED TODO RESENDS FOREVER. Found 2026-08-23 by the two-process E2E.
>
> **This is the most serious defect on the branch, and no unit test could see it.** The first real
> two-process run (hub + spoke, separate OS processes, real socket) reproduced it on the very first
> replicated row.
>
> **Mechanism, traced end to end and confirmed independently of the agent that found it:**
> `todos.ts#stampPending` writes `'id'` into `pendingFields` (measured: `["summary","status",
> "origin","id","ts","author"]`). But `ops.ts#partitionTodoFields` **skips every key in
> `CLUSTER_META_TODO_FIELDS`** — which contains `'id'` — so `id` lands in neither `op.fields` nor
> `op.clearedFields`. Then D27's fix in `replica.ts:217` builds `touchedFieldNames` from exactly
> `op.fields ∪ op.clearedFields ∪ op.unknown`, filters `pendingFields` by it, and clears
> `pendingSince` only when `stillPending.length === 0`. **`id` can never be touched, so it can never
> be filtered out, so `stillPending` never empties, so `pendingSince` never clears.**
>
> Consequence: `deriveTodoOps` re-derives an op for that record on **every flush tick, forever**,
> each allocating a fresh `hubSeq`. Measured on the E2E: the spoke's replicated row settles at
> `pendingFields: ["id"]` and stays there, and **`hub-seq.json` climbs ~1 every 5 seconds with the
> cluster completely idle** — ~17,280/day, which is exactly D35's predicted leak rate.
>
> **This reclassifies D35.** D35 assumed the leak required an *unreplicable* record (one too big to
> frame). It does not: it happens to **every single replicated row**, on the happy path. D35's
> "case 3" framing understates it by an order of magnitude.
>
> **D27's fix caused it.** Before D27, `applyOpToRecord` cleared `pendingSince` unconditionally,
> which was wrong for a different reason (it dropped un-sent local edits) but did not loop. The fix
> is correct in its own terms and created this; that is the shape to watch for, not a reason to
> revert it.
>
> **The real fault is one concept enforced in two places that never agreed:** "which keys can ride an
> op" lives in `partitionTodoFields`, and "which keys are still owed" lives in `stampPending` +
> the D27 narrowing. A key that is definitionally never sendable must never be recorded as owed.
> Fix at the source (do not stamp meta keys as pending) rather than by teaching the narrowing to
> special-case them, or the two will drift again.
>
> **D36 fix, as landed (verify before trusting — I read it, I did not re-run its tests).**
> `CLUSTER_META_TODO_FIELDS` is now **exported from `ops.ts` and derived from the contract**
> (`clusterTodoFieldsSchema.shape`, minus `placement`, plus `'id'`) rather than hand-typed. That is
> better than what was asked for: a seventh cluster field added to the contract becomes un-sendable
> **by default**, so it fails CLOSED (the field silently does not replicate, which is visible) rather
> than OPEN (stamped as owed, loops forever, which is D36 again). Three readers now share the one
> set — `partitionTodoFields` (what may ride), `stampPending` (what may be owed),
> `applyOpToRecord` (what may remain owed). Stuck on-disk records heal two ways: the next local edit
> re-filters the union, and the next replica apply filters `stillPending`.
>
> **STILL OPEN — there is a FOURTH copy.** `cluster/replay.ts` derives its own `CLUSTER_META_KEYS`
> identically and independently; it was correctly left alone (another agent owned that file), but
> until it imports the shared set, D36's root cause — one concept kept in two hand-maintained lists —
> is only three-quarters retired. Retire it before Milestone C.
>
> #### D37 — REPLICATION IS ONE-DIRECTIONAL. A HUB-LOCAL WRITE NEVER LEAVES THE HUB.
> **Found 2026-08-23 by the same two-process E2E. Structural, not a bug — half the design is absent.**
>
> Measured: `HUB-ORIGIN-BETA`, created on the hub, sits in the hub's `todos.json` with
> `pendingSince` and a full `pendingFields`, and is **absent from the spoke** indefinitely. Meanwhile
> `SPOKE-ORIGIN-ALPHA` reached the hub correctly. Replication works spoke -> hub only.
>
> **Cause, verified with `grep -a --include='*.ts'`: `deriveTodoOps` has exactly ONE production
> caller — `spoke-runtime.ts`.** There is no hub-side equivalent. Nothing derives, allocates,
> applies or fans out an op for a write that originates on the hub. `todos.ts` still stamps
> `pendingSince` on the hub (clustering is on there too), so every hub-local write also accumulates a
> pending marker that nothing will ever clear — a second instance of D36's pathology, on the hub,
> which the D36 fix does NOT address because there is no ack coming for a record nobody sent.
>
> **Why this is worse than it sounds: the production hub is `prod-host`, and that is where the
> owner's agents run.** So the direction that does not work is the one carrying agent-created todos
> out to the operator's Mac. The working direction is the less important one.
>
> **Not scoped away anywhere.** The spec's only "bidirectional" statements (lines ~674, ~3712, ~3724)
> are about the KNOWLEDGE CORPUS, which is deliberately one-way; none of them speak to todos.
> Milestone B's stated "largest remaining hole" is the replay gap, not this.
>
> **Do not build a hub-side outbox without recording the design first.** The hub cannot simply reuse
> `spoke-runtime.ts`'s loop: it allocates `hubSeq` locally rather than requesting it, it has no link
> to flush *to*, and its op must enter the SAME `applyOpAtHub` + fan-out path a spoke's op takes or
> the two directions will diverge. That is a design decision, and this spec is the place for it.
>
> #### D40 — A MALFORMED `hello` LEAVES A LINK SILENTLY HALF-DEAD, AND D30's FIX CREATED IT
>
> Found 2026-08-23 while wiring D38, by the same agent that wrote D30's fix. **Not a hypothetical —
> it is why the watermark provider validates rather than trusting a number the node computed itself.**
>
> Chain: `writeFrame` does not validate (JSON-encode plus a byte bound, nothing more), and
> `link-server.ts:272` **DROPS** an invalid uplink frame with a warn rather than refusing the
> connection. So ONE malformed watermark entry means the `hello` is never processed, and
> `helloReceived` is never set. Before D30 that was survivable. **Now that `connectedNodes()` is
> narrowed to handshaken nodes, that node gets no `welcome` and no fan-out AT ALL, indefinitely —
> while its own health still reads `online`.** A silently half-dead link: connected, never served.
>
> Two general points worth carrying past this defect:
> - **Tightening a gate can convert a tolerated fault into a permanent one.** D30's narrowing is
>   correct and should stay. But it moved the cost of a dropped `hello` from "a stale watermark"
>   to "this node is never served again", and nothing in the D30 change itself is where you would
>   look for that.
> - **`storedClusterWatermarkSchema` is `.passthrough()`; the wire's `clusterWatermarkSchema` is
>   `.strict()`.** So handing a stored watermark straight to the wire is invalid the moment it
>   carries any extra key. `helloWatermarks()` narrows to the wire fields, re-validates per entry,
>   caps at 500, and catches a throwing provider — every failure mode falling toward over-send,
>   never toward a dead link. Construct the wire shape deliberately; do not rely on that guard.
>
> `hello.projects` stays hardcoded `[]` deliberately, for a DIFFERENT reason than the watermarks:
> nothing consumes it (`hub-router.ts`'s `hello` case omits `proposals` rather than computing one),
> so advertising into it would be motion, not progress. Recorded separately so a future reader does
> not "finish the job" by wiring it.
>
> #### D41 — THE D9a DOUBLE-START IS REAL, AND IT IS REPORTED RATHER THAN PREVENTED
>
> **The hub refusing a claim does not stop the run this node already started.** `spoke-runtime.ts`
> now says so in its own warn text: *"a claim this node LOST (D9a): a run started here for that
> claim is NOT stopped by this ack"*. So two nodes can be running the same task, and the guard
> built to prevent exactly that reports the collision after the fact instead of preventing it.
>
> **Why it was not simply fixed, and this reasoning is worth preserving:** settling the record needs
> an `opId -> entity` mapping, and this module cannot form one without holding a sent-but-unacked
> map across ticks — the one thing its module doc says it never does, and the thing that makes a
> link outage harmless. Re-deriving from disk cannot recover the mapping either (see D42). So the
> honest contribution available was to make the refusal VISIBLE, and it takes it. Silence was the
> worst option; a fabricated mapping would have been worse than silence.
>
> **This is an owner decision, not an engineering one.** Either a claim becomes synchronous (the
> spoke waits for `accepted` before starting, which is what D9a's own text says `accepted` means and
> costs a round trip on every start), or the double-start is accepted and something must reconcile
> it. It is currently neither: documented, warned about, and live.
>
> #### D42 — `deriveTodoOps` IS DOCUMENTED AS DETERMINISTIC AND IS NOT
>
> `ops.ts:175` claimed *"Deterministic: called twice over the same state it produces the same ops,
> so a re-derive after a crash is a no-op rather than a duplicate flush."* **False.** `opId:
> newOpId()` is `randomUUID()`, so two derives over identical state differ in exactly the field the
> hub deduplicates on — `op-history.ts#findAppliedOp` keys on `opId`. A re-derive is therefore a
> duplicate flush the dedupe **cannot recognise**, durably re-applied at the hub.
>
> This is the engine behind D35/D36: a record that stays `pendingSince` re-derives every 5 s with a
> fresh id and op history grows without bound. **D36's fix removes the usual trigger but does not
> make the sentence true** — any future path that leaves a record pending gets the same behaviour.
> Docblock corrected in place 2026-08-23, original text kept beneath the correction.
>
> The general shape, worth more than the instance: **a docblock asserting a safety property is not
> evidence of it, and this one had been read and relied on repeatedly.** D35's whole analysis rested
> on it. Two of today's defects were found by comparing a module against its mirror-image sibling
> and the shared contract, never by reading its own documentation — a docblock shares the code's
> blind spot by construction.
>
> #### THE ONE LESSON, IF YOU READ NOTHING ELSE
>
> **Wiring dead code makes every latent defect inside it live at the same instant.** Nine defects
> (D27-D35) were found in a single day, all inside code that had been green for weeks, none visible to
> any single-module suite. The dangerous moment for a feature built module-by-module in isolation is
> not when the modules are written — it is the day they are connected. Milestone C is being built the
> same way and will have the same day.
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
> - **CORRECTED 2026-08-23: a PR now exists.** ~~Not merged to `main`, and no PR opened~~ — PR **#9**
>   is open (https://github.com/MarcinWalendowski/cezar/pull/9) and still NOT merged. Merging remains
>   the owner's call, and is the hard prerequisite for any E2E (see the deploy path below). `HEAD` has
>   also moved on past `3f00d234`: it is `961ebcd3` as of 13:11.
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
> ### Milestone B build status — 2026-08-23, in progress
>
> | piece | file | state |
> |---|---|---|
> | `hubSeq` allocator | `cluster/hub-seq.ts` | **done**, 17/17, 3 mutations red |
> | hub applies an ops frame -> ack | `cluster/hub-ops.ts` | **done**, 8/8, 4 mutations red |
> | replica fan-out planner | `cluster/replica-fanout.ts` | **done**, 11/11, 5 mutations red |
> | spoke outbox flush + ack/replica wiring | `cluster/spoke-runtime.ts` | **done**, 28/28, 3 mutations red |
> | router wiring + watermarks | `cluster/hub-router.ts` | **done 2026-08-23**, 17/17, 7 mutations red (was "code written, ZERO TESTS") |
> | durable per-`opId` verdict cache | `cluster/op-history.ts` | **done**, 16/16, fails closed on key/value mismatch |
> | hub-side per-op apply (D9a verdict) | `cluster/hub-apply.ts` | **done**, 11/11 — but NOT mutation-checked (see B2) |
> | constructing the deps in `startClusterRuntime` | `server/cluster-routes.ts` | **DONE 2026-08-23** — wired; the remove-the-wiring negative control verified twice, independently |
>
> #### ~~THE SINGLE MOST IMPORTANT THING TO KNOW ABOUT THIS BRANCH RIGHT NOW~~ — CLOSED 2026-08-23 13:18
>
> **B1 is DONE; this section is kept only as the record of what was wrong and how it was proved.**
> `grep -ac replication hub-router.test.ts` now returns **20**, up from 0, and the file is **17/17**
> (was 11). Six new tests cover the six cases listed below; a seventh covers `watermarkKey` keeping
> `workspace` and `project:<key>` independent. **Every one was mutation-checked RED**, and the
> orchestrating session re-ran the highest-stakes mutation itself rather than accepting the report:
> re-introducing the monotonic `seedWatermark` (the real bug that was caught and fixed the same day
> it was written) turns exactly one test red —
> `AssertionError: expected [ { type: 'replica', …(5) } ] to have a length of 2 but got 1` — and
> `hub-router.ts` was `8a781584c20dcb01b817e965889109f8` before and after, unchanged against HEAD.
>
> **The residual gap, stated honestly, because it is the same shape as the defect this closes.** These
> tests inject FAKES for all six `HubReplicationDeps` members. They prove the router's logic; they
> prove nothing about the real `hub-seq.ts` / `hub-apply.ts` / `op-history.ts` behind it. **That
> integration test is B3's deliverable, not a nicety** — a wiring change with no test that fails when
> the wiring is removed is exactly the D23/D24/D25 defect class.
>
> The original text follows, unchanged:
>
> **`hub-router.ts`'s new replication path has NO test coverage whatsoever, and the suite is green
> anyway.** Measured, not suspected: `grep -c replication hub-router.test.ts` returns **0**. Every
> one of its `ops` tests builds `deps` without a `replication` field, so all of them take the
> `if (!deps.replication)` early return and exercise none of the ~60 lines below it. The five
> replication test files together report **75/75 passing** and that number says nothing at all about
> the code that was just written.
>
> This is the exact shape the repo has been bitten by before (D24; the activation E2E that minted its
> own hub identity): *a suite that is entirely correct about a path production does not take.* Do not
> read the green as progress. **The first thing the next session should do is write `hub-router`
> tests that pass a real `replication` object**, and each one should be mutation-checked, because a
> test that constructs `deps.replication` but asserts only on the ack still never proves a `replica`
> frame was built or pushed.
>
> Concretely, the cases that need to exist and do not:
> 1. an accepted batch produces `[ack, ...origin's own replica frames]`, **ack first** (the origin is
>    waiting on it, and `replica-fanout.ts` deliberately does not exclude the author);
> 2. a second connected node is PUSHED via `sendTo`, and the returned array does **not** contain its
>    frames;
> 3. a rejected op does not appear in any `replica` frame, while its rejection still appears in
>    `ack.results` with the winner's `fields`;
> 4. `sendTo` returning `false` leaves that node's watermark **unadvanced**, so the next batch owes
>    the frame again — with a negative control proving the watermark WOULD have advanced on success;
> 5. a `hello` carrying a LOWER `appliedThroughHubSeq` than the hub last sent **overwrites** it
>    (see the `seedWatermark` note below) — this one is a real bug guard, not a nicety;
> 6. no `replication` wired -> still warns and returns `[]`, never a fabricated ack.
>
> #### What was written into `hub-router.ts` (2026-08-23), so the next session need not re-derive it
>
> Three patches, all applied, typecheck green across all four workspaces:
>
> - **`HubReplicationDeps`, and `replication` is OPTIONAL on `HubFrameRouterDeps`.** A hub with no
>   replication wired is a legitimate state (that is every caller today), and the honest behaviour
>   there is the pre-existing one: warn, apply nothing, send no ack. Making it required would have
>   forced every existing caller and test to fake a replication surface, which is how a fake becomes
>   the only thing that is ever exercised. The deps are `allocate`, `applyOp`, `findAppliedOp`,
>   `recordAppliedOp`, `sendTo(nodeId, frame) => boolean`, `connectedNodes() => ClusterNodeId[]`.
> - **In-closure watermarks**, `Map<nodeId, Map<scopeKey, hubSeq>>`, keyed `workspace` or
>   `project:<key>`. In memory on purpose: a hub restart loses them and re-learns from each `hello`,
>   which is the node's own truth, so there is nothing to persist and nothing to keep consistent.
> - **`advanceWatermark` vs `seedWatermark` — and this distinction is load-bearing, was nearly got
>   wrong, and is written up in the file itself.** Advancing WITHIN a session (on send) is monotonic,
>   so a late or duplicate frame cannot walk a watermark backwards. Seeding from a `hello` is a
>   **SET, not a max**. The hub advances when it SENDS, which is a claim about delivery, not about
>   application; if a node dies between receiving and applying, the hub's number is too high, and on
>   reconnect the node reports the LOWER, truthful value. That lower value must win, or the hub never
>   resends and the node is permanently missing writes with nothing anywhere reporting it. The other
>   direction is free — replica application is idempotent and the receiver drops anything at or below
>   its own watermark — so a spoke that under-reports costs one redundant frame, while a hub that
>   over-remembers costs a silent permanent gap. *(An earlier version of this same patch made `hello`
>   monotonic and described that as a feature. It was a bug. Corrected the same day, before any test
>   existed that could have caught it — which is itself the argument for case 5 above.)*
> - **The `ops` case** now: early-returns the old warn when `replication` is absent; otherwise calls
>   `applyOpsFrame` with `allocateSeq` closed over this frame's scope; rebuilds the applied set by
>   matching `ack.results` back to `frame.ops` by `opId`, keeping **only `accepted`** ones and
>   stamping `hubSeq`; calls `planReplicaFanout` with every connected node as a target at its current
>   watermark; **returns** the origin's frames behind the ack and **pushes** everyone else's via
>   `sendTo`, advancing a watermark only on a successful send.
>
> Backup of the pre-wiring file, if any of this needs reverting without touching git in a shared
> checkout: `$SCRATCH/hub-router.prewire.bak` (this session's scratchpad; gone once it is cleaned).
>
> **Two pieces were not in the original plan and were found while building**, both by an agent
> pushing back on a brief rather than implementing it as written — worth noting because both are
> load-bearing and neither is obvious from the spec text:
> - **`op-history.ts`** — idempotence needs a DURABLE per-`opId` verdict cache, not a Map.
> - **`hub-apply.ts`** — `hub-ops.ts` needs a PER-OP verdict, and the existing `applyHubReplica` is
>   batch-shaped and computes corrections for a spoke against the hub's authority. The hub applying
>   a spoke's op is the other direction. Reuse its mechanism (`withTodosLease`, `applyOpToRecord`,
>   read-fresh-inside-the-lease), not its shape.
>
> **`welcome.resumeFrom` stays `[]`, and the REASON has now changed — DONE 2026-08-23.** The comment
> in `hub-router.ts` no longer says "nothing replicates". It now says what is actually true: ops
> replicate LIVE (a node connected when a batch lands is pushed its frames immediately), but there is
> no **connect-time replay** — nothing reads `oplog.ts#readOps` from a `hello` watermark and ships
> what a node missed while it was away.
>
> **That gap is real and is Milestone B's largest remaining hole, not a cosmetic one.** A spoke that
> is offline when a batch lands never receives it, and never will: it stays behind until some future
> write happens to touch the same records. An empty `resumeFrom` is currently the honest "this hub
> cannot replay" and is indistinguishable on the wire from "you are caught up" — so the value must
> not be quietly treated as correct once replay lands.
>
> #### The spoke half is already wired in production, with a design choice worth reviewing
>
> `spoke-runtime.ts` (delivered, 28/28, three guards mutation-checked: reentrancy, no-backlog,
> drop-only-on-ack) discovers its own project list via a new `discoverOutboxProjects`, reading
> identity + `peers.json` + workspace config from disk rather than taking a list from its caller. Net
> effect: **the flush loop is live today with zero changes to `cluster-routes.ts`'s existing
> `startSpokeRuntime({ link, env, warn })` call site.** Its author flagged this as a call for whoever
> owns `cluster-routes.ts` — if that layer should own and inject the project list for determinism,
> change it there. Also deliberately out of scope in that file: `ackedThroughHubSeq` is in-memory
> per-project state inside `spoke-runtime.ts`, **not** a call into `todos.ts`, because `todos.ts` has
> no generic ack-application function — its only `hubSeq`-stamped path is `markStartedWithClaim`,
> specific to the synchronous claim RPC (D9a) and not to the general outbox `ack` frame, which had
> zero production callers before this change.
>
> ### FOUR LIVE DEFECTS ON THE MILESTONE B PATH — D27-D30, found 2026-08-23 while designing B4
>
> **All four are in code that is already written and already "green". None was found by a test; all
> four were found by reading the path end to end.** Each was then re-verified independently by the
> orchestrating session against the named lines before being written here. They are listed before the
> remaining work because two of them are hazards to B3, which is wiring this exact path right now.
>
> **FIXED 2026-08-23, and the fix needed a SECOND gate nobody had looked at.** `applyOpToRecord` now
> narrows `pendingFields` by whatever the op actually names (`fields` keys u `clearedFields` u
> `unknown` keys) and clears `pendingSince` only when nothing remains owed. The false comment is
> corrected in place. 25/25 in `replica.test.ts` (20 pre-existing untouched), 95/95 across
> `replica`/`ops`/`spoke-runtime`, four mutations red.
>
> **The second gate is the part worth reading.** The load-bearing test came out RED against the
> *fix*, not against the bug — because `deriveTodoOps` has **two** gates, not one:
>
> ```ts
> if (!todo.pendingSince) continue;
> if (todo.hubSeq !== undefined && todo.hubSeq <= input.ackedThroughHubSeq) continue;
> ```
>
> Preserving `pendingSince` correctly (gate 1) achieves nothing if gate 2 drops the record anyway —
> and it does, because the project-wide `ackedThroughHubSeq` advances on every push while a
> partially-resolved record's own `hubSeq` lands at or below it one tick later, which is the NORMAL
> case. **Same bug, reachable through the sibling gate.** Gate 2 is now additionally conditioned on
> `todo.pendingFields === undefined`, deferring to the precise per-field answer wherever one exists
> and remaining the backstop it always was where one does not. Verified load-bearing by an
> independent re-run of the mutation: reverting that one condition fails exactly the load-bearing
> test (`expected [] to have a length of 1 but got +0`, 1 failed / 66 passed) with the `replica.ts`
> fix fully intact.
>
> Note `todos.ts#markStartedWithClaim` already knew this shape — `if (!item.pendingSince) item.hubSeq
> = ack.hubSeq;`, twice, commented against "writing this seq onto a record that still carries unsent
> edits would silently retire them". The knowledge existed, in a different file, for a different
> write path, and did not generalize.
>
> Also folded in: a **tombstone** resolves every pending field unconditionally (it carries no
> `fields`/`clearedFields`, so it would otherwise leave `pendingSince` set forever on a deleted row),
> matching `ops.ts#collapseOwed`'s own "a tombstone wipes whatever accumulated" rule.
>
> ### THE REACHABILITY POINT, WHICH IS THE LESSON OF THIS WHOLE DAY
>
> **D27 had ZERO live blast radius until B3's wiring landed — and B3 is what made it live.** Traced:
> `applyOpToRecord`'s only observable path is the spoke's `applyReplicaDownlink`, which fires solely
> on receipt of a `ClusterReplicaFrame`. Before B3, **nothing anywhere constructed or sent one** —
> the hub had no such mechanism at all. The hub-side call (via `hub-apply.ts`) writes markers on the
> hub's own copy that nothing ever reads, because a hub never runs the spoke's outbox machinery.
>
> So this fix closed the bug **just ahead of** it becoming reachable, rather than closing one that
> was already losing data. Generalized, and this is the thing to carry forward:
>
> > **Wiring dead code makes every latent defect inside it live at the same instant.** B3 made ~1,500
> > lines reachable in a single change. D27, D28, D29, D30 and D35 were all sitting inside those
> > lines, all "green", all invisible to every single-module suite — and all of them went from
> > harmless to load-bearing the moment one line at `cluster-routes.ts:1112` started passing
> > `replication`. The dangerous moment for a feature built module-by-module in isolation is not
> > when the modules are written. It is the day they are connected.
>
> The original defect, kept:
>
> **D27 — applying a replica frame silently DELETES the receiver's own un-sent local edits.**
> `applyOpToRecord` ends with an unconditional `delete base.pendingSince` (`cluster/replica.ts`,
> just after the `hubSeq` assignment), and `deriveTodoOps` gates the ENTIRE outbox on that one marker
> (`cluster/ops.ts:191`, `if (!todo.pendingSince) continue;`). `pendingSince` is **per record, not per
> field**. So when the hub replicates node B's write to a record that node A also has un-sent local
> edits on, A's edits lose the only marker that would ever have sent them upward, and nothing
> re-derives it. The record's *values* may survive for fields the hub did not name; the intent to
> send them does not.
>
> The code's own comment defends the delete — *"the hub has now spoken for whatever it held.
> `applyReplica` is the one that decides, from `pending`, whether that outstanding work was confirmed
> or corrected"*. **That claim is false**, and this is the docblock-disagrees-with-the-code pattern:
> `input.pending` is read in exactly one place (`replica.ts:120-127`) and used only to compute
> `corrections` **for display**. It never guards a field from being overwritten and never preserves a
> marker. Fix: a replay or replica apply may not clear or overwrite a field named in the receiver's
> own `pendingFields`. This is a `replica.ts` change, not a contract change.
>
> **D28 — the origin path advances a watermark with NO delivery check, and the writer it depends on
> can fail silently.** `hub-router.ts`'s `ops` case checks `sendTo`'s boolean before advancing for a
> PUSHED node (`if (replication.sendTo(...)) advanceWatermark(...)`), but the ORIGIN branch calls
> `advanceWatermark` unconditionally right after `downlink.push(replicaFrame)`. Those returned frames
> are written by `link-server.ts:248` — `for (const reply of replies) this.writeFrame(node, reply);` —
> which **ignores `writeFrame`'s return value**. `writeFrame` returns false for an oversized frame
> (warned, `:265-267`) and for a budget-exhausted one (**silently**, `:257`). So a replica frame can be
> dropped while the hub has already recorded it as delivered: silent permanent loss, on the one path
> that skips the check that the other path makes. D29 makes oversized frames the normal case, not the
> exotic one.
>
> **D29 — `planReplicaFanout` enforces the frame's COUNT cap and not its BYTE cap, while its docblock
> claims both.** It splits on `CLUSTER_OPS_PER_FRAME_MAX` only
> (`for (let i = 0; i < owed.length; i += CLUSTER_OPS_PER_FRAME_MAX)`), with no `maxBytes` anywhere —
> unlike the spoke's mirror-image `packOpsFrame`, whose `DEFAULT_OP_SEND_BUDGET` carries
> `maxBytes: CLUSTER_FRAME_MAX_BYTES` (`ops.ts:218-222`). The module's own docblock lists "**Frame
> cap**" among "the remaining requirements … that the tests pin". It pins the count half only. At
> `chat/`-sized records (~3 KB) a 500-op replica frame is ~1.5 MB against a 256 KB
> `CLUSTER_FRAME_MAX_BYTES`, i.e. **six times over**, and is rejected at `link-server.ts:265`.
> **The direction matters:** spoke->hub is budgeted, hub->spoke is not, so this is exactly the half
> that Milestone B newly makes hot.
>
> **ESCALATED 2026-08-23 by an independent second look — this is a CONTRACT violation, not a docblock
> slip.** The bounds are stated in `packages/contract/src/cluster.ts:100-107` as an obligation on
> every sender: *"Bounds are part of the contract, not an implementation detail… a **sender that
> would exceed either splits and resumes** from the last `ack`, so a dropped frame costs a
> retransmit and never a gap."* **"Either" means both, explicitly.** `planReplicaFanout` builds
> `ClusterReplicaFrame`s, is exactly such a sender, and honours one bound. Measured: `grep -a` for
> `byte|Bytes|BYTES` returns **zero hits in `replica-fanout.ts` and zero in its test file** — there
> is no guard to mutate, so the break is permanent and unconditional rather than merely untested.
>
> **And the drop is silent in a way `link-server.ts` says it never is.** Its own module docblock
> (`:34`) states *"A refusal is a stated reason, never a silent drop (D13)"*, but the byte-oversize
> outgoing path warns server-side and `return false`s with no exception, no signal back to the plan
> generator, and no re-split at the right granularity anywhere. From the sender's point of view it is
> a silent drop. Same defect family as D28, and it is why D28's fix must reach `link-server.ts:248`
> and not only `hub-router.ts`.
>
> **FIXED 2026-08-23 (byte-aware splitting), and the fix surfaced a second, sharper question.**
> `planReplicaFanout` now packs against the byte bound as well as the count bound, 15/15, three
> mutations red. Two things from it worth keeping:
>
> - **Measure the quantity the wire enforces, not a proxy for it.** `link-server.ts` checks
>   `Buffer.byteLength(JSON.stringify(frame))` on the whole frame; the spoke's `packOpsFrame` sums
>   per-op bytes and never counts the **envelope** (`type`/`protocol`/`scope`/`projectKey`). The
>   undercount is small (~150-300 bytes against 256 KB) but it is the wrong quantity to bind a hard
>   ceiling to, which is the exact mistake D29 was. The fix measures the encoded frame; to avoid
>   re-stringifying a growing batch per candidate op (quadratic — ~500 ops x up-to-500-element
>   re-stringify is hundreds of MB of string work per call) it tracks an incremental estimate and
>   does one real measurement per COMPLETED frame as a **defensive assertion, not a decision point**.
>   That assertion fired during mutation testing and caught the mutation before the test's own
>   assertions did — the difference between a live invariant and a decorative one.
> - **`ops.ts#packOpsFrame` has the same envelope undercount, smaller**, and its single-oversized-op
>   policy is "emit anyway". Recorded as a known, deliberate difference rather than a defect: that
>   policy was a real decision there, unlike D29 which was an omission.
>
> **THE FOLLOW-ON, and it is why "fixed" is not yet "done".** The fix throws when a SINGLE op exceeds
> the frame bound alone. The throw aborts the whole `planReplicaFanout` call, so every normal-sized op
> in the same batch also fails to replicate and **the origin never gets its ack** — its outbox
> resends the identical frame into the identical throw, forever. No data is lost (the hub applied it
> before this step) but it does not self-heal.
>
> **That state is REACHABLE, measured rather than assumed:** `clusterOpShape.fields` and `.unknown`
> are both `z.record(z.string(), z.unknown()).optional()` (`contract/src/cluster.ts:365`, `:381`) —
> **completely unbounded.** `entityId` is capped at 200, `clearedFields` at 32x120, `pendingFields`
> likewise; the payload itself has no ceiling at all. A todo carrying a pasted stack trace, log
> excerpt or spec body can exceed 256 KB, and in this repo todos routinely carry
> "Context / What to do / Acceptance criteria" prose. So one oversized record **permanently wedges
> that project's entire replication.** Louder than the silent drop D29 caused, which is an
> improvement, and still a poor terminal state.
>
> Being narrowed now: exclude the unrepresentable op, replicate the rest, **still ack the origin**
> (or a replication wedge is merely traded for an outbox wedge), and keep the defensive throw for a
> genuine splitter bug. Note the constraint that makes this more than a warning change: **B4's
> connect-time replay will hit the same wall on the same record every time that spoke reconnects**,
> so the handling has to be stable under repetition, not merely correct once.
>
> **NARROWED 2026-08-23 — and the narrowing uncovered D35, below.** `planReplicaFanout` now returns
> `{ plans, excluded }`, both **non-optional**. The reasoning for a return field over an input
> callback is worth keeping: with a callback, swallowing the report means passing a no-op; with an
> always-present return field, swallowing it means actively not reading something that is right
> there. Choose the shape that is harder to ignore by accident. An oversized op is now excluded per
> (target, op) pair, warned by name — and the warn says explicitly when the excluded target is the
> ORIGIN, because that case is strictly worse. The rest of the batch replicates, the origin still
> gets its ack, and the defensive per-frame throw is kept and deliberately distinguished: "this op
> cannot be represented" is an input condition and is handled; "the frame I built is over budget" is
> a bug in the splitter and still throws. 40/40 across both files, three mutations red — including
> one that simulates "stop trying once you hit an op you cannot represent", proving the rest of the
> batch still gets through.
>
> `planReplicaFanout` stays **pure**: same op, same target, same input -> same exclusion, every call,
> forever. That is what makes it stable under B4's repeated replay attempts rather than a
> fires-once-then-goes-quiet report.
>
> ### D35 — THE ACK DOES NOT STOP RE-DERIVATION, AND AN UNREPLICABLE RECORD LEAKS FOREVER
>
> **Found while narrowing D29; confirmed independently against the code.** The assumption that "the
> ack stops the outbox resending" is only half true, and the half that is false is expensive.
>
> The ack stops raw retransmission of one unacked frame. It does **not** stop the record being
> RE-DERIVED. Chain, every link verified:
>
> 1. A record that cannot be replicated never receives a `replica` frame, and receiving one is the
>    only thing that clears `pendingSince`.
> 2. The ack path **would** stamp the record's `hubSeq` — `todos.ts:912` and `:936` do
>    `item.hubSeq = ack.hubSeq` — but both are guarded by **`if (!item.pendingSince)`**, and
>    `pendingSince` is precisely what is stuck set. So `hubSeq` stays `undefined`.
> 3. `deriveTodoOps`'s defensive guard is
>    `if (todo.hubSeq !== undefined && todo.hubSeq <= input.ackedThroughHubSeq) continue;` — whose own
>    comment says it exists so such a record "is not owed, so it must not be re-sent forever".
>    **It can never fire**, because step 2 guarantees `todo.hubSeq` is `undefined`.
> 4. So every 5 s flush tick (`DEFAULT_OP_FLUSH_MS`) re-derives the record with a **fresh
>    `newOpId()`**. A fresh `opId` misses `op-history`'s idempotence cache by construction, so the hub
>    **durably re-applies it**, burning a new `hubSeq` and a full `todos.json` read-modify-write under
>    lease, and appending another `op-history.json` entry.
>
> **~17,280 op-history entries per day, per stuck record, indefinitely**, each with a lease cycle and
> a hubSeq burn. This is an unbounded resource leak, not a stalled write — and note the shape of it:
> a guard written *specifically* to prevent "re-sent forever" is disarmed by a second guard two files
> away, and each is locally correct.
>
> **Not yet fixed.** The fix lives in `replica.ts`/`todos.ts`, the same code region as D27's
> unconditional `delete base.pendingSince`, so one owner must hold both — the two are the same
> question (*when may `pendingSince` legitimately clear?*) approached from opposite directions.
> **D27 and D35 must be resolved together, or a fix for either will look complete and leave the other
> live.**
>
> **CORRECTED 2026-08-23, same day — step 2 above names the wrong dead end, and the correction
> matters because it invalidates the obvious fix.** `todos.ts:912`/`:936` are inside
> `markStartedWithClaim`'s **synchronous** claim path (`askHubToConfirm` -> `options.confirmStart`),
> and **`confirmStart` is never wired to a real implementation anywhere in `src`** — only the type and
> the two call sites inside `todos.ts` itself. So today every clustered claim takes the `!ack` branch
> and **those two lines are unreachable from any call in the codebase.** Relaxing them, which is what
> the entry above implies, would not have reached the leak at all.
>
> The real dead end is `spoke-runtime.ts#applyAck`, and it discards the answer **on purpose**:
>
> > `throughHubSeq` is the ONLY thing that may retire an owed op (never `results`, which exists for a
> > **future** synchronous claim-confirmation correlation, not for outbox bookkeeping)
> > — `spoke-runtime.ts:311-313`
>
> That "future" work was never built. `results[]` arrives on every ack fully populated by the hub
> (`opId`, `hubSeq`, `accepted`, `fields?`, `reason?`) and is read by nothing.
>
> **And case 3 is two defects, not one.** They have different triggers and are NOT fixable by the same
> mechanism:
>
> - **3a — a REJECTED op** (a claim collision, `already-started`; the only real todo-op rejection
>   besides the `forged-author` security refusal). The ack carries `accepted:false` **with the
>   winner's `fields`** — the wire already carries everything needed to settle it.
> - **3b — an ACCEPTED op permanently excluded from the replica to its own origin** (D29's oversized
>   record). The ack says `accepted:true`, because it *was* applied. **Nothing on today's wire
>   distinguishes this from a normal accepted op that will replicate a moment later.**
>   `ClusterAckResult` has no field for "you will never get this back". Unclosable from the ack by
>   construction.
>
> **RESOLUTION — 3a needs no new mechanism; connect-time replay closes it.** Traced: a losing
> claimant can only exist if it claimed BEFORE receiving the winner's op (`markStartedWithClaim`
> checks `if (item.startedTaskId)` first), so its watermark is necessarily below the winner's
> `hubSeq`. The reason it does not self-heal today is that `planReplicaFanout` fans out
> `input.applied` — **this frame's accepted ops only** — so a historical op above a node's watermark
> is never re-shipped by the live path. That is exactly and only the replay gap. Under B4's Design B
> the scan finds the winner's record, ships it as an ordinary replica, and D27's logic settles it.
>
> **So the `opId -> entity` correlation map in `spoke-runtime.ts` was considered and REJECTED.** It
> would relax an invariant that file's docblock states three separate times (it never holds a
> sent-but-unacked queue, which is what makes an outage harmless) in order to solve a problem an
> already-planned piece solves for free. A `replica.ts` settlement helper was likewise rejected as
> premature: with 3a closing via replay it would have **no caller**, which is the precise pattern that
> put 1,500 lines of green unreachable code on this branch.
>
> **3b stays OPEN and is recorded as a contract question**, with two candidate shapes:
> 1. A field on `ClusterAckResult` (`replicable`, or `excludedFrom`) — which forces the hub to compute
>    the fan-out exclusion set **before** building the ack, a reordering in `hub-router.ts`, not just a
>    schema addition.
> 2. **Refuse it at the source** — have `deriveTodoOps` decline to derive an op that could never fit a
>    frame, and mark the record un-syncable locally with a visible reason. No wire change at all: the
>    record never enters the outbox, never leaks, and the person who wrote a 256 KB todo is told so,
>    instead of the failure surfacing three components downstream as a silent exclusion.
>
> **Recommendation: (2), fail fast where the size is created rather than late where it is
> discovered.** Not built — it changes local write behaviour and should be an owner decision rather
> than something slipped in mid-milestone.
>
> **D30 — the hub-side watermark can jump past ops it never sent, and the race is structural.**
> `advanceWatermark` jumps to the frame's max `hubSeq`. A node at watermark 5 with 6-11 owed, when a
> live batch allocates 12: `owedFor` filters `op.hubSeq > 5` so the frame carries only op 12, the
> frame is sent, and the watermark jumps **5 -> 12**. The hub now asserts the node holds 6-11. It does
> not, and the only thing that ever re-seeds truth is that node's next `hello`. Three facts make the
> window real rather than theoretical:
> 1. **A node is in `connectedNodes()` BEFORE it has said `hello`** (`link-server.ts:196` sets the map
>    at connection setup; `connectedNodes()` is `[...this.nodes.keys()]`), so a concurrent `ops` frame
>    from another node fans out to a node whose position the hub has not yet learned.
> 2. **The `hello` handler awaits after seeding** — it seeds the watermarks, then
>    `await readPeers(...)`. An `ops` frame handled during that await advances the watermark, and a
>    replay computed after the await reads the advanced value and finds nothing owed.
> 3. **The `watermarks` Map is never cleaned on disconnect.** `link-server.ts:204-206` deletes the
>    node from `this.nodes`; the router's closure Map keeps the entry. With (1), the pre-`hello` window
>    uses a **stale, too-high** watermark from the previous session — and since a spoke's own position
>    resets to 0 on restart (`spoke-runtime.ts:196`), "too high" is the overwhelmingly likely case.
>
> **B4 cannot be considered done without fixing D30**, or replay repairs the steady state while the
> race re-opens the hole on the very next reconnect — invisible to a green suite, which is this
> branch's signature failure. The two pieces: gate a node out of live fan-out until its replay has been
> dispatched, and drop its watermark entry on disconnect.
>
> **Why none of this was caught:** every one of these modules is unit-tested in isolation and passes.
> D27 needs a receiver with its OWN pending edits, D28 needs a writer that fails, D29 needs a realistic
> record SIZE rather than a realistic record count, and D30 needs two nodes and a reconnect. No
> single-module suite has any of those, and the integration test that would has never existed because
> the wiring (B3) has never run.
>
> ### D34 — THE LINK PATH HAD NO PAIRING GATE AT ALL. Found and closed 2026-08-23.
>
> **Nothing on the link path checked that a sending node was paired with the project it was writing**,
> while the HTTP `/cluster/todos/*` family gates exactly that, both ways, and calls it D20's closing
> rule (`cluster-routes.ts:356-364`). `hub-router.ts`'s `ops` case and `applyOpsFrame` went straight
> to `applyOp`. So **a node refused project P over HTTP could write P over the socket.** Two halves,
> both now landed:
>
> - **B3's half** — `startClusterRuntime` resolves each op's dataDir through
>   `resolveHubTodosRoot(op.projectKey, op.nodeId, env)`, the same both-ways-confirmed gate.
> - **The half without which the first is decorative** — `resolveHubTodosRoot` authorizes against
>   `op.nodeId`, which is **frame body, not authenticated identity**. A node that forges that field
>   borrows another node's pairings. `hub-router.ts` now refuses any op whose `op.nodeId` disagrees
>   with the id the upgrade authenticated — the `hello` guard's principle one layer down, and checked
>   in code rather than in the schema for the identical reason: no schema constraint can express
>   "equal to a value carried on a different layer".
>
> **A consequence nobody had flagged:** `op.nodeId` is also what `hub-apply.ts` stamps an accepted
> D9a claim's `startedOn` from, and `startedOn` is what the cockpit renders as "started on <node>".
> So a forged author is not only an authorization bypass — it is a run durably attributed to a machine
> that never made it.
>
> **Three design decisions, made deliberately rather than by default:**
> 1. **Refuse the op, do not filter it out.** The guard fires at the `applyOp` seam, where a verdict
>    can be RETURNED. Filtering the frame up front would leave the op with no `results` entry, which
>    `hub-ops.ts` defines as a GAP — so the spoke would keep it owed and resend it every flush tick
>    **forever, for a verdict that can never change.**
> 2. **A returned rejection, never a throw**, by `hub-ops.ts`'s own test — "retrying does not change
>    the state that produced it". The state is the op's immutable `nodeId` against this socket's
>    authenticated identity; neither moves. Note a retransmit never even reaches the guard:
>    `findAppliedOp` answers from the cached verdict first — **which is why a future op-RELAY design
>    would have to invalidate those cached verdicts, not merely relax the guard.**
> 3. **One warning per FRAME, never per op.** A frame may legally carry 500 ops, so a per-op line lets
>    a single misbehaving node flood the log 500 entries at a time — denial of the record, by a sender
>    already misbehaving. The message names both sides, because that IS the content of a security
>    event: which credential sent the frame, and whose name it wrote under.
>
> **And one bound that was checked rather than assumed, which is the detail worth copying.** The
> refusal string embeds two node ids. `clusterAckResultSchema.reason` is `.max(200)`
> (`contract/src/cluster.ts:1512`) and `clusterNodeIdSchema` is `.max(64)` (`:118`), so the worst case
> is **exactly 178** — verified by construction, not by eye. Had it exceeded 200, the SPOKE's parse of
> the whole downlink frame would fail, **taking every other op's verdict in that ack down with it**:
> an error message long enough to destroy the report of the errors around it. Any generated `reason`
> on this wire needs the same arithmetic.
>
> Covered by four tests (21/21 in `hub-router.test.ts`, up from 17): refused-never-applied-never-
> replicated; only the forged op refused while an honest op in the same frame still applies and
> replicates; the refusal is DURABLE (`throughHubSeq` advances past it so the spoke stops owing it);
> and warns exactly once per frame naming every distinct claimed id.
>
> ### THE OTHER FIVE MODULES' MUTATION CLAIMS WERE AUDITED, AND THEY HOLD — 2026-08-23
>
> Because `hub-apply.ts` was reported "done" in the table above and turned out to have no mutation
> testing at all, **every other module's self-reported mutation count was treated as an unaudited
> claim of the same kind** and independently re-tested. Guards were chosen by "what silently loses
> data or fabricates a durable verdict if this is wrong", not by what was easiest to mutate.
>
> **Result: 16 mutations across 5 modules, 16/16 RED. No GREEN. The claims check out.** That is a
> more useful result than it sounds — it means `hub-apply.ts` was the outlier rather than the norm,
> so the rest of the milestone's evidence can be relied on. Highlights, each reproducing a hazard the
> module exists to prevent: `hub-seq` restart persistence (`expected 1 to be greater than 7`);
> `hub-ops` gap-stops-the-watermark, thrown-op-fabricates-no-verdict, and rejected-op-still-recorded
> (which reproduces the false-conflict replay bug from the allocator side); `op-history`'s
> `find()` poisoned-key gate (the same hazard from the durable-cache side); `replica-fanout`'s
> count-split dropping an op (`expected […(199)] to have a length of 200 but got 199`);
> `spoke-runtime`'s ack watermark monotonicity, where an out-of-order ack un-acks a higher one.
>
> **THE METHOD LESSON, which is the durable part.** The auditor did **not** find D29 in its own
> mutation pass, and said so unprompted: it had been *"pattern-matching 'what property does the
> docblock assert' rather than cross-checking against the sibling module `ops.ts` and the contract's
> own stated bounds."* Generalized: **auditing a module against its own docblock can never find a
> guard the docblock does not claim** — the docblock is written by the same author at the same time
> with the same blind spot, so it cannot be the oracle. What found D29 was reading the *mirror-image
> sibling on the other direction of the same wire* and the *shared contract*, neither of which shares
> the module's blind spot. Use those as the oracle when auditing anything on this wire.
>
> **One untested corner, surfaced rather than chased:** `spoke-runtime.ts#flushOps` does
> `if (outcome === 'link-down') { linkDown = true; break; }`, which stops iterating the REMAINING
> projects. No multi-project test exercises that early break, so what a link-down mid-sweep does to
> the projects after it is unpinned. Not a disproven claim — an absent one.
>
> ### REMAINING WORK, in the order it has to happen
>
> Nothing below is blocked on the owner except where it says so.
>
> **B1. Tests for `hub-router.ts`'s replication path. — DONE 2026-08-23 13:18.** ~~Six cases listed
> above. Do this FIRST — the code is written and unproven, and every hour it sits there is an hour the
> green suite is lying about it.~~ All six exist, plus a seventh for scope keying; 17/17; each
> mutation-checked RED with the failure quoted; `hub-router.ts` unchanged (md5 verified before and
> after). Case 6 ("no replication wired -> warns, returns `[]`") already existed in the pre-existing
> `ops` block and was deliberately not duplicated. **No bug was found in `hub-router.ts`** — every
> mutation that produced a red mapped to a hazard the module's own docblocks already name.
>
> Carried forward to B3: these tests use fakes for every `HubReplicationDeps` member, so the real
> allocator, applier and verdict cache are still unexercised end to end.
>
> **B2. `hub-apply.ts` — DELIVERED 2026-08-23, but held to a lower standard than its five siblings,
> and that difference matters.** The agent writing it was stopped along with 57 others before it
> reported, so the file landed with no written account of itself. Verified by hand instead: 331
> lines, not truncated (it ends on a complete function), `npm run typecheck` green across all four
> workspaces, its own suite **11/11**, full cluster directory **591/591**. It exports
> `applyOpAtHub(dataDir, op & { hubSeq }, options)` and `createHubApplyOp(dataDir, options)`, the
> latter typed directly as `HubOpsDeps['applyOp']` — so it is drop-in for B3 with no adapter, and the
> `projectKey -> dataDir` mapping is deliberately left to the caller.
>
> **What is missing is not code, it is evidence.** Every other module in this milestone had its
> guards mutation-tested — a guard removed, the red captured, the file restored and md5-verified.
> `hub-apply.ts` has none of that, so its passing tests prove only that the tests agree with the
> code, which is the weakest thing a green suite can mean. Before B3 wires it into a path that
> mutates the hub's real todo store under a lease, mutation-check at least: the lease being taken at
> all, the read-fresh-inside-the-lease ordering, and whatever decides `accepted: false` (the D9a
> claim-already-won path, which is the one whose verdict travels back to a spoke as authority).
>
> **DONE 2026-08-23 13:30 — and the mutation pass paid for itself immediately: it found THREE real
> bugs, two of them serious.** The suite went 11/11 -> **18/18**, seven new tests. Verified by the
> orchestrating session independently of the agent's own account: `hub-apply.test.ts` 18/18, and the
> whole `packages/cezar/src/cluster/` directory **604/604 across 30 files** with the fixes in the
> tree. This is the concrete answer to "what is a green suite worth on a module nobody mutation-
> tested" — it was worth three bugs, on a module already reported as done.
>
> **D31 — a claim could be granted with NOTHING WRITTEN, which is the double-start this module
> exists to prevent, arriving THROUGH its guard rather than around it.** The staleness guard
> (`op.hubSeq <= existing.hubSeq -> { accepted: true }`) ran after the claim check, and the module's
> docblock argued that ordering made it safe. **The ordering argument covered only a claim that
> LOSES.** It left the mirror case open: a claim on a still-UNCLAIMED row, where an ordinary field op
> from another node reached the lease first and carried the record's `hubSeq` past the claim's own.
> That claim passes the conflict check (nobody holds it), then meets the staleness guard and is
> answered `{ accepted: true }` with no write and no `fields` — and **`accepted` is precisely the
> spoke's permission to START** (`todos.ts#markStartedWithClaim` calls `start()` on it). The hub
> grants a run it holds no record of, and grants the NEXT node's claim on the same row identically.
> Fix: a claim never takes that exit (`!claiming && …`), because *"nothing to re-apply" is true of a
> field patch, whose value is already on the record; it is never true of a claim, whose whole purpose
> is to BECOME the record.* A companion guard keeps `max(existing.hubSeq, op.hubSeq)` on write so an
> out-of-order claim cannot regress the record's hub order.
>
> **D32 — an unreadable `todos.json` was REPLACED BY A SINGLE ROW.** `readTodosRaw` answered `[]` for
> ANY read failure, and its caller writes the whole array straight back. Answering `[]` is survivable
> for a reader — `todos.ts#readRaw` does exactly that — and destructive for a read-modify-write.
> **The production shape is not hypothetical on this project's own box:** a `todos.json` left owned by
> `root` in a `cezar`-owned directory fails the read and still passes the `rename`, because rename
> needs write permission on the DIRECTORY, not on the file. That is the same root-ownership failure
> mode this workspace's doctrine already warns about for the corpus, reappearing where it destroys
> data instead of merely blocking a rewrite. Fixed to `ENOENT` only, and to THROW otherwise —
> deliberately a throw and not a rejection, because an I/O failure is transient and `hub-ops.ts`
> leaves a gap the spoke resends.
>
> **REPRODUCED, not reasoned — 2026-08-23.** The orchestrating session ran the mechanism rather than
> accepting the argument, because "read fails but rename succeeds" is the kind of claim that sounds
> right and is worth ten seconds to settle:
>
> ```
> write todos.json  ->  [{"id":"real-1","summary":"REAL DATA"}]
> chmod 000 todos.json
> read  of the unreadable file   ->  EACCES
> rename OVER the unreadable file ->  SUCCEEDED
> file now contains               ->  [{"id":"replacement","summary":"ONE ROW"}]
> ```
>
> So with the pre-fix `catch { return []; }`, a `todos.json` this process could not read was
> **silently replaced by a single row.** Not a hypothetical: the permission asymmetry is real,
> because `rename(2)` needs write permission on the DIRECTORY and none on the file it replaces.
> The matching production shape on this project's own box — a corpus/data file left owned by `root`
> in a `cezar`-owned tree — is already documented workspace doctrine as a thing that happens, and
> the doctrine only ever warned that such a file *cannot be rewritten by the app*. This is the same
> ownership fault one layer along, where it does not block the write but **destroys the data**.
> Worth carrying beyond this spec: any read-modify-write whose read degrades to "empty" turns an
> unreadable store into an erased one, and `todos.ts#readRaw` has exactly that shape (correctly, for
> a pure reader — the hazard is created by the CALLER that writes the result back).
>
> **D33 — an empty-string `startedTaskId` would have wedged a todo against every future claim.**
> `todoSchema` types it as a bare `z.string().optional()` with no `min(1)`, so `''` stores;
> `todos.ts#markStartedWithClaim` tests `if (item.startedTaskId)` and therefore reads `''` as
> UNCLAIMED and goes on to ask the hub — while `hub-apply.ts` tested `!== undefined` and would have
> read `''` as a HOLDER, refusing every claim on that row forever and naming a winner of `''`. One
> concept decided at two points, in two files, disagreeing.
>
> The original evidence gap, kept because it is the reason all three were found:
>
> Its remaining historical note, kept because the contract is what it is: `op-history.ts` DOES: delivered
> 2026-08-23, 393 lines, **16/16**, and verified by hand against both things that were flagged as
> easy to get wrong. It throws when `record(opId, result)` is called with `result.opId !== opId`
> rather than reconciling them (`ClusterAckResult` carries `opId` inside the value as well as being
> the key, so a mismatch is a corruption signal, and failing closed is the only safe reading), and it
> stores an `at` timestamp alongside each verdict, which is what makes `prune` /
> `OP_HISTORY_RETENTION_MS` possible at all — the verdict shape itself has nowhere to put one.
> `find` deliberately THROWS on a corrupt entry instead of answering `undefined`, because
> `undefined` means "never applied" and would let the hub re-derive a fresh verdict for an op it had
> already decided; the throw propagates out of `applyOpsFrame`, which is exactly the "thrown op gets
> no ack, outbox resends" path.
>
> So B2 is now only `hub-apply.ts`. Its contract is already fixed by `hub-ops.ts`'s `HubOpsDeps`:
> `applyOp(op & { hubSeq }) => Promise<HubOpOutcome>` where `HubOpOutcome = { accepted, fields?,
> reason? }`. Reuse `applyHubReplica`'s MECHANISM (`withTodosLease`, `applyOpToRecord`,
> read-fresh-inside-the-lease) and not its shape — it is batch-shaped and computes corrections for a
> spoke against the hub's authority, whereas this is the other direction, one op at a time, and must
> return a per-op verdict. Check `git status` before writing it; agents on this branch have landed
> files after being reported as not delivered.
>
> **B2a. Nothing ever calls `prune()`, so the 30-day retention policy is currently a no-op.**
> Measured 2026-08-23: **zero callers** outside `op-history.test.ts`. `OP_HISTORY_RETENTION_MS` is
> documented, tested at its boundary, and never invoked, so `op-history.json` grows without bound for
> the life of the hub. Someone has to schedule it — the natural place is alongside whatever else
> `startClusterRuntime` arms. Note the module's own warning before picking a cadence: pruning too
> aggressively REOPENS the double-apply bug the store exists to prevent, because a pruned verdict is
> indistinguishable from an op that was never seen.
>
> **B2b. `record()` deliberately does NOT inherit `hub-seq.ts`'s poisoned-key gate, and that is not
> an oversight.** Written down here because it looks like an inconsistency between two sibling files
> and a future reader will otherwise "fix" it into consistency. `hub-seq.ts` guards `allocate()` on a
> poisoned key because computing the next counter requires trusting the old value.
> `op-history.record()` wholesale-replaces one `opId` with an already-decided verdict and needs no
> old value at all — so refusing to overwrite a poisoned entry would prolong the corruption forever
> with no benefit, and would remove the only path short of hand-editing the file that can heal it.
> Whole-file corruption still refuses `record()`, because merging into unparseable JSON would
> silently discard every other entry.
>
> **B3. Construct the deps in `startClusterRuntime` — DONE 2026-08-23. THE HUB NOW ACKS.**
>
> `cluster-routes.ts:1112` now reads
> `onFrame: createHubFrameRouter({ identity, env, warn, replication })`. A new exported
> `buildHubReplication(identity, env, warn, linkServer)` (`:949`) builds one `HubSeqAllocator`, one
> `OpHistoryStore`, and an `applyOp` resolving `resolveHubTodosRoot(op.projectKey, op.nodeId, env)`
> **per op** — never a fixed dataDir — throwing rather than returning `{accepted:false}` for
> `scope !== 'project'` or an unresolvable pairing. The construction-order cycle is closed with a
> `linkServer: () => ClusterLinkServer | undefined` getter.
>
> **THE PROOF, which is the thing this branch never had.** The wiring was deleted from the production
> call site and the end-to-end test — a real `ops` frame over a real socket — failed:
>
> ```
> cluster hub: ops from "spoke-1" (scope project, project project-hub-e2e, 1 op(s))
>   — no replication wired on this hub, not applied, no ack sent
> x B3: a real ops frame is replicated end to end — ack, durable write, replica after the ack
>   AssertionError: expected undefined to be defined
>   Tests  1 failed | 4 passed (5)
> ```
>
> **Run twice — by the implementing agent, then independently by the orchestrating session** — with
> `cluster-routes.ts` restored to md5 `415b165647d50aacfa1e09efba9333b9` both times. This discharges
> the D24 lesson: a unit test of `buildHubReplication` structurally CANNOT see this, because it never
> touches the call site. Only deleting the wiring and watching production behaviour change can.
>
> Also RED: the per-op dataDir mutation (hardcode one project) gives
> `expected [ 'row-a', 'row-b' ] to deeply equal [ 'row-a' ]` — project B's write landing in project
> A's `todos.json`, the exact bug a fixed-dataDir closure would have shipped.
>
> **B2a shipped with it:** `OP_HISTORY_PRUNE_INTERVAL_MS = 24h`, one immediate sweep on arm (the one
> that will actually run, given ~10 restarts/day), `setInterval` `.unref?.()`'d and `clearInterval`'d
> in teardown, with a mandatory `.catch()` because `prune()` rejects on whole-file corruption and an
> unhandled rejection in a timer callback has no caller. Negative control RED. **`prune()` had zero
> production callers for the life of the branch; it has one now.**
>
> The original text, kept: this is the wire that makes any of Milestone B real. `allocate` <- `createHubSeqAllocator`; `applyOp` <-
> `hub-apply.ts`; `findAppliedOp`/`recordAppliedOp` <- `op-history.ts`; `sendTo`/`connectedNodes` <-
> `ClusterLinkServer`. Until this exists, `deps.replication` is `undefined` everywhere in production
> and the hub still warns and never acks — i.e. **Milestone B is not shipped no matter how green the
> unit tests are.**
>
> How dead this code currently is, measured rather than estimated (2026-08-23, `grep -arn` with a
> QUOTED `--include='*.ts'` — an unquoted one is eaten by zsh and reports "no matches" for
> everything, which reads exactly like a real zero and cost this session one wrong answer):
>
> **RE-MEASURED 2026-08-23 AFTER B3 — every one of these now has a real production caller.** The
> original table is kept below because it is the record of what "1,500 lines of tested, unreachable
> code" looked like, and because the shape recurs. Current counts, same method (`grep -arn`, QUOTED
> `--include='*.ts'`, test files excluded):
>
> | symbol | production callers NOW |
> |---|---|
> | `createOpHistoryStore` | 2 — `cluster-routes.ts:956` (replication) and `:1091` (prune timer) |
> | `applyOpAtHub` | 1 — `cluster-routes.ts:977` |
> | `createHubSeqAllocator` | 1 — `cluster-routes.ts:955` |
> | `OpHistoryStore.prune` | 1 — `cluster-routes.ts:1096` |
> | `OP_HISTORY_PRUNE_INTERVAL_MS` | 1 — `cluster-routes.ts:1105` |
> | `applyOpsFrame` / `planReplicaFanout` | reached via `hub-router.ts`, whose `ops` branch is now ENTERED |
>
> `createHubApplyOp` remains at **0** and that is now correct rather than a gap: B3 calls
> `applyOpAtHub` directly, because the factory closes over ONE `dataDir` and the hub must resolve a
> dataDir per op. The spec's earlier "drop-in for B3 with no adapter" was true only for a
> single-project hub.
>
> The pre-B3 state, kept verbatim:
>
> | symbol | callers outside its own file + test |
> |---|---|
> | `createOpHistoryStore` | **0** |
> | `createHubApplyOp` / `applyOpAtHub` | **0** |
> | `createHubSeqAllocator` | **0** |
> | `OpHistoryStore.prune` | **0** |
> | `applyOpsFrame` | 1 — `hub-router.ts` only |
> | `planReplicaFanout` | 1 — `hub-router.ts` only |
>
> So three of the delivered modules have no caller at all, and the two that do are reached only
> through the `hub-router.ts` branch that nothing enters. Roughly 1,500 lines of tested, unreachable
> code. That is a fine state to be in mid-milestone — it is NOT a state to describe as "Milestone B
> is done bar the wiring", because the wiring is the part that has never been executed even once.
>
> **B4. Connect-time replay** — ~~`resumeFrom` from `oplog.ts#readOps`~~. See above for why this is
> not optional for a real two-machine cluster: without it, any spoke restart or network blip drops
> writes permanently and silently.
>
> **CORRECTED 2026-08-23 — `oplog.ts` is very likely the WRONG source, and naming it made B4 look
> like one task when it is at least two.** Two things measured rather than recalled:
>
> - **`appendOps` has ZERO production callers.** `grep -arn --include='*.ts' "appendOps" packages/`
>   returns only `oplog.test.ts`, one docblock line in `ops.test.ts`, and the compiled
>   `dist/cluster/oplog.d.ts`. So **the hub's op log is never written**, and a replay reading it would
>   return empty forever *while looking implemented* — `resumeFrom: []` again, now with code behind it
>   and no warning attached. Note this is the same shape as the empty `resumeFrom` it was meant to
>   fix: indistinguishable on the wire from "you are caught up".
> - **`oplog.ts`'s own docblock disqualifies it for the job.** It describes the file as the SPOKE's
>   outbox cache, states that "losing it is survivable by design" because the truth is the records
>   marked `pendingSince` and `deriveTodoOps` re-derives them, that the append path "may be fast and
>   un-fsynced", that a torn last line is dropped on read by per-entry salvage, and that it takes
>   **no cross-process lease, deliberately**. Every one of those is defensible for a re-derivable
>   cache and indefensible for a replication log: a dropped line there is a permanently missed write
>   on a spoke, with nothing to re-derive it from.
>
> So B4 is a design choice that has not been made, not a wiring task. The two candidates, being
> evaluated 2026-08-23:
>
> **A — a durable hub-side op log.** Append every accepted, `hubSeq`-stamped op; replay above each
> watermark. Either `oplog.ts` gains a lease, an fsync and a second durability contract (which would
> change its spoke behaviour too), or this is a new module. Carries its own retention problem, which
> has to be reconciled with `op-history.ts`'s.
>
> **B — replay from CURRENT STATE, with no log at all.** Scan the hub's own `todos.json` for records
> whose stored `hubSeq` exceeds the node's watermark and synthesize replica frames from present
> values. Replica application is last-writer-wins by `hubSeq` and idempotent, so a spoke that missed
> three successive edits to one field needs only the LATEST value — the intermediate ops are not
> information it can act on. And a delete is a tombstone that STAYS in the file, so unlike most
> state scans this one is not blind to deletions. **This design lives or dies on whether stored todo
> records actually persist a per-record `hubSeq` through `storedTodoSchema`** — if they do not, it is
> dead, and that check is the first thing to run.
>
> Whichever wins, two hazards are already known and neither is optional:
> - **`resumeFrom` rides inside ONE `welcome` frame.** A node away long enough overflows it, and a
>   truncated `resumeFrom` that the spoke reads as complete is the same silent-loss bug in a new
>   place. `clusterWelcomeFrameSchema` may not be able to express "there is more" today.
> - **The negative control must fail when `resumeFrom` silently returns to `[]` or to a truncated
>   list.** "A spoke reconnects and is caught up" is not that test — it passes when nothing was
>   missing, which is the usual case.
>
> **DECIDED 2026-08-23 — Design B, replay from current state, and B4's real content is now four
> fixes rather than one feature.** Design A is rejected on three measured grounds, not on taste:
> its source module is disqualified by its own contract and rewriting it to qualify breaks its
> spoke use; its retention needs exactly the durable per-node watermark this design deliberately
> refuses, so a node that never returns pins the log forever; and **the dominant replay case is
> "from 0", not "from N-1"** (a spoke's `ackedThroughHubSeq` is in-memory, so every restart resets
> it), which is precisely where a log's cost is unbounded and a state scan's is flat. The asymmetry
> settles it: a state scan systematically OVER-sends, which is free, while a log under-sends
> whenever a line is lost or an append races a compaction, which is the expensive direction.
>
> Design B survived its own checks: records do persist `hubSeq` and it is monotonic per record;
> tombstones stay in the file; and `clearedFields` deletions replay **better** from state than from a
> log, because an absent key reproduces the absence exactly.
>
> **The four fixes B4 must carry, and they are the same defects listed above:**
> - **F1 = D27.** A replay may not clear or overwrite a field named in the receiver's own
>   `pendingFields`. Without this, B4 makes things strictly WORSE: as literally specified, a
>   whole-record replay converts "the spoke is missing a remote write" into "the spoke loses its own
>   local writes", across the spoke's whole board on every restart.
> - **F2 = D29.** A byte budget in `planReplicaFanout`.
> - **F3 = D30.** Live fan-out must not advance a node's watermark past an unfinished replay, and the
>   watermark entry must be dropped on disconnect.
> - **F4 = D28.** The origin path must check delivery before advancing, and `link-server.ts:248` must
>   stop discarding `writeFrame`'s return value.
>
> **Where Design A would still be right, recorded so this is not read as "a log is never needed":**
> if `run`/`triage` stores ever land and carry ops whose effect is an EVENT rather than a value, or if
> replaying a REJECTED claim becomes a requirement — a rejection writes nothing to state
> (`hub-apply.ts` returns `{accepted:false}` and only accepted ops fan out), so it is recoverable from
> a log and structurally unrecoverable from a scan. Both are Milestone C/D territory.
>
> **B5. Resolve the duplicated `toNodeWire`/`toPairingWire`** between `hub-router.ts` and
> `cluster-routes.ts`. Two copies of one projection, already known to be a drift risk; a field added
> to one is a field silently missing from the other.
>
> **B6. Full gate on the box, on a manifest-verified tree.** Method and the one standing red (C18)
> are in "The state to hold in your head" below. Do not gate on the Mac and do not gate a moving
> tree — both cost this session a full run.
>
> **Then, and only then:** Milestones C and D, which are entirely unbuilt, and the ops sequence
> (merge -> deploy -> `cez cluster init` -> `CEZ_CLUSTER=1` -> join code -> Access policy) whose
> first step is the owner's.
>
> ### Where the code stands
>
> Landed and green this session: hub-router, spoke-runtime, edge-auth (D23), the auth-wall seam
> (D24), enrollment roster row (D25), reconcile-wiring, the CLI entry guard, relay affordance fixes
> (`spoolDir` + widened `LOCAL_PATH_RE` + producer-side `name`/`url` projection in `run.ts`), the
> link activation wiring, and the handshake-wedge fix (D26).
>
> **CORRECTED 2026-08-23 13:11 — everything IS committed and pushed.** ~~Nothing is committed yet.
> 28 files dirty, 13 untracked. Commit message drafted at `<scratchpad>/commitmsg.txt`.~~ That was
> true when written and is not now. The working tree is **clean**, `HEAD` is `961ebcd3`, and it is
> level with `origin/feat/multi-node-cluster` (`git rev-list --left-right --count` -> `0 0`).
> **PR #9 is open** — https://github.com/MarcinWalendowski/cezar/pull/9 — and is NOT merged. Do not
> merge it: it auto-deploys to `prod-host`, where the owner's agents run, and that is the
> owner's call.
>
> ### THIS CHECKOUT HAS MORE THAN ONE LIVE SESSION IN IT, AND THE OTHER ONE COMMITS
>
> **Recorded 2026-08-23 13:08 because it is invisible until it bites.** A second, unrelated Claude
> session was working this same branch in this same checkout at the same time as the session writing
> this, and it **committed and pushed** `961ebcd3` ("feat: hub-side per-op apply (hub-apply.ts),
> delivered unreported") mid-read — the spec file changed under an open read, and `git status` went
> from two untracked files to clean, with no action from this session.
>
> That is not a curiosity, it is a hazard with two sharp edges:
>
> - **A mutation check is a window in which broken code sits in the shared tree.** The house method
>   is: break the source, watch the test go red, restore from a scratchpad copy, verify the md5. If
>   the other session runs `git add -A` inside that window, the *mutation* is what gets committed and
>   pushed. Keep the window to a single test run, restore immediately, and re-check the md5 of a file
>   you are about to mutate as well as after — not only after.
> - **Do not `git pull`, rebase, or restore a stale scratchpad copy over a file that moved.** A
>   scratchpad copy is a restore for YOUR OWN mutation, never a general-purpose revert; writing it
>   over another session's edit silently reverts work that nothing will report as missing.
>
> The already-standing rule (never `git stash` / `git checkout .` / `git reset --hard` /
> `git clean -fd` here) exists for the same reason and is now doubly load-bearing: `git clean` would
> have deleted `hub-apply.ts` outright during the ~2 hours it sat untracked.
>
> ### Gate status — run gates on the BOX, never the Mac
>
> The Mac sits at load ~10 and produces timing flakes (`workspace-parallel`, `cluster-flag-off`
> both flake there and both pass on the box).
>
> **CORRECTED 2026-08-23 — do NOT use `rsync --files-from` for this.** The method below used to read
> *"`git ls-files -co --exclude-standard` -> `rsync --files-from` to `/var/lib/cezar/gate-cluster/`"*,
> and following it is how I contaminated the PEER's `/var/lib/cezar/gate-retarget` the same day: a
> file-list rsync **merges** with whatever is already there rather than replacing it, and the mixed
> tree (their tests, my source) failed 23 times in a way that **named the wrong owner** — the side
> whose *tests* survive is the side that looks broken. Use instead:
>
> ```
> rsync -a --delete --exclude node_modules/ --exclude dist/ --exclude .turbo/ \
>   ./packages/ cezar@ssh-cockpit.example.com:/var/lib/cezar/gate-cluster/packages/
> ```
>
> **`/var/lib/cezar/gate-cluster` is THIS branch's dir; `gate-retarget` belongs to another session.**
> One owner per gate dir, and expect `--delete` to remove any `.log` you left there (which is correct
> — a stale log from a previous run is indistinguishable from the current one).
>
> `npm ci` is NOT needed when the three manifests already match — check first, it saves minutes:
> `md5 -q package.json package-lock.json packages/cezar/package.json` vs `md5sum` of the same on the
> box. Confirm the tree landed by comparing `find packages/cezar/src -name '*.ts' | wc -l` on both
> sides (718 = 718 on 2026-08-23). Connect as **`cezar@`, not `root@`**, or every file you write is
> root-owned in a cezar-owned tree; `find /var/lib/cezar -not -user cezar | wc -l` must stay 0.
>
> **Two box-only failures that are NOT gate failures.** `npm run build` dies in an rsync'd tree
> because `scripts/write-build-stamp.mjs` shells `git rev-parse HEAD` and there is no `.git` — and it
> dies *after* printing `check:pack ok`, so it reads like a real build break. And `--reporter=basic`
> is not a valid vitest reporter in this repo: it exits 1 with a startup error and no `Test Files`
> line at all, which also reads exactly like a failing gate.
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

**`throughHubSeq`: a RETURNED rejection and a THROWN error are not the same thing.** Settled
2026-08-23 in `cluster/hub-ops.ts`, and it is the difference between correctness and silent data
loss, because a spoke drops everything at or below this watermark from its outbox forever.

- `applyOp` **returns** `{accepted:false, reason}` — a considered, durable verdict (D9a: another node
  won the claim). It is resolved. It extends the watermark normally and appears in `results`.
  `todos.ts#markStartedWithClaim` already treats this as terminal (`TodoStartRefusal` carries
  `'hub-refused'`).
- `applyOp` **throws** — transient or infrastructural, never a business decision. This creates a
  **gap**: no `results` entry, nothing recorded, and the watermark stops at the last CONTIGUOUS
  resolved op *before* it, even when later ops in the same frame individually succeeded (those still
  get `results` entries; they just may not extend the watermark). A watermark cannot express a hole,
  so advancing past one tells the spoke an un-applied op is durable and it drops it forever.
- **Never convert a throw into a synthetic `accepted:false`.** That fabricates a permanent verdict
  for a temporary failure, which is exactly the loss above wearing a success costume.

**Replay needs a DURABLE per-`opId` verdict cache** — `cluster/op-history.ts`. Without it a
retransmit re-runs `allocateSeq` and `applyOp`, burning a second `hubSeq`, and for a claim op makes
it **collide with its own first application** and report "already claimed" against itself; the spoke
then declines work it legitimately owns. In-memory is not sufficient: the hub blue-green deploys
~10x/day, so a process-lifetime cache turns every restart into that bug.

**Known limitation, recorded rather than fixed:** the wire schema does not forbid two ops sharing one
`opId` **inside a single frame**. Idempotence lookups happen before any of that frame's writes land,
so both read as cache misses and both apply. The replay guarantee is about *the same frame arriving
twice*, not a duplicate within one frame.

**The hub-side watermark, designed 2026-08-23 while wiring.** `planReplicaFanout` needs each
target's `appliedThroughHubSeq`, and **no hub-side store for it exists** — the only watermark
plumbing today is spoke-side (`ops.ts#ackedThroughHubSeq`, `todos.ts#applyHubReplica`). The spoke
reports its watermarks on `hello`; `hub-router.ts` currently answers every one of them with "nothing
to resume" (`resumeFrom: []`).

The design taken: the hub keeps the per-node watermark **in memory**, seeded from that node's
`hello` and advanced as frames are sent. Deliberately not persisted, and that is safe in one
direction only — replica application is idempotent and a receiver drops anything at or below its own
watermark, so **over-sending costs bandwidth while under-sending loses a write**. A hub restart
forgets everything, the spoke reconnects, its `hello` re-seeds the truth, and the worst case is a
resend the spoke discards. Persisting it would add a durability problem (a watermark that outlives
the node's actual state claims the node is caught up when it is not) to buy nothing that `hello`
does not already provide.

`ClusterLinkServer.send(nodeId, frame)` is the fan-out channel — the router's return value only
reaches the node that sent the frame, so fan-out cannot ride it and the sender must be injected.

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
