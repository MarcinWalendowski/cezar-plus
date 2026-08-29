import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, CornerUpLeftIcon, ShieldQuestionIcon } from 'lucide-react'
import { useRef, useState } from 'react'

import { Link } from '@/lib/project-router'

import { approveRun, requestRunChanges } from '@/api/client'
import { queryKeys } from '@/api/queries'
import type { ApiRun } from '@loki-labs/better-cezar-api-client'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { isSubmitShortcut } from '@/lib/use-submit-shortcut'

import { readTaskDraft, writeTaskDraft } from './task-drafts'

/**
 * The human approval gate's card (spec
 * `.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md`, P4).
 *
 * Deliberately NOT modelled on `ReviewPanel`, despite the family resemblance. That panel is the
 * TERMINAL gate: the work is finished and the diff is the thing being judged. This one sits in the
 * MIDDLE of a chain — the spec is written, nothing has been implemented, and the steps waiting
 * behind it are the ones that push to a remote and deploy. So it shows the spec under review and
 * the count of approvals, not a diff, and its "send back" rewinds the chain rather than reopening
 * a finished run.
 *
 * Renders only when `run.pendingApproval` is set, which the engine only ever sets when somebody
 * opted in (`approvals.minApprovers >= 1`). On a default install this component never mounts.
 */
export function ApprovalCard({ run }: { run: ApiRun }) {
  const pending = run.pendingApproval
  const queryClient = useQueryClient()
  const notesRef = useRef<HTMLTextAreaElement>(null)
  // Read at mount — `ApprovalCard` is keyed by run id (task-thread.tsx), so this is a real mount
  // per task. One helper writes state and store together so the two cannot drift.
  const [notes, setNotes] = useState(() => readTaskDraft('approvalNotes', run.id))
  const updateNotes = (next: string) => {
    setNotes(next)
    writeTaskDraft('approvalNotes', run.id, next)
  }

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })

  const approve = useMutation({
    mutationFn: () => approveRun(run.id),
    onSuccess: () => void invalidate(),
    // A 409 here is nearly always "someone else decided first", which is information, not an
    // error the user did anything wrong.
    onError: (error: Error) => toast(error.message || 'could not record the approval', { tone: 'danger' }),
  })

  const sendBack = useMutation({
    mutationFn: () => requestRunChanges(run.id, notes.trim()),
    onSuccess: () => {
      // Spent: clear the box AND the store. A rejected request-changes keeps both.
      updateNotes('')
      void invalidate()
    },
    onError: (error: Error) => toast(error.message || 'could not request changes', { tone: 'danger' }),
  })

  if (!pending) return null
  const have = pending.approvals.length
  const need = pending.minApprovers
  const busy = approve.isPending || sendBack.isPending

  return (
    <section
      data-slot="approval-card"
      aria-label="Approve the spec before implementation"
      className="flex flex-col gap-3"
    >
      <div className="flex items-center gap-2.5 rounded-md border border-violet/30 bg-violet/10 px-3.5 py-2.5">
        <ShieldQuestionIcon className="size-4 shrink-0 text-violet" aria-hidden="true" />
        <p className="min-w-0 text-[13px]">
          <span className="font-semibold">
            Waiting for your approval — {have} of {need} so far.
          </span>{' '}
          <span className="text-muted-foreground">
            The spec is written and reviewed. Nothing is implemented, pushed or deployed until this
            is approved.
          </span>
        </p>
      </div>

      {pending.specPath ? (
        <p className="text-[13px] text-muted-foreground">
          Under review:{' '}
          {/* Links into the Spec tab (spec .ai/specs/2026-08-29-spec-tab-review-feed.md, P3) —
              the card stays the place that collects the decision, but it stops being the only
              way to learn a spec exists. */}
          <Link
            to={`/tasks/${run.id}/spec`}
            className="font-mono text-[12px] underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            {pending.specPath}
          </Link>
        </p>
      ) : null}

      {have > 0 ? (
        <ul data-slot="approval-list" className="flex flex-col gap-1 text-[12px] text-muted-foreground">
          {pending.approvals.map((a) => (
            <li key={a.by}>
              ✓ {a.by}
              {a.note ? ` — ${a.note}` : ''}
            </li>
          ))}
        </ul>
      ) : null}

      <Textarea
        ref={notesRef}
        value={notes}
        onChange={(e) => updateNotes(e.target.value)}
        onKeyDown={(e) => {
          if (isSubmitShortcut(e) && notes.trim()) sendBack.mutate()
        }}
        placeholder="What needs to change? These notes are handed to the spec step as its instructions."
        className="min-h-20"
      />

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => approve.mutate()} disabled={busy}>
          <CheckIcon className="size-4" aria-hidden="true" />
          Approve
        </Button>
        <Button
          variant="outline"
          onClick={() => sendBack.mutate()}
          // Notes are REQUIRED, and the button says so by being unavailable: a rewind with no
          // instructions re-runs the spec step with no idea what to change.
          disabled={busy || !notes.trim()}
        >
          <CornerUpLeftIcon className="size-4" aria-hidden="true" />
          Request changes
        </Button>
      </div>
    </section>
  )
}
