import { useMutation, useQuery } from '@tanstack/react-query'
import { Building2Icon, FolderPlusIcon, LockIcon, LogInIcon, MailQuestionIcon, TriangleAlertIcon, UsersIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

import type {
  CreateOnboardingOrgInput,
  Org,
  RenameOnboardingTeamInput,
  Role,
  Team,
} from '@open-mercato/cezar-api-client'
import { AddProjectDialog } from '@/components/add-project-dialog'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import { createOnboardingOrg, probeOnboarding, renameOnboardingTeam, type OnboardingProbe } from './onboarding-api'

/**
 * `/onboarding` (D8, spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`, phase 4).
 *
 * Workspace-level — mounted OUTSIDE `ProjectScopeRoute` in `routes.tsx`, the same shape as
 * `/notes`/`/workspace/tasks`: there is no project (and possibly no org) yet, so nothing here can
 * hang off a project scope. D8's four steps, one screen each: **sign in** → **name the
 * organization** → **accept the pre-filled default team** (one click) → **add projects**. Steps
 * 2-4 are skippable and resumable by construction — see `fromProbe` below.
 *
 * **Invisible and inert with `CEZ_AUTH` unset.** No capability key gates this page (that control
 * is deliberately not spent here — see `onboarding-api.ts`'s module doc comment and
 * `BACKWARD_COMPATIBILITY.md` §2). The ONE request this route makes on mount
 * (`GET /auth/onboarding`) IS the probe: when auth is off the server never registered `/auth/*`
 * at all, so the SPA catch-all answers with `index.html` — a 200 that isn't JSON — and
 * `probeOnboarding` reports that as `auth-off`, which renders a quiet, static explainer and
 * issues no further request, mutation, or dialog. `onboarding.test.tsx`'s
 * `describe('CEZ_AUTH unset — the surface is inert')` is the negative control for this.
 */
export function OnboardingRoute() {
  const probe = useOnboardingProbe()
  const [wizard, setWizard] = useState<WizardState | null>(null)
  const navigate = useNavigate()

  // `/auth/callback` redirects EVERY sign-in here (that redirect is the only seam pointing at this
  // route — see its own comment in `auth/routes.ts`), so an already-onboarded user has to be sent
  // straight on rather than shown "Add your first project" they finished months ago. `replace`, so
  // the back button does not bounce them into the wizard again.
  useEffect(() => {
    if (wizard?.step === 'done') navigate('/', { replace: true })
  }, [wizard, navigate])

  // Seeded from the probe exactly ONCE, on first resolve — never re-derived on a later refetch.
  // There is no polling and no invalidation of this query from outside this file, so in practice
  // this only ever runs once per mount; guarding on `wizard === null` anyway is what keeps a
  // user's in-progress step (e.g. mid-edit on the org-name field) safe from being clobbered by a
  // stale re-read, the same discipline `workspace-tasks.tsx`'s filter-restore effect follows.
  useEffect(() => {
    if (wizard !== null || probe.data === undefined) return
    setWizard(fromProbe(probe.data))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probe.data])

  return (
    <div data-route="onboarding" className="flex min-h-full flex-col">
      <div className="flex flex-1 flex-col p-3 md:p-5">
        {probe.isError ? (
          <CenteredState
            icon={<TriangleAlertIcon />}
            tone="danger"
            title="Could not check sign-in status"
            subtitle={probe.error instanceof Error ? probe.error.message : 'The cezar server did not answer.'}
            actions={
              <Button variant="outline" onClick={() => void probe.refetch()}>
                Try again
              </Button>
            }
          />
        ) : wizard === null ? (
          <p className="px-4 py-6 text-center text-xs text-soft-foreground">Loading…</p>
        ) : wizard.step === 'auth-off' ? (
          <CenteredState
            icon={<LockIcon />}
            tone="neutral"
            title="Sign-in isn't set up on this deployment"
            subtitle="This cezar instance runs without authentication — there is no organization to onboard into."
          />
        ) : wizard.step === 'sign-in' ? (
          <SignInStep />
        ) : wizard.step === 'needs-invite' ? (
          <NeedsInviteStep />
        ) : wizard.step === 'done' ? (
          // The redirect above is already in flight; rendering the loading line rather than a
          // step avoids a one-frame flash of "Add your first project" on the way out.
          <p className="px-4 py-6 text-center text-xs text-soft-foreground">Loading…</p>
        ) : wizard.step === 'name-org' ? (
          <NameOrgStep
            suggestedName={wizard.suggestedOrgName}
            bootstrapTokenRequired={wizard.bootstrapTokenRequired}
            onCreated={(result) => setWizard({ step: 'accept-team', ...result })}
          />
        ) : wizard.step === 'accept-team' ? (
          <AcceptTeamStep team={wizard.team} onAccepted={(team) => setWizard({ ...wizard, team, step: 'add-projects' })} />
        ) : (
          <AddProjectsStep org={wizard.org} team={wizard.team} />
        )}
      </div>
    </div>
  )
}

// ---- the probe query ----------------------------------------------------------------------------

/** Not in `queries.ts`'s shared registry on purpose: nothing outside this route reads or
 *  invalidates onboarding status, so a local key avoids adding a workspace-wide query the rest of
 *  the cockpit never touches. Retry/staleTime come from `createQueryClient`'s defaults
 *  (`query-client.ts`) — a 4xx-adjacent probe answer never retries, which matters here because a
 *  401 is a normal, expected `probeOnboarding` RESULT (`signed-out`), not a thrown error at all. */
function useOnboardingProbe() {
  return useQuery({
    queryKey: ['onboarding', 'status'] as const,
    queryFn: ({ signal }) => probeOnboarding(signal),
  })
}

// ---- the wizard's own step state -----------------------------------------------------------------

type WizardState =
  | { step: 'auth-off' }
  | { step: 'sign-in' }
  /** Signed in, an org exists, this user is not in it (D8 step 1). A terminal screen, not a step:
   *  there is nothing here for them to do until someone invites them. */
  | { step: 'needs-invite' }
  | { step: 'name-org'; suggestedOrgName?: string; bootstrapTokenRequired: boolean }
  | { step: 'accept-team'; org: Org; team: Team; role: Role }
  | { step: 'add-projects'; org: Org; team: Team; role: Role }
  /** Onboarding is finished — the effect above navigates to `/`. A state rather than a call from
   *  inside `fromProbe` because navigating during a render is a React error. */
  | { step: 'done' }

/**
 * Resumability (D8: "a half-finished onboarding must not strand an org with no team, so the
 * default team is created on org creation and the step only renames it") falls straight out of
 * this mapping: `needs-org` can only mean step 1 is done and nothing else is, so it always starts
 * at `name-org`; `ready` means an org AND its default team already exist (they are created in the
 * SAME call — `createOnboardingOrg`, D8 step 1+2), so the only work possibly still outstanding is
 * step 4, and that is where a reload lands. There is deliberately no server-side "which step was
 * the user on" flag for the `accept-team` screen itself — it is reached only via
 * `NameOrgStep.onCreated` in the SAME session that just created the org, per this file's own
 * "one click" requirement; reloading past it into `ready` is not a lost step, because a resumed
 * user finds their team already named exactly what they last saw (either their own edit, already
 * persisted, or the untouched suggestion — both are the accepted state).
 */
function fromProbe(probe: OnboardingProbe): WizardState {
  switch (probe.kind) {
    case 'auth-off':
      return { step: 'auth-off' }
    case 'signed-out':
      return { step: 'sign-in' }
    case 'needs-invite':
      return { step: 'needs-invite' }
    case 'needs-org':
      return {
        step: 'name-org',
        suggestedOrgName: probe.suggestedOrgName,
        bootstrapTokenRequired: probe.bootstrapTokenRequired,
      }
    case 'ready':
      // `hasProjects` is what makes this route safe as the universal post-login landing spot: a
      // user who already finished onboarding is sent on to `/` instead of being asked, forever,
      // to add their first project (fixed 2026-08-07 — the field was computed by the route and
      // read by nobody).
      return probe.hasProjects
        ? { step: 'done' }
        : { step: 'add-projects', org: probe.org, team: probe.team, role: probe.role }
  }
}

// ---- step 1: sign in ------------------------------------------------------------------------------

/** A real navigation, not a client-side route change: `GET /auth/login` 302s to the IdP, which a
 *  fetch cannot follow into a top-level browser redirect. `asChild` hands the button's styling to
 *  a plain `<a>`, same pattern `clone-project-dialog.tsx` uses for its settings link. */
function SignInStep() {
  return (
    <CenteredState
      icon={<LogInIcon />}
      tone="primary"
      title="Sign in to set up your organization"
      subtitle="This cezar instance requires sign-in. Continue with your identity provider to create or join an organization."
      actions={
        <Button asChild data-slot="onboarding-sign-in">
          <a href="/auth/login">Sign in</a>
        </Button>
      }
    />
  )
}

// ---- terminal: signed in, but this deployment already belongs to someone --------------------------

/** D8 step 1's second half ("subsequent users need an invite"), which phase 4 shipped as a 409 on
 *  a form it had already invited the user to fill in. There is no invite HTTP surface yet — see
 *  the spec's D8 amendment — so this screen is honest about the only thing that can happen next:
 *  someone who is already in the org has to add them. It names no org, no owner and no size,
 *  because the server sends none: an unauthorized caller learns nothing from this page that they
 *  did not already know by reaching it. */
function NeedsInviteStep() {
  return (
    <CenteredState
      icon={<MailQuestionIcon />}
      tone="neutral"
      title="You need an invite to join this deployment"
      subtitle="You're signed in, but this cezar already belongs to an organization. Ask one of its owners to invite you — until then there is nothing here for you to set up."
    />
  )
}

// ---- step 2: name the organization -------------------------------------------------------------

function NameOrgStep({
  suggestedName,
  bootstrapTokenRequired,
  onCreated,
}: {
  suggestedName?: string
  bootstrapTokenRequired: boolean
  onCreated: (result: { org: Org; team: Team; role: Role }) => void
}) {
  const [name, setName] = useState(suggestedName ?? '')
  const [bootstrapToken, setBootstrapToken] = useState('')
  const create = useMutation({
    mutationFn: (input: CreateOnboardingOrgInput) => createOnboardingOrg(input),
  })

  const incomplete = name.trim() === '' || (bootstrapTokenRequired && bootstrapToken.trim() === '')
  const submit = () => {
    if (incomplete || create.isPending) return
    create.mutate(
      {
        name: name.trim(),
        // Omitted entirely when the deployment said it does not want one, rather than sent as an
        // empty string — the contract's field is `.optional()`, and an empty string is a value.
        ...(bootstrapTokenRequired ? { bootstrapToken: bootstrapToken.trim() } : {}),
      },
      { onSuccess: (result) => onCreated(result) },
    )
  }

  return (
    <CenteredState
      icon={<Building2Icon />}
      tone="primary"
      title="Name your organization"
      subtitle="Everyone you invite will share this organization's projects and shell — see the docs before inviting anyone."
      actions={
        <Button data-slot="onboarding-org-submit" disabled={incomplete || create.isPending} onClick={submit}>
          {create.isPending ? 'Creating…' : 'Create organization'}
        </Button>
      }
    >
      <div className="grid gap-1.5 text-left">
        <Label htmlFor="onboarding-org-name">Organization name</Label>
        <Input
          id="onboarding-org-name"
          data-slot="onboarding-org-name"
          autoFocus
          value={name}
          disabled={create.isPending}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
          }}
        />
        {/* The operator's bootstrap code (`auth/bootstrap-claim.ts`). Rendered only when the
            server said it wants one, so a deployment running CEZ_AUTH_BOOTSTRAP_OPEN=1 sees the
            single-field form phase 4 shipped. */}
        {bootstrapTokenRequired ? (
          <>
            <Label htmlFor="onboarding-bootstrap-token">Bootstrap code</Label>
            <Input
              id="onboarding-bootstrap-token"
              data-slot="onboarding-bootstrap-token"
              autoComplete="off"
              spellCheck={false}
              value={bootstrapToken}
              disabled={create.isPending}
              onChange={(event) => setBootstrapToken(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit()
              }}
            />
            <p className="text-[13px] text-soft-foreground">
              Printed in this server&rsquo;s startup log. It proves you are the operator, not just
              the first person to reach the sign-in page.
            </p>
          </>
        ) : null}
        {create.isError ? (
          <p data-slot="onboarding-org-error" className="text-[13px] text-danger">
            {create.error instanceof Error ? create.error.message : 'could not create the organization'}
          </p>
        ) : null}
      </div>
    </CenteredState>
  )
}

// ---- step 3: accept the default team -------------------------------------------------------------

/**
 * **CORRECTED 2026-08-07 (repair stage).** This read "…or rename it now — you can rename it again
 * later", and nothing in the cockpit can. `PATCH /auth/onboarding/team` is the only rename surface
 * in the product and this screen is the only caller: a reload resolves `ready` and lands on
 * `add-projects`, never back here. Team management (create/rename/reassign) is deferred — see the
 * spec's D2 amendment — so the copy states what is true today rather than promising a screen that
 * does not exist. `marketing-site-copy-rules`-style honesty applies to product copy too: an
 * absolute claim on a page has to be true.
 */
const ACCEPT_TEAM_SUBTITLE =
  'Projects you register are assigned to a team. Accept the suggested name, or rename it now — this is the one place to change it until team management ships.'

/** "One click to accept" (D8 step 3, the owner's explicit ask): the suggested name round-trips
 *  with no network call at all when left untouched — `renameOnboardingTeam` fires only when the
 *  field actually changed. */
function AcceptTeamStep({ team, onAccepted }: { team: Team; onAccepted: (team: Team) => void }) {
  const [name, setName] = useState(team.name)
  const rename = useMutation({
    mutationFn: (input: RenameOnboardingTeamInput) => renameOnboardingTeam(input),
  })

  const accept = () => {
    const trimmed = name.trim()
    if (trimmed === '' || rename.isPending) return
    if (trimmed === team.name) {
      onAccepted(team)
      return
    }
    rename.mutate({ name: trimmed }, { onSuccess: ({ team: renamed }) => onAccepted(renamed) })
  }

  return (
    <CenteredState
      icon={<UsersIcon />}
      tone="primary"
      title="Your default team is ready"
      subtitle={ACCEPT_TEAM_SUBTITLE}
      actions={
        <Button data-slot="onboarding-team-accept" disabled={name.trim() === '' || rename.isPending} onClick={accept}>
          {rename.isPending ? 'Saving…' : 'Accept and continue'}
        </Button>
      }
    >
      <div className="grid gap-1.5 text-left">
        <Label htmlFor="onboarding-team-name">Team name</Label>
        <Input
          id="onboarding-team-name"
          data-slot="onboarding-team-name"
          autoFocus
          value={name}
          disabled={rename.isPending}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') accept()
          }}
        />
        {rename.isError ? (
          <p data-slot="onboarding-team-error" className="text-[13px] text-danger">
            {rename.error instanceof Error ? rename.error.message : 'could not rename the team'}
          </p>
        ) : null}
      </div>
    </CenteredState>
  )
}

// ---- step 4: add projects ------------------------------------------------------------------------

/**
 * Reuses `AddProjectDialog` — the SAME folder-browse-and-register flow every other "Add project"
 * affordance in the cockpit uses — rather than forking it. The only addition anywhere in that
 * flow is `AddProjectDialog`'s new optional `teamId` prop (threaded to `POST /api/v1/projects`
 * through `useRegisterProject`/`registerProject`, both additive changes): every other caller of
 * the dialog omits it and is byte-identical to before.
 *
 * Skippable (D8): "Skip for now" leaves with no project added and no error — the org and its
 * default team already exist, so nothing is stranded. A successful add navigates into the new
 * project's scope (`AddProjectDialog`'s own behavior, unchanged), which finishes onboarding by
 * simply landing the user in the app.
 */
function AddProjectsStep({ org, team }: { org: Org; team: Team }) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const navigate = useNavigate()

  return (
    <>
      <CenteredState
        icon={<FolderPlusIcon />}
        tone="primary"
        title="Add your first project"
        subtitle={`${org.name} is ready. Projects you add now are assigned to ${team.name} — add more later from Settings → Projects.`}
        actions={
          <>
            <Button variant="outline" data-slot="onboarding-skip" onClick={() => navigate('/')}>
              Skip for now
            </Button>
            <Button data-slot="onboarding-add-project" onClick={() => setDialogOpen(true)}>
              Add project
            </Button>
          </>
        }
      />
      <AddProjectDialog open={dialogOpen} onOpenChange={setDialogOpen} teamId={team.id} />
    </>
  )
}
