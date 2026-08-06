import { ChevronDownIcon, FolderIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export interface ProjectFilterOption {
  id: string
  name: string
}

/**
 * The shared cross-project filter (`.ai/specs/2026-08-06-workspace-notes-cross-project.md`,
 * "UI/UX" — "the shared project filter"): a multi-select over the registered projects. First used
 * by the workspace Tasks board (W4.10, `workspace-tasks.tsx`); the Notes inbox (P2.4, later)
 * reuses this same component for its own "filters on a note's RESULTING projects" picker.
 *
 * `selected === undefined` means ALL projects — the one contract this component, the URL and the
 * server query all share (`.ai/specs/...`: "Absent means ALL projects, never none"). An explicit
 * `[]` is a real, renderable "nothing selected" state; what a caller shows for it (the board's "No
 * projects match this filter") is that caller's decision, not this component's.
 *
 * Unchecking one project while everything is selected removes only that one — it does not collapse
 * the selection down to the single item left checked, which is what a naive "onChange(id)"
 * implementation would do and is not what a filter checklist means.
 */
export function ProjectFilter({
  options,
  selected,
  onChange,
  className,
}: {
  options: readonly ProjectFilterOption[]
  selected: readonly string[] | undefined
  onChange: (next: string[] | undefined) => void
  className?: string
}) {
  const effective = selected ?? options.map((option) => option.id)
  const allSelected = selected === undefined || (options.length > 0 && effective.length === options.length)

  const label = allSelected
    ? 'All projects'
    : effective.length === 0
      ? 'No projects'
      : effective.length === 1
        ? (options.find((option) => option.id === effective[0])?.name ?? effective[0])
        : `${effective.length} projects`

  const toggle = (id: string) => {
    const next = effective.includes(id) ? effective.filter((x) => x !== id) : [...effective, id]
    onChange(next.length === options.length ? undefined : next)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-slot="project-filter-trigger"
          className={cn('gap-1.5', className)}
        >
          <FolderIcon className="size-3.5" aria-hidden="true" />
          <span className="max-w-40 truncate">{label}</span>
          <ChevronDownIcon className="size-3.5 text-soft-foreground" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent data-slot="project-filter-content" align="start" className="w-56">
        {/* `preventDefault` on every item's `onSelect`, throughout: radix closes the menu on select
            by default, which is right for a single-pick menu and wrong for a checklist — a user
            filtering to three projects should not re-open the menu three times. */}
        <DropdownMenuCheckboxItem
          checked={allSelected}
          onSelect={(event) => {
            event.preventDefault()
            onChange(undefined)
          }}
        >
          All projects
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.id}
            checked={effective.includes(option.id)}
            onSelect={(event) => {
              event.preventDefault()
              toggle(option.id)
            }}
          >
            <span className="truncate">{option.name}</span>
          </DropdownMenuCheckboxItem>
        ))}
        {options.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-soft-foreground">No projects registered</div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
