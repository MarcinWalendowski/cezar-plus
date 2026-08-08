import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Building2Icon,
  FilePlus2Icon,
  FolderOpenIcon,
  FolderPlusIcon,
  LockIcon,
  LogInIcon,
  MailQuestionIcon,
  TriangleAlertIcon,
  UsersIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

import type {
  CreateOnboardingOrgInput,
  CreateTeamInput,
  Org,
  RenameOnboardingTeamInput,
  Role,
  Team,
} from '@open-mercato/cezar-api-client'
import { useHealth } from '@/api/queries'
// The local brand glyph, not a lucide icon — `app-shell.tsx`'s own "Clone from GitHub…" menu
// item uses this exact one, and lucide dropped brand icons.
import { GithubIcon } from '@/components/icons'
import { AddProjectDialog } from '@/components/add-project-dialog'
import { BlankProjectDialog } from '@/components/blank-project-dialog'
import { CloneProjectDialog } from '@/components/clone-project-dialog'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
// `POST /auth/teams` — the same public function Settings → Workspaces uses
// (`settings/teams-panel.tsx`), reused rather than duplicated: `AddWorkspaceField` below is a
// second CALLER of an already-tested function, not a second implementation of the request.
import { createTeam } from '@/routes/settings/teams-api'

import { createOnboardingOrg, probeOnboarding, renameOnboardingTeam, type OnboardingProbe } from './onboarding-api'

/**
 * `/onboarding` (D8, spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`, phase 4; D13 local
 * mode, same spec, phase 9).
 *
 * Workspace-level — mounted OUTSIDE `ProjectScopeRoute` in `routes.tsx`, the same shape as
 * `/notes`/`/workspace/tasks`: there is no project (and possibly no org) yet, so nothing here can
 * hang off a project scope. D8's steps, one screen each: **sign in** (skipped entirely in local
 * mode, D13 — there is nothing to sign into) → **name the organization** → **accept the
 * pre-filled default workspace, and optionally add more** (D13) → **add projects**. Every step
 * after the first is skippable and resumable by construction — see `fromProbe` below.
 *
 * **CORRECTED 2026-08-07 (D13 cockpit pass): "Invisible and inert with `CEZ_AUTH` unset" below
 * described the WHOLE `CEZ_AUTH`-unset population, and is no longer true of most of it.** D13
 * mounts a real `onboardingRoutes` for the npm zero-config default (loopback bind, `CEZ_AUTH`
 * unset — `capabilities.localHandoff`), so THAT deployment now runs the full wizard, same as an
 * authenticated one — `routes.tsx#OnboardingEntryGate` is what routes a first-run local user here
 * automatically. What the paragraph below still correctly describes is the one topology D13
 * deliberately excludes: hosted, `CEZ_AUTH` unset, `CEZ_ALLOW_UNAUTHENTICATED=1` (D9's
 * bounded-audience escape hatch) — there `/auth/*` still mounts nothing, so this route still
 * renders the quiet explainer below for it. `onboarding-api.ts`'s own module doc comment has the
 * full mechanism; the probe's kind for this case is `unavailable`, not `auth-off` (renamed for
 * the same reason).
 *
 * **Invisible and inert on that one remaining topology only.** No capability key gates this page
 * (that control is deliberately not spent here — see `onboarding-api.ts`'s module doc comment and
 * `BACKWARD_COMPATIBILITY.md` §2). The ONE request this route makes on mount
 * (`GET /auth/onboarding`) IS the probe: when the deployment mounts no `/auth/*` surface at all,
 * the SPA catch-all answers with `index.html` — a 200 that isn't JSON — and `probeOnboarding`
 * reports that as `unavailable`, which renders a quiet, static explainer and issues no further
 * request, mutation, or dialog. `onboarding.test.tsx`'s own describe block for this case is the
 * negative control.
 */
export function OnboardingRoute() {
  const probe = useOnboardingProbe()
  const [wizard, setWizard] = useState<WizardState | null>(null)
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // `/auth/callback` redirects EVERY sign-in here (that redirect is the only seam pointing at this
  // route — see its own comment in `auth/routes.ts`), so an already-onboarded user has to be sent
  // straight on rather than shown "Add your first project" they finished months ago. `replace`, so
  // the back button does not bounce them into the wizard again.
  //
  // **ADDED 2026-08-07 (D13 review, FIX 9): evict every `['onboarding', ...]` query on the way
  // out.** This route's own probe (`['onboarding','status']`, below) AND
  // `routes.tsx#OnboardingEntryGate`'s separate `['onboarding','entry-probe']` share that key
  // prefix on purpose. Without this, either cache can keep answering the `needs-org` it fetched
  // BEFORE the org existed: a return visit to `/onboarding` (back button, a stray relink) remounts
  // onto that stale answer and renders `NameOrgStep` again for an org that already exists —
  // submitting it 409s. `removeQueries`, not `invalidateQueries`: invalidating only marks the
  // cached `needs-org` value stale and triggers a background refetch, but a fresh mount still
  // seeds `wizard` SYNCHRONOUSLY from that stale value on its first render (`fromProbe` below runs
  // before the refetch can land) — one render of the wrong step is exactly the window a fast
  // resubmit lands in. Removing the entry outright leaves nothing to seed from until the real
  // fetch resolves, so a return visit shows the loading line instead of a flash of `NameOrgStep`.
  // `handleOrgCreated` below evicts at the earlier, more precise moment (the org is created); this
  // is the second, defensive eviction for the "hasProjects" resume path, which never calls that
  // handler at all.
  useEffect(() => {
    if (wizard?.step !== 'done') return
    void queryClient.removeQueries({ queryKey: ['onboarding'] })
    navigate('/', { replace: true })
  }, [wizard, navigate, queryClient])

  // The org (and its default team) now exist — every cached onboarding probe answer is stale from
  // this instant, in BOTH `NameOrgStep`'s and `NeedsInviteStep`'s success paths (both create the
  // org: the ordinary D8 flow and the D11 claim form). See the effect above for why this matters.
  const handleOrgCreated = (result: { org: Org; team: Team; role: Role }) => {
    void queryClient.removeQueries({ queryKey: ['onboarding'] })
    setWizard({ step: 'accept-team', ...result })
  }

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
        ) : wizard.step === 'unavailable' ? (
          <CenteredState
            icon={<LockIcon />}
            tone="neutral"
            title="Sign-in isn't set up on this deployment"
            subtitle="This cezar instance runs without authentication — there is no organization to onboard into."
          />
        ) : wizard.step === 'sign-in' ? (
          <SignInStep />
        ) : wizard.step === 'needs-invite' ? (
          <NeedsInviteStep onClaimed={handleOrgCreated} />
        ) : wizard.step === 'done' ? (
          // The redirect above is already in flight; rendering the loading line rather than a
          // step avoids a one-frame flash of "Add your first project" on the way out.
          <p className="px-4 py-6 text-center text-xs text-soft-foreground">Loading…</p>
        ) : wizard.step === 'name-org' ? (
          <NameOrgStep
            suggestedName={wizard.suggestedOrgName}
            bootstrapTokenRequired={wizard.bootstrapTokenRequired}
            onCreated={handleOrgCreated}
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
  | { step: 'unavailable' }
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
    case 'unavailable':
      return { step: 'unavailable' }
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
 *  a form it had already invited the user to fill in.
 *
 *  **CORRECTED 2026-08-07 (phases 5b/5c/8): the invite HTTP surface now exists** —
 *  `POST /auth/invites`, `GET /auth/invites`, `POST /auth/invites/revoke` and
 *  `POST /auth/invites/redeem` (`auth/invite-routes.ts`) — so the sentence this replaces is
 *  stale. What has NOT landed is a cockpit screen that consumes `POST /auth/invites/redeem`, so
 *  "ask one of its owners to invite you" below is still the only thing a user reaching THIS
 *  screen can do from the browser; an owner sends the invite id out of band (email, chat) rather
 *  than through a link this wizard resolves. This screen is still honest about the only thing
 *  that can happen next from here — it names no org, no owner and no size, because the server
 *  sends none: an unauthorized caller learns nothing from this page that they did not already
 *  know by reaching it.
 *
 *  **ADDED 2026-08-07 (5b/5c/8 repair stage): the D11 claim form, behind a disclosure.** The
 *  scaffold pass left "the claim-mode UX inside the wizard is undesigned" as a named gap, and the
 *  consequence turned out to be larger than a missing nicety: `hetzner.ts` runs its `org-create`
 *  step for EVERY `--org-slug` install, including the deployment's first, so `listOrgs().length >
 *  0` from that moment and `GET /auth/onboarding` answers `needs-invite` to every membership-less
 *  user — including an org's own intended owner, holding that org's one-time code, being told to
 *  ask an owner who does not exist yet. The only working path was a hand-crafted
 *  `POST /auth/onboarding/org`, which made phase 8's own verification row unexecutable through
 *  the product on the one platform that has orgs.
 *
 *  **Collapsed by default, and it reveals nothing.** The server deliberately does not tell this
 *  route that a claimable org exists, or what its slug is (`onboarding-routes.ts`'s own comment:
 *  "knowing an org exists and can be claimed is itself privileged information the operator hands
 *  out of band, the same channel that already carries the code"). So this is a form the user must
 *  already know to fill in — both fields typed from the installer's output — never a hint that
 *  there is something here to claim. Opening it issues no request; the wizard's terminal message
 *  above is unchanged and still the primary answer.
 *
 *  Deliberately NOT a redeem-an-invite form: that is a different credential with a different
 *  failure mode, and no phase has designed its UX. Still open, still named. */
function NeedsInviteStep({ onClaimed }: { onClaimed: (result: { org: Org; team: Team; role: Role }) => void }) {
  const [claiming, setClaiming] = useState(false)

  return (
    <CenteredState
      icon={<MailQuestionIcon />}
      tone="neutral"
      title="You need an invite to join this deployment"
      subtitle="You're signed in, but this cezar already belongs to an organization. Ask one of its owners to invite you — until then there is nothing here for you to set up."
      actions={
        claiming ? undefined : (
          <Button variant="outline" data-slot="onboarding-claim-open" onClick={() => setClaiming(true)}>
            I have an organization code
          </Button>
        )
      }
    >
      {claiming ? <ClaimOrgForm onClaimed={onClaimed} /> : null}
    </CenteredState>
  )
}

/** The D11 claim: `POST /auth/onboarding/org` with `{ orgSlug, bootstrapToken }`. Both values come
 *  from the operator who ran `cezar server-install --platform hetzner --org-slug <slug>` — the slug
 *  they chose and the one-time code that command printed. The server answers the identical 403 for
 *  "no such org" and "wrong code" (no slug-enumeration oracle), so this form surfaces the server's
 *  `{error}` verbatim rather than guessing which half was wrong. */
function ClaimOrgForm({ onClaimed }: { onClaimed: (result: { org: Org; team: Team; role: Role }) => void }) {
  const [orgSlug, setOrgSlug] = useState('')
  const [bootstrapToken, setBootstrapToken] = useState('')
  const claim = useMutation({
    mutationFn: (input: CreateOnboardingOrgInput) => createOnboardingOrg(input),
  })

  const incomplete = orgSlug.trim() === '' || bootstrapToken.trim() === ''
  const submit = () => {
    if (incomplete || claim.isPending) return
    claim.mutate(
      { orgSlug: orgSlug.trim(), bootstrapToken: bootstrapToken.trim() },
      { onSuccess: (result) => onClaimed(result) },
    )
  }

  return (
    <div className="grid gap-1.5 text-left" data-slot="onboarding-claim-form">
      <Label htmlFor="onboarding-claim-slug">Organization ID</Label>
      <Input
        id="onboarding-claim-slug"
        data-slot="onboarding-claim-slug"
        autoFocus
        autoComplete="off"
        spellCheck={false}
        value={orgSlug}
        disabled={claim.isPending}
        onChange={(event) => setOrgSlug(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit()
        }}
      />
      <Label htmlFor="onboarding-claim-token">Organization code</Label>
      <Input
        id="onboarding-claim-token"
        data-slot="onboarding-claim-token"
        autoComplete="off"
        spellCheck={false}
        value={bootstrapToken}
        disabled={claim.isPending}
        onChange={(event) => setBootstrapToken(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit()
        }}
      />
      <p className="text-[13px] text-soft-foreground">
        Both come from whoever set this organization up on the server. The code works once, and
        only for that one organization.
      </p>
      {claim.isError ? (
        <p data-slot="onboarding-claim-error" className="text-[13px] text-danger">
          {claim.error instanceof Error ? claim.error.message : 'could not claim that organization'}
        </p>
      ) : null}
      <div>
        <Button data-slot="onboarding-claim-submit" disabled={incomplete || claim.isPending} onClick={submit}>
          {claim.isPending ? 'Claiming…' : 'Claim organization'}
        </Button>
      </div>
    </div>
  )
}

// ---- step 2: name the organization -------------------------------------------------------------

/**
 * **The "Not now" decline action REMOVED 2026-08-07 (D14, owner decision).** D13's review round 3
 * added it (FIX 10) so the npm zero-config default's automatic redirect into this screen
 * (`routes.tsx#OnboardingEntryGate`) had an exit — otherwise it was a mandatory interstitial on
 * every page load until an org existed. D14 reverses that on purpose: "no dashboard element
 * renders before the first organization exists" means there is no cockpit for a decline to fall
 * back into, so the wizard now renders exactly one action again. `onboarding-decline.ts` and its
 * test are deleted rather than left as dead code that still reads as live.
 */
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

// ---- step 3: name the default workspace, and optionally add more (D13) --------------------------

/**
 * **SUPERSEDED 2026-08-07 (D13 cockpit pass) — the note below no longer describes this screen.**
 * Team management shipped in phase 5c (`Settings → Workspaces` — `teams-panel.tsx`, labelled
 * "Workspaces" in the UI, the same `team` identifiers underneath; D13's own "rename no identifier"
 * rule), so "until team management ships" is no longer a future this copy has to hedge around.
 * D13 also widens this step itself: it no longer only renames the single hardcoded default — it
 * now lets the user add more workspaces directly, backed by the same `POST /auth/teams` Settings
 * uses (`AddWorkspaceField` below), defaulting to the one default workspace unless the user adds
 * more. The subtitle reflects both.
 *
 * Superseded text, kept for history rather than deleted: "This read '…or rename it now — you can
 * rename it again later', and nothing in the cockpit can. `PATCH /auth/onboarding/team` is the
 * only rename surface in the product and this screen is the only caller … Team management
 * (create/rename/reassign) is deferred — see the spec's D2 amendment — so the copy states what is
 * true today rather than promising a screen that does not exist."
 */
const WORKSPACE_STEP_SUBTITLE =
  'Projects you register are assigned to a workspace. Accept the suggested name, add more below, or manage them anytime from Settings → Workspaces.'

/** A quick, client-side slug for `AddWorkspaceField` below — good enough to satisfy the wire's
 *  `slugInputSchema` (lowercase, hyphen-safe DNS label): the field this step exposes is a NAME,
 *  matching the "one click" ethos the default-workspace field already has — asking a first-time
 *  user for a slug too is Settings → Workspaces' job (`teams-panel.tsx#CreateTeamField`), not
 *  onboarding's. A collision (two workspaces deriving the same slug) surfaces as the server's own
 *  409, shown inline like every other admin refusal on this screen — this function does not try
 *  to disambiguate one locally. */
function slugifyWorkspaceName(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
  return base === '' ? 'workspace' : base
}

/** "One click to accept" (D8 step 3, the owner's explicit ask): the suggested name round-trips
 *  with no network call at all when left untouched — `renameOnboardingTeam` fires only when the
 *  field actually changed. Adding a workspace (D13) is a separate, immediate action next to it:
 *  each `AddWorkspaceField` submit is its own `POST /auth/teams`, independent of "Accept and
 *  continue", which only ever finalizes the DEFAULT workspace's name and advances the wizard. */
function AcceptTeamStep({ team, onAccepted }: { team: Team; onAccepted: (team: Team) => void }) {
  const [name, setName] = useState(team.name)
  const [extraWorkspaces, setExtraWorkspaces] = useState<Team[]>([])
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
      title="Your workspace is ready"
      subtitle={WORKSPACE_STEP_SUBTITLE}
      actions={
        <Button data-slot="onboarding-team-accept" disabled={name.trim() === '' || rename.isPending} onClick={accept}>
          {rename.isPending ? 'Saving…' : 'Accept and continue'}
        </Button>
      }
    >
      <div className="grid gap-4 text-left">
        <div className="grid gap-1.5">
          <Label htmlFor="onboarding-team-name">Workspace name</Label>
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
              {rename.error instanceof Error ? rename.error.message : 'could not rename the workspace'}
            </p>
          ) : null}
        </div>

        {extraWorkspaces.length > 0 ? (
          <ul data-slot="onboarding-workspace-list" className="flex flex-wrap gap-1.5">
            {extraWorkspaces.map((workspace) => (
              <li
                key={workspace.id}
                className="rounded-full border border-border px-2.5 py-1 text-[12px] text-soft-foreground"
              >
                {workspace.name}
              </li>
            ))}
          </ul>
        ) : null}

        <AddWorkspaceField onAdded={(workspace) => setExtraWorkspaces((prev) => [...prev, workspace])} />
      </div>
    </CenteredState>
  )
}

/** D13's "add a workspace" affordance — `POST /auth/teams`, the same route and store path
 *  Settings → Workspaces uses (`teams-panel.tsx`, imported rather than duplicated: it is already
 *  the tested, public function for this exact call). Immediate on submit, independent of
 *  `AcceptTeamStep`'s own "Accept and continue" — see that function's own doc comment. */
function AddWorkspaceField({ onAdded }: { onAdded: (workspace: Team) => void }) {
  const [name, setName] = useState('')
  const add = useMutation({
    mutationFn: (input: CreateTeamInput) => createTeam(input),
  })

  const submit = () => {
    const trimmed = name.trim()
    if (trimmed === '' || add.isPending) return
    add.mutate(
      { name: trimmed, slug: slugifyWorkspaceName(trimmed) },
      {
        onSuccess: ({ team }) => {
          onAdded(team)
          setName('')
        },
      },
    )
  }

  return (
    <div className="grid gap-1.5">
      <Label htmlFor="onboarding-workspace-add-name">Add another workspace</Label>
      <div className="flex gap-2">
        <Input
          id="onboarding-workspace-add-name"
          data-slot="onboarding-workspace-add-name"
          placeholder="Engineering"
          value={name}
          disabled={add.isPending}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
          }}
        />
        <Button
          type="button"
          variant="outline"
          data-slot="onboarding-workspace-add-submit"
          disabled={name.trim() === '' || add.isPending}
          onClick={submit}
        >
          {add.isPending ? 'Adding…' : 'Add workspace'}
        </Button>
      </div>
      <p className="text-[13px] text-soft-foreground">
        Optional — every workspace you add now is ready to file projects under. You can add or rename more anytime
        from Settings → Workspaces.
      </p>
      {add.isError ? (
        <p data-slot="onboarding-workspace-add-error" className="text-[13px] text-danger">
          {add.error instanceof Error ? add.error.message : 'could not create the workspace'}
        </p>
      ) : null}
    </div>
  )
}

// ---- step 4: add projects ------------------------------------------------------------------------

/**
 * Reuses `AddProjectDialog` and `CloneProjectDialog` — the SAME flows every other "Add project"
 * affordance in the cockpit uses — rather than forking them. The only addition anywhere in those
 * flows is an optional `teamId` (threaded to `POST /api/v1/projects` and, since D15,
 * `POST /api/v1/projects/checkout`): every other caller omits it and is byte-identical to before.
 *
 * **NO LONGER SKIPPABLE — D15 (2026-08-07, owner decision).** This step used to carry a "Skip for
 * now" button, per D8's "steps 2–4 are skippable". A first-run user reported the consequence:
 * having skipped nothing and added nothing, they landed in a cockpit already showing a project,
 * its commits and its branch, because boot auto-registration had put one there before the wizard
 * ever asked. D15 makes "the org owns at least one project" part of the gate and gives the user
 * three ways to satisfy it — blank, a local directory, or a GitHub clone. There is no way past
 * this screen that does not create a project, which is the point; `onboarding-gate.ts` enforces
 * the same condition, so removing the button alone would not have been enough.
 *
 * The launch directory is offered rather than assumed: `health.repoRoot` is the folder cezar was
 * started in, which before D15 was silently registered at boot. Pre-filling it keeps the
 * historical one-launch-one-repo ergonomics as a single click.
 */
function AddProjectsStep({ org, team }: { org: Org; team: Team }) {
  const [addOpen, setAddOpen] = useState(false)
  const [cloneOpen, setCloneOpen] = useState(false)
  const [blankOpen, setBlankOpen] = useState(false)
  const health = useHealth()
  const launchRoot = health.data?.repoRoot

  return (
    <>
      <CenteredState
        icon={<FolderPlusIcon />}
        tone="primary"
        title="Add your first project"
        subtitle={`${org.name} is ready. Every project needs somewhere to live — create an empty one, open a folder you already have, or clone from GitHub. It will be assigned to ${team.name}, and you can add more later from Settings → Projects.`}
        actions={
          <>
            <Button variant="outline" data-slot="onboarding-blank-project" onClick={() => setBlankOpen(true)}>
              <FilePlus2Icon className="size-[15px]" aria-hidden="true" />
              Create blank
            </Button>
            <Button variant="outline" data-slot="onboarding-add-project" onClick={() => setAddOpen(true)}>
              <FolderOpenIcon className="size-[15px]" aria-hidden="true" />
              Open local folder
            </Button>
            <Button data-slot="onboarding-clone-project" onClick={() => setCloneOpen(true)}>
              <GithubIcon className="size-[15px]" aria-hidden="true" />
              Import from GitHub
            </Button>
          </>
        }
      />
      <AddProjectDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        teamId={team.id}
        {...(launchRoot ? { initialPath: launchRoot } : {})}
      />
      <CloneProjectDialog open={cloneOpen} onOpenChange={setCloneOpen} teamId={team.id} />
      <BlankProjectDialog open={blankOpen} onOpenChange={setBlankOpen} teamId={team.id} />
    </>
  )
}
