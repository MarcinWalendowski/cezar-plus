import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CheckIcon,
  ChevronDownIcon,
  EyeIcon,
  FolderOpenIcon,
  LoaderCircleIcon,
  SparklesIcon,
  SquareIcon,
  WorkflowIcon,
  XIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  useNavigate as useRouterNavigate,
  useParams,
  useSearchParams,
  Link as WorkspaceLink,
} from 'react-router'

import { isAgentPoolId } from '@loki-labs/better-cezar-api-client'
import { Link, scopeTo, useNavigate } from '@/lib/project-router'

import { createRun, createTodo, getLaunchKey, postPlan, putConfig, putUiState } from '@/api/client'
import { useProjectScope } from '@/api/project-scope-context'
import {
  queryKeys,
  useAgentProfiles,
  useStartWorkspaceRun,
  useConfig,
  useHealth,
  useProviderStatus,
  useProjects,
  useRepo,
  useRunnerModels,
  useSkills,
  useUiState,
  useWorkspaceConfig,
  useWorkflows,
} from '@/api/queries'
import type {
  ImageInput,
  ProjectListEntry,
  RepoResponse,
  Runner,
  Skill,
  WorkflowDef,
} from '@loki-labs/better-cezar-api-client'
import { TwinkleBackdrop } from '@/components/centered-state'
import { Composer, type ComposerHandle } from '@/components/composer/composer'
import { GhostCodeBackdrop } from '@/components/ghost-code-backdrop'
import { Button } from '@/components/ui/button'
import { PickerPill, RunnerPill, chevron, chipClass } from '@/components/picker-pill'
import { PromptTemplateMenu } from '@/components/prompt-template-menu'
import { SkillPreviewDialog } from '@/components/skill-detail'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { toast } from '@/components/ui/toaster'
import {
  autoApplyText,
  normalizePromptTemplates,
  resolveAutoApply,
} from '@/lib/prompt-templates'
import {
  bumpSkillUsage,
  isProjectSkill,
  orderSkillsByUsage,
  partitionSkillsForDisplay,
  searchSkills,
  searchWorkflows,
  skillKeywords,
} from '@/lib/skills'
import { displayWorkflowName } from '@/lib/tasks-table'
import { submitShortcutHint } from '@/lib/use-submit-shortcut'
import { cn } from '@/lib/utils'
import { usableRunners } from '@/lib/provider-status'

import {
  bookmarkletRunBody,
  deepLinkToast,
  unknownSkillPrefillText,
  type DeepLinkNotice,
} from './new-task-autostart'
import {
  clearDraftText,
  composerRunModeNote,
  readDraft,
  resolveComposerRunMode,
  writeDraft,
  type NewTaskDraft,
} from './new-task-draft'
import {
  buildCreateRunBody,
  buildWorkspaceRunBody,
  modelsForRunner,
  modelCatalogStatus,
  pushRecentSource,
  resolveModel,
  resolveRunner,
  resolveSource,
  startedRunPath,
  type TaskSource,
} from './new-task-form'
import { parseNewTaskParams } from './new-task-params'
import { buildPlannedRunBody, pendingPlanOf, type PendingPlan } from './new-task-plan'
import { PlanReview } from './plan-review'

/**
 * `/new` — the full-screen new-task hero (spec §"New task (full-screen, #386)"; visual
 * contract docs/mockups/new-task.html): centered composer card on the twinkle surface, the
 * picker pill row inside the card below the textarea, suggested-task ghost chips underneath.
 * In plan-first mode (#383, the `Start | Plan first` segment) submit runs `POST /api/plan`
 * and opens the review overlay (plan-review.tsx) instead of starting a run.
 *
 * This route also owns the saved-bookmarklet contract (spec 011, BACKWARD_COMPATIBILITY.md):
 * a full document load of `/new?skill=&ref=&auto=1&key=` auto-starts a run unattended when the
 * key matches `GET /api/launch-key`, and only prefills otherwise — `handleDeepLink()` in
 * web/app.js, verbatim (see new-task-autostart.ts for the verified semantics).
 */
export function NewTaskRoute() {
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const routerNavigate = useRouterNavigate()
  const queryClient = useQueryClient()

  // The composer's project (multi-project spec, step 3.4). TWO ids, deliberately:
  //  - `urlProjectId` is what the URL names — always a real project, boot included. It is the
  //    pill's selected value and what a swap navigates away from.
  //  - `scope.projectId` is the API/cache scope, which is NULL for the boot project (the
  //    step-3.1 invariant). It keys the draft, so the boot project keeps the bare legacy
  //    storage key and a draft typed before this upgrade survives it.
  // Both are absent when this route renders outside a `/p/:projectId` prefix (a component
  // test), and everything below degrades to exactly the single-project behavior.
  const { projectId: urlProjectId } = useParams()
  const draftProjectId = useProjectScope().projectId
  const projects = useProjects()

  // The project pill's own selection (D1, `.ai/specs/2026-08-15-knowledge-grounded-task-
  // workspace-run.md`) — 'auto' is Workspace, 'project' follows `urlProjectId` as the pill did
  // before this spec. Genuine local state, DECOUPLED from the URL, and deliberately not derived
  // from `urlProjectId` alone: `/new` permanently redirects to `/p/<boot>/new`
  // (BACKWARD_COMPATIBILITY.md's protected bookmarklet contract — `routes.test.tsx`'s `/new
  // query params` suite exercises it, and a mutation there is the guard), so `urlProjectId` is
  // NEVER undefined once this route actually renders in the real app and cannot by itself tell
  // "landed via the generic New task entry" apart from "explicitly picked the boot project from
  // this very pill". `?scope=auto` is the signal instead: every generic entry point (the
  // sidebar link, the mobile FAB, the command palette's row and shortcuts — app-shell.tsx,
  // tasks-overview.tsx, command-palette.tsx) appends it; an explicit link to one project's
  // composer (notes.tsx, the bookmarklet contract, picking a NAMED project from this pill)
  // never does, and keeps meaning exactly what it always did. Seeded once, from the initial
  // `search`, before the effect below strips every query param from the URL — the same
  // capture-then-clean shape `deepLink` uses just below. `urlProjectId === undefined` is also
  // read here for the ONE case that is not a redirect: a test harness mounting this route
  // directly at a bare `/new` with no `/p/:projectId` ancestor at all.
  const [pillMode, setPillMode] = useState<'auto' | 'project'>(() =>
    urlProjectId === undefined || search.get('scope') === 'auto' ? 'auto' : 'project',
  )

  // The deep-link params, captured ONCE: the mount effect below strips them from the URL
  // (legacy's `history.replaceState` — the launch key must not survive in history or survive
  // a reload to re-trigger), so live search params would vanish under us.
  const [deepLink] = useState(() => parseNewTaskParams(search))

  const health = useHealth()
  const workflows = useWorkflows()
  const skills = useSkills()
  const repo = useRepo()
  const uiState = useUiState()
  // Settings → Agents runner/model policy for this project. `/api/health` is boot-bound and
  // cannot answer these per-project defaults when another project is active (#699).
  const config = useConfig()
  const workspaceConfig = useWorkspaceConfig()

  // The draft survives navigation (module store); explicit deep-link params beat it — a
  // pasted `/new?skill=&ref=` link states intent, a leftover draft only remembers it.
  const [draft, setDraft] = useState<NewTaskDraft>(() => {
    const stored = readDraft(draftProjectId)
    return {
      ...stored,
      ...(deepLink.ref !== '' ? { text: deepLink.ref } : {}),
      ...(deepLink.skill !== ''
        ? { source: { source: 'skill', ref: deepLink.skill } as TaskSource }
        : {}),
    }
  })
  useEffect(() => {
    writeDraft(draft, draftProjectId)
  }, [draft, draftProjectId])
  const update = (patch: Partial<NewTaskDraft>) =>
    setDraft((current) => ({ ...current, ...patch }))

  // ---- effective picker values (rules in new-task-form.ts, mirrored from legacy) -----------
  const recentSources = uiState.data?.recentSources
  // Memoized so the picker gets a STABLE array identity across renders that don't actually
  // change the catalog or the usage stats (#408 — a raw `orderSkillsByUsage(...)` call here
  // would create a new array on EVERY render, including ones unrelated to skills/usage).
  const skillsData = skills.data
  const skillUsage = uiState.data?.skillUsage
  const skillList = useMemo(
    () => orderSkillsByUsage(skillsData ?? [], skillUsage),
    [skillsData, skillUsage],
  )
  const workflowList = workflows.data?.workflows ?? []
  // The registry the project pill offers. Empty while it loads or when it errors — the pill
  // simply does not render, which is the honest state: there is no second project to offer.
  const projectList = projects.data?.projects ?? []
  // Same gate the pill always used ("the same rule the sidebar's project groups follow"): with
  // one project or none there is nothing to run ACROSS, so the pill stays hidden and submit
  // keeps its single-project behavior byte-for-byte, whatever `pillMode` says.
  const showProjectPill = projectList.length > 1
  const workspaceActive = showProjectPill && pillMode === 'auto'
  // The pill's displayed selection: null renders "Workspace"; falls back to `urlProjectId` for
  // the named-project case exactly as before this spec.
  const pillProjectId = pillMode === 'auto' ? null : (urlProjectId ?? null)
  const sourcesReady =
    skills.data !== undefined && workflows.data !== undefined && !uiState.isPending
  // The draft's own pick, and nothing else (2026-08-15, owner: "no workflow should be selected
  // by default"). `uiState.lastTask` used to be the second candidate here — see `resolveSource`'s
  // own doc comment for why a previously-used workflow no longer reappears preselected.
  const source = resolveSource([draft.source], skillList, workflowList)
  const selectedSkill = source?.source === 'skill'
    ? skillList.find((skill) => skill.name === source.ref)
    : undefined

  // ---- prompt templates (#413 follow-up) ----------------------------------------------------
  // The same list the GitHub hand-over and Inbox composers read. Two ways in here: the footer's
  // icon trigger inserts one by hand at the caret, and a skill whose templates are assigned to it
  // applies them on selection — but only into a box the user has not typed in (`resolveAutoApply`).
  const composerRef = useRef<ComposerHandle>(null)
  const templates = useMemo(
    () => normalizePromptTemplates(uiState.data?.promptTemplates),
    [uiState.data?.promptTemplates],
  )
  const autoText = autoApplyText(templates, source?.source === 'skill' ? [source.ref] : [])
  const draftTextRef = useRef(draft.text)
  draftTextRef.current = draft.text
  const autoAppliedRef = useRef('')
  useEffect(() => {
    // Wait for the pickers' data: before it lands `source` is still a provisional guess, and
    // auto-applying against it would flash text in for a skill the user may not end up on.
    if (!sourcesReady) return
    const resolved = resolveAutoApply(draftTextRef.current, autoAppliedRef.current, autoText)
    autoAppliedRef.current = resolved.applied
    if (resolved.text !== draftTextRef.current) update({ text: resolved.text })
    // `autoText` is a derived STRING — this fires when the assigned set changes, not every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoText, sourcesReady])

  const providers = useProviderStatus()
  const runners = usableRunners(providers.data)
  const defaultRunner = config.data?.defaultRunner
  const preferredRunner = defaultRunner ?? 'claude'
  const runner = runners.length > 0 ? resolveRunner(draft.runner, runners, preferredRunner) : null
  const displayRunner = runner ?? preferredRunner
  const providersReady = providers.isSuccess && runners.length > 0
  const catalog = useRunnerModels(displayRunner)
  const modelsLocked = config.data?.modelsLocked === true
  const models = runner === null
    ? []
    : modelsForRunner(runner, catalog.data, [draft.model, config.data?.defaultModels?.[runner]])
  const model = runner === null
    ? ''
    : resolveModel(modelsLocked ? null : draft.model, runner, config.data?.defaultModels, catalog.data)
  // Agent accounts (spec 2026-07-29-agent-profiles). These are rows of the RUNNER pill rather than
  // a pill of their own — `claude · Default` / `claude · Klaudiusz` / `codex` — so what will run is
  // readable at a glance instead of assembled from two controls. An agent with a single login stays
  // a single row, which is why a host with no extra accounts sees the list it always saw.
  const profiles = useAgentProfiles()
  const accountChoices = (profiles.data?.profiles ?? []).map((profile) => ({
    provider: profile.provider as Runner,
    id: profile.id,
    label: profile.label,
    configDir: profile.configDir,
  }))
  // Pools (spec 2026-08-16, Phase C) ride the same slot as an account id and are offered only with
  // the `accountUsage` capability, which is what maintains the signals they balance on.
  const poolsOffered = health.data?.capabilities?.accountUsage === true
  // A draft account belonging to ANOTHER runner is ignored rather than sent: switching runner must
  // not silently carry a foreign account along. A POOL is exempt — it names no runner's login, so
  // there is no foreign account to carry, and dropping it here would silently downgrade every
  // pooled task to a single login the moment the runner pill re-rendered.
  const agentProfile =
    (poolsOffered && isAgentPoolId(draft.agentProfile)) ||
    accountChoices.some((choice) => choice.provider === displayRunner && choice.id === draft.agentProfile)
      ? draft.agentProfile
      : null
  // Which account each runner falls back to until the task overrides it. Selections are keyed by
  // repo ROOT — the same key the store uses — and the root comes from `useRepo`, which is
  // project-scoped and so already answers for the ACTIVE project; going through the projects list
  // would mean re-deriving a mapping the API has already done.
  const repoRoot = repo.data?.info?.root
  const repoAccount = (repoRoot ? profiles.data?.selections[repoRoot] : undefined) as
    | Partial<Record<Runner, string>>
    | undefined

  // A cold /new load mounts the textarea disabled while provider status is checked. Restore
  // the route's autofocus contract once that check enables the form, but never steal focus if
  // the user already moved elsewhere while it was pending.
  const providersWereReady = useRef(false)
  useEffect(() => {
    const becameReady = providersReady && !providersWereReady.current
    providersWereReady.current = providersReady
    if (becameReady && document.activeElement === document.body) {
      document
        .querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a task for the agent"]')
        ?.focus()
    }
  }, [providersReady])

  // Parallel variants need a worktree per variant, hence git (the server 409s without it).
  // Read it from the PROJECT-scoped `/repo` above, never from `/api/health.repo`: health is bound
  // to the boot folder, so booting outside a git repo hid the worktree controls for every
  // registered project (#791) — the same per-project sweep as #700 (forge) and #699 (runner
  // defaults). Loading still assumes git so the controls do not flicker.
  const hasGit = repo.data === undefined || repo.data.info !== null
  const variants = hasGit && !workspaceActive ? draft.variants : 1

  // Worktree opt-out (#worktree-toggle): any ordinary run in a git repo may use the current
  // checkout. Parallel variants are the one hard constraint because each competing run needs
  // its own tree; a non-git repo already runs in place.
  //
  // A WORKSPACE run offers neither, and hides both rather than disabling them. It is exactly one
  // run with no worktree — `workspaceRunStartInputSchema` is `.strict()` and 400s on either key
  // (D10), and `buildWorkspaceRunBody` strips them before the post. So a tickable Worktree box
  // here would be silently discarded: the user ticks it, sees it ticked, and gets a run with no
  // worktree — the "we heard you and did something else" answer D10 exists to refuse, smuggled
  // back in one layer above the API. Same rule, same reason as `followupsToggleShown` below:
  // the server pins the value regardless, so a control would be a lie. Nothing is lost by
  // hiding them, because `composerRunModeNote`'s workspace line already STATES both facts
  // ("Runs once across every project … with no worktree").
  const worktreeToggleShown = hasGit && !workspaceActive
  const worktreeForced = variants > 1

  // Autonomous (#autonomous): the run never pauses for the user. An explicit toggle this session
  // wins; then an interactive skill recommends handing the ball back; otherwise the configured
  // workspace default applies ('source-dependent' → skills default ON, everything else OFF).
  // Plan-first forces it OFF (and disables the toggle): planning is inherently interactive, so
  // the run must be able to hand the ball back.
  const runMode = resolveComposerRunMode({
    hasGit,
    variants,
    // ComposerRunModeInput still models the autonomous constraint as a boolean; the draft's
    // similarly named runMode is the three-way submit choice.
    planFirst: draft.runMode === 'plan',
    explicitAutonomous: draft.autonomous,
    explicitWorktree: draft.worktree,
    interactive: selectedSkill?.interactive,
    configuredAutonomous:
      workspaceConfig.data?.composerDefaults?.autonomous
      ?? workspaceConfig.data?.composerDefaults?.inheritedAutonomous
      ?? 'source-dependent',
    configuredWorktree:
      workspaceConfig.data?.composerDefaults?.worktree
      ?? workspaceConfig.data?.composerDefaults?.inheritedWorktree
      ?? true,
    source: source?.source ?? null,
  })
  const worktreeOn = runMode.worktree
  const autonomousOn = runMode.autonomous

  // Follow-up generation (#444) is offered only while the server has the global inbox on
  // (#471, `CEZ_FOLLOWUPS=1`) — there is no inbox for the follow-ups to land in otherwise, and
  // the server pins the flag to false regardless, so a toggle would be a lie. Hidden, the value
  // is false, matching what the server will do. Health unknown → assume offered, the `hasGit`
  // rule above: the composer must not flicker its controls while health is in flight.
  const followupsToggleShown = health.data === undefined || health.data.capabilities.followups
  // Within an enabled server it stays opt-out: a draft choice wins, then the remembered UI
  // preference; absent state from older installs keeps the historical enabled behavior.
  const generateFollowupsOn = followupsToggleShown
    ? (draft.generateFollowups ?? uiState.data?.lastGenerateFollowups ?? true)
    : false

  // ---- plan mode (#383 + spec 008) ----------------------------------------------------------
  const [plan, setPlan] = useState<PendingPlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [starting, setStarting] = useState(false)

  // ---- workspace run (cross-project-workspace-run.md) --------------------------------------
  // Submitting with the Workspace pill starts ONE run across every registered project. It behaves
  // exactly like the ordinary start path below — same `starting` flag, same navigation to the
  // thread — because it IS an ordinary run, just one whose grant covers the whole workspace.
  //
  // **This replaces the fan-out, and the difference is the fix.** That path ran a ~60 s analysis
  // before anything existed, which is what produced "I just tried to add a task and nothing
  // happened" (2026-08-15): no run to navigate to, so the result had to be parked in the
  // MutationCache and surfaced through a pending banner, a result panel and a shell toast. A run
  // that exists immediately needs none of that — the thread is the surface.
  const workspaceRun = useStartWorkspaceRun()

  // ---- bookmarklet deep-link (spec 011 — legacy handleDeepLink, verbatim) -------------------
  // `auto=1` with a ref arms the unattended start; the composer stays hidden behind a
  // "Starting…" surface until the key check + POST settle (or fail into the prefill path).
  const [autoStarting, setAutoStarting] = useState(() => deepLink.auto && deepLink.ref !== '')
  const [notice, setNotice] = useState<DeepLinkNotice | null>(() =>
    !deepLink.auto && deepLink.ref !== '' ? { kind: 'prefill' } : null,
  )
  const deepLinkUrlCleaned = useRef(false)
  const deepLinkHandled = useRef(false)
  useEffect(() => {
    if (deepLinkUrlCleaned.current) return
    deepLinkUrlCleaned.current = true
    // Legacy cleans the URL FIRST (`history.replaceState({}, '', '/')` — before anything
    // async): the launch key never lingers in the address bar or history, and a reload can
    // never re-trigger the start. Same move here, staying on this route. (The router's own
    // search, not window.location — MemoryRouter under test never touches the window.)
    if (search.toString() !== '') void navigate('/new', { replace: true })
    // mount-only: search is intentionally the initial URL, captured before the replace
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (deepLinkHandled.current) return
    if (!deepLink.auto || deepLink.ref === '') return
    if (providers.isPending) return
    if (!providersReady || runner === null) {
      deepLinkHandled.current = true
      // Authentication could not be established: keep the deep-link intent in the disabled
      // composer and let the provider gate explain whether this is an error or missing setup.
      setNotice({ kind: 'prefill' })
      setAutoStarting(false)
      return
    }
    // Provider status often resolves before project config on a cold load. The protected
    // bookmarklet body may omit runner only against that scoped authoritative default, never
    // our display fallback; a failed config read degrades to the prefilled composer.
    if (config.isPending) return
    deepLinkHandled.current = true
    if (defaultRunner === undefined) {
      setNotice({ kind: 'prefill' })
      setAutoStarting(false)
      return
    }
    void (async () => {
      let launchKey = ''
      try {
        launchKey = (await getLaunchKey()).key
      } catch {
        // key endpoint unreachable → the blocked path, exactly like legacy
      }
      if (launchKey !== '' && deepLink.key === launchKey) {
        try {
          const created = await createRun(bookmarkletRunBody(deepLink, runner, defaultRunner))
          clearDraftText(draftProjectId)
          void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
          void navigate(startedRunPath(created))
          return
        } catch (error) {
          setNotice({
            kind: 'failed',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      } else {
        // Wrong or missing key: a drive-by page guessing the URL gets a form, never a run.
        setNotice({ kind: 'blocked' })
      }
      setAutoStarting(false)
    })()
  }, [config.isPending, defaultRunner, providers.isPending, providersReady, runner]) // eslint-disable-line react-hooks/exhaustive-deps
  // The prefill toast waits for the pickers' data: whether the skill exists decides the
  // wording, and the unknown-skill case rewrites the draft the way legacy did (intent into
  // the text, the default workflow as the source).
  useEffect(() => {
    if (notice === null || !sourcesReady) return
    setNotice(null)
    const unknownSkill =
      deepLink.skill !== '' && !skillList.some((s) => s.name === deepLink.skill)
        ? deepLink.skill
        : ''
    if (unknownSkill !== '') {
      update({
        text: unknownSkillPrefillText(deepLink.skill, deepLink.ref),
        ...(workflowList.some((w) => w.name === 'spec-to-deploy')
          ? { source: { source: 'workflow', ref: 'spec-to-deploy' } as TaskSource }
          : {}),
      })
    }
    const { message, tone } = deepLinkToast(notice, unknownSkill)
    toast(message, { tone })
    // Legacy focused the Run button so a bare Enter submits the reviewed form.
    document
      .querySelector<HTMLButtonElement>(
        '[data-slot="composer"] button[aria-label="Start task"], [data-slot="composer"] button[aria-label="Plan task"]',
      )
      ?.focus()
  }, [notice, sourcesReady]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (text: string, images: ImageInput[]) => {
    if (workspaceActive) {
      // A workspace run IS a run, so it clears the same provider gate the project path does —
      // unlike the fan-out this replaces, which needed none of them because it started nothing.
      if (!providersReady || runner === null) {
        throw new Error(
          providers.isPending
            ? 'Checking agent providers…'
            : 'Connect an agent provider before starting a task.',
        )
      }
      const started = await workspaceRun.mutateAsync(
        buildWorkspaceRunBody({
          task: text,
          source,
          model,
          modelsLocked,
          runner,
          runnerExplicit: draft.runner !== null,
          agentProfile,
          defaultRunner,
          images,
          autonomous: autonomousOn,
          generateFollowups: generateFollowupsOn,
        }),
      )
      clearDraftText(draftProjectId)
      // Explicitly scoped to the project the run actually landed in (the boot project), NOT the
      // active scope: `startedRunPath` returns a scope-relative path, and a workspace run is
      // started from whichever project the composer happened to be under.
      navigate(scopeTo(started.project, `/tasks/${started.run.id}`))
      return
    }
    if (draft.runMode === 'backlog') {
      // One submit files exactly one task in the current project. Do not fan this out across the
      // workspace: that product shape was explicitly rejected in 2026-08-15's composer work.
      const { todo } = await createTodo({ summary: text, origin: 'composer' })
      clearDraftText(draftProjectId)
      void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[1] === 'todos' })
      toast(`Filed "${todo.summary}" to the backlog.`)
      routerNavigate('/tasks')
      return
    }
    if (!providersReady || runner === null) {
      throw new Error(
        providers.isPending
          ? 'Checking agent providers…'
          : providers.isError
            ? 'Provider authentication could not be verified.'
            : 'Connect an agent provider before starting a task.',
      )
    }
    if (!sourcesReady) {
      // Rejection restores the draft — nothing typed is lost to a race with the pickers.
      throw new Error('Still loading workflows and skills — try again in a second.')
    }
    if (draft.runMode === 'plan') {
      // Plan mode: submit means PLAN. A rejection propagates — the composer toasts and
      // restores the draft; a success restores the text ourselves (the composer already
      // cleared optimistically) so Discard hands back exactly what was typed. The review
      // overlay is deliberate: it's where steps are edited and saved as a reusable chain.
      setPlanning(true)
      try {
        setPlan(pendingPlanOf(text, images, await postPlan(text)))
        update({ text })
      } finally {
        setPlanning(false)
      }
      return
    }
    const created = await createRun(
      buildCreateRunBody({
        task: text,
        source,
        model,
        modelsLocked,
        runner,
        runnerExplicit: draft.runner !== null,
        agentProfile,
        defaultRunner,
        variants,
        images,
        worktree: worktreeOn,
        autonomous: autonomousOn,
        generateFollowups: generateFollowupsOn,
        // #374: when the Inbox's "Run" sent us here, hand the entry's id back so the server
        // records this run on it and it leaves the inbox — the audit trail the old
        // POST /api/todos/:id/start kept, minus the blind launch. Empty otherwise.
        // Deliberately not gated on generateFollowupsOn (#444): turning off follow-up
        // generation for THIS task must not stop the entry it came from being marked started.
        todoId: deepLink.todo,
      }),
    )
    // Float what was actually run to the top of the picker next time (recency sort) and count it
    // for the frequency sort — fire-and-forget: a failed write only costs the convenience.
    //
    // **No `lastTask` (2026-08-15, owner: "no workflow should be selected by default").** This
    // used to send `lastTask: source` so the next visit PRESELECTED it. Nothing reads it now, so
    // writing it would be a mechanism that looks live from the code and does nothing — the field
    // is gone from `uiStateSchema` too, rather than left written-and-ignored. Ordering the picker
    // by what you use is a different thing from choosing for you, and only the first survives.
    void putUiState({
      // Recency sort is a catalog concept — None has no catalog entry to float, so only a real
      // pick touches it.
      ...(source ? { recentSources: pushRecentSource(recentSources, source) } : {}),
      ...(followupsToggleShown ? { lastGenerateFollowups: generateFollowupsOn } : {}),
      // Frequency sort (#408): only a SKILL pick counts — the map is keyed by skill name, and a
      // workflow choice here doesn't select one directly. Gated on the CURRENT map being known:
      // the PUT merge is shallow, so bumping off an errored ui-state query (`sourcesReady` only
      // rules out `isPending`, not a failed fetch) would send a one-entry map and wipe every
      // accumulated count.
      ...(source?.source === 'skill' && uiState.data !== undefined
        ? { skillUsage: bumpSkillUsage(uiState.data.skillUsage, source.ref) }
        : {}),
    })
      .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.uiState }))
      .catch(() => {})
    clearDraftText(draftProjectId)
    void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
    navigate(startedRunPath(created))
  }

  /** ▶ Start on the reviewed plan: the (possibly edited) steps go INLINE, with the composer's
   *  current picker choices — legacy `startPlannedRun` semantics on the new surface. */
  const startPlanned = async () => {
    if (plan === null || plan.steps.length === 0 || starting || !providersReady || runner === null) return
    setStarting(true)
    try {
      const created = await createRun(
        buildPlannedRunBody({
          task: plan.task,
          steps: plan.steps,
          model,
          modelsLocked,
          runner,
          runnerExplicit: draft.runner !== null,
          defaultRunner,
          variants,
          images: plan.images,
          generateFollowups: generateFollowupsOn,
          todoId: deepLink.todo, // #374: planning first must not lose the inbox entry
        }),
      )
      // Run-mode choices live in the current draft; stable defaults come from workspace policy.
      // persisting the forced `false` would overwrite their real preference, so turning
      // CEZ_FOLLOWUPS back on later would silently come up off.
      if (followupsToggleShown) {
        void putUiState({ lastGenerateFollowups: generateFollowupsOn })
          .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.uiState }))
          .catch(() => {})
      }
      clearDraftText(draftProjectId)
      setPlan(null)
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
      navigate(startedRunPath(created))
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
    } finally {
      setStarting(false)
    }
  }

  // The unattended bookmarklet start in flight: no composer, no params echoed anywhere —
  // just an honest "working on it" until the POST answers (success navigates to the thread;
  // failure drops back to the prefilled composer with a toast).
  if (autoStarting) {
    return (
      <div
        data-route="new"
        className="relative isolate flex min-h-full flex-col items-center justify-center overflow-x-clip px-6"
      >
        <TwinkleBackdrop />
        <div data-slot="auto-starting" role="status" className="text-center">
          <h1 className="animate-pulse text-lg font-semibold tracking-tight">Starting task…</h1>
          <p className="mt-1.5 text-[13.5px] text-muted-foreground">
            Launched from a bookmarklet — taking you to the run.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div
      data-route="new"
      className="relative isolate flex min-h-full flex-col items-center overflow-x-clip px-6 pt-[clamp(32px,7vh,84px)] pb-16 max-md:px-3.5 max-md:pt-7"
    >
      <TwinkleBackdrop />
      <GhostCodeBackdrop />

      <div className="w-full max-w-[720px]">
        <header className="mb-6 text-center max-md:mb-4">
          <h1 className="text-lg font-semibold tracking-tight max-md:text-base">
            What should the agent work on?
          </h1>
          {/* Follows the resolved run mode (#793). Printing the isolation promise
              unconditionally made this line false for every run the user opted out of — and
              for a non-git folder, where there is no worktree to opt into. */}
          <p data-slot="run-mode-note" className="mt-1.5 text-[13.5px] text-muted-foreground max-md:text-xs">
            {composerRunModeNote({ worktree: worktreeOn, hasGit, workspace: workspaceActive })}
          </p>
        </header>

        <Composer
          ref={composerRef}
          onSubmit={submit}
          value={draft.text}
          onValueChange={(text) => update({ text })}
          autoFocus
          placeholder="Describe a task for the agent — / for skills…"
          ariaLabel="Describe a task for the agent"
          sendAriaLabel={
            draft.runMode === 'plan' && !workspaceActive
              ? 'Plan task'
              : draft.runMode === 'backlog' && !workspaceActive
                ? 'File task'
                : 'Start task'
          }
          // Filing starts no agent, so provider readiness gates only the effective run paths.
          // `workspaceRun.isPending` still closes the workspace double-submit path.
          disabled={
            starting ||
            workspaceRun.isPending ||
            ((draft.runMode !== 'backlog' || workspaceActive) && !providersReady)
          }
          disabledReason={
            draft.runMode === 'backlog' && !workspaceActive
              ? undefined
              : providers.isPending
              ? 'Checking agent providers…'
              : providers.isError
                ? 'Provider authentication could not be verified.'
                : !providersReady
                  ? 'Connect an agent provider before starting a task.'
                  : undefined
          }
          autocompleteSkills
          footerStart={
            <>
              {/* The project pill LEADS the row (mockup new-task-project.html): everything to
                  its right is resolved against it, so it reads left-to-right as "in this
                  project, run this skill, with this model". Rendered only once the workspace
                  actually holds more than one project — with a single one the control offers
                  nothing and the composer keeps the shape it has always had, the same rule the
                  sidebar's project groups follow. */}
              {showProjectPill ? (
                <ProjectPill
                  projects={projectList}
                  projectId={pillProjectId}
                  onPick={(next) => {
                    if (next === null) {
                      // Workspace is composer-local state, not a route: it stays on whichever
                      // project URL is already active (the fan-out call itself is unscoped) so
                      // switching to it never navigates.
                      setPillMode('auto')
                      return
                    }
                    setPillMode('project')
                    // An explicit `/p/<id>` target: the scoped navigate wrapper passes already
                    // scoped paths through untouched, so this is a genuine cross-project jump.
                    navigate(`/p/${encodeURIComponent(next)}/new`, { replace: true })
                  }}
                />
              ) : null}
              <SourcePill
                source={source}
                ready={sourcesReady}
                skills={skillList}
                skillUsage={skillUsage}
                workflows={workflowList}
                onPick={(next) => update({ source: next })}
              />
              {/* Icon-only: this row already carries source/runner/model/variants/worktree/
                  autonomous/branch, and templates is the least-used of them. */}
              <PromptTemplateMenu
                templates={templates}
                iconOnly
                onInsert={(text) => composerRef.current?.insertAtCaret(text)}
              />
              {/* Shown when there is a choice to make: more than one runner, or more than one
                  login for one of them. A host with neither sees no pill, exactly as before. */}
              {runners.length > 1
              || runners.some((id) => accountChoices.filter((c) => c.provider === id).length > 1)
              || (poolsOffered && accountChoices.length > 1) ? (
                <RunnerPill
                  runners={runners}
                  value={displayRunner}
                  accounts={accountChoices}
                  account={agentProfile}
                  repoAccount={repoAccount}
                  pools={poolsOffered}
                  // Changing the AGENT clears the model pin: presets are per-runner, so a kept
                  // model would be one the new runner does not have. Changing only the account
                  // keeps it — the model catalog is the same either way.
                  onPick={(next, picked) =>
                    update({
                      runner: next,
                      agentProfile: picked,
                      ...(next === displayRunner ? {} : { model: null }),
                    })
                  }
                  disabled={!providersReady}
                />
              ) : null}
              <PickerPill
                slot="model-pill"
                ariaLabel="Model"
                label={models.find((m) => m.id === model)?.label ?? 'auto'}
                value={model}
                disabled={!providersReady}
                readOnly={modelsLocked}
                disabledHint={
                  modelsLocked
                    ? 'Model selection is locked to native coding-agent settings.'
                    : undefined
                }
                onPick={(next) => update({ model: next })}
                options={models.map((m) => ({ value: m.id, label: m.label, desc: m.desc }))}
                status={modelCatalogStatus(displayRunner, catalog.data, catalog.isError)}
              />
              {workspaceActive ? null : (
              <PickerPill
                slot="variants-pill"
                ariaLabel="Parallel variants"
                label={variants > 1 ? `×${variants} variants` : '×1'}
                value={String(variants)}
                onPick={(next) => update({ variants: Number(next) })}
                disabled={!hasGit}
                hint="How many times to run this task in parallel — each variant gets its own worktree, and you pick the diff you keep. ×1 runs it once."
                disabledHint="Parallel variants need a git repository — each variant runs in its own worktree."
                options={[
                  { value: '1', label: '×1', desc: 'One run' },
                  { value: '2', label: '×2 variants', desc: 'Two competing runs — pick the diff you keep' },
                  { value: '3', label: '×3 variants', desc: 'Three competing runs — pick the diff you keep' },
                ]}
              />
              )}
              {worktreeToggleShown ? (
                <WorktreeToggle
                  on={worktreeOn}
                  disabled={worktreeForced}
                  disabledReason="Parallel variants always use isolated worktrees"
                  onChange={(on) => update({ worktree: on })}
                />
              ) : null}
              <AutonomousToggle
                on={autonomousOn}
                disabled={draft.runMode === 'plan'}
                onChange={(on) => update({ autonomous: on })}
              />
              {selectedSkill?.interactive && (draft.autonomous === null || draft.worktree === null) ? (
                <p className="basis-full text-xs text-muted-foreground" data-slot="interactive-skill-hint">
                  This skill recommends an interactive run in the current checkout. You can change either setting.
                </p>
              ) : null}
              {followupsToggleShown ? (
                <GenerateFollowupsToggle
                  on={generateFollowupsOn}
                  onChange={(on) => update({ generateFollowups: on })}
                />
              ) : null}
              {repo.data ? <BaseBranchPill repo={repo.data} /> : null}
            </>
          }
          footerEnd={
            <>
              {!providersReady && !providers.isPending ? (
                <WorkspaceLink
                  to="/settings/providers"
                  className="text-xs font-medium text-foreground underline underline-offset-4"
                >
                  Configure providers
                </WorkspaceLink>
              ) : null}
              <ModeSegment
                mode={workspaceActive && draft.runMode === 'backlog' ? 'start' : draft.runMode}
                planning={planning}
                showBacklog={!workspaceActive}
                onModeChange={(runMode) => update({ runMode })}
              />
              <kbd
                aria-hidden="true"
                className="rounded-[5px] border border-b-2 border-border bg-card px-[5px] py-px font-mono text-[10.5px] font-medium text-muted-foreground"
              >
                {submitShortcutHint()}
              </kbd>
            </>
          }
        />

        <SuggestedChips onPick={(text) => update({ text })} />
      </div>

      {plan !== null ? (
        <PlanReview
          plan={plan}
          starting={starting}
          startAvailable={providersReady}
          startUnavailableReason={
            providers.isPending
              ? 'Checking agent providers…'
              : providers.isError
                ? 'Provider authentication could not be verified.'
                : 'Connect an agent provider before starting a task.'
          }
          startUnavailableAction={
            !providers.isPending ? (
              <WorkspaceLink to="/settings/providers">Configure providers</WorkspaceLink>
            ) : undefined
          }
          onStepsChange={(steps) => setPlan((current) => (current ? { ...current, steps } : current))}
          onStart={() => void startPlanned()}
          onDiscard={() => setPlan(null)}
        />
      ) : null}

    </div>
  )
}

/** Worktree opt-out toggle (#worktree-toggle): a checkbox-style chip for ordinary runs.
 *  Checked = isolated worktree (the default); unchecked = run in the repo working tree. */
function WorktreeToggle({
  on,
  disabled,
  disabledReason,
  onChange,
}: {
  on: boolean
  disabled?: boolean
  disabledReason?: string
  onChange: (on: boolean) => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      disabled={disabled}
      data-slot="worktree-toggle"
      onClick={() => onChange(!on)}
      title={
        disabled
          ? disabledReason
          : on
          ? 'Runs in an isolated worktree — uncheck to run in the repo working tree'
          : 'Runs in the repo working tree — check to isolate in a worktree'
      }
      className={cn(chipClass, on && 'border-primary/60 text-foreground')}
    >
      {on ? (
        <CheckIcon aria-hidden="true" className="size-3 shrink-0 text-primary" />
      ) : (
        <SquareIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
      )}
      Worktree
    </button>
  )
}

/** Autonomous toggle (#autonomous): checked = the run never pauses for you, auto-continuing
 *  until the agent is done. No "needs you" is ever raised. */
function AutonomousToggle({
  on,
  disabled,
  onChange,
}: {
  on: boolean
  disabled?: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      disabled={disabled}
      data-slot="autonomous-toggle"
      onClick={() => onChange(!on)}
      title={
        disabled
          ? 'Plan-first runs are interactive — autonomous is unavailable'
          : on
            ? 'Autonomous — the agent runs to completion without pausing for you'
            : 'Runs interactively — check to let the agent finish without pausing for you'
      }
      className={cn(chipClass, on && !disabled && 'border-primary/60 text-foreground')}
    >
      {on ? (
        <CheckIcon aria-hidden="true" className="size-3 shrink-0 text-primary" />
      ) : (
        <SquareIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
      )}
      Autonomous
    </button>
  )
}

/** Follow-up toggle: checked lets agents append newly discovered work to the task inbox.
 *  Handoff journaling remains active either way. */
function GenerateFollowupsToggle({
  on,
  onChange,
}: {
  on: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      data-slot="generate-followups-toggle"
      onClick={() => onChange(!on)}
      title={
        on
          ? 'Agents can add newly discovered follow-up work to the task inbox'
          : 'Follow-up generation is off; agents still maintain the handoff journal'
      }
      className={cn(chipClass, on && 'border-primary/60 text-foreground')}
    >
      {on ? (
        <CheckIcon aria-hidden="true" className="size-3 shrink-0 text-primary" />
      ) : (
        <SquareIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
      )}
      Follow-ups
    </button>
  )
}

/**
 * Rank the registry against the pill's search box.
 *
 * Ranked in JS with cmdk's own filtering off (#484 — cmdk's score-sort does not re-order these
 * pickers reliably). Registry order is `lastOpenedAt`, so an empty search shows the same
 * recency the sidebar does; a typed query floats name/id PREFIX matches above mid-string ones,
 * each group still in recency order.
 */
function matchProjects(
  projects: readonly ProjectListEntry[],
  search: string,
): ProjectListEntry[] {
  const query = search.trim().toLowerCase()
  if (query === '') return [...projects]
  const rank = (project: ProjectListEntry): number => {
    const name = project.name.toLowerCase()
    const id = project.id.toLowerCase()
    if (name.startsWith(query) || id.startsWith(query)) return 0
    if (name.includes(query) || id.includes(query)) return 1
    return 2
  }
  return projects
    .map((project, index) => ({ project, rank: rank(project), index }))
    .filter((entry) => entry.rank < 2)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.project)
}

/**
 * The project pill (multi-project spec §"New task"; mockup new-task-project.html) — the
 * composer's scope selector, preselected from the URL.
 *
 * Picking a project NAVIGATES to that project's composer rather than swapping local state:
 * `/p/<id>/new` is the single place the scope is decided (the step-3.2 route gate), and every
 * part of this screen that must re-resolve already keys off it — the skill/workflow picker and
 * `/`-autocomplete (`/api/p/<id>/skills`), the runner and model probes, the base-branch pill,
 * the per-project draft, and the `POST /api/p/<id>/runs` submit target. Doing it any other way
 * would mean a second, parallel notion of "the active project" living in this component.
 *
 * `replace`: a scope swap corrects where you are, it is not a place to go Back to — Back stays
 * whatever brought you to the composer.
 */
function ProjectPill({
  projects,
  projectId,
  onPick,
}: {
  projects: readonly ProjectListEntry[]
  /** `null` is Workspace (`.ai/specs/2026-08-15-cross-project-workspace-run.md`) — the
   *  composer's default: submit starts ONE run with read/write access to every registered
   *  project, instead of a run scoped to one. Was labelled "All / Auto" while this same pick
   *  fanned the input out into one task per project; that mechanism is deleted. */
  projectId: string | null
  onPick: (projectId: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const selected = projectId === null ? undefined : projects.find((project) => project.id === projectId)
  const matched = matchProjects(projects, search)
  // Same idiom as SourcePill's None: participates in the search box rather than always
  // showing, so it never sits next to "Nothing matches." for a query that excludes it too.
  const query = search.trim().toLowerCase()
  const workspaceMatches =
    query === '' || 'workspace'.includes(query) || 'all'.includes(query)

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSearch('')
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="project-pill"
          aria-label="Project"
          title="Which project this task runs in — its skills, workflows, settings and draft"
          className={cn(chipClass, 'border-foreground/60 font-semibold text-foreground')}
        >
          <FolderOpenIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
          {/* The registry is authoritative for the display name; the raw id is the fallback
              while it is still loading, so the pill never renders an empty label. */}
          <span className="max-w-40 truncate">
            {projectId === null ? 'Workspace' : (selected?.name ?? projectId)}
          </span>
          {chevron}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-[300px] max-w-[calc(100vw-2rem)] p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput placeholder="search projects…" value={search} onValueChange={setSearch} />
          {/* Same 3rem headroom rule as the source picker: the list must not eat the search box. */}
          <CommandList
            data-slot="project-menu"
            className="max-h-[min(18rem,calc(var(--radix-popover-content-available-height)-3rem))]"
          >
            {!workspaceMatches && matched.length === 0 ? (
              <CommandEmpty>Nothing matches.</CommandEmpty>
            ) : null}
            {/* Workspace: the composer's default, listed first — picking it starts one run that
                reaches every registered project rather than one scoped to a single repo. `all`
                stays a search keyword so muscle memory from "All / Auto" still finds it. */}
            {workspaceMatches ? (
              <CommandItem
                value="workspace"
                keywords={['workspace', 'all', 'auto', 'every project']}
                data-slot="project-option"
                data-project-id="all"
                onSelect={() => {
                  onPick(null)
                  setOpen(false)
                }}
              >
                <span className="min-w-0 flex-1 truncate text-xs font-medium">Workspace</span>
                <span className="shrink-0 text-[11px] text-soft-foreground">one run, every project</span>
                {projectId === null ? (
                  <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
                ) : null}
              </CommandItem>
            ) : null}
            {matched.map((project) => (
              <CommandItem
                key={project.id}
                value={project.id}
                keywords={[project.name]}
                data-slot="project-option"
                data-project-id={project.id}
                // A `missing` folder has nothing to run a task in. The entry stays listed (the
                // sidebar owns removing it) but cannot be picked — better than navigating into
                // a project whose every request 4xxs.
                disabled={project.status === 'missing'}
                onSelect={() => {
                  onPick(project.id)
                  setOpen(false)
                }}
              >
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{project.name}</span>
                {project.status === 'missing' ? (
                  <span className="shrink-0 text-[11px] text-soft-foreground">folder not found</span>
                ) : project.branch !== undefined ? (
                  <span className="shrink-0 font-mono text-[11px] text-soft-foreground">
                    {project.branch}
                  </span>
                ) : null}
                {project.id === projectId ? (
                  <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
                ) : null}
              </CommandItem>
            ))}
          </CommandList>
          {/* The mockup's `dd-note`. Worth the two lines: picking here does far more than
              relabel a pill, and nothing else on screen says so. */}
          <p className="border-t border-border px-3 py-2 text-[11px] leading-snug text-soft-foreground">
            Skills, workflows, settings and the draft re-resolve against the selected project.
          </p>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/**
 * The workflow/skill picker (#385's searchable cmdk dropdown, #519's tier ordering): ONE pill
 * for both kinds of source. Groups render Most used (skills picked before, frequency
 * descending), Project skills (bold), Workflows, then Global.
 */
function SourcePill({
  source,
  ready,
  skills,
  skillUsage,
  workflows,
  onPick,
}: {
  /** `null` is None (2026-08-15) — the cold default; sends no `workflow`/`steps`, the server
   *  resolves the default workflow (`spec-to-deploy` since 2026-08-19). */
  source: TaskSource | null
  ready: boolean
  skills: readonly Skill[]
  skillUsage: Readonly<Record<string, number>> | undefined
  workflows: readonly WorkflowDef[]
  onPick: (source: TaskSource | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [preview, setPreview] = useState<Skill | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // #484: rank in JS (cmdk's own score-sort does not re-order reliably here), then split the
  // ranked matches into the #519 display tiers so each group stays match-ordered.
  const matched = searchSkills(skills, search, skillUsage)
  const { mostUsed, project, global } = partitionSkillsForDisplay(matched, skillUsage)
  const matchedWorkflows = searchWorkflows(workflows, search)
  // None participates in the same search box as everything else, rather than always showing —
  // an always-visible row would sit next to "Nothing matches." when a query excludes it too.
  const query = search.trim().toLowerCase()
  const noneMatches = query === '' || 'none'.includes(query)
  const nothingMatches =
    !noneMatches
    && mostUsed.length === 0
    && project.length === 0
    && global.length === 0
    && matchedWorkflows.length === 0
  const pick = (next: TaskSource | null) => {
    onPick(next)
    setOpen(false)
  }

  const skillItem = (skill: Skill, emphasized: boolean) => {
    const selected = source?.source === 'skill' && source.ref === skill.name
    return (
      <CommandItem
        key={skill.path}
        // The path suffix keeps values unique when a project skill shadows a global one.
        value={`skill ${skill.name} ${skill.path}`}
        keywords={skillKeywords(skill.name, skill.description)}
        data-slot="source-option"
        data-source-kind="skill"
        data-source-ref={skill.name}
        onSelect={() => pick({ source: 'skill', ref: skill.name })}
      >
        <span className={cn('shrink-0 font-mono text-xs', emphasized && 'font-semibold')}>
          {skill.name}
        </span>
        {skill.description ? (
          <span className="min-w-0 flex-1 truncate text-xs text-soft-foreground">
            {skill.description}
          </span>
        ) : null}
        {/* Read-only "View skill" (spec §Skills) — the Settings catalog's detail component
            as a dialog. stopPropagation: viewing must not pick the source. */}
        <button
          type="button"
          data-slot="source-skill-view"
          aria-label={`View skill ${skill.name}`}
          title="View skill"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setPreview(skill)
          }}
          className="ml-auto shrink-0 rounded-sm p-0.5 text-soft-foreground transition-colors hover:text-foreground"
        >
          <EyeIcon aria-hidden="true" className="size-3.5" />
        </button>
        {selected ? <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" /> : null}
      </CommandItem>
    )
  }

  return (
    <>
      <SkillPreviewDialog skill={preview} onClose={() => setPreview(null)} />
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setSearch('')
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            data-slot="source-pill"
            aria-label="Choose a skill or workflow"
            disabled={!ready}
            className={cn(chipClass, 'border-foreground/60 font-mono text-[11.5px] font-semibold text-foreground')}
          >
            {source === null ? (
              <WorkflowIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
            ) : source.source === 'skill' ? (
              <SparklesIcon aria-hidden="true" className="size-3 shrink-0 text-violet" />
            ) : (
              <WorkflowIcon aria-hidden="true" className="size-3 shrink-0 text-violet" />
            )}
            {/* `source.ref` is a SKILL name or a WORKFLOW name, so the workflow display mapping is
                applied only to the workflow case — a skill that happened to be called
                `spec-to-deploy` is a different thing and keeps its own name. Picker and pill must
                agree: they sit two clicks apart. */}
            <span className="max-w-44 truncate">
              {!ready
                ? '…'
                : source === null
                  ? 'None'
                  : source.source === 'workflow'
                    ? displayWorkflowName(source.ref)
                    : source.ref}
            </span>
            {chevron}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={8}
          className="w-[336px] max-w-[calc(100vw-2rem)] p-0"
        >
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="search skills & workflows…"
              value={search}
              onValueChange={setSearch}
              onInput={() => listRef.current?.scrollTo(0, 0)}
            />
            {/* The 3rem headroom is the CommandInput row: the popper's available-height var
                covers the whole popover, and the list must leave the search box visible. */}
            <CommandList
              ref={listRef}
              data-slot="source-menu"
              className="max-h-[min(18rem,calc(var(--radix-popover-content-available-height)-3rem))]"
            >
              {nothingMatches ? <CommandEmpty>Nothing matches.</CommandEmpty> : null}
              {/* None (2026-08-15): the cold default, listed first — picking it sends neither
                  `workflow` nor `steps`, and the server resolves the default workflow
                  (`spec-to-deploy` since 2026-08-19). Participates in the search box like
                  everything else rather than always showing, so it never sits next to "Nothing
                  matches." for a query that excludes it too. */}
              {noneMatches ? (
                <CommandItem
                  value="none"
                  data-slot="source-option"
                  data-source-kind="none"
                  onSelect={() => pick(null)}
                >
                  <span className="shrink-0 font-mono text-xs">None</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-soft-foreground">
                    Runs spec-to-deploy — no workflow or skill picked
                  </span>
                  {source === null ? (
                    <CheckIcon aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-primary" />
                  ) : null}
                </CommandItem>
              ) : null}
              {/* Most used leads (#519), then Project skills before Global — the closer a
                  skill lives to the repo, the more likely it's the one being picked. */}
              {mostUsed.length > 0 ? (
                <CommandGroup heading="Most used">
                  {mostUsed.map((skill) => skillItem(skill, isProjectSkill(skill)))}
                </CommandGroup>
              ) : null}
              {project.length > 0 ? (
                <CommandGroup heading="Project skills">
                  {project.map((skill) => skillItem(skill, true))}
                </CommandGroup>
              ) : null}
              {matchedWorkflows.length > 0 ? (
                <CommandGroup heading="Workflows">
                  {matchedWorkflows.map((workflow) => {
                    const selected = source?.source === 'workflow' && source.ref === workflow.name
                    return (
                      <CommandItem
                        key={workflow.name}
                        value={`workflow ${workflow.name}`}
                        keywords={skillKeywords(workflow.name, workflow.description)}
                        data-slot="source-option"
                        data-source-kind="workflow"
                        data-source-ref={workflow.name}
                        onSelect={() => pick({ source: 'workflow', ref: workflow.name })}
                      >
                        {/* Display text only. `value`, `keywords`, `data-source-ref` and the
                            `pick()` above all carry `workflow.name` — the identity the composer
                            posts and the draft persists. */}
                        <span className="shrink-0 font-mono text-xs">
                          {displayWorkflowName(workflow.name)}
                        </span>
                        {workflow.description ? (
                          <span className="min-w-0 flex-1 truncate text-xs text-soft-foreground">
                            {workflow.description}
                          </span>
                        ) : null}
                        {selected ? (
                          <CheckIcon aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-primary" />
                        ) : null}
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              ) : null}
              {global.length > 0 ? (
                <CommandGroup heading="Global">{global.map((skill) => skillItem(skill, false))}</CommandGroup>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </>
  )
}

/** Base-branch picker: worktrees fork from it and PRs target it. It is repo-level CONFIG
 *  (`PUT /api/config`, exactly the legacy Repo tab's picker), not a per-run flag — so it
 *  mutates the server and refetches, rather than living in the draft. Hidden without git. */
function BaseBranchPill({ repo }: { repo: RepoResponse }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (baseBranch: string | null) => putConfig({ baseBranch }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.repo })
      toast(
        result.baseBranch
          ? `New tasks will branch off "${result.baseBranch}" (PRs target it too).`
          : 'Base branch cleared — new tasks fork from the checked-out branch.',
      )
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  if (!repo.info) return null
  const current = repo.baseBranch ?? repo.info.branch
  return (
    <PickerPill
      slot="base-pill"
      ariaLabel="Base branch"
      label={<span className="font-mono text-[11.5px]">base: {current}</span>}
      value={repo.baseBranch ?? ''}
      onPick={(value) => mutation.mutate(value === '' ? null : value)}
      options={[
        { value: '', label: `follow checked-out branch (${repo.info.branch})`, desc: 'New task worktrees fork from whatever branch is checked out' },
        ...repo.branches.map((branch) => ({ value: branch, label: branch })),
      ]}
    />
  )
}

/** The `Start | Plan first` segment (#383): a real toggle with an UNMISTAKABLE selected state.
 *  "Start" selected keeps the quiet card fill; "Plan first" selected takes the mockup's
 *  contrast fill + focus ring (`.seg .plan-active`) — plan mode must never be ambient. The
 *  active plan segment doubles as the busy indicator while `POST /api/plan` is in flight. */
function ModeSegment({
  mode,
  planning,
  showBacklog,
  onModeChange,
}: {
  mode: NewTaskDraft['runMode']
  planning: boolean
  showBacklog: boolean
  onModeChange: (mode: NewTaskDraft['runMode']) => void
}) {
  return (
    <div
      data-slot="mode-seg"
      role="radiogroup"
      aria-label="Run mode"
      className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-[3px]"
    >
      <button
        type="button"
        role="radio"
        aria-checked={mode === 'start'}
        onClick={() => onModeChange('start')}
        className={cn(
          'h-6 rounded-md px-2 text-xs transition-colors',
          mode === 'start'
            ? 'bg-card font-semibold text-foreground shadow-xs'
            : 'font-medium text-muted-foreground hover:text-foreground',
        )}
      >
        Start
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={mode === 'plan'}
        aria-busy={planning || undefined}
        data-slot="mode-plan"
        onClick={() => onModeChange('plan')}
        className={cn(
          'h-6 rounded-md px-2 text-xs transition-colors',
          mode === 'plan'
            ? 'bg-contrast font-semibold text-contrast-foreground ring-2 ring-ring/55'
            : 'font-medium text-muted-foreground hover:text-foreground',
          planning && 'animate-pulse',
        )}
      >
        {planning ? 'Planning…' : 'Plan first'}
      </button>
      {showBacklog ? (
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'backlog'}
          onClick={() => onModeChange('backlog')}
          className={cn(
            'h-6 rounded-md px-2 text-xs transition-colors',
            mode === 'backlog'
              ? 'bg-card font-semibold text-foreground shadow-xs'
              : 'font-medium text-muted-foreground hover:text-foreground',
          )}
        >
          Backlog
        </button>
      ) : null}
    </div>
  )
}

/** Honest static starters (the mockup's ghost chips): they only fill the textarea — the user
 *  still aims and submits. */
const SUGGESTIONS = [
  'Fix a failing or flaky test',
  'Summarize recent commits on this branch',
  'Update the README for recent changes',
]

function SuggestedChips({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="mt-7 flex flex-wrap justify-center gap-2 max-md:justify-start">
      {SUGGESTIONS.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          data-slot="suggested-chip"
          onClick={() => onPick(suggestion)}
          className="inline-flex h-[30px] items-center gap-1.5 rounded-full border border-border px-3 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <SparklesIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
          {suggestion}
        </button>
      ))}
    </div>
  )
}
