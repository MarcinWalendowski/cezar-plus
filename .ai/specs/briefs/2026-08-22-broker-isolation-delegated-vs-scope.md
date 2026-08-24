# Brief — brokered runs survive `systemctl restart` but not a full `stop`+`start`: isolation is `delegated`, not `scope`

**For task bcc059a6. Gather-the-record step only — no spec, no code written here.**

## The problem, in this repo's own terms

cezar's run-broker keeps a brokered agent run alive independent of `cezar.service`, so a
task survives the server being redeployed. How well it survives depends on the broker's
**isolation mode**, reported at `runtime.runBrokerIsolation` on `GET /api/v1/health`:

- `'scope'` — broker gets its own cgroup via `systemd-run --user --scope
  --slice=cezar-runs.slice`. Survives any `cezar.service` action, including a full stop.
- `'delegated'` — broker shares the server's own cgroup, protected only by
  `KillMode=process`. Survives `systemctl restart` (systemd signals `MainPID` only) but
  **not** a full `systemctl stop` (deactivating the unit empties its cgroup, killing
  everything in it — including the broker).
- `'none'` — no relocation; weakest.

Task 7c2dd8f0's own run transcript recorded both outcomes back to back on 2026-08-21: 7
"cezar restarted — this run kept going" events (18:31:57–18:45:35Z, brokered re-attach
working), then 12 consecutive "cezar restarted — resuming the interrupted task from its
last session" events (18:58:13–19:02:47Z, the legacy kill-and-force-resume path), starting
3s after a stop+start. Production has been measured running in `'delegated'` mode, not
`'scope'` — this is the open thread this task closes.

## What the record already decided (with citations)

- **`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`** (KB `specs-594acc539b36`)
  is the spec that *designed* the three isolation modes above, in that preference order,
  probed once at boot. **Status, unchanged since 2026-08-21 19:05 UTC: "QA Needed —
  REOPENED"** — criterion 1 ("a deploy mid-run leaves the run alive and streaming") does
  **not** hold on the blue-green cutover path. Its own status table already measured
  `runBrokerIsolation: "delegated"` — "not `"none"`" is the caveat it records, i.e. even
  its author treated `delegated` as a known shortfall, not a pass. Todo `45813876` inside
  that spec names three candidate causes for the criterion-1 failure; one of the three,
  verbatim, is **"the deploy stopping the unit in a way that reaches the broker (isolation
  is `delegated`, not `scope`)"** — this task's exact framing, already anticipated there.
  **This task's four acceptance criteria are NOT already defined anywhere** — the
  self-deploy spec documents `scope` as preferred-but-unreached and notes incidentally that
  a bare `systemctl stop`→`start` once left a broker alive, but never states "health
  reports `scope`" or "survives a full stop+start" as a checked criterion. This is new spec
  territory that extends, not duplicates, that spec's open thread.
- **`notion-41a043347b70`** (KB, "cezar-prod deploys no longer need root… and why the
  systemd-run escape is the one thing still root-bound") explains root cause: *"
  `runBrokerIsolation` is `delegated` rather than `scope` because the service process has
  no `XDG_RUNTIME_DIR`/DBUS address with which to reach the user manager."* It documents a
  **different** `systemd-run --user` call site (the deploy re-exec escape in
  `self-safe-deploy.ts`'s `buildSystemdRunArgv`/`userBusEnv()`) that already works around
  this by exporting `XDG_RUNTIME_DIR=/run/user/999` explicitly from an agent-task shell.
  That pattern proved `/run/user/999` + `systemd-run --user --scope` *is* viable on this
  box (Linger=yes, `user@999.service` live) — but it is a **separate code path** from the
  broker's own `chooseIsolation`; do not conflate the two `systemd-run --user` sites.
- **`specs-7864d0810713` / `.ai/specs/2026-08-22-run-broker-cli-keepalive.md`** (commit
  `3e6d1b7e`) is a **different, already-resolved bug** — a one-shot `cezar run` CLI process
  exiting early because of an unref'd poll timer. Nothing to do with cgroup isolation mode.
  Flagging explicitly so the next step doesn't merge or re-litigate it.
- **No dedicated spec or KB doc treats broker cgroup isolation as its own topic** — every
  search (`cez kb search "delegated scope isolation broker"`, `"systemd-run --user
  --scope"`, `"KillMode process"`) top-ranks only the two specs above plus
  `notion-41a043347b70` and `docs-811a352fc1e3`.
- **`docs-811a352fc1e3`** ("Remote access — Hetzner") documents `cezar-runs.slice` +
  `KillMode=process` drop-in provisioning via `server-migrate-releases`, and separately
  notes the agent-driven-deploy re-exec gap — but that note is now **stale**: the spec it
  points at shows that gap was closed by commit `07f5c274` (`decideReExec` reading
  `KillMode`, using the user bus). Worth a corrective note when this task's spec lands, per
  the workspace's "a correction marks what it invalidates, in place" rule.

## Code actually involved (current checkout, `HEAD` = `main` = `c73c8a2d`)

Paths differ from the task description's shorthand (`core/broker-isolation.ts` etc. — no
such flat `core/` dir; everything is under `packages/cezar/src/`, `.ts` not `.js`):

- `packages/cezar/src/core/broker-isolation.ts` — `probeUserScope`, `defaultRuntimeDir`,
  `probeIsolationCapabilities`, `chooseIsolation`, `userScopeEnv`, `RUNS_SLICE` (=
  `cezar-runs.slice`), `buildBrokerLaunchArgv`.
- `packages/cezar/src/core/claude-cli-runner.ts:375-434` (`spawnBroker`) — actual broker
  spawn site; env merge at `:422-425`.
- `packages/cezar/src/core/agent-env.ts:307` (`buildChildEnv`) — the allowlist that would
  otherwise silently drop `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS`.
- `packages/cezar/src/workflows/run.ts:1706-1709` (`RunManager.brokerIsolation()`) —
  **caches** the probe result (`this.brokerIsolationCache ??= chooseIsolation(...)`), once
  per `RunManager` instance (i.e. per server-process lifetime), not per health request.
  **Open risk this raises**: if a deploy path exists that doesn't restart the `cezar.service`
  main process (e.g. a web-assets-only swap), health would keep reporting a stale mode.
  Worth checking in the next step, not yet confirmed either way.
- `packages/cezar/src/server/server.ts:2007-2018` and
  `packages/cezar/src/server/runtime-info.ts:32-47` — health endpoint wiring
  (`runtime.runBrokerIsolation`).
- `packages/cezar/src/server-install/platforms/hetzner/socket-unit.ts:70-120`
  (`cezarRunsSlice()`) — the `[Slice]` unit that provisions `cezar-runs.slice`.
- Tests: `packages/cezar/src/core/broker-isolation.test.ts`,
  `packages/cezar/src/core/broker-launch.test.ts:126-162` — cover the pure functions
  (`chooseIsolation`, `probeIsolationCapabilities`, derived-runtime-dir path, `userScopeEnv`
  gap-filling). **No test asserts the merged env at the actual `spawnBroker` call site.**

## The fix described in the task is already fully committed — this is the load-bearing finding

The task's context frames the `probeUserScope`/`userScopeEnv` fix as "PARTIAL … NOT YET
PROVEN ON THE BOX." Verified against the current checkout and git history: **it is not
partial. It is fully implemented, tested, and already an ancestor of `main`/`HEAD`:**

- `fde2dae8` — "fix: run isolation fell back to the weaker mode because it looked for a
  variable a service does not have" — adds `defaultRuntimeDir()` deriving
  `/run/user/<uid>` when `XDG_RUNTIME_DIR` is unset (`broker-isolation.ts:138-162,
  191-193`).
- `cf334d89` — "fix: the scope probe found the user manager, then the spawn threw the
  address away" — adds `userScopeEnv()` (`broker-isolation.ts:201-208`) and merges it into
  `spawnBroker`'s env only in `scope` mode (`claude-cli-runner.ts:422-425`), plus 4 new
  test cases. Commit message itself says: *"Tracked as `7f92bd31`. Not yet proven on the
  box — that needs a deploy, health reporting `runBrokerIsolation` \"scope\", and a run
  surviving a full stop/start."* — i.e. the commit already stated exactly what remained,
  matching this task's framing precisely.

Both commits are confirmed ancestors of `main` HEAD `c73c8a2d` (`main..HEAD` is empty).
Todo `7f92bd31` (referenced across run logs for tasks `7c2dd8f0`, `f272fda8`, `e06f2169`,
`70f19253`, `d92e6b85`, `0762e872`, and this task `bcc059a6`) has always appeared as an
**open, unaddressed follow-up**, never as something another in-flight task currently owns —
confirmed no other worktree/branch touches `broker-isolation.ts`.

**Deployment state, and the actual open gap:** the most recent traceable production deploy
is release `20260822T024019Z-076278cf` (task `fb62168a`, unrelated work, 2026-08-22
02:40Z). `git merge-base --is-ancestor cf334d89 076278cf` confirms the isolation fix **is**
in that deployed sha. But `grep runBrokerIsolation` across every `.ai/cezar/runs/*.ndjson`
found **no occurrence of `"scope"` ever logged — only `"delegated"`**, including from after
the fix's sha should have been live. So the code fix appears deployed but **its effect is
unproven**: nobody has yet observed `runBrokerIsolation: "scope"` in a live health
response, or exercised a real `systemctl stop && systemctl start` against it.

## Open questions a spec will have to settle

1. **Why has `"scope"` never been observed post-fix, if the fix is in the deployed sha?**
   Candidates to rule in/out, none yet confirmed: (a) the health-value cache
   (`run.ts:1707`) is per-process-lifetime, and no health check has hit a `RunManager`
   instance created *after* a restart on the deployed sha; (b) `/run/user/<uid>/systemd/private`
   check fails for a reason other than the missing env var (permission, uid mismatch — is
   the `cezar` service user's uid actually `999` on `prod-host`, matching the
   provisioning note's manual probe?); (c) the deploy that shipped `076278cf` didn't
   actually restart the `cezar.service` main process (rootless blue-green deploys may not
   always `systemctl restart` under normal conditions — needs checking against
   `2026-08-19-non-disruptive-cezar-self-deploy.md`'s current deploy mechanics).
2. **Does the health cache need to become per-request-fresh, or is a restart-triggers-recompute
   model sufficient?** If a future deploy strategy skips a full process restart, a stale
   cached `'delegated'` would misreport indefinitely. Not yet known whether any current
   deploy strategy has that gap.
3. **What is the actual verification sequence for this task's four acceptance criteria?**
   At minimum: confirm current live `/api/v1/health` value first (may already read
   `'scope'` if no one has checked since `076278cf` deployed — check before assuming a new
   deploy is even needed); if still `'delegated'`, force a fresh deploy/restart and re-check;
   then start or use a live run, do a real `systemctl stop cezar.service && systemctl start
   cezar.service`, and inspect both `/proc/<broker>/cgroup` and the run's own transcript for
   the "kept going" vs "resuming the interrupted task" / "interrupted" event language.
4. **The `docs-811a352fc1e3` stale note** (agent-driven deploy re-exec gap, closed by
   `07f5c274` but not reflected there) should get a corrective marker when this lands,
   per the workspace's in-place-correction convention — minor, but named so it isn't lost.

## What I could not find

- No confirmation, in any run log or health snapshot, of `runBrokerIsolation` ever reading
  `"scope"` on production — the fix's actual effect on the box is unverified either way,
  not merely "not yet proven" as a formality.
- No record of the `cezar` service user's uid on `prod-host` being re-checked since
  the manual `/run/user/999` probe in `notion-41a043347b70`'s provisioning note — this
  brief assumes 999 is still correct but did not re-verify it live.
- No test exercising the real spawn site (`claude-cli-runner.ts:422-425`) end-to-end with
  isolation `'scope'` selected — only the pure `userScopeEnv()`/`chooseIsolation` unit
  tests exist.
