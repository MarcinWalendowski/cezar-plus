import { useCallback } from 'react'
import { useSearchParams } from 'react-router'

import { useProjects } from '@/api/queries'
import { cn } from '@/lib/utils'
import type { SettingsSection } from './registry'

/**
 * The project selector that replaced the project settings AREA
 * (`.ai/specs/2026-08-21-one-settings-area.md`).
 *
 * There is one Settings area now, at `/settings`, and it sits outside `/p/:projectId`. A section
 * whose value differs per repo therefore cannot read its project from the URL prefix any more —
 * it reads it from `?project=<id>`, chosen in the section's own header, defaulting to *All
 * projects* (the machine tier).
 *
 * `null` is the whole point of the default: the report this spec answers was that half of Settings
 * was invisible, and requiring a project before showing a section would only move the problem. A
 * per-project section with no project selected either edits the machine tier (`machineTier` in the
 * registry) or says plainly that it needs a project — never a control that would write somewhere
 * arbitrary.
 */

/** The query key. Named once: the redirects in `routes.tsx` mint it and this module reads it. */
export const SETTINGS_PROJECT_PARAM = 'project'

export interface SettingsProject {
  /** The selected project id, or `null` for *All projects* (the machine tier). */
  projectId: string | null
  /** Select a project (or `null`). Replaces the history entry — flipping the selector back and
   *  forth must not build a Back stack the user has to click through to leave Settings. */
  select: (projectId: string | null) => void
}

export function useSettingsProject(): SettingsProject {
  const [params, setParams] = useSearchParams()
  const raw = params.get(SETTINGS_PROJECT_PARAM)
  const projectId = raw === null || raw === '' ? null : raw
  const select = useCallback(
    (next: string | null) => {
      setParams(
        (current) => {
          const updated = new URLSearchParams(current)
          if (next === null) updated.delete(SETTINGS_PROJECT_PARAM)
          else updated.set(SETTINGS_PROJECT_PARAM, next)
          return updated
        },
        { replace: true },
      )
    },
    [setParams],
  )
  return { projectId, select }
}

/**
 * How a save control names what it is about to write. The single highest-value thing this area
 * has to get right (spec §Risks 2): one page now edits two tiers, so the button says which.
 */
export function useSaveTargetLabel(): string {
  const { projectId } = useSettingsProject()
  const registry = useProjects().data
  if (projectId === null) return 'all projects'
  return registry?.projects.find((project) => project.id === projectId)?.name ?? projectId
}

/**
 * The header control. A plain `<select>`, like every other picker in Settings — a combobox would
 * be a second interaction grammar for a list that is normally under a dozen items long.
 */
export function SettingsProjectSelector({ className }: { className?: string }) {
  const { projectId, select } = useSettingsProject()
  const projects = useProjects()
  const entries = projects.data?.projects ?? []
  // A `?project=` naming something the registry does not have still renders as the current value,
  // rather than silently snapping to *All projects*: the URL said something, and quietly editing
  // the machine tier instead is exactly the confusion the selector exists to prevent.
  const unknown = projectId !== null && !entries.some((entry) => entry.id === projectId)
  return (
    <label className={cn('flex items-center gap-2 text-[11px] text-soft-foreground', className)}>
      <span>Applies to</span>
      <select
        aria-label="Which project these settings apply to"
        data-slot="settings-project-selector"
        value={projectId ?? ''}
        onChange={(event) => select(event.target.value === '' ? null : event.target.value)}
        className="max-w-44 truncate rounded-md border border-input bg-card px-2 py-1 text-[12px] text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <option value="">All projects</option>
        {entries.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.name}
          </option>
        ))}
        {unknown ? (
          <option value={projectId}>{projectId} — not registered</option>
        ) : null}
      </select>
    </label>
  )
}

/**
 * What a `per-project` section with no machine tier renders under *All projects*.
 *
 * Four settings genuinely have no global answer — where a checkout lives, a coding agent's own
 * config FILES, one checkout's worktrees on disk, and `baseBranch` (a branch is a property of a
 * repository, not of a person). This state says so and offers the pick, rather than showing a
 * disabled form or, worse, a control that writes to whichever project happens to be around.
 */
export function SettingsProjectRequired({ section }: { section: SettingsSection }) {
  const { select } = useSettingsProject()
  const projects = useProjects()
  const entries = projects.data?.projects ?? []
  return (
    <div
      data-slot="settings-project-required"
      className="mx-auto flex w-full max-w-2xl flex-col gap-3 p-4 md:p-6"
    >
      <div>
        <h2 className="text-sm font-semibold text-foreground">Pick a project</h2>
        <p className="text-[13px] text-muted-foreground">
          {section.title} describes one checkout —{' '}
          {LOCAL_REASON[section.id] ?? 'its value is different in every project'}. Choose which one,
          here or in the selector above.
        </p>
      </div>
      {projects.isPending ? (
        <p className="text-[13px] text-soft-foreground">Loading the project list…</p>
      ) : projects.isError ? (
        <p className="text-[13px] text-danger">
          Could not read the project registry — {projects.error.message}
        </p>
      ) : entries.length === 0 ? (
        <p className="text-[13px] text-soft-foreground">No projects are registered yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {entries.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                data-slot="settings-project-pick"
                data-project={entry.id}
                onClick={() => select(entry.id)}
                className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-left shadow-xs transition-colors hover:bg-card-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">{entry.name}</span>
                  <span className="block truncate font-mono text-[11px] text-soft-foreground">
                    {entry.root}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Why this particular section cannot answer for every project at once — said in the section's
 *  own terms, because "it is per-project" is the restatement of a question, not an answer. */
const LOCAL_REASON: Partial<Record<SettingsSection['id'], string>> = {
  project: 'a folder on disk, a branch and a registry entry belong to one of them',
  'agent-config': 'it edits the agents’ real config files inside that checkout',
  worktrees: 'the worktrees it lists are that checkout’s own',
  bookmarklets: 'a bookmarklet carries the project it launches into',
  'prompt-templates': 'templates live in that repo’s own `.ai/cezar/ui-state.json`',
  sources: 'a mirror writes into that project’s knowledge base',
}
