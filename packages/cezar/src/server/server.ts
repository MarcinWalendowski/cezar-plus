import { existsSync, readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AutomationStore } from '../automations/store.ts';
import { AutomationCoordinator } from '../automations/coordinator.ts';
import { GithubPoller } from '../automations/github-poller.ts';
import { ProjectAutomationScheduler, WorkspaceAutomationScheduler } from '../automations/scheduler.ts';
import { launchAutomationRun, reconcileAutomationReceipts, validateAutomationPrompt } from '../automations/task-template.ts';
import {
  automationEventSchema,
  automationFiltersSchema,
  automationLogResultSchema,
  automationTaskSchema,
  type AutomationDefinition,
} from '../automations/types.ts';
import type { IncomingMessage } from 'node:http';
import { access, constants as fsConstants, mkdir, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import type { Next } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { jsonZodValidator, paramZodValidator, queryZodValidator } from './validators.ts';
import { createKnowledgeRoutes } from './knowledge-routes.ts';
import { createSourcesRoutes } from './sources-routes.ts';
import { createNotesRoutes } from './notes-routes.ts';
import { NoteStore } from '../notes/store.ts';
import { NoteCoordinator } from '../notes/coordinator.ts';
import { NoteProcessor } from '../notes/processor.ts';
import { NoteApprover } from '../notes/approve.ts';
import { NoteContinuationTrigger } from '../notes/continuation.ts';
import { createWorkspaceRunsRoutes } from './workspace-runs-routes.ts';
import { createWorkspaceRunMutationRoutes } from './workspace-run-mutations-routes.ts';
import { createWorkspaceGitRoutes } from './workspace-git-routes.ts';
import { createWorkspaceKnowledgeRoutes } from './workspace-knowledge-routes.ts';
import { createWorkspaceTodosRoutes } from './workspace-todos-routes.ts';
import { createWorkspaceRunRoutes } from './workspace-run-routes.ts';
import { createNotificationsRoutes } from './notifications-routes.ts';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import {
  setWorkspaceUiStateInputSchema,
  type GroupResponse,
  type GroupVariant,
  type PickVariantResponse,
  type DiscoveredAgentAccountsResponse,
  type GitInitResponse,
  type GitPreflightResponse,
  type ProjectScanResponse,
  type RunIndexEntry,
  type RunsIndexResponse,
  type CreateTodoResponse,
  type WorkspaceTodosResponse,
} from '@open-mercato/cezar-contract';
// A contract VALUE, like `workspaceUiStateSchema` in workspace/migrations.ts — the request
// schema this route validates with is the same one the client compiles against.
import {
  createTodoInputSchema,
  gitInitRequestSchema,
  modelDiscoveryRunnerSchema,
  openProjectInSchema,
  updateProjectInputSchema,
} from '@open-mercato/cezar-contract';
import { detectEnvironment } from '../core/backend-detect.ts';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import type { ContentBlock, RunnerId } from '../core/agent-runner.ts';
import { AGENT_MODELS_LOCKED_ERROR, agentModelsLocked } from '../core/agent-model-policy.ts';
import { discoverCodexModels } from '../core/codex-model-catalog.ts';
import { discoverOpencodeModels } from '../core/opencode-model-catalog.ts';
import {
  PROVIDER_IDS,
  ProviderAuthService,
  providerAuthChecksDisabled,
  type ProviderId,
  type ProviderStatusResponse,
} from '../core/provider-auth.ts';
import { applyProviderEnablement } from '../core/provider-availability.ts';
import { RunnerModelCatalog } from '../core/runner-model-catalog.ts';
import { currentUsage, onUsage } from '../core/process-usage.ts';
import { WORKFLOWS_DIR, loadWorkflows } from '../workflows/load.ts';
import {
  QUICK_TASK_WORKFLOW,
  normalizeWorkflowDoc,
  skillStackOf,
  skillsToSteps,
  stepsIssue,
  workflowFileSchema,
  workflowStepSchema,
  type WorkflowDef,
} from '../workflows/types.ts';
import { planChain, slugify } from '../planner.ts';
import { discoverSkills } from '../skills.ts';
import { SkillsUpdateConflictError, SkillsUpdateCoordinator, SkillsUpdateService, type SkillsUpdateState } from '../skills-update.ts';
import { getTeamSkillsCached, refreshTeamSkills, waitForTeamSkills } from '../skills-remote.ts';
import { appendHandoffHeartbeat, handoffProgressExcerpt, readHandoff } from '../handoff.ts';
import { createTodo, markStarted, onTodosChanged, readTodos, removeTodo, todoTaskText, type TodoItem } from '../todos.ts';
import type { RunEvent, RunRecord, RunStatus, RunStore } from '../runs/store.ts';
import {
  HistoryCursorError,
  deriveRunContextEvents,
  readEventsAfterLiveCursor,
  readRunHistoryPage,
  validateLiveCursor,
} from '../runs/event-history.ts';
import { readRunIndexFromDisk } from '../runs/run-index.ts';
import { isV2WireEventType } from '../runs/ui-event-sink.ts';
import {
  runEventsQuerySchema,
  runHistoryQuerySchema,
  runIdParamSchema,
} from '@open-mercato/cezar-contract';
import type { RunManager } from '../workflows/run.ts';
import { removeWorktree, worktreeDiff, worktreeDiffStat, worktreeSizeBytes } from '../git-worktree.ts';
import { isReclaimable, reclaimWorktrees } from '../runs/retention.ts';
import { getBranches, getCommit, getDiff, getLog, getRepoInfo, getStatus } from './git.ts';
import {
  collectChanges,
  collectCommitChanges,
  collectRunCommits,
  commitAll,
  createOrSwitchBranch,
  imageMimeType,
  isOsOpenableImage,
  pushCurrentBranch,
  readWorktreePath,
} from './git-changes.ts';
import { gatedSkillsRepos, loadConfig, resolveWorktreeRetention, type CezConfig } from '../config.ts';
import { findConfigFile } from '../agent-config/catalog.ts';
import { readConfigFile, statConfigPath, writeConfigFile } from '../agent-config/files.ts';
import { readAgentModelDefaults } from '../agent-config/models.ts';
import { listAgentConfig } from '../agent-config/service.ts';
import { listConfigFiles, type AgentHomePaths } from '../agent-config/catalog.ts';
import { readAccountIdentity } from '../agent-config/account-identity.ts';
import {
  PROJECT_ID_RE,
  defaultWorkspaceConfig,
  effectiveSkillsAutoUpdate,
  loadWorkspaceConfig,
  mergeWriteWorkspaceConfig,
  effectiveComposerDefault,
  type WorkspaceConfig,
  type WorkspaceProject,
} from '../workspace/config.ts';
import {
  CONTROL_CHARS_RE,
  DEFAULT_AGENT_ACCOUNT_ID,
  defaultAgentAccountStore,
  isAbsoluteConfigDir,
  loadAgentAccounts,
  mergeWriteAgentAccounts,
  type AgentAccount,
  type AgentAccountStore,
} from '../workspace/agent-accounts.ts';
import {
  defaultAgentProfile,
  listAgentProfiles,
  profileDirState,
  resolveProfileEnvForRoot,
  resolveStoredProfile,
  sameProfileDir,
  type ResolvedAgentProfile,
} from '../workspace/agent-profiles.ts';
import { PROFILE_CAPABLE_PROVIDERS, profileEnv, supportsProfiles } from '../core/agent-profiles.ts';
import { withEnvPrefix } from '../core/shell-env.ts';
import {
  allocateProjectSlug,
  clearProjectProbeCache,
  listProjects,
  normalizeProjectTags,
  normalizeRoot,
  probeProjectStatus,
  registerProject,
  removeProject,
  shouldRegisterProject,
  type ProjectListEntry,
} from '../workspace/projects.ts';
import { discoverClaudeAccounts } from '../workspace/agent-account-identity.ts';
import { enrichNestedRepos, scanNestedRepos } from '../workspace/nested-repos.ts';
import { initGitRepo, preflightGitInit } from '../workspace/git-init.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { mergeWriteWorkspaceUiState, readWorkspaceUiState } from '../workspace/ui-state.ts';
import { checkoutRepo, defaultGitInit, type CloneRunner, type GitInitRunner } from './checkout.ts';
import {
  activateOptionalStores,
  ProjectContextError,
  ProjectContexts,
  type ProjectContext,
} from './project-context.ts';
import { reviewGateEnabled } from '../runs/review-gate.ts';
import { readUiState, uiStatePath } from '../ui-state.ts';
import { agentHomePaths, expandTilde } from '../paths.ts';
import { isLoopbackHostHeader, normalizeHostname, resolveAuthProvider, resolveCapabilities } from './capabilities.ts';
// D3's single construction of "who is this request". Imported STATICALLY, unlike most other
// `../auth/*` modules (which `src/index.ts` reaches only through a `CEZ_AUTH`-gated dynamic
// `import()`), and that asymmetry is deliberate: `auth/principal.ts` has no runtime imports of
// its own — its only import of this file is `import type`, which TypeScript erases — reads no
// file, and touches nothing under `<CEZ_HOME>/identity`. D1's "unset means zero I/O" is about
// filesystem work, which this does none of; what it buys is that `CEZ_AUTH=none` resolves its
// principal through the SAME function an authenticated request does instead of through a second
// hand-rolled constant here. Two constants "kept in sync by convention" is exactly the drift D3
// names, and it had already appeared once in this change: a `LOCAL_PRINCIPAL` here and a
// `LOCAL_IDENTITY` there, byte-identical and with nothing asserting they stayed that way.
//
// **CORRECTED 2026-08-07 (D13, phase 9 HTTP-surface pass): "unlike every other ../auth/* module"
// above is no longer literally true — `auth/local-gates.ts`, imported statically just below, is a
// second one.** Safe for the same underlying reason: neither its own module scope nor
// `local-identity.ts`'s (the module it re-exports the resolver from) reads a file at IMPORT time —
// `local-identity.ts` declares only `let cache = { kind: 'unknown' }` — so loading either costs
// nothing, and what actually does I/O (`localSessionResolver.resolveFromCookieHeader`) is only
// ever CALLED from inside the `resolveAuthProvider(...) === 'none'` branch of the principal
// middleware below, never from the authenticated branches. A hosted deployment with a real
// provider pays one extra `require` for a function it never invokes; it does not pay the read.
// See `auth/local-identity.ts#resolveLocalOrgIdentity`'s own doc comment for what that read costs
// once it IS invoked (bounded and cached — "one stat for the process lifetime" — never
// per-request I/O).
import { hasOrgScope, resolvePrincipal } from '../auth/principal.ts';
// D13's local-org resolver (phase 9 HTTP-surface pass, `resolveLocalPrincipal` below) — the SAME
// `SessionResolver` `auth/onboarding-routes.ts`/`auth/team-routes.ts` are wired with for their own
// gates (`src/index.ts`'s local-mode branch), imported and reused here rather than re-derived: two
// call sites composing `resolveLocalOrgIdentity` + `resolvePrincipal` the same way by hand is
// exactly the `LOCAL_PRINCIPAL`/`LOCAL_IDENTITY` drift shape named two paragraphs up, just at a
// smaller scale — importing the one resolver both need closes it the same way that fix did.
import { localSessionResolver } from '../auth/local-gates.ts';
// D4's root→org registry seam (EXTRACTED 2026-08-07, D13 repair round 3, FIX 3) — see
// `./project-team-registry.ts`'s own doc comment. `registered-project-roots.ts` imports the
// identical `openProjectTeamRegistry` for its non-HTTP `cezar projects remove` caller.
import { openProjectTeamRegistry, type ProjectTeamRegistry } from './project-team-registry.ts';
import { createSocketHub, type SocketHub, type WsUpgradeVerdict } from './ws.ts';
import {
  browseDirectory,
  isInsideBrowseRoot,
  isLexicallyInsideBrowseRoot,
  resolveBrowsableDir,
  resolveBrowseRoot,
} from './fs-browse.ts';
import { parseRemote, resolveForge, type ForgeAvailability } from './forge/index.ts';
import { fetchGithub, fetchGithubChecks, fetchGithubComments, fetchGithubPrDiff, fetchGithubRefStatus, forgetRefStatus, readCachedRefStatuses, refNumberFromUrl, GithubPrNotFoundError, GH_CHECKS_MAX, GH_REF_STATUS_MAX } from './github.ts';
import { ensureLaunchKey } from './launch-key.ts';
import { openInTerminal } from './open-in-terminal.ts';
import { agentCliRunner, detectOpenTargets, openFileInDefaultApp, openInApp } from './open-in-app.ts';
import { createDraftPr } from './pr.ts';
import { ProviderRuntimeAuthObserver } from './provider-auth-runtime.ts';
import {
  providerForActiveRun,
  providerForExistingRun,
  providersRequiredByWorkflow,
  unavailableProviderMessage,
} from './provider-action-gate.ts';
import { cockpitAssetRoutes, serveCockpitShell } from './shell-routes.ts';
// The forwarded-principal HEADER NAMES, imported rather than re-spelled (D10 / D3's own history —
// see `hetzner/nginx.ts`'s "Header names are IMPORTED, not re-typed" section, which makes the same
// argument for the nginx generator). `readForwardedPrincipalHeaders` is the only runtime symbol
// this file takes from the supervisor tree; that module reads no file, opens no store and does no
// I/O to be imported, so D1's "unset means zero I/O" is untouched, and the two call sites below
// only ever CALL it after `resolveAuthProvider(...) !== 'none'` has already been decided.
import {
  readForwardedPrincipalHeaders,
  type ForwardedPrincipalHeaders,
} from '../supervisor/forwarded-principal.ts';

export interface ServerDeps {
  repoRoot: string;
  store: RunStore;
  manager: RunManager;
  version: string;
  /** Mutable holder for the async npm-registry update check (#368) —
   *  `latest` appears once the registry answers with a newer version. */
  update?: { latest?: string };
  /** Host the HTTP server binds (default 127.0.0.1). A non-loopback host
   *  implies hosted mode — `capabilities.localHandoff:false`. */
  bindHost?: string;
  /** Workspace-registry id of the boot project (multi-project spec) — plumbed
   *  from `initWorkspace` in src/index.ts. Optional: legacy callers/tests get
   *  a lazy registry lookup by `repoRoot`, falling back to the repo's slug. */
  bootProjectId?: string;
  /** Per-project context map (multi-project spec, step 2.2). Non-boot
   *  `/api/p/:projectId/*` requests resolve their `{store, manager, …}` here,
   *  built lazily on first touch. Optional so legacy callers change nothing —
   *  the default is a registry-backed map; tests inject their own so they can
   *  `disposeAll()` after. The BOOT project never lives in this map: its
   *  context is seeded from `deps.{store,manager}` (which src/index.ts already
   *  recovered/pruned at startup) and the resolver short-circuits to it. */
  contexts?: ProjectContexts;
  /** Boot project's shared automation store. `startServer` injects the
   *  coordinator-owned instance so HTTP routes and the scheduler never cache
   *  separate views of the same project files. */
  automationStore?: AutomationStore;
  /** Workspace-wide parallel-cap semaphore + cached resource config (spec
   *  2026-07-20, step 2.5): the ONE instance boot created, refreshed, and gave
   *  the boot manager — threaded into the default `ProjectContexts` so every
   *  project's RunManager shares it. Step 2.7's `PUT /api/workspace/config`
   *  calls `semaphore.refresh()` after a write. Optional so legacy
   *  callers/tests change nothing. */
  semaphore?: WorkspaceSemaphore;
  /** Workspace-level SSE bus (spec, step 2.8): `project-added` /
   *  `project-removed` / `checkout-progress` plus the host-wide unstamped
   *  `provider-status` event reach `/api/workspace/events` through this.
   *  Optional — createApp builds a private one; inject to emit from outside
   *  the app (tests, future CLI hooks). */
  workspaceEvents?: WorkspaceEventBus;
  /** How `POST /api/projects/checkout` (step 4.3) actually clones. Defaults to
   *  `gh repo clone` (or the `CEZ_DRY_RUN=1` fake) — injected by tests so the
   *  route's guards, cleanup and error surfacing are exercised for real
   *  against real temp dirs, without a network or a `gh` binary. */
  cloneRunner?: CloneRunner;
  /** D15 — how `POST /api/projects/blank` turns the new folder into a repository. Defaults to
   *  `git init`; injected by tests so the route's cleanup and error surfacing are exercised
   *  against real temp dirs without depending on a `git` binary or on its exit codes. Same
   *  reasoning, and the same shape, as `cloneRunner` above. */
  gitInitRunner?: GitInitRunner;
  /** Host-wide model discovery service. Tests inject a deterministic adapter. */
  modelCatalog?: RunnerModelCatalog;
  /** Host-wide provider authentication discovery. Tests inject deterministic probes. */
  providerAuth?: ProviderAuthService;
  /** Global provider enablement preferences. Tests may inject an in-memory store. */
  workspaceConfig?: {
    load: typeof loadWorkspaceConfig;
    mergeWrite: typeof mergeWriteWorkspaceConfig;
  };
  /** Shared runtime rejection observer. The CLI injects the instance already
   *  watching the boot store before recovery; createApp builds one for legacy
   *  callers and tests. */
  providerRuntimeAuth?: ProviderRuntimeAuthObserver;
  /** Local terminal handoff for provider-owned login. */
  openTerminal?: typeof openInTerminal;
  /** Hand a local FILE (or folder) to the OS default app. Injected so the account-file open route
   *  is testable without actually launching an editor. */
  openFile?: typeof openFileInDefaultApp;
  /** Hand a local FOLDER to a chosen app by target id — editor, file manager, or `terminal`,
   *  which reaches `openInTerminal` internally. The missing sibling of `openFile` above, added
   *  2026-08-07 for the same stated reason and one it turned out to need urgently: without it,
   *  `agent-profiles-api.test.ts`'s "allows a terminal for the FOLDER" test reached the real
   *  launcher on every run and opened an actual Terminal window `cd`-ing into a `mkdtemp`
   *  directory the test had already deleted. `deps.openTerminal` did NOT cover that path — this
   *  route calls `openInApp`. Upstream reached the same conclusion independently in #820. */
  openApp?: typeof openInApp;
  /** Process-wide Open Mercato skills update detector. Injected in tests and
   * shared by every workspace route/project; createApp owns the default. */
  skillsUpdate?: SkillsUpdateService;
  /** WebSocket subscription hub (`/api/v1/ws`, src/server/ws.ts). `createApp`
   *  only registers topics on it — `startServer` builds one and attaches it
   *  to the HTTP server it binds. Optional so legacy callers/tests change
   *  nothing: no hub, no topics, and the HTTP surface is byte-identical. */
  socketHub?: SocketHub;
  /** Re-arm the workspace automation timer after definition mutations. */
  automationsChanged?: () => void;
  /**
   * The Phase 2/3 identity resolver (D1/D3/D6, spec
   * `.ai/specs/2026-08-06-org-team-auth-onboarding.md`), wired in by `src/index.ts`'s
   * `serveCommand` — never built here. `createApp`/`startServer` stay synchronous, but resolving
   * `../auth/session.ts` (a module that does not exist before Phase 2) is a dynamic import, which
   * is not, so the async load happens once in the CLI's already-`async` boot path and the already-
   * resolved instance is threaded through here. Present iff `resolveAuthProvider(process.env) !== 'none'`
   * — `requirePrincipal` below and `verifyWsUpgrade` both treat "auth is on but this is
   * undefined" as a boot-wiring bug, not as "auth is actually off", and fail closed rather than
   * silently falling back to the implicit local principal.
   */
  sessionResolver?: SessionResolver;
  /**
   * The Phase 3 auth routes (`../auth/routes.ts`: `/login`, `/auth/callback`, session
   * status/logout — the OIDC/Google flow of D9 and the onboarding flow of D8), mounted at the
   * app root when present. Same "loaded once in `serveCommand`, threaded in already-built"
   * shape as `sessionResolver` and for the same reason. Undefined is the `CEZ_AUTH=none` case,
   * and D1 is explicit that unset must register no login route at all — so this is genuinely
   * absent rather than present-but-inert, unlike most other optional deps here.
   */
  authRoutes?: Hono;
  /**
   * The D8 onboarding routes (`../auth/onboarding-routes.ts`: `GET /auth/onboarding`,
   * `POST /auth/onboarding/org`, `PATCH /auth/onboarding/team`) — mounted at the app root
   * alongside `authRoutes`, same "loaded once in `serveCommand`, threaded in already-built" shape.
   * **CORRECTED 2026-08-07 by D13: no longer the same "`CEZ_AUTH=none` ⇒ undefined ⇒ nothing
   * registered" contract `authRoutes` above has.** D13's local-mode branch
   * (`local-mode-boot.ts#buildLocalModeRoutes`) populates this field on a loopback bind with
   * `CEZ_AUTH` unset too — the npm zero-config default — gated on `isLocalOrgModeActive`
   * (`resolveAuthProvider(env) === 'none' && capabilities.localHandoff`), not on `CEZ_AUTH` naming
   * a provider. `undefined` still means "nothing registered" (still true, still enforced by
   * `if (deps.onboardingRoutes)` at the mount point below), but `CEZ_AUTH=none` no longer implies
   * `undefined` — only a HOSTED unauthenticated deployment does. A separate field (not folded into
   * `authRoutes`) because it is a separate module owned by a separate unit of work;
   * `onboarding-routes.ts`'s own module doc comment explains why these three routes cannot live
   * behind `requirePrincipal` the way the rest of `/api/*` does.
   */
  onboardingRoutes?: Hono;
  /**
   * The 5b invite routes (`../auth/invite-routes.ts`: `POST /auth/invites`, `GET /auth/invites`,
   * `POST /auth/invites/revoke`, `POST /auth/invites/redeem`) — mounted at the app root alongside
   * `authRoutes`/`onboardingRoutes`, same "loaded once in `serveCommand`, threaded in already-built"
   * shape and the same `CEZ_AUTH=none` ⇒ undefined ⇒ nothing registered contract. A separate field,
   * not folded into `onboardingRoutes`, for the identical reason that field is not folded into
   * `authRoutes`: a separate module owned by a separate unit of work.
   */
  inviteRoutes?: Hono;
  /**
   * Team CRUD (`../auth/team-routes.ts`: `GET/POST /auth/teams`, `PATCH/DELETE
   * /auth/teams/:teamId`, Phase 5c, D2/D12) — mounted at the app root alongside
   * `authRoutes`/`onboardingRoutes`/`inviteRoutes`, same "loaded once in `serveCommand`, threaded
   * in already-built" shape. **CORRECTED 2026-08-07 by D13: no longer the same `CEZ_AUTH=none` ⇒
   * undefined ⇒ nothing registered contract `inviteRoutes` above has** — same correction and same
   * reason as `onboardingRoutes`'s own doc comment right above: D13's local-mode branch populates
   * this field on a loopback bind with `CEZ_AUTH` unset too, gated on `isLocalOrgModeActive`, not
   * on `CEZ_AUTH` naming a provider. `undefined` still means "nothing registered"; `CEZ_AUTH=none`
   * no longer implies `undefined`. A separate field, not folded into `onboardingRoutes`, for the
   * identical reason `inviteRoutes` is not: a separate module owned by a separate unit of work.
   */
  teamRoutes?: Hono;
}

/**
 * A resolved caller identity (D3): every `/api/*` request and every WebSocket upgrade carries
 * one, through the SAME resolution path whether `CEZ_AUTH` is off (the implicit local principal
 * `resolveLocalPrincipal` below resolves) or on (a real session). There is deliberately no "if
 * auth is off, skip the resolver" branch — see D3's own worked incident for what that shape
 * costs: two project-context construction paths (`ProjectContexts.build()` vs the hand-built
 * `bootContext`) silently disagreed about which stores were active, and the same drift would
 * apply to who is allowed to do what if auth-on and auth-off resolved a principal two different
 * ways.
 *
 * **`orgId`/`teamId` widened to `string | null` (D13, phase 9 data-layer pass).** `kind` used to
 * double as "has an org": `'local'` always meant `orgId === 'local'` (a literal naming no row),
 * `'session'` always meant a real org. D13 breaks that coincidence — a local user may now create
 * a real org without authenticating — so `kind` goes back to meaning only "was this request
 * authenticated" and a NEW predicate, `hasOrgScope` (`auth/principal.ts`), is what the five
 * org-scoped call sites (`withTeams`, `mayActOnRoot`, `releaseRootClaim`, `registerFolder`'s claim
 * block, `PATCH /projects/:id`'s `teamId` arm) switch to in place of `kind === 'session'`.
 * **DONE 2026-08-07 (phase 9 HTTP-surface pass) — corrects the line above, which read "not done
 * in this pass" while this file was still only the data-layer pass.** All five sites now read
 * `hasOrgScope(principal)` (or its negation via TypeScript's control-flow narrowing on an early
 * return), never `kind`; `kind` is read ONLY where the question really is "was this request
 * authenticated" — the auth perimeter middleware, `verifyWsUpgrade`, the health-payload
 * redaction, unchanged by this pass. D13 invariant 3 — "a `null` orgId is NEVER coerced to the
 * string `'local'`" — holds because `hasOrgScope` is a type guard: every read of
 * `principal.orgId`/`principal.teamId` inside one of its narrowed branches is the real `string`
 * that guard just proved is not `null`, never a placeholder standing in for "no org".
 */
export interface Principal {
  /** `'local'` is the implicit `CEZ_AUTH=none` identity; `'session'` is a real signed-in user.
   *  No longer a stand-in for "has an org" — see `hasOrgScope` in `auth/principal.ts`. */
  readonly kind: 'local' | 'session';
  readonly userId: string;
  readonly orgId: string | null;
  readonly teamId: string | null;
  readonly role: 'owner' | 'admin' | 'member';
}

/**
 * The Phase 2/3 contract `packages/cezar/src/auth/session.ts` implements (D3, D7) — declared
 * here, not there, because that module does not exist until Phase 2 lands, and putting the
 * shape where BOTH sides already exist lets this seam and the future module compile against the
 * identical type instead of each inventing its own (or the seam falling back to `any`).
 *
 * Deliberately SYNCHRONOUS: `SocketHub.attach()`'s `verifyUpgrade` callback (`./ws.ts`) is sync
 * by construction — the raw `upgrade` event has nowhere to `await` before the hub decides
 * whether to complete the handshake — and D6 asks for the exact same check duplicated into that
 * path, not a second async one bolted on beside it. A resolver only callable from an `async`
 * handler is a resolver `verifyWsUpgrade` could never call. This is not a hardship Phase 2/3
 * inherits reluctantly: D7's identity reads are plain JSON behind an `O_EXCL` lease, which is
 * sync fs I/O — the same constraint `RunStore`/`SourceStore` already live under.
 */
export interface SessionResolver {
  /** `null` for no session, an invalid one, or an expired one — never throws. An unreadable
   *  identity store degrades to "no session", the same zero-config failure mode every other
   *  store in this codebase uses (see e.g. `loadWorkspaceConfig`).
   *
   *  `forwarded` carries the supervisor's HMAC-signed principal headers when this process runs
   *  as an ORG process behind the supervisor (`CEZ_AUTH=supervisor`, D10) —
   *  `supervisor/forwarded-session.ts` is the implementation that reads it, and it ignores the
   *  cookie entirely (an org process has no identity store to look a session id up in). ADDITIVE
   *  and optional by design: TypeScript's "fewer parameters is assignable to more parameters"
   *  rule means `auth/session.ts`'s own cookie resolver, and every test's hand-written stub,
   *  satisfies this widened signature with zero edits. */
  resolveFromCookieHeader(cookieHeader: string | undefined, forwarded?: ForwardedPrincipalHeaders): Principal | null;
}

/**
 * The identity every request resolves to while `CEZ_AUTH` is unset AND the bind is loopback (D1/D3,
 * amended by D13) — a synthetic local user, carrying REAL `orgId`/`teamId` once one has been created
 * through the onboarding wizard, and `null`/`null` until then, so the zero-config single-user
 * product never has to reason about "no principal" at all (it always gets one; `hasOrgScope` is
 * what tells a caller whether that principal may act on an org).
 *
 * **Callable only on the loopback bind (CORRECTED 2026-08-07, adversarial review).** This function
 * reads `<CEZ_HOME>/identity` through `localSessionResolver` with no awareness of who is asking —
 * it is not, on its own, safe to call for every `CEZ_AUTH === 'none'` request, because
 * `hosted + CEZ_AUTH unset + CEZ_ALLOW_UNAUTHENTICATED=1` is a real topology (D1's table) whose
 * audience is a network, not this machine. Its one call site (`requirePrincipal` above) now guards
 * it with `isHostedMode()` — `capabilities.localHandoff`, the same predicate
 * `local-mode-boot.ts#buildLocalModeRoutes` (via `isLocalOrgModeActive`, `server/capabilities.ts`)
 * already gates MOUNTING the local onboarding/team routes on — and falls back to the plain no-org
 * `resolvePrincipal({ authProvider: 'none' })` on a hosted bind instead. Do not add a second caller
 * without the same guard.
 *
 * **No longer a frozen module-scope constant (CORRECTED 2026-08-07, D13 phase 9).** Before D13
 * this could be hoisted ONCE at import time — the doc comment here used to say exactly that,
 * "hoisting the auth-off call to module scope costs one object at import time and is not a
 * per-request allocation" — because the auth-off identity never changed for the process's
 * lifetime. D13 breaks that: a local user can create an org WHILE this process keeps running
 * (`POST /auth/onboarding/org`), so a value computed once at import time would go on reporting
 * "no org" forever even after one exists. This function is called fresh on every request instead.
 *
 * **Resolved per request, but this is NOT per-request I/O.** `localSessionResolver`
 * (`auth/local-gates.ts`) reads through `auth/local-identity.ts#resolveLocalOrgIdentity`'s own
 * module-level cache (`unknown` → one `existsSync` → `none` | `resolved`) — a request pays that
 * cost at most once per process, and the onboarding write is what invalidates it
 * (`invalidateLocalOrgIdentityCache`, called by `auth/onboarding-routes.ts` the instant it
 * succeeds), never a TTL or a re-check on every call.
 *
 * Built by CALLING `resolvePrincipal` (inside `localSessionResolver`), not by writing the four
 * fields out again here. D3 forbids a second construction path, and a duplicated literal is one:
 * it drifts silently, because nothing type-checks two object literals against each other — see
 * this file's own `LOCAL_PRINCIPAL`/`auth/principal.ts`'s `LOCAL_IDENTITY` history, above.
 */
function resolveLocalPrincipal(): Principal {
  // `localSessionResolver.resolveFromCookieHeader` is typed against the shared `SessionResolver`
  // interface (`Principal | null`, since a COOKIE-based resolver can genuinely fail to resolve a
  // session) — but the concrete local implementation (`auth/local-gates.ts`) ignores its argument
  // and always resolves to a `Principal` (the implicit no-org identity, or a real one once the
  // local org exists), never `null`. The `??` below is therefore unreachable in practice; it
  // exists so this function's own return type stays a plain `Principal`, matching every other
  // principal this middleware ever sets, rather than leaking a nullability no caller here needs
  // to handle.
  return localSessionResolver.resolveFromCookieHeader(undefined) ?? resolvePrincipal({ authProvider: 'none' });
}

// ---- project-scoped routing (multi-project spec, step 2.2) -----------------

/** Hono env for the mirrored project-route table: the scope resolver puts the
 *  request's `ProjectContext` on the context, handlers read `c.get('project')`.
 *
 *  Exported (central-hub scaffold, `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md`) so a
 *  project-scoped route family can live in its own file (`knowledge-routes.ts`,
 *  `sources-routes.ts`) and still type its `Hono<ProjectApiEnv>()` against the same env every
 *  in-file family uses, rather than declaring a second, structurally-equal env that could drift.
 *
 *  `ProjectContext` is re-exported alongside it for the same reason: a consumer that types a
 *  `Hono<ProjectApiEnv>()` almost always also has to name the object the env carries (to build a
 *  fixed context in a test, or to narrow one in a helper). Exporting the env while leaving the
 *  type it is defined in terms of module-private is an incomplete surface — the definition still
 *  lives in `project-context.ts`, and this is an alias, not a second declaration. */
export type { ProjectContext };
export type ProjectApiEnv = { Variables: { project: ProjectContext } };

/** `projectId` gate at the route boundary (spec "Project identity"): the slug
 *  shape or the reserved `default` alias — validated BEFORE touching any map
 *  or path. (`default` matches the slug regex too; the literal keeps the
 *  contract explicit.) */
const projectIdSchema = z.union([z.literal('default'), z.string().regex(PROJECT_ID_RE)]);

const providerConnectSchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  /** Which agent account to sign in (spec 2026-07-29-agent-profiles). Absent = the discovered
   *  default, which is what every pre-profiles client sends. Without this, "Connect" on a second
   *  Claude account would open a login for the FIRST one and report success. */
  profileId: z.string().max(64).optional(),
}).strict();

/** Agent-account bodies (spec 2026-07-29-agent-profiles). Bounds mirror `agentProfileSchema` in
 *  src/workspace/config.ts exactly, so a value these accept can never be degraded away by the
 *  next load's `.catch`. The id is allocated server-side and is never a request field. */
const createAgentProfileSchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  label: z.string().trim().max(200).optional(),
  configDir: z.string().trim().min(1).max(4096),
}).strict();

/** `POST …/agent-profiles/:id/open` — a catalog id (or `folder`) plus an optional open target. */
const openAgentAccountFileSchema = z.object({
  file: z.string().min(1).max(200),
  target: z.string().min(1).max(64).optional(),
}).strict();

const updateAgentProfileSchema = z.object({
  label: z.string().trim().max(200).optional(),
  configDir: z.string().trim().min(1).max(4096).optional(),
}).strict().refine(
  (value) => value.label !== undefined || value.configDir !== undefined,
  'send label or configDir',
);

/** `PUT …/agent-profiles/selection` — which account a project uses for one provider. `null`
 *  clears it back to the discovered account. */
const selectAgentProfileSchema = z.object({
  /** `null` targets the machine-wide default rather than one repo. */
  projectId: z.string().min(1).max(64).nullable(),
  provider: z.enum(PROVIDER_IDS),
  profileId: z.string().max(64).nullable(),
}).strict();

/** The hosted-mode refusal, worded like the agent-config one it mirrors. */
const hostedProfileRefusal = {
  error: 'agent accounts are managed from the machine that owns the checkout (this cockpit runs in hosted mode)',
};

/**
 * Allocate a profile id from the label (or, with no label, the folder name).
 *
 * Reuses the project allocator's shape, and deliberately its reserved set too: `default` is the
 * discovered profile here exactly as it is the boot alias there, so a folder called `default/`
 * becomes `default-2` and can never shadow it.
 */
function allocateAgentProfileId(source: string, taken: Iterable<string>): string {
  // `allocateProjectSlug` already basenames its argument and enforces the shared
  // `^[a-z0-9][a-z0-9-]{0,63}$` shape, so `~/.claude-klaudiusz` slugs to `claude-klaudiusz`.
  return allocateProjectSlug(source, taken);
}

const providerParamSchema = z.enum(PROVIDER_IDS);
const providerEnabledSchema = z.object({ enabled: z.boolean() }).strict();
const providerRetrySchema = z.object({
  authFailureId: z.string().min(1).max(128),
}).strict();

const automationEditableSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2_000).optional(),
    enabled: z.boolean().optional(),
    events: z.array(automationEventSchema).min(1).max(4),
    intervalSeconds: z.number().int().min(60).max(86_400),
    filters: automationFiltersSchema,
    task: automationTaskSchema,
  })
  .strict();
const automationCreateSchema = automationEditableSchema.extend({ enable: z.boolean().optional() });
const automationUpdateSchema = automationEditableSchema.extend({ expectedRevision: z.number().int().positive() });
const automationCheckRequestSchema = z.object({ mode: z.enum(['preview', 'execute']) }).strict();
const automationLogQuerySchema = z.object({
  automationId: z.string().optional(),
  result: automationLogResultSchema.optional(),
  event: automationEventSchema.optional(),
  since: z.string().datetime().optional(),
  cursor: z.coerce.number().int().positive().optional(),
  // Optional, not `.default(100)`: `AutomationStore.logs` already clamps `limit ?? 100` into
  // 1..100, so the default here was a second copy of it — and a defaulted key is REQUIRED in the
  // request type `queryZodValidator` publishes (see validators.ts on why the request side falls
  // back to the schema's output), which would have made every caller send a `?limit=` this route
  // never needed.
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function editableAutomation(definition: AutomationDefinition) {
  return {
    name: definition.name,
    description: definition.description,
    enabled: definition.enabled,
    events: definition.events,
    intervalSeconds: definition.intervalSeconds,
    filters: definition.filters,
    task: definition.task,
  };
}

/** One row of the mirrored project-route table. */
export interface ProjectRouteInfo {
  method: string;
  /** Path relative to the mount — `/runs/:id`, not `/api/runs/:id`. */
  path: string;
}

/**
 * The public API surface (spec 2026-07-23-independent-server-web-packages).
 *
 * Every route lives under this one prefix. The unversioned `/api/*` spelling the cockpit used
 * to speak was removed once the whole API was reachable here — carrying two spellings meant two
 * surfaces to keep working, and only one of them could be the typed contract. Bumping to `v2`
 * means mounting a second table beside this one, not editing route paths.
 */
const V1_PREFIX = '/api/v1';

/** Project scoping inside the versioned surface. The version is the OUTER dimension, so a
 *  consumer picks its API version once and then addresses projects inside it. */
const V1_SCOPED_PREFIX = `${V1_PREFIX}/p/:projectId`;

/**
 * The project-scoped route table of a `createApp()` app, derived from its actual registrations
 * (so it can never drift from the code): every method+path mounted under
 * `/api/v1/p/:projectId/…`, minus the scope-resolver middleware (method ALL), deduped. The
 * alias-parity suite iterates this to assert `/api/v1/<path>` ≡ `/api/v1/p/<boot>/<path>` ≡
 * `/api/v1/p/default/<path>`.
 */
export function projectRouteManifest(app: Hono): ProjectRouteInfo[] {
  const seen = new Set<string>();
  const manifest: ProjectRouteInfo[] = [];
  for (const route of app.routes) {
    if (route.method === 'ALL' || !route.path.startsWith(`${V1_SCOPED_PREFIX}/`)) continue;
    const path = route.path.slice(V1_SCOPED_PREFIX.length);
    const key = `${route.method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    manifest.push({ method: route.method, path });
  }
  return manifest;
}

/** 409 body for the inbox mutators while the follow-up inbox is off (#471). */

/** 409 body for every automations route while GitHub automations are off (#801). */
const AUTOMATIONS_OFF = 'GitHub automations are disabled — set CEZ_AUTOMATIONS=1 to enable them';

// ---- variant-compare response shapes (spec 010) ----------------------------
// Named and exported so `api-types.test.ts` can drift-guard the cockpit's
// hand-mirrored copies (`web/app/src/api/types.ts`) against the real thing.

/** One column of `GET /api/groups/:groupId`. NOTE: `diffStat` here is the raw
 *  `git diff --stat` text (worktreeDiffStat), NOT the numeric `RunRecord.diffStat`. */
/** `GET /api/projects` (multi-project spec) — the workspace registry with
 *  per-root status probes. Absolute `root`s belong HERE (same-origin, behind
 *  the cockpit) and are deliberately never mirrored into the CORS-open
 *  `/api/health` payload (#431 — see the health route). Never 404s. */
export interface ProjectsResponse {
  projects: ProjectListEntry[];
  bootProject: string;
  projectsDir: string;
}

/** `POST /api/projects` (multi-project spec, step 4.2) — the folder-browser
 *  dialog's commit step. The entry carries the same `status`/`branch` probe
 *  `GET /api/projects` attaches, so the cockpit sees one project shape.
 *  `error` is present ONLY on the 409 (already registered), where `project` is
 *  the EXISTING entry — the dialog navigates to it instead of dead-ending. */
export interface RegisterProjectResponse {
  project: ProjectListEntry;
  error?: string;
}

/** `DELETE /api/projects/:projectId` (multi-project spec, step 4.4) — the
 *  Projects settings pane's Remove. DEREGISTRATION ONLY: the entry leaves
 *  `~/.cezar/config.json` and nothing under the project root is read, moved or
 *  deleted. `removed` is always true on a 200 (the failure paths are 404/409). */
export interface RemoveProjectResponse {
  removed: true;
  id: string;
}

/** `PATCH /api/projects/:projectId` (spec 2026-07-22-per-project-concurrency)
 *  — sets or clears a project's per-project `maxParallel`. The entry carries
 *  the same `status`/`branch` probe `GET /api/projects` attaches, so the
 *  cockpit sees one project shape. `null` in the request clears the override
 *  back to "inherit the workspace cap". */
export interface UpdateProjectResponse {
  project: ProjectListEntry;
}

/** `GET/PUT /api/workspace/config` (multi-project spec, step 2.7) — the
 *  settings slice of `~/.cezar/config.json`: global knobs ONLY, never the
 *  project registry (that is `GET /api/projects`' job). */
export interface WorkspaceConfigResponse {
  /** Root exposed by the Add project directory browser (`~` kept). */
  browseRoot: string;
  /** Checkout root for GUI-cloned projects — stored as written (`~` kept). */
  projectsDir: string;
  /** Stored override; null means inherit CEZ_SKILLS_AUTO_UPDATE, then true. */
  skillsAutoUpdate: boolean | null;
  effectiveSkillsAutoUpdate: boolean;
  composerDefaults: {
    autonomous: boolean | null;
    worktree: boolean | null;
    inheritedAutonomous: boolean | 'source-dependent';
    inheritedWorktree: boolean;
  };
  resources: {
    maxParallel: number;
    maxMonitoringSessions: number;
    monitoringWakeIntervalMinutes: number | null;
    autoResumeOnUsageLimit: boolean;
    memoryLimitMb: number | null;
    worktreeRetentionDefault: number;
  };
  /** What a repo that has set none of its own runs (spec 2026-07-29-agent-profiles). Both keys
   *  optional: absent means "no opinion", which must stay distinguishable from a chosen value. */
  agentDefaults: {
    runner?: ProviderId;
    models?: { claude?: string; codex?: string; opencode?: string };
  };
}

// ---- workspace SSE (multi-project spec, step 2.8) --------------------------

/** Workspace-level event names carried ONLY on `GET /api/workspace/events`
 *  (never on the per-project streams): registry mutations, the GUI-clone
 *  progress feed (step 4.3), and host-wide unstamped provider status. */
export type WorkspaceEventName =
  | 'project-added'
  | 'project-removed'
  | 'checkout-progress'
  | 'provider-status'
  | 'automation-change';

/**
 * The in-process bus for workspace-level SSE events. The registry-mutating
 * routes (`POST /api/projects` — step 4.2, emits `project-added` for a
 * genuinely new entry; `DELETE /api/projects/:projectId` — step 4.4) and the
 * checkout flow (step 4.3) call `emit()`; runtime provider auth observation
 * emits host-wide `provider-status`; every open `/api/workspace/events` stream
 * relays the event verbatim under its name. Injectable via
 * `ServerDeps.workspaceEvents` so tests (and any out-of-createApp emitter) can
 * drive the stream.
 */
export class WorkspaceEventBus {
  private readonly listeners = new Set<(event: WorkspaceEventName, data: unknown) => void>();

  emit(event: WorkspaceEventName, data: unknown): void {
    for (const listener of [...this.listeners]) listener(event, data);
  }

  /** Subscribe; returns an unsubscribe. */
  on(listener: (event: WorkspaceEventName, data: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** streamSSE with the anti-buffering contract (#424): hono's own header is a
 *  bare `no-cache`, which lets an intermediary (reverse proxy, compression
 *  middleware, corporate MITM) transform-buffer the stream — the client then
 *  sees a silently frozen transcript while the server keeps writing. Headers
 *  are set on the returned Response because hono's helper overwrites
 *  `Cache-Control` set via `c.header()` before it. */
const streamSSENoBuffer: typeof streamSSE = (c, cb, onError) => {
  const res = streamSSE(c, cb, onError);
  res.headers.set('Cache-Control', 'no-cache, no-transform');
  res.headers.set('X-Accel-Buffering', 'no');
  return res;
};

// A run starts from a named workflow, an inline chain of steps (spec 008 — the approved plan is
// posted as-is, never written to a file), or neither — which falls back to quick-task server-side
// (2026-08-15, the composer's "None" pill item). Naming BOTH is still refused, below.
const startRunSchema = z
  .object({
    workflow: z.string().min(1).optional(),
    steps: z.array(workflowStepSchema).min(1).max(8).optional(),
    // The primary agent prompt handed to the spawned runner. Bounded like the
    // other prompt fields (`systemPrompt` 20k, message `text` 100k) so an
    // unbounded body can't be piped into a spawned process (#429). 100k chars
    // (~25k tokens) is well past any hand-written task.
    task: z.string().min(1).max(100_000, 'must be at most 100000 characters'),
    model: z.string().optional(),
    // Agent backend for this task (falls back to config `defaultRunner`).
    runner: z.enum(RUNNER_IDS).optional(),
    // Agent account for this task (spec 2026-07-29-agent-profiles). Falls back to the project's
    // own selection, then the discovered default. Bounded like a profile id in the workspace
    // schema, so a value this route accepts can never be degraded away by the next load.
    agentProfile: z.string().max(64).optional(),
    // Parallel variants (spec 010): ×2/×3 runs the task as 2–3 competing
    // agents in separate worktrees; the user compares diffs and picks one.
    variants: z.number().int().min(1).max(3).optional(),
    // Composer worktree opt-out (#worktree-toggle): false runs in the repo
    // working tree. Ignored when variants > 1.
    worktree: z.boolean().optional(),
    // Autonomous mode (#autonomous): the run never parks at `waiting` — it
    // auto-continues until the agent signals done. No "needs you" is raised.
    autonomous: z.boolean().optional(),
    // Generate follow-up inbox entries (spec 007, #444). Honoured only while
    // the `followups` capability is on (#471) — off, the server pins it to
    // false whatever the client asked for. Omitted still means "enabled" for
    // old clients, but only within an already-enabled server. The handoff
    // journal is unaffected either way.
    generateFollowups: z.boolean().optional(),
    // Per-run system-prompt override (R2 2.3) — programmatic callers only
    // (bookmarklets, scripts); deliberately NOT a composer-UI control. Wins
    // over the config.json default; whitespace-only degrades to absent.
    systemPrompt: z
      .string()
      .trim()
      .max(20_000, 'must be at most 20000 characters')
      .optional()
      .transform((s) => (s ? s : undefined)),
    // Screenshots pasted into the new-task form — same shape and limits as a
    // live-session message; delivered with the first agent step's opening.
    images: z
      .array(
        z.object({
          mediaType: z.string().regex(/^image\//),
          // ~5 MB per image once base64-decoded.
          data: z.string().min(1).max(7_000_000),
        }),
      )
      .max(4)
      .optional(),
    // Inbox follow-up (#374): the todo the composer was prefilled from
    // (`/new?skill=&ref=&todo=t1`). On a successful start the entry is marked
    // started — the same bookkeeping POST /api/todos/:id/start does, so the
    // audit trail survives the composer detour. Bounded like every other
    // string here; a todo id is a short generated key.
    todoId: z.string().min(1).max(200, 'must be at most 200 characters').optional(),
  })
  .refine((b) => !(b.workflow && b.steps), {
    message: 'provide "workflow" or "steps", not both',
  });

const pickSchema = z.object({
  runId: z.string().min(1),
});

const planSchema = z.object({
  // Same bound as `startRunSchema.task` — this flows into `planChain` (#429).
  task: z.string().trim().min(1).max(100_000, 'must be at most 100000 characters'),
});

// A saved workflow carries full `steps` OR the builder's `skills` stack
// (spec 012). `overwrite: true` is the builder's Save on an existing file —
// the GUI asks first; a plain POST still refuses to clobber.
const saveWorkflowSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    // Written into a YAML file on disk (#429) — a workflow description is a
    // short blurb, so a 2k cap is generous without allowing a file-bloat write.
    description: z.string().max(2_000, 'must be at most 2000 characters').optional(),
    steps: z.array(workflowStepSchema).min(1).max(8).optional(),
    skills: z.array(z.string().trim().min(1)).min(1).max(8).optional(),
    overwrite: z.boolean().optional(),
  })
  .refine((b) => Boolean(b.steps) !== Boolean(b.skills), {
    message: 'provide either "steps" or "skills", not both',
  });

const parseWorkflowSchema = z.object({
  yaml: z.string().min(1).max(100_000),
});

// Small GUI preferences persisted in `.ai/cezar/ui-state.json` (files, not a
// DB): today just the last-used task source, so the form preselects what you
// actually run. Unknown keys pass through — future prefs won't need a schema
// dance.

/** Entry cap on the `skillUsage` map (#408). A real skill catalog is dozens of entries; this
 *  bounds the ui-state.json write without ever rejecting a legitimate one. */
const SKILL_USAGE_MAX_ENTRIES = 200;

// Belt-and-braces cap on the number of top-level ui-state keys so a
// `.passthrough()` schema can't accumulate an unbounded key set (#429). Very
// generous for GUI prefs; over-limit is a 400, never a silent strip. Shared by
// BOTH ui-state routes (per-repo and workspace) via `parseUiStateBody`.
const UI_STATE_MAX_KEYS = 200;

/** Settings → Appearance (redesign R6): accent + density + reading width. ONE
 *  schema for both ui-state files — per-repo (the legacy home, kept so an older
 *  cezar in the same repo still honours it) and workspace
 *  (`~/.cezar/ui-state.json`, its post-migration home — multi-project spec,
 *  Data Model).
 *
 *  Every key is `.optional()` so an older ui-state.json parses unchanged, but
 *  each one must be listed HERE: the enclosing `workspaceUiStateSchema` is
 *  `.passthrough()` at the top level only, so an unlisted key inside
 *  `appearance` is stripped by zod and then wiped from the file by the shallow
 *  merge-on-write. The cockpit adopts the PUT response as authoritative, so a
 *  stripped key does not merely fail to persist — it visibly reverts the
 *  control the user just touched. Adding an appearance preference means adding
 *  it here in the same change. */
const appearanceSchema = z.object({
  accent: z.enum(['lime', 'violet']).optional(),
  density: z.enum(['comfortable', 'compact', 'ultra']).optional(),
  width: z.enum(['narrow', 'wide']).optional(),
});

const uiStateSchema = z
  .object({
    // `null` is the composer's "None" pick (2026-08-15) persisted as a sticky default — distinct
    // from absent ("nothing chosen yet"), which resolves the same cold-default way. A stored
    // value from before this change is a plain object and still parses, so no migration runs.
    lastTask: z
      .object({
        source: z.enum(['workflow', 'skill']),
        ref: z.string().min(1).max(200),
      })
      .nullable()
      .optional(),
    // Composer picker recency (newest first, capped) + the remembered worktree
    // choice for single-skill runs. Additive prefs, like the rest of ui-state.
    recentSources: z
      .array(
        z.object({
          source: z.enum(['workflow', 'skill']),
          ref: z.string().min(1).max(200),
        }),
      )
      .max(50)
      .optional(),
    lastWorktree: z.boolean().optional(),
    lastAutonomous: z.boolean().optional(),
    lastGenerateFollowups: z.boolean().optional(),
    // Skill selection frequency (#408): name → times chosen, incremented on a successful run
    // start from EITHER composer (`/new`'s SourcePill and the follow-up `SkillsPicker`). Drives
    // the shared `orderSkillsByUsage` sort (web/app/src/lib/skills.ts) so both pickers float the
    // skills a user actually reaches for above the rest, within the existing project-first
    // grouping. ADDITIVE, like the rest of ui-state — the client always PUTs the whole map
    // because the top-level merge below is shallow.
    //
    // Bounded on all three axes (key length, value, entry count) like every neighbour here: this
    // map is written straight to `ui-state.json`, which the cockpit GETs on every load and this
    // route re-reads on every PUT, so an unbounded map is an unbounded file write. Keys are skill
    // names (`.min(1).max(200)`, matching `lastTask.ref`); SKILL_USAGE_MAX_ENTRIES sits far above
    // any real catalog while capping the file at a few tens of KB.
    skillUsage: z
      .record(z.string().min(1).max(200), z.number().int().min(0).max(1_000_000))
      .refine((usage) => Object.keys(usage).length <= SKILL_USAGE_MAX_ENTRIES, {
        message: `skillUsage must have at most ${SKILL_USAGE_MAX_ENTRIES} entries`,
      })
      .optional(),
    // Runs area presentation (#348): the sidebar-list + detail pane, or the
    // full-width table ("task manager") view.
    runsView: z.enum(['list', 'table']).optional(),
    // The GitHub tab's last-selected sub-tab (#417): issues or PRs. ADDITIVE — an old
    // ui-state.json without the key behaves as the default (issues).
    githubView: z.enum(['issues', 'prs']).optional(),
    // Settings → Appearance (redesign R6): accent + density. ADDITIVE — the theme itself
    // stays in the browser (`cez-theme` localStorage, pre-paint). The cockpit always PUTs
    // the whole object because the top-level merge below is shallow.
    appearance: appearanceSchema.optional(),
    // Follow-up prompt templates (#413): reusable snippets insertable into the GitHub hand-over
    // and Inbox follow-up composers. Absent → the client's built-in defaults; present (even `[]`)
    // is the user's own edited list, from Settings → Prompt templates. Additive, like the rest of
    // ui-state — the cockpit is the only writer, so validation stays generous but bounded.
    promptTemplates: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          label: z.string().trim().min(1).max(80),
          text: z.string().trim().min(1).max(2000),
          // Skill names this template auto-applies for. Optional and additive: templates
          // written before this key existed keep validating, and stay manual-only.
          skills: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
        }),
      )
      .max(50)
      .optional(),
    // Skills promo banner (#391): set once the cockpit banner is dismissed, never unset.
    // Server-persisted (not a cookie) so the "shown once" promise holds across browsers.
    // Retained for backward compatibility — the banner is gone, replaced by the workspace-level
    // `importedSkills` curation (see `workspaceUiStateSchema`); `.passthrough()` would preserve
    // the key regardless, but keep it typed.
    dismissedSkillsBanner: z.boolean().optional(),
  })
  .passthrough();

// Editable titles (#389), and the initial prompt while the run is still queued
// (#472 — rejected with 409 on any other status by the handler).
const patchRunSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  task: z.string().trim().min(1).max(100_000).optional(),
});

// Session commit (redesign R5 — §"Git/session API additions").
const gitCommitSchema = z.object({
  message: z.string().trim().min(1, 'must not be empty').max(5_000),
});

// "Open in…" (#open-in / #365): `target` selects the app; `path` (optional, worktree-relative)
// narrows the target's own worktree/repo-root default to one file — used by the diff pane's
// "open in default app" action for images. Containment is re-checked server-side via
// `readWorktreePath`; this schema only shapes the request.
const openInSchema = z.object({
  // A short bound (#429): matched against a downstream allowlist, so an editor id is never long.
  target: z.string().trim().min(1, 'target required').max(200),
  path: z.string().max(1_000).optional(),
});

const imageInputSchema = z.object({
  mediaType: z.string().regex(/^image\//),
  // ~5 MB per image once base64-decoded.
  data: z.string().min(1).max(7_000_000),
});

const messageSchema = z
  .object({
    text: z.string().max(100_000).default(''),
    images: z.array(imageInputSchema).max(4).default([]),
  })
  .refine((m) => m.text.trim().length > 0 || m.images.length > 0, {
    message: 'message needs text or at least one image',
  });

// PATCH semantics are load-bearing here: an omitted field keeps its current value.
// In particular, the cockpit edits text without re-uploading existing attachments.
const queuedMessagePatchSchema = z
  .object({
    text: z.string().max(100_000).optional(),
    images: z.array(imageInputSchema).max(4).optional(),
  })
  .refine((m) => m.text !== undefined || m.images !== undefined, {
    message: 'message edit needs text or images',
  });

// Queued prompt stack bounds (#472). The per-message bounds mirror `messageSchema`
// above; the one that actually matters is the FOLDED total, because 20 messages of
// 100 000 chars each would otherwise compose a ~2 M-character {{task}}.
const MAX_QUEUED_MESSAGES = 20;
const MAX_QUEUED_IMAGES = 8;
const MAX_FOLDED_TASK_CHARS = 200_000;

/** Length of the prompt a run would execute with — `task` plus its whole stack,
 *  composed exactly as `hydrateQueuedInput` composes it. Checked against the
 *  PROSPECTIVE state so the user is stopped at the write, not at dequeue where
 *  there would be no one left to tell. */
function foldedLength(task: string, stack: Array<{ text: string }>): number {
  return [task, ...stack.map((m) => m.text)]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n\n').length;
}

// "Continue"/"Send back" body (spec 003 / #401): every field optional, so an empty POST reopens
// the last session on the run's current backend (backward compat). A runner/model override lets
// the follow-up composer choose which engine handles the continuation. `text` stays bounded like
// the live-session message `text` (#429), and `images` like a live-session message's — the
// follow-up composer is a full composer, so a screenshot pasted into it must reach the reopened
// session rather than being silently dropped.
const continueSchema = z.object({
  text: z.string().max(100_000, 'must be at most 100000 characters').optional(),
  images: z.array(imageInputSchema).max(4).optional(),
  runner: z.enum(RUNNER_IDS).optional(),
  model: z.string().max(200).optional(),
});

// Inbox "▶ Run" body (spec 007 / #401 / #413): every field optional, and the whole body is
// optional too, so an empty POST — every client before the pills and the composer — starts on
// the host's `defaultRunner` with no extra instructions, exactly as before. This is a START
// path, not a continue: there is no prior backend to preserve, so an omitted `runner`/`model`
// means "host default" rather than "keep what the run had". `prompt` (#413) is extra
// instructions appended to the entry's suggested/summary task text; whitespace-only degrades to
// absent so it never touches `task`.
const startTodoSchema = z
  .object({
    runner: z.enum(RUNNER_IDS).optional(),
    model: z.string().max(200).optional(),
    prompt: z
      .string()
      .trim()
      .max(20_000, 'must be at most 20000 characters')
      .optional()
      .transform((s) => (s ? s : undefined)),
  })
  .optional();

/** Hono env for `POST /todos/:id/start`: the guard in front of that route publishes the resolved
 *  entry so the handler does not re-read `todos.json` a second time in the same request. */
type TodoStartEnv = ProjectApiEnv & { Variables: { todo: TodoItem } };

// `POST /api/runs/:id/archive` (#429) — no body archives; `{archived:false}`
// un-archives. A tiny schema so the route follows the safeParse convention.
const archiveSchema = z.object({
  archived: z.boolean().optional(),
});

// Request-body size guards (#429). A generous global cap keeps a single
// localhost request from being unbounded (the largest legit body is 4 pasted
// images at ~7 MB base64 each); the ui-state PUT gets a much tighter cap since
// it only ever carries small GUI prefs.
const GLOBAL_BODY_LIMIT = 32 * 1024 * 1024; // 32 MiB
const UI_STATE_BODY_LIMIT = 128 * 1024; // 128 KiB

/** The name half of a Host header — `localhost:4321` → `localhost`,
 *  `[::1]:4321` → `[::1]`. A bracketed IPv6 literal keeps its brackets
 *  (`isLoopbackHost` strips them itself); an unbracketed IPv6 spelling is
 *  nonstandard in a Host header and simply fails the loopback test closed. */
function stripHostPort(host: string): string {
  const bracketed = /^(\[[^\]]+\])(?::\d+)?$/.exec(host);
  if (bracketed?.[1]) return bracketed[1];
  return host.replace(/:\d+$/, '');
}

/** The shared write-side half of BOTH ui-state routes (per-repo `/api/v1/ui-state`
 *  and workspace `/api/v1/workspace/ui-state`) — the factored split the
 *  multi-project spec calls for instead of a copy: the route's own schema, plus a
 *  cap on the top-level key count so a `.passthrough()` schema can't accumulate an
 *  unbounded key set (#429). The cap rides as a refinement so the whole thing is one
 *  schema and can go through `jsonBody` like every other mutating route. The
 *  merge-on-write stays with each route (they write different files) but is shallow
 *  in both. */
function capUiStateKeys(data: unknown, ctx: z.RefinementCtx): void {
  if (Object.keys(data as Record<string, unknown>).length > UI_STATE_MAX_KEYS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `ui-state has too many keys (max ${UI_STATE_MAX_KEYS})` });
  }
}

// Derived once per route instead of by a generic `wrap(schema)` helper called at the route: a
// generic wrapper leaves the schema type unresolved where `jsonBody` needs it, and Hono answers
// that by dropping the whole PUT from the route schema rather than erroring — both ui-state PUTs
// silently vanished from `AppType`. Concrete consts keep them visible to `hc`.
const uiStateBody = uiStateSchema.superRefine(capUiStateKeys);

/**
 * Query schemas for the READ routes — deliberately permissive.
 *
 * These exist to make a query key VISIBLE to the route type (`hc` refuses a `query` argument for
 * a key no validator declares), NOT to narrow what the route accepts. Every one of these handlers
 * compares `=== '1'` and treats everything else as false, so `?refresh=0` is a successful request
 * today; a literal schema would silently turn it into a 400. The comparison stays in the handler
 * and the validator stays out of its way.
 *
 * The one route that really is strict on the wire — `GET /github/prs/:number/changes`, which 400s
 * on `?refresh=true` — keeps its own `z.enum(['1'])` schema next to the route.
 */
/**
 * One query value, matching what `c.req.query('k')` did before these routes were validated.
 *
 * Hono's query validator hands a REPEATED key as an array (`?wait=1&wait=1` → `['1','1']`), where
 * `c.req.query()` silently took the first. A plain `z.string()` therefore turns a request that
 * used to answer 200 into a 400 — a wire change no caller asked for. Collapsing to the first
 * value keeps the old behaviour, and the client still sees a plain `key?: string`.
 */
const queryValue = z.union([z.string(), z.array(z.string()).transform((v) => v[0] as string)]).optional();

const refreshQuery = z.object({ refresh: queryValue });
const waitQuery = z.object({ wait: queryValue });

/**
 * HTTP content negotiation for the two routes that serve more than one FORMAT on one path:
 * `GET /repo/commit/:sha` (a structured payload or the legacy text blob) and
 * `GET /runs/:id/files` (a JSON listing/metadata or an image file's BYTES).
 *
 * ## Precedence — flag, then Accept, then the route's own default
 *
 * 1. **The query flag wins whenever the request carries it.** `?structured=1` and `?raw=1` are the
 *    live wire and a protected surface (BACKWARD_COMPATIBILITY.md §2); `Accept` is ADDITIVE and
 *    may never override a caller that said what it wanted in the URL. The flag counts as "carried"
 *    when the key is PRESENT, so `?raw=0` is an explicit opt-out of the raw representation and not
 *    an invitation to re-decide from a header.
 * 2. **Otherwise the best `Accept` match** among the representations that route offers.
 * 3. **Otherwise the route's established default** — the text blob for `/repo/commit/:sha`, the
 *    JSON listing for `/runs/:id/files` — i.e. exactly what a pre-Accept client received.
 *
 * `*<slash>*` matches NOTHING here, deliberately: it is what `fetch`, `curl` and XHR send when
 * they have no preference at all, and treating "anything" as a preference would silently change
 * the default representation of both routes for every existing caller. A browser that navigates to
 * a worktree image DOES get the bytes, because its `Accept` really does ask for `image/*` at q=1 —
 * the same protections ride along (image extensions only, size cap, `nosniff`, sandbox CSP).
 *
 * Both routes answer `Vary: Accept`, since a cache that ignored the header would serve one
 * representation for the other.
 */
type MediaRange = { type: string; subtype: string; q: number };

function parseAccept(header: string): MediaRange[] {
  const ranges: MediaRange[] = [];
  for (const part of header.split(',')) {
    const [range = '', ...params] = part.split(';');
    const [type = '', subtype = ''] = range.trim().toLowerCase().split('/');
    if (type === '' || subtype === '') continue;
    const weight = params.map((p) => p.trim().toLowerCase()).find((p) => p.startsWith('q='));
    const parsed = weight === undefined ? 1 : Number.parseFloat(weight.slice(2));
    const q = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0;
    if (q > 0) ranges.push({ type, subtype, q });
  }
  return ranges;
}

/**
 * The best of `offers` for this `Accept`, or `null` for "no preference expressed" — which is what
 * an absent header, a `*<slash>*`-only header and a header naming nothing on offer all mean, and
 * what leaves the caller on its route's default.
 *
 * `offers` is the server's own preference order: an offer may itself be a wildcard (`image/*`,
 * since the concrete image type is not known until the file is read), and equal q-values go to the
 * EARLIER offer, so each route lists its default representation first.
 */
function negotiate<O extends string>(accept: string | undefined, offers: readonly O[]): O | null {
  if (accept === undefined) return null;
  const ranges = parseAccept(accept);
  let best: { offer: O; q: number } | null = null;
  for (const offer of offers) {
    const [type = '', subtype = ''] = offer.split('/');
    let q = 0;
    for (const range of ranges) {
      if (range.type === '*' && range.subtype === '*') continue; // "anything" is not a preference
      const typeMatches = range.type === type || range.type === '*' || type === '*';
      const subtypeMatches = range.subtype === subtype || range.subtype === '*' || subtype === '*';
      if (typeMatches && subtypeMatches && range.q > q) q = range.q;
    }
    if (q > 0 && (best === null || q > best.q)) best = { offer, q };
  }
  return best?.offer ?? null;
}

/** What `GET /repo/commit/:sha` offers, DEFAULT FIRST: the legacy `text/plain` blob is what a
 *  request with no opinion has always received (§2), so it also wins an Accept tie. */
const COMMIT_FORMATS = ['text/plain', 'application/json'] as const;

/** What `GET /runs/:id/files` offers, DEFAULT FIRST. `image/*` rather than a concrete type: which
 *  image type the bytes are is only known once the path resolves, and the raw branch refuses
 *  everything that is not an image anyway. */
const FILE_FORMATS = ['application/json', 'image/*'] as const;

/** Workspace-root writability probe (multi-project spec, "API Contracts"):
 *  optional `mkdir -p`, `access W_OK`, then a real create/delete round-trip — W_OK alone
 *  can lie (e.g. a read-only mount still reports writable permission bits).
 *  Returns the failure message, or null when the directory is usable. */
async function probeWritableDir(dir: string, create: boolean): Promise<string | null> {
  const probe = join(dir, `.cez-write-probe-${process.pid}-${Date.now().toString(36)}`);
  try {
    if (create) await mkdir(dir, { recursive: true });
    const info = await stat(dir);
    if (!info.isDirectory()) return `${dir} is not a directory`;
    await access(dir, fsConstants.W_OK);
    await writeFile(probe, '', 'utf8');
    await unlink(probe);
    return null;
  } catch (err) {
    await unlink(probe).catch(() => {}); // best-effort if the round-trip half-succeeded
    return err instanceof Error ? err.message : String(err);
  }
}

// The return type is INFERRED on purpose: it is the chained app type built at the bottom of
// this function, and `AppType` (src/server/app-type.ts) is `ReturnType<typeof createApp>`.
// Annotating it `Hono` here would erase every route from the type and leave the typed client
// with nothing to offer. See the `routed` assembly at the end of the function.
export function createApp(deps: ServerDeps) {
  const { version, update, bindHost, bootProjectId, sessionResolver } = deps;
  // Boot singletons keep DELIBERATELY distinct names (`boot*`): every
  // project-scoped handler must resolve its `{store, manager, root, dataDir,
  // launchKey}` from `c.get('project')` — a bare `store`/`repoRoot` in a
  // handler body would silently pin it to the boot project, which the rename
  // turns into a compile error instead.
  const bootRoot = deps.repoRoot;
  const bootDataDir = join(bootRoot, '.ai/cezar');
  const modelCatalog = deps.modelCatalog ?? new RunnerModelCatalog({
    adapters: {
      codex: { discover: () => discoverCodexModels({ cwd: bootRoot }) },
      opencode: { discover: () => discoverOpencodeModels({ cwd: bootRoot }) },
    },
  });
  const providerAuth = deps.providerAuth ?? new ProviderAuthService();
  const workspaceConfig = deps.workspaceConfig ?? {
    load: loadWorkspaceConfig,
    mergeWrite: mergeWriteWorkspaceConfig,
  };
  const providerStatus = async (options?: { refresh?: boolean }): Promise<ProviderStatusResponse> => {
    if (providerAuthChecksDisabled()) {
      return applyProviderEnablement(
        await providerAuth.status(options?.refresh ? { refresh: true } : undefined),
        [],
      );
    }
    const [discovered, workspace] = await Promise.all([
      providerAuth.status(options?.refresh ? { refresh: true } : undefined),
      workspaceConfig.load(),
    ]);
    return applyProviderEnablement(discovered, workspace.disabledProviders);
  };
  /**
   * The gate: why a run cannot start against `required`, or null when it can.
   *
   * VERIFY BEFORE YOU REFUSE. Auth state is served stale-while-revalidate (see
   * `ProviderAuthService.status`), so a cached "disconnected" may predate a login cezar could not
   * observe — someone running `claude auth login` in a terminal. Refusing on that would lock a user
   * out of their own cockpit with no way back but waiting. So a believed-unavailable provider is
   * re-probed, and only a refusal that survives the fresh answer is returned.
   *
   * The cost lands where it belongs: the common path (connected, warm) pays nothing at all, and the
   * probe is only spawned when cezar is about to say no — a rare, interactive moment. This is also
   * what lets the cache hold a negative for a minute instead of five seconds, which is what made
   * every reader of `GET /providers/status` periodically pay for a CLI spawn.
   *
   * A runtime auth latch is deliberately NOT escaped by this: `withRuntimeFailures` keeps forcing
   * the row disconnected until the user acknowledges that exact incident, so the re-probe cannot
   * talk cezar out of a rejection it actually observed.
   */
  const providerActionError = async (
    required: readonly ProviderId[],
  ): Promise<string | null> => {
    const known = await providerStatus();
    const message = unavailableProviderMessage(required, known);
    if (message === null) return null;
    // A DISABLED provider is a settings fact, not a probe result — re-probing it learns nothing and
    // would spawn a CLI to re-read something the user typed.
    const disabled = required.some((provider) =>
      known.providers.find((row) => row.provider === provider)?.enabled === false);
    if (disabled) return message;
    return unavailableProviderMessage(required, await providerStatus({ refresh: true }));
  };
  const openTerminal = deps.openTerminal ?? openInTerminal;
  const openFile = deps.openFile ?? openFileInDefaultApp;
  const openApp = deps.openApp ?? openInApp;
  const skillsUpdate = deps.skillsUpdate ?? new SkillsUpdateService();

  // ---- workspace boot-project identity (multi-project spec) ----------------
  // The boot flow (`initWorkspace` in src/index.ts) registers the boot repo
  // and plumbs its registry id in via `deps.bootProjectId`. Legacy callers and
  // tests construct the app without one — then it is derived lazily from the
  // registry by realpath and cached on a hit. A boot repo that is legitimately
  // unregistered (task worktree, `$HOME` itself, unreadable workspace) falls
  // back to its would-be slug, so `bootProject` always names the repo this
  // server was started in. Strictly non-fatal, zero-config: every failure path
  // degrades to the slug fallback, never an error.
  let bootProjectCache = bootProjectId;
  const resolveBootProject = async (projects?: readonly WorkspaceProject[]): Promise<string> => {
    if (bootProjectCache) return bootProjectCache;
    let registry = projects ?? [];
    try {
      registry = projects ?? (await loadWorkspaceConfig()).projects;
      const real = await realpath(bootRoot).catch(() => bootRoot);
      const match = registry.find((p) => p.root === real || p.root === bootRoot);
      if (match) bootProjectCache = match.id;
    } catch {
      // unreadable workspace — fall through to the slug fallback below
    }
    return bootProjectCache ?? allocateProjectSlug(bootRoot, registry.map((project) => project.id));
  };
  // Health's workspace garnish: id+name ONLY — never `root` (#431, see the
  // health route). Reads only the registry file; no per-root status probes,
  // so health stays cheap enough for the bookmarklet's 800 ms port sweep.
  const workspaceSummary = async (): Promise<{
    projects: { id: string; name: string }[];
    bootProject: string;
  }> => {
    try {
      const registry = (await loadWorkspaceConfig()).projects;
      const bootProject = await resolveBootProject(registry);
      const visible = capabilities().singleProject
        ? registry.filter((project) => project.id === bootProject)
        : registry;
      return {
        // Explicit picks, not a spread: the registry schema passes unknown
        // keys through, and `root` must never ride along onto health.
        projects: visible.map((p) => ({
          id: p.id,
          name: p.name || basename(p.root),
        })),
        bootProject,
      };
    } catch {
      return { projects: [], bootProject: await resolveBootProject([]) };
    }
  };
  // Hosted-mode gate (spec §"Deployment modes") — read per request so
  // CEZ_REMOTE flips take effect live (and tests can toggle it).
  const capabilities = () => resolveCapabilities(process.env, bindHost);
  const singleProjectRefusal = (
    action: 'adding projects' | 'editing projects' | 'removing projects' | 'folder browsing',
  ) => ({ error: `single-project mode is enabled; ${action} is disabled` });
  // Inbox live updates (spec 007). Opt-in (#471): no capability, no watcher —
  // and since step 2.3 the per-dataDir watch is created lazily by the first
  // SSE subscription (and torn down with the last), nothing to start here.

  // ---- project contexts (multi-project spec, step 2.2) ---------------------
  // The boot project's context is SEEDED from the deps the caller already
  // built (src/index.ts `serveCommand` did the recover/prune/launch-key work
  // at startup — observable boot behavior unchanged); it never enters the
  // lazy map, so its `.ai/cezar` state is never double-opened. `id` starts as
  // the reserved alias when registration was suppressed — handlers never read
  // it; API payloads name the boot project via `resolveBootProject` instead.
  //
  // The flag-gated stores come from the SAME activator `ProjectContexts.build()`
  // uses, never a second copy inlined here. They were missing entirely until
  // 2026-08-06: `build()` activated them and this literal did not, so with
  // `CEZ_KB=1` the knowledge base was live on every project except the boot one
  // — which `resolveProjectScope` serves for unscoped requests, for `default`,
  // and for the boot project's own id. See `activateOptionalStores`.
  const bootContext: ProjectContext = {
    id: bootProjectId ?? 'default',
    root: bootRoot,
    dataDir: bootDataDir,
    store: deps.store,
    manager: deps.manager,
    automationStore: deps.automationStore ?? AutomationStore.open(bootDataDir),
    ...activateOptionalStores({
      env: process.env,
      projectId: bootProjectId ?? 'default',
      root: bootRoot,
      dataDir: bootDataDir,
      bindHost,
    }),
    launchKey: ensureLaunchKey(bootDataDir), // bookmarklet auto-start secret (spec 011)
  };
  // Non-boot projects build lazily on first scoped request; their managers
  // count against the same workspace semaphore as the boot manager (step 2.5).
  const contexts = deps.contexts ?? new ProjectContexts({
    listProjects: async () => {
      const selector = capabilities().singleProject
        ? { projectId: await resolveBootProject() }
        : undefined;
      return listProjects(selector);
    },
    semaphore: deps.semaphore,
  });
  // Workspace-level SSE bus (step 2.8) — the registry mutators and the
  // checkout flow (Phase 4) emit here; /api/workspace/events relays.
  const workspaceEvents = deps.workspaceEvents ?? new WorkspaceEventBus();
  const emitAutomationChange = (
    project: ProjectContext,
    automationId: string,
    revision: number,
    deleted = false,
  ) => workspaceEvents.emit('automation-change', {
    project: project.id,
    automationId,
    revision,
    ...(deleted ? { deleted: true } : {}),
  });
  const automationsChanged = () => deps.automationsChanged?.();

  const providerRuntimeAuth = deps.providerRuntimeAuth
    ?? new ProviderRuntimeAuthObserver(providerAuth, (status) => {
      workspaceEvents.emit('provider-status', status);
    });

  providerRuntimeAuth.watch(bootContext.store);
  for (const id of contexts.ids()) {
    const ctx = contexts.peek(id);
    if (ctx) providerRuntimeAuth.watch(ctx.store);
  }
  contexts.onStoreCreated((store) => providerRuntimeAuth.watch(store));
  contexts.onContextBuilt((ctx) => providerRuntimeAuth.watch(ctx.store));

  const app = new Hono();

  // Reject oversized request bodies before they reach any handler (#429). GETs
  // and SSE carry no body, so this only ever gates the mutating routes.
  app.use('*', bodyLimit({ maxSize: GLOBAL_BODY_LIMIT }));

  // ---- request-origin guard (#426) -----------------------------------------
  // This server executes agents with shell access — "start a task" ≈ run code
  // as the user — so "bind 127.0.0.1 + same-origin" is not a perimeter on its
  // own: any page the user visits can still POST to us (CSRF), and DNS
  // rebinding can point a foreign domain at loopback and read our responses.
  // Two zero-config checks close both holes on every /api route EXCEPT
  // /api/v1/health (the intentional cross-origin discovery endpoint, spec 011 —
  // it exposes nothing sensitive, see #431):
  //   1. Host allowlist (loopback deployments only) — a request whose Host is
  //      not a loopback name did not really originate from this machine. A
  //      rebound `evil.com` still sends `Host: evil.com`, so this kills DNS
  //      rebinding for reads AND writes. Skipped in hosted mode (CEZ_REMOTE /
  //      non-loopback bind), where the reverse proxy forwards the real public
  //      Host and TLS+auth own the perimeter.
  //      The match runs through `isLoopbackHostHeader`, whose 127.0.0.0/8 test
  //      is *anchored* and whose missing-Host answer is "untrusted". Both are
  //      load-bearing: a `startsWith('127.')` prefix would accept the
  //      attacker-registrable `127.0.0.1.evil.com`, and such a page is really
  //      same-origin with us, so checks 2 and 3 would wave it through too.
  //   2. Same-origin write guard — a cross-origin write always carries an
  //      `Origin` header (browsers attach it to every non-GET), so its full
  //      authority (host AND port) must match the served Host. A blind CSRF
  //      POST from evil.tld is rejected; the cockpit's own same-origin fetch
  //      (Origin === Host, or no Origin at all for non-browser callers) passes
  //      untouched. Works in both local and hosted mode because it compares
  //      Origin to the actual Host.
  // Scope note: check 2 covers writes only. A cross-origin GET from any site
  // still reaches the read routes — but its Host is ours, so it is a *forced
  // request*, not a read: the same-origin policy stops the attacker seeing any
  // response body (we send CORS headers on /api/v1/health alone), and no GET
  // handler mutates state. Rebinding, which WOULD make those reads legible, is
  // what check 1 stops.
  //
  // Scope: `/api/*` AND `/auth/*` (D1/D9's login family, mounted at the app root by D5 so it
  // carries no `/api/v1` segment). Registering the guard on `/api/*` alone left `/auth/*` as the
  // only route family in the app outside the perimeter, and `POST /auth/logout` as the only
  // unguarded write in the app: a page on another loopback port is same-SITE, so its `SameSite=Lax`
  // session cookie rides along and check 2 is the only thing that would have stopped it destroying
  // the session. The two registrations share ONE handler rather than being written twice — the
  // guard's semantics are the invariant, and a copy would be free to drift from it.
  const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const isHostedMode = () => !resolveCapabilities(process.env, bindHost).localHandoff;
  const originGuard = async (c: Context, next: Next) => {
    const hostName = hostnameOfHost(c.req.header('host'));
    // Strict twin of `isLoopbackHost`: a *missing* Host is untrusted here (an
    // absent header is not the "we defaulted to the loopback bind" case), and
    // the loopback match is anchored so `127.0.0.1.evil.com` does not pass.
    if (!isHostedMode() && !isLoopbackHostHeader(hostName)) {
      return c.json(
        {
          error: 'forbidden: unexpected Host header — this request did not originate from this machine (see #426)',
        },
        403,
      );
    }

    // /api/v1/health stays CORS-open for cross-origin discovery, but its Host is
    // still checked above: cross-origin is legitimate, DNS rebinding is not. The
    // path is spelled through V1_PREFIX rather than inline — an unversioned
    // literal here silently stopped matching when the API moved and left health
    // relying on the mutating-methods gate below to let its GETs through.
    if (c.req.path === `${V1_PREFIX}/health`) return next();

    if (MUTATING_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin');
      if (origin !== undefined) {
        const originHost = hostnameOfOrigin(origin);
        // Compare the whole authority, not just the hostname: a different PORT
        // is a different web origin, and on a dev machine `http://localhost:3000`
        // is every bit as foreign as `https://evil.tld`. Matching on hostname
        // alone would let any page served from another loopback port (a local
        // dev server rendering attacker content, an XSS in a local app) start a
        // shell-capable agent here.
        const sameOrigin = !!originHost && authorityOfOrigin(origin) === authorityOfHost(c.req.header('host'));
        // The one legitimate cross-port case is the `npm run dev` Vite proxy:
        // the browser fetches same-origin from `localhost:5173`, Vite's
        // `changeOrigin` rewrites Host to `127.0.0.1:<api port>` but forwards
        // the original Origin, so the authorities no longer line up. The browser
        // already told us what it thinks: `Sec-Fetch-Site: same-origin` is a
        // forbidden header name that page JS cannot set, and a cross-port
        // attacker page gets `same-site`, never `same-origin`. Requiring it
        // (plus loopback on both ends) readmits the proxy without readmitting
        // the attack. Browsers too old to send Sec-Fetch metadata simply fail
        // closed here — they still work against a non-proxied cockpit.
        const isDevProxy =
          c.req.header('sec-fetch-site') === 'same-origin' &&
          isLoopbackHostHeader(originHost) &&
          isLoopbackHostHeader(hostName);
        if (!sameOrigin && !isDevProxy) {
          return c.json(
            {
              error: 'forbidden: cross-origin request rejected (same-origin only)',
            },
            403,
          );
        }
      }
      // Belt-and-suspenders for browsers that send Sec-Fetch metadata: an
      // explicit cross-site marker is rejected regardless of the Origin dance.
      if (c.req.header('sec-fetch-site') === 'cross-site') {
        return c.json(
          {
            error: 'forbidden: cross-site request rejected (same-origin only)',
          },
          403,
        );
      }
    }
    return next();
  };
  app.use('/api/*', originGuard);
  app.use('/auth/*', originGuard);

  // ---- principal resolution (D1/D3/D6) --------------------------------------
  // Mounted on the same scope as the origin guard above, and deliberately AFTER it: an
  // unauthenticated cross-origin request is rejected by #426 before it ever reaches identity.
  //
  // `/api/v1/health` is exempt for the same reason the origin guard exempts it — it is the
  // CORS-open cross-origin discovery route (#431), reachable before a browser has any cookie
  // for this origin to send, and the bookmarklet's port-sweep depends on that.
  //
  // **CORRECTED 2026-08-07 (repair stage).** This used to add "it carries no per-principal data
  // …, so skipping identity resolution here widens nothing." True about *principals* and beside
  // the point: the payload's `projects[].name` is every registered repository's name, and with
  // `Access-Control-Allow-Origin: *` any page on the internet can READ it, not merely force the
  // request. On a hosted deployment with `CEZ_AUTH` set that is precisely what the login exists to
  // protect. The exemption stays (the route must answer without a cookie), but the *handler* now
  // redacts the project list when auth is on and the request carries no valid session — see
  // `healthRoutes` below. The auth-off payload is untouched and byte-identical.
  //
  // `c.set`/`c.get` below go through a cast to `Context<{ Variables: { principal: Principal } }>`
  // rather than through typing `app` itself with that Env: `app`'s inferred generic IS `createApp`'s
  // inferred return type (nothing here annotates it), and widening it broke assignability to
  // the plain `Hono` every one of `createApp`'s ~30 test-file callers types its own `app`
  // variable as. Phase 5 added the first real readers — `GET /projects` (`withTeams`),
  // `POST /projects` (`registerFolder`'s D4 claim), and `DELETE`/`PATCH /projects/:id`
  // (`mayActOnRoot`) — each through the same cast rather than by widening `app`'s env, which
  // stays the deliberate trade: one cast per reader against breaking ~30 callers' annotations.
  // (This comment previously said "No handler reads `c.get('principal')` yet"; corrected
  // 2026-08-07 at the repair stage, since four handlers below now do.)
  app.use('/api/*', async (c, next) => {
    if (c.req.path === `${V1_PREFIX}/health`) return next();
    const principalContext = c as unknown as Context<{ Variables: { principal: Principal } }>;
    // `resolveAuthProvider`, not `resolveCapabilities(...).auth`: which provider a deployment
    // requires is a server-side policy, not a capability the cockpit is told about, and it is
    // deliberately absent from the health payload — the spec's Risks section names a diff in the
    // auth-off health payload as a failure rather than an update, and the route-parity /
    // bc-route-inventory / versioned-surface suites are the control that only means something
    // while it stays byte-identical. `bindHost` is not a parameter here because `CEZ_AUTH` is
    // read the same way in every deployment mode (unlike `localHandoff`).
    const auth = resolveAuthProvider(process.env);
    if (auth === 'none') {
      // D3: the implicit principal goes through THIS SAME middleware, not a bypassed branch —
      // see the module-level doc comment on `Principal` for the incident that rule guards
      // against. D13: resolved FRESH every request (`resolveLocalPrincipal`'s own doc comment
      // explains why that is not per-request I/O) — and never through `sessionResolver`/a cookie,
      // so invariant 1 ("no cookie parsed, ever, in local mode") holds exactly as it did before
      // this seam existed.
      //
      // **CORRECTED 2026-08-07 (adversarial review, reported independently by four reviewers):
      // this used to call `resolveLocalPrincipal()` for EVERY request where `auth === 'none'` —
      // keyed on the PROVIDER. D13 itself says the opposite is load-bearing ("the reason must be
      // the bind, not the provider"): `hosted + CEZ_AUTH unset + CEZ_ALLOW_UNAUTHENTICATED=1` is a
      // real, permitted topology (D1's table) whose audience is a NETWORK, not one machine — and
      // keying local-org adoption on the provider let an anonymous network caller on that exact
      // topology adopt whatever local org happened to already exist under this process's
      // `<CEZ_HOME>/identity` (e.g. left behind by an earlier loopback run against the same
      // `CEZ_HOME`), with role `owner`. `local-mode-boot.ts#buildLocalModeRoutes` (via
      // `isLocalOrgModeActive`) already gates MOUNTING the local
      // onboarding/team routes on `capabilities.localHandoff`, never on `resolveAuthProvider`;
      // `isHostedMode()` above reads the identical predicate
      // (`resolveCapabilities(process.env, bindHost).localHandoff`), so this call site can no
      // longer disagree with it. On a hosted, unauthenticated bind the principal now stays the
      // plain no-org identity — `orgId`/`teamId` `null`, never coerced to the string `'local'`
      // (D13 invariant 3) — built the exact same way it always was for the no-org case:
      // `resolvePrincipal({ authProvider: 'none' })`, with no local-org lookup at all.
      // `resolveLocalPrincipal()` is now only ever reached on the ONE bind D13 is actually about:
      // loopback.
      principalContext.set(
        'principal',
        isHostedMode() ? resolvePrincipal({ authProvider: 'none' }) : resolveLocalPrincipal(),
      );
      return next();
    }
    // CEZ_AUTH is on. `sessionResolver` only exists when `src/index.ts`'s `serveCommand` loaded
    // `../auth/session.ts` and threaded the result in — a missing resolver here means CEZ_AUTH
    // was flipped on without going through that boot path (e.g. `createApp` called directly).
    // Fail closed rather than quietly falling back to the local principal: that fallback is
    // exactly the "forgot a variable, exposed a shell" shape D1's boot refusal exists to rule
    // out, and this seam must not reopen it one layer up.
    if (!sessionResolver) {
      return c.json({ error: 'server misconfigured: CEZ_AUTH is set but no session resolver was wired' }, 500);
    }
    // The supervisor's signed, forwarded principal (D10) rides alongside the cookie — read here,
    // once, and handed to whichever resolver `serveCommand` wired. `auth/session.ts`'s cookie
    // resolver ignores the second argument (it declares one parameter); the org process's
    // `supervisor/forwarded-session.ts` resolver ignores the FIRST. Reading both at one call site
    // is what keeps "who is this request" a single decision (D3) instead of a per-provider branch
    // in the middleware.
    const forwarded = readForwardedPrincipalHeaders((name) => c.req.header(name));
    const principal = sessionResolver.resolveFromCookieHeader(c.req.header('cookie'), forwarded);
    if (!principal) return c.json({ error: 'unauthenticated' }, 401);
    principalContext.set('principal', principal);
    return next();
  });

  // The mirrored project-route table (spec "API Contracts → Project-scoped").
  // Every route below registers ONCE on this sub-app; `createApp` mounts it
  // twice — under `/api/v1/p/:projectId` (scoped) and under `/api/v1` (bound to
  // the boot project) — so both spellings share one handler and can never
  // drift. The resolver middleware binds `c.get('project')`:
  // no `projectId` param (unscoped mount) → the boot context, byte-identical to
  // the pre-workspace closures; `default` or the boot project's own id → the
  // boot context too; anything else → the lazy context map, with
  // `ProjectContextError` mapped to 404 (unknown) / 409 (missing root).
  // Named rather than inlined because both mounts share it — one function, so
  // the two spellings can never disagree about what `default` means.
  const resolveProjectScope = async (c: Context<ProjectApiEnv>, next: Next): Promise<Response | void> => {
    const raw = c.req.param('projectId');
    if (raw === undefined) {
      c.set('project', bootContext);
      return next();
    }
    if (!projectIdSchema.safeParse(raw).success) {
      return c.json({ error: `unknown project: ${raw}` }, 404);
    }
    if (raw === 'default' || raw === (await resolveBootProject())) {
      c.set('project', bootContext);
      return next();
    }
    try {
      c.set('project', await contexts.context(raw));
    } catch (err) {
      if (err instanceof ProjectContextError) {
        return err.reason === 'missing-root'
          ? c.json({ error: `project folder not found: ${err.projectId}` }, 409)
          : c.json({ error: err.message }, 404);
      }
      throw err;
    }
    return next();
  };

  // ---- static GUI ----------------------------------------------------------
  // `/assets/:file` + `/open-mercato.svg`, and the SPA shell responder used by the catch-all at
  // the bottom of this function. Both now live in `./shell-routes.ts` — the SAME module
  // `supervisor/server.ts` mounts, so the login host and every org host serve byte-identical
  // bytes from byte-identical paths (see that module's own doc comment for the phase-6/7 defect
  // that forced the extraction: the supervisor served no shell, so `/auth/callback`'s redirect to
  // `/onboarding` 404'd and the installer's own verify step could never pass).
  app.route('/', cockpitAssetRoutes());

  // ---- meta ----------------------------------------------------------------
  // CORS — deliberately for /api/health ONLY (spec 011): the bookmarklets
  // fetch it cross-origin from github.com to discover which local ports run a
  // cockpit and which repo each serves. Health exposes no secrets beyond the
  // repo path/remote; every other endpoint stays same-origin.
  const healthCors = async (c: Context, next: Next): Promise<Response | void> => {
    c.header('access-control-allow-origin', '*');
    if (c.req.method === 'OPTIONS') {
      // Preflight (e.g. Chrome Private Network Access) — allow the plain GET.
      c.header('access-control-allow-methods', 'GET');
      c.header('access-control-allow-private-network', 'true');
      return c.body(null, 204);
    }
    await next();
  };
  app.use(`${V1_PREFIX}/health`, healthCors);
  // One builder for both transports: `GET /api/health` (the authoritative,
  // CORS-open discovery endpoint) and the `health` topic on `/api/v1/ws` below
  // push the byte-identical shape, so the two can never drift.
  // Deliberately UNANNOTATED: this literal is the source of the `/health` shape. Annotating it
  // with the api-client's `HealthResponse` made the contract circular — the DTO was declared by
  // hand, the handler was checked against it, and `AppType` then reported the hand-written type
  // back as if the server had proven it. Inferring here means the route says what it actually
  // sends, which is what lets the DTO be derived instead of maintained.
  const healthSnapshot = async () => {
    const [checks, repo, config, workspace] = await Promise.all([
      detectEnvironment(),
      getRepoInfo(bootRoot),
      loadConfig(bootRoot),
      workspaceSummary(),
    ]);
    // Additive fields only below — the pre-forge shape is the most
    // externally-depended-on JSON in the app (BACKWARD_COMPATIBILITY.md §2).
    const forge = resolveForge(repo);
    const caps = capabilities();
    return {
      version,
      // Spread rather than `latestVersion: update?.latest`: an `undefined` VALUE is dropped by
      // JSON.stringify, so the key is absent on the wire — but writing it unconditionally types
      // the key as always-present, which is a shape no client ever receives. The contract schema
      // says `.optional()`, and contract-parity.test.ts holds the two together.
      ...(update?.latest !== undefined ? { latestVersion: update.latest } : {}),
      // Health is CORS-open and, in hosted mode, reachable off the loopback —
      // so any site/host that reads it would learn the developer's absolute
      // checkout path and username (#431). Local mode keeps the full path (the
      // protected bookmarklet shape); hosted/remote mode trims it to a basename.
      // NB this narrows the VALUE of a field named in BACKWARD_COMPATIBILITY.md
      // §2: the field is always present and a string, but under CEZ_REMOTE it is
      // no longer an absolute path. Deliberate — a hosted cockpit's paths are on
      // a machine the reader does not have anyway. See §2's `repoRoot` note.
      repoRoot: caps.localHandoff ? bootRoot : basename(bootRoot),
      repo,
      checks,
      defaultRunner: config.defaultRunner,
      // Non-blocking: cached availability or null-until-warm — health must never pay a `gh`
      // shell-out (the bookmarklet aborts its port probe at 800 ms). See detectGithubCached.
      forge: forge ? { kind: forge.kind, ...(forge.detectCached() ?? {}) } : null,
      capabilities: caps,
      // Workspace enumeration (multi-project spec) — additive, id+name ONLY.
      // NEVER `projects[].root` here: health is the one CORS-open route, and
      // the repoRoot trim above exists precisely to keep absolute paths and
      // usernames away from cross-origin readers (#431) — per-project roots
      // would reintroduce that leak once per registered project. Absolute
      // roots live on the same-origin GET /api/projects instead. An
      // unreadable workspace degrades to `projects: []`.
      projects: workspace.projects,
      bootProject: workspace.bootProject,
    };
  };
  // ---- server-side health cache (stale-while-revalidate) -------------------
  // The snapshot is expensive: ~0.8 s of agent-CLI `--version` probes plus
  // ~0.4 s of git. Paying that on the browser's FIRST `GET /api/health` is
  // exactly the few-seconds-blank the cockpit showed at load. So on the live
  // server the snapshot is computed at the server's OWN pace: both the GET and
  // the WS `health` topic serve the cached value immediately and revalidate
  // behind the response, and the cache is pre-warmed at boot so that first
  // request lands on a warm value instead of the cold compute.
  const HEALTH_TTL_MS = 5_000;
  // The staleness CEILING, which is a different job from the TTL above. The TTL
  // decides how often a revalidation is kicked off; on its own it bounds nothing,
  // because the revalidation is fire-and-forget. While a cockpit holds the
  // `health` topic the publisher's interval keeps the cache warm and the two are
  // the same number — but the normal state of a background `cezar serve` is NO
  // subscriber, and then nothing refreshes the cache at all: the next `GET
  // /api/health`, an hour later, would answer with the boot pre-warm's payload
  // and only the request AFTER it would see the truth. That endpoint is the
  // bookmarklet contract (BACKWARD_COMPATIBILITY.md §2, "the most
  // externally-depended-on JSON in the app") and `repo.branch` going stale is
  // literally #369, so past this age correctness beats the latency win and the
  // read waits for the compute. `refreshHealth` dedupes, so waiting costs one.
  const HEALTH_MAX_STALE_MS = 60_000;
  /** Whatever `healthSnapshot` actually returns — see the note there. */
  type HealthPayload = Awaited<ReturnType<typeof healthSnapshot>>;
  let healthCache: { at: number; payload: HealthPayload; body: string } | undefined;
  let healthInFlight: Promise<HealthPayload> | undefined;
  // Set while the topic has a subscriber; a change a refresh detects is pushed
  // here (a noop when nobody is listening).
  let publishHealth: (data: unknown) => void = () => {};

  const refreshHealth = (): Promise<HealthPayload> => {
    // Dedupe: a GET's background revalidation and the topic's interval tick
    // share ONE compute (and one set of CLI spawns) rather than racing two.
    if (healthInFlight) return healthInFlight;
    healthInFlight = (async () => {
      try {
        const payload = await healthSnapshot();
        const body = JSON.stringify(payload);
        const changed = body !== healthCache?.body;
        healthCache = { at: Date.now(), payload, body };
        if (changed) publishHealth(payload); // only a real change reaches the wire
        return payload;
      } finally {
        healthInFlight = undefined;
      }
    })();
    return healthInFlight;
  };

  // The read the GET and the topic snapshot share. On the live server (a hub is
  // injected) it answers from cache instantly and revalidates behind the
  // response; without a hub — a bare app in tests — there is no refresher
  // keeping a cache coherent, so it computes fresh, exactly as before.
  const readHealth = async (): Promise<HealthPayload> => {
    if (!deps.socketHub) return healthSnapshot();
    if (!healthCache) return refreshHealth(); // first ever: nothing to serve yet
    const age = Date.now() - healthCache.at;
    if (age > HEALTH_MAX_STALE_MS) return refreshHealth(); // too old to serve — wait for the truth
    if (age > HEALTH_TTL_MS) void refreshHealth(); // stale: refresh, don't wait on it
    return healthCache.payload;
  };

  // ---- chained family: health (workspace-level) ----------------------------
  // Written as ONE chained expression rather than a loose `app.get(...)`
  // statement because Hono accumulates its route types through the chain: a
  // statement's return value is discarded, so `typeof app` would record nothing
  // and `hc<AppType>` would have no endpoint to offer. `createApp` mounts this
  // under both `/api` (the frozen legacy spelling) and `/api/v1`.
  /**
   * The CORS-open payload, minus what an unauthenticated reader must not have (ADDED 2026-08-07,
   * repair stage). `projects[].name` is every registered repository's name; `Access-Control-Allow-
   * Origin: *` means any page on the internet can read the response body, and phase 7's plan is
   * for OIDC to REPLACE the nginx `auth_basic` layer that hides it on today's `ubuntu-vps`
   * install. So when `CEZ_AUTH` names a provider and the request carries no valid session, the
   * list is emptied — the same degradation an unreadable workspace already produces
   * (`workspaceSummary`'s own `catch`), so the shape on the wire is one a client already handles.
   *
   * **`CEZ_AUTH` unset returns the cached payload by identity** — same object, no session resolve,
   * no branch taken — which is what keeps the auth-off health payload byte-identical (the spec's
   * Risks section: a diff there is a failure, not an update).
   *
   * Applied HERE and not inside `healthSnapshot` on purpose: the snapshot is cached and shared
   * with the `health` WS topic, so making it per-principal would either poison the cache with one
   * caller's view or fork it per session. The WS twin needs no equivalent — `verifyWsUpgrade`
   * already refuses an unauthenticated upgrade (D6), so nothing reaches that topic without a
   * session. `bootProject` deliberately stays: the SPA shell's redirect gate reads it before any
   * `/api/v1/*` call can succeed, and it is one slug rather than the whole registry.
   */
  const healthForRequest = async (c: Context) => {
    const payload = await readHealth();
    if (resolveAuthProvider(process.env) === 'none') return payload;
    const resolved = sessionResolver?.resolveFromCookieHeader(c.req.header('cookie'));
    if (resolved) return payload;
    return { ...payload, projects: [] };
  };

  const healthRoutes = new Hono().get('/health', async (c) => c.json(await healthForRequest(c)));

  // The push twin of the poll it replaced (#369): while at least one cockpit
  // holds the `health` topic the server re-reads the snapshot on the old 5 s
  // cadence and broadcasts ONLY when it changed — a `git checkout` in a
  // terminal reaches every open tab within a tick — and an idle workspace (no
  // subscriber) runs no timer. Nothing server-side watches `.git/HEAD`, so the
  // interval stays the honest mechanism; it just lives behind the socket now
  // instead of N tabs × 5 s HTTP polls. Every tick and every subscriber read
  // goes through the cache above, so N subscribers still cost one compute.
  deps.socketHub?.registerTopic(
    'health',
    {
      snapshot: readHealth,
      start: (publish) => {
        publishHealth = publish;
        const timer = setInterval(() => void refreshHealth(), HEALTH_TTL_MS);
        timer.unref?.();
        return () => {
          clearInterval(timer);
          publishHealth = () => {};
        };
      },
    },
    // health IS the CORS-open discovery payload (#431), so it is the one topic
    // safe for any local page — including a cross-port page admitted by the
    // loopback fallback on a no-Sec-Fetch browser. Every other (future) topic
    // keeps the default: trusted connections only.
    { loopbackReadable: true },
  );
  // Pre-warm on the live-server path only (startServer injects the hub; a bare
  // app in tests does not, so tests never spawn the probes here): the cache
  // fills while the browser is still downloading the bundle, so its first
  // `GET /api/health` reads a warm value instead of the cold ~1 s compute.
  if (deps.socketHub) void refreshHealth();
  /**
   * Warm the whole of cezar's agent knowledge — the three discovered defaults AND every extra
   * account — so no reader ever pays the first shell-out.
   *
   * Which login each agent is signed into is operating knowledge, not a settings-page detail: the
   * composer, the action gate, the accounts pane and every run resolution ask for it. So the server
   * learns it once, at boot, and keeps it (see the asymmetric cache lifetime in
   * `core/provider-auth.ts`); on-demand refresh rides on `?refresh=1` and on the explicit
   * invalidations — connect, repoint, remove, runtime rejection.
   *
   * Extra accounts are warmed ONE AT A TIME, after the defaults. Each is a CLI spawn, and a machine
   * with several accounts would otherwise fan out a spawn storm at exactly the moment the browser is
   * fetching the bundle; nothing is waiting on this, so sequential costs nothing that matters.
   *
   * Hosted mode warms only the defaults: the agent-profiles family is refused there, so there are
   * no accounts to learn about.
   */
  const warmAgentKnowledge = async (): Promise<void> => {
    await providerAuth.status().catch(() => {});
    if (!capabilities().localHandoff) return;
    const store = await loadAgentAccounts().catch(() => defaultAgentAccountStore());
    for (const account of listAgentProfiles(store, PROVIDER_IDS)) {
      if (account.isDefault) continue; // covered by `status()` above
      await providerAuth
        .profileStatus(account.provider, { id: account.id, configDir: account.path })
        .catch(() => {});
    }
  };
  // Same gate as `refreshHealth`, same reason (startServer injects the hub; a bare app in tests does
  // not, so tests never spawn probes here). Fire-and-forget: a probe that fails leaves that row
  // cold, which is exactly the state every reader already handles.
  if (deps.socketHub) void warmAgentKnowledge();

  // ---- chained family: host model catalog (workspace-level) ----
  const modelsRoutes = new Hono<ProjectApiEnv>()
    // `modelDiscoveryRunnerSchema` is the contract's own list of the runners with an
    // authoritative host-local catalog (#794), so the client compiles against exactly what this
    // validates. Claude has no such source: its picker stays on static presets and this 400s.
    .get('/models', queryZodValidator(z.object({ runner: z.union([z.string(), z.array(z.string()).transform((v) => v[0] as string)]).pipe(modelDiscoveryRunnerSchema) }), { message: 'runner must be codex or opencode' }), async (c) => {
      const query = { data: c.req.valid('query') };
      return c.json(await modelCatalog.get(query.data.runner));
    });

  /**
   * Resolve `profileId` (absent = the discovered default) into a concrete account for `provider`.
   *
   * A dangling id is an ERROR here rather than the silent fall-back to the default that run
   * resolution performs. The difference is who is asking: a run is replaying a stored reference
   * and the default is the only safe answer it can act on, whereas a route is answering a user
   * who just named an account — telling them "unknown account" is honest, and quietly connecting
   * or reporting on a different one is not.
   */
  const resolveWorkspaceProfile = async (
    provider: ProviderId,
    profileId?: string,
  ): Promise<{ profile: ResolvedAgentProfile } | { error: string }> => {
    if (profileId === undefined || profileId === DEFAULT_AGENT_ACCOUNT_ID) {
      return { profile: defaultAgentProfile(provider) };
    }
    let accounts: readonly AgentAccount[];
    try {
      accounts = (await loadAgentAccounts()).accounts;
    } catch {
      return { error: `unknown ${provider} account: ${profileId}` };
    }
    const stored = accounts.find((a) => a.id === profileId && a.provider === provider);
    if (!stored) return { error: `unknown ${provider} account: ${profileId}` };
    return { profile: resolveStoredProfile(stored) };
  };

  /**
   * Workflow resolution for a run-creation body, shared by `POST /runs` and `POST
   * /workspace/runs` (spec 2026-08-15-cross-project-workspace-run).
   *
   * Extracted from the `/runs` handler rather than copied into the workspace route: the two must
   * answer identically for the same body, and "an inline chain, a named workflow, or the
   * `quick-task` floor" is three rules that would drift the first time a fourth arrived. The
   * bare-neither branch is why this can never 404 without a name being given.
   */
  const resolveRunWorkflow = async (
    root: string,
    body: { workflow?: string; steps?: WorkflowDef['steps'] },
  ): Promise<{ workflow: WorkflowDef } | { error: string; status: 400 | 404 }> => {
    if (body.steps) {
      const issue = stepsIssue(body.steps);
      if (issue) return { error: issue, status: 400 };
      return { workflow: { name: '(planned)', source: 'built-in', steps: body.steps } };
    }
    const { workflows } = await loadWorkflows(root);
    if (body.workflow) {
      const named = workflows.find((w) => w.name === body.workflow);
      return named
        ? { workflow: named }
        : { error: `unknown workflow: ${body.workflow}`, status: 404 };
    }
    return { workflow: workflows.find((w) => w.name === 'quick-task') ?? QUICK_TASK_WORKFLOW };
  };

  /**
   * The pre-start guards a run-creation body must clear, shared by the same two routes and for the
   * same reason: model policy, provider availability, and the named agent account. Each keeps the
   * status code the `/runs` route has always answered with (409 for a policy or availability
   * refusal, 400 for an account id that does not exist).
   */
  const guardRunStart = async (
    root: string,
    workflow: WorkflowDef,
    body: { model?: string; runner?: string; agentProfile?: string },
  ): Promise<{ error: string; status: 400 | 409 } | null> => {
    if (agentModelsLocked(root) && body.model?.trim()) {
      return { error: AGENT_MODELS_LOCKED_ERROR, status: 409 };
    }
    const fallback = (body.runner as RunnerId | undefined) ?? (await loadConfig(root)).defaultRunner;
    const blocked = await providerActionError(providersRequiredByWorkflow(workflow, fallback));
    if (blocked) return { error: blocked, status: 409 };
    // A composer override names an account the user just picked, so a stale id (deleted since the
    // page loaded) is answered honestly instead of quietly running on the default.
    if (body.agentProfile !== undefined) {
      const account = await resolveWorkspaceProfile(fallback, body.agentProfile);
      if ('error' in account) return { error: account.error, status: 400 };
    }
    return null;
  };

  /**
   * The environment a terminal handoff must carry so the CLI lands on the right account.
   *
   * `profileId` is the one RECORDED on the step that owns the session, never the project's
   * current selection: `claude --resume <id>` reads `<configDir>/sessions`, so a handoff for a
   * run started on the work account and resumed after the project was switched back would find
   * nothing and silently open a fresh conversation.
   */
  const handoffEnv = async (
    provider: ProviderId,
    profileId: string | undefined,
  ): Promise<{ env: Record<string, string> } | { error: string }> => {
    const resolved = await resolveWorkspaceProfile(provider, profileId);
    if ('error' in resolved) {
      return { error: `this session belongs to an account that no longer exists (${profileId})` };
    }
    const { profile } = resolved;
    return { env: profile.isDefault ? {} : profileEnv(provider, profile.path) };
  };

  /** The copy-paste fallback shown when no terminal could be opened — same account, spelled for
   *  this platform's shell. `null` when the dir cannot be embedded safely, which is a refusal. */
  const handoffFallbackCommand = (cwd: string, command: string, env: Record<string, string>): string | null => {
    const prefixed = withEnvPrefix(command, env, process.platform);
    return prefixed === null ? null : `cd '${cwd}' && ${prefixed}`;
  };

  /** A registered project's realpath'd root, or null when the id is unknown. */
  const projectRootFor = async (projectId: string): Promise<string | null> => {
    try {
      return (await loadWorkspaceConfig()).projects.find((p) => p.id === projectId)?.root ?? null;
    } catch {
      return null;
    }
  };

  // ---- chained family: agent providers (workspace-level) ----
  const providersRoutes = new Hono<ProjectApiEnv>()
    .get(
      '/providers/status',
      queryZodValidator(z.object({ refresh: queryValue.refine((v) => v === undefined || v === '1') }), { message: 'refresh must be 1 when provided' }),
      async (c) => {
        const query = { data: c.req.valid('query') };
        return c.json(await providerStatus({ refresh: query.data.refresh === '1' }));
      },
    )

    .put(
      '/providers/:provider/enabled',
      paramZodValidator(z.object({ provider: providerParamSchema }), { message: 'provider and enabled boolean are required' }),
      jsonZodValidator(providerEnabledSchema, { message: 'provider and enabled boolean are required' }),
      async (c) => {
        const provider = { data: c.req.valid('param').provider };
        const body = { data: c.req.valid('json') };
        let workspace: WorkspaceConfig;
        try {
          workspace = await workspaceConfig.mergeWrite((config) => {
            const disabled = new Set(config.disabledProviders);
            if (body.data.enabled) disabled.delete(provider.data);
            else disabled.add(provider.data);
            config.disabledProviders = PROVIDER_IDS.filter((id) => disabled.has(id));
          });
        } catch {
          return c.json({ error: 'Provider preference could not be saved.' }, 500);
        }
        const result = applyProviderEnablement(
          await providerAuth.status(),
          workspace.disabledProviders,
        );
        const row = result.providers.find(({ provider: id }) => id === provider.data);
        if (row) workspaceEvents.emit('provider-status', row);
        return c.json(result);
      },
    )

    .post(
      '/providers/:provider/retry',
      paramZodValidator(z.object({ provider: providerParamSchema }), { message: 'provider and current authFailureId are required' }),
      jsonZodValidator(providerRetrySchema, { message: 'provider and current authFailureId are required' }),
      async (c) => {
        const provider = { data: c.req.valid('param').provider };
        const body = { data: c.req.valid('json') };
        if (!providerAuth.clearRuntimeAuthFailure(provider.data, body.data.authFailureId)) {
          return c.json({ error: 'Authentication incident changed. Refresh and try again.' }, 409);
        }
        const result = await providerStatus({ refresh: true });
        const row = result.providers.find(({ provider: id }) => id === provider.data);
        if (row) workspaceEvents.emit('provider-status', row);
        return c.json(result);
      },
    )

    .post('/providers/connect', jsonZodValidator(providerConnectSchema, { message: 'provider must be claude, codex, opencode, or pi' }), async (c) => {
      const body = { data: c.req.valid('json') };

      const provider = body.data.provider as ProviderId;
      // A NAMED account is refused in hosted mode before anything is resolved, exactly like every
      // sibling route in the agent-profiles family. Checking later would already have read
      // `~/.cezar/agent-accounts.json`, built a command carrying the account's absolute path (which
      // both the success body and the hosted 409 echo), and — for a stored account — spawned a
      // probe. It would also answer `unknown account: <id>` for a wrong id, which is an enumeration
      // oracle for the very ids the hosted listing withholds. The bare-provider spelling keeps its
      // existing behaviour: it names no host path and is how the Providers card has always worked.
      if (body.data.profileId !== undefined
        && body.data.profileId !== DEFAULT_AGENT_ACCOUNT_ID
        && !capabilities().localHandoff) {
        return c.json(hostedProfileRefusal, 409);
      }
      // Resolve the account BEFORE anything else: both the command and the status probe below
      // must describe the same one, or the pane reports on the personal login while the terminal
      // signs into the work login.
      const resolved = await resolveWorkspaceProfile(provider, body.data.profileId);
      if ('error' in resolved) return c.json({ error: resolved.error }, 400);
      const { profile } = resolved;
      const command = providerAuth.loginCommand(provider, profile.isDefault ? null : profile.path);
      // Fail closed: a config dir that cannot be embedded safely in this platform's shell has no
      // safe degradation. Running the bare command would sign the user into a DIFFERENT account
      // than the one they clicked, and nothing in the terminal would say so.
      if (command === null) {
        return c.json({ error: `This account's folder cannot be used in a terminal command: ${profile.configDir}` }, 409);
      }
      // BOTH branches must mean "is this account signed in NOW". The default branch refreshes; the
      // account branch has to evict first, because `profileStatus` serves the per-account cache and
      // a connected answer there stands for CONNECTED_TTL_MS. Without this, Connect after a
      // `claude /logout` answers "already connected", opens nothing, and the user is stuck — and it
      // would contradict this module's own invariant that opening a login is one of the things
      // cezar CAN observe and therefore invalidates explicitly rather than waiting out a window.
      if (!profile.isDefault) providerAuth.forgetProfileStatus(provider, profile.id);
      const row = profile.isDefault
        ? (await providerAuth.status({ refresh: true })).providers.find(
          (candidate) => candidate.provider === provider,
        )
        : await providerAuth.profileStatus(provider, { id: profile.id, configDir: profile.path });
      if (!row) {
        return c.json({ error: 'Authentication could not be verified. Try again.' }, 500);
      }

      if (row.status === 'connected') {
        return c.json({ opened: false, connected: true, command });
      }
      if (row.status === 'not-installed') {
        return c.json({ error: row.hint ?? providerAuth.installHint(provider), command }, 409);
      }
      if (row.status === 'unknown') {
        return c.json({ error: row.hint ?? 'Authentication could not be verified. Try again.', command }, 409);
      }
      if (!capabilities().localHandoff) {
        return c.json({ error: 'Run this command on the machine hosting cezar.', command }, 409);
      }
      let opened = false;
      try {
        // No `env` argument: `loginCommand` already rendered the account's config dir INTO the
        // command, because this string is also the copy-paste fallback the pane shows. Passing
        // it again here would set the variable twice.
        opened = await openTerminal(bootRoot, command);
      } catch {
        // Terminal handoff is best-effort; the exact command remains the safe fallback.
      }
      if (!opened) {
        return c.json({ error: 'No terminal emulator could be opened. Run this command manually.', command }, 409);
      }
      return c.json({ opened: true, command });
    });

  // ---- chained family: agent profiles / accounts (workspace-level) ----------
  // Extra config dirs for a SECOND login of the same agent CLI (spec
  // 2026-07-29-agent-profiles). Workspace-level and therefore SINGLE-MOUNT: an account belongs to
  // the person and the machine, never to a repo, and a project-scoped spelling would be a second
  // surface to protect with no consumer. Which account a project uses is a field on
  // `PATCH /api/v1/projects/:projectId` instead.
  //
  // Writing is a LOCAL-MACHINE capability, exactly like `PUT /api/v1/agent-config/:id`: a profile
  // points an agent at a directory on the host, and the listing echoes absolute paths carrying
  // the username — the same disclosure `/api/v1/health` trims in hosted mode (#431).

  /**
   * This agent's own USER-scope config files, resolved inside ONE account's folder.
   *
   * Straight from the catalog — the single home of config-file vendor knowledge — with an
   * `AgentHomePaths` whose slot for this provider is the account's dir. That is what makes a second
   * login's `settings.json` the file you open rather than the default account's, and it keeps the
   * ids opaque and stable so the open route below never takes a path from the client.
   */
  const accountFiles = async (profile: ResolvedAgentProfile) => {
    const home: AgentHomePaths = {
      ...agentHomePaths(),
      ...(profile.provider === 'claude' ? { claude: profile.path } : {}),
      ...(profile.provider === 'codex' ? { codex: profile.path } : {}),
      ...(profile.provider === 'opencode' ? { opencodeConfig: profile.path } : {}),
    };
    const defs = listConfigFiles().filter(
      (def) => def.scope === 'user' && def.runners.includes(profile.provider),
    );
    return Promise.all(
      defs.map(async (def) => {
        const path = def.resolve(bootRoot, home);
        return { id: def.id, label: basename(path), path, exists: (await statConfigPath(path)).exists };
      }),
    );
  };

  /** Build the wire row for one resolved profile: its dir state plus whatever auth is cached. */
  const agentProfileBody = async (profile: ResolvedAgentProfile) => ({
    id: profile.id,
    provider: profile.provider,
    label: profile.label,
    configDir: profile.configDir,
    path: profile.path,
    ...(await profileDirState(profile.provider, profile.path)),
    isDefault: profile.isDefault,
    // CACHED auth only — this listing must never pay a CLI spawn.
    //
    // Probing here cost a shell-out per provider PLUS one per extra account: ~0.7s with no extra
    // accounts and over 2s with a few, on every cold load, for a route whose real job (what
    // accounts exist) is a JSON read and a handful of stats. `GET /api/v1/health` already
    // established the rule — it serves whatever the cache holds and never pays a `gh` shell-out.
    // An absent `status` means "not determined yet", which the cockpit renders as Checking… and
    // then fills in from the per-account status route below.
    //
    // SPREAD, not `status: maybeUndefined`: hono would type the key as always-present while
    // `JSON.stringify` drops it, which is exactly the drift `contract-parity` catches (AGENTS.md
    // names this as one of the two recurring mismatches).
    ...(() => {
      const cached = profile.isDefault
        ? providerAuth.peekStatus()?.providers.find((row) => row.provider === profile.provider)
        : providerAuth.peekProfileStatus(profile.provider, profile.id);
      return cached ? { status: cached } : {};
    })(),
    // NO identity field here — see `agentProfileSchema` and `agent-config/account-identity.ts`
    // rule 2. Which subscription a dir is signed in to is answered on demand (`…/:id/details`) and,
    // for dirs that are not accounts yet, by `…/agent-profiles/discovered`. This listing is fetched
    // on every load of the settings pane, so a field here would put an email in the response and
    // the query cache regardless of what the UI chose to render.
    files: await accountFiles(profile),
  });

  /**
   * Resolve `:id` to an account for the per-account reads below. Unlike `resolveWorkspaceProfile`
   * this accepts the reserved `default` for a NAMED provider, which these routes cannot infer — so
   * the id may be `default:<provider>` as well as a stored account id.
   */
  const accountById = async (id: string): Promise<ResolvedAgentProfile | null> => {
    const [head, tail] = id.split(':');
    if (head === DEFAULT_AGENT_ACCOUNT_ID) {
      const provider = PROVIDER_IDS.find((p) => p === tail);
      return provider ? defaultAgentProfile(provider) : null;
    }
    try {
      const stored = (await loadAgentAccounts()).accounts.find((a) => a.id === id);
      return stored ? resolveStoredProfile(stored) : null;
    } catch {
      return null;
    }
  };

  /** Validate a client-supplied config dir. Returns the error text, or null when it is usable. */
  const checkProfileDir = (configDir: string): string | null => {
    if (CONTROL_CHARS_RE.test(configDir)) return 'folder must not contain control characters';
    const expanded = expandTilde(configDir);
    // Absolute after expansion: a relative dir would resolve against whatever cwd the agent
    // happens to be spawned in, which for a task is a throwaway worktree. Through
    // `isAbsoluteConfigDir`, never a leading-`/` test — see its note: a string test refuses every
    // real Windows path, and this is the only gate the Add-account dialog has.
    if (!isAbsoluteConfigDir(expanded)) return `folder must be an absolute path: ${configDir}`;
    return null;
  };

  /** Refuse a dir that is already some other account's (or the default's), compared through
   *  `realpath` — two spellings of one directory would be two accounts silently sharing one
   *  session store, and "which one am I logged into?" would stop having an answer. */
  const conflictingProfile = async (
    profiles: readonly AgentAccount[],
    provider: ProviderId,
    path: string,
    exceptId?: string,
  ): Promise<string | null> => {
    if (await sameProfileDir(path, defaultAgentProfile(provider).path)) {
      return 'that is already this agent\'s default folder';
    }
    for (const candidate of profiles) {
      if (candidate.provider !== provider || candidate.id === exceptId) continue;
      if (await sameProfileDir(path, expandTilde(candidate.configDir))) {
        return `that folder is already used by "${candidate.label || candidate.id}"`;
      }
    }
    return null;
  };

  const agentProfilesRoutes = new Hono<ProjectApiEnv>()
    .get('/workspace/agent-profiles', async (c) => {
      const editable = capabilities().localHandoff;
      // Hosted mode withholds the listing entirely rather than serving it read-only: the paths
      // are the host disclosure, so an empty list is the only honest hosted answer.
      //
      // ONE body object, never a hosted `return` and a local `return`: two returns let hono
      // narrow `editable` to the literal `false`/`true` of each branch, and the contract's
      // honest `z.boolean()` then reads as wider than the route. Same shape as
      // `listAgentConfig`, which carries the same flag for the same reason.
      let store = defaultAgentAccountStore();
      if (editable) {
        try {
          store = await loadAgentAccounts();
        } catch {
          // an unreadable home degrades to "no extra accounts", never a failed request
        }
      }
      const profiles = editable
        ? await Promise.all(listAgentProfiles(store, PROVIDER_IDS).map(agentProfileBody))
        : [];
      return c.json({
        editable,
        profiles,
        profileCapableProviders: [...PROFILE_CAPABLE_PROVIDERS],
        // Which account each project uses, keyed by repo root. Served here rather than on the
        // project registry because it lives in the same file as the accounts it names.
        selections: editable ? store.selections : {},
        /** The machine-wide fallback, for repos that have chosen nothing. Withheld in hosted mode
         *  on the same terms as the rest of this family. */
        defaults: editable ? store.defaults : {},
      });
    })

    /**
     * The Claude logins that exist on this machine (spec
     * `.ai/specs/2026-08-14-claude-subscription-autodetect.md`) — `~/.claude` plus any
     * `~/.claude*` sibling the CLI actually wrote, each with the account it is signed in as.
     *
     * A READ, and a proposal: adding one is still `POST …/agent-profiles` with the dir it names,
     * through the same duplicate and path guards a hand-typed dir goes through. Discovery that
     * registered what it found would be a write nobody asked for, and would also decide FOR the
     * user that every login on the machine belongs in this cockpit.
     *
     * `added` is computed here rather than left to the client because the answer is
     * `sameProfileDir` — a realpath comparison — and a client-side string compare would offer a
     * second spelling of a dir it already has as if it were a new account.
     */
    .get('/workspace/agent-profiles/discovered', async (c) => {
      // Hosted mode withholds it on exactly the terms the listing above does: these are absolute
      // paths on the host, and an empty list is the only honest hosted answer.
      if (!capabilities().localHandoff) return c.json({ accounts: [] } satisfies DiscoveredAgentAccountsResponse);
      let stored: readonly AgentAccount[] = [];
      try {
        stored = (await loadAgentAccounts()).accounts;
      } catch {
        // unreadable store — every dir reads as not-yet-added, which is the safe direction: the
        // POST still refuses a duplicate, so the cost is a refused click rather than a second
        // account silently sharing one session store.
      }
      const discovered = await discoverClaudeAccounts();
      const accounts = await Promise.all(
        discovered.map(async (found) => ({
          provider: found.provider,
          configDir: found.path,
          ...(found.identity ? { identity: found.identity } : {}),
          added: (await conflictingProfile(stored, 'claude', found.path)) !== null,
        })),
      );
      return c.json({ accounts } satisfies DiscoveredAgentAccountsResponse);
    })

    .post('/workspace/agent-profiles', jsonZodValidator(() => createAgentProfileSchema), async (c) => {
      if (!capabilities().localHandoff) return c.json(hostedProfileRefusal, 409);
      const { provider, configDir, label } = c.req.valid('json');
      if (!supportsProfiles(provider)) {
        return c.json({ error: `${provider} cannot carry more than one account` }, 400);
      }
      const dirError = checkProfileDir(configDir);
      if (dirError) return c.json({ error: dirError }, 400);

      // Read-first, exactly like `POST /projects`: the duplicate check needs `realpath`, and the
      // merge-write mutator is deliberately SYNCHRONOUS so the read→rename window stays as small
      // as it is for every other writer of this file. Two processes adding the same folder in
      // that window would both win — a cosmetic duplicate, not a correctness problem, since the
      // schema's id dedupe is what keeps resolution deterministic.
      let existing: readonly AgentAccount[] = [];
      try {
        existing = (await loadAgentAccounts()).accounts;
      } catch {
        // unreadable store — the merge-write below reports the real failure
      }
      const conflict = await conflictingProfile(existing, provider, expandTilde(configDir));
      if (conflict !== null) return c.json({ error: conflict }, 409);

      let created: AgentAccount | undefined;
      try {
        await mergeWriteAgentAccounts((store) => {
          const id = allocateAgentProfileId(label ?? configDir, store.accounts.map((a) => a.id));
          created = {
            id,
            provider,
            configDir,
            label: label?.trim() || id,
            addedAt: new Date().toISOString(),
          };
          store.accounts.push(created);
        });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
      if (!created) return c.json({ error: 'account could not be saved' }, 500);
      // A brand-new account is the one thing the boot warm could not have known about, so learn it
      // now rather than only when something asks. Still off the response: the row is returned with
      // `status` absent (the listing's rule), the pane shows Checking…, and its follow-up request
      // joins this same in-flight probe.
      const account = resolveStoredProfile(created);
      const created201 = await agentProfileBody(account);
      void providerAuth
        .profileStatus(account.provider, { id: account.id, configDir: account.path })
        .catch(() => {});
      return c.json({ profile: created201 }, 201);
    })

    .patch(
      '/workspace/agent-profiles/:id',
      paramZodValidator(z.object({ id: z.string() })),
      jsonZodValidator(() => updateAgentProfileSchema),
      async (c) => {
        if (!capabilities().localHandoff) return c.json(hostedProfileRefusal, 409);
        const id = c.req.param('id');
        const { label, configDir } = c.req.valid('json');
        if (configDir !== undefined) {
          const dirError = checkProfileDir(configDir);
          if (dirError) return c.json({ error: dirError }, 400);
        }

        // Read-first (see POST above, and `PATCH /projects`): a well-formed but unknown id must
        // 404 WITHOUT rewriting the config, and the duplicate check needs async `realpath`.
        let existing: readonly AgentAccount[] = [];
        try {
          existing = (await loadAgentAccounts()).accounts;
        } catch {
          // unreadable store — treated as unknown, like DELETE and PATCH /projects
        }
        const current = existing.find((a) => a.id === id);
        if (!current) return c.json({ error: `unknown account: ${id}` }, 404);
        if (configDir !== undefined) {
          const conflict = await conflictingProfile(existing, current.provider, expandTilde(configDir), id);
          if (conflict !== null) return c.json({ error: conflict }, 409);
        }

        let updated: AgentAccount | undefined;
        try {
          await mergeWriteAgentAccounts((store) => {
            const entry = store.accounts.find((a) => a.id === id);
            if (!entry) return; // lost a race with a concurrent delete — answered below
            // Mutated in place so `.passthrough()` keys on the row survive.
            if (label !== undefined) entry.label = label.trim() || entry.id;
            if (configDir !== undefined) entry.configDir = configDir;
            updated = entry;
          });
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
        if (!updated) return c.json({ error: `unknown account: ${id}` }, 404);
        // The dir may have moved under a cached probe — drop THIS account's answer so the response
        // reports the new folder's state rather than the old one's, and leave every other account's
        // warm answer alone (it is still true). Then re-learn it in the background, so the server's
        // knowledge is complete again whether or not a cockpit is open to ask; the pane's own
        // request for this row joins the same in-flight probe rather than spawning a second.
        const repointed = resolveStoredProfile(updated);
        providerAuth.forgetProfileStatus(repointed.provider, repointed.id);
        const body = await agentProfileBody(repointed);
        void providerAuth
          .profileStatus(repointed.provider, { id: repointed.id, configDir: repointed.path })
          .catch(() => {});
        return c.json({ profile: body });
      },
    )

    /**
     * One account's authentication state, probed for real.
     *
     * Separate from the listing because a probe shells out to an agent CLI: keeping it here lets
     * the pane paint immediately and fill each row in as its answer lands, instead of every cold
     * load blocking on N spawns. `refresh=1` drops this account's cached answer and re-probes, for
     * the "Check again" affordance — the cache itself holds a connected answer for minutes and an
     * unsettled one for a minute (`cacheTtlFor` in `core/provider-auth.ts`).
     */
    .get(
      '/workspace/agent-profiles/:id/status',
      paramZodValidator(z.object({ id: z.string() })),
      queryZodValidator(z.object({ refresh: queryValue.refine((v) => v === undefined || v === '1') }), { message: 'refresh must be 1 when provided' }),
      async (c) => {
        if (!capabilities().localHandoff) return c.json(hostedProfileRefusal, 409);
        const account = await accountById(c.req.param('id'));
        if (!account) return c.json({ error: `unknown account: ${c.req.param('id')}` }, 404);
        const refresh = c.req.valid('query').refresh === '1';
        // The discovered account's row is the one `GET /api/v1/providers/status` owns, so it comes
        // from there — enablement included, which a bare probe does not know about.
        if (account.isDefault) {
          const all = await providerStatus(refresh ? { refresh: true } : undefined);
          const row = all.providers.find((candidate) => candidate.provider === account.provider);
          return c.json({ status: row ?? { provider: account.provider, status: 'unknown' as const } });
        }
        // "Check again" re-probes THIS account only — the other accounts' warm answers are not
        // invalidated by asking about this one.
        if (refresh) providerAuth.forgetProfileStatus(account.provider, account.id);
        return c.json({
          status: await providerAuth.profileStatus(account.provider, {
            id: account.id,
            configDir: account.path,
          }),
        });
      },
    )

    /**
     * Who this account is signed in AS — the pane's "Show details".
     *
     * A separate, on-demand route rather than a field on the listing, and that is what makes
     * "hidden by default" real: an email carried by the listing would already be in the response,
     * the query cache and devtools, whatever the UI chose to render. `provider-auth.ts` keeps
     * identity out of ITS boundary on purpose; this is the deliberate, local-only, opt-in
     * exception — not a widening of that rule. Never logged, never persisted.
     */
    .get(
      '/workspace/agent-profiles/:id/details',
      paramZodValidator(z.object({ id: z.string() })),
      async (c) => {
        if (!capabilities().localHandoff) return c.json(hostedProfileRefusal, 409);
        const account = await accountById(c.req.param('id'));
        if (!account) return c.json({ error: `unknown account: ${c.req.param('id')}` }, 404);
        return c.json(await readAccountIdentity(account.provider, account.path));
      },
    )

    /**
     * Open one of this account's own config files — or its folder — in a local app.
     *
     * `file` is a catalog ID from the account's own `files`, never a path: the client cannot name a
     * location, so there is no traversal surface here at all (the same rule
     * `/api/v1/agent-config/:id` follows). `folder` is the one extra keyword, and it resolves to
     * the account's dir rather than anything the caller spelled.
     */
    .post(
      '/workspace/agent-profiles/:id/open',
      paramZodValidator(z.object({ id: z.string() })),
      jsonZodValidator(() => openAgentAccountFileSchema),
      async (c) => {
        if (!capabilities().localHandoff) return c.json(hostedProfileRefusal, 409);
        const account = await accountById(c.req.param('id'));
        if (!account) return c.json({ error: `unknown account: ${c.req.param('id')}` }, 404);
        const { file, target } = c.req.valid('json');

        let path: string;
        if (file === 'folder') {
          path = account.path;
        } else {
          const match = (await accountFiles(account)).find((f) => f.id === file);
          if (!match) return c.json({ error: `unknown file: ${file}` }, 404);
          path = match.path;
        }
        // A file the agent has not written yet has nothing to open; say so rather than hand the OS
        // a missing path and report success.
        if (!(await statConfigPath(path)).exists && file !== 'folder') {
          return c.json({ error: `this account has no ${basename(path)} yet` }, 409);
        }
        // `target` names a detected app; absent means the OS default handler. Either way the PATH
        // came from the catalog, so an editor is only ever pointed inside this account's folder.
        //
        // Which targets APPLY is checked here rather than left to the UI, because two of them are
        // actively wrong rather than merely useless: `terminal` runs `cd <path>`, which fails on a
        // file, and a `cli:<runner>` handoff would start an agent session inside the config folder.
        // A route is a surface of its own; it refuses what it cannot do correctly.
        if (target !== undefined) {
          if (agentCliRunner(target) !== null) {
            return c.json({ error: 'agent CLIs open a task worktree, not a config folder' }, 400);
          }
          if (target === 'terminal' && file !== 'folder') {
            return c.json({ error: 'a terminal opens a folder, not a file' }, 400);
          }
          if (!detectOpenTargets().some((candidate) => candidate.id === target)) {
            return c.json({ error: `no such app on this machine: ${target}` }, 400);
          }
        }
        const opened = target === undefined
          ? await openFile(path)
          : await openApp(target, path);
        if (!opened) return c.json({ error: `could not open ${basename(path)}`, path }, 409);
        return c.json({ opened: true as const, path });
      },
    )

    // Which account a PROJECT uses. On the accounts family rather than `PATCH /api/v1/projects`
    // because the selection is stored beside the accounts it names — one file, one atomic write,
    // and nothing about it can be dropped by a cezar version that never heard of accounts.
    .put(
      '/workspace/agent-profiles/selection',
      jsonZodValidator(() => selectAgentProfileSchema),
      async (c) => {
        if (!capabilities().localHandoff) return c.json(hostedProfileRefusal, 409);
        const { projectId, provider, profileId } = c.req.valid('json');
        // `null` writes the MACHINE-WIDE default instead of one repo's selection: the account any
        // repo that has chosen nothing uses, so a second login is set up once rather than per
        // checkout. No project to resolve, and therefore no 404 path.
        let root: string | null = null;
        if (projectId !== null) {
          const resolvedId = projectId === 'default' ? await resolveBootProject() : projectId;
          // Keyed by repo ROOT, so the selection survives the registry being rebuilt and needs no
          // cross-reference into config.json. An unknown project is a 404 rather than an orphan
          // entry nobody will ever read.
          root = await projectRootFor(resolvedId);
          if (root === null) return c.json({ error: `unknown project: ${projectId}` }, 404);
        }
        // A user naming an account that does not exist gets told so — the opposite of how RUN
        // resolution treats a dangling stored id, and deliberately: a run has no better answer
        // than the default, a person does.
        if (profileId !== null && profileId !== DEFAULT_AGENT_ACCOUNT_ID) {
          const account = await resolveWorkspaceProfile(provider, profileId);
          if ('error' in account) return c.json({ error: account.error }, 400);
        }
        let store: AgentAccountStore;
        try {
          store = await mergeWriteAgentAccounts((current) => {
            // One rule, two targets: the machine default is the same per-provider shape as a repo's
            // selection, so it clears the same way rather than growing its own spelling.
            const selection = root === null ? current.defaults : current.selections[root] ?? {};
            // `null` and the reserved `default` both mean "back to the discovered account", which
            // is stored as ABSENCE — the default id is never written to the file.
            if (profileId === null || profileId === DEFAULT_AGENT_ACCOUNT_ID) delete selection[provider];
            else selection[provider] = profileId;
            // The machine default keeps an emptied object where a repo selection is deleted, and
            // that asymmetry is the schema's, not an oversight: `defaults` is one FIXED field with
            // `.default(() => ({}))`, so `mergeWriteAgentAccounts` re-materializes it on the next
            // write no matter what this one omits (verified). `selections` is a growing MAP, where
            // an emptied entry is a row per repo ever touched that says nothing. The rule stated
            // for `agentDefaults.models` — "absence is the same answer" — applies there because
            // that key is `.optional()`, so deleting it actually sticks.
            if (root === null) current.defaults = selection;
            else if (Object.keys(selection).length === 0) delete current.selections[root];
            else current.selections[root] = selection;
          });
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
        return c.json({ selections: store.selections, defaults: store.defaults });
      },
    )

    .delete(
      '/workspace/agent-profiles/:id',
      paramZodValidator(z.object({ id: z.string() })),
      async (c) => {
        if (!capabilities().localHandoff) return c.json(hostedProfileRefusal, 409);
        const id = c.req.param('id');
        let removed = false;
        // Captured inside the mutator, because after the write there is nothing left to ask which
        // provider this account belonged to — and the eviction below is keyed by it.
        let removedProvider: ProviderId | undefined;
        try {
          await mergeWriteAgentAccounts((store) => {
            const before = store.accounts.length;
            removedProvider = store.accounts.find((a) => a.id === id)?.provider;
            store.accounts = store.accounts.filter((a) => a.id !== id);
            removed = store.accounts.length < before;
            if (!removed) return;
            // Scrub every reference IN THE SAME MUTATOR — the reason selections share this file.
            // A two-call delete-then-scrub can be observed mid-way by another cezar process on
            // this machine, which would then resolve a dangling id; harmless today (it degrades
            // to the default) but only by luck.
            for (const [root, selection] of Object.entries(store.selections)) {
              for (const key of Object.keys(selection) as Array<keyof typeof selection>) {
                if (selection[key] === id) delete selection[key];
              }
              if (Object.keys(selection).length === 0) delete store.selections[root];
            }
          });
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
        if (!removed) return c.json({ error: `unknown account: ${id}` }, 404);
        // Only this account's answer: it is about to stop existing, and holding it would let a
        // re-added account with the same id read the deleted one's state.
        providerAuth.forgetProfileStatus(removedProvider, id);
        return c.json({ removed: true as const, id });
      },
    );

  // ---- workspace projects (multi-project spec) -----------------------------
  // The registered-project list for the cockpit sidebar. Same-origin (unlike
  // health), so absolute `root`s are fine here. `listProjects()` TTL-caches
  // its per-root status/branch probes, so a burst of renders never shells git
  // N times. Never 404s: empty or unreadable registry → `projects: []`.
  /** The configured checkout root, as WRITTEN (`~` kept — callers that touch
   *  the filesystem expand it). An unreadable workspace degrades to the
   *  default rather than failing the request: every caller here is a route
   *  that must keep answering. */
  const workspaceProjectsDir = async (): Promise<string> => {
    try {
      return (await loadWorkspaceConfig()).projectsDir;
    } catch {
      return defaultWorkspaceConfig().projectsDir;
    }
  };

  const workspaceBrowseRoot = async (): Promise<string> => {
    try {
      return (await loadWorkspaceConfig()).browseRoot;
    } catch {
      return defaultWorkspaceConfig().browseRoot;
    }
  };

  /**
   * D4's root→org registry seam — **EXTRACTED 2026-08-07 (D13 repair round 3, FIX 3) to
   * `./project-team-registry.ts`**, so `registered-project-roots.ts#releaseProjectTeamClaim` (the
   * `cezar projects remove` path, which has no HTTP request and no resolved `Principal` to build
   * this closure from) can share the identical seam instead of opening `IdentityStore` directly and
   * silently missing a claim held by the supervisor on the D10 topology. See that module's own doc
   * comment for the full reasoning; nothing here closes over `ServerDeps`, so the move is
   * behavior-preserving for every call site below.
   *
   * **CORRECTED 2026-08-07 (D13, phase 9): the sentence below described `kind`, and the gate moved
   * to `hasOrgScope`.** A principal with NO org (`!hasOrgScope(principal)` — `CEZ_AUTH` unset with
   * no local org yet) never reaches `openProjectTeamRegistry` — every call site below guards on
   * `hasOrgScope` first, exactly as they guarded on `principal.kind === 'session'` before this seam
   * existed — so D1's "unset means zero I/O" and D7's "the module is never imported" both hold
   * literally for that case: the function is never even called, let alone the dynamic imports
   * inside either branch it can reach. Once a LOCAL principal has a real org (D13's onboarding
   * wizard), `hasOrgScope` is true and it DOES run — deliberately: `kind` stays `'local'`
   * throughout, because `kind` only ever means "was this request authenticated" (see `hasOrgScope`,
   * `auth/principal.ts`), never "does it have an org".
   */

  /**
   * Attach `teamId`/`teamName` to registry entries (Phase 5, D5: "Team is metadata on a project
   * used for grouping and filtering, NOT a scope"). The ONE place either field is ever put on a
   * `ProjectListEntry` — both the GET listing and the POST registration answer through this, so
   * the two cannot report a different team for the same root.
   *
   * **A principal with no org (`!hasOrgScope(principal)` — D13) returns `projects` untouched, by
   * identity.** No call to `openProjectTeamRegistry()` at all — D1's "unset means zero I/O" and
   * D7's "the module is never imported" both still hold for that case, and the pre-onboarding
   * listing payload is byte-identical to the pre-Phase-5 build. Once a local principal HAS an org
   * (D13), `hasOrgScope` is true and this annotates its listing exactly like a signed-in
   * session's — `kind` stays `'local'` either way (D13: `kind` means authenticated, never
   * org-scoped).
   *
   * **Annotates; deliberately does NOT filter.** Under D4 cross-org isolation is an OS process
   * boundary that phase 6 delivers, and the spec's Risks section names shipping tenancy-shaped
   * behaviour before then as the largest risk here. Quietly org-scoping this one listing while
   * every other route stays open would read as an isolation control without being one. A root
   * claimed by a DIFFERENT org does stay unannotated, though — `listProjectTeams` is filtered to
   * the caller's own org, so another org's team id and name are never handed out.
   *
   * **Best-effort, not a security check.** Unlike `mayActOnRoot` below, this only decorates a
   * listing — a registry that cannot be reached (the phase 6+ HTTP path) degrades to the
   * unannotated listing rather than failing the whole request, matching every other
   * "unreadable workspace — degrade" read already in this file.
   */
  const withTeams = async (projects: ProjectListEntry[], principal: Principal): Promise<ProjectListEntry[]> => {
    if (!hasOrgScope(principal) || projects.length === 0) return projects;
    let claims: Map<string, string>;
    let teamNames: Map<string, string>;
    try {
      const registry = await openProjectTeamRegistry();
      // Two whole-table reads, never one lookup per project: the local `IdentityStore` keeps no
      // in-memory cache and re-parses `identity.json` on EVERY read (its own module doc explains
      // why that is deliberate), so a per-entry `getProjectTeam` would re-parse the file once per
      // registered project on every sidebar render — and the remote path pays a round trip per
      // call, which the same batching avoids paying once per project too.
      const rows = await registry.listProjectTeams({ orgId: principal.orgId });
      if (rows.length === 0) return projects;
      claims = new Map(rows.map((row) => [row.projectRoot, row.teamId]));
      teamNames = new Map((await registry.listTeams(principal.orgId)).map((team) => [team.id, team.name]));
    } catch {
      return projects;
    }
    return projects.map((project) => {
      // Keyed on the realpath both sides normalize to: `registerProject` stores `normalizeRoot`'s
      // output as `root`, and `createProjectTeam` realpaths its input again (idempotent on an
      // already-canonical string) before using it as the `project_teams` PRIMARY KEY.
      const teamId = claims.get(project.root);
      if (teamId === undefined) return project;
      const teamName = teamNames.get(teamId);
      // CORRECTED 2026-08-07 (5b/5c/8 repair stage): this used to say "unreachable today (nothing
      // deletes a team)". Something does now — `DELETE /auth/teams/:teamId` (`auth/team-routes.ts`)
      // — the same correction `auth/onboarding-routes.ts` already applied to the identical sentence
      // about `renameTeam`, and this sibling was the one it missed. The branch remains unreachable,
      // but for a DIFFERENT reason: `IdentityStore#deleteTeam` refuses (`team-has-projects`) while
      // any project still claims the team, so a claim can never outlive its team. Kept anyway,
      // because emitting `teamName: undefined` would put the key on the wire as `null` through
      // JSON, which the closed contract does not describe. Omit it instead.
      return teamName === undefined ? { ...project, teamId } : { ...project, teamId, teamName };
    });
  };

  /**
   * D4's org boundary, applied to a root the caller did **not** just register (ADDED 2026-08-07,
   * repair stage). `false` ⇒ this root is claimed by a DIFFERENT org and the caller must be
   * refused.
   *
   * **Why this exists.** Phase 5 enforced "one root, one org" at `POST /api/v1/projects` and
   * nowhere else, so a second org could `DELETE` and `PATCH` the first org's registry row and read
   * every project-scoped route on it. Reproduced at review with two seeded orgs: eight routes
   * answered 200, `DELETE` unregistered the project, and the `project_teams` row survived as an
   * orphan. Not reachable through HTTP today (no route creates a second org or a second
   * membership) — but "enforced on create, ignored on destroy" is a mapping a phase-6 reader would
   * reasonably trust, so the asymmetry is closed rather than annotated.
   *
   * Deliberately covers the two WRITE verbs only. Org-scoping the project-scoped *reads* is a
   * different decision: D4 says cross-org isolation is an OS process boundary phase 6 delivers,
   * and the spec's Risks section names quietly shipping tenancy-shaped behaviour before then as
   * the largest risk here. Destroying another org's registration is not "tenancy-shaped
   * behaviour", it is data loss.
   *
   * `!hasOrgScope(principal)` (no `CEZ_AUTH` and no local org yet, D13) returns `true` having done
   * ZERO I/O — no call to `openProjectTeamRegistry()` — so D1/D7 hold exactly as they do for
   * `withTeams`. Once a local principal has a real org, `hasOrgScope` is true and this DOES read
   * the registry, same as a signed-in session — `kind` stays `'local'` either way (D13: `kind`
   * means authenticated, never org-scoped).
   *
   * **This IS the D4 boundary, not an annotation** (ADDED phase 6, D10) — unlike `withTeams`'s
   * best-effort decoration, a registry that cannot be reached must refuse, never silently allow: a
   * caught error here answers `false`, the exact same refusal a genuinely cross-org claim gets, so
   * an unreachable supervisor fails CLOSED rather than opening the boundary it exists to enforce.
   *
   * **ADDED 2026-08-07 (5b/5c/8 repair stage): in SUPERVISOR mode the refusal now arrives through
   * that same catch, and that is deliberate.** `GET /internal/project-teams/by-root` used to answer
   * any authenticated org with any org's claim, so the comparison below did the refusing; it is now
   * org-scoped like every sibling verb on that path, so a foreign claim comes back 403 →
   * `RegistryClientError('unauthorized')` → `catch` → `false`. Same answer, enforced on the side of
   * the process boundary that can actually enforce it. The LOCAL (single-process) registry is
   * unchanged and still returns the row, so the `claim.orgId === principal.orgId` comparison below
   * is still live and still load-bearing on that path — it is not dead code on either topology.
   */
  const mayActOnRoot = async (root: string, principal: Principal): Promise<boolean> => {
    if (!hasOrgScope(principal)) return true;
    try {
      const claim = await (await openProjectTeamRegistry()).getProjectTeam(root);
      return claim === undefined || claim.orgId === principal.orgId;
    } catch {
      return false;
    }
  };

  /**
   * Release this root's `project_teams` claim after a successful unregistration — see
   * `IdentityStore#deleteProjectTeam`'s own doc comment for why leaving it behind is a bug and not
   * merely untidy (the orphan makes a later re-registration silently inherit the old team). Same
   * zero-I/O auth-off contract as `mayActOnRoot` above. Unlike `withTeams`, a failure here is
   * deliberately NOT swallowed: it propagates, so the caller sees a 500 rather than a silently
   * orphaned claim.
   *
   * **The transient-failure window is closed one layer down (ADDED 2026-08-07, phase 6/7 repair
   * stage), not here.** Before phase 6 this was a local write behind D7's `O_EXCL` lease, where a
   * failure meant something was genuinely wrong with the filesystem. It is now a 5 s `fetch` to
   * another process, where a single blip — supervisor mid-restart, a `systemctl reload`, a
   * momentarily saturated loopback — is an ordinary event that would orphan the claim. The retry
   * lives in `supervisor/registry-client.ts#deleteProjectTeam`, which owns `RegistryClientError`
   * and can therefore retry only the transport failure (`unreachable`) rather than duck-typing an
   * error class this module deliberately does not import (D7: `CEZ_AUTH` unset ⇒ the supervisor
   * module is never even loaded, which a top-level `import` here would break).
   *
   * **Why the ordering above it stays as it is.** The release runs AFTER `removeProject`, not
   * before, and both orderings have a failure mode — but they are not equally bad. Release-first
   * with a failing `removeProject` drops a live claim on a root this process is still serving, so
   * another org can take it: two processes over one leaseless `.ai/cezar`, which is D4's silent
   * run-history loss. Remove-first with a failing release leaves an orphan that the SAME org can
   * still re-register (`mayActOnRoot` compares `claim.orgId`, so no other org can), inheriting a
   * stale team. A recoverable annotation bug beats unrecoverable data loss, so the window gets
   * closed by retrying rather than by reversing the ordering.
   */
  const releaseRootClaim = async (root: string, principal: Principal): Promise<void> => {
    if (!hasOrgScope(principal)) return;
    await (await openProjectTeamRegistry()).deleteProjectTeam(root);
  };

  /** The one wording both write verbs answer a cross-org attempt with — identical to
   *  `registerFolder`'s refusal, so a client never has to learn two spellings of one fact. */
  const CROSS_ORG_REFUSAL = { error: 'this project is already registered to a different organization' } as const;

  // ---- chained family: project registry (workspace-level) ----
  const projectsRoutes = new Hono<ProjectApiEnv>()
    .get('/projects', async (c) => {
      let projects: ProjectListEntry[] = [];
      let projectsDir = defaultWorkspaceConfig().projectsDir;
      try {
        projectsDir = (await loadWorkspaceConfig()).projectsDir;
        const selector = capabilities().singleProject
          ? { projectId: await resolveBootProject() }
          : undefined;
        projects = await listProjects(selector);
      } catch {
        // unreadable workspace — degrade to the empty registry + defaults
      }
      // Phase 5: the team the board's filter groups by. Without this the `teamId`/`teamName`
      // fields would exist on the contract and be populated only by the registration response —
      // i.e. the cockpit's team filter would have data for exactly the project you just added and
      // none after a reload, which is a feature that is load-bearing but not reachable.
      const principal = (c as unknown as Context<{ Variables: { principal: Principal } }>).get('principal');
      projects = await withTeams(projects, principal);
      const body: ProjectsResponse = {
        projects,
        bootProject: await resolveBootProject(projects),
        projectsDir,
      };
      return c.json(body);
    })

    /**
     * Every git repo inside a folder, so "Add project" can offer each one as its own project
     * (spec `.ai/specs/2026-08-14-nested-repos-as-projects.md`, which REVERSED
     * `2026-08-06-nested-repos-cockpit-scope.md` D1's "nested repos are not projects").
     *
     * A READ. It never writes the registry — the dialog posts the rows the user keeps to
     * `POST /api/v1/projects`, one at a time, through the guards every other add goes through
     * (D4). That is why this route has no `teamId` and no side effect to undo.
     *
     * Containment is `resolveBrowsableDir`, the same gate `GET /api/v1/fs/browse` runs — not a
     * second copy of it (D5). This route hands back directory STRUCTURE, so a permissive
     * spelling here would walk around the browse-root narrowing exactly as a permissive
     * fs-browse would; sharing the function is what stops the two from drifting apart.
     */
    .get('/projects/scan', queryZodValidator(z.object({ path: queryValue })), async (c) => {
      if (capabilities().singleProject) {
        return c.json(singleProjectRefusal('folder browsing'), 409);
      }
      const resolved = await resolveBrowsableDir({
        root: resolveBrowseRoot(await workspaceBrowseRoot()),
        path: c.req.valid('query').path,
      });
      if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);

      const scan = await scanNestedRepos(resolved.real);
      const repos = await enrichNestedRepos(scan.repos);
      // Which rows are already projects. Read from the registry ONCE, and compared on the realpath
      // key the registry stores (`normalizeRoot`) rather than on the walked spelling — a project
      // added through a symlinked path is the same project, and rendering it as addable would put
      // a checkbox on a row whose POST can only ever answer 409.
      let known = new Set<string>();
      try {
        known = new Set((await loadWorkspaceConfig()).projects.map((p) => p.root));
      } catch {
        // Unreadable workspace: every row renders as not-yet-registered. The POST still refuses a
        // duplicate, so the cost of being wrong here is a redundant request, not a duplicate row.
      }
      const body: ProjectScanResponse = {
        root: resolved.real,
        rootIsRepo: await stat(join(resolved.real, '.git')).then(() => true).catch(() => false),
        repos: await Promise.all(
          repos.map(async (repo) => ({
            ...repo,
            registered: known.has(await normalizeRoot(repo.path)),
          })),
        ),
        truncated: scan.truncated,
      };
      return c.json(body);
    })

    /**
     * What "Set up git" would do to a folder (spec
     * `.ai/specs/2026-08-15-import-all-folders-as-projects.md`, D4). A READ — it writes nothing,
     * and the answer is a thing to RENDER, never a thing the POST below trusts.
     *
     * Both git routes ask TWO questions, where every route before them asked one, because they are
     * the first pair that WRITES to an operator-named path:
     *
     * 1. `resolveBrowsableDir` — the shared containment gate (lexical, then realpath). Same
     *    function as `fs/browse` and `/projects/scan`, never a second copy.
     * 2. `shouldRegisterProject` — `$HOME` and cezar task worktrees. `git init` + `git add -A` in a
     *    home directory is a far worse outcome than registering one, and this guard is where
     *    "not a project folder" is already defined.
     */
    .get('/projects/git-preflight', queryZodValidator(z.object({ path: queryValue })), async (c) => {
      if (capabilities().singleProject) {
        return c.json(singleProjectRefusal('folder browsing'), 409);
      }
      const resolved = await resolveBrowsableDir({
        root: resolveBrowseRoot(await workspaceBrowseRoot()),
        path: c.req.valid('query').path,
      });
      if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
      if (!(await shouldRegisterProject(resolved.real))) {
        return c.json({ error: 'not a project folder: this is your home directory or a cezar task worktree' }, 400);
      }
      const body: GitPreflightResponse = await preflightGitInit(resolved.real);
      return c.json(body);
    })

    /**
     * Run it: `git init -b main`, `.gitignore` for every detected secret, `git add -A`, first
     * commit (D4/D5).
     *
     * The body is a path and NOTHING else, and this handler re-runs `preflightGitInit` itself
     * inside `initGitRepo`. A request that could carry `sensitive: []` would be a request that can
     * decide to commit somebody's `.env` — so the shape simply cannot express it.
     *
     * Both gates from the preflight above are re-asked here rather than assumed from the GET: the
     * two calls are separate requests, nothing links them, and a guard that runs only on the read
     * half is a guard on the wrong half.
     */
    .post('/projects/git-init', jsonZodValidator(() => gitInitRequestSchema, { message: 'path must be a non-empty path' }), async (c) => {
      if (capabilities().singleProject) {
        return c.json(singleProjectRefusal('folder browsing'), 409);
      }
      const resolved = await resolveBrowsableDir({
        root: resolveBrowseRoot(await workspaceBrowseRoot()),
        path: c.req.valid('json').path,
      });
      if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
      if (!(await shouldRegisterProject(resolved.real))) {
        return c.json({ error: 'not a project folder: this is your home directory or a cezar task worktree' }, 400);
      }
      const result = await initGitRepo(resolved.real);
      if (!result.ok) return c.json({ error: result.error }, result.status);
      // The probe cache is keyed on the root and holds `not-git`/`no-commits` for up to its TTL —
      // stale by exactly the change just made. Dropped here so the registry answers with the repo
      // that now exists rather than the folder that used to.
      clearProjectProbeCache();
      const body: GitInitResponse = result.body;
      return c.json(body);
    })

    .post('/projects', jsonZodValidator(() => registerProjectSchema, { message: 'root must be a non-empty path' }), async (c) => {
      const parsed = { data: c.req.valid('json') };
      const principal = (c as unknown as Context<{ Variables: { principal: Principal } }>).get('principal');
      const registered = await registerFolder(parsed.data.root, 'local', principal, parsed.data.teamId);
      if (registered.status !== 200) return c.json(registered.body, registered.status);
      return c.json(registered.body, 200);
    })

    // D15 — create a blank project: `<projectsDir>/<name>` + `git init`, then register it through
    // the SAME `registerFolder` guards every other project-adding path uses (single-project
    // refusal, browse-root containment, `$HOME`/worktree refusal, the D4 root→org claim). The
    // directory is created first and registered second, deliberately in that order: `registerFolder`
    // stats the path and refuses one that does not exist.
    .post('/projects/blank', jsonZodValidator(() => blankProjectSchema, { message: 'name must be a valid folder name' }), async (c) => {
      if (capabilities().singleProject) {
        return c.json(singleProjectRefusal('adding projects'), 409);
      }
      const { name, teamId } = c.req.valid('json');
      const parent = expandTilde(await workspaceProjectsDir());
      const target = join(parent, name);

      // Refuse an existing directory rather than adopting it. "Create blank" must never silently
      // hand back someone else's folder — that is what the local-directory path is for, and it
      // shows the user what they are picking.
      if (existsSync(target)) {
        return c.json({ error: `already exists: ${target}` }, 409);
      }
      try {
        await mkdir(target, { recursive: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: `could not create ${target}: ${message}` }, 500);
      }

      const init = deps.gitInitRunner ?? defaultGitInit;
      const initialized = await init(target);
      if (!initialized.ok) {
        // The directory exists and is empty, and `git` is the thing that failed — so this DOES
        // clean up, unlike the checkout route's deliberate "the clone is legitimately the user's
        // files" stance. There is nothing here worth keeping and a stray empty folder in the
        // projects dir would be re-offered as "already exists" on the next attempt with the same
        // name, turning one transient git failure into a permanently blocked name.
        await rm(target, { recursive: true, force: true }).catch(() => {});
        return c.json({ error: `could not initialize a git repository: ${initialized.error}` }, 500);
      }

      const principal = (c as unknown as Context<{ Variables: { principal: Principal } }>).get('principal');
      const registered = await registerFolder(target, 'local', principal, teamId);
      if (registered.status !== 200) {
        // Same reasoning as the cleanup above, and the same limit on it: registration failed on a
        // directory this route just created and nobody has put anything in, so removing it is
        // safe. `registerFolder`'s own error is passed through with the location appended, matching
        // the checkout route's wording discipline.
        await rm(target, { recursive: true, force: true }).catch(() => {});
        const { body } = registered;
        const error = 'error' in body && body.error ? body.error : 'could not register the new project';
        return c.json({ error: `${error} (at ${target})` }, registered.status);
      }
      return c.json(registered.body, 200);
    })

    .delete('/projects/:projectId', async (c) => {
      if (capabilities().singleProject) {
        return c.json(singleProjectRefusal('removing projects'), 409);
      }
      const raw = c.req.param('projectId');
      // Same gate the scoped-route resolver applies, and the same 404 wording —
      // a malformed id is an unknown project, not a validation essay.
      if (!projectIdSchema.safeParse(raw).success) {
        return c.json({ error: `unknown project: ${raw}` }, 404);
      }
      const bootId = await resolveBootProject();
      // `default` is the boot alias everywhere else in the API; honour it here
      // too rather than 404ing a spelling the cockpit is allowed to use.
      const id = raw === 'default' ? bootId : raw;

      let entry: WorkspaceProject | undefined;
      try {
        entry = (await loadWorkspaceConfig()).projects.find((p) => p.id === id);
      } catch {
        // unreadable workspace — there is nothing to remove, and saying so is
        // more useful than a 500 the user cannot act on
      }
      if (!entry) return c.json({ error: `unknown project: ${id}` }, 404);

      // D4: another org's root is not this caller's to unregister (see `mayActOnRoot`). Checked
      // before every other refusal below so a cross-org caller cannot use the ORDER of the
      // answers as an oracle for whether the project is the boot project or has running tasks.
      const deletePrincipal = (c as unknown as Context<{ Variables: { principal: Principal } }>).get('principal');
      if (!(await mayActOnRoot(entry.root, deletePrincipal))) return c.json(CROSS_ORG_REFUSAL, 409);

      // The boot project is refused, not removed: `cezar serve` re-registers the
      // repo it was started in on every boot, so "removing" it would undo itself
      // at the next restart while breaking this session's sidebar in the
      // meantime. The pane disables the button and says the same thing.
      if (id === bootId) {
        return c.json(
          {
            error: `cezar is serving ${entry.name} right now — it re-registers itself at every start, so it cannot be removed from here`,
          },
          409,
        );
      }

      const active = activeRunCount(id);
      if (active > 0) {
        return c.json(
          {
            error: `${entry.name} has ${active} running task${active === 1 ? '' : 's'} — cancel or finish ${active === 1 ? 'it' : 'them'} before removing the project`,
            runningTasks: active,
          },
          409,
        );
      }

      let removed: boolean;
      try {
        removed = await removeProject(id);
      } catch (err) {
        // e.g. a read-only home — nothing was persisted (atomic tmp+rename).
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
      // Lost a race with another writer (or another cezar process): the entry is
      // gone, which is what the caller wanted, but say it honestly.
      if (!removed) return c.json({ error: `unknown project: ${id}` }, 404);
      // The root is no longer registered here, so this org no longer holds it (D4). Released
      // AFTER the registry write, not before: if `removeProject` had failed we would have dropped
      // a live claim and let another org take a root this process is still serving.
      await releaseRootClaim(entry.root, deletePrincipal);
      // In-process handles for a project no route can reach any more: store
      // closed (index flushed), manager's timers and usage subscription dropped.
      contexts.dispose(id);
      workspaceEvents.emit('project-removed', { id });
      const body: RemoveProjectResponse = { removed: true, id };
      return c.json(body);
    })

    // Edit the per-project registry fields the cockpit owns: the concurrency ceiling (spec
    // 2026-07-22-per-project-concurrency) and the grouping tags (spec
    // 2026-08-10-global-tasks-and-project-tags). A PATCH (not PUT) because it touches named
    // fields and leaves the rest of the entry alone, and a distinct route from POST
    // (register-a-folder) to keep register vs. edit semantics clear.
    //
    // The body schema is the CONTRACT's, passed directly rather than restated behind a thunk:
    // it is already in scope, and a second copy is a second thing to keep in step. Its bounds
    // mirror `workspaceProjectSchema` (config.ts) exactly, so a value this route accepts can
    // never be degraded away by the next load's `.catch`.
    //
    // Deliberately NOT the home of the agent-account selection: that lives in
    // `~/.cezar/agent-accounts.json` beside the accounts it names, so a cezar version that has
    // never heard of accounts cannot drop it (see workspace/agent-accounts.ts).
    .patch('/projects/:projectId', jsonZodValidator(updateProjectInputSchema), async (c) => {
      if (capabilities().singleProject) {
        return c.json(singleProjectRefusal('editing projects'), 409);
      }
      const raw = c.req.param('projectId');
      // Same gate + 404 wording as DELETE: a malformed id is an unknown project.
      if (!projectIdSchema.safeParse(raw).success) {
        return c.json({ error: `unknown project: ${raw}` }, 404);
      }
      const parsed = { data: c.req.valid('json') };
      // `default` is the boot alias the cockpit is allowed to use everywhere else.
      const id = raw === 'default' ? await resolveBootProject() : raw;
      const { maxParallel, teamId, tags } = parsed.data;

      // Read-first (mirroring DELETE, server.ts:1252-1258): a well-formed but
      // unknown id must 404 WITHOUT rewriting the config — otherwise it would both
      // do a needless full-config tmp+rename and, on a read-only home, surface the
      // write failure as a 500 where the honest answer is 404.
      let existing: WorkspaceProject | undefined;
      try {
        existing = (await loadWorkspaceConfig()).projects.find((p) => p.id === id);
      } catch {
        // unreadable workspace — treat as unknown; the read-only case answers 404,
        // not a 500 the caller cannot act on (same reasoning as DELETE).
      }
      if (!existing) return c.json({ error: `unknown project: ${id}` }, 404);
      // D4, same guard and same wording as DELETE above: `maxParallel`/`teamId` are that project's
      // own settings, and another org's are not this caller's to move.
      const patchPrincipal = (c as unknown as Context<{ Variables: { principal: Principal } }>).get('principal');
      if (!(await mayActOnRoot(existing.root, patchPrincipal))) return c.json(CROSS_ORG_REFUSAL, 409);

      // 5c (D2/D4, ADDED 2026-08-07): `teamId` reassigns this project's team WITHIN its owning
      // org. Applied BEFORE the `maxParallel` write below, so a refused reassignment (unknown
      // team, a team from a different org) leaves `maxParallel` untouched too — one PATCH, one
      // outcome, never a half-applied body. A principal with no org yet (`!hasOrgScope(principal)`
      // — `CEZ_AUTH` unset with no local org, D13, or a hosted deployment before phase 6) has no
      // org to reassign FROM, so this field is REJECTED rather than silently ignored (contract's
      // own doc comment on `updateProjectInputSchema.teamId`).
      //
      // **CORRECTED 2026-08-07 (D13, phase 9): the 400 below used to say "requires an
      // authenticated session" — that was never the real precondition, and D13 makes the gap
      // visible: a LOCAL principal (never authenticated, `kind === 'local'`) can satisfy
      // `hasOrgScope` once it has onboarded, and would then have been refused by a message naming
      // a fact about itself that is true and irrelevant. The real precondition, in both modes, is
      // an organization to reassign within — so that is what the message names.**
      if (teamId !== undefined) {
        if (!hasOrgScope(patchPrincipal)) {
          return c.json({ error: 'teamId requires an organization — there is no org to reassign a team within' }, 400);
        }
        const result = await (await openProjectTeamRegistry()).updateProjectTeam(existing.root, teamId);
        if (!result.ok) {
          if (result.code === 'project-root-not-found') {
            return c.json({ error: 'this project has no team assignment to reassign — it was never claimed by an organization' }, 400);
          }
          if (result.code === 'team-not-found') {
            return c.json({ error: `unknown team: ${teamId}` }, 400);
          }
          return c.json({ error: 'cannot move a project to a team outside its own organization' }, 409);
        }
      }

      // `maxParallel` absent (Fill unit 3, 5c widening) means "leave the concurrency override
      // untouched" — skip the write entirely rather than round-tripping the config for nothing,
      // the same "no needless write" discipline the read-first 404 above already follows. A
      // `teamId`-only PATCH therefore costs exactly one write (the team reassignment above), not
      // two.
      let updated: WorkspaceProject = existing;
      if (maxParallel !== undefined || tags !== undefined) {
        let written: WorkspaceProject | undefined;
        try {
          await mergeWriteWorkspaceConfig((config) => {
            const entry = config.projects.find((p) => p.id === id);
            if (!entry) return; // lost a race with a concurrent remove — answered below
            // Each key is applied only when the body NAMED it (#845): a PATCH that says nothing
            // about a field must leave it exactly as it was, which is what keeps the tags editor
            // from clearing a concurrency ceiling — and the pre-tags `{ maxParallel }` body from
            // clearing tags. null clears; a value sets. Mutated in place so `.passthrough()` keys
            // on the entry survive.
            if (maxParallel !== undefined) {
              if (maxParallel === null) delete entry.maxParallel;
              else entry.maxParallel = maxParallel;
            }
            if (tags !== undefined) {
              // Normalized on the way IN, so every reader — this API, the CLI, the global Tasks
              // page — sees one spelling per tag and never has to fold case itself.
              const normalized = normalizeProjectTags(tags);
              if (normalized === undefined) delete entry.tags;
              else entry.tags = normalized;
            }
            written = entry;
          });
        } catch (err) {
          // e.g. a read-only home — nothing was persisted (atomic tmp+rename).
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
        // Raced with a concurrent removal between the read and the write.
        if (!written) return c.json({ error: `unknown project: ${id}` }, 404);
        updated = written;

        // The new ceiling takes effect WITHOUT a restart: refresh the shared semaphore's snapshot
        // and pump every manager — the same live-apply hook `PUT /api/workspace/config` fires for
        // a workspace-cap change. Only a `maxParallel` change needs it; a tags-only PATCH does not.
        if (maxParallel !== undefined) await deps.semaphore?.refresh();
      }

      let project: ProjectListEntry = { ...updated, ...(await probeProjectStatus(updated.root)) };
      // Read the team assignment back through the SAME `withTeams` the GET listing uses (5c),
      // rather than restating `teamId` here — that literal is only what this handler *intended* to
      // write, and `withTeams` reports what `project_teams` actually holds now. Mirrors
      // `registerFolder`'s own "read the answer back" comment above for the identical reason.
      project = (await withTeams([project], patchPrincipal))[0] ?? project;
      const body: UpdateProjectResponse = { project };
      return c.json(body);
    })

    .post('/projects/checkout', jsonZodValidator(() => checkoutSchema, { message: 'url must be a GitHub repository' }), async (c) => {
      if (capabilities().singleProject) {
        return c.json(singleProjectRefusal('adding projects'), 409);
      }
      const parsed = { data: c.req.valid('json') };
      const { url, name, checkoutId } = parsed.data;
      const result = await checkoutRepo({
        url,
        name,
        checkoutId,
        projectsDir: expandTilde(await workspaceProjectsDir()),
        onProgress: (event) => workspaceEvents.emit('checkout-progress', event),
        // A closed dialog / navigated-away tab aborts the request; the clone is
        // killed and its partial directory removed rather than left running.
        signal: c.req.raw.signal,
        ...(deps.cloneRunner ? { run: deps.cloneRunner } : {}),
      });
      if (!result.ok) {
        // `reason` rides along on the 503 (`gh` unavailable) — the spec's
        // `{ error, reason }` degradation, mirroring the GitHub pane.
        return c.json(
          'reason' in result ? { error: result.error, reason: result.reason } : { error: result.error },
          result.status,
        );
      }
      const principal = (c as unknown as Context<{ Variables: { principal: Principal } }>).get('principal');
      const registered = await registerFolder(result.target, 'checkout', principal, parsed.data.teamId);
      if (registered.status !== 200) {
        // The clone SUCCEEDED and its files are legitimately the user's, so this
        // path deliberately does NOT clean up — an unregisterable checkout is a
        // registry problem, not a reason to delete a repo we just fetched. Say
        // where it is so they can register it by hand.
        const { body } = registered;
        const error = 'error' in body && body.error ? body.error : 'could not register the checkout';
        return c.json({ error: `${error} (the clone is at ${result.target})` }, registered.status);
      }
      return c.json(registered.body, 200);
    });

  // Register an existing folder (multi-project spec, "Add project" — the
  // folder-browser dialog's commit step, step 4.2). Workspace-level like its
  // GET twin. Everything here is a guard; the registry write itself is one
  // idempotent `registerProject` call.
  //
  // `teamId` is additive (Phase 5, D8 step 4: "add projects, assigned to that
  // team — the only new input is the team"). Absent under `CEZ_AUTH` unset
  // (ignored — see `registerFolder`'s own comment) and, under real auth,
  // absent means "the signed-in user's own default team" rather than a
  // required field, so a client that predates Phase 5 keeps working unchanged.
  const registerProjectSchema = z.object({
    root: z.string().trim().min(1).max(4096),
    teamId: z.string().trim().min(1).max(200).optional(),
  });

  /**
   * The register-a-folder half of `POST /api/projects`, factored out so the
   * checkout route (step 4.3) commits its fresh clone through the SAME guards
   * and the same `project-added` emission rather than a second copy of them.
   * Returns the status + body for the caller to answer with.
   *
   * `principal` and `teamId` are Phase 5 additions (spec
   * `.ai/specs/2026-08-06-org-team-auth-onboarding.md`, D4/D5/D8): which org (and,
   * optionally, which team) the freshly-registered — or freshly-touched — root gets
   * assigned to. **CORRECTED 2026-08-07 (D13, phase 9): the gate below moved from `kind` to
   * `hasOrgScope`.** `!hasOrgScope(principal)` (`CEZ_AUTH` unset with no local org yet) is the D1
   * zero-I/O case: every identity-store touch below is skipped outright, not merely made inert, so
   * this function's behavior is byte-identical to pre-Phase-5 for every install that has not
   * onboarded. Once a local principal has a real org (D13), `hasOrgScope` is true and this claims
   * the root exactly as it does for a signed-in session — `kind` stays `'local'` either way (D13:
   * `kind` means authenticated, never org-scoped).
   */
  const registerFolder = async (
    spelled: string,
    source: 'local' | 'checkout',
    principal: Principal,
    teamId?: string,
  ): Promise<
    // Discriminated on `status`, not one object with a union `body`: a flat
    // `{ status: 200 | 400 | 409 | 500; body: RegisterProjectResponse | { error } }` made
    // `c.json(body, status)` type the route's 200 as carrying the ERROR bodies too, which is a
    // shape neither POST route can answer with (`contract-parity.workspace.test.ts` pins it).
    // Split here so the success branch narrows at the call site instead.
    | { status: 200; body: RegisterProjectResponse }
    | { status: 400 | 409 | 500; body: RegisterProjectResponse | { error: string } }
  > => {
    if (capabilities().singleProject) {
      return { status: 409, body: singleProjectRefusal('adding projects') };
    }
    // `~` is expanded for the same reason `/api/fs/browse` expands it: the
    // dialog hands back absolute paths, but a hand-written body (curl, a
    // future CLI) spells home the way a shell does.
    const requested = expandTilde(spelled);
    if (!requested.startsWith('/')) {
      return {
        status: 400,
        body: { error: `not a folder: ${spelled} is not an absolute path` },
      };
    }
    // Hosted mode: the same root the picker is narrowed to, re-checked — see
    // `isInsideBrowseRoot`. Local mode deliberately has NO containment: a
    // project under `/srv/code` is a normal local setup and `cezar serve`
    // registers it today.
    //
    // Containment is asked in two halves, around the stat, and the split is
    // deliberate.
    //
    // The LEXICAL half runs BEFORE the stat, and that order is the security
    // property: an out-of-root path must answer the SAME way whether or not it
    // exists, or the route becomes the existence oracle fs-browse narrows the
    // tree to prevent. Lexical, not realpath, because a realpath check answers
    // `false` for a path that IS inside the root and merely absent — which
    // would tell a hosted user who typo'd a folder under their own checkout
    // root that it is "outside the browsable root".
    const hostedBrowseRoot = capabilities().localHandoff
      ? null
      : resolveBrowseRoot(await workspaceBrowseRoot());
    if (hostedBrowseRoot !== null) {
      if (!(await isLexicallyInsideBrowseRoot(hostedBrowseRoot, requested))) {
        // No resolved path in the message (fs-browse's rule): saying where the
        // root is would hand a remote viewer the layout the narrowing hides.
        return {
          status: 400,
          body: { error: 'folder is outside the browsable root' },
        };
      }
    }
    // Existence is checked HERE rather than left to `registerProject` (which
    // degrades a failed realpath to a plain resolve): a registry full of
    // `missing` rows the user never had is worse than a 400 they can act on.
    const info = await stat(requested).catch(() => null);
    if (!info?.isDirectory()) return { status: 400, body: { error: `no such folder: ${spelled}` } };
    // The REALPATH half, now that the path is known to exist: a symlink inside
    // the root pointing out of it spells as contained and is not. Same message
    // as the lexical rejection, so the two halves stay indistinguishable from
    // outside.
    if (hostedBrowseRoot !== null && !(await isInsideBrowseRoot(hostedBrowseRoot, requested))) {
      return {
        status: 400,
        body: { error: 'folder is outside the browsable root' },
      };
    }
    // The boot-time auto-registration guard, applied to the manual gesture
    // too: `$HOME` and cezar's own task worktrees are exactly as wrong a
    // project root when a human clicks "Add project" as when `cezar serve`
    // would have registered them. Reachable from the dialog, which starts at
    // `~` and can add the folder it is showing.
    if (!(await shouldRegisterProject(requested))) {
      return {
        status: 400,
        body: {
          error: `not a project folder: ${spelled} is your home directory or a cezar task worktree`,
        },
      };
    }
    // Asked BEFORE the write, because `registerProject` is idempotent and
    // cannot tell us afterwards whether it appended or just bumped
    // `lastOpenedAt`. Same realpath key the registry dedupes on — and, since
    // Phase 5, the same key `identity-store.ts#createProjectTeam`'s PRIMARY
    // KEY protects (`normalizeRoot` now realpaths via `.native`, precisely so
    // a case-differing spelling on a case-insensitive filesystem cannot dodge
    // that PK — see its own doc comment in `workspace/projects.ts`).
    const real = await normalizeRoot(requested);
    let known = false;
    try {
      known = (await loadWorkspaceConfig()).projects.some((p) => p.root === real);
    } catch {
      // unreadable workspace — treat as unknown; the write below will fail loudly
    }

    // D4 hard constraint (Phase 5): a project root belongs to exactly ONE org.
    // A principal with no org (`!hasOrgScope(principal)` — `CEZ_AUTH` unset with no local org
    // yet, D13) skips every line in this block — no call to `openProjectTeamRegistry()` at all —
    // so D7's "the module is never imported" still holds for that case, and the pre-onboarding
    // registration path is untouched. Once a local principal has a real org (D13), `hasOrgScope`
    // is true and this block runs exactly as it does for a signed-in session — `kind` stays
    // `'local'` either way (D13: `kind` means authenticated, never org-scoped).
    let registry: ProjectTeamRegistry | undefined;
    let claimedTeamId: string | undefined;
    if (hasOrgScope(principal)) {
      registry = await openProjectTeamRegistry();
      if (teamId !== undefined) {
        const team = await registry.getTeamById(teamId);
        if (!team || team.orgId !== principal.orgId) {
          return { status: 400, body: { error: `unknown team: ${teamId}` } };
        }
      }
      const existingClaim = await registry.getProjectTeam(real);
      if (existingClaim && existingClaim.orgId !== principal.orgId) {
        // Refused BEFORE `registerProject` runs: this request must not leave
        // a workspace-registry row behind for a root it was never allowed to
        // claim (same "don't pollute the registry for a doomed request"
        // discipline the existence/containment checks above already apply).
        return {
          status: 409,
          body: {
            error: 'this project is already registered to a different organization',
          },
        };
      }
      claimedTeamId = existingClaim ? existingClaim.teamId : (teamId ?? principal.teamId);
    }

    let project: ProjectListEntry;
    try {
      const entry = await registerProject(requested, source);
      project = { ...entry, ...(await probeProjectStatus(entry.root)) };
    } catch (err) {
      // e.g. a read-only home — nothing was persisted (atomic tmp+rename).
      return {
        status: 500,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }

    // `registry` alone would tell TypeScript nothing about `principal.orgId`/`teamId` (it is a
    // SEPARATE variable, only ever assigned inside the `hasOrgScope(principal)` block above) — the
    // redundant `hasOrgScope(principal)` re-check here is what narrows `principal` back to its
    // real, non-null `orgId`/`teamId` for the block below, at zero cost (`hasOrgScope` is a pure,
    // synchronous read of two already-resolved fields, not a second registry round trip).
    if (registry && hasOrgScope(principal)) {
      // Claim an unclaimed root (brand new, or a legacy root registered
      // before auth existed) for the signing-in org. `createProjectTeam`
      // re-checks project-root-taken itself, atomically, inside its write
      // lease (D7, or the supervisor's equivalent under D10) — the pre-check
      // above is a UX nicety (avoid the registry write above for a request we
      // already know will be refused); THIS is the actual guarantee, and it
      // is what catches a genuine race against a concurrent claim from
      // another org landing between the two reads.
      if (!(await registry.getProjectTeam(project.root))) {
        const created = await registry.createProjectTeam({
          projectRoot: project.root,
          orgId: principal.orgId,
          teamId: claimedTeamId ?? principal.teamId,
        });
        if (!created.ok) {
          if (created.code === 'project-root-taken') {
            return {
              status: 409,
              body: {
                error: 'this project is already registered to a different organization',
              },
            };
          }
          // `org-not-found`/`team-not-found`/`team-org-mismatch` are unreachable here in
          // practice — `principal.orgId` and `claimedTeamId` were already validated against
          // this SAME registry a few lines up — but the discriminated result forces this
          // branch to exist rather than silently swallowing a code this call site never
          // expects, instead of an `instanceof` check on an error type specific to whichever
          // implementation answered.
          throw new Error(`unexpected project-team registration failure: ${created.code}`);
        }
      }
      // Read the answer BACK through the same `withTeams` the GET listing uses, rather than
      // restating `claimedTeamId ?? principal.teamId` here: that literal is what this handler
      // *intended* to write, and reporting an intention is how the two routes come to disagree
      // about the same root. `withTeams` reports what `project_teams` actually holds now —
      // including the case just above where a concurrent claim from this same org won the race, so
      // `createProjectTeam` was skipped and the surviving row is someone else's choice of team.
      project = (await withTeams([project], principal))[0] ?? project;
    }

    if (known) {
      // 409 with the EXISTING entry (spec): the dialog treats it as "you
      // already have this one" and navigates there rather than dead-ending.
      return {
        status: 409,
        body: { project, error: `already registered as ${project.id}` },
      };
    }
    // Only a genuinely new project is an event — a re-add is a no-op for every
    // open cockpit's sidebar.
    workspaceEvents.emit('project-added', { project });
    return { status: 200, body: { project } };
  };

  // Deregister a project (multi-project spec, step 4.4 — Settings → Projects,
  // the per-row "Remove"). READ THIS BEFORE TOUCHING THE HANDLER: the ONLY
  // durable effect allowed here is dropping one entry from
  // `~/.cezar/config.json`. There is deliberately no `rm`, no `rmdir`, no
  // `RunStore.open` (which would `mkdir` `<root>/.ai/cezar/runs` and therefore
  // WRITE into a folder the user just asked us to forget) anywhere below —
  // `removeProject` is a registry filter and `contexts.dispose` only tears down
  // in-process handles. Re-registering the same root later finds every task,
  // worktree and transcript exactly where it was. The confirmation copy in the
  // cockpit promises precisely this; the promise is kept here.
  //
  // A run this server is responsible for blocks the removal with a 409 (spec):
  // deregistering mid-run would strand a live agent process under a root no
  // route can resolve any more — the run would keep burning tokens with no
  // cockpit able to show, message or cancel it.
  const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['queued', 'running', 'waiting']);

  /**
   * How many of `projectId`'s runs this process is actively responsible for.
   *
   * Counted from the ALREADY-BUILT context only (`peek`, never `context()`):
   * a project with no context in this process has no manager, therefore no
   * agent to strand — and building one to answer the question would recover
   * and resume runs on a project being deleted, which is the exact opposite of
   * what the caller asked for. Reading the run index off disk instead was
   * rejected for the same reason as the `rm` above: `RunStore.open` creates
   * directories, and a stale `running` row left by a crashed process would
   * become a 409 the user could never clear.
   */
  const activeRunCount = (projectId: string): number => {
    const ctx = contexts.peek(projectId);
    if (!ctx) return 0;
    return ctx.store.listRuns().filter((run) => ACTIVE_RUN_STATUSES.has(run.status)).length;
  };

  // Workspace-level by design: update state spans project and global installs,
  // but the selected registered project supplies the safe, server-owned cwd.
  const skillsUpdateInputSchema = z.object({ projectId: projectIdSchema }).strict();
  const resolveSkillsUpdateRoot = async (raw: string): Promise<
    { root: string } | { status: 404 | 409; error: string }
  > => {
    if (!projectIdSchema.safeParse(raw).success) return { status: 404, error: `unknown project: ${raw}` };
    const bootId = await resolveBootProject();
    if (raw === 'default' || raw === bootId) return { root: bootRoot };
    const project = (await loadWorkspaceConfig()).projects.find((entry) => entry.id === raw);
    if (!project) return { status: 404, error: `unknown project: ${raw}` };
    if ((await probeProjectStatus(project.root)).status === 'missing') {
      return { status: 409, error: `project folder not found: ${raw}` };
    }
    return { root: project.root };
  };

  const skillsUpdateResponse = async (state: SkillsUpdateState): Promise<SkillsUpdateState> => {
    const config = await loadWorkspaceConfig();
    return { ...state, autoUpdateEnabled: effectiveSkillsAutoUpdate(config), inherited: config.skillsAutoUpdate === undefined };
  };

  // ---- chained family: skills updates (workspace-level) ----
  const skillsUpdateRoutes = new Hono<ProjectApiEnv>()
    .get('/workspace/skills-update', queryZodValidator(skillsUpdateInputSchema, { message: 'projectId is required' }), async (c) => {
      const parsed = { data: c.req.valid('query') };
      const resolved = await resolveSkillsUpdateRoot(parsed.data.projectId);
      if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
      const state: SkillsUpdateState = skillsUpdate.snapshot(resolved.root);
      void skillsUpdate.check(resolved.root).catch(() => {});
      return c.json(await skillsUpdateResponse(state));
    })

    .post('/workspace/skills-update/check', jsonZodValidator(skillsUpdateInputSchema, { message: 'body must contain only projectId' }), async (c) => {
      const parsed = { data: c.req.valid('json') };
      const resolved = await resolveSkillsUpdateRoot(parsed.data.projectId);
      if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
      return c.json(await skillsUpdateResponse(await skillsUpdate.check(resolved.root, true)));
    })

    .post('/workspace/skills-update/apply', jsonZodValidator(skillsUpdateInputSchema, { message: 'body must contain only projectId' }), async (c) => {
      const parsed = { data: c.req.valid('json') };
      const resolved = await resolveSkillsUpdateRoot(parsed.data.projectId);
      if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
      try {
        return c.json(await skillsUpdateResponse(await skillsUpdate.update(resolved.root, true)));
      } catch (error) {
        if (error instanceof SkillsUpdateConflictError) {
          return c.json({ error: 'another skills update operation is running', state: await skillsUpdateResponse(skillsUpdate.snapshot(resolved.root)) }, 409);
        }
        throw error;
      }
    });

  // ---- GUI clone (multi-project spec, step 4.3) ----------------------------
  // "Add project → Clone from GitHub": clone into the checkout root, then
  // register the result through `registerFolder` above (same guards, same
  // `project-added`). Everything dangerous — where the clone may land, and
  // what a failed clone is allowed to delete — lives in src/server/checkout.ts.
  //
  // Long-running by design (the spec's contract): the response lands when the
  // clone finishes, and the dialog's liveness comes from `checkout-progress`
  // events on the workspace stream. `checkoutId` is the cockpit's own
  // correlation token, echoed on every event so two tabs cloning at once never
  // render each other's progress.
  const checkoutSchema = z.object({
    url: z.string().trim().min(1).max(512),
    name: z.string().trim().max(128).optional(),
    checkoutId: z.string().trim().max(128).optional(),
    // D15: additive, and the same optional shape `registerProjectSchema` already carries. Without
    // it a clone performed DURING onboarding registers under the principal's default team rather
    // than the team the wizard just told the user it would use — indistinguishable from correct
    // while only one workspace exists, and wrong the moment a second one does.
    teamId: z.string().trim().min(1).max(200).optional(),
  });

  /**
   * D15 — "blank" is the third way to satisfy the wizard's project step, beside a local folder and
   * a GitHub clone. It creates `<projectsDir>/<name>` and `git init`s it.
   *
   * `projectsDir` (default `~/cezar/projects`) is deliberately the SAME setting `/projects/checkout`
   * writes into and Settings → Projects already exposes as "Default checkout folder", so blank
   * projects land beside checkouts instead of inventing a second location the user would have to
   * learn. `git init` runs because every project-scoped surface here (Git tab, GitHub tab, task
   * worktrees) assumes a repository; a blank project without one has permanently empty main panes.
   *
   * The name is validated as a single path SEGMENT, not a path: `..`, `/` and a leading `.` are all
   * refused rather than normalized. This route takes a name and joins it to a directory the server
   * chose, so accepting a path here would let the caller pick the parent too — the containment the
   * `registerFolder` browse-root check performs for hosted mode would be bypassed before it ran.
   */
  const blankProjectSchema = z.object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/,
        'name must start with a letter or number and contain only letters, numbers, spaces, dots, dashes or underscores',
      )
      .refine((v) => !v.includes('..'), 'name must not contain ".."'),
    teamId: z.string().trim().min(1).max(200).optional(),
  });
  // ---- workspace settings (multi-project spec, step 2.7) -------------------
  // WORKSPACE-level routes: single-mount (never mirrored under /api/p/),
  // same-origin. The config routes carry the settings UI's slice of
  // `~/.cezar/config.json` — global knobs only; the registry stays on
  // /api/projects above, and schemaVersion (a migration cursor, not a
  // setting) is deliberately omitted.
  const workspaceConfigBody = (config: WorkspaceConfig): WorkspaceConfigResponse => ({
    browseRoot: config.browseRoot,
    projectsDir: config.projectsDir,
    skillsAutoUpdate: config.skillsAutoUpdate ?? null,
    effectiveSkillsAutoUpdate: effectiveSkillsAutoUpdate(config),
    composerDefaults: {
      autonomous: config.composerDefaults.autonomous ?? null,
      worktree: config.composerDefaults.worktree ?? null,
      inheritedAutonomous:
        process.env.CEZ_AUTONOMOUS_DEFAULT === '0'
          ? false
          : process.env.CEZ_AUTONOMOUS_DEFAULT === '1'
            ? true
            : 'source-dependent',
      inheritedWorktree: effectiveComposerDefault(
        undefined,
        process.env.CEZ_WORKTREE_DEFAULT,
        true,
      ),
    },
    resources: {
      maxParallel: config.resources.maxParallel,
      maxMonitoringSessions: config.resources.maxMonitoringSessions,
      monitoringWakeIntervalMinutes: config.resources.monitoringWakeIntervalMinutes,
      autoResumeOnUsageLimit: config.resources.autoResumeOnUsageLimit,
      memoryLimitMb: config.resources.memoryLimitMb,
      worktreeRetentionDefault: config.resources.worktreeRetentionDefault,
    },
    // SPREAD, never `runner: maybeUndefined`: hono would type the key as always-present while
    // `JSON.stringify` drops it, which is the exact drift `contract-parity` catches. And absent has
    // to keep meaning "no opinion" here, or the fallback collapses into "always claude".
    agentDefaults: {
      ...(config.agentDefaults.runner !== undefined ? { runner: config.agentDefaults.runner } : {}),
      ...(config.agentDefaults.models !== undefined ? { models: config.agentDefaults.models } : {}),
    },
  });
  // ---- chained family: workspace settings + GUI prefs (workspace-level) ----
  const workspaceConfigRoutes = new Hono<ProjectApiEnv>()
    .get('/workspace/config', async (c) => c.json(workspaceConfigBody(await loadWorkspaceConfig())))

    .put('/workspace/config', jsonZodValidator(() => workspaceConfigUpdateSchema), async (c) => {
      const parsed = { data: c.req.valid('json') };
      const { browseRoot, projectsDir, skillsAutoUpdate, composerDefaults, resources, agentDefaults } = parsed.data;
      for (const [configuredRoot, create] of [
        [browseRoot, false],
        [projectsDir, true],
      ] as const) {
        if (configuredRoot === undefined) continue;
        // Validated ON CHANGE, never at load (spec): browse roots must already
        // exist; checkout roots use `mkdir -p`. Both get a real write probe.
        // Any failure → 400 and NO change persisted.
        const expanded = expandTilde(configuredRoot);
        if (!expanded.startsWith('/')) {
          return c.json({ error: `not writable: ${configuredRoot} is not an absolute path` }, 400);
        }
        if (!create) {
          try {
            if (!(await stat(expanded)).isDirectory()) {
              return c.json({ error: `browse folder is not a directory: ${configuredRoot}` }, 400);
            }
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              return c.json({ error: `browse folder does not exist: ${configuredRoot}` }, 400);
            }
            return c.json({ error: `browse folder unavailable: ${err instanceof Error ? err.message : String(err)}` }, 400);
          }
        }
        const probeError = await probeWritableDir(expanded, create);
        if (probeError !== null) return c.json({ error: `not writable: ${probeError}` }, 400);
      }
      let written: WorkspaceConfig;
      try {
        written = await mergeWriteWorkspaceConfig((config) => {
          // Roots are stored as written (`~` kept); only the probe expands them.
          if (browseRoot !== undefined) config.browseRoot = browseRoot;
          if (projectsDir !== undefined) config.projectsDir = projectsDir;
          if (skillsAutoUpdate === null) delete config.skillsAutoUpdate;
          else if (skillsAutoUpdate !== undefined) config.skillsAutoUpdate = skillsAutoUpdate;
          if (composerDefaults?.autonomous === null) delete config.composerDefaults.autonomous;
          else if (composerDefaults?.autonomous !== undefined) {
            config.composerDefaults.autonomous = composerDefaults.autonomous;
          }
          if (composerDefaults?.worktree === null) delete config.composerDefaults.worktree;
          else if (composerDefaults?.worktree !== undefined) {
            config.composerDefaults.worktree = composerDefaults.worktree;
          }
          if (resources?.maxParallel !== undefined) config.resources.maxParallel = resources.maxParallel;
          if (resources?.maxMonitoringSessions !== undefined) {
            config.resources.maxMonitoringSessions = resources.maxMonitoringSessions;
          }
          if (resources?.monitoringWakeIntervalMinutes !== undefined) {
            config.resources.monitoringWakeIntervalMinutes = resources.monitoringWakeIntervalMinutes;
          }
          if (resources?.autoResumeOnUsageLimit !== undefined) {
            config.resources.autoResumeOnUsageLimit = resources.autoResumeOnUsageLimit;
          }
          if (resources?.memoryLimitMb !== undefined) config.resources.memoryLimitMb = resources.memoryLimitMb;
          if (resources?.worktreeRetentionDefault !== undefined) {
            config.resources.worktreeRetentionDefault = resources.worktreeRetentionDefault;
          }
          // `null` CLEARS back to "no opinion" — a partial patch cannot say that by omission,
          // and leaving a stale runner behind would keep overriding repos that never chose.
          if (agentDefaults?.runner === null) delete config.agentDefaults.runner;
          else if (agentDefaults?.runner !== undefined) config.agentDefaults.runner = agentDefaults.runner;
          for (const runner of PROVIDER_IDS) {
            const model = agentDefaults?.models?.[runner];
            if (model === undefined) continue;
            const models = config.agentDefaults.models ?? {};
            if (model === null) delete models[runner];
            else models[runner] = model;
            // An empty object would persist a key that says nothing; absence is the same answer.
            if (Object.keys(models).length === 0) delete config.agentDefaults.models;
            else config.agentDefaults.models = models;
          }
        });
      } catch (err) {
        // e.g. a read-only home — nothing was persisted (atomic tmp+rename).
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
      // A resource change takes effect WITHOUT a restart: refresh the shared
      // semaphore's in-memory snapshot and pump every manager (step 2.5's hook).
      if (resources !== undefined) await deps.semaphore?.refresh();
      return c.json(workspaceConfigBody(written));
    })

    // Global GUI state (`~/.cezar/ui-state.json`) — same parse/key-cap/shallow-
    // merge semantics as the per-repo /api/v1/ui-state route below (the shared half
    // is `uiStateBodySchema`), but backed by the workspace file.
    .get('/workspace/ui-state', async (c) => c.json(await readWorkspaceUiState()))

    // The tighter body cap rides on `use` rather than inline on the route: `bodyLimit` is typed
    // as a bare MiddlewareHandler, and passing one to `.put()` collapses the route's schema, so
    // the PUT went missing from `AppType` and `hc` could not see its body at all. `use` runs at
    // the same point (before the handler, so the cap still precedes any read) and leaves the
    // chain's type accumulation alone. Method-agnostic here, which the GET does not mind.
    .use('/workspace/ui-state', bodyLimit({ maxSize: UI_STATE_BODY_LIMIT }))

    .put('/workspace/ui-state', jsonZodValidator(setWorkspaceUiStateInputSchema), async (c) => {
      const parsed = { data: c.req.valid('json') };
      try {
        return c.json(
          await mergeWriteWorkspaceUiState((state) => ({
            ...state,
            ...parsed.data,
          })),
        );
      } catch (err) {
        // A read-only home degrades to an unsaved pref, never a crash.
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    });

  // Partial updates only — absent keys stay untouched. Bounds mirror the
  // workspace schema (src/workspace/config.ts, step 1.2) exactly, so a value
  // this route accepts can never be degraded away by the next load's `.catch`.
  const workspaceConfigUpdateSchema = z.object({
    browseRoot: z.string().trim().min(1).max(4096).optional(),
    projectsDir: z.string().trim().min(1).max(4096).optional(),
    skillsAutoUpdate: z.boolean().nullable().optional(),
    composerDefaults: z
      .object({
        autonomous: z.boolean().nullable().optional(),
        worktree: z.boolean().nullable().optional(),
      })
      .optional(),
    resources: z
      .object({
        maxParallel: z.number().int().min(1).max(16).optional(),
        maxMonitoringSessions: z.number().int().min(0).max(16).optional(),
        monitoringWakeIntervalMinutes: z.number().int().min(1).max(60).nullable().optional(),
        autoResumeOnUsageLimit: z.boolean().optional(),
        memoryLimitMb: z.number().int().min(0).max(1_048_576).nullable().optional(),
        worktreeRetentionDefault: z.number().int().min(0).max(1000).optional(),
      })
      .optional(),
    // Bounds mirror `src/workspace/config.ts`, so a value this accepts is never degraded away by
    // the next load's `.catch`. `null` clears a key back to "no opinion".
    agentDefaults: z
      .object({
        runner: z.enum(PROVIDER_IDS).nullable().optional(),
        models: z
          .object({
            claude: z.string().trim().min(1).max(200).nullable().optional(),
            codex: z.string().trim().min(1).max(200).nullable().optional(),
            opencode: z.string().trim().min(1).max(200).nullable().optional(),
            pi: z.string().trim().min(1).max(200).nullable().optional(),
          })
          .optional(),
      })
      .optional(),
  });
  // ---- chained family: filesystem browse (workspace-level) ----
  const fsBrowseRoutes = new Hono<ProjectApiEnv>()
    .get(
      '/fs/browse',
      queryZodValidator(z.object({ path: queryValue, showHidden: queryValue })),
      async (c) => {
        if (capabilities().singleProject) {
          return c.json(singleProjectRefusal('folder browsing'), 409);
        }
        const query = c.req.valid('query');
        const root = resolveBrowseRoot(await workspaceBrowseRoot());
        const result = await browseDirectory({
          root,
          path: query.path,
          showHidden: query.showHidden === '1',
        });
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json(result.body);
      },
    );

  // ---- chained family: launch-key (project-scoped) ----
  const launchKeyRoutes = new Hono<ProjectApiEnv>()
    .get('/launch-key', (c) => c.json({ key: c.get('project').launchKey }));

  // ---- chained family: skills (project-scoped) ----
  const skillsRoutes = new Hono<ProjectApiEnv>()
    .get('/skills', queryZodValidator(waitQuery), async (c) => {
      const repoRoot = c.get('project').root;
      // The default read stays fast and starts the team load in the background.
      // The cockpit follows it with `wait=1`, off the render path, so a cold
      // cache converges without polling or a manual reload (spec 005 / #555).
      if (c.req.valid('query').wait === '1') await waitForTeamSkills(repoRoot);
      return c.json(await discoverSkills(repoRoot));
    })

    // The opt-in catalog for the "Import skills" panel: every skill a default
    // (vendor) repo offers — `open-mercato/skills` — regardless of import state,
    // so the panel can present them all with a per-skill toggle. Empty once a repo
    // configures its own `skillsRepos` (nothing is gated then). `wait=1` lets the
    // panel wait out a cold team-skill cache, same as `GET /skills` (spec 005).
    .get('/skills/importable', queryZodValidator(waitQuery), async (c) => {
      const repoRoot = c.get('project').root;
      const gated = await gatedSkillsRepos(repoRoot);
      if (gated.size === 0) return c.json([]);
      if (c.req.valid('query').wait === '1') await waitForTeamSkills(repoRoot);
      const importable = getTeamSkillsCached(repoRoot)
        .filter((skill) => skill.team && gated.has(skill.team.repo))
        // Spread `description` rather than writing it unconditionally: an undefined VALUE is
        // dropped by JSON.stringify, so the key is absent on the wire, and writing it always
        // typed the route as sending a key it does not. contract/skills.ts says `.optional()`,
        // which is what the client actually receives.
        .map((skill) => ({
          name: skill.name,
          ...(skill.description !== undefined ? { description: skill.description } : {}),
        }));
      return c.json(importable);
    })

    // Refresh team skills (spec 005): clone/fetch the configured skills repos,
    // then return the merged catalog. Degrades quietly — offline just means the
    // team entries stay as they were (or absent).
    .post('/skills/refresh', async (c) => {
      const { root: repoRoot } = c.get('project');
      await refreshTeamSkills(repoRoot);
      return c.json(await discoverSkills(repoRoot));
    });

  // ---- chained family: GUI prefs / ui-state (project-scoped) ----
  const uiStateRoutes = new Hono<ProjectApiEnv>()
    .get('/ui-state', async (c) => c.json(await readUiState(c.get('project').root)))

    // On `use`, not inline on the route — see the workspace ui-state PUT above.
    .use('/ui-state', bodyLimit({ maxSize: UI_STATE_BODY_LIMIT }))

    .put('/ui-state', jsonZodValidator(uiStateBody), async (c) => {
      const { root: repoRoot, dataDir } = c.get('project');
      // `.passthrough()` keeps unknown prefs (BACKWARD_COMPATIBILITY §3), but a
      // single request may not stuff an unbounded key set (#429) — the shared
      // schema+cap half of both ui-state routes lives in `uiStateBody`.
      const parsed = { data: c.req.valid('json') };
      const merged = { ...(await readUiState(repoRoot)), ...parsed.data };
      try {
        await mkdir(dataDir, { recursive: true });
        await writeFile(uiStatePath(repoRoot), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
      return c.json(merged);
    });

  // ---- chained family: workflows (project-scoped) --------------------------
  // One chained expression, mounted by `createApp` into BOTH the legacy `api`
  // table and the versioned `v1` one — see `healthRoutes` for why the chain
  // shape (not the statement shape) is what carries the types.
  const workflowsRoutes = new Hono<ProjectApiEnv>()
    .get('/workflows', async (c) => c.json(await loadWorkflows(c.get('project').root)))

    // Save an approved plan as a reusable chain (spec 008): YAML in
    // `.ai/cezar/workflows/<slug>.yaml` — from then on it's in the dropdown
    // like any other workflow.
    .post('/workflows', jsonZodValidator(saveWorkflowSchema), async (c) => {
      const { root: repoRoot } = c.get('project');
      const parsed = { data: c.req.valid('json') };
      const steps = parsed.data.steps ?? skillsToSteps(parsed.data.skills ?? []);
      const issue = stepsIssue(steps);
      if (issue) return c.json({ error: issue }, 400);
      const slug = slugify(parsed.data.name) || 'chain';
      const dir = join(repoRoot, WORKFLOWS_DIR);
      const path = join(dir, `${slug}.yaml`);
      // Pure skill stacks are written in the portable compact form (spec 012) —
      // `name` + `skills:` — so the file imports cleanly in any repo.
      const stack = skillStackOf(steps);
      const doc = {
        name: parsed.data.name,
        ...(parsed.data.description ? { description: parsed.data.description } : {}),
        ...(stack ? { skills: stack } : { steps }),
      };
      try {
        await mkdir(dir, { recursive: true });
        // `wx` = fail if the file exists — no silent overwrite of a chain.
        await writeFile(path, stringifyYaml(doc), {
          encoding: 'utf8',
          flag: parsed.data.overwrite ? 'w' : 'wx',
        });
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
          return c.json({ error: `workflow file already exists: ${path}`, exists: true }, 409);
        }
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: message }, 500);
      }
      return c.json({ path, name: parsed.data.name }, 201);
    })

    // Delete a saved workflow (spec 012 follow-up): file workflows only —
    // built-ins have no file and always come back.
    .delete('/workflows/:name', async (c) => {
      const { root: repoRoot } = c.get('project');
      const name = c.req.param('name');
      const { workflows } = await loadWorkflows(repoRoot);
      const wf = workflows.find((w) => w.name === name);
      if (!wf) return c.json({ error: `unknown workflow: ${name}` }, 404);
      if (wf.source !== 'file' || !wf.path) {
        return c.json({ error: 'built-in workflows cannot be deleted' }, 400);
      }
      const dir = resolve(repoRoot, WORKFLOWS_DIR);
      const target = resolve(wf.path);
      if (!target.startsWith(dir + sep)) {
        return c.json({ error: 'refusing to delete a file outside the workflows dir' }, 400);
      }
      try {
        await unlink(target);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
      return c.json({ ok: true, path: target });
    })

    // Import support for the builder (spec 012): parse + validate a pasted
    // workflow YAML (either form) and hand back the normalized definition. The
    // server owns YAML parsing — the GUI stays dependency-free.
    .post('/workflows/parse', jsonZodValidator(parseWorkflowSchema), async (c) => {
      const parsed = { data: c.req.valid('json') };
      let raw: unknown;
      try {
        raw = parseYaml(parsed.data.yaml);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: `not valid YAML: ${message}` }, 400);
      }
      const doc = workflowFileSchema.safeParse(raw);
      if (!doc.success) {
        return c.json({ error: doc.error.issues.map((i) => i.message).join('; ') }, 400);
      }
      const normalized = normalizeWorkflowDoc(doc.data);
      const issue = stepsIssue(normalized.steps);
      if (issue) return c.json({ error: issue }, 400);
      return c.json(normalized);
    });

  // ---- chained family: plan (project-scoped) ----
  const planRoutes = new Hono<ProjectApiEnv>()
    .post('/plan', jsonZodValidator(planSchema), async (c) => {
      const { root: repoRoot } = c.get('project');
      const parsed = { data: c.req.valid('json') };
      const blocked = await providerActionError([(await loadConfig(repoRoot)).defaultRunner]);
      if (blocked) return c.json({ error: blocked }, 409);
      return c.json(await planChain(repoRoot, parsed.data.task));
    });

  // ---- GitHub automations --------------------------------------------------

  /**
   * One manual "test filter" check, in server memory only.
   *
   * Declared here rather than inferred from `contract/src/automations.ts`: the contract's
   * `automationCheckSchema` is checked against what this route ANSWERS
   * (`contract-parity.automations.test.ts`), and a schema that annotated the handler it is
   * compared with would be true by construction.
   */
  type ManualCheck = {
    id: string;
    automationId: string;
    mode: 'preview' | 'execute';
    status: 'queued' | 'running' | 'complete' | 'error';
    createdAt: string;
    completedAt?: string;
    matches?: number;
    truncated?: boolean;
    error?: string;
  };
  const manualChecks = new Map<string, ManualCheck>();

  /**
   * The automations gate (#801): with `CEZ_AUTOMATIONS` unset, every route of the feature
   * answers 409 before touching a store, a lease or GitHub.
   *
   * Written as MIDDLEWARE rather than a line in each handler so the family cannot drift: a route
   * added to either chain below inherits the gate from its path, where a per-handler check is one
   * omission away from an ungated endpoint.
   *
   * Registered against EXPLICIT paths, never `use('*')`. Both chains are mounted with
   * `.route('/', …)` alongside a dozen unrelated sub-apps, and `route()` re-registers a sub-app's
   * middleware under the mount prefix — so a `'*'` here would gate the entire `/api/v1` surface,
   * including `/health`. The two-line pairing (`/automations` and `/automations/*`) is what makes
   * a path match both the collection and everything under it.
   */
  const requireAutomations = async (c: Context, next: Next) => {
    if (!capabilities().automations) return c.json({ error: AUTOMATIONS_OFF }, 409);
    await next();
  };

  // ---- chained family: GitHub automations (project-scoped) ----
  // Every handler below reads `c.get('project')` — the definitions, their runtime state and the
  // execution log are per-project files — so the family is project-scoped and mounted with the
  // rest of the mirrored table. The one exception is the manual-check read, which touches no
  // project at all; it is its own workspace-level family below.
  const automationsRoutes = new Hono<ProjectApiEnv>()
    .use('/automations', requireAutomations)
    .use('/automations/*', requireAutomations)
    .use('/automation-log', requireAutomations)
    .use('/automation-log/*', requireAutomations)
    .get('/automations', async (c) => {
      const { root, automationStore } = c.get('project');
      const forge = resolveForge(await getRepoInfo(root));
      // Annotated, so the two branches are ONE shape rather than a union of two: the fallback
      // literal always carries `reason`, the cached answer only sometimes does, and the route
      // type is what `contract/src/automations.ts` has to describe.
      const availability: ForgeAvailability = forge?.detectCached() ?? {
        available: false,
        reason: forge ? 'GitHub availability is still being checked' : 'No GitHub remote is configured',
      };
      const automations = automationStore.list().map((automation) => {
        const logs = automationStore.logs({ automationId: automation.id, limit: 100 });
        const state = automationStore.state(automation.id);
        const latestLog = logs[0];
        return {
          ...automation,
          // Spread conditionally, never `state: maybeUndefined`: the latter types the key as
          // always-present while `JSON.stringify` drops it from the wire, so the contract would
          // have to describe a key consumers never receive.
          ...(state ? { state } : {}),
          ...(latestLog ? { latestLog } : {}),
          counts: {
            matches: logs.filter((row) => row.result === 'launched' || row.result === 'duplicate').length,
            launched: logs.filter((row) => row.result === 'launched').length,
            duplicates: logs.filter((row) => row.result === 'duplicate').length,
            errors: logs.filter((row) => row.result === 'error' || row.result === 'rate-limited').length,
          },
        };
      });
      const nextDue = automations.map((item) => item.state?.nextCheckAt).filter(Boolean).sort()[0];
      return c.json({
        ...availability,
        scheduler: {
          // `as const` on both arms: in an object literal a conditional of two string literals
          // widens to `string`, which would erase the two states this key can hold.
          state: automations.some((item) => item.enabled) ? ('scheduled' as const) : ('idle' as const),
          ...(nextDue ? { nextDue } : {}),
        },
        automations,
      });
    })

    .post('/automations', jsonZodValidator(() => automationCreateSchema), async (c) => {
      const { automationStore } = c.get('project');
      const parsed = { data: c.req.valid('json') };
      const promptIssue = validateAutomationPrompt(parsed.data.task.prompt);
      if (promptIssue) return c.json({ error: promptIssue }, 400);
      const { enable, ...input } = parsed.data;
      try {
        const automation = automationStore.create({ ...input, enabled: enable === true });
        if (enable) {
          const baselineAt = new Date().toISOString();
          automationStore.setState(automation.id, {
            revision: automation.revision,
            baselineAt,
            cursor: { timestamp: baselineAt },
            nextCheckAt: new Date(Date.now() + automation.intervalSeconds * 1_000).toISOString(),
          });
        }
        emitAutomationChange(c.get('project'), automation.id, automation.revision);
        automationsChanged();
        return c.json({ automation }, 201);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    })

    .get('/automations/:id', (c) => {
      const { automationStore } = c.get('project');
      const automation = automationStore.get(c.req.param('id'));
      if (!automation) return c.json({ error: 'not found' }, 404);
      const state = automationStore.state(automation.id);
      const latestLog = automationStore.logs({ automationId: automation.id, limit: 1 })[0];
      return c.json({
        automation,
        ...(state ? { state } : {}),
        ...(latestLog ? { latestLog } : {}),
      });
    })

    .put('/automations/:id', jsonZodValidator(() => automationUpdateSchema), async (c) => {
      const { automationStore } = c.get('project');
      const parsed = { data: c.req.valid('json') };
      const promptIssue = validateAutomationPrompt(parsed.data.task.prompt);
      if (promptIssue) return c.json({ error: promptIssue }, 400);
      const { expectedRevision, ...input } = parsed.data;
      if (!automationStore.get(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
      try {
        const automation = automationStore.update(c.req.param('id'), expectedRevision, { ...input, enabled: input.enabled ?? false });
        emitAutomationChange(c.get('project'), automation.id, automation.revision);
        automationsChanged();
        return c.json({ automation });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ error: message }, message.includes('conflict') ? 409 : 400);
      }
    })

    .delete('/automations/:id', (c) => {
      const id = c.req.param('id');
      const store = c.get('project').automationStore;
      const current = store.get(id);
      if (!current || !store.delete(id)) return c.json({ error: 'not found' }, 404);
      emitAutomationChange(c.get('project'), id, current.revision, true);
      automationsChanged();
      return c.body(null, 204);
    })

    .post('/automations/:id/enable', (c) => {
      const store = c.get('project').automationStore;
      const current = store.get(c.req.param('id'));
      if (!current) return c.json({ error: 'not found' }, 404);
      const automation = store.update(current.id, current.revision, { ...editableAutomation(current), enabled: true });
      const baselineAt = new Date().toISOString();
      store.setState(automation.id, {
        ...store.state(automation.id),
        revision: automation.revision,
        baselineAt,
        cursor: { timestamp: baselineAt },
        nextCheckAt: new Date(Date.now() + automation.intervalSeconds * 1_000).toISOString(),
      });
      store.appendLog({ automationId: automation.id, revision: automation.revision, result: 'baseline', reason: 'Enabled from a current-time baseline; existing records were not launched.' });
      emitAutomationChange(c.get('project'), automation.id, automation.revision);
      automationsChanged();
      return c.json({ automation });
    })

    .post('/automations/:id/pause', (c) => {
      const store = c.get('project').automationStore;
      const current = store.get(c.req.param('id'));
      if (!current) return c.json({ error: 'not found' }, 404);
      const automation = store.update(current.id, current.revision, { ...editableAutomation(current), enabled: false });
      emitAutomationChange(c.get('project'), automation.id, automation.revision);
      automationsChanged();
      return c.json({ automation });
    })

    // The body is validated as MIDDLEWARE, which is what puts it in the route type — and moves
    // the 400 ahead of this route's 404: `POST /automations/<unknown>/check` with a malformed
    // body now answers 400 rather than 404. Nothing else about either answer changed.
    .post('/automations/:id/check', jsonZodValidator(() => automationCheckRequestSchema), async (c) => {
      const project = c.get('project');
      const store = project.automationStore;
      const automation = store.get(c.req.param('id'));
      if (!automation) return c.json({ error: 'not found' }, 404);
      const parsed = { data: c.req.valid('json') };
      // `string`, not `randomUUID`'s template-literal type: the wire carries an opaque id, and
      // leaking `${string}-${string}-…` into the route type would make the contract describe the
      // generator rather than the answer.
      const id: string = randomUUID();
      const check: ManualCheck = { id, automationId: automation.id, mode: parsed.data.mode, status: 'queued', createdAt: new Date().toISOString() };
      if (manualChecks.size >= 200) manualChecks.delete(manualChecks.keys().next().value!);
      manualChecks.set(id, check);
      void (async () => {
        check.status = 'running';
        try {
          const remote = parseRemote((await getRepoInfo(project.root))?.remote ?? '');
          if (!remote || remote.host !== 'github.com') throw new Error('No GitHub remote is configured');
          const scheduler = new ProjectAutomationScheduler({
            projectId: project.id,
            owner: remote.owner,
            repo: remote.repo,
            store,
            poller: new GithubPoller(),
            launch: parsed.data.mode === 'execute'
              ? (definition, candidate, receiptId) => launchAutomationRun({ root: project.root, manager: project.manager, store: project.store, definition, candidate, receiptId })
              : undefined,
            onChange: (automationId, revision) => emitAutomationChange(project, automationId, revision),
          });
          const result = await scheduler.check(automation, parsed.data.mode);
          Object.assign(check, { status: 'complete', completedAt: new Date().toISOString(), matches: result.candidates.length, truncated: result.truncated });
        } catch (error) {
          Object.assign(check, { status: 'error', completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
        }
      })();
      return c.json({ checkId: id }, 202);
    })

    .get('/automation-log', queryZodValidator(automationLogQuerySchema), (c) => {
      return c.json({ records: c.get('project').automationStore.logs(c.req.valid('query')) });
    })

    .post('/automation-log/:receiptId/retry', async (c) => {
      const project = c.get('project');
      const store = project.automationStore;
      const receipt = [...store.latestReceipts().values()].find((row) => row.receiptId === c.req.param('receiptId'));
      if (!receipt) return c.json({ error: 'not found' }, 404);
      if (receipt.status !== 'launch-error' || receipt.runId) return c.json({ error: 'receipt is not retryable' }, 409);
      if (!receipt.candidate) return c.json({ error: 'receipt predates retry context and cannot be retried safely' }, 409);
      const definition = store.get(receipt.automationId);
      if (!definition) return c.json({ error: 'automation not found' }, 404);
      const lease = store.acquireLease();
      if (!lease) return c.json({ error: 'automation polling lease is held by another process' }, 409);
      const reserved = { ...receipt, status: 'reserved' as const, error: undefined, updatedAt: new Date().toISOString() };
      store.appendReceipt(reserved);
      try {
        const launched = await launchAutomationRun({ root: project.root, manager: project.manager, store: project.store, definition, candidate: receipt.candidate, receiptId: receipt.receiptId });
        store.appendReceipt({ ...reserved, status: 'launched', runId: launched.runId, updatedAt: new Date().toISOString() });
        emitAutomationChange(project, definition.id, definition.revision);
        return c.json({ receiptId: receipt.receiptId, runId: launched.runId }, 202);
      } catch (error) {
        store.appendReceipt({ ...reserved, status: 'launch-error', error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() });
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
      } finally {
        lease.release();
      }
    });

  // ---- chained family: manual automation checks (workspace-level) ----
  // Workspace-level because the handler reads no project: a check lives in the server-memory map
  // above, keyed by an unguessable id that the project-scoped POST hands back. Mounting it under
  // `/api/v1/p/:projectId` too would be a second spelling of a lookup that consults no project.
  const automationChecksRoutes = new Hono()
    .use('/automation-checks/*', requireAutomations)
    .get('/automation-checks/:checkId', (c) => {
      const check = manualChecks.get(c.req.param('checkId'));
      return check ? c.json(check) : c.json({ error: 'not found' }, 404);
    });

  // ---- runs ----------------------------------------------------------------

  // Additive `usage` field (#348): the latest CPU/RSS/proc-count sample of the
  // run's live process tree — absent for finished runs and when `ps` yields
  // nothing. The stored record itself is never touched.
  const withUsage = (run: RunRecord): RunRecord & { usage?: ReturnType<typeof currentUsage> } => {
    const usage = currentUsage(run.id);
    return usage ? { ...run, usage } : run;
  };

  // The inbox half of a composer launch (#374). Since the cockpit's "▶ Run"
  // prefills `/new` instead of calling POST /api/todos/:id/start (never launch
  // blind — #355), the todo id rides along on the composer's POST /api/runs and
  // lands here: `markStarted` writes `startedTaskId`, so the entry leaves the
  // inbox (`visibleTodos()`) and stays in todos.json as the audit trail, and a
  // second launch of the same entry no longer double-starts it.
  //
  // Deliberately best-effort: bookkeeping must never cost the user their task,
  // so an unknown, stale or already-started id (markStarted → false) and any I/O
  // failure only log. The run has already been created by the time we get here.
  const noteTodoStarted = async (dataDir: string, todoId: string, taskId: string): Promise<void> => {
    try {
      if (!(await markStarted(dataDir, todoId, taskId))) {
        console.warn(`[cezar] inbox entry ${todoId} not marked started (unknown or already started)`);
      }
    } catch (err) {
      console.warn(`[cezar] could not mark inbox entry ${todoId} started: ${String(err)}`);
    }
  };

  // ---- chained family: runs lifecycle + artifacts (project-scoped) ----
  const runsRoutes = new Hono<ProjectApiEnv>()
    .get('/runs', (c) => c.json(c.get('project').store.listRuns().map(withUsage)))

    // Registered before the `/:id/...` routes so "archive-finished" and "read-all"
    // never match as a run id.
    .post('/runs/archive-finished', (c) => c.json({ archived: c.get('project').store.archiveFinished() }))

    // The read-receipt sweep (#unread-done-items) — the mark-read twin of the archive
    // sweep above, and under the same registration-order guard.
    .post('/runs/read-all', (c) => c.json({ read: c.get('project').store.markAllRead() }))

    .post('/runs/:id/archive', jsonZodValidator(archiveSchema, { absent: ({}) }), async (c) => {
      const { store } = c.get('project');
      const id = c.req.param('id');
      // An empty/absent body archives (the common case); a malformed body degrades
      // to `{}` just as before, but a wrong-typed `archived` is now a 400 (#429).
      // Archiving also retires any pending usage-limit resume, but that rule belongs to
      // `setArchived` itself — the bulk sweep must obey it too (spec
      // 2026-08-03-auto-resume-after-usage-limit).
      const parsed = { data: c.req.valid('json') };
      const run = store.setArchived(id, parsed.data.archived !== false);
      return run ? c.json(run) : c.json({ error: 'not found' }, 404);
    })

    // The per-task off switch for that resume (the workspace setting is Settings → Resources).
    // Idempotent: a run with nothing pending answers 200 too, because "this task will not
    // resume itself" is equally true either way.
    .delete('/runs/:id/auto-resume', (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      manager.cancelAutoResume(id);
      return c.json({ cancelled: true as const });
    })

    .post('/runs/:id/read', (c) => {
      // No body: opening a thread marks it read, full stop. Stamps `seenAt = now` and
      // returns the updated record (which also rides the `run` SSE via `touch`).
      const run = c.get('project').store.setRead(c.req.param('id'));
      return run ? c.json(run) : c.json({ error: 'not found' }, 404);
    })

    .post('/runs/:id/unread', (c) => {
      // The mark-unread twin (#775) — bodyless like its read counterpart: clearing the
      // receipt is the whole action, so there is nothing to say about it. Sits under
      // `/runs/:id/`, so the `read-all` registration-order caveat above does not apply.
      const run = c.get('project').store.setUnread(c.req.param('id'));
      return run ? c.json(run) : c.json({ error: 'not found' }, 404);
    })

    .post('/runs', jsonZodValidator(startRunSchema), async (c) => {
      const { root: repoRoot, dataDir, manager } = c.get('project');
      const parsed = { data: c.req.valid('json') };
      // Workflow resolution and the pre-start guards live in `resolveRunWorkflow`/`guardRunStart`
      // above — shared verbatim with `POST /workspace/runs`, which must answer identically for
      // the same body (spec 2026-08-15-cross-project-workspace-run). Behaviour here is unchanged:
      // an inline chain wins, a named workflow 404s when unknown, and naming neither falls back
      // to quick-task (the composer's "None" pill), which is why this can never 404 unasked.
      const resolvedWorkflow = await resolveRunWorkflow(repoRoot, {
        ...(parsed.data.workflow === undefined ? {} : { workflow: parsed.data.workflow }),
        ...(parsed.data.steps === undefined ? {} : { steps: parsed.data.steps }),
      });
      if ('error' in resolvedWorkflow) {
        return c.json({ error: resolvedWorkflow.error }, resolvedWorkflow.status);
      }
      const workflow = resolvedWorkflow.workflow;
      const guarded = await guardRunStart(repoRoot, workflow, {
        ...(parsed.data.model === undefined ? {} : { model: parsed.data.model }),
        ...(parsed.data.runner === undefined ? {} : { runner: parsed.data.runner }),
        ...(parsed.data.agentProfile === undefined
          ? {}
          : { agentProfile: parsed.data.agentProfile }),
      });
      if (guarded) return c.json({ error: guarded.error }, guarded.status);
      const images = parsed.data.images?.map((img): ContentBlock => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.data },
      }));
      const input = {
        task: parsed.data.task,
        model: parsed.data.model,
        runner: parsed.data.runner,
        agentProfile: parsed.data.agentProfile,
        images,
        systemPrompt: parsed.data.systemPrompt,
        worktree: parsed.data.worktree,
        autonomous: parsed.data.autonomous,
        // Opt-in inbox (#471): the capability is the ceiling, so a client asking
        // for follow-ups on a server that has them off gets a plain `false`
        // rather than an error — the run is still perfectly valid without them.
        // One decision here feeds the run record, the system prompt and
        // CEZ_TODOS_FILE alike (RunManager.agentEnv).
        generateFollowups: capabilities().followups ? parsed.data.generateFollowups : false,
      };
      const variants = parsed.data.variants ?? 1;
      if (variants > 1) {
        // Variants live in worktrees — without git there's nothing to isolate
        // them with, so this degrades to a clear 400 instead of stepping on
        // one shared working tree.
        const repo = await getRepoInfo(repoRoot);
        if (!repo) {
          return c.json(
            {
              error:
                'parallel variants need a git repository (each variant runs in its own worktree) — run ×1 here, or start cezar inside a git repo',
            },
            400,
          );
        }
        const runs = manager.startVariants(workflow, input, variants);
        // The entry points at the first variant — the thread the composer navigates to.
        const first = runs[0];
        if (parsed.data.todoId && first) await noteTodoStarted(dataDir, parsed.data.todoId, first.id);
        return c.json({ runs }, 201);
      }
      const run = manager.startRun(workflow, input);
      if (parsed.data.todoId) await noteTodoStarted(dataDir, parsed.data.todoId, run.id);
      return c.json(run, 201);
    })

    .get('/runs/:id', (c) => {
      const { store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      return run ? c.json(withUsage(run)) : c.json({ error: 'not found' }, 404);
    })

    .get(
      '/runs/:id/history',
      paramZodValidator(runIdParamSchema),
      queryZodValidator(runHistoryQuerySchema),
      async (c) => {
        const { store, dataDir } = c.get('project');
        const { id } = c.req.valid('param');
        if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
        try {
          return c.json(
            await readRunHistoryPage(join(dataDir, 'runs', `${id}.ndjson`), c.req.valid('query').cursor),
          );
        } catch (error) {
          if (error instanceof HistoryCursorError) return c.json({ error: error.message }, error.status);
          throw error;
        }
      },
    )

    .get(
      '/runs/:id/history-context',
      paramZodValidator(runIdParamSchema),
      async (c) => {
        const { store, dataDir } = c.get('project');
        const { id } = c.req.valid('param');
        if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
        return c.json(await deriveRunContextEvents(join(dataDir, 'runs', `${id}.ndjson`)));
      },
    )

    // Editable titles (#389). The UI displays `titleSummary ?? title`, so a
    // user edit sets BOTH: `title` (the record's own name — the raw task stops
    // being it the moment the user renames the run) and `titleSummary` (what
    // actually displays). The auto-summarizer only ever fills an *unset*
    // titleSummary (RunManager.recordTurnEnd), so an edit wins over any past or
    // future auto-summary. Answers the updated record.
    .patch('/runs/:id', jsonZodValidator(patchRunSchema), async (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      const parsed = { data: c.req.valid('json') };
      // The prompt is editable only while the run is still queued (#472). Checked
      // BEFORE the title write so a rejected PATCH is a no-op rather than a partial
      // one. `title` itself keeps working on any status — no regression to #389.
      if (parsed.data.task !== undefined) {
        const foldedChars = foldedLength(parsed.data.task, store.getRun(id)?.queuedMessages ?? []);
        if (foldedChars > MAX_FOLDED_TASK_CHARS) {
          return c.json(
            {
              error: `prompt too long — ${MAX_FOLDED_TASK_CHARS} character limit across the task and its queued messages (would be ${foldedChars})`,
            },
            400,
          );
        }
        if (!manager.editTask(id, parsed.data.task)) {
          return c.json({ error: 'run already started' }, 409);
        }
      }
      if (parsed.data.title !== undefined) {
        // titleOrigin 'user' permanently stops the namer's live updates for this run
        // (spec 2026-07-17-task-auto-naming).
        store.updateRun(id, {
          title: parsed.data.title,
          titleSummary: parsed.data.title,
          titleOrigin: 'user',
        });
      }
      return c.json(store.getRun(id));
    })

    .post('/runs/:id/cancel', (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      const cancelled = manager.cancel(id);
      return c.json({ cancelled });
    })

    // Live-session participation (spec 002): deliver a user message (text +
    // pasted screenshots) into the run's open claude session.
    .post('/runs/:id/messages', jsonZodValidator(messageSchema), async (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      const parsed = { data: c.req.valid('json') };
      // Stacking onto a queued prompt mutates an existing task and invokes no provider.
      // Provider availability still gates live delivery after the record leaves `queued`, but
      // must not strand prompt authoring just because an unrelated fallback provider is
      // disconnected (provider-auth spec: disabling never blocks existing-task mutations).
      // In the dequeue race, the ladder below safely turns this into a starting-state buffer.
      if (run.status !== 'queued') {
        const blocked = await providerActionError([providerForActiveRun(run)]);
        if (blocked) return c.json({ error: blocked }, 409);
      }
      const content: ContentBlock[] = [
        ...parsed.data.images.map((img): ContentBlock => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.data },
        })),
        ...(parsed.data.text.trim() ? [{ type: 'text', text: parsed.data.text } satisfies ContentBlock] : []),
      ];
      // Three-rung delivery ladder (#472). Branch on the ENGINE's answer rather
      // than a status read here: the handler cannot observe the dequeue safely
      // (the record is written a tick later), the engine can.
      //   live session → delivered · still queued → folded into the prompt
      //   starting up  → buffered  · anything else → 409, exactly as before
      if (manager.sendMessage(id, content)) return c.json({ delivered: true });

      const currentRun = store.getRun(id);
      const stack = currentRun?.queuedMessages ?? [];
      // Bounds apply only to a message that is actually about to be stacked. Without this
      // gate an over-long message posted to a *finished* run would answer `400 prompt too
      // long` when the truthful answer is `409 session closed`. The status read is safe
      // here because it only decides whether to reject EARLY — `enqueueMessage` still
      // re-checks against the engine's own queue before writing anything.
      if (currentRun?.status === 'queued') {
        if (stack.length >= MAX_QUEUED_MESSAGES) {
          return c.json({ error: `too many queued messages — ${MAX_QUEUED_MESSAGES} message limit` }, 400);
        }
        const stackedImages = stack.reduce((n, m) => n + (m.images?.length ?? 0), 0);
        if (stackedImages + parsed.data.images.length > MAX_QUEUED_IMAGES) {
          return c.json({ error: `too many queued images — ${MAX_QUEUED_IMAGES} image limit across the stack` }, 400);
        }
        const prospective = foldedLength(currentRun.task, [...stack, { text: parsed.data.text }]);
        if (prospective > MAX_FOLDED_TASK_CHARS) {
          return c.json(
            {
              error: `prompt too long — ${MAX_FOLDED_TASK_CHARS} character limit across the task and its queued messages (would be ${prospective})`,
            },
            400,
          );
        }
      }

      const queued = manager.enqueueMessage(id, content);
      if (queued) return c.json({ queued: true, message: queued });
      if (manager.deferMessage(id, content)) return c.json({ deferred: true });
      return c.json({ error: 'session closed' }, 409);
    })

    // Edit / remove a stacked message (#472). Registered before any conflicting
    // `/:id` route so `queued-messages` never matches as a run id.
    .patch('/runs/:id/queued-messages/:msgId', jsonZodValidator(queuedMessagePatchSchema), async (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      const parsed = { data: c.req.valid('json') };
      const msgId = c.req.param('msgId');
      const stack = run.queuedMessages ?? [];
      const existing = stack.find((m) => m.id === msgId);
      if (!existing) return c.json({ error: 'not found' }, 404);

      const effectiveText = parsed.data.text ?? existing.text;
      const effectiveImageCount = parsed.data.images?.length ?? existing.images?.length ?? 0;
      if (!effectiveText.trim() && effectiveImageCount === 0) {
        return c.json({ error: 'message needs text or at least one image' }, 400);
      }

      const others = stack.filter((m) => m.id !== msgId);
      const stackedImages = others.reduce((n, m) => n + (m.images?.length ?? 0), 0);
      if (stackedImages + effectiveImageCount > MAX_QUEUED_IMAGES) {
        return c.json({ error: `too many queued images — ${MAX_QUEUED_IMAGES} image limit across the stack` }, 400);
      }
      const prospective = foldedLength(run.task, [...others, { text: effectiveText }]);
      if (prospective > MAX_FOLDED_TASK_CHARS) {
        return c.json(
          {
            error: `prompt too long — ${MAX_FOLDED_TASK_CHARS} character limit across the task and its queued messages (would be ${prospective})`,
          },
          400,
        );
      }

      const images: ContentBlock[] | undefined = parsed.data.images?.map(
          (img): ContentBlock => ({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: img.data },
          }),
        );
      const message = manager.editQueuedMessage(id, msgId, {
        ...(parsed.data.text !== undefined ? { text: parsed.data.text } : {}),
        ...(images !== undefined ? { images } : {}),
      });
      if (!message) return c.json({ error: 'run already started' }, 409);
      return c.json({ message });
    })

    .delete('/runs/:id/queued-messages/:msgId', (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      const msgId = c.req.param('msgId');
      if (!(run.queuedMessages ?? []).some((m) => m.id === msgId)) {
        return c.json({ error: 'not found' }, 404);
      }
      if (!manager.removeQueuedMessage(id, msgId)) return c.json({ error: 'run already started' }, 409);
      return c.json({ removed: true });
    })

    // "Finish": gracefully close a waiting session — the run completes as done.
    .post('/runs/:id/finish', (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      const finished = manager.finish(id);
      if (!finished) return c.json({ error: 'no open session' }, 409);
      return c.json({ finished: true });
    })

    // "Continue" (spec 003): reopen a finished run's session in-process.
    .post('/runs/:id/continue', jsonZodValidator(continueSchema, { absent: ({}) }), async (c) => {
      const { root: repoRoot, store, manager } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      // Bounded resume text (#429); an empty/absent body still just re-runs on the
      // run's current backend, and a runner/model override reopens on that engine (#401).
      const parsed = { data: c.req.valid('json') };
      if (agentModelsLocked(repoRoot) && parsed.data.model?.trim()) {
        return c.json({ error: AGENT_MODELS_LOCKED_ERROR }, 409);
      }
      const blocked = await providerActionError([providerForExistingRun(run, parsed.data.runner)]);
      if (blocked) return c.json({ error: blocked }, 409);
      const result = manager.continueRun(id, {
        text: parsed.data.text,
        images: parsed.data.images?.map((img): ContentBlock => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.data },
        })),
        runner: parsed.data.runner,
        model: parsed.data.model,
      });
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json({ continued: true });
    })

    // "Open in terminal" (spec 003): hand the session off to a real terminal —
    // in the task's worktree when it still exists (spec 006).
    .post('/runs/:id/open-in-cli', async (c) => {
      const { root: repoRoot, store } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      // Hosted mode: there is no "my machine" to open a terminal on. The UI
      // hides the button when localHandoff is false — this is defense in depth.
      if (!capabilities().localHandoff) {
        return c.json(
          {
            error:
              'local handoff is disabled — this cockpit runs in hosted mode (CEZ_REMOTE); resume the session from a machine that has the checkout',
          },
          409,
        );
      }
      const sessionStep = [...run.steps].reverse().find((s) => s.sessionId);
      const sessionId = sessionStep?.sessionId;
      if (!sessionId) return c.json({ error: 'no agent session to resume' }, 409);
      const blocked = await providerActionError([providerForExistingRun(run)]);
      if (blocked) return c.json({ error: blocked }, 409);
      const cwd = run.worktreePath && existsSync(run.worktreePath) ? run.worktreePath : repoRoot;
      const command = resumeCommand(run.runner, sessionId);
      // Fails closed on an id we do not recognise — see resumeCommand (#431).
      if (!command) return c.json({ error: 'the recorded session id has an unexpected shape' }, 409);
      // The account that OWNS this session, not the project's current one (spec 2026-07-29).
      const account = await handoffEnv(run.runner ?? 'claude', sessionStep?.profileId);
      if ('error' in account) return c.json({ error: account.error }, 409);
      const fallback = handoffFallbackCommand(cwd, command, account.env);
      // Fail closed for the same reason as the session id: a terminal opened without the
      // account's config dir resumes nothing and says nothing about why.
      if (fallback === null) {
        return c.json({ error: 'this account\'s folder cannot be used in a terminal command' }, 409);
      }
      const opened = await openTerminal(cwd, command, account.env);
      if (!opened) {
        return c.json({ error: 'no terminal emulator found', command: fallback }, 409);
      }
      return c.json({ opened: true, command });
    })

    // Open a run's worktree (or the repo root) in the chosen local app.
    .post('/runs/:id/open-in', jsonZodValidator(openInSchema), async (c) => {
      const { root: repoRoot, store } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      if (!capabilities().localHandoff) {
        return c.json(
          {
            error: 'local handoff is disabled — this cockpit runs in hosted mode (CEZ_REMOTE)',
          },
          409,
        );
      }
      // Follows the safeParse convention (#429); the downstream allowlist match is the real
      // injection guard, this just validates the shape.
      const parsedBody = { data: c.req.valid('json') };
      const { target, path: relPath } = parsedBody.data;
      const dir = run.worktreePath && existsSync(run.worktreePath) ? run.worktreePath : repoRoot;

      // Diff pane "open in OS default app" (#365): one worktree file, opened with the platform's
      // default handler for its type — not a directory in the file manager (that's `finder`
      // above) and not a session takeover (editors/CLIs above). `path` is re-validated against
      // the worktree here regardless of what the schema allowed, so a stale/forged path can never
      // escape it.
      if (target === 'default') {
        if (!run.worktreePath || !existsSync(run.worktreePath)) {
          return c.json({ error: NO_WORKTREE }, 409);
        }
        if (!relPath) return c.json({ error: 'path required for the default-app target' }, 400);
        const result = await readWorktreePath(run.worktreePath, relPath);
        if (result.kind !== 'file') {
          return c.json(
            {
              error: result.kind === 'dir' ? `not a file: ${relPath}` : result.error,
            },
            409,
          );
        }
        // This route's whole contract is "preview an image in its default app", and containment
        // alone does not enforce it. Without this gate any regular file in the worktree — a
        // `.command`/`.desktop` an agent just wrote, an `.exe` — would be handed to the OS
        // launcher, which EXECUTES it. Not remotely reachable (random run ids, same-origin, local
        // mode), so: defense in depth.
        //
        // Deliberately `isOsOpenableImage`, NOT the raw route's `imageMimeType`: that list allows
        // SVG on the strength of an `<img>` + no-script CSP the OS launcher never applies (the
        // default `.svg` handler is usually a browser, which would run the file's `<script>`).
        if (!isOsOpenableImage(result.path)) {
          // Say which rule refused, in the route's own words — "limited to images" would be a lie
          // to someone holding an SVG, which IS an image and DOES preview inline.
          return c.json(
            {
              error: imageMimeType(result.path)
                ? `SVG can carry scripts, so it previews inline but is never handed to the OS: ${result.path}`
                : `opening in the default app is limited to images: ${result.path}`,
            },
            409,
          );
        }
        const filePath = join(run.worktreePath, result.path);
        const opened = await openFile(filePath);
        if (!opened) return c.json({ error: `could not open ${result.path}`, path: filePath }, 409);
        return c.json({ opened: true, path: filePath });
      }

      // Coding-agent CLI handoff (#cli-handoff, #402): open a terminal in the worktree that resumes
      // THIS run's session when the chosen CLI is the run's own runner (and a session exists), or
      // starts a fresh CLI there otherwise. Same terminal launcher the Terminal button uses.
      // Records that predate the runner choice carry no `runner` at all — they default to Claude
      // everywhere else (resumeCommand, the client's resumeHint/cliTargetResumes), so the match
      // check defaults the same way here; without it, a legacy run's own Claude CLI would never
      // resume its own session, only ever launch fresh.
      // A run the engine still owns never resumes: `sessionId` is seeded when the agent step STARTS
      // (workflows/run.ts), so a running/queued/waiting run already carries one, and resuming it
      // would attach a SECOND CLI process to the transcript the engine is actively writing. Those
      // picks launch the CLI fresh in the worktree — the same degradation as a cross-runner pick,
      // and what the client's cliTargetResumes now labels. Resume-after-finish is untouched.
      const cliRunner = agentCliRunner(target);
      if (cliRunner) {
        const blocked = await providerActionError([cliRunner]);
        if (blocked) return c.json({ error: blocked }, 409);
        const engineOwnsSession = run.status === 'running' || run.status === 'queued' || run.status === 'waiting';
        const sessionStep = engineOwnsSession ? undefined : [...run.steps].reverse().find((s) => s.sessionId);
        const sessionId = sessionStep?.sessionId;
        // An id resumeCommand refuses (#431) degrades to a fresh CLI in the worktree,
        // exactly like a run that never recorded a session.
        const resume = sessionId && cliRunner === (run.runner ?? 'claude') ? resumeCommand(cliRunner, sessionId) : null;
        const command = resume ?? cliRunner;
        // BOTH branches carry the account (spec 2026-07-29-agent-profiles): a resume needs the
        // config dir that holds its session, and a FRESH CLI in this worktree should still open
        // on the account the project works under — otherwise "Open in → Claude CLI" quietly
        // hands the user a different subscription than every task in the same project uses.
        const account = resume
          ? await handoffEnv(cliRunner, sessionStep?.profileId)
          : { env: (await resolveProfileEnvForRoot(repoRoot, cliRunner)).env };
        if ('error' in account) return c.json({ error: account.error }, 409);
        const fallback = handoffFallbackCommand(dir, command, account.env);
        if (fallback === null) {
          return c.json({ error: 'this account\'s folder cannot be used in a terminal command' }, 409);
        }
        // The resolved dep, not the raw import — same reason as `openApp` above: a test must be
        // able to exercise this branch without a real terminal window surviving the run.
        const opened = await openTerminal(dir, command, account.env);
        if (!opened) {
          return c.json({ error: 'no terminal emulator found', command: fallback }, 409);
        }
        return c.json({ opened: true, path: dir, command });
      }

      const opened = await openApp(target, dir);
      if (!opened) return c.json({ error: `could not open ${target}`, path: dir }, 409);
      return c.json({ opened: true, path: dir });
    })

    // Handoff journal (spec 007): the per-task handoff.md as markdown. 404 only
    // when the task is unknown; a task without a (yet) seeded file returns ''.
    .get('/runs/:id/handoff', (c) => {
      const { dataDir, store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      return c.text(readHandoff(dataDir, run.id), 200, {
        'content-type': 'text/markdown; charset=utf-8',
      });
    })

    .get('/runs/:id/images/:file', (c) => {
      const { dataDir, store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      const file = basename(c.req.param('file'));
      const path = join(dataDir, 'runs', `${run.id}-images`, file);
      if (!existsSync(path)) return c.json({ error: 'not found' }, 404);
      const type = IMAGE_TYPES[file.split('.').pop() ?? ''] ?? 'application/octet-stream';
      return new Response(readFileSync(path), {
        headers: {
          'content-type': type,
          'cache-control': 'private, max-age=31536000, immutable',
        },
      });
    })

    // Task diff (spec 006): what this run changed — its worktree vs its base.
    .get('/runs/:id/diff', async (c) => {
      const { store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      if (!run.worktreePath || !existsSync(run.worktreePath)) {
        return c.text('(no worktree — this task ran directly in the repo working tree)');
      }
      return c.text(await worktreeDiff(run.worktreePath, run.baseBranch ?? 'HEAD'));
    })

    .get('/runs/:id/changes', async (c) => {
      const { root: repoRoot, store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      const workingDirectory = workingDirectoryOf(run, repoRoot);
      if (!workingDirectory) return c.json({ error: NO_WORKTREE }, 409);
      const result = await collectChanges(workingDirectory, run.baseBranch ?? 'HEAD', {
        taskBranch: run.branch,
        // Anchors a repointed worktree at the branch as this run found it (#751).
        runStartedAt: run.startedAt,
        // A read-only GET against the user's real checkout must never modify its index.
        intentToAdd: run.worktreePath ? undefined : false,
      });
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json(result.changes);
    })

    // The run's own commits (<base>..HEAD on the worktree branch) — the Commits tab.
    .get('/runs/:id/commits', async (c) => {
      const { root: repoRoot, store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      const workingDirectory = workingDirectoryOf(run, repoRoot);
      if (!workingDirectory) return c.json({ error: NO_WORKTREE }, 409);
      const result = await collectRunCommits(workingDirectory, run.baseBranch ?? 'HEAD');
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json({ commits: result.commits });
    })

    // One of the run's commits, structured like the Changes tab (reuses collectCommitChanges).
    .get('/runs/:id/commit/:sha', async (c) => {
      const { root: repoRoot, store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      const workingDirectory = workingDirectoryOf(run, repoRoot);
      if (!workingDirectory) return c.json({ error: NO_WORKTREE }, 409);
      const result = await collectCommitChanges(workingDirectory, c.req.param('sha'));
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json(result.commit);
    })

    // Files tab: directory listing (path omitted or a dir) or file content
    // (size-capped, binary flagged). Traversal-safe — readWorktreePath rejects
    // anything escaping the worktree. `raw=1` (R5 Step 1.6) serves the BYTES of
    // image files only, for the preview's inline <img> — never HTML/JS/etc., so
    // no worktree file can become a same-origin document, and never past the
    // size cap. The no-script CSP neutralizes SVG opened as a top-level URL.
    //
    // An `Accept` that asks for images reaches the same raw branch without the flag — which is
    // what an `<img>` sends — while the flag still wins whenever it is present and `*<slash>*`
    // (every `fetch`) still gets the JSON listing. See `negotiate`.
    .get('/runs/:id/files', queryZodValidator(z.object({ path: queryValue, raw: queryValue })), async (c) => {
      const { root: repoRoot, store } = c.get('project');
      const query = c.req.valid('query');
      c.header('vary', 'Accept');
      const wantsRaw =
        query.raw !== undefined
          ? query.raw === '1'
          : negotiate(c.req.header('accept'), FILE_FORMATS) === 'image/*';
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      const workingDirectory = workingDirectoryOf(run, repoRoot);
      if (!workingDirectory) return c.json({ error: NO_WORKTREE }, 409);
      const result = await readWorktreePath(workingDirectory, query.path ?? '');
      if (result.kind === 'invalid' || result.kind === 'missing') {
        return c.json({ error: result.error }, 409);
      }
      if (result.kind === 'dir') {
        return c.json({
          // `as const` or the literal widens to `string` during Hono's route-type inference,
          // which erases the discriminant a consumer narrows on — `entry.type === 'dir'` then
          // leaves `never` and every field access on it fails. The wire was always 'dir'.
          type: 'dir' as const,
          path: result.path,
          entries: result.entries,
        });
      }
      if (wantsRaw) {
        const mime = imageMimeType(result.path);
        if (mime === null || result.tooLarge) {
          // `?raw=1` ASKED for bytes, so it hears why it cannot have them — that 409 and its
          // wording are the protected surface (§2). An `Accept` is only a preference, so a
          // resource with no image representation falls THROUGH to the JSON answer below rather
          // than turning a browser's navigation to a text file into an error.
          if (query.raw !== undefined) {
            const error =
              mime === null
                ? `raw serving is limited to images: ${result.path}`
                : `file too large to serve raw (${result.size} bytes): ${result.path}`;
            return c.json({ error }, 409);
          }
        } else {
          const bytes = await readFile(join(workingDirectory, result.path));
          return c.body(new Uint8Array(bytes).buffer as ArrayBuffer, 200, {
            'content-type': mime,
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          });
        }
      }
      return c.json({
        type: 'file' as const,
        path: result.path,
        size: result.size,
        binary: result.binary,
        tooLarge: result.tooLarge,
        ...(result.content !== undefined ? { content: result.content } : {}),
      });
    })

    .post('/runs/:id/git/commit', jsonZodValidator(gitCommitSchema), async (c) => {
      const { store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      const worktree = worktreeOf(run);
      if (!worktree) return c.json({ error: NO_WORKTREE }, 409);
      const parsed = { data: c.req.valid('json') };
      const result = await commitAll(worktree, parsed.data.message);
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json({ committed: true, sha: result.sha });
    })

    .post('/runs/:id/git/push', async (c) => {
      const { store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      const worktree = worktreeOf(run);
      if (!worktree) return c.json({ error: NO_WORKTREE }, 409);
      const result = await pushCurrentBranch(worktree);
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json({
        pushed: true,
        branch: result.branch,
        remote: result.remote,
        upstreamSet: result.upstreamSet,
      });
    })

    // Draft PR from the review gate (spec 009): final autosave → push →
    // `gh pr create --draft`; on success the run completes as done with the PR
    // badge. Failures come back as 409 with a `manual` merge command the GUI
    // shows next to the toast. CEZ_DRY_RUN=1 fakes the URL (no push, no gh).
    .post('/runs/:id/pr', async (c) => {
      const { root: repoRoot, dataDir, store, manager } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      if (manager.isActive(id)) return c.json({ error: 'run is still active — wait for the review gate' }, 409);
      if (!run.worktreePath || !existsSync(run.worktreePath) || !run.branch) {
        return c.json(
          {
            error: 'no worktree/branch to publish — this task ran in the repo working tree',
          },
          400,
        );
      }
      const outcome = await createDraftPr({
        repoRoot,
        run,
        handoffText: readHandoff(dataDir, id),
      });
      if (!outcome.ok) {
        return c.json({ error: outcome.error, manual: `git merge ${run.branch}` }, 409);
      }
      // A number the cockpit asked about BEFORE the pull request existed is cached as "this
      // repository has no such number" — which is exactly what a `CEZ:PR=901` marker declared
      // ahead of the push looks like. It exists now.
      const createdNumber = refNumberFromUrl(outcome.url);
      if (createdNumber !== null) forgetRefStatus(repoRoot, createdNumber);
      store.updateRun(id, {
        pullRequestUrl: outcome.url,
        status: 'done',
        finishedAt: run.finishedAt ?? new Date().toISOString(),
      });
      store.appendEvent(id, {
        type: 'note',
        message: `draft PR created: ${outcome.url}${outcome.dryRun ? ' (dry run — no real PR)' : ''}`,
      });
      return c.json({ url: outcome.url, dryRun: outcome.dryRun }, 201);
    })

    // Archived tasks keep their worktree for inspection; this is the explicit
    // "🧹 Remove worktree" cleanup (spec 006).
    .post('/runs/:id/remove-worktree', async (c) => {
      const { root: repoRoot, store, manager } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      if (manager.isActive(id)) return c.json({ error: 'run is active — cancel it first' }, 409);
      if (run.worktreePath) await removeWorktree(repoRoot, run.worktreePath, run.branch);
      store.updateRun(id, { worktreePath: undefined, branch: undefined });
      return c.json({ removed: true });
    })

    .delete('/runs/:id', async (c) => {
      const { root: repoRoot, store, manager } = c.get('project');
      const id = c.req.param('id');
      if (manager.isActive(id)) return c.json({ error: 'run is active — cancel it first' }, 409);
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      // Delete cleans up after itself: worktree + branch go with the run (spec 006).
      if (run.worktreePath) await removeWorktree(repoRoot, run.worktreePath, run.branch);
      return store.deleteRun(id) ? c.json({ deleted: true }) : c.json({ error: 'not found' }, 404);
    });

  // ---- parallel variants (spec 010) -----------------------------------------

  const groupRuns = (store: RunStore, groupId: string): RunRecord[] =>
    store
      .listRuns()
      .filter((r) => r.groupId === groupId)
      .sort((a, b) => (a.variant ?? '').localeCompare(b.variant ?? ''));

  // ---- chained family: variant groups (project-scoped) ----
  const groupsRoutes = new Hono<ProjectApiEnv>()
    .get('/groups/:groupId', async (c) => {
      const { dataDir, store } = c.get('project');
      const runs = groupRuns(store, c.req.param('groupId'));
      if (runs.length === 0) return c.json({ error: 'not found' }, 404);
      const detailed = await Promise.all(
        runs.map(async (r): Promise<GroupVariant> => ({
          id: r.id,
          variant: r.variant ?? '?',
          title: r.title,
          status: r.status,
          archived: r.archived,
          tokensUsed: r.tokensUsed,
          ...(r.inputTokens !== undefined ? { inputTokens: r.inputTokens } : {}),
          ...(r.outputTokens !== undefined ? { outputTokens: r.outputTokens } : {}),
          ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
          diffStat:
            r.worktreePath && existsSync(r.worktreePath)
              ? await worktreeDiffStat(r.worktreePath, r.baseBranch ?? 'HEAD')
              : '',
          handoffExcerpt: handoffProgressExcerpt(readHandoff(dataDir, r.id)),
        })),
      );
      return c.json({
        groupId: c.req.param('groupId'),
        runs: detailed,
      } satisfies GroupResponse);
    })

    // "Pick this one": the winner rests at `review` (spec 009 takes it from
    // there — send back / draft PR / finish); the losers are cancelled if
    // alive, archived, and their worktrees + branches removed.
    .post('/groups/:groupId/pick', jsonZodValidator(pickSchema), async (c) => {
      const { root: repoRoot, dataDir, store, manager } = c.get('project');
      const runs = groupRuns(store, c.req.param('groupId'));
      if (runs.length === 0) return c.json({ error: 'not found' }, 404);
      const parsed = { data: c.req.valid('json') };
      const winner = runs.find((r) => r.id === parsed.data.runId);
      if (!winner) return c.json({ error: 'runId is not part of this group' }, 404);
      if (manager.isActive(winner.id)) {
        return c.json({ error: 'this variant is still active — wait for it to finish first' }, 409);
      }

      // Winner: a non-review terminal state with a non-empty diff flips to
      // `review` (the settleSuccess rule) — but only when the review gate applies
      // (#489): it is enabled (`reviewGateEnabled`, default off) AND the winner is
      // not autonomous. An autonomous / gate-off winner keeps its `done` state with
      // the diff left in the worktree; an empty diff (or no worktree) stays too.
      if (
        winner.status !== 'review' &&
        winner.worktreePath &&
        existsSync(winner.worktreePath) &&
        winner.autonomous !== true &&
        reviewGateEnabled(await loadConfig(repoRoot))
      ) {
        const diff = await worktreeDiff(winner.worktreePath, winner.baseBranch ?? 'HEAD');
        if (diff.trim().length > 0 && !diff.startsWith('(diff failed')) {
          store.updateRun(winner.id, { status: 'review' });
        }
      }
      const losers = runs.filter((r) => r.id !== winner.id);
      store.appendEvent(winner.id, {
        type: 'lifecycle',
        message: `picked from ${runs.length} variants — ${losers.length} other variant(s) archived`,
      });
      appendHandoffHeartbeat(dataDir, winner.id, `picked from ${runs.length} variants`);

      for (const loser of losers) {
        if (manager.isActive(loser.id)) manager.cancel(loser.id);
        if (loser.worktreePath) await removeWorktree(repoRoot, loser.worktreePath, loser.branch);
        store.updateRun(loser.id, { worktreePath: undefined, branch: undefined });
        store.setArchived(loser.id, true);
        store.appendEvent(loser.id, {
          type: 'lifecycle',
          message: `variant ${winner.variant ?? '?'} was picked — this variant is archived, its worktree removed`,
        });
      }
      // Spread: `getRun` may answer undefined, and an undefined VALUE is dropped by
      // JSON.stringify — so writing the key unconditionally typed the route as sending a key it
      // does not. contract/workflows.ts says `.optional()`, which is what a client receives.
      const picked = store.getRun(winner.id);
      return c.json({ ...(picked !== undefined ? { winner: picked } : {}) });
    });

  // ---- chained family: open-targets (project-scoped) ----
  const openTargetsRoutes = new Hono<ProjectApiEnv>()
    .get('/open-targets', (c) => c.json({ targets: capabilities().localHandoff ? detectOpenTargets() : [] }))

    // Open the PROJECT ROOT itself (Settings → "Project folder" → Open with). The run route
    // above opens a task worktree and needs a run to name one; this is the repo the cockpit is
    // scoped to, which the scope middleware has already resolved — so no path is accepted from
    // the client and there is nothing to contain.
    .post('/open-in', jsonZodValidator(openProjectInSchema), async (c) => {
      const { root } = c.get('project');
      if (!capabilities().localHandoff) {
        return c.json(
          { error: 'local handoff is disabled — this cockpit runs in hosted mode (CEZ_REMOTE)' },
          409,
        );
      }
      const { target } = c.req.valid('json');
      // Refused here rather than left to the menu, on the same principle as the accounts route:
      // a `cli:<runner>` handoff would START AN AGENT in the checkout everything else runs in a
      // worktree to protect. Which app APPLIES is a property of the route, not of one client.
      if (agentCliRunner(target) !== null) {
        return c.json({ error: 'agent CLIs open a task worktree, not the project folder' }, 400);
      }
      if (!detectOpenTargets().some((candidate) => candidate.id === target)) {
        return c.json({ error: `no such app on this machine: ${target}` }, 400);
      }
      const opened = await openApp(target, root);
      if (!opened) return c.json({ error: `could not open ${target}`, path: root }, 409);
      return c.json({ opened: true as const, path: root });
    });

  // Agent screenshots — image blocks the run manager persisted out of tool
  // results (persistImage). `basename` pins reads inside the run's own dir.
  const IMAGE_TYPES: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
  };
  // ---- session git view (redesign R5 Step 1.2 — §"Git/session API additions").
  // Structured sibling of the text-blob /diff above (which stays untouched —
  // protected surface). Isolated runs read their worktree; worktree-off runs
  // read the repo checkout they executed in. Every predictable git failure
  // degrades to 409 + human-readable reason, 404 only for unknown ids.
  const worktreeOf = (run: RunRecord): string | null =>
    run.worktreePath && existsSync(run.worktreePath) ? run.worktreePath : null;
  const workingDirectoryOf = (run: RunRecord, repoRoot: string): string | null =>
    run.worktree === false
      ? repoRoot
      : worktreeOf(run);
  const NO_WORKTREE = 'no worktree — this task ran directly in the repo working tree';

  // ---- chained family: worktrees (project-scoped) ----
  const worktreesRoutes = new Hono<ProjectApiEnv>()
    .get('/worktrees', async (c) => {
      const { root: repoRoot, store } = c.get('project');
      // The keep-limit the panel reports is the one the enforcer will actually
      // apply — inherited from the workspace default when this repo sets none.
      const keep = await resolveWorktreeRetention(repoRoot);
      const runs = store.listRuns().filter((r) => r.worktreePath && existsSync(r.worktreePath));
      const worktrees = await Promise.all(
        runs.map(async (r) => ({
          runId: r.id,
          title: r.title ?? r.id,
          status: r.status,
          branch: r.branch ?? null,
          // POSIX `du` — degrades to null (Windows / du missing / error); never blocks.
          sizeBytes: await worktreeSizeBytes(r.worktreePath as string),
          finishedAt: r.finishedAt ?? null,
          reclaimable: isReclaimable(r),
        })),
      );
      // Total is null when any size degraded, so the panel never shows a wrong sum.
      const totalBytes = worktrees.some((w) => w.sizeBytes === null)
        ? null
        : worktrees.reduce((sum, w) => sum + (w.sizeBytes ?? 0), 0);
      return c.json({ worktrees, totalBytes, keep });
    })

    .post('/worktrees/reclaim', jsonZodValidator(() => reclaimBodySchema, { absent: ({}), message: 'invalid body' }), async (c) => {
      const { root: repoRoot, store } = c.get('project');
      // The body is validated (an empty or `{}` one is accepted) but carries nothing this
      // handler reads; retention is best-effort, so 200 always.
      const reclaimed = await reclaimWorktrees(repoRoot, store, await resolveWorktreeRetention(repoRoot));
      return c.json({ reclaimed });
    });

  const reclaimBodySchema = z.object({}).passthrough();

  /**
   * "The inbox is on and this entry exists" — the 409/404 half of `POST /todos/:id/start`, lifted
   * out of the handler and in FRONT of the body validator.
   *
   * That position is the whole point. The route's contract is that an unknown id 404s before the
   * body is looked at, and Hono only records a body in the route type when it is validated as
   * MIDDLEWARE — which necessarily runs before the handler. Registering this guard first satisfies
   * both: the documented status order is unchanged, and `startTodoSchema` becomes visible to
   * `AppType` (and so to `hc`) instead of being parsed invisibly inside the handler.
   *
   * Deliberately NOT annotated with a return type: the inferred one carries the typed 404, which
   * is what keeps that branch in the route's schema for the client.
   *
   * **Ungated since D7a (2026-08-15).** This used to answer `409 FOLLOWUPS_OFF` when
   * `capabilities().followups` was off, and that made the fan-out flow dead-end at its LAST step:
   * tasks filed (`POST /todos`, ungated), listed on the board (ungated), and then un-startable on
   * a default install, where `CEZ_FOLLOWUPS` is unset. The line is generation, not storage —
   * `CEZ_FOLLOWUPS=1` governs whether an agent is ASKED to produce follow-ups at the end of a run
   * (`handoff.ts`, `FOLLOWUP_INSTRUCTIONS`, still gated at the `generateFollowups` call site), not
   * whether a task that already exists can be read back and started.
   */
  const todoMustExist = async (c: Context<TodoStartEnv, '/todos/:id/start'>, next: Next) => {
    const todo = (await readTodos(c.get('project').dataDir)).find((t) => t.id === c.req.param('id'));
    if (!todo) return c.json({ error: 'not found' }, 404);
    c.set('todo', todo);
    await next();
  };

  // ---- chained family: follow-up inbox / todos (project-scoped) ----
  const todosRoutes = new Hono<ProjectApiEnv>()
    // Ungated since D7a: returning `[]` with the flag off hid a composer-filed task in its own
    // project while the cross-project board showed it — two surfaces disagreeing about whether a
    // task exists is worse than either answer alone.
    .get('/todos', async (c) => c.json(await readTodos(c.get('project').dataDir)))

    // The create route (2026-08-15-knowledge-grounded-task-fanout.md, Phase 1; ungated per D7,
    // added 2026-08-15): the composer's fan-out — and, until Phases 2-4 land, any script or
    // agent — files a fully-specified task here instead of the out-of-process `CEZ_TODOS_FILE`
    // append being the only writer. Body validated against the wire twin
    // (`createTodoInputSchema`), which is `todoItemSchema` minus the server-/agent-assigned
    // keys, so the two can never drift field-by-field.
    //
    // Deliberately NOT gated on `capabilities().followups`, unlike every other route in this
    // family: this is becoming the composer's DEFAULT submit path, and `followups` (the
    // follow-up INBOX feature — `GET`/`DELETE`/`:id/start` below) is off by default on every
    // real install. Storing a task the composer just filed is not conditional on whether that
    // separate inbox feature happens to be on.
    .post('/todos', jsonZodValidator(() => createTodoInputSchema), async (c) => {
      const { dataDir } = c.get('project');
      const todo = await createTodo(dataDir, c.req.valid('json'));
      const body: CreateTodoResponse = { todo };
      return c.json(body, 201);
    })

    // Check off = delete the entry. Ungated since D7a, for symmetry with create/list/start: a task
    // you can file and start but not remove is a trap.
    .delete('/todos/:id', async (c) => {
      const { dataDir } = c.get('project');
      const removed = await removeTodo(dataDir, c.req.param('id'));
      return removed ? c.json({ removed: true }) : c.json({ error: 'not found' }, 404);
    })

    // "▶ Run": turn an inbox entry into a task — a one-off single-step workflow
    // around the suggested skill when it exists, plain quick-task otherwise.
    //
    // TWO middlewares, and their ORDER is the contract. This route's documented status order
    // (pinned by todos-start.test.ts) is that a disabled inbox 409s and an unknown id 404s BEFORE
    // the body is looked at — which is why the body used to be parsed inline, invisible to `hc`.
    // Hono runs route middleware in registration order, so `todoMustExist` FIRST keeps that order
    // exactly while `jsonZodValidator` second is what records the body in the route type.
    //
    // The two no-body cases the old inline parse distinguished are carried by the validator's
    // `absent`/`malformed` options: no body at all is `undefined` (the pre-#401 bodyless POST,
    // which the optional schema accepts → 201), a truncated payload is `null` (which it rejects
    // → 400, rather than passing as "no body" and silently starting a run).
    .post(
      '/todos/:id/start',
      todoMustExist,
      jsonZodValidator(startTodoSchema, { absent: undefined, malformed: null }),
      async (c) => {
        const { root: repoRoot, dataDir, manager } = c.get('project');
        const id = c.req.param('id');
        const todo = c.get('todo');
        const parsed = { data: c.req.valid('json') };
        if (agentModelsLocked(repoRoot) && parsed.data?.model?.trim()) {
          return c.json({ error: AGENT_MODELS_LOCKED_ERROR }, 409);
        }
        if (todo.startedTaskId) return c.json({ error: 'already started' }, 409);

        let task = todoTaskText(todo);
        if (parsed.data?.prompt) task += `\n\n${parsed.data.prompt}`;

        let workflow: WorkflowDef | undefined;
        if (todo.suggestedSkill) {
          const skills = await discoverSkills(repoRoot);
          if (skills.some((s) => s.name === todo.suggestedSkill)) {
            workflow = {
              name: '(inbox)',
              description: `Follow-up from the inbox — skill "${todo.suggestedSkill}"`,
              source: 'built-in',
              steps: [
                {
                  id: 'task',
                  name: 'Do the task',
                  skill: todo.suggestedSkill,
                  prompt: '{{task}}',
                },
              ],
            };
          }
        }
        if (!workflow) {
          const { workflows } = await loadWorkflows(repoRoot);
          workflow = workflows.find((w) => w.name === 'quick-task') ?? QUICK_TASK_WORKFLOW;
        }

        const fallback = parsed.data?.runner ?? (await loadConfig(repoRoot)).defaultRunner;
        const blocked = await providerActionError(providersRequiredByWorkflow(workflow, fallback));
        if (blocked) return c.json({ error: blocked }, 409);

        const run = manager.startRun(workflow, {
          task,
          runner: parsed.data?.runner,
          model: parsed.data?.model,
        });
        await markStarted(dataDir, id, run.id);
        return c.json({ run }, 201);
      },
    );

  // ---- chained family: SSE streams (project-scoped) ----
  const sseRoutes = new Hono<ProjectApiEnv>()
    .get(
      '/runs/:id/events',
      paramZodValidator(runIdParamSchema),
      queryZodValidator(runEventsQuerySchema),
      async (c) => {
      const { store, dataDir } = c.get('project');
      const { id } = c.req.valid('param');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      const query = c.req.valid('query');
      const eventsPath = join(dataDir, 'runs', `${id}.ndjson`);
      if (query.cursor) {
        try {
          await validateLiveCursor(eventsPath, query.cursor);
        } catch (error) {
          if (error instanceof HistoryCursorError) return c.json({ error: error.message }, error.status);
          throw error;
        }
      }
      const lastEventId = Number.parseInt(c.req.header('Last-Event-ID') ?? '', 10);
      const requestedAfter = Math.max(
        query.afterSeq ?? 0,
        Number.isSafeInteger(lastEventId) && lastEventId >= 0 ? lastEventId : 0,
      );
      return streamSSENoBuffer(c, async (stream) => {
        let replaying = true;
        let maxSeq = requestedAfter;
        const buffered: RunEvent[] = [];
        // One endpoint, two SSE event names: v1 lines stay `run-event` (the name
        // the legacy UI listened to — its default branch JSON-dumped unknown
        // types into the transcript, which is why v2 never rode that name; the
        // split outlives the R7 retirement as wire shape); protocol-v2 lines
        // (dotted types, persisted snapshots AND ephemeral coalesced deltas)
        // ride `ui-event`, which only v2-aware clients subscribe to.
        // EventSource ignores names it has no listener for.
        const writeEvent = (event: RunEvent) =>
          stream.writeSSE({
            id: String(event.seq),
            event: isV2WireEventType(event.type) ? 'ui-event' : 'run-event',
            data: JSON.stringify(event),
          });
        const onEvent = (payload: { runId: string; event: RunEvent }) => {
          if (payload.runId !== id) return;
          if (replaying) buffered.push(payload.event);
          else void writeEvent(payload.event);
        };
        const onRun = (run: RunRecord) => {
          if (run.id !== id) return;
          void stream.writeSSE({ event: 'run', data: JSON.stringify(run) });
        };
        store.on('event', onEvent);
        store.on('run', onRun);
        stream.onAbort(() => {
          store.off('event', onEvent);
          store.off('run', onRun);
        });

        const replay = query.cursor
          ? await readEventsAfterLiveCursor(eventsPath, query.cursor)
          : { events: store.readEvents(id), boundarySeq: 0 };
        maxSeq = Math.max(maxSeq, replay.boundarySeq);
        for (const event of replay.events) {
          if (event.seq <= maxSeq) continue;
          await writeEvent(event);
          maxSeq = event.seq;
        }
        replaying = false;
        for (const event of buffered) {
          if (event.seq > maxSeq) await writeEvent(event);
        }
        const run = store.getRun(id);
        if (run) await stream.writeSSE({ event: 'run', data: JSON.stringify(run) });

        while (!stream.aborted) {
          await stream.writeSSE({ event: 'ping', data: '' });
          await stream.sleep(15_000);
        }
      });
    },
    )

    // Global SSE: run-summary updates for the list view + inbox changes.
    // Scoped `/p/:projectId/events` carries that project's stream in today's
    // shape; the legacy unprefixed alias stays bound to the boot project ONLY
    // (spec "Legacy aliases" — widening it would be a silent behavioral break;
    // the all-project stream arrives as `/api/workspace/events` in step 2.8).
    .get('/events', (c) => {
      const { dataDir, store } = c.get('project');
      return streamSSENoBuffer(c, async (stream) => {
        const onRun = (run: RunRecord) => void stream.writeSSE({ event: 'run', data: JSON.stringify(run) });
        const onDeleted = (id: string) =>
          void stream.writeSSE({
            event: 'run-deleted',
            data: JSON.stringify({ id }),
          });
        const sendTodos = async () => {
          const items: TodoItem[] = await readTodos(dataDir).catch(() => []);
          await stream.writeSSE({ event: 'todos', data: JSON.stringify(items) });
        };
        // Subscribing is what creates this project's watcher (step 2.3), so this costs one fd per
        // open stream. That cost used to be opt-in behind `capabilities().followups` (#471), but
        // since D7a (2026-08-15) todos exist on a default install — the composer's fan-out files
        // them — and a board that never updates while tasks are being written into it is a worse
        // trade than the fd. Scoped to this stream's dataDir: another project's todos.json writes
        // never reach this connection.
        const offTodos = onTodosChanged(dataDir, () => void sendTodos());
        // Live resource telemetry (#348): the sampler ticks ~every 2 s only
        // while some run has a registered process; each tick is relayed as one
        // `usage` message (runId → {cpuPct, rssBytes, procCount}). Never
        // persisted — the NDJSON transcripts stay usage-free. The sampler is
        // module-global, so a snapshot carries EVERY project's runs — split it
        // by ownership and relay only this project's rows, never a stamped
        // whole (multi-project spec, step 2.4: filtered, not stamped).
        const offUsage = onUsage((usage) => {
          const owned: typeof usage = {};
          for (const [runId, sample] of Object.entries(usage)) {
            if (store.getRun(runId)) owned[runId] = sample;
          }
          void stream.writeSSE({ event: 'usage', data: JSON.stringify(owned) });
        });
        store.on('run', onRun);
        store.on('deleted', onDeleted);
        stream.onAbort(() => {
          store.off('run', onRun);
          store.off('deleted', onDeleted);
          offTodos();
          offUsage();
        });
        while (!stream.aborted) {
          await stream.writeSSE({ event: 'ping', data: '' });
          await stream.sleep(15_000);
        }
      });
    });

  // ---- chained family: workspace SSE stream (workspace-level) ----
  const workspaceEventsRoutes = new Hono<ProjectApiEnv>()
    .get('/workspace/events', (c) => {
      return streamSSENoBuffer(c, async (stream) => {
        // One detach bundle per attached project — the id guard makes a double
        // attach (connect-time snapshot vs. the built hook) impossible.
        const attached = new Map<string, { store: RunStore; detach: () => void }>();
        const attach = (project: string, ctx: Pick<ProjectContext, 'store' | 'dataDir'>): void => {
          if (attached.has(project)) return;
          const { store, dataDir } = ctx;
          const onRun = (run: RunRecord) =>
            void stream.writeSSE({
              event: 'run',
              data: JSON.stringify({ ...run, project }),
            });
          const onDeleted = (id: string) =>
            void stream.writeSSE({
              event: 'run-deleted',
              data: JSON.stringify({ id, project }),
            });
          const sendTodos = async () => {
            const items: TodoItem[] = await readTodos(dataDir).catch(() => []);
            await stream.writeSSE({
              event: 'todos',
              data: JSON.stringify({ project, items }),
            });
          };
          // Ungated alongside the per-project stream (D7a). NOTE the cost is bigger here: this is
          // the multi-project stream, so it is one watcher per ATTACHED project rather than one
          // per connection. Accepted for the same reason — the cross-project board is where a
          // fan-out's tasks appear, and it has to see them arrive. Each subscription is still
          // scoped to its own dataDir (2.3).
          const offTodos = onTodosChanged(dataDir, () => void sendTodos());
          store.on('run', onRun);
          store.on('deleted', onDeleted);
          attached.set(project, {
            store,
            detach: () => {
              store.off('run', onRun);
              store.off('deleted', onDeleted);
              offTodos();
            },
          });
        };

        // The boot context never lives in the lazy map — seed it under its
        // registry id (`resolveBootProject`, NOT `bootContext.id`, which may be
        // the reserved alias when registration was suppressed).
        attach(await resolveBootProject(), bootContext);
        // NB: snapshot + hook subscription happen in one sync block, so no
        // context can slip between them.
        for (const id of contexts.ids()) {
          const ctx = contexts.peek(id);
          if (ctx) attach(ctx.id, ctx);
        }
        const offBuilt = contexts.onContextBuilt((ctx) => attach(ctx.id, ctx));

        // `usage` is FILTERED per project, never a stamped whole (spec "SSE
        // streams"): the module-global sampler's snapshot is split by each
        // attached project's owned runIds, one event per project that has live
        // rows. No event for a row-less project — the workspace stream carries
        // no empty-record clears (that is the per-project streams' contract).
        const offUsage = onUsage((usage) => {
          const rows = Object.entries(usage);
          for (const [project, { store }] of attached) {
            const owned: typeof usage = {};
            for (const [runId, sample] of rows) {
              if (store.getRun(runId)) owned[runId] = sample;
            }
            if (Object.keys(owned).length > 0) {
              void stream.writeSSE({
                event: 'usage',
                data: JSON.stringify({ project, usage: owned }),
              });
            }
          }
        });

        // Workspace-level events (project-added / project-removed /
        // checkout-progress plus host-wide unstamped provider-status) — relayed
        // verbatim under their own names. A removal also drops the project's
        // attach entry: the id guard in `attach` would otherwise pin the
        // DISPOSED context forever, so a project removed and re-added on the
        // same slug would rebuild a fresh context whose events never reach this
        // already-open stream.
        const offWorkspace = workspaceEvents.on((event, data) => {
          if (event === 'project-removed') {
            const removed = (data as { id?: string }).id;
            if (removed !== undefined && attached.has(removed)) {
              attached.get(removed)?.detach();
              attached.delete(removed);
            }
          }
          void stream.writeSSE({ event, data: JSON.stringify(data) });
        });

        stream.onAbort(() => {
          offBuilt();
          offUsage();
          offWorkspace();
          for (const { detach } of attached.values()) detach();
          attached.clear();
        });

        while (!stream.aborted) {
          await stream.writeSSE({ event: 'ping', data: '' });
          await stream.sleep(15_000);
        }
      });
    });

  // ---- chained family: GitHub (project-scoped) ----
  // These sit ABOVE the routes rather than with the family's other schemas below it, because a
  // validator argument is evaluated when the route is REGISTERED — a schema declared further down
  // would be in its temporal dead zone. (The schemas below are all read inside a handler, or
  // passed as a thunk, which defers them past that point.)
  const mergeNumberParams = z.object({ number: z.coerce.number().int().positive() });
  /** A ref-status list: `null` means malformed (the caller answers 400), `[]` means "not asked
   *  for". Absent and empty are the same request — neither names a number. */
  const parseRefNumbers = (raw: string | undefined): number[] | null => {
    const parts = (raw ?? '').split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length > GH_REF_STATUS_MAX) return null;
    const numbers: number[] = [];
    for (const part of parts) {
      const n = Number(part);
      if (!Number.isInteger(n) || n <= 0 || String(n) !== part) return null;
      numbers.push(n);
    }
    return numbers;
  };
  const prChangesParams = z.object({ number: z.coerce.number().int().positive().safe() });
  const prChangesQuery = z.object({ refresh: queryValue.refine((v) => v === undefined || v === '1') });
  const githubRoutes = new Hono<ProjectApiEnv>()
    .get(
      '/github',
      // `limit` stays a bare string: the handler's `Number.parseInt`/`Number.isFinite` fallback to
      // 30 already accepts `?limit=banana`, and a numeric schema would 400 it instead.
      queryZodValidator(z.object({ limit: queryValue, refresh: queryValue })),
      async (c) => {
        const { root: repoRoot } = c.get('project');
        const query = c.req.valid('query');
        const limit = Number.parseInt(query.limit ?? '', 10);
        return c.json(await fetchGithub(repoRoot, query.refresh === '1', Number.isFinite(limit) ? limit : 30));
      },
    )

    .get('/github/comments/:kind/:number', queryZodValidator(refreshQuery), async (c) => {
      const { root: repoRoot } = c.get('project');
      const parsed = commentsParams.safeParse({
        kind: c.req.param('kind'),
        number: c.req.param('number'),
      });
      if (!parsed.success) return c.json({ error: 'invalid kind or number' }, 400);
      return c.json(
        await fetchGithubComments(repoRoot, parsed.data.kind, parsed.data.number, c.req.valid('query').refresh === '1'),
      );
    })

    // Lazy checks glyphs for on-screen PR rows (#664). Additive sibling of /api/github — the list
    // call dropped `statusCheckRollup` (the dominant cost), so the glyph is hydrated here per
    // visible row. `prs` is a comma-separated list of positive integers, capped at GH_CHECKS_MAX;
    // anything malformed is a 400. Same in-payload availability degrade as the list (never a 5xx).
    // `prs` is the one genuinely REQUIRED query key on this server, so it is the one validated
    // strictly — `.min(1)` because `?prs=` answered `missing prs query` before it answered
    // `invalid prs query`, and both spellings must keep their own words.
    .get('/github/checks', queryZodValidator(z.object({ prs: z.string().min(1) }), { message: 'missing prs query' }), async (c) => {
      const { root: repoRoot } = c.get('project');
      const raw = c.req.valid('query').prs;
      const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
      if (parts.length === 0 || parts.length > GH_CHECKS_MAX) return c.json({ error: 'invalid prs query' }, 400);
      const numbers: number[] = [];
      for (const part of parts) {
        const n = Number(part);
        if (!Number.isInteger(n) || n <= 0 || String(n) !== part) return c.json({ error: 'invalid prs query' }, 400);
        numbers.push(n);
      }
      return c.json(await fetchGithubChecks(repoRoot, numbers));
    })

    // Batched status for the PR/issue chips a task table paints. Additive sibling of
    // /github/checks and shaped like it: comma-separated positive integers, capped at
    // GH_REF_STATUS_MAX per kind, malformed input is a 400, and an unreachable forge degrades in
    // the payload. Unlike /github/checks BOTH keys are optional — a table may hold only issues —
    // but at least one must name something, or the request asks for nothing.
    .get(
      '/github/ref-status',
      queryZodValidator(z.object({ prs: z.string().optional(), issues: z.string().optional() })),
      async (c) => {
        const { root: repoRoot } = c.get('project');
        const { prs, issues } = c.req.valid('query');
        const parsedPrs = parseRefNumbers(prs);
        const parsedIssues = parseRefNumbers(issues);
        if (parsedPrs === null || parsedIssues === null) return c.json({ error: 'invalid ref-status query' }, 400);
        if (parsedPrs.length === 0 && parsedIssues.length === 0) {
          return c.json({ error: 'missing prs or issues query' }, 400);
        }
        return c.json(await fetchGithubRefStatus(repoRoot, { prs: parsedPrs, issues: parsedIssues }));
      },
    )

    .get(
      '/github/prs/:number/merge-state',
      paramZodValidator(mergeNumberParams, { message: 'invalid pull request number' }),
      queryZodValidator(refreshQuery),
      async (c) => {
        const { root: repoRoot } = c.get('project');
        const parsed = { data: c.req.valid('param') };
        const forge = resolveForge(await getRepoInfo(repoRoot));
        if (!forge?.prMergeState) return c.json({ available: false, reason: 'GitHub merge state is unavailable' });
        return c.json(await forge.prMergeState(parsed.data.number, { refresh: c.req.valid('query').refresh === '1' }));
      },
    )

    .post(
      '/github/prs/:number/merge',
      paramZodValidator(mergeNumberParams, { message: 'invalid pull request number' }),
      jsonZodValidator(() => mergeBodySchema, { message: 'invalid merge request' }),
      async (c) => {
        const { root: repoRoot } = c.get('project');
        const parsedNumber = { data: c.req.valid('param') };
        const body = { data: c.req.valid('json') };
        const forge = resolveForge(await getRepoInfo(repoRoot));
        if (!forge?.mergePR) return c.json({ error: 'GitHub merge is unavailable' }, 409);
        const result = await forge.mergePR(parsedNumber.data.number, body.data);
        if (result.merged) {
          // We just changed this pull request, so what the ref-status cache holds about it is now
          // known-stale — and its TTL would keep every chip showing the PRE-merge status for up to
          // a minute after the user watched this server merge it. Forget it; the next reader asks
          // the forge, gets `merged`, and then stops polling it at all.
          forgetRefStatus(repoRoot, parsedNumber.data.number);
          return c.json(result);
        }
        return c.json(
          {
            error: result.error,
            ...(result.code ? { code: result.code } : {}),
            ...(result.current ? { current: result.current } : {}),
          },
          result.status,
        );
      },
    )

    .get(
      '/github/prs/:number/changes',
      // Split out of one `safeParse` over both inputs, because a path param and the query string
      // are separate validation targets to Hono and only a split makes each visible to the route
      // type. Both keep the single 400 sentence the combined parse answered. `refresh` stays
      // STRICT here (`?refresh=true` is a 400 today, unlike everywhere else on this server).
      paramZodValidator(prChangesParams, { message: 'invalid pull request number or refresh flag' }),
      queryZodValidator(prChangesQuery, { message: 'invalid pull request number or refresh flag' }),
      async (c) => {
        const { root: repoRoot } = c.get('project');
        const parsed = { data: c.req.valid('param') };
        try {
          return c.json(
            await fetchGithubPrDiff(repoRoot, parsed.data.number, c.req.valid('query').refresh === '1'),
          );
        } catch (err) {
          if (err instanceof GithubPrNotFoundError) return c.json({ error: err.message }, 404);
          throw err;
        }
      },
    );

  // The full comment thread for one issue/PR (#499). Additive sibling of /api/github — lazy
  // (fetched only while a detail view is open), zod-validated params, 400 on garbage, and the
  // same in-payload availability degrade (gh missing / offline / 404 all render as a hint).
  const commentsParams = z.object({
    kind: z.enum(['issue', 'pr']),
    number: z.coerce.number().int().positive(),
  });
  const mergeBodySchema = z.object({
    method: z.enum(['merge', 'squash', 'rebase']),
    expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
    overrideRules: z.boolean().optional().default(false),
  }).strict();

  // ---- chained family: repo / git (project-scoped) ----
  const repoRoutes = new Hono<ProjectApiEnv>()
    .get('/repo', async (c) => {
      const { root: repoRoot } = c.get('project');
      const info = await getRepoInfo(repoRoot);
      if (!info)
        return c.json({
          info: null,
          status: [],
          log: [],
          branches: [],
          baseBranch: null,
        });
      const [status, log, branches, config] = await Promise.all([
        getStatus(info.root),
        getLog(info.root),
        getBranches(info.root),
        loadConfig(repoRoot),
      ]);
      return c.json({
        info,
        status,
        log,
        branches,
        baseBranch: config.baseBranch ?? null,
      });
    })

    .get('/repo/diff', async (c) => {
      const { root: repoRoot } = c.get('project');
      const info = await getRepoInfo(repoRoot);
      if (!info) return c.text('not a git repository');
      return c.text(await getDiff(info.root));
    })

    // One commit's message + stat + patch — the Repo view expands it inline.
    // `?structured=1` is the ADDITIVE sibling (R5 Step 1.7): the new repo view's commit-diff
    // shape `{sha, subject, author, when, files, stat}` with 409 + reason on failure. The
    // legacy text answer below is a protected surface (BACKWARD_COMPATIBILITY.md §2) — its
    // shape, including the in-band failure sentences, stays exactly as it was.
    //
    // `Accept: application/json` reaches the same structured answer without the flag, and
    // `Accept: text/plain` asks for the blob; the flag still wins whenever it is present, and a
    // request with no opinion still gets the blob. See `negotiate`.
    .get('/repo/commit/:sha', queryZodValidator(z.object({ structured: queryValue })), async (c) => {
      const { root: repoRoot } = c.get('project');
      c.header('vary', 'Accept');
      const { structured } = c.req.valid('query');
      const wantsJson =
        structured !== undefined
          ? structured === '1'
          : negotiate(c.req.header('accept'), COMMIT_FORMATS) === 'application/json';
      const info = await getRepoInfo(repoRoot);
      if (wantsJson) {
        if (!info) return c.json({ error: 'not a git repository' }, 409);
        const result = await collectCommitChanges(info.root, c.req.param('sha'));
        if (!result.ok) return c.json({ error: result.error }, 409);
        return c.json(result.commit);
      }
      if (!info) return c.text('not a git repository');
      try {
        return c.text(await getCommit(info.root, c.req.param('sha')));
      } catch (err) {
        return c.text(`(git show failed: ${err instanceof Error ? err.message : String(err)})`);
      }
    })

    // Structured sibling of the text-blob /api/repo/diff above (protected
    // surface, untouched): the same {files, stat} shape the session /changes
    // route serves, here for the MAIN working tree's uncommitted changes vs
    // HEAD (redesign R5 Step 1.3 — §"Git/session API additions").
    .get('/repo/changes', async (c) => {
      const { root: repoRoot } = c.get('project');
      const info = await getRepoInfo(repoRoot);
      if (!info) return c.json({ error: 'not a git repository' }, 409);
      // The user's REAL working tree — never stage into their index (a GET must not write).
      const result = await collectChanges(info.root, 'HEAD', {
        intentToAdd: false,
      });
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json(result.changes);
    })

    .post('/repo/branch', jsonZodValidator(() => repoBranchSchema), async (c) => {
      const { root: repoRoot } = c.get('project');
      const info = await getRepoInfo(repoRoot);
      if (!info) return c.json({ error: 'not a git repository' }, 409);
      const parsed = { data: c.req.valid('json') };
      const result = await createOrSwitchBranch(info.root, parsed.data.name, parsed.data.from);
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json({ branch: result.branch, created: result.created });
    });

  // The Settings → Agents knobs in one read (R6 Step 1.5) — an ADDITIVE
  // sibling of PUT /api/config below; /api/health keeps its protected shape.
  const configAnswer = async (repoRoot: string, config: CezConfig) => {
    const nativeModels = await readAgentModelDefaults(repoRoot);
    const modelsLocked = agentModelsLocked(repoRoot);
    return {
      baseBranch: config.baseBranch ?? null,
      defaultRunner: config.defaultRunner,
      systemPrompt: config.systemPrompt ?? null,
      // Native defaults seed each runner independently. A Cezar preset remains
      // selectable unless the operator opts into the fixed-model policy.
      defaultModels: modelsLocked
        ? nativeModels
        : { ...nativeModels, ...(config.defaultModels ?? {}) },
      modelsLocked,
      maxParallel: config.maxParallel,
      memoryLimitMb: config.memoryLimitMb ?? null,
      // Count-based worktree retention (#483): keep the last N finished worktrees
      // on disk. 0 = unlimited. Always materialized (schema default 10).
      worktreeRetention: config.worktreeRetention,
      // Live title updates (task auto-naming spec): tri-state — null means "no
      // config key, the CEZ_TITLE_UPDATES env default (ON) decides".
      liveTitleUpdates: config.liveTitleUpdates ?? null,
      // Optional review gate (#489): tri-state — null means "no config key, the
      // CEZ_REVIEW_GATE env default (OFF) decides".
      reviewGate: config.reviewGate ?? null,
    };
  };
  // ---- chained family: per-repo config (project-scoped) ----
  const configRoutes = new Hono<ProjectApiEnv>()
    .get('/config', async (c) => {
      const repoRoot = c.get('project').root;
      return c.json(await configAnswer(repoRoot, await loadConfig(repoRoot)));
    })

    .put('/config', jsonZodValidator(() => setConfigSchema), async (c) => {
      const { root: repoRoot, dataDir } = c.get('project');
      const parsed = { data: c.req.valid('json') };
      if (agentModelsLocked(repoRoot) && parsed.data.defaultModels !== undefined) {
        return c.json({ error: AGENT_MODELS_LOCKED_ERROR }, 409);
      }
      const configPath = join(dataDir, 'config.json');
      let raw: Record<string, unknown> = {};
      try {
        const existing: unknown = JSON.parse(await readFile(configPath, 'utf8'));
        if (existing && typeof existing === 'object') raw = existing as Record<string, unknown>;
      } catch {
        // missing or malformed — start fresh
      }
      if (parsed.data.baseBranch !== undefined) {
        if (parsed.data.baseBranch === null) delete raw.baseBranch;
        else raw.baseBranch = parsed.data.baseBranch;
      }
      if (parsed.data.defaultRunner !== undefined) raw.defaultRunner = parsed.data.defaultRunner;
      if (parsed.data.systemPrompt !== undefined) {
        // '' and null both clear: an emptied textarea means "no extra prompt".
        if (parsed.data.systemPrompt === null || parsed.data.systemPrompt === '') {
          delete raw.systemPrompt;
        } else {
          raw.systemPrompt = parsed.data.systemPrompt;
        }
      }
      if (parsed.data.maxParallel !== undefined) raw.maxParallel = parsed.data.maxParallel;
      if (parsed.data.worktreeRetention !== undefined) {
        // null clears back to the default (10); a number (including 0 = unlimited)
        // is stored as-is.
        if (parsed.data.worktreeRetention === null) delete raw.worktreeRetention;
        else raw.worktreeRetention = parsed.data.worktreeRetention;
      }
      if (parsed.data.liveTitleUpdates !== undefined) {
        if (parsed.data.liveTitleUpdates === null) delete raw.liveTitleUpdates;
        else raw.liveTitleUpdates = parsed.data.liveTitleUpdates;
      }
      if (parsed.data.reviewGate !== undefined) {
        if (parsed.data.reviewGate === null) delete raw.reviewGate;
        else raw.reviewGate = parsed.data.reviewGate;
      }
      if (parsed.data.memoryLimitMb !== undefined) {
        // null or 0 both mean "no ceiling" — drop the key back to the default.
        if (parsed.data.memoryLimitMb === null || parsed.data.memoryLimitMb === 0) {
          delete raw.memoryLimitMb;
        } else {
          raw.memoryLimitMb = parsed.data.memoryLimitMb;
        }
      }
      if (parsed.data.defaultModels !== undefined) {
        // Per-runner merge, so setting codex's preset never clobbers claude's.
        const current =
          raw.defaultModels && typeof raw.defaultModels === 'object'
            ? { ...(raw.defaultModels as Record<string, unknown>) }
            : {};
        for (const [runner, model] of Object.entries(parsed.data.defaultModels)) {
          if (model === undefined) continue;
          if (model === null || model === '') delete current[runner];
          else current[runner] = model;
        }
        if (Object.keys(current).length === 0) delete raw.defaultModels;
        else raw.defaultModels = current;
      }
      try {
        await mkdir(dataDir, { recursive: true });
        await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
      // Pre-R6 answer shape ({baseBranch, defaultRunner}) + additive R6 fields.
      return c.json(await configAnswer(repoRoot, await loadConfig(repoRoot)));
    });

  // Set/clear the agents' config knobs (Settings → Agents; the Repo tab's
  // base-branch picker). Merges into the RAW config.json so user keys
  // (skillsRepos…) survive and schema defaults are never materialized into
  // the file. All fields optional + additive: `null` (and `''` for the
  // R6 keys) clears a knob back to its default.
  const modelPresetSchema = z.string().trim().max(200).nullable().optional();
  const setConfigSchema = z.object({
    baseBranch: z.string().trim().min(1).max(200).nullable().optional(),
    defaultRunner: z.enum(RUNNER_IDS).optional(),
    systemPrompt: z.string().trim().max(20_000, 'must be at most 20000 characters').nullable().optional(),
    defaultModels: z
      .object({
        claude: modelPresetSchema,
        codex: modelPresetSchema,
        opencode: modelPresetSchema,
        pi: modelPresetSchema,
      })
      .optional(),
    // Concurrency + memory guard (Settings → Resources). maxParallel clamps to
    // the schema's 1–16; memoryLimitMb null/0 clears the ceiling.
    maxParallel: z.number().int().min(1).max(16).optional(),
    memoryLimitMb: z.number().int().min(0).max(1_048_576).nullable().optional(),
    // Worktree retention count (Settings → Resources, #483). 0 = unlimited;
    // null clears the key back to the schema default (10). Unlike memoryLimitMb,
    // 0 is a meaningful value (unlimited), so it is stored, not treated as clear.
    worktreeRetention: z.number().int().min(0).max(1000).nullable().optional(),
    // Live title updates toggle (Settings → Agents): null clears the key back
    // to the env-default behavior.
    liveTitleUpdates: z.boolean().nullable().optional(),
    // Optional review gate toggle (Settings → Agents, #489): null clears the key
    // back to the env-default behavior (OFF).
    reviewGate: z.boolean().nullable().optional(),
  });
  const setAgentConfigSchema = z.object({
    content: z.string().max(2_000_000),
    version: z.string().nullable(),
  });

  // ---- chained family: agent-config (project-scoped) -----------------------
  // Agent config is project-scoped (spec #404, adapted to the multi-project
  // route seam from #521): handlers resolve the selected repo through the
  // same ProjectContext as every other mirrored route. Chained (not statements)
  // so `AppType` carries it — see `healthRoutes`.
  const agentConfigRoutes = new Hono<ProjectApiEnv>()
    .get('/agent-config', async (c) => {
      const editable = capabilities().localHandoff;
      return c.json(await listAgentConfig(c.get('project').root, process.env, editable));
    })

    .get('/agent-config/:id', async (c) => {
      const id = c.req.param('id');
      const def = findConfigFile(id);
      if (!def) return c.json({ error: 'unknown config file' }, 404);
      if (def.tracked === 'outside-repo' && !capabilities().localHandoff) {
        return c.json(
          {
            error: 'this file lives in your home directory and is not served in hosted mode (CEZ_REMOTE)',
          },
          409,
        );
      }
      const read = await readConfigFile(id, c.get('project').root);
      if (read === null) return c.json({ error: 'unknown config file' }, 404);
      if ('error' in read) return c.json({ error: read.error }, 500);
      return c.json(read);
    })

    .put('/agent-config/:id', jsonZodValidator(setAgentConfigSchema), async (c) => {
      // Config files may define hooks and MCP commands, so writes remain a
      // local-machine capability and are re-gated on every request.
      if (!capabilities().localHandoff) {
        return c.json(
          {
            error:
              'editing agent config is disabled in hosted mode (CEZ_REMOTE) — edit it from the machine that owns the checkout',
          },
          409,
        );
      }
      const parsed = { data: c.req.valid('json') };
      const out = await writeConfigFile(
        c.req.param('id'),
        parsed.data.content,
        parsed.data.version,
        c.get('project').root,
      );
      if (out === null) return c.json({ error: 'unknown config file' }, 404);
      if (!out.ok) return c.json({ error: out.error }, out.status);
      return c.json(out.read);
    });

  // Repo view branch actions: switch to an existing branch, or create one
  // (from `from` or HEAD) and switch. Predictable git failures — invalid
  // name, unknown `from`, dirty-tree checkout conflict — are 409 + reason.
  const repoBranchSchema = z.object({
    name: z.string().trim().min(1).max(200),
    from: z.string().trim().min(1).max(200).optional(),
  });

  // ---- central-hub scaffold: five inert, flag-gated families ---------------
  // Each lives in its own file (`.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D6) and is built
  // by a factory rather than declared inline, so the wave-4 packages that fill them in touch only
  // their own file — never this one. `knowledgeRoutes`/`sourcesRoutes` are project-scoped (mounted
  // into `v1` below); `notesRoutes`/`workspaceRunsRoutes`/`notificationsRoutes` are workspace-level
  // (mounted into `workspaceV1`).
  const knowledgeRoutes = createKnowledgeRoutes();
  const sourcesRoutes = createSourcesRoutes();

  // ---- the notes pipeline (P2.2/P2.3) --------------------------------------
  // ONE store, shared by the routes and the pipeline. `NoteStore` caches the inbox in memory
  // after its first read, so two instances over one `notes.json` would each hold a stale half of
  // it — a note captured through the routes would be invisible to the pass that is supposed to
  // analyse it. Construction touches no filesystem, so building this under a disabled flag is
  // free.
  const noteStore = new NoteStore();
  const noteProcessor = new NoteProcessor({
    store: noteStore,
    coordinator: new NoteCoordinator({ listProjects, warn: (message) => console.warn(message) }),
    // The workspace-level index the context map already owns — same cache, one parse of each
    // project's `runs.json` rather than two.
    runIndex: contexts.runIndex,
    bootRoot: deps.repoRoot,
  });
  const noteApprover = new NoteApprover({
    store: noteStore,
    listProjects,
    // Approval is the one notes path that may build a project context: a person named this
    // repository and asked for a run in it, and building its context is what starting a run
    // there means. The triage pass is structurally barred from this (see `notes/processor.ts`).
    startRun: async (projectId, workflow, task, options) => {
      const ctx = await contexts.context(projectId);
      return ctx.manager.startRun(workflow, {
        task,
        ...options,
        // A spec run's next step is the explicit "start implementation" click on the note, so the
        // follow-up inbox would only duplicate a decision the page already presents.
        generateFollowups: false,
      });
    },
    warn: (message) => console.warn(message),
  });
  const notesRoutes = createNotesRoutes({
    store: noteStore,
    pipeline: {
      process: (noteId) => noteProcessor.process(noteId),
      approve: (noteId, input) => noteApprover.approve(noteId, input),
    },
  });
  // The autonomous implementation continuation trigger (PLAN D27 Phase 3, `.ai/specs/2026-08-15-
  // autonomous-implementation-continuation.md`). One `NoteContinuationTrigger` per project, bound
  // to that project's own root and manager — mirrors `noteApprover.startRun` above, reversed:
  // `notes/continuation.ts` has no import path to the run machinery, and `workflows/run.ts` has no
  // import path back into `notes/`; this is where the two directions meet. Subscribes to each
  // project's OWN `RunStore`'s `'run'` event (already public — no `RunManager` import needed to
  // observe it), so a note's spec run reaching `done` in ANY registered project is seen without
  // this file (or `notes/continuation.ts`) ever building a context that would not otherwise exist.
  const wireNoteContinuation = (ctx: ProjectContext): void => {
    const trigger = new NoteContinuationTrigger({
      store: noteStore,
      projectId: ctx.id,
      projectRoot: ctx.root,
      startRun: async (workflow, task, options) =>
        ctx.manager.startRun(workflow, {
          task,
          ...options,
          // Same reasoning as the spec run's own start above: the note's own "resulting tasks"
          // list is the follow-up surface for this pipeline, not the generic inbox.
          generateFollowups: false,
        }),
      warn: (message) => console.warn(message),
    });
    ctx.store.on('run', (run) => void trigger.onRunSettled(run));
  };
  wireNoteContinuation(bootContext);
  contexts.onContextBuilt(wireNoteContinuation);
  const workspaceRunsRoutes = createWorkspaceRunsRoutes();
  // The cross-project board's ROW ACTIONS, kept off `/p/:projectId` on purpose: that prefix's
  // `use('*')` scope resolver builds a context for whichever project the path names, and a build
  // prunes orphans, reclaims worktrees and recovers every interrupted run. `contexts` is passed
  // so the family can `peek` at an already-built store; it can never build one.
  // (`.ai/specs/2026-08-14-cross-project-run-mutations.md`.)
  const workspaceRunMutationRoutes = createWorkspaceRunMutationRoutes({ contexts });
  // The cross-project git overview (`.ai/specs/2026-08-14-cross-project-git-overview.md`):
  // same non-instantiating discipline as the two families above, own file, own index.
  const workspaceGitRoutes = createWorkspaceGitRoutes();
  // The cross-project knowledge read (`.ai/specs/2026-08-14-knowledge-domains-and-changelog.md`,
  // D5). Takes `contexts` for the same reason the run mutations do and with the same limit: it
  // `peek`s an already-built store and can never build one, because building recovers and resumes
  // that project's interrupted runs — and typing into a search box must not start agents.
  const workspaceKnowledgeRoutes = createWorkspaceKnowledgeRoutes({ contexts });
  // The cross-project todo board (D2 of the same spec, Phase 1): `readTodos()` (`../todos.ts`) is
  // already a plain fs reader keyed on a `dataDir` path, so this family needs no `contexts` seam
  // at all — it never builds or peeks a `ProjectContext`, only derives each registered project's
  // `<root>/.ai/cezar` the same way `WorkspaceRunIndex`/`WorkspaceKnowledgeIndex` derive theirs.
  const workspaceTodosRoutes = createWorkspaceTodosRoutes();
  // The composer's Workspace submit (`.ai/specs/2026-08-15-cross-project-workspace-run.md`): ONE
  // run, not scoped to any project, granted read/write in every registered project directory.
  //
  // Replaces `createTaskFanoutRoutes`, which answered this same submit by splitting the request
  // into N per-project todos — the mechanism the owner rejected ("i don't want to have task per
  // each project"). Deleted rather than left mounted: a dead path that still answers reads as
  // live to the next person here.
  //
  // Takes `bootContext` directly, never `contexts.context(id)`: the boot context already exists
  // in this process, so a workspace run builds nothing and resumes nothing. That is the same
  // justification `noteApprover.startRun` records for the one notes path allowed to build a
  // context — a person asked for a run, and starting one is what that means.
  const workspaceRunRoutes = createWorkspaceRunRoutes({
    bootProject: () => resolveBootProject(),
    bootRoot: deps.repoRoot,
    startRun: (workflow, input) => bootContext.manager.startRun(workflow, input),
    resolveWorkflow: resolveRunWorkflow,
    guard: guardRunStart,
  });
  const notificationsRoutes = createNotificationsRoutes();

  // ---- assemble the chained families --------------------------------------
  // Every chained family is registered ONCE and mounted into the versioned table. There is no
  // second, unversioned spelling: `/api/*` was removed once the whole API was reachable under
  // `/api/v1` (BACKWARD_COMPATIBILITY.md §2). One surface means one thing to keep working, and
  // it is the one the typed client describes.
  //
  // MOUNT ORDER IS REGISTRATION ORDER. Hono matches in the order routes were added, so each
  // family keeps its internal order and the families keep theirs relative to each other.
  //
  // Written as ONE chained expression because that is the only shape Hono can infer route types
  // from — it is what puts these routes in `AppType`, and so in the typed client.
  const v1 = new Hono<ProjectApiEnv>()
    .use('*', resolveProjectScope)
    .route('/', launchKeyRoutes)
    .route('/', skillsRoutes)
    .route('/', uiStateRoutes)
    .route('/', workflowsRoutes)
    .route('/', planRoutes)
    .route('/', automationsRoutes)
    .route('/', runsRoutes)
    .route('/', groupsRoutes)
    .route('/', openTargetsRoutes)
    .route('/', worktreesRoutes)
    .route('/', todosRoutes)
    .route('/', sseRoutes)
    .route('/', githubRoutes)
    .route('/', repoRoutes)
    .route('/', configRoutes)
    .route('/', agentConfigRoutes)
    .route('/', knowledgeRoutes)
    .route('/', sourcesRoutes);

  // ---- chained family: the cross-project run index (workspace-level) -------
  /**
   * How many runs each project may contribute, newest first. The index is a FINDER, not a
   * listing: past the newest couple of hundred per project you are looking for something the
   * project's own Tasks table answers better, and every extra row is a DOM node the palette's
   * filter walks on each keystroke. `truncated` names the projects this bit, so a consumer never
   * has to pretend the list is complete.
   */
  const RUNS_INDEX_PER_PROJECT = 200;

  /** `RunRecord` → the wire row. Optional keys are spread CONDITIONALLY: writing
   *  `titleSummary: run.titleSummary` types a key as always-present that `JSON.stringify` then
   *  drops when it is undefined, which is exactly the drift the parity guard fails on. */
  /**
   * Every number a run MENTIONS — a superset of what its chip will show.
   *
   * Deliberately not `taskReference()`'s rule: which of a run's references is displayed is the
   * cockpit's decision (#407, #526), and re-deriving it here would be a second rule that drifts
   * from the first. This feeds a CACHE READ, which costs nothing per number, so asking about one
   * the client will not paint is free and asking about one it will is the whole point.
   */
  const mentionedReferenceNumbers = (run: RunRecord): number[] => {
    const numbers: number[] = [];
    for (const url of [run.pullRequestUrl, run.referencedPullRequestUrl, run.referencedIssueUrl]) {
      const number = url ? refNumberFromUrl(url) : null;
      if (number !== null) numbers.push(number);
    }
    for (const number of [run.prNumber, run.issueNumber, run.markerRefs?.pr, run.markerRefs?.issue]) {
      if (typeof number === 'number' && Number.isInteger(number) && number > 0) numbers.push(number);
    }
    return numbers;
  };

  const runIndexEntry = (projectId: string, run: RunRecord): RunIndexEntry => {
    const usage = currentUsage(run.id);
    return {
    projectId,
    id: run.id,
    title: run.title,
    ...(run.titleSummary !== undefined ? { titleSummary: run.titleSummary } : {}),
    ...(run.titleOrigin !== undefined ? { titleOrigin: run.titleOrigin } : {}),
    status: run.status,
    ...(run.activity !== undefined ? { activity: run.activity } : {}),
    ...(run.stopReason !== undefined ? { stopReason: run.stopReason } : {}),
    createdAt: run.createdAt,
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    ...(run.seenAt !== undefined ? { seenAt: run.seenAt } : {}),
    archived: run.archived,
    ...(run.autoResumeAt !== undefined ? { autoResumeAt: run.autoResumeAt } : {}),
    workflow: run.workflow,
    ...(run.branch !== undefined ? { branch: run.branch } : {}),
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    // The tracker-reference inputs, verbatim — the cockpit's `taskReference()` owns the rule
    // that picks between them (see the schema's note).
    ...(run.pullRequestUrl !== undefined ? { pullRequestUrl: run.pullRequestUrl } : {}),
    ...(run.referencedPullRequestUrl !== undefined
      ? { referencedPullRequestUrl: run.referencedPullRequestUrl }
      : {}),
    ...(run.prNumber !== undefined ? { prNumber: run.prNumber } : {}),
    ...(run.issueNumber !== undefined ? { issueNumber: run.issueNumber } : {}),
    ...(run.referencedIssueUrl !== undefined ? { referencedIssueUrl: run.referencedIssueUrl } : {}),
    ...(run.markerRefs !== undefined ? { markerRefs: run.markerRefs } : {}),
    ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}),
    ...(run.peakRssBytes !== undefined ? { peakRssBytes: run.peakRssBytes } : {}),
    ...(run.peakProcCount !== undefined ? { peakProcCount: run.peakProcCount } : {}),
    // The live sample, on the same terms as `GET /runs`: process-wide sampler, so a
    // workspace-level answer can carry it for every project's runs at once.
    ...(usage ? { usage } : {}),
    };
  };

  /**
   * `GET /workspace/runs-index` — every registered project's recent tasks in one slim answer, so
   * ⌘K can find a task without knowing which project it lives in.
   *
   * Workspace-level and single-mount for the obvious reason: a project-scoped spelling of "all
   * projects" is a contradiction. The per-project source is chosen the same way the automation
   * coordinator's boot fan-out chooses it (`bootContext` for the boot project, `contexts.peek`
   * for anything this process already owns, disk otherwise) — and never `contexts.context()`,
   * which would build a context, prune worktrees and `recover()` running agents. Typing in a
   * search box must not resume work; see `runs/run-index.ts`.
   */
  const runsIndexRoutes = new Hono()
    .get('/workspace/runs-index', async (c) => {
      let projects: ProjectListEntry[] = [];
      try {
        const selector = capabilities().singleProject
          ? { projectId: await resolveBootProject() }
          : undefined;
        projects = await listProjects(selector);
      } catch {
        // unreadable workspace — an empty index, never a 500. The palette degrades to the
        // active project's own run list, which it holds either way.
      }
      const bootId = await resolveBootProject(projects);
      const runs: RunIndexEntry[] = [];
      const truncated: string[] = [];
      // Statuses the server already holds, shipped WITH the rows that carry the references. The
      // cockpit would otherwise ask for them a beat after the table paints — one round trip per
      // project, and a visible flash of un-coloured chips before it lands. Cache-only, so this
      // never touches `gh` and never slows the index down; anything cold stays absent and the
      // lazy `/github/ref-status` route fills it in.
      const referenceStatuses: RunsIndexResponse['referenceStatuses'] = {};
      for (const project of projects) {
        // No folder, no runs to read. `not-git` still has an `.ai/cezar` worth indexing.
        if (project.status === 'missing') continue;
        const owned = project.id === bootId ? bootContext : contexts.peek(project.id);
        // `listRuns()` already sorts newest-first; the disk reader returns file order, so both
        // paths get sorted below rather than trusting either.
        //
        // Archived runs are INCLUDED. The active project's rows reach the palette through
        // `GET /runs`, which has always carried them, and excluding them here would mean a task
        // is findable while you stand in its project and vanishes the moment you leave — the
        // exact asymmetry a cross-project finder exists to remove.
        const recent = (
          owned ? owned.store.listRuns() : readRunIndexFromDisk(join(project.root, '.ai/cezar'))
        ).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        if (recent.length > RUNS_INDEX_PER_PROJECT) truncated.push(project.id);
        const mentioned: number[] = [];
        for (const run of recent.slice(0, RUNS_INDEX_PER_PROJECT)) {
          runs.push(runIndexEntry(project.id, run));
          mentioned.push(...mentionedReferenceNumbers(run));
        }
        if (mentioned.length > 0) {
          const cached = readCachedRefStatuses(project.root, mentioned);
          // Only when something was actually warm. A project key holding two empty maps is noise
          // that every consumer would have to look past, and it would blur the one rule this
          // payload has: absent means nothing is known.
          if (Object.keys(cached.prs).length > 0 || Object.keys(cached.issues).length > 0) {
            referenceStatuses[project.id] = cached;
          }
        }
      }
      runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const body: RunsIndexResponse = {
        runs,
        perProjectLimit: RUNS_INDEX_PER_PROJECT,
        truncated,
        referenceStatuses,
      };
      return c.json(body);
    });

  // Workspace-level families answer for the whole workspace, so they are single-mount: never a
  // project-scoped spelling, which would be a second surface to protect with no consumer.
  const workspaceV1 = new Hono()
    .route('/', healthRoutes)
    .route('/', modelsRoutes)
    .route('/', providersRoutes)
    .route('/', projectsRoutes)
    .route('/', agentProfilesRoutes)
    .route('/', skillsUpdateRoutes)
    .route('/', workspaceConfigRoutes)
    .route('/', fsBrowseRoutes)
    .route('/', automationChecksRoutes)
    .route('/', runsIndexRoutes)
    .route('/', workspaceEventsRoutes)
    .route('/', notesRoutes)
    .route('/', workspaceRunsRoutes)
    .route('/', workspaceRunMutationRoutes)
    .route('/', workspaceGitRoutes)
    .route('/', workspaceKnowledgeRoutes)
    .route('/', workspaceTodosRoutes)
    .route('/', workspaceRunRoutes)
    .route('/', notificationsRoutes);

  // ---- mount ---------------------------------------------------------------
  // Scoped first, then the unscoped alias bound to the boot project. The paths are disjoint (no
  // route starts with `/p/`), so order between the two never decides a match — but the SPA
  // catch-all below must still come last. `route()` re-registers the sub-app's routes under
  // each prefix, handlers shared, internal order preserved.
  //
  // Workspace families mount LAST and that is load-bearing: mounting the project table also
  // mounts its `use('*')` scope resolver over the whole prefix, and Hono runs matched middleware
  // in registration order. `/health` in particular answers for the workspace, has no project to
  // resolve, and is the CORS-open discovery route — it must not sit behind the resolver.
  const routed = app
    .route(V1_SCOPED_PREFIX, v1)
    .route(V1_PREFIX, v1)
    .route(V1_PREFIX, workspaceV1);

  // ---- auth routes (D1/D9, mount point only — Phase 3 builds the router) ----
  // `/login`, `/auth/callback` and the rest of the OIDC/Google + onboarding flow are top-level
  // paths, not API ones (D5: org is which PROCESS answers, so it needs no `/api/v1` segment or
  // `/o/<org>` prefix). Mounted at root, before the SPA catch-all so it still wins; absent
  // whenever `CEZ_AUTH=none` (`deps.authRoutes` is only ever set by `serveCommand`'s auth
  // branch), which is what makes D1's "no login route registered" literally true rather than a
  // route that exists but 404s.
  if (deps.authRoutes) routed.route('/', deps.authRoutes);
  // Same mount, same guard coverage. **CORRECTED 2026-08-07 by D13: NOT the same `CEZ_AUTH=none`
  // ⇒ absent contract `authRoutes` above has.** `deps.onboardingRoutes` is also populated by D13's
  // local-mode branch on a loopback bind with `CEZ_AUTH` unset (`local-mode-boot.ts`, gated on
  // `isLocalOrgModeActive`, not on `CEZ_AUTH` naming a provider) — so this `if` DOES mount
  // `/auth/onboarding*`/`/auth/teams*` on the npm zero-config default now. See
  // `../auth/onboarding-routes.ts`'s own module doc comment for why these three routes are a
  // separate file rather than three more methods on that one.
  if (deps.onboardingRoutes) routed.route('/', deps.onboardingRoutes);
  // Same mount, same guard coverage, same `CEZ_AUTH=none` ⇒ absent contract as `authRoutes` above
  // — still accurate for invite routes: D13 leaves `inviteRoutes` unmounted locally (there is no
  // second local user to invite), so this stays populated only once `CEZ_AUTH` names a provider.
  // See `../auth/invite-routes.ts`'s own module doc comment for why these are a separate file too.
  if (deps.inviteRoutes) routed.route('/', deps.inviteRoutes);
  // Same mount, same guard coverage as `onboardingRoutes` above, not as `authRoutes`/`inviteRoutes`
  // — **CORRECTED 2026-08-07 by D13**, for the identical reason: `deps.teamRoutes` is also
  // populated by D13's local-mode branch on a loopback bind with `CEZ_AUTH` unset. See
  // `../auth/team-routes.ts`'s own module doc comment for why these are a separate file too.
  if (deps.teamRoutes) routed.route('/', deps.teamRoutes);

  // ---- SPA catch-all -------------------------------------------------------
  // Last, so every route above still wins. Any other GET gets the cockpit shell:
  // react-router owns the route map, including the 404, so `/tasks/:id/changes`
  // cold-loads and survives a refresh instead of 404ing. `/api/*` and the static
  // files above resolve to `passthrough` and fall through to Hono's own 404 —
  // an unknown API path must never answer with HTML.
  // Without a web/dist build this serves the built-in build-hint page (dev-only
  // state — the published tarball ships web/dist), never a 404.
  routed.get('*', (c) => serveCockpitShell(c) ?? c.notFound());

  return routed;
}

export function startServer(deps: ServerDeps, port: number): ServerType {
  const workspaceEvents = deps.workspaceEvents ?? new WorkspaceEventBus();
  const skillsUpdate = deps.skillsUpdate ?? new SkillsUpdateService({ invalidateCatalog: refreshTeamSkills });
  // The subscription hub rides the same HTTP server (one port, zero config):
  // createApp registers the topics, the `upgrade` hook below owns the socket.
  const socketHub = deps.socketHub ?? createSocketHub();
  const automationCoordinator = new AutomationCoordinator({ listProjects });
  const bootProjectId = deps.bootProjectId ?? 'default';
  const bootAutomationStore = automationCoordinator.store(bootProjectId, deps.repoRoot)!;
  const sharedContexts = deps.contexts ?? new ProjectContexts({
    listProjects,
    semaphore: deps.semaphore,
    automationStore: (projectId, root) => automationCoordinator.store(projectId, root)!,
  });
  // #801: GitHub automations are opt-in. Off, the flag must remove the BEHAVIOR and not merely
  // the UI — no scheduler, no GitHub polling, no launched runs — so every entry point into the
  // workspace scheduler below is gated on it. Read per call rather than captured, for the same
  // reason `capabilities()` is inside `createApp`: tests flip the variable between apps.
  const automationsEnabled = () => resolveCapabilities(process.env, deps.bindHost).automations;
  let rescheduleAutomations = () => {};
  const app = createApp({
    ...deps,
    contexts: sharedContexts,
    automationStore: bootAutomationStore,
    workspaceEvents,
    skillsUpdate,
    socketHub,
    automationsChanged: () => rescheduleAutomations(),
  });
  // SECURITY: default to loopback. This server executes agents locally and its endpoints are
  // same-origin-trusted (only /api/health is CORS-open); binding to a non-loopback host would
  // expose an agent-executing box to the network. `bindHost` exists only for a deliberate
  // hosted/VPS deployment (which also flips CEZ_REMOTE to gate the local-handoff endpoints) —
  // src/index.ts never passes it, so the loopback guarantee holds for the normal CLI.
  const server = serve({
    fetch: app.fetch,
    port,
    hostname: deps.bindHost ?? '127.0.0.1',
  });
  const coordinator = new SkillsUpdateCoordinator(skillsUpdate, async () =>
    effectiveSkillsAutoUpdate(await loadWorkspaceConfig()));
  const automationProjects = new Map<string, { root: string; owner: string; repo: string }>();
  const automationScheduler = new WorkspaceAutomationScheduler({
    coordinator: automationCoordinator,
    handle: (projectId, store) => {
      const project = automationProjects.get(projectId);
      if (!project) return undefined;
      return {
        projectId,
        owner: project.owner,
        repo: project.repo,
        store,
        poller: new GithubPoller(),
        onChange: (automationId, revision) =>
          workspaceEvents.emit('automation-change', { project: projectId, automationId, revision }),
        launch: async (definition, candidate, receiptId) => {
          const bootId = deps.bootProjectId ?? 'default';
          const context = projectId === bootId
            ? { root: deps.repoRoot, manager: deps.manager, store: deps.store }
            : await sharedContexts.context(projectId);
          return launchAutomationRun({
            root: context.root,
            manager: context.manager,
            store: context.store,
            definition,
            candidate,
            receiptId,
          });
        },
      };
    },
  });
  // The scheduler is inert until `start()` anyway (it constructs `stopped`), but the gate is
  // stated here rather than inherited from that detail: a definition saved while the flag is off
  // must not even ask the coordinator to refresh.
  rescheduleAutomations = () => {
    if (!automationsEnabled()) return;
    void automationScheduler.reschedule();
  };
  const unsubscribe = workspaceEvents.on((event, data) => {
    if (event === 'project-added') {
      const project = (data as { project?: { id?: unknown; root?: unknown; status?: unknown } }).project;
      if (project && typeof project.id === 'string' && typeof project.root === 'string' && project.status !== 'missing') {
        coordinator.add(project.id, project.root);
        void getRepoInfo(project.root).then((info) => {
          const parsed = parseRemote(info?.remote ?? '');
          if (parsed?.host === 'github.com') automationProjects.set(project.id as string, { root: project.root as string, owner: parsed.owner, repo: parsed.repo });
          return rescheduleAutomations();
        });
      }
    } else if (event === 'project-removed') {
      const id = (data as { id?: unknown }).id;
      if (typeof id === 'string') coordinator.remove(id);
      if (typeof id === 'string') {
        automationCoordinator.remove(id);
        automationProjects.delete(id);
        rescheduleAutomations();
      }
    }
  });
  server.once('listening', () => {
    void listProjects().then((projects) => {
      const all = projects.some((project) => project.root === deps.repoRoot)
        ? projects : [{ id: deps.bootProjectId ?? 'default', root: deps.repoRoot, status: 'ok' as const }, ...projects];
      coordinator.start(all);
      // #801: with automations off there is nothing to warm — no remote to resolve, no receipts
      // to reconcile, and above all no scheduler to start. The skills-update coordinator above is
      // a separate feature and starts either way.
      if (!automationsEnabled()) return;
      void Promise.all(all.map(async (project) => {
        const parsed = parseRemote((await getRepoInfo(project.root))?.remote ?? '');
        if (parsed?.host === 'github.com') automationProjects.set(project.id, { root: project.root, owner: parsed.owner, repo: parsed.repo });
        const automationStore = automationCoordinator.store(project.id, project.root);
        const runStore = project.id === (deps.bootProjectId ?? 'default')
          ? deps.store
          : sharedContexts.peek(project.id)?.store;
        if (automationStore && runStore) reconcileAutomationReceipts(automationStore, runStore);
      })).then(() => automationScheduler.start()).catch(() => undefined);
    }).catch(() => undefined);
  });
  server.once('close', () => { unsubscribe(); coordinator.stop(); automationScheduler.stop(); });
  socketHub.attach(server, (req) => verifyWsUpgrade(req, deps.bindHost, deps.sessionResolver));
  return server;
}

/**
 * The WebSocket twin of the `/api/*` request-origin guard (#426), applied
 * before the `/api/v1/ws` handshake. WebSocket is NOT subject to CORS — any web
 * page may open `ws://127.0.0.1:<port>/api/v1/ws` and, unlike a forced HTTP GET,
 * would get to READ what comes back — so this guard is load-bearing:
 *
 *   1. Host allowlist (local mode): a non-loopback Host is a DNS-rebound
 *      request; kill it before the handshake. Same anchored
 *      `isLoopbackHostHeader` rules as the HTTP guard.
 *   2. Origin check: browsers always attach `Origin` to a WS handshake. A
 *      same-authority Origin is the cockpit itself. A LOOPBACK origin with a
 *      loopback Host is also admitted — that is the `npm run dev` Vite proxy
 *      (`changeOrigin` rewrites Host, the browser's `localhost:5173` Origin
 *      survives). Unlike the HTTP write guard we cannot REQUIRE `Sec-Fetch-Site`
 *      here — Safari sends no `Sec-Fetch-*` at all and requiring it would lock
 *      the dev proxy out of it — but we do honor it when it is there: Chromium
 *      does send it on a WS handshake, and page JS cannot forge it (forbidden
 *      header name), so a cross-port attacker page announcing `same-site` is
 *      rejected on the browser that ships it while Safari/Firefox still fall
 *      back to the loopback rule. Best available, not fail-open.
 *      No Origin at all is a non-browser client — same stance as the HTTP guard.
 *
 * The loopback-origin fallback still admits, on a browser that sends no
 * `Sec-Fetch-Site`, a page served from ANOTHER loopback port. That is no longer
 * a caveat the caller must remember: the verdict carries a `trusted` flag, and
 * the hub only lets an UNtrusted connection subscribe to topics a publisher
 * marked `loopbackReadable`. `health` is flagged so (the CORS-open discovery
 * payload, #431); every other topic stays trusted-only by default, so a topic
 * carrying run or repo content is mechanically unreachable from a foreign local
 * page without any per-topic vigilance. A connection is `trusted` when it is
 * provably the cockpit itself: a same-authority Origin, a no-Origin native
 * client, or a dev proxy the browser vouches for via `Sec-Fetch-Site`.
 *
 * **Principal check (D6).** Duplicated here rather than shared with the HTTP `requirePrincipal`
 * middleware above because the upgrade is attached to the RAW http server (`startServer`, below),
 * never to Hono — `app.use('/api/*', requirePrincipal)` never runs for this path, which is
 * exactly why D6 calls this out as its own bypass-shaped gap. `sessionResolver` is the SAME
 * instance `requirePrincipal` uses (both threaded from `ServerDeps` by `serveCommand`'s one
 * `../auth/session.ts` import), so the two call sites can only drift in wiring, never in what
 * counts as a valid session.
 */
export function verifyWsUpgrade(req: IncomingMessage, bindHost?: string, sessionResolver?: SessionResolver): WsUpgradeVerdict {
  const host = req.headers.host;
  const hostName = hostnameOfHost(host);
  const hosted = !resolveCapabilities(process.env, bindHost).localHandoff;
  if (!hosted && !isLoopbackHostHeader(hostName)) return false;
  const auth = resolveAuthProvider(process.env);
  if (auth !== 'none') {
    // Same fail-closed stance as `requirePrincipal`: a missing resolver while auth is nominally
    // on is a boot-wiring bug, not "auth is actually off", and an unauthenticated upgrade is
    // refused outright rather than admitted at reduced trust — this is the negative control D6
    // asks for, exercising the socket itself rather than an HTTP route beside it.
    // Same two inputs as `requirePrincipal`'s own call above, read off the RAW `IncomingMessage`
    // headers this path gets instead of Hono's request (D10 — the org process's forwarded
    // principal must gate the socket too, or `CEZ_AUTH=supervisor` would refuse every upgrade
    // while admitting every HTTP request, which is a bypass in the opposite direction).
    const forwarded = readForwardedPrincipalHeaders((name) => {
      const value = req.headers[name];
      return Array.isArray(value) ? value[0] : value;
    });
    if (!sessionResolver || !sessionResolver.resolveFromCookieHeader(req.headers.cookie, forwarded)) return false;
  }
  const origin = req.headers.origin;
  if (origin === undefined) return { trusted: true }; // non-browser client — no Origin to spoof
  // Scheme-checked, like the HTTP guard's comparison: `authorityOfOrigin` is
  // null for anything that is not an http(s) URL, so the opaque `"null"` origin
  // of a sandboxed iframe AND a `ftp://127.0.0.1`-shaped one both stay out
  // rather than reaching the loopback test below on hostname alone.
  const originAuthority = authorityOfOrigin(origin);
  const originHost = hostnameOfOrigin(origin);
  if (originAuthority === null || !originHost) return false;
  if (originAuthority === authorityOfHost(host)) return { trusted: true }; // the cockpit itself
  // The dev-proxy fallback. An explicit `cross-site`/`same-site` is an attacker
  // page on another local port and is refused even though both ends are
  // loopback; anything else needs loopback on both ends to get in at all.
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin') return false;
  if (!isLoopbackHostHeader(originHost) || !isLoopbackHostHeader(hostName)) return false;
  // Loopback on both ends, admitted. If the browser vouches it is same-origin
  // (`Sec-Fetch-Site: same-origin`, unforgeable by page JS), this is the dev
  // proxy on Chromium → trust it. An ABSENT header is a browser that ships no
  // metadata (Safari/Firefox), where the dev proxy and a foreign local page are
  // indistinguishable: admit as UNTRUSTED so only `loopbackReadable` topics show.
  return { trusted: fetchSite === 'same-origin' };
}

/** The bare hostname of a `Host` header — see `normalizeHostname`. `''` when the
 *  header is absent, which no allowlist matches. */
function hostnameOfHost(host: string | undefined): string {
  return host ? normalizeHostname(host) : '';
}

/** The `hostname:port` authority of a `Host` header, e.g. `127.0.0.1:4321`.
 *
 *  The port is kept verbatim and is `''` when the header omits it — which is
 *  exactly when a browser also omits it from `Origin` (both drop the scheme's
 *  default port). That symmetry is what lets us compare the two without knowing
 *  our own scheme, which we cannot know behind a TLS-terminating proxy. */
function authorityOfHost(host: string | undefined): string {
  if (!host) return '';
  const port = host.match(/^\[[^\]]*\]:(\d+)$/)?.[1] ?? host.match(/^[^:]*:(\d+)$/)?.[1] ?? '';
  return `${normalizeHostname(host)}:${port}`;
}

/** The `hostname:port` authority of an `Origin` header, or `null` when it is not
 *  a parseable http(s) URL (the opaque `"null"` origin of a sandboxed iframe, a
 *  `file://` page). `URL.port` is `''` for a scheme's default port, matching
 *  `authorityOfHost`. */
function authorityOfOrigin(origin: string): string | null {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${normalizeHostname(u.hostname)}:${u.port}`;
  } catch {
    return null;
  }
}

/** The hostname of an `Origin` header, or `null` when it is not a parseable URL
 *  (e.g. the opaque `"null"` origin of a sandboxed iframe). Normalized through
 *  the same path as `hostnameOfHost` so the two compare equal for IPv6 and for
 *  trailing-dot FQDNs. */
function hostnameOfOrigin(origin: string): string | null {
  try {
    return normalizeHostname(new URL(origin).hostname);
  } catch {
    return null;
  }
}

/**
 * The session id shape every backend actually mints: UUIDs (claude/codex) and
 * the CLIs' own slug-ish ids. No character here is special to bash, AppleScript
 * OR cmd.exe, and a leading `-` is refused so the id can never be read as an
 * option by the CLI it is passed to (same dash-guard as `isSafeGitRef`, #431).
 * Bounded, like every other input that reaches a spawned process.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,199}$/;

/** True for session ids safe to splice into the take-over command (see above). */
export function isSafeSessionId(sessionId: string): boolean {
  return SAFE_SESSION_ID.test(sessionId);
}

/**
 * The CLI command that reopens a run's session for interactive take-over, per
 * backend. Legacy/undefined records default to Claude. Returns null when the id
 * is not a shape we recognise — callers degrade (no take-over) rather than
 * splice it into a shell.
 *
 * Validate, don't quote (#431): the session id is the only variable spliced
 * into the command string, and `openInTerminal` runs that string through bash
 * on darwin/linux but through `cmd /K` on win32. cmd.exe does not treat `'` as
 * a quote character, so POSIX-quoting the id handed Windows users a literal
 * `claude --resume '9f8e…'` and Claude answered "no conversation found".
 * Constraining the charset to one with no metacharacter in ANY of those shells
 * needs no quoting at all and fails closed on an unexpected id — a stronger
 * guarantee than escaping, and platform-independent. Ids are UUID/CLI-minted
 * today; this keeps a future source safe.
 */
export function resumeCommand(runner: string | undefined, sessionId: string): string | null {
  if (!isSafeSessionId(sessionId)) return null;
  switch (runner) {
    case 'codex':
      return `codex resume ${sessionId}`;
    case 'opencode':
      return `opencode --session ${sessionId}`;
    case 'pi':
      return `pi --session ${sessionId}`;
    default:
      return `claude --resume ${sessionId}`;
  }
}
