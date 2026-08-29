# Activate main, not per-run worktrees

**Status:** Implemented 2026-08-26, **QA Needed** — the runtime proof (Verification 4-7) has not been
run, and it is the only thing that establishes the claim. Automated verification recorded green:
`npm run typecheck` across all four projects, and `recover-manual-deploy.test.ts` 5/5. Each of the five was
mutation-checked and each is killed by a distinct mutation (sweep never fires → the recheck test;
sweep fires unconditionally → the two "leaves it parked" tests; `kind` guard removed → the
manual-merge test; the sweep folded back into `recover()` → the placement test), so none of them
passes by construction. The probe rewrite (S3) was verified
separately against real `mkdtemp` repos with the old probe as the negative control: for a live sha
absent from the object db the old text printed "NOT serving this HEAD" and the new one prints
"CANNOT BE DETERMINED", while a genuinely divergent HEAD still reds. The full suite was NOT run here
(KB `run-cezar-gates-on-the-box-not-the-loaded-mac`: the gate is authoritative on the box, twice,
because of one deterministic red and a load-sensitive flake pool).
**Repo:** `cezar`
**Written against HEAD:** `d20f7101` (which is also `origin/main` at the time of writing, and is
itself the HEAD that produced the red this spec exists to explain).

**Extends, and does NOT supersede, the owner decision it depends on:**
`.ai/specs/2026-08-24-default-workflow-ten-stages.md` D6 and
`.ai/specs/2026-08-24-manual-deploy-not-a-bug.md`. **A person still activates cezar, not an
agent.** Nothing here automates the activation, moves it into a run, or weakens the park. What
changes is *what* the person is told to activate (`origin/main`, not the run's own worktree) and
*how many times* they must act (once per activation, not once per parked run).

## TLDR

Production cezar was serving `dc64b741` (landed 2026-08-25T10:34Z) while `origin/main` stood at
`d20f7101` (2026-08-26T11:08Z): **18 commits and roughly 25 hours behind**. Every run that finished
in that window parked on its own `manual-deploy` handoff card, each one asking a person to deploy
that run's own worktree. They were all waiting on the same single action, none of them said so, and
nothing anywhere reported that production had fallen a day behind.

Four defects, one shipped fix each:

1. The card names **this run's worktree**. Stage 8 lands the run on the base branch *before* stage
   10 runs, so `origin/main` already contains this HEAD. Deploying the worktree instead is
   unnecessary, ships a tree the merged-tree gate never saw, and can strand sibling runs on a
   divergent line.
2. **N cards for one action.** cezar is one service; exactly one sha can be live. One activation
   satisfies every parked run whose HEAD is an ancestor of it, but each still demands its own
   Resolve press.
3. The probe's ancestor test **fails closed when it cannot resolve the live sha**, and
   `2>/dev/null` makes "unknown object" indistinguishable from "not an ancestor". Latent today;
   armed the moment fix 1 lands, because a worktree cut before those commits existed has never
   fetched the sha the activation deploys.
4. **Staleness is invisible.** The only signal that production is behind is a run going red, one
   task at a time, after the fact.

## Problem

### P1. The instruction points at a tree that is neither necessary nor safest

Both targets in `.ai/deploy-targets.json` carry the same `manualReason`, added 2026-08-24 with D6:

> Deploy from THIS run's own isolated worktree (the path the run reports), NEVER from the shared
> checkout `/var/lib/cezar/loki-labs/cezar`: its local main lags and `server-deploy` builds whatever
> is checked out while `--sha` only labels the release (KB `notion-8d2aa351272c`).

The warning it carries is correct and stays correct: `server-deploy` builds the tree at `--source`,
and `--sha` only labels the release, so pointing at a checkout whose `main` lags ships old bytes
under a new label. But the conclusion it draws from that no longer follows. It was written for a
pipeline where the run's commit might not be on the base branch yet. Since D4, stage 8 lands the
run on the base branch and stage 10 deploys after it — measured on the run that produced this
spec, whose HEAD `d20f7101` *is* `origin/main`. So by the time the card appears, main already
contains the commit, and "main lags" is a property of one particular checkout that a `git fetch`
fixes, not a reason to deploy an unmerged tree.

Deploying the worktree instead costs three things:

- It ships a tree that passed only the branch gate, never the merged-tree gate — the exact
  distinction KB `notion-c20835e294bf` exists to draw.
- It cannot clear sibling parks. Run A's HEAD is an ancestor of run B's worktree HEAD only if they
  happen to be on the same line; two divergent task branches deployed in either order leave the
  other red permanently.
- The worktree is transient. Retention reclaims it (`reclaimedAt` on the record), so a card that
  has waited long enough names a path that no longer exists.

### P2. A box-level action is reported as a per-run card

`allServicesDeployed` parks the run that is executing (`postconditions.ts:357-370`), which is
correct for that run and blind to every other. `recover()` re-announces the same park on every
restart with "cezar restarted, still waiting for manual deployment" (`run.ts:2308-2313`) and
nothing more.

So an operator who activates correctly still has to walk the board and press Resolve once per
parked run, and each press re-enters that run's chain through `requeueHandoff`
(`run.ts:6299-6308`), which re-runs the deploy step — an agent step. The toil scales with the
backlog, which is exactly backwards: the longer activation is deferred, the more presses it costs.

### P3. The ancestor test cannot tell "no" from "cannot tell"

The backend probe ends:

```sh
git merge-base --is-ancestor "$head" "$live" 2>/dev/null && { echo "…descendant…"; exit 0; }
echo "live=$live head=$head — the running server is NOT serving this HEAD"
```

`git merge-base --is-ancestor` exits non-zero for *two* different reasons: the commit is genuinely
not an ancestor, and the commit is not in this repository's object database. `2>/dev/null` discards
the message that separates them, and the probe then prints the first reading for both.

Today this is latent, because the sha deployed has generally come from a tree the worktree could
already see. Fix 1 arms it: an activation of `origin/main` deploys commits a worktree cut an hour
earlier has never fetched, so a correct deploy would read as "NOT serving this HEAD" — the precise
failure shape the three dated corrections already in that file were each written to eliminate.

### P4. Nothing reports the gap until it reds a run

There is no place that says "production is N commits behind `origin/main`". The 25-hour gap here
was discovered because a task went red, and would have kept growing otherwise.

## Solution

### S1. Both `manualReason` strings name `origin/main` and a dedicated deploy checkout

Rewritten in place with a dated correction in the file's `$comment` array, which already carries
four. The command becomes one script (S2). The worktree path stays named as the **exception**: if
this HEAD is not on the base branch, landing was skipped, and only then does the run's own worktree
apply. The shared checkout `/var/lib/cezar/loki-labs/cezar` stays excluded, for a sharper reason
than "its main lags": task worktrees fork from it, so `reset --hard` there is a bad habit even on
the occasions it is harmless.

### S2. `scripts/activate-main.sh` — the whole activation as one command

`fetch → verify clean → reset --hard origin/main → npm ci → npm run build → server-deploy → probe
/api/v1/ready`, refusing on a dirty or mid-operation checkout and printing the live→incoming
relation before it acts. It performs no privileged step of its own: `server-deploy` keeps every
gate it already has (build-stamp/HEAD agreement, `staleSource`, and the divergence refusal at
`release-deploy.ts:446-460`). The script is a runbook that cannot be mistyped, not a new deploy
path.

### S3. The probe resolves the live sha before asking about ancestry

Fetch once if the object is absent, and if it is still absent, say *that* rather than "NOT serving
this HEAD". The `2>/dev/null` comes off the `merge-base` call, because once the object is proven
present, any remaining error is real and should be visible.

### S4. A restart re-probes every `manual-deploy` park

**An activation on this box IS a restart** — the blue-green flip restarts `cezar.service`. So boot
is the exact moment a `manual-deploy` park may have just been satisfied, with no timer, no polling
and no race against the cutover.

`recheckManualDeployParks()` re-runs the repo's own `all-services-deployed` probes in each parked
run's worktree and requeues **only** the runs that now pass.

**CORRECTED during implementation, 2026-08-26 — it cannot live in `recover()`, which is where this
spec first put it.** `manager.recover()` is awaited **before** `startServer()`
(`packages/cezar/src/index.ts`), and the deploy probe asks *this* server which sha it is serving.
Run from `recover()` it would interrogate a socket that is not accepting yet: every run would probe
red, so the sweep would never fire at the one moment it exists for, and each parked run would add
its full bounded poll (30s, plus `curl --max-time 10`) to boot. Correct logic, made unreachable by
a gate upstream of it. It is therefore called from `index.ts` after `startServer`, gated on
`waitForHealth(<url>/api/v1/ready, 30_000)` — `/api/v1/ready` rather than `/api/v1/health` because
it is uncached by construction and 503s until the server really is ready, which is exactly the
condition `waitForHealth`'s poll-until-`res.ok` waits for.

This was caught by reading the boot sequence, **not** by the tests: they drive the sweep directly,
so their fixture agrees with the bug. A fifth test now pins the placement — with green targets, a
plain `recover()` must leave the park intact — because folding the sweep back into `recover()` is a
one-line change that looks tidier and silently kills the feature on the real box while every other
test still passes.

Two further properties matter and neither is incidental:

- **Probe, then requeue — never requeue unconditionally.** `requeueHandoff` re-enters the chain at
  the deploy step, which is an agent step. An unconditional requeue would spend a model call per
  parked run on every restart, including the crash restarts that changed nothing.
- **The engine still learns nothing about cezar.** It reads the repo's own
  `.ai/deploy-targets.json` through the same post-condition every deploy step already uses. A repo
  with no manual targets never parks this way and never enters this branch.

### S5 (not in this spec). Staleness reporting

P4 is real and is deliberately left out of scope, because the honest fix is a cockpit surface
("production is N commits / H hours behind `origin/main`") and that is a UI change with its own
design questions. S4 removes the toil the gap causes; it does not make the gap visible in advance.
Filed as follow-up work, not silently dropped.

### P5 (noted, not fixed). The UI probe cannot detect being behind

Today's own probe output proves it: with the backend 18 commits stale, the UI target reported
**OK**. That probe compares the HTML actually served against
`/opt/cezar/packages/cezar/web/dist/index.html` — the **deployed** tree, not this HEAD's build — so
it proves the server is serving whatever was last activated, never that what was activated is
current. That is a real property worth keeping (it is what catches a half-live deploy: new tree,
old resident server) and it is not a substitute for currency. The pairing still holds because D6
marks both targets manual and activation is one symlink flip, so the backend probe decides for
both. Left alone deliberately rather than widened here; naming it so the next reader does not
mistake a green UI target for a current one.

## Architecture

```
stage 8 merge        HEAD lands on origin/main
stage 10 deploy      automatic targets deployed; manual ones probed
                     └─ any manual target red → park (pendingHandoff: manual-deploy)
                                                  card says: activate origin/main   ← S1
a person runs        scripts/activate-main.sh                                        ← S2
                     └─ server-deploy blue-green: symlink flip + service restart
cezar.service boots  recover()          ← adopts persisted runs. NOT the hook: it is awaited
                                         BEFORE the server listens (see S4)
                     startServer()      ← the socket starts accepting
                     GET /api/v1/ready answers
                     └─ recheckManualDeployParks(): re-probe each park in its worktree  ← S4
                        ├─ green → requeueHandoff → chain continues, no press
                        └─ red   → stay parked, unchanged
```

## Data models

None. `pendingHandoffSchema` is unchanged, `deployTargetsSchema` is unchanged, and no run record
field is added. S4 reads `worktreePath` and `workspaceProjects`, both of which already exist
(`runs/store.ts:473`, `:439`).

## API contracts

None. `POST /runs/:id/handoff/resolve` and `/skip` keep their present behaviour exactly; S4 reaches
`requeueHandoff` through the same internal path a Resolve press takes, so a run cleared by the
sweep is indistinguishable from one cleared by hand.

## Risks

- **R1. Sweep cost on an unrelated restart.** Two curls per parked run, sequential, each bounded by
  `PROBE_TIMEOUT_MS`. A crash restart with five parked runs spends ten bounded probes and requeues
  nothing.
- **R2. A pruned worktree.** `worktreePath` absent or gone means the probes cannot run. Treated as
  **still parked**, never as green: a missing directory is not evidence of a deploy.
- **R3. Dry runs.** `dryRunVerdict` short-circuits every post-condition green under
  `CEZ_DRY_RUN=1`, so the sweep would clear parks in a dry run. Consistent with the existing
  carve-out (`AGENTS.md:13`) rather than a new hole, but named here so it is not rediscovered as a
  surprise.
- **R4. A run whose HEAD is not on main.** Then activating main does not satisfy it, and the probe
  correctly stays red. The `manualReason` keeps the run's own worktree as the named exception for
  exactly this case, so the operator is not left without a path.
- **R5. The sweep's placement is load-bearing, not stylistic.** It must run after the server
  listens; see the correction in S4. The regression test is the only thing keeping it there, and it
  is the only test in the file that would notice.
- **R6. `git fetch` inside a probe.** S3 adds a network call to a probe that previously made none,
  inside the 60s harness bound. It runs only on the branch where the live sha is unresolvable, and
  a failed fetch degrades to the explicit "cannot determine the relation" message rather than to a
  wrong verdict.

## Verification

**Automated.**

1. `postconditions.test.ts`: a real `mkdtemp` git repo where the live sha is **absent** from the
   probing worktree asserts the probe reports "cannot be determined", not "NOT serving this HEAD".
   Negative control: the same fixture with the sha present must still report the plain red for a
   genuinely divergent HEAD, so the new branch cannot be what makes both cases pass.
2. `recover-*.test.ts`: three cases for the sweep — probes green → the run requeues and the step
   returns to `pending`; probes red → the run stays `waiting` with `pendingHandoff` intact;
   `worktreePath` missing → stays `waiting` (R2). Assert `requeueHandoff` is **not** reached in the
   last two, since "did nothing" is the property that keeps R1 bounded.
3. `npm run typecheck`, `npm run lint`, `npm test`. Per
   KB `run-cezar-gates-on-the-box-not-the-loaded-mac`, the gate is authoritative **on the box**,
   and it must be run twice before attributing any red: there is one deterministic failure (C18)
   plus a load-sensitive flake pool.

**Runtime, on `prod-host` — this is the part that decides whether the spec worked.**

4. With at least two runs parked on `manual-deploy`, run `scripts/activate-main.sh`.
5. After the service comes back: `curl -fsS http://127.0.0.1:4321/api/v1/ready` reports
   `deploy.sha` = `origin/main`.
6. **Every parked run left `waiting` with no Resolve press**, and its step log shows the sweep's
   own event. This is the claim; steps 1-3 do not establish it.
7. Negative control for step 6: a run whose HEAD is *not* an ancestor of the deployed sha is still
   parked afterwards. Without it, "everything went green" is equally consistent with a sweep that
   clears parks unconditionally.

**CORRECTED 2026-08-29: steps 4 to 7 were never executed, and step 6 FAILED the first time it
was.** This spec shipped in `6a40929d` on 2026-08-26 and was never deployed, so the production
verification above stayed hypothetical while its claim ("the operator presses Resolve zero times")
was read as fact by the handoff card. Production sat on `dc64b741` for four days with two runs
parked, and an operator pressed Resolve five times against five honest reds.

When step 4 was finally run on 2026-08-29, `deploy.sha` matched `origin/main` (step 5 passed) and
step 6 **failed**: both runs stayed `waiting`, while each one's own probe exited 0 when run by hand
in its worktree. Two causes, neither visible from this spec's own tests:

- **S4's sweep swept the boot project only.** This box's boot project is `workspace`; every cezar
  deploy park lives in the registered `cezar` project. The sweep could never have reached them.
- **A parked worktree could not resolve the deployed sha**, which is the hazard item 3 of the
  Problem section predicted and armed. The repair went into the probe, and a parked run runs the
  probe copy in its OWN worktree, so the repair could not reach the runs it was written for.

Both fixed in `.ai/specs/2026-08-29-resolve-button-red-recheck.md`. Steps 4 to 7 then passed on the
next activation (`17637629`): both parks cleared with no Resolve press, each logging `every deploy
target now probes green after the restart` and `manual deploy detected after restart`.

Until 4-7 have been executed this ships as **QA Needed**, not Done.
