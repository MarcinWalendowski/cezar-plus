import { useMutation, useQueryClient } from '@tanstack/react-query'
import { BotIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { putConfig, putWorkspaceConfig } from '@/api/client'
import {
  queryKeys,
  useAgentProfiles,
  useConfig,
  useHealth,
  useProjects,
  useProviderStatus,
  useRepo,
  useRunnerModelCatalogs,
  useSelectAgentProfile,
  useWorkspaceConfig,
  workspaceQueryKeys,
} from '@/api/queries'
import { useProjectScope } from '@/api/project-scope-context'
import type {
  ConfigResponse,
  Runner,
  SetConfigInput,
  SetWorkspaceConfigInput,
  WorkspaceConfigResponse,
} from '@loki-labs/better-cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { providerStatusFor } from '@/lib/provider-status'
import {
  DefaultAgentPicker,
  agentPickerRows,
  hasAgentAccounts,
} from '@/components/default-agent-picker'
import { modelCatalogStatus, modelsForRunner, RUNNERS } from '@/routes/new-task-form'
import { useSaveTargetLabel, useSettingsProject } from './settings-project'

/**
 * Settings → Agents (R6 Step 1.5, spec §"Settings"): today's scattered `PUT /api/config` knobs
 * in one place — default runner, per-runner model presets, THE system prompt (this is its
 * single edit surface: the /new composer intentionally has none, user decision in R4), and the
 * base branch (also settable from the Git view's branch picker; both write the same key).
 *
 * Copy stays coding-agent-agnostic by rule: the section describes capabilities (`runner`,
 * `model`, `system prompt`), never vendor config formats.
 *
 * Persistence: every control PUTs a partial patch; the server merges it into the raw
 * config.json so user keys survive. The PUT answers the full knob shape, which lands straight
 * in the `config` query — the readback is the server's own truth, not an optimistic guess.
 *
 * **Two tiers since `.ai/specs/2026-08-21-one-settings-area.md`.** Settings is one area now and
 * this section carries a project selector, so it renders one of two forms:
 *  - *All projects* → the MACHINE tier, `projectDefaults` in `~/.cezar/config.json`, written
 *    through `PUT /api/v1/workspace/config`. Only the four knobs that have a machine tier appear;
 *    a repo's own value still wins over every one of them.
 *  - a project → that repo's `.ai/cezar/config.json`, exactly as before, with each of those four
 *    knobs labelled **Overridden** (this repo sets it) or **Inherited** (the machine's answer is
 *    showing through) from `GET /api/v1/config`'s `overridden`/`inherited`.
 *
 * `Providers` used to render at the top of this pane and does not any more (spec Phase 2): its
 * switch writes `disabledProviders` in the WORKSPACE config, so a host-wide toggle was reachable
 * only through one arbitrary project's URL. It is its own section at `/settings/providers`.
 */

/** The server's validation cap for the system prompt (src/config.ts) — enforced here too so an
 *  over-limit draft is a disabled Save with a reason, not a 400 round-trip. */
const SYSTEM_PROMPT_MAX = 20_000

export function AgentsSection() {
  const { projectId } = useSettingsProject()
  // Hooks run unconditionally; only the RENDER branches. `useConfig` is scope-aware and the shell
  // mounts no scope provider for *All projects*, so with no project it would read the boot repo's
  // config — which is exactly the wrong answer to show under a header that says "All projects".
  return projectId === null ? <MachineTierForm /> : <ProjectAgentsSection />
}

/**
 * *All projects*: the four knobs that have a machine tier, and honest pointers for the ones that
 * do not. `baseBranch` is deliberately absent (a branch belongs to a repository, not to a person)
 * and so is the default runner/models pair, which already has a machine-tier editor of its own in
 * Agent accounts → "Defaults for new projects" — two editors over one file key is how they drift.
 */
function MachineTierForm() {
  const queryClient = useQueryClient()
  const config = useWorkspaceConfig()
  const save = useMutation({
    mutationFn: (patch: SetWorkspaceConfigInput) => putWorkspaceConfig(patch),
    onSuccess: (result) => {
      queryClient.setQueryData(workspaceQueryKeys.config, result)
      // Every project that does NOT set its own value just changed effective behaviour, and the
      // per-repo `config` queries hold the folded answer.
      void queryClient.invalidateQueries({ queryKey: queryKeys.config })
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  if (config.isPending) {
    return (
      <p data-slot="agents-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading agent settings…
      </p>
    )
  }
  if (config.isError) {
    return (
      <CenteredState
        icon={<BotIcon />}
        tone="danger"
        title="Agent settings did not load"
        subtitle={config.error.message}
        heading="h2"
      />
    )
  }
  return <MachineTierFields defaults={config.data.projectDefaults} save={save} />
}

function MachineTierFields({
  defaults,
  save,
}: {
  defaults: WorkspaceConfigResponse['projectDefaults']
  save: ReturnType<typeof useMutation<WorkspaceConfigResponse, Error, SetWorkspaceConfigInput>>
}) {
  const [prompt, setPrompt] = useState(defaults.systemPrompt ?? '')
  const trimmedPrompt = prompt.trim()
  const promptSaved = trimmedPrompt === (defaults.systemPrompt ?? '')
  const promptOverLimit = trimmedPrompt.length > SYSTEM_PROMPT_MAX

  return (
    <div
      data-slot="agents-section"
      data-tier="machine"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <p data-slot="agents-tier-note" className="text-[13px] text-muted-foreground">
        These are this machine’s answers, stored in <code className="font-mono">~/.cezar</code> and
        used by every project that has not set its own. A project that HAS set one always wins —
        pick it in the selector above to see or change it.
      </p>

      <Field
        title="System prompt"
        hint="Extra instructions appended to every run in every project, whichever runner executes it."
      >
        <Textarea
          aria-label="System prompt"
          data-slot="agents-system-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Extra rules for every agent run — conventions, tone, review requirements…"
          className="min-h-32 max-w-xl"
        />
        <div className="flex max-w-xl items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-action="agents-save-prompt"
            disabled={promptSaved || promptOverLimit || save.isPending}
            onClick={() =>
              save.mutate(
                { projectDefaults: { systemPrompt: trimmedPrompt === '' ? null : trimmedPrompt } },
                {
                  onSuccess: () =>
                    toast(
                      trimmedPrompt === ''
                        ? 'System prompt cleared for all projects'
                        : 'System prompt saved for all projects',
                    ),
                },
              )
            }
          >
            Save for all projects
          </Button>
          {promptOverLimit ? (
            <p data-slot="agents-prompt-limit" className="text-[11px] text-danger">
              {trimmedPrompt.length.toLocaleString()} characters — the limit is{' '}
              {SYSTEM_PROMPT_MAX.toLocaleString()}.
            </p>
          ) : (
            <p className="text-[11px] text-soft-foreground">
              Leave empty and save to clear. Applied to new runs only.
            </p>
          )}
        </div>
      </Field>

      <Field
        title="Live title updates"
        hint="Refresh a task's short title through the namer model as the run progresses. A manual rename always wins and stops updates for that task."
      >
        <TierSwitch
          label="Live title updates"
          slot="agents-live-title-updates"
          value={defaults.liveTitleUpdates}
          fallback
          disabled={save.isPending}
          onChange={(next) =>
            save.mutate(
              { projectDefaults: { liveTitleUpdates: next } },
              { onSuccess: () => toast(TIER_TOAST('Live title updates', next)) },
            )
          }
        />
      </Field>

      <Field
        title="Review changes before finishing"
        hint="When on, a task with changes pauses so you can Accept, Send back, or open a Draft PR. Autonomous tasks always skip this and finish on their own. Default: off — tasks finish without asking."
      >
        <TierSwitch
          label="Review changes before finishing"
          slot="agents-review-gate"
          value={defaults.reviewGate}
          fallback={false}
          disabled={save.isPending}
          onChange={(next) =>
            save.mutate(
              { projectDefaults: { reviewGate: next } },
              { onSuccess: () => toast(TIER_TOAST('Review gate', next)) },
            )
          }
        />
      </Field>

      <Field
        title="Base branch, default runner and models"
        hint="Not here, and deliberately so."
      >
        <p className="max-w-xl text-[13px] text-muted-foreground">
          A base branch is a property of a repository, not of a person — pick a project above to set
          it. The default runner and per-runner models for projects that have chosen none live in{' '}
          <strong className="font-medium text-foreground">Agent accounts</strong>, beside the
          accounts they select.
        </p>
      </Field>
    </div>
  )
}

/** A tri-state machine-tier switch: on / off / not set. `fallback` is what an unset value means
 *  at runtime, so the row can say "(default)" honestly instead of implying a choice. */
function TierSwitch({
  label,
  slot,
  value,
  fallback,
  disabled,
  onChange,
}: {
  label: string
  slot: string
  value: boolean | null
  fallback: boolean
  disabled: boolean
  onChange: (next: boolean | null) => void
}) {
  const effective = value ?? fallback
  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex w-fit items-center gap-3">
        <Switch
          aria-label={label}
          data-slot={slot}
          checked={effective}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(checked)}
        />
        <span className="text-[13px] text-muted-foreground">
          {effective ? 'On' : 'Off'}
          {value === null && ' (default)'}
        </span>
      </label>
      {value === null ? null : (
        <button
          type="button"
          data-action={`${slot}-clear`}
          disabled={disabled}
          onClick={() => onChange(null)}
          className="text-[11px] font-medium text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground disabled:opacity-50"
        >
          Use the built-in default
        </button>
      )}
    </div>
  )
}

const TIER_TOAST = (what: string, next: boolean | null) =>
  next === null ? `${what} back to the default for all projects` : `${what} ${next ? 'on' : 'off'} for all projects`

function ProjectAgentsSection() {
  const config = useConfig()
  // One row per runner here, so every runner's own host catalog is needed at once (#794) —
  // unlike the composer, which only ever renders the runner the user picked.
  const catalogs = useRunnerModelCatalogs()
  const providerStatus = useProviderStatus()

  if (config.isPending) {
    return (
      <p data-slot="agents-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading agent settings…
      </p>
    )
  }
  if (config.isError) {
    return (
      <CenteredState
        icon={<BotIcon />}
        tone="danger"
        title="Agent settings did not load"
        subtitle={config.error.message}
        heading="h2"
      />
    )
  }
  return <AgentsForm config={config.data} catalogs={catalogs} providerStatus={providerStatus} />
}

function AgentsForm({
  config,
  catalogs,
  providerStatus,
}: {
  config: ConfigResponse
  catalogs: ReturnType<typeof useRunnerModelCatalogs>
  providerStatus: ReturnType<typeof useProviderStatus>
}) {
  const repo = useRepo()
  const queryClient = useQueryClient()
  // What the Save button names. One page edits two tiers now, so a control that just said "Save"
  // would be the single easiest way to write the wrong file (spec §Risks 2).
  const saveTarget = useSaveTargetLabel()

  const save = useMutation({
    mutationFn: (patch: SetConfigInput) => putConfig(patch),
    onSuccess: (result) => {
      // The PUT already answers the merged knobs — no refetch needed for this section. The
      // same knobs surface elsewhere though: defaultRunner in /api/health, baseBranch in
      // /api/repo — refresh both so the composer and the Git view agree immediately.
      queryClient.setQueryData(queryKeys.config, result)
      void queryClient.invalidateQueries({ queryKey: queryKeys.health })
      void queryClient.invalidateQueries({ queryKey: queryKeys.repo })
    },
    // 400/409/500 alike: the server's own words, verbatim (the repo-wide error doctrine).
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  // The system prompt edits locally and saves explicitly — a textarea that PUT-ed 20k
  // characters on every keystroke would be a worse control, not a simpler one.
  const [prompt, setPrompt] = useState(config.systemPrompt ?? '')
  const trimmedPrompt = prompt.trim()
  const promptSaved = trimmedPrompt === (config.systemPrompt ?? '')
  const promptOverLimit = trimmedPrompt.length > SYSTEM_PROMPT_MAX
  const savePrompt = () =>
    save.mutate(
      { systemPrompt: trimmedPrompt === '' ? null : trimmedPrompt },
      {
        onSuccess: () =>
          toast(trimmedPrompt === '' ? 'System prompt cleared' : 'System prompt saved'),
      },
    )

  return (
    <div
      data-slot="agents-section"
      data-tier="project"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      {/* `ProviderSettings` used to render here. It writes WORKSPACE state (`disabledProviders`),
          so it is its own section at `/settings/providers` now — spec Phase 2. */}
      <DefaultAgentField
        defaultRunner={config.defaultRunner}
        providerStatus={providerStatus}
        saving={save.isPending}
        onPick={(runner) => save.mutate({ defaultRunner: runner })}
      />

      <Field
        title="Default models"
        hint={
          config.modelsLocked
            ? 'Models are locked to the defaults configured in the native coding-agent settings.'
            : 'The model preselected in the composer for each runner. Auto lets the runner decide per task.'
        }
      >
        <div className="flex max-w-md flex-col gap-2">
          {RUNNERS.map((runner) => {
            const provider = providerStatusFor(providerStatus.data, runner.id)
            const providerConnected =
              !providerStatus.isPending &&
              !providerStatus.isError &&
              provider?.enabled === true &&
              provider.status === 'connected'
            const providerReason = providerStatus.isPending
              ? 'Checking provider authentication…'
              : providerStatus.isError
                ? 'Provider authentication could not be verified.'
                : provider?.enabled === false
                  ? 'This provider is disabled. Enable it above or choose another provider.'
                : providerConnected
                  ? undefined
                  : 'Connect this provider before selecting it.'
            const catalog = catalogs[runner.id]
            const catalogStatus = modelCatalogStatus(runner.id, catalog.data, catalog.isError)
            const modelOptions = modelsForRunner(runner.id, catalog.data, [
              config.defaultModels[runner.id],
            ])
            const configuredModel = config.defaultModels[runner.id] ?? ''
            const configuredModelLabel =
              modelOptions.find((model) => model.id === configuredModel)?.label ??
              configuredModel ??
              'auto (default)'
            return (
              <label key={runner.id} className="flex items-center gap-3">
                <span className="w-24 shrink-0 font-mono text-xs text-muted-foreground">{runner.label}</span>
                {config.modelsLocked ? (
                  <output
                    aria-label={`Default model for ${runner.label}`}
                    data-slot="agents-model"
                    data-runner={runner.id}
                    title="Model selection is locked to native coding-agent settings."
                    className="block w-full rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs"
                  >
                    {configuredModelLabel}
                  </output>
                ) : (
                  <select
                    aria-label={`Default model for ${runner.label}`}
                    data-slot="agents-model"
                    data-runner={runner.id}
                    value={configuredModel}
                    title={providerReason ?? runner.desc}
                    disabled={save.isPending || !providerConnected}
                    onChange={(event) =>
                      save.mutate({
                        defaultModels: { [runner.id]: event.target.value || null } as Partial<
                          Record<Runner, string | null>
                        >,
                      })
                    }
                    className="block w-full rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                  >
                    {modelOptions.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.id === '' ? 'auto (default)' : model.label}
                      </option>
                    ))}
                    {catalogStatus ? <option disabled>{catalogStatus}</option> : null}
                  </select>
                )}
              </label>
            )
          })}
        </div>
      </Field>

      <Field
        title="System prompt"
        hint="Extra instructions appended to every run, whichever runner executes it."
        tier={tierOf(config, 'systemPrompt')}
      >
        <Textarea
          aria-label="System prompt"
          data-slot="agents-system-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Extra rules for every agent run — conventions, tone, review requirements…"
          className="min-h-32 max-w-xl"
        />
        <div className="flex max-w-xl items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-action="agents-save-prompt"
            disabled={promptSaved || promptOverLimit || save.isPending}
            onClick={savePrompt}
          >
            Save for {saveTarget}
          </Button>
          {promptOverLimit ? (
            <p data-slot="agents-prompt-limit" className="text-[11px] text-danger">
              {trimmedPrompt.length.toLocaleString()} characters — the limit is{' '}
              {SYSTEM_PROMPT_MAX.toLocaleString()}.
            </p>
          ) : (
            <p className="text-[11px] text-soft-foreground">
              Leave empty and save to clear. Applied to new runs only.
            </p>
          )}
        </div>
      </Field>

      <Field
        title="Live title updates"
        hint="Refresh a task's short title through the namer model as the run progresses. A manual rename always wins and stops updates for that task."
        tier={tierOf(config, 'liveTitleUpdates')}
      >
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex w-fit items-center gap-3">
            <Switch
              aria-label="Live title updates"
              data-slot="agents-live-title-updates"
              checked={config.liveTitleUpdates ?? true}
              disabled={save.isPending}
              onCheckedChange={(checked) =>
                save.mutate(
                  { liveTitleUpdates: checked },
                  { onSuccess: () => toast(checked ? 'Live title updates on' : 'Live title updates off') },
                )
              }
            />
            <span className="text-[13px] text-muted-foreground">
              {(config.liveTitleUpdates ?? true) ? 'On' : 'Off'}
              {config.liveTitleUpdates === null && ' (default)'}
            </span>
          </label>
          <ClearOverride
            slot="agents-live-title-updates"
            shown={config.overridden.includes('liveTitleUpdates')}
            disabled={save.isPending}
            onClear={() =>
              save.mutate(
                { liveTitleUpdates: null },
                { onSuccess: () => toast('Live title updates back to the shared default') },
              )
            }
          />
        </div>
      </Field>

      <Field
        title="Review changes before finishing"
        hint="When on, a task with changes pauses so you can Accept, Send back, or open a Draft PR. Autonomous tasks always skip this and finish on their own. Default: off — tasks finish without asking."
        tier={tierOf(config, 'reviewGate')}
      >
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex w-fit items-center gap-3">
            <Switch
              aria-label="Review changes before finishing"
              data-slot="agents-review-gate"
              checked={config.reviewGate ?? false}
              disabled={save.isPending}
              onCheckedChange={(checked) =>
                save.mutate(
                  { reviewGate: checked },
                  { onSuccess: () => toast(checked ? 'Review gate on' : 'Review gate off') },
                )
              }
            />
            <span className="text-[13px] text-muted-foreground">
              {(config.reviewGate ?? false) ? 'On' : 'Off'}
              {config.reviewGate === null && ' (default)'}
            </span>
          </label>
          <ClearOverride
            slot="agents-review-gate"
            shown={config.overridden.includes('reviewGate')}
            disabled={save.isPending}
            onClear={() =>
              save.mutate(
                { reviewGate: null },
                { onSuccess: () => toast('Review gate back to the shared default') },
              )
            }
          />
        </div>
      </Field>

      <Field
        title="Base branch"
        hint="New task worktrees branch from this and draft PRs target it. Also settable from the Git view. Always this repo's own — a branch name is a property of a repository, so it has no all-projects answer."
        tier={config.overridden.includes('baseBranch') ? 'overridden' : undefined}
      >
        {repo.data?.info ? (
          <select
            aria-label="Base branch"
            data-slot="agents-base-branch"
            value={config.baseBranch ?? ''}
            disabled={save.isPending}
            onChange={(event) => save.mutate({ baseBranch: event.target.value || null })}
            className="block w-full max-w-md rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
          >
            <option value="">follow checked-out branch (default)</option>
            {repo.data.branches.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        ) : (
          <p data-slot="agents-base-branch-unavailable" className="text-[13px] text-soft-foreground">
            {repo.isPending ? 'Loading branches…' : 'Not a git repository — tasks run in place, no branching.'}
          </p>
        )}
      </Field>
    </div>
  )
}

/**
 * The repo's default AGENT — and, when that agent has more than one login, which account (spec
 * 2026-07-29-agent-profiles).
 *
 * One flat list, the same shape the composer's runner pill uses:
 *
 *     claude · Default
 *     claude · Klaudiusz
 *     codex
 *
 * Not a runner control with an account control beside it. Both answers are the same decision —
 * "what does this repo run by default" — and splitting them meant reading two fields to learn one
 * fact. An agent with a single login stays a single row, so a machine with no extra accounts sees
 * exactly the control it always saw.
 *
 * The two halves land in DIFFERENT stores, and that is deliberate rather than incidental: the runner
 * is a team decision and goes in the repo's committable config, while the account is personal and
 * per-machine (`~/.cezar/agent-accounts.json`) — committing it would publish which login someone
 * works under. Hence two writes for one click, and the copy says so.
 */
function DefaultAgentField({
  defaultRunner,
  providerStatus,
  saving,
  onPick,
}: {
  defaultRunner: Runner
  providerStatus: ReturnType<typeof useProviderStatus>
  saving: boolean
  onPick: (runner: Runner) => void
}) {
  const profiles = useAgentProfiles()
  const projects = useProjects()
  const scope = useProjectScope()
  const repo = useRepo()
  const select = useSelectAgentProfile()
  const health = useHealth()

  // `projectId: null` is the boot project, which every route addresses by the reserved `default`
  // alias. The repo ROOT is the key the account store uses, and `useRepo` is project-scoped so it
  // already answers for the ACTIVE project.
  const projectId = scope.projectId ?? 'default'
  const repoRoot = repo.data?.info?.root
  // Repo first, then the machine-wide default — the same order the server resolves in, so the
  // checked row is the account a task would really run under rather than a guess.
  const selection = repoRoot ? profiles.data?.selections[repoRoot] : undefined
  const machine = profiles.data?.defaults
  const rows = agentPickerRows(profiles.data?.profiles ?? [], {
    pools: health.data?.capabilities?.accountUsage === true,
  })
  const hasAccounts = hasAgentAccounts(rows)

  return (
    <Field
      title={hasAccounts ? 'Default agent' : 'Default runner'}
      hint={
        hasAccounts
          ? 'Preselected for new tasks in THIS repo, and used by the chain planner. Each task can still pick another agent or account. The account is stored on this machine only — it is never committed, so a teammate keeps their own.'
          : 'Preselected for new tasks in THIS repo, and used by the chain planner. Each task can still pick another runner.'
      }
    >
      <DefaultAgentPicker
        rows={rows}
        runner={defaultRunner}
        accountFor={(id) => selection?.[id] ?? machine?.[id] ?? null}
        providerStatus={providerStatus}
        disabled={saving}
        // The account half needs a project to write against; the runner half does not, so only an
        // account row waits on the registry.
        accountDisabled={select.isPending || projects.data === undefined}
        onPick={(runner, account, hasAccountChoice) => {
          if (runner !== defaultRunner) onPick(runner)
          // Only when this agent HAS a choice of accounts: a single-login agent must not write a
          // selection, or the store would fill up with rows that say nothing.
          if (hasAccountChoice) {
            select.mutate(
              { projectId, provider: runner, profileId: account },
              { onError: (error: Error) => toast(error.message, { tone: 'danger' }) },
            )
          }
        }}
      />
      {!providerStatus.isPending &&
      !providerStatus.isError &&
      providerStatusFor(providerStatus.data, defaultRunner)?.enabled === false ? (
        <p className="text-[13px] text-muted-foreground">
          This provider is disabled. Enable it above or choose another provider.
        </p>
      ) : null}
      {hasAccounts ? (
        <p className="max-w-md text-[13px] text-muted-foreground">
          Tasks already started under another account can’t be resumed here — their sessions live in
          that account’s folder.
        </p>
      ) : null}
    </Field>
  )
}

/**
 * Which tier the value on screen came from
 * (`.ai/specs/2026-08-21-one-settings-area.md`, Phase 3).
 *
 * `overridden` — this repo's own `.ai/cezar/config.json` sets the key, so it wins over everything.
 * `inherited` — it does not, and `~/.cezar/config.json`'s `projectDefaults` is what is showing.
 * `undefined` — neither tier has an opinion: the built-in default, which needs no badge because
 * the control already says "(default)".
 */
type FieldTier = 'overridden' | 'inherited'

/** The badge for one of the four knobs with a machine tier. Reads `overridden` from the RAW repo
 *  file (never the parsed config, which cannot tell a chosen value from a seeded one). */
function tierOf(
  config: ConfigResponse,
  key: 'systemPrompt' | 'liveTitleUpdates' | 'reviewGate',
): FieldTier | undefined {
  if (config.overridden.includes(key)) return 'overridden'
  return config.inherited[key] === null ? undefined : 'inherited'
}

const TIER_LABEL: Record<FieldTier, string> = {
  overridden: 'Overridden',
  inherited: 'Inherited',
}

const TIER_TITLE: Record<FieldTier, string> = {
  overridden: 'This project sets its own value in .ai/cezar/config.json — it wins over the all-projects one.',
  inherited: 'Not set in this project. The value shown comes from the all-projects setting in ~/.cezar.',
}

/** Drop this repo's override so the field falls back to the all-projects answer. Rendered only
 *  when there IS an override — a "clear" that clears nothing is a button that can only confuse. */
function ClearOverride({
  slot,
  shown,
  disabled,
  onClear,
}: {
  slot: string
  shown: boolean
  disabled: boolean
  onClear: () => void
}) {
  if (!shown) return null
  return (
    <button
      type="button"
      data-action={`${slot}-clear`}
      disabled={disabled}
      onClick={onClear}
      className="text-[11px] font-medium text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground disabled:opacity-50"
    >
      Use the all-projects value
    </button>
  )
}

/** The Appearance section's field chassis — same rhythm, so Settings reads as one surface. */
function Field({
  title,
  hint,
  tier,
  children,
}: {
  title: string
  hint: string
  tier?: FieldTier
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {tier ? (
            <span
              data-slot="agents-field-tier"
              data-tier={tier}
              title={TIER_TITLE[tier]}
              className="rounded-full border border-border px-1.5 py-px text-[10.5px] font-medium text-soft-foreground"
            >
              {TIER_LABEL[tier]}
            </span>
          ) : null}
        </div>
        <p className="text-[13px] text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  )
}
