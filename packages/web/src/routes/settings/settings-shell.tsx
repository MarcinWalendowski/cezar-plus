import { ChevronRightIcon, SlidersHorizontalIcon } from 'lucide-react'
import { Link, NavLink } from 'react-router'

import { ProjectScopeProvider } from '@/api/project-scope-context'
import { cn } from '@/lib/utils'
import { ProjectLocationNav } from './project-location'
import {
  visibleSettingsSections,
  type SettingsCapabilities,
  type SettingsSection,
} from './registry'
import {
  SettingsProjectRequired,
  SettingsProjectSelector,
  useSettingsProject,
} from './settings-project'

/**
 * The registry-driven Settings shell (R6 Step 1.3, spec §"Settings").
 *
 * Layout, both driven by the same `visibleSettingsSections()` so they can never disagree:
 *  - desktop (`md:`): a left section nav beside the section's content;
 *  - mobile: a segmented pill row above the content (the area index renders the stacked
 *    section list instead — the drill-in page small screens expect).
 *
 * **ONE area since `.ai/specs/2026-08-21-one-settings-area.md`.** This shell used to take a
 * `scope` prop and serve two areas — `/p/<id>/settings/…` and `/settings/global/…` — with plain
 * router links in one and the project-prefixing `@/lib/project-router` wrappers in the other.
 * Both are gone. Every settings URL is `/settings/<id>`, so every link here is a plain
 * react-router link, and a section that needs a project takes it from `?project=` rather than
 * from the path.
 *
 * That leaves one piece of plumbing: a `per-project` section sits outside `ProjectScopeRoute` and
 * still has to address the SELECTED project's API. It gets a `ProjectScopeProvider` of its own
 * around its body (`SettingsSectionRoute` below) — the same provider `/p/:projectId` mounts, so
 * every existing hook (`useConfig`, `useRepo`, `useActiveProjectId`, …) keeps working unchanged,
 * against `/api/v1/p/<selected>/…` and under that project's query keys. No second client, no
 * per-section explicit-id variants of a dozen query hooks.
 *
 * Every section is its own URL, so the h1 is the SECTION title — that is what the page is
 * about; "Settings" is the area. Hidden registry entries are not routed, so their URLs are
 * honest 404s until the section ships.
 *
 * Both navs lead with an "All settings" entry pointing at the area INDEX. It is not a registry
 * section — it has no settings of its own — but without it the index is a page you can only reach
 * by arriving.
 */

/** The area's URL root — also what `SettingsSkillsRedirect` and the legacy redirects target.
 *  `projectId` preselects a `per-project` section's subject; omit it for *All projects*. */
export function settingsSectionPath(
  id: SettingsSection['id'],
  projectId?: string | null,
): string {
  const base = `/settings/${id}`
  return projectId ? `${base}?project=${encodeURIComponent(projectId)}` : base
}

export function settingsIndexPath(): string {
  return '/settings'
}

/** Carry the current `?project=` across a nav click: switching from Worktrees to Agents while
 *  standing on one project must not silently re-target the machine tier. */
function useSectionHref(): (id: SettingsSection['id']) => string {
  const { projectId } = useSettingsProject()
  return (id) => settingsSectionPath(id, projectId)
}

function SectionNav({
  activeId,
  capabilities,
}: {
  activeId: SettingsSection['id'] | null
  capabilities?: SettingsCapabilities
}) {
  const href = useSectionHref()
  const { projectId } = useSettingsProject()
  return (
    <nav
      aria-label="Settings sections"
      data-slot="settings-nav"
      className="hidden w-52 shrink-0 flex-col gap-1 border-r border-border p-3 md:flex"
    >
      <NavLink
        to={settingsIndexPath()}
        end
        data-slot="settings-nav-index"
        aria-current={activeId === null ? 'page' : undefined}
        className={cn(
          'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors',
          activeId === null
            ? 'bg-muted text-foreground'
            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
        )}
      >
        <SlidersHorizontalIcon aria-hidden="true" className="size-4 shrink-0" />
        All settings
      </NavLink>
      {visibleSettingsSections(capabilities).map((section) => (
        <NavLink
          key={section.id}
          to={href(section.id)}
          data-section={section.id}
          data-applies-to={section.appliesTo}
          aria-current={section.id === activeId ? 'page' : undefined}
          className={cn(
            'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors',
            section.id === activeId
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
          )}
        >
          <section.icon aria-hidden="true" className="size-4 shrink-0" />
          {section.title}
        </NavLink>
      ))}
      {/* The nav footer answers "what am I editing?". With a project selected that is WHICH repo,
          by its absolute path on disk; with none, it is this machine's own file. */}
      {projectId === null ? (
        <p className="mt-auto px-2.5 pt-3 text-[11px] text-soft-foreground">Stored in ~/.cezar</p>
      ) : (
        // The id comes as a PROP rather than from a scope provider wrapped around the nav: this
        // footer only needs the registry (a workspace-level query), and a second provider writing
        // the module-level API scope beside the body's would be two writers for one fact.
        <ProjectLocationNav projectId={projectId} />
      )}
    </nav>
  )
}

/** The mobile stand-in for the left nav: one segmented, scrollable pill row. */
function SectionPills({
  activeId,
  capabilities,
}: {
  activeId: SettingsSection['id']
  capabilities?: SettingsCapabilities
}) {
  const href = useSectionHref()
  return (
    <nav
      aria-label="Settings sections"
      data-slot="settings-nav-mobile"
      className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-border px-3 py-2.5 md:hidden"
    >
      {/* Never the active pill: the index is a different route, and reaching it from a section
          is the whole reason this entry exists. */}
      <NavLink
        to={settingsIndexPath()}
        end
        data-slot="settings-nav-index"
        className="rounded-full border border-border bg-card px-3 py-1.5 text-[13px] font-medium whitespace-nowrap text-muted-foreground transition-colors"
      >
        All
      </NavLink>
      {visibleSettingsSections(capabilities).map((section) => (
        <NavLink
          key={section.id}
          to={href(section.id)}
          data-section={section.id}
          aria-current={section.id === activeId ? 'page' : undefined}
          className={cn(
            'rounded-full border px-3 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors',
            section.id === activeId
              ? 'border-transparent bg-contrast text-contrast-foreground'
              : 'border-border bg-card text-muted-foreground',
          )}
        >
          {section.title}
        </NavLink>
      ))}
    </nav>
  )
}

/**
 * A `per-project` section's body, mounted against the selected project.
 *
 * The provider is what makes every hook inside address `/api/v1/p/<selected>/…` and cache under
 * that project's query scope. With *All projects* (`projectId === null`) it is the identity — the
 * unscoped default, which is what the machine tier wants — so the section either edits
 * `~/.cezar/config.json` (`machineTier`) or asks for a project.
 */
function SectionBody({
  section,
  capabilities,
}: {
  section: SettingsSection
  capabilities?: SettingsCapabilities
}) {
  const { projectId } = useSettingsProject()
  const Body = section.component
  if (section.appliesTo === 'workspace') return <Body capabilities={capabilities} />
  if (projectId === null && section.machineTier !== true) {
    return <SettingsProjectRequired section={section} />
  }
  return (
    <ProjectScopeProvider projectId={projectId}>
      {/* Keyed on the project so a swap is a real unmount/mount: sections hold mount-time state
          (the Agents system-prompt draft, the config editor's buffer) read from the project that
          was selected when they mounted. Same reason `ProjectScopeRoute` keys its `Outlet`. */}
      <Body key={projectId ?? 'all'} capabilities={capabilities} />
    </ProjectScopeProvider>
  )
}

/** One registered section inside the shell — `/settings/<id>`. */
export function SettingsSectionRoute({
  section,
  capabilities,
}: {
  section: SettingsSection
  capabilities?: SettingsCapabilities
}) {
  return (
    <div data-route={`settings-${section.id}`} className="flex min-h-full flex-col">
      {/* Desktop header — below `md` the shell's top bar already says "Settings". */}
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">{section.title}</h1>
        <p className="min-w-0 flex-1 truncate text-[13px] text-soft-foreground">
          {section.description}
        </p>
        {/* Always visible, never tucked into the body: one page edits two tiers now, and the
            selector is the only thing that says which one a save is about to land in. */}
        {section.appliesTo === 'per-project' ? (
          <SettingsProjectSelector className="ml-auto shrink-0" />
        ) : (
          <span data-slot="settings-applies-to" className="ml-auto shrink-0 text-[11px] text-soft-foreground">
            All projects
          </span>
        )}
      </header>
      {/* The mobile header has no room for the description, but it MUST carry the selector: a
          small screen otherwise has no way to see or change what a save applies to. */}
      {section.appliesTo === 'per-project' ? (
        <div className="flex shrink-0 items-center justify-end border-b border-border px-3 py-2 md:hidden">
          <SettingsProjectSelector />
        </div>
      ) : null}
      <div className="flex flex-1 flex-col md:flex-row">
        <SectionNav activeId={section.id} capabilities={capabilities} />
        <SectionPills activeId={section.id} capabilities={capabilities} />
        <div className="flex min-w-0 flex-1 flex-col">
          <SectionBody section={section} capabilities={capabilities} />
        </div>
      </div>
    </div>
  )
}

/** The area's index: the same registry rendered as a stacked list of cards (the mobile drill-in
 *  page; on desktop it sits beside the nav as a plain directory). */
export function SettingsIndexRoute({ capabilities }: { capabilities?: SettingsCapabilities }) {
  const href = useSectionHref()
  return (
    <div data-route="settings" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Settings</h1>
        <p className="text-[13px] text-soft-foreground">
          Everything cezar can be told — this machine’s, and each project’s.
        </p>
      </header>
      <div className="flex flex-1 flex-col md:flex-row">
        <SectionNav activeId={null} capabilities={capabilities} />
        {/* No second h1 for small screens: the app shell's mobile top bar already titles the
            page "Settings" from the nav registry. */}
        <div className="flex min-w-0 flex-1 flex-col p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-5 md:pb-5">
          <ul
            data-slot="settings-index"
            className="mx-auto flex w-full max-w-2xl flex-col gap-2.5"
          >
            {visibleSettingsSections(capabilities).map((section) => (
              <li key={section.id}>
                <Link
                  to={href(section.id)}
                  data-section={section.id}
                  className="flex items-center gap-3.5 rounded-lg border border-border bg-card p-4 shadow-xs transition-colors hover:bg-card-2"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
                    <section.icon aria-hidden="true" className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">{section.title}</span>
                    <span className="block text-xs text-soft-foreground">{section.description}</span>
                  </span>
                  {/* The one thing the old split got right, kept as a LABEL rather than as an
                      address: a reader still wants to know whether a row is about the machine or
                      about one repo before clicking it. */}
                  <span
                    data-slot="settings-index-applies-to"
                    className="hidden shrink-0 text-[11px] text-soft-foreground sm:block"
                  >
                    {section.appliesTo === 'workspace' ? 'All projects' : 'Per project'}
                  </span>
                  <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-soft-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
