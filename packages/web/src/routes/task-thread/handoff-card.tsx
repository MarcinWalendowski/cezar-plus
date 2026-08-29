import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, SkipForwardIcon, HandIcon } from 'lucide-react'
import { useState } from 'react'

import { resolveRunHandoff, skipRunHandoff } from '@/api/client'
import { queryKeys } from '@/api/queries'
import type { ApiRun } from '@loki-labs/better-cezar-api-client'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'

import { readTaskDraft, writeTaskDraft } from './task-drafts'

export function HandoffCard({ run }: { run: ApiRun }) {
  const pending = run.pendingHandoff
  const queryClient = useQueryClient()
  const [note, setNote] = useState(() => readTaskDraft('handoffNotes', run.id))
  const updateNote = (next: string) => {
    setNote(next)
    writeTaskDraft('handoffNotes', run.id, next)
  }
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
  const resolve = useMutation({
    mutationFn: () => resolveRunHandoff(run.id, note.trim() || undefined),
    /**
     * A 200 is not a yes. The server re-probes on Resolve and answers `resolved: false` when the
     * targets are still red — the handoff stays parked, and the run does not move. This branch
     * used to be missing entirely: `onSuccess` cleared the note and showed nothing, so a refusal
     * and a success looked identical and the button read as broken. Measured 2026-08-29: the
     * operator pressed it five times on run cc25d636 against five honest reds.
     *
     * On a refusal, KEEP the note — it is the operator's, they may still want it on the record,
     * and wiping what someone typed is the second half of what made this feel dead.
     */
    onSuccess: (result) => {
      void invalidate()
      if (!result.resolved) {
        toast(result.verdict || 'the deploy targets are still red — nothing was deployed', { tone: 'danger' })
        return
      }
      updateNote('')
      toast('handoff resolved — the run is continuing')
    },
    onError: (error: Error) => toast(error.message || 'could not resolve the handoff', { tone: 'danger' }),
  })
  const skip = useMutation({
    mutationFn: () => skipRunHandoff(run.id, note.trim()),
    onSuccess: () => {
      updateNote('')
      void invalidate()
    },
    onError: (error: Error) => toast(error.message || 'could not skip the handoff', { tone: 'danger' }),
  })

  if (!pending) return null
  const busy = resolve.isPending || skip.isPending
  const manualDeploy = pending.kind === 'manual-deploy'

  return (
    <section data-slot="handoff-card" aria-label="Manual handoff required" className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5 rounded-md border border-warning/30 bg-warning/10 px-3.5 py-2.5">
        <HandIcon className="size-4 shrink-0 text-warning" aria-hidden="true" />
        <p className="min-w-0 text-[13px]">
          <span className="font-semibold">
            {manualDeploy ? 'Awaiting manual deployment' : 'Awaiting manual merge'}
          </span>{' '}
          <span className="text-muted-foreground">The workflow is paused until this handoff is resolved.</span>
        </p>
      </div>

      <p className="text-[13px] text-muted-foreground">{pending.reason}</p>
      {pending.targets?.length ? (
        <ul data-slot="handoff-targets" className="flex flex-col gap-1 text-[12px] text-muted-foreground">
          {pending.targets.map((target) => <li key={target}>{target}</li>)}
        </ul>
      ) : null}

      <Textarea
        value={note}
        onChange={(event) => updateNote(event.target.value)}
        placeholder="Optional note for the handoff record"
        className="min-h-20"
      />
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => resolve.mutate()} disabled={busy}>
          <CheckIcon className="size-4" aria-hidden="true" />
          Resolve
        </Button>
        <Button variant="outline" onClick={() => skip.mutate()} disabled={busy || !note.trim()}>
          <SkipForwardIcon className="size-4" aria-hidden="true" />
          Skip
        </Button>
      </div>
    </section>
  )
}
