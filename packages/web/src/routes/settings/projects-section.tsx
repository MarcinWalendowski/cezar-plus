import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FoldersIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

import { putWorkspaceConfig } from '@/api/client'
import {
  useProjects,
  useRemoveProject,
  useUpdateProject,
  useWorkspaceConfig,
  workspaceQueryKeys,
} from '@/api/queries'
import type { ProjectListEntry, ProjectsResponse, WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { SettingsField } from './settings-field'
import { listOrgTeams } from './teams-api'

/**
 * Global settings → Projects (multi-project spec, step 4.4; mockup
 * `settings-global.html`): the two things that describe the WORKSPACE rather than any one repo —
 * where "Clone from GitHub" puts new checkouts, and the registry itself.
 *
 * Two deliberate decisions live here:
 *
 * 1. **The checkout-root error is the server's, verbatim.** Writability is decided by the
 *    `PUT /api/workspace/config` probe (step 2.7: `mkdir -p`, `access W_OK`, then a real
 *    create/delete round-trip, because W_OK alone lies on a read-only mount). The client cannot
 *    reproduce that from a browser and must not pretend to: this pane renders the 400's `{ error }`
 *    string inline under the field ("not writable: …"), never a generic "invalid path". The one
 *    thing checked locally is emptiness, because an empty field isn't a request worth sending.
 *
 * 2. **Remove only ever DEREGISTERS.** No files are deleted, ever — not the repo, not its tasks,
 *    not its worktrees (`DELETE /api/projects/:id` is a registry filter; see the route). The
 *    button, the confirm title, the confirm body and the section hint all say so, because
 *    "Remove" next to a project path is exactly the kind of button a user reads as "delete my
 *    repo". A project with running tasks is refused server-side with a 409, whose message this
 *    pane surfaces as a toast.
 *
 * The `missing` row (a registered folder that has been deleted or moved) is why the remove
 * affordance lives here rather than in the sidebar: the sidebar greys it out, this is where the
 * user can act on it.
 */

/**
 * Team filtering (D5, spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`, phases 5/5c): "Team
 * is metadata on a project used for grouping and filtering, NOT a scope." No URL segment, no
 * route change — this reads `teamId`/`teamName` off the SAME `GET /api/v1/projects` entry every
 * other column already reads, and filters client-side.
 *
 * `teamId`/`teamName` are optional on `ProjectListEntry` (`packages/contract/src/projects.ts`) and
 * populated by `GET /api/v1/projects` only for a root the caller's own org has claimed. With
 * `CEZ_AUTH` unset the server never reads the identity store at all, so every project comes back
 * with neither — which is exactly the state that must render with no filter and no board change.
 * Read through this one helper rather than at each use site, so "has a team" is decided once.
 */
function teamOf(project: ProjectListEntry): { id: string; label: string } | null {
  if (!project.teamId) return null
  return { id: project.teamId, label: project.teamName ?? project.teamId }
}

/**
 * Phase 5c: now that an org can hold more than its one original default team (5c's create/rename
 * surface), `teamOptions` deriving purely from `teamOf` above — i.e. only teams a REGISTERED
 * PROJECT already carries — undercounts. A freshly-created, still-empty team (D2's examples,
 * `engineering` / `marketing`) could never be offered as something to filter by, which is the gap
 * `RegistryTable`'s `teamOptions` closes below by also reading the org's full roster from
 * `GET /auth/teams` (`teams-api.ts`).
 *
 * A soft query, deliberately: `listOrgTeams` already folds `CEZ_AUTH` unset into `[]` (the SPA
 * catch-all, non-JSON, is not an error), and a genuine failure here (network, 5xx) is left
 * un-retried and simply contributes no extra options rather than blocking or erroring the whole
 * pane — `registry.projects` (and the `teamOf`-derived options already proven at phase 5) render
 * regardless of whether this call ever resolves. Not in `@/api/queries`'s shared registry: like
 * `onboarding.tsx#useOnboardingProbe`, nothing else in the cockpit reads org teams, so a local key
 * avoids adding a workspace-wide query the rest of the app never touches.
 */
function useOrgTeams() {
  return useQuery({
    queryKey: ['settings', 'org-teams'] as const,
    queryFn: ({ signal }) => listOrgTeams(signal),
    retry: false,
  })
}

/** Which project the confirm dialog is about — `null` while it is closed. */
type Confirming = ProjectListEntry | null

/** Per-project concurrency bounds — mirror the workspace cap (resources-section.tsx). */
const MAX_PARALLEL_MIN = 1
const MAX_PARALLEL_MAX = 16

/** Human wording for a registry status probe. `not-git` is fully usable (single-queue
 *  degraded mode), so it reads as a note rather than a fault; only `missing` is a problem. */
const STATUS_LABEL: Record<ProjectListEntry['status'], string> = {
  ok: 'ok',
  'not-git': 'no git repo',
  missing: 'folder not found',
}

/** `2026-07-20T…` → `Jul 20`, in the reader's locale. Registry timestamps are ISO strings; an
 *  unparseable one (hand-edited config) degrades to an em dash rather than `Invalid Date`. */
function shortDate(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function ProjectsSection() {
  const config = useWorkspaceConfig()
  const projects = useProjects()

  if (config.isPending || projects.isPending) {
    return (
      <p data-slot="projects-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading projects…
      </p>
    )
  }
  if (config.isError || projects.isError) {
    return (
      <CenteredState
        icon={<FoldersIcon />}
        tone="danger"
        title="Project settings did not load"
        subtitle={(config.error ?? projects.error)?.message}
        heading="h2"
      />
    )
  }
  return <ProjectsPane config={config.data} registry={projects.data} />
}

function ProjectsPane({
  config,
  registry,
}: {
  config: WorkspaceConfigResponse
  registry: ProjectsResponse
}) {
  return (
    <div
      data-slot="projects-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <WorkspaceRootField
        configKey="browseRoot"
        value={config.browseRoot}
        title="Default browse folder"
        hint="Where “Open local folder…” starts. The picker cannot navigate above this folder."
        placeholder="~/"
        slot="browse"
        savedLabel="Browse folder"
        footer="Only affects folder browsing; GitHub checkouts use the separate checkout folder."
      />
      <WorkspaceRootField
        configKey="projectsDir"
        value={config.projectsDir}
        title="Default checkout folder"
        hint="Where “Clone from GitHub” puts new projects: <folder>/<project name>."
        placeholder="~/cezar/projects"
        slot="checkout"
        savedLabel="Checkout folder"
        footer="Only affects new checkouts; projects already registered keep their location."
        refreshProjects
      />
      <RegistryTable registry={registry} workspaceMax={config.resources.maxParallel} />
    </div>
  )
}

/** A workspace folder — edited locally, saved explicitly, and validated by the SERVER. */
function WorkspaceRootField({
  configKey,
  value: configuredValue,
  title,
  hint,
  placeholder,
  slot,
  savedLabel,
  footer,
  refreshProjects = false,
}: {
  configKey: 'browseRoot' | 'projectsDir'
  value: string
  title: string
  hint: string
  placeholder: string
  slot: 'browse' | 'checkout'
  savedLabel: string
  footer: string
  refreshProjects?: boolean
}) {
  const queryClient = useQueryClient()
  // The merged config the PUT answers with lands straight in the workspace-config query. The
  // projects response carries projectsDir for the clone dialog, while every fs-browse result is
  // relative to browseRoot. Invalidate the corresponding authoritative cache after either save.
  const save = useMutation({
    mutationFn: (next: string) =>
      putWorkspaceConfig(configKey === 'browseRoot' ? { browseRoot: next } : { projectsDir: next }),
    onSuccess: (result) => {
      queryClient.setQueryData(workspaceQueryKeys.config, result)
      if (configKey === 'browseRoot') {
        void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.fsBrowseRoot })
      } else if (refreshProjects) {
        void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.projects })
      }
    },
  })
  const [value, setValue] = useState(configuredValue)
  const trimmed = value.trim()
  const unchanged = trimmed === configuredValue
  // The 400's message ("not writable: …"), shown until the next attempt. `save.error` is the
  // ApiError `errorFor` built from the server's own `{ error }` — passed through untouched,
  // because paraphrasing "permission denied on /opt/checkouts" as "invalid path" throws away
  // the only sentence that tells the user what to fix.
  const serverError = save.isError ? save.error.message : null

  return (
    <SettingsField
      title={title}
      hint={`${hint} ${
        configKey === 'browseRoot'
          ? 'Choose an existing folder; it is verified writable before saving.'
          : 'The folder is created recursively if needed, then verified writable before saving.'
      }`}
    >
      <div className="flex items-center gap-2">
        <input
          type="text"
          spellCheck={false}
          aria-label={title}
          aria-invalid={serverError !== null}
          data-slot={`projects-${slot}-root`}
          value={value}
          disabled={save.isPending}
          placeholder={placeholder}
          onChange={(event) => {
            setValue(event.target.value)
            // Editing clears the stale failure: the message names a path that is no longer in
            // the field, so leaving it up would be a lie about the current value.
            if (save.isError) save.reset()
          }}
          className="block w-full max-w-sm rounded-md border border-input bg-card px-3 py-1.5 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-danger disabled:opacity-50"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-action={`projects-save-${slot}-root`}
          disabled={unchanged || trimmed === '' || save.isPending}
          onClick={() =>
            save.mutate(trimmed, { onSuccess: () => toast(`${savedLabel} set to ${trimmed}`) })
          }
        >
          Save
        </Button>
      </div>
      {serverError !== null ? (
        // The mockup's error line: the reason, then what did NOT happen — a failed probe
        // persists nothing, and saying so stops the reader wondering which value is live.
        <p data-slot={`projects-${slot}-root-error`} role="alert" className="text-[11px] text-danger">
          {serverError} — setting unchanged
        </p>
      ) : (
        <p className="text-[11px] text-soft-foreground">
          {footer}
        </p>
      )}
    </SettingsField>
  )
}

function RegistryTable({
  registry,
  workspaceMax,
}: {
  registry: ProjectsResponse
  workspaceMax: number
}) {
  const [confirming, setConfirming] = useState<Confirming>(null)
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null)
  const remove = useRemoveProject()
  const orgTeams = useOrgTeams()

  // The filter's whole option set: the org's REAL team roster (`GET /auth/teams`, so an
  // as-yet-empty team is selectable), unioned with any team a registered project carries that the
  // org list somehow missed — belt-and-suspenders for a query that failed or hasn't resolved yet,
  // never a second source of truth (both name the same team the same way when they agree). Empty
  // under `CEZ_AUTH` unset, and empty for any deployment with exactly its one original team — no
  // data means no filter, never an empty dropdown.
  const teamOptions = useMemo(() => {
    const byId = new Map<string, string>()
    for (const team of orgTeams.data ?? []) byId.set(team.id, team.name)
    for (const project of registry.projects) {
      const team = teamOf(project)
      if (team && !byId.has(team.id)) byId.set(team.id, team.label)
    }
    return Array.from(byId, ([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label))
  }, [registry.projects, orgTeams.data])

  // A selection that no longer names a team actually present (its last project was removed, or
  // reassigned) is treated as cleared rather than filtering everything away — the alternative is
  // a "no projects on this team" message the reader has no visible control left to undo, since
  // the whole filter disappears in the same render once `teamOptions` is empty.
  const effectiveTeamId =
    selectedTeamId !== null && teamOptions.some((team) => team.id === selectedTeamId) ? selectedTeamId : null

  const visibleProjects =
    effectiveTeamId === null
      ? registry.projects
      : registry.projects.filter((project) => teamOf(project)?.id === effectiveTeamId)

  // Phase 5c: the reassignment picker's own gate is the SAME `teamOptions.length > 0` signal the
  // filter row above already uses — no team data (CEZ_AUTH unset, or a genuinely team-less org)
  // means no column, not a column full of dashes. This is what makes the picker "invisible", not
  // merely disabled, under CEZ_AUTH unset (this file's own module doc comment on `teamOf`).
  const showTeamColumn = teamOptions.length > 0

  const confirmRemoval = () => {
    if (!confirming) return
    const { id, name } = confirming
    setConfirming(null)
    remove.mutate(id, {
      // "Removed from the workspace", not "Deleted": the toast is the last word the user reads
      // about a button they may have pressed nervously.
      onSuccess: () => toast(`${name} removed from the workspace — its files are untouched`),
      // The 409s (running tasks, the boot project) explain themselves; show the server's words.
      onError: (error: Error) => toast(error.message, { tone: 'danger' }),
    })
  }

  return (
    <SettingsField
      title="Registered projects"
      hint={`Every folder cezar has run in, plus the ones added from the GUI. “Max parallel” caps how many of that project's tasks run at once; the workspace limit (${workspaceMax}) still applies as an overall ceiling, so a per-project value above it has no extra effect until the workspace limit is raised. Removing a project only unregisters it — no files on disk are deleted.`}
    >
      {teamOptions.length > 0 ? (
        <div className="mb-2 flex items-center gap-2">
          <label htmlFor="project-team-filter" className="text-[12px] text-soft-foreground">
            Team
          </label>
          <select
            id="project-team-filter"
            data-slot="project-team-filter"
            aria-label="Filter projects by team"
            value={effectiveTeamId ?? ''}
            onChange={(event) => setSelectedTeamId(event.target.value === '' ? null : event.target.value)}
            className="block w-48 rounded-md border border-input bg-card px-2 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <option value="">All teams</option>
            {teamOptions.map((team) => (
              <option key={team.id} value={team.id}>
                {team.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {registry.projects.length === 0 ? (
        <p data-slot="projects-empty" className="text-[13px] text-soft-foreground">
          No projects registered yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Projects registered in this workspace</caption>
            <thead>
              <tr className="border-b border-border text-left text-[12px] text-soft-foreground">
                <th scope="col" className="px-3 py-2 font-medium">Project</th>
                <th scope="col" className="px-3 py-2 font-medium">Status</th>
                <th scope="col" className="px-3 py-2 font-medium">Max parallel</th>
                {showTeamColumn ? <th scope="col" className="px-3 py-2 font-medium">Team</th> : null}
                <th scope="col" className="px-3 py-2 font-medium">Added</th>
                <th scope="col" className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleProjects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  isBoot={project.id === registry.bootProject}
                  workspaceMax={workspaceMax}
                  disabled={remove.isPending}
                  onRemove={() => setConfirming(project)}
                  teamOptions={showTeamColumn ? teamOptions : null}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {confirming?.name} from the workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              This only unregisters the project — <strong>nothing on disk is deleted</strong>. The
              folder, its git history and its task history all stay exactly where they are, and
              opening it again re-registers it with everything intact.
              <span className="mt-1 block truncate font-mono text-[11px] text-foreground" title={confirming?.root}>
                {confirming?.root}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              data-action="projects-confirm-remove"
              className="bg-danger text-danger-foreground hover:brightness-[0.96]"
              onClick={confirmRemoval}
            >
              Remove from list
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsField>
  )
}

function ProjectRow({
  project,
  isBoot,
  workspaceMax,
  disabled,
  onRemove,
  teamOptions,
}: {
  project: ProjectListEntry
  isBoot: boolean
  workspaceMax: number
  disabled: boolean
  onRemove: () => void
  /** `null` when `RegistryTable` decided the Team column itself is not shown (no team data at
   *  all — CEZ_AUTH unset, this file's own inertness contract). Non-null, including `[]`, means
   *  the column IS rendered; see `TeamPicker`'s own comment for why a `[]` case can't actually
   *  happen given how `RegistryTable` derives it. */
  teamOptions: { id: string; label: string }[] | null
}) {
  return (
    <tr data-slot="project-row" data-project={project.id} className="border-b border-border last:border-0">
      <th scope="row" className="max-w-[260px] px-3 py-2 text-left font-normal">
        <span className="block truncate text-foreground">{project.name}</span>
        <span className="block truncate font-mono text-[11px] text-soft-foreground" title={project.root}>
          {project.root}
        </span>
      </th>
      <td className="px-3 py-2">
        <span
          data-slot="project-status"
          className={project.status === 'missing' ? 'text-[12px] text-danger' : 'text-[12px] text-soft-foreground'}
        >
          {STATUS_LABEL[project.status]}
        </span>
        {project.status !== 'missing' ? (
          <span className="ml-1 text-[11px] text-soft-foreground">· {project.source}</span>
        ) : null}
        {teamOf(project) ? (
          <span data-slot="project-team" className="ml-1 text-[11px] text-soft-foreground">
            · {teamOf(project)!.label}
          </span>
        ) : null}
      </td>
      <td className="px-3 py-2">
        <MaxParallelSelect project={project} workspaceMax={workspaceMax} />
      </td>
      {teamOptions ? (
        <td className="px-3 py-2">
          <TeamPicker project={project} teamOptions={teamOptions} />
        </td>
      ) : null}
      <td className="px-3 py-2 tabular-nums text-soft-foreground">{shortDate(project.addedAt)}</td>
      <td className="px-3 py-2 text-right">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-action="project-remove"
          // Names the gesture precisely for a screen reader, where the row context that makes a
          // bare "Remove" safe-sounding isn't read out with it.
          aria-label={`Unregister ${project.name} (no files are deleted)`}
          // The boot project is refused server-side too (it re-registers itself at every start);
          // disabling here means the user gets the explanation before the click, not after.
          title={isBoot ? 'cezar is serving this project — it re-registers itself at every start' : undefined}
          disabled={disabled || isBoot}
          onClick={onRemove}
        >
          Remove
        </Button>
      </td>
    </tr>
  )
}

/**
 * Per-project team reassignment (D2/D4, Phase 5c: "a project can be moved between two real
 * teams" — spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`'s own phase-table wording).
 * The write side of this was already wired end to end before this pane existed:
 * `identity-store.ts#updateProjectTeam`, `PATCH /api/v1/projects/:projectId`'s `teamId` field,
 * `client.ts#updateProject`, `useUpdateProject` — this component is the one piece that was
 * missing, a control that actually calls it.
 *
 * Mirrors `MaxParallelSelect` immediately below: bound straight to the server value
 * (`project.teamId`), saved on change, and `useUpdateProject`'s shared `onSuccess` (queries.ts)
 * invalidates the projects list so a successful move re-renders every row — including the
 * static `project-team` badge above, which is left untouched by this file (see `RegistryTable`'s
 * own comment on why the column is additive rather than a replacement).
 *
 * **No client-side role check.** D12 gates team reassignment to `owner`/`admin`, and this pane
 * does not try to guess that client-side — same "no local admin probe" choice
 * `teams-panel.tsx`'s create/rename form already makes: a `member` sees the same picker an
 * `owner`/`admin` does and would learn the boundary from the server's own refusal, surfaced here
 * as an error toast rather than a silently-reverted select. **As of this pass `PATCH
 * /api/v1/projects/:projectId`'s `teamId` branch (`server.ts`) has no such check — it only
 * verifies same-org via `mayActOnRoot`, not role — so today a `member` CAN reassign a project's
 * team.** That is a gap against D12's own text, not a decision this file makes: `server.ts` is
 * outside this unit's ownership (team CRUD store+HTTP is a different Fill unit), so it is reported
 * rather than fixed here. This component is written for the D12-compliant server it should be
 * talking to — see `describe("reassigning a project's team...")`'s own 403 test in this file's
 * test twin, which exercises the CLIENT's handling of a refusal without claiming the server sends
 * one today.
 *
 * **`teamOptions` is never actually empty when this renders.** `RegistryTable` only mounts this
 * column at all when `teamOptions.length > 0`, and that array always contains THIS project's own
 * team when it has one (unioned in via `teamOf(project)`) — so the value bound to `<select>` is
 * always one of its own `<option>`s. A project with no team yet (`project.teamId === undefined` —
 * a legacy root claimed before this org had more than its default team) has nothing to reassign:
 * `updateProjectTeam`'s own docblock is explicit that it moves an EXISTING claim rather than
 * creating one, so that row renders a plain dash instead of a select with no correct starting
 * value.
 */
function TeamPicker({
  project,
  teamOptions,
}: {
  project: ProjectListEntry
  teamOptions: { id: string; label: string }[]
}) {
  const update = useUpdateProject()
  if (project.teamId === undefined) {
    return <span className="text-[12px] text-soft-foreground">—</span>
  }
  const currentTeamId = project.teamId
  return (
    <select
      aria-label={`Team for ${project.name}`}
      data-slot="project-team-picker"
      value={currentTeamId}
      disabled={update.isPending}
      onChange={(event) => {
        const next = event.target.value
        if (next === currentTeamId) return
        const label = teamOptions.find((team) => team.id === next)?.label ?? next
        update.mutate(
          { id: project.id, teamId: next },
          {
            onSuccess: () => toast(`${project.name} moved to ${label}`),
            onError: (error: Error) => toast(error.message, { tone: 'danger' }),
          },
        )
      }}
      className="block w-40 rounded-md border border-input bg-card px-2 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
    >
      {teamOptions.map((team) => (
        <option key={team.id} value={team.id}>
          {team.label}
        </option>
      ))}
    </select>
  )
}

/**
 * Per-project "Max parallel tasks" selector (spec 2026-07-22). `Inherit
 * workspace (N)` is the unset default; `1..16` pins a per-project ceiling.
 * Bound directly to the server value (`project.maxParallel`) and saved on
 * change, mirroring the workspace `Max parallel` control (resources-section.tsx)
 * — a failed save reverts because the value never leaves the server's, and the
 * hook invalidates the projects query so a success re-renders the row. The
 * workspace cap still clamps at runtime, which the section hint explains.
 */
function MaxParallelSelect({
  project,
  workspaceMax,
}: {
  project: ProjectListEntry
  workspaceMax: number
}) {
  const update = useUpdateProject()
  // `''` is the inherit sentinel; a number is an explicit per-project ceiling.
  const value = project.maxParallel === undefined ? '' : String(project.maxParallel)
  return (
    <select
      aria-label={`Max parallel tasks for ${project.name}`}
      data-slot="project-max-parallel"
      value={value}
      disabled={update.isPending}
      onChange={(event) => {
        const raw = event.target.value
        const next = raw === '' ? null : Number(raw)
        update.mutate(
          { id: project.id, maxParallel: next },
          {
            onSuccess: () =>
              toast(
                next === null
                  ? `${project.name} inherits the workspace limit (${workspaceMax})`
                  : `${project.name} runs at most ${next} task${next === 1 ? '' : 's'} at a time`,
              ),
            onError: (error: Error) => toast(error.message, { tone: 'danger' }),
          },
        )
      }}
      className="block w-44 rounded-md border border-input bg-card px-2 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
    >
      <option value="">Inherit workspace ({workspaceMax})</option>
      {Array.from(
        { length: MAX_PARALLEL_MAX - MAX_PARALLEL_MIN + 1 },
        (_, i) => i + MAX_PARALLEL_MIN,
      ).map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  )
}
