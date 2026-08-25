import { DEFAULT_AGENT_ACCOUNT_ID, parseAgentRoute, type AgentRoute } from '@loki-labs/better-cezar-contract';
import type {
  ProviderId,
  ProviderStatusResponse,
} from '../core/provider-auth.ts';
import { PROVIDER_IDS } from '../core/provider-auth.ts';
import type { RunRecord } from '../runs/store.ts';
import { stepKind, type WorkflowDef } from '../workflows/types.ts';
import { selectionFor, type AgentAccountStore } from '../workspace/agent-accounts.ts';
import type { DispatchRequirement, Viability } from '../workspace/account-viability.ts';

const ORDER: readonly ProviderId[] = PROVIDER_IDS;
const LABEL: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'pi',
};

export function providersRequiredByWorkflow(
  workflow: WorkflowDef,
  fallback: ProviderId,
): ProviderId[] {
  const required = new Set<ProviderId>();
  for (const step of workflow.steps) {
    if (stepKind(step) === 'agent') required.add(step.runner ?? fallback);
  }
  return ORDER.filter((provider) => required.has(provider));
}

export function providerForExistingRun(
  run: RunRecord,
  override?: ProviderId,
): ProviderId {
  if (override) return override;
  return run.runner ?? 'claude';
}

/** The provider that owns a currently live session, when the record is attributed. */
export function providerForActiveRun(run: RunRecord): ProviderId {
  const current = run.currentStepId
    ? run.steps.find((step) => step.id === run.currentStepId)
    : undefined;
  if (current?.backend) return current.backend;

  // `execute()` persists the task backend before it starts a step. This is the
  // conservative fallback for older records whose current step lacks affinity.
  if (run.runner) return run.runner;

  // Pre-affinity records can still carry a prior attributed session. It is a
  // better fallback than guessing Claude, but never outranks the live step or
  // the run's current runner.
  for (let index = run.steps.length - 1; index >= 0; index -= 1) {
    const backend = run.steps[index]?.backend;
    if (backend) return backend;
  }
  return 'claude';
}

export function unavailableProviderMessage(
  required: readonly ProviderId[],
  response: ProviderStatusResponse,
): string | null {
  for (const provider of required) {
    const row = response.providers.find(({ provider: id }) => id === provider);
    if (row?.enabled === false) {
      return `${LABEL[provider]} is disabled. Enable it in Settings → Agents → Providers.`;
    }
    if (row?.status !== 'connected') {
      return `${LABEL[provider]} credentials are unavailable. Authorize it in Settings → Agents → Providers.`;
    }
  }
  return null;
}

/**
 * Whether any of `pinned`'s providers is DISABLED — a settings fact, not a credentials one, and
 * terminal regardless of what else in the workspace is authorized ("Explicitly out of scope":
 * rerouting away from a disabled provider is not this spec's job). `providerActionError`
 * (`server.ts`) already has this check inline as its first rung; this is the SAME check, exported
 * so the headless preflight (`index.ts`, site 10) — which has no `poolHasConnectedAccount`/cheap-
 * connected rungs behind it and goes straight to `assessAccountViability` — does not silently
 * reroute a task off a provider the user switched off.
 */
export function disabledProviderMessage(
  pinned: readonly ProviderId[],
  response: ProviderStatusResponse,
): string | null {
  const disabled = pinned.find((provider) =>
    response.providers.find((row) => row.provider === provider)?.enabled === false);
  return disabled ? `${LABEL[disabled]} is disabled. Enable it in Settings → Agents → Providers.` : null;
}

// ---- the three NEW terminal messages, `.ai/specs/2026-08-25-logged-out-account-fallback.md` ----
//
// `unavailableProviderMessage` above answers "is the first required provider's DEFAULT row
// connected?" and stays exactly as it is — it is still what the two pinned sites (Terminal,
// Open-in-CLI) and the untouched `/plan` gate use, byte-identically. These three answer a
// different, wider question — "could ANY account this action is allowed to use run it?" — for
// every REROUTABLE site, and there are three of them because `placeable === false` has three
// genuinely different causes (Solution 2's own "the terminal case is THREE cases" section) and
// naming the wrong one is a new lie replacing an old one.

/** Nothing enabled and connected anywhere, on any provider, capable or not. */
export const NO_PROVIDER_AUTHORIZED_MESSAGE =
  'No agent provider is authorized. Connect one in Settings → Agents → Providers.';

/** Something IS connected, but only a provider that cannot carry an account (OpenCode, pi) — so no
 *  account fallback could ever rescue this dispatch, and the message must not pretend one might. */
export function noEligibleFallbackMessage(provider: ProviderId): string {
  return `${LABEL[provider]} credentials are unavailable, and no account cezar can move this to is authorized. Authorize it in Settings → Agents → Providers.`;
}

/** An eligible connected account exists SOMEWHERE, but not inside this dispatch's own candidate
 *  set: an explicit route with fallback off, or a mixed-provider workflow whose pinned step has
 *  nowhere to go even with fallback on. */
export function fallbackOffMessage(provider: ProviderId): string {
  return `${LABEL[provider]} credentials are unavailable, and account fallback is off. Authorize it in Settings → Agents → Providers, or turn on Account fallback in Settings → Resources.`;
}

/**
 * Picks between the three messages above from an unplaceable `Viability` — `viability.blocked[0]`
 * names the provider, `PROVIDER_IDS`-ordered, the way `<Provider>` is decided everywhere in this
 * spec ("Message copy, decided"), which is a correction over the first `required` entry
 * `unavailableProviderMessage` picks: that can name a provider that was perfectly fine when a
 * later pinned requirement is the one with nowhere to go.
 */
export function viabilityRefusalMessage(viability: Viability): string {
  if (!viability.anyConnectedAnywhere) return NO_PROVIDER_AUTHORIZED_MESSAGE;
  const provider = viability.blocked[0];
  // Defensive only: a `blocked` provider always exists once `anyConnectedAnywhere` is true and
  // `placeable` is false — see `assessAccountViability`'s own reasoning for why a provider-less
  // (wildcard pool) requirement can never be the SOLE unplaceable one while something eligible is
  // connected (its own candidate set already covers every eligible account).
  if (provider === undefined) return NO_PROVIDER_AUTHORIZED_MESSAGE;
  return viability.anyEligibleConnected ? fallbackOffMessage(provider) : noEligibleFallbackMessage(provider);
}

// ---- requirement construction, shared by every call site that starts or resumes a run ----
//
// `DispatchRequirement`s are built HERE, beside `providersRequiredByWorkflow`, rather than inside
// the gate itself: only the call site knows which expression the picker it is about to invoke will
// actually read (a composer override, a retarget target, a recorded session's account), and a
// helper that recomputed it from the project's stored route alone would answer a different
// question from the one dispatch is about to ask (Architecture, "the call sites build the
// requirements, because only they know them").

/** The provider a RUN-LEVEL route actually implies. `undefined` only for the wildcard `pool:*`,
 *  where the candidate set legitimately crosses providers — never the workflow's own runner, which
 *  is the substitution that reproduces the reported bug (Architecture, "why site 1 is NOT one
 *  provider-pinned requirement per `providersRequiredByWorkflow` entry"). */
function runLevelProvider(
  route: AgentRoute,
  fallback: ProviderId,
  accounts: Pick<AgentAccountStore, 'accounts'>,
): ProviderId | undefined {
  if (route.kind === 'pool') return route.provider;
  if (route.accountId === DEFAULT_AGENT_ACCOUNT_ID) return fallback;
  // An unknown id degrades to the pinned provider's default, mirroring `selectProfile`'s own
  // degrade — the account this dispatch would actually land on if nothing else moved it.
  return accounts.accounts.find((a) => a.id === route.accountId)?.provider ?? fallback;
}

export interface WorkflowRunRequirementsInput {
  workflow: WorkflowDef;
  accounts: Pick<AgentAccountStore, 'accounts' | 'selections' | 'defaults'>;
  repoRoot: string;
  /** `body.runner ?? config.defaultRunner` — what `guardRunStart` already computes today, and the
   *  third argument `selectionFor` reads when nothing overrides it. */
  fallback: ProviderId;
  /** `body.agentProfile` — read FIRST, exactly as `resolvePoolForDispatch` reads
   *  `options.agentProfile ?? selectionFor(...)` (`agent-route-select.ts:263-265`). */
  overrideAgentProfile: string | undefined;
  fallbackAcrossAccountsWhenLimited: boolean;
}

/**
 * The run-level requirement plus one per EXPLICITLY PINNED workflow step, mirroring exactly what
 * `resolvePoolForDispatch` (run level) and `resolvePoolForProvider` (a pinned step) will each
 * resolve — Architecture's call-site table, row 1 (also rows 8/9: the todo-start route and
 * headless `cezar run` share this construction verbatim). `[]` when the workflow has no agent step
 * at all, matching `providersRequiredByWorkflow`'s own empty answer in that case: a shell-only
 * workflow dispatches nothing, so nothing needs to be viable.
 */
export function requirementsForWorkflowRun(input: WorkflowRunRequirementsInput): DispatchRequirement[] {
  const { workflow, accounts, repoRoot, fallback, overrideAgentProfile, fallbackAcrossAccountsWhenLimited } = input;
  if (!workflow.steps.some((step) => stepKind(step) === 'agent')) return [];
  const runRoute = parseAgentRoute(overrideAgentProfile ?? selectionFor(accounts, repoRoot, fallback));
  const requirements: DispatchRequirement[] = [
    {
      provider: runLevelProvider(runRoute, fallback, accounts),
      route: runRoute,
      reroutable: runRoute.kind === 'pool' ? true : fallbackAcrossAccountsWhenLimited,
    },
  ];
  const pinned = new Set<ProviderId>();
  for (const step of workflow.steps) {
    if (stepKind(step) !== 'agent' || step.runner === undefined || pinned.has(step.runner)) continue;
    pinned.add(step.runner);
    // `resolvePoolForProvider`'s own expression — NEVER the run's override, which a pin must not
    // inherit (Architecture, "Pinned steps DO keep a provider, and take their route from a
    // different expression").
    const stepRoute = parseAgentRoute(selectionFor(accounts, repoRoot, step.runner));
    requirements.push({
      provider: step.runner,
      route: stepRoute,
      reroutable: stepRoute.kind === 'pool' ? true : fallbackAcrossAccountsWhenLimited,
    });
  }
  return requirements;
}

/** The `DispatchRequirement` for an action against an EXISTING run's own session/account — sites
 *  3b (the reopen branch of `/runs/:id/messages`) and 4 (`/runs/:id/continue`). The route is the
 *  account that owns the run's last session, exactly what `runContinuation`'s own reroute resolves
 *  (`run.ts:4322-4340`); `overrideProvider` is a runner override on `/continue`, when given. */
export function requirementForExistingRun(
  run: RunRecord,
  overrideProvider: ProviderId | undefined,
  fallbackAcrossAccountsWhenLimited: boolean,
): DispatchRequirement {
  const sessionStep = [...run.steps].reverse().find((step) => step.sessionId);
  const route = parseAgentRoute(sessionStep?.profileId ?? run.agentProfile);
  return {
    provider: providerForExistingRun(run, overrideProvider),
    route,
    reroutable: route.kind === 'pool' ? true : fallbackAcrossAccountsWhenLimited,
  };
}

/** The `DispatchRequirement` for site 5, "Run on…" (`POST /runs/:id/agent`). The route is the
 *  RETARGET's own target, not the record's own session — `retargetQueuedRun` writes
 *  `target.agentProfile` onto the record BEFORE dispatch (`run.ts:2106`), so the record's
 *  `agentProfile` at gate time is stale for this one site. */
export function requirementForRetarget(
  run: RunRecord,
  target: { runner?: ProviderId; agentProfile?: string },
  fallbackAcrossAccountsWhenLimited: boolean,
): DispatchRequirement {
  const route = parseAgentRoute(target.agentProfile ?? run.agentProfile);
  return {
    provider: providerForExistingRun(run, target.runner),
    route,
    reroutable: route.kind === 'pool' ? true : fallbackAcrossAccountsWhenLimited,
  };
}

/**
 * The `DispatchRequirement` for `/plan` (site 2, Solution 4b/Phase 5). `planChain` has no
 * `RunManager` behind it, so this is not one of the sites `providerActionError` gates — see the
 * route itself, which gates on `viability.requirements[0].runnable`, not `placeable`, and
 * {@link plannerRefusalMessage}, which answers the refusal for that narrower question. The route
 * is `config.defaultRunner`'s own project-level selection — exactly what `planChain` resolves via
 * `resolveProfileEnvForRoot(repoRoot, config.defaultRunner)` today (Architecture's call-site
 * table, row 2).
 */
export function requirementForPlanner(
  defaultRunner: ProviderId,
  accounts: Pick<AgentAccountStore, 'accounts' | 'selections' | 'defaults'>,
  repoRoot: string,
  fallbackAcrossAccountsWhenLimited: boolean,
): DispatchRequirement {
  const route = parseAgentRoute(selectionFor(accounts, repoRoot, defaultRunner));
  return {
    provider: defaultRunner,
    route,
    reroutable: route.kind === 'pool' ? true : fallbackAcrossAccountsWhenLimited,
  };
}

/**
 * The refusal message for `/plan`, which gates on `viability.requirements[0].runnable.length > 0`
 * rather than `placeable` (Solution 4b) — a `waitable`-only workspace IS `placeable` (there is
 * something a RUN could be held on), but a plan has no hold path, so it must refuse anyway.
 * Reusing {@link viabilityRefusalMessage} here would read `viability.blocked`, which is empty for
 * a requirement that IS placeable, and would misreport "No agent provider is authorized" even
 * though something is connected. So this keys off the planner's own single requirement directly,
 * applying the SAME three-message rule (Solution 2, "the terminal case is THREE cases").
 */
export function plannerRefusalMessage(viability: Viability): string {
  if (!viability.anyConnectedAnywhere) return NO_PROVIDER_AUTHORIZED_MESSAGE;
  const provider = viability.requirements[0]?.requirement.provider;
  if (provider === undefined) return NO_PROVIDER_AUTHORIZED_MESSAGE;
  return viability.anyEligibleConnected ? fallbackOffMessage(provider) : noEligibleFallbackMessage(provider);
}
