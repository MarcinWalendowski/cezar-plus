import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

import {
  useGitPreflight,
  useInitGitRepo,
  useProjectFolderScan,
  useProjects,
  useRegisterProject,
} from '@/api/queries'
import type { FsBrowseDir, NestedRepo } from '@open-mercato/cezar-api-client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { FolderBrowser, useBrowseTarget } from '@/components/folder-browser'
import { cn } from '@/lib/utils'

/**
 * "Add project → Open local folder" (multi-project spec, "Add project" / step 4.2).
 *
 * Registers the folder chosen in the shared `FolderBrowser` with `POST /api/v1/projects`, then
 * navigates to the new project's scope. The browsing itself — and the three API shapes it is
 * faithful to — lives in `components/folder-browser.tsx`, shared with "Add agent account".
 *
 * A non-git folder is selectable: `isRepo` only earns a badge, because cezar degrades in a
 * non-git folder exactly as `cezar serve` does today, so gating selection on it would invent a
 * restriction the server does not have.
 *
 * **Nested repos (spec `.ai/specs/2026-08-14-nested-repos-as-projects.md`).** A folder that holds
 * git repositories offers each one as its own project row, checked, alongside the folder itself.
 * The list is a PROPOSAL: `GET /api/v1/projects/scan` writes nothing, and the button registers
 * exactly what is still checked — one `POST /api/v1/projects` per row (D4), so every row gets its
 * own outcome instead of a batch that half-fails. That reverses D1 of the 2026-08-06 spec, which
 * had decided a workspace folder stays one project with a repo selector.
 *
 * The register errors (a home directory, hosted-mode narrowing) are shown VERBATIM: the server
 * writes them for the person reading them, and this dialog cannot know which of them is the
 * user's real situation.
 */
export function AddProjectDialog({
  open,
  onOpenChange,
  teamId,
  initialPath,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Onboarding step 4 (D8, spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`): assigns
   *  the newly registered project to this team. Omitted keeps today's behavior byte-identical —
   *  every OTHER caller of this dialog leaves it unset, and `registerProject` sends no `teamId`
   *  key at all when it is absent, so the request on the wire is unchanged for them. */
  teamId?: string
  /** D15: open the browser already showing this folder instead of the configured browse root.
   *  The onboarding wizard passes `health.repoRoot` — the directory cezar was launched in, which
   *  before D15 was silently registered at boot — so the historical one-launch-one-repo behaviour
   *  survives as one click rather than as a write nobody asked for. Omitted keeps today's
   *  behaviour byte-identical for every other caller. */
  initialPath?: string
}) {
  // `null` = the independently configured browse root. The dialog never spells that path itself
  // — it only ever echoes what it was told.
  const [path, setPath] = useState<string | null>(initialPath ?? null)
  const [selected, setSelected] = useState<FsBrowseDir | null>(null)
  const projects = useProjects()
  const register = useRegisterProject()
  const navigate = useNavigate()

  // Registry roots are realpath'd server-side; a listed `path` may be a symlink's own spelling,
  // so this match is best-effort — it decorates a row, it never blocks one. (A duplicate is not
  // an error anyway: the 409 carries the existing entry and we navigate to it.)
  const registered = new Set((projects.data?.projects ?? []).map((project) => project.root))

  const enter = (dir: string) => {
    setPath(dir)
    setSelected(null)
    register.reset() // a stale "that folder is your home directory" must not haunt the next one
  }

  // Nothing selected means "add the folder I am looking at" — the mockup's footer path. That is
  // also the only way to add the browse root itself.
  const target = useBrowseTarget(path, selected)

  // The nested-repo proposal for whatever folder is currently targeted. Keyed on `target`, so
  // walking into a subfolder re-asks about THAT folder rather than showing the parent's answer.
  const scan = useProjectFolderScan(target)
  const scanned = scan.data
  const nested: NestedRepo[] = scanned?.repos ?? []
  // Which row's "Set up git" panel is open — one at a time, by path. A per-row boolean would let
  // two preflights run at once over two different trees, and the second answer would render under
  // the first row that finished.
  const [setup, setSetup] = useState<string | null>(null)
  useEffect(() => setSetup(null), [scanned?.root])
  const anyNeedsGit =
    (scanned !== undefined && !scanned.rootIsRepo) ||
    nested.some((repo) => !repo.isRepo || repo.hasCommits === false)
  const repoCount = nested.filter((repo) => repo.isRepo).length
  const folderCount = nested.length - repoCount
  // Counts both kinds, because the list now proposes both and a sentence that only counted repos
  // would leave the user to work out where the other rows came from.
  const contents = [
    repoCount === 0 ? null : repoCount === 1 ? '1 git repository' : `${repoCount} git repositories`,
    folderCount === 0 ? null : folderCount === 1 ? '1 other folder' : `${folderCount} other folders`,
  ]
    .filter((part) => part !== null)
    .join(' and ')
  const summary =
    contents === ''
      ? 'This folder can be added as a project:'
      : `This folder holds ${contents}. Each can be added as its own project:`
  // Which rows will be registered. Seeded to "everything addable" each time a new scan lands and
  // never re-seeded from a refetch, so an unchecked row stays unchecked while the user is still
  // deciding — the same discipline the onboarding wizard's step state follows.
  const [skipped, setSkipped] = useState<Set<string>>(new Set())
  const [skipRoot, setSkipRoot] = useState(false)
  useEffect(() => {
    setSkipped(new Set())
    setSkipRoot(false)
  }, [scan.data?.root])

  const chosen = [
    ...(target !== null && !skipRoot ? [target] : []),
    ...nested.filter((repo) => !repo.registered && !skipped.has(repo.path)).map((repo) => repo.path),
  ]

  const toggle = (repoPath: string) =>
    setSkipped((current) => {
      const next = new Set(current)
      if (!next.delete(repoPath)) next.add(repoPath)
      return next
    })

  /**
   * Register every chosen row, one call each (D4).
   *
   * Sequential rather than concurrent: each `POST` takes the same workspace merge-write lease, and
   * the registry's own reader-then-writer window is the place two concurrent adds would drop one
   * another's entry. Six sequential local writes is imperceptible; a lost project is not.
   *
   * The FIRST row is what the dialog navigates to — for the overwhelmingly common single-folder
   * case that is the folder you picked, unchanged from before this list existed.
   */
  const add = async () => {
    if (chosen.length === 0 || register.isPending) return
    let first: string | null = null
    for (const root of chosen) {
      // Each row awaited on its own: `mutateAsync` rejects on a real failure (a home directory, a
      // cross-org root), and stopping there leaves the earlier rows registered — which they are,
      // and the error names the row that failed. Silently continuing past it would report a
      // success the user never got.
      //
      // Caught rather than allowed to propagate, and the two are NOT the same: the call site is
      // `void add()`, and `void` discards a promise without handling it, so a refused folder threw
      // an unhandled rejection into the page (and a "this might cause false positive tests" error
      // into the suite). Nothing is swallowed by catching here — `register.isError` below renders
      // the server's message verbatim, which is the whole error surface this flow ever had.
      try {
        const { project } = await register.mutateAsync({ root, teamId })
        first ??= project.id
      } catch {
        return
      }
    }
    if (first === null) return
    onOpenChange(false)
    // Raw react-router `useNavigate`, not the scope-aware wrapper: this is a deliberate
    // cross-project jump, and `/p/…` targets pass through the wrapper untouched anyway.
    navigate(`/p/${encodeURIComponent(first)}/`)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="add-project-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Open local folder</DialogTitle>
          <DialogDescription>
            Pick the folder cezar should run in. Git repos are marked; any folder works.
          </DialogDescription>
        </DialogHeader>

        <FolderBrowser
          path={path}
          selected={selected}
          onSelect={setSelected}
          onEnter={enter}
          emptyHint="No subfolders here — “Add project” registers this folder."
          decorate={(dir) => (
            <>
              {dir.isRepo ? (
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  git
                </Badge>
              ) : null}
              {registered.has(dir.path) ? (
                <Badge variant="ghost" className="shrink-0 text-[10px] text-muted-foreground">
                  already added
                </Badge>
              ) : null}
            </>
          )}
        />

        {scanned !== undefined && (nested.length > 0 || !scanned.rootIsRepo) ? (
          <div data-slot="nested-repos" className="min-w-0 space-y-1.5">
            <p className="text-[12px] text-soft-foreground">{summary}</p>
            <div className="max-h-52 space-y-1 overflow-y-auto">
              {/* The scanned folder itself, first — it is the row the footer target names, and
                  giving it a checkbox is what lets a container folder (no `.git` of its own, or
                  simply not wanted as a project) be skipped while its repos are kept. */}
              <div key="." data-slot="nested-row" data-repo="." data-git={scanned.rootIsRepo ? 'true' : 'false'}>
                <div className="flex items-center gap-2.5 rounded-md border border-border px-2.5 py-1.5 text-[13px]">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                    <input
                      type="checkbox"
                      data-slot="nested-toggle"
                      checked={!skipRoot}
                      onChange={() => setSkipRoot((current) => !current)}
                      className="size-3.5 shrink-0"
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                      {target === null ? '' : target.split('/').pop()}
                    </span>
                  </label>
                  <span className="shrink-0 text-[11px] text-muted-foreground">this folder</span>
                  {scanned.rootIsRepo ? null : <NoGitBadge kind="none" />}
                  {scanned.rootIsRepo ? null : (
                    <SetupButton path={scanned.root} open={setup === scanned.root} onOpen={setSetup} />
                  )}
                </div>
                {setup === scanned.root ? <SetupPanel path={scanned.root} onClose={() => setSetup(null)} /> : null}
              </div>
              {nested.map((repo) => {
                // Two different rows share one warning: a folder with no `.git` at all, and a repo
                // whose `.git` holds no commit. They cost the same thing — `git worktree add` on a
                // commitless repo succeeds and hands back an EMPTY tree — so the second is not a
                // lesser case of the first, it is the same case wearing a repo's badge.
                const needsGit = !repo.isRepo || repo.hasCommits === false
                return (
                  <div
                    key={repo.path}
                    data-slot="nested-row"
                    data-repo={repo.relPath}
                    data-git={repo.isRepo ? (repo.hasCommits === false ? 'no-commits' : 'true') : 'false'}
                    data-registered={repo.registered ? 'true' : undefined}
                  >
                    <div
                      className={cn(
                        'flex items-center gap-2.5 rounded-md border border-border px-2.5 py-1.5 text-[13px]',
                        repo.registered ? 'opacity-60' : null,
                      )}
                    >
                      <label
                        className={cn(
                          'flex min-w-0 flex-1 items-center gap-2.5',
                          repo.registered ? null : 'cursor-pointer',
                        )}
                      >
                        <input
                          type="checkbox"
                          data-slot="nested-toggle"
                          // An already-registered row is checked AND disabled: it is going to be a
                          // project either way, and a checkbox that cannot change what the button
                          // does would be a lie about the button.
                          checked={repo.registered || !skipped.has(repo.path)}
                          disabled={repo.registered}
                          onChange={() => toggle(repo.path)}
                          className="size-3.5 shrink-0"
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-foreground">{repo.relPath}</span>
                      </label>
                      {repo.branch ? (
                        <span className="shrink-0 text-[11px] text-muted-foreground">{repo.branch}</span>
                      ) : null}
                      {needsGit ? <NoGitBadge kind={repo.isRepo ? 'no-commits' : 'none'} /> : null}
                      {repo.registered ? (
                        <Badge variant="ghost" className="shrink-0 text-[10px] text-muted-foreground">
                          already added
                        </Badge>
                      ) : null}
                      {needsGit ? (
                        <SetupButton path={repo.path} open={setup === repo.path} onOpen={setSetup} />
                      ) : null}
                    </div>
                    {setup === repo.path ? <SetupPanel path={repo.path} onClose={() => setSetup(null)} /> : null}
                  </div>
                )
              })}
            </div>
            {/* The warning is the feature, not decoration. A folder that registers without git is
                not a slightly-worse project: it loses worktree isolation, it loses PARALLELISM —
                which is what cezar is for — and it loses the diff every review reads. Generic
                "no git" copy would let a user accept the row without learning any of that. */}
            {anyNeedsGit ? (
              <p data-slot="nested-no-git-warning" className="text-[12px] text-warning">
                Rows marked “no git” run <strong>in place, one task at a time</strong> — no isolated
                worktree, no parallel runs, and no diff to review. “Set up git” runs{' '}
                <code>git init</code> and a first commit, which is what restores all three.
              </p>
            ) : null}
            {/* The cap, said out loud. A silently short list reads as "there is nothing else in
                there", which is the one wrong answer this feature must not give. */}
            {scanned.truncated ? (
              <p data-slot="nested-truncated" className="text-[12px] text-warning">
                Only the first {nested.length} folders are listed — add the rest by opening them
                directly.
              </p>
            ) : null}
          </div>
        ) : null}

        {register.isError ? (
          <p data-slot="add-project-error" className="min-w-0 break-words text-[13px] text-danger">
            {register.error instanceof Error ? register.error.message : 'could not add that folder'}
          </p>
        ) : null}

        {/* min-w-0 matters: DialogContent is a grid, and a grid item with visible overflow
            cannot shrink below its min-content — a long target path (unbreakable, mono) would
            widen the whole column and push every row past the card edge. With the floor removed
            the path truncates instead. */}
        <DialogFooter className="min-w-0 sm:items-center sm:justify-between">
          <span
            data-slot="add-project-target"
            className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground"
            title={target ?? undefined}
          >
            {target ?? ''}
          </span>
          <span className="flex shrink-0 gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              data-slot="add-project-confirm"
              disabled={chosen.length === 0 || register.isPending}
              onClick={() => void add()}
            >
              {/* The label counts what will actually be written, so the button says what it does
                  rather than leaving the user to infer it from the checkboxes above. */}
              {register.isPending
                ? 'Adding…'
                : chosen.length > 1
                  ? `Add ${chosen.length} projects`
                  : 'Add project'}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** `no git` on a plain folder, `no commits` on a repo that has one but has never committed. Two
 *  badges rather than one because the fix is the same and the CAUSE is not — a user who sees
 *  "no git" on a directory they know is a repo learns nothing they can act on. */
function NoGitBadge({ kind }: { kind: 'none' | 'no-commits' }) {
  return (
    <Badge data-slot="no-git-badge" variant="outline" className="shrink-0 text-[10px] text-warning">
      {kind === 'none' ? 'no git' : 'no commits'}
    </Badge>
  )
}

/** Opens the panel below the row. A button, not a link or a checkbox: it is the one control here
 *  that WRITES to the user's disk, and it must not be reachable by the click that ticks a row. */
function SetupButton({
  path,
  open,
  onOpen,
}: {
  path: string
  open: boolean
  onOpen: (path: string | null) => void
}) {
  return (
    <Button
      data-slot="setup-git"
      variant="outline"
      size="sm"
      className="h-6 shrink-0 px-2 text-[11px]"
      onClick={(event) => {
        // The row's label wraps a checkbox; without this the same click would toggle the row's
        // participation in the add, which is a different decision entirely.
        event.preventDefault()
        onOpen(open ? null : path)
      }}
    >
      {open ? 'Cancel' : 'Set up git'}
    </Button>
  )
}

/**
 * The preflight summary, and the button that applies it.
 *
 * Shown BEFORE anything is written, because this is the only place in the dialog where a click
 * changes files on disk. It reports three things the user cannot otherwise see: how much will be
 * committed, what will be excluded and why, and whether cezar is refusing outright.
 *
 * A refusal disables the button rather than hiding it: a control that vanishes reads as a bug, and
 * the reason for the refusal is the actionable half.
 */
function SetupPanel({ path, onClose }: { path: string; onClose: () => void }) {
  const preflight = useGitPreflight(path)
  const init = useInitGitRepo()
  const data = preflight.data
  // Every refusal the server would answer with, asked here too so the button is not offered for a
  // click that can only fail. The server re-checks all of them — this is UI honesty, never the
  // guard itself.
  const refusal =
    data === undefined
      ? null
      : data.oversized.length > 0
        ? `${data.oversized[0]} is too large to commit — move or ignore it, then try again.`
        : data.truncated
          ? 'Too many files here for cezar to check them all for secrets.'
          : data.trackedElsewhere
            ? 'The git repository above this folder already tracks these files.'
            : data.alreadyRepo && data.hasCommits
              ? 'This folder is already a git repository with commits.'
              : null

  return (
    <div data-slot="setup-panel" className="mt-1 min-w-0 space-y-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-2 text-[12px]">
      {preflight.isPending ? <p className="text-muted-foreground">Checking what would be committed…</p> : null}
      {preflight.isError ? (
        <p data-slot="setup-error" className="break-words text-danger">
          {preflight.error instanceof Error ? preflight.error.message : 'could not inspect that folder'}
        </p>
      ) : null}
      {data !== undefined ? (
        <>
          <p data-slot="setup-summary" className="text-soft-foreground">
            {data.alreadyRepo
              ? 'Already a git repo with no commits. '
              : 'Runs git init and one commit on branch main. '}
            {data.files === 1 ? '1 file' : `${data.files} files`} ({formatBytes(data.bytes)}) would be
            committed.
          </p>
          {data.sensitive.length > 0 ? (
            <p data-slot="setup-excluded" className="break-words text-soft-foreground">
              Excluded as secrets, written to <code>.gitignore</code>:{' '}
              <span className="font-mono">{data.sensitive.slice(0, 6).join(', ')}</span>
              {data.sensitive.length > 6 ? ` and ${data.sensitive.length - 6} more` : ''}
            </p>
          ) : null}
          {refusal !== null ? (
            <p data-slot="setup-refusal" className="break-words text-warning">
              {refusal}
            </p>
          ) : null}
          {/* Said out loud, but not in the way of the button: this is the normal shape of a
              workspace folder that has a couple of files committed at its top, and the new repo is
              genuinely independent of that one. */}
          {refusal === null && data.insideRepo ? (
            <p data-slot="setup-nested-note" className="text-soft-foreground">
              Inside another git repo, which does not track this folder — the new repo will be
              independent of it.
            </p>
          ) : null}
        </>
      ) : null}
      {init.isError ? (
        <p data-slot="setup-error" className="break-words text-danger">
          {init.error instanceof Error ? init.error.message : 'could not set up git'}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          data-slot="setup-confirm"
          size="sm"
          className="h-6 px-2 text-[11px]"
          disabled={data === undefined || refusal !== null || init.isPending}
          onClick={() => {
            init.mutate(path, { onSuccess: onClose })
          }}
        >
          {init.isPending ? 'Setting up…' : 'Set up git'}
        </Button>
      </div>
    </div>
  )
}

/** `18.4 MB` / `212 KB`. Sizes are for a human deciding whether to look before committing. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}
