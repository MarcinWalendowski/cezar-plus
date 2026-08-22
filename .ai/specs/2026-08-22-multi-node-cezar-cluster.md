# Two cezar nodes, one backlog: the Mac and prod-host as one cluster

**Status:** Proposed
**Date:** 2026-08-22

## TLDR

Two cezar cockpits already run against the same workspace — `prod-host` (12 registered
projects under `/var/lib/cezar/loki-labs`, always on, public through the tunnel) and the Mac (12
registered projects, 11 of them under `/Users/mw/loki-labs`, where the owner actually sits). They
share a backlog by **hand**: the 2026-08-17 corpus note says *"Both cockpits carry the same entries
with the same ids; a change on one side should be mirrored to the other."* Measured 2026-08-22, five
days later, that mirror has failed in the only direction it could: **110 todos exist on the box and
on neither Mac file, 10 more disagree about their status, and not one entry exists Mac-only.** The
Mac cockpit is a stale read-only window onto work it cannot see.

This spec makes the two cockpits **one cluster**: a hub (`hel1`) and spokes (the Mac, and any later
node) that dial out to it, replicate a small, explicit tier of state in near-real-time (measured
application-layer round trip Mac → box → Mac through the tunnel: **58 ms median**, n=10, min 56.8 /
max 59.0), take cluster-scoped leases for anything that starts work or spends a
shared subscription, and place a task on the node whose *capabilities* the task needs — macOS,
iMessage, a physical device, a browser — rather than on whichever host happened to be open.

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

### 2. A second node is worth having for *capability*, not for compute

It is tempting to frame this as capacity. The corpus already refutes that: *"cezar run speed is
round-trip bound, not box bound"* (measured 2026-08-21 — 61.5 min of run `ec6e8e06` was 65 % model
time at 1.00 tool calls per round trip; the box's own CPU was never the constraint). Moving a run
to a second host buys approximately nothing in wall clock.

What the Mac has that the box does not:

- **macOS and Apple services** — Messages.db, the `imsg` binaries, FindMy, Contacts, the TCC grants.
  Every device E2E in `AGENTS.md` → "Definition of Done" needs them, and the box cannot run one.
- **The Chrome bridge** and a real logged-in browser profile.
- **The owner's working tree**, including uncommitted work, and their keychain and git identity.
- **Presence** — the person is in front of it.

What the box has that the Mac does not: it is always on, it has a stable inbound address, it holds
the Cloudflare token and the 1Password service account, and it self-deploys.

So the cluster's job is **placement**, not load-spreading: a task that needs a Mac runs on the Mac,
everything else runs where it always did, and one board shows both.

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

### 4. Two nodes drain one subscription

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

One **hub**, N **spokes**. A spoke holds a single outbound WebSocket to the hub and never listens
for inbound connections.

```
   ┌──────────────── prod-host  (hub) ────────────────┐
   │  cockpit.example.com · always on · owns cluster leases │
   │  /var/lib/cezar/loki-labs/*   ·  the KB corpus         │
   └───────▲──────────────────────────────────▲─────────────┘
           │  outbound WSS (Cloudflare Tunnel)│
           │  58 ms median RTT, measured      │
   ┌───────┴────────────┐          ┌──────────┴───────────┐
   │  mac  (spoke)       │          │  future node (spoke) │
   │  /Users/mw/loki-labs│          │                      │
   │  labels: macos,     │          │                      │
   │  imessage, browser, │          │                      │
   │  device-e2e         │          │                      │
   └─────────────────────┘          └──────────────────────┘
```

Hub-and-spoke rather than peer-to-peer, for three reasons that are facts about this deployment, not
preferences: the Mac has **no inbound address**; the Mac **sleeps**, so a node that was away needs
somewhere durable to catch up from; and at N=2..5 a gossip mesh buys nothing and costs a discovery
protocol and an anti-entropy layer.

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

**D12 — Placement defaults to the authoring node, and an unmet requirement queues visibly.**
A todo may carry `placement: { node?: string; requires?: string[] }`. Labels are **discovered, not
configured** (platform, which agent CLIs are logged in, whether the Chrome bridge answers, hosted
mode) — the zero-config rule.

Resolution order: an explicit `node` pins; else `requires` narrows the eligible set; else **the node
that authored the todo**. That last clause is the one that matters, and "the hub" would have been
the wrong default: today a todo filed in the Mac's inbox runs on the Mac and one filed on the box
runs on the box, and defaulting to the hub would silently relocate half of them the day clustering
turns on. A default whose job is "nothing changes" must be written to say exactly that.

If no eligible node is online the run stays `queued` with a `queuedReason` naming what it is waiting
for, and **never silently runs somewhere else**.

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

**D14 — Node-local `maxParallel` stays node-local.** `WorkspaceSemaphore` protects *the host* —
"`maxParallel` and `memoryLimitMb` protect the host, not a repo". A cluster-wide parallel cap would
be a different feature with a different justification. The *account* grant (tier 2) is what bounds
shared spend; the two must not be conflated.

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
packages/web/src/routes/settings/cluster.tsx
```

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
- **Nothing in `runs/store.ts`.** `RunStore extends EventEmitter` and already emits `run`, `event`
  and `deleted`, so the run projection is an observer that `watch(store)`es it — the shape
  `provider-auth-runtime.ts` and `notifications/observer.ts` already use, wired through the same
  `onStoreCreated` / `onContextBuilt` hooks so it covers the boot context, every already-built
  context and every later one.
- `capabilities.ts` — `cluster: boolean`, **always present** and `false` when off, like every other
  capability key. Do not re-assert the "flag-off health body is byte-identical" claim: it was
  measured false and corrected in place in that file, and this key makes the body grow by one more
  pair. What opt-in buys is behavioural — no index, no watcher, no timer, no route, no nav item, no
  prompt bytes.
- `workspace-runs-routes.ts` — union the remote projection into the workspace runs list.
- `.env.example` — `CEZ_CLUSTER` and `CEZ_CLUSTER_HUB`, **in the same commit that introduces them**,
  plus the README env table since both are user-facing. The env contract has one documentation
  surface and an undocumented `CEZ_*` var is a bug, not an omission.

Nothing else. In particular `RunStore`, `RunRecord`, `RunStatus`, `StepStatus` and every existing
`.ai/cezar/` file format are unchanged.

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

Each phase is independently shippable and independently verifiable. The ordering is chosen so that
**no phase ever creates shared state without the lease that makes it safe.**

**Phase 1 — Identity and link (inert).**
`nodeId`, discovered labels, enrollment, outbound WS, presence, protocol-version handshake,
`capabilities.cluster`, the cockpit's Cluster panel showing peers online/offline and per-node
repo drift. **No state replicates.** Provisioning: a cockpit-app Access service token (see Problem
§7). Ship it and nothing about either cockpit's behaviour changes.

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

**Phase 4 — Placement and remote dispatch.**
`placement` on a todo, label matching, queue-with-reason, spoke-side `acceptsDispatch` opt-in,
workflow-by-value and the pre-dispatch freshness refusal (D12a), on-demand live event relay for a
foreign run.

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
POST   /api/v1/cluster/enroll               hub: mint a single-use code (admin-gated)
POST   /api/v1/cluster/join                 spoke: redeem a code (CLI-driven)
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
→ presence{ activeRuns, hostMetrics, repoDrift[] }
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
| **Enrollment grants code execution on the Mac** | outbound-only, `acceptsDispatch` off by default and spoke-enforced, per-node credential, two-sided revoke |

## Verification

Planned up front, per the workspace rule that verification is a design input.

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
    created under `~/.cezar/cluster` or `.ai/cezar/cluster`, `capabilities.cluster === false`, and
    the agent system prompt byte-identical.
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
(adds/updates/conflicts, duration). No analytics sink exists in this repo today — stated, not
invented; these are the names to use when one lands.

## Non-goals

Not HA and not failover — the hub is a coordination SPOF by design (D15 bounds the damage). Not
multi-tenant. Not a live-run migration. Not a second code-sync mechanism — git remains it. Not a
cluster-wide `maxParallel` (D14). Not replication of the KB corpus (D8).

**And not doctrine.** `CLAUDE.md` / `AGENTS.md` at the workspace root have their own record (the
box) and their own one-way transport (`tools/doctrine-sync`, pull-only by design, SPEC-531). Those
are repo files, which puts them in tier 3. The cluster must not become a second, bidirectional path
for them — that is precisely how the two copies became unrelated histories in the first place.

## Open questions for the owner

1. **Which node is the hub?** This spec assumes `hel1` (always on, addressable). The alternative —
   Mac as hub — inverts the reachability problem and is not recommended.
2. **Should the Mac accept dispatched work at all in v1**, or only be a place to *file* work and run
   device E2E on request? Default in this spec is off, opt-in.
3. **Cockpit-app Access service token, or ride the SSH tunnel?** A token on the cockpit app's policy
   is cleaner and independently revocable; the SSH tunnel needs no Cloudflare change.
4. **Do run *records* replicate in Phase 3, or is one merged board deferred?** Todos are the value;
   runs are the nice-to-have.
5. **Does this go upstream?** `open-mercato/cezar` is never pushed to, but this is a general
   feature. If it should stay fork-private, say so before Phase 1 — it changes nothing technically
   and everything about how the flags are documented.
