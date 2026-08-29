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

import { useHealth, useProjects } from './api/queries'
import { ProjectScopeProvider } from './api/project-scope-context'
import { locationToRestore, readStoredLastLocation } from './lib/last-location'
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
import { FiledTaskDetailLoading } from './routes/filed-task-detail-loading'
import { visibleSettingsSections, type SettingsSectionId } from './routes/settings/registry'
import {
  SettingsIndexRoute,
  SettingsSectionRoute,
  settingsIndexPath,
  settingsSectionPath,
} from './routes/settings/settings-shell'
import { TasksOverviewRoute } from './routes/tasks-overview'
import { GlobalTasksRoute } from './routes/global-tasks'
import { AutomationsRoute } from './routes/automations/automations'
// Central-hub scaffold (`.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D22c): these three are
// capability-gated placeholder pages, created by the scaffold so `routes.tsx` is edited exactly
// once. Each is taken over and FILLED by its own wave (W2.3 knowledge, P2.4 notes, W4.10
// workspace-tasks) — a sequenced hand-off of the same file, never a concurrent edit. Statically
// imported like `InboxRoute`/`TasksOverviewRoute`: today each is a tiny placeholder, not a heavy
// chunk, so there is nothing here yet worth lazy-loading.
import { KnowledgeRoute } from './routes/knowledge/knowledge'
import { NotesRoute } from './routes/notes/notes'
import { WorkspaceGitRoute } from './routes/workspace/workspace-git'
import { WorkspaceKnowledgeRoute } from './routes/workspace/workspace-knowledge'
import { WorkspaceNewTaskRoute } from './routes/workspace/workspace-new-task'
import { WorkspaceReportsRoute } from './routes/workspace/workspace-reports'
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

/** Lazy for the same reason as the thread above: `FiledTaskDetailContent`
 *  (`components/filed-task-detail.tsx`) renders `context`/`whatToDo` through the same `Markdown`
 *  component the thread does, so a static import here would pull that chunk into the main bundle
 *  for a page most visits to the board never open. */
const FiledTaskDetailRoute = lazy(() =>
  import('./routes/filed-task-detail').then((m) => ({ default: m.FiledTaskDetailRoute })),
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
const TaskSpecRoute = lazy(() =>
  import('./routes/task-spec/task-spec').then((m) => ({ default: m.TaskSpecRoute })),
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

/** `/knowledge/:id` moved to `/knowledge?doc=<id>` (skills-preview parity,
 *  `.ai/specs/2026-08-17-knowledge-skills-preview-parity.md`) — the Knowledge page now selects
 *  through a query param, exactly like `?skill=` on `/skills`. This redirect exists for stale
 *  bookmarks/history only; every in-repo link producer (`knowledge.tsx`'s own rows and
 *  `hrefForId`, `workspace-knowledge.tsx`'s `SearchResultRow`) writes the new shape directly. The
 *  scoped `Navigate` keeps the redirect inside the active project, same as
 *  `SettingsSkillsRedirect` below. */
function KnowledgeDocRedirect() {
  const { id } = useParams<{ id: string }>()
  return <ScopedNavigate to={`/knowledge?doc=${encodeURIComponent(id ?? '')}`} replace />
}

/**
 * `/settings/global` and `/settings/global/<id>` → the one Settings area
 * (`.ai/specs/2026-08-21-one-settings-area.md`).
 *
 * Its own component rather than an inline `<Navigate>`, because only a component can read
 * `useLocation` and carry the query and hash across — `BACKWARD_COMPATIBILITY.md`'s "Settings
 * split, old URLs kept" promise applies in this direction too, and nine global URLs are in
 * bookmarks and in that document. Plain Navigate: the target is outside every project.
 */
function GlobalSettingsRedirect({ sectionId }: { sectionId?: SettingsSectionId }) {
  const location = useLocation()
  return (
    <Navigate
      to={{
        pathname: sectionId === undefined ? settingsIndexPath() : settingsSectionPath(sectionId),
        search: location.search,
        hash: location.hash,
      }}
      replace
    />
  )
}

/**
 * `/p/<id>/settings` and `/p/<id>/settings/<section>` → `/settings[/<section>]?project=<id>`.
 *
 * The project half of the same move: scope stopped being a PLACE and became a field, so the id
 * that used to be a path prefix becomes a query param and the section keeps working on exactly
 * the repo the old URL named. `project` leads the query string so a pasted link reads as what it
 * is; the caller's own params follow, and an incoming `project=` loses to the path (the path is
 * the thing that was addressed).
 *
 * Registered ONE ROUTE PER KNOWN SECTION rather than as `settings/:section`, deliberately: a
 * catch-all would swallow `/p/<id>/settings/nope`, redirect it to `/settings/nope?project=<id>`,
 * which matches no route, which the flat-path fallback sends back to `/p/<id>/settings/nope` — a
 * redirect loop where a 404 belongs. Unknown and hidden sections fall through to `NotFoundRoute`.
 */
function ProjectSettingsRedirect({ sectionId }: { sectionId?: SettingsSectionId }) {
  const location = useLocation()
  const { projectId = '' } = useParams()
  const params = new URLSearchParams()
  params.set('project', projectId)
  for (const [key, value] of new URLSearchParams(location.search)) {
    if (key !== 'project') params.append(key, value)
  }
  return (
    <Navigate
      to={{
        pathname: sectionId === undefined ? settingsIndexPath() : settingsSectionPath(sectionId),
        search: `?${params.toString()}`,
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
 * The exact bare root is the sole exception: once health and the registry settle, it may restore
 * the last valid project-scoped page THIS browser was on (localStorage, so a second client never
 * decides where this one lands). Any query/hash makes `/` explicit, so pasted links always win.
 * `replace` keeps Back from bouncing off either startup redirect.
 */
function LegacyPathRedirect() {
  const location = useLocation()
  const health = useHealth()
  const projects = useProjects()
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
    // The remembered location itself is local and synchronous (#786); only the registry that
    // validates its project is still worth waiting for.
    if (projects.data === undefined && !projects.isError) return <ScopeResolving />
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
      readStoredLastLocation(),
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
  // The global page. It is not project-scoped, so it never carries a `/p/` prefix to strip —
  // but it goes through the same table, because the browser title is one mechanism.
  { pattern: '/tasks', pageLabel: 'All tasks' },
  { pattern: '/new', pageLabel: 'New task' },
  { pattern: '/compare/:groupId', pageLabel: 'Compare' },
  { pattern: '/git/*', pageLabel: 'Git' },
  { pattern: '/github/*', pageLabel: 'GitHub' },
  { pattern: '/automations/*', pageLabel: 'Automations' },
  { pattern: '/skills', pageLabel: 'Skills' },
  { pattern: '/inbox', pageLabel: 'Inbox' },
  { pattern: '/knowledge/*', pageLabel: 'Knowledge' },
  { pattern: '/notes', pageLabel: 'Notes' },
  { pattern: '/workspace/new', pageLabel: 'New task' },
  { pattern: '/workspace/tasks', pageLabel: 'Tasks' },
  { pattern: '/workspace/git', pageLabel: 'Git' },
  { pattern: '/workspace/knowledge', pageLabel: 'Knowledge' },
  { pattern: '/workspace/reports', pageLabel: 'Reports' },
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
            path="tasks/:id/spec"
            element={
              <Suspense fallback={<GitTabLoading tab="spec" />}>
                <TaskSpecRoute />
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

          {/* The filed-task detail page (`.ai/specs/2026-08-29-filed-task-detail-page.md`),
              replacing the old detail dialog: every filed row, in both board views, at every
              status, links here. `todos/`, not `tasks/filed/` — todo ids and run ids are
              different id spaces, and the server already spells this one
              `/api/v1/p/:projectId/todos/:id`. */}
          <Route
            path="todos/:todoId"
            element={
              <Suspense fallback={<FiledTaskDetailLoading />}>
                <FiledTaskDetailRoute />
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
              same as `/inbox` does for `followups` (D19: a switched-off feature is never a 404).
              Selection is a query param (`?doc=<id>`), skills-preview parity — `knowledge/:id`
              redirects rather than routing, matching `settings/skills` below. */}
          <Route path="knowledge" element={<KnowledgeRoute />} />
          <Route path="knowledge/:id" element={<KnowledgeDocRedirect />} />

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

          {/* Settings is ONE area now, mounted at the top level below
              (`.ai/specs/2026-08-21-one-settings-area.md`). Everything under `/p/<id>/settings/*`
              redirects to it with the project carried as `?project=<id>`, so every pre-existing
              bookmark keeps working and keeps naming the same repo. `settings/skills` outranks
              nothing here — it is a static sibling and keeps its own older hop to `/skills`. */}
          <Route path="settings" element={<ProjectSettingsRedirect />} />
          <Route path="settings/skills" element={<SettingsSkillsRedirect />} />
          {visibleSettingsSections(capabilities).map((section) => (
            <Route
              key={section.id}
              path={`settings/${section.id}`}
              element={<ProjectSettingsRedirect sectionId={section.id} />}
            />
          ))}

          <Route path="*" element={<NotFoundRoute />} />
        </Route>

        {/* Settings — ONE area, outside `/p/:projectId`
            (`.ai/specs/2026-08-21-one-settings-area.md`). It used to be two, kept apart by a
            `scope` field on the registry, and the sidebar pointed at the half that did not hold
            Agents, Worktrees, Bookmarklets, Prompt templates or the agent config editor. Every
            non-hidden section is routed here exactly once; a `per-project` one takes its subject
            from `?project=` and mounts its own scope provider (settings-shell.tsx).

            No `ProjectScopeProvider` above this block, so a workspace section reads/writes the
            workspace routes (`/api/v1/workspace/*`), which are never scope-prefixed.

            Static segments outrank the `*` legacy redirect below in React Router's ranking, so
            these win regardless of order — listed here for readability. */}
        <Route path="/settings" element={<SettingsIndexRoute capabilities={capabilities} />} />
        {visibleSettingsSections(capabilities).map((section) => (
          <Route
            key={section.id}
            path={`/settings/${section.id}`}
            element={<SettingsSectionRoute section={section} capabilities={capabilities} />}
          />
        ))}
        {/* The old global area's URLs, kept alive. `global` is not a section id, so these static
            segments can never collide with the block above. */}
        <Route path="/settings/global" element={<GlobalSettingsRedirect />} />
        {visibleSettingsSections(capabilities).map((section) => (
          <Route
            key={`global-${section.id}`}
            path={`/settings/global/${section.id}`}
            element={<GlobalSettingsRedirect sectionId={section.id} />}
          />
        ))}

        {/* Two more non-project areas (central-hub scaffold F3, `CEZ_NOTES=1` /
            `CEZ_WORKSPACE_VIEWS=1`), the same shape as `/settings/global` above: no project owns a
            note before it is filed, and the cross-project board aggregates every project, so
            neither mounts under `ProjectScopeRoute` (`.ai/specs/2026-08-06-workspace-notes-cross-
            project.md` "The scope trap"). Reachable even off — each route renders its own
            "disabled" state rather than a 404 (D19). */}
        <Route path="/notes" element={<NotesRoute />} />
        <Route path="/workspace/new" element={<WorkspaceNewTaskRoute />} />
        <Route path="/workspace/tasks" element={<WorkspaceTasksRoute />} />
        {/* The cross-project git overview (`.ai/specs/2026-08-14-cross-project-git-overview.md`),
            here for the same reason as its neighbours: "every project's repo state" scoped to one
            project is a contradiction. `nav-items.ts` gives the Git item
            `workspaceTo: '/workspace/git'`, so this route is what keeps that band row from
            navigating into the 404 page — a nav row that leads nowhere being worse than a missing
            one is exactly why the band shipped WITHOUT Git in Phase 1. */}
        <Route path="/workspace/git" element={<WorkspaceGitRoute />} />
        {/* The cross-project knowledge view
            (`.ai/specs/2026-08-14-knowledge-domains-and-changelog.md` Phase 3), mounted for the
            identical reason as Git above: `nav-items.ts` gives the Knowledge item
            `workspaceTo: '/workspace/knowledge'`, so without this route that band row navigates
            into the 404 page. Note the item is additionally gated on `capabilities.knowledge`, so
            the row is absent unless `CEZ_KB=1` — but the ROUTE is unconditional, which is
            deliberate: a user who bookmarks the URL, or flips the flag off after landing here,
            must reach the page's own `disabledReason` state naming which flag to set, not a 404
            that tells them nothing (D19). Gating the route as well would collapse those two very
            different situations into the same dead end. */}
        <Route path="/workspace/knowledge" element={<WorkspaceKnowledgeRoute />} />

        {/* Report triage (`.ai/specs/2026-08-19-reports-triage-approve-dismiss.md`, "Reports is a
            workspace tab" amendment, 2026-08-19), mounted for the identical reason as Knowledge
            and Git above: the knowledge mount the reports live in is declared once, by the
            operator, not per project — a project-scoped route would render the SAME corpus once
            per registered project (measured: 12 identical queues on the box that motivated this
            move). `nav-items.ts` gives the Reports item `workspaceTo: '/workspace/reports'`, so
            this route is what keeps that band row from navigating into the 404 page. Reports
            still carries the `knowledge` gate (rides the same `CEZ_KB=1` flag as Knowledge), but
            the ROUTE is unconditional for the same D19 reason as its neighbours: a bookmark or a
            flag flipped off after landing here must reach the page's own "switched off" state,
            not a 404 that names nothing. Selection is `?report=`, the same query-param shape
            Knowledge uses for `?doc=`. */}
        <Route path="/workspace/reports" element={<WorkspaceReportsRoute />} />

        {/* The global Tasks page (#845) — a third non-project area, for the same reason as the
            two above: "every project's tasks" scoped to one project is a contradiction. Its data
            is the workspace-level run index, which is never scope-prefixed.

            EXACTLY `/tasks`, never `/tasks/*`: `/tasks/:id` is a legacy flat task link and must
            keep redirecting to the boot project's thread (`LegacyPathRedirect` below owns it).
            React Router ranks this static segment above that `*`, so the two never compete.

            TODO(upstream-sync 2026-08-13): this and our own `/workspace/tasks` above are two
            boards over one idea — upstream built the cross-project run index at
            `runs/run-index.ts` while ours lives at `workspace/run-index.ts`. Reconciling them is
            a decision recorded in `.ai/runs/2026-08-13-upstream-merge-triage/PLAN.md` §5, not
            something this merge settles.

            CORRECTED 2026-08-14 by `044f529e`. This used to close with "note that this page's row
            actions POST to `/api/v1/p/:projectId/…`, which builds a project context and resumes
            that project's interrupted runs" — true when written, and false now. §5's precondition
            has landed: the row actions POST to `/api/v1/workspace/runs/:projectId/:runId/…`
            (`server/workspace-run-mutations-routes.ts`), which peeks and never builds. The
            consolidation decision itself is still open; only the hazard that blocked it is gone.
            See `.ai/specs/2026-08-14-cross-project-run-mutations.md`. */}
        <Route path="/tasks" element={<GlobalTasksRoute />} />

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
