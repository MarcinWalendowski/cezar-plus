# Cluster dispatch hostname probe

**Status: PARTIAL — P0 and P1 executed 2026-08-24, no product change made.** P0 (the probe itself)
was satisfied twice over (see §"Measured facts"). P1 landed as commit `52612f48` (`docs:` only, two
files, local to `cez/d843bf5e`, not pushed — see §"Record" for the verification). P2 (the deploy
gate) is an operator decision this run declines to make unattended, per its own text below, so step
8 of this run should not report a false green. P3 (recording this doctrine in the KB) is this run's
step 7 and is done in the same breath as this edit. This document is the `spec` step (2 of 8) of run
`d843bf5e-9455-42fe-9ada-193512c54110`, workflow `spec-to-deploy`, branch `cez/d843bf5e`, worktree
HEAD `715e3ee8` (at time of writing; HEAD is now `52612f48`). Its subject is an **E2E probe of the
multi-node cluster's dispatch path**, not a feature. What this spec actually decides is the thing
the probe collided with, which is that **`spec-to-deploy` cannot carry a "do not write files, do not
commit" task to a green finish**, for a reason that is in the postcondition code and is cited below.

Written against the brief `.ai/specs/briefs/2026-08-24-cluster-probe-print-hostname.md` (step 1 of
this run). Every file cited below was re-opened at `715e3ee8` for this document.

## TLDR

The task is two commands: `hostname -s`, `uname -a`, print, stop, touch nothing, commit nothing.
Both were run twice on this box, in two different steps of this run, and both times the answer was
`prod-host`. The acceptance criterion is met.

The interesting result is not the hostname. It is that the run was dispatched onto the
**`spec-to-deploy`** workflow, whose steps 6, 7 and 8 carry built-in postconditions
(`packages/cezar/src/workflows/types.ts:981,1031,1109`) that are **structurally unsatisfiable** by a
task forbidden to write files or commit — but not for the reason the brief guessed. The brief's open
question 1 asked whether `commit-push` "requires *something* committed to go green". It does not:
`everythingCommitted` (`packages/cezar/src/workflows/postconditions.ts:126`) is green on a *clean
tree*, commit or no commit. The real trap is the inverse. The workflow's own scaffolding steps have
**already dirtied the tree** — step 1 wrote the brief, this step writes this file — so by the time
`commit-push` runs, `git status --porcelain` is non-empty and the postcondition fails on files the
workflow itself put there, not on anything the task did. Obeying "do NOT commit" literally therefore
guarantees a red step.

The recommendation is P1 below: commit the two doc files as a local `docs:` commit, **without
pushing**, accept that this is a deviation from the task text and say so plainly rather than
quietly, and record the doctrine (P3) that a no-write probe must be filed as a one-step workflow,
never `spec-to-deploy`.

## Problem

### What the task asks

From the run's own handoff (`.ai/cezar/runs/d843bf5e-….handoff.md`) and the brief:

> Cluster dispatch end-to-end probe. Run: `hostname -s` and `uname -a`. Print the output. Do NOT
> modify, create, or delete any file. Do NOT commit. Then stop.
>
> - [ ] The run output contains the hostname of the machine that executed it.

This is a smoke test of the dispatch path that shipped on this exact branch lineage days ago:
`b446be29` (feat: multi-node cezar cluster — dispatch activation and the `acceptsDispatch` writer),
`6e9fd0f2`/`1c2c2d1a` (the hub self-confirms its own local autostart claims under `CEZ_CLUSTER=1`),
`96668b03`/`715e3ee8` (a spoke can join an auth-enabled hub). Its value is proving **which machine
executed the work**, which is why the criterion is about the hostname appearing in the output rather
than about any artifact.

### Why it does not fit the workflow it was given

`spec-to-deploy` is 8 steps: context → spec → review-spec → implement → run-tests → commit-push →
document → deploy. Three of them assert a postcondition
(`packages/cezar/src/workflows/types.ts`):

| step | line | postcondition |
| --- | --- | --- |
| `commit-push` | 981 | `{ builtin: 'everything-committed', max: 1 }` |
| `document` | 1031 | `{ builtin: 'everything-committed', max: 1 }` |
| `deploy` | 1109 | `{ builtin: 'all-services-deployed', max: 1 }` |

`everythingCommitted` (`postconditions.ts:126`) reads:

```
const dirty = status.stdout.split('\n').map(l => l.trim()).filter(Boolean);
if (dirty.length > 0) {
  return { ok: false, detail: `${plural(dirty.length,'file')} still uncommitted — …` };
}
```

`--porcelain` honours `.gitignore` but reports **modified AND untracked** files — the comment above
that branch says so explicitly, naming run `23221162` as the incident it was written for. There are
exactly two carve-outs, and neither applies here: `ctx.workspaceRun` (this is a single-project
worktree run, not a workspace run — `run.ts:6955` sets that flag only when
`workspaceProjects?.length > 0`), and "not a git working tree" (this worktree is one).

So the sequence is:

1. Step 1 writes `.ai/specs/briefs/2026-08-24-cluster-probe-print-hostname.md`. Measured now:
   `git status --porcelain` → `A .ai/specs/briefs/2026-08-24-cluster-probe-print-hostname.md`.
2. Step 2 (this one) writes this spec — the step's own instructions require it and require its path
   declared for step 3 to review.
3. Step 6 evaluates `everything-committed` against a dirty tree → **`ok: false`**, retried once
   (`max: 1`), then the step fails. The count is **two files once this spec is written into the
   worktree** — it was **one** at the time this document was first drafted, because step 2 initially
   wrote the spec outside the worktree, into the main checkout (see §Record). Do not read the count
   off this page; V2 re-measures it.

**And the postcondition is only half of the mechanism: the harness commits the tree itself,
unconditionally.** `run.ts:5429` ends every run with `if (state.cwd !== this.repoRoot) await
autosaveCommit(state.cwd, 'run finalize');`. That guard is true here — `run.ts:4955` sets
`state.cwd = wt.path` when the run takes a worktree — and it is **not** gated on `CEZ_AUTOSAVE`.
Only the *periodic* timer is opt-in (`periodicAutosaveEnabled`, `run.ts:245-247`, returns
`env.CEZ_AUTOSAVE === '1'`; measured unset on this box, which is why HEAD is still `715e3ee8` after
three step-turns). `autosaveCommit` (`git-worktree.ts:323-352`) runs `git add -A` and then
`git commit --no-verify -m "cezar autosave (run finalize)"`, and returns `'nothing-to-do'` **only
when the tree is already clean** (`git-worktree.ts:325`).

So **"do NOT commit" is not achievable by agent restraint at all.** With two files in the tree,
obeying it literally buys a red step 6 *and* a harness-authored commit under the opaque message
`cezar autosave (run finalize)` — the worst of both outcomes. This **strengthens** P1 rather than
weakening it: if this branch is going to carry a commit either way, a labelled `docs:` commit naming
its two files beats an unlabelled autosave nobody chose. The only thing that avoids a commit
entirely is an already-clean tree, which is why §Rejected alternatives has to price deletion
honestly rather than as a mere convenience.

The task text and the workflow's gate cannot both be honoured. That is the decision this spec
exists to make, and it is an operator-visible one, not something to paper over.

### The second-order trap: the deploy gate

Committing to clear the dirty tree does not end the problem, it moves it. `.ai/deploy-targets.json`
declares **two real targets** with live probes, and `allServicesDeployed`
(`postconditions.ts:254`) runs them for real; a missing targets file would fail, an empty
`{"targets": []}` would pass, but neither is the case here. The backend probe's own recorded
correction (`.ai/deploy-targets.json`, `$comment`, "CORRECTED AGAIN 2026-08-21") states its rule:

> It demanded live sha == this worktree HEAD. … **HEAD being an ANCESTOR of the live sha is now
> green.**

The comparison the probe actually makes is **HEAD against the live sha reported by the running
process at `GET /api/v1/ready`** — not against `origin/main`. That distinction is load-bearing here,
because the two are *not* interchangeable on this box. Measured at `715e3ee8`, 2026-08-24 ~12:50Z:

- **The rule comes from the probe's source, not from any snapshot of the box.** The backend target
  in `.ai/deploy-targets.json` greps `sha` out of `GET /api/v1/ready` into `$live`, then runs
  `case "$head" in "$live"*)` and `git merge-base --is-ancestor "$head" "$live"`. The word `origin`
  appears in neither probe. HEAD-vs-live and HEAD-vs-`origin/main` are therefore different relations
  by construction, and only the first is the gate — do not substitute one for the other, including
  in the periods when they coincide.
- **They coincide right now, which is precisely why the point must be made from the source.**
  Measured 2026-08-24 ~12:50Z the live sha was `d01fc102` while `origin/main` was `8f1732a3`;
  re-measured ~13:00Z the box had activated `8f1732a3` itself
  (`releaseId 20260824T124515Z-8f1732a3`, `activatedAt 12:45:22.818Z`), so live *is* `origin/main` as
  this is written. The sha rolls over whenever a concurrent task deploys. V4 re-measures it; this
  page does not.
- `git merge-base --is-ancestor HEAD "$live"` → **exit 0** at unmodified HEAD `715e3ee8`, against
  both of those live shas. So with the tree left alone the backend probe has a green path; both
  probes were re-run verbatim during step 3's review and both exited 0.
- A **new** commit on `cez/d843bf5e` is by construction *not* an ancestor of any already-activated
  sha, whichever one is live when step 8 runs (`d01fc102` then, `8f1732a3` now). So the
  moment P1 commits, `deploy` reads red until that commit is actually activated on the box. This is
  a confirmed prediction, not a conjecture.

That is the honest cost of P1 and it belongs in the operator's hands, not buried in a step log.

### What could not be verified

- ~~The live sha the running service reports.~~ **Recorded 2026-08-24 during review of this spec.**
  `GET /api/v1/ready` on `127.0.0.1:4321` answers
  `"deploy":{"releaseId":"20260824T123308Z-d01fc102","version":"0.10.0","sha":"d01fc1028a054a52d942bd68d69d06bc412710e2","activatedAt":"2026-08-24T12:33:13.351Z","builtAt":"2026-08-24T12:33:07.222Z","dirty":true}`.
  Both deployed trees are present (`/opt/cezar/packages/cezar/dist/index.js`,
  `/opt/cezar/packages/cezar/web/dist/index.html`, both stamped 12:33). So at unmodified HEAD
  **both** deploy probes have a green path. V4 still exists because that is a snapshot: a concurrent
  task can activate a different sha at any moment, and the gate reads the box, not this file.
- Whether this probe was dispatched from a hub to a *different* node, or executed locally on the
  hub. Nothing in the run record distinguishes the two, which is precisely the brief's open
  question 3 and the reason V1 must be re-run in situ rather than quoted.

## Measured facts

Run in this worktree on `prod-host`, in **step 2** (this step), independently of step 1:

```
$ hostname -s
prod-host

$ uname -a
Linux prod-host 7.0.0-29-generic #29-Ubuntu SMP PREEMPT_DYNAMIC Fri Jul 17 20:52:35 UTC 2026 x86_64 GNU/Linux
```

Step 1 recorded byte-identical output in the brief. Two independent executions, one node,
`prod-host`. **The acceptance criterion — "the run output contains the hostname of the machine
that executed it" — is satisfied.**

Per KB `specs-846bf82b4c91` ("The deploy E2E probe must not report PASS on what it never observed"),
this is stated as what was measured, not as a claim that cross-node dispatch works: **both samples
come from the same machine, so this run has demonstrated execution-and-report round-trip, and has
demonstrated nothing whatsoever about placement onto a second node.** A single-node cluster cannot
distinguish "dispatch works" from "dispatch never happened". Anyone reading this as proof of the
multi-node path is reading more than the data holds.

## Solution

### The brief's three open questions, settled

**Q1 — does `commit-push` tolerate a no-op run with nothing staged?**
**Yes, and it is the wrong question.** A clean tree is green (`postconditions.ts:126-183`): with no
upstream configured it returns `ok: true` with "no upstream is configured for this branch, so the
commits are local only" (`postconditions.ts:163-169`) — and this branch has no upstream
(`git rev-parse --abbrev-ref --symbolic-full-name @{u}` → `fatal: no upstream configured for branch
'cez/d843bf5e'`). What fails is a **dirty** tree, which is what the workflow's own scaffolding has
created. The mismatch is real but inverted from the brief's framing.

**Q2 — must the output land in the handoff/task record, or does the step transcript suffice?**
**The transcript suffices.** The criterion says "the run output", and a step's transcript is run
output. No mechanism reads a hostname out of the handoff file, so writing it there would be
decoration. This spec records it anyway (§Measured facts) because the spec is the artifact step 3
reviews — that is a byproduct of the workflow choice, not a requirement of the probe.

**Q3 — is the probe meant to validate dispatch onto a *different* node?**
**Assume yes, and treat this run as inconclusive on it.** The task calls itself a "cluster dispatch
end-to-end probe", and the only reading under which the hostname matters is one where it might have
been a different hostname. Both samples here are the hub itself. V1 keeps the re-run requirement so
no later step launders a quoted value into a fresh observation.

### Decision

**D1. Obey the acceptance criterion; deviate from "do NOT commit", visibly.** The two files that
exist are workflow scaffolding (a brief and this spec), not the "modify, create, or delete any file"
the task was guarding against — that clause protects product code from a probe. But the deviation is
a deviation and gets reported in the run's final message, not smoothed over.

**D2. Do not implement anything.** Step 4 (`implement`) has nothing to build. It must report "no
code change required by this spec" rather than inventing a diff to look busy.

**D3. Prefer stopping over deploying.** The task says "then stop". If the operator will accept a red
or skipped tail, stopping after P0/P1 is the outcome truest to the task. P2 exists only for the case
where the run must be driven to green.

**D4. Local commit only — no push, no PR.** The `commit-push` step's prompt (`types.ts:1013-1016`)
tells the agent to "ship it the way this repo ships … whether it pushes a branch directly, or opens
a PR (`gh pr create`) and merges it", and `'git push'` and `'gh pr'` are both in its
`bashAllowlist` (`types.ts:990-1003`). For a probe whose contract is "change nothing", pushing to
`origin` is an outward-facing action nobody asked for. It is also unnecessary: the gate goes green
on a clean tree with no upstream (Q1), so nothing is bought by pushing.

### Rejected alternatives

- **Delete the brief and this spec to restore a clean tree.** Priced honestly this is more than "the
  cheapest green". Because `autosaveCommit` returns `'nothing-to-do'` on an already-clean tree
  (`git-worktree.ts:325`), deletion is **the only path on which this run commits nothing at all** —
  every other path ends in either P1's `docs:` commit or the harness's own `cezar autosave (run
  finalize)` (see §Why it does not fit). It also leaves HEAD at `715e3ee8`, where both deploy probes
  exit 0 (re-run verbatim during step 3's review). So it is the single option that satisfies "do NOT
  commit" literally *and* keeps steps 6, 7 and 8 green. It is **still rejected**, on the one ground
  that outranks a green: it destroys the run's own record. Step 3 (`review-spec`) and step 7
  (`document`) read this file, and a probe that erases its own evidence to satisfy a gate is the
  exact failure mode KB `specs-846bf82b4c91` was written against. Rejecting it at its true cost is
  the point — an operator who wants a literally-clean run should choose this knowingly, not discover
  it later as an option this spec understated.
- **Force a trivial product diff to satisfy the gates.** Directly contradicts the task and
  manufactures a commit whose only purpose is to pass a postcondition. This is what the brief warned
  against and it stays rejected.
- **`CEZ_DRY_RUN=1` to neutralise the postconditions.** `postconditions.ts` (header comment, lines
  71-76) documents that dry-run mode makes these checks structurally unanswerable, and the run is
  not a mock. Using it to dodge a real gate would be forging a green.

## Architecture

**Product code touched: none.** There is no module to add and no interface to change. The components
that *participate* in this run, all of them pre-existing:

| component | path | role here |
| --- | --- | --- |
| workflow definition | `packages/cezar/src/workflows/types.ts:960-1120` | supplies the 8 steps and the three `verify` clauses |
| postconditions | `packages/cezar/src/workflows/postconditions.ts` | `everythingCommitted:126`, `allServicesDeployed:254` |
| verify driver | `packages/cezar/src/workflows/run.ts:6939-6965` (`runStepVerify`) | evaluates the builtin against `state.cwd` (line 6956), emits `check-output` with an exit-code verdict |
| retry policy | `packages/cezar/src/workflows/run.ts` (`retryAfterFailedPostcondition`) | re-enters the same step once (`max: 1`), telling the agent what it failed |
| deploy contract | `.ai/deploy-targets.json` | two probes: backend "RUNNING process serving this HEAD" via `/api/v1/ready`, UI "built bundle is the one being served" via `/` |
| cluster spec | `.ai/specs/2026-08-22-multi-node-cezar-cluster.md` | the subject under probe — Status *Partial, implemented 2026-08-23, not yet verified* |

After the relocation described in §Record, the artifacts this run has produced are exactly two, both
**inside this worktree**: `.ai/specs/briefs/2026-08-24-cluster-probe-print-hostname.md` and this
file. A third existed briefly — an untracked copy of this spec at
`/var/lib/cezar/loki-labs/cezar/.ai/specs/2026-08-24-cluster-dispatch-hostname-probe.md` in the main
checkout, written by step 2's first attempt. It is **deleted**, because every later step runs with
`cwd` = this worktree (`run.ts:6956` passes `state.cwd`), so a file over there is unreachable to
`git add`, unresolvable as a repo-relative path for step 7, and a permanent dirtying of a checkout
this task was told not to touch.

## Data models and API contracts

**No new data model and no new API contract.** Two existing contracts are load-bearing for the
phases and are restated as-read, not as-designed:

`PostconditionResult` (`postconditions.ts:37`) — `{ ok: boolean; detail: string }`; `POSTCONDITION_IDS`
is exactly `['everything-committed', 'all-services-deployed']` (line 45).

`.ai/deploy-targets.json` (`deployTargetsSchema`, `postconditions.ts`) —
`{ targets: [{ name: string, probe: string }] }`. Each `probe` runs under `bash -lc` in the step's
cwd, bounded by `PROBE_TIMEOUT_MS = 60_000` (line 29); exit 0 is the only pass. An **absent** file is
`ok: false` by design; `{"targets": []}` is `ok: true`. This repo's file declares 2 targets.

`GET /api/v1/ready` (read here, not designed here) carries
`deploy: { releaseId, version, sha, activatedAt, builtAt, dirty }`. The backend probe parses `sha`
out of it. `/api/v1/health` carries the same field but is **not** what the gate reads: the
`$comment` records it as cached stale-while-revalidate and blocking past `HEALTH_MAX_STALE_MS`,
which is the "SILENT RED" incident the probe was rewritten to escape. Anything checking this gate by
hand must use `/api/v1/ready`.

## Phases

Independently shippable, in order. **P0 alone satisfies the task's acceptance criterion**; each later
phase exists only to resolve the workflow collision, and each can be stopped at.

### P0 — Execute and print the probe *(done; nothing to ship)*

Run `hostname -s` and `uname -a` in the step that actually executes, print both verbatim. Do not
quote an earlier step's captured value. **Complete for steps 1 and 2** (§Measured facts). Every
later step that runs should re-run them, since a later step could in principle land on another node.

### P1 — Clear the workflow's own scaffolding, honestly

One `docs:` commit containing exactly the brief and this spec, on `cez/d843bf5e`, **committed
locally and not pushed**. Nothing else may enter it — verify with `git status --porcelain` before and
`git show --stat` after.

Explicitly, per D4: **do not `git push`, do not `gh pr create`, do not merge.** The gate still goes
green without any of that, and the reason is in the code: this branch has no upstream, so
`everythingCommitted` short-circuits to `ok: true` with "no upstream is configured for this branch,
so the commits are local only" (`postconditions.ts:163-169`). A push would be an outward-facing
action on a task whose contract is "change nothing".

This makes `everything-committed` green at steps 6 and 7. The run's final message must state **both**
deviations: that the task said "do NOT commit" and the workflow's gate made that unachievable
(naming this file), and that nothing was pushed by deliberate decision.

Independently shippable: after P1 the run may stop, with steps 6 and 7 green and step 8 unattempted.

### P2 — Resolve the deploy gate, or decline it *(operator decision; do not do this unattended)*

P1's commit is not an ancestor of the live sha `d01fc102`, so `all-services-deployed` will read red
at step 8 (§"The second-order trap"). Two acceptable outcomes, and one unacceptable:

- **Decline** (preferred, per D3): leave step 8 unattempted or skipped, and report the deploy as not
  performed because no code changed. A doc-only commit does not need activation.
- **Activate**: deploy this HEAD, making the probe's ancestry test true. Only appropriate if the
  operator wants the branch live anyway. cezar's self-deploy is non-disruptive per
  `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`.
- **Not acceptable**: reporting step 8 green without both probes exiting 0. That is the vacuous pass
  KB `specs-846bf82b4c91` forbids.

### P3 — Record the doctrine so the next probe is filed correctly

The durable lesson is not about this hostname: **a task whose contract is "change nothing" must not
be filed on `spec-to-deploy`.** That workflow's `commit-push`/`document` steps fail on the dirty tree
its own `context` and `spec` steps create — and, the stronger half, `run.ts:5429` commits that tree
anyway at run finalize whatever the agent decides.

**Dropping to a single-step workflow with no `verify` clause is not sufficient, and an earlier draft
of this phase was wrong to say it was.** A single-step workflow still runs in a worktree, so
`state.cwd !== this.repoRoot` still holds and the run-finalize autosave still commits whatever that
step wrote. A "change nothing" probe must satisfy **both** of:

1. either run with `cwd === repoRoot` (the worktree opt-out, so `run.ts:5429`'s guard is false and
   the autosave is skipped) **or** write no file at all, so `autosaveCommit` short-circuits at
   `git-worktree.ts:325`; **and**
2. carry no `verify` clause, so no postcondition demands a commit the probe was told not to make.

**How to write it down.** Append an NDJSON `upsert` line to `$CEZ_KB_WRITE_FILE`; never edit a
mounted document directly. Measured in this run, that variable resolves to
`/var/lib/cezar/loki-labs/cezar/.ai/cezar/runs/d843bf5e-9455-42fe-9ada-193512c54110.knowledge.ndjson`
— **outside this worktree** — so step 7 writing it dirties nothing and `everything-committed` stays
green off P1's commit. This is new doctrine with no stale entry contradicting it, so the line carries
no `supersedes`; if step 7 finds an entry it does contradict, name that entry and add one. Cross-link
the multi-node cluster spec, whose status is still *not yet verified* and which this run does not
advance.

## Risks

| # | risk | severity | mitigation |
| --- | --- | --- | --- |
| R1 | **This run is read as proof that cross-node dispatch works.** Both samples are the hub itself; a one-node sample cannot distinguish a dispatched run from a local one. | high — it would mark the cluster spec verified on no evidence | §Measured facts states the limit explicitly; P3 records it; the cluster spec's status stays *not yet verified* |
| R2 | A later step quotes the brief's hostname instead of running the command, turning an observation into a copied string. | medium | P0 mandates re-execution in situ; V1 re-runs it |
| R3 | Step 4 (`implement`) invents a diff to look productive, producing exactly the product change the task forbade. | medium | D2; V3 asserts the diff contains no file outside `.ai/specs/` |
| R4 | P1's commit is deployed reflexively to clear step 8, activating a branch nobody chose to ship. | medium | P2 makes it an explicit operator decision and names declining as preferred |
| R5 | The dirty-tree analysis is stale by the time step 6 runs — another file appears, or the postcondition changes. | low | V2 re-measures `git status --porcelain` at the step rather than trusting this document |
| R6 | Deviating from "do NOT commit" is normalised into "gates outrank task text". | low | P1 requires both deviations be reported in the final message, every time |
| R7 | A step writes to the **main checkout** instead of this worktree, as step 2's first attempt did — invisible to `git add` here, unresolvable for step 7, and permanent dirt in a tree the task protects. | medium | V3's pre-check asserts this spec is present *in this worktree* before P1 commits |

## Verification

Concrete and executable. Run from the worktree root
(`/var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/d843bf5e-9455-42fe-9ada-193512c54110`).

**V1 — the acceptance criterion (re-run, never quoted).**
```bash
hostname -s && uname -a
```
Pass: both print, and the `hostname -s` value appears in the step's own output. Record the value seen
**by that step**. If it is not `prod-host`, that is the interesting result — the probe found a
second node, and it must be reported loudly, not reconciled to this document.

**V2 — the dirty-tree claim, re-measured (do not trust this spec's snapshot).**
```bash
git status --porcelain; echo "files=$(git status --porcelain | grep -c . )"
```
Pass for the analysis: `files` ≥ 1 before P1 (the collision is real). Pass for P1: `files` = 0 after
the commit.

**V3 — P1 committed the scaffolding and nothing else.**
```bash
test -f .ai/specs/2026-08-24-cluster-dispatch-hostname-probe.md || echo "FAIL: spec not in this worktree"
git show --stat --oneline HEAD
git show --name-only --pretty=format: HEAD | grep -v '^$' | grep -v '^\.ai/specs/' && echo "FAIL: non-spec file committed" || echo "OK: docs-only"
```
Pass: the pre-check prints nothing; exactly
`.ai/specs/briefs/2026-08-24-cluster-probe-print-hostname.md` and
`.ai/specs/2026-08-24-cluster-dispatch-hostname-probe.md` are listed — **both paths relative to this
worktree** — and the grep finds nothing. Also assert the local-only rule of D4:
`git rev-parse --abbrev-ref --symbolic-full-name @{u}` must still fail with "no upstream configured".

**V4 — the deploy-gate prediction, before anyone runs step 8.**
```bash
live=$(curl -fsS --max-time 10 http://127.0.0.1:4321/api/v1/ready | grep -o '"deploy":{[^}]*}' | grep -o '"sha":"[0-9a-f]*"' | grep -o '[0-9a-f]\{7,40\}' | head -1)
echo "live=$live head=$(git rev-parse HEAD)"
git merge-base --is-ancestor HEAD "$live"; echo "HEAD-ancestor-of-live exit=$?"
```
This mirrors what the real probe does, including the `'"deploy":{[^}]*}'` narrowing that scopes the
`sha` grep to the deploy block: `/api/v1/ready`, not `/api/v1/health` (the `$comment` records
`/health` as the wrong endpoint for a deploy gate — cached, and blocking past `HEALTH_MAX_STALE_MS`,
which produced the SILENT RED incident), and HEAD against the **live sha**, not against
`origin/main` — the probe source names no remote at all, it compares `$head` to the sha the running
process reported. Those are different relations by construction even while they happen to coincide,
as they do at the time of writing (§The second-order trap). Interpretation: if HEAD is **not** an ancestor of
the live sha, step 8 will read red and P2's decision is required. Do not run step 8 expecting green
without this.

**V5 — the postcondition claims are true of the code as it stands.**
```bash
sed -n '126,160p' packages/cezar/src/workflows/postconditions.ts   # dirty.length > 0 → ok:false
sed -n '254,262p' packages/cezar/src/workflows/postconditions.ts   # workspaceRun carve-out only
grep -n "everything-committed\|all-services-deployed" packages/cezar/src/workflows/types.ts
```
Pass: the `dirty.length > 0 → ok: false` branch is present with no exemption beyond `workspaceRun`
and non-git-tree, and `types.ts` still attaches the three `verify` clauses tabulated in §Problem.
If any of this has changed, **this spec is stale and its P1/P2 reasoning must be re-derived.**

**V6 — no gates to run.** `npm run typecheck` / `test:unit` are not required by this spec, because no
source file changes. Running them is harmless but proves nothing about this work; do not report them
as verification of it. Note the standing red on this box recorded in the cluster spec
(`knowledge/catalog.test.ts` C18, red at pristine HEAD on `prod-host`) before reading any full
suite result as a regression.

## Record

- **This spec's own placement was fixed during step 3's review.** Step 2's first attempt wrote it to
  the **main checkout** (`/var/lib/cezar/loki-labs/cezar/.ai/specs/`, branch `main`), where it sat as
  an untracked file outside this run's worktree — unreachable to `commit-push`, unresolvable for
  `document`, and dirt in a checkout the task protects. It was rewritten into this worktree at
  `.ai/specs/2026-08-24-cluster-dispatch-hostname-probe.md` and the stray main-checkout copy was
  deleted, restoring the "modify, create, or delete no file" contract outside the run's own tree.
- Brief: `.ai/specs/briefs/2026-08-24-cluster-probe-print-hostname.md` (step 1 of this run).
- Cluster spec under probe: `.ai/specs/2026-08-22-multi-node-cezar-cluster.md` — *Partial,
  implemented 2026-08-23, not yet verified*. **This run does not change that status.**
- Commits establishing the dispatch path: `b446be29`, `6e9fd0f2`, `1c2c2d1a`, `96668b03`, `715e3ee8`
  (= this worktree's HEAD).
- KB read for this spec: `specs-846bf82b4c91` (deploy E2E probe must not report PASS on what it
  never observed), `specs-d4f96afa9ac2` (eight tasks at once: bound the burst, then spread across
  nodes), `notion-66eb47464d50` and `notion-4f4bfeb71577` (cluster implemented flag-off, not yet
  verified) — all four cited via the brief, which searched `cez kb search` for "cluster dispatch
  probe", "cluster e2e" and "print hostname stop no file changes probe task" and found **no prior
  spec, brief or todo for a bare dispatch probe**. Nothing on point exists beyond the general
  doctrine above.
- Code re-opened at `715e3ee8` for this document: `packages/cezar/src/workflows/postconditions.ts`,
  `packages/cezar/src/workflows/types.ts` (incl. the `commit-push` prompt and `bashAllowlist`,
  lines 990-1022), `packages/cezar/src/workflows/run.ts` (`runStepVerify`, 6939-6965),
  `.ai/deploy-targets.json`.
- Live state measured 2026-08-24 ~12:50Z: `/api/v1/ready` → `deploy.sha = d01fc102…`,
  `releaseId 20260824T123308Z-d01fc102`, `dirty: true`; `origin/main` = `8f1732a3`; both deployed
  trees present under `/opt/cezar/`.
- `cezar todo list` → empty at step 1. No duplicate or in-flight work.
- **Step 6 (`commit-push`) executed P1, 2026-08-24T13:20Z.** Commit `52612f48` on `cez/d843bf5e`,
  `docs:` only, exactly the two files named in P1 (`git show --name-only` verified — no other file
  entered it). Not pushed; no PR opened; branch carries no upstream, so `everything-committed`
  reads `ok: true` off the local commit alone (`postconditions.ts:163-169`), per D4. Both
  deviations from the task's literal "do NOT commit" are named here, per R6: they were forced by
  `run.ts:5429`'s unconditional run-finalize autosave (§P3), and this labelled commit replaces the
  opaque `cezar autosave (run finalize)` commit that would otherwise have landed instead.
- **Step 7 (`document`), this edit, 2026-08-24.** Recorded P3's doctrine as an `upsert` in
  `$CEZ_KB_WRITE_FILE` (see KB note `2026-08-24-spec-to-deploy-unfit-for-no-write-probes`),
  cross-linked to this spec and to `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`. This Status
  edit itself re-dirties the worktree the same way step 1/2 did — that is expected, not a defect:
  the top-level step-7 instructions call for committing doc/spec edits the same way the change was
  shipped, so this edit is folded into a second local, unpushed `docs:` commit rather than left for
  `run.ts:5429`'s autosave to pick up unlabelled.
- **P2 (the deploy gate) was left undecided by this step, deliberately.** Declining is the
  documented preference (§P2); activating a deploy is an operator call this step does not make
  unattended. If step 8 runs, expect it to read red unless an operator has since deployed this
  branch — that is the predicted outcome, not a bug in step 8.
