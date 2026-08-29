# Resolve answers a red recheck, and a park can be cleared at all

**Status:** Implemented (2026-08-29)
**Supersedes nothing.** Extends `.ai/specs/2026-08-26-activate-main-not-worktrees.md` (S4) and
`.ai/specs/2026-08-24-manual-deploy-not-a-bug.md` (D2). D6 is untouched: a person still activates
cezar, not an agent.

## TLDR

Three defects kept four runs parked on `needs you` for three to four days and made the Resolve
button look dead. All three are fixed here, none of them by weakening a gate.

1. **The button swallowed its own refusal.** `POST /handoff/resolve` answers **200** with
   `resolved: false` when the re-probe is still red. The web client typed that body `unknown` and
   the card's `onSuccess` ran anyway: it cleared the operator's note and rendered nothing. A
   refusal and a success were pixel-identical.
2. **A correct activation could not clear a park.** The probe that runs for a parked run is the
   copy in the run's **own worktree**. Those worktrees were cut before the deployed commits
   existed, so the live sha is not in their object db, and `git merge-base --is-ancestor … 2>/dev/null`
   reports "unknown object" as "not deployed" — permanently.
3. **The activation runbook could not run on the box it was written for.** `activate-main.sh`
   defaulted to the SSH remote; the `cezar` user has no SSH key for GitHub.

## Problem

Measured on `prod-host`, 2026-08-29:

| Fact | Value |
| --- | --- |
| Live release | `dc64b741`, activated **2026-08-25T10:40:13Z** — four days |
| `origin/main` (GitHub) | `6a40929d` |
| Parked on `manual-deploy` | `cc25d636` (HEAD `d20f7101`), `30ca4c9f` (HEAD `b5e9b4a8`) |
| Resolve presses on `cc25d636` | **5**, each answered `handoff recheck is still red` |
| `git cat-file -e 6a40929d^{commit}` in `cc25d636`'s worktree | **ABSENT (unknown object)** |
| `ssh -T git@github.com` as `cezar` | `Permission denied (publickey)` |
| `/var/lib/cezar/deploy` | does not exist — first activation takes the clone path |

The event log is unambiguous about what the operator experienced: five
`handoff resolve requested by …` notes, each followed by
`handoff recheck is still red: …`. The server did the right thing and said so; nothing said it to
the person who pressed the button.

### Why the probe's own fix could not reach these runs

`.ai/deploy-targets.json` was taught on 2026-08-26 to resolve the live sha before testing
ancestry (`git cat-file -e "$live^{commit}" … || git fetch`). That repair ships in the **repo**.
The probe that actually executes for a parked run is the one in that run's **worktree**, cut
before the fix existed and never updated. So the repair reaches every run except the ones already
parked — and the ones already parked are the entire population it was written for. This is the
general shape: *a fix that ships in the artefact under test cannot repair the copies already
taken.*

## Solution

**S1 — the client reads the answer.** `resolveRunHandoff` returns
`{ resolved: boolean; verdict: string }` instead of `unknown`. `HandoffCard.onSuccess` branches on
`resolved`: on a refusal it toasts the verdict in the `danger` tone and **keeps the note** (it is
the operator's, the handoff is still parked, and wiping their typing was the second half of what
made this feel dead); on a real resolve it clears the note and says so.

**S2 — a verdict short enough to be an answer.** `PostconditionResult` gains `summary`: the
failing manual targets' names and their probes' own output, with no probe source and no
`manualReason`. `detail` (pages long, every probe's source) still goes to the event note, so
nothing is lost from the record. Only the manual-deploy park sets it — the one place a person is
waiting on the answer.

**S3 — the engine refreshes a parked worktree before probing it.** `refreshParkedWorktree()` runs
`git fetch --quiet origin`, bounded at 20s, before the deploy post-condition on **both** re-probe
paths: the boot sweep (`manualDeployNowLive`) and the interactive Resolve press. It touches the
object db and remote-tracking refs only — never HEAD, the index, or the working tree — and is
best-effort: a failed or slow fetch leaves the probe to answer exactly as it would have. Being
engine-side is the whole point, because that is the only side that reaches an already-parked run.

**S4 — `activate-main.sh` reads its clone URL from a checkout that works.** `REPO_URL` now
defaults to `git -C /var/lib/cezar/loki-labs/cezar remote get-url origin` (HTTPS, authenticated
through `gh auth git-credential`), falling back to the HTTPS GitHub URL. The old SSH default was
only ever consulted on the **first** activation — the one where the deploy checkout does not exist
yet — so it failed exactly when there was nothing to fall back on.

## Architecture

```
Resolve press ─▶ POST /runs/:id/handoff/resolve
                   │
                   ├─ live waiter?  ─▶ refreshParkedWorktree(state.cwd)   ← S3
                   │                    └─▶ recheck() ─▶ green: resume
                   │                                  └─ red:  200 {resolved:false, verdict:summary}  ← S2
                   │                                            └─▶ toast(danger), note kept       ← S1
                   └─ no waiter (restart) ─▶ requeueHandoff

boot, after startServer ─▶ recheckManualDeployParks()
                             └─ per park: refreshParkedWorktree(worktreePath) ─▶ probe ─▶ requeue on green
```

## Data models

`PostconditionResult.summary?: string` — additive, optional, set only by `all-services-deployed`
on a manual failure. No stored shape changes; no migration.

## API contracts

`POST /runs/:id/handoff/resolve` is unchanged on the wire (`{resolved, verdict}`, 200 either way).
What changes is that `verdict` on the red path is now the concise `summary` rather than `detail`,
and that the **client** is typed to read it.

## Risks

- **A fetch on the Resolve path adds latency to a click.** Bounded at 20s with
  `killSignal: 'SIGKILL'` — a timeout that only sends SIGTERM has not ended anything — and well
  inside the 60s probe budget that follows.
- **`cwd` may be absent.** `execFile` with `cwd: undefined` inherits the server's directory, which
  would have made this fetch from the cezar checkout itself on every press. Guarded on
  `!cwd || !existsSync(cwd)`. This was not theoretical: it turned two `handoff-gate.test.ts` cases
  into 5s network timeouts, which is how it was found.
- **Fetching must not become "assume green".** The negative control in
  `parked-worktree-fetch.test.ts` parks a run on a divergent line: the object arrives and the park
  stays red.

## Verification

Executed 2026-08-29 unless marked otherwise.

1. `parked-worktree-fetch.test.ts` — a worktree cloned before the deployed commit existed, with
   the **old** probe shape (the one the stuck runs carry, deliberately, so the test cannot pass
   against a fixed probe with the engine fix reverted). Three cases: the precondition that the
   worktree genuinely cannot resolve the sha; the park clearing after the refresh, plus an
   assertion that the object is present afterwards; and the divergent-line negative control.
   **Mutation-checked**: deleting `await this.refreshParkedWorktree(cwd)` fails the middle case
   and leaves the other two green. ✅
2. `handoff-card.test.tsx` — a 200 carrying `resolved: false` shows the verdict and keeps the
   note; a 200 carrying `resolved: true` clears it. **Mutation-checked**: restoring the old
   `onSuccess` fails both. ✅ The pre-existing green-path test stubbed only `resolved: true`,
   which is why this shipped.
3. Full gates on the box (`typecheck`, `lint`, `test`, `test:unit`, `test:package`, `build`). ✅
4. Production E2E: activate `origin/main`, confirm `/api/v1/ready` reports the new sha, and
   confirm the parked runs clear **without** a Resolve press (S4 of the 2026-08-26 spec, which
   has never actually run on this box because the release that carries it was never deployed). ✅
