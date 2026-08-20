# Split the pipeline's front half, add a spec review step, and gate it on human approval

**Status:** draft 2026-08-20. Extends `.ai/specs/2026-08-19-spec-to-deploy-default-workflow.md`
(implemented; last amended 2026-08-20 P3, commit `097d1b15`). Answers the owner's question
"is every step run on a separate subagent?" — **it already is**, verified in source below —
and specifies the three changes actually asked for: **split gathering the record from writing
the spec**, add a **review spec** step, and put a **user approval gate** behind it with a
setting whose default is *auto-approved*.

## TLDR

`spec-to-deploy` today is six agent steps, each already its own isolated agent session. Its
first step does two jobs at once (read the whole record, then write the spec) and nothing ever
reviews the spec before six remote-reaching steps act on it. This spec:

1. **records the verified answer** to the subagent question and changes nothing there;
2. **splits step 1** into `context` (read the record, write a brief) and `spec` (write the spec
   from that brief) — 6 agent steps become 8;
3. adds **`review-spec`**, a read-only reviewer that ends with a `CEZ:REVIEW=pass|revise`
   verdict; `revise` loops the chain back to `spec` with the notes, bounded;
4. adds a **human approval gate** on that step — `requiresApproval`, released by
   `POST /runs/:id/approve`, configured by `approvals.minApprovers`, **default `0` = auto-approved**,
   so the zero-config path is byte-for-byte unchanged.

## Problem

### 1. "Is every step run on a separate subagent?" — yes, and this needs recording, not fixing

Verified in source, not inferred (`packages/cezar/src/workflows/run.ts`):

- the step loop (`execute()`, `run.ts:3003-3054`) walks `workflow.steps` one at a time and calls
  `runAgentStep` per agent step;
- `runAgentStep` mints a **fresh session id per step** — `const sessionId = randomUUID()`
  (`run.ts` ~3330, persisted via `this.store.updateStep(runId, step.id, { sessionId, backend })`)
  — and calls `runner.startSession(...)` (`run.ts:3385`) with that step's **own** `systemPrompt`,
  `userPrompt`, `allowedTools`, `bashAllowlist`, `model` and `env`;
- non-final steps run with `autoEndAfterFirstTurn: true` (`run.ts:3427`), so the session is
  closed at the end of its turn; only the last agent step of the workflow is `interactive`
  (`run.ts:3027`).

So each step is a **separate agent process with a separate context window**, not a sub-agent
inside one long session, and not a resumed session. The only things shared across steps are the
`{{task}}` text, the run-level handoff file, and the working tree. `chainStepNote`
(`workflows/types.ts:130-165`) exists precisely because that isolation is real — a later step's
fresh session would otherwise read an earlier step's "done" and stop.

The one honest caveat: these are separate *top-level agent sessions*, not Claude `Task`-tool
subagents. If the owner's question meant "does each step get its own clean context", the answer
is yes today. **No change is proposed for this. It is recorded here so the next session does not
re-investigate it.**

### 2. One step does two different jobs

The `spec` step's prompt (`types.ts:425-455`) asks one session to (a) search the KB, the tracker,
the spec directory and `git log`, and (b) write the spec. Two problems:

- **Context competition.** The reading half is the expensive half — `cez kb search` on this
  workspace returns 132–778 hits for an ordinary query (measured this session on
  "spec-to-deploy workflow approval" and "workflow step approval gate"). The spec is then written
  from whatever survived in the same window.
- **No reusable artifact.** What was read is lost the moment the session closes; only the spec's
  citations survive. This repo already has the artifact shape for it —
  `.ai/specs/briefs/2026-08-07-issue-linked-pr-chip.md` is the one existing brief, and it is
  exactly "problem + agreed direction + rejected alternatives" written *before* a spec.

### 3. Nothing reviews the spec, and the steps after it are the dangerous ones

After `spec`, the chain implements, tests, **pushes to a remote** (`commit-push`, scoped git+gh
grant incl. `git push`) and **runs the repo's deploy scripts under unrestricted Bash** (`deploy`).
Per the 2026-08-20 P3 amendment, `spec-to-deploy` is now the default for *everything*, including
GitHub-triggered and bookmarklet-triggered runs. A spec that misread the task therefore reaches
production with no checkpoint between "one agent wrote a plan" and "the plan is deployed".

There is a terminal review gate (`config.reviewGate` / `CEZ_REVIEW_GATE`, #489,
`packages/web/src/routes/task-thread/review-panel.tsx`), but it fires **after the run finishes** —
after the deploy step. It is the wrong end of the pipeline for this.

### 4. There is no in-run approval mechanism at all

Searched: `approve`/`approval` in `packages/cezar/src` returns only note approval
(`notes-routes.ts:239`) and report triage (`workspace-reports-routes.ts:463`) — both operate on
*inbox rows*, not on a live run. `runStatusSchema` has `waiting` and `review`
(`packages/contract/src/runs.ts:29-38`); neither carries "N humans must say yes before step k+1".
No KB entry covers an in-run approval gate (`cez kb search "workflow step approval gate"` →
nothing on point). This is new mechanism.

## Solution

### 4a. The new chain (8 agent steps)

| # | id | what changes |
|---|----|--------------|
| 1 | `context` | **new** — read the record (KB, tracker, specs, git log), write ONE brief to `.ai/specs/briefs/`. Never writes a spec. |
| 2 | `spec` | **narrowed** — writes the spec *from the brief*; no longer does the gathering. |
| 3 | `review-spec` | **new** — read-only adversarial review of the spec. Ends `CEZ:REVIEW=pass` or `CEZ:REVIEW=revise`. `requiresApproval: true`. |
| 4 | `implement` | unchanged |
| 5 | `run-tests` | unchanged |
| 6 | `commit-push` | unchanged |
| 7 | `document` | unchanged |
| 8 | `deploy` | unchanged |

### 4b. Two independent gates, deliberately

- **The agent gate (`CEZ:REVIEW`)** works at the *shipped default*. `revise` loops the chain back
  to `spec`, bounded by `onFail.max` (2), with the reviewer's notes appended to the retried
  prompt. This is the answer to AGENTS.md § "A replacement that ships OFF is not a replacement":
  with `minApprovers` at its default `0`, the review step must still do real work, or the change
  is a knob and not a mechanism.
- **The human gate (`requiresApproval` + `approvals.minApprovers`)** is the owner's asked-for
  setting: **`0` = auto-approved (default)**, `≥1` = the run parks until that many approvals
  arrive. At `0` the engine takes the same code path it takes today.

### 4c. Why the gate is a step ATTRIBUTE, not a new step kind

`stepStateSchema.kind` is `z.enum(['agent','check'])` on the **published** contract
(`packages/contract/src/runs.ts:65`), and this repo's stated rule for published unions is not to
widen them — see `stopReason`'s doc comment (`runs.ts:225-232`): *"`RunStatus` is deliberately NOT
widened for this — it is a published union and cezar is a released npm package, so adding a member
would break a consumer switching over it exhaustively."* The same argument applies to `kind`.

So the approval is an **optional boolean on an agent step** plus an **optional object on the run
record**. Every added field is additive and optional; no enum gains a member; an older build
round-trips the new fields untouched. The rail already renders a `waiting` step as active
(`step-rail.tsx:railVisual`), so a parked step reads correctly with no UI change required for
correctness (P4 makes it *legible*, which is different).

### 4d. Why the loop-back reuses `onFail`

`stepsIssue` (`types.ts:171-185`) already validates that `onFail.retry` names an **earlier** step,
and `execute()` already implements the loop-back — reset the intervening steps to `pending`, set
`i = retryIdx`, and append the failure text to the retried agent's prompt via `checkFailure`
(`run.ts:3188-3190`). That machinery is currently reachable only from the check branch. The change
is to factor it into one helper called from both branches — not to invent a second loop.

## Architecture

```
packages/contract/src/runs.ts          + pendingApprovalSchema (optional on runRecordSchema
                                         and the API run shape). No enum widened.
packages/cezar/src/workflows/types.ts  + requiresApproval on workflowStepSchema
                                       + CONTEXT/REVIEW steps in SPEC_TO_DEPLOY_WORKFLOW
                                       + REVIEW_MARKER_RE and parseReviewVerdict()
packages/cezar/src/workflows/run.ts    + loopBackTo() helper (shared by check + review)
                                       + awaitApproval() park (models acquireRepoRoot,
                                         run.ts:1781-1815) + release on approve
                                       + recover() re-park for a run with pendingApproval
packages/cezar/src/runs/store.ts       + pendingApproval persistence
packages/cezar/src/config.ts           + approvals.minApprovers (default 0)
packages/cezar/src/server/server.ts    + POST /runs/:id/approve
                                       + POST /runs/:id/request-changes
packages/web/src/routes/task-thread/   + approval-card.tsx (Approve / Request changes)
packages/web/src/routes/settings/      + "Minimum spec approvals" next to the review-gate toggle
.env.example                           + CEZ_MIN_APPROVERS (AGENTS.md:27 makes this mandatory
                                         in the same commit)
```

### Transitions out of the parked state (AGENTS.md § "Enumerate the transitions out of every state")

A run parked on an approval has exactly these exits. Anything not on this list is a dead end and
the phase is not done:

1. `POST /runs/:id/approve` reaching `minApprovers` → gate released, chain proceeds to `implement`.
2. `POST /runs/:id/request-changes` → loop back to `spec` with notes (bounded by `onFail.max`;
   exhausting it fails the run with a clear error rather than looping forever).
3. `POST /runs/:id/cancel` → existing path; `state.cancelled` aborts the park exactly as it aborts
   `acquireRepoRoot` (`run.ts:1796-1810`).
4. `approvals.timeoutHours > 0` elapsing → the gate auto-approves **only if configured to**;
   default `0` = wait indefinitely.
5. Process restart → `recover()` re-parks the run (does **not** resume it into `implement`). This
   is not hypothetical: the cezar process restarted twice while this very spec was being written,
   which is exactly why the pending state is persisted on the record rather than held in
   `ActiveRun` memory.

Note what a parked run holds: `waiting` gives its `maxParallel` slot back (the #347 rule,
`run.ts:974-1001`), but the repo-root lease is held for a run's whole lifetime *by design*
(`acquireRepoRoot` doc comment) — so an in-place parked run blocks other in-place runs on that
repo for as long as it waits. That is the same exposure an unanswered interactive step already
has, but the window is longer. See Risks.

## Data models / API contracts

**`workflowStepSchema`** (`packages/cezar/src/workflows/types.ts`) — additive:

```ts
/** Agent steps only: park the run after this step's turn until `approvals.minApprovers`
 *  approvals arrive. Ignored (no park) when minApprovers is 0 — the default. */
requiresApproval: z.boolean().optional(),
```
plus a `.refine` rejecting `requiresApproval` on a check step.

**`pendingApprovalSchema`** (`packages/contract/src/runs.ts`) — new, optional on `runRecordSchema`
and the API run shape:

```ts
export const pendingApprovalSchema = z.object({
  stepId: z.string(),
  requestedAt: z.string(),
  /** Snapshot of the config AT PARK TIME — lowering the setting later must not
   *  retroactively release a run that is already waiting. */
  minApprovers: z.number().int().min(1),
  approvals: z.array(z.object({
    by: z.string(),
    at: z.string(),
    note: z.string().max(2000).optional(),
  })),
  /** Echo of `declaredSpecPath` so the approval card can link the artifact under review. */
  specPath: z.string().max(500).optional(),
  /** Deadline when `approvals.timeoutHours > 0`; absent = wait indefinitely. */
  expiresAt: z.string().optional(),
});
```

**Config** (`packages/cezar/src/config.ts`, `.ai/cezar/config.json`) — additive, `.catch`-guarded
like its neighbours:

```jsonc
"approvals": {
  "minApprovers": 0,   // 0 = AUTO-APPROVED (default, owner's ask). >=1 parks the run.
  "timeoutHours": 0,   // 0 = wait indefinitely
  "maxRevisions": 2    // rejections that may loop back before the run fails
}
```
Absent key → `CEZ_MIN_APPROVERS` decides → default `0`. This mirrors `reviewGate`'s
absent-key/env/default-OFF pattern exactly (`config.ts:105-110`), including that Settings edits the
**repo** config file (`packages/web/src/routes/settings/agents-section.tsx:281-292` is the model).

**Routes** (additive, under the existing versioned `/api/v1` surface):

```
POST /runs/:id/approve            { note?: string }  -> 200 { run }  | 409 if not parked
POST /runs/:id/request-changes    { notes: string }  -> 200 { run }  | 409 if not parked
```
`by` is resolved from the same identity the report-triage approvals use
(`workspace-reports-routes.ts` records `by` on approve/dismiss). On a single-user local install
there is effectively one identity — see Risks.

**Marker:** `CEZ:REVIEW=pass` / `CEZ:REVIEW=revise` parsed on assembled turn text, exactly where
`CEZ:DONE` / `CEZ:MONITORING` / `CEZ:ASK` are parsed (`run.ts:3254-3261`). Deliberately **no**
`CEZ:BRIEF_PATH` marker: `CEZ:SPEC_PATH` exists because the note pipeline parses it
programmatically (`declaredSpecPath`); nothing consumes a brief path but the next step's agent,
which reads the shared handoff.

## Phases

Each phase is independently shippable and leaves the default path working.

### P1 — split `context` from `spec` (types only)
Add the `context` step; narrow the `spec` prompt to "write the spec from the brief". Record the
verified subagent finding in `SPEC_TO_DEPLOY_WORKFLOW`'s doc comment. `context` tools:
`['Read','Grep','Glob','Write','Bash']`, `bashAllowlist: ['git log','git show','git status','git diff','cez kb','cezar todo list']`
— read-only except the brief it writes. Tests in `workflows/types.test.ts`.
*No engine change. No contract change.*

### P2 — `review-spec` + the agent verdict loop
Add the step (read-only: `['Read','Grep','Glob','Bash']`, read-only git + `cez kb`, **no Write, no
Edit** — a reviewer must not edit what it reviews), `onFail: { retry: 'spec', max: 2 }`, the
`CEZ:REVIEW` parser, and the factored `loopBackTo()` helper in `run.ts`.
*Works at the shipped default with no config at all.*

### P3 — the human approval gate
`requiresApproval` on the step schema; `pendingApproval` on the record + store; `awaitApproval()`
park + release; `recover()` re-park; the two routes; `config.approvals` + `CEZ_MIN_APPROVERS` +
`.env.example`. **Ships with `minApprovers: 0`, so the default path never parks.**

### P4 — cockpit
Approval card in the task thread (Approve / Request changes + notes, modeled on
`review-panel.tsx`'s actions), the Settings control, and the attention/rail labelling so a parked
run reads as "waiting for your approval" rather than a generic `waiting`.

## Risks

- **Cost: the default workflow grows 6 → 8 agent sessions, for every task in the workspace.**
  Since the 2026-08-20 P3 amendment `spec-to-deploy` is the floor for *everything*, including
  unattended paths. That is roughly +33% agent sessions per task, and the `context` step's KB
  sweep is not cheap. Mitigation: `context` is read-only and told to produce a bounded brief, and
  `review-spec` is read-only and short. **This is a real, accepted cost, not one to explain away —
  if it lands badly the honest fix is a smaller default workflow, not a quieter `context` step.**
- **A parked run holds the repo-root lease.** With `minApprovers ≥ 1`, an in-place run waiting for
  a human blocks every other in-place run on that repo until someone answers. Worktree runs are
  unaffected. `timeoutHours` exists for this; its default (`0` = wait forever) means the exposure
  is real whenever someone opts in. Named, not designed away.
- **"N distinct approvers" is not enforceable without real identities.** A single-user local
  install has one `by` value, so `minApprovers: 2` degrades to "the same person clicked twice".
  P3 should either reject `minApprovers > 1` when no multi-user identity exists, or document that
  it counts clicks, not people. **Do not ship it silently counting clicks while the setting says
  "approvers".**
- **A gate that defaults to auto-approve is a gate nobody uses.** Accepted deliberately: the owner
  asked for auto-approved by default, and AGENTS.md forbids trading a working default for a knob.
  The `CEZ:REVIEW` verdict loop (P2) is what carries the safety value at the default — if P2 is
  cut, this spec ships a knob.
- **The reviewer can loop the chain.** `onFail.max: 2` bounds it, and `stepsIssue` guarantees the
  retry target is earlier. Without both, a stubborn reviewer and a stubborn writer burn a step
  budget arguing.
- **Contract additivity.** Every new field is optional; no published enum gains a member. The guard
  is `packages/cezar/src/server/contract-parity.workflows.test.ts`, which exists to keep
  `workflowDefSchema` and the contract from drifting.

## Verification

This repo is **npm workspaces + vitest**, not pnpm (`package.json` root `workspaces`) — the
earlier spec's `pnpm --filter cezar test` line is wrong for this repo and is not repeated here.

Automated, per phase:

- P1: `npx vitest run packages/cezar/src/workflows/types.test.ts` — assert the 8 step ids in order;
  `context`'s allowlist contains no `git push` and no bare script-runner prefix; `spec`'s prompt no
  longer instructs the KB sweep.
- P2: `npx vitest run packages/cezar/src/workflows/types.test.ts packages/cezar/src/workflows/run.test.ts`
  — `review-spec` has neither `Write` nor `Edit` in `allowedTools`; `parseReviewVerdict` accepts
  `pass`/`revise` and ignores the marker inside a code fence; a `revise` verdict resets `spec`,
  `review-spec` to `pending`, re-enters at `spec`, and the reviewer's notes appear in the retried
  prompt; a third `revise` fails the run instead of looping.
- P3: `npx vitest run packages/cezar/src/workflows/run.test.ts packages/cezar/src/config.test.ts`
  — **regression guard first**: with `minApprovers: 0` the run never parks and the step sequence is
  identical to today's; with `minApprovers: 1` the run goes `waiting` with `pendingApproval` set and
  `implement` does **not** start; `POST approve` releases it; `POST request-changes` loops back;
  `POST approve` on a non-parked run is 409; a store round-trip preserves `pendingApproval`; a
  simulated restart (`recover()`) re-parks rather than resuming.
- Contract: `npm run typecheck` (runs contract → client → server → web) and
  `npx vitest run packages/cezar/src/server/contract-parity.workflows.test.ts`.
- Full gates: `npm run typecheck && npm run lint && npm test`.

Runtime / e2e (this is what makes it *done* rather than *QA needed*, per CLAUDE.md):

- `packages/web/e2e/spec-approval.e2e.ts`, new, modeled on `packages/web/e2e/review-gate.e2e.ts`
  (which boots the fixture server with `CEZ_REVIEW_GATE: '1'`): boot with `CEZ_MIN_APPROVERS: '1'`,
  start a run, assert it parks with the approval card visible, click Approve, assert the chain
  proceeds. Run via `npm run test:e2e` (`.ai/scripts/e2e.sh`), recordings kept.
- One real run of the full 8-step chain on a small cezar task with `minApprovers: 1`: confirm
  `context` writes a brief under `.ai/specs/briefs/`, `spec` cites it, `review-spec` emits a
  verdict, the run parks, an approval from the cockpit releases it, and the remaining five steps
  run. **Until that run has actually happened this is "QA needed", not done.**

Known gaps, stated rather than invented:

- Component tests in this sandbox fail on `React.act` for environmental reasons, so P4's card is
  verified by the e2e above and by hand, not by a component test run here.
- No KB entry or open todo covers in-run approvals (`cez kb search "workflow step approval gate"`,
  `cezar todo list` → "no todos filed"), so nothing prior is being superseded; the `document` step
  of this run should create that KB entry.
