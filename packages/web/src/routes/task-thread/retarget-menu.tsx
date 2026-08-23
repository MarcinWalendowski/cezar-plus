import { PlayIcon } from 'lucide-react'

import type { ApiRun, Runner } from '@loki-labs/better-cezar-api-client'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from '@/components/ui/toaster'
import { RUNNERS } from '@/routes/new-task-form'
import { useRetargetAction } from './retarget-engine'

/**
 * "Run on…" in the header action row and the mobile menu
 * (spec `.ai/specs/2026-08-23-retarget-task-to-another-engine.md`, Phase 5).
 *
 * A menu of ENGINES, not a second engine picker. Picking one moves the task immediately and sends
 * no model, so Phase 2's ladder re-resolves it for the new backend — which is the honest thing for
 * a one-click action to do, because a click on "codex" says nothing about which codex model. The
 * dock's `RetargetHint` is where the same action carries runner *and* model pills; this is the
 * shortcut for the common case ("just move it off the account that is out of quota").
 *
 * Visibility is `runActionFlags.retarget`, the same table-tested rule the dock hint uses, so the
 * two placements can never disagree about when a task is movable. The menu lists only runners
 * `usableRunners()` reports as connected, and the runner the task is already on is disabled rather
 * than hidden — "you are already here" is information, and hiding it would make a two-provider
 * host's menu look like it has one choice.
 */
export function RetargetMenuButton({ run, className }: { run: ApiRun; className?: string }) {
  const action = useRetargetAction(run)
  if (!action.available) return null

  const move = (runner: Runner) => {
    action
      .retarget(runner)
      .then(() => toast(`Moving this task to ${runner}`))
      // The server's own words: the likeliest failure is the 409 for a task that started while
      // the menu was open, and "it is already running" is information, not an error.
      .catch((error: Error) => toast(error.message, { tone: 'danger' }))
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          data-slot="retarget-menu"
          className={className}
          title={action.reason ?? 'Move this parked task to another engine'}
          disabled={action.pending || action.providerPending || !action.canRetarget}
        >
          {action.pending ? 'Moving…' : 'Run on…'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Run on…</DropdownMenuLabel>
        {action.runners.map((id) => (
          <DropdownMenuItem
            key={id}
            data-action="retarget-to"
            data-runner={id}
            disabled={id === action.currentRunner}
            onSelect={() => move(id)}
          >
            {RUNNERS.find((r) => r.id === id)?.label ?? id}
            {id === action.currentRunner ? ' (current)' : ''}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The same action as flat rows, for the mobile overflow menu — "Run on codex", one item per
 * connected engine.
 *
 * Flat rather than a `DropdownMenuSub`, because on the surface where this matters (a phone) a
 * submenu costs a second tap and a hover model touch does not have. It returns a fragment of
 * `DropdownMenuItem`s so it composes into the existing `DropdownMenuContent` without a nested
 * menu root.
 */
export function RetargetMenuItems({ run }: { run: ApiRun }) {
  const action = useRetargetAction(run)
  if (!action.available) return null

  return (
    <>
      {action.runners
        .filter((id) => id !== action.currentRunner)
        .map((id) => (
          <DropdownMenuItem
            key={id}
            data-action="retarget-to"
            data-runner={id}
            disabled={action.pending || action.providerPending || !action.canRetarget}
            onSelect={() => {
              action
                .retarget(id)
                .then(() => toast(`Moving this task to ${id}`))
                .catch((error: Error) => toast(error.message, { tone: 'danger' }))
            }}
          >
            <PlayIcon aria-hidden="true" /> Run on {RUNNERS.find((r) => r.id === id)?.label ?? id}
          </DropdownMenuItem>
        ))}
    </>
  )
}
