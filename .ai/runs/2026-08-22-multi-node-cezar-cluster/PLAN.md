# Plan — Eight tasks at once: bound the burst, then spread across nodes

| | |
|---|---|
| **Status** | Ready to dispatch, gated at Stage 0 |
| **Spec** | `.ai/specs/2026-08-22-multi-node-cezar-cluster.md` |
| **Base** | `292ed00a` (`main`) |
| **Repo** | `~/loki-labs/cezar` — push `origin` **only**, never `upstream` |
| **Shape** | 9 stages, ~41 packages, fan-out capped at 3 then 8 |

---

## Why this plan exists

The spec is 1 792 lines and describes six shippable phases across four packages of a published
npm module. Handing it to one agent produces one very long run that touches `todos.ts`,
`capabilities.ts`, `registry.tsx` and the contract barrel, and nobody can tell afterwards which
change was which. Handing it to eight agents at once produces eight agents editing
`packages/contract/src/index.ts`.

So this plan does two things the spec deliberately does not: it decides **who owns which file**,
and it decides **where the gate runs**. Everything else — what to build, why, and how it is
verified — is in the spec, and this plan never restates it. A package's prompt carries the spec
path and a phase name, not a summary. Summaries are where a plan and a spec start to disagree.

One property of this particular plan is worth stating out loud, because it is funny and it is
also load-bearing: **the plan's own parallelism is bounded by the ceiling the plan exists to
raise.** Until Stage 0 ships, this repo's own box runs 3-4 concurrent agents before `run-tests`
saturates it. So Stage 0 fans out to at most 3, and every later stage to at most 8. A plan that
dispatched 8 agents to build the thing that makes 8 agents possible would spend its first hour
proving its own problem statement.

---

## Resolved decisions (autonomous defaults)

These are plan-level. Spec-level decisions are D1-D19 **in the spec** and are not repeated or
re-litigated here. Where a number below cites a `D`, it is the spec's.

**P1 — Stage 0 ships alone, and stages 1+ are not pre-authorized.**
The spec's own Phase 0 text says *"Ship Phase 0 alone and stop, if it is enough."* This plan
honours that literally: Stage 0 ends at a **decision package** that reports C0 vs C1 and asks the
owner whether to continue. Dispatching Stage 1 before that answer would spend a week of agent time
on a cluster that the measurement might have made unnecessary — and, worse, would make the
measurement unfalsifiable, because nobody stops a half-built cluster.

**P2 — C0 is captured before any Stage 0 code lands.**
`C1`'s acceptance is *"wall time to all-8-complete is lower than C0"*. If C0 is measured after the
bounding lands, there is no C0. This is package **0.0**, it is the first package in the plan, and
nothing else in Stage 0 dispatches until its numbers are written to the run directory.

**P3 — One SOLO scaffold package per stage owns every shared file, once.**
Carried over from `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D6, which learned it the hard
way: **fan-out collides at file level, not topic level.** Two packages on completely unrelated
topics both need a row in `SOURCE_PROVIDERS`. The chokepoint files in this plan are:

```
packages/contract/src/cluster.ts          + the contract barrel
packages/cezar/src/server/cluster-routes.ts
packages/cezar/src/server/server.ts        (one wiring line)
packages/cezar/src/capabilities.ts
packages/web/src/routes/settings/registry.tsx
packages/cezar/src/sources/registry.tsx    (SOURCE_PROVIDERS)
packages/cezar/src/index.ts                (the CLI switch)
packages/cezar/src/todos.ts
packages/cezar/src/workflows/run.ts
.env.example  +  README env table
```

Every one of those appears in exactly one `owns` cell in the tables below. A construction package
that needs a route, a capability key, a CLI verb or a contract type gets it **already present and
stubbed** from its stage's scaffold, and fills in the body of a file it alone owns.

**P4 — The full gate runs at wave barriers only, and never in `~/loki-labs/cezar` on the Mac while
the cockpit is up.**
Two independent reasons, both measured:

- `pretypecheck` is `build:server` and `npm run build` / `npm run test:package` all write
  `packages/cezar/dist`. Two agents running the gate concurrently in one checkout overwrite each
  other's build. The gate is therefore a **barrier**, run once per wave by the barrier package,
  not by each construction package.
- The Mac's live cockpit on `:4321` executes `packages/cezar/dist/index.js` with cwd
  `~/loki-labs/cezar` — the `--repo` flag names its boot project, not where its code lives. A
  build in that checkout rewrites a running server's code underneath it. Run the gate on the box
  (which serves a blue-green release out of `/opt/cezar-releases/` and is unaffected), or stop the
  Mac cockpit first.

Construction packages still run their **own** narrow tests: `npm test -- <their path>`.

**P5 — `spec-implementer` (Sonnet 5) for construction; the session model for SOLO, decision and
verification packages.**
`AGENTS.md` → *"Delegating implementation"*: a subagent with no `model:` inherits the session
model, so naming `spec-implementer` is what makes the choice happen. The line is decision work vs
construction work. In this plan that puts every scaffold, every reconcile-the-real-divergence
package, every measurement package and the final release package on the session model, and
everything with a settled contract on Sonnet.

**P6 — No worktree isolation.**
Two reasons. The harness's `isolation: 'worktree'` cuts a worktree of the **outer workspace repo**
(`~/loki-labs`), not of cezar. And a real cezar worktree needs its own `npm ci` or Node resolves
upward into the parent checkout's `node_modules` and produces a run that looks normal and is not
(`AGENTS.md` → trap 1's 2026-08-21 amendment: 1 979 failures, none naming the cause). Packages in
one wave are file-disjoint by P3, so they do not need isolation; they need discipline about paths,
which P3 supplies.

**P7 — Fan-out ≤ 3 during Stage 0, ≤ 8 after it lands.**
See "Why this plan exists". Concurrency here is the resource under test.

**P8 — Backward compatibility applies inside cezar, and this overrides the workspace pre-launch
rule.**
`~/loki-labs/AGENTS.md`'s "Pre-launch — no backward-compatibility burden" is **scoped to `chat/`**
by its own first line. cezar is published as `@loki-labs/cezar-plus` v0.10.0 and is installed by
`npx` on machines this plan does not control — including, by Phase 1b's own design, freshly
provisioned workers. So: **never widen a published wire enum** (`RunStatus`, `StepStatus`),
additive optional fields only, and every on-disk shape stays `.passthrough()`. Phase 0's
`resourceKill` is a new optional **field** for exactly this reason, not a new `RunStatus` member.

**P9 — The 110-row reconcile is owner-gated, and no agent resolves the 10.**
The spec is explicit that a disagreement predating the hub is not a conflict any ordering can
settle. Package **2.5** runs `--dry-run` against the real divergence, checks the shape against the
spec's expected counts (103 / 7 / 579 + 33 / 10), and **stops**. The real run happens with the
owner in the loop. An agent auto-picking a side here is the most believable wrong answer available.

**P10 — Every negative control the spec names is part of the package that ships the feature.**
The spec names roughly twenty, and most exist because their absence produced a test that passes
against the bug. A package that ships item 6a without the "same fixture *with* an `origin` does get
placed on the peer" half has shipped a test that cannot fail. The package tables carry the
verification ids so this is checkable rather than hoped for.

**P11 — The known-reds are declared here, not discovered per package.**
Three failures in this repo are host or history, not the diff. A package reporting one of them as
its own has misreported, and re-deriving them is expensive (one cost 43 583 output tokens):

| red | what it is | what to do |
|---|---|---|
| `knowledge/catalog.test.ts` C18 (`bestMs/totalMiB < 40`) | an absolute budget calibrated on a faster core; measures 54-65 ms/MiB on the prod host **idle** | cite `AGENTS.md` trap 3, do not widen the budget |
| `add-project-dialog.test.tsx` "registers exactly the checked rows…" | live flake, ~1 run in 4, and it flakes in isolation too | cite, re-run once, do not bisect |
| `test:package` case 5 under the run broker | closed 2026-08-22 by `3e6d1b7e`; **may no longer reproduce** | if it reproduces, that is new information — report it, do not re-diagnose |

**P12 — A package that finds the spec wrong stops and says so.**
This spec was corrected four times under owner review — the CRDT became hub-linearization, `cez
node provision` became a role on the existing installer, the corpus decision was found unable to
serve an agent at all. Implementing around a wrong spec is how the record and the code drift. Stop,
report, and let the spec change first.

---

## Stages

The stages **are the spec's phases**, plus a wave-0 scaffold inside each and a release stage at the
end. Package ids are `<phase>.<n>` — so `0.3`, `1b.2`, `3b.4` — deliberately, so that no plan id
can be confused with the spec's own `C0-C4`, `D1-D19` or `E1-E8`.

```
  Stage 0  ── Phase 0: bound and gate the burst on the box that exists
      │       0.0 baseline  →  0.1 scaffold  →  {0.2 0.3 0.4 0.5}  →  0.6 wiring  →  0.7 DECIDE
      │
      ▼   ┌──────────── owner decision gate: is Phase 0 enough? ────────────┐
      │   └─ stop here, or continue ────────────────────────────────────────┘
      │
  Stage 1  ── identity + link, inert          1.0 scaffold → {1.1 1.2 1.3 1.4} → 1.5 activate
      │
  Stage 1b ── the Cluster section             1b.1 → 1b.2 → 1b.3
      │
  Stage 2  ── hub-linearized todos            2.0 scaffold → {2.1 2.2} → 2.3 todos.ts → 2.4 → 2.5⚑
      │
  Stage 3  ── leases + claims + projection      3.1 → {3.2 3.3 3.4}
      │
  Stage 3b ── corpus mirror                     3b.1 → 3b.2 → {3b.3 3b.4}
      │
  Stage 4  ── placement, dispatch, workers     {4.1 4.2} → {4.3 4.4} → 4.5 → 4.6
      │
  Stage 5  ── scheduler ownership              5.1 → 5.2
      │
  Stage R  ── release                          R.1 → R.2
```

`{…}` is a parallel wave. `→` is a barrier: the left side is committed and the gate is green
before the right side dispatches. `⚑` is owner-gated.

---

## Package tables

Columns: **owns (exact)** is the complete set of paths a package may create or edit — anything not
listed is another package's. **verifies** names the spec's own verification ids the package must
ship. **model** is `sonnet` (via `spec-implementer`) or `session` (SOLO).

### Stage 0 — Phase 0. No cluster, no link, no second machine.

| # | package | owns (exact) | deps | verifies | model |
|---|---|---|---|---|---|
| **0.0** | **Baseline, SOLO.** Launch 8 real tasks at today's settings on the box. Record concurrent `run-tests`, `memory.peak` per scope, `/proc/pressure/{cpu,memory}` `some avg60` at the worst minute, `journalctl -k` OOM kills, wall time to all-8. Write to `.ai/runs/2026-08-22-multi-node-cezar-cluster/c0-baseline.md`. **If it does not confirm the 3-to-4 ceiling, stop the whole plan** — the premise is wrong. | `c0-baseline.md` (this run dir) | — | **C0** | session |
| **0.1** | **Phase 0 scaffold, SOLO.** The four additive optional fields on `RunRecord` (`peakCpuPct`, `peakMemoryBytes`, `cpuSeconds`, `resourceKill`), the `heavy?: boolean` on the step definition type, the five D14a keys on workspace `resources` (`maxHeavySteps` plus `runMemoryHighMb`, `runMemoryMaxMb`, `runCpuWeight`, `runsSliceMemoryMaxMb` — 0.3 *reads* them and must not be editing `config.ts` concurrently), and `.env.example` + README rows for anything new. **`heavy` cannot land in `workflows/types.ts` alone:** `GET /workflows` serves the cezar-side `WorkflowDef` verbatim and `contract-parity.workflows.test.ts` asserts mutual assignability, so the contract's `workflowStepDefSchema` must mirror it in the same change or tsc fails `route-is-wider`. Found by 0.1 itself, mid-flight. Types and defaults only — no behaviour. | `runs/store.ts`, `workflows/types.ts`, **`packages/contract/src/workflows.ts`**, `workspace/config.ts`, `.env.example`, `README.md` | 0.0 | — | session |
| **0.2** | Peak CPU beside peak RSS, and on Linux prefer the run's own cgroup (`memory.peak`, `cpu.stat`) over summing `ps` RSS. Degrade to the `ps` path where cgroups are absent, and **report which one it used** — that value is what the node row's `enforcement` field renders later. | `core/process-usage.ts` + its tests | 0.1 | — | sonnet |
| **0.3** | Resource properties onto the transient scope `broker-isolation` already creates: `MemoryHigh`/`MemoryMax`/`CPUWeight` per run, a ceiling on `cezar-runs.slice`. A kill must surface as `resourceKill` with a reason, **never as a failed test step**. | `core/broker-isolation.ts` + its tests | 0.1 | **C3** | sonnet |
| **0.4** | The second semaphore: `maxHeavySteps`, taken and released **around a step**, not a run. Declared per workflow step via `heavy`, never inferred from a step's name at runtime. **Corrected during Stage 0: the schema default is absent = unbounded, NOT 2.** This row said "default 2" and the spec's Data Models said *absent = unbounded, i.e. today's behaviour*; the spec is right and this row was wrong. `@loki-labs/cezar-plus` is published and `run-tests` defaults `heavy: true`, so a schema default of 2 would silently cap every installed user's concurrent test steps on upgrade — experienced as "cezar got slower", with nothing in their config to point at, which is what P8 forbids. The **2 is a config value in this box's own** `config.json` (spec Phase 0 step 3: *"default 2 **on this box**"*), and that is now the one way the gate turns on. **It is an ops precondition, not 0.6's code change** — 0.6 reports that it is required; 0.7 must confirm it is actually written before C1/C2 mean anything, because an unwritten value measures ungated behaviour and reads exactly like a gate that did not help. Anything reading it treats `undefined` as unbounded — never 0, never 1. | `workspace/semaphore.ts` + its tests | 0.1 | — | sonnet |
| **0.5** | Worker and thread caps: vitest workers, ripgrep threads on the agent search path. This is the largest single contributor to the burst and the cheapest to bound. | `packages/cezar/vitest.config.ts`, the agent search-path module + its tests | 0.1 | — | sonnet |
| **0.6** | **Wiring, SOLO.** `run.ts` takes the heavy semaphore around heavy steps; `run-tests` defaults `heavy: true`. **Corrected during Stage 0, twice over — see “Phase 0 config vs. code” below.** ~~`maxParallel` default raised to 8 on this box~~: raising `.default(2)` in `workspace/config.ts` would not change *this box*, it would quadruple admitted concurrency for every installed `@loki-labs/cezar-plus` user on their next upgrade, on hardware nobody here has measured. 8 is a measurement about `prod-host` and belongs in that box's own `config.json`, exactly like `maxHeavySteps: 2`. **Also picked up here:** 0.3's cgroup keys were dead config — `buildBrokerLaunchArgv` accepts `opts.resources` but `claude-cli-runner.ts` never passed it, so no bound reached any scope and `detectResourceKill` could not fire, making C3 unrunnable rather than unverified. 0.6 wires `resources` through `BrokerSessionRequest` so the applied bound and the attribution read the same object. | `workflows/run.ts`, `core/claude-cli-runner.ts` (resources wiring) | 0.2, 0.3, 0.4, 0.5 | — | session |
| **0.7** | **Measure and decide, SOLO.** Re-run the eight tasks (C1), then the correlated launch (C2), then C4's health-latency-under-load. Write `c1-results.md` next to the baseline and state plainly whether wall time went **down**. Present the Phase-0-is-enough question to the owner. | `c1-results.md` | 0.6 | **C1, C2, C4** | session |

**Barrier:** full gate on the box, one commit, push `origin`. Then **stop and ask.**

#### Phase 0 config vs. code — a defect in this plan, corrected 2026-08-22

Phase 0's step list in the spec mixes two kinds of change and this table copied the mix, so **two
separate packages arrived at the same conflict independently**: 0.4 with `maxHeavySteps: 2`, 0.6
with `maxParallel: 8`. Both step texts read as "change the default", both defaults live in
`workspace/config.ts`, and in both cases changing them there would have been wrong.

The rule, for anything else in this plan phrased as a number:

> cezar is **published** as `@loki-labs/cezar-plus`. A `z.…default(N)` in `workspace/config.ts` is
> a claim about every installed user's machine on their next upgrade — hardware nobody here has
> seen, cannot measure, and whose failure mode is thrash or "cezar got slower" with nothing in their
> own config to point at. A number derived from measuring `prod-host` describes
> `prod-host`. It goes in **that box's** `~/.cezar/config.json`, never in the schema default.

So `resources.maxParallel: 8` and `resources.maxHeavySteps: 2` are both **ops preconditions of
0.7**, not code changes in 0.6. 0.7 must verify both are actually written on the box before
reporting C1/C2: an unwritten value measures ungated behaviour, and a gate that was never turned on
is indistinguishable in the results from a gate that did not help.

### Stage 1 — Phase 1. Identity and link, inert.

| # | package | owns (exact) | deps | verifies | model |
|---|---|---|---|---|---|
| **1.0** | **Cluster scaffold, SOLO.** `packages/contract/src/cluster.ts` with every wire shape `.strict()` and every frame shape from the spec's API contracts section, exported through the barrel; `server/cluster-routes.ts` as a chained route family with stubbed handlers; `capabilities.ts` gains `cluster: boolean`, always present; the `cez cluster` CLI verb in the `index.ts` switch with subcommands stubbed; `CEZ_CLUSTER` / `CEZ_CLUSTER_HUB` in `.env.example` and the README table **in this commit**. `contract-parity.cluster.test.ts` both directions. The contract stays Node-free — no `node:crypto`. | `packages/contract/src/cluster.ts`, contract barrel, `server/cluster-routes.ts`, `capabilities.ts`, `packages/cezar/src/index.ts`, `.env.example`, `README.md`, `contract-parity.cluster.test.ts` | 0.7 ✅ | **12** (flag-off) | session |
| **1.1** | `nodeId`, node name, **discovered** labels (`macos`, `imessage`, `browser`, `device-e2e`, cgroup availability) — probed, never configured. `~/.cezar/cluster/node.json` at `0600`, `.passthrough()`, corrupt degrades to defaults with one warning. | `cluster/node-identity.ts` + tests | 1.0 | — | sonnet |
| **1.2** | Enrollment: mint a short-TTL single-use code stored as a **SHA-256 digest** (`auth/org-claim-token.ts`'s existing contract, verbatim idiom), redeem, revoke-before-use, per-node HMAC secret written `0600`. The named failure reasons are values, not prose. **This row said "four" and then listed five; it is six now.** `code-malformed` was added during implementation because `joinCluster` parses the pasted code before opening a socket, so a typo was answering `hub-unreachable` — a tested-sounding claim about DNS, the tunnel and Access, none of which had been touched. Its own test proved it: the case asserts `fetch` was never called and then asserted the hub was unreachable. The enum splits on **what the operator holding the screen can do next**, which is why a malformed code is its own member and a hub answering HTTP 500 is not. | `cluster/enrollment.ts` + tests | 1.0, 1.1 | — | sonnet |
| **1.3** | The link, both ends. Spoke: outbound WS, `hello`/`welcome`, resume watermarks, exponential backoff with jitter. Hub: the `/api/v1/cluster/link` upgrade with **its own** auth guard — `server/ws.ts`'s guard admits browser origins and must not admit a node, and a node-authenticated socket must not gain cockpit topics. Frame bounds: ≤ 256 KB, ≤ 500 ops, per-tick send budget. Signed freshness-bounded principal per `supervisor/forwarded-principal.ts`. | `cluster/link-client.ts`, `cluster/link-server.ts` + tests | 1.0, 1.2 | **13** | sonnet |
| **1.4** | Roster, pairings store, presence: heartbeat, capacity claim, `hostMetrics`, `repoDrift` per paired project (`HEAD` vs `origin/main`, ahead/behind, dirty, **`MERGE_HEAD`**). A spoke exposes only paired projects (D2). | `cluster/peers.ts` + tests | 1.0, 1.1 | — | sonnet |
| **1.5** | **Activation, SOLO.** One wiring line in `server.ts` beside the existing `providerRuntimeAuth.watch` / `watchTodoAutostart` block; route family chained into the builder; `capabilities.cluster` reflects the flag. Then **E1** for real against `cockpit.example.com`. | `server/server.ts` | 1.1-1.4 | **E1** | session |

### Stage 1b — Phase 1b. The Cluster section, and one-line Add node.

| # | package | owns (exact) | deps | verifies | model |
|---|---|---|---|---|---|
| **1b.1** | **Registry entry, SOLO.** One row in `routes/settings/registry.tsx` — `id: 'cluster'`, `appliesTo: 'workspace'`, `capability: 'cluster'` — and the `SettingsCapabilities` alias widened to include `cluster`, so the shell cannot fall behind the filter that reads it. Nothing else; the registry's own docblock says it is the one place a section is declared. | `routes/settings/registry.tsx` | 1.5 | — | session |
| **1b.2** | The panel. Node rows in the spec's stated order, most-actionable first. Three honesty rules, each an assertion: a peer's capacity is **a claim rendered with its age**, `enforcement: 'none'` is rendered as a stated limitation, and offline is "asleep since HH:MM" — a state, not a red error. | `routes/settings/cluster-section.tsx` + `cluster-section.test.tsx` | 1b.1 | **12b, 12c** | sonnet |
| **1b.3** | *Add node*. The hub **renders** the one-liner server-side pinning its own version (never `@latest`, never assembled client-side), TTL counting down, revoke-before-use, single-use said plainly. `POST /api/v1/cluster/enroll` returns `{ code, expiresAt, commands }`. The join failure reasons render as **four distinct strings**, because an operator who cannot tell an Access rejection from a stale code will re-mint codes to fix a credential problem. | `cluster-section.tsx` (Add-node subtree), `cluster/enrollment.ts` (mint/render), `server/cluster-routes.ts` (enroll handlers) | 1b.2 | **12a**, **E1b** | sonnet |

> 12a is the one that matters in this stage: assert the rendered string matches the `npx …` shape
> **and** that it does not contain the Access client id or secret, from a fixture where both are in
> the environment. A test checking only the happy shape passes just as well against a command that
> leaks.

### Stage 2 — Phase 2. Hub-linearized todos.

| # | package | owns (exact) | deps | verifies | model |
|---|---|---|---|---|---|
| **2.0** | **Ops scaffold, SOLO.** Op shapes and the `pendingSince` / `hubSeq` / `tombstone` record fields in the contract and in `todos.ts`'s schema — fields and types only, no writers yet. Keeps the two packages that follow off each other's files. | `packages/contract/src/cluster.ts` (ops half), `todos.ts` (schema only) | 1b.3 | — | session |
| **2.1** | `ops.ts` + `oplog.ts`: **derive** the outbox from records marked `pendingSince` (the log is a cache, not the truth), append/read/compact `.ai/cezar/cluster/ops.ndjson`, flush with the send budget. | `cluster/ops.ts`, `cluster/oplog.ts` + tests | 2.0 | **5, 5b** | sonnet |
| **2.2** | `replica.ts`, pure: apply a hub replica over local + pending state. Hub order respected and **idempotent**; per-field ops so two spokes editing different fields both survive; tombstone/resurrection **both directions**; an unknown field round-trips through an older reader unchanged. | `cluster/replica.ts` + tests | 2.0 | **1, 2, 3, 4, 5a** | sonnet |
| **2.3** | **`todos.ts`, SOLO.** `applyHubReplica`, and a `pendingSince` stamp inside the **existing** `O_EXCL` lease on every writer — `createTodo`, `updateTodo`, `markStarted`, `clearStartedTaskId`, delete — with `markStarted` the one that waits for the hub instead of applying optimistically. Preserve `JSON.stringify(items, null, 2)` byte-for-byte and the heal-on-read path. One file, one owner, because every other package in this stage would otherwise want a line in it. | `todos.ts` + its tests | 2.1, 2.2 | **15** | session |
| **2.4** | The reconcile **classifier** and `cez cluster reconcile [--dry-run]`: three classes (one side only / identical / differing-and-neither-saw-the-hub), `todos.json.bak` on both sides before any write, and the periodic full reconcile that is what recovers a sleeping node — not the watcher. | `cluster/reconcile.ts` + tests, `index.ts` reconcile subcommand body | 2.3 | **7, 8** | sonnet |
| **2.5** | ⚑ **The real divergence, SOLO, owner-gated.** `--dry-run` against the live pair. The plan must name **103 `cezar` adds, 7 `chat` adds, 579 + 33 identical, 10 `chat` refusals**, plus whatever it reports for `aside`/`career-kit` (never diffed by id — report, do not assume). Any other shape means the classifier is wrong: re-measure the diff before believing the tool. **Then stop.** The 10 are the owner's call. | `reconcile-dryrun.md` (this run dir) | 2.4 | **E2** (dry-run half) | session |

### Stage 3 — Phase 3. Hub-confirmed claims, and the leases that are still leases.

| # | package | owns (exact) | deps | verifies | model |
|---|---|---|---|---|---|
| **3.1** | `leases.ts` — hub-side, TTL + renew, for what genuinely guards a **resource** rather than a record: account grants, usage aggregation, cluster-wide limit holds, scheduler ticks. Claims are explicitly **not** here any more (D4/D9a). | `cluster/leases.ts` + tests | 2.5 ✅ | — | sonnet |
| **3.2** | **`todo-autostart.ts`, SOLO. Two changes, not one.** (a) a guard: start only once the hub has acknowledged the claim, a no-op returning `true` when clustering is off; (b) D9a's confirm-before-start ordering **on the cluster path only**, leaving the existing act-then-stamp path byte-identical when clustering is off. The durable key is the replicated `startedTaskId` stamp, **not** the lease — which is what survives a blue-green hub deploy. | `todo-autostart.ts` + its tests | 3.1 | **9, 10, 11, 14** | session |
| **3.3** | Account grants across nodes: one coherent utilisation at the hub, a limit hold observed on one node parks the others. Its own file — it **consumes** 3.1's lease, it does not co-edit it. | `cluster/account-grants.ts`, account-usage wiring + tests | 3.1 | **E6** | sonnet |
| **3.4** | The run index projection — an **observer** on `RunStore`'s existing `run`/`event`/`deleted` events, wired through `onStoreCreated`/`onContextBuilt` exactly as `notifications/observer.ts` does, so it covers the boot context and every later one. Union the remote projection into the workspace runs list. Nothing in `runs/store.ts`. | `cluster/run-projection.ts`, `workspace-runs-routes.ts` + tests | 3.1 | — | sonnet |

> **9 has a procedure, not just an assertion.** Prove it fails without the fix: `git stash push`
> the file the guard landed in, run it, confirm **red**, `git stash pop`. A regression test written
> after the diagnosis passes against the bug more often than anyone expects.

### Stage 3b — Phase 3b. Corpus mirror. Ordered before dispatch on purpose.

| # | package | owns (exact) | deps | verifies | model |
|---|---|---|---|---|---|
| **3b.1** | **The provider + the one row, SOLO.** `sources/cezar-hub/provider.ts` and one row in `SOURCE_PROVIDERS`. The seam's own docblock promises a provider costs one file plus one row with no contract, route or UI change — this is the first outside test of that claim. **If it costs more, say so** rather than widening the seam quietly. | `sources/cezar-hub/provider.ts`, `sources/registry.tsx` + tests | 3.4 | **16, 17, 18** | session |
| **3b.2** | Hub-side corpus routes: scoped manifest (`corpusVersion`, per-doc hash/size/mtime), one-document body, and `POST /corpus/submit` — the **only** write direction the corpus has. Scope is per node; `reports/` off by default (196 files carrying phones and chat ids have no business on a machine whose premise is that it gets destroyed). | `server/cluster-routes.ts` (corpus family), `packages/contract/src/cluster.ts` (corpus shapes) | 3b.1 | — | sonnet |
| **3b.3** | Staleness, made legible: fetch time + hub corpus version on the mirror, rendered in the node row beside repo drift; the mirror scope rendered so "not found" is never ambiguous between *absent from the record* and *not mirrored here*. | `cluster-section.tsx` (corpus subtree) + tests | 3b.2 | **18** (UI half) | sonnet |
| **3b.4** | `cez kb submit` — a local knowledge write is **quarantined and preserved**, then has a correct path to the hub instead of only a prohibition. | `index.ts` (`kb submit` body), `sources/cezar-hub/provider.ts` (submit half) + tests | 3b.2 | **17** | sonnet |

> **16's negative control is the whole test.** A document that merely fails to appear in one
> watermark-filtered delta must **not** be deleted — that is the exact bug the `sources` sweep's own
> docblock warns about, so the test has to distinguish an explicit tombstone from an absence.

### Stage 4 — Phase 4. Placement, dispatch, and a worker you can mint in minutes.

| # | package | owns (exact) | deps | verifies | model |
|---|---|---|---|---|---|
| **4.1** | `placement.ts`, pure: label matching, and **queue-with-reason** — plus the render, because a reason nobody sees is not a reason. Four reasons, four distinct strings — *no node carries this label* / *every eligible node is at capacity* / *the node it needs is offline* / *this project has no `origin` and may only run where it lives*. Collapsing them into "queued" is what sends a person to buy a node when the real fix was opening a laptop lid. | `cluster/placement.ts`, `cluster-section.tsx` (queued-reason subtree) + tests | 3b.4 | **6, 6a, 6b, 12d** | sonnet |
| **4.2** | `allocate.ts` — the hub hands out and **records** scarce shared identities, spec numbers first. `next-spec` reserves nothing and a spoke's uncommitted worktree is invisible to it, so **skipping this makes multi-node worse than one machine**. N concurrent calls, N distinct numbers, asserted across the whole set. | `cluster/allocate.ts` + tests, `server/cluster-routes.ts` (allocate handler) | 3b.4 | **6c** | sonnet |
| **4.3** | Dispatch: spoke-side `acceptsDispatch` opt-in (default off, enforced **spoke-side**), workflow carried **by value** never by name, and the pre-dispatch `freshness` exchange that refuses a target that is behind, dirty or mid-conflict — naming which. Hub unreachable → a hand-started run still starts, recorded `unattributed`; a **replicated** todo's autostart refuses with a stated reason. A mirror stale past its bound refuses too, **naming the corpus** — with the negative control that a fresh mirror does not refuse, so the test cannot pass against a node that refuses everything. | `cluster/dispatch.ts`, `cluster/link-*.ts` (dispatch frames) + tests | 4.1 | **14** (dispatch half), **19, E5a** | sonnet |
| **4.4** | On-demand live event relay for a foreign run: relayed while watched, stopped when the view closes. A foreign run **never** offers a local-machine affordance — the cluster must not become a way to smuggle "open in terminal" for a run on somebody else's host. | `cluster/relay.ts`, cockpit run-view wiring + tests | 4.1 | — | sonnet |
| **4.5** | **The worker role, SOLO.** `cez server-install --platform hetzner --role worker` — an extension of the existing step list and strategy, **not** a parallel shell script. Adds repo checkouts, agent CLI **logins**, cgroup caps + `maxHeavySteps`, `CEZ_ENV_PASSTHROUGH`, and `cez cluster enroll` with the hub's token. The logins are the one genuinely interactive step, so the run must **stop and say so** rather than half-provisioning silently. The cockpit's *Add node* grows its second variant here, still with **no long-lived credential in the pasteable string**. | `server-install/platforms/hetzner.ts`, `server-install/steps.ts`, `cluster-section.tsx` (provision variant) + tests | 4.3 | **E5b** | session |
| **4.6** | `cez cluster active` — in-flight runs across the cluster (todo summary, node, branch, touched paths), a **read an agent can already make** over the `Bash` + `cez` surface it has, no MCP needed. Wired to the overlap refusal in 4.1 so the two agree on what "active" means. | `index.ts` (`cluster active` body), `server/cluster-routes.ts` (active handler) + tests | 4.1, 4.2 | **6b** (wiring half) | sonnet |

> **6a and 6b both need their negative controls or they are vacuous.** 6a: the same fixture *with*
> an `origin` **does** get placed on the peer — otherwise the test passes because placement did
> nothing at all. 6b: non-overlapping paths in the same project **do** dispatch (otherwise the rule
> is just "one run per project", which is not what was asked for), and a **finished** overlapping
> run does not block (otherwise the check leaks and the board wedges).

### Stage 5 — Phase 5. Scheduler ownership.

| # | package | owns (exact) | deps | verifies | model |
|---|---|---|---|---|---|
| **5.1** | Automations, sources and backup tick under a cluster lease — each creates work or writes shared state. | the three schedulers + tests | 4.6 | — | sonnet |
| **5.2** | **Timer audit, SOLO.** Walk every timer in the repo against one question — **"does a second tick do the work a second time, anywhere but here?"** — and record the verdict per timer. Retention, the knowledge reindex and the reopen sweep stay per node, because they act on node-local resources only; that is a conclusion this package has to reach and write down, not assume. | `timer-audit.md` (this run dir) | 5.1 | — | session |

### Stage R — Release.

| # | package | owns (exact) | deps | verifies | model |
|---|---|---|---|---|---|
| **R.1** | **Runtime E2E, SOLO.** The real pair, then the real fleet: E3 (**with the lag measured and recorded**, budget < 1 s against a 58 ms link), E4, E5, E5c (**the eight tasks across the cluster vs the single-box C1 number** — the only evidence a second machine bought throughput rather than moving queueing around), E5d (asserted at the **agent's** level: the agent quotes a corpus-only fact, and with the mirror disabled visibly cannot), E7, E8. | `e2e-results.md` (this run dir) | 5.2 | **E3, E4, E5, E5c, E5d, E7, E8** | session |
| **R.2** | **Record + release, SOLO.** Mark the spec Implemented (or Partial, honestly). Sync the box: knowledge note, dated changelog entry, `domains/cezar.md`, and the filed todo's acceptance criteria ticked against what actually passed. Write as **`cezar`**, never root; end with `find /var/lib/cezar -not -user cezar | wc -l` = **0**. Version bump and publish only on the owner's word. | the spec, the corpus on the box | R.1 | — | session |

---

## The dispatch contract

Every package prompt carries these. Each clause exists because something broke.

1. **The spec path and the phase name, verbatim.** Never a summary of the spec. `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, and the phase heading. Read the phase, and the Decisions it cites, before writing anything.
2. **`owns (exact)` is the complete list.** Create or edit nothing outside it. If your package needs a route, a capability key, a CLI verb or a contract type, it is already stubbed by your stage's scaffold — fill in the body of a file you own.
3. **If a file you own already has content you did not write, stop and report it.** Two packages overlapped, and that is a bug in this plan worth one message more than it is worth merging around.
4. **Read the precedent before writing the pattern.** This repo has an existing idiom for almost everything in this spec: `auth/org-claim-token.ts` for digest-stored codes, `supervisor/forwarded-principal.ts` for signed principals, `notifications/observer.ts` for store observers, `sources/sync.ts` for watermark-resumable sweeps with explicit tombstones, `todos.ts` for `O_EXCL` leases. Match them.
5. **Run only your own tests.** `npm test -- <your path>`. The full five-command gate is the barrier's job — `npm run build` and `npm run test:package` both write `packages/cezar/dist`, so two of you running it at once corrupt each other.
6. **Scrub the environment, every time.** Not a hand-written `-u` list — that was measured incomplete and an incomplete scrub is worse than none:
   ```bash
   scrub=$(env | sed -n 's/^\(CEZ_[A-Z0-9_]*\)=.*/\1/p' \
           | grep -vxE 'CEZ_(HANDOFF_FILE|TASK_ID)' | sed 's/^/-u /')
   tmp=/tmp/cez-gate-$$ && mkdir -p $tmp     # TMPDIR must be OUTSIDE any git repo
   env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm test -- <your path>
   ```
7. **Never `npx vitest`.** It reaches past the pinned devDependency and fetches a different version off the registry — a slow, networked, silently-different run. A missing local vitest is a signal to fix the install, never to route around it.
8. **Do not commit and do not push.** The orchestrator commits once per wave. If you are ever told to push in this repo: `git push origin main`, named remote, **never** `upstream`, **never** bare `git push`.
9. **Never widen a published wire enum.** `RunStatus` and `StepStatus` ship in `@loki-labs/cezar-plus`. Additive optional fields only; on-disk shapes `.passthrough()`.
10. **The known-reds are P11's table.** Cite them; do not investigate them. Re-deriving trap 5 once cost 43 583 output tokens.
11. **Ship the negative controls named in your `verifies` cell.** They are not optional and they are not "extra coverage" — most of them exist because their absence produced a test that passes against the bug it was written for.
12. **If the spec is wrong, stop and say so.** Do not implement around it. This spec has been corrected four times under review; the fifth is likelier than a clean run.
13. **Report, in this order:** files created; files edited; tests added by name; the verbatim output of your narrow gate; and anything in your `verifies` cell you could **not** do, named. A package that silently drops a verification item has moved the plan's honesty into someone else's next session.

---

## Verification that the plan itself is honest

Checkable properties, not intentions:

1. **Every file in the spec's "New modules" block appears in at least one `owns` cell.** Grep the two lists against each other; a file in the spec and in no cell is unowned work that will be discovered at the barrier. *Not* "exactly one" — that would be a nicer claim and it is false here. Eight files are deliberately **re-opened across stages**, because P3's scaffolds stub a file early and a later package fills it in:

   | file | opened by | filled by |
   |---|---|---|
   | `packages/contract/src/cluster.ts` | 1.0 | 2.0, 3b.2 |
   | `server/cluster-routes.ts` | 1.0 | 1b.3, 3b.2, 4.2, 4.6 |
   | `packages/cezar/src/index.ts` (CLI) | 1.0 | 2.4, 3b.4, 4.6 |
   | `cluster/enrollment.ts` | 1.2 | 1b.3 |
   | `cluster/link-client.ts` / `link-server.ts` | 1.3 | 4.3 (dispatch frames) |
   | `cluster-section.tsx` | 1b.2 | 1b.3, 3b.3, 4.1, 4.5 |
   | `sources/cezar-hub/provider.ts` | 3b.1 | 3b.4 (submit half) |

   Every one of those pairs is in a **different wave**, which is the property that actually matters
   — see 2. A re-open inside one wave would be the bug; a re-open across a barrier is just a file
   with a stub in it.
2. **No path appears in two packages of the same wave.** This is P3's whole content and it is mechanical to check. Checking it against the first draft of this plan found two real defects, which is the argument for writing the check down: Stage 3 had `cluster/leases.ts` in **two** packages of one wave (3.1 and 3.3, now split — 3.3 owns `account-grants.ts` and consumes the lease), and Stages 3 and 3b both drew waves whose members depended on each other, which is not a wave.
3. **Every verification id in the spec is assigned.** C0-C4, automated 1-19 with 5a/5b/6a/6b/6c/12a-12d, and E1-E8 with E1b/E5a/E5b/E5c/E5d. The same check found **12d** (four queued reasons, four distinct strings) and **19** (a stale mirror refuses a dispatch) assigned to nobody — 12d because the reasons are produced in `placement.ts` and rendered somewhere else, 19 because the refusal is a corpus fact enforced on the dispatch path. Both now have an owner. Four ids are deliberately assigned to **two** packages as named halves — 6b (the rule, then the `cez cluster active` wiring), 14 (autostart, then dispatch), 17 and 18 (the sweep, then the UI that makes it legible) — because each is a mechanism plus the surface that shows it, and asserting one without the other is the rule silently collapsing to its neighbour. E2's real-run half is owner-gated in 2.5 rather than assigned, which is P9, not an omission.
4. **The gate runs at barriers only**, and never in the Mac checkout with the cockpit up.
5. **Stage 0 has a stop condition and Stage 1 is not pre-authorized.** If the plan cannot be stopped after Stage 0, then Phase 0's measurement was decorative.
6. **The plan states its own concurrency bound** — 3, then 8 — rather than inheriting whatever the harness allows. The whole spec is about the cost of unbounded concurrency on this box.

---

## Known open questions for the owner

The spec carries eight (§ Open questions). Four of them **block dispatch** of a specific stage, and
this plan names which, so they get answered at the right time rather than all at once:

| spec Q | blocks | why it blocks |
|---|---|---|
| **Q1 — is Phase 0 enough?** | Stage 1 | This is package 0.7's whole output. Nothing after Stage 0 dispatches without it. |
| **Q5 — cockpit-app Access service token, or ride the SSH tunnel?** | 1.2, 1b.3 | Enrollment's `access-rejected` path is a *different mechanism* depending on the answer, and E1b tests it by name. |
| **Q7 — what does a worker's mirror include by default?** | 3b.1 | The default is a data-exposure decision, not a config default: 196 report files carry phones and chat ids, and the cost of being wrong is asymmetric. |
| **Q4 — does the Mac accept dispatched work at all in v1?** | 4.3 | If the answer is no, `acceptsDispatch` on the Mac stays off and E5 needs a different capability node. |

Q2/Q2a (how many workers), Q3 (which node is the hub), Q6 (do run records replicate) and Q8 (does
this go upstream) do not block: Q2a is explicitly a *measurement* to take at 8 concurrent rather
than a decision to make now, Q3's assumption (`hel1`) is already what the plan builds, Q6 is
scoped into 3.4 as the nice-to-have it is, and Q8 changes only how the flags are documented.

Plan-level, and not in the spec:

- **Where do the gates run?** P4 says the box. That assumes the box's `chat`-style checkout of
  cezar stays level with `origin/main` and installed — it did not, for six hours, on 2026-08-22.
  If the box is not a reliable gate host, the alternative is the Mac **with the cockpit stopped**,
  and that is an interruption to the owner's own machine that should be agreed rather than assumed.
- **Does Stage 2's real reconcile happen in this plan at all, or after it?** 2.5 stops at
  `--dry-run` by P9. Merging 110 rows into the live record is a data change to the thing every
  session reads first, and it deserves the owner present.

## Found during implementation — open items

Written 2026-08-23, from the packages' own reports. Every line here is something a package found
and **escalated instead of quietly working around**, which is the behaviour that made them
findable at all. Nothing below is a defect in the package that reported it.

**Corrected in place already** (listed so nobody re-opens them): the `maxParallel`/`maxHeavySteps`
config-vs-code defect (rows 0.4/0.6 + the section above); `hub-unreachable` for a malformed join
code, now `code-malformed` (row 1.2 + spec E1b); whole-record ops, now `pendingFields` (spec Data
Models + Verification 2); relay's reach through `RunStore`'s `private dataDir`, now
`readHandoffText`; `handoff.test.ts`'s field classification and the `todoItemSchema` extension that
`placement` needed to be classifiable honestly.

### Blocking — all three CLOSED 2026-08-23

Kept in place rather than deleted, because each was found by a package escalating instead of
working around, and the table is the evidence that the escalation was the right call. Every row
below now names the fix, and the whole set is covered by the barrier run described at the end of
this document.

| what | why it mattered | how it was closed |
|---|---|---|
| **`server/ws.ts` destroys the cluster link socket.** Its `'upgrade'` listener destroys any path that is not `WS_PATH`, and Node fires every listener for one event. Verified empirically in both registration orders (close code 1006, nothing logged). | Phase 1.5 wires both onto one `http.Server`. Until this is fixed the link can never connect, and it fails **silently** — there is no error on either side, only an abnormal close a client sees. | `attach` no longer destroys a foreign path; a new exported `attachUpgradeFallback(server, ownedPaths)` destroys only paths **nobody** owns, and `server.ts` calls it unconditionally with `[WS_PATH, CLUSTER_LINK_PATH]`. Order-independent by construction, so a future third upgrade handler cannot reintroduce it by registering first. |
| **A cgroup kill reports as `done`.** `brokeredExitFailure` reads `code === null` as "ended acceptably", which is exactly an untrapped SIGKILL's shape. | Not a cluster bug at all — it is live in the published package, so an OOM-killed run reports success today. Diagnosis requested before it is written up; if it reproduces on unmodified `main` it wants its own commit and changelog entry, not a line in a cluster spec. | `brokeredExitFailure` now separates "no exit was ever observed" (`code === null` **and** no signal — still not the run's fault) from an untrapped external kill (`code === null` **with** a signal — now an error naming the signal). `reportedResourceKill` adds the attribution, and refuses it when the bound was never applied to this launch. Covered by `broker-external-kill.test.ts` and `broker-resource-kill.test.ts`, both of which pair every positive with its opposite. |
| **`--role worker` / `--join` are not parseable flags.** 4.5's entire worker role is built and tested but unreachable from a command line. | The plan's own "what is touched" list said "nothing else" for row 4.5, so this is a gap in the plan's accounting rather than one 4.5 introduced. Three additive edits: `server-install/types.ts`, `engine.ts`, `index.ts`. | The three additive edits landed: `--role`/`--join` parse in `index.ts` (only `worker` is recognised; anything else falls through to `undefined` rather than silently selecting a mode), and are threaded through `server-install/types.ts` → `engine.ts`. |

### Real, not yet assigned

| what | why it matters |
|---|---|
| ~~**THE HUB NEVER PERSISTS A NODE'S SECRET, so it cannot verify any node by any transport.**~~ **CLOSED 2026-08-23 (D22).** **DESIGN SETTLED 2026-08-23 as spec D22; LANDED the same day (commit `282b1d1a`), and D21 landed on top of it.** Found 2026-08-23 by the D20 package. `redeemEnrollmentCode` mints `randomBytes(NODE_SECRET_BYTES)`, marks the code redeemed, returns the secret to the joining node — and stores it nowhere. `cluster/peers.ts` contains the string `secret` **zero** times; the contract's served node shape says outright *"It has no `secret` field at all"*. Verified by `grep -a` across `packages/cezar/src` and `packages/contract/src`. | **Bigger than D20, which merely tripped over it.** `verifyClusterFrame` needs that secret, so the **link's own per-frame authentication is equally unusable on the hub side** — D17's "the secret every link frame is signed with" has no receiving end. Enrollment therefore *reads* as complete and is not: a node joins, lands in the roster, and holds a credential nothing can check. `node-auth.ts`'s `lookupNodeSecret` fails closed (`unknown-node` for everyone), which is correct and also means **every node-authenticated route refuses by construction** — which is exactly why D21's todos routes were NOT wired this session: a route that can only 401 is worse than one that does not exist. Not a one-liner: `peers.json` is the wrong home unless nothing renders it (`GET /cluster` serves the roster, and `secret` was removed from that shape deliberately). **D22 settles it, and pinned two things the sketch here left open.** A separate `0600` `node-secrets.json` keyed by node id, its own file so no `readPeers()` can leak it, with a single-node read and deliberately no list-all accessor. (a) The secret is stored in **plaintext** — HMAC verification needs the key itself, and digest-at-rest (right for enrollment codes, which only need equality) would fail every signature and read as a signing bug. (b) It is written **before** the code is marked redeemed, inside the existing `withEnrollCodesLease`: two files, one lease, and the failure is asymmetric — redeem-first strands a node holding a credential the hub never stored *and* a burned code, secret-first strands an inert orphan. Also closes a live hole the diagnosis missed: `disableNode` is a roster edit only, so a disabled node's signatures still verify today. Unblocks, in order: `lookupNodeSecret` wired for real → the LINK's `lookupSecret` (same store, which is what fixes per-frame auth, not just HTTP) → D21's routes stop being 401-by-construction → the reconcile transport → E2's dry run. |
| ~~**`cez cluster reconcile` has no transport.**~~ **DECIDED 2026-08-23 — spec D21. UNBLOCKED the same day by D22, and LANDED the same day: three routes, the transport, and the CLI, dry-run by default. CLOSED.** There is no request/response primitive for "fetch a peer's todo list": the link is fire-and-forget, and the contract has no route for a todos snapshot. 2.4 gated it behind a named error rather than faking a default. | The gap turned out to be **one method, not four**: `apply` is an ops frame, `backup` is a local write on the receiver, `listProjects` is the confirmed-pairings list — only `list` had no rail. D21 adds `GET /api/v1/cluster/todos/:projectKey` (plus the backup/append halves) on the **hub**, and reconcile runs from the spoke against it, which is both the direction E2 needs and the only addressable one. Hub-reconciling-against-a-spoke stays out of scope: there is no inbound address. The real merge remains owner-gated by P9; what changes is that `--dry-run` becomes runnable at all. **AMENDED 2026-08-23 before building:** `/append` performs backup-then-append inside **one** lease, rather than leaving `/backup` and `/append` as two independent calls. Two calls would re-create — and across a network badly widen — the `.bak`-outside-the-lease hazard already logged two rows below: a concurrent local write landing between them is handled correctly by the append (which re-reads fresh under the lease) and is **absent from the backup**, so restoring silently rolls back an unrelated write. `/backup` still exists because the transport's contract calls `backup()` before the first mutation of a pass *whether or not* that peer receives any adds — the zero-adds case has no append to ride along with. |
| ~~**`appendLocalTodos` deadlocks on its own lease.**~~ **CLOSED 2026-08-23 — the function no longer exists.** Fixed first by delegating to `todos.ts#appendTodosPreservingIds`, then removed outright when the local backup+append were fused into `backupLocalAndMaybeAppend` (row below). It calls `readTodos()` *inside* `withLease`, and both use `todos.lock`. `readTodos` takes that lease whenever an entry lacks an id, which is the common case for an agent append. | 5s stall, then the throw is swallowed by `.catch(() => undefined)` and the id backfill is skipped **silently**. Worse than the stall: the fallback returns ids `readRaw` minted but never wrote, on the documented assumption that "nothing was written either" — and then `appendLocalTodos`, holding the outer lease, writes them. Root cause is 2.4 having to re-implement the lease locally because `todos.ts` exports no insert-preserving-an-existing-id primitive. **Blocked** until the per-field ops package releases `todos.ts`. |
| ~~**Field deletions never replicate.**~~ **CLOSED 2026-08-23.** `todoContentFields` built `fields` from present keys and `replica.ts` applied with `Object.assign`, so a removed key was indistinguishable from one never set. Real cases: `updateTodo({archived:false})`, `clearStartedTaskId`, `markStarted`'s `delete autostart`. | Both halves landed. Sending: `partitionTodoFields` splits each key named in `pendingFields` into `fields` (present on the record) or `clearedFields` (absent), one branch per key, and `collapseOwed` evicts from the opposite side on every write so the two stay disjoint at every step of a collapse rather than only in the result. Receiving: `applyOpToRecord` deletes each listed key, **after** the `fields` and `unknown` merges so an explicit clear cannot be undone by a D13 passthrough copy; `diffCorrections` now reads cleared names too, so a clear the local record disagreed with raises a correction instead of passing silently. The package that found this deliberately left the receiving half alone and routed it, and the test it wrote as a demonstration of the gap — asserting the key *wrongly survived* — was rewritten into the end-to-end proof with the two controls that keep it honest. |
| ~~**`opencode-server-runner.ts` can still report an externally-killed run as `done`, by a DIFFERENT mechanism.**~~ **STALE — already fixed in commit `5dd616f5` earlier the same day, with its own mutation-checked `opencode-server-runner-exit-gate.test.ts`. The row describes the pre-fix state and outlived it.** `resolveExit()` discards both the exit code and the signal and gates on neither: success is decided entirely by the SSE session status (`completed`/`error`) plus `this.timedOut`. A kill mid-session with the stream never reporting `error` falls through to an unconditional `{type:'done'}`. | Found while fixing the same *symptom* in `pi` and `codex`, and deliberately not folded in with them: those two were one bug (`waitForExit` dropping the signal) in two places, this is exit-gating that does not exist at all. Fixing it means giving opencode an exit gate, not copying a branch. Its own change, its own changelog entry. |
| **The knowledge-index budget test (`knowledge/catalog.test.ts`, C18) fails on the production box, and always has.** `bestMs / totalMiB` reads **68.6** against a `< 40` ceiling on `prod-host`. Measured against **pristine HEAD** on the same box, unpacked from `git archive HEAD` with no changes from this work: identical failure. Not new either — the same test was confirmed the same way on 2026-08-22 at **61.37**, so this is a standing red on the box, and a full box gate reading "559 of 560 files passed, 1 failed" is the green result rather than a near-miss. It is a per-core-speed budget calibrated on an M4 Max, with no host normalisation, asserted on the machine cezar actually runs on. | Deliberately NOT fixed here, and the number deliberately NOT raised — that would weaken the ~20 % regression detector the test's own docblock argues for, on every host, to make one host quiet. The principled fix is to express the budget relative to a reference workload measured on the SAME host in the same run, so the guard scales with the machine instead of encoding one. Until then, anyone running the gate on the box should expect exactly this one red and confirm it against HEAD rather than assume it is theirs. |
| ~~**`todos.json.bak` is written OUTSIDE the lease that guards the write it protects.**~~ **CLOSED 2026-08-23** — `backupLocalTodos`/`appendLocalTodos` are both gone, replaced by `backupLocalAndMaybeAppend` delegating to `todos.ts#backupAndAppendTodosPreservingIds` (one lease), with the zero-adds case taking a standalone lease-free `backupTodos`. Discriminated by a concurrent-write test; the obstruction test does NOT discriminate and is recorded as such. Fusing them falsified three separate comments claiming both sides were backed up before either mutated — all three corrected in place. In `reconcileProject` the order is `backupLocalTodos()` → `remote.backup()` → `appendLocalTodos()`, and only the last takes the `todos.lock` lease. Established 2026-08-23 by the package that removed reconcile's duplicate lease, in answer to a direct question — and it confirmed the hazard **predates that change**: the deleted re-implementation used the same lock file and also started its coverage inside the append, never before it. | A concurrent `createTodo`/`updateTodo`/`markStarted`/`removeTodo` landing between the backup and the append is handled correctly by the append (it re-reads fresh under the lease) but is **absent from the `.bak`**. So the restore path is the unsafe one: recovering from a bad reconcile silently rolls back an unrelated write that was never part of the reconcile. A backup that can be older than the state it is a backup *of* is worse than no backup, because it is trusted. Fix is a `todos.ts` primitive doing backup+append under **one** lease — new scope, deliberately not folded into the deadlock fix. |
| ~~**`opencode-server-runner`'s `child.on('error')` sets `spawnFailed` but never resolves `this.exited`.**~~ **CLOSED 2026-08-23.** The `'error'` handler now also calls `captureExit(...)`, matching `claude-cli-runner`/`pi-runner`'s `waitForExit` fallback. Caught by an explicit promise-vs-timer race, so the hang FAILS the test rather than hanging the runner. Found 2026-08-23 while adding that runner's exit gate. If a post-fork spawn error (e.g. `EACCES`) is not followed by an `'exit'` event — Node's docs do not promise it is — `result` waits forever on `await this.exited` and never reaches the `spawnFailed` check. | **A permanent hang, not a wrong answer**, and therefore invisible in a way a wrong `done` is not: no error, no timeout, no event. Distinct from the exit-gate defect (which was "reports success when killed") and untouched by its fix. Worth a bounded wait or resolving `exited` from the `'error'` handler. |
| ~~**`opencode-server-runner`'s `bootstrap()` awaits `this.prompt(first)` unguarded.**~~ **CLOSED 2026-08-23** — the result's catch now gates on `!this.timedOut && !this.terminatedByCezar`, so a teardown cezar itself initiated stops surfacing as a run failure. A negative control in the same file proves the new gate does not over-suppress a GENUINE failure (`terminatedByCezar` false ⇒ the error still fires). **Deliberately NOT brought over from the sibling runners: their belt-and-suspenders safety `setTimeout` on exit.** This runner resolves `exited` from `'exit'`, `'close'` AND now `'error'` — every documented Node exit-signalling path — and `terminate()` escalates SIGTERM → SIGKILL after a grace, so a timer would defend a case that cannot practically occur. Recorded as a judgement made, not an omission missed. A teardown cezar itself initiates while that first-turn POST is in flight makes the `fetch` reject; the rejection propagates through `this.ready` and surfaces as a generic `opencode: <fetch error>` **error event on a shutdown cezar asked for**. Reproduces identically on the unmodified file. | Same class as the exit gate — cezar's own teardown read as a failure — but at a different point in the lifecycle, so the exit gate does not cover it. It was hit as real test flakiness before being worked around by waiting for `turn-end`; a real run has no such luxury. |
| ~~**`/cluster/allocate/:kind` and `/cluster/leases/*` attribute to `loadNodeIdentity({env})` — THIS server's identity — not to the caller.**~~ **CLOSED 2026-08-23**, once D22's secret store made the gate meaningful. Both halves landed together, as this row required: attribution is now `getAuthenticatedClusterNode(c).nodeId` and the routes joined the node-authenticated set atop (not instead of) `requireHub`, cheap gate first so a non-hub still gets 409 rather than 401. **The open question in this row dissolved rather than being answered:** it worried the hub has no secret of its own and so cannot authenticate to itself — but these routes have **no HTTP client anywhere in the repo**, and every local consumer (`cluster/account-grants.ts`) calls `acquireLease`/`releaseLease`/`allocate` directly. There is no hub-local HTTP call, so no self-credential was invented. Mutation-checked both ways: reverting attribution reddens the three attribution tests, removing the `.use()` registrations reddens all six refusal tests. `BACKWARD_COMPATIBILITY.md` §2 updated — **and note the route-inventory gate could not have caught that omission**, since it asserts route PRESENCE only and these routes were already listed; the prose describing their refusal set had to be reviewed by hand. Which is why D20 deliberately left them out of the authenticated set: gating them without fixing the attribution would produce a route that **looks secured and silently ignores the identity it just verified**, which is worse than one that is honestly open. | Two things must land together, in this order: the hub-side secret store (top row), then attribution-by-caller, then the gate. Note the second half of the reason they were excluded — `StoredClusterNodeIdentity#secret` is documented **spoke-only**, so the hub has no secret of its own and cannot authenticate to itself; whoever fixes this has to decide what a hub-local call presents. |
| ~~**`todo-autostart.ts` still imports `ClusteredTodoItem`**~~ **CLOSED 2026-08-23.**, which is now a plain alias for `TodoItem`. It is the only consumer keeping the name alive; `replica.ts` no longer uses it internally at all. | One-line follow-up (`import type { TodoItem }`, two signatures and one cast). Left alone on purpose 2026-08-23 — the package that made the alias redundant did not own that file, and reaching into a file you do not own is how a fan-out corrupts a peer's work. |
| **`createOrgUserCommand`'s `useradd --comment "cezar org: ${orgSlug}"` still spells the raw slug**, so a cluster worker's GECOS field reads `cezar org: worker`. | The `label` fix covers the four operator-facing strings; this is a system field with its own passing tests keyed on the slug. Minor and deliberately out of scope — recorded so the next reader knows it was seen and judged, not missed. |
| **`startPeriodicReconcile` is wired to nothing — and neither is the link. Stage 1.5 landed as a WARNING, not as activation.** Read `startClusterRuntime` (`cluster-routes.ts` ~line 550): with the flag on it logs *"the cluster routes are served, but the node link and the periodic reconcile have not landed yet"* and returns a no-op teardown. The modules exist (1.3, 2.4); nothing dials, nothing attaches, nothing is armed. | **This is the honest state of the cluster: enabled and inert.** The stub says so out loud, which is why it is a finding rather than a surprise — its own comment names the failure mode, *"a cluster that is enabled and inert looks exactly like one that is working until somebody asks a second node a question."* Deliberately NOT folded into the 2026-08-23 increment: arming the link is where **E1 (the real pair against `cockpit.example.com`)** lives, and that is a runtime E2E across two machines with the owner present, not a code change to slip in behind a gate. It is the next increment, and it is the one that makes the cluster a cluster. D21's transport is a precondition for the reconcile half of it. |
| ~~**3b.1 invented the corpus doc-body shape and auth headers.**~~ **REVISED 2026-08-23 — spec D20 supersedes the auth half.** `GET /corpus/*path` → `{path, body}`, `Authorization: Bearer` + `x-cezar-node-id`. No wire auth scheme was specified for the corpus REST family anywhere. | The doc-body shape stands and is still 3b.2's to match. The **auth** half is now decided against: a bare bearer secret over a family with no replay window is the weaker half of a choice nobody made. D20 extends the link's already-built signed freshness-bounded principal (`supervisor/forwarded-principal.ts`) to the HTTP family, keyed on enrollment's per-node HMAC secret. This is why the corpus routes were right to sit at 409 — and landing D20 is what unparks them. Note what the family has today: `requireCluster` + `requireHub` and **no authentication at all**, which was harmless only while no route returned content. |
| **`stripLocalAffordances` is a denylist on a security boundary.** An allowlist is unavailable: `clusterRelayFrameSchema.events` is an open record and `RunEvent` has an index signature, so nothing enumerates what an event may carry. | Residual is narrower than "any missed key" — `stripDeep` scrubs paths from every string in the tree, so the exposure is an **opaque resume handle** under an unlisted key. Inverting it means `RunEvent` stops being an index signature first. |
| **`account-at-limit` fires only on a lease conflict.** No configured per-account ceiling exists; Q2a is explicitly unmeasured, so 3.3 declined to invent one. | Possible second unreachable enum member, the same class as the `'cpu'` narrowing and the `unknown-workflow` tripwire. Decide when Q2a is measured, not before. |
| **The relay has no cockpit run-view wiring.** Row 4.4 lists it; 4.4 owned `relay.ts` only and said so. | Needs `link-client.ts` present, so it lands with or after 1.5. |
| ~~**`replica.ts`'s local `ClusteredTodoItem` intersection is now redundant** — 2.3 landed the ~~five~~ **six** fields on `todoSchema` verbatim from `clusterTodoFieldsSchema.shape`.~~ **CLOSED 2026-08-23** — alias deleted, all three consumers retyped to `TodoItem`, and the identity casts that existed only to bridge the two names deleted rather than left in place. (**Count corrected 2026-08-23:** the row said *five*; there are **six** — `pendingSince`, `pendingFields`, `hubSeq`, `tombstone`, `placement`, `startedOn`. `pendingFields` was added after the row was written, which is how the count drifted.) | Delete it, don't leave a second spelling of the same type. |
| ~~**`orgUserProvisioningStep('worker')` renders `org "worker"`** in its UI strings, because they are parameterized by slug rather than by mode.~~ **ALREADY FIXED — this row was STALE when re-checked 2026-08-23.** | Cosmetic, and the price of reusing the step rather than duplicating it — which was the right trade. Worth one string change. **The string change had already been made** and the row outlived it: `hetzner.ts:1686` calls `orgUserProvisioningStep(WORKER_PSEUDO_SLUG, 'this cluster worker')`, passing the `label` override the signature already provides, and every user-facing string in `provision-user.ts` renders `label`. The only two places that still spell the raw slug are correct: the invalid-slug error (which is *about* the slug) and `createOrgUserCommand`'s GECOS comment — which is the row above this one, deliberately out of scope. **Nothing to do; verified by reading the call site rather than by trusting the row.** Worth noting as a pattern: an open-items list decays as the code moves under it, so re-check a row before acting on it — acting on this one would have meant "fixing" something already fixed, and possibly re-breaking a deliberate judgement recorded one row up. |
| **`workflows/workspace-parallel.test.ts` flakes under full-suite load on the box — seen TWICE now, and a pristine-HEAD control did NOT reproduce it**, in "removes the directory, keeps `cez/<id8>`, and leaves no leftover entry on the record". `git status --porcelain` in the fixture project read `?? .ai/` where the test requires `''`, alongside stderr `failed to save runs.json: ENOENT … /.ai/cezar/runs.json.tmp` from two other boot roots — i.e. a store save racing the discard's cleanup, winning in one direction here and losing in the other there. | **RESOLVED 2026-08-23 — the control reproduced it. This IS pre-existing.** ~~Earlier reading: "3 failures in 6 runs of this branch's tree, 0 in 1 run of pristine `origin/main`", with "pre-existing" explicitly NOT established on one green control.~~ Repeated control runs were what it needed, and they were run: final tally on the box, all full-suite runs, same host and same `CEZ_VITEST_MAX_WORKERS=3` — **5 failures in 9 runs of this branch's tree, and 1 failure in 4 runs of pristine `origin/main`**, same assertion and same `?? .ai/` every time. **A pristine `origin/main` tree fails this test with nothing of ours in it**, so the branch did not cause it. Three isolated re-runs of the file pass 3/3 and the run after each failure was clean, so it is non-deterministic on both sides. The **rate** differs (roughly 1-in-2 against 1-in-4), which is consistent with the load coupling predicted here and not with a semantic one: this branch adds test files, which changes worker scheduling under a 3-worker cap and widens exactly the window the assertion sits in. Nothing in this change touches `workflows/`, `runs/` or worktree code. **The general lesson is that the earlier entry was right to refuse the "pre-existing" label on one green control, and right that only more control runs could settle it** — a label is not evidence, and the cheap fix (re-run the control N times) was available the whole time. Recorded rather than dismissed because the mechanism is real: an asynchronous `runs.json` save outliving the directory it targets. Whoever picks it up should start from the ENOENT, not from the assertion. |
| **The web suite has a shifting set of load-sensitive flakes too, newly observed 2026-08-23 and not previously recorded.** Across three full-suite runs of this branch on the box, three *different* web tests failed and never the same set twice: `add-project-dialog.test.tsx` ("registers exactly the checked rows…"), and two in `onboarding.test.tsx` ("D13: adding extra workspaces…"). Each passes 3/3 when its file is run alone. | **Read the assertion before attributing it.** `add-project-dialog`'s failure is `expected '/p/cezar/' to be '/p/added/'` — it `waitFor`s `onOpenChange`, then immediately asserts a **navigation**, which is a different signal; `/p/cezar/` is the previous test's location still rendered. So it is racing by construction, and load decides whether it wins. Not caused by this branch (which touches nothing under `packages/web/`), but worth fixing at the source: wait on the thing you are about to assert, not on a neighbouring one. Note this is the same failure class as the `todos.test.ts` `fs.watch` reds on the loaded Mac — **which the box exonerated**: 80/80 there, and a pristine-HEAD Mac control failed the same three by name. Attribution needs a control on the same host, in both directions. |
| ~~**D20 gated the cluster routes without updating its own two callers.**~~ **CLOSED 2026-08-23.** `runKbSubmitCommand` (`index.ts`) POSTed `/cluster/corpus/submit` with `content-type` and nothing else — **zero** auth headers — and `sources/cezar-hub/provider.ts` still sent the bearer pair D20 supersedes. Both run on a SPOKE, which does hold the secret, so both were fixable the same day even though the hub cannot verify anything yet. | Both now sign through a new `node-auth.ts#signedNodeRequestHeaders`, which exists for one reason: the way to get D20 wrong is to hash one body and send another (`JSON.stringify` twice is not guaranteed to agree), and that failure surfaces as `bad-signature` — the reason that reads as tampering. The helper takes `bodyText` as a string and RETURNS it alongside the headers, so the two are the same value by construction and there is nothing left for a test to enforce. Verified in both files against the real `verifyNodeHttpPrincipal` on the **captured sent request**, never a re-derivation, with negative controls for path / method / body / freshness / wrong-secret; mutation-checked twice (sign-a-different-body fails 6, re-adding a bearer header fails 2). Note what is NOT closed: every one of these signed writes still gets 401 `unknown-node` until the hub-side secret store lands (top row), so `cez kb submit` now names that gap explicitly instead of echoing `unknown-node`'s own "enroll it first" advice, which would be actively wrong. |
| **`runKbSubmitCommand` is not directly tested, and cannot be.** `index.ts` calls `main()` at module load, so importing it from a test runs the CLI. A package briefly exported the function citing a test file that was never written — and could not have worked as described anyway. | Reverted to unexported. The signing it does now lives in `signedNodeRequestHeaders` and is covered there; what stays uncovered is this command's own argument handling and its refusal messages. Worth extracting the command body to its own module if that coverage is ever wanted — do not widen `index.ts`'s exports for a test that has to spawn the CLI regardless. |
| **BLOCKS 3b.2 — the corpus family chooses its ACCESS SCOPE in an unsigned query string.** D20 signs `url.pathname`, never `url.search`, and that asymmetry is load-bearing (Hono's `c.req.path` excludes the query, so signing it would fail every query-carrying request on arrival). But `provider.ts#fetchManifest` asks for `GET /api/v1/cluster/corpus?scope=knowledge,domains,changelog,tasks` — so the single parameter this family puts in a query string is the one that decides what the caller may read. `CLUSTER_CORPUS_OPT_IN_SCOPE` (`reports`, `raw-input`) is off by default precisely because those 196 files carry phone numbers and chat ids that must not reach a disposable worker. Surfaced 2026-08-23 by the caller-signing package, as an aside about which `path` gets signed. | **Not exploitable today and will be the moment 3b.2 lands as written.** The routes answer 409, node auth fails closed for every node, and the hub cannot verify anyone — but the client exists and 3b.2 is written against the client. Within the 120s window a captured header trio replayed with `?scope=reports,raw-input` is indistinguishable from the original request. **The fix is a hub-side rule, not a signature change:** derive scope from the enrolled node's own grant, and treat the query parameter as a *narrowing hint at most* — asking for less than you are entitled to is harmless, asking for more must be refused by the grant. Recorded in `node-auth.ts`'s docblock next to the rule it is a counter-example to, because a rule stated in the abstract beside a live violation is how the violation survives review. |
| **A package's own green tests said nothing about the protected route surface.** D21 added three `/api/v1/*` routes and the box gate caught `bc-route-inventory.test.ts` red: §2 of `BACKWARD_COMPATIBILITY.md` calls that surface protected, so an unlisted route is a contract nobody agreed to keep. The implementing agent ran 13 hand-picked files, all green; the repo has 571. | Fixed by listing the three routes with their pairing-scope refusal, which is part of the contract rather than an implementation detail. **This is the standing hazard of briefing a fan-out agent to run only its own files — nobody runs the full gate, and 13 greens read as coverage.** The rule that keeps working: the orchestrator runs the full gate on the box at every barrier, and treats an agent's narrow green as evidence about its own files only. Note the same gate also EXONERATED that agent's three red `todos.test.ts` watch tests — 80/80 on the box — so the full run settles attribution in both directions. |

| **BLOCKS 1.5 — arming the periodic reconcile would perform E2 automatically, unattended, and that is the one thing P9 gates.** Found 2026-08-23 while scoping 1.5, by reading the two halves against each other rather than either alone. `PeriodicReconcileOptions.run`'s docblock (`cluster/reconcile.ts`) says the production caller is *"a **non-dry-run** `reconcileAll` against every peer this node is linked to"*. D21 says the opposite about the same operation: *"the real merge remains owner-gated by P9; what changes is that `--dry-run` becomes runnable at all"* — which is why `cez cluster reconcile` shipped **dry-run by default**, needing an explicit `--apply`. Both statements are in the tree today and they disagree about whether replication may write without the owner. | **Not a doc nit — it decides what happens the first time two nodes link.** The safety property that makes a non-dry-run pass sound is that `divergent-unclocked` rows are REFUSED, never auto-merged. But the divergence that motivated this whole design is **110 rows that exist only on the box**, and one-side-only is exactly the class a non-dry-run pass *does* merge. So arming 1.5 with the documented production caller performs E2 — the 110-row merge — automatically and unattended, on first link, with no operator present. That may well be the right end state; it is **not** a call to make while wiring a timer. **Do not wire 1.5 until this is decided.** Note the flag is currently OFF on `prod-host` (`CEZ_CLUSTER` unset in the running service, verified 2026-08-23), so nothing is armed today and there is no urgency — but that also means the contradiction will not announce itself; the first person to set the flag finds out. Resolve by deciding one of: periodic reconcile is dry-run-only and reports divergence (safe, and the CLI stays the only writer); or it applies but only after a first attended `--apply` pass per pairing; or it applies freely and P9's gate is retired deliberately, in writing. Whichever wins, correct the LOSING statement in place rather than appending the winner. |

### Found 2026-08-23 while wiring 1.5 — three things that made the link unusable end to end

Recorded here as well as in the spec (D23/D24/D25) because each was found by MEASURING the running
system rather than by reading the code, and the measurement is the part a future session will want.

| what | how it was found, and why it mattered |
|---|---|
| **The cluster HTTP family sat behind the cockpit auth wall, so D20/D21 could never work on a real deployment.** `server.ts`'s `app.use('/api/*', ...)` exempts only `/health` and `/ready`; everything else needs a **cockpit principal**, which a spoke cannot obtain. Fixed as spec **D24**. | Measured on the production hub over loopback, with a control: `/api/v1/health` → 200, `/api/v1/cluster` → **401 `{"error":"unauthenticated"}`**, `/api/v1/todos` → 401. The control is what makes it conclusive — the cluster route behaves exactly like an ordinary authed route, and the **401 rather than the flag-off 409 proves the wall fires before `requireCluster`**. Reading `cluster-routes.ts` alone would never show this: every gate in that file is correct, and all of them are downstream of a wall in a different file. The WS link was never affected (an upgrade never reaches Hono), which is why the two halves of the transport had to be checked separately rather than inferred from each other. |
| **Enrollment minted a credential and wrote no roster row, so a joined node was invisible AND its revoke silently did nothing.** Fixed as spec **D25**. | Found by pulling on a thread from the hub-router package, which had (correctly) declined to re-check `disabledAt` on `hello` because `disableNode` removes the node's secret. Checking whether that held led to: `redeemEnrollmentCode` never calls `upsertNode`, and the only production `upsertNode` call site is a `PATCH` that begins `if (!current) return 404`. So no code path creates a roster row. The security consequence is third in a chain of four — `disableNode` removes the secret only `if (found)`, and `found` means "the roster row existed", so **revoking a joined-but-unrostered node left a valid credential in place**. The lesson worth keeping: a correct local decision ("upstream already enforces this") is only as good as the upstream it names, and the cheap check is to go read it. |
| **The link client could not cross a Cloudflare tunnel, and the failure mode was an infinite retry rather than a refusal.** Fixed as spec **D23**. | Owner decision the same day: the cluster is CF-tunnel-only. Measured before building: `GET https://<hub>/api/v1/health` answers **302 with AND without** the existing Access service token — that token is scoped to the SSH application, so it buys nothing here. Testing *with* the credential and getting the same answer as *without* is what proved the token was the wrong one, rather than the request being malformed. The client sends exactly three node-auth headers and has no seam for anything else, so the symptom would have been a link reconnecting forever against a redirect, with backoff hiding it. |

**The pattern across all three:** each was invisible from the module that owned the concept, and visible
in one probe of the running system. None would have been caught by the unit suites, which were green
throughout — every one of these modules tests correctly against its own contract, and the defect was
in what sat above, beside, or in front of it.

### Ops preconditions of 0.7, not code

`resources.maxParallel: 8`, `resources.maxHeavySteps: 2`, and a memory bound
(`runMemoryMaxMb`, plus `runMemoryHighMb` / `runCpuWeight` / `runsSliceMemoryMaxMb` for C4) must be
written into `prod-host`'s own `~/.cezar/config.json` **before C1/C2/C3 are run**. C3 has
nothing to detect without a memory bound, and the heavy-step gate is inert without `maxHeavySteps`
by design. The bounds exist only under `scope` isolation — on the Mac cockpit all of it degrades to
no bound and no attribution, by construction, so the Mac cannot be the host for C3.

### The gate itself was broken for hours, and the fan-out is why nobody saw it

`npm test` — plain `vitest run` — died **in planning with zero tests executed** from the moment
package 0.5 added `maxWorkers` to `packages/cezar/vitest.config.ts`. Vitest 4 requires projects
that differ in `maxWorkers` to carry distinct `sequence.groupOrder`, and only `server` had the
field. Fixed by setting the cap on **every** project from the one derivation in
`search-parallelism.ts`, which is also what makes the cap real: bounding the burst means one
`run-tests` step must not claim the whole box, and capping `server` while `web` still forks a
worker per test file leaves it exactly as unbounded. Projects that agree share one pool, so the
budget now applies to the gate as a whole. Distinct group orders would have satisfied the validator
while leaving the cap partial and serialising the groups — slower and still wrong.

**The orchestration lesson, which is the part worth keeping.** P4 tells every package to run only a
narrow per-project command and never the full gate, for good reasons — twenty concurrent full gates
would thrash, and here a build would hot-swap two live cockpits. The cost is that **the full gate is
then run by nobody until the barrier**, so a break in the gate itself is invisible while every
package truthfully reports green. It surfaced only because one agent tried an unfiltered run on its
own initiative.

Two amendments to P4, for this plan and the next one of this shape:

1. **Run the unfiltered gate yourself, once, before the fan-out.** A known-good baseline is what
   makes a barrier failure attributable.
2. **A change to shared build or test config is an explicit exception to the narrow-command rule.**
   `vitest.config.ts`, any `tsconfig`, the root scripts: whoever lands one runs the full gate,
   because those are precisely the changes no narrow command can exercise.

Also note the second-order hazard: a cross-project narrow run (`vitest run <cezar-file>
<web-file>`) failed the same way and reported **"no tests"**, which is not a shape anyone reads as
red. Assert on "N tests passed", never on exit code alone and never on absence of output.

### `git stash` in a shared checkout is everyone's WIP, not yours

Disclosed by the package that did it, which is why it is here rather than undiscovered. Mid-
verification, one agent ran `git stash push --include-untracked` intending to test its five owned
files against a clean tree, caught the prohibition immediately and ran `git stash pop`. Nothing was
lost — the stash list is empty, the file counts match, and the whole tree subsequently passed
`typecheck` / `build` / `test:unit` / `test:package` on the box.

The reason the rule exists is exactly what happened: **`~/loki-labs/cezar` is ONE checkout shared by
every agent in the fan-out**, so that stash briefly held roughly twenty agents' uncommitted work —
broker isolation, workflows, server-install, the web routes — not the five files its author owned.
A pop that failed, or a second agent writing during the window, would have been unrecoverable, and
`.ai/cezar` is gitignored so parts of it would not even have been in the stash to restore.

`git diff` answers the same question read-only, and is what to reach for. The general form: in a
shared checkout, **no agent may run a command whose blast radius is the whole working tree** —
`stash`, `checkout .`, `reset --hard`, `clean -fd`. That includes restoring a mutation test: copy
the file to the scratchpad first and restore from the copy.

**IT RECURRED 2026-08-23, in a package whose brief prohibited it by name.** A second agent ran
`git stash push -- <two files>` to check whether the unmodified files at HEAD also failed
`prettier --check` — a legitimate question — and popped it back immediately. Verified afterwards:
stash list empty, all 23 expected files present, both diffs intact, nothing lost. Again.

The recurrence is the useful part, because it says something about how the rule fails. The brief
said "NEVER run `git stash`" and the agent ran it anyway — not carelessly, but because it wanted a
**baseline comparison against HEAD** and `stash` is the tool that comes to mind for that. A
prohibition with no named substitute leaves the agent holding a real question and no sanctioned way
to answer it, so it reaches for the familiar verb. Both occurrences were the same underlying need:
"what did this file look like before I touched it?"

So the rule now travels with its answer: **`git show HEAD:<path>` reads any file at HEAD, read-only,
with zero blast radius** — it is what `stash` was being used to approximate, and it works on a
shared tree. State the alternative in the brief beside the ban, not just the ban. (The enrollment
package did exactly this unprompted — it reverted its two files by writing `git show HEAD:...`
output over them to run the pre-fix negative control, then restored from a scratchpad copy. Same
question, no stash, no risk.)

### A green branch gate says nothing about the tree you will actually push

The branch gate on the box read 559 of 560 files green with only the standing C18 red. The merge
with `origin/main` — 33 commits the box's own agents had pushed while this fan-out ran — then took
the same tree to **3 failed files, 12 failed tests**, and none of the twelve were in a file the
merge touched textually. Git had reported two conflicted files and five hunks; it could not report
this, because nothing conflicted.

What broke: `origin/main`'s dead-twin fix made `instanceId` a **required** field of a fresh broker
launch (`spawnBroker` now throws `fresh broker launch requires an instance id`), moved the spool to
`<runId>.spool/<instanceId>`, and made `BrokeredSession` accept an `exit.json` only when its
`instanceId` matches the launch's. Two test files written earlier in this same fan-out
(`broker-external-kill.test.ts`, `broker-resource-wiring.test.ts`) constructed broker requests
without one, because when they were written the runner minted its own. Both were adapted to supply
an `instanceId` and to stamp it into every exit they write — which makes them *more* faithful to
`RunManager.brokerFor`, not less. Post-merge on the box: typecheck 0, **562 of 563 files green**,
the one red still C18.

The rule this yields: **the gate that authorises a push is the gate on the merged tree**, re-run
after the merge, never the branch gate carried forward. A long fan-out against a moving `main` makes
that mandatory rather than tidy — the contract a test was written against can be replaced under it
by a commit that never touches the test's file, and the only thing that detects it is running the
suite again.

### An open-items list decays, and two of its rows were already done

Measured 2026-08-23, re-checking this section before assigning work from it: **two of the rows were
stale — the thing they described had already been fixed**, hours earlier, in this same session.

- "`opencode-server-runner.ts` can still report an externally-killed run as `done`" — fixed in
  commit `5dd616f5`, with its own mutation-checked test file sitting right beside the runner.
- "`orgUserProvisioningStep('worker')` renders `org \"worker\"`" — fixed at the call site, which
  already passes the `label` override the signature provides.

Neither row was wrong when written. Both outlived their subject, because a row records a finding at
a moment and nothing re-reads it when the code moves underneath. The cost is not zero: an agent
handed a stale row spends a full context establishing that there is nothing to do, and the worse
case is that it "fixes" something already fixed — the `orgUserProvisioningStep` row sits directly
below one that records a deliberate decision to leave the GECOS field alone, so a literal reading
could have re-opened a judgement someone had already made and written down.

**The rule: re-verify a row against the code before assigning it, not after.** Cheap — both were
settled by one `grep` and one file read. And when a row turns out stale, strike it in place with
what actually happened rather than deleting it, so the next reader learns the row decayed rather
than wondering whether it was ever true. Both agents that found these reported them as findings
rather than quietly doing nothing, which is what made the decay visible at all — a brief that says
"verify the claim before acting on it, and tell me if it is already true" is what produces that.

### One methodological note, because it invalidates a whole class of claim

`grep` **silently finds nothing** in a file it classifies as binary, and four `.ts` files in this
repo are so classified — including `cluster/ops.ts`. They are not corrupt (no control characters,
they typecheck, and one of the four is untouched in git); the likely cause is the density of
multi-byte characters in the docblocks. So every "no other callers, confirmed via grep" in a
package report today had an invisible blind spot. The ones that decisions rested on were re-run
with `-a` and all held. Use `grep -a` for any audit whose conclusion is a negative.

### Found 2026-08-23 — an agent's summary of what it changed contradicted its own diff

`pkg-relay-affordance-guard` reported, twice and unprompted, that `workflows/run.ts` was untouched:
*"`run.ts` untouched (this fix needed no producer-side change — both closed at the boundary)"* and
*"`git status --porcelain`: `run.ts` clean (no diff)"*. `run.ts` was in fact modified, at two sites,
with exactly the explicit `name`/`url` projection that had been agreed. The work was right; the
report of the work was wrong.

It was caught by accident, and that is the point. The tell was not in the summary at all — it was a
docblock **inside the test file** saying `{ ...saved }` was *"now eliminated at the producer"*, which
cannot be true of a file nobody edited. Reading the artefact contradicted the cover letter.

Two costs, one of them nearly shipped:

1. **A stale gate.** The box snapshot had been `rsync`'d before `run.ts` changed, so the full suite
   was running against a tree missing the producer fix and a new activation test. A green result
   would have been reported for code that was not the code being committed. The fix is not "trust
   less" but **snapshot immediately before the gate and diff the file list after**, which is what
   caught the second artefact.
2. **The self-contradiction was inside one message.** No cross-checking between sources was needed
   to spot it — only reading the whole message against itself.

**The rule this earns:** an agent's claim about *what it did not touch* is exactly as unreliable as
its claim about what it did, and cheaper to check than either — `git status <path>` is one command.
Verify the negative, especially when the negative is what makes a gate result meaningful.

Related, same session: the `coverage: 'path-regex'` branch this agent added to the inventory test
looked like a classifier escape hatch and was mutation-tested for exactly that (mark a risky,
denylisted field as regex-covered and see if it slips through). It does not — risky fields are
required to be denylisted regardless of `coverage`, and the mutation went red on three tests naming
`cwd`. The suspicion was wrong and the check was still worth the two minutes.
