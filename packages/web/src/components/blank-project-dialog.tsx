import { useState } from 'react'
import { useNavigate } from 'react-router'

import { useCreateBlankProject, useProjects } from '@/api/queries'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * "Create blank project" (D15, spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`) — the
 * third way to satisfy the onboarding wizard's project step, beside opening a local folder and
 * cloning from GitHub.
 *
 * Deliberately modelled on `clone-project-dialog.tsx` rather than on `add-project-dialog.tsx`,
 * because it composes a target the same way that one does: `<projectsDir>/<name>`, previewed from
 * the registry response's own `projectsDir` so the preview is a reading of the server's rule and
 * not a second copy of it. The folder browser is the wrong shape here — there is nothing to
 * browse, the parent is a setting, and the only input is a name.
 *
 * **The name is validated as a single path segment, and only loosely, on purpose.** The server's
 * `createBlankProjectInputSchema` is the authority; this checks just enough to disable the button
 * and say why, so a user is not made to round-trip to learn that `../x` is not a folder name. Any
 * disagreement between the two resolves in the server's favour — its error text is what renders.
 *
 * A successful create navigates into the new project's scope, matching what both sibling dialogs
 * do. That is also what finishes onboarding: `useCreateBlankProject` evicts the `['onboarding']`
 * queries, so the entry gate re-reads a probe that now answers `hasProjects: true` and stops
 * gating (see `routes/onboarding/onboarding-gate.ts`).
 */
export function BlankProjectDialog({
  open,
  onOpenChange,
  teamId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Assigns the new project to this team, same additive shape as the other two dialogs. */
  teamId?: string
}) {
  const [name, setName] = useState('')
  const projects = useProjects()
  const create = useCreateBlankProject()
  const navigate = useNavigate()

  const trimmed = name.trim()
  const projectsDir = projects.data?.projectsDir ?? ''
  const target = trimmed === '' ? '' : `${projectsDir.replace(/\/+$/, '')}/${trimmed}`
  // Mirrors the server regex loosely — see the doc comment above on why this is not a second
  // authority. `..` is called out separately because it is the one that reads as a path rather
  // than as a typo, and deserves its own sentence.
  const invalid =
    trimmed !== '' && (trimmed.includes('/') || trimmed.includes('..') || !/^[A-Za-z0-9]/.test(trimmed))

  const submit = () => {
    if (trimmed === '' || invalid || create.isPending) return
    create.mutate(
      { name: trimmed, ...(teamId ? { teamId } : {}) },
      {
        onSuccess: ({ project }) => {
          onOpenChange(false)
          setName('')
          navigate(`/p/${encodeURIComponent(project.id)}/`)
        },
      },
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A closed dialog must not keep a stale error to greet the next opening with — the same
        // `reset()` discipline `add-project-dialog.tsx` applies when it changes folder.
        if (!next) create.reset()
        onOpenChange(next)
      }}
    >
      <DialogContent data-slot="blank-project-dialog">
        <DialogHeader>
          <DialogTitle>Create blank project</DialogTitle>
          <DialogDescription>
            Makes an empty folder and initializes a git repository in it. Change where these land in
            Settings → Projects.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Label htmlFor="blank-project-name">Project name</Label>
          <Input
            id="blank-project-name"
            data-slot="blank-project-name"
            value={name}
            autoFocus
            placeholder="my-project"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
            }}
          />
          {target === '' ? null : (
            <p data-slot="blank-project-target" className="text-[13px] text-soft-foreground">
              Creates <code>{target}</code>
            </p>
          )}
          {invalid ? (
            <p data-slot="blank-project-invalid" role="alert" className="text-[13px] text-danger">
              Use a folder name, not a path — no slashes, no “..”, and start with a letter or number.
            </p>
          ) : null}
          {create.isError ? (
            <p data-slot="blank-project-error" role="alert" className="text-[13px] text-danger">
              {create.error instanceof Error ? create.error.message : 'could not create the project'}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            data-slot="blank-project-create"
            disabled={trimmed === '' || invalid || create.isPending}
            onClick={submit}
          >
            {create.isPending ? 'Creating…' : 'Create project'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
