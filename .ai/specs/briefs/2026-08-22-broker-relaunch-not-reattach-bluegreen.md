# Brief — a brokered run is RE-LAUNCHED, not re-attached, across a blue-green cutover

**Task id:** cd439910-d96d-4d32-9493-b39b5654d66d
**Step:** 1/8 — Gather the record (this document is a brief, not a spec; no code was written)

**CORRECTED 2026-08-24:** the diagnosis below was a research snapshot before the follow-up spec
settled the mechanism. Its claims that none of the suspects had been ruled out, no post-reopen
broker-isolation fix existed, and suspect 2 was the most promising are superseded by
`.ai/specs/2026-08-22-brokered-run-survive-bluegreen-cutover.md`. Suspects 1 and 2 do not fit the
measured failure. Suspect 3 was the original cause: `fde2dae8` derived the user runtime directory
when `XDG_RUNTIME_DIR` was absent and `cf334d89` forwarded the user-scope environment through the
child allowlist, moving brokers from `delegated` to `scope` isolation. A separate non-boot
`RunStore` flush gap was then fixed in `d65602b5`, but that commit is only on the task branch and
the required paired blue-green acceptance E2E remains unrun. The original research text is kept
unchanged below.

## The problem, in this repository's own terms

`RunManager.recover()` is supposed to re-attach to a still-alive brokered run's spool after
the cezar server restarts, rather than treating it as interrupted and starting a fresh
session. It works across a bare `systemctl restart`/`stop→start` (the detached broker
survives, re-parented to PID 1, and the server picks the spool back up). It does **not**
work across a `cezar server-deploy --strategy=blue-green` cutover: the pre-cutover broker
and its `claude` child both vanish, the spool is rewritten from byte 0 instead of appended
to, and a brand-new broker/session starts about a second after the deploy finishes. That
means acceptance criterion 1 of the self-deploy spec ("a deploy mid-run leaves the run alive
and streaming") is **not** met on the one path that actually matters for self-hosted cezar —
despite every individual piece of the re-attach machinery existing and reporting healthy.

## What the record already decided — this is NOT a fresh discovery

**This exact defect, with this exact evidence, is already written up** in
`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` (KB id `specs-594acc539b36`). The
file's status line (top of file, lines 1–17) currently reads:

> **Status:** **QA Needed — REOPENED 2026-08-21 19:05 UTC.** … **criterion 1 does not hold on
> the blue-green cutover path**: a controlled re-measurement found the run RE-LAUNCHED, not
> re-attached. Criterion 2 stands. See "Criterion 1 was reopened by a controlled
> re-measurement". — **and NOT a prerequisite for anything**

The measured evidence (spec § "Criterion 1 was reopened by a controlled re-measurement
(2026-08-21 19:05 UTC)", lines 1081–1130) is **the same evidence given in this task's brief
verbatim** — same pids (231420 broker / 231428 claude → gone; new broker 262531 started
19:02:48.576Z, one second after the 19:02:46 cutover), same spool numbers (21026 B →
24532 B, prefix sha `35201d24…` differs after), same conclusion ("`RunManager.recover()`
did not take its re-attach branch; it treated the run as interrupted and started a fresh
session"), and the same "plain restart survives, cutover doesn't" contrast. The spec already
files **todo `45813876`** with the three suspects, in the same order given in this task:

1. `consumedOffset`/`spoolDir` never persisted onto the run record
2. the release flip moving the install path so the new process resolves a different runs dir
3. the deploy stopping the unit in a way that reaches the broker (isolation is `delegated`,
   not `scope`)

**None of the three has been confirmed or ruled out in the spec text** — it states them as a
ranked list and stops. **No commit since the reopen (`71e4d91f`, "criterion 1 does not hold
on the cutover path — reopen it with the evidence") has touched `recover()`, `run-spool.ts`,
or `broker-isolation.ts`** — only the spec doc changed. The only commit that has touched the
implicated area since (`3e6d1b7e`, "keep a one-shot brokered run's interval ref'd") is a
**different, already-shipped bug** in the one-shot CLI's own event-loop keep-alive
(`brokered-session.ts`), and that spec explicitly declares the server-side re-attach path
(`reattachSession`/`claude-cli-runner.ts:355-367`, `RunManager.recover()`) **out of scope,
untouched** — confirmed by a second research pass, no overlap.

**What this means for this task:** the "gather the record" step for a fresh brief would
normally end here — the record already contains everything the task's own Context paragraph
asserts, at a finer grain (a documented ranked suspect list under a filed todo). The next
step should treat this as **resuming/closing out `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`
§ Criterion 1 + todo `45813876`**, not opening a parallel investigation — and the acceptance
criteria in this task's own brief (spool-prefix-hash match, `spoolDir`+`consumedOffset`
persisted, re-attach branch observed) are effectively a restatement of what that todo already
asks for.

## What the record does NOT yet contain — new code-level findings from this pass

The spec names three suspects but doesn't cite the code. Reading `RunManager.recover()` and
its dependencies directly narrows things:

**The re-attach gate is a single boolean: `isSpoolLive(spoolDir)`.**
`packages/cezar/src/workflows/run.ts:1647` — `if (await this.reattachBrokeredRun(run)) continue;`
falls through to the legacy "interrupted" path (`:1656-1688`, marks failed, fires
`RESTART_CONTINUATION_PROMPT`, starts a fresh session) whenever it returns false.
`reattachBrokeredRun()` (`run.ts:1806-1854`) calls `isSpoolLive(spoolDir)` at `:1810`, where
`spoolDir = this.spoolDirOf(run)` (`:1809`, built from the persisted `run.spoolDir`, falling
back to the default layout if absent). `isSpoolLive()` (`packages/cezar/src/core/run-spool.ts:238-245`)
returns false on: dir missing, `meta.json` unparseable, protocol mismatch, `exit.json`
present, or `isPidAlive(meta.pid)` false — where `meta.pid` is the **broker's own** pid, not
the child's.

**Suspect 1 (offset/spoolDir never persisted) — partially contradicted, but a related
persistence gap exists that the spec doesn't name.** `spoolDir`/`consumedOffset` ARE written:
at run start (`run.ts:1746-1750`, before spawn) and on every offset flush
(`persistConsumedOffset`, `run.ts:1771-1787`, throttled to 1/sec, `force`d at session end,
`:4775`). But `RunStore.updateRun()` (`runs/store.ts:735`) only mutates in-memory state and
schedules a **300 ms debounced, `unref()`'d** disk write (`runs/store.ts:1246-1254`). That
debounce is only guaranteed to flush by the **boot project's** `SIGTERM`/`SIGINT` handler
(`index.ts:806-824`, `store.flush(); process.exit(0);`). Every non-boot project's `RunStore`
is only flushed by `ProjectContexts.dispose()`/`disposeAll()`, which — per grep — is **called
only from tests**, never from the server's shutdown path. So: **if the deployed run's project
is not the boot project, or if the last `updateRun` landed inside the un-flushed 300 ms
window, the persisted `consumedOffset`/`spoolDir` on disk could be stale or absent even
though the in-memory write happened** — this is a plausible, code-confirmed mechanism
distinct from "never persisted at all," and it isn't in the spec's suspect list. Whether it
applies depends on which project the measured run belonged to and whether `systemctl restart`
delivers `SIGTERM` (giving the handler a chance to run) before any `SIGKILL` — not yet
determined here.

**Suspect 2 (release flip moves the runs dir) — no direct support in the generic code path,
but one very plausible variant exists, unconfirmed at runtime.** `dataDir` is
`join(project.root, '.ai/cezar')` (`server/project-context.ts:422`), and `project.root` comes
from the project registry — not from `/opt/cezar-releases/<releaseId>` in general. The
*broker binary itself* re-execs from `import.meta.url` (`broker-launch.ts:50-55`), which does
resolve inside the versioned release path, but that only picks which `index.js` runs the
broker subcommand — it doesn't change where the spool is written. **However**, `.ai/cezar/runs`
is deliberately **excluded from the release-staging rsync** (`server-install/release-deploy.ts:150-157`,
widened by `6f3db24a` to also exclude `worktrees`/`tmp`) — meaning a new release's own
`.ai/cezar/runs` starts empty by design. If, for the box's own self-hosted "cezar" project,
`project.root` is registered as `/opt/cezar` (the symlink release-deploy flips at cutover)
rather than a stable checkout path, then `dataDir` resolves *through* that symlink and a
cutover would silently retarget every existing run's spool lookup to the new (empty) release's
`.ai/cezar/runs` — exactly reproducing the measured symptom. **This is the single most
promising unconfirmed hypothesis** and needs one runtime fact this repo-only pass can't
supply: what `project.root` actually is for the self-hosted "cezar" project's registry entry
on `prod-host`, and whether it's a plain filesystem path baked in at registration time
(stable) or one that traverses `/opt/cezar` at resolution time (unstable across a flip).

**Suspect 3 (isolation is `delegated`, broker reachable by the deploy's restart) —
code-confirmed gap between the spec's stated design and what's implemented, but doesn't
obviously explain a *cutover-specific* difference from a plain restart.**
`chooseIsolation()`/`probeIsolationCapabilities()` (`packages/cezar/src/core/broker-isolation.ts:46-50, 128-186`)
resolve to `'delegated'` on this box, not `'scope'` — confirmed live (`runBrokerIsolation:
"delegated"`, self-deploy spec line 51). But `buildBrokerLaunchArgv()` (`broker-isolation.ts:94-107`)
returns the launch argv **unchanged** for `'delegated'` (only `'scope'` gets special
treatment) — so, contrary to the self-deploy spec's own P4 design text ("the broker
`setsid`-detached into **a child cgroup the server creates**", spec line 471), no such child
cgroup is ever created in code. The broker sits in `cezar.service`'s own cgroup, protected
only by `KillMode=process` on the unit's main PID. A code comment at
`broker-isolation.ts:148-154` documents this exact hazard in the abstract ("protected only by
`KillMode=process`, which survives `systemctl restart` but NOT a full `stop`… a run therefore
survived seven restarts and then died on the first stop/start"). **This appears to conflict
with the spec's own measured contrast**, which says a plain `systemctl stop → start` *did*
leave the broker alive under the current, already-`delegated` configuration (self-deploy spec
lines ~1104–1110). Whether that comment describes stale pre-`delegated` history or a live,
still-true hazard under `delegated` mode is unresolved and worth checking (`git blame` on
that comment) before leaning on it. Separately: `release-deploy.ts`'s cutover issues exactly
one `systemctl restart <unit>` (`server-install/platforms/hetzner.ts:1194-1198`) — the same
primitive `--strategy=restart` uses — with no code in `release-deploy.ts`/`deploy-strategy.ts`
that explicitly signals or stops anything beyond that. So if isolation is the true cause, the
divergence must come from some difference in how systemd itself tears down a `restart` job's
cgroup depending on context (e.g. whether the unit's dependency graph or `ai `Delegate=yes`
drop-in are re-evaluated), not from anything `release-deploy.ts` does differently by design —
this needs a runtime/systemd-level check, not a code read.

## Code actually involved

- `packages/cezar/src/workflows/run.ts` — `recover()` (`:1579`), `reattachBrokeredRun()`
  (`:1806-1854`), `brokerFor()`/spool-dir assignment (`:1743-1758`), `persistConsumedOffset()`
  (`:1771-1787`), forced final flush (`:4775`).
- `packages/cezar/src/core/run-spool.ts` — `isSpoolLive()` (`:238-245`), `spoolDirFor()`
  (`:127-130`), `readSpoolMeta`/`readSpoolExit`.
- `packages/cezar/src/runs/store.ts` — `RunRecord.spoolDir`/`consumedOffset` schema
  (`:179`, `:192`), `updateRun()` (`:735`), debounced `scheduleSave()` (`:1246-1254`),
  `flush()` (`:1177`).
- `packages/cezar/src/index.ts` — boot-project shutdown flush + `SIGTERM`/`SIGINT` wiring
  (`:806-824`).
- `packages/cezar/src/server/project-context.ts` — per-project `RunStore.open()` (`:425`),
  `dataDir = join(project.root, '.ai/cezar')` (`:422`), `dispose()`/`disposeAll()`
  (`:375-389`, test-only callers).
- `packages/cezar/src/core/claude-cli-runner.ts` — `spawnBroker()` (`:375-443`), old-spool
  `rmSync` on fresh start (`:391`).
- `packages/cezar/src/core/broker-launch.ts` — `resolveBrokerCommand()` (`:50-55`, resolves
  via `import.meta.url`, i.e. off the running release).
- `packages/cezar/src/core/broker-isolation.ts` — `chooseIsolation()`/
  `probeIsolationCapabilities()` (`:46-50`, `:128-186`), `buildBrokerLaunchArgv()`
  (`:94-107`), the stop-vs-restart hazard comment (`:148-154`).
- `packages/cezar/src/server-install/release-deploy.ts` — `stage()` rsync excludes
  (`:150-157`), `runReleaseDeploy()` sequence (`:295-406`).
- `packages/cezar/src/server-install/deploy-strategy.ts` — `runGatedDeploy()`, calls
  `effects.restart()` (`:153/171/215`).
- `packages/cezar/src/server-install/platforms/hetzner.ts` — `restart()` →
  `systemctl restart <unit>` (`:1194-1198`).

## Prior decisions this would (or would not) contradict

- Does **not** contradict anything — it's a continuation of `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`'s
  own P4 design, which already anticipated a fallback ("fails open") but evidently the
  fallback is triggering when it shouldn't.
- Does **not** touch the recently-shipped, unrelated CLI-keepalive fix
  (`.ai/specs/2026-08-22-run-broker-cli-keepalive.md`, commit `3e6d1b7e`) — confirmed
  disjoint scope (client-side event-loop lifecycle vs. server-side recover()/re-attach).
- Does **not** touch the recent release-staging excludes fix (`6f3db24a`,
  `.ai/specs/2026-08-22-release-staging-excludes-worktrees-and-tmp.md`) beyond corroborating
  that `.ai/cezar/runs` has always been meant to live outside any release tree.
- Two other todos from the same reopen are adjacent but distinct and should not be
  conflated into this fix: `58e5954c` (the E2E probe scores vacuous/empty assertions as
  PASS — a harness defect, not a re-attach defect) and `e36b79c0`/`8dc8bf3a` (probe must
  report UNMEASURED instead of PASS on an empty sample).

## Open questions a spec will have to settle

1. **What is `project.root` for the self-hosted "cezar" project's registry entry on
   `prod-host`, and is it a stable filesystem path or does it resolve through the
   `/opt/cezar` symlink?** This is the single most actionable next check — it would confirm
   or rule out suspect 2 in one command (`readlink -f`, or reading the project registry) and
   is the strongest candidate given `.ai/cezar/runs` is deliberately excluded from every
   release's rsync.
2. **Which project's `RunStore` held the measured run, and did its `updateRun({spoolDir,
   consumedOffset})` reliably reach disk before the cutover's `systemctl restart` signalled
   the process?** Determines whether the newly-found debounce/flush gap (§ above) is in play
   alongside, or instead of, the spec's suspect 1.
3. **Does `broker-isolation.ts:148-154`'s "survives restart but not a full stop" comment
   describe the CURRENT `delegated` configuration, or a prior/different configuration?**
   `git blame` that comment against when `Delegate=yes`/`KillMode=process` were actually
   provisioned (self-deploy spec says 18:08–18:11 UTC 2026-08-21) to see if it predates or
   postdates the fix it seems to describe — needed to know whether suspect 3 is live or a
   red herring given the spec's own contrary measurement (plain stop→start DID survive).
4. **Does a blue-green cutover's `systemctl restart` differ from `--strategy=restart`'s
   `systemctl restart` in any way not visible in `release-deploy.ts`/`deploy-strategy.ts`**
   — e.g. does the symlink flip that happens immediately before it change what the *unit
   file itself* resolves (`WorkingDirectory`, `ExecStart`) even though the running process
   isn't restarted until the explicit call? Needs a systemd-level check, not a code read.
5. Given todo `45813876` already exists for this, should the eventual spec/fix be filed as
   closing that todo plus reopening/closing `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`'s
   criterion 1, rather than a new standalone spec? (Recommended: yes, given the acceptance
   criteria in this task are effectively restating that spec's own reopened criterion.)

## What I could not find

- No runtime/systemd-level evidence in this repo-only pass (couldn't check the actual
  `project.root` value, actual unit file contents, or cgroup behavior on `prod-host` —
  those require box access, which this gather step didn't use).
- No commit or in-flight branch that already attempts a fix for this specific defect —
  confirmed via `git log` on every implicated file (`run.ts`, `run-spool.ts`,
  `broker-isolation.ts`, `release-deploy.ts`) showing no post-reopen changes.
- No separate standalone brief/spec for this exact defect prior to this one — it has lived
  entirely inside the self-deploy spec's status log.
