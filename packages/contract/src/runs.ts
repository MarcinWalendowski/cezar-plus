import { z } from 'zod';
import { runnerSchema } from './health.ts';
import { referenceStatusSchema } from './github.ts';
import { taskAuthorSchema } from './task-author.ts';
// The chain shapes belong to the workflows family; the run record embeds one, so this file
// consumes them rather than redeclaring. One-way on purpose — see the header of `./workflows.ts`.
import { workflowDefSchema, workflowStepDefSchema } from './workflows.ts';

/**
 * The RUNS family of `/api/v1` — a task's record, its lifecycle mutations, and the artifacts
 * (queued prompt stack, commits, git actions) that hang off one run.
 *
 * The record itself is persisted by `src/runs/store.ts`, so these schemas describe a shape that
 * already has a zod definition server-side; they are the WIRE half of it, and the parity guard in
 * `src/server/contract-parity.runs.test.ts` is what keeps the two from drifting.
 *
 * Two things about the mutation responses are deliberate and were measured, not assumed:
 *
 *  - every "did it work" flag is a `z.literal(true)`, not a boolean. Each of those routes answers
 *    409 (or 404) on refusal, so `false` is not a value the 200 branch can carry — the
 *    hand-written DTO's `boolean` invited a re-check the server never needs. `cancelled` is the
 *    one real boolean: `POST /runs/:id/cancel` answers 200 either way.
 *  - `POST /runs/:id/messages` answers a three-way UNION, not one object with three optional
 *    keys. The client narrows on which key is present, and the DTO's flattened shape allowed
 *    `{}` — a payload the route cannot produce.
 */

// ---- the record --------------------------------------------------------------------------

export const runStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'review',
  'done',
  'failed',
  'cancelled',
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

/**
 * Sub-state of `running` (spec 2026-07-18-subagent-monitoring-status, #490): the agent ended its
 * turn still working on its own downstream work (a sub-agent, a monitored command) and said so
 * with the `CEZ:MONITORING` marker — a non-attention state, not "needs you".
 */
export const runActivitySchema = z.enum(['monitoring']);
export type RunActivity = z.infer<typeof runActivitySchema>;

export const stepStatusSchema = z.enum([
  'pending',
  'running',
  'waiting',
  'review',
  'done',
  'failed',
  'cancelled',
  'skipped',
]);
export type StepStatus = z.infer<typeof stepStatusSchema>;

const usageCounterSchema = z.number().finite().nonnegative();

/** One step of a run's chain. */
export const stepStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['agent', 'check']),
  status: stepStatusSchema,
  iterations: z.number(),
  tokensUsed: z.number(),
  inputTokens: usageCounterSchema.optional(),
  outputTokens: usageCounterSchema.optional(),
  /** Current context-window occupancy: the MOST RECENT turn's prompt size
   *  (`input + cacheRead + cacheWrite`), OVERWRITTEN each turn rather than summed like
   *  `inputTokens` — it tracks "how full is the window now", not the running total (spec
   *  2026-08-19-context-usage-in-tasks-table). Absent until the first turn ends. */
  contextTokens: usageCounterSchema.optional(),
  /** This step's own context-window max (spec 2026-08-22-context-window-denominator-per-step):
   *  a real backend-reported figure when one exists (codex today), else the model-string
   *  guess, else absent the moment this step's own `contextTokens` disproves that guess.
   *  Paired 1:1 with `contextTokens` above — never recomputed from a different step's model. */
  contextWindow: usageCounterSchema.optional(),
  usageInvocationsStarted: usageCounterSchema.optional(),
  usageInvocationsObserved: usageCounterSchema.optional(),
  usageTurnsStarted: usageCounterSchema.optional(),
  usageTurnsRecorded: usageCounterSchema.optional(),
  usageInvocationEpoch: usageCounterSchema.optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
  /** Latest agent session id — `claude --resume <id>` and friends. */
  sessionId: z.string().optional(),
  /** Backend that owns `sessionId`; absent on records written before backend affinity. */
  backend: runnerSchema.optional(),
  /** Free-text model this step's latest attempt actually asked for — the per-step twin of
   *  `RunRecord.model`. Absent when the agent-model lock voided it, when nothing was asked, and on
   *  every step recorded before spec 2026-08-22-per-step-model-display. */
  model: z.string().optional(),
  /** Canonical `provider/model` this step's latest attempt resolved to — the per-step twin of
   *  `RunRecord.modelIdentity`, which holds only the LAST step's. This is what the step rail
   *  renders per row, so a multi-model workflow reads honestly instead of showing one model for
   *  every step. */
  modelIdentity: z.string().optional(),
  /** Agent account (spec 2026-07-29-agent-profiles) that owns `sessionId` — `default`, or a
   *  stored profile id. The two are a PAIR: a session id only resolves inside the config dir
   *  that created it, so resume and Continue read this rather than the project's current
   *  selection. Absent on records written before accounts existed. */
  profileId: z.string().optional(),
  costUsd: z.number().optional(),
  /** Why CEZAR stopped this step, when it did: today only `'inactivity'` — the agent produced no
   *  output for the runner's bound. `status` stays `failed` (`StepStatus` is a published union),
   *  so this is the only thing that says nothing actually errored, and it is what the step rail
   *  renders "stopped" rather than a red X from. Absent on every genuine failure. */
  stopReason: z.enum(['inactivity']).optional(),
});
export type StepState = z.infer<typeof stepStateSchema>;

/** Aggregate diff numbers of a run's worktree vs its base (#389). */
export const diffStatSchema = z.object({
  adds: z.number(),
  dels: z.number(),
  files: z.number(),
  /** Additive since #751, and present ONLY when true: the numbers were measured against a
   *  branch the agent checked out into the task's worktree, as the run found it, because the
   *  worktree's HEAD had been repointed off the task's own branch (every review/QA run does
   *  this) and the merge-base anchor would otherwise have reported that branch's entire diff
   *  as this task's. Absent on every normal run and on every record written before #751 — a
   *  consumer that ignores it sees exactly the old shape. */
  repointed: z.boolean().optional(),
});
export type DiffStat = z.infer<typeof diffStatSchema>;

/** One prompt message stacked onto a run while it waits for a free agent slot (#472). */
export const queuedMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  /** `/api/v1/runs/:id/images/…` URLs — attachments are persisted, never inlined. */
  images: z.array(z.string()).optional(),
  createdAt: z.string(),
});
export type QueuedMessage = z.infer<typeof queuedMessageSchema>;

/** One aggregated sample of a run's live process tree (`src/core/process-usage.ts`). */
export const processUsageSchema = z.object({
  /** Sum of `%cpu` across the tree — can exceed 100 on multi-core work. */
  cpuPct: z.number(),
  rssBytes: z.number(),
  procCount: z.number(),
});
export type ProcessUsage = z.infer<typeof processUsageSchema>;

/**
 * One registered project inside a workspace run's grant
 * (`.ai/specs/2026-08-15-cross-project-workspace-run.md`).
 *
 * Deliberately NOT `workspaceProjectHealthSchema` (`./workspace-runs.ts`), which is the shape of a
 * BOARD row: it carries `ok`/`reason`/`total` (derived at read time from a `runs.json` parse) and
 * carries no `root` at all. This is the opposite — the root is the whole point, and nothing here
 * is derived at read time, because the grant must mean the same thing on a resume six hours later.
 */
export const workspaceGrantProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Absolute path. What `--add-dir` receives (after containment dedupe) and what the run's
   *  system prompt states verbatim — the portable half, for runners that ignore `--add-dir`. */
  root: z.string(),
  /** As probed at creation. `missing` grants no directory but is still rendered, so a moved
   *  checkout reads as unavailable rather than as never having been registered. */
  status: z.enum(['ok', 'missing', 'not-git', 'no-commits']),
});
export type WorkspaceGrantProject = z.infer<typeof workspaceGrantProjectSchema>;

/** One granted project's isolated worktree on a parallel workspace run
 *  (`.ai/specs/2026-08-19-parallel-workspace-runs-worktrees.md`). */
export const workspaceWorktreeSchema = z.object({
  /** The real project root the worktree mirrors and is applied back into. */
  root: z.string(),
  worktreePath: z.string(),
  /** `cez/<id8>` — same name across repos, distinct repos. */
  branch: z.string(),
  /** Fork ref / starting commit, the apply-back diff base. */
  baseBranch: z.string(),
  /** Set when count-based retention removed this worktree's DIRECTORY; the `cez/<id8>` branch
   *  survives, so the work stays recoverable (spec 2026-08-20-workspace-run-worktree-isolation,
   *  X4). Its absence on a path that no longer exists is what a LEAKED worktree looks like. */
  reclaimedAt: z.string().optional(),
});
export type WorkspaceWorktree = z.infer<typeof workspaceWorktreeSchema>;

/** One todo filed by a workspace-scoped input-to-tasks run. */
export const filedTodoSchema = z.object({
  project: z.string(),
  todoId: z.string(),
  summary: z.string().max(500),
  autostart: z.literal(true).optional(),
  startedTaskId: z.string().optional(),
});
export type FiledTodo = z.infer<typeof filedTodoSchema>;

/** The append-only ledger captured from the registered projects' todo files. */
export const filedTodosSchema = z.object({
  items: z.array(filedTodoSchema),
  at: z.string(),
});
export type FiledTodos = z.infer<typeof filedTodosSchema>;

/**
 * The stored run record, as `runs.json` holds it (`src/runs/store.ts`).
 *
 * `archived` is required although the store schema defaults it: a default fills on PARSE, so the
 * key is always present in what the server hands out. Everything else optional here is optional
 * there — these are additive fields, and an absent one means "this run predates it".
 */
/**
 * A run parked on a HUMAN APPROVAL GATE
 * (`.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md`, P3).
 *
 * Persisted on the record, not held in `ActiveRun` memory, for a reason this project learned the
 * hard way: run `be31d9e9` was interrupted by two cezar restarts mid-step, and an approval held
 * only in process memory would have evaporated with them — silently un-gating the very step the
 * gate exists to hold. `recover()` reads this back and re-parks.
 *
 * Additive and optional: no published enum gains a member (see `stopReason`'s doc comment on why
 * `RunStatus` is never widened), so an older build round-trips this untouched. A parked run's
 * `status` is the existing `waiting` — "the ball is in your court" already means exactly that.
 */
export const pendingApprovalSchema = z.object({
  /** The gated step. The run is parked BEFORE the chain advances past it. */
  stepId: z.string(),
  requestedAt: z.string(),
  /**
   * Snapshot of `approvals.minApprovers` AT PARK TIME. Deliberately not re-read on each approval:
   * lowering the setting later must not retroactively release a run that is already waiting, and
   * raising it must not move the goalposts under the people who already approved.
   */
  minApprovers: z.number().int().min(1),
  approvals: z.array(
    z.object({
      by: z.string(),
      at: z.string(),
      note: z.string().max(2000).optional(),
    }),
  ),
  /** Echo of `declaredSpecPath`, so the approval card can link the artifact under review. */
  specPath: z.string().max(500).optional(),
  /** Deadline when `approvals.timeoutHours > 0`; absent = wait indefinitely. */
  expiresAt: z.string().optional(),
});
export type PendingApproval = z.infer<typeof pendingApprovalSchema>;

/** A run paused until a person lands a protected change or deploys a manual target. */
export const pendingHandoffSchema = z.object({
  kind: z.enum(['manual-deploy', 'manual-merge']),
  stepId: z.string(),
  requestedAt: z.string(),
  reason: z.string().max(2_000),
  targets: z.array(z.string()).max(50).optional(),
  prUrl: z.string().url().max(500).optional(),
  sha: z.string().max(64).optional(),
  baseBranch: z.string().max(300).optional(),
});
export type PendingHandoff = z.infer<typeof pendingHandoffSchema>;

/** The tree produced by the final green test gate and the commit that shipped it. */
export const testAttestationProjectSchema = z.object({
  root: z.string().min(1),
  worktreePath: z.string().min(1),
  treeSha: z.string().length(40),
  headSha: z.string().length(40).optional(),
  shippedSha: z.string().length(40).optional(),
});
export type TestAttestationProject = z.infer<typeof testAttestationProjectSchema>;

export const testAttestationSchema = z.object({
  stepId: z.string(),
  treeSha: z.string().length(40),
  headSha: z.string().length(40).optional(),
  shippedSha: z.string().length(40).optional(),
  /** Per-project truth for a workspace run. Top-level fields keep older run records valid. */
  projects: z.array(testAttestationProjectSchema).min(1).optional(),
  at: z.string(),
});
export type TestAttestation = z.infer<typeof testAttestationSchema>;

export const runRecordSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Display title (#389): auto-derived from the first agent turn, or the user's inline edit
   *  (`PATCH /runs/:id` sets it together with `title`). Show `titleSummary ?? title`. */
  titleSummary: z.string().optional(),
  /** Refreshed on every turn-end; absent until the first turn ends (and on worktree-less runs). */
  diffStat: diffStatSchema.optional(),
  workflow: z.string(),
  task: z.string(),
  /** Prompt messages stacked onto the run while it waited for a free agent slot (#472). Folded
   *  into the prompt at dequeue — never delivered as their own turns. Absent on pre-#472 runs. */
  queuedMessages: z.array(queuedMessageSchema).optional(),
  /** URLs of images attached to the initial task prompt (#image-display). */
  taskImages: z.array(z.string()).optional(),
  model: z.string().optional(),
  /** Normalized provider/model identity used for attribution and reproducible replay. */
  modelIdentity: z.string().optional(),
  runner: runnerSchema.optional(),
  /** The composer's per-task agent account (spec 2026-07-29-agent-profiles), applying to steps
   *  on `runner`. Absent = the run follows the project's own selection. */
  agentProfile: z.string().optional(),
  /** Echo of the extra system prompt the run used (POST override or config default). */
  systemPrompt: z.string().optional(),
  /** false when the run deliberately disabled follow-up todo generation. Absent means enabled. */
  generateFollowups: z.boolean().optional(),
  /** Autonomous mode (#autonomous): the run never parks at `waiting` or the terminal `review`
   *  gate. Absent = falsy = not autonomous. */
  autonomous: z.boolean().optional(),
  /**
   * Provenance for a task a project GitHub automation launched (#694). Absent on every ordinary
   * run, which is what makes it additive — the cockpit shows the "from automation" link only when
   * it is there.
   *
   * `event` is a plain string rather than `automationEventSchema`: it is the event NAME the
   * launching definition matched, recorded on the run for the audit trail, and `src/runs/store.ts`
   * persists it as free text so an older cezar can still read a record written by a newer one.
   */
  automation: z
    .object({
      automationId: z.string(),
      automationRevision: z.number(),
      receiptId: z.string(),
      event: z.string(),
      githubUrl: z.string(),
    })
    .optional(),
  /**
   * Who created this task, stamped at creation and never rewritten (spec
   * `.ai/specs/2026-08-21-task-author-provenance.md`).
   *
   * OPTIONAL on the schema because every record written before 2026-08-21 has none — REQUIRED by
   * `createRun`/`startRun`'s input types, which is what makes it present on everything written
   * since. Absent renders as "unknown (created before 2026-08-21)", never as a guess: cezar has no
   * evidence about who started a run last week and inventing one would be worse than `—`.
   *
   * Never client-supplied. `createRunInputSchema` does NOT carry this key, so a body naming an
   * `author` never reaches a handler — an author you can set yourself is not provenance.
   */
  author: taskAuthorSchema.optional(),
  status: runStatusSchema,
  /**
   * Why a `review` run stopped, when it was not the ordinary diff-first review gate (#489) —
   * PLAN D27, Phase 1 of `.ai/specs/2026-08-15-autonomous-implementation-continuation.md`. Only
   * ever set alongside `status: 'review'`; today the only value is `'budget'`, meaning `stepsUsed`
   * (below) reached the configured `stepBudget` before the run finished on its own. `RunStatus` is
   * deliberately NOT widened for this — it is a published union and cezar is a released npm
   * package, so adding a member would break a consumer switching over it exhaustively. This field
   * is new and optional, so an older build round-trips it untouched.
   */
  stopReason: z.enum(['budget', 'inactivity']).optional(),
  /** Cumulative units of budgeted work this run has spent (PLAN D27 Phase 1) — one check-step
   *  attempt, or one agent turn (opening turn, follow-up, self-continuation nudge, or monitoring
   *  wake-up all count equally). See `stopReason` above and `stepsUsed`'s doc comment in
   *  `runs/store.ts` for why a workflow's fixed step list cannot carry this bound alone. */
  stepsUsed: z.number().optional(),
  /** Per-run override of `config.stepBudget` (PLAN D27 Phase 3): set once at start by the
   *  autonomous continuation trigger when the target project's own `stepBudget` is 0/unset, so an
   *  autonomous implementation run is never unbounded even in a repo that never configured one.
   *  See `stepBudgetOverride`'s doc comment in `runs/store.ts` for the full reasoning. */
  stepBudgetOverride: z.number().optional(),
  /** Repo-relative path of the spec an implementation-triggering `note-to-spec` run reported
   *  writing, parsed from a `CEZ:SPEC_PATH=` marker in its final turn (PLAN D27 Phase 3, mirrors
   *  `markerRefs`). Absent until the run declares one, and absent forever on a run that never does
   *  — a fact worth seeing, not one to paper over with a guessed path. */
  declaredSpecPath: z.string().max(500).optional(),
  /** Set while the run is parked on a human approval gate (spec 2026-08-20, P3); cleared the
   *  moment the gate releases or the chain moves on. Absent on every ungated run. */
  pendingApproval: pendingApprovalSchema.optional(),
  pendingHandoff: pendingHandoffSchema.optional(),
  testAttestation: testAttestationSchema.optional(),
  /** `monitoring` while `status === 'running'` and the agent is working on downstream work.
   *  Absent on old runs; cleared on resume/end. */
  activity: runActivitySchema.optional(),
  /** Why an unmarked interactive turn is parked. Additive so older records and clients remain valid. */
  waitingReason: z.enum(['question', 'report', 'handoff']).optional(),
  /** Verbatim trailing question detected in the agent's prose, never synthesized by cezar. */
  waitingQuestion: z.string().max(280).optional().catch(undefined),
  /** Exact ISO-8601 deadline for the next automatic monitoring check. */
  monitoringWakeAt: z.string().optional(),
  /** The current live monitoring epoch exhausted its 40 automatic checks. */
  monitoringWakeCapReached: z.boolean().optional(),
  /** Exact ISO-8601 instant this run resumes itself after a provider usage limit stopped it
   *  (spec 2026-08-03-auto-resume-after-usage-limit). Present only on a `failed` run with a
   *  pending automatic resume — its absence is what "no resume is scheduled" looks like. */
  autoResumeAt: z.string().optional(),
  /** Consecutive automatic resumes since the last human turn, against the safety cap. */
  autoResumeAttempts: z.number().optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  tokensUsed: z.number(),
  inputTokens: usageCounterSchema.optional(),
  outputTokens: usageCounterSchema.optional(),
  /** Current context-window occupancy — the latest agent step's `contextTokens` (the
   *  current session's most recent turn). NOT a sum: it is "how full the window is now"
   *  (spec 2026-08-19-context-usage-in-tasks-table). Absent until the first turn ends. */
  contextTokens: usageCounterSchema.optional(),
  /** The model's maximum context window, the denominator in the cockpit's `45k / 200k`.
   *  Superseded 2026-08-22 by 2026-08-22-context-window-denominator-per-step: sourced from
   *  the same step's own `StepState.contextWindow` (a real report, else the model-string
   *  guess, else withdrawn when that step's own tokens disprove it) rather than a fresh
   *  independent guess — absent for a runner/model whose window we do not model, so the
   *  cell shows only the current figure. */
  contextWindow: usageCounterSchema.optional(),
  costUsd: z.number().optional(),
  pullRequestUrl: z.string().optional(),
  /** The PR this task is ABOUT (#407) — auto-discovered from conversation references. Display
   *  tier only: `pullRequestUrl` (the PR this task CREATED) wins, and the action gates ignore it. */
  referencedPullRequestUrl: z.string().optional(),
  /** The PR/issue number this task is ABOUT (task auto-naming spec) — display tier only. */
  prNumber: z.number().optional(),
  issueNumber: z.number().optional(),
  /** Server-side provenance: referenced-issue discovery currently owns `issueNumber`. */
  referencedIssueNumberSeeded: z.boolean().optional(),
  /** 'user' = renamed via PATCH, never auto-overwritten; 'marker' = agent-declared via
   *  CEZ:TITLE (spec 2026-07-18-task-ref-markers); 'auto' = namer-owned. */
  titleOrigin: z.enum(['user', 'auto', 'marker']).optional(),
  /** References the agent declared via CEZ:PR/CEZ:ISSUE markers — authoritative over the namer
   *  for the matching kind. */
  markerRefs: z.object({ pr: z.number().optional(), issue: z.number().optional() }).optional(),
  /** The referenced tier's working set (distinct PR URLs spotted, capped server-side). */
  referencedPrCandidates: z.array(z.string()).optional(),
  /** The issue this task is ABOUT (spec 2026-07-21-report-ref-discovery). Display-only. */
  referencedIssueUrl: z.string().optional(),
  /** The referenced-issue working set, persisted like `referencedPrCandidates`. Capped. */
  referencedIssueCandidates: z.array(z.string()).optional(),
  /** Explicit execution policy. `false` means the run intentionally uses the repo root;
   *  absent on older runs and for the default isolated-worktree mode. */
  worktree: z.literal(false).optional(),
  /** Absent for in-place runs and after an isolated worktree is removed. */
  worktreePath: z.string().optional(),
  /**
   * A WORKSPACE RUN's directory grant (`.ai/specs/2026-08-15-cross-project-workspace-run.md`) —
   * every registered project this run may read and write outside its cwd. Present only on
   * workspace runs; an ordinary project run never carries it.
   *
   * **Persisted, not re-derived, and that is the point.** The registry is mutable: a project
   * added or removed while a run is alive would silently widen or narrow the grant of a run
   * already in flight the moment it resumed. The grant is decided once, at creation, and every
   * later step and every restart-and-resume re-applies exactly this list.
   *
   * **The PROJECT list, not the granted directory list**, because the two are deliberately
   * different: `--add-dir` gets the same set deduped by containment (twelve registered projects
   * collapse to two directories on the owner's own workspace), while the prompt must name all
   * twelve so the agent knows what is there. Both are derived from this one field by
   * `buildWorkspaceGrant` (`workspace/granted-roots.ts`) — a pure function, so nothing re-reads
   * the registry mid-run.
   */
  /** The composer's frozen input-to-tasks dispatch choice. */
  autoStart: z.boolean().optional(),
  workspaceProjects: z.array(workspaceGrantProjectSchema).optional(),
  /** Todos filed by an input-to-tasks workspace run, captured before completion is reported. */
  filedTodos: filedTodosSchema.optional(),
  /**
   * A parallel WORKSPACE RUN's per-project worktrees
   * (`.ai/specs/2026-08-19-parallel-workspace-runs-worktrees.md`). At start, every granted git
   * project is isolated in its own `cez/<id8>` worktree; the agent works there instead of the real
   * checkouts, so N workspace runs run concurrently without colliding. When the run finishes each
   * worktree's diff is applied back into its real checkout and the worktree is removed.
   *
   * Persisted, not re-derived (like `workspaceProjects`, D5): the apply-back step must find these
   * after a restart, and after the process that created them is gone.
   */
  workspaceWorktrees: z.array(workspaceWorktreeSchema).optional(),
  branch: z.string().optional(),
  /** Stable baseline for session git views: a worktree's fork ref, or an in-place run's starting commit. */
  baseBranch: z.string().optional(),
  /** Set when count-based retention (#483) reclaimed the worktree DIRECTORY (the branch is
   *  kept): the dir is gone but recoverable. */
  worktreeReclaimedAt: z.string().optional(),
  /** Parallel variants (spec 010): runs sharing a groupId are one group. */
  groupId: z.string().optional(),
  /** Variant letter within the group — 'A' | 'B' | 'C'. */
  variant: z.string().optional(),
  peakRssBytes: z.number().optional(),
  peakProcCount: z.number().optional(),
  archived: z.boolean(),
  archivedAt: z.string().optional(),
  /** Read receipt (#unread-done-items): ISO time the cockpit last opened this run's
   *  thread. A finished (`done`/`failed`) run reads as *unread* until seen since it
   *  finished — see `isUnread()` in the cockpit's `lib/read-state.ts`. Absent on old
   *  runs, on any run not yet opened, and on one deliberately put back to unread via
   *  `POST /runs/:id/unread` (#775) — all three count as unread. */
  seenAt: z.string().optional(),
  currentStepId: z.string().optional(),
  error: z.string().optional(),
  steps: z.array(stepStateSchema),
  /**
   * The persisted workflow definition, so a `queued` run survives a restart — including the ad-hoc
   * "(planned)" chains that exist nowhere else.
   *
   * The definition schema and NOT `z.record(z.string(), z.unknown())`: this key comes off the wire,
   * so its values are whatever `JSON.parse` can produce and nothing else. `unknown` was wider than
   * the server can serialize, and it made the route type unrepresentable here — hono maps `unknown`
   * to its own `JSONValue`, whose index signature admits `object | symbol | undefined`. The fix was
   * at the source: `src/runs/store.ts` persists a typed `workflowDefSchema` now, so the route's own
   * type is this shape and the two-way check in `src/server/contract-parity.runs.test.ts` covers it
   * like every other key.
   */
  workflowDef: workflowDefSchema.optional(),
  /**
   * Run-broker spool for this run's live agent session, relative to the project's data dir
   * (spec `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`, P4).
   *
   * Absent means this run was never brokered — an older record, a backend that is not brokered
   * yet, or a host where brokering is unavailable. On boot, absent routes recovery to the legacy
   * "mark interrupted and force-continue" path, which stays exactly as it was.
   */
  spoolDir: z.string().optional(),
  /**
   * Bytes of `<spoolDir>/out.ndjson` already consumed and turned into events.
   *
   * This single number IS the re-attach contract: a replacement server resumes the tail here, so
   * it replays precisely the records the previous process had not yet handled — no gap, no
   * duplicate. It advances only past COMPLETE lines (see `readSpoolFrom`), which is why a read
   * landing mid-record cannot corrupt or lose one.
   */
  consumedOffset: z.number().optional(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

/**
 * What `GET /runs` and `GET /runs/:id` answer: the stored record plus the live `usage` sample the
 * server attaches on the way out (`withUsage`). Absent for finished runs and wherever `ps` yields
 * nothing — never persisted, and never attached by the mutation routes.
 */
export const apiRunSchema = runRecordSchema.extend({
  usage: processUsageSchema.optional(),
});
export type ApiRun = z.infer<typeof apiRunSchema>;

// ---- the cross-project index --------------------------------------------------------------

/**
 * One run in the WORKSPACE-level index (`GET /api/v1/workspace/runs-index`) — the ⌘K palette's
 * "find a task in any project" list, and the global Tasks page's rows.
 *
 * Deliberately a separate, slim shape rather than `ApiRun`. The index answers for every
 * registered project at once, and `runRecordSchema` carries `steps[]` and `workflowDef` — a fat
 * record whose cost is fine per project and absurd multiplied by the registry. These are exactly
 * the fields a palette row renders: `runTitle`'s three (`title`, `titleSummary`, `titleOrigin`),
 * `deriveAttention`'s `AttentionInput`, `isUnread`'s `ReadStateInput`, and the timestamps
 * `shortAge` reads. Adding a field here is cheap; adding the whole record is what this exists to
 * avoid — but note that widening either of those two `Pick`s means widening this too, or the
 * palette's cross-project rows silently answer differently from every other surface.
 *
 * `projectId` is the join key, NOT the project name: the registry is already on the client and is
 * authoritative for display names, and duplicating one here would let a renamed project show two
 * different labels in one palette.
 */
export const runIndexEntrySchema = z.object({
  /** The registered project this run belongs to. Joins against `GET /projects`. */
  projectId: z.string(),
  /**
   * A WORKSPACE RUN (`.ai/specs/2026-08-15-cross-project-workspace-run.md`) — one run granted every
   * registered project root, whose record happens to live in the boot project's `runs.json`.
   *
   * It QUALIFIES `projectId` rather than replacing it: D1's storage fact stays true, and the row
   * still needs a project to be keyed and fetched by. What it says is that `projectId` is not a
   * scoping claim here, so a cross-project board must not present the boot repo as the work's home.
   *
   * Derived server-side from `RunRecord.workspaceProjects` — the field the record already
   * persists — so there is exactly one definition of "is a workspace run" and no second one to
   * drift. Absent (never `false`) on an ordinary run, including an ordinary run that genuinely
   * lives in the boot repo.
   */
  workspace: z.boolean().optional(),
  id: z.string(),
  title: z.string(),
  titleSummary: z.string().optional(),
  titleOrigin: z.enum(['user', 'auto', 'marker']).optional(),
  status: runStatusSchema,
  activity: runActivitySchema.optional(),
  /** Why an unmarked interactive turn is parked. */
  waitingReason: z.enum(['question', 'report', 'handoff']).optional(),
  /** Verbatim trailing question detected in the agent's prose. */
  waitingQuestion: z.string().max(280).optional().catch(undefined),
  /** Why a `review` run stopped, when it was not the ordinary diff-first review gate (#489) —
   *  PLAN D27, Phase 1/3. Mirrors `RunRecord.stopReason` (see its own doc comment there); carried
   *  here because `deriveAttention` reads it to tell a budget stop apart from an ordinary review
   *  on the two cross-project boards (`global-tasks.tsx`, `workspace-tasks.tsx`) — without it a
   *  budget-parked run across every OTHER project reads as a plain, unremarkable `review`. */
  stopReason: z.enum(['budget', 'inactivity']).optional(),
  createdAt: z.string(),
  finishedAt: z.string().optional(),
  /** With `status`/`finishedAt`/`archived`, the four inputs `isUnread` reads — what lets the
   *  palette lead with "finished while you weren't looking" across every project, not just the
   *  one you happen to be standing in. */
  seenAt: z.string().optional(),
  /** Always present, like `RunRecord.archived`: absent would read as "not archived", and the
   *  unread rule treats archiving as a stronger "done with this" than reading. */
  archived: z.boolean(),
  /** A run parked by a provider usage limit is `failed` on the record with a resume booked
   *  (spec 2026-08-03-auto-resume-after-usage-limit). Both `deriveAttention` and `isUnread` read
   *  it, so without it here a cross-project row would show a red "failed" dot and land in
   *  Recently finished for work that is simply waiting for its appointment. */
  autoResumeAt: z.string().optional(),
  /** The workflow the run executes — the global Tasks page shows it in a column and groups by
   *  it. Always present on the record (`RunRecord.workflow`), so required here; the display
   *  refinement `workflowLabel` applies needs `steps[]`, which this row deliberately omits, so
   *  a `(planned)` chain reads as itself here rather than as its first agent's name. */
  workflow: z.string(),
  /** The task's branch, when it has one — a column on the global page, and the one field that
   *  makes a cross-project row identifiable at a glance without opening it. */
  branch: z.string().optional(),
  /** Who created the task (`.ai/specs/2026-08-21-task-author-provenance.md`, Phase 4) — the
   *  global page's Author column, and the only field that answers "what made this?" for a row on
   *  a board spanning forty projects. One small object, carried whole rather than pre-rendered to
   *  a label, because the cross-project board is also the one surface that can resolve an agent
   *  author's PARENT to a link: it already holds every project's rows. Absent on runs created
   *  before the field existed. */
  author: taskAuthorSchema.optional(),
  /** When the agent actually started, as opposed to when the task was created. The global page's
   *  age column prefers it and falls back to `createdAt`, exactly as the per-project table does. */
  startedAt: z.string().optional(),
  /**
   * The eight fields `taskReference()` (`web/src/lib/tasks-table.ts`) reads to decide a task's PR
   * or issue chip. Carried verbatim rather than pre-resolved into a `{kind, number, url}` on the
   * server, because the rule that picks between them is subtle (#407, #526: a run that REVIEWED
   * a PR must not claim it as its own, an issue-subject run must not adopt an incidental
   * transcript PR) and it already exists, tested, on the client. Resolving it a second time
   * server-side would be a second rule, and the two would drift.
   *
   * `referencedIssueCandidates`/`referencedPrCandidates` are the two newest additions
   * (foreign-number guard, design ported read-only from `open-mercato/cezar` #840/#864): they are
   * EVIDENCE the client's `namesNumberElsewhere()` uses to refuse building a chip for a number
   * that belongs to a different repository, not a link themselves.
   *
   * Eight scalars/arrays is still the slim row this schema exists to keep: `steps[]` and
   * `workflowDef`, the expensive half, stay off it.
   */
  pullRequestUrl: z.string().optional(),
  referencedPullRequestUrl: z.string().optional(),
  prNumber: z.number().optional(),
  issueNumber: z.number().optional(),
  referencedIssueUrl: z.string().optional(),
  markerRefs: z.object({ pr: z.number().optional(), issue: z.number().optional() }).optional(),
  /** Evidence-only: raw PR URLs scraped from the run's transcript, some of which may name a
   *  different repository than the project's own. See `namesNumberElsewhere()`
   *  (`web/src/lib/tasks-table.ts`). Mirrors `RunRecord.referencedPrCandidates` verbatim. */
  referencedPrCandidates: z.array(z.string()).optional(),
  /** Evidence-only twin of `referencedPrCandidates` for issue numbers. Mirrors
   *  `RunRecord.referencedIssueCandidates` verbatim. */
  referencedIssueCandidates: z.array(z.string()).optional(),
  /** What the run has cost so far. Absent means nothing was recorded, which is NOT `$0` — the
   *  cockpit prints an em dash rather than claiming a measurement that never happened. */
  costUsd: z.number().optional(),
  /** Current context occupancy and the model's max window — the cross-project mirror of
   *  `RunRecord.contextTokens`/`contextWindow`, so the global Tasks table's Context column
   *  answers exactly as the per-project one does (spec 2026-08-19-context-usage-in-tasks-table). */
  contextTokens: usageCounterSchema.optional(),
  contextWindow: usageCounterSchema.optional(),
  /** The persisted high-water marks a FINISHED run leaves behind. `usage` below stops existing
   *  the moment the process tree does, so without these a finished row could say nothing at all
   *  about what it took to run. */
  peakRssBytes: z.number().optional(),
  peakProcCount: z.number().optional(),
  /**
   * The live CPU/RSS sample of this run's process tree, attached on the way out exactly as
   * `GET /runs` attaches it (`withUsage`) — never persisted.
   *
   * It can ride a WORKSPACE-level answer because the sampler is process-wide: one cezar process
   * runs every project's agents, so `currentUsage(runId)` knows about a run whatever project it
   * belongs to. That is what lets a cross-project table show live usage without opening one
   * event stream per project (it could not — the run stream is project-scoped).
   */
  usage: processUsageSchema.optional(),
});
export type RunIndexEntry = z.infer<typeof runIndexEntrySchema>;

/**
 * `GET /workspace/runs-index`.
 *
 * `truncated` is not decoration: the index caps each project's contribution, and a capped list
 * that says nothing reads as "your task is not here" when the honest answer is "not in the
 * newest N". Naming the projects that hit the cap is what lets a consumer say so.
 */
/**
 * Everything the SERVER already knew about the references its rows carry, per project — the
 * statuses that would otherwise cost a second round trip a beat after the table paints.
 *
 * Read from cache only: this never asks the forge, so a cold entry is simply absent and
 * `GET /github/ref-status` stays the route that actually goes and looks. That makes it free, and
 * being free is what lets it be a superset — the server looks up every number a run mentions
 * rather than re-deriving which one the cockpit will display (#407, #526 live client-side, and
 * duplicating that rule is how the two would drift).
 */
export const referenceStatusesByProjectSchema = z.record(
  z.string(),
  z.object({
    prs: z.record(z.number(), referenceStatusSchema),
    issues: z.record(z.number(), referenceStatusSchema),
  }),
);

export const runsIndexResponseSchema = z.object({
  /** Newest first, across every registered project. Archived runs are included — `GET /runs`
   *  carries them for the project you are standing in, and a finder that dropped them elsewhere
   *  would make a task vanish the moment you left its project. */
  runs: z.array(runIndexEntrySchema),
  /** Additive: absent statuses mean "nothing warm", never "nothing to show". */
  referenceStatuses: referenceStatusesByProjectSchema,
  /** The per-project cap that produced this list. */
  perProjectLimit: z.number(),
  /** Ids of the projects that had more runs than the cap allowed. */
  truncated: z.array(z.string()),
});
export type RunsIndexResponse = z.infer<typeof runsIndexResponseSchema>;

// ---- mutation responses ------------------------------------------------------------------

/**
 * `POST /runs` (201) — one record for ×1, a group for ×2/×3.
 *
 * The ×1 branch is the STORED record, not `ApiRun`: `startRun` answers before any `ps` sample
 * exists, so the create route never runs a record through `withUsage`.
 */
export const createRunResponseSchema = z.union([
  runRecordSchema,
  z.object({ runs: z.array(runRecordSchema) }),
]);
export type CreateRunResponse = z.infer<typeof createRunResponseSchema>;

/** `POST /runs/:id/cancel` — genuinely a boolean: an already-settled run answers 200 + `false`. */
export const cancelResponseSchema = z.object({ cancelled: z.boolean() });
export type CancelResponse = z.infer<typeof cancelResponseSchema>;

/**
 * `DELETE /runs/:id/auto-resume` (spec 2026-08-03-auto-resume-after-usage-limit) — the per-task
 * off switch for a pending usage-limit resume, next to the workspace-wide setting.
 *
 * `z.literal(true)`, not a boolean, and that IS the shape: the route is idempotent, so a run with
 * nothing pending answers 200 as well — "this task will not resume itself" is equally true either
 * way. Only an unknown run refuses, with 404.
 */
export const cancelAutoResumeResponseSchema = z.object({ cancelled: z.literal(true) });
export type CancelAutoResumeResponse = z.infer<typeof cancelAutoResumeResponseSchema>;

/** `POST /runs/archive-finished` — how many runs the sweep archived. */
export const archiveFinishedResponseSchema = z.object({ archived: z.number() });
export type ArchiveFinishedResponse = z.infer<typeof archiveFinishedResponseSchema>;

/** `POST /runs/read-all` — how many unread finished runs the sweep marked read. */
export const markAllReadResponseSchema = z.object({ read: z.number() });
export type MarkAllReadResponse = z.infer<typeof markAllReadResponseSchema>;

/** `DELETE /runs/:id` — an active run is a 409 and an unknown one a 404, so this only ever
 *  reports success. */
export const deleteRunResponseSchema = z.object({ deleted: z.literal(true) });
export type DeleteRunResponse = z.infer<typeof deleteRunResponseSchema>;

/** `POST /runs/:id/finish` — "no open session" is a 409. */
export const finishResponseSchema = z.object({ finished: z.literal(true) });
export type FinishResponse = z.infer<typeof finishResponseSchema>;

/** `POST /runs/:id/continue` — a refusal to reopen is a 409 carrying the engine's reason. */
export const continueResponseSchema = z.object({ continued: z.literal(true) });
export type ContinueResponse = z.infer<typeof continueResponseSchema>;

/**
 * `POST /runs/:id/pr` (201, spec 009) — the draft PR's URL; `dryRun` marks the CEZ_DRY_RUN fake
 * (no push, no gh). Failure is a 409 whose `ApiError` carries the `manual` merge command instead.
 *
 * `dryRun` is REQUIRED: `createDraftPr`'s success outcome always sets it (`forge/types.ts`), so
 * the key is always on the wire. The hand-written DTO had it optional.
 */
export const createPrResponseSchema = z.object({
  url: z.string(),
  dryRun: z.boolean(),
});
export type CreatePrResponse = z.infer<typeof createPrResponseSchema>;

/**
 * `POST /runs/:id/messages` — one of three shapes (#472), by how far the run has got:
 * `delivered` (a live session took it), `queued` (still waiting for a slot, so it was stacked
 * onto the prompt and the stored entry rides along), `deferred` (mid-spawn, so it was buffered
 * and arrives as an ordinary follow-up turn once the session opens). Anything else is a 409.
 *
 * A union, not one object of optional flags: exactly one of the four keys is ever present, and
 * the flattened DTO shape admitted `{}`. Pre-#472 clients only ever saw `delivered`.
 *
 * `continued` (spec 2026-08-20-inactive-sessions-stay-in-progress): the run was an idle-PARKED
 * `waiting` session — its backend process was closed to free memory but its status stayed
 * `waiting`, not `done` — so posting a message reopened the session via `--resume` and handed the
 * message in as the continuation prompt, exactly like `POST /runs/:id/continue`.
 */
export const messageResponseSchema = z.union([
  z.object({ delivered: z.literal(true) }),
  z.object({ queued: z.literal(true), message: queuedMessageSchema }),
  z.object({ deferred: z.literal(true) }),
  z.object({ continued: z.literal(true) }),
]);
export type MessageResponse = z.infer<typeof messageResponseSchema>;

/** `PATCH /runs/:id/queued-messages/:msgId` (#472) — the replaced entry. */
export const editQueuedMessageResponseSchema = z.object({ message: queuedMessageSchema });
export type EditQueuedMessageResponse = z.infer<typeof editQueuedMessageResponseSchema>;

/** `DELETE /runs/:id/queued-messages/:msgId` (#472) — `409 run already started` otherwise. */
export const removeQueuedMessageResponseSchema = z.object({ removed: z.literal(true) });
export type RemoveQueuedMessageResponse = z.infer<typeof removeQueuedMessageResponseSchema>;

/**
 * `POST /runs/:id/open-in-cli` — a terminal was spawned with `command` running in it. With no
 * terminal emulator the server answers 409 and the `ApiError` carries the full `cd … && <command>`
 * for the clipboard fallback.
 */
export const openInCliResponseSchema = z.object({
  opened: z.literal(true),
  command: z.string(),
});
export type OpenInCliResponse = z.infer<typeof openInCliResponseSchema>;

/** `POST /runs/:id/remove-worktree` — per-row delete in the worktrees panel (#483). */
export const removeWorktreeResponseSchema = z.object({ removed: z.literal(true) });
export type RemoveWorktreeResponse = z.infer<typeof removeWorktreeResponseSchema>;

/** `POST /runs/:id/git/commit` — `git add -A && git commit` in the run's worktree. */
export const gitCommitResponseSchema = z.object({
  committed: z.literal(true),
  sha: z.string(),
});
export type GitCommitResponse = z.infer<typeof gitCommitResponseSchema>;

/** `POST /runs/:id/git/push` — push the worktree's branch, setting upstream if it has none. */
export const gitPushResponseSchema = z.object({
  pushed: z.literal(true),
  branch: z.string(),
  remote: z.string(),
  upstreamSet: z.boolean(),
});
export type GitPushResponse = z.infer<typeof gitPushResponseSchema>;

/** A commit a run made on its worktree branch. */
export const runCommitSchema = z.object({
  sha: z.string(),
  subject: z.string(),
  author: z.string(),
  /** Relative time ("3 hours ago") — git's `%cr`. */
  when: z.string(),
});
export type RunCommit = z.infer<typeof runCommitSchema>;

/** `GET /runs/:id/commits` — `<base>..HEAD` on the worktree branch, newest first. */
export const runCommitsResponseSchema = z.object({ commits: z.array(runCommitSchema) });
export type RunCommitsResponse = z.infer<typeof runCommitsResponseSchema>;

// ---- parallel variants (spec 010) ----------------------------------------------------------
//
// `/groups/:groupId/*` is the RUN family seen sideways: a group is the runs sharing a `groupId`,
// and the pick answers a whole run record. So these live here rather than with the workflows,
// which keeps `./workflows.ts` free of any edge back into this file (see its header).

/**
 * One variant column of the compare view.
 *
 * CAREFUL: `diffStat` here is the raw `git diff --stat` TEXT the server runs in the variant's
 * worktree — a different thing from the numeric `RunRecord.diffStat`. `''` when the worktree
 * is gone.
 */
export const groupVariantSchema = z.object({
  id: z.string(),
  /** 'A' | 'B' | 'C' in practice; `'?'` for a record that lost its letter. */
  variant: z.string(),
  title: z.string(),
  status: runStatusSchema,
  archived: z.boolean(),
  tokensUsed: z.number(),
  inputTokens: usageCounterSchema.optional(),
  outputTokens: usageCounterSchema.optional(),
  costUsd: z.number().optional(),
  diffStat: z.string(),
  /** First lines of the handoff journal's "## Progress log" section, as markdown. */
  handoffExcerpt: z.string(),
});
export type GroupVariant = z.infer<typeof groupVariantSchema>;

/** `GET /groups/:groupId` — every run sharing a groupId, side by side. */
export const groupResponseSchema = z.object({
  groupId: z.string(),
  runs: z.array(groupVariantSchema),
});
export type GroupResponse = z.infer<typeof groupResponseSchema>;

/**
 * `POST /groups/:groupId/pick` — the winner (parked at `review` when it has a diff); the losers
 * were cancelled if alive, archived, and their worktrees + branches removed.
 *
 * `winner` is OPTIONAL because that is what the wire says: `store.getRun(id)` can miss, and
 * `JSON.stringify` drops a key whose value is `undefined`. The handler spreads the key in
 * conditionally (`server.ts`, the `/groups/:groupId/pick` route) so its own type says the same
 * thing — the two-way check in `contract-parity.workflows.test.ts` is what pins that.
 */
export const pickVariantResponseSchema = z.object({
  winner: runRecordSchema.optional(),
});
export type PickVariantResponse = z.infer<typeof pickVariantResponseSchema>;

// ---- request bodies ----------------------------------------------------------------------
//
// Request types are `z.input`, not `z.infer`: a caller writes what the schema ACCEPTS, and the
// defaults/transforms below (`text`, `images`, `systemPrompt`) mean the parsed output is not the
// same shape. `z.infer` here would demand keys the server fills in for you.

/** An inline image, base64 — ≤4 per request, ~5 MB each once decoded. */
export const imageInputSchema = z.object({
  mediaType: z.string().regex(/^image\//),
  data: z.string().min(1).max(7_000_000),
});
export type ImageInput = z.input<typeof imageInputSchema>;

/**
 * The KEYS of `POST /runs`' body, before the XOR refinement that `createRunInputSchema` adds.
 *
 * Split out for one reason: `./automations.ts` builds an automation's task on top of this shape
 * (a task IS a run-creation body minus the three keys an automation supplies itself), and zod
 * refuses `.omit()` on a schema that carries refinements. Validate with `createRunInputSchema`
 * below — this half accepts a body naming both `workflow` and `steps`, which the server does not.
 */
export const createRunInputBaseSchema = z
  .object({
    workflow: z.string().min(1).optional(),
    /** An inline chain (spec 008 — an approved plan runs as an ad-hoc workflow, never written to
     *  a file). The catalog's own step shape, not a copy of it. */
    steps: z.array(workflowStepDefSchema).min(1).max(8).optional(),
    task: z.string().min(1).max(100_000, 'must be at most 100000 characters'),
    model: z.string().optional(),
    runner: runnerSchema.optional(),
    /** Agent account for this task (spec 2026-07-29-agent-profiles). Omit to follow the
     *  project's own selection; an id that no longer exists is a 400, not a silent default. */
    agentProfile: z.string().max(64).optional(),
    /** 1–3. Above 1 the response is `{ runs }` rather than a single record. */
    variants: z.number().int().min(1).max(3).optional(),
    /** false → run in the repo working tree instead of an isolated worktree (read-only skills).
     *  Omit for the default. Ignored server-side when variants > 1. */
    worktree: z.boolean().optional(),
    /** true → autonomous run: never parks at "waiting"; auto-continues until done. */
    autonomous: z.boolean().optional(),
    /** false → keep the handoff journal but do not expose or request a follow-up todos file.
     *  Omit for the default (enabled); a server with the capability off pins it to false. */
    generateFollowups: z.boolean().optional(),
    /** Per-run system-prompt override (R2 2.3) — programmatic callers only. Wins over the
     *  config.json default; whitespace-only degrades to absent. */
    systemPrompt: z
      .string()
      .trim()
      .max(20_000, 'must be at most 20000 characters')
      .optional()
      .transform((s) => (s ? s : undefined)),
    /** Screenshots pasted into the new-task form; delivered with the first agent step. */
    images: z.array(imageInputSchema).max(4).optional(),
    /** The inbox entry this task came from (#374). Best-effort bookkeeping: an unknown or
     *  already-started id never fails the run. For ×2/×3 the FIRST variant is recorded. */
    todoId: z.string().min(1).max(200, 'must be at most 200 characters').optional(),
  });

/**
 * `POST /runs`. At most one of `workflow` / `steps` — naming both is a 400; naming neither
 * resolves server-side to `quick-task` (the composer's "None" pill item, 2026-08-15).
 *
 * Every bound here is the server's own (#429): an unbounded body must never reach a spawned
 * process, so a client that validates before sending gets the same answer the route would give.
 */
export const createRunInputSchema = createRunInputBaseSchema.refine(
  (b) => !(b.workflow && b.steps),
  { message: 'provide "workflow" or "steps", not both' },
);
export type CreateRunInput = z.input<typeof createRunInputSchema>;

/**
 * `POST /runs/:id/messages` — text and/or pasted screenshots for a live session. Both keys have
 * server-side defaults, so an omitted `text` is `''` and an omitted `images` is `[]`; the refine
 * is what rejects a message that is empty in both.
 */
export const messageInputSchema = z
  .object({
    text: z.string().max(100_000).default(''),
    images: z.array(imageInputSchema).max(4).default([]),
  })
  .refine((m) => m.text.trim().length > 0 || m.images.length > 0, {
    message: 'message needs text or at least one image',
  });
export type MessageInput = z.input<typeof messageInputSchema>;

/**
 * `PATCH /runs/:id` (#389). `title` is trimmed server-side, 1–300 chars, and the edit sets both
 * `title` and `titleSummary` so it wins over any auto-summary. `task` (#472) is the initial
 * prompt, editable only while the run is still queued — any other status answers
 * `409 run already started`, and the folded total across the task and its stack bounds it again.
 */
export const patchRunInputSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  task: z.string().trim().min(1).max(100_000).optional(),
});
export type PatchRunInput = z.input<typeof patchRunInputSchema>;
