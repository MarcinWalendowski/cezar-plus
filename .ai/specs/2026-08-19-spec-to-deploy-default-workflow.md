# Spec-to-deploy: a built-in "full cycle" default workflow

**Status:** implemented 2026-08-19 — deploy decision: **fixed grant** (unrestricted bash,
runs the repo's existing deploy scripts). Amended 2026-08-19: split into six steps, adding
**run tests** and a **commit & push/merge** step (scoped git+gh grant) between implement and
document, per owner request. Amended 2026-08-19 (P2): `spec-to-deploy` is now **the default
workflow** — it replaces `quick-task` as the floor for user-initiated runs (composer/None,
todo ▶ Run, CLI) via a new `DEFAULT_WORKFLOW_NAME` constant. Amended 2026-08-20 (P3): **default
EVERYTHING** — the earlier carve-out that kept the unattended paths (automations, GitHub-triggered
tasks, bookmarklet, unknown-skill prefill) on `quick-task` is REMOVED; they now default to
`spec-to-deploy` too, per owner instruction "default everything to this workflow".

**Amended 2026-08-20 (P4), commit `57fc8807` — a step of this workflow is NO LONGER green just
because its agent exited 0.** As specified here, every step settled `done` whenever the runner
reported no error, which let `commit-push` report done having committed nothing (run `23221162`)
and let `deploy` report done having shipped one of cezar's two services. `commit-push`, `document`
and `deploy` now each carry a `verify` post-condition that must hold after the step's work, and a
failed post-condition re-runs the SAME step with the verdict appended to its prompt before the run
fails. Read `.ai/specs/2026-08-20-steps-green-only-when-verified.md` before reasoning about any
step status described below — the "Solution" and "Architecture" sections here still describe the
pre-P4 unconditional `done`.

**Further amended 2026-08-20 (P5), commit `2e421370` — "must hold after the step's work" above
is unqualified and should read *outside a dry run*.** Under `CEZ_DRY_RUN=1` every post-condition
short-circuits green (`simulated, not verified`): the dry-run agent is a mock that never commits
or deploys, so evaluating its post-conditions for real killed every dry run of this workflow at
`commit-push` and broke `npm run test:package` and `npm run test:e2e` on every branch. A green
dry run of `spec-to-deploy` therefore proves its shape, not that any step's goal was met.

## TLDR

Add a new built-in workflow that codifies the owner's standard operating pipeline as a
single selectable chain, the same way `quick-task`, `note-to-spec` and
`autonomous-implementation` are built in today: **read the record → write the spec →
implement → run tests → commit & push/merge → document → deploy**. It becomes a first-class
option in the composer's workflow pill, alongside the existing built-ins.

## Problem

The owner's working method is a fixed 5-phase pipeline (recorded as the
`standard-workflow-pipeline` memory / CLAUDE.md defaults): read knowledge base + tasks +
previous specs, define a spec, implement, document, deploy. Today this lives only as prose
guidance a session is asked to follow. There is no way to *pick* it for a task the way you
pick `note-to-spec` or `autonomous-implementation`. The pieces already exist as separate
built-ins:

- `note-to-spec` — reads the repo's record and writes a spec, then **stops**.
- `autonomous-implementation` — implements a spec, runs gates, commits locally; **never
  pushes/deploys**.

What's missing is the end-to-end chain that also **documents** (writes the decision back to
the knowledge base / spec status + tracker) and **deploys**.

## Solution

One new `WorkflowDef` (`SPEC_TO_DEPLOY_WORKFLOW`) in
`packages/cezar/src/workflows/types.ts`, registered in
`packages/cezar/src/workflows/load.ts` next to the other built-ins (a repo can override it
by shipping a same-named `.ai/cezar/workflows/*.yaml`). Name: `spec-to-deploy`
(description: "Read the record, write a spec, implement it, document it, then deploy.").

The chain reuses the safety patterns already proven in the existing built-ins. Six agent
steps:

1. **Read the record + write the spec** — mirrors `note-to-spec`'s single step: read the
   KB (`cez kb search`), open tasks, and prior specs, then write ONE spec file. Read-only
   tools plus `cez kb` and `git log/show/status` via `bashAllowlist`. Emits `CEZ:SPEC_PATH`.
   *(Reading is folded into the spec step exactly as `note-to-spec` does — a read-only pass
   that produces no artifact is not worth a separate session; the step is named to show both
   halves.)*
2. **Implement** — reuses `autonomous-implementation`'s exact `bashAllowlist` (installs +
   gate-shaped build/test/lint/typecheck/check/format across npm/pnpm/yarn/make/cargo/go/
   pytest, git add/commit only). **No `git push`, no bare script-runner prefix.** Writes the
   code; the authoritative test run and the commit are separate later steps.
3. **Run tests** — reuses the same allowlist by reference: runs the repo's full gate suite
   (typecheck/lint/tests) and fixes failures until green. Can install and edit code; **no
   push, no commit.** Stops the chain rather than shipping a red build.
4. **Commit & push/merge** — **scoped remote grant (owner decision 2026-08-19).** Commits
   with a spec-referencing message, then ships the way the repo ships (branch push or
   `gh pr create`/`gh pr merge`). `bashAllowlist` is **git + gh only, including `git push`** —
   a real escalation over the "never pushes" built-ins, but still an allowlist, not an
   arbitrary shell. Falls back to local commit + reports if pushing isn't authorized.
5. **Document** — write the durable decision back: KB (`cez kb`), spec Status
   (implemented/partial), tracker/todo sync; corrections marked in place. Read/Edit/Write +
   git add/commit + **`git push`/`gh pr`** (it runs after the ship step, so its record commit
   reaches the remote too) + `cez kb`.
6. **Deploy** — **fixed grant (owner decision 2026-08-19).** Unrestricted `Bash`
   (`DEFAULT_ALLOWED_TOOLS`, no `bashAllowlist`) so it can run the target repo's **existing
   deploy scripts / documented deploy instructions**. The step's prompt tells it to
   discover and run those, not invent commands.

Chaining ≥2 agent steps already gets the `chainStepNote` guard (each step gets the same
`{{task}}` and a shared handoff journal, so later steps read earlier steps' handoff Resume
notes rather than concluding the whole task is done). Nothing new is needed there.

## Architecture

- `types.ts`: export `SPEC_TO_DEPLOY_WORKFLOW: WorkflowDef` with the four agent steps.
  Follows the existing built-ins' shape exactly (`source: 'built-in'`, per-step
  `allowedTools` / `bashAllowlist`, `{{task}}` in each prompt). The implement step reuses
  `AUTONOMOUS_IMPLEMENTATION_WORKFLOW`'s allowlist by reference so the two never drift.
- `load.ts`: add it to the built-in fallback list
  `[QUICK_TASK_WORKFLOW, NOTE_TO_SPEC_WORKFLOW, SPEC_TO_DEPLOY_WORKFLOW]` (filtered by any
  same-named file workflow, same override rule as the others).
- No API/contract change: `workflowDefSchema` already covers it; it flows through
  `loadWorkflows` → composer pill → `startRun` unchanged.

## Data models / API contracts

None new. Reuses `WorkflowDef` / `workflowStepSchema`. The composer's workflow list and
`GET /workflows` pick it up automatically because `loadWorkflows` returns it.

## Phases

- **P1** — add `SPEC_TO_DEPLOY_WORKFLOW` (all six steps), register in `load.ts`, add unit
  coverage in `workflows/types.test.ts` (step order; `implement`/`run-tests` allowlists still
  push-free and shared by reference; `commit-push` CAN push but is git/gh-only; `document`
  git/gh + `cez kb` only; `deploy` unrestricted **by design**) and confirm `load.ts` returns
  it with the file-override rule. **Done.**

- **P2 — make it the default floor.** There was no single source of truth: `'quick-task'` was
  hardcoded at ~6 sites. Add `DEFAULT_WORKFLOW_NAME` / `DEFAULT_WORKFLOW` in `workflows/
  types.ts` = `spec-to-deploy`, and point the **user-initiated** floors at it:
  `server.ts` `resolveRunWorkflow` (POST /runs + workspace, the seam the composer's "None"
  pill resolves through), `workflows/run.ts` `resolveTodoWorkflow` (todo ▶ Run / autostart),
  and the CLI default in `index.ts`. UI truthfulness: the composer "None" subtitle now reads
  "Runs spec-to-deploy", and the `WORKFLOW_DISPLAY_NAMES` `default` label moves from
  `quick-task` → `spec-to-deploy` (`web/src/lib/tasks-table.ts`). Initially left the unattended
  integration fallbacks on `quick-task` (reversed in P3). **Done + deployed 2026-08-20.**

- **P3 — default EVERYTHING (owner instruction 2026-08-20 "default everything to this
  workflow").** Removed the P2 carve-out: the unattended fallbacks now default to `spec-to-deploy`
  too. Backend automations (`automations/task-template.ts`) reads `DEFAULT_WORKFLOW_NAME`; the web
  integration fallbacks hardcode `spec-to-deploy` to match — GitHub (`web/src/lib/github-task.ts`),
  bookmarklet (`web/src/routes/new-task-autostart.ts`), the automations-create default
  (`web/src/routes/automations/automations.tsx`), and the composer unknown-skill prefill
  (`web/src/routes/new-task.tsx`, incl. its toast copy). Reversed the `DEFAULT_WORKFLOW_NAME` doc
  comment's "not wired to unattended paths" note. Tests updated: `github-task.test.ts`,
  `new-task-autostart.test.ts`, `github.test.tsx`, `new-task.test.tsx`. Trade-off accepted: a
  CI/webhook/bookmarklet-triggered run can now inherit `git push` + the unrestricted-Bash deploy
  step; the deploy step still degrades safely (discovers a repo's deploy script, stops if none).
  **Done** (backend + web typecheck green; backend + web pure-fn tests green; component tests are
  sandbox-`React.act`-blocked — QA in CI).

## Risks

- **Two steps reach outside the machine — a deliberate reversal of cezar's "no unattended
  deploy/push" stance, for this opt-in workflow only.** `autonomous-implementation` keeps its
  structural no-push guard unchanged; this workflow trades differently, named honestly in the
  description and each step's doc comment:
  - **`commit-push`** (owner decision 2026-08-19, "commit & push/merge") — SCOPED grant:
    `git` (incl. `git push`, branch/merge) and `gh pr` only. It can push a branch and
    open/merge a PR, but it is an allowlist, not an arbitrary shell.
  - **`deploy`** (owner decision 2026-08-19, "fixed grant") — UNRESTRICTED bash, runs the
    repo's own deploy scripts.
  Both only run because a person picked `spec-to-deploy` for the task.
- Deploy mechanics differ per project; the step relies on each repo having documented deploy
  scripts/instructions to discover. Where a repo has none, the deploy step has nothing safe
  to run and should report that rather than improvise.

## Verification

- `pnpm --filter cezar test` green, including the new workflow tests.
- `GET /workflows` (or the composer) lists `spec-to-deploy`; a repo-shipped same-named YAML
  overrides it (existing load test pattern).
- A real run of the chain on a small task: step 1 writes a spec, step 2 commits after gates,
  step 3 writes the KB/tracker, step 4 runs the repo's deploy script. Recorded per CLAUDE.md
  e2e requirement (QA-needed until executed).
