import { type ReactNode } from 'react'
import { useLocation } from 'react-router'

import {
  useHealth,
  useProjectRuns,
  useProjects,
  useRuns,
  useSkillsUpdate,
  useTodos,
} from '@/api/queries'
import type { HealthResponse, SkillsUpdateState } from '@open-mercato/cezar-api-client'
import { AppShell, type RepoChip } from '@/components/app-shell'
import { CommandPalette } from '@/components/command-palette'
import { ListViewProvider } from '@/components/list-view'
import { ProviderBannerContainer } from '@/components/provider-banner-container'
import { ProjectGroups } from '@/components/project-groups'
import { TaskQuickListContainer } from '@/components/task-quick-list'
import { ToolsMenu } from '@/components/tools-menu'
import { useDocumentTitle } from '@/lib/use-document-title'
import { useActiveProjectId } from '@/lib/project-router'
import { unreadDoneCount } from '@/lib/read-state'
import { runTitle } from '@/lib/task-groups'
import { pageTitleContext } from '@/routes'
import { needsOnboardingGate, useOnboardingEntryProbe } from '@/routes/onboarding/onboarding-gate'

/**
 * Derive the sidebar's repo chip from `/api/health`.
 *
 * Null — the chip renders nothing — whenever there is nothing true to say: health hasn't
 * answered yet, or cezar is running outside a git repository (`repo: null`), which is a
 * supported way to run it. An empty chip is honest; "loading…" or a guessed folder name is not.
 *
 * The name is the repo root's basename: `/home/me/Projects/cezar` → `cezar`. Both separators,
 * because the server sends whatever path git gave it, and a trailing one is stripped first so
 * `/repo/` doesn't chip as an empty string.
 */
export function repoChipOf(health: HealthResponse | undefined): RepoChip | null {
  const repo = health?.repo
  if (!repo) return null
  const name = repo.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  if (!name) return null
  return { name, branch: repo.branch }
}

/** Only a checked, still-actionable result earns chrome. An update failure may retain a proven
 * available scope, so keep that signal; all unknown/transient/degraded states stay quiet. */
export function skillsUpdateMarkerOf(state: SkillsUpdateState | undefined): boolean {
  return state?.available === true && (state.status === 'available' || state.status === 'error')
}

/**
 * The app shell, wired to live data.
 *
 * AppShell itself stays presentational — it takes repo/version/inboxCount and renders them, or
 * renders nothing. This is the seam where those become real: `useHealth()` for the repo and
 * version chips, `useTodos()` for the inbox badge.
 *
 * Nothing here caches boot-time values (#369: the legacy UI read the branch once at startup and
 * then showed a stale branch forever). The chips read whatever is currently in the health query,
 * so keeping them live is `useHealth`'s job — its poll plus Step 3.2's reconnect/visibility
 * reconcile — not a change here.
 *
 * **D14 (`.ai/specs/2026-08-06-org-team-auth-onboarding.md`): the sidebar/nav/banner/command
 * palette are all suppressed while the shared onboarding probe (`onboarding-gate.ts`) answers
 * `needs-org`** — "no dashboard element renders before the first organization exists." `children`
 * (`<AppRoutes/>`, ultimately `<OnboardingRoute/>` once `routes.tsx#OnboardingEntryGate` has
 * navigated there) is passed to `<AppShell>` UNCONDITIONALLY either way — only `chromeless` and
 * the slot props change — because toggling whether `<AppShell>` wraps `children` at ALL would
 * change `children`'s position in the tree and force React to unmount and remount it. That would
 * lose `OnboardingRoute`'s own local wizard-step state (`onboarding.tsx`'s `wizard`) the instant
 * the org is created and the probe's cached answer moves past `needs-org` — landing the user back
 * on the org-naming step mid-wizard instead of the next one. Keeping `<AppShell>` mounted and only
 * varying its `chromeless` prop (which itself preserves `<main>{children}</main>`'s position, see
 * that component's own doc comment) avoids the remount entirely.
 */
export function AppShellContainer({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const onboardingProbe = useOnboardingEntryProbe()
  const chromeless = needsOnboardingGate(onboardingProbe.data)
  const projectId = useActiveProjectId()
  const health = useHealth()
  // The global inbox is opt-in (#471). With the capability off there is no Inbox nav item to
  // badge and the endpoint can only answer [], so the query parks rather than polls.
  const inboxAvailable = health.data?.capabilities.followups === true
  // GitHub automations are opt-in too (#801) — same honesty rule: without the server's word for
  // it the nav must not offer a tab whose every request would 409.
  const automationsAvailable = health.data?.capabilities.automations === true
  const todos = useTodos(inboxAvailable)
  // One query in the shell feeds every rendering of the active project's navigation (desktop,
  // mobile drawer, and grouped sidebar). Routes reuse this TanStack Query cache entry.
  const skillsUpdate = useSkillsUpdate(projectId ?? '', projectId !== null)
  const skillsUpdateAvailable = skillsUpdateMarkerOf(skillsUpdate.data)
  // Unread done items (#unread-done-items) for the Tasks badge. Reads the same active-scope run
  // list the sidebar quick-list and Tasks table already hold — one cache entry, no extra fetch.
  const runs = useRuns()
  const registry = useProjects().data
  const titleContext = pageTitleContext(pathname)
  const bootProjectId = registry?.bootProject ?? health.data?.bootProject ?? null
  const isBootProject = projectId !== null && projectId === bootProjectId
  const activeProject = registry?.projects.find((project) => project.id === projectId)

  /**
   * **FIXED 2026-08-07 (D15 follow-up, reported from the running app).** This chip used to be
   * `repoChipOf(health.data)` unconditionally — and `health.repo` describes the directory cezar
   * was LAUNCHED in, never the project you are looking at. Before D15 that was almost always the
   * same thing, because boot auto-registered the launch directory as a project; D15 stopped doing
   * that, and the conflation became a visible lie: a cockpit showing project `black` (at
   * `~/cezar/projects/black`) captioned `cezar / feat/knowledge-base-central-hub`, naming a repo
   * that is not even in the registry. The owner's words: "why there is cezar /
   * feat/knowledge-base-central-hub".
   *
   * The registry entry is the authority — it carries this project's own `name` and `branch`
   * (`contract/src/projects.ts`) — and health is the fallback only when there is no active
   * project to describe (global settings, an unknown id, a registry that has not answered).
   */
  const activeRepoChip = activeProject
    ? { name: activeProject.name, ...(activeProject.branch ? { branch: activeProject.branch } : {}) }
    : repoChipOf(health.data)
  const titleRuns = useProjectRuns(
    projectId ?? '',
    // Wait for the registry to identify the project before choosing the boot/non-boot cache
    // key. Health can arrive first; fetching then would briefly populate a project-scoped key
    // for the boot project before switching to the authoritative `default` key.
    activeProject !== undefined && titleContext.taskId !== null,
    registry?.bootProject === projectId,
  ).data

  // Global settings intentionally has no selected project. Everywhere else the URL id selects
  // the authoritative registry entry; health may name only the CONFIRMED boot project while
  // the registry is unavailable, never a non-boot project whose root health does not describe.
  const globalSettings = pathname === '/settings/global' || pathname.startsWith('/settings/global/')
  const projectName = globalSettings
    ? null
    : (activeProject?.name ??
      (isBootProject ? (repoChipOf(health.data)?.name ?? null) : null))
  const titleRun = titleContext.taskId
    ? titleRuns?.find((run) => run.id === titleContext.taskId)
    : undefined
  const pageLabel = titleRun ? runTitle(titleRun) : titleContext.pageLabel

  useDocumentTitle({ projectName, pageLabel })

  // Multi-project sidebar only from the SECOND project on (multi-project spec, "Sidebar").
  // With one registered project — or with the registry still loading, or unreachable — the
  // group header would say nothing the repo chip does not already say, so the shell keeps the
  // flat nav + single quick-list it has always had. That degenerate case is the upgrade path:
  // an existing user boots the new version in their usual repo and sees no difference.
  const projects = registry && registry.projects.length > 1 ? registry : null

  return (
    // The Active/Archived filter is shared by the quick-list below and the Tasks table (Step 3.4),
    // which renders in `children`. The provider goes here because this is the lowest node that has
    // both of them under it — the spec requires the two sets of tabs to be one filter.
    <ListViewProvider>
      <AppShell
        repo={activeRepoChip}
        version={health.data?.version ?? null}
        latestVersion={health.data?.latestVersion ?? null}
        // `?? null` rather than `?? 0`: no badge while the inbox is unknown, and no badge when it
        // is known to be empty — AppShell renders neither for a falsy count.
        inboxCount={todos.data?.length ?? null}
        // Same `?? null` honesty: no badge while the list is unknown; a loaded list with none
        // unread is 0, which AppShell also renders as no badge.
        unreadCount={runs.data ? unreadDoneCount(runs.data) : null}
        skillsUpdateAvailable={skillsUpdateAvailable}
        // Hidden until health confirms the forge driver (R6 Step 1.1) — same honesty rule as
        // the chips: the nav must not claim a GitHub tab it cannot back. The Tools menu's
        // forge note says why it is absent.
        forgeAvailable={health.data?.forge?.available === true}
        // Hidden unless health reports the opt-in inbox (#471) — same honesty rule as above:
        // the nav must not offer an Inbox this server will never fill.
        inboxAvailable={inboxAvailable}
        // Central-hub scaffold (`.ai/runs/2026-08-06-cezar-central-hub/PLAN.md`, F1/F3): same
        // honesty rule — hidden unless health reports the opt-in capability.
        knowledgeAvailable={health.data?.capabilities.knowledge === true}
        notesAvailable={health.data?.capabilities.notes === true}
        // `!== false`, not `=== true`: an older server that reports no `skills` key at all
        // must keep its Skills tab. Only an explicit `false` removes it.
        skillsAvailable={health.data?.capabilities.skills !== false}
        // Hidden unless health reports the opt-in automations capability (#801).
        automationsAvailable={automationsAvailable}
        banner={<ProviderBannerContainer />}
        singleProject={health.data?.capabilities.singleProject === true}
        taskQuickList={<TaskQuickListContainer />}
        // Present only in a multi-project workspace; `AppShell` renders the flat nav and the
        // quick-list above whenever this slot is absent.
        projectGroups={
          projects ? (
            <ProjectGroups
              projects={projects.projects}
              bootProjectId={projects.bootProject}
              // No forge prop: each group gates its own GitHub tab on its registry entry's
              // `forge` field (#698) — the boot folder's health-level answer says nothing
              // about the other projects in the workspace.
              inboxAvailable={inboxAvailable}
              automationsAvailable={automationsAvailable}
              // The same value `AppShell` gets above, and it has to be passed twice: the shell's
              // own copy gates the workspace band, this one gates every project group's nav.
              // Omitting it here is the bug this prop was added for — the gate defaults to
              // `false`, so Knowledge silently vanished from every group.
              knowledgeAvailable={health.data?.capabilities.knowledge === true}
              // Passed so the `workspace: true` filter is what keeps Notes out of the groups,
              // rather than a capability that happened to default off — see the prop's own note.
              notesAvailable={health.data?.capabilities.notes === true}
              inboxCount={todos.data?.length ?? null}
              skillsUpdateAvailable={skillsUpdateAvailable}
            />
          ) : undefined
        }
        toolsMenu={<ToolsMenu health={health.data} />}
        chromeless={chromeless}
      >
        {children}
      </AppShell>
      {/* Global chrome, not a route: ⌘K must work on every URL — except D14's gated onboarding,
          where there is no dashboard to jump to yet (`chromeless`, above). Mounted here (not in
          AppShell) because it needs the query client and router this container already assumes. */}
      {chromeless ? null : <CommandPalette />}
    </ListViewProvider>
  )
}
