# A brokered run must survive a full `systemctl stop && start`, not just a `restart` — verify `scope` isolation live, in production, under real disruption

**Status: spec only — the code fix this task assumed was still needed is ALREADY LIVE and
independently reconfirmed during this spec step. Revised after review (see review notes on
this task's handoff, 2026-08-22): the remaining work is now three parts — (0) two documentation
corrections and one small hardening fix, all non-disruptive and shippable without sign-off; (0.5)
a committed, re-runnable verification script that makes the disruptive test safe to run and
safe to re-run; and (1) a single deliberate, disruptive, operator-run production verification
(a genuine `systemctl stop cezar.socket cezar.service && systemctl start cezar.socket
cezar.service` — not just the service unit; see "This spec corrects the task's own framing"
below and Phase 1 for why). See "This spec corrects the task's own framing" below before
reading further — it changes what Phase 1 actually is.**

## TLDR

Task `bcc059a6`'s brief (`.ai/specs/briefs/2026-08-22-broker-isolation-delegated-vs-scope.md`)
concluded that the `probeUserScope`/`userScopeEnv` fix (`fde2dae8`, `cf334d89`) was deployed but
its effect unproven — "no run log has ever shown `runBrokerIsolation: "scope"` — only
`"delegated"`, even post-fix." **That conclusion is wrong, and this spec step re-verified why
live.** The brief's own `grep runBrokerIsolation` search missed every hit because
`.ai/cezar/runs/*.ndjson` stores each tool's stdout as a JSON string *inside* a JSON event, so a
literal `"scope"` in a health response is written to disk as `\"scope\"` (backslash-escaped) —
a plain-string grep for `"runBrokerIsolation": "scope"` (or similar) never matches that. Correcting
for the escaping, `runBrokerIsolation` reads **`"scope"`** in at least 7 separate task transcripts
between 2026-08-21T20:48:40Z (first observed under release `7e8f2938`, the first deploy to include
`cf334d89`) and 2026-08-22T02:40:47Z (the box's current release, `076278cf`, activated
02:40:28Z) — see "Live evidence" below for the full list with timestamps. It has **not** flipped
back to `delegated` at any point after that first sighting.

Independently, *this very spec-writing step* is itself a brokered run (cezar defaults to
brokering for any built tree). Reading its own process tree confirms, live, right now:

```
$ cat /proc/1788640/cgroup   # the run-broker for THIS task (bcc059a6), step "spec"
0::/user.slice/user-999.slice/user@999.service/cezar.slice/cezar-runs.slice/cezar-run-bcc059a6-8496-4e6c-9fc2-571e55695d16.scope
```

— a real per-run scope under `cezar-runs.slice`, not `/system.slice/cezar.service` (the
`cezar.service` MainPID's own cgroup is confirmed separately as `0::/system.slice/cezar.service`
for contrast). **This is acceptance criterion 2, met and observed directly, right now, on
`prod-host`.**

So of this task's four acceptance criteria, **two are already satisfied and were simply never
checked correctly**, and two — the actual disruptive test — have never been attempted since the
fix went live, because nobody has run a bare `systemctl stop && start` against production since
`7e8f2938` deployed 2026-08-21T20:50:44Z. This spec's only remaining work is that one deliberate
test, plus marking the record straight afterward.

## This spec corrects the task's own framing

The task description (and the brief that preceded this spec) frames the remaining work as "prove
the already-landed fix on the box." That framing is now stale as of this spec step's own
findings. The real remaining scope is narrower and different in kind:

| | Task's framing | What this spec found |
| --- | --- | --- |
| AC1 (`health` reports `scope`) | Unverified, needs a fresh deploy + check | **Already true**, has been true since 2026-08-21T20:48Z, needs only a **re-confirmation immediately before** the disruptive test (state can drift between now and whenever Phase 1 runs) |
| AC2 (broker in its own cgroup) | Unverified | **Already true**, observed directly from `/proc/<broker-pid>/cgroup` in this step |
| AC3 (survives full stop/start) | Unverified, "needs a deploy then a test" | **Genuinely unverified** — no code work implied, just the test itself |
| AC4 (no interrupted event, no seq gap/dup) | Unverified | **Genuinely unverified** — same test produces this evidence |

This means the disruptive part of this spec (now Phase 1, after a new Phase 0 — see "Phases") is
**not** "deploy the fix" (nothing to deploy — it is already the live release). It **is** a single
controlled disruption of the production service, which is why it needs explicit sign-off before it
runs — see Risks. Phase 0 is not code-free, though: review of this spec's first draft found that
"just run `systemctl stop && start` by hand" is not a safe procedure on this box (`cezar.socket`
keeps the port listening across a bare service stop, and the shell issuing the command lives
inside the very cgroup the test is disrupting) — so Phase 0 adds one small, non-disruptive,
committed script that makes the test itself safe and repeatable, plus one small hardening fix for
a silent-regression path the original code fix left open. None of Phase 0 touches the isolation
mechanism's own logic.

## Problem

cezar's run broker (P4, `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`) keeps an
agent run's actual backend process (`claude`, etc.) alive independent of `cezar.service`, so a
deploy or restart does not kill in-flight work. How completely that holds depends on
`runBrokerIsolation` (`packages/cezar/src/core/broker-isolation.ts`):

- `'scope'` — `systemd-run --user --scope --slice=cezar-runs.slice` places the broker in its own
  cgroup, structurally outside `cezar.service`'s cgroup tree entirely (it lives under
  `user@999.service`'s tree instead — see the live cgroup path above). No action on
  `cezar.service` — restart *or* stop — can reach it, because "reach" here means "is a member of
  the cgroup being torn down," and it categorically is not.
- `'delegated'` — the broker is `setsid`-detached but still lives inside `cezar.service`'s OWN
  cgroup, protected only by `KillMode=process`. That protects the tree from `systemctl restart`
  (which signals only `MainPID`), but **not** from `systemctl stop`, because deactivating a unit
  removes/empties its cgroup regardless of `KillMode` — `KillMode` governs what gets *signalled*,
  not whether the cgroup itself survives deactivation.

Task 7c2dd8f0's own run transcript recorded both outcomes back to back on 2026-08-21: 7 "cezar
restarted — this run kept going" events (18:31:57–18:45:35Z) then 12 consecutive "cezar restarted
— resuming the interrupted task from its last session" events (18:58:13–19:02:47Z, starting 3s
after a stop+start). At that time (per the self-deploy spec's own status table,
`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md:51`) production was measured running
`runBrokerIsolation: "delegated"` — consistent with the mechanism above: the 7 restarts survived
because `KillMode=process` protected them; the stop did not, because a stop empties the cgroup
outright.

`probeUserScope()` (`broker-isolation.ts:138-162`) required `env.XDG_RUNTIME_DIR`, which is unset
inside `cezar.service` (a login shell over ssh has it, which is why every manual operator probe of
`systemd-run --user` succeeded while the server's own capability check silently failed and fell
back to `delegated`). Two commits, both already ancestors of `main` HEAD `c73c8a2d` before this
spec was written, close that gap:

- `fde2dae8` adds `defaultRuntimeDir()`, deriving `/run/user/<uid>` when `XDG_RUNTIME_DIR` is
  absent (`broker-isolation.ts:138-162, 191-193`).
- `cf334d89` adds `userScopeEnv()` and merges it into the broker's spawn env, but **only** in
  `scope` mode (`broker-isolation.ts:201-208`, `claude-cli-runner.ts:422-425`) — `buildChildEnv`
  is an allowlist (#427) and was silently dropping `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS`
  even after `probeUserScope` started deriving them.

Both commits are in every release deployed since 2026-08-21T19:02Z at the latest (confirmed:
`git merge-base --is-ancestor cf334d89 7e8f2938` — true), and the live evidence above shows the
probe has been returning `scope` since the very next deploy after that. **The code problem this
task set out to fix is closed.** What is left is that nobody has yet subjected a live `scope`-mode
run to the one disruption it is specifically supposed to survive and `delegated` mode does not: a
full `stop` followed by a `start`, not a `restart`.

**A related problem the original fix left open, found during this spec's review pass.** The
capability probe that decides `scope` vs. `delegated` runs once per `RunManager` instance and is
then cached for the process's entire lifetime: `this.brokerIsolationCache ??=
chooseIsolation(probeIsolationCapabilities())` (`run.ts:1706-1707`). Nothing orders `cezar.service`
against the lingering user manager that has to be up first — `probeUserScope`'s one hard dependency
is `/run/user/999/systemd/private`, which `user@999.service` creates, and `cezar.service`'s own
`[Unit]` block declares only `After=network-online.target` / `Wants=network-online.target`
(confirmed via `systemctl cat cezar.service`) — no `After=`/`Wants=` on `user@999.service` at all.
A boot where `cezar.service` starts before `user@999.service` has finished would reproduce this
task's original symptom (silently pinned to `delegated`) for the process's entire lifetime, visible
only in an unwatched health field — exactly the failure mode this task exists to fix, just moved
from "probe reads the wrong variable" to "probe runs before its dependency is ready." This has not
been observed on `prod-host` — the box has been up continuously since before `scope` first
appeared and has not cold-booted since — so it is unconfirmed as a live bug, but the race is real
and the fix is cheap; see Phase 0.3.

## Live evidence (read during this spec step, 2026-08-22)

Every occurrence of `runBrokerIsolation` in `.ai/cezar/runs/*.ndjson`, found by grepping for the
correctly-escaped needle `runBrokerIsolation\":\"` (not the naive unescaped form, which is why the
brief's own search came back empty):

| task | first `"scope"` seen | release at the time |
| --- | --- | --- |
| `70f19253` | 2026-08-21T20:42:14Z reads `delegated`; 20:48:40Z reads `scope` (crosses the `7e8f2938` deploy mid-transcript) | `7e8f2938` |
| `e06f2169` | 2026-08-21T20:52:58Z | `7e8f2938` |
| `f272fda8` | 2026-08-21T22:37:47Z | (later release, unlogged sha in this excerpt) |
| `0762e872` | 2026-08-22T00:17:57Z | — |
| `d92e6b85` | 2026-08-22T01:43:51Z | — |
| `f2012c07` | 2026-08-22T02:08:16Z | — |
| `fb62168a` | 2026-08-22T02:40:47Z (9 minutes before this spec step began) | `076278cf`, live at spec-writing time — **do not treat this id as pinned**; the box has since moved to `256afb26` (see the round-2 review re-check note under "Sources read"), which still reports `scope`, so the finding holds across a release change and isn't tied to any one build |

No transcript shows a reversion to `delegated` after `70f19253`'s crossing. `fb62168a`'s hit is
against the release symlinked at `/opt/cezar` at spec-writing time (`readlink /opt/cezar` →
`/opt/cezar-releases/20260822T024019Z-076278cf`, confirmed live in that same tool call).

Direct process inspection, this step, right now:

```
$ ps -eo pid,ppid,uid,cmd | grep node
 753078       1   999 node .../dist/index.js --port 43037 ...   # unrelated dev cezar serve instance, ppid=1
1744584       1   999 /usr/bin/node /opt/cezar/packages/cezar/dist/index.js serve ...   # cezar.service MainPID
$ cat /proc/1744584/cgroup
0::/system.slice/cezar.service
$ pstree -sp $$
systemd(1)---node(1744584)---node(1788640)---claude(1788670)---bash(1796637)-+-head(1796662)
                                                                             `-pstree(1796661)
$ tr '\0' ' ' < /proc/1788640/cmdline
/usr/bin/node /opt/cezar-releases/20260822T024019Z-076278cf/packages/cezar/dist/index.js
  run-broker --spool .../runs/bcc059a6-....spool --run bcc059a6-... --backend claude
  --step spec --cwd .../worktrees/bcc059a6-... -- claude ...
$ cat /proc/1788640/cgroup
0::/user.slice/user-999.slice/user@999.service/cezar.slice/cezar-runs.slice/cezar-run-bcc059a6-8496-4e6c-9fc2-571e55695d16.scope
```

PID 1788640 is unambiguously the run-broker for this task's own current step (its argv names
`--run bcc059a6-8496-4e6c-9fc2-571e55695d16 --step spec`), and its cgroup is a per-run scope under
`cezar-runs.slice`, disjoint from `cezar.service`'s own `/system.slice/cezar.service`. Note the
process **tree** (`ppid`) still traces through `cezar.service`'s own node process — that is
expected and does not weaken the isolation: `buildBrokerLaunchArgv`'s doc comment
(`broker-isolation.ts:84-96`) explains `--scope` deliberately *adopts an existing process into a
new cgroup* while leaving its parent/stdio relationship alone. Cgroup membership, not process
ancestry, is what `systemctl stop`'s cgroup teardown acts on, and membership here is disjoint.

`cezar-runs.slice` itself: `systemctl status cezar-runs.slice` shows it `loaded (static)`, presently
`inactive (dead)` with `0` active units at the instant checked (between-step lull — scopes are
transient and exist only while a broker is actually running); `systemctl show
cezar-run-bcc059a6-....scope -p Slice` could not be queried against the **system** manager because
this is a `--user` scope (owned by `user@999.service`, not PID 1's manager) — querying it correctly
needs `systemctl --user show ... ` run as uid 999, not attempted in this step since the cgroup path
itself is already unambiguous proof.

## Non-goal: the self-deploy spec's *other* reopened criterion

`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` is currently **"QA Needed — REOPENED
2026-08-21 19:05 UTC"** for a *different* reason: a controlled blue-green cutover measurement
found a run **re-launched, not re-attached** (broker pid gone, `meta.json` naming a new broker
started after the deploy, spool rewritten from byte zero) — todo `45813876` lists three candidate
causes, of which "isolation is `delegated`, not `scope`" is only one. That spec's own text is
explicit that the observed failure was on a **blue-green cutover** (`systemctl restart` via
`release-deploy.ts`'s `restart()` effect, immediately following an rsync + symlink flip), not a
bare `systemctl stop && start` — and a plain stop/start in the *same* investigating session left a
different broker (pid 231420) alive and re-parented, which the spec explicitly says is not
evidence either way for the cutover-specific bug. **This spec's acceptance criteria name a bare
`systemctl stop cezar.service && systemctl start cezar.service`, not a blue-green deploy** — a
narrower, different scenario. A pass on this spec's test does not close that spec's reopened
status, and this spec makes no claim that it does. If the live-fire test in Phase 1 happens to
also shed light on the other two candidate causes (`consumedOffset`/`spoolDir` persistence, or the
release-flip path resolution), that is incidental and should be filed against todo `45813876`
separately, not folded into this spec's acceptance criteria.

## Solution

No change to the isolation mechanism itself — it is built, deployed, and independently confirmed
live twice over (health endpoint, direct cgroup inspection). What this spec adds is three things,
in order of how disruptive they are:

1. Two documentation corrections that are already true today and don't depend on any test outcome.
2. One small hardening fix for the caching/ordering race identified above ("A related problem…").
3. A committed, re-runnable verification script, because review of this spec's first draft found
   that the disruptive test cannot safely be described as prose run by hand on this box: a bare
   `systemctl stop cezar.service` doesn't produce a real down window here (`cezar.socket` keeps
   127.0.0.1:4321 listening and re-triggers the service on the next inbound request), and the
   operator's own shell issuing the stop/start lives inside the very cgroup the test disrupts, so a
   genuine failure of the mechanism under test could kill the recovery command along with
   everything else. The script exists to make the test itself safe, controlled, and repeatable —
   see Phase 0.4 and Risks.

Items 1–3 are all non-disruptive and ship without sign-off (Phase 0). The disruptive test itself —
actually running the script against production — is still a single deliberate, operator-run action
needing explicit sign-off (Phase 1).

### Why the disruptive test has not simply been run as part of this spec step

Stopping `cezar.service` (and, per the correction above, `cezar.socket` with it) is disruptive to
**every** currently in-flight task on the box, not only a designated test subject — this task's own
remaining steps (3 through 8) included, plus whatever concurrent sibling tasks are running (at
spec-writing time, `.ai/cezar/runs/*.ndjson` mtimes show at least four other tasks actively being
written to: `95d3c6f2`, `f32d72ba`, `312fe333`, `ac844128`). Per this workspace's standing
instructions ("don't build or run anything without asking" — global CLAUDE.md; "flag anything
genuinely destructive or irreversible... before doing it" — Executing Actions With Care), and
because this step's brief was explicitly scoped to "write a spec... NOT implementing it," the
stop/start itself belongs in the implementation phase, run with the operator's explicit go-ahead
and ideally at a moment with no other tasks that would be surprised by a mid-run restart.

## Architecture

No component boundaries change. The re-attach path this test exercises already exists in full:

```
systemctl stop cezar.service          systemctl start cezar.service
        │                                       │
        ▼                                       ▼
  cezar.service's OWN cgroup            new cezar.service process boots
  is torn down — but the                       │
  broker's cgroup is a DISJOINT                ▼
  tree under user@999.service,          RunManager.recoverInterruptedRuns()  (run.ts, "running" branch)
  untouched by this                             │
                                                 ▼
                                    reattachBrokeredRun(run)   (run.ts:1806-1856)
                                      ├─ backend is a brokered backend?
                                      ├─ isSpoolLive(spoolDir)?        (run-spool.ts:238)
                                      ├─ readSpoolMeta(spoolDir)       (run-spool.ts:146)
                                      │    .runId === run.id && .stepId set?
                                      ├─ open step matches meta.stepId, not terminal?
                                      ├─ reviveWorkflow + chainResumeAt agree with meta.stepId?
                                      └─ ALL true → pendingReattach set, append lifecycle event
                                           'cezar restarted — this run kept going',
                                           re-enter execute() at the surviving step
                                    (any check false → falls through to a SECOND, unrelated
                                     revival path before the legacy one: reenterChain(run,
                                     'cezar restarted', { onlyIfMoreStepsFollow: true })
                                     (run.ts:1653) — re-enters the CHAIN at the interrupted
                                     step's own index if later steps still follow it; neither
                                     of its own log messages match the two strings this spec's
                                     assertions grep for, so a failure that lands here reads as
                                     "'kept going' missing" with no 'interrupted' event either —
                                     still correctly a test FAIL, but Phase 3 root-causing needs
                                     to know this branch exists)
                                    (only if BOTH of the above return false: falls through to the
                                     OLD legacy path — mark step/run 'failed' with error
                                     'interrupted — cezar process exited during the run',
                                     then continueRun() with RESTART_CONTINUATION_PROMPT,
                                     logging 'cezar restarted — resuming the interrupted
                                     task from its last session')
```

`reattachBrokeredRun` fails open by design (every uncertain branch returns `false`, per its own
doc comment) — this spec's test is exercising whether it reaches the true branch when the cause of
interruption is a full stop rather than a crash or a restart, now that the broker survives the
former the same way it always survived the latter.

## Data models

None. No persisted shape changes — `meta.json`, `exit.json`, `runs.json`, and the `RunEvent`/`seq`
shape are all untouched by this spec.

## API / interface contracts

None. `runtime.runBrokerIsolation` on `GET /api/v1/health` already exists
(`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`, `runtime-info.ts:19-46`) and already
reports the value this spec verifies; this spec adds no new field, flag, or endpoint.

## Phases

### Phase 0 — ship unconditionally: no disruption, no sign-off, independently shippable

Everything in this phase is true today and does not depend on Phase 1's outcome. It is the
implementation step's actual deliverable — commit, gates, deploy, stop there; the disruptive test
in Phase 1 is a separate, later, operator-run action.

0.1. **Correct `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md:51` in place**, per this
   workspace's "a correction marks what it invalidates, in place" rule: that line currently reads
   `runBrokerIsolation: "delegated"` — `not "none"` as its own caveat. It is stale as of
   2026-08-21T20:48Z and should read `"scope"` with a dated correction noting when and why it
   changed, leaving the original `"delegated"` text below, struck through or clearly marked
   superseded, per the same convention the file already uses elsewhere in its own text (e.g. its
   `:13` and `:1080` correction blocks). Do **not** touch that spec's own `QA Needed — REOPENED`
   status line — that reopening is about the unrelated blue-green re-attach bug (see "Non-goal"
   above) and stays open regardless of this spec's outcome.

0.2. **Correct the stale note in `docs-811a352fc1e3`** (`docs/server-install/hetzner.md`) flagged
   by the brief: it still describes the agent-driven-deploy re-exec gap as open, but that was
   closed by `07f5c274` (`decideReExec` reading `KillMode`, using the user bus) on 2026-08-21.
   Small, independent of everything else in this spec.

0.3. **Close the caching/ordering race** identified in "Problem" ("A related problem…"). Review of
   this spec's first draft found that a unit-ordering fix alone cannot be the load-bearing
   mitigation: `nonDisruptiveDropIn` today emits a `[Service]`-only body (verified —
   `systemd-analyze verify` on a drop-in with `After=`/`Wants=` pasted into `[Service]` prints
   `Unknown key 'After' in section [Service], ignoring.` and the same for `Wants=`; those are
   `[Unit]` directives), and its only caller, `release-cli.ts:192`
   (`{ socketUnit: socketUnitName(unit) }`), has no uid to give it even if the section were fixed.
   So this step is now two changes, not symmetric — one closes the race in code that actually
   reaches the box, the other is defense-in-depth that a human has to carry the rest of the way:
   - **(closes the race, ships in this deploy) Re-probe instead of caching a non-`'scope'` result.**
     Change `brokerIsolation()` (`run.ts:1706-1708`) from unconditionally caching the first probe —
     `this.brokerIsolationCache ??= chooseIsolation(probeIsolationCapabilities())` — to caching only
     a `'scope'` result and re-probing every call otherwise:
     ```ts
     brokerIsolation(): BrokerIsolation {
       if (this.brokerIsolationCache !== 'scope') {
         this.brokerIsolationCache = chooseIsolation(probeIsolationCapabilities());
       }
       return this.brokerIsolationCache;
     }
     ```
     `probeUserScope` is two `existsSync` calls (`broker-isolation.ts:138-162`) and
     `brokerIsolation()` is consulted per run-start (`run.ts:1755`, `:4680`), not per event, so the
     repeated work is negligible. This closes the race regardless of unit ordering: if
     `user@999.service` is still starting when `cezar.service` first asks, the process now keeps
     asking until it is up, rather than locking in the wrong answer for its own lifetime. This is
     the change that actually ships to `prod-host` in Phase 0's deploy — the ordering bullet
     below does not, on its own (see below).
   - **(defense-in-depth, does not close the race by itself, needs a manual follow-up step it
     does not get in this spec) Emit `After=`/`Wants=user@<uid>.service` in a `[Unit]` section.**
     Add a `[Unit]` stanza above the existing `[Service]` stanza in `nonDisruptiveDropIn`'s output
     (a single drop-in file may carry both sections; systemd merges each section against the base
     unit independently) — or, equivalently, a second drop-in
     `41-order-after-user-manager.conf` containing only `[Unit]` — so `cezar.service` is ordered
     after the user manager that owns `/run/user/<uid>/systemd/private`. The generator has no uid
     today (`NonDisruptiveDropInOptions` is `{ socketUnit, runsSlice? }`, and `release-cli.ts:192`
     passes only `socketUnit`), so add an optional `runAsUid?: number` to
     `NonDisruptiveDropInOptions`; when absent, emit no `[Unit]` section at all (never guess —
     `user@0.service` orders against root's manager, which is worse than the missing ordering
     it's meant to fix). `release-cli.ts`'s `migrate` command resolves the uid the same way
     `provision-user.ts:162` already resolves one elsewhere in this codebase — shell out to
     `id -u <username>` — where `<username>` comes from the base unit's own `User=` line (read the
     existing `${systemdDir}/${unit}` file and regex for `^User=(.+)$`; the base unit is
     hand-written and already carries it, per this file's own top comment). If the base unit has
     no `User=` line (runs as the systemd default, i.e. root) or the file can't be read, skip the
     `[Unit]` section and print a one-line notice — don't fail the migrate command over a
     best-effort hardening step. Whichever form ships, it is a **generator** change: it does not
     retroactively rewrite the drop-in already installed on `prod-host`, and no phase in this
     spec performs the `systemctl daemon-reload` + drop-in regeneration needed to pick it up on the
     live box — say so plainly in the commit and leave it as a named manual follow-up, not an
     implied side effect of Phase 0 shipping. Because the re-probe change above already closes the
     race in the code that does deploy, this step remaining un-applied on the box is a missed
     hardening layer, not an open instance of the original bug.
   - **Log the non-`'scope'` case instead of leaving it silent.** Confirmed today:
     `brokerIsolation()` has zero log or console calls (`run.ts:1706-1708`) — not "info-level", not
     "silent by omission of a check", genuinely no logging exists. Add a `console.warn('[cez] ...')`
     when a probe (the first one, or any re-probe under the change above) resolves to something
     other than `'scope'`, matching this file's own existing warning style (`console.warn(...)` at
     `run.ts:951`, `:2317`, `:2333`, `:2355` — there is no `logger`/`pino` instance in `run.ts`, only
     direct `console.warn`). A wrong result should never again be silent, since silence is exactly
     what let this task's original bug ship unnoticed.

0.4. **Add a committed, re-runnable verification script** —
   `packages/cezar/scripts/verify-stop-survival.sh`. Review of this spec's first draft found that
   describing the Phase 1 test as prose invites a false PASS (see Phase 1's own note) and leaves no
   way to re-run the same check after the next deploy or the next drift. `packages/cezar/scripts/`
   today holds only `.mjs` files (`check-pack.mjs`, `deploy-e2e-probe.mjs`, `install-as-command.mjs`,
   `mock-claude.mjs`, `mock-pi-rpc.mjs`, `sync-readme.mjs`, `test-process-usage.mjs`) — this is the
   first `.sh` in the directory, not a new pattern for a new location. `package.json`'s `files`
   array already includes the whole `scripts` directory verbatim (no per-file allowlist), so
   `check-pack.mjs`/`findPackGaps` need no change for the new file to ship in the published
   tarball — but create it with executable bits (`mode: 0o755`, matching the existing executable
   scripts in that directory — `deploy-e2e-probe.mjs`, `mock-claude.mjs`, `mock-pi-rpc.mjs` are all
   `0755` on disk today, while the non-executable ones are `0644`) so it survives packing and
   extraction runnable, not just readable. The script's contract, concrete enough to implement
   without further design work:
   - Run as **root** (not the `cezar` service user) — arming the independent restore watchdog
     (step 3 below) creates a *system* transient unit, which `hetzner.md:346-353`'s polkit grant
     explicitly does not extend to the `cezar` user ("never the right to create *system* transient
     units, which run as root"). The script must fail fast with a clear message if not run as root,
     rather than silently skipping the watchdog.
   - Flags: `--run-id <id>` (the test-subject run to watch), `--watchdog-seconds N` (default 180),
     `--yes` (skip the interactive confirmation prompt — for use only when the operator has already
     confirmed out of band).
   - Step 1 (precondition): `curl -fsS http://127.0.0.1:4321/api/v1/health | jq -r
     .runtime.runBrokerIsolation` — abort with a clear message if not exactly `scope`.
   - Step 2 (baseline, all captured with timestamps). Locate and validate the broker before
     touching anything, using the same preconditions `reattachBrokeredRun` itself gates on
     (`run.ts:1806-1856`) — the Risks section's own "false negative from an unrelated cause" bullet
     names exactly these as the failure mode if skipped:
     - Read `<dataDir>/runs/<runId>.spool/meta.json` (`spoolDirFor`, `run.ts:1746`) and pull the
       broker pid from its `.pid` field — this is the same field `isSpoolLive` (`run-spool.ts:238`)
       tests for liveness, not the backend CLI's pid (`meta.json`'s separate `.childPid`,
       `run-spool.ts:146`).
     - Assert the run's `backend` is in `BROKERED_BACKENDS` (`broker-launch.ts:72` — today just
       `['claude']`) — abort with a clear message otherwise, since a non-brokered backend cannot
       reattach regardless of isolation mode and the test would be measuring nothing.
     - Assert `meta.stepId` is set and names a step that is currently open (not terminal) on the
       run — abort otherwise, since `reattachBrokeredRun` requires the open step to match
       `meta.stepId` before it will take the true branch (`run.ts:1806-1856`), and a run sitting
       between steps is exactly the false-negative case the Risks section warns about.
     - Only once those hold: capture the broker pid's cgroup (`/proc/<pid>/cgroup`), the run's
       `.ndjson` `seq` high-water mark, and — this is the control the first draft was missing —
       `systemctl show cezar.service -p InvocationID -p MainPID -p ActiveEnterTimestamp`.
       `cezar.socket`'s own state too (`systemctl show cezar.socket -p ActiveState -p
       InvocationID`), since the socket, not just the service, is being stopped.
   - Step 3 (arm the independent restore, from outside the target cgroup, before the stop):
     `systemd-run --on-active=${WATCHDOG_SECONDS} --unit=cezar-restore-watchdog-$(date -u
     +%s 2>/dev/null || echo fallback) /bin/systemctl start cezar.socket cezar.service`. This
     transient unit lives outside `cezar.service`'s cgroup and outside the shell running this
     script, so it fires even if the stop kills the invoking shell — the exact failure mode the
     test exists to probe for. `systemctl start` on an already-active unit is a no-op, so a
     harmless late fire after a successful manual recovery is not a bug.
   - Step 4 (confirmation, unless `--yes`): print the baseline and the watchdog unit name, prompt
     for explicit confirmation before proceeding.
   - Step 5 (the disruption — **both units**, not just the service, per Phase 1's note below):
     `systemctl stop cezar.socket cezar.service`, sleep a fixed short window (e.g. 5s) to represent
     a genuine down window, then `systemctl start cezar.socket cezar.service`.
   - Step 6 (post-check, all against the Step 2 baseline):
     - `systemctl show cezar.service -p InvocationID -p MainPID -p ActiveEnterTimestamp` — assert
       **all three changed**. This is the proof the stop actually happened; without it, "no
       interrupted event" is not evidence of anything (see Phase 1 / Risks).
     - the broker pid from Step 2 is still alive and its `/proc/<pid>/cgroup` is unchanged.
     - the run's `.ndjson`, tailed from the Step 2 `seq` high-water mark, contains exactly one
       `cezar restarted — this run kept going` lifecycle event and **no** `interrupted — cezar
       process exited during the run` or `cezar restarted — resuming the interrupted task from its
       last session` event, and `seq` is strictly consecutive across the gap with no repeat.
     - `runtime.runBrokerIsolation` still reads `scope` from a fresh `/api/v1/health` call.
   - Step 7: if the watchdog unit is still pending, `systemctl stop
     cezar-restore-watchdog-<ts>.timer` (or the transient unit's actual name as printed in Step 3)
     to clean it up; if it already fired, note that in the output but do not treat it as a failure.
   - Exit non-zero on any assertion failure, printing which one, so the script is usable both
     interactively and as a recorded artifact.

### Phase 1 — the live-fire test (operator-run, using the Phase 0.4 script)

This phase is unchanged in substance from the original spec — a single deliberate disruption of
production, needing explicit sign-off — but its mechanics are now "run the Phase 0.4 script as
root," not "an operator types commands by hand," for two reasons found during review of this
spec's first draft:

- **`cezar.service` is socket-activated and a bare `systemctl stop cezar.service` is not a full
  stop on this box.** Confirmed live: `cezar.socket` is `active (running)` on `127.0.0.1:4321`,
  `Triggers: cezar.service` (`systemctl status cezar.socket`), installed by
  `nonDisruptiveDropIn`/`cezarSocketUnit` (`socket-unit.ts`) as P3 of the self-deploy spec. Stopping
  only the service leaves the socket listening; the next inbound request — the cockpit polling, the
  tunnel, an operator's own `curl` — re-activates `cezar.service` on its own, and the operator's
  subsequent `systemctl start` may hit an already-running process. That would not invalidate the
  underlying mechanism (the cgroup is still torn down at the moment of the stop), but it breaks the
  *test*: observing no interruption events in that scenario proves nothing, because the "stop" may
  not have produced any real down window at all. Hence Step 5's `systemctl stop cezar.socket
  cezar.service` (both units) and Step 6's InvocationID/MainPID/ActiveEnterTimestamp assertion —
  without that assertion, a false PASS is possible.
- **The command must not be run from inside the cgroup under test.** This worktree's own shell —
  and any operator `ssh`ing in and driving the test inline — lives inside a
  `cezar-run-<runId>.scope` under `cezar-runs.slice`, itself a **child** of the isolation this test
  is verifying. If the mechanism under test is broken, the stop can kill the very shell that was
  about to run `systemctl start`, leaving production down with nothing to bring it back. Step 3's
  watchdog, armed from a detached `systemd-run` transient unit *before* the stop, is the independent
  restore arm — it does not depend on the operator's shell surviving the stop it is testing.

Preconditions and procedure are exactly the script's Steps 1–7 above. The test subject is whatever
run is genuinely `running` and mid-step (not between steps) at the moment the operator actually
runs this — **not** this task's own run: by the time Phase 1 is scheduled (gated on sign-off,
necessarily after this spec's own chain has been reviewed and deployed), `bcc059a6` will itself be
terminal, and the script's Step 2 preconditions (above) would correctly refuse it. Prefer a
purpose-started throwaway over disrupting real work in flight — e.g. `cezar todo add "no-op sleep
for stop/start verification" --start` against a trivial prompt that keeps a step open for a few
minutes — over commandeering whatever sibling task happens to be running at the time. If a
throwaway isn't practical and a real in-flight run is used instead, the script's own Step 2
preconditions are what confirm it's a valid subject, not the operator's assumption that "something
is running": confirm `meta.json`'s `.pid` resolves, `backend` is in `BROKERED_BACKENDS`, and
`meta.stepId` names a currently-open, non-terminal step, before proceeding. If concurrent sibling
runs are active at the time — as this spec's own Solution section notes several were during
spec-writing — the operator should still expect and accept that this is a full-box disruption; the
script only watches `--run-id`, it does not protect siblings.

```
sudo packages/cezar/scripts/verify-stop-survival.sh --run-id <the-throwaway-or-chosen-run-id>
```

### Phase 2 — if Phase 1 passes: close the record

- Mark this task's four acceptance criteria measured, with the concrete evidence the script printed
  (pid, InvocationID before/after, timestamps, seq range) — not a re-statement of intent.
- File or update todo `7f92bd31` (referenced across `7c2dd8f0`, `f272fda8`, `e06f2169`,
  `70f19253`, `d92e6b85`, `0762e872`, `bcc059a6`'s own run logs as the open follow-up this task
  tracks) as resolved, citing this spec and the script's output.

### Phase 3 — if Phase 1 fails: this spec does not pre-design the fix

If the broker does not survive, or survives but `reattachBrokeredRun` does not take its true
branch, that is a genuinely new finding this spec's research did not anticipate (everything read
for this spec says the mechanism should work; nothing found suggests a specific reason it
wouldn't). Root-causing from the actual failure evidence — which specific guard in
`reattachBrokeredRun` returned false, whether it instead fell through to the `reenterChain` branch
at `run.ts:1653` (see "Architecture" — that branch's own log messages don't match either string
this test greps for, so a failure there and a failure in the legacy path look identical to this
test even though they are different code paths), or whether the cgroup teardown reached the broker
after all — is follow-up work for a new spec informed by Phase 1's concrete failure artifacts, not
something to guess at here.

## Risks

- **The test is genuinely disruptive.** A full stop/start of both `cezar.socket` and
  `cezar.service` interrupts every currently-running task on the box that is *not* in `scope` mode,
  and briefly makes the cockpit and its API unavailable for the duration (typically single-digit
  seconds, per the self-deploy spec's own measured restart windows, but not zero). Schedule it
  deliberately, not as a side effect of something else, and get explicit operator sign-off
  immediately before running it — this is exactly the "hard-to-reverse / affects shared state"
  category the workspace's Executing Actions With Care guidance calls out.
- **A bare `systemctl stop cezar.service` (service only) is not a full stop on this box and can
  produce a false PASS.** `cezar.socket` stays `active (running)` on `127.0.0.1:4321` and
  re-triggers `cezar.service` on the next inbound request (the cockpit's own polling is enough), so
  a stop of the service alone may never actually produce a down window — and "no interrupted event
  was logged" would then be read as a pass when nothing was really tested. This is why Phase 0.4's
  script stops **both** units and asserts `cezar.service`'s `InvocationID`/`MainPID`/
  `ActiveEnterTimestamp` actually changed — a control the original draft of this spec did not have.
  Do not skip that assertion when running the script by hand or modifying it.
- **Running the stop from inside the cgroup under test can strand production down with no
  recovery.** Both this worktree's own shell and any operator `ssh` session driving the test inline
  live inside `cezar-run-<runId>.scope`, itself scoped under the very isolation being verified. In
  exactly the failure case this test exists to catch, the stop could kill that shell before it
  reaches the `start` half of the command, leaving nothing to bring the service back. Phase 0.4's
  watchdog — a `systemd-run --on-active=…` transient unit armed *before* the stop, from outside the
  target cgroup — exists specifically to cover this. Note this requires root: the `cezar` service
  user's polkit grant is scoped to `manage-units` on `cezar.service`/`cezar.socket` only and
  explicitly excludes creating system transient units (`hetzner.md:346-353`), so the script cannot
  arm its own watchdog if invoked as `cezar` — it must run as root, and will refuse to run otherwise
  per its own contract in Phase 0.4.
- **A false negative from an unrelated cause.** If the test-subject run's backend is not actually
  `claude` (or another entry in `BROKERED_BACKENDS`), or its step happens to land between agent
  turns rather than mid-turn, `reattachBrokeredRun` will correctly fall through to the
  `reenterChain`/legacy paths for reasons that have nothing to do with cgroup isolation —
  misreading that as an isolation failure would misdiagnose a working system. Running the test
  against a genuinely mid-step run (Phase 1's precondition) exists specifically to avoid this.
- **Production state can drift between this spec being written and Phase 1 running** — including,
  now, in a way this spec has itself identified: the isolation probe is cached once per process
  lifetime with no ordering guarantee against `user@999.service` (see "Problem" → "A related
  problem…" and Phase 0.3). Another deploy, a manual restart that loses the race, or a
  `loginctl disable-linger` somewhere could change `runBrokerIsolation` back to `delegated` before
  the test runs — the script's Step 1 live re-confirmation exists specifically to catch that rather
  than assume this spec's snapshot still holds. If Phase 0.3's hardening has not yet landed when
  Phase 1 runs, a cold-boot-induced regression is possible and silent; check the health endpoint,
  don't assume.
- **Conflating this spec's scope with the self-deploy spec's still-open blue-green re-attach bug**
  (see "Non-goal") would produce a report that claims more than was tested. Keep the two separate
  in whatever record this spec's outcome gets written to.

## Verification

Phase 0 (documentation corrections, the hardening fix, and the verification script itself) is
verified the normal way: gates green (`chat/tools/typecheck` / lint / test equivalents for this
repo), the two doc edits reviewed by eye against the "correction marks what it invalidates, in
place" convention, and the script exercised at least once in `--yes`-free (interactive) form against
a non-production target or dry-run path before it is ever pointed at `prod-host` — this spec
does not require building a second test harness to test the test harness, but the first real
invocation of the script should not also be its first execution ever.

Phase 1 (the disruptive test) **is** the verification for AC3/AC4, and there is no substitute for
running it live, because this spec's acceptance criteria describe a live production behavior under
a specific real disruption, not a unit-testable pure function (the pure functions involved —
`chooseIsolation`, `probeUserScope`, `userScopeEnv` — already have coverage in
`broker-isolation.test.ts` and `broker-launch.test.ts:126-162`, unchanged by this spec, and were not
what was in doubt). Concrete, executable steps, restated from Phase 0.4/Phase 1 for a checklist:

1. `curl -fsS http://127.0.0.1:4321/api/v1/health | jq -r .runtime.runBrokerIsolation` → must
   print `scope` before proceeding (AC1).
2. Baseline capture (the script's Step 2): broker pid + cgroup path, run's last `seq`,
   `cezar.service`'s `InvocationID`/`MainPID`/`ActiveEnterTimestamp`, `cezar.socket`'s state — all
   recorded with timestamps.
3. Arm the independent restore watchdog (the script's Step 3), run as root, before the stop.
4. `sudo packages/cezar/scripts/verify-stop-survival.sh --run-id <id>` — operator-confirmed, timed;
   internally this is `systemctl stop cezar.socket cezar.service` then, after a short window,
   `systemctl start cezar.socket cezar.service`.
5. Post-check (the script's Step 6): `InvocationID`/`MainPID`/`ActiveEnterTimestamp` all changed
   (proof the stop was real — AC3's precondition); the same broker pid still alive at the same
   cgroup path (AC2); `.ndjson` tail shows exactly the `'cezar restarted — this run kept going'`
   lifecycle event and nothing reading `interrupted` or `resuming the interrupted task` (AC3/AC4);
   `seq` sequence across the gap has no jump and no repeat (AC4).
6. `curl -fsS http://127.0.0.1:4321/api/v1/health | jq -r .runtime.runBrokerIsolation` again →
   still `scope` post-restart (AC1 re-confirmed after a real process boot, not just a steady-state
   read).

All six are pass/fail against concrete, already-identified artifacts (specific pids, specific
`InvocationID`s, specific `seq` numbers, specific event strings quoted verbatim from `run.ts`) — no
step requires inventing a new tool or harness beyond the one script Phase 0.4 commits.

## Sources read

- Brief: `.ai/specs/briefs/2026-08-22-broker-isolation-delegated-vs-scope.md` (this task's own
  gather-the-record output) — read in full; its code-location citations verified against the
  current checkout and found accurate, but its central claim ("no occurrence of `scope` ever
  logged") independently re-tested and found incorrect (grep-escaping artifact) during this step.
- `packages/cezar/src/core/broker-isolation.ts` (full file) — `probeUserScope`, `defaultRuntimeDir`,
  `userScopeEnv`, `chooseIsolation`, `buildBrokerLaunchArgv`, `RUNS_SLICE`.
- `packages/cezar/src/core/claude-cli-runner.ts:375-440` (`spawnBroker`) — env merge site for
  `userScopeEnv()` in `scope` mode.
- `packages/cezar/src/core/agent-env.ts:290-330` (`buildChildEnv`) — the allowlist `userScopeEnv`
  has to route around.
- `packages/cezar/src/workflows/run.ts:1706-1707` (`brokerIsolation()`'s one-shot cache — the
  load-bearing site for the "related problem" this revision adds to "Problem" and Phase 0.3),
  `:1600-1669` (the `running`/re-entry branch, including the `reenterChain(run, 'cezar restarted',
  { onlyIfMoreStepsFollow: true })` call at `:1653` between `reattachBrokeredRun` and the legacy
  interrupted/continuation path — re-checked this revision after review flagged the original diagram
  omitted this middle branch), `:1806-1856` (`reattachBrokeredRun` in full — line range corrected
  this revision; the original spec cited `:1789-1840`, which was off by the width of the
  `takeReattach`/`lastOffset`/`brokerFor`/`persistConsumedOffset` helpers between the two).
- `packages/cezar/src/runs/store.ts:951-1200` (`appendEvent`/`nextSeq`) — confirms `seq` assignment
  mechanics referenced in the verification section.
- `packages/cezar/src/core/run-spool.ts:146, 238` (`readSpoolMeta`, `isSpoolLive`) — the two checks
  `reattachBrokeredRun` gates on.
- `packages/cezar/src/server/server.ts:1995-2020`, `packages/cezar/src/server/runtime-info.ts`
  (full file) — health endpoint wiring for `runtime.runBrokerIsolation`.
- `packages/cezar/src/server-install/self-safe-deploy.ts` (full file) — the separate
  agent-driven-deploy re-exec escape (`decideReExec`, `userBusEnv`), confirmed a different code path
  from the broker's own isolation choice, per the brief's own warning not to conflate them.
- `packages/cezar/src/server-install/deploy-strategy.ts:1-80`, `release-deploy.ts:150-190` —
  confirmed blue-green's `restart()` effect runs a genuine `systemctl restart <unit>`, not a
  stop/start, which is why that path's own reopened bug (self-deploy spec) is a different failure
  mode than this spec's bare-stop scenario.
- `packages/cezar/src/server-install/platforms/hetzner/socket-unit.ts` (full file, re-read this
  revision) — `cezarSocketUnit` (the `[Socket]` unit itself, `Accept=no`, no
  `WantedBy=sockets.target` conflict with the service), `nonDisruptiveDropIn` (`KillMode=process`,
  `Delegate=yes`, `Sockets=cezar.socket`) and `cezarRunsSlice`. Re-read specifically to confirm
  where the `After=`/`Wants=user@999.service` hardening in Phase 0.3 belongs.
- `packages/cezar/src/server-install/release-cli.ts:180-220` — confirms `loginctl enable-linger
  cezar` is a manual operator step printed to the console during migration, not automated for the
  Hetzner platform (relevant background: this is why `scope` mode's *availability* was never
  guaranteed by code alone, though live evidence in this step confirms linger is in fact enabled on
  `prod-host` — `user@999.service` is `active`, `/run/user/999` exists with the right
  ownership).
- `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` (`:1-70` status/summary table,
  `:1080-1210` "Criterion 1 was reopened" section in full) — establishes the separate, still-open
  blue-green re-attach bug this spec explicitly does not claim to close (see "Non-goal").
- `.ai/specs/2026-08-22-run-broker-cli-keepalive.md` (full file) — read only to confirm this is an
  unrelated, already-resolved bug (a one-shot CLI process exit timing issue), per the brief's own
  flag not to conflate the two; also used as the closest recent example of this repo's spec section
  conventions.
- `docs/server-install/hetzner.md` — located as `docs-811a352fc1e3`, confirmed it still describes
  the agent-driven-deploy re-exec gap as open; not edited in this step (spec-writing only), flagged
  for Phase 0.2. `:346-353` re-read this revision specifically for the polkit grant paragraph
  ("grant it narrowly (a polkit rule for `manage-units` on `cezar.service`/`cezar.socket` only —
  never a unit-name prefix, and never the right to create *system* transient units, which run as
  root)") — this is the citation for Phase 0.4's "script must run as root" requirement and the
  matching Risks bullet.
- `notion-export/knowledge/notes/cezar-prod-rootless-deploy-provisioning--local.md` — located as
  `notion-41a043347b70`; confirms the `/run/user/999` + `systemd-run --user --scope` viability
  finding the brief cited, and that `07f5c274` closed the deploy-side (not broker-side) re-exec gap.
- `.ai/cezar/runs/*.ndjson` (live production run transcripts) — greped directly for
  `runBrokerIsolation` with escaping corrected for the ndjson's nested-JSON encoding; full list of
  hits with timestamps and release ids in "Live evidence" above. This is the load-bearing
  correction this spec makes to the brief.
- Live process/cgroup state on `prod-host` itself, read directly during this step (no ssh
  needed — this worktree runs on the production box): `ps`, `pstree`, `/proc/<pid>/cgroup`,
  `/proc/<pid>/cmdline`, `systemctl status cezar-runs.slice`, `systemctl show ... -p MainPID`. Full
  output quoted verbatim in "Live evidence."
- **This revision** (applying review feedback), additional live checks on `prod-host`, all
  reproducible: `systemctl status cezar.socket` — `Active: active (running)`, `Triggers:
  cezar.service`, confirming socket-activation is live and a bare service-only stop would not
  produce a real down window. `systemctl show cezar.service -p Sockets -p DropInPaths` —
  `Sockets=cezar.socket`, drop-ins in order `10-cloudflare.conf`, `20-onepassword.conf`,
  `30-agent-passthrough.conf`, `40-non-disruptive.conf`. `systemctl cat cezar.service`'s `[Unit]`
  block — `After=network-online.target` / `Wants=network-online.target` only, no ordering against
  `user@999.service`, confirming the race described in "Problem" → "A related problem…" is real as
  written, not merely inferred. `systemctl show cezar.service -p InvocationID -p MainPID -p
  ActiveEnterTimestamp` — read once to confirm these properties exist and are populated on this
  systemd version, before specifying them as the Phase 0.4 script's core control. `id` as the
  current shell's user — confirmed this step itself runs as uid 999 (`cezar`), not root, which is
  exactly the constraint Phase 0.4's "must run as root" requirement and the matching Risks bullet
  are about — this step could not have armed the watchdog itself even if it had attempted to.
- **This revision (round 2, applying the review feedback above), additional reads:**
  `packages/cezar/src/server-install/platforms/hetzner/socket-unit.ts` (`nonDisruptiveDropIn`'s
  full output, re-read to confirm it is `[Service]`-only, no `[Unit]` section) and
  `systemd-analyze verify` run against a scratch drop-in with `After=`/`Wants=` pasted into
  `[Service]` — confirmed live: `Unknown key 'After' in section [Service], ignoring.` (and the same
  for `Wants=`), which is the evidence for defect 1 above. `packages/cezar/src/server-install/
  release-cli.ts:150-223` (the `migrate` command in full) — confirms its only call to
  `nonDisruptiveDropIn` passes `{ socketUnit: socketUnitName(unit) }`, no uid, and that it writes
  units with `writeFileSync(..., { mode: 0o644 })`, no shell-out to resolve a uid today.
  `packages/cezar/src/server-install/platforms/hetzner/provision-user.ts:162` — the codebase's
  existing `id -u <username> >/dev/null 2>&1 || useradd ...` pattern, cited as precedent for how
  Phase 0.3's uid resolution should shell out. `packages/cezar/src/workflows/run.ts:845,
  1706-1708, 1744-1746, 1755, 1806-1856, 4680` (`brokerIsolationCache`, `brokerIsolation()`,
  `spoolDirFor` call site, both `brokerIsolation()` call sites, `reattachBrokeredRun` re-read for
  its exact precondition order, the second `brokerIsolation()` consumer) and a full-file grep for
  `console.warn`/`logger`/`pino` in `run.ts` — confirms zero logging exists today around
  `brokerIsolation()` and that `console.warn('[cez] ...')` (used at `:951`, `:2317`, `:2333`,
  `:2355`) is this file's own established pattern, settling the "confirm the exact current
  behavior" open question the first draft left for the implementer.
  `packages/cezar/src/core/run-spool.ts:34-53, 146, 238` (`spoolMetaSchema`'s `pid`/`childPid`
  fields with their own doc comments, `readSpoolMeta`, `isSpoolLive`) — re-read to cite exactly
  which field (`.pid`, not `.childPid`) Phase 0.4's script must read, and which liveness checks
  gate `isSpoolLive`. `packages/cezar/src/core/broker-launch.ts:72` (`BROKERED_BACKENDS = ['claude']
  as const`) — the precondition Phase 0.4's Step 2 now asserts explicitly. `ls -la
  packages/cezar/scripts/` and `packages/cezar/package.json:17-22` (`files` array) — confirms the
  directory's current file types/modes and that the npm `files` allowlist already covers the whole
  `scripts/` directory, settling the packaging nit. Live re-check on `prod-host`: `GET
  /api/v1/health` now reports `runtime.runBrokerIsolation: "scope"`, `socketActivated: true` on
  release `256afb26` (activated 2026-08-22T03:07:51Z per the review notes this revision responds
  to) — confirms the box has moved past the `076278cf` release cited in "Live evidence" above and
  the `scope` finding holds across that change; this shell's own cgroup was independently
  re-observed at `.../user@999.service/cezar.slice/cezar-runs.slice/cezar-run-bcc059a6-....scope`,
  consistent with the original "Live evidence" capture.
- **Not found / not chased:** `.ai/cezar/todos.json` (gitignored, not present in this worktree) —
  todo `7f92bd31`'s current recorded status taken from the brief's citation, not re-read directly.
  No `systemctl --user` query was run as uid 999 to independently confirm the scope unit's `Slice=`
  property via systemd itself (the cgroup path already settles the question; this would be
  belt-and-braces, not load-bearing, and was left for whoever runs Phase 1 if they want extra
  confirmation).
