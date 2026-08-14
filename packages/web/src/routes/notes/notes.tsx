import { useState, type FormEvent } from 'react'
import { NotebookPenIcon, SparklesIcon, TrashIcon } from 'lucide-react'
import type { NoteProposal, NoteSummary } from '@open-mercato/cezar-api-client'

import {
  useApproveWorkspaceNote,
  useCreateWorkspaceNote,
  useDeleteWorkspaceNote,
  useHealth,
  useProcessWorkspaceNote,
  useRejectWorkspaceNote,
  useWorkspaceNote,
  useWorkspaceNotes,
} from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Link, scopeTo } from '@/lib/project-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

/**
 * `/notes` (F3 feature B, `CEZ_NOTES=1`) — the capture inbox and its review gate. Spec:
 * `.ai/specs/2026-08-14-note-to-spec-pipeline.md`.
 *
 * Workspace-level: mounted OUTSIDE `ProjectScopeRoute` in `routes.tsx`, because a note has not yet
 * been assigned to a project — deciding which projects it implies is the whole job of the pass
 * (PLAN D14).
 *
 * **Approving is the only path from a note to a run**, and it starts a run per proposal in that
 * proposal's own repository. Nothing on this page starts anything without a click on a row a
 * person has read: that review gate is the feature, not a courtesy.
 *
 * Flag off, this renders the same "disabled" pattern `/inbox` uses for `followups` — the nav item
 * is gated off too (`nav-items.ts`), so this only shows on a pasted link or a direct visit.
 */
export function NotesRoute() {
  const health = useHealth()
  const healthKnown = health.data !== undefined
  const notesOff = healthKnown && health.data.capabilities?.notes !== true
  const [selected, setSelected] = useState<string>()

  // Gated on the capability answer, not fired optimistically: the flag-off list is a 200 carrying
  // an empty payload (D19), so a fetch made before health arrives comes back indistinguishable
  // from a genuinely empty inbox and paints "no notes yet" over "the feature is off".
  const notes = useWorkspaceNotes({}, healthKnown && !notesOff)

  if (!healthKnown) {
    return (
      <NotesShell>
        <p className="p-4 text-sm text-muted-foreground">Loading notes…</p>
      </NotesShell>
    )
  }

  if (notesOff) {
    return (
      <NotesShell>
        <CenteredState
          icon={<NotebookPenIcon />}
          tone="neutral"
          title="The notes inbox is off"
          subtitle="Set CEZ_NOTES=1 and restart cezar to turn it on."
          heading="h2"
        />
      </NotesShell>
    )
  }

  const rows = notes.data?.notes ?? []

  return (
    <NotesShell>
      <div className="flex flex-1 flex-col gap-4 p-3 md:p-5">
        <CaptureBox />
        {notes.isPending ? (
          <p className="text-sm text-muted-foreground">Loading notes…</p>
        ) : rows.length === 0 ? (
          <CenteredState
            icon={<NotebookPenIcon />}
            tone="neutral"
            title="No notes yet"
            subtitle="Write down what needs doing. Analysing it into specced tasks comes next, and only when you ask."
            heading="h2"
          />
        ) : (
          <ul className="flex flex-col gap-2" data-testid="notes-list">
            {rows.map((note) => (
              <NoteCard
                key={note.id}
                note={note}
                expanded={selected === note.id}
                onToggle={() => setSelected(selected === note.id ? undefined : note.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </NotesShell>
  )
}

function NotesShell({ children }: { children: React.ReactNode }) {
  return (
    <div data-route="notes" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Notes</h1>
      </header>
      <div className="flex flex-1 flex-col">{children}</div>
    </div>
  )
}

/** THE single write path from the cockpit. Deliberately one textarea and one button: a capture
 *  surface that asks questions before it accepts a thought is a capture surface people stop
 *  using, and every question it could ask (which project? which workflow?) is what the pass is
 *  for. */
function CaptureBox() {
  const [body, setBody] = useState('')
  const create = useCreateWorkspaceNote()

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = body.trim()
    if (!trimmed) return
    create.mutate(
      { body: trimmed, source: 'cockpit' },
      { onSuccess: () => setBody('') },
    )
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="What needs doing? One note can cover several things in several projects."
        aria-label="New note"
        rows={4}
      />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!body.trim() || create.isPending}>
          {create.isPending ? 'Saving…' : 'Capture note'}
        </Button>
        {create.isError ? (
          <span className="text-sm text-destructive">{String(create.error)}</span>
        ) : null}
      </div>
    </form>
  )
}

function NoteCard({
  note,
  expanded,
  onToggle,
}: {
  note: NoteSummary
  expanded: boolean
  onToggle: () => void
}) {
  const detail = useWorkspaceNote(note.id, expanded)
  const process = useProcessWorkspaceNote()
  const remove = useDeleteWorkspaceNote()

  return (
    <li className="rounded-md border border-border bg-card" data-note-id={note.id}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full flex-col items-start gap-1 p-3 text-left"
      >
        <span className="flex w-full items-center gap-2">
          <span className="flex-1 truncate text-sm font-medium">{note.title}</span>
          <Badge variant="outline">{note.status}</Badge>
          {note.proposalCount > 0 ? (
            <Badge variant="secondary">
              {note.proposalCount} proposed
            </Badge>
          ) : null}
        </span>
        <span className="line-clamp-2 text-xs text-muted-foreground">{note.excerpt}</span>
        {note.targetProjects.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {note.targetProjects.map((projectId) => (
              <Badge key={projectId} variant="outline" className="text-[10px]">
                {projectId}
              </Badge>
            ))}
          </span>
        ) : null}
      </button>

      {expanded ? (
        <div className="flex flex-col gap-3 border-t border-border p-3">
          <p className="whitespace-pre-wrap text-sm">{detail.data?.note?.body ?? note.excerpt}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => process.mutate(note.id)}
              disabled={process.isPending || note.status === 'processing'}
            >
              <SparklesIcon />
              {note.status === 'processed' ? 'Analyse again' : 'Analyse'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => remove.mutate(note.id)}
              disabled={remove.isPending}
            >
              <TrashIcon />
              Delete
            </Button>
            {process.isError ? (
              <span className="text-sm text-destructive">{String(process.error)}</span>
            ) : null}
          </div>
          {note.resultingTasks.length > 0 ? <ResultingRuns note={note} /> : null}
          {detail.data?.note?.pass ? (
            <ProposalReview noteId={note.id} pass={detail.data.note.pass} />
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

/**
 * What this note has already produced: one row per run, in the project it runs in.
 *
 * **"Start implementation" is a prefilled composer link, not a start button**, and that is the
 * point. It lands on the target project's editable composer (`/p/<id>/new?ref=…`, the same
 * review-before-launch detour `newTaskPrefillHref` documents for the Inbox), so implementing
 * always costs a deliberate second click in the repository it will change. A note typed on a
 * phone produced the spec; a person decides whether it gets built.
 */
function ResultingRuns({ note }: { note: NoteSummary }) {
  return (
    <section className="flex flex-col gap-1" aria-label="Runs from this note">
      {note.resultingTasks.map((row) => (
        <div key={`${row.proposalId}-${row.kind}`} className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline">{row.projectId}</Badge>
          <Link
            to={scopeTo(row.projectId, `/tasks/${row.runId}`)}
            className="underline underline-offset-2 hover:text-foreground"
          >
            {row.kind === 'spec' ? 'Spec run' : 'Implementation run'}
          </Link>
          {row.specPath ? <span className="text-muted-foreground">{row.specPath}</span> : null}
          {row.kind === 'spec' ? (
            <Link
              to={`${scopeTo(row.projectId, '/new')}?ref=${encodeURIComponent(implementationPrefill(row))}`}
              className="underline underline-offset-2 hover:text-foreground"
            >
              Start implementation
            </Link>
          ) : null}
        </div>
      ))}
    </section>
  )
}

/** The brief the composer opens with. It points at the spec run rather than pasting a spec body
 *  nobody has read back — the agent reads the spec in the repo, which is where it actually is. */
function implementationPrefill(row: NoteSummary['resultingTasks'][number]): string {
  const where = row.specPath ? `the spec at ${row.specPath}` : `the spec written by cezar task ${row.runId}`
  return `Implement ${where}. Read it first and follow its phases. If it disagrees with the code as it stands now, say so before changing anything.`
}

/**
 * The review gate. Every proposal is listed with the project it targets and why, and nothing
 * happens until Approve is pressed on rows a person has looked at.
 *
 * A row flagged `duplicateOf` is pre-DESELECTED rather than hidden: the pass believing something
 * is already on the board is information, and hiding it would quietly drop work whenever that
 * belief is wrong.
 */
function ProposalReview({
  noteId,
  pass,
}: {
  noteId: string
  pass: NonNullable<NonNullable<ReturnType<typeof useWorkspaceNote>['data']>['note']>['pass']
}) {
  const proposals = pass?.proposals ?? []
  const [chosen, setChosen] = useState<Set<string>>(
    () =>
      new Set(
        proposals
          // A flagged row (`unknown-project`, a suspected duplicate) starts DESELECTED, never
          // hidden: the pass's belief is information, and hiding a row would silently drop work
          // whenever that belief is wrong. Deselecting only means the default click does not
          // start it.
          .filter((row) => !row.duplicateOf && row.issues.length === 0 && !row.createdRunId)
          .map((row) => row.id),
      ),
  )
  const approve = useApproveWorkspaceNote()
  const reject = useRejectWorkspaceNote()

  if (!pass) return null

  const toggle = (id: string) => {
    setChosen((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <section className="flex flex-col gap-2" aria-label="Proposed tasks">
      {pass.summary ? <p className="text-xs text-muted-foreground">{pass.summary}</p> : null}
      {pass.error ? <p className="text-sm text-destructive">{pass.error}</p> : null}
      <ul className="flex flex-col gap-2">
        {proposals.map((proposal) => (
          <ProposalRow
            key={proposal.id}
            proposal={proposal}
            checked={chosen.has(proposal.id)}
            onToggle={() => toggle(proposal.id)}
          />
        ))}
      </ul>
      {pass.unassigned.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Not assigned to a project: {pass.unassigned.map((row) => row.text).join(' · ')}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={chosen.size === 0 || approve.isPending}
          onClick={() =>
            approve.mutate({
              noteId,
              passId: pass.id,
              proposals: [...chosen].map((id) => ({ id })),
            })
          }
        >
          {approve.isPending
            ? 'Starting…'
            : `Write ${chosen.size === 1 ? 'the spec' : `${chosen.size} specs`}`}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={chosen.size === 0 || reject.isPending}
          onClick={() => reject.mutate({ noteId, proposals: [...chosen] })}
        >
          Reject selected
        </Button>
        {approve.isError ? (
          <span className="text-sm text-destructive">{String(approve.error)}</span>
        ) : null}
      </div>
      {/* Read defensively: this is the one place partial success is reported, and a summary that
          throws on an unexpected body would blank the whole review panel — losing the record of
          what DID start along with it. */}
      {approve.data ? (
        <p className="text-xs text-muted-foreground">
          Started {approve.data.created?.length ?? 0}.{' '}
          {(approve.data.rejected?.length ?? 0) > 0
            ? `Refused ${approve.data.rejected.length}: ${approve.data.rejected
                .map((row) => row.error)
                .join('; ')}`
            : ''}
        </p>
      ) : null}
    </section>
  )
}

function ProposalRow({
  proposal,
  checked,
  onToggle,
}: {
  proposal: NoteProposal
  checked: boolean
  onToggle: () => void
}) {
  const claimed = proposal.createdRunId !== undefined
  return (
    <li className="flex items-start gap-2 rounded-md border border-border p-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        // A proposal that already produced a run cannot be approved again — the server refuses it
        // too (first-wins claim); this only keeps the UI from offering the click.
        disabled={claimed}
        aria-label={`Select ${proposal.title}`}
        className="mt-1"
      />
      <div className="flex flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{proposal.title}</span>
          <Badge variant="outline">{proposal.projectId}</Badge>
          {proposal.duplicateOf ? <Badge variant="secondary">looks like a duplicate</Badge> : null}
          {claimed ? <Badge variant="secondary">spec run started</Badge> : null}
          {proposal.issues.map((issue) => (
            <Badge key={issue} variant="destructive">
              {issue}
            </Badge>
          ))}
        </span>
        {proposal.rationale ? (
          <span className="text-xs text-muted-foreground">{proposal.rationale}</span>
        ) : null}
        {proposal.duplicateOf ? (
          <span className="text-xs text-muted-foreground">
            {proposal.duplicateOf.title} — {proposal.duplicateOf.reason}
          </span>
        ) : null}
      </div>
    </li>
  )
}
