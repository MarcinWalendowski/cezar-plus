import { NotebookPenIcon } from 'lucide-react'

import { useHealth } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'

/**
 * `/notes` (F3 feature B, central-hub scaffold, `CEZ_NOTES=1`). Workspace-level — mounted
 * OUTSIDE `ProjectScopeRoute` in `routes.tsx` (D14: a note has not yet been assigned to a
 * project).
 *
 * **Placeholder, created by the scaffold** (`.ai/runs/2026-08-06-cezar-central-hub/PLAN.md`
 * "Shared-file ownership") so `routes.tsx` is edited exactly once. P2.4 takes over and FILLS this
 * file with the real inbox — capture textarea, note cards, the review overlay
 * (`.ai/specs/2026-08-06-workspace-notes-cross-project.md` "UI/UX") — a sequenced hand-off, never
 * a concurrent edit with anything here.
 *
 * Until then this renders the same "disabled" pattern `/inbox` uses for `followups`
 * (`routes/inbox.tsx:94-101`): the nav item itself is gated off (`nav-items.ts`), so this only
 * shows for a pasted link or a direct visit, and the flag-off case is never a 404 (D19).
 */
export function NotesRoute() {
  const health = useHealth()
  const notesAvailable = health.data?.capabilities?.notes === true
  const notesOff = health.data !== undefined && !notesAvailable

  return (
    <div data-route="notes" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Notes</h1>
      </header>
      <div className="flex flex-1 flex-col p-3 md:p-5">
        {notesOff ? (
          <CenteredState
            icon={<NotebookPenIcon />}
            tone="neutral"
            title="The notes inbox is off"
            subtitle="Set CEZ_NOTES=1 and restart cezar to turn it on."
            heading="h2"
          />
        ) : (
          <CenteredState
            icon={<NotebookPenIcon />}
            tone="neutral"
            title="Notes is not built yet"
            subtitle="This section arrives in a later phase of the central-hub programme."
            heading="h2"
          />
        )}
      </div>
    </div>
  )
}
