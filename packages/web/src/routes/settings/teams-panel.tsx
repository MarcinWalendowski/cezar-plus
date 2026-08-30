import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2Icon, LockIcon, LogInIcon, TriangleAlertIcon } from 'lucide-react'
import { useState } from 'react'

import type { CreateTeamInput, RenameTeamInput, Team } from '@loki-labs/cezar-plus-api-client'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/ui/toaster'
import { SettingsField } from './settings-field'
import { createTeam, probeTeams, renameTeam, type TeamsProbe } from './teams-api'

/**
 * The actual Settings → Teams content (D2/D12, Phase 5c) — dynamically imported by
 * `teams-section.tsx`, which is the file that owns why this is a separate module. List every team
 * in the caller's own org, create a new one, rename any one — the three surfaces D2's own
 * 2026-08-07 amendment named as missing ("`IdentityStore.createTeam` has no HTTP caller;
 * `PATCH /auth/onboarding/team` is the only rename surface and reaches only the caller's own first
 * team, once"). Reassigning a PROJECT's team is a Settings → Projects surface, not this one — see
 * `projects-section.tsx`'s own `teamOptions`/`GET /auth/teams` wiring, already landed by that file's
 * own Fill unit as of this pass.
 *
 * `list` is open to any signed-in member (`packages/contract/src/orgs.ts#listTeamsResponseSchema`'s
 * own doc comment); `create`/`rename` are D12 org-administration acts, gated server-side by
 * `require-org-admin.ts`. This pane does not try to hedge that client-side (no local "am I an
 * admin" probe) — a `member` sees the same form an `owner`/`admin` does and learns the boundary from
 * the server's own 403, shown inline, the same way `NameOrgStep`/`AcceptTeamStep` in `onboarding.tsx`
 * surface every other admin-decided refusal.
 */

const TEAMS_QUERY_KEY = ['settings', 'teams'] as const

function useTeamsProbe() {
  return useQuery({
    queryKey: TEAMS_QUERY_KEY,
    queryFn: ({ signal }) => probeTeams(signal),
  })
}

export function TeamsPanel() {
  const probe = useTeamsProbe()

  if (probe.isPending) {
    return (
      <p data-slot="teams-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading workspaces…
      </p>
    )
  }
  if (probe.isError) {
    return (
      <CenteredState
        icon={<TriangleAlertIcon />}
        tone="danger"
        title="Could not load workspaces"
        subtitle={probe.error instanceof Error ? probe.error.message : 'The cezar-plus server did not answer.'}
        actions={
          <Button variant="outline" onClick={() => void probe.refetch()}>
            Try again
          </Button>
        }
        heading="h2"
      />
    )
  }
  return <TeamsBody probe={probe.data} />
}

function TeamsBody({ probe }: { probe: TeamsProbe }) {
  if (probe.kind === 'unavailable') {
    return (
      <CenteredState
        icon={<LockIcon />}
        tone="neutral"
        title="Sign-in isn't set up on this deployment"
        subtitle="This cezar-plus instance runs without authentication — there is no organization to manage workspaces for."
        heading="h2"
      />
    )
  }
  // FIX C3 (second adversarial review, 2026-08-07): this used to fall through to `probe.isError`
  // above, which rendered the generic `tone="danger"` "Could not load workspaces" card — a RED
  // ERROR CARD for the ordinary, expected state before any org exists. This is the neutral empty
  // state the pre-D13 pane showed for the same moment, restored.
  //
  // **D14 (2026-08-07, owner decision) removed the "Create an organization" re-entry link this
  // branch used to render.** It existed only because D13's now-deleted "decline" behaviour
  // (`onboarding-decline.ts`) could strand a browser on this state indefinitely with no other way
  // back into `/onboarding`. D14 reverses that: the cockpit is now gated on onboarding, so Settings
  // itself cannot render while no org exists (`app-shell-container.tsx`'s `chromeless` — see D14,
  // `.ai/specs/2026-08-06-org-team-auth-onboarding.md`) — `routes.tsx#OnboardingEntryGate` gets
  // there first. This branch is defensive rather than reachable in ordinary use (a probe race
  // against that gate, e.g.), so it stays a plain, actionless explainer rather than a link back to
  // a wizard the user should already be looking at.
  if (probe.kind === 'no-org') {
    return (
      <CenteredState
        icon={<Building2Icon />}
        tone="neutral"
        title="No organization yet"
        subtitle="This deployment has no organization yet."
        heading="h2"
      />
    )
  }
  if (probe.kind === 'signed-out') {
    return (
      <CenteredState
        icon={<LogInIcon />}
        tone="primary"
        title="Sign in to manage workspaces"
        subtitle="This cezar-plus instance requires sign-in. Continue with your identity provider to see and manage your organization's workspaces."
        actions={
          <Button asChild data-slot="teams-sign-in">
            <a href="/auth/login">Sign in</a>
          </Button>
        }
        heading="h2"
      />
    )
  }
  return <TeamsPane teams={probe.teams} />
}

function TeamsPane({ teams }: { teams: Team[] }) {
  return (
    <div
      data-slot="teams-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <CreateTeamField />
      <TeamsTable teams={teams} />
    </div>
  )
}

/** D2's own examples (`engineering`, `marketing`) are two independent fields on the wire, not one
 *  derived from the other — `createTeamInputSchema`'s own doc comment: an admin creating a team
 *  "reasonably wants to pick the slug a project-team filter will show, not have one silently
 *  generated from a name they may rename later." So this form asks for both, plainly. */
function CreateTeamField() {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const create = useMutation({
    mutationFn: (input: CreateTeamInput) => createTeam(input),
  })

  const incomplete = name.trim() === '' || slug.trim() === ''
  const submit = () => {
    if (incomplete || create.isPending) return
    const trimmedName = name.trim()
    create.mutate(
      { name: trimmedName, slug: slug.trim() },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: TEAMS_QUERY_KEY })
          setName('')
          setSlug('')
          toast(`Workspace "${trimmedName}" created`)
        },
      },
    )
  }

  return (
    <SettingsField
      title="Create a workspace"
      hint="Workspaces group projects for filtering — engineering, marketing, whatever your org uses. Creating or renaming a workspace needs an owner or admin role; assigning a project to one happens from Settings → Projects."
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="grid gap-1.5">
          <Label htmlFor="teams-create-name">Name</Label>
          <Input
            id="teams-create-name"
            data-slot="teams-create-name"
            value={name}
            disabled={create.isPending}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
            }}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="teams-create-slug">Slug</Label>
          <Input
            id="teams-create-slug"
            data-slot="teams-create-slug"
            spellCheck={false}
            value={slug}
            disabled={create.isPending}
            onChange={(event) => setSlug(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
            }}
          />
        </div>
        <Button
          type="button"
          data-slot="teams-create-submit"
          disabled={incomplete || create.isPending}
          onClick={submit}
        >
          {create.isPending ? 'Creating…' : 'Create workspace'}
        </Button>
      </div>
      {create.isError ? (
        <p data-slot="teams-create-error" role="alert" className="text-[13px] text-danger">
          {create.error instanceof Error ? create.error.message : 'could not create the workspace'}
        </p>
      ) : null}
    </SettingsField>
  )
}

function TeamsTable({ teams }: { teams: Team[] }) {
  const sorted = [...teams].sort((a, b) => a.name.localeCompare(b.name))
  return (
    <SettingsField
      title="Workspaces"
      hint="Every workspace in your organization."
    >
      {sorted.length === 0 ? (
        <p data-slot="teams-empty" className="text-[13px] text-soft-foreground">
          No workspaces yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Workspaces in your organization</caption>
            <thead>
              <tr className="border-b border-border text-left text-[12px] text-soft-foreground">
                <th scope="col" className="px-3 py-2 font-medium">Name</th>
                <th scope="col" className="px-3 py-2 font-medium">Slug</th>
                <th scope="col" className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((team) => (
                <TeamRow key={team.id} team={team} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsField>
  )
}

/** Inline edit, one row at a time — "edited locally, saved explicitly" (`projects-section.tsx`'s
 *  own `WorkspaceRootField` idiom), scoped per row instead of per pane. */
function TeamRow({ team }: { team: Team }) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(team.name)
  const rename = useMutation({
    mutationFn: (input: RenameTeamInput) => renameTeam(team.id, input),
  })

  const cancel = () => {
    setEditing(false)
    setName(team.name)
    rename.reset()
  }

  const save = () => {
    const trimmed = name.trim()
    if (trimmed === '' || rename.isPending) return
    if (trimmed === team.name) {
      setEditing(false)
      return
    }
    rename.mutate(
      { name: trimmed },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: TEAMS_QUERY_KEY })
          setEditing(false)
          toast(`Workspace renamed to "${trimmed}"`)
        },
      },
    )
  }

  return (
    <tr data-slot="team-row" data-team={team.id} className="border-b border-border last:border-0">
      <td className="px-3 py-2">
        {editing ? (
          <div className="flex flex-col gap-1">
            <Input
              aria-label={`Rename ${team.name}`}
              data-slot="team-rename-name"
              autoFocus
              value={name}
              disabled={rename.isPending}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') save()
                if (event.key === 'Escape') cancel()
              }}
              className="h-8"
            />
            {rename.isError ? (
              <p data-slot="team-rename-error" role="alert" className="text-[11px] text-danger">
                {rename.error instanceof Error ? rename.error.message : 'could not rename the workspace'}
              </p>
            ) : null}
          </div>
        ) : (
          <span className="text-foreground">{team.name}</span>
        )}
      </td>
      <td className="px-3 py-2 font-mono text-[12px] text-soft-foreground">{team.slug}</td>
      <td className="px-3 py-2 text-right">
        {editing ? (
          <div className="flex justify-end gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-action="team-rename-cancel"
              disabled={rename.isPending}
              onClick={cancel}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-action="team-rename-save"
              disabled={name.trim() === '' || rename.isPending}
              onClick={save}
            >
              {rename.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        ) : (
          <Button type="button" variant="ghost" size="sm" data-action="team-rename" onClick={() => setEditing(true)}>
            Rename
          </Button>
        )}
      </td>
    </tr>
  )
}
