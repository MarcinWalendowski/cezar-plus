import { useState, type FormEvent } from 'react'
import { NotebookPenIcon } from 'lucide-react'
import { useNavigate } from 'react-router'

import { useCreateWorkspaceNote, useHealth, useProcessWorkspaceNote, useProjects } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { chevron, chipClass } from '@/components/picker-pill'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { scopeTo } from '@/lib/project-router'
import { newTaskPrefillHref } from '@/routes/new-task-params'

/**
 * `/workspace/new` (Phase 1, `.ai/specs/2026-08-14-project-less-task-composer.md`) — a composer
 * with NO project selected. Type one thing, submit, and the triage pass shipped in
 * `11467f44` (`.ai/specs/2026-08-14-note-to-spec-pipeline.md`) decides which registered projects
 * it implies.
 *
 * Workspace-level: mounted OUTSIDE `ProjectScopeRoute` in `routes.tsx`, beside `/notes` and
 * `/workspace/tasks`, for the same reason both of those are — there is no project yet to scope to
 * (the scope trap, `.ai/specs/2026-08-06-workspace-notes-cross-project.md` "The scope trap": with
 * no `ProjectScopeRoute` above it, `queryScope()` silently resolves to the boot project's
 * `'default'` sentinel, so a project-scoped call here would read/write the WRONG repo with no
 * error). This file reads only `useHealth`, `useCreateWorkspaceNote`, `useProcessWorkspaceNote` and
 * `useProjects` (`GET /api/v1/projects`, itself workspace-level and never scoped — the same read
 * the unknown-project screen and the sidebar use) — never a scope-led query or client function.
 * `workspace-new-task.test.tsx` asserts this by request log, in the mould of
 * `new-task-project.test.tsx:352`, and the assertion covers the named-project menu open too, not
 * only the default Auto-detect path.
 *
 * **Renders no skill pill, no template menu, no base-branch pill** (spec "Solution" §3's table):
 * all three are project-derived and there is no project. The project pill (`TargetPill`) defaults
 * to "Auto detect" and its menu also lists every registered project (D2, Phase 2): picking one
 * NAVIGATES to that project's own prefilled composer rather than submitting from here — this page
 * posts nothing on that path, same discipline `useCreateWorkspaceNote`/`useProcessWorkspaceNote`
 * get on the Auto-detect path.
 *
 * **The autonomous toggle is back** (D27 Phase 4b, `.ai/specs/2026-08-15-autonomous-
 * implementation-continuation.md`). D3 (2026-08-14, `.ai/specs/2026-08-14-project-less-task-
 * composer.md`) pulled the original toggle because it was wired to nothing: neither
 * `createNoteInputSchema` nor `NOTE_TO_SPEC_WORKFLOW` had a way to act on it, so shipping it would
 * have been a control that changes nothing plus a false capability claim. That reasoning no longer
 * holds — as of `9532d1dd` an autonomous note's spec run finishing starts a bounded implementation
 * run in the same repo (PLAN D27 Phases 2+3), and `createNoteInputSchema.autonomous` is a real,
 * already-shipped field (Phase 3) — so the toggle returns because it now means something, which is
 * the situation D3 was written about not holding anymore. Defaults **off**: a control that starts
 * unattended agents writing code and committing across several repos is opt-in, never opt-out.
 * `NewTaskComposer`'s explainer swaps text with the toggle so the page never claims a capability
 * the current state does not have; both variants say plainly that a run never pushes and can stop
 * early on its step budget with the work incomplete (Phase 4a — a budget stop no longer renders as
 * a finish anywhere run status shows).
 *
 * **"Land on the review view for that note" (D2):** on a successful submit this navigates to
 * `/notes`, the existing, unchanged review surface — not a second copy of its
 * `ProposalReview`/`ProposalRow` rendering. Phase 1's scope (per the implementation brief) is "the
 * route, the composer, Auto-detect submit, the autonomous explainer, the off state" — it does not
 * list a review UI, and `notes.tsx` is outside this file's allowlist. Duplicating that rendering
 * here would also reopen exactly the "two composers can drift" risk the spec accepts only for
 * shared CONTROLS (the textarea/submit), not for a second copy of the proposal list.
 */
export function WorkspaceNewTaskRoute() {
  const health = useHealth()
  const healthKnown = health.data !== undefined
  const notesOff = healthKnown && health.data.capabilities?.notes !== true

  if (!healthKnown) {
    return (
      <Shell>
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      </Shell>
    )
  }

  if (notesOff) {
    return (
      <Shell>
        <CenteredState
          icon={<NotebookPenIcon />}
          tone="neutral"
          title="The project-less composer is off"
          subtitle="Set CEZ_NOTES=1 and restart cezar-plus to turn it on."
          heading="h2"
        />
      </Shell>
    )
  }

  return (
    <Shell>
      <NewTaskComposer />
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div data-route="workspace-new-task" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">New task</h1>
      </header>
      <div className="flex flex-1 flex-col">{children}</div>
    </div>
  )
}

/** THE composer: the target pill (`TargetPill`, D2), the textarea, a visible explainer of what
 *  submitting does, and the submit affordance. Auto-detect submit does `POST /workspace/notes`
 *  then `POST /workspace/notes/:noteId/process` — the shipped path, unchanged — then a navigate to
 *  `/notes` to review what the pass proposed. Picking a named project in the pill bypasses all of
 *  that and navigates straight to that project's composer instead (`goToProject`, below). */
function NewTaskComposer() {
  const navigate = useNavigate()
  const [body, setBody] = useState('')
  const [error, setError] = useState<string>()
  // Off by default (PLAN D27 Phase 4b) — opted into, never opted out of, since it starts
  // unattended agents writing code and committing across every repo the note implies.
  const [autonomous, setAutonomous] = useState(false)
  const create = useCreateWorkspaceNote()
  const process = useProcessWorkspaceNote()
  const pending = create.isPending || process.isPending

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = body.trim()
    if (!trimmed || pending) return
    setError(undefined)
    try {
      // Sequential, not `Promise.all` — the order is the contract (spec Verification: "drop the
      // `/process` call" must turn this guard red, which requires the note to exist first).
      const created = await create.mutateAsync({ body: trimmed, source: 'cockpit', autonomous })
      const noteId = created.note?.id
      if (!noteId) throw new Error('The note was created without an id.')
      await process.mutateAsync(noteId)
      navigate('/notes')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  // D2's named-project branch: picking a project is a NAVIGATION, never a submit — this page
  // must post nothing on that path (spec Verification, and the mutation table catches it). The
  // prefill shape comes from `newTaskPrefillHref` (the same detour the Notes inbox's "Start
  // implementation" link uses), scoped onto the picked project with the pure `scopeTo` helper
  // rather than the context-aware `Link`/`useNavigate` wrappers — this route mounts with no
  // `ProjectScopeRoute` above it, so there is no ambient project to fall back to.
  const goToProject = (projectId: string) => {
    navigate(scopeTo(projectId, newTaskPrefillHref({ ref: body.trim() })))
  }

  return (
    <form onSubmit={submit} className="flex flex-1 flex-col gap-4 p-3 md:p-5">
      <TargetPill onPickProject={goToProject} />

      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="What needs doing? cezar-plus reads your registered projects and works out which ones this implies."
        aria-label="New task"
        rows={6}
      />

      {/* Visible text, not a `title` attribute (D3) — invisible-on-hover is exactly the flaw this
       *  composer is fixing relative to the per-project one. `data-slot` gives the test a stable
       *  hook independent of the exact wording. The copy SWAPS with the toggle rather than adding
       *  a caveat to one paragraph, so the page never states a capability the current state does
       *  not have — a "this may also do X" hedge under an off toggle is still a claim about what
       *  submitting does. Both variants are exact — no "autonomous mode" — and both say plainly
       *  that a run never pushes and can stop early on its step budget with the work incomplete
       *  (PLAN D27 Phase 4a: a budget stop renders distinctly everywhere run status shows, so this
       *  is not a silent risk, but the composer still has to say it up front). */}
      <div className="flex max-w-lg items-start justify-between gap-4 rounded-md border border-border p-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="autonomous-toggle" className="text-sm font-medium text-foreground">
            Continue automatically after the spec
          </label>
          <p data-slot="autonomous-explainer" className="text-xs text-muted-foreground">
            {autonomous
              ? 'cezar-plus writes a spec in each detected project, then keeps going: a bounded implementation run starts in the same repo, commits locally, and never pushes. A run can stop early on its step budget with the work incomplete — that shows up clearly on the task, never as a finished run.'
              : 'cezar-plus reads each detected project and writes a spec there. It stops at the spec — you review the proposals, then start the implementation yourself.'}
          </p>
        </div>
        <Switch
          id="autonomous-toggle"
          data-slot="autonomous-toggle"
          checked={autonomous}
          onCheckedChange={setAutonomous}
        />
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!body.trim() || pending}>
          {pending ? 'Starting…' : 'Start task'}
        </Button>
        {error ? <span className="text-sm text-destructive">{error}</span> : null}
      </div>
    </form>
  )
}

/**
 * The project control (D2): a real menu, not a label. "Auto detect" is first and is the resting
 * label — picking it (or closing without picking) leaves this page exactly as it was. Every
 * registered project follows, each a `DropdownMenuRadioItem`: on pick, `onPickProject` NAVIGATES
 * away, so this pill never reflects a project as "selected" — there is nothing to reflect, the
 * page has moved on.
 *
 * A `missing` project (folder gone) is listed but `disabled`, with the reason inline — the same
 * precedent `new-task.tsx`'s own `ProjectPill` follows for its `CommandItem` (line ~972): a
 * disabled row that says why beats a row that silently vanishes. `not-git` is NOT disabled here,
 * matching `ProjectListEntry.status`'s own doc comment — it is "fully usable (degraded
 * single-queue mode)"; only `missing` blocks.
 *
 * Built directly on the `DropdownMenu` primitives (not the shared `PickerPill`) because
 * `PickerPill`'s `options` shape has no per-row `disabled`/reason slot, and that file is outside
 * this page's allowlist. `chipClass`/`chevron` (imported, not edited) keep the trigger's visual
 * grammar identical to every other pill in the app.
 */
function TargetPill({ onPickProject }: { onPickProject: (projectId: string) => void }) {
  const projects = useProjects()
  const registry = projects.data?.projects ?? []

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" data-slot="target-pill" aria-label="Target project" className={chipClass}>
          Auto detect
          {chevron}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-testid="target-pill-menu">
        <DropdownMenuRadioGroup
          value="auto"
          onValueChange={(value) => {
            if (value === 'auto') return
            onPickProject(value)
          }}
        >
          <DropdownMenuRadioItem value="auto">Auto detect</DropdownMenuRadioItem>
          {registry.length > 0 ? <DropdownMenuSeparator /> : null}
          {registry.map((project) => (
            <DropdownMenuRadioItem
              key={project.id}
              value={project.id}
              disabled={project.status === 'missing'}
              data-project-id={project.id}
            >
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              {project.status === 'missing' ? (
                <span className="shrink-0 text-[11px] text-soft-foreground">folder not found</span>
              ) : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
