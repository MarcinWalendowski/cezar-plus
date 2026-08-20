# A step is green only when its goal was verified

**Status: IMPLEMENTED and PUSHED 2026-08-20 — commit `57fc8807` on `origin/main`
(github.com/MarcinWalendowski/cezar), 10 files, +1301/-5. Typecheck exit 0; the three touched
test files 148/148. NOT YET DEPLOYED — deploy is step 6 of this same run — and NOT YET OBSERVED
on a live run: the mechanism is proven by test only, so this is QA NEEDED, not done. Do not
upgrade this line without that observation (todo `aad60921`).**

Written in the `implement` step of run `3bc55a31`, not the `spec` step. The `spec` step of that
same run was killed mid-research (`claude CLI did not exit on its own after close; terminated by
cezar (code 143)`), wrote no file, and its handoff heartbeat still recorded
`step "spec" complete — status=done`. That is this spec's own subject, reproduced by the run that
produced the spec: **a step reported green having achieved nothing.** The reconstruction is
recorded in § Provenance.

## TLDR

Every step of the default `spec-to-deploy` workflow is green whenever its agent session ends
without erroring. Nothing checks that the step's GOAL was met. Three observed consequences, all
from the last two days:

1. **run `23221162`** — `commit-push` reported `status=done` leaving **7 modified and 5 untracked
   files with no commit at all**. The `run-tests` step before it had ended 25 seconds after
   backgrounding `npm test`, never reading the result; both steps logged done. A later step
   reading only the handoff would have concluded the change shipped, because the handoff said so.
2. **run `3bc55a31`** (this one) — `spec` reported done having written no spec file.
3. **deploy** — cezar is two services, the **UI** (`web/dist` swapped into `/opt/cezar`) and the
   **service** (backend `dist` + the restart that actually activates it). Deploying either one
   alone ends the step green. `cezar-prod-deploy-mechanics` records the trap in the owner's own
   words: *"delivery is not activation"* — a half-live deploy where the CLI half is live and the
   server half still runs the old prompts reads exactly like a complete one.

> A step's status must be a claim about the WORLD, not about the agent. `done` means a
> machine-checkable post-condition held after the step ran.
>
> **Corrected 2026-08-20 by `2e421370` — this thesis holds OUTSIDE a dry run only.** Under
> `CEZ_DRY_RUN=1` every post-condition now short-circuits green with a `simulated, not verified`
> verdict, because the dry-run agent is a mock that commits and deploys nothing: evaluating its
> post-conditions for real made `everything-committed` truthfully report a dirty tree and killed
> every dry run at `commit-push`, breaking `npm run test:package` and `npm run test:e2e` on every
> branch. In a dry run, `done` is a claim about the SIMULATION. The unknown-builtin-id check is
> deliberately evaluated first, so a workflow naming a post-condition that does not exist is
> still caught. See the `Fixed` entry for `2e421370` in `CHANGELOG.md`.

## Problem

`workflows/run.ts`'s step loop settles an agent step like this (line ~3444):

```ts
if (failure) { this.finishStep(runId, step.id, 'failed', failure, emit); … }
if (state.budgetExceeded) break;
this.finishStep(runId, step.id, 'done', undefined, emit);
```

`failure` is non-null only when the *runner* reported an error — a crashed CLI, a stop cezar
initiated. An agent that ran, said nothing useful and exited 0 is indistinguishable from one that
did the job. The workflow definition has no way to say what the job WAS.

The machinery to fix this already exists and is used for exactly this shape of question:
`check` steps (`types.ts:13-42`, executed at `run.ts:3449-3479`) are shell commands where exit 0
passes and non-zero can loop back to an earlier step via `onFail`, with the failing output
appended to the retried agent's prompt (`run.ts:3609`). What is missing is the ability to bind
such a check to a step **as its own post-condition**, so the step's own chip goes red rather than
a separate one, and so the failure re-runs the step that caused it.

## Solution

Add `verify` to a workflow step: a post-condition evaluated after the step's work, deciding the
step's status.

```yaml
- id: commit-push
  prompt: …
  verify:
    builtin: everything-committed   # or: command: "some shell command"
    max: 1                          # re-runs of THIS step when the post-condition fails
```

Semantics:

- No `verify` → unchanged behaviour. Every existing workflow keeps its current meaning.
- `verify.command` → a shell command in the step's cwd; exit 0 is the only green.
- `verify.builtin` → a named post-condition evaluated **in-process**, so its verdict is a
  sentence rather than an exit code, and so it is unit-testable against a temp repo instead of
  through a bash string.
- A failed post-condition re-runs the SAME step up to `max` times, with the verdict appended to
  the prompt through the existing `checkFailure` channel — the agent is told what it failed to
  achieve and gets to finish the job. Past `max`, the step is `failed` and the run stops. It never
  silently continues to the next step.

Both branches of the step loop (agent and check) route through one `runStepVerify`, so a check
step can carry a post-condition too and the runner has a single code path to test.

### The two built-ins

**`everything-committed`** — for `commit-push` and `document`:

| Condition | Verdict |
|---|---|
| `git status --porcelain` non-empty | **RED**, listing the files. This is run `23221162`'s exact failure. |
| No commit on `HEAD` | **RED** |
| Upstream configured, `rev-list --count @{u}..HEAD` > 0 | **RED** — "committed but never pushed" |
| No upstream configured | green, saying so: the step's prompt explicitly permits committing locally when no remote is reachable |
| Not a git working tree | green, saying so |
| Workspace run | green, saying so — a workspace run's worktrees apply back UNSTAGED **by design** (`workspace-worktrees.ts`), so it is supposed to commit nothing |

**`all-services-deployed`** — for `deploy`. Reads `.ai/deploy-targets.json` and runs every
declared probe; the step is green only if **ALL** of them exit 0, which is the literal ask.

| File state | Verdict |
|---|---|
| Missing | **RED**, naming the file to create. "Nobody ever declared what this repo deploys" is not evidence of a successful deploy. |
| `{"targets": []}` | green — an explicit "this repo does not deploy", distinct from silence |
| Targets declared | green iff every probe exits 0; the report names each target and its verdict |
| Workspace run | green, saying so — for the same structural reason as the commit built-in: a workspace run commits nothing, so there is no commit to deploy |

Each probe is bounded by a 60s timeout, so a hanging health check fails the deploy instead of
hanging the run.

## Architecture

| File | Change |
|---|---|
| `packages/cezar/src/workflows/postconditions.ts` | **new** — `PostconditionResult`, the two built-ins, the deploy-targets reader, `evaluatePostcondition` |
| `packages/cezar/src/workflows/types.ts` | `verify` on `workflowStepSchema`; `skillStackOf` refuses to compact a step carrying one; `verify` wired into `SPEC_TO_DEPLOY_WORKFLOW` |
| `packages/contract/src/workflows.ts` | mirror `verify` on `workflowStepDefSchema` — the run record persists a workflow def, and `contract-parity.workflows.test.ts` fails the typecheck on drift |
| `packages/cezar/src/workflows/run.ts` | `runStepVerify` + `runShell` (extracted from `runCheckStep`); both step branches gate `done` on it |
| `.ai/deploy-targets.json` | **new** — cezar's own two services |

The verdict is emitted as a `check-output` event, which the cockpit already renders as an execute
card with an exit-code verdict (`web/src/routes/task-thread/thread-state.ts:616`), and stored as
the step's `error` when red — so the existing red step chip and its error surface are reused. **No
web change is required.**

## Data models

```ts
interface PostconditionResult { ok: boolean; detail: string }
interface PostconditionContext { cwd: string; workspaceRun?: boolean }
type PostconditionId = 'everything-committed' | 'all-services-deployed';
```

`.ai/deploy-targets.json`:

```json
{ "targets": [ { "name": "cezar service (backend)", "probe": "…shell…" } ] }
```

## Phases

1. **The mechanism** — `postconditions.ts`, the schema field, the runner gate. Shippable alone:
   with no workflow declaring `verify`, behaviour is identical.
2. **The default workflow's post-conditions** — `commit-push`, `document`, `deploy`.
3. **cezar's own deploy targets** — the UI probe and the service probe.

## Risks

- **R1 — a post-condition that is wrong turns a good run red.** Mitigated by scoping green
  generously where the step's prompt genuinely permits the weaker outcome (no upstream, no repo,
  workspace run) and by `max` re-runs before failing.
- **R2 — the missing-`deploy-targets.json` verdict is RED, so every repo that has not declared its
  targets gets a red deploy step until it does.** Deliberate — it is the ask — and one file per
  repo dismisses it. Dialling it back to green-with-a-note is a one-line change in
  `allServicesDeployed`. Called out as the load-bearing judgement call.
- **R3 — a workspace run.** Its per-project worktrees are applied back to the real checkouts
  **unstaged, after the run ends** (`workspace-worktrees.ts`), and its agents are told not to
  commit. So it commits nothing by design, and therefore deploys nothing either. BOTH built-ins
  special-case it, consistently; getting this wrong would fail every workspace run's `commit-push`
  and its `deploy`. This is the assumption most worth a second opinion: the alternative reading is
  that a workspace run simply has no business running those two steps at all, which is a change to
  the workflow rather than to the post-conditions.
- **R4 — a hanging probe.** Bounded by the 60s per-probe timeout.

## Verification

Automated, in `packages/cezar/src/workflows/postconditions.test.ts` (real git repos in `mkdtemp`,
no mocks):

1. a dirty tree → red, and the verdict NAMES the uncommitted files — **run `23221162`'s exact
   shape: 7 modified + 5 untracked, no commit**;
2. a clean tree with no upstream → green, and says the commits are local only;
3. a clean tree with an upstream that is ahead → red, "not pushed";
4. a clean tree in sync → green;
5. a workspace run → green regardless of a dirty tree;
6. a non-repo directory → green;
7. deploy: missing file → red; `{"targets":[]}` → green; all probes pass → green; **one of two
   probes fails → RED and the verdict names WHICH** (the "UI shipped, service did not" case);
8. a probe that hangs → red on the timeout.

In `packages/cezar/src/workflows/types.test.ts`:

9. `commit-push`, `document` and `deploy` each carry the expected `verify`, so deleting one turns
   the suite red;
10. the schema rejects a `verify` naming both `builtin` and `command`, and rejects neither.

In `packages/cezar/src/workflows/run.test.ts` (check-only workflows — no agent, sub-second):

11. a step whose work succeeds but whose post-condition fails ends **`failed`, not `done`**, and
    the run ends `failed` — the core claim (**outside a dry run only — see 14**);
12. that step is re-run `max` times first, and a post-condition that passes on the retry ends the
    step `done`;
13. a step with no `verify` is untouched.
14. **Added 2026-08-20 by `2e421370`:** under `CEZ_DRY_RUN=1` a post-condition returns green
    without running — including one that would otherwise fail — while an unknown `builtin` id
    still throws. This qualifies claim 11: outside a dry run a failed post-condition ends the
    step `failed`; inside one, nothing is verified at all. +3 tests in `postconditions.test.ts`.

Gates: `npm run typecheck` (root, not `typecheck:web` alone) and `npm test`.

### What actually ran (this session)

- `NODE_ENV=development npm run typecheck` — **exit 0**. (First attempt was red on a real type
  error in the new `types.test.ts`; note that piping the run through `tail` masks npm's exit code,
  which is how that red first read as green.)
- `npm test` — **9099 passed, 29 failed, 1 skipped**. The 29 are **pre-existing, not this
  change, and proven so**: a pristine `git archive HEAD` tree extracted beside this one and run
  through the same full suite fails **the same 29 tests, by name — the set difference against this
  branch's failures is empty**. Baseline 29 failed / 9066 passed; this branch 29 failed / 9099
  passed, the +33 being exactly the tests added here (19 + 9 + 5). They are environmental,
  contaminated by running inside a live cezar session: `agent-profile-wiring` fails because the
  ambient env carries `CEZ_KB_ROOTS` and `CEZ_KB_WRITE_FILE`, the rest are auth Host rebinding,
  projects/org scope, health-forge flags, `home-safety` and a knowledge-catalog CPU budget.
- The new suites specifically: `postconditions.test.ts` 18/18, `types.test.ts` 24/24,
  `run.test.ts -t 'post-condition'` 5/5.
- **Not run:** lint (this repo defines no lint script) and `test:e2e` (needs a live box).

**Not verified until it happens:** a real `spec-to-deploy` run reaching a red `commit-push` or a
red `deploy` in production. Until then the mechanism is proven by test only. Do not upgrade this
line without that observation. Tracked as todo `aad60921` (high), with its three acceptance
criteria — a dirty tree naming its files, a half-deployed pair naming WHICH target failed, and a
failed post-condition re-entering the same step rather than continuing past it.

### What shipped, and where the record went (the `document` step, run `3bc55a31`)

Committed as `57fc8807` "feat: a step is green only when its post-condition holds" and pushed
straight to `origin/main` — this fork ships linear commits to `main`, not PRs, under AGENTS.md
§"Shipping cezar itself". `origin/main` had moved to `93e450c7` meanwhile and conflicted in two
files; **both were keep-BOTH unions, resolved and re-verified, nothing dropped**:

- `workflows/types.ts` — upstream had added `Task` to the `document` step's `allowedTools`; kept
  that AND this change's `verify: { builtin: 'everything-committed', max: 1 }`.
- `workflows/types.test.ts` — import union of upstream's `DEFAULT_ALLOWED_TOOLS` /
  `RECORD_READ_RECIPE` with this change's `skillStackOf` / `workflowStepSchema`.

The decision was written back to, in the same session as the code:

| Where | What |
|---|---|
| `CHANGELOG.md`, Unreleased → ✨ Added | the entry for this change |
| `AGENTS.md` § "Shipping cezar itself" | the "gate on a real readiness probe" rule was PROSE this now enforces — marked in place as implemented, naming the built-in and `.ai/deploy-targets.json` |
| `.ai/specs/2026-08-19-spec-to-deploy-default-workflow.md` | amended (P4) — its steps are no longer green on agent exit alone |
| knowledge base | proposal appended to `CEZ_KB_WRITE_FILE` (workspace scope), pending review via `cez kb proposals` |
| tracker | todo `aad60921` — the in-the-wild observation tests cannot supply; todo `4b455418` — the owner's call on R2 and R3 |
| memory `commit-step-must-commit-everything` | the owner instruction it records is now MECHANICALLY enforced, not advice — marked in place |

**Open after this step, deliberately:** the deploy (step 6), and the live-run observation. Both
built-ins report not-applicable-green on a workspace run *by design* (R3), and this WAS a
workspace run — so this run cannot be its own evidence. The first real proof is a repo-scoped
`spec-to-deploy` run after the deploy lands.

## Provenance

Read for this spec: `.ai/specs/2026-08-19-spec-to-deploy-default-workflow.md`;
`.ai/specs/2026-08-20-agent-step-stopped-is-not-failed.md` (the precedent for "a status is a
claim about what happened, and collapsing two causes makes the record unable to answer which");
`AGENTS.md:11` ("the deploy step must gate on a real readiness probe"), which this implements
rather than invents; the memory entries `commit-step-must-commit-everything` (run `23221162`, the
owner's "everything must be committed in the commit step") and `cezar-prod-deploy-mechanics`
(delivery vs activation, the two halves of a cezar deploy); and the run transcript of `3bc55a31`
itself for the `spec`-step kill.
