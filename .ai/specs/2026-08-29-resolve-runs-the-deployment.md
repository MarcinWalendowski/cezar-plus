# Resolve runs the deployment it has only ever asked about

**Status:** Implemented (2026-08-29)
**Extends** `.ai/specs/2026-08-29-resolve-button-red-recheck.md` (the button that finally reports its
own refusal) and `.ai/specs/2026-08-26-activate-main-not-worktrees.md` (one activation of `main`
satisfies every parked run).
**D6 is intact.** "A person activates cezar, not an agent" (owner decision 2026-08-24). Pressing
Resolve *is* that person acting. What changes is that they no longer have to leave the cockpit,
open an ssh session and remember a runbook to carry out what the card already told them to do.

## TLDR

`POST /handoff/resolve` re-probed and reported. It never deployed. So on a box whose live release
was behind `main`, the honest answer was red, and it stayed red however many times it was pressed —
which reads, correctly, as a broken button. Resolve now runs the deployment the repo declares, once,
outside this process's cgroup, and one press settles every run parked on the same deployment.

## Problem

After the 2026-08-29 fix that made the button *report* its refusal, the owner pressed it and got:

```
live=95b93175… head=eb854e91… — the running server is NOT serving this HEAD
```

That verdict is true, and useless on its own. The run's HEAD was on `origin/main`; the box was
serving an older release; nothing in the product would ever change that. The gap was never in the
probe or in the reporting — it was that the only action the card offered did not perform the action
the card was named after.

Three things had to be true at once for this to be safe, and none of them were free:

1. **The command outlives its parent.** It restarts `cezar.service`, the process handling the click.
   A child in that cgroup is killed mid-cutover, possibly with the symlink already flipped.
2. **Nothing may wait for it.** The connection is about to be severed, so the click cannot learn
   whether the deploy worked.
3. **A second press must not start a second cutover.** The restart is what makes the page go quiet,
   so clicking again is the *expected* human response to a working deploy.

## Solution

**S1 — the repo declares how, the engine only runs it.** `deployTargetsSchema` gains an optional
`activate` per target. A manual target without one keeps the old behaviour exactly: re-probe and
report. It lives beside `probe` because the repo that knows how to prove a service is live is the
one that knows how to make it live, and a deploy command in the engine would be one repo's runbook
compiled into every user's binary.

**S2 — read at click time, filtered to what actually failed.** `readActivationCommands(cwd, failing)`
reads the run's own worktree when the button is pressed, not a value persisted onto a days-old
handoff, and takes only manual targets that are *among the ones the probe just reported red* — so a
green service is never redeployed to satisfy a different one's failure. Commands are **deduped by
command string**: cezar's two targets are one blue-green cutover declared twice, and per-target
dispatch would run it concurrently with itself.

**S2a — and the project root when the worktree's copy predates the feature.** A worktree carries
`.ai/deploy-targets.json` as it was when it was cut, so the runs that need this most — the ones
parked longest — are exactly the ones whose copy has no `activate` at all. The lookup falls back to
the project root, which is the copy that keeps moving. This is the identical shape to the probe's
own fetch repair: *a fix that ships in the artefact under test cannot reach the copies already
taken.* The command still runs in the run's own worktree; only the declaration is borrowed.

**S3 — the cgroup escape.** `activationArgv()` hands the command to a transient systemd unit,
reusing `buildSystemdRunArgv` — `--user` unless already root, because a *system* transient unit runs
as root and granting an unprivileged service account that right is a root-equivalent grant under a
narrow name. With no `systemd-run` present it degrades to `bash -lc`: there, no unit restart is
going to kill it, so the escape buys nothing and refusing would make the feature untestable off the
production host.

**S3a — the launch is VERIFIED, and the lock is taken only for something that started.**
*Added after the first production press failed, 2026-08-29.* `systemd-run` returns as soon as the
unit is queued, so registering it can be synchronous without blocking the click — and being
synchronous is the point. The first version spawned it detached with `stdio: 'ignore'` and took the
lock regardless, so a launch that failed was indistinguishable from one that worked. It failed for
**two** independent reasons, both documented in the code it reused and neither carried over:

1. **No bus coordinates.** `cezar.service`'s own `/proc/<pid>/environ` has neither
   `XDG_RUNTIME_DIR` nor `DBUS_SESSION_BUS_ADDRESS`, so `systemd-run --user` died with *"Failed to
   connect to user scope bus via local transport"*. An **ssh session has them**, which is exactly
   why this is invisible until it runs from inside the service.
2. **An unwritable log target.** `buildSystemdRunArgv` hardcoded `append:/var/log/cezar/…`, and the
   `cezar` uid cannot create that directory (`mkdir: Permission denied`). systemd refuses to start
   a unit whose `append:` target is unwritable, so this alone would have failed every launch.

Net effect: the operator was blocked for 15 minutes by a lock guarding **nothing running**, and a
second press correctly told them to wait for a deploy that did not exist. *A guard that fires for
an action that never happened is worse than no guard.* `activationEnv()` now supplies the bus
coordinates, `activationLogPath()` puts the log in the project's own data dir, `buildSystemdRunArgv`
takes an optional `logPath` (defaulted, so `server-deploy` is unchanged), and the lock is taken only
after a launch reports success — with the failure text returned to the card.

**S4 — a file lock, not a flag.** `activation.lock` in the project's data dir, 15-minute TTL. It has
to be a file precisely because the thing it guards restarts this process: an in-memory flag is
cleared by the very event it exists to survive.

**S5 — three outcomes on the wire, not two.** The response carries `activating: true` alongside
`resolved: false`. Both mean "still parked", and they must not read the same: without the flag the
card reports a started deployment in the danger tone, telling someone their click failed at the
moment it worked.

**S6 — one press settles every run waiting on that deployment** (owner requirement, 2026-08-29).
On a green resolve the manager sweeps the *other* manual-deploy parks and requeues the ones that now
probe green — `exceptRunId` keeps the pressed run out of it, since it is still `waiting` at that
instant and would otherwise be requeued twice. Fire-and-forget: each sibling runs its own probe in
its own worktree, bounded at 60s, and the click must not wait for all of them. The activation path
gets the same outcome from the other side — the post-restart sweep
(`recheckManualDeployParksEverywhere`) re-probes every park on boot.

## Architecture

```
Resolve press
   └─ refreshParkedWorktree ─▶ re-probe
        ├─ GREEN ─▶ resume this run ─▶ sweep the OTHER parks (S6)
        └─ RED  ─▶ activate declared?  ── no ──▶ 200 {resolved:false} + the probe's verdict
                        │ yes
                        ├─ lock held? ──▶ 200 {resolved:false} "an activation is still running"
                        └─ launch, deduped, in a transient unit ─▶ 200 {resolved:false, activating:true}
                                     └─▶ cezar restarts ─▶ boot sweep re-probes EVERY park
```

## Data models

`activate?: string` on a deploy target (additive, optional). `activation.lock`: one file holding a
millisecond timestamp. No stored run shape changes, no migration.

## API contracts

`POST /runs/:id/handoff/resolve` gains `activating?: true` in its 200 body. Additive: a client that
ignores it behaves exactly as before.

## Risks

- **A second cutover under the first** — the one genuinely destructive outcome. Guarded by S4, and
  by the dedup in S2.
- **The lock outliving a crashed activation** blocks a legitimate retry for up to 15 minutes. The
  message names the age and points at the deploy log rather than silently doing nothing.
- **The declared command is arbitrary shell from the repo.** It is the same trust level as `probe`,
  which has always run `bash -lc` from the same file.
- **A stale worktree copy of the script.** Avoided by pointing at the shared checkout's copy, not
  the worktree's — the same "a fix cannot reach the copies already taken" trap that made parked runs
  unrescuable in the first place.

## Verification

Executed 2026-08-29.

1. `manual-activation.test.ts`, 13 cases. Selection: only manual targets, only ones that failed,
   only ones declaring a command; one command launched once however many targets name it, with the
   names merged; every unreadable shape (absent, malformed, schema-invalid) degrades to "no way to
   deploy" rather than throwing. Argv: `--user` before `--unit` (systemd-run picks its bus from that
   flag), `KillMode=process`, the command intact, and the plain-shell fallback. Lock: holds for its
   TTL, releases after, unparseable reads as free.
2. Engine, through the real park: a red resolve launches the command and answers `activating`, while
   the run stays parked; **the identical park with no `activate` declared launches nothing and
   returns the probe's own verdict** (the negative control — without it "Resolve deploys" could not
   be told from "Resolve deploys whatever is in the file"); a second press inside the TTL launches
   nothing and does not report progress; a GREEN re-probe deploys nothing at all.
3. **S6**: a sibling parked on the same deployment, with its own worktree and its own probe, is
   requeued by one press on another run. **Mutation-checked**: removing the sweep → red.
4. `handoff-card.test.tsx`: an `activating` 200 reads as progress and consumes the note, and does
   **not** render the refusal copy. **Mutation-checked**: dropping the `activating` branch → red.
5. Mutation matrix, all confirmed red then restored green: never launching (2 red); no double-launch
   guard (1); no sibling sweep (1); deploying before the re-probe (1); a lock refusal reported as
   `activating` (1); per-target dispatch without dedup (1).
6. Full gates: `npm run typecheck` clean; `npm test` green; `test:unit`, `test:package`, `build`.
7. **Production E2E, round 1 — FAILED, 2026-08-29, and is why S3a exists.** The press launched
   nothing and locked the operator out. Found by the button, not by the 14 tests that shipped with
   it: every one of them stubbed the host, so none could observe that the real launcher's argv could
   not start on the real box.
8. **The fixed launch shape, proven on `prod-host` with a control.** From a deliberately
   non-login environment (`env -u XDG_RUNTIME_DIR -u DBUS_SESSION_BUS_ADDRESS`, what the service
   has): the shipped shape → *"Failed to connect to user scope bus"*; the fixed shape → *"Running as
   unit: cez-fix-….service"*, and the unit executed, writing `PROBE_OK from
   /var/lib/cezar/loki-labs/cezar` to a project-owned log. The control is what makes this evidence
   rather than a hopeful re-run. ✅
9. **S7**: a re-exec whose `systemd-run` fails reports `ok: false` naming the reason and hands back
   **no** `detachedUnit`, having staged and restarted nothing; the log directory prefers
   `/var/log/cezar` when creatable (the negative control), falls through when not, and never fails a
   deploy over a log. **Mutation-checked**: ignoring the handoff result → red; never falling through
   → 3 red; ignoring the resolved directory → red.
10. **S8**: with the ref declaring `activate` and **both** working trees stale, the launch still
    happens — and each working-tree read is asserted empty in the same test, so the pass can only
    have come from the ref. **Mutation-checked**: dropping the ref read → red.
11. **Production E2E, round 2 — pending.** Acceptance unchanged: one press, the card reading
   "deploying … now", a new release under `/opt/cezar-releases/`, every park clearing on the restart
   with no second press.

**S7 — `server-deploy`'s own re-exec, fixed too** *(2026-08-29, on the owner's instruction; it was
first recorded here as a known gap).* The shared deploy path had the same unwritable-log defect and
a worse reporting one:

- `deployLogPath` hardcoded `/var/log/cezar`. It is now resolved: `pickDeployLogDir` takes the first
  candidate the deployer can create (`/var/log/cezar`, then `~/.cezar/deploy-logs`, then the temp
  dir), memoized per process since the answer depends only on the uid. `readDeployLog` tries **every**
  candidate, because a log written by a root deployer and one written by the service account land in
  different directories and `--follow` on the wrong one reports an empty deploy.
- `ReleaseDeployHost.spawnDetached` returned `void`, so `runReleaseDeploy` answered
  `{ ok: true, detachedUnit }` whether or not a unit existed. It now returns `{ ok, error? }` —
  implemented with `spawnSync` for `systemd-run`, which returns once the unit is registered — and a
  failed handoff is reported as a failure. Nothing has been staged or flipped at that point, so
  failing there is both safe and honest; the previous behaviour turned "the unit never started" into
  something indistinguishable from a hung deploy.

**S8 — the fallback declaration is read from a REF, not the project root's working tree** *(same
instruction).* S2a's fallback was weak on the one box it was written for: the project root there is
the shared checkout task worktrees fork from, and nothing pulls it — `activate-main.sh` refuses to
`reset --hard` it by design, and agents fetch without pulling. Measured 2026-08-29: **22 commits
behind `origin/main` with 4 dirty files.** The lookup is now worktree → `git show origin/<base>:…`
→ project-root working tree. The ref is current the moment anything fetched and is unaffected by
dirty files, and it matches how worktrees already choose their base (`resolveBaseRef` prefers
`origin/<base>` when the local branch is behind), rather than inventing a third answer.

Note what did **not** need fixing: new task worktrees were never affected by the stale checkout,
because `resolveBaseRef` already forks from `origin/<base>`.
