# Fix per-project GitHub issue/PR links: `useProjectRepoBase` reads workspace `/health` instead of the project's own repo

**Status: implemented and shipped 2026-08-22.** Commit `e38116cc` ("fix: resolve per-project
GitHub repo instead of boot-only /health for issue/PR links"), pushed directly to `origin/main`
(fast-forward `22c78934..e38116cc`; no branch protection on this repo, per standing ship
authorization). All 5 phases landed together, 14 files changed. Gates green: root `npm run
typecheck` exit 0 across all 4 packages; full `npm run test` 9780 passed / 2 failed / 1 skipped
(9783) — the 2 failures (`catalog.test.ts`, `config-api.test.ts`) are pre-existing and unrelated,
already filed as todos `72eba946`/`72129a4c`. One deviation from this spec's literal proposed
code: `useProjectRepoBase()` uses its own `useQuery({ retryOnMount: false })` rather than calling
`useProjects()` directly, because the spec's proposed code retry-looped forever against a
permanently-erroring registry (broke `routes.test.tsx`); this also fixed a boot-fallback bug in
the spec's proposed code where `effectiveId !== undefined` gated the `/health` fallback off
exactly when both queries were still loading.

**QA needed, not done:** the Phase 1 manual/e2e case (browsing ≥2 real projects on different
GitHub repos to confirm the Issue/PR chip resolves into each project's own repo, not the boot
project's) has not been run — flagged per this workspace's Definition of Done, not rounded up to
done.

Per Verification step 8: PRs `open-mercato/cezar#840`/`#864` (this spec's design source for the
foreign-number guard) are **not** closed or superseded by this change — this account has
`push:false, triage:false` on that upstream repo and cannot act on them. They remain independent,
foreign-repo references; this repo's own foreign-number guard is a separate, reimplemented copy.

## TLDR

The reported symptom ("Issues and PR link in UI are totally broken, because we are not open
mercato and there are multiple github repositories") is real but not caused by a hardcoded
single-repo assumption — the forge/data layer is already fully per-project (`repoRoot` threaded
through every server call, `GET /api/v1/projects` already serves each project's own `repoUrl`).
The actual break is one client hook: `useProjectRepoBase()`
(`packages/web/src/api/queries.ts:1072-1077`) reads `/health`, which is workspace-level and always
describes the *boot* project, so **every project except the one cezar was launched in gets
`repoBase = undefined`**, silently dropping every synthesized Issue/PR chip on the Task Thread and
run header. Phase 1 fixes this by reading the per-project `repoUrl` already on the wire from `GET
/api/v1/projects` (`useProjects()`, already fetched by the `/p/:projectId` route gate — zero new
network cost), keeping `/health` only as a narrow fallback for a boot project the registry does
not list. Phases 2–3 reimplement, against this repo, a guard whose design comes from
`open-mercato/cezar` PRs #840/#864 — a separate upstream repository this workspace has read-only
access to; their `CONFLICTING` state is against *that* repo's `main` and is irrelevant here, and
this work neither lands nor closes anything there. Phase 4 keeps `githubRepoBase()` as a narrow
boot-fallback parser (not a deletion — see Phase 4 below, which is authoritative over this
sentence). The wider multi-**forge** (GitHub+GitLab) rewrite tracked by issue #847 is
explicitly out of scope — it
answers a different question (which forge) than this bug (which repo).

## Problem

### What "totally broken" actually means, verified against the code on this branch

1. **The forge/data layer is not single-repo.** `packages/cezar/src/server/forge/github.ts`
   resolves `owner/name` per call via `gh repo view --json nameWithOwner` run with `cwd: repoRoot`
   (`resolveRepoHandle`, `fetchGithub`, `fetchGithubChecks`); every `/api/v1/github*` route reads
   `const { root: repoRoot } = c.get('project')` (`packages/cezar/src/server/server.ts:6164-6295`
   per the brief; not independently re-verified in this step, low risk — same pattern as the
   confirmed-read `runIndexEntry` code below). No hardcoded `open-mercato/*` owner/repo string
   exists in production code — every hit is in tests, docs, mockup HTML, or dated `.ai/specs/`
   records (prior codebase-map sweep, see brief).

2. **The project registry already computes and serves each project's own repo.**
   `packages/cezar/src/workspace/projects.ts:376-386` (`computeProbe`, read in full this step):
   ```ts
   const info = await getRepoInfo(root);
   const forge = forgeKindOfRemote(info?.remote);
   const repoUrl = forgeWebRoot(info?.remote);
   return { status: 'ok', ...(info?.branch ? { branch: info.branch } : {}),
     ...(forge ? { forge } : {}), ...(repoUrl ? { repoUrl } : {}) };
   ```
   Wire contract: `packages/contract/src/projects.ts:44-56` (`projectListEntrySchema.repoUrl`,
   read in full) — "the remote's web root… rebuilt server-side from the parsed remote… It exists
   for the cross-project surfaces". `GET /api/v1/projects` (`projectsResponseSchema`,
   `packages/contract/src/projects.ts:102-107`, read) answers `{ projects: ProjectListEntry[],
   bootProject: string, projectsDir: string }` — **`bootProject` is already on this response**, so
   a client needs no second query to resolve the boot project's id either.

3. **The confirmed root cause: `useProjectRepoBase()` reads the wrong source.**
   `packages/web/src/api/queries.ts:1072-1077` (read in full):
   ```ts
   export function useProjectRepoBase(): string | undefined {
     const health = useHealth().data
     const { projectId } = useProjectScope()
     const isBootProject = projectId === null || projectId === health?.bootProject
     return isBootProject ? githubRepoBase(health?.repo?.remote) : undefined
   }
   ```
   `/health` is workspace-level by design (`healthResponseSchema`,
   `packages/contract/src/health.ts:200-214`, read: `repoRoot: z.string()`, `repo:
   repoInfoSchema.nullable()`, `bootProject: z.string()` — one repo, one boot slug, no per-project
   list); the server always builds it from `bootRoot`
   (`packages/cezar/src/server/server.ts:2137-2171`, read: `healthForRequest` composes
   `readHealth()`, cached from `bootRoot`, no `projectId` input at all). The function's own doc
   comment (lines 1060-1071, present on `main` today) already explains *why* it is written this
   way — a 2026-08-07-ish hardening for wrong-link defect **#526** ("Handing a non-boot project's
   task a link built from the boot project's repo would point at a completely different
   repository") — but the fix it chose was to blank the link out entirely for every non-boot
   project, rather than to fetch the *right* repo. That trade-off is the actual defect: #526 is
   real and must stay fixed, but the correct fix was always available (`GET /api/v1/projects`
   already carries the right answer) and was not used.

4. **Confirmed consumers that go dark for every non-boot project**, both read in full:
   - `packages/web/src/routes/task-thread/task-thread.tsx:290` —
     `const issueUrl = taskIssueUrl(run, useProjectRepoBase())`, guarded by the same #526 comment.
   - `packages/web/src/routes/task-thread/run-header.tsx:537-548` — `const repoBase =
     useProjectRepoBase()`, feeding both the PR/issue chip glyph-status batch and (line 579)
     `taskIssueUrl(run, repoBase)`.
   Both routes mount inside `/p/:projectId/*` (`packages/web/src/routes.tsx:220-245`,
   `ProjectScopeRoute`), i.e. exactly the surfaces a multi-project workspace uses to view a
   non-boot project's own task.

5. **The existing-correct pattern to imitate is already in the codebase.**
   `packages/web/src/routes/global-tasks.tsx:388-394` and `:1703`, `:1847` (all read) call
   `taskReferences(task.run, task.project?.repoUrl)` / `taskIssueUrl(run, task.project?.repoUrl)`
   — one `repoUrl` per row, sourced from the cross-project runs-index join against the registry.
   `useProjectRepoBase()` is the one outlier among otherwise project-scoped code, not the norm.

6. **`useProjects()` is already fetched for free on every project-scoped route.**
   `packages/web/src/routes.tsx:234` (`ProjectScopeRoute`) and `:312` (`LegacyPathRedirect`) both
   call `useProjects()` before `/p/:projectId/*` ever mounts `<Outlet/>` — confirmed by
   `packages/web/src/routes/tasks-overview.tsx:1024-1027`'s own comment: "this route mounts INSIDE
   the `/p/:projectId` gate, which itself gates on `useProjects()`". Both `task-thread.tsx` and
   `run-header.tsx` render inside that gate, so calling `useProjects()` from
   `useProjectRepoBase()` is a **react-query cache hit against an already-in-flight/already-cached
   query** (`workspaceQueryKeys.projects`, `packages/web/src/api/queries.ts:308`), not a new
   request.

### A second, distinct defect: foreign numbers rebuilt into the wrong repo — guard design borrowed, read-only, from a separate upstream repo

`taskIssueUrl` (`packages/web/src/lib/tasks-table.ts:229-240`, read in full) synthesizes
`${repoBase}/issues/${number}` from `run.markerRefs?.issue ?? run.issueNumber`. `issueNumber` has
two origins: `extractTaskRefs` reads it from the task prompt (trustworthy), but `autoNameRun`
(`packages/cezar/src/workflows/run.ts`) seeds it from the transcript whenever no `CEZ:ISSUE`
marker exists — and a task working on another repository's issue/PR scrapes that repo's numbers.
The result, reported live: this repo's own persisted `runs.json` holds a run with `issueNumber:
475` whose `referencedIssueCandidates` is `https://github.com/open-mercato/cezar/issues/475` — a
number that belongs to an entirely different repository than this project's own
`https://github.com/MarcinWalendowski/cezar`.

The fix design for this — `namesNumberElsewhere`, `chipIssueNumber`/`chipPrNumber`,
`referencedIssueCandidates`/`referencedPrCandidates` — is **borrowed, read-only**, from PRs
already open against a *different* repository: `open-mercato/cezar` #840
(`fix/issue-819-foreign-issue-chip`) and #864 (`fix/issue-854-pr-chip-foreign-number-guard`,
`baseRefName: main` — not stacked on #840's branch, contrary to an earlier draft of this spec).
This checkout's `origin` is `https://github.com/MarcinWalendowski/cezar.git` (confirmed via `gh
repo view`: `isFork:false`, private, created 2026-08-08, **zero issues and zero PRs** as of this
step — `gh issue list --state all` and `gh pr list --state all` both return `[]`), and this
account's permissions on `open-mercato/cezar` are `{pull:true, push:false, triage:false,
maintain:false, admin:false}`. `open-mercato/cezar`'s `main` is at `185c68a7`, which is not an
object in this repo's history (`git cat-file -t 185c68a7` → `fatal: Not a valid object name`),
while this repo's `origin/main` is `0883256b` — the two repositories have fully diverged. #840's
file list is `BACKWARD_COMPATIBILITY.md`, `runs-index-api.test.ts`, `server.ts`,
`contract/src/runs.ts`, `tasks-table.ts`, `tasks-table.test.ts`, `global-tasks.test.tsx` — it does
**not** touch `queries.ts`/`useProjectRepoBase`, so it does not overlap Phase 1's edit.

Because #840/#864 live in a separate, foreign repository with no push/triage access, nothing this
spec does rebases, lands, closes, or supersedes them, and no commit message this spec produces may
write `closes #819`, `closes #854`, or `closes #840`/`#864` — those numbers name nothing in
`MarcinWalendowski/cezar`. This spec's Phases 2–3 reimplement the same guard fresh, against this
repo, reusing #840/#864's algorithm and test cases as a design reference only (see "Sources
read").

### Out of scope, on purpose

Issue **#847** ("git remote provider interface with pluggable forge adapters — GitHub + GitLab")
is open, filed 2026-08-10, and does read as a "rewrite" — `ForgeKind` is a single-member `'github'`
union, `FORGE_HOSTS` hardcodes `github.com`. It is real, but it answers *which forge*, not *which
repo of the same forge* — the reported symptom is about GitHub links disappearing/mispointing
across cezar's own multi-repo workspace, which #847 does not touch and this spec fully resolves
without it. Widening this task's scope to #847 was not asked for and would block a real, narrow
fix behind a large, unrelated one.

## Solution

**Phase 1** — `useProjectRepoBase()` resolves the on-screen project's `repoUrl` from `GET
/api/v1/projects` (already served, already cached) instead of unconditionally from workspace-level
`/health`. `repoUrl` from the registry is already a full `https://github.com/owner/repo` web root
(server-computed in `computeProbe`/`forgeWebRoot`), so no client-side remote parsing is needed for
the normal path. `/health` is kept as a narrow fallback: only when the on-screen project is the
*boot* project and the registry has no row for it (an unregistered boot repo, or an errored/empty
registry response) does the hook fall back to parsing `health.repo.remote` via `githubRepoBase()`
— never for a non-boot project, which keeps #526's invariant intact.

**Phase 2** — reintroduce PR #840's foreign-issue-number guard (`namesNumberElsewhere`,
`chipIssueNumber`) into `taskIssueUrl`/`taskReferences`, plus the `referencedIssueCandidates` field
on `runIndexEntrySchema` the global Tasks page needs to run the same check.

**Phase 3** — the PR twin (PR #864: `chipPrNumber`, `referencedPrCandidates` on
`runIndexEntrySchema`), reusing Phase 2's `namesNumberElsewhere`.

**Phase 4** — keep `githubRepoBase()` (`packages/web/src/lib/tasks-table.ts:181-195`), the
client-side remote-string parser, but demote it: after Phase 1 it is reached only on the
boot-project fallback path (an unregistered boot repo, or an errored/empty registry response).
Its doc comment is updated to say so, so a future reader does not mistake it for the normal
source of `repoBase`.

Each phase is independently shippable and independently testable. Phase 1 alone fixes the literal
reported symptom (links vanish for non-boot projects). Phases 2-3 fix the second, narrower,
already-diagnosed symptom (links point at the wrong repo/404). Phase 1 does not block Phases 2-3
or vice versa — they touch overlapping lines of the same file, so land them in the order below to
avoid re-doing merge conflicts against each other, but none is a technical prerequisite for
another to be correct in isolation.

## Architecture

No new routes, no new server-side logic, no schema change in Phase 1 — `GET /api/v1/projects`
already answers everything `useProjectRepoBase` needs. Phases 2-3 add two optional array fields to
an existing additive wire contract (`runIndexEntrySchema`) and thread them through one existing
server-side row builder (`runIndexEntry`) and one existing client accessor
(`TaskReferenceInput`/`taskReferences`) — no new endpoints.

```
Phase 1 data flow (per-project repo link):
  GET /api/v1/projects (already fetched by ProjectScopeRoute)
    -> useProjects() [queries.ts:529, cached under workspaceQueryKeys.projects]
    -> useProjectRepoBase() [queries.ts:1072, REWRITTEN] looks up the current
       projectId (useProjectScope(), null = boot) against projects.data.projects[].repoUrl,
       falling back to projects.data.bootProject when projectId is null; if the registry
       has no row for the effective id AND that id is the boot project, falls back to
       githubRepoBase(health.repo.remote) [queries.ts:1038, useHealth()]
    -> taskIssueUrl(run, repoBase) / taskReferences(run, repoBase)
       [tasks-table.ts, unchanged in Phase 1]
    -> task-thread.tsx:290, run-header.tsx:537-548,579 [unchanged call sites]

Phases 2-3 data flow (foreign-number guard, per chip):
  RunRecord.referencedIssueCandidates / referencedPrCandidates [already exist on
    runRecordSchema, contract/src/runs.ts:339,343 — persisted server-side already]
    -> runIndexEntry() [server.ts:6873-6910, ADD both fields, mirrors the six
       existing verbatim-carried tracker fields already there]
    -> runIndexEntrySchema [contract/src/runs.ts:464-559, ADD both fields as
       optional string[], additive]
    -> TaskReferenceInput [tasks-table.ts:251-259, ADD both fields to the Pick]
    -> namesNumberElsewhere() [NEW, tasks-table.ts] evidence check, shared by
       taskIssueUrl (issue side) and chipPrNumber (PR side)
    -> taskIssueUrl / chipIssueNumber / chipPrNumber -> taskReferences()
       [tasks-table.ts, MODIFIED]
```

Only three call sites pass a `repoBase` today and get both fixes automatically once the shared
functions change: `task-thread.tsx:290`, `run-header.tsx:537-548,579`, and `global-tasks.tsx`'s
three `taskReferences(task.run, task.project?.repoUrl)` call sites. The four call sites of the
*singular* `taskReference(run)` — `tasks-overview.tsx:579,896,1067`, `task-quick-list.tsx:324,476`,
`workspace-tasks.tsx:431,505`, `project-groups.tsx:227` — pass no `repoBase` at all
(`taskReference()` is `taskReferences(run)[0]`, `tasks-table.ts:330-331`); they neither link a
numeric-only chip for any project today, nor pick up Phases 2–3's foreign-number guard, until
Phase 5 threads a `repoBase` through them too.

## Data models

**Phase 1 — no schema change.** `projectListEntrySchema.repoUrl` (`packages/contract/src/projects.ts:44-56`)
and `projectsResponseSchema.bootProject` (`packages/contract/src/projects.ts:102-107`) already
exist and already carry what's needed.

**Phase 2 — `runIndexEntrySchema`** (`packages/contract/src/runs.ts:464-559`), one new optional
field:

```ts
// packages/contract/src/runs.ts, inside runIndexEntrySchema, beside referencedIssueUrl
referencedIssueCandidates: z.array(z.string()).optional(),
```

Doc comment on the existing "six fields `taskReference()` reads" note (line ~516) becomes "seven
fields" and explains `referencedIssueCandidates` is evidence, not a link (mirror PR #840's
contract diff verbatim — see Sources read).

**Phase 3 — same schema**, one more optional field:

```ts
referencedPrCandidates: z.array(z.string()).optional(),
```

**Both fields already exist on `runRecordSchema`** (`packages/contract/src/runs.ts:339,343`) —
this is purely surfacing already-persisted server state onto the slim cross-project row, the same
pattern every other field on `runIndexEntrySchema` already follows.

## API contracts

No new routes in any phase. One existing response body gains two optional fields:

- `GET /api/v1/workspace/runs-index` — `BACKWARD_COMPATIBILITY.md:71` enumerates the runs-index
  row as `{projectId, workspace?, id, title, titleSummary?, titleOrigin?, status, activity?,
  createdAt, finishedAt?, seenAt?, archived, autoResumeAt?}` — the core slim fields only; it
  already omits every tracker field this shape carries (`pullRequestUrl`, `prNumber`,
  `issueNumber`, `referencedIssueUrl`, `markerRefs`), so it does not describe this document and
  appending `referencedIssueCandidates`/`referencedPrCandidates` to that enumeration would make it
  *less* accurate, not more. The bullet's own rule ("adding a field is additive") already covers
  Phases 2-3, so no edit to that enumeration is required. If the implementer wants the record
  explicit, add one clause to that bullet's prose — not a field to the enumeration.
- `GET /api/v1/projects` — unchanged; Phase 1 only changes which existing field the client reads.

## Phases

1. **Fix `useProjectRepoBase()` to read the per-project registry, with a boot-only fallback for an unregistered boot repo.**
   - Rewrite `packages/web/src/api/queries.ts:1072-1077`:
     ```ts
     export function useProjectRepoBase(): string | undefined {
       const projects = useProjects().data
       const health = useHealth().data
       const { projectId } = useProjectScope()
       const bootId = projects?.bootProject ?? health?.bootProject
       const effectiveId = projectId === null || projectId === 'default' ? bootId : projectId
       const entry = projects?.projects.find((p) => p.id === effectiveId)
       if (entry) return entry.repoUrl
       // Registry has no row for this id — an unregistered boot repo (server.ts resolveBootProject)
       // or an errored/empty registry. Only the BOOT project may fall back to /health, which is
       // built from bootRoot; a non-boot id with no row synthesizes nothing (#526).
       return effectiveId !== undefined && effectiveId === bootId
         ? githubRepoBase(health?.repo?.remote)
         : undefined
     }
     ```
   - Update the function's doc comment (currently lines 1060-1071): it must keep stating the
     #526 rule this hook exists to serve (only the on-screen project's own repo may ever be
     handed to a synthesizer) but correct the now-wrong claim that `/health` is the *normal*
     source of the link — it is now only a fallback for the boot project when the registry has
     no row for it (unregistered boot repo, or an errored/empty registry response).
   - Keep the `useHealth` import — it is now load-bearing for the fallback path, not dead.
   - No change to `packages/web/src/routes/task-thread/task-thread.tsx` or
     `run-header.tsx` — both already call `useProjectRepoBase()` with no arguments and will pick
     up the fix automatically.
   - Verification: add a `useProjectRepoBase()` unit case where `projects.data.projects`
     contains no entry for `bootProject` but `health.data.repo.remote` is a GitHub remote —
     returns that repo's web root — and the same fixture with a **non-boot** `projectId` —
     returns `undefined` (the #526 guard against widening what may be synthesized).

2. **Foreign issue-number guard (design ported from upstream `open-mercato/cezar` PR #840; no cross-repo close).**
   - `packages/web/src/lib/tasks-table.ts`: add `namesNumberElsewhere(candidates, number,
     repoBase)` (case-insensitive prefix match against `${repoBase}/`, matching PR #840's
     implementation verbatim — see Sources read for the exact diff) and call it from
     `taskIssueUrl` between resolving `number` and synthesizing the link; add `chipIssueNumber`
     and use it in place of the bare `run.issueNumber` in `taskReferences`'s numeric-only PR/Issue
     source list.
   - Add `referencedIssueCandidates` to `TaskReferenceInput`'s `Pick<RunRecord, …>` and to
     `runIndexEntrySchema` (contract) + `runIndexEntry()` (`packages/cezar/src/server/server.ts:6873-6910`,
     add one more `...(run.referencedIssueCandidates !== undefined ? {…} : {})` line beside the
     existing `referencedIssueUrl` one).
   - Port PR #840's five new `tasks-table.test.ts` cases and one `global-tasks.test.tsx` case
     (see Sources read) — they already encode the exact acceptance behavior (drops a
     candidate-proven foreign number, keeps a number whose foreign candidates name *other*
     numbers, stays inert with no known repo, case-insensitive match, rejects a same-prefix
     different-repo match, and suppresses a foreign-numbered `markerRefs.issue` too).
   - Update `runs-index-api.test.ts`'s field-list assertion (~line 164) and port PR #840's new
     "carries the issue candidates" case.

3. **Foreign PR-number guard (design ported from upstream `open-mercato/cezar` PR #864; no cross-repo close), depends on Phase 2's
   `namesNumberElsewhere`.**
   - Same shape as Phase 2 for the PR half: `chipPrNumber`, `referencedPrCandidates` added to
     `TaskReferenceInput`, `runIndexEntrySchema`, and `runIndexEntry()`.
   - Port PR #864's corresponding test cases (issue-chip cases already covered by Phase 2; the PR
     twin cases — drop/keep-other-numbers/inert-without-repo/keeps-discovered-URL — need
     `referencedPrCandidates` fixtures instead of `referencedIssueCandidates`).

4. **Keep `githubRepoBase()` — it is now a fallback, not dead code.**
   - After Phase 1, `githubRepoBase()` (`packages/web/src/lib/tasks-table.ts:181-195`) is reached
     only on the boot-project fallback path (unregistered boot repo / errored or empty registry).
     Do not delete it.
   - Update its doc comment (`tasks-table.ts:175-180`) to say exactly that: it is no longer the
     normal source of `repoBase` — the server-computed `repoUrl` from `GET /api/v1/projects` is —
     and it exists only so a boot repo the registry does not list still links.
   - Keep its `describe('githubRepoBase', …)` tests (`tasks-table.test.ts` ~lines 446-466)
     unchanged; they still cover live production behavior.

5. **Thread a per-row `repoBase` through `taskReference()`.**
   - Change `taskReference(run: TaskReferenceInput, repoBase?: string)` to forward to
     `taskReferences(run, repoBase)` instead of calling it with no second argument.
   - Update every call site to pass the repo of the project that **row** belongs to, not the
     on-screen project. Call `useProjectRepoBase()` **once, in the container component's body** —
     beside the existing `useReferenceProjectId()` call at `tasks-overview.tsx:1059` and
     `task-quick-list.tsx:470` — add it to those components' `useMemo` dependency arrays, and pass
     the resulting value as a prop into the row/card components (`TableRow` at
     `tasks-overview.tsx:559`, `TaskCard` at `:879`, `RunRow` at `task-quick-list.tsx:297`) rather
     than calling the hook inside them or inside a `useMemo`/`flatMap` callback —
     `tasks-overview.tsx:1067` and `task-quick-list.tsx:476` are both inside
     `React.useMemo(() => … flatMap((run) => { … }))` callbacks, where no hook may be called, and
     those row/card components are also rendered directly by presentational tests. This repo has
     **no eslint gate** (`npm run lint` does not exist), so a rules-of-hooks violation would ship
     silently — do not introduce one. `project-groups.tsx:227` needs no registry lookup at all:
     its enclosing component already receives `project: ProjectListEntry`
     (`project-groups.tsx:181`), so pass `project.repoUrl` directly; its `taskReference(...)` call
     is likewise inside a `buckets.flatMap(...)` callback, so no hook belongs there either.
     Cross-project surfaces otherwise pass the registry entry's `repoUrl` for the row's own
     project — `workspace-tasks.tsx:431,505` already have `run.project` in scope, resolvable
     against the same `useProjects()` registry Phase 1 introduces. `project-groups.tsx` needs a
     `repoBase` even though it only reads the reference's *number* for `referenceStatuses`
     requests — without one the foreign-number guard has nothing to check against, and it would
     ask `gh` about a number belonging to a repo it was never scraped from.
   - Verification: a unit test that a numeric-only reference renders as a link on the per-project
     table (`tasks-overview.tsx`) and on the sidebar quick list (`task-quick-list.tsx`) once a
     `repoBase` is threaded through, and that a candidate-proven foreign number (per Phase 2/3's
     guard) produces no chip on those same surfaces.

## Risks

- **Phase 1 regressing #526.** The fix must keep the invariant #526 exists to protect: a
  synthesized link may only ever name the project genuinely on screen, never a transcript
  scraping. The rewritten hook still derives `repoBase` from the registry entry matching the
  *current* `projectId` (or the boot project when unscoped) — it does not widen what may be
  synthesized, it only widens *which* project's own repo is available to synthesize from. Cover
  this with a unit test asserting a non-boot project's `useProjectRepoBase()` returns that
  project's `repoUrl`, not the boot project's.
- **`/health` stays as a boot-only fallback, not a dead path.** The registry (`GET
  /api/v1/projects`) lists only *registered* projects (`server.ts:3270-3290`, `listProjects()`
  over `config.projects`), while the boot project can legitimately be unregistered — a task
  worktree, `$HOME` itself, or an unreadable workspace all resolve a `bootProject` id with no row
  in the registry (`server.ts:1463-1482`) — and the registry route itself degrades to `projects:
  []` when the workspace is unreadable (`routes.tsx` `ProjectScopeRoute` explicitly falls back to
  `health.data.bootProject` on `projects.isError`). Dropping the `/health` fallback entirely, as
  an earlier draft of this spec did, would silently regress those two cases from "links work" to
  "links vanish" for the boot project. The fallback is scoped to the boot project only — a
  non-boot project with no registry row still resolves to `undefined`, keeping #526 intact.
- **`useProjects()` not yet settled when `useProjectRepoBase()` is first read.** Unlike `/health`
  (usually already cached from app boot), a cold direct-link into a project's task thread could in
  principle read `useProjectRepoBase()` before `useProjects()` resolves. This degrades to
  `undefined` (no chip synthesized) exactly like today's boot-project-only behavior does while
  `/health` is in flight — not a regression, but confirm the loading-state behavior is unchanged
  by testing the hook with `projects.data === undefined`.
- **Reimplementing #840/#864's design instead of merging them risks drifting from the
  already-reviewed code.** Mitigated by citing and reusing their diffs as a reference (function
  bodies, doc comments, and test cases) rather than re-deriving the algorithm from scratch; the
  "Sources read" section below is the paper trail. #840/#864/#819/#854 live in `open-mercato/cezar`,
  a separate repository this account cannot push to or close issues/PRs in — this spec's Phases
  2-3 land as new commits in this repo only, and close nothing upstream.
- **Silent scope creep toward #847.** None of this spec's phases touch `ForgeKind`, `FORGE_HOSTS`,
  or any file under `packages/cezar/src/server/forge/` beyond citing them for context — if
  implementation drifts toward "let's also add GitLab," that is out of scope for this spec and
  belongs in a fresh one against #847.
- **A bare number with no candidates to prove it foreign still gets synthesized into a 404.**
  This workspace registers 12 projects across three owners (`MarcinWalendowski/*`,
  `Loki-Labs-AI/*`) plus four roots with no git remote at all, and this repo's own persisted runs
  carry `open-mercato/cezar`-lineage numbers (e.g. `issueNumber: 475`) against a `repoUrl` of
  `https://github.com/MarcinWalendowski/cezar` — a repo with zero issues and zero PRs. When a
  number arrives with **no** `referencedIssueCandidates`/`referencedPrCandidates` to prove it
  foreign — a bare `#N` typed into a prompt, or a `CEZ:ISSUE=`/`CEZ:PR=` marker declared for an
  upstream issue — Phases 1–3's guard has no evidence to act on and still synthesizes
  `https://github.com/MarcinWalendowski/cezar/issues/N`, a guaranteed 404. This is a known,
  accepted limitation of this spec, not a regression it introduces; closing it fully needs
  persisting the *origin repo* alongside the bare number, not just the number, and is left for a
  follow-up.

## Verification

1. **Phase 1 — unit.** `packages/web/src/api/queries.test.tsx`: new cases for
   `useProjectRepoBase()` — (a) unscoped (`projectId: null`) resolves the registry entry whose
   `id === projects.data.bootProject` and returns its `repoUrl`; (b) scoped to a *non-boot*
   project id resolves that project's own `repoUrl`, not the boot project's (the #526 regression
   guard and the literal bug this spec fixes); (c) a project with no `repoUrl` (non-GitHub remote,
   no remote, or non-git) returns `undefined`; (d) `projects.data === undefined` (still loading)
   returns `undefined`, not a throw.
2. **Phase 1 — manual/e2e (needs a running cockpit; ask before starting one per this session's
   standing instruction).** With ≥2 registered projects on different GitHub repos: open a task in
   the **non-boot** project whose transcript carries a `CEZ:ISSUE=` marker or a scraped issue/PR
   number, confirm the header/footer chip renders and links into that project's own repo (not the
   boot project's, not a 404). Repeat for the boot project to confirm no regression.
3. **Phase 2 — unit.** Port PR #840's `tasks-table.test.ts` cases for `taskIssueUrl` and
   `taskReferences` (foreign-number drop, other-numbers-kept, no-repo-inert, case-insensitivity,
   prefix-false-positive rejection, marker-number suppression) and its `global-tasks.test.tsx`
   case (no issue chip rendered for a candidate-proven foreign number). Run
   `npx vitest run packages/web/src/lib/tasks-table.test.ts packages/web/src/routes/global-tasks.test.tsx`.
4. **Phase 2 — server unit.** Port PR #840's `runs-index-api.test.ts` case ("carries the issue
   candidates the client needs to refuse a foreign issue chip") and update the field-enumeration
   assertion. Run `npx vitest run packages/cezar/src/server/runs-index-api.test.ts`.
5. **Phase 3 — unit.** Same shape as steps 3-4 for the PR half, using PR #864's test cases
   (`referencedPrCandidates` fixtures, `chipPrNumber`).
6. **Phase 4.** `grep -rn "githubRepoBase" packages/web/src` shows exactly two live references:
   the `queries.ts` import and its use as the fallback call inside `useProjectRepoBase()`. Add a
   `useProjectRepoBase()` unit case where `projects.data.projects` has no entry for `bootProject`
   but `health.data.repo.remote` is a GitHub remote — asserts it returns that repo's web root —
   and the same fixture with a **non-boot** `projectId` — asserts it returns `undefined` (the
   #526 guard).
7. **Full gate suite**, per this repo's Definition of Done: `npm run typecheck` (which runs
   `build:server` via `pretypecheck`), `npm run test`, and `npm run test:package` — this repo has
   no `lint` script (confirmed absent from the root `package.json` and every
   `packages/*/package.json`), so there is no lint gate to run. None of these phases touch
   build/packaging surfaces directly, but `test:package` is the gate that caught the last
   unrelated regression in this area (see `.ai/specs/2026-08-22-run-broker-cli-keepalive.md`) and
   should stay green.
8. **Close the loop on the record.** #840/#864/#819/#854 live in `open-mercato/cezar`, where this
   account has `push:false, triage:false` — `gh pr close`/`gh issue close` against them returns
   403, so this repo cannot act on them and must not try. Instead, close the loop in this repo's
   own record: mark this spec `status: implemented` once shipped, and note in the KB that the
   foreign-number guard's design originated in upstream `open-mercato/cezar` #840/#864 and was
   reimplemented here because the two repositories have diverged and are separately owned. Do not
   reference #847 — it is likewise another repo's issue and out of scope here.

## Sources read

- Brief: `.ai/specs/briefs/2026-08-22-github-issue-pr-links-multi-repo.md` (this task's own
  gather-the-record output; every numbered claim in it re-verified against the files below except
  where explicitly noted as "not independently re-verified"). **Note:** this brief file, and an
  earlier copy of this spec, were lost from this worktree between the 2nd and 3rd review passes
  when the worktree was externally re-synced (untracked files only — `git status` was clean
  afterward, `HEAD` unchanged at `0883256b`). This revision was re-emitted from a byte-identical
  preserved copy of the reviewed spec and re-verified live against the current worktree (`HEAD`,
  `queries.ts:1038-1077`, `tasks-table.ts:175-200` all re-read and match the citations below) —
  see this task's handoff file for the recovery trail.
- `packages/web/src/api/queries.ts:1038-1077` (`useHealth`, `useProjectRepoBase` in full),
  `:526-534` (`useProjects`), `:305-308` (`workspaceQueryKeys.projects`).
- `packages/web/src/api/project-scope-context.tsx` (full file — `useProjectScope`,
  `ProjectScopeProvider`).
- `packages/web/src/lib/tasks-table.ts:160-330` (`finishedRunCount` through `taskReference`, full
  region covering `githubRepoBase`, `taskPrUrl`, `prUrls`, `taskIssueUrl`, `TaskReferenceInput`,
  `taskReferences`).
- `packages/web/src/routes/global-tasks.tsx:380-400`, `:1695-1715`, `:1840-1855` (the
  existing-correct `task.project?.repoUrl` pattern).
- `packages/web/src/routes/task-thread/task-thread.tsx:270-300`.
- `packages/web/src/routes/task-thread/run-header.tsx:525-555`.
- `packages/contract/src/projects.ts:1-107` (`projectListEntrySchema`, `projectsResponseSchema`
  in full).
- `packages/contract/src/health.ts:190-215` (`readyResponseSchema`, `healthResponseSchema`).
- `packages/cezar/src/server/server.ts:2130-2175` (`healthForRequest`, health route wiring),
  `:6870-6912` (`runIndexEntry` in full).
- `packages/cezar/src/workspace/projects.ts:370-390` (`computeProbe`, confirms `repoUrl` derivation).
- `packages/web/src/routes.tsx:220-320` (`ProjectScopeRoute`, `LegacyPathRedirect` — confirms
  `useProjects()` is already fetched before any `/p/:projectId/*` route mounts).
- `packages/web/src/routes/tasks-overview.tsx:1015-1040` (comment confirming the same, from a
  different route).
- `packages/contract/src/runs.ts:219-350` (`runRecordSchema` region including
  `referencedPrCandidates`/`referencedIssueCandidates`), `:464-559` (`runIndexEntrySchema` in
  full).
- `gh pr view 840 --repo open-mercato/cezar --json number,title,state,mergeable,updatedAt,body`
  and same for `864` — both re-checked live this step: **both now `mergeable: CONFLICTING`**
  (brief's step recorded #840 as `UNKNOWN`, since revised by GitHub's own mergeability
  recomputation; #864 was already `CONFLICTING` in the brief and remains so).
- `gh pr diff 840 --repo open-mercato/cezar` and `gh pr diff 864 --repo open-mercato/cezar` (full
  diffs read) — source of the `namesNumberElsewhere`/`chipIssueNumber`/`chipPrNumber`
  implementations cited in Phases 2-3, the `runIndexEntrySchema`/`runIndexEntry()` diffs cited in
  Data models, and the test cases enumerated in Verification steps 3-5. Not merged: they are open
  against `open-mercato/cezar`, a separate repository this account has `pull`-only access to and
  whose `main` (`185c68a7`) is not in this history. Their diffs are read here as a design
  reference; their mergeability against that repo's `main` is irrelevant to this work.
- Recent specs read only for this repo's section-naming/citation conventions (not for content
  relevant to this bug): `.ai/specs/2026-08-22-run-broker-cli-keepalive.md`,
  `.ai/specs/2026-08-21-structured-review-targeted-spec-edits.md`,
  `.ai/specs/2026-08-09-issue-linked-pr-chip.md`.
- **Not independently re-verified this step** (carried from the brief as-is, lower confidence):
  `packages/cezar/src/server/forge/github.ts`'s exact line numbers for `resolveRepoHandle`/
  `fetchGithub`/`fetchGithubChecks`, and `server.ts:6164-6295`'s exact route-scoping lines — both
  cited in the brief from a prior codebase-map pass; the pattern they describe (per-project
  `repoRoot`) is corroborated by everything read above and is not itself changed by any phase in
  this spec, so re-verifying the exact line numbers was not load-bearing for this design.
- **Not found:** no KB entry or dedicated design doc for "per-project GitHub repo mapping" beyond
  the code and specs cited above (confirmed again this step, same as the brief).

