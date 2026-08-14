import { Suspense, lazy, useEffect, useRef } from 'react'
import {
  matchPath,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router'

import { useHealth, useProjects, useWorkspaceUiState } from './api/queries'
import { ProjectScopeProvider } from './api/project-scope-context'
import { locationToRestore } from './lib/last-location'
import { Navigate as ScopedNavigate, stripProjectPrefix } from './lib/project-router'
import { needsOnboardingGate, useOnboardingEntryProbe } from './routes/onboarding/onboarding-gate'
import { CompareLoading } from './routes/compare-loading'
import { GithubLoading } from './routes/github/github-loading'
import { InboxRoute } from './routes/inbox'
import { NewTaskRoute } from './routes/new-task'
import { NotFoundRoute } from './routes/not-found'
import { RepoGitLoading } from './routes/repo-git/repo-git-loading'
import { SkillsLoading } from './routes/skills-loading'
import { UnknownProjectRoute } from './routes/unknown-project'
import { WorkflowsLoading } from './routes/workflows/workflows-loading'
import { GitTabLoading } from './routes/task-git/git-tab-loading'
import { ThreadLoading } from './routes/task-thread/thread-loading'
import { visibleSettingsSections, type SettingsSectionId } from './routes/settings/registry'
import {
  SettingsIndexRoute,
  SettingsSectionRoute,
  settingsSectionPath,
} from './routes/settings/settings-shell'
import { TasksOverviewRoute } from './routes/tasks-overview'
import { AutomationsRoute } from './routes/automations/automations'
// Central-hub scaffold (`.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D22c): these two are
// capability-gated placeholder pages, created by the scaffold so `routes.tsx` is edited exactly
// once. Each is taken over and FILLED by its own wave (W2.3 knowledge, W4.10 workspace-tasks) — a
// sequenced hand-off of the same file, never a concurrent edit. Statically imported like
// `InboxRoute`/`TasksOverviewRoute`: today each is a tiny placeholder, not a heavy chunk, so there
// is nothing here yet worth lazy-loading. (P2.4's `/notes` page was the third until F3 feature B
// was removed on 2026-08-14 — `.ai/specs/2026-08-14-remove-notes-capture-inbox.md`.)
import { KnowledgeRoute } from './routes/knowledge/knowledge'
import { WorkspaceTasksRoute } from './routes/workspace/workspace-tasks'

/** Lazy ON PURPOSE: the thread view carries the markdown stack (Streamdown + remark/rehype,
 *  ~140 KB gz) — as a static import it would sit in the main bundle every visitor pays for
 *  before any route renders. The Suspense fallback is the same loading state the route itself
 *  shows while fetching, so the split is invisible to the user. */
const TaskThreadRoute = lazy(() =>
  import('./routes/task-thread/task-thread').then((m) => ({ default: m.TaskThreadRoute })),
)

/** Lazy for the same reason: the compare view renders Progress excerpts through Streamdown and
 *  full diffs through the Shiki singleton — thread-chunk weight the home screen must not pay. */
const CompareVariantsRoute = lazy(() =>
  import('./routes/compare-variants').then((m) => ({ default: m.CompareVariantsRoute })),
)

/** Lazy because both tabs render the shared run header, which lives in the thread chunk
 *  (markdown stack and all) — a static import here would pull that into the main bundle. */
const TaskChangesRoute = lazy(() =>
  import('./routes/task-git/task-changes').then((m) => ({ default: m.TaskChangesRoute })),
)
const TaskFilesRoute = lazy(() =>
  import('./routes/task-git/task-files').then((m) => ({ default: m.TaskFilesRoute })),
)
const TaskCommitsRoute = lazy(() =>
  import('./routes/task-git/task-commits').then((m) => ({ default: m.TaskCommitsRoute })),
)

/** Lazy because the repo view renders through the `<Diff>` facade and the Shiki singleton —
 *  the same heavy chunk the task git tabs ride; the home screen must not pay for it. */
const RepoGitRoute = lazy(() =>
  import('./routes/repo-git/repo-git').then((m) => ({ default: m.RepoGitRoute })),
)

/** Lazy because the GitHub detail pane renders issue/PR bodies through the same markdown
 *  stack the thread carries — thread-chunk weight the home screen must not pay. */
const GithubRoute = lazy(() =>
  import('./routes/github/github').then((m) => ({ default: m.GithubRoute })),
)
/** `/github`'s index (#417) — restores the last-selected tab. Same chunk as `GithubRoute`,
 *  just a second named export off the same lazy import. */
const GithubIndexRoute = lazy(() =>
  import('./routes/github/github').then((m) => ({ default: m.GithubIndexRoute })),
)

/** Lazy because the builder carries dnd-kit (R6 Step 1.6) — drag machinery only this surface
 *  uses, so only this surface pays for it. */
const WorkflowsRoute = lazy(() =>
  import('./routes/workflows/workflows').then((m) => ({ default: m.WorkflowsRoute })),
)

/** Lazy because the skill detail renders the skill body through the same markdown stack the
 *  thread carries — thread-chunk weight the home screen must not pay (it used to ride the main
 *  bundle as a static Settings section). */
const SkillsRoute = lazy(() => import('./routes/skills').then((m) => ({ default: m.SkillsRoute })))

/**
 * The onboarding wizard (D8, `.ai/specs/2026-08-06-org-team-auth-onboarding.md`, phase 4).
 *
 * **CORRECTED 2026-08-07 (repair stage): lazy.** It landed as a static import, defended as "it
 * must render with zero delay for a user who just came back from `/auth/callback`" — a navigation
 * that cannot happen when `CEZ_AUTH` is unset, which is the npm default and the product for most
 * users. Measured with `vite build`: the static import put 6.90 kB (2.02 gz) of wizard into the
 * entry chunk that every zero-config cockpit downloads and parses, for a page whose auth-off
 * render is one sentence. Lazy costs the authenticated user one chunk fetch on a screen that is
 * already waiting on `GET /auth/onboarding`.
 */
const OnboardingRoute = lazy(() =>
  import('./routes/onboarding/onboarding').then((m) => ({ default: m.OnboardingRoute })),
)

/** `/settings/skills` moved to the top-level `/skills` (out of the Settings shell). Redirect —
 *  preserving the `?skill=` selection and any hash — so pasted links and saved bookmarklets
 *  still land. The scoped Navigate keeps the redirect inside the active project. */
function SettingsSkillsRedirect() {
  const location = useLocation()
  return (
    <ScopedNavigate
      to={{ pathname: '/skills', search: location.search, hash: location.hash }}
      replace
    />
  )
}

/** A settings section that MOVED from the project area to the global one. Its own hop, not an
 *  inline `<Navigate>`, because `settingsSectionPath` returns a bare pathname: only a component
 *  can read `useLocation` and carry the query and hash across. Legacy flat URLs reach here on a
 *  SECOND hop (`LegacyPathRedirect` first), and dropping either half there would silently undo
 *  what that hop just preserved. Plain Navigate — the target is outside every project. */
function MovedSettingsSectionRedirect({ sectionId }: { sectionId: SettingsSectionId }) {
  const location = useLocation()
  return (
    <Navigate
      to={{
        pathname: settingsSectionPath('global', sectionId),
        search: location.search,
        hash: location.hash,
      }}
      replace
    />
  )
}

/** What renders while a redirect target is still being resolved (the boot id from `/api/health`,
 *  the registry from `/api/projects`). Deliberately quiet: the answer arrives in one local round
 *  trip, and any real screen here would flash the WRONG screen (spec, "URL scheme"). */
function ScopeResolving() {
  return (
    <div data-route="scope-resolving" className="flex min-h-full flex-col">
      <p className="px-4 py-6 text-center text-xs text-soft-foreground">Loading…</p>
    </div>
  )
}

/**
 * The `/p/:projectId` layout gate (multi-project spec, step 3.2) — the ONE place the URL's
 * project id becomes the app's project scope:
 *
 *  - `/p/default/…` is the reserved alias for the boot project (never an allocated slug):
 *    normalized to the real slug with a `replace` navigation, so the address bar always names
 *    the project. Params, query and hash survive byte-for-byte.
 *  - an id the registry doesn't know renders the "not registered here" screen — the cockpit
 *    twin of the API's 404;
 *  - a known id mounts `ProjectScopeProvider`, which scopes the API client and the query
 *    cache for the whole routed subtree (`<Outlet />`).
 *
 * When `/api/projects` itself errors (server unreachable), the gate mounts the scope anyway:
 * known-ness cannot be verified, and the routed views' own error states are the honest surface
 * for an unreachable server — a permanent "Loading…" here would not be.
 */
function ProjectScopeRoute() {
  const { projectId = '' } = useParams()
  const location = useLocation()
  const projects = useProjects()
  const health = useHealth()

  if (projectId === 'default') {
    // The registry names the boot slug; health's additive `bootProject` (the same slug) is the
    // fallback when the registry query ERRORED. With neither and the registry still fetching,
    // stay quiet; with the registry errored and no fallback either, fall through — the
    // server-side `default` alias answers every `/api/p/default/*` route as the boot project,
    // so mounting the scope (whose routed views own the honest error states) beats a permanent
    // "Loading…" (the same doctrine as the projects-error path below).
    const boot =
      projects.data?.bootProject ?? (projects.isError ? health.data?.bootProject : undefined)
    if (boot !== undefined) {
      const rest = location.pathname.replace(/^\/p\/default(?=\/|$)/, '')
      return (
        <Navigate
          to={`/p/${encodeURIComponent(boot)}${rest || '/'}${location.search}${location.hash}`}
          replace
        />
      )
    }
    if (!projects.isError) return <ScopeResolving />
  }

  if (projects.data) {
    const known =
      projects.data.bootProject === projectId ||
      projects.data.projects.some((project) => project.id === projectId)
    if (!known) return <UnknownProjectRoute projectId={projectId} registry={projects.data} />
  } else if (!projects.isError) {
    return <ScopeResolving />
  }

  // The BOOT project mounts UNSCOPED (projectId null): the step-3.1 invariant keeps its API
  // requests byte-identical to the single-project cockpit — the protected legacy `/api/*`
  // surface — and its cache under the same `'default'`-led keys the shell chrome (which
  // renders outside this provider) already uses. Only non-boot projects pay the `/api/p/<id>`
  // prefix. Links carry the URL prefix either way (project-router falls back to the URL).
  const scopeId = projects.data?.bootProject === projectId ? null : projectId

  return (
    <ProjectScopeProvider projectId={scopeId}>
      {/* React Router keeps the matched child mounted when only this parent param changes.
          Project-local queries and mount-time state must instead start from the project the URL
          now names. Key the child boundary (not the provider, whose unmount resets API scope). */}
      <Outlet key={projectId} />
    </ProjectScopeProvider>
  )
}

/**
 * The composer, remounted per project (multi-project spec, step 3.4).
 *
 * A `/p/:projectId` param change alone re-renders the SAME `NewTaskRoute` instance — React
 * Router matches the same route element either way. That is fine for the queries (their keys
 * carry the scope) but wrong for the composer's mount-time state: the draft is read once from
 * the departing project's storage key, and the write-back effect would then persist it under
 * the arriving project's key — exactly the draft leak the per-project keys exist to prevent.
 * Keying on the project makes the swap a real unmount/mount, so the draft, the pickers and the
 * deep-link capture all start from the project the URL now names.
 */
function NewTaskProjectRoute() {
  const { projectId = '' } = useParams()
  return <NewTaskRoute key={projectId} />
}

/**
 * Legacy flat URLs — every pre-multi-project path, `/tasks/:id` bookmarks and the `/new?...`
 * bookmarklet grammar included — redirect to the boot project's scoped twin, preserving path,
 * query and hash byte-for-byte (BACKWARD_COMPATIBILITY.md protects the bookmarklet contract).
 * The exact bare root is the sole exception: once health, registry, and workspace UI state
 * settle, it may restore the last valid project-scoped page. Any query/hash makes `/` explicit,
 * so pasted links always win. `replace` keeps Back from bouncing off either startup redirect.
 */
function LegacyPathRedirect() {
  const location = useLocation()
  const health = useHealth()
  const projects = useProjects()
  const uiState = useWorkspaceUiState()
  // D15: the shared onboarding probe — the same query `AppShellContainer` and
  // `OnboardingEntryGate` read, never a second fetch. See the bare-root branch below.
  const onboarding = useOnboardingEntryProbe()
  const resolvedBoot = health.data?.bootProject ?? projects.data?.bootProject
  const bootSourcesSettled =
    (health.data !== undefined || health.isError) &&
    (projects.data !== undefined || projects.isError)
  if (resolvedBoot === undefined && !bootSourcesSettled) return <ScopeResolving />
  // Health and the registry normally name the same boot project. If neither can answer after
  // both queries settle, the server-side `default` alias remains the no-config fallback.
  const boot = resolvedBoot ?? 'default'

  const isBareRoot =
    location.pathname === '/' && location.search === '' && location.hash === ''
  if (isBareRoot) {
    if (
      (projects.data === undefined && !projects.isError) ||
      (uiState.data === undefined && !uiState.isError)
    ) {
      return <ScopeResolving />
    }
    // **FIXED 2026-08-07 (D15 runtime E2E): the bare root must not race the onboarding gate.**
    //
    // Two independent authorities used to redirect `/`: this component, once health + registry +
    // ui-state settle, and `OnboardingEntryGate` below, once the onboarding probe settles. Whoever
    // resolved first won — and because that gate latches `firedOnce` to at most one redirect per
    // page load, losing the race once meant it never re-asserted. Observed live: with an org and a
    // workspace created but no project yet, `/` landed on `/p/<boot>/` showing the Tasks pane,
    // chrome correctly suppressed (`AppShellContainer` reads the same probe and had already
    // decided to gate) but never redirected — the two halves of one gate disagreeing about the
    // same answer. It reproduced intermittently, which is exactly what a race looks like from
    // outside.
    //
    // Waiting here costs NO extra request: `AppShellContainer` mounts the same
    // `['onboarding','entry-probe']` query on every page, so this reads a fetch that is already in
    // flight. It is also scoped to the bare root alone — the deep-link redirect below and every
    // other path are untouched, which is what the pre-D15 doc comment was protecting when it
    // argued against gating "EVERY boot" on one more round trip.
    if (onboarding.data === undefined && !onboarding.isError) return <ScopeResolving />
    // Gate is on: yield. `OnboardingEntryGate` owns the navigation to `/onboarding` — deliberately
    // NOT duplicated here, so there stays exactly one place that decides where onboarding starts.
    if (needsOnboardingGate(onboarding.data)) return <ScopeResolving />


    const restored = locationToRestore(
      uiState.data?.lastLocation,
      projects.data,
      resolvedBoot,
    )
    if (restored !== null) return <Navigate to={restored} replace />
  }

  // A bare `/p` (or `/p/`) names no project — send it to the boot project's home rather than
  // minting a nonsense `/p/<boot>/p` path.
  const path = location.pathname === '/p' || location.pathname === '/p/' ? '/' : location.pathname
  return (
    <Navigate
      to={`/p/${encodeURIComponent(boot)}${path}${location.search}${location.hash}`}
      replace
    />
  )
}

/**
 * D13/D14 entry point (spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`, phases 9 and the
 * D14 amendment) — "opening `http://127.0.0.1:<port>` for the first time … should offer to create
 * an organization," and (D14) the wizard is the entire surface until it does. Before D13, the ONLY
 * thing that ever routed a user INTO `/onboarding` was `/auth/callback`'s post-login redirect
 * (`auth/routes.ts`, see `onboarding.tsx`'s own doc comment: "redirects EVERY sign-in here") — a
 * route that exists only when `CEZ_AUTH` names a real provider. Local mode has no login at all, so
 * nothing ever pointed a first-run local user at the wizard; `/onboarding` was reachable only by
 * typing the URL by hand, which is what made the whole feature unreachable in practice. This
 * component is local mode's equivalent of that callback redirect, generalised (D14) to every
 * topology the probe can answer `needs-org` for — see `onboarding-gate.ts`'s own doc comment for
 * why the query below is unconditionally enabled rather than restricted to `capabilities.
 * localHandoff` the way the pre-D14 version of this gate was.
 *
 * **Deliberately a side effect, not a render-blocking gate added to `LegacyPathRedirect`.** Gating
 * the bare-root redirect chain itself on this probe's answer would tie EVERY boot — including
 * every already-onboarded install, forever, and every test in `routes.test.tsx` that exercises
 * that chain synchronously against seeded query data — to one more sequential round trip. Mounted
 * instead as an always-present sibling of `<Routes>`: it renders nothing and imperatively
 * navigates to `/onboarding` at most ONCE per page load, the moment the probe answers `needs-org`
 * — never a second time, so a user who finishes onboarding and lands back on `/` is never fought
 * back into it. (D14 removed the other way a user used to leave `/onboarding` early — declining —
 * so completing the wizard is now the only way out.)
 *
 * **FIXED 2026-08-07 (adversarial review of D13, FIX 9 — the "at most ONCE" claim above was false
 * for the one case that matters most).** The `firedOnce` ref was set only inside the branch that
 * called `navigate()`, so a user who loaded (or was linked to) `/onboarding` DIRECTLY — never
 * through this gate's own redirect — left it unset: the probe stayed `enabled` and its `needs-org`
 * answer stayed cached. Finishing the wizard and landing back on `/` re-ran this effect against
 * that STALE cached answer, which still read `needs-org`, and bounced the user straight back into
 * `/onboarding` — where `OnboardingRoute`'s own probe cache (`onboarding.tsx`'s `['onboarding',
 * 'status']`) was equally stale, re-rendering `NameOrgStep` for an org that already existed and
 * 409ing on submit. Fixed two ways, together: (1) the effect now disarms — `firedOnce.current =
 * true` — the moment the pathname IS `/onboarding`, regardless of how the user got there, checked
 * before anything else so a direct load latches on its very first pathname-settled render; (2)
 * `onboarding.tsx#OnboardingRoute` evicts every `['onboarding', ...]`-keyed query (this gate's
 * `entry-probe` included, by shared key prefix) the moment the org is actually created, so even a
 * query that somehow stayed `enabled` has no stale `needs-org` left to read on its next render.
 *
 * **D14 (2026-08-07, owner decision): declining no longer exists.** This gate used to also check
 * `hasDeclinedOnboarding()` (`onboarding-decline.ts`, added at D13's repair round 3) before ever
 * enabling its probe or navigating, and `NameOrgStep` carried a "Not now" action that wrote that
 * flag. The owner reversed that: no dashboard element renders before the first organization
 * exists, full stop, so there is nothing left for a decline to make reversible. Both are removed
 * rather than left inert.
 */
function OnboardingEntryGate() {
  const location = useLocation()
  const navigate = useNavigate()
  const firedOnce = useRef(false)
  const probe = useOnboardingEntryProbe()

  useEffect(() => {
    // Disarm the moment the user IS at `/onboarding`, for ANY reason — this gate's own `navigate`
    // below, a direct load, or a hand-typed link — not only when this effect performed the
    // navigation itself. Checked first, and unconditionally, so a direct load latches on its very
    // first render at this pathname, before the probe has even resolved. Without this, a direct
    // load leaves `firedOnce` false forever, and a later navigation away (any wizard-completion
    // path) re-reads the still-cached `needs-org` answer and bounces back in (FIX 9 above).
    if (location.pathname === '/onboarding') {
      firedOnce.current = true
      return
    }
    if (firedOnce.current) return
    if (!needsOnboardingGate(probe.data)) return
    firedOnce.current = true
    navigate('/onboarding', { replace: true })
  }, [probe.data, location.pathname, navigate])

  return null
}

export interface PageTitleContext {
  pageLabel: string | null
  taskId: string | null
}

const PAGE_TITLE_ROUTES = [
  { pattern: '/', pageLabel: 'Tasks' },
  { pattern: '/new', pageLabel: 'New task' },
  { pattern: '/compare/:groupId', pageLabel: 'Compare' },
  { pattern: '/git/*', pageLabel: 'Git' },
  { pattern: '/github/*', pageLabel: 'GitHub' },
  { pattern: '/automations/*', pageLabel: 'Automations' },
  { pattern: '/skills', pageLabel: 'Skills' },
  { pattern: '/inbox', pageLabel: 'Inbox' },
  { pattern: '/knowledge/*', pageLabel: 'Knowledge' },
  { pattern: '/workspace/tasks', pageLabel: 'Tasks' },
  { pattern: '/onboarding', pageLabel: 'Onboarding' },
  { pattern: '/workflows/*', pageLabel: 'Workflows' },
  { pattern: '/settings/*', pageLabel: 'Settings' },
] as const

/** Browser-title context from the project-relative route map; raw ids are lookup keys only. */
export function pageTitleContext(pathname: string): PageTitleContext {
  const projectPath = stripProjectPrefix(pathname)
  const task = matchPath({ path: '/tasks/:id/*', end: true }, projectPath)
  if (task) return { pageLabel: null, taskId: task.params.id ?? null }

  const route = PAGE_TITLE_ROUTES.find(({ pattern }) =>
    matchPath({ path: pattern, end: true }, projectPath),
  )
  return { pageLabel: route?.pageLabel ?? null, taskId: null }
}

/** The route map from the spec's "Routing — every surface is a URL" section.
 *
 *  Real URLs, not hash routes: the Hono server serves the built index.html for
 *  every non-/api GET (src/server/static-ui.ts `resolveGetRequest`), so each of
 *  these cold-loads and survives a refresh — `/p/…` paths included.
 *
 *  Every path lives under `/p/:projectId/` (multi-project spec, step 3.2) via the one
 *  `ProjectScopeRoute` layout above; the flat spellings below are relative to that prefix and
 *  stay stable — they are what teammates paste, and the legacy flat URLs redirect onto them.
 */
export function AppRoutes() {
  const capabilities = useHealth().data?.capabilities
  return (
    <>
      <OnboardingEntryGate />
      <Routes>
        <Route path="/p/:projectId" element={<ProjectScopeRoute />}>
          <Route index element={<TasksOverviewRoute />} />
          <Route path="new" element={<NewTaskProjectRoute />} />

          <Route
            path="tasks/:id"
            element={
              <Suspense fallback={<ThreadLoading />}>
                <TaskThreadRoute />
              </Suspense>
            }
          />
          <Route
            path="tasks/:id/changes"
            element={
              <Suspense fallback={<GitTabLoading tab="changes" />}>
                <TaskChangesRoute />
              </Suspense>
            }
          />
          <Route
            path="tasks/:id/files"
            element={
              <Suspense fallback={<GitTabLoading tab="files" />}>
                <TaskFilesRoute />
              </Suspense>
            }
          />
          <Route
            path="tasks/:id/commits"
            element={
              <Suspense fallback={<GitTabLoading tab="changes" />}>
                <TaskCommitsRoute />
              </Suspense>
            }
          />
          <Route
            path="tasks/:id/commits/:sha"
            element={
              <Suspense fallback={<GitTabLoading tab="changes" />}>
                <TaskCommitsRoute />
              </Suspense>
            }
          />
          <Route
            path="compare/:groupId"
            element={
              <Suspense fallback={<CompareLoading />}>
                <CompareVariantsRoute />
              </Suspense>
            }
          />

          {/* The repo view (R5 Step 1.7): each segment is a URL — /git (working-tree changes),
              /git/commits (+ /:sha for one commit's diff), /git/branches. */}
          <Route
            path="git"
            element={
              <Suspense fallback={<RepoGitLoading />}>
                <RepoGitRoute tab="changes" />
              </Suspense>
            }
          />
          <Route
            path="git/commits"
            element={
              <Suspense fallback={<RepoGitLoading />}>
                <RepoGitRoute tab="commits" />
              </Suspense>
            }
          />
          <Route
            path="git/commits/:sha"
            element={
              <Suspense fallback={<RepoGitLoading />}>
                <RepoGitRoute tab="commits" />
              </Suspense>
            }
          />
          <Route
            path="git/branches"
            element={
              <Suspense fallback={<RepoGitLoading />}>
                <RepoGitRoute tab="branches" />
              </Suspense>
            }
          />
          {/* The GitHub tab (R6 Step 1.1): issues and PRs are separate list URLs, each item a
              deep link. The nav item is forge-gated in the shell; the routes stay reachable so a
              pasted link renders the honest unavailable explainer instead of a 404. The bare
              `/github` is the one URL that restores the last-selected tab (#417) — `/github/prs`
              and the `:n` deep links are always exactly what they say. */}
          <Route
            path="github"
            element={
              <Suspense fallback={<GithubLoading />}>
                <GithubIndexRoute />
              </Suspense>
            }
          />
          <Route
            path="github/prs"
            element={
              <Suspense fallback={<GithubLoading />}>
                <GithubRoute view="prs" />
              </Suspense>
            }
          />
          <Route
            path="github/issues/:n"
            element={
              <Suspense fallback={<GithubLoading />}>
                <GithubRoute view="issues" />
              </Suspense>
            }
          />
          <Route
            path="github/prs/:n"
            element={
              <Suspense fallback={<GithubLoading />}>
                <GithubRoute view="prs" />
              </Suspense>
            }
          />
          <Route
            path="github/prs/:n/changes"
            element={
              <Suspense fallback={<GithubLoading />}>
                <GithubRoute view="prs" changes />
              </Suspense>
            }
          />
          <Route path="automations" element={<AutomationsRoute />} />
          <Route path="automations/new" element={<AutomationsRoute mode="new" />} />
          <Route path="automations/:automationId" element={<AutomationsRoute mode="edit" />} />
          <Route path="automations/:automationId/log" element={<AutomationsRoute mode="log" />} />

          {/* The skills catalog (R6 Step 1.4) — its own top-level surface, no settings sub-nav.
              `/settings/skills` redirects here (below) so pasted links keep working. */}
          <Route
            path="skills"
            element={
              <Suspense fallback={<SkillsLoading />}>
                <SkillsRoute />
              </Suspense>
            }
          />

          {/* The follow-up inbox (R6 Step 1.2): light — no markdown stack — so it rides the main
              bundle like the overview does. */}
          <Route path="inbox" element={<InboxRoute />} />

          {/* The knowledge base (central-hub scaffold F1, `CEZ_KB=1`): project-scoped, like Git.
              Reachable even off — off just means `KnowledgeRoute` renders its own "disabled" state,
              same as `/inbox` does for `followups` (D19: a switched-off feature is never a 404). */}
          <Route path="knowledge" element={<KnowledgeRoute />} />
          <Route path="knowledge/:id" element={<KnowledgeRoute />} />

          {/* The workflow builder (R6 Step 1.6): /workflows opens the canvas on the repo's first
              saved chain, /workflows/:name deep-links a specific one. */}
          <Route
            path="workflows"
            element={
              <Suspense fallback={<WorkflowsLoading />}>
                <WorkflowsRoute />
              </Suspense>
            }
          />
          <Route
            path="workflows/:name"
            element={
              <Suspense fallback={<WorkflowsLoading />}>
                <WorkflowsRoute />
              </Suspense>
            }
          />

          {/* Settings (R6 Step 1.3): registry-driven — the section list, nav and routes all come
              from routes/settings/registry.tsx. Hidden sections are NOT routed, so their URLs are
              honest 404s until the section ships (notifications unhides in Step 1.7).

              Only the PROJECT-scoped sections live here (multi-project spec, step 3.5); the
              global ones are the top-level `/settings/global/*` block below. */}
          <Route path="settings" element={<SettingsIndexRoute scope="project" capabilities={capabilities} />} />
          <Route path="settings/skills" element={<SettingsSkillsRedirect />} />
          {visibleSettingsSections('project', capabilities).map((section) => (
            <Route
              key={section.id}
              path={`settings/${section.id}`}
              element={<SettingsSectionRoute section={section} scope="project" capabilities={capabilities} />}
            />
          ))}
          {/* A section that MOVED out of the project area keeps its old URL working: every
              pre-3.5 bookmark and every legacy flat `/settings/appearance` (which the redirect
              below turns into `/p/<boot>/settings/appearance`) lands on the global twin instead
              of a 404 — query and hash intact across both hops. */}
          {visibleSettingsSections('global', capabilities).map((section) => (
            <Route
              key={section.id}
              path={`settings/${section.id}`}
              element={<MovedSettingsSectionRedirect sectionId={section.id} />}
            />
          ))}

          <Route path="*" element={<NotFoundRoute />} />
        </Route>

        {/* Global settings (multi-project spec, step 3.5) — the one cockpit area that is NOT
            under `/p/:projectId`, because nothing here belongs to a project: appearance and
            notifications are the user's, resources are the machine's, and the Projects pane IS
            the registry. No `ProjectScopeProvider` above it, so its sections must read/write the
            workspace routes (`/api/workspace/*`), which are never scope-prefixed.

            Static segments outrank the `*` legacy redirect below in React Router's ranking, so
            these win regardless of order — listed here for readability. */}
        <Route path="/settings/global" element={<SettingsIndexRoute scope="global" capabilities={capabilities} />} />
        {visibleSettingsSections('global', capabilities).map((section) => (
          <Route
            key={section.id}
            path={settingsSectionPath('global', section.id)}
            element={<SettingsSectionRoute section={section} scope="global" capabilities={capabilities} />}
          />
        ))}

        {/* One more non-project area (central-hub scaffold F3 feature A,
            `CEZ_WORKSPACE_VIEWS=1`), the same shape as `/settings/global` above: the cross-project
            board aggregates every project, so it does not mount under `ProjectScopeRoute`
            (`.ai/specs/2026-08-06-workspace-notes-cross-project.md` "The scope trap"). Reachable
            even off — the route renders its own "disabled" state rather than a 404 (D19). */}
        <Route path="/workspace/tasks" element={<WorkspaceTasksRoute />} />

        {/* The onboarding wizard (D8; D13 local mode). Outside `ProjectScopeRoute` for the same
            reason as the two routes above — there may be no project, and no ORG, yet. Reachable at
            all times (never a 404, D19's pattern). `OnboardingRoute` renders the full wizard for
            BOTH an authenticated deployment and the npm zero-config local default (D13) — it only
            falls back to the quiet "unavailable" explainer on the one remaining topology that mounts
            no `/auth/*` surface at all (a hosted, unauthenticated deployment; see that file's own
            doc comment, corrected 2026-08-07). `OnboardingEntryGate` above is what actually routes a
            first-run local user here — this `<Route>` is only reachable once something points at
            it. */}
        <Route
          path="/onboarding"
          element={
            <Suspense fallback={<p className="px-4 py-6 text-center text-xs text-soft-foreground">Loading…</p>}>
              <OnboardingRoute />
            </Suspense>
          }
        />

        {/* Everything else IS a legacy flat URL — the boot-project redirect owns it. The 404 for
            truly unknown paths still renders, scoped, after the redirect. */}
        <Route path="*" element={<LegacyPathRedirect />} />
      </Routes>
    </>
  )
}
