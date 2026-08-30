import type { ApiRun } from '@loki-labs/cezar-plus-api-client'
import { StatusDot } from '@/components/status-dot'
import { toast } from '@/components/ui/toaster'
import { useRetargetAction } from './retarget-engine'

/**
 * "This task is parked — run it somewhere else instead"
 * (spec `.ai/specs/2026-08-23-retarget-task-to-another-engine.md`, Phase 5).
 *
 * Lives in the DOCK, beside `AutoResumeHint` and the paused/queued hints, for that component's
 * own stated reason: this is where the thread answers "what is expected of me right now?". For a
 * parked task the honest answer used to be "nothing, for possibly days", and this is the line that
 * turns it into something actionable.
 *
 * **This is the full control; the header's "Run on…" is the shortcut.** The action is not a single
 * click — it is a click plus a choice of engine, and the runner *and model* pills need somewhere to
 * be. Here they are visible without a second click, on the surface a person opens precisely
 * *because* the task is not moving. `RetargetMenuButton` (`retarget-menu.tsx`) puts the same action
 * in the header row and the mobile menu as a list of engines, sending no model so Phase 2's ladder
 * re-resolves one. Both read `runActionFlags.retarget`, so the two placements cannot disagree about
 * when a task is movable, and both call `useRetargetAction`, so they cannot disagree about how.
 *
 * Renders only for the two parked states (`runActionFlags.retarget`): `queued`, which is the
 * reported case of a task held behind an exhausted account, and `failed` WITH an `autoResumeAt`,
 * the scheduled state. A plain finished run already has Continue, whose composer carries these
 * same pills.
 */
export function RetargetHint({ run }: { run: ApiRun }) {
  const action = useRetargetAction(run)
  if (!action.available) return null

  const scheduled = run.status === 'failed'
  return (
    <div
      data-slot="retarget-hint"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-muted-foreground"
    >
      <StatusDot tone="pending" />
      <span>
        {scheduled
          ? 'Waiting for a usage limit to reset. Run it on another engine instead:'
          : 'Waiting for a slot. Run it on another engine instead:'}
      </span>
      {action.pills}
      <button
        type="button"
        data-action="retarget-run"
        disabled={action.pending || action.providerPending || !action.canRetarget}
        onClick={() => {
          action
            .retarget()
            .then(() => toast('Moving this task to the engine you picked'))
            // The server's own words, not a generic failure: the most likely one is the 409 for a
            // task that started while this was open, and "it is already running" is information,
            // not an error the user caused.
            .catch((error: Error) => toast(error.message, { tone: 'danger' }))
        }}
        className="font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground disabled:opacity-50"
      >
        {action.pending ? 'Moving…' : 'Run on this'}
      </button>
      {action.reason ? <span data-slot="retarget-blocked">{action.reason}</span> : null}
    </div>
  )
}
