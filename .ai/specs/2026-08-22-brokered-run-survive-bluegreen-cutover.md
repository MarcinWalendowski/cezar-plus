# A brokered run is re-launched, not re-attached, across a blue-green cutover

**Status:** **Partial, QA Needed.** Phase 1 is implemented in `d65602b5` and pushed to
`origin/cez/cd439910`, but as of 2026-08-24 it is not an ancestor of `origin/main` and is not in
the deployed release `20260824T140312Z-a2a74f43`. Focused broker recovery tests passed 9/9, the
combined broker and cluster suites passed 37/37, and typecheck passed; no lint script exists. The
full root gate remained red at 11,383 passed, 3 failed, 4 skipped because of the separately specced
stable gate blockers in `.ai/specs/2026-08-24-stable-test-gate-blockers.md`. Phase 2's controlled
second-cutover production measurement has not run, and
`.ai/analysis/2026-08-22-bluegreen-cutover-measurement.md` does not exist. Therefore all three
task acceptance criteria remain open and Phase 3 must not mark the parent criterion MET.

**Note on this file's history:** an earlier pass of this same step wrote a
spec at this path and it was reviewed (verdict: revise) — but the file itself did not survive into
this retry's worktree (no commit, `git log --all` has no entry for it, and the brief the first pass
left under `.ai/specs/briefs/` is likewise gone). This is a **fresh write**, not an edit of that
draft; it is informed by the prior review's findings (quoted where relevant) but every fact below
was re-verified against the code and the live box during this pass, timestamped **2026-08-22
~04:20–04:41 UTC**.

**Date:** 2026-08-22
**Parent spec:** `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` — P4 ("Runs survive the
restart: the detached run broker"). That spec's own status header currently reads *"REOPENED
2026-08-21 19:05 UTC … criterion 1 does not hold on the blue-green cutover path"* and is now **stale
as of this pass** (see "What has changed since the reopen" below) — this spec does not edit it
(out of scope for this step), but a later step should, citing this file.
**Todo:** `45813876` (the three ranked suspects the reopening filed), tracked in the parent spec.

---

## TLDR

The parent spec's criterion 1 ("a deploy mid-run leaves the run alive and streaming") was reopened
2026-08-21 19:05 UTC after a controlled measurement showed a run's broker pid gone and its spool
*rewritten from byte zero* across a `--strategy=blue-green` cutover — i.e. `RunManager.recover()`
took the **interrupted** branch, not the **re-attach** branch, despite the broker machinery
reporting healthy. Three suspects were filed, ranked by plausibility.

**Suspects 1 and 2 are ruled out by reading the code, not by measurement:** `spoolDirOf()`
(`workflows/run.ts:1731`) is a pure function of `(dataDir, run.spoolDir ?? runId)` with no
release-relative path in it, and `spoolDirFor()` (`core/run-spool.ts:128`) never touches
`WorkingDirectory` or an install path — so a release flip cannot make either process "look in the
wrong place." A wrong-path bug would show as `isSpoolLive()` (`run-spool.ts:238`) returning `false`
because the directory or `meta.json` is missing; the actual evidence was a spool that **existed,
was readable, and named a live-looking broker whose pid had simply exited** — that is suspect 3's
shape, not 1's or 2's.

**Suspect 3 was the real bug, and it is already diagnosed, already fixed, and already deployed.**
Two commits, both ancestors of this branch's `HEAD` (`git merge-base --is-ancestor` confirms both):

- `fde2dae8` (2026-08-21 19:06 UTC) — `probeUserScope()` (`core/broker-isolation.ts:138`) read
  `XDG_RUNTIME_DIR` to decide whether a per-run systemd **scope** was available. Inside
  `cezar.service` that variable is unset, so the probe silently concluded `scope` was unavailable
  and `chooseIsolation()` (`:46`) fell back to `delegated` — the broker stays in `cezar.service`'s
  *own* cgroup, protected only by `KillMode=process`. Fixed by deriving `/run/user/<uid>` when the
  env var is absent (`:159`, `defaultRuntimeDir` at `:191`).
- `cf334d89` (2026-08-21 19:10 UTC) — even with the probe fixed, the broker is spawned through
  `buildChildEnv()` (`core/claude-cli-runner.ts:423`), an *allowlist* (#427), which drops
  `XDG_RUNTIME_DIR` on the way to the child — so `systemd-run --user` in the child still couldn't
  find the user bus and the scope launch failed silently. Fixed by merging `userScopeEnv()`
  (`broker-isolation.ts:201`) into the spawn env, but **only** in `scope` mode and **only** when the
  variable is genuinely absent (`claude-cli-runner.ts:424`).

**What has changed since the reopen — measured live during this pass, not asserted from memory:**

- `GET /api/v1/health` (`http://127.0.0.1:4321`, the box's actual bind) reports
  `runtime.runBrokerIsolation: "scope"` — not `"delegated"`. The probe fix is in effect.
- `systemctl --user list-units 'cezar-run-*.scope'` shows real per-run scope units under
  `user@999.service` — e.g. `cezar-run-29c070f0-….scope`, `ActiveEnterTimestamp=Sat 2026-08-22
  04:37:55 UTC` (command verified live: `systemctl --user show <unit> -p ActiveEnterTimestamp`
  answers directly, no sudo, as the `cezar` user). Brokers are landing in the scope, not the
  service's own cgroup.
- The current release is `20260822T041826Z-7ad35ad8`, `activatedAt: 2026-08-22T04:18:35.421Z`
  (`/opt/cezar-releases/deploy.json`), reached via `runGatedDeploy` (`server-install/deploy-strategy.ts:118`,
  default strategy `blue-green`) — i.e. a **real** blue-green cutover, not a plain restart.
- This task's own run record (`cd439910-…`) is itself brokered (`.ai/cezar/runs/cd439910-….spool/meta.json`,
  `stepId: "spec"`, `pid: 2042941`), and its predecessor steps ran across that same 04:18:35Z
  cutover. Per the handoff, the review step (verdict landed 04:36:14Z) observed, at that cutover,
  **five** runs — including this task's own — logging `"cezar restarted — this run kept going"`
  (`workflows/run.ts:1831`), a line that is reachable **only** from `reattachBrokeredRun()` after
  `isSpoolLive()` → `isPidAlive(meta.pid)` (`run-spool.ts:173`) returned `true` for the pre-existing
  broker. That line cannot be logged by the interrupted path.

**So the fix is deployed, live, and demonstrably taking the re-attach branch in production** — the
substance of criterion 3 (recover observed re-attaching, no interrupted error) and, by the pid-alive
precondition that gates it, the substance of criterion 1 (broker pid survives) are **already true**
of the current release. What is **not yet true** is the acceptance criteria's *specific evidentiary
form*: a paired before/after capture of (pid, `meta.json` identity, spool byte-prefix hash) recorded
**outside** the measuring run's own transcript, because the natural way to measure this — have the
agent doing the measuring watch its own broker across the cutover that also interrupts *its own
turn* — is self-referential and is exactly the shape of confusion the previous pass got tangled in.
Phase 2 below specifies the mechanics to do that measurement safely.

**One more thing surfaced by code reading, independent of suspect 3, and worth shipping first
because it is a real code change this spec can make today:** the non-boot `RunStore` flush gap
(see Problem → "A second, independent way to land on the interrupted branch"). It is not what
caused the 2026-08-21 19:02 incident (that box was still in `delegated` mode, which is a cgroup
problem, not a stale-record problem) but it is a second, currently-unfixed way to reach the same
symptom, and this task's own runs live in exactly the non-boot project it affects.

---

## Problem

### The reopened defect, restated precisely

`RunManager.recover()` (`workflows/run.ts:1579`) decides, for every `running` run, whether to
re-attach to a still-alive broker (`reattachBrokeredRun()`, `:1806`, called at `:1647`) or fall
through to the legacy path that marks the run `interrupted` and starts a fresh session (`:1656–1688`).
The 2026-08-21 19:02:41–19:02:48 UTC measurement (recorded in the parent spec, section "Criterion 1
was reopened by a controlled re-measurement") found the fall-through path taken while the broker
machinery reported healthy: broker pid 231420 and its `claude` child 231428 both alive before the
cutover, both **gone** after; spool grown from 21026 B to 24532 B with the same-length prefix hash
changed (`35201d24…` → different) — i.e. **rewritten from byte zero**, which `claude-cli-runner.ts:391`
does deliberately (`rmSync(request.spoolDir, …)`) at the *start* of a **new** broker launch, never
during a re-attach; and `meta.json` naming a brand-new broker (262531) started one second after the
deploy finished. That is a fresh session, not a resumed one.

### Why suspects 1 and 2 do not fit the evidence (code-read, not re-measured)

- **Suspect 1 (spoolDir/consumedOffset never persisted).** `brokerFor()` (`run.ts:1743`) writes
  `spoolDir` and `consumedOffset: 0` onto the run record *before* the spawn (`:1749`), and
  `persistConsumedOffset()` (`:1771`) updates `consumedOffset` on every offset advance (throttled to
  1/s, forced on session end). If these were never persisted, `spoolDirOf()` would fall back to the
  *default* layout (`run.spoolDir ? … : spoolDirFor(…, run.id)`, `:1732`) — which is the **same**
  path the broker actually used, since both are `spoolDirFor(runsDir, runId)`. So even a total
  persistence failure would not misdirect `isSpoolLive()`; it would just make `startOffset` wrong
  (a duplicate-replay bug, not a relaunch). Ruled out by the shape of the evidence: the spool
  existed at the path the new process could plainly see (it computed a byte size and a hash for it).
- **Suspect 2 (release flip changes the resolved runs dir).** `spoolDirFor(runsDir, runId)` takes
  `runsDir` as a parameter; the caller passes `join(this.dataDir, 'runs')` (`run.ts:1746`), and
  `dataDir` is `<project.root>/.ai/cezar` — a path under the **workspace's own project root**
  (`/var/lib/cezar/loki-labs/cezar`), never under `/opt/cezar` or any release directory. A release
  flip changes where the *server binary* is resolved from; it does not move where a project's own
  `.ai/cezar/runs/` lives. Ruled out for the same reason as suspect 1: the new process **did** find
  the spool (it read a `meta.json` and reported a size and hash for it) — it just found a spool that
  had already been overwritten by a **new** broker it had itself just launched.

### The actual mechanism (suspect 3, already fixed — see TLDR)

`isSpoolLive()` (`run-spool.ts:238`) ends in `isPidAlive(meta.pid)` (`:173`, a `kill(pid, 0)` probe).
In `delegated` isolation the broker sits in `cezar.service`'s own cgroup, and while
`KillMode=process` is documented (`broker-isolation.ts:16–20`) to protect it from a `systemctl
restart` (systemd signals only the main process), the *misclassification* itself — the box reporting
`delegated` when a real `scope` was actually obtainable — is what the fix commits close. Whether the
specific 19:02:41 incident died to a `stop`-shaped teardown of the delegated cgroup, or to some other
edge in the `KillMode=process` contract, is now moot: **the box is not in `delegated` mode any more**
(measured `"scope"` above), so re-deriving the exact mechanism by which `delegated` failed adds
nothing actionable. What matters is that `scope` mode is live and demonstrably re-attaching.

### A second, independent way to land on the interrupted branch

`reattachBrokeredRun()` reads the **run record**, not just the spool: `run.steps.find((s) => s.id
=== meta.stepId)` (`:1813`), `stepTerminal(openStep.status)` (`:1814`), and
`workflow.steps[resumeAt.index]?.id !== meta.stepId` (`:1822`) all gate on `run.steps`/`currentStepId`
as they exist **in the record `recover()` loaded from disk at boot**, not in whatever the previous
process's in-memory `Map` held.

`RunStore.updateRun`/`updateStep` (`runs/store.ts:735`, `:806`) both end in `scheduleSave()`
(`:1247`), a **debounced, `.unref()`'d** 300 ms timer — `saveNow()` (`:1256`) only actually runs when
that timer fires. On process exit before the timer fires, the write is lost from `runs.json` even
though it happened in memory.

On a graceful shutdown (`index.ts:807` `shutdown()`, wired to `SIGTERM`/`SIGINT` at `:823–824`,
which is what a blue-green cutover's `systemctl restart <unit>` — `server-install/release-deploy.ts:171`
— sends before any `SIGKILL`), the handler drains in-flight HTTP, then calls `store.flush()` and
`process.exit(0)` (`:819–820`). **`store` here is the single top-level `RunStore` opened at
`index.ts:698`** — the **boot** project's store only. Every **non-boot** project's own `RunStore`
(one per project, opened lazily by `ProjectContexts.build()` at `project-context.ts:425`) is never
referenced from `index.ts` at all: `startServer()` (`server/server.ts:7101`) builds its own
`sharedContexts` internally (`:7112`, `deps.contexts ?? new ProjectContexts(…)`) and **returns only
the `http.Server`** (`:7242` `return server;`) — the `ProjectContexts` instance is not exposed to the
caller. `ProjectContexts.disposeAll()` (`project-context.ts:386`), which *would* flush every
non-boot store via `teardown()` (`:478`, `ctx.store.flush()` at `:480`), has **no non-test caller
anywhere in `packages/cezar/src`** — confirmed by grep; every call site is a `*.test.ts` file's own
teardown.

**Concretely:** this task's own project (`cezar`, root `/var/lib/cezar/loki-labs/cezar`) is a
**non-boot** project — the box's `bootProject` is `"workspace"` (`/api/v1/health` →
`"bootProject":"workspace"`, matching the CLAUDE.md fact that `~/loki-labs/` is itself a small git
repo the boot project is rooted at). So a step transition, `currentStepId` change, or the tail end of
a `persistConsumedOffset` write that lands in the last unflushed 300 ms window before a cutover's
`SIGTERM` is **silently dropped** for this run and every other run in a non-boot project. The next
process boots from a **stale** on-disk record — one whose `run.steps`/`currentStepId` may no longer
match what the chain is actually doing — and `reattachBrokeredRun()`'s step-identity checks
(`:1813`, `:1822`) can fail against that staleness even though the broker pid is genuinely alive and
`isSpoolLive()` genuinely returns `true`. That failure lands on exactly the same interrupted branch
suspect 3 did, for a different reason, and it is **currently live and unfixed** on this box —
`project-context.ts:415` even documents the adjacent race ("whichever flushes last … truncates the
other's away") without naming this specific gap.

This did not cause the 19:02:41 incident (the box was in `delegated` mode then, a cgroup problem
upstream of anything the record contains), but it is a live, independent risk to the very
measurement Phase 2 needs to run, since this chain's own runs are in the affected `cezar` project —
so it is fixed first, not after.

---

## Solution

Two independently shippable pieces. Phase 1 is the only code change in this spec. Phase 2 is a
verification procedure — no code — that produces the paired before/after evidence the acceptance
criteria require. **It needs two cutovers, not one.** `runGatedDeploy` flips the release symlink and
only *then* restarts the unit (`server-install/deploy-strategy.ts:149,153`) — the process that
receives `SIGTERM` and runs `shutdown()` is still running the *old* release's code, symlink or no
symlink, so the cutover that installs Phase 1 exercises Phase 1's *absence*, not its presence. This
chain's own `deploy` step is therefore the **install** cutover; Phase 2 measures across a **second**,
subsequent `--strategy=blue-green` cutover (a redeploy of the same HEAD), whose outgoing process is
the first one to actually run Phase 1's shutdown path. Phase 3 is a record-keeping follow-up. The
parent spec's status header now correctly keeps criterion 1 open; its older historical `MET`
passages remain preserved beneath explicit correction text until Phase 2 supplies evidence that
can close the criterion.

### Phase 1 — close the non-boot `RunStore` flush gap

`startServer()` (`server/server.ts:7101`) already builds a `sharedContexts: ProjectContexts`
(`:7112`) with everything `disposeAll()` needs; it just never hands it back. Change its return type
from `ServerType` to `{ server: ServerType; contexts: ProjectContexts }`, replacing the current
`return server;` at `:7242` with `return { server, contexts: sharedContexts };`. The production call
site, `index.ts:762`, currently discards the return value entirely, so capturing it there is
additive — but it is not the *only* call site: `server/automations-gate.test.ts:201` also calls
`startServer()` and uses the returned value directly as an `http.Server`
(`server.once('listening', …)`), so this change needs a one-line fix there too (destructure
`{ server }`) or it breaks typecheck.

`index.ts`'s `serveCommand` captures `contexts` from that call and, inside `shutdown()`
(`:807–824`), calls `contexts.disposeAll()` **before** `store.flush()` (i.e. between the drain
(`:812`) and the boot store's own flush at `:819`). `disposeAll()` (`project-context.ts:386`) already
iterates every built non-boot context and flushes each one's `RunStore` via `teardown()` (`:478–483`);
per the `ServerDeps.contexts` comment (`server.ts:326`), **the boot project never lives in this
map**, so this cannot double-flush or double-dispose the boot store `index.ts` already owns —
the two calls are disjoint by construction.

This changes nothing about *when* a non-boot store saves during normal operation (the 300 ms
debounce is unchanged); it only guarantees the **last** in-memory state is durable at the one moment
that matters for re-attach: right before the process that held it exits.

### Phase 2 — the controlled, externally-recorded measurement

Requires **two** blue-green cutovers, per the correction above: this chain's own `deploy` step
**installs** Phase 1 (its outgoing process pre-dates the fix, so nothing about that cutover is what
gets measured); the procedure below runs across a **second**, subsequent cutover, triggered once
Phase 1 is confirmed live. The mechanics exist specifically because the measuring agent **is** a
brokered run and **is** a subject of the cutover it is measuring — its own turn gets
interrupted-or-reattached exactly like every other run, so anything held only in its live context
(not yet on disk) cannot be trusted to "survive itself."

1. **Confirm Phase 1 is live** before doing anything else — the release that just installed via this
   chain's own `deploy` step. If it hasn't installed yet, stop: measuring now would measure the
   install cutover, not a Phase-1-aware one.
2. **Before triggering the second deploy**, from a shell (not from the agent's own working memory),
   record to `.ai/cezar/tmp/<runId>/pre-cutover.json` — scratch space for the duration of this run
   only; step 6 below copies the final comparison somewhere durable:
   - this run's own broker pid and `claude` child pid, from `.ai/cezar/runs/<runId>.spool/meta.json`
     (`pid`, `childPid`);
   - the scope unit name (`brokerScopeUnitName(runId)`, `broker-isolation.ts:78`,
     `cezar-run-<runId>` with the same sanitization) and its
     `systemctl --user show cezar-run-<runId>.scope -p ActiveEnterTimestamp` value;
   - the spool's current byte size (`stat -c%s`) and a `sha256sum` of the **first N bytes**
     (`head -c N | sha256sum`) of `out.ndjson`, N = the size just recorded — a *prefix* hash, so a
     legitimate append after the cutover does not itself change it;
   - the run record's `spoolDir` and `consumedOffset` (via `cezar runs get <runId>` or a direct read
     of `runs.json` for the `cezar` project, since `GET /api/v1/runs/:id` requires the session
     `sessionResolver` this box's OIDC gate imposes — reading the state file directly sidesteps that
     without needing a token).
3. **Trigger** a second `cezar server-deploy --strategy=blue-green --follow` — a redeploy of the same
   HEAD Phase 1 shipped in step 1's cutover. This is the cutover whose outgoing process actually runs
   Phase 1's `shutdown()`.
4. **Force the non-boot `cezar` project's context to build, then wait on an observable, not a
   clock.** `RunManager.recover()` for a non-boot project runs only from `ProjectContexts.build()`
   (`server/project-context.ts:454`), which every boot-time path (`server/server.ts:7216`, `:7222`;
   `index.ts`'s runs-index loop) reaches only via `peek()`, never `context()` — so nothing builds it
   eagerly, and a sample taken before something else touches the `cezar` project would score the
   pre-cutover pid and byte-identical spool as PASS while `recover()` had never run for this project
   at all. Immediately after the deploy command reports the cutover complete: (a) issue one request
   that reaches the `cezar` project's context (a `cezar` CLI command or API call scoped to this
   project — either reaches `contexts.context('cezar')` and forces the build); then (b) poll — a
   bounded until-loop on a 1–2 s interval against a generous deadline (e.g. 30 s), per this repo's
   own doctrine against a fixed guessed sleep
   (`.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md`) — for one of: a new `lifecycle` line
   appended to `.ai/cezar/runs/<runId>.ndjson` (either the re-attach or the interrupted message,
   `run.ts:1831`/`:1665`/`:1672`), or `meta.json`'s `startedAt` changing. Record which of the three
   outcomes was observed — **re-attached**, **interrupted**, or **recover() never ran within the
   deadline** — as a distinct result, not folded into pass/fail. (A previous pass observed, at a
   different cutover, two `recover()` sweeps roughly 3.5 s apart; if that recurs here it is most
   likely `index.ts:733`'s boot-project sweep plus this step's own forced non-boot build — naming
   that mechanism precisely is optional, waiting on the observable instead of a fixed delay is not.)
5. **Re-read** the pid, scope-unit timestamp, spool size, and prefix hash the same way as step 2, and
   compare against the pre-cutover file:
   - **Criterion 1 substance:** broker pid unchanged, `meta.json`'s `pid` field unchanged, AND the
     scope unit's `ActiveEnterTimestamp` unchanged (this is the stronger check the live box now makes
     available — no pid-reuse ambiguity — and should be reported alongside the pid comparison, not
     instead of it).
   - **Criterion 2:** the pre-cutover prefix hash, recomputed against the **first N bytes of the
     post-cutover file** (same N), is identical. A changed hash means the spool was rewritten, not
     appended to, regardless of what the pid check shows.
   - **Criterion 3:** the lifecycle outcome from step 4 is **re-attached**, not **interrupted** or
     **never ran** — and the pre-cutover capture (step 2) already shows `spoolDir` present and
     `consumedOffset > 0`, per the criterion's own wording.
6. **Copy the final comparison to a durable, committed location before the run ends** —
   `.ai/analysis/2026-08-22-bluegreen-cutover-measurement.md`, not `.ai/cezar/tmp/<runId>/`: that
   scratch directory is `agentTmpRoot(dataDir)` (`runs/agent-tmpdir.ts:51–53`), and
   `sweepAgentTmpDirs()` (`:166`, called from `recover()` at `run.ts:1589`) deletes every subdirectory
   whose name is not a *live* run id, and `dropActive` clears it at run end — so the pre-cutover file
   this procedure writes in step 2 does not outlive the run being measured. Only when **all three**
   criteria hold does the parent spec's criterion 1 get marked MET — per this task's own acceptance
   criteria, this is an explicit AND, not "the pid check implies the rest."

### Phase 3 — mark the record (a later step's job, not this one's)

The document step has corrected the parent spec's status header in place to keep criterion 1 open
and point here. Once Phase 2's results exist, amend that same header again, following the
workspace's correction convention and citing both this file and the Phase 2 artifact. Do not mark
the criterion `MET` before all three acceptance checks pass.

---

## Architecture

```
                    cezar.service (KillMode=process, Delegate=yes)
                              │
                    systemctl restart <unit>   (server-install/release-deploy.ts:171,
                              │                  strategy default = blue-green,
                              ▼                  deploy-strategy.ts:118)
                    index.ts shutdown()  (:807)
                         │        │
              drain.drain() │        │ [PHASE 1 — NEW]
                         │        └──► contexts.disposeAll()  (project-context.ts:386)
                         │             flushes every NON-BOOT RunStore's pending
                         │             300ms-debounced writes (scheduleSave → saveNow)
                         ▼
                    store.flush()   (boot project only, index.ts:698/819)
                         │
                    process.exit(0)
                              │
              ── new process boots, RunManager.recover() (run.ts:1579) ──
                              │
              for each `running` run:
                reattachBrokeredRun(run)  (:1806)
                  spoolDirOf(run)  (:1731) — pure fn of (dataDir, run.id), unaffected by release path
                  isSpoolLive(spoolDir)  (run-spool.ts:238) → isPidAlive(meta.pid)  (:173)
                    │
                    ├─ pid alive, meta/step checks pass ──► pendingReattach + execute()
                    │      appendEvent 'cezar restarted — this run kept going'  (:1831)
                    │      [requires: broker actually in cezar-runs.slice, not cezar.service's
                    │       own cgroup — chooseIsolation()==='scope', broker-isolation.ts:46,
                    │       now measured live; AND run.steps/currentStepId on disk match the
                    │       live chain state — Phase 1 fixes the non-boot gap in this precondition]
                    │
                    └─ any check fails ──► legacy interrupted path (:1656–1688)
                           updateStep/updateRun status:'failed', error:'interrupted — …'
                           continueRun(RESTART_CONTINUATION_PROMPT)
```

---

## Phases

| # | Phase | Ships | Verified by |
| --- | --- | --- | --- |
| **1** | Non-boot `RunStore` flush on shutdown | `startServer()` returns `{server, contexts}`; `index.ts` shutdown calls `contexts.disposeAll()` before `store.flush()`; `server/automations-gate.test.ts:201` updated to destructure `{ server }` from the new return shape | new case in `recover-brokered.test.ts` (or a sibling file) simulating a stale on-disk record vs. a live in-memory one; `npm run typecheck`/`lint`/`test` green |
| **2** | Controlled, externally-recorded measurement across a **second** cutover (the first installs Phase 1) | Pre/post facts file, pid + scope-unit-timestamp + prefix-hash comparison, sampled once the non-boot project's `recover()` is confirmed to have run | manual/scripted procedure above, executed once per this task; final comparison committed to `.ai/analysis/2026-08-22-bluegreen-cutover-measurement.md` |
| **3** | Mark the parent spec's status header | Corrected header in `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`, citing this file | out of scope for this step; a later chain step's job |

Ordering: **Phase 1 ships, then Phase 2 measures across the cutover after that — not the same one.**
`runGatedDeploy` restarts the unit *after* flipping the symlink (`deploy-strategy.ts:149,153`), so
the process that runs `shutdown()` during any given cutover is still the release that was live going
into it. This chain's own `deploy` step installs Phase 1 but is not what Phase 2 measures; Phase 2
explicitly triggers one more `--strategy=blue-green` cutover afterward, and that second cutover's
outgoing process is the first one actually running Phase 1's fix.

---

## Data models

No `RunRecord` or spool schema changes — every field Phase 2 reads already exists (`RunRecord.spoolDir`,
`RunRecord.consumedOffset` — `runs/store.ts:179`, `:192`; spool `meta.json` — `run-spool.ts:137`;
`/api/v1/health.runtime.runBrokerIsolation` — established by the parent spec).

**New, Phase 2 only — the pre-cutover facts file** (`.ai/cezar/tmp/<runId>/pre-cutover.json` during
the run — scratch space only, reaped by `sweepAgentTmpDirs()` once the run ends
(`runs/agent-tmpdir.ts:51–53`, `:166`) — copied into the durable comparison at
`.ai/analysis/2026-08-22-bluegreen-cutover-measurement.md` before the run ends; written by a shell
command, not by application code, so neither is a schema this repo needs to version):

```jsonc
{
  "capturedAt": "2026-08-22T04:41:00.000Z",
  "runId": "cd439910-d96d-4d32-9493-b39b5654d66d",
  "brokerPid": 2042941,
  "childPid": 2043057,
  "scopeUnit": "cezar-run-cd439910-d96d-4d32-9493-b39b5654d66d.scope",
  "scopeActiveEnterTimestamp": "Sat 2026-08-22 04:36:15 UTC",
  "spoolBytes": 116119,
  "spoolPrefixSha256": "…"
}
```

**Changed API surface — `startServer()`'s return type** (`server/server.ts:7101`): from `ServerType`
to `{ server: ServerType; contexts: ProjectContexts }`. Internal to the `cezar` package (not part of
any published HTTP or CLI contract); the single call site is updated in the same change.

---

## API contracts

No HTTP or CLI contract changes. `GET /api/v1/health`'s `runtime.runBrokerIsolation` field already
exists (parent spec) and is what Phase 2 reads to confirm `scope` mode before trusting a measurement.

---

## Risks

- **`disposeAll()` during shutdown tears down more than a flush.** `teardown()` (`project-context.ts:478`)
  also calls `ctx.manager.dispose()` and `ctx.store.removeAllListeners()`. Since this only runs in
  the terminal path immediately before `process.exit(0)`, the extra teardown work has no observable
  consequence beyond the flush this spec needs — but it is worth calling out explicitly in review
  rather than assuming "it's just a flush."
- **The measurement is still self-referential in one respect:** the shell commands in Phase 2 are
  themselves issued by this same agent, inside the same brokered session, so a sufficiently badly
  timed cutover could interrupt the shell command itself mid-write. Writing the pre-cutover file
  *before* triggering the second deploy (step 2, before step 3) bounds this — the file is complete
  and fsynced (a normal file write) well before the risk window opens.
- **The "two recover sweeps ~3.5s apart" observation is unconfirmed by this pass** (no journald read
  access as the `cezar` user — `journalctl -u cezar` answers "insufficient permissions"). Phase 2
  step 4 no longer depends on this number: it waits on an observable (a new lifecycle line or a
  changed `startedAt`) rather than a fixed delay, so an unconfirmed sweep count cannot make the
  measurement fire too early. If a future pass gets journal access, confirming or explaining the
  two-sweep observation is still worth doing, just not load-bearing here.
- **Scope-unit name collisions across retries.** `brokerScopeUnitName()` (`broker-isolation.ts:78`)
  is deterministic in `runId`; a run that is re-attached (not re-launched) keeps the same unit, so
  `ActiveEnterTimestamp` staying constant *is* exactly the "same broker" signal Phase 2 relies on —
  but only for `scope` mode. If a box ever falls back to `delegated` or `none` (health reports it),
  Phase 2's scope-unit check is inapplicable and only the pid + hash checks apply.
- **Phase 1 is untested against a real non-boot project on this exact box until Phase 2's second
  cutover exercises it.** The install cutover (this chain's own `deploy` step) exercises Phase 1's
  *absence*, not its presence — see the Ordering note above — so it is specifically the second,
  Phase-2-triggered cutover that would surface a bug in Phase 1 itself, not the install. Keep the two
  failure signatures distinct in whatever report Phase 2 produces: a stale-record failure looks like
  `reattachBrokeredRun()` returning `false` on the step-identity checks (`:1813`/`:1822`) with a
  **live** pid confirmed separately; a cgroup failure looks like the pid itself being gone.

---

## Verification

**Automated (Phase 1, before any deploy):**

1. `recover-brokered.test.ts` (or a new sibling file) gains a case that constructs a `RunStore` over
   a `dataDir`, mutates a run's `currentStepId`/step status in memory without flushing, then — to
   simulate "the process exited before the debounce fired" — opens a **second** `RunStore` instance
   over the same `dataDir` (as the next boot would), builds a `RunManager` over it, and asserts
   `await manager.recover()` lands the run on the interrupted branch even though a live pid is
   injected — driving `recover()` end-to-end, the way the existing seven cases in this file already
   do, since `reattachBrokeredRun()` itself is private. Then repeat with `disposeAll()`/`flush()`
   called between the mutation and the second open, and assert `recover()` takes the re-attach branch
   instead. This is the regression the flush gap describes, made deterministic rather than
   timing-dependent.
2. `npm run typecheck`, `npm run lint`, `npm run test` green under the environment AGENTS.md
   prescribes, on the prod box, before deploying Phase 1.

**Live, on `prod-host` (Phase 2, run across the second cutover, after Phase 1 installs via this
chain's own `deploy` step):**

1. Confirm `runtime.runBrokerIsolation === "scope"` on `GET /api/v1/health` immediately before
   starting — if it has regressed to `delegated`/`none`, Phase 2's result would not generalize and
   should be re-run once it is `scope` again.
2. Confirm Phase 1 is the release currently live (Phase 2 step 1 above) — the chain's own `deploy`
   step installs it; nothing in this section measures across that cutover.
3. Execute Phase 2 steps 2–6 above, once, across one additional `--strategy=blue-green` cutover,
   waiting on the recover()-ran observable (step 4) rather than a fixed delay.
4. Report the three comparisons (pid+timestamp identity, prefix-hash equality, lifecycle-line outcome
   — re-attached / interrupted / never-ran) explicitly, with the actual before/after values — not
   just pass/fail — the same way the parent spec's own measurement tables do, so a future reader can
   audit the claim rather than trust it. Commit the report to
   `.ai/analysis/2026-08-22-bluegreen-cutover-measurement.md`.
5. Only mark the parent spec's criterion 1 MET if all three hold; if any fails, the failure signature
   (per the Risks section above) determines whether the next step is "Phase 1 has a bug" or "a fourth
   suspect exists" — either way, record it rather than re-opening blind.
