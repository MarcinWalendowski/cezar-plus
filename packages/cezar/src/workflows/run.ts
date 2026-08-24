import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  parseAskMarkerResult,
  stripAskMarker,
  type AskMarkerParseResult,
  type AskRequest,
} from '../core/ask.ts';
import { claudeSessionTranscriptExists, type AgentSession } from '../core/claude-cli-runner.ts';
import { detectTrailingQuestion, type TrailingQuestion } from '../core/turn-question.ts';
import { onUsage, registerRunProcess, unregisterRunProcess, type ProcessUsage } from '../core/process-usage.ts';
import { parseUsageLimit } from '../core/usage-limit.ts';
import { createRunner } from '../core/runner-factory.ts';
import {
  BROKERED_BACKENDS,
  brokerAvailable,
  type BrokerSessionRequest,
  type ResourceKillReport,
} from '../core/broker-launch.ts';
import {
  chooseIsolation,
  nextBrokerInstanceId,
  probeIsolationCapabilities,
  type BrokerIsolation,
  type BrokerResourceLimits,
} from '../core/broker-isolation.ts';
import { isPidAlive, isSpoolLive, legacySpoolDirFor, readSpoolMeta, SPOOL_ORPHAN_GRACE_MS, spoolDirFor, type SpoolMeta } from '../core/run-spool.ts';
import { isRetryableBrokerLaunch } from '../core/brokered-session.ts';
import { reapAbandonedBroker } from '../core/reap-abandoned-broker.ts';
import { isMissingSessionRejection, type RunnerId } from '../core/agent-runner.ts';
import { agentHomePaths } from '../paths.ts';
import { modelConflictsWithRunner } from '../core/model-presets.ts';
import { AGENT_MODELS_LOCKED_ERROR, agentModelsLocked } from '../core/agent-model-policy.ts';
import {
  ModelIdentityError,
  formatModelIdentity,
  normalizeModelForBackend,
} from '../core/model-identity.ts';
import {
  HANDOFF_ONLY_INSTRUCTIONS,
  HANDOFF_INSTRUCTIONS,
  appendHandoffHeartbeat,
  followupsEnabled,
  handoffPath,
  seedHandoffFile,
} from '../handoff.ts';
import { todosPath } from '../todos.ts';
import { knowledgeSystemPrompt, loadKnowledgeSummary, type KnowledgePromptSummary } from '../knowledge/prompt.ts';
import { knowledgeWriteFilePath } from '../knowledge/proposals.ts';
import type { AgentEvent, AgentStopReason, ContentBlock } from '../core/agent-runner.ts';
import { discoverSkills, type Skill } from '../skills.ts';
import { materializeSkillDir } from '../skills-remote.ts';
import { seedAgentConfigLocalLayer } from '../agent-config/seed.ts';
import { readAgentModelProvider } from '../agent-config/models.ts';
import { loadConfig, resolveWorktreeRetention, type CezConfig } from '../config.ts';
import { autosaveCommit, createWorktree, resolveBaseRef, worktreeDiff, worktreeShortstat } from '../git-worktree.ts';
import { LEASE_HEARTBEAT_MS, removeWorktreeLeases, touchWorktreeLeases, writeWorktreeLease } from '../workspace/worktree-lease.ts';
import { getHeadCommit, getRepoInfo } from '../server/git.ts';
import { loadWorkflows } from './load.ts';
import { evaluatePostcondition, type PostconditionResult } from './postconditions.ts';
import type { QueuedMessage, RunRecord, RunStore, StepState } from '../runs/store.ts';
import type { TaskAuthor } from '../runs/task-author.ts';
import { reclaimWorktrees, rematerializeReclaimedWorktree } from '../runs/retention.ts';
import {
  AgentTempDirError,
  agentTmpEnv,
  removeAgentTmpDir,
  sweepAgentTmpDirs,
} from '../runs/agent-tmpdir.ts';
import { extractTaskRefs, refineTaskRefs, titleRefNumber } from '../runs/task-refs.ts';
import { parseTaskMarkers, stripTaskMarkers } from '../runs/task-markers.ts';
import {
  autoNamingActive,
  generateRunName,
  liveTitleUpdatesEnabled,
  postValidateTitle,
  TITLE_MAX,
} from '../runs/auto-name.ts';
import { reviewGateEnabled } from '../runs/review-gate.ts';
import { approvalsSatisfied, minApprovers } from '../runs/approvals.ts';
import { defDescribesRun, firstUnfinishedStep, pendingChainSteps, stepTerminal } from '../runs/chain.ts';
import { resolveProfileEnvForRoot } from '../workspace/agent-profiles.ts';
import {
  clearLimited,
  countInflight,
  isLimited,
  loadAgentAccountUsage,
  mergeWriteAgentAccountUsage,
  recordDispatch,
  recordLimited,
  usageEntry,
  type InflightStep,
} from '../workspace/agent-account-usage.ts';
import { loadAgentAccounts } from '../workspace/agent-accounts.ts';
import { listAgentProfiles } from '../workspace/agent-profiles.ts';
import { PROFILE_CAPABLE_PROVIDERS } from '../core/agent-profiles.ts';
import {
  accountUsageKey,
  DEFAULT_AGENT_ACCOUNT_ID,
  runAccountKey,
  usageHoldAccountKey,
} from '@loki-labs/better-cezar-contract';
import {
  resolvePoolForDispatch,
  resolvePoolForProvider,
  selectPoolAccount,
  type PoolChoice,
} from '../workspace/agent-route-select.ts';
import type { ProviderId } from '../core/provider-auth.ts';
import {
  buildWorkspaceGrant,
  loadWorkspaceGrant,
  workspaceGrantSystemPrompt,
  type GrantedProject,
  type WorkspaceGrant,
} from '../workspace/granted-roots.ts';
import {
  applyWorkspaceWorktrees,
  discardWorkspaceWorktrees,
  materializeWorkspaceWorktrees,
} from '../workspace/workspace-worktrees.ts';
import type { PendingApproval, WorkspaceWorktree } from '@loki-labs/better-cezar-contract';
import { WorkspaceSemaphore, type AccountHolds } from '../workspace/semaphore.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { UiEventSink } from '../runs/ui-event-sink.ts';
import type { UiEvent } from '../core/ui-events.ts';
import {
  chainStepNote,
  CLASS_CHOICE_BY_RUNNER,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_WORKFLOW,
  DEFAULT_WORKFLOW_NAME,
  parseReviewVerdict,
  resolveStepModel,
  stepKind,
  type ReviewVerdict,
  type StepModelChoice,
  type TaskClass,
  type WorkflowDef,
  type WorkflowStepDef,
} from './types.ts';
import { classifyTask } from '../task-classifier.ts';

const CHECK_OUTPUT_CAP = 20_000;

/**
 * The workflow "▶ Run" turns a filed todo into (`server.ts`'s `POST /todos/:id/start`): a
 * one-step workflow around the suggested skill when it still exists on disk, the default workflow
 * ({@link DEFAULT_WORKFLOW_NAME}) otherwise. Lifted out here — rather than left inline in the route
 * — so `todo-autostart.ts` (Phase 2, `.ai/specs/2026-08-19-file-tasks-from-a-running-task.md`)
 * resolves a todo the SAME way whether a person clicks ▶ Run or the cockpit starts a
 * `--start`-filed todo for them. A todo is user-initiated (a person filed it), so it floors to the
 * full default; the unattended integration paths keep their own explicit fallback (see
 * {@link DEFAULT_WORKFLOW_NAME}).
 */
export async function resolveTodoWorkflow(
  repoRoot: string,
  todo: { suggestedSkill?: string },
): Promise<WorkflowDef> {
  if (todo.suggestedSkill) {
    const skills = await discoverSkills(repoRoot);
    if (skills.some((s) => s.name === todo.suggestedSkill)) {
      return {
        name: '(inbox)',
        description: `Follow-up from the inbox — skill "${todo.suggestedSkill}"`,
        source: 'built-in',
        steps: [{ id: 'task', name: 'Do the task', skill: todo.suggestedSkill, prompt: '{{task}}' }],
      };
    }
  }
  const { workflows } = await loadWorkflows(repoRoot);
  return workflows.find((w) => w.name === DEFAULT_WORKFLOW_NAME) ?? DEFAULT_WORKFLOW;
}

async function configuredModelProvider(
  backend: RunnerId,
  repoRoot: string,
): Promise<string | undefined> {
  return readAgentModelProvider(backend, repoRoot).catch(() => undefined);
}
/** An interactive session that hears nothing from the user closes itself. */
export const IDLE_TIMEOUT_MS = 15 * 60_000;
/**
 * Task-completion marker from the agent contract (HANDOFF_INSTRUCTIONS): a
 * turn whose text ends with `CEZ:DONE` means "goal achieved, nothing to ask" —
 * the session is closed right away instead of parking at `waiting` (#347).
 * Detection runs on the accumulated turn text so delta-streaming backends
 * (codex, opencode) can't split the marker across text events.
 */
const DONE_MARKER_RE = /CEZ:DONE\s*$/;
/**
 * Still-working marker from the agent contract (spec
 * 2026-07-18-subagent-monitoring-status, #490): a turn whose text ends with
 * `CEZ:MONITORING` means "I ended this turn but I'm still working on my own
 * downstream work (a sub-agent / a command I'm monitoring), not waiting on the
 * user" — cezar parks it as `running`/`activity:'monitoring'` instead of
 * `waiting`, so the cockpit shows a non-attention state. `CEZ:DONE` wins if both
 * appear. Detected on accumulated turn text (like `CEZ:DONE`) so delta-streaming
 * backends can't split the marker across text events.
 */
const MONITORING_MARKER_RE = /CEZ:MONITORING\s*$/;
/**
 * Preserve boundaries between complete assistant text blocks while a turn is
 * accumulated for marker parsing. The runners join these same v1 blocks with
 * newlines in `AgentRunResult`; matching that contract here prevents a
 * trailing `CEZ:TITLE=` block from absorbing later commentary (#623).
 */
export function appendTurnText(current: string, next: string): string {
  if (!current) return next;
  if (!next) return current;
  return `${current}\n${next}`;
}
/** Strip a trailing marker from one text event so transcripts stay free of
 *  protocol noise. Delta backends may split the marker across events — then
 *  it stays visible; detection above is unaffected. */
function stripDoneMarker(text: string): string {
  return text.replace(/\s*CEZ:DONE\s*$/, '');
}
/** Strip a trailing `CEZ:MONITORING` marker from one text event (see
 *  `stripDoneMarker`; same delta-backend caveat). */
function stripMonitoringMarker(text: string): string {
  return text.replace(/\s*CEZ:MONITORING\s*$/, '');
}
/** Emit the v2 `ask.requested` event for a parsed marker (the cockpit renders
 *  it as an ask card, #473). Returns the minted request id. */
function emitAskRequested(sink: UiEventSink, ask: AskRequest): string {
  const requestId = randomUUID();
  sink.handle({ type: 'ask.requested', requestId, questions: ask.questions });
  return requestId;
}
/** A persisted, non-fatal explanation for protocol-shaped text that could not
 * become an ask card. Never include the raw payload in this diagnostic. */
function askMarkerRejection(result: AskMarkerParseResult): string | undefined {
  if (result.kind === 'invalid-json') {
    return 'structured question ignored — CEZ:ASK payload is not valid JSON';
  }
  if (result.kind !== 'invalid-structure') return undefined;
  const issue = result.issues[0];
  const location = issue?.path.length ? ` at ${issue.path.join('.')}` : '';
  return `structured question ignored — CEZ:ASK payload failed validation${location}${issue ? `: ${issue.message}` : ''}`;
}
/** Periodic "cezar autosave" commit in the task worktree (spec 006). */
export const AUTOSAVE_INTERVAL_MS = 90_000;

/** The periodic autosave timer is opt-in (#471): off, a task branch carries only the
 *  agent's own commits plus the turn-end/pre-PR flushes — no mid-run "cezar autosave"
 *  noise interleaving PR history. The flushes (`autosaveCommit` at turn end and before
 *  a draft PR) are NOT gated: the branch must still end holding the finished state. */
export function periodicAutosaveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_AUTOSAVE === '1';
}

/**
 * Explicitly opt out of the repository-root lease for runs that execute in the
 * current checkout. This covers explicit worktree opt-out, non-Git degradation,
 * and continuations whose worktree cannot be restored (spec 006 hardening, #438).
 * This is intentionally unsafe: concurrent agents may overwrite each other's
 * files or Git state. Isolated worktree runs are unaffected.
 */
export function repositoryRootLockDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_DISABLE_REPO_LOCK === '1';
}

const REPOSITORY_ROOT_LOCK_DISABLED_NOTE =
  'repository-root lock disabled by CEZ_DISABLE_REPO_LOCK=1 (shared checkout is unsafe)';

/** How a parked approval gate released (spec 2026-08-20, P3). */
type ApprovalOutcome = { kind: 'approved' } | { kind: 'changes'; notes: string } | { kind: 'cancelled' };

interface ActiveRun {
  cancelled: boolean;
  interrupt: () => void;
  /** Where this run's steps execute: the task worktree, or the repo root. */
  cwd: string;
  /** Live claude session of the currently running agent step, if any. */
  session?: AgentSession;
  currentStepId?: string;
  idleTimer?: NodeJS.Timeout;
  /** The idle timer fired and closed the live session to free the backend process (its memory
   *  bound, AGENTS.md). Distinguishes that inactivity park from a genuine completion in the
   *  post-`session.result` wrap-up: an idle-parked run KEEPS `status: 'waiting'` (needs-you /
   *  in-progress) instead of settling `done`/`review`, and resumes via `--resume` on the next
   *  message (spec 2026-08-20-inactive-sessions-stay-in-progress). Never persists — a parked run
   *  leaves the active map. */
  idleParked?: boolean;
  monitoringWakeTimer?: NodeJS.Timeout;
  monitoringWakeIntervalMinutes?: number;
  monitoringWakeups?: number;
  /** Bounded re-emit nudges spent on this run (cap `MAX_ASK_STRUCTURE_NUDGES`).
   *  Process-local by design, like `monitoringWakeups`: a restart is a fresh epoch. */
  askStructureNudges?: number;
  autosaveTimer?: NodeJS.Timeout;
  leaseTimer?: NodeJS.Timeout;
  leaseRoots?: string[];
  /* The screenshot counter lives on `RunManager.queuedImageSeq` (#472), keyed by
   * run id — a queued run persists attachments with no `ActiveRun` at all. */
  /** Has a session EVER opened on this run (#472)? `session` alone cannot answer
   *  it — teardown sets it back to `undefined`, so a closed session and one that
   *  never opened look identical. This distinguishes "still starting up, buffer
   *  the message" from "genuinely closed, 409". */
  sessionEverOpened?: boolean;
  /** Autonomous mode (#autonomous): never park at `waiting` — auto-nudge the agent to keep
   *  going until it signals done or the safety cap is hit. */
  autonomous?: boolean;
  autoContinues?: number;
  /**
   * The bound (PLAN D27, Phase 1 of `.ai/specs/2026-08-15-autonomous-implementation-continuation.md`):
   * set the moment `config.stepBudget` is spent, by whichever turn-end handler (`runAgentStep` or
   * `runContinuation`) or `execute()`'s loop-top check notices it first. A workflow's `steps` list
   * is fixed, so counting only step-loop entries cannot bound the actual runaway vector — an open
   * agent session self-continuing (follow-ups, `CEZ:MONITORING` nudges, monitoring wake-ups) turn
   * after turn without ever returning to that loop. `state` is what every one of those call sites
   * shares, so it is what carries this signal between them, telling the caller that just-completed
   * work must be the LAST work this run does — land `review` + `stopReason: 'budget'`, not `done`.
   */
  budgetExceeded?: boolean;
  /**
   * The `CEZ:REVIEW=pass|revise` verdict the CURRENT agent step declared (spec
   * `.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md`, P2). Set from the
   * turn-end handler, read and cleared by `execute()`'s step loop once the step returns — the
   * same shape `stepStopped` already uses, and for the same reason: the loop does not own the
   * session's turns, so the signal has to travel on the state both sides share.
   */
  reviewVerdict?: ReviewVerdict;
  /** The reviewing turn's full report — what a `revise` verdict hands to the retried step. */
  reviewReport?: string;
  /** Resolver for a run parked on a human approval gate (spec 2026-08-20, P3). Present ONLY
   *  while parked; `approve`/`requestChanges` call it, `cancel` aborts it. */
  approvalWaiter?: (outcome: ApprovalOutcome) => void;
  /**
   * A continuation ended its turn with `CEZ:DONE` while its run's CHAIN still had pending steps
   * (spec 2026-08-20, P2). The marker is a statement about the agent's OWN step, so the session
   * closes — but the run must be handed back to the chain, not settled. Carried on `state` for
   * the same reason `budgetExceeded` is: the turn-end handler cannot see the post-`session.result`
   * wrap-up that has to act on it.
   */
  chainHandBack?: boolean;
  /**
   * Cezar itself stopped the running agent session — the inactivity bound fired
   * (`.ai/specs/2026-08-20-agent-step-stopped-is-not-failed.md`), the agent did not fail.
   *
   * Carried on `state` for the same reason `budgetExceeded` is: the runner reports it through an
   * `error` event inside `onEvent`, and `execute()`'s step loop — which is what has to decide
   * `review`-not-`failed`, and whether to re-enter the step — cannot see that event while its
   * `await this.runAgentStep(...)` for that very step is still in flight. Set per step attempt,
   * consumed by the step loop.
   */
  stepStopped?: AgentStopReason;
  /** A newly launched broker exhausted its control-channel budget before any request succeeded. */
  brokerNeverAnswered?: { spoolDir: string; message: string };
  /** Registry snapshot used to expand `/skill` follow-ups before a backend can
   *  mistake them for its own slash commands (#676). */
  skills?: Skill[];
  /** Release for exclusive execution in the user's repository working tree.
   *  Worktree-backed runs never need it; root runs ordinarily do unless the
   *  explicit unsafe bypass is active. */
  releaseRepoRoot?: () => void;
  /** Durable directional-usage accounting state for the current runner
   * invocation. Provider-local turn ids are unique only within this epoch. */
  usageInvocation?: {
    stepId: string;
    epoch: number;
    observed: boolean;
    startedTurns: Set<string>;
    recordedTurns: Set<string>;
    /** A real backend-reported context-window max for THIS invocation (today: codex's
     *  `usage.updated`), scoped to the invocation because a fresh backend process may report a
     *  different figure next time. Threaded as `reportedWindow` into every subsequent
     *  `contextTokens`-bearing patch so it wins over the model-string guess (spec
     *  2026-08-22-context-window-denominator-per-step). */
    reportedContextWindow?: number;
  };
}

/** Safety cap on autonomous auto-continues per run — stops a stuck agent from nudging forever. */
const MAX_AUTO_CONTINUES = 40;
const AUTONOMOUS_NUDGE =
  'Continue working autonomously until the task is fully complete. Do not ask me for confirmation or clarification — make reasonable assumptions and proceed. When everything is done, end the session with your done signal.';
const MONITORING_WAKE_NUDGE =
  'Re-check the downstream work you were monitoring. Continue toward the task goal; emit CEZ:MONITORING again only if it is still pending.';
/** One nudge per run (spec 2026-08-23-plain-end-structured-question, D6): an agent that declined
 *  once has answered the question, and a cap of one cannot loop by construction. */
const MAX_ASK_STRUCTURE_NUDGES = 1;
/** The sentinel substring (`You ended that turn with no marker`) is matched literally by the
 *  bundled dry-run mock's `mock:ask-on-nudge` verb — the mock is a separate process and never
 *  imports this constant. */
const ASK_STRUCTURE_NUDGE =
  'You ended that turn with no marker, which parks the task and tells the user to reply — but the cockpit has nothing for them to tap. If you were asking them something, send it again now as a single CEZ:ASK <json> line with 2–4 concrete options. If you were NOT asking anything, end plainly again, or with CEZ:DONE if the goal is achieved — do not invent a question.';

/** Stop both halves of a broker launch before its spool is replaced by a retry. Best effort.
 *  Distinct from `reapAbandonedBroker` (`../core/reap-abandoned-broker.ts`), which stops a
 *  broker the replacement server refused to adopt across a blue-green cutover — different
 *  trigger, different signature (spool dir here vs. run id + meta there). */
export function reapAbandonedColdLaunch(spoolDir: string): void {
  const meta = readSpoolMeta(spoolDir);
  if (!meta) return;
  for (const pid of [meta.childPid, meta.pid]) {
    if (pid === undefined || !isPidAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already exited or not signalable. Reaping must not turn a retryable step into a failure.
    }
  }
}

/**
 * Auto-resume after a provider usage limit (spec 2026-08-03-auto-resume-after-usage-limit).
 *
 * The wait is the provider's own reset instant plus this grace: resuming AT the boundary races the
 * provider's clock (and its rounding), and one failed resume costs the whole window over again.
 * Thirty seconds is cheap next to five hours and long enough to be past any sane skew.
 */
export const AUTO_RESUME_GRACE_MS = 30_000;
/**
 * Consecutive automatic resumes allowed without a human turn. A resume can only fire after a real
 * reset instant, so this is not a throttle — it is the backstop for the pathological case (a
 * provider that answers "limit reached, retry now" in a loop), and it is deliberately generous
 * enough to sit through a couple of days of five-hour windows.
 */
export const MAX_AUTO_RESUMES = 12;
/**
 * How long a missed deadline stays worth acting on. The promise is "we pick this up when the
 * window reopens" — kept across a restart or an overnight close, which is the case the feature
 * exists for. A day later it is no longer that promise: the user has moved on, and a task
 * springing back to life is a surprise rather than a service. Such a deadline is retired with a
 * note instead of fired, so the only tasks a sweep can revive are ones someone is still waiting on.
 */
export const AUTO_RESUME_MISSED_WINDOW_MS = 24 * 60 * 60_000;

/**
 * How often the queue checks that it is not wedged.
 *
 * A hold is the only thing in the engine that can make an idle queue CORRECT, so it is also the
 * only thing that can make a wedged one look correct. This tick is the way out: cheap (a few
 * in-memory checks), unref'd, and it only ever acts when idling has no justification left.
 */
export const QUEUE_WATCHDOG_MS = 60_000;
/** Shared empty holds for the common "nothing is held" pump — avoids allocating per sweep. */
/** How often a brokered run's consumed byte offset is written to `runs.json`. */
const OFFSET_PERSIST_MS = 1_000;

const NO_HOLDS: AccountHolds = { deadline: new Set(), inFlight: new Set() };

/**
 * May this run start, given what its account is holding?
 *
 * The two kinds of hold bind different work, and getting that wrong has produced a bug in each
 * direction (spec 2026-08-03-auto-resume-after-usage-limit):
 *
 *  - a `deadline` hold means the window is KNOWN shut until an instant, so it blocks everything
 *    on that account — resumes included. Exempting them let four resumes fire at once and
 *    re-limit one after another, which is the stampede wearing a different hat.
 *  - an `inFlight` hold means a resume is testing the window right now and nothing is proven, so
 *    it blocks fresh work but not other resumes. Blocking those deadlocked a live workspace.
 */
function accountHeldOn(
  key: string,
  run: Pick<RunRecord, 'status' | 'autoResumeAttempts'>,
  holds: AccountHolds,
): boolean {
  if (holds.deadline.has(key)) return true;
  return holds.inFlight.has(key) && !resumeInFlight(run);
}

/**
 * The same question about the account the RUN RECORD names — admission's default reading.
 *
 * The key is a parameter above rather than derived here because the queue has to ask about TWO
 * accounts, not one: this one, and the account the spawn gate has already refused this run on.
 * See `heldAccountFor`, and the production busy-loop that forced the split.
 */
function accountHeldFor(
  run: Pick<RunRecord, 'runner' | 'agentProfile' | 'status' | 'autoResumeAttempts'>,
  holds: AccountHolds,
  fallbackRunner: RunnerId,
): boolean {
  return accountHeldOn(runAccountKey(run, fallbackRunner), run, holds);
}

// `runAccountKey` — which agent ACCOUNT a run's work runs on (spec
// 2026-08-03-auto-resume-after-usage-limit) — MOVED 2026-08-23 to
// `@loki-labs/better-cezar-contract` (`usage-hold.ts`), and SPLIT IN TWO there (spec
// 2026-08-23-usage-limit-hold-account). The single function that used to sit here answered the
// admission question ("where will this run's work go?") and was then also used for the hold
// question ("which account did a provider refuse?"), which are not the same question whenever a
// workflow step pins its own runner or the pool routes two steps to two logins. `runAccountKey`
// keeps the first; `usageHoldAccountKey` answers the second off the STEP that actually ran.
// Measured cost of conflating them: a codex task held for hours by a Claude weekly limit, while a
// claude task would not have been held at all. It also had to leave this module so the browser
// could import it — see the contract file's own docblock.

/**
 * Is this run an automatic resume that has not completed a turn yet?
 *
 * Such a run is the work the reopened window is FOR, so the hold must never apply to it — not
 * its own, and not another resume's. Two resumes that hold each other is a deadlock the queue
 * cannot recover from: both sit `queued` with a counter and no deadline, each waiting for the
 * other to prove a window neither will ever get to test. That is the shape a live run produced
 * — two scheduled tasks fired, both went `queued`, and nothing in the workspace moved again.
 *
 * The hold exists to stop NEW work walking into a closed window. A resume is not new work.
 */
function resumeInFlight(run: Pick<RunRecord, 'status' | 'autoResumeAttempts'>): boolean {
  return (
    run.autoResumeAttempts !== undefined && (run.status === 'queued' || run.status === 'running')
  );
}

const AUTO_RESUME_PROMPT =
  'The provider usage limit that interrupted this task has reset. Read the handoff file (CEZ_HANDOFF_FILE) to recover context, then continue the task from where you left off.';
/**
 * The wake instant as a human reads it — local, to the SECOND, with the zone named. The
 * transcript line is what someone scanning a stalled task actually reads, and "18:41" is not
 * enough to tell a wait that is nearly over from one that just started; the machine-readable ISO
 * copy lives on `RunRecord.autoResumeAt`. Server-side formatting is honest here because cezar is
 * local-first: the process and the browser reading it are the same machine.
 */
function formatWakeInstant(at: Date): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' }).format(at);
}

/**
 * What EXECUTING a run needs — everything `execute()` reads, and nothing about who asked for it.
 *
 * Split out from `StartRunInput` below (spec 2026-08-21-task-author-provenance) for a reason that
 * is load-bearing rather than cosmetic: `pendingJobs` holds one of these, and the two RECOVERY
 * paths (`reviveQueuedRun`, chain re-entry) rebuild one from a record for a run that ALREADY
 * EXISTS. Authorship is a fact of the record at that point, stamped once and never rewritten, so
 * a recovered job has nothing to say about it — and requiring a value there would have forced
 * exactly the invented `system` placeholder the required field exists to prevent.
 */
export interface ExecuteRunInput {
  task: string;
  model?: string;
  /** Agent backend chosen for this task (GUI). Unset = the config default. */
  runner?: RunnerId;
  /** Agent account for this task (spec 2026-07-29-agent-profiles), applying to steps that run
   *  on `runner`. Unset = the project's own selection. Persisted on the record so the choice
   *  survives into resume and Continue, and so the thread can say which account did the work. */
  agentProfile?: string;
  /** Screenshots pasted into the new-task form — persisted when the run is
   *  created and delivered once, with the first agent step's opening message. */
  images?: ContentBlock[];
  /** Per-run system-prompt override (`POST /api/runs`, programmatic callers).
   *  Replaces the `config.json` default for this run — see
   *  `resolveExtraSystemPrompt` for the precedence contract. */
  systemPrompt?: string;
  /** Composer opt-out (#worktree-toggle): `false` runs the task in the repo
   *  working tree instead of an isolated worktree. Undefined/`true` keeps the
   *  default per-task worktree. Ignored for variants (they always isolate). */
  worktree?: boolean;
  /** WORKSPACE RUN (spec 2026-08-15-cross-project-workspace-run): every registered project this
   *  run may read and write outside its cwd. Set only by `POST /api/v1/workspace/runs`; an
   *  ordinary project run leaves it undefined and behaves exactly as it always has. Persisted at
   *  creation and re-applied from the RECORD on every later step, so the grant cannot drift when
   *  the registry changes mid-run. */
  workspaceProjects?: GrantedProject[];
  /** Autonomous mode (#autonomous): the run never parks at `waiting` for the
   *  user — turn-ends auto-continue until the agent signals done or the safety
   *  cap is hit. No "needs you" is ever raised. */
  autonomous?: boolean;
  /** Per-run override of `config.stepBudget` (PLAN D27 Phase 3): set by the notes continuation
   *  trigger when the target project never configured one, so an autonomous implementation run is
   *  never unbounded. See `stepBudgetOverride`'s doc comment in `runs/store.ts`. */
  stepBudgetOverride?: number;
  /** Follow-up inbox generation (spec 007, #444). Omitted means enabled for
   *  compatibility; the handoff journal runs either way. */
  generateFollowups?: boolean;
  /** Attachments from the queued prompt stack (#472), re-encoded from disk by
   *  `hydrateQueuedInput` at dequeue. Kept separate from `images` because those
   *  are persisted into `taskImages` by `startRun()` — folding
   *  the stack's (already-persisted) files in there would write duplicate files
   *  and make the task bubble render the stack's images as its own. In-memory
   *  only: rebuilt from the record on every hydration, never persisted. */
  stackedImages?: ContentBlock[];
}

/**
 * What CREATING a run needs: everything execution needs, plus WHO created it.
 *
 * `author` is REQUIRED (spec `.ai/specs/2026-08-21-task-author-provenance.md`), and required here
 * rather than only on `RunStore.createRun`, because three of the creation paths — `cezar run` and
 * the two notes triggers — never touch the store directly. Requiring it at both boundaries is what
 * makes `npm run typecheck` fail for the ninth creation path exactly as it did for the first
 * eight; there is deliberately no default and no fallback, since a default is precisely what
 * would let a real path ship unattributed.
 *
 * Build it with one of the constructors in `../runs/task-author.ts` (`authorFromRequest` /
 * `authorFromAgentEnv` / `inheritAuthor` / `agentAuthor` / `automationAuthor` / `localCliAuthor` /
 * `systemAuthor`), never with a literal — the `kind`/`id` pairing is decided there, once.
 */
export interface StartRunInput extends ExecuteRunInput {
  author: TaskAuthor;
}

/**
 * The effective "extra" system prompt for a run (spec §protocol v2, R2 2.3):
 * the per-run override (`POST /api/runs` `systemPrompt`) REPLACES the
 * `config.json` default — they are the same knob at two scopes, so the more
 * specific one wins outright; they never concatenate. Whichever wins is
 * ADDITIVE to the skill body and the handoff contract, which always ride
 * along (see `composeSystemPrompt`). Blank strings count as unset.
 */
export function resolveExtraSystemPrompt(
  override: string | undefined,
  configDefault: string | undefined,
): string | undefined {
  return override?.trim() || configDefault?.trim() || undefined;
}

/**
 * How an agent step should SPEND its tool calls (spec
 * `.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md`, Phase 2 — "code mode").
 *
 * **Why this exists at all.** Run `ec6e8e06` took 61.5 minutes and made 271 tool calls at a
 * measured **1.00 calls per model round trip** — it never once put two independent calls in one
 * turn. 231 of those calls (85%) finished in under a second and did 29 seconds of real work
 * between them, while costing ~23.5 minutes of round trips at a median 6.1 s gap. Nothing in the
 * composed prompt had ever said how to spend a tool call, so the model spent them one fact at a
 * time. `cez run stats <runId>` is the meter that proves or disproves the fix.
 *
 * Rides on EVERY agent step and every Continue turn, before the handoff contract, because the
 * economics are the same whichever step is running. Kept short on purpose (R7: prompt bloat) —
 * and it is cache-read, not re-input, on every turn after the first (`ec6e8e06` billed 599 k
 * cacheRead against 10 input tokens), so its marginal per-turn cost is near zero.
 *
 * The `set +e` / delimiter / bound rules are not style: they are R1 and R2 from that spec. A
 * batch under `set -e` hides every section after the first failure, and an unbounded batch is
 * strictly worse than the calls it replaced.
 *
 * **Bullet 3 names the waiting mechanism because the first version did not** (spec
 * `.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md`). It used to say "wait for it before
 * you report" and stop there, so agents supplied the mechanism themselves and guessed a duration:
 * measured across the five run transcripts on the prod box, 7 blind `sleep N` waits (1.8 min) —
 * the archetype being `sleep 120; tail -12 /tmp/full-suite-mine.log` — against 32 bounded poll
 * loops, which are the CORRECT pattern and exit when the job does. Hence three tiers in
 * preference order (foreground + redirect · background + completion signal · block on the marker)
 * and an explicit ban on a bare `sleep N`. The `never end your turn while it runs` clause closes
 * run `23221162`'s hole, where `run-tests` backgrounded `npm test` and reported done while it ran.
 *
 * The re-read clause carves the expensive case out of bullet 1's bounding rule, which is correct
 * for cheap reads and had no exception: on run `7c2dd8f0`, 18 repeated expensive calls cost 5.9
 * minutes, headed by one test file re-run **11 times** only to see a different output filter.
 * `blindSleepCalls` and `repeatedExpensiveCalls` in `cez run stats` are the meter for both.
 *
 * It names **no backend-specific tool or parameter** — not even `run_in_background`, which is a
 * Claude Code Bash parameter — because this text is also prepended to codex, opencode and pi
 * prompts (`core/agent-runner.ts`). Tiers 1 and 3 are pure POSIX shell and are the two preferred
 * ones, so a backend that models no background work at all loses nothing. `system-prompt.test.ts`
 * asserts that absence rather than trusting it.
 */
export const TOOL_BUDGET_DOCTRINE = `## Tool budget (cezar)

Round trips make a step slow, not tool execution: a measured cezar run spent 23 of its 61
minutes on 231 sub-second shell calls issued one per turn. Spend a tool call as if it costs six
seconds, because it does.

- **Batch cheap reads into ONE script.** Several independent facts, each a cheap shell command,
  are one call. Use \`set +e\` so a missing file does not abort the rest, delimit each section
  (\`printf '\\n===== %s =====\\n'\`), and bound every section (\`head\`, \`sed -n\`) so the batch
  cannot flood your context. Echo \`$?\` where success matters; read every section.
- **Emit independent tool calls in ONE turn.** Different tools, or one slow call beside several
  fast ones, cost a single round trip together — but only with **no dependency between them**. A
  write and a read of the same path stay serial, and a probe whose answer decides the next
  command is not independent of it.
- **Background what is genuinely slow; wait on the process, never on a guess.** Send its output to
  a file (\`cmd >"$f" 2>&1; echo EXIT=$?\`). Foreground it unless you have work to overlap; if you
  do, background it and wait for the completion signal, or block on the marker
  (\`until grep -q EXIT= "$f"; do sleep 5; done\`) — never a bare \`sleep N\`, and never end your turn
  while it runs. Re-read \`$f\` for a different slice; never re-run an expensive command. Never
  background anything that mutates the git index.`;

/**
 * Joins the parts of one agent step's system prompt in fixed order — skill
 * body (most task-specific), then the run's extra prompt (user guidance, can
 * amend the skill), then the tool-budget doctrine, then the handoff contract
 * (always last, never optional in practice). Blank parts drop out; survivors
 * join with the same `\n\n---\n\n` divider the skill+handoff composition has
 * always used.
 */
export function composeSystemPrompt(...parts: Array<string | undefined>): string {
  return parts
    .map((p) => p?.trim())
    .filter((p): p is string => Boolean(p))
    .join('\n\n---\n\n');
}

/**
 * The directories a spawned agent may reach outside its worktree: the run-state
 * folder that holds its handoff file, plus its own temp directory when this run
 * got one (#785). Handing an agent a `TMPDIR` its file tools are not allowed to
 * write would trade one silent failure for another, so the two travel together;
 * under `CEZ_AGENT_TMPDIR=0` there is no per-run directory and the list is
 * exactly what it always was.
 */
export function agentDirectories(runsDir: string, env: Record<string, string>): string[] {
  return env.TMPDIR ? [runsDir, env.TMPDIR] : [runsDir];
}

/**
 * A workspace run's grant, rebuilt from its OWN RECORD — never from the registry
 * (spec 2026-08-15-cross-project-workspace-run).
 *
 * That distinction is the whole reason this is a function and not an inline read. `buildWorkspaceGrant`
 * is pure, so calling it here on every step and every resume costs nothing and can never observe a
 * registry that changed since the run started: a project added an hour into a long run does not
 * silently join the grant, and one removed does not silently leave it. `undefined` for every
 * ordinary project run, which is every run that is not this one kind.
 */
export function workspaceGrantOf(
  run: { workspaceProjects?: GrantedProject[]; workspaceWorktrees?: WorkspaceWorktree[] } | undefined,
): WorkspaceGrant | undefined {
  const projects = run?.workspaceProjects;
  if (!projects || projects.length === 0) return undefined;
  // Parallel workspace run (spec 2026-08-19): once its per-project worktrees exist, the grant —
  // both `--add-dir` and the prompt text — points at the worktrees, not the real checkouts.
  return buildWorkspaceGrant(projects, run?.workspaceWorktrees ?? []);
}

/**
 * Materialized pasted attachment: the on-disk name/serving-URL pair the
 * transcript already used, plus the absolute path that lets the agent
 * operate on the file itself — save it, `cp` it, attach it to a GitHub
 * issue/PR (#357). `path` is only ever an absolute path under
 * `.ai/cezar/runs/<runId>-images/` (see `RunManager.persistImage`).
 */
/** Inverse of `persistImage`'s extension mapping (#472) — a persisted attachment
 *  is re-encoded from disk at dequeue and needs its media type back. */
export function mediaTypeFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  return ext === 'jpg' ? 'image/jpeg'
    : ext === 'webp' ? 'image/webp'
    : ext === 'gif' ? 'image/gif'
    : 'image/png';
}

/** Highest `<prefix>-<n>.<ext>` suffix already present in a run's image dir (#472).
 *  `screenshot-*` and `pasted-*` share one numbering space, so this scans both and
 *  returns 0 for a missing/empty directory. */
export function highestImageSeq(dir: string): number {
  try {
    return readdirSync(dir).reduce((max, name) => {
      const m = /^(?:screenshot|pasted)-(\d+)\./.exec(name);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
  } catch {
    return 0;
  }
}

export interface PersistedAttachment {
  name: string;
  url: string;
  path: string;
}

/**
 * Plain-text note listing the absolute paths of pasted attachments, appended
 * to the message that carries them (#357). The base64 image blocks stay in
 * the message for the model to *view*; this note is what lets it *use* the
 * files as files — and the only usable reference on backends (codex,
 * opencode) whose `textOf()` drops image blocks before reaching the model.
 */
export function pastedAttachmentsText(attachments: PersistedAttachment[]): string {
  const list = attachments.map((a) => `- ${a.path}`).join('\n');
  return (
    `The user attached ${attachments.length} pasted file${attachments.length > 1 ? 's' : ''}, ` +
    `also saved on disk at:\n${list}\n` +
    `When the task involves saving, uploading, attaching, or transforming the pasted content ` +
    `(e.g. attaching to a GitHub issue/PR, copying into the repo), operate on these files — do ` +
    `not attempt to reconstruct them from the conversation.`
  );
}

/** Same note as `pastedAttachmentsText`, wrapped as a trailing `ContentBlock`
 *  ready to append to a message's content array. */
export function pastedAttachmentsNote(attachments: PersistedAttachment[]): ContentBlock {
  return { type: 'text', text: pastedAttachmentsText(attachments) };
}

/** Variant letters + the fixed diversification hints (spec 010). A runs the
 *  task verbatim; B/C get one constant sentence each — zero configuration. */
export const VARIANT_LETTERS = ['A', 'B', 'C'] as const;
const VARIANT_HINTS: Record<string, string | undefined> = {
  A: undefined,
  B: 'Approach hint: prefer the minimal, surgical change.',
  C: 'Approach hint: prefer a thorough, structural approach.',
};

const RESTART_CONTINUATION_PROMPT =
  'The cezar process restarted while you were working on this task. Read the handoff file (CEZ_HANDOFF_FILE) to recover context, then continue the task from where you left off.';

/**
 * cezar's own synthetic continuation prompts (spec 2026-08-22-continue-step-naming) — excluded
 * from Phase 1's "name the step from what the user typed" naming so a restart/auto-resume
 * continuation does not mint a step titled after its own boilerplate prompt text
 * ("the cezar process restarted while you wer…"). A human-authored prompt, even one that also
 * happens to defer for capacity (`reopen-watch.ts`'s reopen sweep), is never in this set.
 */
const SYNTHETIC_CONTINUE_PROMPTS: ReadonlySet<string> = new Set([
  RESTART_CONTINUATION_PROMPT,
  AUTO_RESUME_PROMPT,
]);

/** Suffix Phase 2 (spec 2026-08-22-continue-step-naming) appends when naming a new `continue-N`
 *  step after the real step it's retrying. */
const CONTINUED_STEP_SUFFIX = ' — continued';

/**
 * `` `${sessionStep.name} — continued` `` — but clamping `sessionStep.name` itself first, using
 * the same code-point slicing and ellipsis-on-overflow `postValidateTitle` uses. Deliberately NOT
 * `postValidateTitle` on the composed string: that would lowercase the first character (turning
 * "Deploy — continued" into "deploy — continued") and clamp the WHOLE composed string to
 * `TITLE_MAX`, which truncates the suffix away entirely on a step name over ~27 characters.
 */
function continuedStepName(sessionStepName: string): string {
  const limit = TITLE_MAX - CONTINUED_STEP_SUFFIX.length;
  const chars = [...sessionStepName];
  const clamped =
    chars.length > limit ? `${chars.slice(0, limit - 1).join('').trimEnd()}…` : sessionStepName;
  return `${clamped}${CONTINUED_STEP_SUFFIX}`;
}

/**
 * The prompt a step gets when it is re-entered after CEZAR stopped it for inactivity.
 *
 * It resumes the SAME session, so the work so far is already in context. What the agent does not
 * know is why its turn ended — and an agent that assumes it crashed re-does finished work.
 * Deliberately different from `RESTART_CONTINUATION_PROMPT`: a restart lost the process, this did
 * not. The instruction that matters is "land what you have", because the same bound is armed
 * again for the retry and a second stop ends the run.
 */
export function stoppedContinuationPrompt(_reason: AgentStopReason): string {
  return (
    'Your previous turn did not end on its own — cezar stopped the session because it had ' +
    'produced no output for too long. Nothing you already did was undone: this is the same ' +
    'session, so check the work on disk before redoing any of it. Prioritise landing what you ' +
    'have — finish the current change, update the handoff file (CEZ_HANDOFF_FILE), and end the ' +
    'turn. This is the one automatic retry; the same limit is armed again.'
  );
}

/**
 * The restart prompt, told where in the chain it landed (spec 2026-08-20, P3). The engine and
 * the prompt have to say the same thing about what `CEZ:DONE` means: without the chain position
 * a resumed step reads its own handoff notes, concludes the task is achieved and ends the run.
 */
export function restartContinuationPrompt(chain?: { position: number; total: number }): string {
  if (!chain || chain.total <= 1) return RESTART_CONTINUATION_PROMPT;
  return (
    `${RESTART_CONTINUATION_PROMPT} This run is a chain of ${chain.total} agent steps and you are ` +
    `resuming step ${chain.position} of ${chain.total} — finish THIS step's own work; the chain ` +
    `continues after it.`
  );
}

/**
 * Wraps feedback destined for a re-entry into the `spec` step with a fixed instruction: apply it
 * as targeted edits, don't re-emit the whole file. Used at every place in this file that builds
 * feedback text for THAT step specifically — never at the generic `checkFailure` wrapper in
 * `runAgentStep`, which stays step-agnostic (spec .ai/specs/2026-08-21-structured-review-targeted-
 * spec-edits.md).
 *
 * `specPath`, when known, is `RunRecord.declaredSpecPath` (`store.ts:291`) — the concrete path the
 * `spec` step itself declared on an earlier turn via `CEZ:SPEC_PATH=` (`applyTurnMarkers`,
 * `run.ts:4969-4970`). It is NOT guaranteed to be set — measured on this task's own run, it isn't —
 * so the `undefined` branch below is the case to design for, not an edge case.
 */
export function specRevisionFeedback(report: string, specPath?: string): string {
  const locate = specPath
    ? `Changes were requested for the spec at \`${specPath}\`.`
    : [
        'Changes were requested for the spec. This run never recorded its path, so before doing',
        "anything else: find the existing file from the change list's own FILE: line(s) below, then",
        "`ls .ai/specs/` or `git status` if a path doesn't resolve from your working directory. A",
        'repo can have more than one `.ai/specs/` directory (for example a worktree plus the main',
        "checkout) — if a path doesn't exist relative to your cwd, that means look elsewhere, not",
        'that it needs to be created. Never write a second copy of the spec under a new path.',
      ].join('\n');
  return [
    locate,
    'Open the EXISTING file and apply each item below as a TARGETED EDIT to the section it names —',
    'Read, then Edit (old_string → new_string), the same rule FILE_WRITE_RECIPE already gave you.',
    'Do NOT re-emit or rewrite the whole file — no `cat > … <<EOF`, no full-file `Write` — unless',
    'the notes below themselves say the changes touch most of the document and call for a',
    'structural rewrite, or unless the items below, TAKEN TOGETHER, change most of the file — judge',
    'by how much of the file changes, exactly as FILE_WRITE_RECIPE already told you. Rewriting the',
    'file to fix three sections is the failure; rewriting it because the list genuinely touches',
    'nearly every section is not. Every section the notes below do not name must come out',
    'byte-identical.',
    '',
    'The requested changes:',
    '',
    report,
  ].join('\n');
}

/**
 * Where a chain picks back up (spec 2026-08-20, P1/P2) — the first definition step that has
 * not reached a terminal state, plus the interrupted session to reattach to when there is one
 * and it is safe. In-memory only: it rides in `pendingJobs` alongside the revived workflow and
 * is recomputed from the record on every re-entry, so nothing about it needs persisting.
 */
interface ChainResumePoint {
  /** Index into the revived `WorkflowDef.steps`. */
  index: number;
  /** Present only when that step already had a session this process may reattach to.
   *  `verifyTranscript` marks it (spec 2026-08-22-resume-fresh-session-fallback, Phase 1): every
   *  handle built here is a session id recorded by an EARLIER process invocation, of ambiguous
   *  confirmation status — never a session this same process just observed running, the way a
   *  cezar-initiated stop's own retry (`stopResume`, `execute()`'s chain loop) is. `runAgentStep`
   *  reads it to decide whether the Claude-only proactive existence check applies; a `stopResume`
   *  handle deliberately does not set it, or the check would downgrade a session that was
   *  confirmed alive moments ago whenever the dev box's real `~/.claude/projects` (or a test's
   *  unrelated `CLAUDE_CONFIG_DIR`) happens not to carry its transcript — losing the in-progress
   *  work the stop-retry exists to preserve, and reproducing the stop as a second, terminal one. */
  resume?: { sessionId: string; profileId?: string; prompt: string; verifyTranscript?: true };
  /**
   * Why the chain is re-entering here, in the words the resumed step should act on. Seeded into
   * `checkFailure`, the channel that appends explanatory text to a retried agent's prompt.
   *
   * One caller today: a "request changes" that arrives while the run is NOT active — a restart
   * killed the `execute()` that was parked on the approval gate (spec 2026-08-20, P3). Without
   * it the spec step would be re-run with no idea what the reviewer objected to, which is the
   * same defect as re-running a failed check without showing the failure.
   */
  feedback?: string;
}

interface PendingContinuation {
  stepId: string;
  sessionId: string | undefined;
  backend: RunnerId;
  prompt: string;
  images: ContentBlock[];
  /** The step's computed title (spec 2026-08-22-continue-step-naming), carried through a deferred
   *  continuation so its eventual `step-start` event and `StepState.name` agree with what was
   *  computed at `continueRun` time, not a re-derived (and possibly synthetic-prompt-derived)
   *  value at dequeue. */
  name: string;
  nameOrigin: 'step' | 'prompt';
}

interface PersistedImages {
  blocks: ContentBlock[];
  attachments: PersistedAttachment[];
}

/**
 * The mini workflow engine: executes a `WorkflowDef` against a repo, one step
 * at a time, persisting every event to the RunStore (which the SSE endpoints
 * relay live to the GUI). No GitHub choreography — agent steps and shell
 * checks with bounded retry loops, plus live sessions: the last agent step
 * stays open for follow-ups (`waiting`) until "finish", idle timeout, or
 * cancel. Runs queue behind the workspace-wide `maxParallel` slots (the shared
 * `WorkspaceSemaphore`, spec 2026-07-20 step 2.5) and each run executes in its
 * own git worktree on a `cez/<id8>` branch (spec 006), autosave-committed at
 * turn end and before a draft PR — plus every 90 s when opted in via
 * CEZ_AUTOSAVE=1 (#471). Each autosave records its trigger in the commit
 * subject, so the always-on flushes are not mistaken for the opt-in timer.
 * The user's working tree is never touched.
 */
export class RunManager {
  private readonly active = new Map<string, ActiveRun>();
  // Queue + `starting` set (spec 006, janitor's pump() pattern): `starting`
  // covers the window between shifting a run off the queue and the run
  // registering in `active`, so parallel-slot counting is never racy.
  private readonly queue: string[] = [];
  private readonly starting = new Set<string>();
  // Runs parked at `waiting` (open session, ball in the user's court). They
  // don't consume a `maxParallel` slot (#347) — an idle claude process costs
  // memory but no tokens, queued work progressing matters more, and the idle
  // timeout already bounds how long a session can sit open. Invariant:
  // `waiting ⊆ active` — always cleared together via dropActive().
  private readonly waiting = new Set<string>();
  /** Durable monitoring subset. Only the configured number receives the waiting-slot exemption. */
  private readonly monitoring = new Set<string>();
  private readonly pendingJobs = new Map<
    string,
    { workflow: WorkflowDef; input: ExecuteRunInput; resumeAt?: ChainResumePoint }
  >();
  /** Steps left in the chain at this run's last hand-back (spec 2026-08-20, R4). A re-entry that
   *  does not strictly reduce it is a loop, not progress, and fails the run loudly instead of
   *  spinning. Process-local: a restart re-arms it from the record on the first hand-back. */
  private readonly chainReentries = new Map<string, number>();
  /**
   * Runs whose next agent step must RE-ATTACH to a live broker rather than spawn one (P4 of
   * `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`).
   *
   * A side channel rather than another parameter threaded through `execute()` → `runAgentStep()`,
   * and that is a deliberate trade: the alternative is widening two long signatures and every
   * call site of both for a value that is set in exactly one place (`recover`) and read in exactly
   * one place (the spawn seam). Entries are consumed on first read and dropped whenever the run's
   * step turns out not to match, so a stale entry cannot re-attach a later step to an older spool.
   */
  private readonly pendingReattach = new Map<string, { stepId: string; spoolDir: string; startOffset: number }>();
  /** Last `consumedOffset` written per run, so the tail's 50 ms cadence does not become a 50 ms
   *  write cadence on `runs.json`. */
  private readonly offsetWrites = new Map<string, { offset: number; written: number; at: number }>();
  /** Cached once `'scope'` is seen, but re-probed on every call until then.
   *  CORRECTED 2026-08-22: this used to say the answer "cannot change without the process being
   *  restarted anyway" and cache unconditionally — false whenever `cezar.service` starts before
   *  `user@<uid>.service` has finished booting, which pins the probe to a non-`'scope'` result for
   *  the rest of the process's life (`.ai/specs/2026-08-22-broker-scope-isolation-full-stop-survival.md`,
   *  Phase 0.3). `'scope'` is the only outcome that cannot regress on its own, so it is the only one
   *  worth caching. */
  private brokerIsolationCache?: BrokerIsolation;
  /** Last non-`'scope'` value already warned about, so `brokerIsolation()` logs once per distinct
   *  degraded result rather than once per call — it is consulted per health/ready poll
   *  (`server.ts`'s `describeRuntime`), not only per run-start. */
  private brokerIsolationWarnedFor?: BrokerIsolation;
  /** Interrupted agent turns recovered after a process restart. Unlike an
   *  explicit user Continue, these are bulk scheduler work and must re-enter
   *  through `pump()` so both workspace and per-project caps are honored. */
  private readonly pendingContinuations = new Map<string, PendingContinuation>();
  /** Per-run image counter behind `pasted-<n>` / `screenshot-<n>` (#472). Lives on
   *  the manager rather than the `ActiveRun` so a *queued* run — which has no
   *  `ActiveRun` at all — can persist attachments. Seeded lazily from disk. */
  private readonly queuedImageSeq = new Map<string, number>();
  /** Messages that landed in the dequeue → session-open gap (#472), flushed as
   *  ordinary follow-up turns the moment the session opens. In-memory only. */
  private readonly deferredMessages = new Map<string, ContentBlock[][]>();
  /** Armed usage-limit resumes, keyed by run id (spec
   *  2026-08-03-auto-resume-after-usage-limit). The DEADLINE itself lives on the record
   *  (`autoResumeAt`) — this map holds only the process-local timer, so a restart rebuilds it
   *  from the record rather than losing the wait. Runs here are `failed` and therefore NOT in
   *  `active`, which is why the timer cannot live on an `ActiveRun` like the monitoring one. */
  private readonly autoResumeTimers = new Map<string, NodeJS.Timeout>();
  private pumping = false;
  /** A pump that arrived while one was in flight — replayed by `pump()`'s own
   *  loop so a slot freed mid-sweep is never a lost wakeup. */
  private pumpAgain = false;
  /**
   * Runs normally isolate in worktrees and may execute in parallel. When that
   * isolation is unavailable (or explicitly disabled), access to `repoRoot` is
   * serialized by default so two agents cannot edit/revert the same files
   * (#438). `CEZ_DISABLE_REPO_LOCK=1` deliberately bypasses this safety lease.
   */
  private repoRootTail: Promise<void> = Promise.resolve();

  /** `.ai/cezar` — where the per-task handoff files and todos.json live. */
  private readonly dataDir: string;

  /** Runs currently being paused by the memory guard — dedupes the ~2 s samples so one breach
   *  triggers one pause, not a burst. Cleared in dropActive when the run leaves the registry. */
  private readonly memoryPausing = new Set<string>();

  /** Queued runs that have already been TOLD, on their own transcript, which account they are
   *  waiting on — keyed run id -> that account, so a hold that moves to a different account
   *  speaks again while a long one stays quiet. `pump()` runs on every lifecycle event, so an
   *  un-deduped note would bury the thread it is meant to explain. */
  private readonly heldNotified = new Map<string, string>();

  /** Queued runs the SPAWN gate has refused, keyed run id -> the account it refused them on.
   *  `pump()` admits on the account the run RECORD names while `execute()` refuses on the account
   *  DISPATCH resolves, and when those disagree the run is dequeued, bounced and re-queued at
   *  loop speed. This memo is what makes admission ask the spawn's question too. Every read
   *  re-checks the account against the live holds, so the memo can only ever delay a start that
   *  the spawn gate was going to refuse anyway. */
  private readonly heldAtSpawn = new Map<string, string>();

  /** Unsubscribe handle for the constructor's `onUsage` subscription — released
   *  by dispose() so a torn-down manager stops receiving sampler ticks. */
  private readonly offUsage: () => void;

  /** The stalled-queue watchdog (see `rescueStalledQueue`). */
  private readonly queueWatchdog: ReturnType<typeof setInterval>;

  /** Set by the watchdog for exactly one sweep: ignore the usage-limit hold and make progress. */
  private forceNextPump = false;

  /** Runs the watchdog started despite the hold. The spawn-time gate (`requeueWhileHeld`) would
   *  otherwise hand them straight back and the rescue would undo itself in a millisecond. */
  private readonly forceStarted = new Set<string>();

  /**
   * The classifier's answer for a run, computed on the first step that has no model pinned
   * (`.ai/specs/2026-08-24-auto-classify-task-model.md`, D4). One agent call per run, not per step.
   *
   * **The CLASS is cached, not the model.** A run can change runner partway through — a retarget,
   * or a step naming its own `runner` — and the class is a property of the TASK while the model is
   * a property of (class, runner). Caching a model would either carry the first runner's id into
   * the second runner's step or force a second classification of the same text; caching the class
   * does neither.
   *
   * In memory on purpose. A server restart re-classifies, which costs one more cheap call and
   * nothing else — whereas persisting it would mean a new field on the run record and on the wire
   * contract to hold a value that is already recoverable, since the model each step actually ran on
   * is written onto the step before its spawn (`2026-08-22-per-step-model-display`).
   *
   * Cleared in `dropActive` with the run's other per-run maps.
   */
  private readonly autoTaskClasses = new Map<string, TaskClass>();

  /** The workspace-wide parallel-cap semaphore + cached resource config
   *  (spec 2026-07-20, step 2.5). Boot constructs ONE and every manager shares
   *  it; the private fallback keeps single-manager callers and tests working. */
  private readonly semaphore: WorkspaceSemaphore;

  /** Unregister handle for this manager's semaphore membership — released by
   *  dispose() so a torn-down project stops counting against the cap. */
  private readonly offSemaphore: () => void;

  /**
   * This manager is bound to cezar's boot/scratch root — the launch directory, when it holds
   * nothing but cezar's own runtime state (`workspace/boot-repo.ts#holdsOnlyRuntimeState`).
   *
   * Two things follow, and ONLY here: a run homed on such a root never runs in place
   * (`execute`, change B) and one that arrived without a workspace grant adopts one
   * (change C). Both would be wrong on a root that holds work, which is why this is injected by
   * the caller that measured it rather than inferred from `repoRoot`.
   * Spec `.ai/specs/2026-08-21-workspace-boot-repo-and-always-worktrees.md`.
   */
  private readonly bootScratchRoot: boolean;

  /** The registry read behind change C. A seam so the adoption is testable without a workspace
   *  registry on disk — the production default is the same read the sidebar performs. */
  private readonly loadGrant: () => Promise<WorkspaceGrant>;
  private readonly reapBroker: (runId: string, meta: SpoolMeta) => Promise<boolean>;

  constructor(
    private readonly store: RunStore,
    private readonly repoRoot: string,
    options: {
      semaphore?: WorkspaceSemaphore;
      bootScratchRoot?: boolean;
      loadGrant?: () => Promise<WorkspaceGrant>;
      reapBroker?: (runId: string, meta: SpoolMeta) => Promise<boolean>;
    } = {},
  ) {
    this.dataDir = join(repoRoot, '.ai/cezar');
    this.bootScratchRoot = options.bootScratchRoot === true;
    this.loadGrant = options.loadGrant ?? (() => loadWorkspaceGrant());
    this.reapBroker = options.reapBroker ?? reapAbandonedBroker;
    this.semaphore = options.semaphore ?? new WorkspaceSemaphore();
    this.offSemaphore = this.semaphore.register({
      busySlots: () => this.busySlots(),
      pump: () => this.pump(),
      oldestQueuedAt: () => this.oldestQueuedAt(),
      accountHolds: () => this.accountHolds(),
      accountInflight: () => this.accountInflight(),
    });
    // Memory guard (#memory-guard): the shared process-tree sampler already ticks ~every 2 s for
    // the runs table; piggyback on it to enforce the per-task memory ceiling.
    this.offUsage = onUsage((snapshot) => void this.enforceMemoryLimit(snapshot));
    // `void` on a promise discards its rejection, and Node terminates the process on an unhandled
    // one — so this `.catch` is what stops a failing sweep from killing the cockpit. The per-run
    // degrade lives inside `rescueStalledQueue`; this is the backstop for everything else it does
    // (`pump`, the hold scan) and for the same reason: a watchdog may fail, never take the server
    // with it. The next tick retries.
    this.queueWatchdog = setInterval(() => {
      this.rescueStalledQueue().catch((err: unknown) => {
        console.warn(
          `[cez] queue watchdog: sweep failed, retrying next tick: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }, QUEUE_WATCHDOG_MS);
    this.queueWatchdog.unref?.();
  }

  /**
   * Release everything this manager owns without touching run records
   * (multi-project workspace, spec 2026-07-20: a removed project's context is
   * torn down while the process lives on). Unsubscribes the shared usage
   * sampler — before dispose() existed that subscription lived for the whole
   * process — clears every per-run idle/autosave timer, releases any held
   * repo-root locks, and empties the queued state so nothing fires later.
   * Live sessions are NOT ended here: run lifecycle stays the caller's policy;
   * dispose only guarantees the manager makes no further moves on its own.
   */
  dispose(): void {
    this.offUsage();
    this.offSemaphore();
    clearInterval(this.queueWatchdog);
    for (const [runId, state] of this.active) {
      this.clearIdleTimer(state);
      this.clearMonitoringWakeTimer(state, runId);
      this.clearAutosaveTimer(state);
      this.clearWorktreeLeases(state, runId);
      state.releaseRepoRoot?.();
      state.releaseRepoRoot = undefined;
    }
    for (const timer of this.autoResumeTimers.values()) clearTimeout(timer);
    this.autoResumeTimers.clear();
    this.active.clear();
    this.waiting.clear();
    this.starting.clear();
    this.queue.length = 0;
    this.pendingJobs.clear();
    this.pendingContinuations.clear();
    this.memoryPausing.clear();
    this.lastNamerKey.clear();
  }

  /**
   * Pause any active run whose whole process tree exceeds the WORKSPACE
   * `resources.memoryLimitMb`, freeing its slot so the queue advances
   * (#memory-guard). "Pause" closes the session — freeing the tree's
   * memory — and leaves the run resumable via Continue; a loud warning explains why. No-op when
   * no limit is set or the sampler has no data (e.g. `ps`/PowerShell unavailable).
   */
  private async enforceMemoryLimit(snapshot: Record<string, ProcessUsage>): Promise<void> {
    // The sampler is module-global (one `ps` for the whole process), so with
    // multiple projects a snapshot carries EVERY project's runs. Act only on
    // rows this manager owns (multi-project spec, step 2.4).
    const runIds = Object.keys(snapshot).filter((runId) => this.active.has(runId));
    if (runIds.length === 0) return;
    // Workspace limit from the shared semaphore's in-memory cache (step 2.5:
    // refreshed at boot and on PUT /api/workspace/config — never N per-tick
    // file reads across N projects). Legacy per-repo `memoryLimitMb` keys are
    // ignored post-migration.
    const limitMb = this.semaphore.memoryLimitMb();
    if (!limitMb || limitMb <= 0) return;
    const limitBytes = limitMb * 1024 * 1024;
    for (const runId of runIds) {
      const usage = snapshot[runId];
      if (!usage || usage.rssBytes <= limitBytes) continue;
      if (this.memoryPausing.has(runId)) continue;
      const state = this.active.get(runId);
      if (!state?.session?.open || state.cancelled) continue;
      this.memoryPausing.add(runId);
      const usedMb = Math.round(usage.rssBytes / (1024 * 1024));
      this.store.appendEvent(runId, {
        type: 'note',
        message: `⚠ memory limit exceeded — this task's process tree is using ${usedMb} MiB (limit ${limitMb} MiB). Pausing it and letting the next queued task run; resume it with Continue.`,
      });
      this.store.appendEvent(runId, {
        type: 'lifecycle',
        message: `paused — memory limit exceeded (${usedMb} MiB > ${limitMb} MiB)`,
      });
      // Closing the session frees the tree and lets the normal exit path settle the run and
      // pump the queue. Suppress autonomous auto-continue so the pause actually holds.
      state.autonomous = false;
      this.clearIdleTimer(state);
      state.session.end();
    }
  }

  /** Env the spawned claude gets so the agent can find its handoff file and
   *  the global inbox (spec 007; the inbox only when the run opted in), plus the knowledge base
   *  wiring (spec 2026-08-06-knowledge-base-mounts-search, "Agent read path and write back",
   *  W4.2).
   *
   *  `CEZ_TODOS_FILE` is set to `''` rather than omitted when follow-ups are
   *  off: runners spawn with `{ ...process.env, ...spec.env }`, so omitting the
   *  key would let a value inherited from *this* process through — a nested
   *  cezar (an agent running `cez serve`/`cez run`/the test suite) would then
   *  write follow-ups into the parent's inbox despite the opt-out. Empty is the
   *  established "absent" spelling — consumers guard with `if (todosFile)`.
   *
   *  `CEZ_KB_ROOTS`/`CEZ_KB_WRITE_FILE` do NOT follow that rule: with `CEZ_KB` off they are
   *  **absent**, not `''`, so the zero-config env stays exactly the three keys it has always been
   *  (`agent-profile-wiring.test.ts`, "adds NOTHING for the default account"). That is the
   *  flag-off byte-identity requirement in `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md`: an
   *  unset flag must leave the agent's environment untouched, and two extra empty keys are not
   *  untouched.
   *
   *  **Corrected 2026-08-22:** the zero-config env is no longer "exactly the three keys" —
   *  `NODE_ENV` below is a fourth, unconditional one. It is not gated by any flag, so it does not
   *  touch the byte-identity invariant this paragraph cites (that invariant is about flag-gated
   *  features going untouched when their flag is off); it is simply always present now, the same
   *  way `TMPDIR`/`TEMP`/`TMP` always are.
   *
   *  The empty-string spelling above is not the precedent it looks like, because the two cases
   *  differ in where the decision lives. `generateFollowups` is a PER-RUN boolean that flips
   *  inside one process whose `process.env` never changes, so omitting the key really would let
   *  the ambient value through and silently defeat the opt-out. `CEZ_KB` is a PROCESS-level flag:
   *  a nested cezar inherits its parent's `process.env` wholesale, so if the parent had the flag
   *  on the child has `CEZ_KB=1` too and computes its own roots — there is no state in which a
   *  parent's roots leak into a child that considers the feature off.
   *
   *  With the flag on, `CEZ_KB_ROOTS` uses whatever root list `knowledge.summary` resolved to
   *  (possibly `undefined` in the narrow window before the store's first reindex has persisted a
   *  manifest) — `''` there, self-healing once that first reindex completes. `CEZ_KB_WRITE_FILE`
   *  does NOT wait on that: an agent must be able to propose the very first document into an
   *  empty knowledge base, so it is set from the flag alone.
   *
   *  `TMPDIR`/`TEMP`/`TMP` (#785) point at this run's own scratch directory
   *  instead of the machine-wide one every agent used to share. Created and
   *  write-probed here, on the last common path before a spawn, so an unusable
   *  temp directory throws `AgentTempDirError` at the caller rather than
   *  turning into empty command output inside a running agent. */
  private agentEnv(
    runId: string,
    generateFollowups: boolean,
    knowledge: { enabled: boolean; summary: KnowledgePromptSummary | undefined },
  ): Record<string, string> {
    return {
      CEZ_HANDOFF_FILE: handoffPath(this.dataDir, runId),
      CEZ_TASK_ID: runId,
      CEZ_TODOS_FILE: generateFollowups ? todosPath(this.dataDir) : '',
      // `NODE_ENV=production` makes npm's own tooling (ci, test runners) install/resolve the
      // production build of everything, which is never what an agent-driven `npm ci`/`npm test`
      // wants (AGENTS.md trap 1). Unconditional, not gated by any CEZ_* flag: every agent-spawned
      // command gets a sane default, the same way TMPDIR below always does.
      NODE_ENV: '',
      ...(knowledge.enabled
        ? {
            CEZ_KB_ROOTS: knowledge.summary ? knowledge.summary.roots.map((r) => r.path).join(':') : '',
            CEZ_KB_WRITE_FILE: knowledgeWriteFilePath(this.dataDir, runId),
          }
        : {}),
      ...agentTmpEnv(this.dataDir, runId),
    };
  }

  /**
   * The model+effort for a step that nobody pinned, from the classifier
   * (`.ai/specs/2026-08-24-auto-classify-task-model.md`). One call per RUN, cached — a
   * `spec-to-deploy` chain would otherwise pay for eight identical classifications of one task.
   *
   * Reached only when the step's runner HAS a class table and every layer above named nothing.
   * The two halves arrived for different reasons and it is worth keeping them straight: on codex an
   * unpinned step was falling to `gpt-5.6-sol` at `null` effort — the most expensive model in the
   * catalog at its shallowest setting, the one cell the owner's table never selects — so that half
   * repairs a bad default. On Claude the CLI's own choice was already sane, so that half is a
   * policy the owner asked for, applying the same table's rows.
   *
   * **The answer is always announced, and a degrade says it degraded.** A fail-soft path with no
   * counter is a quieter outage rather than a fixed one, and this one chooses which model spends
   * the owner's quota — so the transcript must distinguish "classified as explore" from "could not
   * classify, using explore". `classifyTask` never throws, so there is no catch here: its failure
   * paths are values, carrying `classified: false` and a reason.
   */
  private async autoTaskChoice(
    runId: string,
    stepId: string,
    task: string,
    classTable: Record<TaskClass, StepModelChoice>,
    emit: (event: { type: string; stepId?: string; [k: string]: unknown }) => void,
  ): Promise<StepModelChoice> {
    const cached = this.autoTaskClasses.get(runId);
    const taskClass = cached ?? (await this.classifyOnce(runId, stepId, task, emit));
    return classTable[taskClass];
  }

  /** The call itself, separated from the mapping so the CLASS is what gets cached — not one
   *  runner's model. A chain that switches runner mid-run (a retarget, or a step naming its own
   *  `runner`) must not re-classify, and must not carry the first runner's model into the second
   *  runner's step. The class is a property of the task; the model is a property of the pair. */
  private async classifyOnce(
    runId: string,
    stepId: string,
    task: string,
    emit: (event: { type: string; stepId?: string; [k: string]: unknown }) => void,
  ): Promise<TaskClass> {
    const result = await classifyTask(this.repoRoot, task);
    this.autoTaskClasses.set(runId, result.taskClass);
    const why = result.reason ? ` — ${result.reason}` : '';
    emit({
      type: 'note',
      stepId,
      message: result.classified
        ? `task class: ${result.taskClass}${why}`
        : `task class: ${result.taskClass} (could not classify${why})`,
    });
    return result.taskClass;
  }

  /**
   * `agentEnv` plus the agent-account variable for the profile this STEP runs under (spec
   * 2026-07-29-agent-profiles), and the id it resolved to so the caller can record it — plus,
   * since this is already the one place every agent step's env gets assembled, the knowledge-base
   * summary (spec 2026-08-06-knowledge-base-mounts-search, W4.2) a caller needs for BOTH the
   * `CEZ_KB_*` env vars above and the `knowledgeSystemPrompt`/`additionalDirectories` wiring at
   * the `composeSystemPrompt` call site — one read, reused three ways, rather than three reads.
   *
   * Resolved per step, not per run, because a workflow can mix backends: an override naming a
   * Claude account says nothing about which Codex account a codex step should use. Resolution
   * order, most specific first:
   *
   *   1. the step's ALREADY-RECORDED `profileId` — a resume or Continue must reattach to the
   *      account that created the session, whatever the project has since been switched to;
   *   2. the run's composer override, but only for steps on the run's own runner;
   *   3. the project's stored selection, and failing that the discovered default.
   *
   * Read fresh every time. `~/.cezar/config.json` is shared by every cezar process on this
   * machine, so a cached snapshot is a staleness bug, and one small JSON read is free next to
   * spawning a CLI. Never throws: an unreadable home degrades to the default profile, which is
   * exactly the behaviour that predates profiles.
   */
  /**
   * The model pin to hand `backend`, with a pin that backend cannot serve DROPPED rather than
   * forwarded (`.ai/specs/2026-08-22-failed-turn-reads-as-done.md`).
   *
   * `modelConflictsWithRunner` already existed and already answered this — it is applied on the
   * continuation path (`postMessage`) with a comment naming this exact hazard, "an inherited
   * `opus` would survive a switch to codex". The per-step model policy that landed 2026-08-21
   * (`.ai/specs/2026-08-21-per-step-model-policy.md`) pins `sonnet` on seven steps and `opus` on
   * `review-spec`, and never routed through it. When codex went live the next day, every step of
   * every codex run handed codex a Claude alias, and codex answered 400 on all 47 turns.
   *
   * **Dropped, not substituted.** The obvious alternative is to swap in that backend's equivalent
   * id, and it was rejected on measurement: all three ids in `KNOWN_PRESETS_BY_RUNNER.codex`
   * (`gpt-5.1-codex`, `gpt-5.1-codex-mini`, `gpt-5-codex`) are themselves dead on the production
   * account — probed 2026-08-22, each one `Model metadata not found` then the same 400. A pinned
   * vendor id is a thing that goes stale, so substituting one trades today's wrong model for
   * tomorrow's. Dropping falls through to the backend's own current default, which does not rot.
   *
   * The drop is announced on the thread. A model pin silently ignored is its own small lie, and
   * this whole spec exists because cezar told the owner something untrue about a run.
   */
  private modelForBackend(
    runId: string,
    stepId: string,
    backend: RunnerId,
    model: string | undefined,
  ): string | undefined {
    if (!model || !modelConflictsWithRunner(model, backend)) return model;
    this.store.appendEvent(runId, {
      type: 'note',
      stepId,
      message: `model "${model}" is not a ${backend} model — running on ${backend}'s default instead`,
    });
    return undefined;
  }

  private async agentEnvForStep(
    runId: string,
    backend: RunnerId,
    options: {
      generateFollowups?: boolean;
      recordedProfileId?: string;
      /**
       * WHICH AGENT SESSION this env belongs to (spec 2026-08-21-task-author-provenance, Phase 2).
       *
       * `CEZ_TASK_ID` (set by `agentEnv`, per RUN) answers "which task"; a task filed from inside
       * a run also has to name the session that filed it, and a session id is a STEP-level fact.
       * These two are the halves that were unreachable from a child process before.
       *
       * `stepId` is the authoritative one: it is stable across resumes, restarts and session
       * re-mints. `sessionId` is best-effort BY CONSTRUCTION — Codex/OpenCode overwrite the id
       * cezar minted with their own when the backend reports one, which happens after this env is
       * already built — so on those backends it records cezar's pre-mint id and `stepId` is what
       * always resolves. On the Claude backend, the default and the overwhelming majority, it is
       * exact.
       */
      stepId?: string;
      sessionId?: string;
    } = {},
  ): Promise<{ env: Record<string, string>; profileId: string; knowledgeSummary: KnowledgePromptSummary | undefined }> {
    const run = this.store.getRun(runId);
    const runRunner = run?.runner ?? 'claude';
    // A step that pins its OWN runner overrides the provider, and until 2026-08-23 nothing
    // re-resolved the account for it: `profileId` fell through to `undefined`, `selectProfile`
    // could not parse the pool route stored for that provider, and it degraded to that provider's
    // DEFAULT login however exhausted that login was. Resolve the pool for the step's provider
    // instead — limited-skip and the rest of the ranking come free from `selectPoolAccount`.
    // Spec: `.ai/specs/2026-08-23-step-runner-account-resolution.md`.
    const steppedProfile = options.recordedProfileId === undefined && backend !== runRunner
      ? (await resolvePoolForProvider({
          provider: backend as ProviderId,
          repoRoot: this.repoRoot,
          inflight: this.semaphore.accountInflight(),
        }))?.accountId
      : undefined;
    const profileId = options.recordedProfileId
      ?? (backend === runRunner ? run?.agentProfile : steppedProfile);
    // Zero I/O when off (D4) — `loadKnowledgeSummary` itself re-checks the flag, this short-circuit
    // just avoids the Promise.all overhead in the (overwhelmingly common, today) off case.
    const kbEnabled = process.env.CEZ_KB === '1';
    const [resolved, knowledgeSummary] = await Promise.all([
      resolveProfileEnvForRoot(this.repoRoot, backend, profileId),
      kbEnabled ? loadKnowledgeSummary(this.dataDir) : Promise.resolve(undefined),
    ]);
    return {
      env: {
        ...this.agentEnv(runId, options.generateFollowups ?? true, { enabled: kbEnabled, summary: knowledgeSummary }),
        // Always PRESENT, empty when unknown — the `CEZ_TODOS_FILE` spelling above, for the same
        // reason: a nested cezar inherits its parent's `process.env` wholesale, so omitting the
        // key would let the PARENT run's session id shine through and a task filed by the child
        // would name the wrong session. Empty reads as absent everywhere
        // (`authorFromAgentEnv` trims), which is honest; a stale id would not be.
        CEZ_STEP_ID: options.stepId ?? '',
        CEZ_SESSION_ID: options.sessionId ?? '',
        ...resolved.env,
      },
      profileId: resolved.profile.id,
      knowledgeSummary,
    };
  }

  startRun(
    workflow: WorkflowDef,
    input: StartRunInput,
    group?: { groupId: string; variant: string },
  ): RunRecord {
    // Sanitize at the manager boundary so CLI runs, workflows, variants, and
    // direct callers cannot bypass the HTTP policy.
    const effectiveInput = agentModelsLocked(this.repoRoot)
      ? { ...input, model: undefined }
      : input;
    const run = this.store.createRun({
      title: makeRunTitle(input.task, workflow) + (group ? ` (${group.variant})` : ''),
      workflow: workflow.name,
      task: input.task,
      model: effectiveInput.model,
      runner: input.runner,
      // The composer's per-task account (spec 2026-07-29-agent-profiles). Persisted at creation
      // so a queued run picks it up at dequeue and every later resume reads the same answer.
      agentProfile: input.agentProfile,
      // The global inbox is the ceiling on the per-run flag (#471). Enforced here rather than
      // at the HTTP route because `cezar run`, the inbox's own "▶ Run" and variants all reach
      // startRun directly — a route-level gate would leave those writing todos.json.
      generateFollowups: followupsEnabled() ? input.generateFollowups : false,
      // Who asked for this task, stamped at creation and never rewritten (spec
      // 2026-08-21-task-author-provenance). Passed straight through: `startRun` decides nothing
      // about authorship — the caller that KNOWS who acted is the only one that can.
      author: input.author,
      // Persist autonomy on the record (#489) so the terminal review gate
      // (`settleSuccess`) and the group-pick winner-park can honor it — mid-run
      // auto-nudge reads `input.autonomous` (`execute`), but the record is the
      // only source those after-the-fact consumers have.
      autonomous: input.autonomous === true,
      // PLAN D27 Phase 3 — see `stepBudgetOverride`'s doc comment (`runs/store.ts`).
      stepBudgetOverride: input.stepBudgetOverride,
      // Persist the explicit opt-out so queued-run restart recovery and the
      // session Git routes can distinguish it from a removed isolated worktree.
      worktree: !group && input.worktree === false ? false : undefined,
      // A workspace run's directory grant, frozen at creation (spec 2026-08-15-cross-project-
      // workspace-run). Never re-read from the registry afterwards — see the field's doc comment
      // in `contract/src/runs.ts`. Variants never carry one: they exist to isolate, and a
      // workspace run has nothing to isolate into.
      workspaceProjects: group ? undefined : input.workspaceProjects,
      groupId: group?.groupId,
      variant: group?.variant,
      steps: workflow.steps.map((s) => ({ id: s.id, name: s.name ?? s.id, kind: stepKind(s) })),
    });
    // Persist the full definition so a queued run survives a restart (#367) —
    // ad-hoc "(planned)" chains exist nowhere else to re-resolve from.
    this.store.updateRun(run.id, { workflowDef: workflow });
    // Initial pasted images must be visible while the run is still queued (#612),
    // and must survive a restart before a slot opens. Persist them before the job
    // enters `pendingJobs`; `hydrateQueuedInput` reconstructs their content blocks
    // from these URLs when a recovered run eventually starts.
    if (input.images?.length) {
      const persisted = input.images
        .filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image')
        .map((b) => this.persistImage(run.id, b.source.media_type, b.source.data, 'pasted'))
        .filter((saved): saved is PersistedAttachment => saved !== null);
      if (persisted.length) {
        this.store.updateRun(run.id, { taskImages: persisted.map((saved) => saved.url) });
      }
    }
    // Step-0 reference extraction (task auto-naming spec): the regex layer's
    // numbers persist immediately; the namer may add the kind it verified later.
    const skillHint = workflow.steps.find((s) => stepKind(s) === 'agent' && s.skill)?.skill?.trim();
    const refs = refineTaskRefs(extractTaskRefs(input.task), skillHint);
    if (refs.prNumber !== undefined || refs.issueNumber !== undefined) {
      this.store.updateRun(run.id, {
        ...(refs.prNumber !== undefined ? { prNumber: refs.prNumber } : {}),
        ...(refs.issueNumber !== undefined ? { issueNumber: refs.issueNumber } : {}),
      });
    }
    // Fire-and-forget LLM naming (task auto-naming spec): the heuristic title
    // above shows instantly; the namer's short title replaces it when (and if)
    // the model answers. Never awaited, never fails the run.
    void this.autoNameRun(run.id, skillHint, input.task);
    this.pendingJobs.set(run.id, { workflow, input: effectiveInput });
    this.queue.push(run.id);
    void this.pump();
    return run;
  }

  /**
   * Parallel variants (spec 010): N runs of the same workflow on the same
   * task, sharing a groupId. Variant A gets the task verbatim; B and C get a
   * fixed one-line approach hint appended to the *task input* (not the step
   * template), so diversification works with any workflow. The normal queue
   * applies — with maxParallel=2 a third variant simply waits.
   */
  startVariants(workflow: WorkflowDef, input: StartRunInput, count: number): RunRecord[] {
    const groupId = randomUUID();
    return VARIANT_LETTERS.slice(0, Math.min(Math.max(count, 1), VARIANT_LETTERS.length)).map(
      (variant) => {
        const hint = VARIANT_HINTS[variant];
        const task = hint ? `${input.task}\n\n${hint}` : input.task;
        return this.startRun(workflow, { ...input, task, worktree: undefined }, { groupId, variant });
      },
    );
  }

  /**
   * Slots this manager holds against the workspace-wide cap. `waiting` runs
   * don't hold a slot (#347): an idle claude process costs memory but no
   * tokens, queued work progressing matters more, and the idle timeout already
   * bounds how long a session can sit open. Because the exemption lives HERE —
   * in the count, not in any acquire path — a message into a `waiting` run
   * (sendMessage) resumes it immediately even when that momentarily exceeds
   * `maxParallel`, including when other projects saturate the cap.
   */
  private busySlots(): number {
    const ordinaryWaiting = this.waiting.size - this.monitoring.size;
    const exemptMonitoring = Math.min(this.monitoring.size, this.semaphore.maxMonitoringSessions());
    return this.active.size + this.starting.size - ordinaryWaiting - exemptMonitoring;
  }

  /** Is this run a WORKSPACE RUN — one granted every registered project (spec 2026-08-15), now
   *  isolated per-project in worktrees (spec 2026-08-19)? Read from the record so it holds across a
   *  restart, and `false` for every ordinary project run. */
  private isWorkspaceRun(runId: string): boolean {
    return (this.store.getRun(runId)?.workspaceProjects?.length ?? 0) > 0;
  }

  /**
   * Change C — a run homed at the boot scratch root with no grant adopts the workspace grant, and
   * from that line on IS a workspace run: per-project worktrees, no boot-root lease, apply-back on
   * success (spec `.ai/specs/2026-08-21-workspace-boot-repo-and-always-worktrees.md`).
   *
   * **Why this exists at all.** `workspaceProjects` is written in exactly ONE place —
   * `server/workspace-run-routes.ts`, reached only by `POST /api/v1/workspace/runs`. Nine other
   * `startRun` call sites (`cezar run`, `POST /runs`, todo autostart, task templates, note
   * approval, continuations…) never pass it, and any of them bound to the boot manager produces a
   * run that used to fall into the ordinary in-place branch: the exclusive working-tree lease and
   * `pump()`'s one-at-a-time cap. Measured 2026-08-21: run `50ce87f1` held it for 85 minutes,
   * while a run created 43 seconds later WITH the grant isolated into ten worktrees. The only
   * difference was the record.
   *
   * Fixing every call site would be nine copies of one decision, each free to be forgotten again.
   * Fixing it here answers the question where the run actually lands.
   *
   * **The `groupId` carve-out is deliberate**, not an oversight. `startRun` drops the grant for
   * group VARIANTS on purpose ("they exist to isolate, and a workspace run has nothing to isolate
   * into"). A variant submitted at the boot root therefore still gets change B's forced isolation
   * of the boot repo, not ten per-project worktrees.
   *
   * Never throws and never blocks the run: an unreadable registry, or one with no project on
   * disk, leaves the record exactly as it was and the run takes change B's path instead.
   */
  private async adoptWorkspaceGrant(
    runId: string,
    emit: (event: { type: string; [k: string]: unknown }) => unknown,
  ): Promise<void> {
    if (!this.bootScratchRoot) return;
    const record = this.store.getRun(runId);
    if (!record) return;
    if ((record.workspaceProjects?.length ?? 0) > 0) return;
    if (record.groupId !== undefined) return;

    const grant = await this.loadGrant().catch((err: unknown) => {
      emit({
        type: 'note',
        message: `workspace registry unreadable (${err instanceof Error ? err.message : String(err)}) — this task runs without a workspace grant`,
      });
      return null;
    });
    if (!grant || grant.projects.length === 0) return;

    this.store.updateRun(runId, { workspaceProjects: grant.projects });
    emit({
      type: 'note',
      message:
        `workspace boot root — this task carried no project grant, so it adopted the workspace's ` +
        `${grant.projects.length} project(s) rather than running in the scratch root one at a time`,
    });
  }

  /** Busy slots held by NON-workspace in-place runs — the only ones the non-git single-slot cap in
   *  `pump()` must still serialize. Workspace runs isolate in worktrees, so they neither count here
   *  nor are blocked by it. `waiting` runs hold no slot, matching `busySlots()`. */
  private nonWorkspaceInPlaceBusy(): number {
    let n = 0;
    for (const runId of new Set([...this.active.keys(), ...this.starting])) {
      if (this.waiting.has(runId)) continue;
      if (this.isWorkspaceRun(runId)) continue;
      n += 1;
    }
    return n;
  }

  /** Epoch ms of this manager's oldest queued run (the semaphore's fairness
   *  key when a freed slot is broadcast), or null when nothing is queued.
   *  `queue` is FIFO — `startRun` pushes and `recover()` re-queues by
   *  `createdAt` — so the head is the oldest. */
  private oldestQueuedAt(): number | null {
    const head = this.queue[0];
    if (!head) return null;
    const createdAt = this.store.getRun(head)?.createdAt;
    const ms = createdAt ? Date.parse(createdAt) : Number.NaN;
    return Number.isNaN(ms) ? null : ms;
  }

  /**
   * A slot this manager held just came free. Pump the whole WORKSPACE, not
   * just this manager: `maxParallel` is counted across every project, so the
   * run that should take the slot is the workspace's oldest queued one — which
   * usually sits in another project's queue. Pumping only `this` is what left
   * a queued run in project B stuck at `queued` while project A's runs came
   * and went. `release()` pumps this manager too, so it replaces the local
   * `pump()` at every slot-freeing transition.
   */
  private releaseSlot(): void {
    void this.semaphore.release();
  }

  /**
   * A pure READ of the same two ceilings `pump()` enforces before it dequeues anything — whether a
   * NEW run may start on this project right now, under BOTH the workspace `maxParallel` and this
   * project's own per-project cap, plus the non-git in-place degradation rule. Built for Milestone C
   * (`.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, C-e): a dispatched run's `capacityAvailable`
   * has to come from THIS manager — the one that will actually run the work — never from the
   * `presence` heartbeat's `capacity` claim, which is stamped at `heartbeatMs` cadence and would be
   * stale by exactly the window that matters.
   *
   * **Advances nothing and holds no lock** — unlike the `resolvePoolFor*` family in
   * `workspace/agent-route-select.ts`: `resolvePoolForDispatch` (`:208`), whose own docblock warns
   * it "cannot be called speculatively" because it burns a turn of the fairness cursor as a side
   * effect, and its sibling `resolvePoolForProvider` (`:246`), which advances the identical cursor
   * through `recordDispatch` (`:273`). Both pick a login/provider by consuming a turn; this is the
   * account-agnostic structural question one level up ("is there a slot at all"), asked the same
   * way `pump()` asks it, and it is safe to call speculatively for exactly that reason: the answer
   * is a snapshot, not a reservation, so a genuine race between this read and the run actually
   * starting is possible and is left to `pump()`'s own gate — the same race `pump()` already lives
   * with across its own multiple `await`s.
   *
   * Deliberately omits the account-hold check `pump()` also applies (`accountHolds()` / usage-limit
   * gating): that gate is about which *specific* queued run may take a free slot, not whether a
   * slot exists, and a dispatched run's account is not chosen until it actually starts.
   */
  async hasCapacity(): Promise<boolean> {
    const repo = await getRepoInfo(this.repoRoot);
    const maxParallel = this.semaphore.maxParallel();
    const projectMax = this.semaphore.projectMaxParallel(this.repoRoot);
    return (
      this.semaphore.busy() < maxParallel &&
      this.busySlots() < projectMax &&
      (repo !== null || this.nonWorkspaceInPlaceBusy() < 1)
    );
  }

  /**
   * Start queued runs while parallel slots are free. A run starts only under
   * BOTH ceilings: the WORKSPACE `resources.maxParallel` (default 2, counted
   * across every manager — spec 2026-07-20, step 2.5) AND this project's own
   * per-project `maxParallel` when the registry sets one (spec 2026-07-22,
   * inherits the workspace cap when unset). Legacy per-repo `maxParallel` keys
   * are ignored. A non-git directory degrades to 1 sequential run in the repo
   * root (spec 006 degradation rule), which is always the tighter bound.
   */
  private async pump(): Promise<void> {
    this.reconcileMonitoringWakeTimers();
    this.reconcileAutoResumes();
    // A pump requested while one is in flight can't just be dropped: the
    // in-flight pass may already have read capacity (it awaits `getRepoInfo`
    // before the first check), so a slot freed in that window would be lost
    // until the next unrelated event. Re-run the sweep instead.
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        const repo = await getRepoInfo(this.repoRoot);
        const maxParallel = this.semaphore.maxParallel();
        // Per-project ceiling (spec 2026-07-22-per-project-concurrency): this
        // project never runs more than its own configured `maxParallel`; absent
        // an override it equals the workspace cap, so behavior is unchanged.
        const projectMax = this.semaphore.projectMaxParallel(this.repoRoot);
        // `waiting` runs don't hold a slot (#347) — see busySlots(). The check
        // below is the only slot gate: resumes never pass through it. A run
        // starts only under BOTH the workspace cap and this project's ceiling.
        const capacity = () =>
          this.semaphore.busy() < maxParallel &&
          this.busySlots() < projectMax &&
          // Non-git degradation (spec 006): a non-git root can't isolate an ordinary in-place run,
          // so those serialize to one. A WORKSPACE run is exempt — it isolates each project in its
          // own worktree (spec 2026-08-19, W3) — so only NON-workspace in-place runs count here,
          // letting several workspace runs start on the non-git boot root up to maxParallel.
          (repo !== null || this.nonWorkspaceInPlaceBusy() < 1);
        // The usage-limit hold (spec 2026-08-03-auto-resume-after-usage-limit).
        //
        // A limit closes an ACCOUNT, not a run — so starting the next queued task walks it into
        // the same wall. Measured before this gate existed: eight tasks under `maxParallel: 2`
        // all failed within 517 ms, each spawning a CLI (and, outside worktree-opt-out mode, a
        // worktree and a branch) only to be marked `scheduled`. The cap was respected at every
        // instant and was no brake at all, because a doomed run lives ~200 ms.
        //
        // So: while any run on an account is waiting out a limit, nothing new starts on THAT
        // account. Other accounts (a second login, a different backend) keep running — the hold
        // is keyed, not global. The set is derived from the durable records rather than tracked
        // separately, which is what makes it survive a restart, expire on its own, and lift the
        // instant a user cancels a resume.
        // The watchdog's one-shot override — read and cleared here, so a forced sweep never
        // leaks into the next ordinary one.
        const forced = this.forceNextPump;
        this.forceNextPump = false;
        const holds = this.queue.length > 0 && !forced ? this.semaphore.accountHolds() : NO_HOLDS;
        const anyHold = holds.deadline.size > 0 || holds.inFlight.size > 0;
        // Only pay for the config read when something is actually held: a queued record may name
        // no runner, and then the account it would use is the configured default.
        const defaultRunner = anyHold ? (await loadConfig(this.repoRoot)).defaultRunner : undefined;
        // Say so on the transcript before deciding anything (spec 2026-08-23-usage-limit-hold-
        // account). A held run is otherwise indistinguishable from an ordinary queued one — it
        // wears `queued`, it wears `#1 in queue`, and it does not move for hours. The queue was
        // right and the cockpit was silent, which reads as a wedged workspace.
        //
        // A FORCED sweep is skipped entirely: it reads `NO_HOLDS` by construction, which is an
        // instruction to ignore the holds, never evidence that none exist. Letting it run here
        // cleared the dedupe state on every watchdog tick, so the next ordinary sweep said
        // everything again — two notes per hold on a quiet queue, and a note per round trip on a
        // bouncing one.
        if (!forced) {
          if (anyHold) {
            this.noteHeldRuns(holds, (defaultRunner ?? 'claude') as RunnerId);
          } else {
            // Nothing is held anywhere, so every memo and every spent note is stale.
            this.heldNotified.clear();
            this.heldAtSpawn.clear();
          }
        }
        while (this.queue.length > 0 && capacity()) {
          // FIFO among the runs that CAN start; a held one keeps its place in the queue rather
          // than being dequeued and re-queued (which would churn its position and its record).
          const next = !anyHold
            ? 0
            : this.queue.findIndex((id) => {
                const queued = this.store.getRun(id);
                return !queued || !this.heldAccountFor(queued, holds, defaultRunner ?? 'claude');
              });
          if (next === -1) break; // everything queued is waiting on a held account
          const runId = this.queue.splice(next, 1)[0];
          if (!runId) break;
          this.heldNotified.delete(runId);
          this.heldAtSpawn.delete(runId);
          // A forced sweep has to reach the spawn: the gate inside `execute` asks the same
          // question and would send this run straight back to the queue.
          if (forced) this.forceStarted.add(runId);
          const job = this.pendingJobs.get(runId);
          const continuation = this.pendingContinuations.get(runId);
          this.pendingJobs.delete(runId);
          this.pendingContinuations.delete(runId);
          if (!job && !continuation) continue;
          this.starting.add(runId);
          if (continuation) {
            const hydrated = this.hydrateQueuedContinuation(runId, continuation);
            void this.runContinuation(
              runId,
              hydrated.stepId,
              hydrated.name,
              hydrated.sessionId,
              hydrated.backend,
              hydrated.prompt,
              hydrated.images,
              hydrated.persistedImages,
              hydrated.persistedAttachments,
            ).catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              this.store.updateRun(runId, {
                status: 'failed',
                error: `continue crashed: ${message}`,
                finishedAt: new Date().toISOString(),
              });
              this.starting.delete(runId);
              this.dropActive(runId);
            });
            continue;
          }
          if (!job) continue;
          // Rebuild the prompt from the store at the last instant (#472), so an edit
          // or a stacked message that landed while the run waited is honored. Entered
          // in the same synchronous tick as the `pendingJobs.delete` above, so no
          // handler can observe a half-dequeued run.
          const input = this.hydrateQueuedInput(runId, job.input);
          void this.execute(runId, job.workflow, input, job.resumeAt).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            this.store.updateRun(runId, {
              status: 'failed',
              error: `engine crashed: ${message}`,
              finishedAt: new Date().toISOString(),
            });
            const state = this.active.get(runId);
            if (state) {
              this.clearIdleTimer(state);
              this.clearAutosaveTimer(state);
            }
            this.starting.delete(runId);
            this.dropActive(runId);
          });
        }
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  /**
   * Tell each held queued run, once, which account it is waiting on and until when.
   *
   * The hold itself is correct and deliberate — starting a task on an account that is out of
   * window just burns a CLI spawn on a doomed run. What was missing is that the refusal left no
   * trace anywhere a person looks: the record stays plain `queued`, the row still counts it `#1
   * in queue`, and the only other note of this kind (`requeueWhileHeld`) fires on the SPAWN path,
   * which a run held at dequeue never reaches. Measured 2026-08-23: a task sat queued behind an
   * eleven-hour hold with nothing in its transcript, its row, or the log saying so.
   *
   * Deduped per account rather than per run: a run whose hold moves to a different account is
   * waiting on something new and should say so, while a run parked on one account for hours
   * should not repeat itself on every sweep.
   */
  private noteHeldRuns(holds: AccountHolds, defaultRunner: RunnerId): void {
    // Self-pruning: a run can leave the queue by paths that never reach the dequeue below (a
    // cancel, most obviously), and this map must not outlive the queue it describes.
    for (const runId of this.heldNotified.keys()) {
      if (!this.queue.includes(runId)) this.heldNotified.delete(runId);
    }
    for (const runId of this.heldAtSpawn.keys()) {
      if (!this.queue.includes(runId)) this.heldAtSpawn.delete(runId);
    }
    for (const runId of this.queue) {
      const queued = this.store.getRun(runId);
      if (!queued) continue;
      // Whichever account is actually holding it — its own, or the one the spawn gate refused.
      // Naming the run's own account for a run bounced on a step's account would print a sentence
      // about an account that is wide open, which is worse than the silence this replaced.
      const account = this.heldAccountFor(queued, holds, defaultRunner);
      if (!account) {
        this.heldNotified.delete(runId);
        continue;
      }
      this.noteHeld(runId, account);
    }
  }

  /**
   * Which account is holding this queued run right now, or undefined when nothing is.
   *
   * TWO keys, because the two gates ask about different accounts and a run BOUNCES forever when
   * they disagree. `pump()` admits on the account the run RECORD names; `execute()` refuses on
   * the account DISPATCH resolves, and those differ for two independent reasons: a `pool:` route
   * picks the PROVIDER as well as the login (`resolvePoolForDispatch`), and a workflow step may
   * pin its own runner. The measured cause was the first — the box's `defaults` are `pool:*` for
   * both providers, so a task created on codex resolved to a claude account. Its record said
   * codex, so the queue admitted it; dispatch said claude, which was held, so the spawn handed it
   * back; repeat. Measured on `prod-host` on 2026-08-23 at roughly eleven round trips a
   * second, each one appending a transcript note, 2626 of them in four minutes.
   *
   * So the spawn gate's verdict is remembered (`heldAtSpawn`) and consulted at admission. It is a
   * MEMO, not a second source of truth: the remembered account must still be held right now for
   * it to count, and a stale one is dropped on read. The worst case is that a hold moves to a
   * different account and the run bounces once more, which records the new account and settles
   * again — bounded by the number of accounts, not by time.
   *
   * The memo cannot wedge a queue. It only ever holds back a run the spawn gate would refuse a
   * millisecond later, and the watchdog's forced sweep bypasses this predicate entirely.
   */
  private heldAccountFor(run: RunRecord, holds: AccountHolds, defaultRunner: RunnerId): string | undefined {
    // Out-of-quota fallback (spec 2026-08-23-retarget-task-to-another-engine, Phase 4): with the
    // setting on, "the account the RECORD names is limited" stops being a reason to WAIT, so
    // admission does not hold on it and the run goes through to dispatch, which is the only place
    // allowed to resolve an account. If dispatch finds nowhere better, `requeueWhileHeld` parks it
    // exactly as before — so the worst case of admitting it is one dequeue, not a start on a
    // closed login.
    //
    // **The SPAWN MEMO is exempt from that bypass, and it has to be.** CORRECTED 2026-08-23 by
    // `.ai/specs/2026-08-23-never-block-a-task.md`: the setting's first version returned here
    // unconditionally, which threw away the memo as well as the record's hold. That is the brake.
    // Without it the queue ran hot — dequeue, resolve, park, release, pump, dequeue — and because
    // `noteHeldRuns` reads THIS predicate to decide whether the thread has already spoken, an
    // `undefined` answer deleted the dedupe memo on every sweep too. **Measured on a genuinely
    // stuck run: 37 identical "held in the queue" notes in 1.5 seconds**, the same shape as the
    // 2626-note write storm rolled back earlier the same day.
    //
    // The memo is safe to honour under the fallback because it is not the record's guess: it is
    // what dispatch ACTUALLY refused, after the full resolve. Re-dequeuing a millisecond later can
    // only refuse again — the inputs (`limited`, holds) move on a timescale of minutes. It still
    // self-clears the moment that account stops being held, `retargetQueuedRun` drops it outright,
    // and the watchdog's forced sweep bypasses this predicate entirely, so it cannot wedge.
    //
    // Deliberately NOT "resolve the alternative here and compare". This predicate is synchronous
    // and runs on every pump sweep, while choosing an account means reading two JSON files; worse,
    // the obvious helper (`resolvePoolForDispatch`) advances the round-robin cursor as a side
    // effect, so asking it per sweep would corrupt the balancer it is asking.
    const own = runAccountKey(run, defaultRunner);
    if (!this.semaphore.fallbackAcrossAccountsWhenLimited() && accountHeldOn(own, run, holds)) {
      return own;
    }
    const atSpawn = this.heldAtSpawn.get(run.id);
    if (atSpawn === undefined) return undefined;
    if (accountHeldOn(atSpawn, run, holds)) return atSpawn;
    this.heldAtSpawn.delete(run.id);
    return undefined;
  }

  /** One held run, one line, once per account it is held on. Shared by the dequeue-time sweep
   *  above and the spawn-time gate (`requeueWhileHeld`) so a run that is refused at both does not
   *  say the same thing twice, and so both spell the account the same way. */
  private noteHeld(runId: string, account: string): void {
    if (this.heldNotified.get(runId) === account) return;
    this.heldNotified.set(runId, account);
    const until = this.holdReopensAt(account);
    this.store.appendEvent(runId, {
      type: 'note',
      // No em dash in the cockpit-visible half of this line (owner's standing rule for product
      // copy); the surrounding comments keep the file's own style.
      message: until
        ? `held in the queue: the ${account} agent account is waiting out a usage limit until ${formatWakeInstant(until)}`
        : `held in the queue: the ${account} agent account is waiting out a usage limit`,
    });
  }

  /** When the named account's earliest scheduled resume fires, or null when the hold is an
   *  in-flight resume with no published instant behind it. */
  private holdReopensAt(account: string): Date | null {
    let soonest: number | undefined;
    for (const run of this.store.listRuns()) {
      if (run.status !== 'failed' || !run.autoResumeAt) continue;
      if (usageHoldAccountKey(run, run.runner ?? 'claude') !== account) continue;
      const at = Date.parse(run.autoResumeAt);
      if (!Number.isFinite(at) || at <= Date.now()) continue;
      if (soonest === undefined || at < soonest) soonest = at;
    }
    return soonest === undefined ? null : new Date(soonest);
  }

  /**
   * Move a QUEUED run to a different engine before it has started anything
   * (`.ai/specs/2026-08-23-retarget-task-to-another-engine.md`, Phase 2).
   *
   * The parked-task counterpart to `continueRun`'s `{runner, model}` override, which cannot serve
   * this case: it requires a session to resume, and a queued run has none. Everything here happens
   * before a single agent turn, so there is nothing to migrate — no session, no worktree, no cost.
   *
   * ## Why the pending input must be rewritten, not just the record
   *
   * `execute()` reads `input.runner` / `input.agentProfile` / `input.model`, never the record. A
   * retarget that updated only the record would show the new engine everywhere a human looks and
   * dispatch to the old one — the most expensive shape of wrong, because it looks like it worked.
   * The record is updated too, and must be: `pump()`'s admission gate keys on `runAccountKey(run)`
   * off the RECORD, so leaving it stale would have admission and dispatch disagreeing about the
   * account, which is the exact ping-pong `2026-08-23-usage-limit-hold-account.md` had to fix.
   *
   * ## The memo has to go
   *
   * `heldAtSpawn` remembers the account a spawn refused this run on, and it is stale the instant
   * the target changes — it would otherwise keep the run out of the queue on the strength of a
   * verdict about a DIFFERENT account, so the retarget would appear to do nothing until the old
   * account's hold expired. `heldNotified` goes with it so the thread speaks again for the new
   * account rather than staying quiet on a dedupe key that no longer applies.
   *
   * ## Refusals
   *
   * A run with no pending work item is the wedge `reviveQueuedRun` exists to repair — a queued
   * record that `pump()` cannot see. Retargeting it would write a new engine onto a record that
   * still has nothing to execute, which reads as success and changes nothing. Refused instead; the
   * queue watchdog revives it within a sweep and the retarget then works.
   */
  async retargetQueuedRun(
    runId: string,
    target: { runner?: RunnerId; agentProfile?: string; model?: string },
  ): Promise<{ ok: boolean; error?: string }> {
    if (agentModelsLocked(this.repoRoot) && target.model?.trim()) {
      return { ok: false, error: AGENT_MODELS_LOCKED_ERROR };
    }
    const run = this.store.getRun(runId);
    if (!run) return { ok: false, error: 'not found' };
    if (run.status !== 'queued') return { ok: false, error: `cannot retarget a ${run.status} run` };

    const job = this.pendingJobs.get(runId);
    const continuation = this.pendingContinuations.get(runId);
    if (!job && !continuation) {
      return { ok: false, error: 'this task has no queued work item yet, try again in a moment' };
    }

    const targetRunner = target.runner ?? run.runner ?? 'claude';
    // The same pairing guard `continueRun` applies, for the same reason and with the same words:
    // a model that is recognizably another runner's preset would corrupt the run. Free-form and
    // custom ids pass untouched.
    if (target.model && modelConflictsWithRunner(target.model, targetRunner)) {
      return { ok: false, error: `model '${target.model}' is not a ${targetRunner} model` };
    }
    // A runner switch carrying NO explicit model must not leave the previous backend's pin behind
    // — the guard above only sees `target.model`. Cleared, never substituted: dropping falls
    // through to the new backend's own current default, whereas swapping in "the equivalent id"
    // trades today's wrong model for tomorrow's stale one
    // (`.ai/specs/2026-08-22-failed-turn-reads-as-done.md`, and `modelForBackend` below).
    const inheritedPinIsForeign =
      target.model === undefined && run.model !== undefined && modelConflictsWithRunner(run.model, targetRunner);
    const model = target.model === undefined ? (inheritedPinIsForeign ? undefined : run.model) : target.model || undefined;
    const agentProfile = target.agentProfile === undefined ? run.agentProfile : target.agentProfile || undefined;

    this.store.updateRun(runId, {
      runner: targetRunner,
      model,
      agentProfile,
      // A retarget is a decision to run this task somewhere else NOW. Any pending usage-limit
      // appointment was made about the old engine and is meaningless for the new one.
      autoResumeAt: undefined,
    });

    if (job) {
      this.pendingJobs.set(runId, {
        ...job,
        input: { ...job.input, runner: targetRunner, agentProfile, model },
      });
    }
    if (continuation) {
      // A session id is provider-owned. Sending the new backend the old one's handle is the
      // failure `reviveQueuedRun` already guards against on its own path, so a continuation whose
      // engine changed starts a fresh session instead of resuming a thread the target cannot read.
      const sessionSurvives = continuation.backend === targetRunner;
      this.pendingContinuations.set(runId, {
        ...continuation,
        backend: targetRunner,
        sessionId: sessionSurvives ? continuation.sessionId : undefined,
      });
    }

    this.heldAtSpawn.delete(runId);
    this.heldNotified.delete(runId);
    this.chainReentries.delete(runId);

    const where = agentProfile ? `${targetRunner} (${agentProfile})` : targetRunner;
    this.store.appendEvent(runId, {
      type: 'lifecycle',
      message: `moved to ${where}${model ? ` on ${model}` : ''}, waiting for a slot`,
    });
    void this.pump();
    return { ok: true };
  }

  /**
   * The executable input for a run going BACK into the queue, rebuilt from its record.
   *
   * Three callers had this same object spelled out inline — `reviveQueuedRun` (boot recovery and
   * the queue watchdog), `reattachBrokeredRun` (a live spool survived a restart) and
   * `reenterChain` (a chain hands itself back) — and **all three dropped `agentProfile`**, which is
   * what this helper exists to make impossible to repeat. `execute()` resolves the account from
   * `input.agentProfile`, never from the record, so every one of those paths silently downgraded
   * an explicit account pick back to the project's own selection. The record kept the value the
   * whole time, which is exactly what hid it: the cockpit went on showing the account the user
   * chose while the dispatch used a different one.
   *
   * It matters more now than it did: `retargetQueuedRun` writes the user's new engine onto both
   * the record and the pending input, and any path that rebuilds the input from the record would
   * otherwise undo the retarget at the next restart, hand-back or re-attach.
   *
   * `generateFollowups` stays a parameter rather than being read here, because the callers do not
   * agree on it: `reviveQueuedRun` normalizes the value onto the record first (#471) and the other
   * two compute it inline. Folding that decision in would change behaviour in one of the three.
   */
  private queuedInputFromRecord(run: RunRecord, generateFollowups: boolean | undefined): ExecuteRunInput {
    return this.hydrateQueuedInput(run.id, {
      task: run.task,
      model: run.model,
      runner: run.runner,
      agentProfile: run.agentProfile,
      generateFollowups,
      // Re-thread autonomy (#489): the rebuilt input feeds `execute`, whose mid-run auto-nudge
      // reads `input.autonomous`. Without this a recovered autonomous run would run
      // non-autonomously and later wrongly park at `review`.
      autonomous: run.autonomous,
      // Preserve an explicit worktree opt-out across a queued restart.
      worktree: run.worktree,
    });
  }

  /**
   * Make one `queued` RECORD executable again — the engine half a queued run needs but does not
   * persist (`pendingJobs` / `pendingContinuations` are process-local, the record is not).
   *
   * Two callers, one path: boot recovery re-adopts everything the previous process was holding,
   * and the queue watchdog re-adopts anything the running process has somehow lost. A queued
   * record with no work item behind it is invisible to `pump()` and would sit there for good,
   * which is the worst failure this engine has — the task is neither running nor failed, just
   * silently never going to happen.
   *
   * A continuation is reconstructed first: its executable details are gone, but the pending
   * `continue-N` step and the session before it are durable, which is enough. Otherwise the
   * workflow is revived from the record. A run that can be neither is failed loudly rather than
   * left in the queue as a ghost.
   */
  private async reviveQueuedRun(run: RunRecord, reason: string): Promise<void> {
    const queuedContinuation = [...run.steps]
      .reverse()
      .find((step) => step.status === 'pending' && step.id.startsWith('continue-'));
    const sessionStep = queuedContinuation
      ? [...run.steps].reverse().find((step) => step.id !== queuedContinuation.id && step.sessionId)
      : undefined;
    if (queuedContinuation && sessionStep?.sessionId) {
      const backend = run.runner ?? 'claude';
      const sessionBackend = sessionStep.backend ?? backend;
      this.pendingContinuations.set(run.id, {
        stepId: queuedContinuation.id,
        sessionId: sessionBackend === backend ? sessionStep.sessionId : undefined,
        backend,
        prompt: RESTART_CONTINUATION_PROMPT,
        images: [],
        // Read off the already-persisted `continue-N` step, not re-derived from the restart
        // prompt above — otherwise every restart would relabel the step "the cezar process
        // restarted…" instead of preserving its real title (spec 2026-08-22-continue-step-naming).
        // `PendingContinuation.nameOrigin` has no `'marker'` member — a step Phase 3 already
        // refined is, like a Phase 1 prompt-derived one, still eligible for further refinement (it
        // is only `'step'` that must never be overwritten), so a persisted `'marker'` folds to
        // `'prompt'` here rather than widening this type for a distinction that doesn't matter to
        // this path.
        name: queuedContinuation.name,
        nameOrigin: queuedContinuation.nameOrigin === 'step' ? 'step' : 'prompt',
      });
      this.queue.push(run.id);
      this.store.appendEvent(run.id, {
        type: 'lifecycle',
        message: `${reason} — interrupted continuation re-queued`,
      });
      return;
    }
    const workflow = await this.reviveWorkflow(run);
    if (!workflow) {
      this.store.updateRun(run.id, {
        status: 'failed',
        error: 'interrupted — workflow definition not recoverable after a restart',
        finishedAt: new Date().toISOString(),
      });
      this.store.appendEvent(run.id, {
        type: 'lifecycle',
        message: `${reason} — workflow definition not recoverable, task failed`,
      });
      return;
    }
    // Re-apply the inbox ceiling (#471). `execute()` gates again at spawn time, so the agent is
    // safe either way — but a run queued while the inbox was on and recovered after it was
    // switched off would otherwise keep echoing `generateFollowups: true` on a run that
    // demonstrably produced none. Normalize the record, the way startRun does.
    const generateFollowups = followupsEnabled() ? run.generateFollowups : false;
    if (generateFollowups !== run.generateFollowups) {
      this.store.updateRun(run.id, { generateFollowups });
    }
    this.pendingJobs.set(run.id, {
      workflow,
      // Folded through the same helper `pump()` uses (#472) so a restart carries the stack.
      // Idempotent: hydration always composes from `run.task` + the stack, never from an
      // already-folded `input.task`, so re-hydrating at dequeue yields the same string.
      input: this.queuedInputFromRecord(run, generateFollowups),
    });
    this.queue.push(run.id);
    this.store.appendEvent(run.id, { type: 'lifecycle', message: `${reason} — task re-queued` });
  }

  /**
   * Startup recovery (#367) — re-adopt runs that were live when the previous
   * cezar process exited (requires the store opened with `keepLive`):
   *  - `queued`  → back into the queue (FIFO by createdAt), from the persisted
   *    workflowDef (or the catalog by name for older records);
   *  - `waiting` → the turn was over and the ball was in the user's court —
   *    settle exactly like a closed session (review/done, Continue still works);
   *  - `running` → mark interrupted, then immediately resume the last agent
   *    session via the Continue path, pointing the agent at its handoff file.
   * Call once, before the server starts taking requests.
   */
  async recover(): Promise<void> {
    const live = this.store
      .listRuns()
      .filter((r) => ['queued', 'waiting', 'running'].includes(r.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    // A crash never reaches `dropActive`, so its temp directory (#785) outlived the run.
    // Startup is the one moment we know which runs are still live, so sweep every other
    // per-run directory here — bounded to `<dataDir>/tmp`, never a sibling.
    sweepAgentTmpDirs(this.dataDir, live.map((r) => r.id));
    // Same reasoning, same moment, for the broker spools (P4): a spool whose run is over is dead
    // weight, and startup is the one point at which "which runs are still live" is knowable.
    this.sweepSpools(live.map((r) => r.id));
    for (const run of live) {
      if (run.status === 'queued') {
        await this.reviveQueuedRun(run, 'cezar restarted');
        continue;
      }
      if (run.status === 'waiting') {
        // A run parked on an APPROVAL GATE stays parked (spec 2026-08-20, P3). Everything below
        // this line settles the open step to `done` — which, for a gated step, would silently
        // grant the approval that a human was asked for and never gave. That is the exact failure
        // mode `pendingApproval` is persisted to prevent, so it is checked FIRST.
        //
        // Nothing needs to be re-run to hold the park: the record already carries the gate and the
        // approvals collected so far, and `releaseApproval`'s no-live-waiter branch re-enters the
        // chain when the decision finally arrives. Re-entering HERE would re-run the reviewer for
        // no benefit and lose nothing but time.
        if (run.pendingApproval) {
          this.store.appendEvent(run.id, {
            type: 'lifecycle',
            message: `cezar restarted — still waiting for approval (${run.pendingApproval.approvals.length}/${run.pendingApproval.minApprovers})`,
          });
          continue;
        }
        // A `waiting` run parked on an unanswered `CEZ:ASK` is waiting on the USER — settling it
        // to plain `done` here silently drops the "needs you" signal, so a restart made a task
        // with an open question look finished. Detect that before the steps are settled and keep
        // it in the attention-bearing `review` gate instead (the ask card still resumes it).
        /** An explicit unanswered marker is strong enough to outrank chain re-entry. */
        const pendingAsk = this.runHasPendingAsk(run.id);
        /** A heuristic prose verdict may preserve attention, but must never withhold queued work. */
        const pendingAttention = pendingAsk || run.waitingReason === 'question';
        // The turn was over and the ball was in the user's court, so the open step really is
        // finished — but the CHAIN may not be (spec 2026-08-20, P2). Settle the step first, then
        // ask: if later steps are still pending, re-enter at the next one instead of calling
        // `settleSuccess`, which would mark a six-step run `done` after one. An unanswered
        // question OUTRANKS that: running the next step without the answer is exactly what the
        // agent stopped to avoid, so a pending ask keeps the run parked for the user instead.
        for (const step of run.steps) {
          if (step.status === 'waiting' || step.status === 'running') {
            this.store.updateStep(run.id, step.id, { status: 'done', finishedAt: new Date().toISOString() });
          }
        }
        const settled = this.store.getRun(run.id) ?? run;
        if (!pendingAsk && (await this.reenterChain(settled, 'cezar restarted'))) continue;
        this.store.appendEvent(run.id, {
          type: 'lifecycle',
          message: pendingAttention
            ? 'cezar restarted — the open session was settled; your answer is still needed'
            : 'cezar restarted — the open session was settled',
        });
        await this.settleSuccess(run.id, { pendingAsk: pendingAttention });
        continue;
      }
      // `running`: FIRST ask whether the agent is even dead (P4 of
      // `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`). A brokered run's backend
      // lives outside this process's cgroup and outlives it, so a restart is not a crash for it —
      // its output has been accumulating in a file the whole time. Re-attaching keeps the run
      // `running`, replays exactly the bytes this process had not consumed, and adds no
      // `interrupted` event and no restart-continuation prompt. Everything below is unchanged and
      // remains the safety net: every way this can be wrong returns false.
      if (await this.reattachBrokeredRun(run)) continue;
      // The process died mid-turn. Re-enter the CHAIN first (spec 2026-08-20, P1) —
      // resuming the interrupted step's own session at its own index, the same shape
      // `reviveQueuedRun` already uses for a `queued` record. Before this, a restart during any
      // non-final step silently converted the pipeline into an open-ended `continue-N` chat and
      // the remaining steps were never going to happen.
      if (await this.reenterChain(run, 'cezar restarted', { onlyIfMoreStepsFollow: true })) {
        continue;
      }
      // Nothing revivable: fall back to the continuation path. Mark it interrupted (the state
      // continueRun expects), then pick the work back up from the last session.
      const finishedAt = new Date().toISOString();
      for (const step of run.steps) {
        if (step.status === 'running' || step.status === 'waiting') {
          // A non-empty `error`: this step did NOT fail, it was interrupted, and an empty error
          // string is what the cockpit rendered as a bare "failed" with no cause.
          this.store.updateStep(run.id, step.id, {
            status: 'failed',
            error: 'interrupted — cezar process exited during the run',
            finishedAt,
          });
        }
      }
      this.store.updateRun(run.id, {
        status: 'failed',
        error: 'interrupted — cezar process exited during the run',
        finishedAt,
        currentStepId: undefined,
      });
      const resumed = await this.continueRun(
        run.id,
        {
          text: RESTART_CONTINUATION_PROMPT,
        },
        true,
      );
      this.store.appendEvent(run.id, {
        type: 'lifecycle',
        message: resumed.ok
          ? 'cezar restarted — resuming the interrupted task from its last session'
          : `cezar restarted — could not resume the interrupted task (${resumed.error ?? 'unknown'})`,
      });
    }
    // Re-arm usage-limit resumes (spec 2026-08-03-auto-resume-after-usage-limit): the wait is
    // routinely longer than a cezar session, so the deadline is durable and the timer is rebuilt
    // from it. `pump()` reconciles again on every sweep, so this is the fast path, not the only
    // one — see `reconcileAutoResumes`.
    this.reconcileAutoResumes();
    void this.pump();
  }

  // ---- the second admission gate (D14) ----------------------------------------------------

  /**
   * Run one step's work while holding a heavy-step slot — but ONLY when the step's own definition
   * says it is heavy (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D14).
   *
   * `maxParallel` bounds how many runs are admitted at all; this bounds how many of them may be
   * inside a CPU/memory-heavy step at the same time. Two numbers, because one count cannot express
   * a workload that sits near 0.5 GB for most of a run and wants several GB inside `run-tests`.
   *
   * **`step.heavy === true` is the whole test, and it is read from the DEFINITION.** Never the
   * step's id, name, command or prompt: a name-match would be a second, invisible definition of
   * "heavy" that drifts the moment somebody names a step `tests`, and it could not be turned off
   * for a chain that genuinely wants an unbounded step. `heavy` is absent on every step of every
   * existing workflow except the catalog's `run-tests`, so this is a no-op for everything else.
   *
   * **A step that is not heavy is never gated, at any occupancy** — it does not pass through the
   * semaphore at all, so a saturated heavy gate cannot delay a `commit-push` or a check step.
   *
   * `runHeavyStep` releases in a `finally`, so a step that throws still frees its slot; that is
   * why this wraps rather than exposing acquire/release. And when `maxHeavySteps` is absent the
   * gate is `Infinity` — an install nobody opted in stays exactly as it is today, which is the
   * whole reason the config key has no schema default (`workspace/config.ts`).
   *
   * Two stated limits, both deliberate rather than overlooked:
   *
   *  - an INTERACTIVE last step holds its slot while it is parked waiting for a follow-up, because
   *    the slot's lifetime is the step's turn and an interactive turn ends at finish/idle/cancel.
   *    No built-in workflow marks such a step heavy (`run-tests` always has steps after it), so
   *    this costs nothing today — but a chain that marks its final step heavy would hold a heavy
   *    slot while idle, which is the #347 exemption's problem in a second place.
   *  - a **Continue** (`runContinuation`) and a message into an open session are NOT gated. The
   *    chain's own re-entries come back through this loop and are; those two are a person acting on
   *    one run by hand, and D15a's rule for exactly this shape is that a human asserting intent on
   *    this host proceeds. Making the owner's Continue queue behind two other runs' test steps
   *    would be the gate deciding something it was not built to decide.
   */
  private async withHeavyStep<T>(
    step: WorkflowStepDef,
    emit: (event: { type: string; stepId?: string; [k: string]: unknown }) => void,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (step.heavy !== true) return fn();
    const max = this.semaphore.maxHeavySteps();
    const active = this.semaphore.heavyActive();
    // Queueing at this gate is expected and correct — thrashing is what it prevents — but a step
    // that sits `running` while it is actually waiting is a state the cockpit cannot read. Same
    // reasoning as the repository-root lease's "waiting for exclusive access" note. Advisory only:
    // the gate is `runHeavyStep`, and this line never decides anything.
    if (active >= max) {
      emit({
        type: 'note',
        stepId: step.id,
        message: `waiting for a heavy-step slot — ${active}/${max} heavy steps running across the workspace`,
      });
    }
    return this.semaphore.runHeavyStep(fn);
  }

  // ---- run brokering (P4) ---------------------------------------------------------------
  //
  // `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`. The seam is deliberately tiny:
  // everything below decides WHETHER a session is brokered and WHERE its spool lives. Nothing
  // above the runner learns that a run moved out of process, which is what makes this tractable
  // against a file this size.

  /** Which cgroup escape this host actually supports. Re-probed until a `'scope'` result is
   *  observed, then cached for the process's lifetime — see the field's own doc comment for why
   *  a non-`'scope'` result must never be cached unconditionally. */
  brokerIsolation(): BrokerIsolation {
    if (this.brokerIsolationCache !== 'scope') {
      this.brokerIsolationCache = chooseIsolation(probeIsolationCapabilities());
    }
    if (this.brokerIsolationCache !== 'scope' && this.brokerIsolationWarnedFor !== this.brokerIsolationCache) {
      this.brokerIsolationWarnedFor = this.brokerIsolationCache;
      console.warn(
        `[cez] run broker isolation is '${this.brokerIsolationCache}', not 'scope' — brokered runs will`
        + ` survive a 'systemctl restart' of this service but NOT a full 'systemctl stop' + 'start'.`
        + ` See .ai/specs/2026-08-22-broker-scope-isolation-full-stop-survival.md.`,
      );
    }
    return this.brokerIsolationCache;
  }

  /**
   * Claim this run's pending re-attach, but only if it names THIS step.
   *
   * Consuming unconditionally is the point: an entry that does not match is stale — the chain
   * moved on, or the record and the spool disagreed — and leaving it behind would let a later step
   * re-attach to an older step's spool. One read, then gone, either way.
   */
  private takeReattach(runId: string, stepId: string): { spoolDir: string; startOffset: number } | undefined {
    const pending = this.pendingReattach.get(runId);
    if (!pending) return undefined;
    this.pendingReattach.delete(runId);
    return pending.stepId === stepId ? { spoolDir: pending.spoolDir, startOffset: pending.startOffset } : undefined;
  }

  /** The furthest offset this process has recorded for a run. */
  private lastOffset(runId: string): number {
    return this.offsetWrites.get(runId)?.offset ?? 0;
  }

  /** Absolute spool dir for a run, from the record's relative path or the default layout. */
  private spoolDirOf(run: RunRecord): string {
    return run.spoolDir ? join(this.dataDir, run.spoolDir) : legacySpoolDirFor(join(this.dataDir, 'runs'), run.id);
  }

  /**
   * The broker request for one step, or `undefined` to keep the in-process path.
   *
   * Three gates, all of which must pass, and each of which is a real limit rather than caution:
   * the backend must be one whose stdout a spool can stand in for (`claude` today), this cezar
   * must have a built entry point to re-exec as the broker, and the run must not already be
   * re-attaching to a live spool for this very step.
   */
  private async brokerFor(
    runId: string,
    stepId: string,
    backend: RunnerId,
  ): Promise<BrokerSessionRequest | undefined> {
    if (!(BROKERED_BACKENDS as readonly string[]).includes(backend)) return undefined;
    if (!brokerAvailable()) return undefined;
    const instanceId = nextBrokerInstanceId();
    const spoolDir = spoolDirFor(join(this.dataDir, 'runs'), runId, instanceId);
    // Recorded BEFORE the spawn: a crash in the same millisecond must still leave the next process
    // a path to probe. Written relative to `dataDir` — see the field's own note in `store.ts`.
    this.store.updateRun(runId, { spoolDir: relative(this.dataDir, spoolDir), consumedOffset: 0 });
    this.offsetWrites.set(runId, { offset: 0, written: 0, at: Date.now() });
    return {
      spoolDir,
      runId,
      instanceId,
      stepId,
      isolation: this.brokerIsolation(),
      resources: await this.runResourceLimits(),
      onResourceKill: (kill) => this.recordResourceKill(runId, stepId, kill),
      onOffset: (offset) => this.persistConsumedOffset(runId, offset),
    };
  }

  /**
   * The D14a cgroup bounds one broker launch is created with, read from workspace `resources`.
   *
   * Read from the FILE here rather than from `WorkspaceSemaphore`'s cache, because the semaphore
   * caches only the two admission numbers and the process-tree memory guard — these four keys are
   * not in its snapshot, and widening that snapshot is `workspace/semaphore.ts`'s call, not this
   * file's. The read is once per broker launch (once per step), never per tick, which is the
   * invariant the semaphore's own docblock defends: it exists because the memory guard samples
   * every ~2 s per manager, not because reading the config is expensive.
   *
   * An unreadable config degrades to no bounds — which is exactly today's behaviour, and the right
   * direction to fail: an unbounded run is what cezar has always shipped, whereas guessing a
   * ceiling from a file we could not read would kill work for a number nobody chose.
   */
  private async runResourceLimits(): Promise<BrokerResourceLimits> {
    try {
      const { resources } = await loadWorkspaceConfig();
      return {
        runMemoryHighMb: resources.runMemoryHighMb,
        runMemoryMaxMb: resources.runMemoryMaxMb,
        runCpuWeight: resources.runCpuWeight,
        runsSliceMemoryMaxMb: resources.runsSliceMemoryMaxMb,
      };
    } catch {
      return {};
    }
  }

  /**
   * A cgroup bound killed this run's processes (C3).
   *
   * Written on the RUN, not the step, because that is where the field lives (`runs/store.ts`) and
   * because the fact outlives the step: a chain re-entry re-runs the step, and the record must
   * still be able to answer "was this run ever killed by a bound?" afterwards. The step's own
   * failure message names the bound too — `claude-cli-runner.ts` appends the detail — so the two
   * surfaces agree.
   *
   * The note is not decoration. It is the sentence a person (and the run's own next agent) reads
   * instead of concluding that the tests broke: "a bound whose failure mode is indistinguishable
   * from a code failure will be blamed on the code."
   */
  private recordResourceKill(runId: string, stepId: string | undefined, kill: ResourceKillReport): void {
    this.store.updateRun(runId, { resourceKill: kill });
    this.store.appendEvent(runId, {
      type: 'note',
      ...(stepId ? { stepId } : {}),
      message: `run killed by a resource bound — ${kill.detail}. This is NOT a test or code failure; the step was stopped by the host.`,
    });
    // Named now so "how often does a bound actually fire, and on which step?" has an answer next
    // time instead of a grep — the same reason `run.step.stopped` is emitted.
    this.store.appendEvent(runId, {
      type: 'metric',
      ...(stepId ? { stepId } : {}),
      name: 'run.resource_kill',
      runId,
      limit: kill.limit,
      at: kill.at,
    });
  }

  /**
   * Persist how far this process has consumed the spool, at most once a second.
   *
   * The throttle is not premature optimization: the tail wakes every 50 ms and `updateRun` writes
   * the whole run index, so an unthrottled offset would turn a chatty agent into twenty full
   * `runs.json` rewrites a second. The cost of the throttle is bounded and cheap — a crash inside
   * the window re-attaches up to a second early and REPLAYS those records, which is exactly the
   * direction the design tolerates: a duplicate event is visible and harmless, a lost one is not.
   *
   * `force` is used when the session ends, so the final offset is always durable.
   */
  private persistConsumedOffset(runId: string, offset: number, force = false): void {
    const last = this.offsetWrites.get(runId) ?? { offset: 0, written: -1, at: 0 };
    // Always remember the newest report, even when the write is throttled away — otherwise the
    // final flush below would have nothing newer than the last throttled write to persist, and
    // the whole point of forcing it is the progress the throttle is currently holding.
    const latest = Math.max(last.offset, offset);
    if (latest <= last.written) {
      this.offsetWrites.set(runId, { ...last, offset: latest });
      return;
    }
    if (!force && Date.now() - last.at < OFFSET_PERSIST_MS) {
      this.offsetWrites.set(runId, { ...last, offset: latest });
      return;
    }
    this.offsetWrites.set(runId, { offset: latest, written: latest, at: Date.now() });
    this.store.updateRun(runId, { consumedOffset: latest });
  }

  /**
   * Take a run whose agent is STILL ALIVE behind a broker and keep it running (P4 re-attach).
   *
   * Returns false — leaving the caller's existing interrupted-run handling to deal with it — for
   * every reason a re-attach could be wrong, and there are many: the backend is not brokered, the
   * spool is gone or belongs to another run, the broker died, the protocol moved, no step is
   * actually running, or the chain's resume point is not the step the spool holds. **Failing open
   * is the whole safety argument.** The dangerous outcome here is not "we re-attached when we
   * could have restarted"; it is a live agent left with nobody reading it, which is strictly worse
   * than today's behaviour. Every uncertain branch therefore falls back to today's behaviour.
   *
   * Unlike a chain re-entry this does NOT re-queue the run. `reenterChain` sets the record to
   * `queued` and waits for a slot, which would make the run's status leave `running` — the exact
   * thing the acceptance criterion says must not happen — while its agent kept working unwatched.
   * So the job is handed straight to `execute()`, which re-adopts the run, re-takes its slot and
   * re-enters the chain at the surviving step.
   */
  private async reattachBrokeredRun(run: RunRecord): Promise<boolean> {
    const backend = run.runner ?? 'claude';
    if (!(BROKERED_BACKENDS as readonly string[]).includes(backend)) return false;
    const spoolDir = this.spoolDirOf(run);
    const meta = readSpoolMeta(spoolDir);
    const refuse = async (): Promise<false> => {
      if (meta && await this.reapBroker(run.id, meta)) {
        this.store.appendEvent(run.id, {
          type: 'lifecycle',
          message: `adopted-out agent stopped: broker ${meta.pid}`,
        });
      }
      return false;
    };
    if (!isSpoolLive(spoolDir)) return refuse();
    if (!meta || meta.runId !== run.id || !meta.stepId) return refuse();
    const openStep = run.steps.find((s) => s.id === meta.stepId);
    if (!openStep || stepTerminal(openStep.status)) return refuse();

    const workflow = await this.reviveWorkflow(run);
    if (!workflow) return refuse();
    const resumeAt = this.chainResumeAt(run, workflow);
    // The spool must hold the step the chain is about to run. A mismatch means the record and the
    // spool disagree about where this run is, and guessing between them is precisely how a run
    // ends up with two live agents.
    if (!resumeAt || workflow.steps[resumeAt.index]?.id !== meta.stepId) return refuse();

    this.pendingReattach.set(run.id, {
      stepId: meta.stepId,
      spoolDir,
      startOffset: run.consumedOffset ?? 0,
    });
    this.store.appendEvent(run.id, {
      type: 'lifecycle',
      message: 'cezar restarted — this run kept going',
    });
    this.starting.add(run.id);
    const input = this.queuedInputFromRecord(run, followupsEnabled() ? run.generateFollowups : false);
    void this.execute(run.id, workflow, input, resumeAt).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.pendingReattach.delete(run.id);
      this.store.updateRun(run.id, {
        status: 'failed',
        error: `re-attach crashed: ${message}`,
        finishedAt: new Date().toISOString(),
      });
      this.starting.delete(run.id);
      this.dropActive(run.id);
    });
    return true;
  }

  /**
   * Delete spool directories whose runs are over.
   *
   * The mirror of `sweepAgentTmpDirs`, and needed for the same reason: a crash never reaches the
   * tidy-up path, so yesterday's spools accumulate. Bounded to `<dataDir>/runs/*.spool` and skips
   * anything still live, so a sweep can never remove a spool a re-attach is about to use.
   */
  private sweepSpools(liveRunIds: string[]): void {
    const runsDir = join(this.dataDir, 'runs');
    const live = new Set(liveRunIds);
    let entries: string[];
    try {
      entries = readdirSync(runsDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.spool')) continue;
      const parent = join(runsDir, entry);
      const runId = entry.slice(0, -'.spool'.length);
      let children: string[];
      try {
        children = readdirSync(parent);
      } catch {
        continue;
      }
      // A flat protocol-1 spool has files directly in the parent. Keep it only while its run is live.
      if (children.some((child) => child === 'meta.json')) {
        if (!live.has(runId) && !isSpoolLive(parent)) rmSync(parent, { recursive: true, force: true });
        continue;
      }
      for (const child of children) {
        const instanceDir = join(parent, child);
        if (isSpoolLive(instanceDir)) continue;
        if (!readSpoolMeta(instanceDir)) {
          try {
            if (Date.now() - statSync(instanceDir).mtimeMs <= SPOOL_ORPHAN_GRACE_MS) continue;
          } catch {
            continue;
          }
        }
        rmSync(instanceDir, { recursive: true, force: true });
      }
      try {
        if (readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true });
      } catch {
        // Concurrent broker launch or cleanup, leave it for the next sweep.
      }
    }
  }

  /** The persisted definition when it looks sane, else the catalog by name. */
  private async reviveWorkflow(run: RunRecord): Promise<WorkflowDef | null> {
    // "Looks sane" is the STORE's job now: it parses `workflowDef` against the definition schema
    // and `.catch`es a def that no longer fits to `undefined`, so anything present here already
    // has the `steps` array the old inline `Array.isArray` check was asking for.
    const def = run.workflowDef;
    if (def) return def;
    const { workflows } = await loadWorkflows(this.repoRoot);
    return workflows.find((w) => w.name === run.workflow) ?? null;
  }

  /**
   * Where this run's chain picks back up, and whether the interrupted step's session may be
   * reattached (spec 2026-08-20, P1). `undefined` when every definition step is terminal —
   * there is nothing to re-enter and the caller settles as it always did.
   */
  private chainResumeAt(run: RunRecord, workflow: WorkflowDef): ChainResumePoint | undefined {
    // A catalog-revived def may not be this run's def at all (see `defDescribesRun`). Re-entering
    // against a foreign one would re-run finished work, so bail to the caller's old path instead.
    if (!defDescribesRun(workflow.steps, run.steps)) return undefined;
    const index = firstUnfinishedStep(workflow.steps, run.steps);
    const def = index < 0 ? undefined : workflow.steps[index];
    if (index < 0 || !def) return undefined;
    if (stepKind(def) !== 'agent') return { index }; // a check step is a shell command; nothing to resume
    const record = run.steps.find((s) => s.id === def.id);
    // Session ids are provider-owned opaque values (#562): reattaching one to the wrong backend
    // corrupts the run, so a mismatch simply starts the step fresh. Same affinity rule
    // `continueRun` applies — new records carry explicit affinity, legacy ones fall back to the
    // run's current runner as the conservative owner.
    //
    // A step-level pin can be DOWNGRADED at dispatch when its provider is wholly out of quota
    // (`downgradePinnedRunner`, `2026-08-23-never-block-a-task.md`), so `def.runner` and
    // `record.backend` can now legitimately differ on a step that ran perfectly well. That reads
    // here as a mismatch and starts the step fresh — **safe in both directions** (a codex session
    // is never handed to claude, or the reverse) and **lossy in one**: after a restart with the
    // pinned provider still exhausted, the step re-runs instead of resuming its downgraded
    // session. Deliberately left lossy. Resolving it properly means re-asking the downgrade
    // question, which is async and reads two JSON files, from a synchronous predicate that runs on
    // every recovery sweep — and getting that wrong reattaches a session to the wrong provider,
    // which corrupts the run rather than costing a turn.
    const stepBackend = def.runner ?? run.runner ?? 'claude';
    const sessionBackend = record?.backend ?? run.runner ?? 'claude';
    // `pending` means the step never opened a session in the first place — any `sessionId` on it
    // was minted for an attempt that did not start, so there is nothing on the other end.
    if (!record?.sessionId || record.status === 'pending' || sessionBackend !== stepBackend) {
      return { index };
    }
    const total = workflow.steps.filter((step) => stepKind(step) === 'agent').length;
    const position = workflow.steps.slice(0, index).filter((step) => stepKind(step) === 'agent').length + 1;
    return {
      index,
      resume: {
        sessionId: record.sessionId,
        // `sessionId` and `profileId` are a PAIR — a resume that reads the wrong account's
        // config dir finds no session and silently starts a fresh one instead.
        ...(record.profileId ? { profileId: record.profileId } : {}),
        prompt: restartContinuationPrompt({ position, total }),
        // This id was recorded by an earlier process invocation — see `ChainResumePoint.resume`.
        verifyTranscript: true,
      },
    };
  }

  /**
   * Hand a run back to its CHAIN instead of finishing it (spec 2026-08-20, P1/P2) — the fix for
   * the two paths that used to end a six-step run from a one-step signal: restart recovery, which
   * replaced the remaining steps with a synthetic `continue-N` chat, and a continuation's
   * `CEZ:DONE`, which had no chain guard at all.
   *
   * Re-entry goes through the QUEUE (`pendingJobs` + `queue.push`), never a direct `execute()`:
   * that is the only path that respects the workspace semaphore, the repo-root lease and the
   * `maxParallel` cap. A turn-end handler calling `execute()` inline would run a second engine
   * loop for a run that still holds a slot.
   *
   * Returns `true` when the run has been HANDLED — re-queued, or failed for making no progress.
   * The caller must not settle it either way. `false` means nothing could be revived and the
   * caller's old path (a continuation, or `settleSuccess`) still applies.
   */
  private async reenterChain(
    // Reassigned when `opts.resetTo` rewinds the record — the resume point must be computed
    // against the steps as they are AFTER the rewind, not before it.
    run: RunRecord,
    reason: string,
    opts: {
      /** R4: a hand-back that does not shorten the chain is a loop. Recovery may legitimately
       *  re-enter the SAME step (a second restart), so only the turn-end hand-back asks for it. */
      requireProgress?: boolean;
      /**
       * The caller's fallback already covers the step being resumed, so re-entry is only worth
       * taking over for when the chain OUTLIVES that step. `recover()`'s `running` branch is the
       * one caller in that position: its `continueRun` fallback resumes the interrupted step's own
       * session, which is the whole job for a single-step `quick-task` (and for a chain
       * interrupted on its last step) — and that path carries its own hard-won behaviour, from
       * per-project cap queueing to the #562 session-failure containment. Narrowing here keeps
       * this fix to what it is about: a chain whose REMAINING steps would otherwise be dropped.
       */
      onlyIfMoreStepsFollow?: boolean;
      /**
       * Rewind before resuming: reset this step, and every step back to its `onFail.retry`
       * target, to `pending` so the re-entry lands on the TARGET rather than on the step that
       * was just released. Used by a "request changes" that arrives with no live `execute()` to
       * loop back in-process (spec 2026-08-20, P3).
       */
      resetTo?: string;
      /** Carried into the resumed step's prompt — see `ChainResumePoint.feedback`. */
      feedback?: string;
    } = {},
  ): Promise<boolean> {
    const workflow = await this.reviveWorkflow(run);
    if (!workflow) return false;
    if (opts.resetTo) {
      const fromIdx = workflow.steps.findIndex((s) => s.id === opts.resetTo);
      const target = workflow.steps[fromIdx]?.onFail?.retry;
      const retryIdx = target ? workflow.steps.findIndex((s) => s.id === target) : -1;
      // Only ever backwards, and only when both ends resolve — `stepsIssue` guarantees the
      // ordering at load time, but a REVIVED definition may not be the one this record was
      // written against, so the bounds are re-checked rather than assumed.
      if (fromIdx >= 0 && retryIdx >= 0 && retryIdx <= fromIdx) {
        for (const between of workflow.steps.slice(retryIdx, fromIdx + 1)) {
          this.store.updateStep(run.id, between.id, { status: 'pending', error: undefined });
        }
        run = this.store.getRun(run.id) ?? run;
      }
    }
    const resumeAt = this.chainResumeAt(run, workflow);
    if (!resumeAt) return false;
    if (opts.feedback) resumeAt.feedback = opts.feedback;
    const remaining = workflow.steps.length - resumeAt.index;
    if (opts.onlyIfMoreStepsFollow && remaining < 2) return false;
    const nextId = workflow.steps[resumeAt.index]?.id ?? '?';
    if (opts.requireProgress) {
      const previous = this.chainReentries.get(run.id);
      if (previous !== undefined && remaining >= previous) {
        const error = `chain re-entry made no progress — still ${remaining} step(s) pending at "${nextId}"`;
        this.store.updateRun(run.id, {
          status: 'failed',
          error,
          finishedAt: new Date().toISOString(),
          currentStepId: undefined,
          activity: undefined,
        });
        this.store.appendEvent(run.id, { type: 'lifecycle', message: `run failed — ${error}` });
        this.chainReentries.delete(run.id);
        return true;
      }
    }
    this.chainReentries.set(run.id, remaining);
    // Re-apply the inbox ceiling exactly as `reviveQueuedRun` does — same reason (#471).
    const generateFollowups = followupsEnabled() ? run.generateFollowups : false;
    this.pendingJobs.set(run.id, {
      workflow,
      input: this.queuedInputFromRecord(run, generateFollowups),
      resumeAt,
    });
    // Steps about to re-run go back to `pending` so the GUI rail reads top-to-bottom truthfully
    // while the run sits in the queue — the same normalization `execute()`'s retry loop does.
    for (const step of workflow.steps.slice(resumeAt.index)) {
      const record = run.steps.find((s) => s.id === step.id);
      if (record && !stepTerminal(record.status)) {
        this.store.updateStep(run.id, step.id, { status: 'pending', finishedAt: undefined });
      }
    }
    this.store.updateRun(run.id, {
      status: 'queued',
      error: undefined,
      finishedAt: undefined,
      currentStepId: undefined,
      activity: undefined,
      generateFollowups,
    });
    this.queue.push(run.id);
    this.store.appendEvent(run.id, {
      type: 'lifecycle',
      message: `${reason} — chain re-queued at step "${nextId}" (${remaining} of ${workflow.steps.length} step(s) remaining)`,
    });
    return true;
  }

  /** Remove a run from the live registries — keeps `waiting ⊆ active`. */
  private dropActive(runId: string): void {
    const state = this.active.get(runId);
    if (state) this.clearWorktreeLeases(state, runId);
    state?.releaseRepoRoot?.();
    if (state) state.releaseRepoRoot = undefined;
    this.waiting.delete(runId);
    this.monitoring.delete(runId);
    if (state) this.clearMonitoringWakeTimer(state, runId);
    this.active.delete(runId);
    this.memoryPausing.delete(runId);
    this.lastNamerKey.delete(runId);
    this.forceStarted.delete(runId);
    this.autoTaskClasses.delete(runId);
    // The run's slot is gone from busySlots() as of the deletes above — hand it
    // to the workspace's oldest queued run, in ANY project. Every terminal path
    // funnels through here, so this one call covers them all.
    // Same reasoning as retention below — every terminal path funnels through here, so the
    // usage-limit question ("did this run stop because the account is out of window, and when
    // does that window reopen?") is asked once, in one place, off the record the failing path
    // has already written. Nothing to do for any other outcome.
    //
    // BEFORE releasing the slot, and that order is the whole point: `releaseSlot` pumps every
    // manager, and a pump reads the hold off the records. Publishing the schedule afterwards
    // left a window — measured as exactly one extra task — where the queue saw a free slot and
    // an account that looked healthy, and started work that was already doomed.
    this.scheduleAutoResumeIfLimited(runId);
    this.releaseSlot();
    // A run leaving the active registry is a terminal transition (done/review/
    // failed/cancelled) — the one moment the finished-worktree count can grow.
    // Enforce count-based retention (#483) here so a single hook covers every
    // terminal path. Fire-and-forget: retention must never delay or throw into
    // the lifecycle.
    void this.enforceRetention();
    // The run's temp directory (#785) goes on the same terminal transition, and
    // unconditionally — it is scratch, not an artifact, so unlike a worktree
    // there is no keep-count to respect and nothing left to recover from it. A
    // Continue (or an auto-resume) re-creates it through `agentEnv`.
    removeAgentTmpDir(this.dataDir, runId);
  }

  // ---- usage-limit auto-resume (spec 2026-08-03-auto-resume-after-usage-limit) --------------

  /**
   * A run just failed: if the provider said "usage limit, back at T", promise to resume it at
   * `T + AUTO_RESUME_GRACE_MS` instead of leaving the task dead until someone notices.
   *
   * Every refusal below is silent-but-honest — the run stays `failed` with its Continue button,
   * which is exactly the pre-feature behavior — except the safety cap, which says so on the
   * transcript, because a run that stops resuming itself needs to explain why.
   */
  private scheduleAutoResumeIfLimited(runId: string): void {
    if (this.autoResumeTimers.has(runId)) return; // already promised
    const run = this.store.getRun(runId);
    if (!run || run.status !== 'failed') return;
    // Archiving IS resigning from a task. Reviving one because a window happened to reopen would
    // be the feature working against the clearest signal the user can give it.
    if (run.archived) return;
    const limit = parseUsageLimit(run.error);
    if (!limit) return;
    // Write the limit down BEFORE any of the refusals below. Whether THIS run will resume itself
    // is a different question from whether THAT account is exhausted, and every early return under
    // this line answers only the first: the setting being off, the run having no session to resume,
    // and the resume cap being spent are all reasons not to re-run this task, and none of them is
    // evidence the provider's window reopened. Recording under them would leave the pool routing
    // onto a login that just said no, which is the production failure this closes.
    this.recordAccountLimit(run, limit.resetAt);
    if (!this.semaphore.autoResumeOnUsageLimit()) return;
    // No session to resume = nothing this feature can do; `continueRun` would refuse anyway.
    if (!run.steps.some((step) => step.sessionId)) return;
    const attempts = run.autoResumeAttempts ?? 0;
    if (attempts >= MAX_AUTO_RESUMES) {
      this.store.appendEvent(runId, {
        type: 'note',
        message: `automatic resume cap reached (${MAX_AUTO_RESUMES}) — continue this task manually`,
      });
      return;
    }
    const wakeAt = new Date(limit.resetAt.getTime() + AUTO_RESUME_GRACE_MS);
    this.armAutoResume(runId, wakeAt.getTime());
    this.store.appendEvent(runId, {
      type: 'lifecycle',
      message: `usage limit reached — resuming automatically at ${formatWakeInstant(wakeAt)}`,
    });
  }

  /**
   * Tell the account balancer that a provider just refused this run's account
   * (`.ai/specs/2026-08-23-retarget-task-to-another-engine.md`, Phase 1).
   *
   * `selectPoolAccount` has ranked "skip a limited account" as signal 1 since
   * `2026-08-16-agent-account-usage-routing.md` — the stated reason pools exist at all. It was
   * dead code in production for a week: `recordLimited()` had no caller outside its own tests, so
   * `AccountUsageEntry.limited` was never written, `isLimited()` answered `false` for an account
   * that had just said no, and the pool routed straight back onto it. What masked the gap is the
   * queue hold, which stops the work a different way — but the hold is per-run and per-account,
   * and it parks the task instead of moving it, which is exactly what the reporter hit.
   *
   * **Keyed with `usageHoldAccountKey`, not `runAccountKey`.** The account that was refused is on
   * the STEP that ran, not on the run record: `spec-to-deploy` pins `spec` and `review-spec` to
   * claude whatever the task was started on, and a `pool:` route may put two steps of one run on
   * two logins. Keying off the record is the bug `2026-08-23-usage-limit-hold-account.md` was
   * filed for, and repeating it here would poison the balancer in both directions at once —
   * excluding a healthy login while leaving the closed one eligible.
   *
   * `until` is the provider's own stated reset, passed through only because `parseUsageLimit`
   * extracted it from the provider's own words. An absent one would fall to
   * `ASSUMED_LIMIT_COOLDOWN_MS`; here there is always one, because a `limit` is what got us here.
   *
   * Fire-and-forget, like every other write to this store: `mergeWriteAgentAccountUsage` never
   * throws (a read-only home degrades to in-memory state), and a lost write costs one dispatch's
   * fairness, never a run. Blocking the failure path on a JSON write would be the worse trade.
   */
  private recordAccountLimit(run: RunRecord, resetAt: Date): void {
    const account = usageHoldAccountKey(run, run.runner ?? 'claude');
    void mergeWriteAgentAccountUsage((store) =>
      recordLimited(store, account, { source: 'usage-limit', until: resetAt.toISOString() }),
    );
  }

  /**
   * The account a task NAMED is out of quota — move it to one that is not
   * (`.ai/specs/2026-08-23-retarget-task-to-another-engine.md`, Phase 4). `undefined` means "leave
   * the run where it is", which is also every answer when the setting is off.
   *
   * **Only for an explicit pick.** A `pool:` route is resolved by `resolvePoolForDispatch` before
   * this is reached and already skips limited logins as its first signal — that is Phase 1, and it
   * needs no setting because a pool is the user asking to be balanced. This is the other case: a
   * user who named `codex`, or a specific login, and whose choice cezar would otherwise honour by
   * making them wait.
   *
   * **This is the one place the override may live.** The admission gate is synchronous and runs
   * per pump sweep; resolving an account there would mean two JSON reads per sweep, and doing it
   * through `resolvePoolForDispatch` would advance the fairness cursor as a side effect. So
   * admission simply stops holding when the setting is on (`heldAccountFor`) and the real decision
   * happens here, once, at the moment the run stops being a plan and becomes work.
   *
   * `selectPoolAccount` is reused rather than reimplemented: "best available login" is the same
   * question a pool asks, and a second ranking would drift from the first the moment either
   * changed. It is pure, so unlike `resolvePoolForDispatch` it moves no cursor — `recordDispatch`
   * below is written explicitly, so the account this run takes still counts toward fairness.
   */
  private async rerouteExplicitAccountIfLimited(
    runId: string,
    input: ExecuteRunInput,
    defaultRunner: RunnerId,
  ): Promise<PoolChoice | undefined> {
    if (!this.semaphore.fallbackAcrossAccountsWhenLimited()) return undefined;
    try {
      const [accounts, usage] = await Promise.all([loadAgentAccounts(), loadAgentAccountUsage()]);
      const provider = (input.runner ?? defaultRunner) as ProviderId;
      // A dangling `agentProfile` — one that names no stored account for this provider (a since-
      // removed account, or a value written before the account existed) — resolves to the provider's
      // DEFAULT login downstream (`selectProfile`'s own fallback, `workspace/agent-profiles.ts`).
      // Checking the raw id here reads as "not limited" for an id that never had a usage entry in
      // the first place, so this returned early forever while the DEFAULT account it silently fell
      // back to sat held: measured on `prod-host`, a run pinned to `codex:secondary` — no such
      // account exists — kept resolving to (and failing on) the held `codex:default`, while a real,
      // unlimited `codex:second-example-com` sat idle. Resolve against the same rule
      // `selectProfile` uses so this checks the hold on the account that will actually run.
      const resolvedAgentProfile =
        input.agentProfile !== undefined &&
        input.agentProfile !== DEFAULT_AGENT_ACCOUNT_ID &&
        accounts.accounts.some((account) => account.provider === provider && account.id === input.agentProfile)
          ? input.agentProfile
          : undefined;
      const current = accountUsageKey(provider, resolvedAgentProfile);
      // Nothing to route around. The common case, and the cheap exit.
      if (!isLimited(usageEntry(usage, current).limited)) return undefined;

      const candidates = listAgentProfiles(accounts, PROFILE_CAPABLE_PROVIDERS).filter(
        (profile) => !isLimited(usageEntry(usage, accountUsageKey(profile.provider, profile.isDefault ? undefined : profile.id)).limited),
      );
      // Every login limited: `selectPoolAccount` would still answer (by design — see its docblock),
      // and its answer would be another closed account. Filtering FIRST and refusing an empty set
      // is what keeps this from quietly moving the run somewhere no better, which would burn a turn
      // and lose the account the user actually chose.
      const choice = candidates.length > 0
        ? selectPoolAccount({ candidates, store: usage, inflight: this.semaphore.accountInflight() })
        : undefined;
      if (!choice) return undefined;
      if (choice.provider === provider && choice.accountId === (resolvedAgentProfile ?? DEFAULT_AGENT_ACCOUNT_ID)) {
        return undefined;
      }

      await mergeWriteAgentAccountUsage((store) =>
        recordDispatch(store, accountUsageKey(choice.provider, choice.accountId)),
      );
      // Say so, always. Overriding a choice the user made in silence is the failure this whole
      // setting is a decision about — the note is what makes it a fallback rather than cezar
      // ignoring the picker, which is the bug this spec was filed for in the first place.
      this.store.appendEvent(runId, {
        type: 'note',
        message:
          `${current} is out of quota, so this task starts on ${accountUsageKey(choice.provider, choice.accountId)} instead ` +
          '(Settings, Resources, "Out-of-quota fallback")',
      });
      return choice;
    } catch {
      // An unreadable home must never fail a run: fall through to the account the task named and
      // let the ordinary hold park it, which is exactly the behaviour with this setting off.
      return undefined;
    }
  }

  /**
   * A step pins a provider that is WHOLLY out of quota — return where to run it instead.
   *
   * `undefined` means "keep the pin", which is every ordinary case: the setting is off, the step
   * pins nothing, or at least one account of the pinned provider is still open. Only when the
   * pinned provider has no usable login anywhere does this answer, and then it answers with the
   * best available account on another provider.
   *
   * **Keyed on EVERY account of the provider being limited, never on one.** One exhausted login is
   * `resolvePoolForProvider`'s job — it moves within the provider and keeps the pin's promise
   * intact. Downgrading there would throw away a working Claude account to satisfy a rule about
   * availability, which is the opposite of what the rule is for.
   *
   * Never throws: an unreadable home keeps the pin, which is the behaviour that predates this.
   */
  private async downgradePinnedRunner(
    runId: string,
    step: { id: string; model?: string | undefined },
    pinned: RunnerId,
  ): Promise<RunnerId | undefined> {
    if (!this.semaphore.fallbackAcrossAccountsWhenLimited()) return undefined;
    try {
      const [accounts, usage] = await Promise.all([loadAgentAccounts(), loadAgentAccountUsage()]);
      const all = listAgentProfiles(accounts, PROFILE_CAPABLE_PROVIDERS);
      const open = all.filter(
        (profile) =>
          !isLimited(
            usageEntry(usage, accountUsageKey(profile.provider, profile.isDefault ? undefined : profile.id)).limited,
          ),
      );
      // Still somewhere to go on the pinned provider — not this function's problem.
      if (open.some((profile) => profile.provider === pinned)) return undefined;
      const choice = open.length > 0
        ? selectPoolAccount({ candidates: open, store: usage, inflight: this.semaphore.accountInflight() })
        : undefined;
      // Nothing open anywhere. Keep the pin and let the turn fail honestly rather than moving the
      // work somewhere no better — rung 4 of the ladder, and the bottom of "never blocked".
      if (!choice || choice.provider === pinned) return undefined;

      this.store.appendEvent(runId, {
        type: 'note',
        stepId: step.id,
        message:
          `this step asks for ${step.model ? `${step.model} on ` : ''}${pinned}, and every ${pinned} account is out of quota — ` +
          `running on ${accountUsageKey(choice.provider, choice.accountId)} instead`,
      });
      return choice.provider as RunnerId;
    } catch {
      return undefined;
    }
  }

  /**
   * A turn on this account completed, so the window is open — drop any recorded limit on it.
   *
   * **A completed turn is the only honest proof.** The stored `until` is a provider's prediction,
   * and `isLimited` already expires it on time; this covers the other direction, where the window
   * reopened earlier than stated or the limit was recorded against the wrong window. Without it a
   * pool would keep avoiding a working login until the clock caught up.
   *
   * Reads the STEP's own `backend`/`profileId` — the account that actually served the turn, which
   * for a pooled run is not the one the record names. A step with no `backend` (a `check` step, or
   * one from before backend affinity) is not evidence about any account, so it clears nothing:
   * guessing here would clear a limit on a login that never ran.
   */
  private clearAccountLimit(runId: string, stepId: string): void {
    const step = this.store.getRun(runId)?.steps.find((candidate) => candidate.id === stepId);
    if (!step?.backend) return;
    const account = accountUsageKey(step.backend, step.profileId);
    void mergeWriteAgentAccountUsage((store) => clearLimited(store, account));
  }

  /** Publish the deadline on the record (the cockpit's only source) and arm the timer for it. */
  private armAutoResume(runId: string, deadline: number): void {
    this.store.updateRun(runId, { autoResumeAt: new Date(deadline).toISOString() });
    const timer = setTimeout(() => void this.fireAutoResume(runId), Math.max(0, deadline - Date.now()));
    timer.unref?.();
    this.autoResumeTimers.set(runId, timer);
  }

  /**
   * The window has reopened. Re-check the record synchronously — hours may have passed, and the
   * user may have continued, deleted or cancelled the run in them — then hand the resume to the
   * ordinary queued-continuation path so it obeys both concurrency caps like any other work.
   */
  private async fireAutoResume(runId: string): Promise<void> {
    this.autoResumeTimers.delete(runId);
    const run = this.store.getRun(runId);
    if (!run || run.status !== 'failed' || !run.autoResumeAt) return;
    // Belt and braces against the one gap `reconcileAutoResumes` cannot close: the setting going
    // off in the window between the last pump and this tick.
    if (!this.semaphore.autoResumeOnUsageLimit()) {
      this.clearAutoResume(runId);
      return;
    }
    const attempts = (run.autoResumeAttempts ?? 0) + 1;
    // `continueRun` retires the pending resume (timer + record fields) on the way in — this is a
    // resume, not a user turn, so the counter is put back straight after.
    const resumed = await this.continueRun(runId, { text: AUTO_RESUME_PROMPT }, true);
    if (!resumed.ok) {
      // Refusals happen before `continueRun` retires anything, so the deadline is still on the
      // record — and a deadline in the past is a promise the cockpit keeps displaying and the
      // engine will never keep. Retire it here instead, and say why.
      this.clearAutoResume(runId);
      this.store.appendEvent(runId, {
        type: 'note',
        message: `automatic resume could not start — ${resumed.error ?? 'unknown'}`,
      });
      return;
    }
    this.store.updateRun(runId, { autoResumeAttempts: attempts });
    this.store.appendEvent(runId, {
      type: 'lifecycle',
      message: `usage limit reset — resuming automatically (${attempts}/${MAX_AUTO_RESUMES})`,
    });
    // A deferred continuation only ENQUEUES itself; the queue moves when something pumps it, and
    // `recover()` — the other deferring caller — pumps once after its whole bulk sweep. A timer
    // firing on its own has no such follow-up, so without this the resumed run sits at `queued`
    // until some unrelated run happens to finish. This is the pump for it.
    void this.pump();
  }

  /**
   * Make the armed timers agree with the records and the current setting. Runs on every `pump()`
   * — which is where a settings change lands (a config PUT refreshes the shared semaphore, which
   * pumps every manager) — and once from `recover()`.
   *
   * It is a RECONCILE rather than a one-shot restore because the deadline is durable state and
   * the timer is not: a restart, a rebuilt project context, a manager disposed mid-wait, or a
   * refusal all leave a record promising a resume that no timer is holding. Rebuilding from the
   * record covers every one of those at once — the alternative is a hint counting down to a time
   * that has already passed, which is exactly the failure this method exists to make impossible.
   *
   * Cheap: an in-memory scan, and arming is skipped for every run already held.
   */
  private reconcileAutoResumes(): void {
    if (!this.semaphore.autoResumeOnUsageLimit()) {
      // Sweep the RECORDS, not the timer map. A record promising a resume that no timer is
      // holding is the exact population this method exists for, and it is also the one the
      // setting can be switched off in front of: cezar restarted while it was off, the config
      // was hand-edited, or the project context was disposed mid-wait. Retiring only the armed
      // timers leaves such a record with a live `autoResumeAt`, which `accountHolds()` reads as
      // a deadline hold — so nothing new starts on that account, `rescueStalledQueue` treats the
      // phantom appointment as a legitimate reason to sit still, and the cockpit shows a
      // `scheduled` row for a resume that will never come. `clearAutoResume` covers the armed
      // ones too, so this one loop is the whole cancellation.
      const pending = new Set([
        ...this.autoResumeTimers.keys(),
        ...this.store.listRuns().filter((run) => run.autoResumeAt !== undefined).map((run) => run.id),
      ]);
      for (const runId of pending) {
        this.clearAutoResume(runId);
        this.store.appendEvent(runId, {
          type: 'note',
          message: 'automatic resume cancelled — auto-resume is switched off',
        });
      }
      return;
    }
    for (const run of this.store.listRuns()) {
      if (run.status !== 'failed' || !run.autoResumeAt) continue;
      if (this.autoResumeTimers.has(run.id)) continue;
      const deadline = Date.parse(run.autoResumeAt);
      // A deadline that is unreadable, belongs to a run that has spent its cap, or belongs to a
      // task the user has archived is retired rather than re-armed: it can only mislead. One
      // that has just passed arms at zero — the window is open, which is the point.
      if (
        run.archived
        || !Number.isFinite(deadline)
        || (run.autoResumeAttempts ?? 0) >= MAX_AUTO_RESUMES
      ) {
        this.store.updateRun(run.id, { autoResumeAt: undefined });
        continue;
      }
      // …and one missed by more than a day is retired loudly: reviving a task from another era
      // is a surprise, not a service, and this is what keeps a sweep from resurrecting every
      // limit-stopped task a user has long since walked away from.
      if (Date.now() - deadline > AUTO_RESUME_MISSED_WINDOW_MS) {
        this.store.updateRun(run.id, { autoResumeAt: undefined });
        this.store.appendEvent(run.id, {
          type: 'note',
          message: 'automatic resume expired — its window reopened over a day ago; continue this task manually',
        });
        continue;
      }
      this.armAutoResume(run.id, deadline);
    }
  }

  /**
   * Hand a run that has not spawned anything back to the queue, when the account it would run on
   * went into a usage-limit hold (spec 2026-08-03-auto-resume-after-usage-limit).
   *
   * The dequeue-time gate in `pump()` cannot be the only one: a run can sit between dequeue and
   * spawn for a long time — an in-place run waiting for the exclusive repo-root lease is the
   * measured case — and the account can close in that gap. This is the last honest moment to
   * refuse, because everything after it costs a real agent turn.
   *
   * "Untouched" is the contract: the run has created no session and no worktree, so it goes back
   * as plain `queued` with its `startedAt` cleared, and `pump()` will pick it up when the window
   * reopens. Returns true when the caller must abandon the run.
   */
  private requeueWhileHeld(
    runId: string,
    workflow: WorkflowDef,
    input: ExecuteRunInput,
    runner: RunnerId,
    state?: ActiveRun,
    /** What dispatch resolved for this run, when it resolved anything — a pool choice or an
     *  out-of-quota reroute. The record does not carry it; see the comment on `account` below. */
    resolved?: PoolChoice,
  ): boolean {
    const run = this.store.getRun(runId);
    if (!run || run.status === 'cancelled' || state?.cancelled) return false;
    // The watchdog sent this one through. Checked, never consumed: the spawn path asks this
    // question TWICE — here at the top of `execute`, and again after the exclusive repo-root
    // lease is granted — so a one-shot flag would clear at the first gate and let the second one
    // hand an in-place run straight back, re-wedging the queue the rescue had just freed.
    // `dropActive` retires the entry on every terminal path, so the set still cleans itself up.
    if (this.forceStarted.has(runId)) return false;
    // The account THIS SPAWN would use.
    //
    // `resolved` when dispatch has already chosen one — a `pool:` route, or the out-of-quota
    // reroute (`.ai/specs/2026-08-23-never-block-a-task.md`). Taking it is not an optimisation, it
    // is the correctness fix: the reroute stamps its choice on the INPUT and deliberately leaves
    // the record saying what the user asked for, so rebuilding the key from the record parked runs
    // on the very account they had just been moved off — admission let them through, this gate
    // handed them straight back.
    //
    // Falling back to the record is right when dispatch resolved nothing: then the run really is
    // going to the account the record names, and a hold on it still means wait. **Deliberately not
    // "skip the hold whenever the never-block setting is on".** That was the first attempt and it
    // was too blunt — it disabled the hold outright on a default host, including the herd control
    // that keeps a dozen queued runs from all walking into one closed window, which the ruling
    // never asked for. The ruling is that a task proceeds on the next AVAILABLE provider; when
    // there is none, a visible appointment with a real `autoResumeAt` is the honest answer and
    // costs no quota. Measured: the blunt version reddened 23 tests in `auto-resume.test.ts`, and
    // they were right.
    const account = resolved
      ? accountUsageKey(resolved.provider, resolved.accountId)
      : runAccountKey({ ...run, runner }, runner);
    if (!accountHeldOn(account, run, this.semaphore.accountHolds())) return false;
    state?.releaseRepoRoot?.();
    if (state) state.releaseRepoRoot = undefined;
    this.pendingJobs.set(runId, { workflow, input });
    this.queue.push(runId);
    this.store.updateRun(runId, { status: 'queued', startedAt: undefined, currentStepId: undefined });
    // Tell admission what was refused here, or it re-admits this run immediately and the two
    // gates trade it back and forth for as long as the hold lasts.
    this.heldAtSpawn.set(runId, account);
    this.noteHeld(runId, account);
    this.dropActive(runId);
    return true;
  }

  /**
   * The failsafe: a queue must never be able to wedge.
   *
   * Everything else in this file makes an idle queue CORRECT under some condition — a slot cap, a
   * repo-root lease, and now a usage-limit hold. That is also what makes a wedged queue look
   * correct, and the hold has already produced one in the field: two resumes fired together, each
   * holding the account the other was waiting on, and the whole workspace stopped with every task
   * `queued`. That specific bug is fixed and tested, but "the queue stopped and nothing will ever
   * restart it" is too expensive a failure mode to leave resting on any single fix being right.
   *
   * The test is deliberately about JUSTIFICATION rather than about any particular bug: idling is
   * legitimate while work is running (here or in another project), or while a real appointment is
   * still ahead — a scheduled resume that will fire and pump on its own. Anything else is a
   * queue with work in it, nothing running anywhere, and no event coming to wake it. That gets one
   * forced sweep, which starts work under the ordinary caps and lets the account's real state
   * re-assert itself: if the window truly is shut, that task meets the limit and re-establishes an
   * honest hold, with a real deadline behind it this time.
   *
   * Public so a test can drive the wedge directly instead of waiting out the interval.
   */
  async rescueStalledQueue(now = Date.now()): Promise<void> {
    // First, the worst shape: a record that says `queued` while the engine holds no job, no
    // continuation and no queue entry for it. `pump()` cannot see such a run — it iterates the
    // queue, and this one is not in it — so nothing will ever start it. Re-adopt it through the
    // same path boot recovery uses.
    for (const run of this.store.listRuns()) {
      if (run.status !== 'queued') continue;
      if (this.active.has(run.id) || this.starting.has(run.id)) continue;
      if (this.pendingJobs.has(run.id) || this.pendingContinuations.has(run.id)) continue;
      if (this.queue.includes(run.id)) continue;
      console.warn(`[cez] queue watchdog: re-adopting queued run ${run.id} the engine had lost`);
      try {
        await this.reviveQueuedRun(run, 'queue watchdog');
      } catch (err) {
        // One run that cannot be re-adopted must not abort the sweep for the others, and must
        // never escape to the caller. This method is driven by `setInterval(() => void ...)`, and
        // `void` on a promise discards its rejection — which Node treats as an **unhandled
        // rejection and terminates the process for**. So a single unwritable run record (its
        // project directory deleted under us, a permissions change, a full disk) would take the
        // whole cockpit down, and take it down again on the very next tick. A watchdog whose job
        // is to rescue stuck work is the last thing that may kill the server.
        //
        // Degrade per-run rather than per-sweep — the same shape as C6 in
        // `workspace-runs-api.test.ts`, where one unreadable project must not blank the others.
        // The next tick retries, so a transient cause heals itself; the warn is what keeps a
        // permanent one visible instead of silently swallowed.
        console.warn(
          `[cez] queue watchdog: could not re-adopt ${run.id}, leaving it queued for the next tick: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    if (this.queue.length === 0) return;
    if (this.busySlots() > 0 || this.starting.size > 0) return;
    if (this.semaphore.busy() > 0) return;
    // A future deadline is a real reason to sit still: that timer will fire and pump.
    for (const run of this.store.listRuns()) {
      if (run.status !== 'failed' || !run.autoResumeAt) continue;
      const deadline = Date.parse(run.autoResumeAt);
      if (Number.isFinite(deadline) && deadline > now) return;
    }
    if (this.semaphore.accountHolds().inFlight.size === 0) {
      // Not the hold, then — some other wakeup went missing. An ordinary pump is the whole fix,
      // and it is idempotent, so this stays quiet.
      void this.pump();
      return;
    }
    console.warn(
      '[cez] queue watchdog: work is queued, nothing is running, and the usage-limit hold has no'
      + ' deadline behind it — starting the next task anyway',
    );
    this.forceNextPump = true;
    void this.pump();
  }

  /**
   * The accounts this project is currently holding: one key per run parked on a usage-limit
   * resume that has not come due yet (spec 2026-08-03-auto-resume-after-usage-limit).
   *
   * Published to the shared semaphore so the hold spans PROJECTS — one Claude account can be
   * driving tasks in three repos, and a limit closes it for all of them. Derived from the
   * records on every ask rather than tracked as state: a deadline that passes, a resume that
   * fires, a cancel, an archive and a delete all lift the hold with no bookkeeping.
   *
   * Deliberately excludes a deadline that has already passed — that run is about to resume, and
   * holding the queue for it would only stall the very work the window reopened for.
   */
  /**
   * Runs THIS manager is executing right now, per agent account (`accountUsageKey`).
   *
   * Keyed on `this.active` — the map of runs with a live `ActiveRun` — and NOT on the records'
   * `status === 'running'`. That distinction is the whole correctness of this method, and it was
   * found by SIGKILLing a cockpit mid-run:
   *
   * The server opens every store with `keepLive: true`, so `reconcileLoadedRun` does **nothing** on
   * load — a crashed process's `running` steps come back from disk still saying `running`, on
   * purpose, so `recover()` can resume them. A count derived from those records therefore reports a
   * run that no process is executing, and it does so **permanently**: nothing will ever move that
   * step again. The balancer would then route away from that account forever, and the sidebar would
   * show a busy login that is idle. Measured after one SIGKILL: the recovered run's first step was
   * reconciled to `failed` while its `continue-1` step stayed `running`, leaking a phantom 1.
   *
   * `active` cannot leak that way — it is in-memory, so a process that dies takes it with it, and
   * the answer after a restart is zero until something genuinely starts.
   *
   * `currentStepId` rather than "every running-looking step": a run executes one step at a time, so
   * counting each `running` step would multiply a single agent across an interrupted run's history.
   */
  accountInflight(): Record<string, number> {
    const steps: InflightStep[] = [];
    for (const [runId, state] of this.active) {
      const run = this.store.getRun(runId);
      if (!run || !state.currentStepId) continue;
      const step = run.steps.find((candidate) => candidate.id === state.currentStepId);
      // Forced to `running`: `active` + `currentStepId` IS the fact that it is running, and the
      // record's own status can lag a tick behind the manager that owns it.
      if (step?.backend) steps.push({ backend: step.backend, profileId: step.profileId, status: 'running' });
    }
    return countInflight(steps);
  }

  accountHolds(now = Date.now()): AccountHolds {
    const deadline = new Set<string>();
    const inFlight = new Set<string>();
    for (const run of this.store.listRuns()) {
      // The account a provider actually refused, read off the STEP that ran — NOT off the run
      // (spec 2026-08-23-usage-limit-hold-account). A run's steps do not all run on the run's own
      // backend: `spec-to-deploy` pins two steps to claude, and the pool may route two steps of
      // one run to two logins. The fallback is unused for a run that has started a step; it is
      // spelled out rather than `!` so a future record shape degrades, not throws.
      const key = () => usageHoldAccountKey(run, run.runner ?? 'claude');
      if (run.status === 'failed' && run.autoResumeAt) {
        const at = Date.parse(run.autoResumeAt);
        if (Number.isFinite(at) && at > now) deadline.add(key());
      } else if (resumeInFlight(run)) {
        inFlight.add(key());
      }
    }
    return { deadline, inFlight };
  }


  /**
   * The PER-TASK off switch (`DELETE /api/v1/runs/:id/auto-resume`, and the archive route):
   * stop resuming THIS task, without touching the workspace setting or any other task.
   *
   * Idempotent — a run with nothing pending answers the same way, because "this task will not
   * resume itself" is equally true either way. Returns false only when the run does not exist,
   * which is the route's 404.
   */
  cancelAutoResume(runId: string): boolean {
    const run = this.store.getRun(runId);
    if (!run) return false;
    const pending = run.autoResumeAt !== undefined || this.autoResumeTimers.has(runId);
    this.clearAutoResume(runId);
    if (pending) {
      this.store.appendEvent(runId, {
        type: 'note',
        message: 'automatic resume cancelled for this task',
      });
      // This run may have been the last thing holding its account's queue — nothing else will
      // notice, since the hold is derived and its release is not an event.
      void this.pump();
    }
    return true;
  }

  /** Retire a pending resume — timer, deadline and counter. The counter goes too because every
   *  caller is a fresh epoch: a human Continue, or a resume that re-stamps its own count. */
  private clearAutoResume(runId: string): void {
    const timer = this.autoResumeTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.autoResumeTimers.delete(runId);
    const run = this.store.getRun(runId);
    if (!run) return;
    if (run.autoResumeAt !== undefined || run.autoResumeAttempts !== undefined) {
      this.store.updateRun(runId, { autoResumeAt: undefined, autoResumeAttempts: undefined });
    }
  }

  /** Reclaim finished worktrees beyond the keep-limit (#483) — directory only,
   *  `cez/<id8>` branch kept. Best-effort; a failure never affects run
   *  lifecycle. `review`/live runs are excluded by the selector. */
  private async enforceRetention(): Promise<void> {
    try {
      const keep = await resolveWorktreeRetention(this.repoRoot);
      await reclaimWorktrees(this.repoRoot, this.store, keep);
    } catch {
      // retention is best-effort; swallow so terminal transitions never break.
    }
  }

  /** Last live-refresh namer inputs per run — unchanged inputs skip the call. */
  private lastNamerKey = new Map<string, string>();

  /**
   * Acquire the one-at-a-time lease for runs executing in `repoRoot`.
   *
   * A lease waiter is idle, so it parks in `waiting` and gives its
   * `maxParallel` slot back (the #347 rule): isolated worktrees keep using
   * every configured slot while root runs line up. The store status stays
   * `running` — only the queue's busy count changes, so the GUI never shows a
   * lease-blocked run as awaiting user input.
   *
   * The lease is held for the run's whole lifetime, including the idle
   * `waiting` parks between agent turns. A parked session is still live and
   * writes to the working tree the moment it resumes, so handing the tree to
   * another run there would reintroduce the concurrent-edit bug (#438) this
   * lease exists to prevent.
   *
   * Returns false when the run was cancelled while waiting: the lease was
   * never granted and the caller must not touch the working tree.
   */
  private async acquireRepoRoot(runId: string, state: ActiveRun): Promise<boolean> {
    // `cancel()` can land between the run going `running` and reaching here,
    // while `interrupt` is still the default no-op — never enter the chain.
    if (state.cancelled) return false;
    const previous = this.repoRootTail;
    let release: () => void = () => undefined;
    this.repoRootTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Until `previous` resolves this run does not own the tree yet, so a drop
    // during the wait must not hand the tree to the next waiter — chain our
    // release behind `previous` instead of resolving the tail early.
    state.releaseRepoRoot = () => {
      void previous.then(release);
    };
    let abort: () => void = () => undefined;
    const cancelled = new Promise<void>((resolve) => {
      abort = resolve;
    });
    const parked = state.interrupt;
    state.interrupt = () => {
      parked();
      abort();
    };
    this.waiting.add(runId);
    this.releaseSlot();
    try {
      await Promise.race([previous, cancelled]);
    } finally {
      state.interrupt = parked;
      this.waiting.delete(runId);
    }
    if (state.cancelled) return false;
    state.releaseRepoRoot = release;
    return true;
  }

  cancel(runId: string): boolean {
    // Still waiting in the queue: just drop it there.
    const queuedAt = this.queue.indexOf(runId);
    if (queuedAt >= 0) {
      this.queue.splice(queuedAt, 1);
      this.pendingJobs.delete(runId);
      this.pendingContinuations.delete(runId);
      this.store.updateRun(runId, { status: 'cancelled', finishedAt: new Date().toISOString() });
      this.store.appendEvent(runId, { type: 'lifecycle', message: 'cancelled while queued' });
      return true;
    }
    const state = this.active.get(runId);
    if (!state) {
      // An idle-PARKED wait (spec 2026-08-20-inactive-sessions-stay-in-progress) has no active
      // state — its backend process was closed to free memory — but it is NOT terminal. Cancel
      // settles it `cancelled` directly; every other statusless run is genuinely gone (409).
      const run = this.store.getRun(runId);
      if (run?.status === 'waiting') {
        this.store.updateRun(runId, { status: 'cancelled', finishedAt: new Date().toISOString() });
        this.store.appendEvent(runId, { type: 'lifecycle', message: 'run cancelled' });
        return true;
      }
      return false;
    }
    state.cancelled = true;
    this.clearIdleTimer(state);
    state.interrupt();
    return true;
  }

  isActive(runId: string): boolean {
    return this.active.has(runId) || this.starting.has(runId) || this.queue.includes(runId);
  }

  /**
   * Fold a queued run's persisted prompt — `run.task` plus everything stacked
   * onto it (#472) — into the job input that is about to execute.
   *
   * Called from `pump()` immediately before `execute()`, which makes the RECORD
   * the single source of truth for a queued run's prompt. Before this, the
   * executing copy lived in `pendingJobs` (memory) while the record held a
   * second one, so an edit that PATCHed the record silently did nothing until a
   * restart. `recover()` rebuilds through the same helper, so both paths agree.
   *
   * **Read-only, and that is load-bearing.** It composes into the in-memory
   * `input` and never writes the folded string back to `RunRecord.task`; the
   * task and its stack stay separate on disk for the life of the run. Writing
   * back would re-append the whole stack on every recovery and compound without
   * bound — asserted directly by a test.
   */
  private hydrateQueuedInput(runId: string, input: ExecuteRunInput): ExecuteRunInput {
    const run = this.store.getRun(runId);
    if (!run) return input;
    const stack = run.queuedMessages ?? [];

    const task = [run.task, ...stack.map((m) => m.text)]
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join('\n\n');

    // Keep the original in-memory blocks for a live process (including the
    // best-effort case where persistence failed). Recovery has no such copy,
    // so rebuild it from the durable task-image URLs.
    const images = input.images?.length
      ? input.images
      : this.readPersistedImages(runId, run.taskImages ?? [], 'task').blocks;
    const stackedImages = this.readPersistedImages(
      runId,
      stack.flatMap((m) => m.images ?? []),
      'queued',
    ).blocks;

    return {
      ...input,
      task,
      ...(images.length ? { images } : { images: undefined }),
      ...(stackedImages.length ? { stackedImages } : { stackedImages: undefined }),
    };
  }

  /** Apply edits and messages made while a restart continuation waits for
   * capacity. The durable record remains the source of truth, just as it is for
   * an ordinary queued workflow (#472), so a second restart reconstructs and
   * hydrates the same amendments instead of dropping them. */
  private hydrateQueuedContinuation(
    runId: string,
    continuation: PendingContinuation,
  ): PendingContinuation & {
    persistedImages: ContentBlock[];
    persistedAttachments: PersistedAttachment[];
  } {
    const run = this.store.getRun(runId);
    if (!run) {
      return { ...continuation, persistedImages: [], persistedAttachments: [] };
    }
    const stack = run.queuedMessages ?? [];
    const amendedTask = [run.task, ...stack.map((message) => message.text)]
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join('\n\n');
    const prompt = amendedTask
      ? `${continuation.prompt}\n\nCurrent task and queued updates:\n\n${amendedTask}`
      : continuation.prompt;
    const persisted = this.readPersistedImages(
      runId,
      stack.flatMap((message) => message.images ?? []),
      'queued',
    );
    return {
      ...continuation,
      prompt,
      persistedImages: persisted.blocks,
      persistedAttachments: persisted.attachments,
    };
  }

  private readPersistedImages(
    runId: string,
    urls: string[],
    kind: 'task' | 'queued',
  ): PersistedImages {
    const blocks: ContentBlock[] = [];
    const attachments: PersistedAttachment[] = [];
    for (const url of urls) {
      const name = url.split('/').pop();
      if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) continue;
      const path = join(this.dataDir, 'runs', `${runId}-images`, name);
      try {
        const data = readFileSync(path);
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: mediaTypeFor(name), data: data.toString('base64') },
        });
        attachments.push({ name, url, path });
      } catch {
        // Degrade, never fail the boot (AGENTS.md): the user deleted `.ai/cezar/`
        // or the file is unreadable — start with the text and say which image went.
        this.store.appendEvent(runId, {
          type: 'note',
          message: `${kind} attachment ${name} could not be read — starting without it`,
        });
      }
    }
    return { blocks, attachments };
  }

  /**
   * Still waiting for a slot? Checked against the engine's own queue rather than
   * the record's `status` (#472): the record is written by `execute()` a tick
   * after `pump()` dequeues, so a status read can see `queued` for a run that has
   * already started. The pending maps are deleted synchronously at dequeue, so
   * they are the authoritative answer for "can this prompt still be amended".
   */
  private isQueued(runId: string): boolean {
    return this.pendingJobs.has(runId) || this.pendingContinuations.has(runId);
  }

  /** Split `ContentBlock[]` into the persisted shape a stacked message holds. */
  private toQueuedMessage(runId: string, content: ContentBlock[]): QueuedMessage {
    const text = content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const images = content
      .filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image')
      .map((b) => this.persistImage(runId, b.source.media_type, b.source.data, 'pasted'))
      .filter((saved): saved is PersistedAttachment => saved !== null)
      .map((saved) => saved.url);
    return {
      id: randomUUID(),
      text,
      ...(images.length ? { images } : {}),
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Append a prompt message onto a still-queued run (#472). Returns the stored
   * entry, or null when the run has already started — the caller then falls
   * through to `deferMessage`.
   */
  enqueueMessage(runId: string, content: ContentBlock[]): QueuedMessage | null {
    if (!this.isQueued(runId)) return null;
    const run = this.store.getRun(runId);
    if (!run) return null;
    const message = this.toQueuedMessage(runId, content);
    this.store.updateRun(runId, { queuedMessages: [...(run.queuedMessages ?? []), message] });
    return message;
  }

  /** Edit a stacked message in place. Omitted fields retain their current value. */
  editQueuedMessage(
    runId: string,
    msgId: string,
    edit: { text?: string; images?: ContentBlock[] },
  ): QueuedMessage | null {
    if (!this.isQueued(runId)) return null;
    const run = this.store.getRun(runId);
    const stack = run?.queuedMessages;
    if (!stack) return null;
    const at = stack.findIndex((m) => m.id === msgId);
    if (at < 0) return null;
    const current = stack[at]!;
    const replacementImages = edit.images === undefined
      ? current.images
      : this.toQueuedMessage(runId, edit.images).images;
    const replacement: QueuedMessage = {
      id: msgId,
      text: edit.text ?? current.text,
      ...(replacementImages?.length ? { images: replacementImages } : {}),
      createdAt: current.createdAt,
    };
    const next = [...stack];
    next[at] = replacement;
    this.store.updateRun(runId, { queuedMessages: next });
    // Images the edit dropped are now orphans.
    this.dropOrphanImages(runId, stack[at]!.images ?? [], next);
    return replacement;
  }

  /** Remove a stacked message and its now-orphaned attachments. */
  removeQueuedMessage(runId: string, msgId: string): boolean {
    if (!this.isQueued(runId)) return false;
    const run = this.store.getRun(runId);
    const stack = run?.queuedMessages;
    if (!stack) return false;
    const target = stack.find((m) => m.id === msgId);
    if (!target) return false;
    const next = stack.filter((m) => m.id !== msgId);
    this.store.updateRun(runId, { queuedMessages: next });
    this.dropOrphanImages(runId, target.images ?? [], next);
    return true;
  }

  /**
   * Delete image files no longer referenced by anything (#472). Best effort — a
   * leftover file is harmless and goes with the run. Never touches a URL still
   * referenced by another stacked entry or by the initial prompt's `taskImages`.
   */
  private dropOrphanImages(runId: string, candidates: string[], stack: QueuedMessage[]): void {
    if (!candidates.length) return;
    const run = this.store.getRun(runId);
    const referenced = new Set([
      ...(run?.taskImages ?? []),
      ...stack.flatMap((m) => m.images ?? []),
    ]);
    for (const url of candidates) {
      if (referenced.has(url)) continue;
      const name = url.split('/').pop();
      // Defend the join against a crafted URL: only a bare file name may be deleted.
      if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) continue;
      try {
        rmSync(join(this.dataDir, 'runs', `${runId}-images`, name), { force: true });
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * Edit the initial prompt of a still-queued run (#472). Re-derives the
   * heuristic title and the PR/issue chips, but never re-runs the LLM namer —
   * it already fired at creation and a second model call per edit is unjustified.
   */
  editTask(runId: string, task: string): boolean {
    if (!this.isQueued(runId)) return false;
    const run = this.store.getRun(runId);
    if (!run) return false;
    const workflow = this.pendingJobs.get(runId)?.workflow;
    const skillHint = workflow?.steps.find((s) => stepKind(s) === 'agent' && s.skill)?.skill?.trim();
    const refs = refineTaskRefs(extractTaskRefs(task), skillHint);
    // Hand-edited titles always win (#389): `user` beats the heuristic, and a
    // `marker` title the agent declared beats it too.
    const keepTitle = run.titleOrigin === 'user' || run.titleOrigin === 'marker';
    this.store.updateRun(runId, {
      task,
      ...(keepTitle || !workflow ? {} : { title: makeRunTitle(task, workflow) }),
      ...(refs.prNumber !== undefined ? { prNumber: refs.prNumber } : {}),
      ...(refs.issueNumber !== undefined ? { issueNumber: refs.issueNumber } : {}),
    });
    return true;
  }

  /**
   * Buffer a message that arrived in the gap between dequeue and session-open
   * (#472). `pump()` has already folded the stack and `execute()` is spawning the
   * backend, so there is nothing left to amend and no session to deliver into —
   * without this rung the message would 409, a genuinely dropped message in the
   * feature built to stop dropping them. Flushed as an ordinary follow-up turn
   * the instant the session opens; dropped if the run never starts, which the
   * existing error path already surfaces.
   *
   * The buffer lives on the manager rather than the `ActiveRun` because the
   * `ActiveRun` does not exist yet for part of this window.
   */
  deferMessage(runId: string, content: ContentBlock[]): boolean {
    // The window spans two sub-states: `starting` (no `ActiveRun` yet) and the
    // longer stretch where the `ActiveRun` exists but the backend is still being
    // spawned. `execute()` deletes the run from `starting` as soon as it builds
    // the state — seconds before the session opens — so checking `starting`
    // alone would reopen exactly the drop this rung exists to close.
    const state = this.active.get(runId);
    const startingUp = this.starting.has(runId) || (state !== undefined && !state.sessionEverOpened && !state.cancelled);
    if (!startingUp) return false;
    const pending = this.deferredMessages.get(runId) ?? [];
    pending.push(content);
    this.deferredMessages.set(runId, pending);
    return true;
  }

  /** Deliver anything `deferMessage` buffered, once the session is live. */
  private flushDeferred(runId: string): void {
    const pending = this.deferredMessages.get(runId);
    if (!pending?.length) return;
    // Re-buffer whatever the session refused rather than dropping it. `sendMessage`
    // answers false when the session is not open yet — and silently losing a message
    // here would be precisely the failure `deferMessage` exists to prevent. Anything
    // left over is retried by the next session that opens on this run.
    const unsent = pending.filter((content) => !this.sendMessage(runId, content));
    if (unsent.length) this.deferredMessages.set(runId, unsent);
    else this.deferredMessages.delete(runId);
  }

  /**
   * Deliver a user message into the run's live claude session (mid-turn or
   * while `waiting`). Returns false when there is no open session — the GUI
   * then offers "Continue" instead.
   */
  sendMessage(runId: string, content: ContentBlock[]): boolean {
    const delivered = this.deliverMessage(runId, content, true);
    if (delivered) {
      const state = this.active.get(runId);
      if (state) state.monitoringWakeups = 0;
      this.store.updateRun(runId, { monitoringWakeCapReached: undefined });
    }
    return delivered;
  }

  /** Shared live-session delivery. Synthetic scheduler prompts reuse lifecycle
   * bookkeeping without masquerading as user-authored transcript messages. */
  private deliverMessage(runId: string, content: ContentBlock[], userAuthored: boolean): boolean {
    const state = this.active.get(runId);
    if (!state?.session?.open || state.cancelled) return false;

    const text = content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    // Persist the attached images so the thread can render them (not just count them) — the same
    // on-disk store + `/images/` route the agent's own screenshots use. `pasted` prefix marks
    // these as user attachments (vs. agent tool screenshots) on disk (#357).
    const persisted = userAuthored ? content
      .filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image')
      .map((b) => this.persistImage(runId, b.source.media_type, b.source.data, 'pasted'))
      .filter((saved): saved is PersistedAttachment => saved !== null) : [];
    const images = persisted.map((saved) => saved.url);
    if (userAuthored) {
      this.store.appendEvent(runId, {
        type: 'user-message',
        stepId: state.currentStepId,
        text,
        imageCount: content.filter((b) => b.type === 'image').length,
        images,
      });
    }

    // Tell the agent where the pasted files live on disk (#357): the base64 blocks below still
    // ride along so the model can *view* them, but a real path is what lets it *operate* on them
    // (save, `cp`, attach to a GitHub issue/PR) — and it's the only usable reference on backends
    // (codex, opencode) that drop image blocks entirely before reaching the model.
    const expanded = userAuthored ? expandRegistrySlashSkill(content, state.skills ?? []) : content;
    const deliverable = persisted.length ? [...expanded, pastedAttachmentsNote(persisted)] : expanded;
    const delivered = state.session.sendMessage(deliverable);
    if (delivered) {
      this.clearIdleTimer(state);
      this.clearMonitoringWakeTimer(state, runId);
      this.waiting.delete(runId); // resumed — the run counts against slots again
      this.monitoring.delete(runId);
      // Clear any `monitoring` activity — the agent is actively working again
      // (spec 2026-07-18-subagent-monitoring-status, #490). Also clears a markerless park's
      // `waitingReason`/`waitingQuestion` (spec 2026-08-23-plain-end-structured-question) — a
      // stale prose question must not survive a reply and sit beside a fresh turn's own outcome.
      this.store.updateRun(runId, {
        status: 'running',
        activity: undefined,
        waitingReason: undefined,
        waitingQuestion: undefined,
      });
      if (state.currentStepId) {
        this.store.updateStep(runId, state.currentStepId, { status: 'running' });
      }
    }
    return delivered;
  }

  /** Close the open session gracefully — the run then completes as `done`
   *  (or rests at `review` when the worktree holds changes, spec 009).
   *  On a run already resting at `review` (no session — the engine loop is
   *  over), "Finish" is the third review exit: accept the changes without a
   *  PR and flip straight to `done`. */
  finish(runId: string): boolean {
    const state = this.active.get(runId);
    if (state?.session?.open) {
      this.clearIdleTimer(state);
      this.store.appendEvent(runId, { type: 'lifecycle', message: 'session closed by user' });
      state.session.end();
      return true;
    }
    const run = this.store.getRun(runId);
    if (run?.status === 'review' && !this.isActive(runId)) {
      // `stopReason` is only ever valid alongside `status: 'review'` (PLAN D27 Phase 1) — accepting
      // a budget-stopped run as `done` here must not leave the stale reason on a finished record.
      this.store.updateRun(runId, { status: 'done', stopReason: undefined });
      this.store.appendEvent(runId, { type: 'lifecycle', message: 'review accepted — finished without a PR' });
      return true;
    }
    // An idle-PARKED wait (spec 2026-08-20-inactive-sessions-stay-in-progress): its process was
    // already closed, so there is no live session to end — but "Finish" still means "complete it".
    // Settle it now: apply the worktree and land `done` (or `review` with a diff), exactly as a
    // live session's graceful close would have. `settleSuccess` only touches the store/worktree, so
    // it is safe with no active state; its writes propagate over SSE, so the sync return is fine.
    if (run?.status === 'waiting' && !this.isActive(runId)) {
      this.store.appendEvent(runId, { type: 'lifecycle', message: 'session closed by user' });
      void this.settleSuccess(runId);
      return true;
    }
    return false;
  }

  /**
   * "Continue" (spec 003): reopen a finished run's claude session in-process
   * (`claude --resume <sessionId>`) as a new synthetic step. The session then
   * behaves exactly like an interactive step: `waiting` after each turn,
   * messages via sendMessage, closed by finish/idle/cancel.
   */
  async continueRun(
    runId: string,
    opts: { text?: string; images?: ContentBlock[]; runner?: RunnerId; model?: string } = {},
    /** Restart recovery may discover several interrupted tasks at once. Those
     *  continuations are queued; an explicit user Continue remains immediate. */
    deferForCapacity = false,
  ): Promise<{ ok: boolean; error?: string }> {
    if (agentModelsLocked(this.repoRoot) && opts.model?.trim()) {
      return { ok: false, error: AGENT_MODELS_LOCKED_ERROR };
    }
    if (this.active.has(runId)) return { ok: false, error: 'run is still active' };
    const run = this.store.getRun(runId);
    if (!run) return { ok: false, error: 'not found' };
    // `review` is continuable too — that's the "Send back" path (spec 009). `waiting` is
    // continuable only once it is no longer active — an idle-PARKED wait whose backend process was
    // closed to free memory (spec 2026-08-20-inactive-sessions-stay-in-progress). A LIVE waiting
    // session never reaches here: it is still in `this.active` and the guard above returns first,
    // so its follow-ups keep flowing through `sendMessage`/`deliverMessage` as before.
    if (!['done', 'failed', 'cancelled', 'review', 'waiting'].includes(run.status)) {
      return { ok: false, error: `cannot continue a ${run.status} run` };
    }
    const sessionStep = [...run.steps].reverse().find((s) => s.sessionId);
    if (!sessionStep?.sessionId) return { ok: false, error: 'no agent session to resume' };
    const targetRunner = opts.runner ?? run.runner ?? 'claude';
    // Session ids are provider-owned opaque values. New records carry explicit
    // affinity; for legacy records, the run's current runner is the conservative
    // owner until a continuation emits a new, attributed session id (#562).
    const sessionBackend = sessionStep.backend ?? run.runner ?? 'claude';
    const resume = sessionBackend === targetRunner;

    // Follow-up runner/model override (#401): the composer lets the user pick which backend and
    // model handle this continuation. Omitted → the run's current backend/model is kept
    // (backward compat). A provided choice is persisted BEFORE scheduling, so it becomes the
    // run's current backend — `runContinuation` reads it off the record, later continuations
    // default to it, and the header reflects the active engine. An empty model ('') clears the
    // pin, letting the runner pick the model (auto).
    if (opts.runner !== undefined || opts.model !== undefined) {
      // Guard the pairing before persisting anything: the model override applies to the runner
      // this continuation will actually use (`opts.runner ?? record.runner ?? 'claude'` — the
      // same resolution `runContinuation` reads off the record). A model that is recognizably
      // another runner's preset would corrupt the run; free-form/custom ids pass untouched.
      if (opts.model && modelConflictsWithRunner(opts.model, targetRunner)) {
        return { ok: false, error: `model '${opts.model}' is not a ${targetRunner} model` };
      }
      // A runner switch that carries NO explicit model must not leave the previous backend's pin
      // on the record: the guard above only sees `opts.model`, so without this an inherited
      // `opus` would survive a switch to codex and `runContinuation` would hand it to the codex
      // runner. Clearing (not rejecting) is right — the pin belonged to the old backend and is
      // meaningless for the new one, which is exactly what the composer already displays (auto).
      // Only a recognizably foreign preset is cleared; a free-form/custom id is left alone.
      const inheritedPinIsForeign =
        opts.model === undefined &&
        run.model !== undefined &&
        modelConflictsWithRunner(run.model, targetRunner);
      this.store.updateRun(runId, {
        ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
        ...(opts.model !== undefined
          ? { model: opts.model === '' ? undefined : opts.model }
          : inheritedPinIsForeign
            ? { model: undefined }
            : {}),
      });
    }

    // Everything that could refuse this continuation has now passed, so a pending usage-limit
    // resume is superseded either way: this IS that resume (it re-stamps its own counter), or a
    // human got there first — and then the counter starts over, because the cap only exists to
    // bound UNATTENDED resumes.
    this.clearAutoResume(runId);

    // Phase 4 (spec 2026-08-22-continue-step-naming): a follow-up on a budget-stopped review may
    // land right where the chain has real, untouched work waiting — re-enter the chain instead of
    // opening a disconnected continue-N chat. Resolve the target FIRST — needed for the
    // user-message event below, and `reenterChain` does not return it — duplicating its own
    // internal resolution rather than widening its return type for its four other callers.
    const budgetReentryEligible =
      run.status === 'review' &&
      run.stopReason === 'budget' &&
      !run.pendingApproval &&
      !opts.images?.length;
    const workflow = budgetReentryEligible ? await this.reviveWorkflow(run) : undefined;
    const resumeAt = workflow ? this.chainResumeAt(run, workflow) : undefined;
    if (workflow && resumeAt) {
      const handled = await this.reenterChain(run, 'follow-up continues the chain', {
        feedback: opts.text,
      });
      if (handled) {
        // `reenterChain` only appends a `lifecycle` event — without this the text the user just
        // typed never reaches the rendered thread (it flows only into `resumeAt.feedback`, a
        // retry-explanation channel `checkFailure` reads, not the transcript).
        this.store.appendEvent(runId, {
          type: 'user-message',
          stepId: workflow.steps[resumeAt.index]?.id,
          text: opts.text ?? '',
          imageCount: 0,
        });
        // `reenterChain` ends with `queue.push` and deliberately does not pump itself — without
        // this the re-queued run would sit at `queued` for up to `QUEUE_WATCHDOG_MS` before the
        // sweep picks it up.
        void this.pump();
        return { ok: true };
      }
    }

    // Naming (Phases 1 & 2, spec 2026-08-22-continue-step-naming): the new step is named after the
    // real step it's retrying when one exists, or from the user's own text when there is none.
    const retryingContinuation = sessionStep.id.startsWith('continue-');
    const authored = opts.text?.trim();
    const name = retryingContinuation
      ? authored && !SYNTHETIC_CONTINUE_PROMPTS.has(authored)
        ? postValidateTitle(authored)
        : 'Continue'
      : continuedStepName(sessionStep.name);
    const nameOrigin: 'step' | 'prompt' = retryingContinuation ? 'prompt' : 'step';

    const continuations = run.steps.filter((s) => s.id.startsWith('continue-')).length;
    const stepId = `continue-${continuations + 1}`;
    this.store.addStep(runId, { id: stepId, name, kind: 'agent', nameOrigin });
    const prompt = opts.text?.trim() || 'Continue.';
    const images = opts.images ?? [];
    if (deferForCapacity) {
      this.pendingContinuations.set(runId, {
        stepId,
        sessionId: resume ? sessionStep.sessionId : undefined,
        backend: targetRunner,
        prompt,
        images,
        name,
        nameOrigin,
      });
      this.queue.push(runId);
      this.store.updateRun(runId, {
        status: 'queued',
        error: undefined,
        finishedAt: undefined,
        currentStepId: undefined,
      });
      return { ok: true };
    }
    void this.runContinuation(
      runId,
      stepId,
      name,
      resume ? sessionStep.sessionId : undefined,
      targetRunner,
      prompt,
      images,
    ).catch(
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.store.updateRun(runId, {
          status: 'failed',
          error: `continue crashed: ${message}`,
          finishedAt: new Date().toISOString(),
        });
        this.dropActive(runId);
      },
    );
    return { ok: true };
  }

  private async runContinuation(
    runId: string,
    stepId: string,
    /** Computed once by the caller (spec 2026-08-22-continue-step-naming) — required, not
     *  defaulted, so a call site that forgets it fails to typecheck rather than silently minting
     *  a blank rail row. Threaded through so `StepState.name` and the `step-start` event's `name`
     *  always agree (previously two independent `'Continue'` literals). */
    name: string,
    sessionId: string | undefined,
    backend: RunnerId,
    prompt: string,
    /** Screenshots pasted into the follow-up composer — delivered with the
     *  reopened session's opening message, exactly like a live-session
     *  message's attachments. */
    images: ContentBlock[] = [],
    /** Queued-message screenshots were persisted when they were enqueued and
     *  reconstructed at dequeue. Keep them separate from fresh `images` so
     *  opening a recovered continuation does not persist duplicate files. */
    persistedImages: ContentBlock[] = [],
    persistedAttachments: PersistedAttachment[] = [],
    /** Set only by this method's own reactive fallback (spec 2026-08-22-resume-fresh-session-
     *  fallback, Phase 3) when it re-invokes itself with a fresh session after a resume was
     *  rejected as targeting a conversation the backend never created — guards the one retry
     *  against retrying a SECOND rejection in a row, which is a real failure, not a loop. Every
     *  ordinary caller omits it. */
    retriedMissingSession = false,
    /** Bounds a fresh-broker retry while preserving this continuation's backend conversation. */
    retriedColdBroker = false,
  ): Promise<void> {
    // Continuation runs in the task's worktree when it still exists (spec
    // 006) — the resumed session sees exactly what the original run left.
    // Retention (#483) may have reclaimed this run's worktree directory while
    // keeping its branch and worktreePath. Re-materialize it on resume and clear
    // the stamp so the session regains its isolated tree and the run is eligible
    // for retention again — otherwise it keeps a dir on disk while staying
    // invisible to the enforcer forever. Best-effort; falls back to repoRoot.
    await rematerializeReclaimedWorktree(this.repoRoot, this.store, runId);
    const record = this.store.getRun(runId);
    // The env is a live ceiling: a run created while the inbox was on must not keep writing
    // follow-ups after it is switched off.
    const generateFollowups = followupsEnabled() && record?.generateFollowups !== false;
    const cwd =
      record?.worktreePath && existsSync(record.worktreePath)
        ? record.worktreePath
        : this.repoRoot;
    const state: ActiveRun = { cancelled: false, interrupt: () => undefined, cwd };
    this.active.set(runId, state);
    this.starting.delete(runId);
    // A resumed WORKSPACE run stays isolated and lease-free (spec 2026-08-19). Re-materialize its
    // worktrees if a prior settle applied and removed them (continuing a finished workspace run),
    // so the resumed session works in worktrees rather than falling back to the real checkouts.
    const workspaceRun = (record?.workspaceProjects?.length ?? 0) > 0;
    if (workspaceRun) {
      const live = (record?.workspaceWorktrees ?? []).filter((w) => existsSync(w.worktreePath));
      if (live.length === 0) {
        const worktrees = await materializeWorkspaceWorktrees(
          runId,
          record?.workspaceProjects ?? [],
          (m) => this.store.appendEvent(runId, { type: 'note', message: m }),
          // Same write-ordering fix as the initial materialize above — this resume path is the one
          // that actually mattered for the 232ad6d4 incident's SECOND reclaim, which came after an
          // interrupt-and-resume, not through the initial materialize.
          (snapshot) => {
            this.store.updateRun(runId, { workspaceWorktrees: [...snapshot] });
          },
          this.repoRoot,
        );
        this.store.updateRun(runId, { workspaceWorktrees: worktrees });
        await touchWorktreeLeases(worktrees.map((worktree) => worktree.root), runId, this.repoRoot);
        this.armWorktreeLeases(state, runId, worktrees.map((worktree) => worktree.root));
      } else {
        // Spec 2026-08-22-live-worktree-reaped-mid-run, "What is still open" #2: `dropActive`
        // deletes every lease this run held when it last settled, and reusing an EXISTING live
        // tree here used to arm nothing at all — the most common resume path left a live workspace
        // worktree with no lease, the incident's exact shape. Write and arm unconditionally,
        // whether the trees were rebuilt above or reused here.
        const roots = live.map((worktree) => worktree.root);
        await touchWorktreeLeases(roots, runId, this.repoRoot);
        this.armWorktreeLeases(state, runId, roots);
      }
    }
    if (state.cwd === this.repoRoot && !workspaceRun) {
      if (repositoryRootLockDisabled()) {
        this.store.appendEvent(runId, {
          type: 'note',
          message: REPOSITORY_ROOT_LOCK_DISABLED_NOTE,
        });
      } else {
        this.store.appendEvent(runId, {
          type: 'note',
          message: 'waiting for exclusive access to the repository working tree',
        });
        if (!(await this.acquireRepoRoot(runId, state))) {
          this.store.updateRun(runId, {
            status: 'cancelled',
            finishedAt: new Date().toISOString(),
            currentStepId: undefined,
          });
          this.store.appendEvent(runId, { type: 'lifecycle', message: 'run cancelled' });
          this.dropActive(runId);
          return;
        }
      }
    }
    this.armAutosave(state);
    if (!workspaceRun && cwd !== this.repoRoot) {
      // Spec 2026-08-22-live-worktree-reaped-mid-run, "What is still open" #2: `dropActive`
      // deletes this run's lease at its last settle, and reusing `record.worktreePath` here used
      // to arm nothing at all — a continued single-repo run occupied a live worktree with no
      // lease, the incident's exact shape, on the most common way work resumes on this box.
      await writeWorktreeLease(this.repoRoot, runId, this.repoRoot);
      this.armWorktreeLeases(state, runId, [this.repoRoot]);
    }
    if (record) seedHandoffFile(this.dataDir, record); // idempotent — normally already there
    // Registry snapshot for `/skill` expansion. `execute` loads this for the workflow's own
    // sessions; a continuation builds its OWN ActiveRun, and without this the resumed session
    // expanded against an empty registry and leaked `/om-...` verbatim to the backend, which
    // answered "Unknown skill" (#811). Best-effort — discovery must never break Continue.
    state.skills = await discoverSkills(this.repoRoot).catch(() => [] as Skill[]);

    this.store.updateRun(runId, {
      status: 'running',
      error: undefined,
      finishedAt: undefined,
      currentStepId: stepId,
      activity: undefined, // resuming a monitoring run — it's actively working again (#490)
      // `review` is continuable (see `continueRun` below), including a budget stop — Continuing
      // one is a fresh attempt, so the stale reason must not survive into whatever this attempt
      // finishes as (PLAN D27 Phase 1; `stopReason` is only ever valid alongside `status: 'review'`).
      stopReason: undefined,
      // A prose question from the run this continuation resumes must not survive into this fresh
      // turn (spec 2026-08-23-plain-end-structured-question) — same reasoning as `activity` above.
      waitingReason: undefined,
      waitingQuestion: undefined,
    });
    this.store.updateStep(runId, stepId, {
      status: 'running',
      iterations: 1,
      startedAt: new Date().toISOString(),
      sessionId,
      backend,
    });
    this.store.appendEvent(runId, { type: 'step-start', stepId, name, kind: 'agent', iteration: 1 });
    // Attachments pasted into the follow-up composer, on the same terms as a live-session
    // message (#357): persisted to the run's own image store so the thread renders the bubble's
    // images rather than a bare count, and handed to the agent BOTH as base64 blocks (so it can
    // view them) and as absolute paths appended to the prompt (so it can operate on them — and
    // because codex/opencode drop image blocks before they reach the model).
    const freshAttachments = images
      .filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image')
      .map((b) => this.persistImage(runId, b.source.media_type, b.source.data, 'pasted'))
      .filter((saved): saved is PersistedAttachment => saved !== null);
    const openingImages = [...images, ...persistedImages];
    const attachments = [...freshAttachments, ...persistedAttachments];
    this.store.appendEvent(runId, {
      type: 'user-message',
      stepId,
      text: prompt,
      imageCount: openingImages.filter((b) => b.type === 'image').length,
      ...(attachments.length ? { images: attachments.map((saved) => saved.url) } : {}),
    });

    let stepCost = 0;
    let turnText = '';
    let sessionError: string | undefined;
    const sink = this.makeUiSink(runId, stepId);
    // Loaded once, closed over by `onEvent` below — the step budget (PLAN D27 Phase 1) is
    // checked on every turn-end here too, the twin of `runAgentStep`'s own check.
    const config = await loadConfig(this.repoRoot);
    const onEvent = (event: AgentEvent) => {
      if (event.type === 'image') {
        const saved = this.persistImage(runId, event.mediaType, event.data);
        // Explicit `name`/`url` projection, not `...saved` — `PersistedAttachment.path` is an
        // absolute LOCAL filesystem path (`join(this.dataDir, 'runs', ...)`), which a relay to
        // another cluster node must never carry (cluster/relay.ts, spec D9a). Verified (grep -a,
        // since 4 .ts files in this repo misclassify as binary) that no dashboard/web consumer
        // reads the wire event's `path` — only `url`. This also closes the leak class at the
        // producer: an open spread would silently relay whatever `PersistedAttachment` grows
        // next, an explicit projection cannot.
        if (saved) this.store.appendEvent(runId, { type: 'image', stepId, name: saved.name, url: saved.url });
        return;
      }
      if (event.type === 'text') {
        turnText = appendTurnText(turnText, event.text);
        const text = stripAskMarker(stripTaskMarkers(stripMonitoringMarker(stripDoneMarker(event.text))));
        if (text) this.store.appendEvent(runId, { type: 'text', text, stepId });
        return;
      }
      this.store.appendEvent(runId, { ...event, stepId });
      if (event.type === 'error') {
        sessionError ??= event.message;
        state.session?.interrupt();
        return;
      }
      if (sessionError) return;
      if (event.type === 'session') {
        this.store.updateStep(runId, stepId, { sessionId: event.sessionId, backend });
      }
      if (event.type === 'token-usage') {
        this.store.updateStep(runId, stepId, { tokensUsed: event.tokensUsed });
      }
      if (event.type === 'cost') {
        stepCost += event.usd;
        this.store.updateStep(runId, stepId, { costUsd: stepCost });
      }
      if (event.type === 'turn-end') {
        // Belt-and-braces: v2 `turn.completed` already flushed the delta
        // coalescers; the v1 turn boundary flushes again (idempotent) so no
        // buffered delta can outlive its turn.
        sink.flushAll();
        void this.recordTurnEnd(runId, turnText); // titleSummary + diffStat (#389)
        const sessionOpen = !state.cancelled && state.session?.open;
        const done = sessionOpen && DONE_MARKER_RE.test(turnText.trimEnd());
        // `CEZ:ASK` → the user is genuinely blocked; wins over `CEZ:MONITORING`
        // (a pending question is always attention), loses to `CEZ:DONE` (#473).
        const askResult = sessionOpen && !done ? parseAskMarkerResult(turnText) : undefined;
        const ask = askResult?.kind === 'valid' ? askResult.request : null;
        const askRejection = askResult ? askMarkerRejection(askResult) : undefined;
        const monitoring =
          sessionOpen && !done && !ask && MONITORING_MARKER_RE.test(turnText.trimEnd());
        // A plain end — none of the three markers fired (spec
        // 2026-08-23-plain-end-structured-question). Classified HERE, before `turnText` resets
        // below — the same reason twin A (`runAgentStep`) hoists it at its own marker site.
        const trailingQuestion = !done && !ask && !monitoring ? detectTrailingQuestion(turnText) : null;
        turnText = '';
        // The step budget (PLAN D27 Phase 1): this turn just happened, so it is spent
        // unconditionally — including the `done` turn, harmlessly, since nothing spends after it.
        this.spendBudgetUnit(runId);
        if (askRejection) this.store.appendEvent(runId, { type: 'note', message: askRejection, stepId });
        if (done) {
          // Goal achieved (agent contract, #347) — but of WHAT (spec 2026-08-20, P2). `CEZ:DONE`
          // is a statement about the agent's own step; `runAgentStep`'s twin of this handler has
          // said so since #410 (its `interactive` gate ignores the marker on a non-final step) and
          // this one had no guard at all. That asymmetry was defensible while a continuation only
          // ever existed AFTER a chain finished; restart recovery creates them mid-chain, and then
          // it is what marks a six-step run `done` after step one.
          const settling = this.store.getRun(runId);
          const chainPending = settling ? pendingChainSteps(settling) : [];
          state.chainHandBack = chainPending.length > 0;
          this.store.appendEvent(runId, {
            type: 'lifecycle',
            message: state.chainHandBack
              ? `step goal achieved — session closed; ${chainPending.length} chain step(s) still to run`
              : 'goal achieved — session closed',
          });
          appendHandoffHeartbeat(this.dataDir, runId, 'turn complete — goal achieved, session closed');
          state.session?.end();
          return;
        }
        const budgetJustExceeded = sessionOpen && this.budgetSpent(runId, config);
        // Did a plain end spend a bounded nudge instead of parking (P4)? Stays false on every
        // marked ending, on an autonomous continuation, and when the session is not open.
        let nudged = false;
        if (budgetJustExceeded) {
          // The bound (PLAN D27 Phase 1): an open session would otherwise self-continue
          // (autonomous nudge) or park (`waiting`/`monitoring`) for another turn — stop it here,
          // BEFORE the autonomous nudge below gets a chance to buy one more. `state` carries the
          // signal to this method's own post-`session.result` wrap-up, which lands `review` +
          // `stopReason` instead of calling `settleSuccess`.
          state.budgetExceeded = true;
          state.session?.end();
          this.clearIdleTimer(state);
          this.clearMonitoringWakeTimer(state, runId);
          this.monitoring.delete(runId);
          this.waiting.delete(runId);
          this.releaseSlot();
        } else if (sessionOpen) {
          // Autonomous (#autonomous): never hand the ball back to the user. Nudge the agent to
          // keep going (bounded by MAX_AUTO_CONTINUES) instead of parking at `waiting`.
          const autoContinued =
            state.autonomous &&
            (state.autoContinues ?? 0) < MAX_AUTO_CONTINUES &&
            !state.cancelled &&
            (() => {
              const sent = state.session?.sendMessage([{ type: 'text', text: AUTONOMOUS_NUDGE }]);
              if (!sent) return false;
              state.autoContinues = (state.autoContinues ?? 0) + 1;
              this.store.appendEvent(runId, {
                type: 'note',
                message: `autonomous — continuing without pausing (${state.autoContinues}/${MAX_AUTO_CONTINUES})`,
              });
              return true;
            })();
          if (!autoContinued) {
            // `CEZ:ASK` → park `waiting` (attention) AND surface the structured question as an
            // ask card (#473). `CEZ:MONITORING` → non-attention `running`/`activity:'monitoring'`
            // (#490). A plain end is classified by `parkPlainEnd`, which may spend a bounded nudge
            // instead of parking at all (spec 2026-08-23-plain-end-structured-question). All three
            // share the waiting lifecycle otherwise (free the slot, keep the idle timer); the
            // autonomous nudge above still wins over any of them.
            if (monitoring) {
              this.store.updateRun(runId, {
                status: 'running',
                activity: 'monitoring',
                waitingReason: undefined,
                waitingQuestion: undefined,
              });
              this.store.updateStep(runId, stepId, { status: 'running' });
              this.monitoring.add(runId);
              this.clearIdleTimer(state);
              this.armMonitoringWakeTimer(runId, state);
              this.waiting.add(runId);
              this.releaseSlot();
            } else if (ask) {
              emitAskRequested(sink, ask);
              this.store.updateRun(runId, {
                status: 'waiting',
                activity: undefined,
                waitingReason: undefined,
                waitingQuestion: undefined,
              });
              this.store.updateStep(runId, stepId, { status: 'waiting' });
              this.monitoring.delete(runId);
              this.clearMonitoringWakeTimer(state, runId);
              this.waiting.add(runId);
              this.armIdleTimer(runId, state);
              this.releaseSlot();
            } else {
              nudged = this.parkPlainEnd(runId, stepId, trailingQuestion, state);
              if (!nudged) {
                this.store.updateStep(runId, stepId, { status: 'waiting' });
                this.monitoring.delete(runId);
                this.clearMonitoringWakeTimer(state, runId);
                this.waiting.add(runId);
                this.armIdleTimer(runId, state);
                this.releaseSlot();
              }
            }
          }
        }
        // A turn that completed is the ONLY evidence the provider's window actually reopened, so
        // it is what retires the consecutive-resume counter — which in turn releases the account
        // hold for every other task queued behind it (spec
        // 2026-08-03-auto-resume-after-usage-limit). `settleSuccess` does the same for a run that
        // finishes outright; this covers the far more common "parked for the user" ending.
        if (this.store.getRun(runId)?.autoResumeAttempts !== undefined) {
          this.store.updateRun(runId, { autoResumeAttempts: undefined });
        }
        // A nudge turn is still `running`, not `waiting` — see P4 step 3.
        appendHandoffHeartbeat(
          this.dataDir,
          runId,
          `turn complete — status=${monitoring ? 'monitoring' : nudged ? 'running' : sessionOpen ? 'waiting' : 'running'}`,
        );
      }
    };

    // Backend + model come off the record: the run's current backend by default, or the
    // follow-up override that `continueRun` persisted before scheduling (#401).
    const continueBackend = backend;
    /** Settle this turn as a failure before anything is spawned — the shape both
     *  pre-spawn gates below need (model identity, #405; temp directory, #785). */
    const failBeforeSpawn = (message: string): void => {
      const failedAt = new Date().toISOString();
      sink.sessionEnded('error', message);
      this.store.updateStep(runId, stepId, {
        status: 'failed',
        error: message,
        finishedAt: failedAt,
      });
      this.store.updateRun(runId, {
        status: 'failed',
        error: `continue failed: ${message}`,
        finishedAt: failedAt,
        currentStepId: undefined,
      });
      this.store.appendEvent(runId, {
        type: 'lifecycle',
        message: `continue failed — ${message}`,
      });
      this.dropActive(runId);
    };
    // Apply the SAME canonical-identity gate the first spawn applies (#405, review M1).
    // A follow-up may switch both runner and model (#401), so without this the record keeps
    // asserting the identity the run STARTED with while a different model serves the turn —
    // the exact defect that PR existed to remove — and the raw record string reaches the CLI
    // in the un-normalised wire form the first step already converted away (`anthropic/opus`
    // instead of `opus`). Fail loud here too rather than let the backend pick a default.
    let continueModel: string | undefined;
    // Hoisted for the same reason as `stepRawModel` in `runAgentStep`: the mapper and the record
    // must read one expression, not two copies of it.
    const continueRawModel = agentModelsLocked(this.repoRoot) ? undefined : record?.model;
    try {
      const normalized = normalizeModelForBackend(continueBackend, continueRawModel, {
        configuredProvider: await configuredModelProvider(continueBackend, state.cwd),
      });
      continueModel = normalized?.backendModel;
      const continueModelIdentity = normalized ? formatModelIdentity(normalized.identity) : undefined;
      this.store.updateRun(runId, {
        modelIdentity: continueModelIdentity,
      });
      // The step half of the same write (spec 2026-08-22-per-step-model-display). Without it, a
      // follow-up that switches model (#401) — or any resume, which re-resolves from the RUN-level
      // `record.model` rather than the step's own — would move the run-level identity on and leave
      // the step's frozen at its spawn-time value, reintroducing at step level the exact "the
      // record asserts a model that is not what ran" defect #405 removed at run level.
      this.store.updateStep(runId, stepId, {
        model: continueRawModel,
        modelIdentity: continueModelIdentity,
      });
      this.store.appendEvent(runId, {
        type: 'note',
        message: `model: ${continueModelIdentity ?? continueRawModel ?? 'auto'}`,
        stepId,
      });
    } catch (err) {
      if (!(err instanceof ModelIdentityError)) throw err;
      failBeforeSpawn(err.message);
      return;
    }
    // Resuming reattaches to a session that lives inside ONE account's config dir, so the
    // continuation must run under the account that created it — not whatever the project has
    // been switched to since. The owning step is the one carrying this session id.
    const resumedProfileId = sessionId === undefined
      ? undefined
      : record?.steps.find((s) => s.sessionId === sessionId)?.profileId;
    // The temp-directory preflight (#785) rides along with the account resolution: a resumed
    // turn hits the same broken `/tmp` a fresh one would, and an agent whose shell silently
    // returns nothing is worse than a turn that refuses to start and says why.
    let continueProfile: {
      env: Record<string, string>;
      profileId: string;
      knowledgeSummary: KnowledgePromptSummary | undefined;
    };
    try {
      continueProfile = await this.agentEnvForStep(runId, continueBackend, {
        generateFollowups,
        recordedProfileId: resumedProfileId,
        stepId,
        ...(sessionId === undefined ? {} : { sessionId }),
      });
    } catch (err) {
      if (!(err instanceof AgentTempDirError)) throw err;
      failBeforeSpawn(err.message);
      return;
    }
    this.store.updateStep(runId, stepId, { profileId: continueProfile.profileId });

    // Proactive Claude-only check (spec 2026-08-22-resume-fresh-session-fallback, Phase 1) — the
    // twin of `runAgentStep`'s own check. `sessionId` here is a hint persisted before the backend
    // ever confirmed the conversation exists (the `updateStep` above at the top of this method);
    // verify a transcript actually exists before handing it to `--resume`. Unlike `runAgentStep`,
    // no `userPrompt` rebuild is needed on a miss: `prompt` is the caller's own opening message
    // either way, not a restart-continuation prompt tied to an assumption the session already
    // holds context (see spec Phase 1, "Phase 3 is unaffected for a different reason").
    let resumeDowngraded = false;
    if (continueBackend === 'claude' && sessionId !== undefined) {
      const claudeHome = agentHomePaths({ ...process.env, ...continueProfile.env }).claude;
      const exists = await claudeSessionTranscriptExists(claudeHome, state.cwd, sessionId);
      if (!exists) {
        resumeDowngraded = true;
        this.store.appendEvent(runId, {
          type: 'note',
          stepId,
          message: 'no transcript for the recorded session — starting fresh',
        });
      }
    }
    // A downgrade mints a NEW id rather than retrying the dead one — Claude never emits a
    // `session` event to correct the record later the way Codex/OpenCode do, so the fresh id
    // must be persisted here or the record keeps pointing at the dead one forever.
    const spawnSessionId = resumeDowngraded ? randomUUID() : sessionId;
    if (resumeDowngraded) this.store.updateStep(runId, stepId, { sessionId: spawnSessionId });

    // From the RECORD, not the registry — see `workspaceGrantOf`.
    const continueGrant = workspaceGrantOf(record);
    const runner = createRunner(continueBackend);
    state.currentStepId = stepId;
    this.beginUsageInvocation(runId, state, stepId);
    // A continuation's opening message becomes the session's `userPrompt` and never passes
    // through `deliverMessage`, so it needs the SAME delivery-only `/skill` rewrite the
    // live path applies (#811). Delivery-only: the `user-message` event above already
    // persisted the user's original text, and the transcript must keep showing that.
    const openingPrompt = expandRegistrySlashSkillText(prompt, state.skills ?? []);
    const continueBroker = await this.brokerFor(runId, stepId, continueBackend);
    const session = runner.startSession(
      {
        // The Continue step is a fresh agent session on the same run — the
        // run's extra system prompt (already resolved at execute time and
        // echoed on the record) rides along with the handoff contract.
        systemPrompt: composeSystemPrompt(
          record?.systemPrompt,
          // A Continue turn is a FRESH agent session, so it re-earns the round-trip tax from
          // scratch — `ec6e8e06`'s `continue-1` step spent 145 s of model time against 3 s of
          // tool time, the worst model:exec ratio in the whole run (48×).
          TOOL_BUDGET_DOCTRINE,
          generateFollowups ? HANDOFF_INSTRUCTIONS : HANDOFF_ONLY_INSTRUCTIONS,
          // Before the knowledge block on purpose: this says where the work IS. A Continue turn
          // is a FRESH agent session, so without it the second turn of a workspace run would
          // have the directories granted and no idea they exist.
          workspaceGrantSystemPrompt(continueGrant),
          knowledgeSystemPrompt(continueProfile.knowledgeSummary),
        ),
        userPrompt: attachments.length
          ? `${openingPrompt}\n\n${pastedAttachmentsText(attachments)}`
          : openingPrompt,
        ...(openingImages.length ? { images: openingImages } : {}),
        cwd: state.cwd,
        allowedTools: DEFAULT_ALLOWED_TOOLS,
        additionalDirectories: [
          ...agentDirectories(join(this.dataDir, 'runs'), continueProfile.env),
          ...(continueProfile.knowledgeSummary?.roots.map((r) => r.path) ?? []),
          ...(continueGrant?.roots ?? []),
        ],
        env: continueProfile.env,
        model: continueModel,
        sessionId: spawnSessionId,
        resume: resumeDowngraded ? false : sessionId !== undefined,
        timeoutMs: 0,
      },
      onEvent,
      {
        onUiEvent: (event) => this.handleRunnerUiEvent(runId, state, sink, event),
        ...(continueBroker ? { broker: continueBroker } : {}),
      },
    );
    state.session = session;
    state.sessionEverOpened = true;
    this.flushDeferred(runId);
    state.interrupt = () => session.interrupt();
    if (session.pid !== undefined) registerRunProcess(runId, session.pid);

    const finishedAt = () => new Date().toISOString();
    /** Set by the success branch below when the chain must take the run back — acted on in
     *  `finally`, once this run has left the live registries. */
    let handBack: RunRecord | null = null;
    /** Set by the catch branch below (spec 2026-08-22-resume-fresh-session-fallback, Phase 3)
     *  when the failure is a recognized "unknown session" rejection and this is the first time —
     *  acted on in `finally`, once this run has left the live registries, same reasoning as
     *  `handBack`: re-invoking while still `active` lets a concurrent `pump()` race this method. */
    let missingSessionRetry = false;
    /** Re-enter after teardown with a new broker but the same backend session id. */
    let coldBrokerRetry = false;
    try {
      await session.result;
      if (sessionError) throw new Error(sessionError);
      sink.sessionEnded(state.cancelled ? 'cancelled' : 'end_turn');
      if (state.cancelled) {
        this.store.updateStep(runId, stepId, { status: 'cancelled', finishedAt: finishedAt() });
        this.store.updateRun(runId, { status: 'cancelled', finishedAt: finishedAt(), currentStepId: undefined });
        this.store.appendEvent(runId, { type: 'lifecycle', message: 'run cancelled' });
        appendHandoffHeartbeat(this.dataDir, runId, `step "${stepId}" complete — status=cancelled`);
      } else if (state.budgetExceeded) {
        // The bound (PLAN D27 Phase 1): the turn-end handler above already ended this session for
        // budget — land `review` + `stopReason` here instead of falling into `settleSuccess`, the
        // same precedence `execute()`'s own terminal block gives budget over a plain finish. The
        // step itself completed its turn; only the RUN is stopped from taking another.
        this.store.updateStep(runId, stepId, { status: 'done', finishedAt: finishedAt() });
        this.clearAccountLimit(runId, stepId);
        this.store.appendEvent(runId, { type: 'step-end', stepId, status: 'done' });
        this.store.updateRun(runId, {
          status: 'review',
          stopReason: 'budget',
          finishedAt: finishedAt(),
          currentStepId: undefined,
          // May have landed while parked `monitoring` on a PRIOR turn of this same continuation —
          // that sub-state is stale the moment the run is no longer `running` at all.
          activity: undefined,
        });
        this.store.appendEvent(runId, {
          type: 'lifecycle',
          message: `run stopped — step budget (${this.effectiveStepBudget(runId, config)}) reached; review before continuing`,
        });
        appendHandoffHeartbeat(this.dataDir, runId, `step "${stepId}" complete — status=review (budget)`);
      } else if (state.idleParked) {
        // Parked for inactivity, NOT finished (spec 2026-08-20-inactive-sessions-stay-in-progress).
        // The wrap-up runs because the backend session closed to free its process, but the agent
        // never emitted CEZ:DONE — so keep the run at `waiting` (needs-you / in-progress), skip
        // `settleSuccess` (no `done`, no worktree apply), and leave the worktree for `--resume`.
        this.store.updateStep(runId, stepId, { status: 'waiting' });
        this.store.updateRun(runId, { status: 'waiting', activity: undefined, currentStepId: undefined });
        appendHandoffHeartbeat(this.dataDir, runId, `step "${stepId}" parked — status=waiting (idle)`);
      } else {
        this.store.updateStep(runId, stepId, { status: 'done', finishedAt: finishedAt() });
        this.clearAccountLimit(runId, stepId);
        this.store.appendEvent(runId, { type: 'step-end', stepId, status: 'done' });
        // The continuation step is done either way; whether the RUN is depends on the chain
        // (spec 2026-08-20, P2). With steps still pending, hand back to the chain instead of
        // settling — `settleSuccess`'s own guard would only park it at `waiting`, which is a
        // stall, not the continuation of the pipeline the user asked for. The hand-back itself
        // happens in `finally`, AFTER `dropActive`: re-queuing a run that is still in `active`
        // lets a concurrent `pump()` enter `execute()` for it, and the `dropActive` below would
        // then delete the NEW `ActiveRun` out from under the running engine loop.
        handBack = state.chainHandBack === true ? (this.store.getRun(runId) ?? null) : null;
        if (!handBack) await this.settleSuccess(runId);
        appendHandoffHeartbeat(
          this.dataDir,
          runId,
          `step "${stepId}" complete — status=${handBack ? 'chain continues' : 'done'}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!retriedColdBroker && isRetryableBrokerLaunch(err)) {
        coldBrokerRetry = true;
        reapAbandonedColdLaunch(err.spoolDir);
        this.store.appendEvent(runId, {
          type: 'note',
          stepId,
          message: `${message}; the follow-up did not reach the agent, relaunching the broker once`,
        });
        this.store.appendEvent(runId, {
          type: 'metric',
          stepId,
          name: 'run.step.retried_cold_broker',
          runId,
          workflow: this.store.getRun(runId)?.workflow,
          spoolDir: err.spoolDir,
          attempt: 2,
        });
      // Reactive fallback (spec 2026-08-22-resume-fresh-session-fallback, Phase 3) — the
      // continuation-path twin of the chain loop's Phase 2 branch, and what
      // `recover-session-failure.test.ts` exercises. `sessionId !== undefined` means this attempt
      // actually resumed a session; `!retriedMissingSession` bounds it to one retry.
      } else if (!retriedMissingSession && sessionId !== undefined && isMissingSessionRejection(backend, message)) {
        missingSessionRetry = true;
        this.store.appendEvent(runId, {
          type: 'note',
          stepId,
          message: `${message} — the session was never confirmed to exist; retrying with a fresh session`,
        });
        this.store.appendEvent(runId, {
          type: 'metric',
          stepId,
          name: 'run.step.resumed_after_missing_session',
          runId,
          backend,
        });
      } else {
        sink.sessionEnded('error', message);
        this.store.updateStep(runId, stepId, { status: 'failed', error: message, finishedAt: finishedAt() });
        appendHandoffHeartbeat(this.dataDir, runId, `step "${stepId}" complete — status=failed`);
        this.store.updateRun(runId, {
          status: 'failed',
          error: `continue failed: ${message}`,
          finishedAt: finishedAt(),
          currentStepId: undefined,
        });
        this.store.appendEvent(runId, { type: 'lifecycle', message: `continue failed — ${message}` });
      }
    } finally {
      this.recordUsagePeaks(runId);
      this.clearIdleTimer(state);
      this.clearAutosaveTimer(state);
      if (state.cwd !== this.repoRoot) await autosaveCommit(state.cwd, 'turn end');
      // Same rule as `execute()`'s terminal block: a continuation that ended cancelled/stopped/
      // failed drops its worktree directories and keeps the branches (spec 2026-08-20, X3).
      await this.discardWorkspaceRun(runId);
      this.dropActive(runId);
      if (coldBrokerRetry) {
        void this.runContinuation(
          runId,
          stepId,
          name,
          sessionId,
          backend,
          prompt,
          images,
          persistedImages,
          persistedAttachments,
          retriedMissingSession,
          true,
        ).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.store.updateRun(runId, {
            status: 'failed',
            error: `continue crashed: ${message}`,
            finishedAt: new Date().toISOString(),
          });
          this.dropActive(runId);
        });
      } else if (missingSessionRetry) {
        // Same shape as `handBack` below: re-invoke only after this run has left the live
        // registries, so a concurrent `pump()` cannot race the new `ActiveRun` this creates.
        // Re-entering `runContinuation` itself (rather than the chain loop) re-sets `status:
        // 'running'`, `iterations: 1` and re-appends `step-start`/`user-message` unconditionally
        // (above), so the record ends up looking like a step that took two iterations — the same
        // shape the chain-loop fallback produces.
        void this.runContinuation(
          runId,
          stepId,
          name,
          undefined,
          backend,
          prompt,
          images,
          persistedImages,
          persistedAttachments,
          true,
        ).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.store.updateRun(runId, {
            status: 'failed',
            error: `continue crashed: ${message}`,
            finishedAt: new Date().toISOString(),
          });
          this.dropActive(runId);
        });
      } else if (handBack) {
        // Now that the run holds no slot and no `ActiveRun`, put it back in the queue at its next
        // pending step. `dropActive`'s own `releaseSlot()` pumped a queue this run was not in
        // yet, so pump once more — otherwise the re-queued run waits for an unrelated wakeup.
        if (await this.reenterChain(handBack, 'step goal achieved', { requireProgress: true })) {
          void this.pump();
        } else {
          await this.settleSuccess(runId);
        }
      }
    }
  }

  // ---- execution -----------------------------------------------------------

  private async execute(
    runId: string,
    workflow: WorkflowDef,
    input: ExecuteRunInput,
    /** Chain re-entry (spec 2026-08-20, P1): start the loop at this step instead of the top, and
     *  reattach its interrupted session when one survived. Absent on every ordinary start. */
    resumeAt?: ChainResumePoint,
  ): Promise<void> {
    const state: ActiveRun = {
      cancelled: false,
      interrupt: () => undefined,
      cwd: this.repoRoot,
      autonomous: input.autonomous === true,
      autoContinues: 0,
    };
    this.active.set(runId, state);
    this.starting.delete(runId);
    const emit = (event: { type: string; stepId?: string; [k: string]: unknown }) =>
      this.store.appendEvent(runId, event);

    // Resolve the agent backend for this run: the task choice (GUI) wins over
    // the config default. Per-step `runner` can still override it below.
    const config = await loadConfig(this.repoRoot);
    // A pool route resolves HERE, once, and never again (spec 2026-08-16, Phase C). This is the
    // moment the run stops being a plan and starts being work, and it is late enough that the
    // balancer sees the real state of the workspace — a run queued ten minutes ago must not be
    // routed on ten-minute-old in-flight counts. `pool:*` picks the PROVIDER too, which is why this
    // sits above `taskBackend` rather than inside the account lookup.
    const pooled = await resolvePoolForDispatch({
      agentProfile: input.agentProfile,
      fallbackProvider: (input.runner ?? config.defaultRunner) as ProviderId,
      repoRoot: this.repoRoot,
      // Workspace-wide, via the semaphore every manager registers with — the boot project's
      // included, which no project-context map can see. See `SemaphoreParticipant.accountInflight`.
      inflight: this.semaphore.accountInflight(),
    });
    // Out-of-quota fallback (spec 2026-08-23-retarget-task-to-another-engine, Phase 4). Only for
    // an EXPLICIT pick — `pooled` being set means the user asked for a pool, which already routed
    // around the limit on its own (Phase 1) and needs no override. **ON by default** since
    // `2026-08-23-never-block-a-task.md` (this comment said "Off by default" until then).
    const rerouted = pooled ?? (await this.rerouteExplicitAccountIfLimited(runId, input, config.defaultRunner));
    const chosen = pooled ?? rerouted;
    const taskBackend: RunnerId = chosen?.provider ?? input.runner ?? config.defaultRunner;
    // The account may have gone into a usage-limit hold since this run was dequeued — the queue
    // gate cannot be the only one, because dequeue is not the moment of no return. Nothing has
    // happened yet here, so the run goes back to the queue untouched (spec
    // 2026-08-03-auto-resume-after-usage-limit).
    if (this.requeueWhileHeld(runId, workflow, input, taskBackend, undefined, chosen)) return;
    // Extra system prompt (R2 2.3): POST override > config default; echoed on
    // the record so the UI/API can show what the run actually used.
    const extraSystemPrompt = resolveExtraSystemPrompt(input.systemPrompt, config.systemPrompt);
    // Canonical provider/model identity (#405) — the normalised `provider/model`
    // the task ran with, persisted for cost attribution / reproducible replay
    // beside the free-text `model`. Best-effort here (a per-step `runner`/`model`
    // can still override below); the authoritative fail-loud gate is at spawn.
    let modelIdentity: string | undefined;
    try {
      const normalized = normalizeModelForBackend(
        taskBackend,
        agentModelsLocked(this.repoRoot) ? undefined : input.model,
        { configuredProvider: await configuredModelProvider(taskBackend, this.repoRoot) },
      );
      modelIdentity = normalized ? formatModelIdentity(normalized.identity) : undefined;
    } catch {
      // An unresolvable task-level model surfaces loudly at the step below; the
      // metadata echo stays absent rather than guessing.
    }
    this.store.updateRun(runId, {
      status: 'running',
      startedAt: new Date().toISOString(),
      runner: taskBackend,
      systemPrompt: extraSystemPrompt,
      modelIdentity,
      // The pool is spent here. From this line on the record names a concrete login, so resume
      // reads the account that actually ran, the thread header keeps meaning what it means, and
      // "which account spent this" stays answerable after the fact. A record that stayed `pool:…`
      // would re-balance on every resume and could answer differently each time.
      // `chosen`, not `pooled`: an out-of-quota reroute (Phase 4) resolves a concrete login for
      // the same reason a pool does, and leaving the record naming the limited account the user
      // originally picked would make the thread header, the resume and "which account spent this"
      // all answer with an account that ran nothing.
      ...(chosen ? { agentProfile: chosen.accountId } : {}),
    });
    emit({ type: 'lifecycle', message: `run started — workflow "${workflow.name}" (runner: ${taskBackend})` });

    // Worktree per task (spec 006): the agent works on its own branch in
    // `.ai/cezar/worktrees/<id>`, never in the user's working tree. A Git task
    // that requests isolation fails closed if the worktree cannot be
    // established; only explicit opt-out and non-Git modes run in place.
    const repo = await getRepoInfo(this.repoRoot);
    // At the boot scratch root, a run that arrived without a grant adopts one and becomes a
    // workspace run here (spec 2026-08-21, change C) — see `adoptWorkspaceGrant`.
    await this.adoptWorkspaceGrant(runId, emit);
    // A parallel WORKSPACE RUN (spec 2026-08-19): isolate each granted git project in its own
    // `cez/<id8>` worktree, run up to maxParallel — no boot repo-root lease (below) and not counted
    // by the non-git cap in `pump()`. cwd stays the boot scratch repo; the grant (--add-dir + the
    // prompt) is redirected to the worktrees by `workspaceGrantOf` reading `workspaceWorktrees`.
    const isWorkspaceRun = (this.store.getRun(runId)?.workspaceProjects?.length ?? 0) > 0;
    if (isWorkspaceRun) {
      const projects = this.store.getRun(runId)?.workspaceProjects ?? [];
      const worktrees = await materializeWorkspaceWorktrees(
        runId,
        projects,
        (m) => emit({ type: 'note', message: m }),
        // Persist a snapshot after EVERY worktree, not just at the end (spec
        // 2026-08-22-cross-project-worktree-orphan-prune-safety) — otherwise the first project's
        // worktree sits on disk, unrecorded anywhere a target project's own boot-time prune can
        // see, for as long as the rest of this loop takes.
        (snapshot) => {
          this.store.updateRun(runId, { workspaceWorktrees: [...snapshot] });
        },
        this.repoRoot,
      );
      this.store.updateRun(runId, { workspaceWorktrees: worktrees });
      this.armWorktreeLeases(state, runId, worktrees.map((worktree) => worktree.root));
      emit({
        type: 'note',
        message:
          worktrees.length > 0
            ? `workspace run — ${worktrees.length} project worktree(s) isolated; changes apply back on finish`
            : 'workspace run — no git projects to isolate; running in place',
      });
    } else if (repo && input.worktree === false && !this.bootScratchRoot) {
      // Composer opt-out: run in the repo working tree, no branch/worktree. The
      // repository-root lease serializes these runs by default; the explicit
      // CEZ_DISABLE_REPO_LOCK=1 escape hatch allows unsafe overlap.
      // Pin the starting commit: the session's Changes and Commits views use it
      // as their stable lower bound while reading the current working copy.
      const startingCommit = await getHeadCommit(repo.root);
      if (startingCommit) this.store.updateRun(runId, { baseBranch: startingCommit });
      emit({ type: 'note', message: 'worktree off — running in the repo working tree' });
    } else if (repo) {
      if (input.worktree === false) {
        // Change B. `worktree: false` means "work in the repo working tree", and at the boot
        // scratch root there is no work in that tree to be in — only cezar's own runtime state,
        // which the repo ignores. Honoring it would buy nothing and cost the exclusive
        // working-tree lease plus `pump()`'s one-at-a-time cap. So it is overridden, out loud:
        // a note that disagrees with the request is honest, a silent disagreement is not.
        emit({
          type: 'note',
          message:
            'worktree forced on — this is the workspace boot root, which holds no project work; ' +
            `isolating in .ai/cezar/worktrees/${runId} instead of running in place`,
        });
        // Clear the persisted opt-out, or `workingDirectoryOf` (`server.ts`, the session Git
        // view) would keep reading the boot root while the agent works in the worktree, and
        // restart recovery would keep treating a removed worktree as "never had one".
        this.store.updateRun(runId, { worktree: undefined });
      } else {
        emit({
          type: 'note',
          message: `worktree on — using an isolated task worktree (${input.worktree === true ? 'explicit request' : 'default'})`,
        });
      }
      // Fork from the configured base branch (config.json `baseBranch`, e.g.
      // `develop`) — also the target of the eventual draft PR. Unresolvable
      // (typo, not fetched) → note + the currently checked-out branch.
      //
      // A task that already recorded a fork point keeps it: its worktree is
      // reused as-is, and re-resolving against a since-changed config would
      // silently re-anchor the `merge-base` every diff/shortstat is measured
      // from, shifting "what did this task change" under an existing task.
      const recorded = this.store.getRun(runId)?.baseBranch;
      let base = recorded ?? repo.branch;
      const configured = recorded ? undefined : config.baseBranch;
      if (configured) {
        const resolved = await resolveBaseRef(this.repoRoot, configured);
        if (resolved) {
          base = resolved;
        } else {
          emit({
            type: 'note',
            message: `configured base branch "${configured}" not found (locally or on origin) — using "${repo.branch}"`,
          });
        }
      }
      try {
        const wt = await createWorktree(this.repoRoot, runId, base);
        await writeWorktreeLease(this.repoRoot, runId, this.repoRoot);
        state.cwd = wt.path;
        this.store.updateRun(runId, {
          worktreePath: wt.path,
          branch: wt.branch,
          baseBranch: wt.baseBranch,
        });
        emit({ type: 'note', message: `worktree ready — branch ${wt.branch} (base ${wt.baseBranch})` });
        // Seed from this manager's project root: each multi-project context has
        // its own manager/repoRoot and must never copy another project's layer.
        const seededConfig = await seedAgentConfigLocalLayer(this.repoRoot, state.cwd).catch(() => []);
        if (seededConfig.length > 0) {
          emit({ type: 'note', message: `seeded personal agent config: ${seededConfig.join(', ')}` });
        }
        this.armAutosave(state);
        this.armWorktreeLeases(state, runId, [this.repoRoot]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const error = `worktree creation failed: ${message}`;
        emit({ type: 'note', message: `${error} — task stopped before workflow execution` });
        this.store.updateRun(runId, {
          status: 'failed',
          error,
          finishedAt: new Date().toISOString(),
          currentStepId: undefined,
        });
        emit({ type: 'lifecycle', message: `run failed — ${error}` });
        this.dropActive(runId);
        return;
      }
    } else {
      emit({ type: 'note', message: 'not a git repository — running in place, one task at a time' });
    }

    if (state.cwd === this.repoRoot) {
      // A workspace run does NOT take the lease: its work is isolated in per-project worktrees, so
      // the boot scratch tree it shares with other workspace runs holds none of it (spec
      // 2026-08-19, W3). Ordinary in-place runs still serialize on the boot tree as before.
      if (isWorkspaceRun) {
        // no lease — parallel by design
      } else if (repositoryRootLockDisabled()) {
        emit({
          type: 'note',
          message: REPOSITORY_ROOT_LOCK_DISABLED_NOTE,
        });
      } else {
        emit({
          type: 'note',
          message: 'waiting for exclusive access to the repository working tree',
        });
        // A cancel during the wait leaves the lease ungranted; the step loop
        // below breaks on `cancelled` before touching the tree and settles the
        // run through the usual path.
        await this.acquireRepoRoot(runId, state);
      }
      // THE window that matters for an in-place run. Waiting for the exclusive tree can take
      // minutes, and a run parked on that lease holds no slot (#347) — so the queue keeps
      // advancing behind it and the dequeue-time gate is long past. Measured with five in-place
      // tasks and `maxParallel: 2`: four of them started. Re-ask here, where the very next thing
      // is a spawn, and hand the run back to the queue if the account closed meanwhile. This
      // check also covers the explicit lock-bypass path, where the account may close while the
      // run is preparing its first step.
      if (this.requeueWhileHeld(runId, workflow, input, taskBackend, state, chosen)) return;
    }

    // Handoff journal (spec 007) — seeded after the worktree exists so the
    // header can name the branch. Idempotent: an existing file stays as-is.
    const seeded = this.store.getRun(runId);
    if (seeded) seedHandoffFile(this.dataDir, seeded);

    const skills = await discoverSkills(this.repoRoot);
    // Every ActiveRun construction site must carry the registry — `runContinuation` builds
    // its own, and the one that skipped this leaked raw `/skill` text to the backend (#811).
    state.skills = skills;
    const retriesUsed = new Map<string, number>();
    /** Re-runs a step has had because its POST-CONDITION failed. Separate ledger from
     *  `retriesUsed`: that one counts a check step looping BACK to an earlier step, this one
     *  counts a step being re-entered to finish its own unfinished job. */
    const verifyRetries = new Map<string, number>();
    let checkFailure: string | null = null;
    let runError: string | null = null;

    /** Is a backwards loop from this step still within its `onFail.max` budget? */
    const canLoopBack = (from: WorkflowStepDef): boolean =>
      Boolean(from.onFail) && (retriesUsed.get(from.id) ?? 0) < (from.onFail?.max ?? 0);

    /**
     * Send the chain BACK to `step.onFail.retry`, carrying `feedback` into that step's prompt.
     *
     * ONE loop-back in this engine, not two. It was extracted when the spec reviewer's `revise`
     * verdict (spec 2026-08-20-split-steps-spec-review-and-approval-gate, P2) became a second
     * caller: a check step failing and a reviewer asking for changes are the same motion — reset
     * the steps between here and the target so the GUI rail reads top-to-bottom truthfully, hand
     * the target the text explaining WHY, and re-enter. `stepsIssue` has already guaranteed the
     * target is an EARLIER step, so this can only ever go backwards.
     *
     * Returns the index to continue from. Callers check `canLoopBack` first.
     */
    const loopBackTo = (from: number, step: WorkflowStepDef, feedback: string, message: string): number => {
      retriesUsed.set(step.id, (retriesUsed.get(step.id) ?? 0) + 1);
      checkFailure = feedback;
      const retryIdx = workflow.steps.findIndex((candidate) => candidate.id === step.onFail?.retry);
      emit({ type: 'note', stepId: step.id, message });
      for (const between of workflow.steps.slice(retryIdx, from + 1)) {
        this.store.updateStep(runId, between.id, { status: 'pending' });
      }
      return retryIdx;
    };
    // The step budget (PLAN D27, Phase 1 of
    // `.ai/specs/2026-08-15-autonomous-implementation-continuation.md`): `config.stepBudget`
    // (0 = unlimited) caps the persisted `stepsUsed` counter — see its doc comment
    // (`runs/store.ts`) for what counts as a unit. `state.budgetExceeded` (not a local variable
    // here) carries the signal, because it must also be settable from INSIDE `runAgentStep`'s
    // open-session turn-end handler — this loop does not control an interactive step's session
    // once its `await` is in flight, so a fixed step list alone cannot carry this bound.
    // `startRun` already persisted task images so a queued bubble can render them
    // (#612). Reuse those files for the agent-facing path note instead of minting
    // duplicate pasted files when execution finally begins.
    let startAttachments: PersistedAttachment[] = (this.store.getRun(runId)?.taskImages ?? [])
      .map((url): PersistedAttachment | null => {
        const name = url.split('/').pop();
        if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) return null;
        const path = join(this.dataDir, 'runs', `${runId}-images`, name);
        return existsSync(path) ? { name, url, path } : null;
      })
      .filter((saved): saved is PersistedAttachment => saved !== null);
    // Task screenshots go with the FIRST agent step's opening message only —
    // later steps and retry loops run in fresh sessions without them. Stacked
    // attachments (#472) ride along too, but are NOT re-persisted above: they
    // already live on disk, and adding them to `taskImages` would both duplicate
    // the files and make the task bubble claim the stack's images as its own.
    let startImages =
      input.stackedImages?.length ? [...(input.images ?? []), ...input.stackedImages] : input.images;

    const lastAgentIdx = findLastAgentStepIndex(workflow);

    // A re-entry (P1) resumes mid-chain. Clamp defensively: the index came from a revived
    // definition that may not be the one the record was written against.
    const resumeIdx =
      resumeAt && resumeAt.index > 0 && resumeAt.index < workflow.steps.length ? resumeAt.index : 0;
    // Consumed by the FIRST step this loop runs and never again — a later step is new work,
    // not a resumed turn.
    let resumeFrom = resumeIdx === (resumeAt?.index ?? -1) ? resumeAt?.resume : undefined;
    // A re-entry may carry the reason it is re-entering — today: the notes from a "request
    // changes" that landed after a restart, when there was no parked `execute()` left to resolve
    // (spec 2026-08-20, P3). Delivered through the same channel a failing check uses.
    if (resumeAt?.feedback) checkFailure = resumeAt.feedback;

    /** Steps already re-entered once after a cezar-initiated stop. One retry per step: a second
     *  stop is terminal for the run rather than a loop. */
    const resumedAfterStop = new Set<string>();
    /** Steps already re-entered once after a resume rejected because the backend never actually
     *  created the conversation being resumed (spec 2026-08-22-resume-fresh-session-fallback,
     *  Phase 2). One retry per step, same reasoning as `resumedAfterStop`: a second miss in a row
     *  is a real failure, not a loop to keep retrying. */
    const resumedAfterMissingSession = new Set<string>();
    /** Steps already relaunched once after a new broker never answered its first control request. */
    const retriedColdBroker = new Set<string>();
    /** The resume handle a re-entry hands to the step it is re-running. Distinct from
     *  `resumeFrom`, which belongs to a RESTART re-entry and is spent on `resumeIdx` only. */
    let stopResume: { sessionId: string; profileId?: string; prompt: string } | undefined;
    /** Set when a stop is terminal for this run: it parks at `review` with this reason, and the
     *  steps after it stay `pending`. Deliberately NOT `runError` — a run cezar stopped is not a
     *  run that failed, and collapsing them makes the record unable to answer which it was. */
    let stopReason: AgentStopReason | undefined;

    let i = resumeIdx;
    while (i < workflow.steps.length) {
      if (state.cancelled) break;
      if (this.budgetSpent(runId, config)) {
        state.budgetExceeded = true;
        break;
      }
      const step = workflow.steps[i] as WorkflowStepDef;
      const kind = stepKind(step);
      const record = this.store.getRun(runId)?.steps.find((s) => s.id === step.id);
      const iteration = (record?.iterations ?? 0) + 1;

      this.store.updateRun(runId, { currentStepId: step.id });
      this.store.updateStep(runId, step.id, {
        status: 'running',
        iterations: iteration,
        startedAt: new Date().toISOString(),
        error: undefined,
      });
      emit({ type: 'step-start', stepId: step.id, name: step.name ?? step.id, kind, iteration });

      if (kind === 'agent') {
        // The last agent step of the workflow is interactive: after its turn
        // the session stays open for follow-ups until finish/idle/cancel.
        const interactive = i === lastAgentIdx && i === workflow.steps.length - 1;
        // A stop re-entry's handle wins: it is for THIS iteration of THIS step, whereas
        // `resumeFrom` belongs to the restart that opened the loop and is spent on `resumeIdx`.
        const stepResume = stopResume ?? (i === resumeIdx ? resumeFrom : undefined);
        stopResume = undefined;
        resumeFrom = undefined;
        state.stepStopped = undefined;
        state.brokerNeverAnswered = undefined;
        // These three snapshots serve two purposes at once, and both need the value AS SENT.
        // Theirs: a broker that never answered is retried once, and the retry restores exactly
        // what this attempt was given (see `coldBroker` below). Ours: `withHeavyStep` may not call
        // `fn` until a heavy slot frees, and `startImages`/`startAttachments`/`checkFailure` are
        // one-shot — they belong to the step entering now, not to whatever the loop is doing when
        // it resumes. Passing the snapshots rather than the live variables makes the call
        // independent of when it actually runs.
        const sentImages = startImages;
        const sentAttachments = startAttachments;
        const sentCheckFailure = checkFailure;
        const stepChainNote = chainStepNote(workflow.steps, i, { resumed: stepResume !== undefined });
        const failure = await this.withHeavyStep(step, emit, () =>
          this.runAgentStep(
            runId,
            state,
            step,
            input,
            skills,
            sentCheckFailure,
            interactive,
            emit,
            sentImages,
            taskBackend,
            extraSystemPrompt,
            stepChainNote,
            sentAttachments,
            stepResume,
            // The POST-CONDITION ledger, not `retriesUsed`: the table's escalation row is about a
            // step that ran and did not meet its goal, which is exactly what `verifyRetries`
            // counts. `retriesUsed` counts a CHECK step looping back to an earlier step — a
            // different event, and one that can re-enter a step that never failed.
            { priorFailures: verifyRetries.get(step.id) ?? 0 },
          ),
        );
        startImages = undefined;
        startAttachments = [];
        checkFailure = null;
        if (state.cancelled) break;
        const stopped = state.stepStopped;
        state.stepStopped = undefined;
        if (failure && stopped) {
          // A stop cezar initiated. Three things must NOT happen here, all of which did on run
          // 9d09795a: the step must not read as an agent failure, the RUN must not be marked
          // `failed`, and the steps after it must not be abandoned into ad-hoc `continue-N` chat.
          const record = this.store.getRun(runId)?.steps.find((st) => st.id === step.id);
          // Name the numbers now, so "how often does this fire, and how far in?" has an answer
          // next time instead of a grep. The run's own NDJSON is the analytics surface.
          emit({
            type: 'metric',
            stepId: step.id,
            name: 'run.step.stopped',
            runId,
            workflow: workflow.name,
            reason: stopped,
            elapsedMs: record?.startedAt ? Date.now() - Date.parse(record.startedAt) : undefined,
            tokensUsed: record?.tokensUsed,
            attempt: resumedAfterStop.has(step.id) ? 2 : 1,
          });
          if (!resumedAfterStop.has(step.id) && record?.sessionId) {
            // Re-enter the SAME session once. The work is on disk and in the session; starting
            // over would discard it, and a cold continuation costs more than the bound saved.
            resumedAfterStop.add(step.id);
            emit({
              type: 'note',
              stepId: step.id,
              message: `${failure} — resuming the same session once`,
            });
            emit({ type: 'metric', stepId: step.id, name: 'run.step.resumed_after_stop', runId, reason: stopped });
            this.store.updateStep(runId, step.id, { status: 'pending', error: undefined });
            stopResume = {
              sessionId: record.sessionId,
              // `sessionId` and `profileId` are a PAIR — see `chainResumeAt`.
              ...(record.profileId ? { profileId: record.profileId } : {}),
              prompt: stoppedContinuationPrompt(stopped),
            };
            continue; // same `i`
          }
          this.finishStep(runId, step.id, 'failed', failure, emit, stopped);
          stopReason = stopped;
          break;
        }
        // Reactive fallback (spec 2026-08-22-resume-fresh-session-fallback, Phase 2) — the exact
        // path run `232ad6d4` hit: `stepResume !== undefined` means this attempt actually resumed
        // a session, and the predicate recognizes the backend's "never created that conversation"
        // rejection. One retry per step, mirroring `resumedAfterStop` just above.
        // From the RECORD, not `step.runner ?? taskBackend`. A step-level pin can be DOWNGRADED at
        // dispatch when its provider is wholly out of quota (`downgradePinnedRunner`,
        // `2026-08-23-never-block-a-task.md`), so the definition and the thing that ran no longer
        // always agree — and this classifies one provider's rejection strings while reporting a
        // metric about another. `runAgentStep` stamps `backend` before it spawns, so the record is
        // the one place both facts are the same.
        const ranOn =
          this.store.getRun(runId)?.steps.find((s) => s.id === step.id)?.backend
          ?? step.runner
          ?? taskBackend;
        if (
          failure &&
          stepResume !== undefined &&
          !resumedAfterMissingSession.has(step.id) &&
          isMissingSessionRejection(ranOn, failure)
        ) {
          resumedAfterMissingSession.add(step.id);
          this.store.updateStep(runId, step.id, { sessionId: undefined, status: 'pending', error: undefined });
          emit({
            type: 'note',
            stepId: step.id,
            message: `${failure} — the session was never confirmed to exist; retrying with a fresh session`,
          });
          emit({
            type: 'metric',
            stepId: step.id,
            name: 'run.step.resumed_after_missing_session',
            runId,
            workflow: workflow.name,
            backend: ranOn,
          });
          continue; // same `i` — resumeFrom/stopResume are already spent, so the next pass mints a fresh id
        }
        // The session callback can set this while `runSingleAgentStep` is awaiting. TypeScript's
        // local control-flow analysis cannot observe that asynchronous mutation.
        const coldBroker = state.brokerNeverAnswered as ActiveRun['brokerNeverAnswered'];
        state.brokerNeverAnswered = undefined;
        if (failure && coldBroker && !retriedColdBroker.has(step.id)) {
          retriedColdBroker.add(step.id);
          reapAbandonedColdLaunch(coldBroker.spoolDir);
          this.store.updateStep(runId, step.id, {
            sessionId: undefined,
            status: 'pending',
            error: undefined,
          });
          emit({
            type: 'note',
            stepId: step.id,
            message: `${failure}; no control request reached the agent, relaunching the broker once`,
          });
          emit({
            type: 'metric',
            stepId: step.id,
            name: 'run.step.retried_cold_broker',
            runId,
            workflow: workflow.name,
            spoolDir: coldBroker.spoolDir,
            attempt: 2,
          });
          startImages = sentImages;
          startAttachments = sentAttachments;
          checkFailure = sentCheckFailure;
          continue;
        }
        if (failure) {
          this.finishStep(runId, step.id, 'failed', failure, emit);
          runError = `step "${step.id}" failed: ${failure}`;
          break;
        }
        if (state.budgetExceeded) break; // its own turn-end handler already landed this — see there

        const verdict = await this.runStepVerify(runId, state, step, emit);
        if (state.cancelled) break;
        if (!verdict.ok) {
          const attempt = this.retryAfterFailedPostcondition(runId, step, verdict, verifyRetries, emit);
          if (attempt) {
            checkFailure = attempt;
            continue; // same `i` — the step re-runs to finish its own job
          }
          this.finishStep(runId, step.id, 'failed', `post-condition failed — ${verdict.detail}`, emit);
          runError = `step "${step.id}" did not meet its post-condition: ${verdict.detail}`;
          break;
        }

        // ---- the spec reviewer's verdict (spec 2026-08-20, P2) -------------------------------
        // Read and CLEAR: the verdict belongs to the step that just ran, and leaving it set would
        // let one reviewer's `revise` re-trigger on a later step that never declared anything.
        const reviewVerdict = state.reviewVerdict;
        const report = state.reviewReport;
        state.reviewVerdict = undefined;
        state.reviewReport = undefined;
        if (reviewVerdict === 'revise' && step.onFail) {
          const used = retriesUsed.get(step.id) ?? 0;
          if (canLoopBack(step)) {
            // The reviewer did its job correctly — `done`, not `failed`. `loopBackTo` resets it to
            // `pending` a line later anyway (the slice is inclusive of `from`), but the step-end
            // event the rail reads must not call a working reviewer a failure.
            this.finishStep(runId, step.id, 'done', undefined, emit);
            const reviewFeedback = report ?? 'The reviewer asked for changes but left no report.';
            i = loopBackTo(
              i,
              step,
              step.onFail?.retry === 'spec'
                ? specRevisionFeedback(reviewFeedback, this.store.getRun(runId)?.declaredSpecPath)
                : reviewFeedback,
              `spec review asked for changes — reworking from "${step.onFail.retry}" (revision ${used + 1}/${step.onFail.max})`,
            );
            continue;
          }
          // Revisions spent. PROCEED rather than fail the run — deliberately, and loudly.
          //
          // Failing here would let one stubborn reviewer kill a run at the SHIPPED DEFAULT, where
          // no human is in the loop to overrule it (`minApprovers: 0`); that trades a
          // false-green risk for a hard-stop certainty, which is the worse of the two. The note
          // is the mitigation and it is not decorative: it is what a person reads when asking why
          // an implemented change still carries an unresolved objection.
          emit({
            type: 'note',
            stepId: step.id,
            message: `spec review still asks for changes after ${step.onFail.max} revision(s) — continuing anyway; read this step's report before trusting the result`,
          });
        }

        // ---- the human approval gate (spec 2026-08-20, P3) -----------------------------------
        if (step.requiresApproval) {
          const outcome = await this.awaitApproval(runId, state, step, emit, config);
          if (outcome.kind === 'cancelled') break;
          if (outcome.kind === 'changes') {
            const used = retriesUsed.get(step.id) ?? 0;
            if (canLoopBack(step)) {
              this.finishStep(runId, step.id, 'done', undefined, emit);
              i = loopBackTo(
                i,
                step,
                step.onFail?.retry === 'spec'
                  ? specRevisionFeedback(outcome.notes, this.store.getRun(runId)?.declaredSpecPath)
                  : `A reviewer requested changes to "${step.onFail?.retry ?? step.id}":\n\n${outcome.notes}`,
                `changes requested — reworking from "${step.onFail?.retry}" (revision ${used + 1}/${step.onFail?.max})`,
              );
              continue;
            }
            // A HUMAN asked for changes and the chain has no revisions left. Unlike the agent
            // verdict above, this one stops the run: a person is in the loop by definition here
            // (the gate only parks when they opted in), so "proceed anyway" would override the
            // very decision the gate exists to collect.
            this.finishStep(runId, step.id, 'failed', 'changes requested, no revisions left', emit);
            runError = `step "${step.id}": changes were requested after ${step.onFail?.max ?? 0} revision(s) — rework the spec and start again`;
            break;
          }
        }

        this.finishStep(runId, step.id, 'done', undefined, emit);
        i++;
        continue;
      }

      const { ok, output } = await this.withHeavyStep(step, emit, () => this.runCheckStep(state, step, emit));
      this.spendBudgetUnit(runId); // a check attempt is one unit, same as an agent turn
      if (state.cancelled) break;
      if (ok) {
        const verdict = await this.runStepVerify(runId, state, step, emit);
        if (state.cancelled) break;
        if (!verdict.ok) {
          // Deliberately NOT stashed in `checkFailure`: that channel appends text to a retried
          // AGENT's prompt, and a check step has no prompt to carry it into — leaving it set would
          // leak this verdict into whatever agent step ran next.
          if (this.retryAfterFailedPostcondition(runId, step, verdict, verifyRetries, emit)) {
            continue; // same `i`
          }
          this.finishStep(runId, step.id, 'failed', `post-condition failed — ${verdict.detail}`, emit);
          runError = `step "${step.id}" did not meet its post-condition: ${verdict.detail}`;
          break;
        }
        this.finishStep(runId, step.id, 'done', undefined, emit);
        i++;
        continue;
      }

      const used = retriesUsed.get(step.id) ?? 0;
      if (canLoopBack(step)) {
        this.finishStep(runId, step.id, 'failed', 'check failed — looping back', emit);
        i = loopBackTo(
          i,
          step,
          output,
          `check failed — retrying from "${step.onFail?.retry}" (attempt ${used + 1}/${step.onFail?.max})`,
        );
        continue;
      }

      this.finishStep(runId, step.id, 'failed', `\`${step.command}\` exited non-zero`, emit);
      runError = `check "${step.id}" failed${step.onFail ? ` after ${used + 1} attempts` : ''}`;
      break;
    }

    // Final autosave: the branch always ends holding the finished state.
    this.clearAutosaveTimer(state);
    if (state.cwd !== this.repoRoot) await autosaveCommit(state.cwd, 'run finalize');

    const finishedAt = new Date().toISOString();
    if (state.cancelled) {
      const run = this.store.getRun(runId);
      for (const s of run?.steps ?? []) {
        if (s.status === 'running' || s.status === 'waiting') {
          this.store.updateStep(runId, s.id, { status: 'cancelled' });
        }
      }
      this.store.updateRun(runId, { status: 'cancelled', finishedAt, currentStepId: undefined });
      emit({ type: 'lifecycle', message: 'run cancelled' });
    } else if (stopReason) {
      // `review`, never `failed` — the precedent `stopReason: 'budget'` set: an agent cezar
      // stopped is not an agent that errored, and `review` is already resumable from the
      // cockpit's Continue action. The steps after this one were never touched, so they stay
      // `pending` and the chain is still there to finish.
      this.store.updateRun(runId, {
        status: 'review',
        stopReason,
        finishedAt,
        currentStepId: undefined,
        // May have been parked `monitoring` when the stop landed — stale the moment the run is
        // no longer `running` at all.
        activity: undefined,
      });
      emit({
        type: 'lifecycle',
        message: `run stopped — the agent produced no output for too long; review before continuing`,
      });
    } else if (runError) {
      this.store.updateRun(runId, { status: 'failed', error: runError, finishedAt, currentStepId: undefined });
      emit({ type: 'lifecycle', message: `run failed — ${runError}` });
    } else if (state.budgetExceeded) {
      // The bound (PLAN D27, Phase 1): `review`, never `done`, and never `failed` — an agent
      // halted at its ceiling and an agent that finished must not share a terminal state, and an
      // agent we stopped is not an agent that errored. See `stopReason`'s doc comment
      // (`runs/store.ts`) for why this is a new field rather than a widened `RunStatus`.
      this.store.updateRun(runId, {
        status: 'review',
        stopReason: 'budget',
        finishedAt,
        currentStepId: undefined,
        // The stop may have landed while the run was parked `monitoring` (a self-continuing
        // interactive step over several turns) — that sub-state is stale the moment the run is
        // no longer `running` at all.
        activity: undefined,
      });
      emit({
        type: 'lifecycle',
        message: `run stopped — step budget (${this.effectiveStepBudget(runId, config)}) reached; review before continuing`,
      });
    } else if (state.idleParked) {
      // Inactivity parked the last interactive step; the backend process was closed to free
      // memory but the agent never finished. Keep the run `waiting` (in-progress / needs-you),
      // not `done` — the next message resumes it via `--resume`
      // (spec 2026-08-20-inactive-sessions-stay-in-progress).
      this.store.updateRun(runId, { status: 'waiting', activity: undefined, currentStepId: undefined });
    } else {
      await this.settleSuccess(runId);
    }
    // Cancelled / stopped / failed: no apply-back (W7), but no leak either (spec 2026-08-20, X3).
    await this.discardWorkspaceRun(runId);
    this.clearIdleTimer(state);
    this.dropActive(runId);
  }


  // ---- the human approval gate (spec 2026-08-20-split-steps-spec-review-and-approval-gate, P3) --

  /**
   * Park the run until `approvals.minApprovers` DISTINCT humans approve the step that just ran,
   * or one of them asks for changes.
   *
   * **At the shipped default (`minApprovers: 0`) this returns `approved` without parking, without
   * persisting anything and without emitting an event** — the zero-config chain takes exactly the
   * path it took before the gate existed. That is the whole reason the flag is safe to put on a
   * step of the DEFAULT workflow.
   *
   * The park itself is modelled on `acquireRepoRoot`: join `waiting`, give the `maxParallel` slot
   * back (the #347 rule — an idle run must not hold a slot), await, and restore on the way out.
   * Two differences, both deliberate:
   *  - the state is PERSISTED (`pendingApproval`) as well as held in memory, because a cezar
   *    restart must not silently un-gate the step — see `pendingApprovalSchema`'s doc comment for
   *    the run that taught us this;
   *  - `status` becomes `waiting`, the existing "ball is in your court" state, rather than a new
   *    `RunStatus` member. `RunStatus` is a published union and is never widened.
   *
   * Every exit is enumerated (AGENTS.md § "Enumerate the transitions out of every state you add"):
   * approve, request-changes, cancel, the optional `timeoutHours` auto-approval, and a process
   * restart — which does NOT resolve this promise at all (the process is gone); recovery re-parks
   * from the persisted record instead.
   */
  private async awaitApproval(
    runId: string,
    state: ActiveRun,
    step: WorkflowStepDef,
    emit: (event: { type: string; stepId?: string; [k: string]: unknown }) => void,
    config: CezConfig,
  ): Promise<ApprovalOutcome> {
    const required = minApprovers(config);
    if (required <= 0) return { kind: 'approved' };
    if (state.cancelled) return { kind: 'cancelled' };

    const run = this.store.getRun(runId);
    // Re-parking after a restart keeps the approvals already collected — they were given against
    // this same step and this same snapshot, and discarding them would ask the same people again.
    const existing = run?.pendingApproval?.stepId === step.id ? run.pendingApproval : undefined;
    const timeoutHours = config.approvals?.timeoutHours ?? 0;
    const pending: PendingApproval = existing ?? {
      stepId: step.id,
      requestedAt: new Date().toISOString(),
      minApprovers: required,
      approvals: [],
      ...(run?.declaredSpecPath ? { specPath: run.declaredSpecPath } : {}),
      ...(timeoutHours > 0
        ? { expiresAt: new Date(Date.now() + timeoutHours * 3_600_000).toISOString() }
        : {}),
    };

    // Already satisfied before we even park — an approval that arrived while the step was still
    // running, or a re-park after a restart where the gate was met in between.
    if (approvalsSatisfied(pending.approvals, pending.minApprovers)) {
      this.store.updateRun(runId, { pendingApproval: undefined });
      return { kind: 'approved' };
    }

    this.store.updateRun(runId, { pendingApproval: pending, status: 'waiting', activity: undefined });
    this.store.updateStep(runId, step.id, { status: 'waiting' });
    emit({
      type: 'lifecycle',
      stepId: step.id,
      message: `waiting for approval — ${pending.approvals.length}/${pending.minApprovers} approver(s) so far`,
    });

    /** Restores the pre-park `interrupt`; assigned inside the promise, called on the way out. */
    let restore: () => void = () => undefined;
    const outcome = await new Promise<ApprovalOutcome>((resolve) => {
      let settled = false;
      const once = (value: ApprovalOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      state.approvalWaiter = once;
      // `cancel()` calls `state.interrupt()`; chain onto it so a cancelled run does not sit here
      // forever. Restored in the `finally` below, exactly as `acquireRepoRoot` does.
      const parkedInterrupt = state.interrupt;
      state.interrupt = () => {
        parkedInterrupt();
        once({ kind: 'cancelled' });
      };
      const timer = pending.expiresAt
        ? setTimeout(
            () => {
              emit({
                type: 'note',
                stepId: step.id,
                message: `approval timed out after ${timeoutHours}h — auto-approving, as this repo's \`approvals.timeoutHours\` asks`,
              });
              once({ kind: 'approved' });
            },
            Math.max(0, Date.parse(pending.expiresAt) - Date.now()),
          )
        : undefined;
      timer?.unref?.();
      restore = () => {
        state.interrupt = parkedInterrupt;
      };
      this.waiting.add(runId);
      this.releaseSlot();
    });

    restore();
    state.approvalWaiter = undefined;
    this.waiting.delete(runId);
    this.store.updateRun(runId, { pendingApproval: undefined });
    if (outcome.kind !== 'cancelled') {
      this.store.updateRun(runId, { status: 'running' });
      this.store.updateStep(runId, step.id, { status: 'running' });
    }
    return outcome;
  }

  /**
   * Record one approval for a run parked on its gate. Returns the updated pending state so the
   * caller can report "2 of 3" without a second read.
   *
   * Idempotent per approver: a second click from the same identity does not count twice — see
   * `approvalsSatisfied` on why this counts DISTINCT approvers rather than clicks. It does
   * refresh that approver's note and timestamp, which is a correction, not a new vote.
   */
  async approveRun(
    runId: string,
    by: string,
    note?: string,
  ): Promise<{ ok: boolean; error?: string; pending?: PendingApproval }> {
    const run = this.store.getRun(runId);
    if (!run) return { ok: false, error: 'not found' };
    const pending = run.pendingApproval;
    if (!pending) return { ok: false, error: 'this run is not waiting for an approval' };

    const at = new Date().toISOString();
    const approvals = [
      ...pending.approvals.filter((a) => a.by !== by),
      { by, at, ...(note ? { note } : {}) },
    ];
    const updated: PendingApproval = { ...pending, approvals };
    this.store.updateRun(runId, { pendingApproval: updated });
    this.store.appendEvent(runId, {
      type: 'note',
      stepId: pending.stepId,
      message: `approved by ${by} (${approvals.length}/${pending.minApprovers})`,
    });

    if (!approvalsSatisfied(approvals, pending.minApprovers)) return { ok: true, pending: updated };

    this.store.appendEvent(runId, {
      type: 'lifecycle',
      stepId: pending.stepId,
      message: `approval gate released — ${pending.minApprovers} approver(s) satisfied`,
    });
    const released = await this.releaseApproval(runId, { kind: 'approved' }, pending);
    return { ...released, pending: updated };
  }

  /** A reviewer wants the spec changed. Sends the chain back to the step's `onFail.retry`. */
  async requestChanges(runId: string, by: string, notes: string): Promise<{ ok: boolean; error?: string }> {
    const run = this.store.getRun(runId);
    if (!run) return { ok: false, error: 'not found' };
    const pending = run.pendingApproval;
    if (!pending) return { ok: false, error: 'this run is not waiting for an approval' };
    this.store.appendEvent(runId, {
      type: 'note',
      stepId: pending.stepId,
      message: `changes requested by ${by}`,
    });
    return this.releaseApproval(runId, { kind: 'changes', notes: `${notes}\n\n— requested by ${by}` }, pending);
  }

  /**
   * Hand the outcome to whoever is waiting on it — and when NOBODY is (a restart killed the
   * `execute()` that was parked), re-enter the chain from the persisted record instead.
   *
   * That second branch is the one that makes this gate survive a restart rather than merely
   * record one. `execute()`'s promise cannot be resolved across a process boundary, so the
   * durable state has to be enough on its own: for an approval the gated step is marked `done`
   * and re-entry lands on the NEXT step; for a change request the gated step and everything back
   * to its retry target go `pending`, and the notes ride along as `feedback`.
   */
  private async releaseApproval(
    runId: string,
    outcome: ApprovalOutcome,
    pending: PendingApproval,
  ): Promise<{ ok: boolean; error?: string }> {
    const state = this.active.get(runId);
    if (state?.approvalWaiter) {
      state.approvalWaiter(outcome);
      return { ok: true };
    }
    // No live waiter: settle the record so a chain re-entry resumes in the right place.
    this.store.updateRun(runId, { pendingApproval: undefined });
    const run = this.store.getRun(runId);
    if (!run) return { ok: false, error: 'not found' };
    if (outcome.kind === 'approved') {
      this.store.updateStep(runId, pending.stepId, { status: 'done', finishedAt: new Date().toISOString() });
    }
    let changesFeedback: string | undefined;
    if (outcome.kind === 'changes') {
      const def = await this.reviveWorkflow(run);
      const target = def?.steps.find((s) => s.id === pending.stepId);
      changesFeedback =
        target?.onFail?.retry === 'spec'
          ? specRevisionFeedback(outcome.notes, pending.specPath)
          : `A reviewer requested changes to "${target?.onFail?.retry ?? pending.stepId}":\n\n${outcome.notes}`;
    }
    await this.reenterChain(
      this.store.getRun(runId) ?? run,
      outcome.kind === 'approved' ? 'approved' : 'changes requested',
      outcome.kind === 'changes' ? { feedback: changesFeedback, resetTo: pending.stepId } : {},
    );
    return { ok: true };
  }

  /** Returns an error message, or null on success. */
  private async runAgentStep(
    runId: string,
    state: ActiveRun,
    step: WorkflowStepDef,
    input: ExecuteRunInput,
    skills: Skill[],
    checkFailure: string | null,
    interactive: boolean,
    emit: (event: { type: string; stepId?: string; [k: string]: unknown }) => void,
    images: ContentBlock[] | undefined,
    taskBackend: RunnerId,
    extraSystemPrompt: string | undefined,
    /** The chain-boundary note for this step (#410), or undefined when the
     *  workflow has a single agent step and there is no boundary to explain. */
    chainNote: string | undefined,
    /** Pasted attachments already materialized to disk (#357) — their absolute
     *  paths are appended to `userPrompt` so the agent can operate on the
     *  real files, not just view the inline image blocks. */
    attachments: PersistedAttachment[] = [],
    /** Chain re-entry (spec 2026-08-20, P1): reattach the session this step was already running
     *  when the process died, and open it with the restart prompt instead of the step's own
     *  template — the session already holds everything the template would have said. Also the
     *  vehicle for a stop-retry's own resume handle (`execute()`'s `stopResume`), which is why
     *  `verifyTranscript` (spec 2026-08-22-resume-fresh-session-fallback) is a separate flag
     *  rather than "resumeFrom is set" — see `ChainResumePoint.resume`. */
    resumeFrom?: { sessionId: string; profileId?: string; prompt: string; verifyTranscript?: true },
    /** How many times this step's post-condition has already sent it back — 0 on the first
     *  attempt. Drives the codex escalation ladder
     *  (`.ai/specs/2026-08-24-codex-step-model-and-effort.md`, D4).
     *
     *  An object rather than a bare `number` deliberately: this parameter list is fifteen long and
     *  ends in two optionals, and a lone trailing number is the shape that swaps with a neighbour
     *  and still typechecks. */
    escalation: { priorFailures: number } = { priorFailures: 0 },
  ): Promise<string | null> {
    let systemPrompt: string | undefined;
    if (step.skill) {
      const skill = skills.find((s) => s.name === step.skill);
      if (skill) {
        // The body alone often does not identify the selected skill. Keep its
        // name and catalog description in the normalized runner payload so a
        // numeric task such as "432" still gives the model enough context to
        // describe the work — and therefore derive a useful title (#432).
        systemPrompt = skillSystemPrompt(skill);
        // Directory team skills (SKILL.md + references/) get materialized
        // into <cwd>/.claude/skills/<name>/ — the run's worktree when there
        // is one — so claude sees the companion files on disk; the shared
        // info/exclude keeps them out of git (and out of autosave commits).
        if (skill.source === 'team' && skill.team?.dir) {
          const seeded = await materializeSkillDir(state.cwd, skill).catch(() => false);
          if (seeded) {
            emit({
              type: 'note',
              stepId: step.id,
              message: `team skill "${skill.name}" materialized to .claude/skills/${skill.name}/`,
            });
          }
        }
      } else {
        emit({
          type: 'note',
          stepId: step.id,
          message: `skill "${step.skill}" not found in .ai/cezar/skills, .ai/skills or the team skills repo — running with the plain prompt`,
        });
      }
    }

    let userPrompt = resumeFrom?.prompt ?? applyTemplate(step.prompt ?? '{{task}}', input.task);
    if (chainNote) userPrompt = `${chainNote}\n\n---\n\n${userPrompt}`;
    if (checkFailure) {
      userPrompt += `\n\nFeedback on the previous attempt — read it and act on it:\n\n${checkFailure}`;
    }
    if (images?.length) {
      emit({
        type: 'note',
        stepId: step.id,
        message: `${images.length} screenshot${images.length > 1 ? 's' : ''} attached to the task`,
      });
      // Point the agent at the on-disk files for the pasted subset (#357) — the
      // base64 blocks above still let it *view* the images; this is what lets it
      // *use* them as files (save, attach to an issue/PR, copy into the repo).
      if (attachments.length) userPrompt += `\n\n${pastedAttachmentsText(attachments)}`;
    }

    // A resumed step keeps the session id it already owns — that id IS the work done so far.
    const sessionId = resumeFrom?.sessionId ?? randomUUID();
    // Never blocked (`.ai/specs/2026-08-23-never-block-a-task.md`). A step may pin its own runner,
    // and `spec-to-deploy` pins `runner: claude` + `opus` on `spec`/`review-spec` from the owner's
    // 2026-08-22 "writing spec + spec review should be by opus always". When EVERY account of that
    // provider is out of quota, that pin has nowhere to go and the step used to die there.
    //
    // The owner's 2026-08-23 ruling is that availability outranks the pin: proceed on whatever is
    // available and say so. So the quality pin is now a preference with a fallback, not a
    // guarantee — a real reduction in what the workflow promises, mitigated by announcement rather
    // than prevention, which is why the note below is asserted by a test rather than decorative.
    const pinned = step.runner ?? undefined;
    const backend = (pinned ? await this.downgradePinnedRunner(runId, step, pinned) : undefined) ?? step.runner ?? taskBackend;
    this.store.updateStep(runId, step.id, { sessionId, backend });

    // Loaded once, closed over by `onEvent` below — the step budget (PLAN D27 Phase 1) is
    // checked on every turn-end, not only at `execute()`'s loop-top.
    const config = await loadConfig(this.repoRoot);
    const stepRecord = this.store.getRun(runId)?.steps.find((s) => s.id === step.id);
    const startTokens = stepRecord?.tokensUsed ?? 0;
    let stepCost = stepRecord?.costUsd ?? 0;
    let turnText = '';
    let sessionError: string | undefined;
    const sink = this.makeUiSink(runId, step.id);
    const onEvent = (event: AgentEvent) => {
      if (event.type === 'image') {
        const saved = this.persistImage(runId, event.mediaType, event.data);
        // Explicit `name`/`url` projection, not `...saved` — see the twin site above for why
        // (`PersistedAttachment.path` is an absolute local path a relay must never carry).
        if (saved) emit({ type: 'image', stepId: step.id, name: saved.name, url: saved.url });
        return;
      }
      if (event.type === 'text') {
        turnText = appendTurnText(turnText, event.text);
        const text = stripAskMarker(stripTaskMarkers(stripMonitoringMarker(stripDoneMarker(event.text))));
        if (text) emit({ type: 'text', text, stepId: step.id });
        return;
      }
      emit({ ...event, stepId: step.id });
      if (event.type === 'error') {
        sessionError ??= event.message;
        // A stop CEZAR initiated carries `reason`; a genuine agent/CLI error does not. Keeping
        // the two apart is the whole point: the record used to say `failed` for both, so on run
        // 9d09795a the owner had to hand-annotate the handoff to explain that a step whose code
        // was written, gates green and commit made had not actually failed.
        if (event.reason) state.stepStopped ??= event.reason;
        state.session?.interrupt();
        return;
      }
      if (sessionError) return;
      if (event.type === 'session') {
        // Codex/OpenCode mint their own session id — persist it so resume works.
        this.store.updateStep(runId, step.id, { sessionId: event.sessionId, backend });
      }
      if (event.type === 'token-usage') {
        this.store.updateStep(runId, step.id, { tokensUsed: startTokens + event.tokensUsed });
      }
      if (event.type === 'cost') {
        stepCost += event.usd;
        this.store.updateStep(runId, step.id, { costUsd: stepCost });
      }
      if (event.type === 'turn-end') {
        // v2 `turn.completed` already flushed the coalescers; the v1 turn
        // boundary flushes again (idempotent) as a backstop.
        sink.flushAll();
        void this.recordTurnEnd(runId, turnText); // titleSummary + diffStat (#389)
        const sessionOpen = !state.cancelled && state.session?.open;
        // The spec reviewer's verdict (spec 2026-08-20-split-steps-spec-review-and-approval-gate,
        // P2). Read on EVERY turn of the step and overwritten, so the LAST turn's verdict is the
        // one the step loop acts on — a reviewer that thinks again in a follow-up turn is not held
        // to what it said first. Unlike `done`, this is NOT gated on `interactive`: `review-spec`
        // is a mid-chain step, which is exactly the position where `interactive` is false, and
        // gating it there would make the verdict unreadable in the only step that emits one.
        const declaredVerdict = parseReviewVerdict(turnText);
        if (declaredVerdict) {
          state.reviewVerdict = declaredVerdict;
          // The report IS the instruction set handed to the retried step, so it is kept whole
          // (capped like any other fed-back output) rather than reduced to the verdict word.
          state.reviewReport = turnText.trimEnd().slice(-CHECK_OUTPUT_CAP);
        }
        const done = interactive && sessionOpen && DONE_MARKER_RE.test(turnText.trimEnd());
        // `CEZ:ASK` → the user is blocked; wins over `CEZ:MONITORING`, loses to
        // `CEZ:DONE` (#473).
        const askResult = interactive && sessionOpen && !done ? parseAskMarkerResult(turnText) : undefined;
        const ask = askResult?.kind === 'valid' ? askResult.request : null;
        const askRejection = askResult ? askMarkerRejection(askResult) : undefined;
        const monitoring =
          interactive &&
          sessionOpen &&
          !done &&
          !ask &&
          MONITORING_MARKER_RE.test(turnText.trimEnd());
        // A plain end — none of the three markers fired (spec
        // 2026-08-23-plain-end-structured-question). Classified HERE, before `turnText` resets
        // below: the park block downstream sees only the empty string.
        const trailingQuestion = !done && !ask && !monitoring ? detectTrailingQuestion(turnText) : null;
        turnText = '';
        // The step budget (PLAN D27 Phase 1): this turn just happened, so it is spent
        // unconditionally — including the `done` turn, harmlessly, since nothing spends after it.
        this.spendBudgetUnit(runId);
        if (askRejection) emit({ type: 'note', stepId: step.id, message: askRejection });
        if (done) {
          // Goal achieved (agent contract, #347): close the session instead
          // of parking at `waiting` — the run completes and frees its slot.
          emit({ type: 'lifecycle', message: 'goal achieved — session closed' });
          appendHandoffHeartbeat(this.dataDir, runId, 'turn complete — goal achieved, session closed');
          state.session?.end();
          return;
        }
        const waiting = interactive && sessionOpen;
        const budgetJustExceeded = waiting && this.budgetSpent(runId, config);
        // Did a plain end spend a bounded nudge instead of parking (P4)? Only meaningful when
        // `waiting` is true; stays false on every marked ending and every non-interactive step.
        let nudged = false;
        if (budgetJustExceeded) {
          // The bound (PLAN D27 Phase 1): an open session would otherwise park (`waiting` /
          // `monitoring`) for another turn — stop it here instead of granting one. `state`
          // carries the signal back to `execute()`, which cannot see this turn-end directly
          // while its `await this.runAgentStep(...)` for this very step is still in flight.
          state.budgetExceeded = true;
          state.session?.end();
          this.clearIdleTimer(state);
          this.clearMonitoringWakeTimer(state, runId);
          this.monitoring.delete(runId);
          this.waiting.delete(runId);
          this.releaseSlot();
        } else if (waiting) {
          // Turn over, session open. The ball is in the user's court — with a structured
          // `CEZ:ASK` question the cockpit renders as an ask card (#473), with the agent's own
          // `CEZ:MONITORING` declaration that it is still working on its own downstream work
          // (parks as `running`/`activity:'monitoring'`, a non-attention state, instead of raising
          // "needs you", #490), or with a plain end, in which case `parkPlainEnd` classifies it
          // (spec 2026-08-23-plain-end-structured-question) and may spend a bounded nudge instead
          // of parking at all.
          if (monitoring) {
            this.store.updateRun(runId, {
              status: 'running',
              activity: 'monitoring',
              waitingReason: undefined,
              waitingQuestion: undefined,
            });
            this.store.updateStep(runId, step.id, { status: 'running' });
            this.monitoring.add(runId);
            this.clearIdleTimer(state);
            this.armMonitoringWakeTimer(runId, state);
            this.waiting.add(runId);
            this.releaseSlot();
          } else if (ask) {
            emitAskRequested(sink, ask);
            this.store.updateRun(runId, {
              status: 'waiting',
              activity: undefined,
              waitingReason: undefined,
              waitingQuestion: undefined,
            });
            this.store.updateStep(runId, step.id, { status: 'waiting' });
            this.monitoring.delete(runId);
            this.clearMonitoringWakeTimer(state, runId);
            this.waiting.add(runId);
            this.armIdleTimer(runId, state);
            this.releaseSlot(); // the freed slot can start a queued run right away — in any project
          } else {
            nudged = this.parkPlainEnd(runId, step.id, trailingQuestion, state);
            if (!nudged) {
              this.store.updateStep(runId, step.id, { status: 'waiting' });
              this.monitoring.delete(runId);
              this.clearMonitoringWakeTimer(state, runId);
              this.waiting.add(runId);
              this.armIdleTimer(runId, state);
              this.releaseSlot();
            }
          }
        }
        // The window is proven open — see the twin in `runContinuation`.
        if (this.store.getRun(runId)?.autoResumeAttempts !== undefined) {
          this.store.updateRun(runId, { autoResumeAttempts: undefined });
        }
        // Cez's own heartbeat — the handoff stays current even when the
        // agent forgets to write (spec 007). A nudge turn is still `running`, not `waiting` — see
        // P4 step 3.
        appendHandoffHeartbeat(
          this.dataDir,
          runId,
          `turn complete — status=${monitoring ? 'monitoring' : nudged ? 'running' : waiting ? 'waiting' : 'running'}`,
        );
      }
    };

    // The SAME value stamped on the record ~140 lines up, not a second evaluation of
    // `step.runner ?? taskBackend`. It read that way until 2026-08-23, when
    // `downgradePinnedRunner` made the two expressions able to disagree: the record said codex
    // while `createRunner(stepBackend)` below still spawned claude, so the downgrade recorded a
    // lie instead of changing anything. Caught because the test asserted the RECORD — which is
    // the half a record-only bug agrees with. Everything downstream reads this one binding:
    // `modelForBackend`, `normalizeModelForBackend`, `agentEnvForStep`, `createRunner`,
    // `brokerFor`, and the claude-only transcript verification.
    const stepBackend = backend;
    // Normalise the selected model to canonical `provider/model` and back to the
    // backend's own wire form via the ONE shared mapper (#405). Fail-loud: an
    // unresolvable model (e.g. a bare id on opencode) returns the step error
    // instead of letting the backend silently substitute its default.
    let backendModel: string | undefined;
    // Resolved ONCE, for the backend that will actually run this step, and both halves from the
    // same source (`.ai/specs/2026-08-24-codex-step-model-and-effort.md`, D1). Before this, the
    // model came from `step.model ?? input.model` and the effort from `step.effort` at the spawn
    // site 180 lines below — two independent reads that a per-runner override would have pulled
    // apart, applying codex's model with Claude's ceiling.
    // Resolved TWICE, deliberately, and the first call is the hole detector. `unpinned` asks
    // "did any layer name anything?" using the very function that would fill the hole, rather than
    // re-deriving that question from `step.byRunner` / `step.model` / `input.model` here — two
    // expressions for one question is how they drift, and this one has to agree with
    // `resolveStepModel`'s own precedence by construction. Both calls are pure.
    const unpinned = resolveStepModel(step, stepBackend, input.model, escalation.priorFailures);
    // `agentModelsLocked` is part of the gate, not just of the mapping below: under a lock
    // `stepRawModel` is forced to `undefined`, so a classification would be paid for and then
    // discarded. The one property this must not have is spending the owner's quota to compute a
    // value nothing reads.
    //
    // Keyed on the runner having a TABLE, not on a runner name. `opencode` and `pi` have none —
    // their models are discovered from the host — so they classify nothing and keep the behaviour
    // they had before this existed, without a second list here to fall out of step with the first.
    const classTable = CLASS_CHOICE_BY_RUNNER[stepBackend];
    const autoChoice =
      classTable &&
      unpinned.model === undefined &&
      unpinned.effort === undefined &&
      !agentModelsLocked(this.repoRoot)
        ? await this.autoTaskChoice(runId, step.id, input.task, classTable, emit)
        : undefined;
    const stepChoice = autoChoice
      ? resolveStepModel(step, stepBackend, input.model, escalation.priorFailures, autoChoice)
      : unpinned;
    // Hoisted rather than inlined into the call below, because it is now read TWICE — once by the
    // mapper and once by the record. Two copies of the same expression is exactly how the thing
    // that ran and the thing the record claims ran drift apart.
    // `modelForBackend` is applied HERE, before the hoist, so the dropped-pin case cannot make the
    // record lie. `stepRawModel` is persisted onto the step as what ran (spec
    // 2026-08-22-per-step-model-display); if a `sonnet` pin is dropped for a codex step and the
    // drop happened only on the way to the runner, the step rail would keep displaying `sonnet`
    // for a step that ran on codex's default. Same reason the hoist exists at all.
    const stepRawModel = agentModelsLocked(this.repoRoot)
      ? undefined
      : this.modelForBackend(runId, step.id, stepBackend, stepChoice.model);
    try {
      const normalized = normalizeModelForBackend(stepBackend, stepRawModel, {
        configuredProvider: await configuredModelProvider(stepBackend, state.cwd),
      });
      backendModel = normalized?.backendModel;
      const stepModelIdentity = normalized ? formatModelIdentity(normalized.identity) : undefined;
      // Persist the identity of what ACTUALLY runs (#405, review M1). The run-start echo
      // (line ~993) is best-effort from `taskBackend`/`input.model`; a per-step `runner`/`model`
      // override makes it assert a model that never ran. Re-write it here, from the resolved
      // step identity, so the record — the product of this PR — is always one that ran.
      this.store.updateRun(runId, {
        modelIdentity: stepModelIdentity,
      });
      // ...and on the STEP, where the next step's resolution cannot overwrite it (spec
      // 2026-08-22-per-step-model-display). The run-level field above is a single slot rewritten
      // by every step, so a `spec-to-deploy` chain that runs `review-spec` on opus and its other
      // seven steps on sonnet finishes asserting only sonnet, with every earlier step's real model
      // discarded. The step rail reads this pair instead. Written beside `sessionId`/`backend`, the
      // per-step execution facts that already live here, and at the same moment: before the spawn,
      // so a running step already says what it is running on.
      this.store.updateStep(runId, step.id, { model: stepRawModel, modelIdentity: stepModelIdentity });
      // The same fact for `cez run`'s stdout and the web transcript, through the generic `note`
      // channel both already render — no new event type and no handler change on either side. The
      // CLI's `── step:` header is printed before this point in the control flow (the model is not
      // resolved yet there), which is why the headless surface had no model line at all.
      emit({
        type: 'note',
        stepId: step.id,
        message: `model: ${stepModelIdentity ?? stepRawModel ?? 'auto'}`,
      });
    } catch (err) {
      if (err instanceof ModelIdentityError) return err.message;
      throw err;
    }
    // Which agent account this step spawns under, and — recorded on the step before the spawn —
    // which one its session belongs to. `sessionId` and `profileId` are a pair: a resume that
    // reads the wrong account's config dir finds no session and silently starts a fresh one.
    // Resolved together with the temp-directory preflight (#785): the step fails with a named,
    // actionable error instead of spawning a backend whose shell would return empty output.
    let stepProfile: {
      env: Record<string, string>;
      profileId: string;
      knowledgeSummary: KnowledgePromptSummary | undefined;
    };
    try {
      stepProfile = await this.agentEnvForStep(runId, stepBackend, {
        generateFollowups: followupsEnabled() && input.generateFollowups !== false,
        // A resume reattaches to a session that lives inside ONE account's config dir, so it must
        // run under the account that created it — not whatever the project has been switched to
        // since. Same rule `runContinuation` applies to a resumed continuation.
        ...(resumeFrom?.profileId ? { recordedProfileId: resumeFrom.profileId } : {}),
        // The session this step is about to run under, minted (or resumed) just above — see the
        // option's own doc comment for why `stepId` is the authoritative half of the pair.
        stepId: step.id,
        sessionId,
      });
    } catch (err) {
      if (err instanceof AgentTempDirError) return err.message;
      throw err;
    }
    this.store.updateStep(runId, step.id, { profileId: stepProfile.profileId });

    // From the RECORD, not the registry, and not from `input` — see `workspaceGrantOf`. Reading
    // `input.workspaceProjects` here would work on the first step and be wrong after a restart,
    // where the run is revived from `runs.json` and `input` is rebuilt.
    const stepGrant = workspaceGrantOf(this.store.getRun(runId));
    const runner = createRunner(stepBackend);
    let session: AgentSession;
    state.currentStepId = step.id;
    this.beginUsageInvocation(runId, state, step.id);
    // P4: this step either re-attaches to a broker that never stopped, or starts one, or takes the
    // in-process path — decided here and nowhere else, so every layer above sees one `AgentSession`.
    const reattach = this.takeReattach(runId, step.id);
    const brokerRequest = reattach
      ? {
          spoolDir: reattach.spoolDir,
          runId,
          stepId: step.id,
          startOffset: reattach.startOffset,
          isolation: this.brokerIsolation(),
          // A re-attach spawns nothing, so these bounds are never APPLIED here — the surviving
          // scope already carries whatever it was created with. They are passed for attribution
          // only, and they are read from the config as it is NOW: nothing records what a scope was
          // created with, and the run this path exists for survived a self-deploy that happens
          // ~10x a day on the box. So the trade is stated rather than hidden — a bound changed
          // between the spawn and the kill makes the reported detail name the current value. The
          // alternative, attributing nothing across every deploy, would silently drop C3's
          // reporting for a large share of real runs, and `detectResourceKill` is documented as a
          // detection rather than a proof for exactly this class of reason.
          resources: await this.runResourceLimits(),
          onResourceKill: (kill: ResourceKillReport) => this.recordResourceKill(runId, step.id, kill),
          onOffset: (offset: number) => this.persistConsumedOffset(runId, offset),
        }
      : await this.brokerFor(runId, step.id, stepBackend);

    // Proactive Claude-only check (spec 2026-08-22-resume-fresh-session-fallback, Phase 1): a
    // resume target is a HINT cezar minted and persisted before any confirmation the backend
    // ever created the conversation — verify a transcript actually exists before handing it to
    // `--resume`, so a session that died before writing one (run 232ad6d4's `commit-push`
    // iteration 1) never reaches the CLI at all. Skipped for a P4 broker reattach: that path
    // never spawns a new `claude` process or sends `--resume`, so there is nothing to verify.
    // Gated on `resumeFrom.verifyTranscript`, NOT merely `resumeFrom !== undefined` — this same
    // parameter also carries a cezar-initiated stop's own retry handle (`stopResume`, a session
    // this very process observed running seconds ago), which `verifyTranscript` deliberately
    // leaves unset. Without the gate this check would downgrade a stop-retry whenever the box's
    // `~/.claude/projects` (or a test's unrelated `CLAUDE_CONFIG_DIR`) doesn't carry that
    // session's transcript yet, discarding the in-progress work the stop-retry exists to
    // preserve and turning one stop into two (the second being terminal).
    let resumeDowngraded = false;
    if (stepBackend === 'claude' && resumeFrom?.verifyTranscript === true && !reattach) {
      const claudeHome = agentHomePaths({ ...process.env, ...stepProfile.env }).claude;
      const exists = await claudeSessionTranscriptExists(claudeHome, state.cwd, resumeFrom.sessionId);
      if (!exists) {
        // The check fires AFTER `userPrompt` was frozen above (resumeFrom.prompt — the restart-
        // continuation prompt), which assumes the session already holds everything the step's own
        // template would have said. A downgrade falsifies that assumption by construction, so
        // `userPrompt` must be rebuilt from the step's own template — not just the session id —
        // or the fresh session runs contextless. Re-run exactly the three lines that built it the
        // first time, with `resumeFrom` treated as absent.
        userPrompt = applyTemplate(step.prompt ?? '{{task}}', input.task);
        if (chainNote) userPrompt = `${chainNote}\n\n---\n\n${userPrompt}`;
        if (checkFailure) {
          userPrompt += `\n\nFeedback on the previous attempt — read it and act on it:\n\n${checkFailure}`;
        }
        resumeDowngraded = true;
        emit({
          type: 'note',
          stepId: step.id,
          message: 'no transcript for the recorded session — starting fresh',
        });
      }
    }
    // A downgrade mints a NEW id rather than retrying the dead one — nothing to reattach to, and
    // Claude never emits a `session` event to correct the record later the way Codex/OpenCode do,
    // so the fresh id must be persisted here or the record keeps pointing at the dead one forever.
    const spawnSessionId = resumeDowngraded ? randomUUID() : sessionId;
    if (resumeDowngraded) this.store.updateStep(runId, step.id, { sessionId: spawnSessionId });

    try {
      const openSession = reattach && runner.reattachSession
        ? runner.reattachSession.bind(runner)
        : runner.startSession.bind(runner);
      session = openSession(
        {
          // Skill body, then the run's extra prompt (POST override or config
          // default), then the handoff/todos contract — every agent step.
          systemPrompt: composeSystemPrompt(
            systemPrompt,
            extraSystemPrompt,
            // After the skill and the user's own prompt, so neither is buried, and before the
            // handoff contract. Both can override it: a skill that needs a call-by-call trace
            // says so and wins, because it is the more specific instruction.
            TOOL_BUDGET_DOCTRINE,
            followupsEnabled() && input.generateFollowups !== false
              ? HANDOFF_INSTRUCTIONS
              : HANDOFF_ONLY_INSTRUCTIONS,
            // Before the knowledge block on purpose: this says where the work IS. The cwd of a
            // workspace run is a scratch repo that contains none of it, so an agent given only
            // `--add-dir` and no text has directories it can reach and no reason to look.
            workspaceGrantSystemPrompt(stepGrant),
            knowledgeSystemPrompt(stepProfile.knowledgeSummary),
          ),
          userPrompt,
          images,
          cwd: state.cwd,
          allowedTools: step.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
          bashAllowlist: step.bashAllowlist,
          // The handoff file lives outside the worktree — grant access, along with this run's
          // own TMPDIR (#785). The knowledge base's roots ride along too (spec
          // 2026-08-06-knowledge-base-mounts-search, "Agent read path and write back"): helps
          // Claude (`claude-cli-runner.ts` pushes `--add-dir` per entry), ignored by the
          // codex/opencode runners — the portable half is the absolute path already stated in
          // `knowledgeSystemPrompt`'s own text.
          additionalDirectories: [
            ...agentDirectories(join(this.dataDir, 'runs'), stepProfile.env),
            ...(stepProfile.knowledgeSummary?.roots.map((r) => r.path) ?? []),
            // A workspace run's granted project roots (spec 2026-08-15-cross-project-workspace-
            // run). Empty for every ordinary run, so nothing about them changes.
            ...(stepGrant?.roots ?? []),
          ],
          env: stepProfile.env,
          model: backendModel,
          // `stepChoice.effort`, not `step.effort`: a `byRunner` entry carries the pair, and
          // reading the step's own effort here would apply the other backend's ceiling.
          effort: stepChoice.effort,
          sessionId: spawnSessionId,
          resume: resumeDowngraded ? false : resumeFrom !== undefined,
          // Interactive sessions have no wall clock — the idle timer rules.
          timeoutMs: interactive ? 0 : undefined,
        },
        onEvent,
        {
          autoEndAfterFirstTurn: !interactive,
          onUiEvent: (event) => this.handleRunnerUiEvent(runId, state, sink, event),
          ...(brokerRequest ? { broker: brokerRequest } : {}),
        },
      );
    } catch (err) {
      state.currentStepId = undefined;
      return err instanceof Error ? err.message : String(err);
    }
    state.session = session;
    state.sessionEverOpened = true;
    this.flushDeferred(runId);
    state.currentStepId = step.id;
    state.interrupt = () => session.interrupt();
    if (session.pid !== undefined) registerRunProcess(runId, session.pid);

    try {
      const result = await session.result;
      if (sessionError) {
        sink.sessionEnded('error', sessionError);
        return sessionError;
      }
      // v2 counterpart of v1's `done` (spec: the mappers leave session-close
      // events to the RunManager — only it knows how the session settled).
      sink.sessionEnded(state.cancelled ? 'cancelled' : 'end_turn');
      this.store.updateStep(runId, step.id, { tokensUsed: startTokens + result.tokensUsed });
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isRetryableBrokerLaunch(err)) {
        state.brokerNeverAnswered = { spoolDir: err.spoolDir, message };
      }
      sink.sessionEnded('error', message); // alongside v1's fatal `error`
      return message;
    } finally {
      this.recordUsagePeaks(runId);
      this.clearIdleTimer(state);
      this.monitoring.delete(runId);
      this.waiting.delete(runId);
      this.clearMonitoringWakeTimer(state, runId);
      // The throttle above may be holding the last few hundred milliseconds of progress. A run
      // that ended has no next tick to write it, and an offset short of the truth would make a
      // re-attach replay records the run already handled.
      if (brokerRequest) this.persistConsumedOffset(runId, this.lastOffset(runId), true);
      this.offsetWrites.delete(runId);
      state.session = undefined;
      state.currentStepId = undefined;
      state.interrupt = () => undefined;
    }
  }

  /**
   * Protocol-v2 sink for one agent session (R2 step 2.1): the runner's
   * `onUiEvent` stream flows through here. Persisted snapshots ride the same
   * NDJSON file as v1 (the store stamps `seq`/`ts`, `appendEvent` fans them
   * out live too); coalesced `item.delta` flushes go out live-only via
   * `emitEphemeral` — raw deltas never hit disk (spec §performance
   * guardrails). One sink per session: cumulative usage dedup and the
   * item-shape cache are session-scoped, like the mapper state feeding them.
   */
  private makeUiSink(runId: string, stepId: string): UiEventSink {
    return new UiEventSink({
      persist: (event) => this.store.appendEvent(runId, { ...event, stepId }),
      emitLive: (event) => this.store.emitEphemeral(runId, { ...event, stepId }),
    });
  }

  /** Native backend asks arrive before turn-end. Persist and park immediately
   * so the cockpit shows attention and the run releases its workspace slot. */
  private handleRunnerUiEvent(runId: string, state: ActiveRun, sink: UiEventSink, event: UiEvent): void {
    this.recordUsageUiEvent(runId, state, event);
    sink.handle(event);
    if (event.type !== 'ask.requested' || state.cancelled) return;
    this.clearIdleTimer(state);
    this.monitoring.delete(runId);
    this.clearMonitoringWakeTimer(state, runId);
    this.waiting.add(runId);
    this.store.updateRun(runId, { status: 'waiting', activity: undefined });
    if (state.currentStepId) this.store.updateStep(runId, state.currentStepId, { status: 'waiting' });
    this.releaseSlot();
  }

  /** Persist the invocation checkpoint before launching a runner. A throw or
   * process exit before `turn.started` therefore leaves a durable mismatch. */
  private beginUsageInvocation(runId: string, state: ActiveRun, stepId: string): void {
    const step = this.store.getRun(runId)?.steps.find((candidate) => candidate.id === stepId);
    if (!step) return;
    const epoch = (step.usageInvocationEpoch ?? 0) + 1;
    this.persistUsageCheckpoint(runId, stepId, {
      usageInvocationEpoch: epoch,
      usageInvocationsStarted: (step.usageInvocationsStarted ?? 0) + 1,
    });
    state.usageInvocation = {
      stepId,
      epoch,
      observed: false,
      startedTurns: new Set(),
      recordedTurns: new Set(),
    };
  }

  /** Fold backend-neutral completed-turn usage into the current step exactly
   * once. Invocation/turn counters are written before the event reaches the
   * NDJSON sink so crashes cannot preserve a falsely complete subtotal. */
  private recordUsageUiEvent(runId: string, state: ActiveRun, event: UiEvent): void {
    const invocation = state.usageInvocation;
    if (!invocation) return;
    const step = this.store.getRun(runId)?.steps.find((candidate) => candidate.id === invocation.stepId);
    if (!step) return;

    if (event.type === 'turn.started') {
      if (invocation.startedTurns.has(event.turnId)) return;
      invocation.startedTurns.add(event.turnId);
      const firstObservedTurn = !invocation.observed;
      invocation.observed = true;
      this.persistUsageCheckpoint(runId, invocation.stepId, {
        usageTurnsStarted: (step.usageTurnsStarted ?? 0) + 1,
        ...(firstObservedTurn
          ? { usageInvocationsObserved: (step.usageInvocationsObserved ?? 0) + 1 }
          : {}),
      });
      return;
    }

    // A real backend-reported context-window max (today: codex's `thread/tokenUsage/updated`,
    // mapped to `usage.contextWindow`) — persist it immediately so the record is current
    // before the next tick, and cache it on the invocation so every later patch this
    // invocation makes keeps carrying the real number instead of reverting to a guess (spec
    // 2026-08-22-context-window-denominator-per-step).
    if (event.type === 'usage.updated') {
      if (Number.isFinite(event.usage.contextWindow) && (event.usage.contextWindow ?? 0) > 0) {
        invocation.reportedContextWindow = event.usage.contextWindow;
        this.persistUsageCheckpoint(runId, invocation.stepId, { contextWindow: event.usage.contextWindow });
      }
      return;
    }

    // Live occupancy (per round-trip): overwrite the step's `contextTokens` as each model call
    // reports its prompt size, so the Context column climbs DURING a long turn rather than
    // jumping only at `turn.completed`. Overwrite-only — never touches the turn's token totals,
    // which `turn.completed` still owns (spec 2026-08-19, live-refresh follow-up).
    if (event.type === 'context.updated') {
      if (Number.isFinite(event.contextTokens) && event.contextTokens >= 0) {
        this.persistUsageCheckpoint(runId, invocation.stepId, {
          contextTokens: event.contextTokens,
          ...(invocation.reportedContextWindow !== undefined
            ? { contextWindow: invocation.reportedContextWindow }
            : {}),
        });
      }
      return;
    }

    if (event.type !== 'turn.completed') return;
    if (!invocation.startedTurns.has(event.turnId) || invocation.recordedTurns.has(event.turnId)) return;
    const input = event.usage?.input;
    const output = event.usage?.output;
    if (
      typeof input !== 'number' ||
      !Number.isFinite(input) ||
      input < 0 ||
      typeof output !== 'number' ||
      !Number.isFinite(output) ||
      output < 0
    ) {
      return;
    }
    invocation.recordedTurns.add(event.turnId);
    // Context occupancy is the LATEST turn's window fill — overwritten, not accumulated like
    // the token totals above, so it tracks how full the window is right now (spec
    // 2026-08-19-context-usage-in-tasks-table). Prefer the mapper's point-in-time
    // `event.contextTokens`: the LAST single call's prompt. `event.usage` here is the turn's
    // CROSS-CALL SUM (the claude `result` frame adds every round-trip's prompt), so falling
    // back to `input + cacheRead + cacheWrite` of it overcounts a many-round-trip turn
    // manyfold — the `10M / 200k` bug (correction 2026-08-20). The fallback stays only for
    // backends (pi) whose turn `usage` is already the last call's, not a sum.
    const contextTokens =
      event.contextTokens ?? input + (event.usage?.cacheRead ?? 0) + (event.usage?.cacheWrite ?? 0);
    this.persistUsageCheckpoint(runId, invocation.stepId, {
      inputTokens: (step.inputTokens ?? 0) + input,
      outputTokens: (step.outputTokens ?? 0) + output,
      contextTokens,
      ...(invocation.reportedContextWindow !== undefined
        ? { contextWindow: invocation.reportedContextWindow }
        : {}),
      usageTurnsRecorded: (step.usageTurnsRecorded ?? 0) + 1,
    });
  }

  /** Usage completeness is a crash boundary, unlike high-frequency token
   * snapshots: the checkpoint must reach `runs.json` before the runner starts
   * or the matching UI event is persisted and forwarded. */
  private persistUsageCheckpoint(
    runId: string,
    stepId: string,
    patch: Partial<Omit<StepState, 'id'>>,
  ): void {
    this.store.updateStep(runId, stepId, patch);
    this.store.flush();
  }

  /**
   * Turn-end bookkeeping (#389), shared by `runAgentStep` and
   * `runContinuation` — called (fire-and-forget) from every `turn-end` event:
   *
   *  - `titleSummary`: derived from the turn's text, set ONCE — only while the
   *    record has none. A user's inline edit also lands in `titleSummary`
   *    (see `PATCH /api/runs/:id`), so an edit is never overwritten either.
   *  - `diffStat`: cheap `git diff --shortstat` vs the base, refreshed every
   *    turn. Async and best-effort — a git failure becomes at most a `note`
   *    event, NEVER a run failure. `updateRun` fans the record out over SSE,
   *    so the list views pick both up with no extra wiring.
   *
   * Not `private` so the integration tests can drive a turn-end directly —
   * a real agent session is the only other way to reach this path.
   */
  /**
   * The namer's apply path (task auto-naming spec). Fire-and-forget: called
   * without await from `startRun` (creation) and `recordTurnEnd` (live
   * refresh). A user-owned title (`titleOrigin: 'user'`) is never overwritten;
   * namer-owned titles may be replaced by fresher namer results.
   */
  private async autoNameRun(
    runId: string,
    skillName: string | undefined,
    task: string,
    live?: { turnText?: string; diffStat?: string },
  ): Promise<void> {
    // CEZ_AUTONAME=0 kills all LLM naming; dry-run skips it too unless
    // CEZ_AUTONAME=1 forces the mock path — see autoNamingActive.
    if (!autoNamingActive()) return;
    try {
      let skillDescription: string | undefined;
      if (skillName) {
        const skills = await discoverSkills(this.repoRoot).catch(() => [] as Skill[]);
        skillDescription = skills.find((s) => s.name === skillName)?.description;
      }
      const result = await generateRunName(this.repoRoot, { task, skillName, skillDescription, ...live });
      if (!result) return;
      const run = this.store.getRun(runId);
      // Marker-owned state outranks the namer (spec 2026-07-18-task-ref-markers):
      // a declared title blocks the whole apply (this call raced the marker),
      // and a declared pr/issue kind blocks that kind field-by-field.
      if (!run || run.titleOrigin === 'user' || run.titleOrigin === 'marker') return;
      this.store.updateRun(runId, {
        titleSummary: result.titleSummary,
        titleOrigin: 'auto',
        ...(result.prNumber !== undefined && run.markerRefs?.pr === undefined
          ? { prNumber: result.prNumber }
          : {}),
        ...(result.issueNumber !== undefined && run.markerRefs?.issue === undefined
          ? { issueNumber: result.issueNumber }
          : {}),
      });
    } catch {
      // Naming is best-effort — nothing here may disturb the run.
    }
  }

  async recordTurnEnd(runId: string, turnText: string): Promise<void> {
    try {
      const run = this.store.getRun(runId);
      if (!run) return;
      this.applyTurnMarkers(runId, run, turnText);
      // Titles are the namer's job (task auto-naming spec) — turn text is
      // deliberately NEVER a title source; see maybeRefreshTitle below. The
      // one exception is an explicit CEZ:TITLE declaration (applied above).
      if (run.worktreePath && existsSync(run.worktreePath)) {
        // `taskBranch` + `runStartedAt` are what keep this number *this task's* (#751): a
        // review/QA run repoints the worktree onto the branch under review, and without the
        // branch to compare HEAD against and the moment it was checked out, the stat would
        // claim that whole branch's diff.
        const stat = await worktreeShortstat(run.worktreePath, run.baseBranch ?? 'HEAD', {
          taskBranch: run.branch,
          runStartedAt: run.startedAt,
        });
        if (stat) this.store.updateRun(runId, { diffStat: stat });
        else this.store.appendEvent(runId, { type: 'note', message: 'diff stat unavailable — git diff --shortstat failed in the worktree' });
      }
      await this.maybeRefreshTitle(runId, turnText);
    } catch {
      // Bookkeeping only — nothing here may disturb the run.
    }
  }

  /**
   * In-band declarations from the finished turn (spec
   * 2026-07-18-task-ref-markers): the main thread's own `CEZ:PR=` /
   * `CEZ:ISSUE=` / `CEZ:TITLE=` lines, parsed from the accumulated turn text
   * like `CEZ:DONE` — never from tool output. Declared numbers overwrite the
   * regex/namer display tier (the store re-resolves the referenced-PR chip);
   * a declared title takes `titleOrigin: 'marker'`, which beats the namer but
   * never a user rename, and silences the live refresh below.
   *
   * `CEZ:SPEC_PATH=` (PLAN D27 Phase 3) is the same idiom, added for `note-to-spec`'s own closing
   * instruction ("declare it with a line `CEZ:SPEC_PATH=…`"): persisted verbatim to
   * `RunRecord.declaredSpecPath` for the notes continuation trigger to read once this run settles.
   */
  private applyTurnMarkers(runId: string, run: RunRecord, turnText: string): void {
    const markers = parseTaskMarkers(turnText);
    if (markers.pr !== undefined || markers.issue !== undefined) {
      this.store.applyMarkerRefs(runId, { pr: markers.pr, issue: markers.issue });
    }
    if (markers.title && run.titleOrigin !== 'user') {
      const current = this.store.getRun(runId);
      const refNumber = current?.prNumber ?? current?.issueNumber;
      const validated = postValidateTitle(markers.title, refNumber);
      // Same junk guard as composeNameResult: a declaration that validates to
      // nothing (or to a bare number prefix) must not blank the title.
      if (validated && validated !== `${refNumber}:`) {
        this.store.updateRun(runId, { titleSummary: validated, titleOrigin: 'marker' });
      }
      // Phase 3 (spec 2026-08-22-continue-step-naming): the same declaration also refines the
      // active continuation step's own name — but never a Phase 2 "<step> — continued" title,
      // which is what `nameOrigin !== 'step'` excludes. No `refNumber` here: a step name must not
      // carry the run title's PR-number prefix.
      if (run.currentStepId?.startsWith('continue-')) {
        const step = current?.steps.find((s) => s.id === run.currentStepId);
        if (step && step.nameOrigin !== 'step') {
          const validatedStepName = postValidateTitle(markers.title);
          if (validatedStepName) {
            this.store.updateStep(runId, run.currentStepId, {
              name: validatedStepName,
              nameOrigin: 'marker',
            });
          }
        }
      }
    }
    if (markers.specPath) {
      this.store.updateRun(runId, { declaredSpecPath: markers.specPath.slice(0, 500) });
    }
  }

  /**
   * Live title refresh (task auto-naming spec, step 3): re-run the namer with
   * the turn's context. Skips: toggle off (`liveTitleUpdates` config over
   * `CEZ_TITLE_UPDATES` env, default ON), user-owned title, marker-owned title
   * (the agent declares via `CEZ:TITLE` — the token-saving fast path), dry-run
   * mocks (canned answers add nothing), empty turn text, unchanged namer inputs.
   */
  private async maybeRefreshTitle(runId: string, turnText: string): Promise<void> {
    if (!autoNamingActive()) return;
    if (!turnText.trim()) return;
    const config = await loadConfig(this.repoRoot);
    if (!liveTitleUpdatesEnabled(config)) return;
    const run = this.store.getRun(runId);
    if (!run || run.titleOrigin === 'user' || run.titleOrigin === 'marker') return;
    const statText = run.diffStat ? `${run.diffStat.files} files, +${run.diffStat.adds} -${run.diffStat.dels}` : undefined;
    const key = `${turnText.slice(0, 200)}|${statText ?? ''}`;
    if (this.lastNamerKey.get(runId) === key) return;
    this.lastNamerKey.set(runId, key);
    const workflow = await this.reviveWorkflow(run);
    const skillName = workflow?.steps.find((s) => stepKind(s) === 'agent' && s.skill)?.skill?.trim();
    void this.autoNameRun(runId, skillName, run.task, { turnText, diffStat: statText });
  }

  /**
   * End-of-session telemetry (#348): stop sampling the run's process tree and
   * fold the session's peaks into the run record. `max` with existing values —
   * a run can hold several sessions (multiple agent steps, Continue) and the
   * record keeps the highest water mark across all of them.
   */
  private recordUsagePeaks(runId: string): void {
    const peaks = unregisterRunProcess(runId);
    if (!peaks) return;
    const run = this.store.getRun(runId);
    this.store.updateRun(runId, {
      peakRssBytes: Math.max(run?.peakRssBytes ?? 0, peaks.peakRssBytes),
      peakProcCount: Math.max(run?.peakProcCount ?? 0, peaks.peakProcCount),
    });
  }

  /**
   * The budget actually enforced for this run (PLAN D27 Phase 3): `RunRecord.stepBudgetOverride`
   * when the continuation trigger set one at start, else the repo-wide `config.stepBudget`. Kept
   * as its own method so every reader of "what is the ceiling" — `budgetSpent` and the two
   * lifecycle messages that report it — agrees, rather than each re-deriving the precedence.
   */
  private effectiveStepBudget(runId: string, config: CezConfig): number {
    return this.store.getRun(runId)?.stepBudgetOverride ?? config.stepBudget;
  }

  /**
   * Has this run already spent its step budget (PLAN D27 Phase 1)? `effectiveStepBudget() === 0`
   * means unlimited. Reads the PERSISTED counter (`RunRecord.stepsUsed`) rather than any in-memory
   * count: `execute()`'s loop-top check and the `turn-end` handlers in `runAgentStep` and
   * `runContinuation` are three separate call sites — sometimes across a process restart — with no
   * shared closure to hold a running total in.
   */
  private budgetSpent(runId: string, config: CezConfig): boolean {
    const budget = this.effectiveStepBudget(runId, config);
    return budget > 0 && (this.store.getRun(runId)?.stepsUsed ?? 0) >= budget;
  }

  /**
   * Record one more unit of budgeted work (PLAN D27 Phase 1) — a check-step attempt (fresh or an
   * `onFail` retry), or one agent turn (opening turn, follow-up, self-continuation nudge, or
   * monitoring wake-up). See `stepBudget`'s doc comment (`config.ts`) for why a turn is the unit,
   * not a workflow step.
   */
  private spendBudgetUnit(runId: string): void {
    const used = (this.store.getRun(runId)?.stepsUsed ?? 0) + 1;
    this.store.updateRun(runId, { stepsUsed: used });
  }

  /**
   * Diff-first review gate (spec 009), shared by `execute` and
   * `runContinuation`: a *successful* run whose worktree holds changes rests
   * at `review` instead of `done` — the user inspects the diff first, then
   * sends feedback back, opens a draft PR, or just finishes. Failed/cancelled
   * runs never enter review; no worktree or an empty diff means plain `done`.
   *
   * The gate is opt-in (#489): the review park happens only when it is enabled
   * (`reviewGateEnabled` — config toggle over the `CEZ_REVIEW_GATE` env, default
   * OFF) AND the run is not autonomous. Autonomous runs — and runs with the gate
   * off — settle straight to `done`, leaving the diff in the worktree untouched.
   */
  /**
   * Apply a parallel workspace run's per-project worktrees back to their real checkouts
   * (spec 2026-08-19, W4/W6). A clean apply lands the changes unstaged in the real tree and the
   * worktree is removed inside `applyWorkspaceWorktrees`; a conflict keeps the `cez/<id8>` branch as
   * the recovery point, and only those survive on the record. A no-op for every other run.
   */
  private async applyWorkspaceRun(runId: string): Promise<void> {
    const worktrees = this.store.getRun(runId)?.workspaceWorktrees;
    if (!worktrees || worktrees.length === 0) return;
    this.store.appendEvent(runId, {
      type: 'note',
      message: `applying ${worktrees.length} project worktree(s) back to their checkouts…`,
    });
    const reports = await applyWorkspaceWorktrees(worktrees);
    const kept: WorkspaceWorktree[] = [];
    for (const report of reports) {
      if (report.outcome === 'applied') {
        this.store.appendEvent(runId, { type: 'note', message: `applied changes to ${report.root}` });
      } else if (report.outcome === 'nothing') {
        this.store.appendEvent(runId, { type: 'note', message: `no changes in ${report.root}` });
      } else {
        const wt = worktrees.find((w) => w.root === report.root);
        if (wt) kept.push(wt);
        this.store.appendEvent(runId, {
          type: 'note',
          message: `${report.root}: ${report.outcome} on apply — kept worktree branch ${report.branch}${
            report.detail ? ` (${report.detail})` : ''
          }`,
        });
      }
    }
    // Keep only the worktrees that could not be applied (conflicts), so a re-run does not try to
    // re-apply what already landed; clear the field entirely once everything is in.
    this.store.updateRun(runId, { workspaceWorktrees: kept.length > 0 ? kept : undefined });
  }

  /**
   * The other half of `applyWorkspaceRun` (spec 2026-08-20-workspace-run-worktree-isolation, X3).
   *
   * Apply-back is success-only on purpose (spec 2026-08-19, W7) — landing a half-finished run in
   * twelve real checkouts is worse than not landing it. But CLEANUP was success-only too, purely
   * because `applyWorkspaceRun` was the single call site, so every `failed`/`cancelled`/stopped
   * workspace run left twelve full checkouts on disk forever. This discards the DIRECTORIES and
   * keeps the `cez/<id8>` BRANCHES: nothing becomes unrecoverable (a Continue re-materializes the
   * trees from those branches), and the gigabytes go.
   *
   * A no-op for every other run and for every other ending — including the review GATE, which is a
   * successful park whose diff the user is about to read. `review` WITH a `stopReason` is the
   * opposite: an agent we stopped, which is one of the endings this exists for.
   */
  private async discardWorkspaceRun(runId: string): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run) return;
    const stopped = run.status === 'review' && run.stopReason !== undefined;
    if (run.status !== 'failed' && run.status !== 'cancelled' && !stopped) return;
    const worktrees = run.workspaceWorktrees;
    if (!worktrees || worktrees.length === 0) return;
    const reports = await discardWorkspaceWorktrees(worktrees);
    const keptRoots = new Set(reports.filter((r) => r.outcome === 'kept').map((r) => r.root));
    const kept = worktrees.filter((wt) => keptRoots.has(wt.root));
    for (const report of reports) {
      if (report.outcome !== 'kept') continue;
      this.store.appendEvent(runId, {
        type: 'note',
        message: `${report.root}: worktree kept — ${report.detail ?? 'not discarded'}`,
      });
    }
    const discarded = reports.length - kept.length;
    if (discarded > 0) {
      this.store.appendEvent(runId, {
        type: 'note',
        message: `run did not succeed — discarded ${discarded} project worktree(s); the ${
          worktrees[0]?.branch ?? 'cez/*'
        } branches keep the work`,
      });
    }
    this.store.updateRun(runId, { workspaceWorktrees: kept.length > 0 ? kept : undefined });
  }

  private async settleSuccess(runId: string, opts: { pendingAsk?: boolean } = {}): Promise<void> {
    // Invariant I1 (spec 2026-08-20-chain-integrity-restart-and-continuation): only the CHAIN
    // finishes the run. `settleSuccess` has three callers and only `execute()`'s success path can
    // prove the chain ran off the end — the other two arrive from a session-level signal (a
    // restart settle, a continuation's `CEZ:DONE`) that says nothing about the remaining steps.
    // Fail closed BEFORE `applyWorkspaceRun`: applying twelve worktrees back and stamping
    // `finishedAt` is what made this unrecoverable rather than merely wrong. A stalled chain parks
    // at `waiting`, which is recoverable (P1/P2 re-entry, the next `recover()`, the queue
    // watchdog, or a user "Continue") — failing it would throw away a worktree full of real work.
    const settling = this.store.getRun(runId);
    const pending = settling ? pendingChainSteps(settling) : [];
    if (pending.length > 0) {
      // An unanswered `CEZ:ASK` outranks a stalled chain: the run is not merely incomplete, it is
      // blocked ON THE USER, and `review` is the attention-bearing park. Either way the worktrees
      // stay isolated and `finishedAt` stays unset — the run did NOT finish.
      const askPending = opts.pendingAsk === true;
      this.store.updateRun(runId, {
        status: askPending ? 'review' : 'waiting',
        currentStepId: undefined,
      });
      this.store.appendEvent(runId, {
        type: 'lifecycle',
        message: askPending
          ? `chain incomplete — ${pending.length} step(s) still pending, and your answer is still needed`
          : `chain incomplete — ${pending.length} step(s) still pending; the run was not finished`,
      });
      return;
    }
    this.chainReentries.delete(runId);
    await this.applyWorkspaceRun(runId);
    const run = this.store.getRun(runId);
    let review = false;
    if (run?.worktreePath && existsSync(run.worktreePath)) {
      const diff = await worktreeDiff(run.worktreePath, run.baseBranch ?? 'HEAD');
      const hasDiff = diff.trim().length > 0 && !diff.startsWith('(diff failed');
      const config = await loadConfig(this.repoRoot);
      review = hasDiff && reviewGateEnabled(config) && run.autonomous !== true;
    }
    // A run parked on an UNANSWERED question is waiting on the user, not finished. Settle it to
    // the attention-bearing `review` gate — the same non-active, continuable state the ask card
    // resumes through — never plain `done`, or a restart would silently mark a task that still
    // needs you as complete and drop the "needs you" signal (the `CEZ:ASK`-stuck-on-done bug).
    const pendingAsk = opts.pendingAsk === true;
    const settledReview = review || pendingAsk;
    this.store.updateRun(runId, {
      status: settledReview ? 'review' : 'done',
      finishedAt: new Date().toISOString(),
      currentStepId: undefined,
      // A run that got all the way to a settled turn is not in a limit loop, so the resume
      // counter starts over — otherwise a task that legitimately met the limit once a week would
      // creep toward the cap forever and stop resuming for no reason anyone could see.
      autoResumeAttempts: undefined,
    });
    this.store.appendEvent(runId, {
      type: 'lifecycle',
      message: pendingAsk
        ? 'your answer is still needed — reopen the session to continue'
        : review
          ? 'changes ready for review — send feedback, open a draft PR, or finish'
          : 'run finished',
    });
  }

  /**
   * Does this run's transcript end on an UNANSWERED `CEZ:ASK`? True when its latest
   * `ask.requested` event has no later `user-message` (the event a resume/answer appends to
   * resolve the card). Used by restart recovery where an explicit ask may outrank chain re-entry.
   * A heuristically detected prose question is handled beside this predicate: it may preserve
   * attention, but may not stall queued chain work (spec 2026-08-23, P5).
   */
  private runHasPendingAsk(runId: string): boolean {
    let lastAsk = -1;
    let lastAnswer = -1;
    for (const event of this.store.readEvents(runId)) {
      if (event.type === 'ask.requested') lastAsk = Math.max(lastAsk, event.seq);
      else if (event.type === 'user-message') lastAnswer = Math.max(lastAnswer, event.seq);
    }
    return lastAsk >= 0 && lastAsk > lastAnswer;
  }

  /**
   * Agent screenshot (an image block inside a tool result) or a user-pasted
   * attachment: the base64 data never enters the NDJSON event log — it lands
   * as a file under `.ai/cezar/runs/<id>-images/` and the transcript event
   * carries only the name + serving URL. `namePrefix` distinguishes the two
   * origins on disk (`screenshot-<n>.<ext>` for agent tool screenshots,
   * `pasted-<n>.<ext>` for user-pasted attachments, #357) and the absolute
   * `path` lets the agent operate on the file directly (save/attach/upload).
   * Best effort: on failure the attachment is dropped, the transcript still
   * shows the tool result's `[screenshot]` placeholder (or the image count).
   */
  private persistImage(
    runId: string,
    mediaType: string,
    data: string,
    namePrefix: string = 'screenshot',
  ): { name: string; url: string; path: string } | null {
    try {
      const ext =
        /png/.test(mediaType) ? 'png'
        : /jpe?g/.test(mediaType) ? 'jpg'
        : /webp/.test(mediaType) ? 'webp'
        : /gif/.test(mediaType) ? 'gif'
        : 'img';
      const dir = join(this.dataDir, 'runs', `${runId}-images`);
      mkdirSync(dir, { recursive: true });
      // Seed from the highest numeric suffix already on disk, NOT the file count:
      // `screenshot-*` and `pasted-*` share one numbering space, so counting would
      // re-issue a live number after any deletion. Only matters on the first write
      // of a process (restart case) — afterwards the map is authoritative.
      let seq = this.queuedImageSeq.get(runId);
      if (seq === undefined) seq = highestImageSeq(dir);
      // `persistImage` is fully synchronous, so two pastes cannot interleave between
      // the read of the counter and the write. The exclusive-create flag is the
      // belt-and-braces guard for a stale seed: it degrades to a renamed file rather
      // than a silent overwrite.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        seq += 1;
        const name = `${namePrefix}-${seq}.${ext}`;
        const path = join(dir, name);
        try {
          writeFileSync(path, Buffer.from(data, 'base64'), { flag: 'wx' });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw err;
        }
        this.queuedImageSeq.set(runId, seq);
        // Versioned, because that is the only surface served now. The cockpit still upgrades
        // the unversioned URLs sitting in OLD transcripts when it renders them
        // (`resolveApiUrl`), but a URL minted today must be fetchable as written.
        return { name, url: `/api/v1/runs/${runId}/images/${name}`, path };
      }
      return null;
    } catch {
      return null;
    }
  }

  private armIdleTimer(runId: string, state: ActiveRun): void {
    this.clearIdleTimer(state);
    state.idleTimer = setTimeout(() => {
      if (state.session?.open && !state.cancelled) {
        // Inactivity closes the backend PROCESS to free its memory (the timer's load-bearing
        // role, AGENTS.md) — but it is NOT evidence the agent finished. Flag the close as a park
        // so the post-`session.result` wrap-up KEEPS `status: 'waiting'` (needs-you / in-progress)
        // instead of settling `done`, and the next message resumes via `--resume`
        // (spec 2026-08-20-inactive-sessions-stay-in-progress; owner instruction 2026-08-20:
        // "don't mark inactive sessions as done autonomously").
        state.idleParked = true;
        this.store.appendEvent(runId, {
          type: 'lifecycle',
          message: `session parked after ${Math.round(IDLE_TIMEOUT_MS / 60_000)}m of inactivity — reply to resume`,
        });
        state.session.end();
      }
    }, IDLE_TIMEOUT_MS);
    state.idleTimer.unref?.();
  }

  private clearIdleTimer(state: ActiveRun): void {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
  }

  private reconcileMonitoringWakeTimers(): void {
    for (const runId of this.monitoring) {
      const state = this.active.get(runId);
      if (state) this.armMonitoringWakeTimer(runId, state);
    }
  }

  private armMonitoringWakeTimer(runId: string, state: ActiveRun): void {
    const minutes = this.semaphore.monitoringWakeIntervalMinutes();
    if (minutes === null) {
      this.clearMonitoringWakeTimer(state, runId);
      return;
    }
    if ((state.monitoringWakeups ?? 0) >= MAX_AUTO_CONTINUES) {
      this.clearMonitoringWakeTimer(state, runId);
      if (!this.store.getRun(runId)?.monitoringWakeCapReached) {
        this.store.updateRun(runId, { monitoringWakeCapReached: true });
        this.store.appendEvent(runId, {
          type: 'note',
          message: `automatic monitoring wake-up cap reached (${MAX_AUTO_CONTINUES}); session remains parked`,
        });
      }
      return;
    }
    if (state.monitoringWakeTimer && state.monitoringWakeIntervalMinutes === minutes) return;
    this.clearMonitoringWakeTimer(state, runId);
    state.monitoringWakeIntervalMinutes = minutes;
    this.store.updateRun(runId, { monitoringWakeCapReached: undefined });
    const deadline = Date.now() + minutes * 60_000;
    this.store.updateRun(runId, { monitoringWakeAt: new Date(deadline).toISOString() });
    state.monitoringWakeTimer = setTimeout(() => {
      state.monitoringWakeTimer = undefined;
      this.store.updateRun(runId, { monitoringWakeAt: undefined });
      if (!this.monitoring.has(runId) || !state.session?.open || state.cancelled) return;
      const wakeups = state.monitoringWakeups ?? 0;
      if (wakeups >= MAX_AUTO_CONTINUES) {
        this.store.updateRun(runId, { monitoringWakeCapReached: true });
        this.store.appendEvent(runId, {
          type: 'note',
          message: `automatic monitoring wake-up cap reached (${MAX_AUTO_CONTINUES}); session remains parked`,
        });
        return;
      }
      state.monitoringWakeups = wakeups + 1;
      this.store.appendEvent(runId, {
        type: 'note',
        message: `automatic monitoring wake-up (${state.monitoringWakeups}/${MAX_AUTO_CONTINUES})`,
      });
      this.deliverMessage(runId, [{ type: 'text', text: MONITORING_WAKE_NUDGE }], false);
    }, Math.max(0, deadline - Date.now()));
    state.monitoringWakeTimer.unref?.();
  }

  private clearMonitoringWakeTimer(state: ActiveRun, runId?: string): void {
    if (state.monitoringWakeTimer) clearTimeout(state.monitoringWakeTimer);
    state.monitoringWakeTimer = undefined;
    state.monitoringWakeIntervalMinutes = undefined;
    if (runId) this.store.updateRun(runId, { monitoringWakeAt: undefined });
  }

  /**
   * Shared by BOTH turn-end twins (`runAgentStep`, `runContinuation`) — the same lesson
   * `specs-172ddd891dd0` (chain-integrity) left behind: one method called from both sites, not two
   * copies that drift (spec 2026-08-23-plain-end-structured-question, R3).
   *
   * `trailingQuestion` is the VERDICT already computed at the marker site, before `turnText` was
   * reset — this method never sees the raw turn text. Called ONLY on a genuine plain end (no
   * `CEZ:DONE` / `CEZ:ASK` / `CEZ:MONITORING`).
   *
   * Returns `true` when a bounded `ASK_STRUCTURE_NUDGE` was sent instead of parking — the caller
   * must then skip ONLY the park/slot-release block, not the trailing `autoResumeAttempts` /
   * handoff-heartbeat statements that still run on every turn (P4 step 3).
   */
  private parkPlainEnd(
    runId: string,
    stepId: string,
    trailingQuestion: TrailingQuestion | null,
    state: ActiveRun,
  ): boolean {
    if (
      trailingQuestion !== null &&
      (state.askStructureNudges ?? 0) < MAX_ASK_STRUCTURE_NUDGES &&
      !state.cancelled &&
      !state.autonomous &&
      state.session?.open
    ) {
      const sent = this.deliverMessage(runId, [{ type: 'text', text: ASK_STRUCTURE_NUDGE }], false);
      if (sent) {
        state.askStructureNudges = (state.askStructureNudges ?? 0) + 1;
        this.store.appendEvent(runId, {
          type: 'note',
          stepId,
          message: `nudged to re-send a prose question as CEZ:ASK (${state.askStructureNudges}/${MAX_ASK_STRUCTURE_NUDGES})`,
        });
        return true;
      }
    }
    this.store.updateRun(runId, {
      status: 'waiting',
      activity: undefined,
      waitingReason: trailingQuestion !== null ? 'question' : 'report',
      waitingQuestion: trailingQuestion?.text,
    });
    return false;
  }

  /** Autosave-commit the worktree every 90 s while the run lives (spec 006).
   *  Opt-in via CEZ_AUTOSAVE=1 (#471) — see periodicAutosaveEnabled. */
  private armAutosave(state: ActiveRun): void {
    if (!periodicAutosaveEnabled()) return;
    if (state.cwd === this.repoRoot || state.autosaveTimer) return;
    state.autosaveTimer = setInterval(() => {
      void autosaveCommit(state.cwd, 'periodic');
    }, AUTOSAVE_INTERVAL_MS);
    state.autosaveTimer.unref?.();
  }

  private clearAutosaveTimer(state: ActiveRun): void {
    if (state.autosaveTimer) {
      clearInterval(state.autosaveTimer);
      state.autosaveTimer = undefined;
    }
  }

  private armWorktreeLeases(state: ActiveRun, runId: string, roots: string[]): void {
    const unique = [...new Set(roots)];
    if (unique.length === 0) return;
    state.leaseRoots = unique;
    if (state.leaseTimer) clearInterval(state.leaseTimer);
    state.leaseTimer = setInterval(() => {
      void touchWorktreeLeases(unique, runId, this.repoRoot);
    }, LEASE_HEARTBEAT_MS);
    state.leaseTimer.unref?.();
  }

  private clearWorktreeLeases(state: ActiveRun, runId: string): void {
    if (state.leaseTimer) clearInterval(state.leaseTimer);
    state.leaseTimer = undefined;
    const roots = state.leaseRoots ?? [];
    state.leaseRoots = undefined;
    if (roots.length > 0) void removeWorktreeLeases(roots, runId);
  }

  private runCheckStep(
    state: ActiveRun,
    step: WorkflowStepDef,
    emit: (event: { type: string; stepId?: string; [k: string]: unknown }) => void,
  ): Promise<{ ok: boolean; output: string }> {
    return this.runShell(state, step.id, step.command as string, emit);
  }

  /**
   * A step's POST-CONDITION (`.ai/specs/2026-08-20-steps-green-only-when-verified.md`): what has
   * to be true about the world before the step may be called done. A step with no `verify` passes
   * untouched, so every workflow that predates this keeps its exact behaviour.
   *
   * The verdict is emitted as a `check-output` event — the cockpit already renders those as an
   * execute card carrying an exit-code verdict, so the failure is visible with no web change.
   */
  private async runStepVerify(
    runId: string,
    state: ActiveRun,
    step: WorkflowStepDef,
    emit: (event: { type: string; stepId?: string; [k: string]: unknown }) => void,
  ): Promise<PostconditionResult> {
    const verify = step.verify;
    if (!verify) return { ok: true, detail: '' };

    if (verify.command) {
      const { ok, output } = await this.runShell(state, step.id, verify.command, emit);
      return { ok, detail: ok ? output : `\`${verify.command}\` exited non-zero:\n${output}` };
    }

    // A workspace run applies its per-project worktrees back UNSTAGED on purpose, so it is
    // supposed to commit nothing — `everything-committed` has to know that or it fails them all.
    const workspaceRun = (this.store.getRun(runId)?.workspaceProjects?.length ?? 0) > 0;
    const result = await evaluatePostcondition(verify.builtin as string, { cwd: state.cwd, workspaceRun });
    emit({
      type: 'check-output',
      stepId: step.id,
      command: `post-condition: ${verify.builtin}`,
      text: result.detail,
      exitCode: result.ok ? 0 : 1,
    });
    return result;
  }

  /**
   * Decide whether a failed post-condition gets another attempt at the SAME step. Returns the text
   * to append to the retried prompt, or `undefined` when the budget is spent and the step must
   * fail. Re-entering the step is the point: the agent is told exactly what it did not achieve —
   * the files it left uncommitted, the service that is not live — and gets to finish the job.
   */
  private retryAfterFailedPostcondition(
    runId: string,
    step: WorkflowStepDef,
    verdict: PostconditionResult,
    ledger: Map<string, number>,
    emit: (event: { type: string; stepId?: string; [k: string]: unknown }) => void,
  ): string | undefined {
    const max = step.verify?.max ?? 0;
    const used = ledger.get(step.id) ?? 0;
    if (used >= max) return undefined;
    ledger.set(step.id, used + 1);
    emit({
      type: 'note',
      stepId: step.id,
      message: `post-condition failed — re-running "${step.id}" (attempt ${used + 1}/${max}): ${verdict.detail}`,
    });
    // Back to `pending` so the GUI rail reads top-to-bottom truthfully while the step re-runs,
    // exactly as a check step's loop-back does.
    this.store.updateStep(runId, step.id, { status: 'pending', error: undefined });
    return `This step's post-condition FAILED, so its goal was not met:\n\n${verdict.detail}`;
  }

  /** One bash spawn, output-capped, reported as a `check-output` card. Shared by check steps and
   *  by a `verify.command` post-condition so both read identically in the thread. */
  private runShell(
    state: ActiveRun,
    stepId: string,
    command: string,
    emit: (event: { type: string; stepId?: string; [k: string]: unknown }) => void,
  ): Promise<{ ok: boolean; output: string }> {
    emit({ type: 'note', stepId, message: `$ ${command}` });
    return new Promise((resolve) => {
      // Check steps run in the same cwd as the agent steps — the worktree.
      const child = spawn('bash', ['-lc', command], { cwd: state.cwd, env: process.env });
      state.interrupt = () => child.kill('SIGTERM');

      let output = '';
      const collect = (chunk: Buffer) => {
        if (output.length < CHECK_OUTPUT_CAP) {
          output += chunk.toString('utf8');
          if (output.length >= CHECK_OUTPUT_CAP) output += '\n… (output truncated)';
        }
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', (err) => {
        state.interrupt = () => undefined;
        const message = `failed to spawn: ${err.message}`;
        emit({ type: 'check-output', stepId, command, text: message, exitCode: -1 });
        resolve({ ok: false, output: message });
      });
      child.on('close', (code) => {
        state.interrupt = () => undefined;
        const trimmed = output.trim() || '(no output)';
        emit({ type: 'check-output', stepId, command, text: trimmed, exitCode: code ?? -1 });
        resolve({ ok: code === 0, output: trimmed });
      });
    });
  }

  private finishStep(
    runId: string,
    stepId: string,
    status: 'done' | 'failed',
    error: string | undefined,
    emit: (event: { type: string; stepId?: string; [k: string]: unknown }) => void,
    /** Set only when CEZAR stopped the step. `status` stays `failed` — `StepStatus` is a
     *  published union and widening it would break every exhaustive consumer — so this field is
     *  the one thing that tells a reader, and the cockpit, that nothing actually errored. */
    stopReason?: AgentStopReason,
  ): void {
    this.store.updateStep(runId, stepId, {
      status,
      error,
      ...(stopReason ? { stopReason } : {}),
      finishedAt: new Date().toISOString(),
    });
    // The WORKFLOW-step half of the limit clear (the continuation half is in `runContinuation`).
    // Every ordinary agent step lands here, so this is the seam that matters most: a `spec` or
    // `review-spec` turn completing is the commonest proof a provider's window reopened. A `check`
    // step carries no `backend` and is skipped inside the helper rather than guarded here.
    if (status === 'done') this.clearAccountLimit(runId, stepId);
    emit({
      type: 'step-end',
      stepId,
      status,
      ...(error ? { error } : {}),
      ...(stopReason ? { stopReason } : {}),
    });
    appendHandoffHeartbeat(
      this.dataDir,
      runId,
      `step "${stepId}" complete — status=${status}${stopReason ? ' (stopped, not failed)' : ''}`,
    );
  }
}

function findLastAgentStepIndex(workflow: WorkflowDef): number {
  for (let i = workflow.steps.length - 1; i >= 0; i--) {
    const step = workflow.steps[i];
    if (step && stepKind(step) === 'agent') return i;
  }
  return -1;
}

function applyTemplate(template: string, task: string): string {
  return template.replaceAll('{{task}}', task);
}

/**
 * Immediate title shown while a run is queued. The namer's `titleSummary`
 * replaces it once the model answers; this is the honest, permanent fallback
 * when no model is available (#432, spec 2026-07-17-task-auto-naming). When
 * the task references a PR/issue, the number leads: `469: /om-auto-review-pr`.
 */
export function makeRunTitle(task: string, workflow: WorkflowDef): string {
  const firstLine = task.trim().split('\n')[0] ?? '';
  const skill = workflow.steps.find((step) => stepKind(step) === 'agent' && step.skill)?.skill?.trim();
  const contextual = skill && !firstLine.startsWith(`/${skill}`)
    ? `/${skill}${firstLine ? ` ${firstLine}` : ''}`
    : firstLine;
  const refNumber = titleRefNumber(refineTaskRefs(extractTaskRefs(task), skill));
  // `469` or `/om-auto-review-pr 469` reads as `469: /om-auto-review-pr` — the
  // number leads so it survives the tasks table's narrow truncation.
  const skillArg = skill && contextual.startsWith(`/${skill}`) ? contextual.slice(skill.length + 1).trim() : null;
  const body = refNumber !== undefined && skill && (skillArg === '' || /^#?\d+$/.test(skillArg ?? ''))
    ? `/${skill}`
    : contextual;
  const prefixed =
    refNumber !== undefined && !body.trimStart().replace(/^#/, '').startsWith(String(refNumber))
      ? `${refNumber}: ${body}`
      : body;
  const chars = [...(prefixed || '(untitled task)')];
  return chars.length > 80 ? `${chars.slice(0, 79).join('').trimEnd()}…` : chars.join('');
}

/**
 * Skill identity is context, while the Markdown body remains instructions.
 *
 * For an on-disk skill we also hand the agent the ABSOLUTE directory of the
 * installed copy. A run executes in an isolated worktree that has no local
 * `.agents/skills` (gitignored, absent in a fresh checkout), so without this
 * the agent cannot read the skill's companion files (`references/*.md`) — or,
 * worse, reads a stale copy materialized from the team-repo cache. The path
 * resolves against the MAIN project root (`discoverSkills(repoRoot)`), i.e. the
 * current `npx skills`-installed copy, so a worktree agent and the main
 * checkout read the exact same, up-to-date files. Team skills are omitted here:
 * they are materialized into the worktree separately (see the call site).
 */
export function skillSystemPrompt(
  skill: Pick<Skill, 'name' | 'description' | 'body'> & Partial<Pick<Skill, 'path' | 'source'>>,
): string {
  const lines = [
    `Selected skill: /${skill.name}`,
    ...(skill.description ? [`Description: ${skill.description}`] : []),
  ];
  if (skill.source && skill.source !== 'team' && skill.path) {
    const dir = dirname(skill.path);
    lines.push(
      '',
      `Skill files are installed on disk at: ${dir}`,
      `Read any file this skill references (for example references/*.md) from that absolute directory. ` +
        `It is the current installed copy — use it even though your working directory is a separate worktree that does not contain the skill.`,
    );
  }
  lines.push('', 'Skill instructions:', skill.body.trim());
  return lines.join('\n');
}

/**
 * Expand a registry-backed slash skill in one prompt string before it reaches a
 * backend. Claude otherwise intercepts an unknown leading slash command, and
 * Codex/OpenCode have no native slash-skill lookup at all (#676).
 *
 * Only a match at character zero counts, and unknown commands pass through
 * byte-for-byte — a backend's OWN slash commands must keep working. The caller
 * persists the original user text before applying this delivery-only rewrite.
 *
 * Both delivery seams route through here: live-session messages via
 * `expandRegistrySlashSkill`, and a continuation's opening prompt, which becomes
 * the session's `userPrompt` and never passes through `deliverMessage` at all
 * (#811).
 */
export function expandRegistrySlashSkillText(text: string, skills: readonly Skill[]): string {
  const match = /^\/([A-Za-z0-9][A-Za-z0-9._-]*)(?=\s|$)/.exec(text);
  if (!match) return text;
  const skill = skills.find((candidate) => candidate.name === match[1]);
  if (!skill) return text;

  const request = text.slice(match[0].length).trim();
  return request ? `${skillSystemPrompt(skill)}\n\nUser request:\n${request}` : skillSystemPrompt(skill);
}

/**
 * `expandRegistrySlashSkillText` over a live chat message: only the first text
 * block is eligible, and an unchanged block returns the caller's array
 * identity untouched.
 */
export function expandRegistrySlashSkill(
  content: ContentBlock[],
  skills: readonly Skill[],
): ContentBlock[] {
  const textIndex = content.findIndex((block) => block.type === 'text');
  if (textIndex < 0) return content;
  const block = content[textIndex];
  if (!block || block.type !== 'text') return content;
  const text = expandRegistrySlashSkillText(block.text, skills);
  if (text === block.text) return content;

  const expanded = [...content];
  expanded[textIndex] = { type: 'text', text };
  return expanded;
}
