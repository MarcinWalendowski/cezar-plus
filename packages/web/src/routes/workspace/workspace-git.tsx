import { GitBranchIcon, GitCommitHorizontalIcon, TriangleAlertIcon } from 'lucide-react'

import { useHealth, useWorkspaceGit } from '@/api/queries'
import type { WorkspaceGitProject } from '@loki-labs/better-cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Badge } from '@/components/ui/badge'
import { workspaceViewsOffSubtitle } from '@/lib/capability-copy'
import { Link, scopeTo } from '@/lib/project-router'

/**
 * `/workspace/git` — the cross-project git overview (`.ai/specs/2026-08-14-cross-project-git-overview.md`
 * Phase 2). One row per registered project: branch, ahead/behind, dirty count, last commit — the
 * question the owner actually has, answered without a per-project click and without the
 * per-project context build that click costs today.
 *
 * **Workspace-level: mounted OUTSIDE `ProjectScopeRoute`** (`routes.tsx`), the same placement as
 * `/workspace/tasks` and `/notes`. That means the scope trap applies: with no `ProjectScopeRoute`
 * above this route, `queryScope()` would silently resolve to the boot project's `'default'`
 * sentinel, so a project-scoped query or client call made from here would read the WRONG
 * project's data with no error, no throw, no symptom (`workspace-tasks.tsx`'s own docblock names
 * this exactly). **This file reads only `useHealth` and `useWorkspaceGit` — never a scope-led
 * query or client function.** `workspace-git.test.tsx` asserts this by request log: it fails if
 * any `/api/v1/p/…` URL is ever requested.
 *
 * Row links are the one place this page touches a project scope, and that is safe BY
 * CONSTRUCTION rather than by care: `scopeTo(row.id, '/git')` builds an href string client-side —
 * no request leaves this page for it. Following the link is a deliberate navigation into
 * `/p/:projectId/*`, which is where building that project's context is correct and expected (the
 * server spec's Problem §1: "a caller under that prefix is standing in the project, and opening
 * it is a deliberate act"). A failed row (`ok: false`) is NOT linked — there is nothing on the
 * other side worth a click, and the reason is already on this page.
 *
 * **A failed project renders as a visible row carrying its reason, never filtered out.** The
 * server's whole point (D3: "never silently fewer rows") is defeated if the client then hides the
 * row it went to the trouble of returning — a dead repo that vanishes from this page reads as
 * "all clear" when it is the opposite.
 *
 * **`ahead`/`behind` absent renders differently from `0`**, in `SyncStatus` below: absent (no
 * upstream) renders nothing, `0`/`0` (an upstream that is level) renders "up to date", and a
 * nonzero pair renders the counts. Collapsing any two of those three into the same markup would
 * destroy the distinction the server went to trouble to preserve (`git.ts#parseBranchHeader`).
 *
 * No push channel drives this data (unlike the runs board's `/workspace/events`), and the server
 * ships no cache for it on purpose (D5) — `useWorkspaceGit` polls instead; see its own doc
 * comment in `api/queries.ts`.
 */
export function WorkspaceGitRoute() {
  const health = useHealth()
  const healthKnown = health.data !== undefined
  const gitOff = healthKnown && health.data.capabilities?.workspaceViews !== true

  // Gated on the capability answer, not fired optimistically — the flag-off list is a 200
  // carrying an empty payload (D1/D19), so a fetch made before health arrives comes back
  // indistinguishable from "no projects registered" and paints the wrong empty state.
  const git = useWorkspaceGit(healthKnown && !gitOff)

  if (!healthKnown) {
    return (
      <WorkspaceGitShell>
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      </WorkspaceGitShell>
    )
  }

  if (gitOff) {
    return (
      <WorkspaceGitShell>
        <CenteredState
          icon={<GitBranchIcon />}
          tone="neutral"
          title="The workspace git overview is off"
          subtitle={workspaceViewsOffSubtitle(health.data.capabilities?.singleProject)}
          heading="h2"
        />
      </WorkspaceGitShell>
    )
  }

  const rows = git.data?.projects ?? []

  return (
    <WorkspaceGitShell>
      <div className="flex flex-1 flex-col gap-3 p-3 md:p-5">
        {git.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <CenteredState
            icon={<GitBranchIcon />}
            tone="neutral"
            title="No projects registered"
            subtitle="Register a project from the sidebar to see its git status here."
            heading="h2"
          />
        ) : (
          <ul className="flex flex-col gap-2" data-testid="workspace-git-list">
            {rows.map((row) => (
              <ProjectRow key={row.id} row={row} />
            ))}
          </ul>
        )}
      </div>
    </WorkspaceGitShell>
  )
}

function WorkspaceGitShell({ children }: { children: React.ReactNode }) {
  return (
    <div data-route="workspace-git" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Git</h1>
      </header>
      <div className="flex flex-1 flex-col">{children}</div>
    </div>
  )
}

function ProjectRow({ row }: { row: WorkspaceGitProject }) {
  if (!row.ok) {
    return (
      <li
        data-project-id={row.id}
        data-ok="false"
        className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3"
      >
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{row.name}</span>
          <span data-slot="workspace-git-reason" className="text-xs text-destructive">
            {row.reason}
          </span>
        </div>
      </li>
    )
  }

  return (
    <li
      data-project-id={row.id}
      data-ok="true"
      className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-3 sm:flex-row sm:items-center sm:gap-3"
    >
      <Link
        to={scopeTo(row.id, '/git')}
        className="flex min-w-0 items-center gap-2 text-sm font-medium hover:underline sm:w-40 sm:shrink-0"
      >
        <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{row.name}</span>
      </Link>

      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        <BranchLabel row={row} />
        <DirtySummary dirty={row.dirty} />
        <SyncStatus row={row} />
        <HeadCommit head={row.head} />
      </div>
    </li>
  )
}

/** `detached` wins over `branch` because the two are mutually exclusive on the wire (a detached
 *  HEAD reports no branch name); absent-both is the unborn-repo edge case with nothing to show. */
function BranchLabel({ row }: { row: WorkspaceGitProject }) {
  if (row.detached) {
    return (
      <Badge variant="outline" className="font-mono text-[11px]">
        detached
      </Badge>
    )
  }
  if (row.branch) {
    return (
      <Badge variant="outline" className="font-mono text-[11px]">
        {row.branch}
      </Badge>
    )
  }
  return null
}

function DirtySummary({ dirty }: { dirty?: WorkspaceGitProject['dirty'] }) {
  if (!dirty) return null
  const total = dirty.staged + dirty.unstaged + dirty.untracked
  if (total === 0) {
    return (
      <span data-slot="workspace-git-dirty" className="text-xs text-muted-foreground">
        clean
      </span>
    )
  }
  const parts: string[] = []
  if (dirty.staged > 0) parts.push(`${dirty.staged} staged`)
  if (dirty.unstaged > 0) parts.push(`${dirty.unstaged} unstaged`)
  if (dirty.untracked > 0) parts.push(`${dirty.untracked} untracked`)
  return (
    <span data-slot="workspace-git-dirty" className="text-xs text-pending-strong">
      {parts.join(' · ')}
    </span>
  )
}

/**
 * The three-way rendering the server's `ahead`/`behind` contract exists for
 * (`.ai/specs/2026-08-14-cross-project-git-overview.md`, Data Models — "absent" vs "0" are
 * different facts, and the UI must say which):
 *
 * - `row.upstream === undefined` → no upstream at all, nothing rendered. Nothing to compare
 *   against, so no claim is made — not even "clean".
 * - `upstream` present, `ahead`/`behind` both absent → the `[gone]` case (the remote-tracking
 *   ref no longer exists). Same as above: nothing can be counted, so nothing is claimed.
 * - `upstream` present, both `0` → a real comparison came back level. Renders "up to date",
 *   which is NOT the same markup as the no-upstream case above.
 * - `upstream` present, either nonzero → renders the counts.
 */
function SyncStatus({ row }: { row: WorkspaceGitProject }) {
  if (row.upstream === undefined) return null
  if (row.ahead === undefined && row.behind === undefined) return null

  const ahead = row.ahead ?? 0
  const behind = row.behind ?? 0
  if (ahead === 0 && behind === 0) {
    return (
      <span data-slot="workspace-git-sync" className="text-xs text-muted-foreground">
        up to date
      </span>
    )
  }
  return (
    <span data-slot="workspace-git-sync" className="text-xs text-muted-foreground">
      {ahead > 0 ? `↑${ahead}` : null}
      {ahead > 0 && behind > 0 ? ' ' : null}
      {behind > 0 ? `↓${behind}` : null}
    </span>
  )
}

function HeadCommit({ head }: { head?: WorkspaceGitProject['head'] }) {
  if (!head) return null
  return (
    <span
      data-slot="workspace-git-head"
      className="flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground"
      title={head.subject}
    >
      <GitCommitHorizontalIcon className="size-3.5 shrink-0" />
      <span className="font-mono">{head.hash}</span>
      <span className="truncate">{head.subject}</span>
      <span className="shrink-0">· {head.when}</span>
    </span>
  )
}
