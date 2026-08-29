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
7. **Production E2E — pending.** Acceptance: a parked run on `prod-host`, one Resolve press,
   the card reading "deploying … now", a new release under `/opt/cezar-releases/`, and every park
   clearing on the restart with no second press.
