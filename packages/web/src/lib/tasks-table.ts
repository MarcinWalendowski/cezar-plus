import type { ProcessUsage, RunRecord, RunStatus } from '@loki-labs/better-cezar-api-client'
import { groupTitle, runTitle, type ListView } from '@/lib/task-groups'

/**
 * The pure half of the Tasks table (the `/` overview): search, the header's archive count, the
 * usage-cell decisions and the compare-variants strip. The component only paints what these say.
 *
 * The usage semantics are ported from the legacy table (`web/app.js` → `renderRunsTable` /
 * `runRowHtml`), which is R1's parity bar: a live sample is only believed while the run's own
 * process tree can exist, and a finished run falls back to its persisted peaks, dimmed.
 */

/** Statuses whose usage sample is current — a session is registered while running AND while
 *  parked at `waiting` (the CLI process stays alive). Legacy `USAGE_LIVE_STATUSES`. */
const USAGE_LIVE_STATUSES: ReadonlySet<RunStatus> = new Set(['running', 'waiting'])

/** Nothing left to observe: these runs can never report a live sample again. Legacy
 *  `TERMINAL_STATUSES` — `review` is terminal because the agent is done and a human is not. */
export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(['done', 'failed', 'review', 'cancelled'])

/** What "Archive finished" archives (`POST /api/runs/archive-finished` server-side): outcomes,
 *  not gates — a `review` run still wants a human and must not be swept away. */
const FINISHED_STATUSES: ReadonlySet<RunStatus> = new Set(['done', 'failed', 'cancelled'])

/**
 * Humanized RSS — `612 MB`, `1.2 GB`. Ported from the legacy `fmtBytes` (ps gives KB, the store
 * keeps bytes) so both cockpits print the same number for the same sample. '' for nothing —
 * the cell renders its own em dash, `0 kB` would claim a measurement that never happened.
 */
export function formatMem(bytes: number | undefined): string {
  if (!bytes) return ''
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.round(bytes / 1024)} kB`
}

/** Compact token count for a narrow cell: `512`, `45k`, `1.2M`. Thousands round to whole `k`
 *  (a column this narrow has no room for `44.7k`); millions keep one decimal until ten, where
 *  it too stops mattering. Used by the Context column's `used / max` pair. */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return `${Math.round(tokens)}`
}

/** One Context cell: current window occupancy over the model's max (spec
 *  2026-08-19-context-usage-in-tasks-table). `text` is '' when the run has recorded no
 *  context yet — the cell renders its own em dash. `ratio` (used/max, only when both are
 *  known) drives the amber/danger tint as the window fills. */
export interface ContextCell {
  text: string
  ratio?: number
}

export type ContextCellInput = Pick<RunRecord, 'contextTokens' | 'contextWindow'>

export function contextCell(run: ContextCellInput): ContextCell {
  const used = run.contextTokens
  if (used === undefined) return { text: '' }
  const max = run.contextWindow
  // Without a modelled max (a runner whose window we do not size) the cell is honest and shows
  // only the current figure rather than dividing by an invented denominator.
  if (!max) return { text: formatTokenCount(used) }
  return { text: `${formatTokenCount(used)} / ${formatTokenCount(max)}`, ratio: used / max }
}

/** `$0.31` / `$12` — two decimals until the cents stop mattering. Legacy `fmtCost`; '' when the
 *  run has no recorded spend, because `$0.00` reads as "measured: free" and it was not measured. */
export function formatCost(usd: number | undefined): string {
  if (!usd) return ''
  return `$${usd >= 10 ? usd.toFixed(0) : usd.toFixed(2)}`
}

/**
 * When a `scheduled` run resumes itself, sized for a list row (spec
 * 2026-08-03-auto-resume-after-usage-limit).
 *
 * `label` rides in the status pill beside the word "scheduled", so it is deliberately terse:
 * clock time alone for an appointment later today, a short date in front once it is not. `title`
 * carries the full instant to the second for the hover — a row has no space for it, and the
 * thread's own hint is where the exact time belongs.
 *
 * Undefined for anything without a live schedule, including an unparseable stamp: a row must
 * never print `Invalid Date` next to "scheduled".
 */
export function scheduledResume(
  run: Pick<RunRecord, 'status' | 'autoResumeAt'>,
  now: Date = new Date(),
): { label: string; title: string } | undefined {
  if (run.status !== 'failed' || !run.autoResumeAt) return undefined
  const at = new Date(run.autoResumeAt)
  if (!Number.isFinite(at.getTime())) return undefined
  const sameDay = at.toDateString() === now.toDateString()
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at)
  return {
    label: sameDay
      ? time
      : `${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(at)} ${time}`,
    title: `Resumes automatically at ${new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'long',
    }).format(at)}`,
  }
}

/**
 * How a workflow NAME is displayed. Identity in, display text out — nothing else.
 *
 * `spec-to-deploy` is the value the server resolves to when a run names no workflow at all
 * (`server.ts`'s `resolveRunWorkflow`, since the 2026-08-19 default change). So it is what almost
 * every row created without an explicit pick carries, and its raw name reads as a choice somebody
 * made when it is the absence of one. It prints as **default**. (`quick-task`, the old floor, is
 * now an ordinary named pick and shows itself verbatim.)
 *
 * **Display only, and that boundary is the whole design.** The stored `RunRecord.workflow`, the
 * `POST /runs` body, the `--workflow` CLI flag, the catalog entry and any `.ai/cezar/workflows/
 * spec-to-deploy.yaml` override a repo may ship are all untouched — `spec-to-deploy` remains the
 * name every one of those speaks. Renaming the identity would break committed/shared workflow
 * files; renaming the label costs nothing and can be undone by deleting one map entry.
 *
 * **The line is REFERENCING a workflow versus AUTHORING one**, and it is deliberate, not an
 * oversight to tidy up later. Everything that says "this run used that workflow" goes through
 * here: both task boards, the per-project table, the thread header, the queued-run note, the
 * workflow facet, the group-by headings, and the composer's picker *and* its pill (those two sit
 * two clicks apart and must agree). The Workflows builder page (`routes/workflows/`) does NOT —
 * its chips load a workflow into an editable draft whose name field becomes
 * `.ai/cezar/workflows/<name>.yaml`, so a chip reading "default" that populates `spec-to-deploy`
 * and saves `spec-to-deploy.yaml` would be a lie about the thing you are editing. There the name
 * IS the subject; here it is a reference to one.
 */
const WORKFLOW_DISPLAY_NAMES: Readonly<Record<string, string>> = { 'spec-to-deploy': 'default' }

/** The display text for a workflow name. Unmapped names pass through verbatim, so a real pick
 *  (`plan-first`, a repo's own file) always shows itself. */
export function displayWorkflowName(workflow: string): string {
  return WORKFLOW_DISPLAY_NAMES[workflow] ?? workflow
}

/** The Workflow column's text. `(planned)` chains and inbox runs carry their meaning in their
 *  first agent step, so that name reads better than the placeholder. Legacy `workflowLabel`.
 *
 *  Takes a `RunRecord` because the step lookup needs `steps[]`; the cross-project boards hold the
 *  slim `RunIndexEntry`, which deliberately omits them, and reach `displayWorkflowName` directly. */
export function workflowLabel(run: RunRecord): string {
  if (run.workflow === '(planned)' || run.workflow === '(inbox)') {
    const agent = run.steps.find((step) => step.kind === 'agent')
    if (agent?.name) return agent.name
  }
  return displayWorkflowName(run.workflow)
}

/**
 * The header search: case-insensitive substring over what the table actually shows — the
 * displayed title (`runTitle`: the auto-summary when one exists, per R2 #389), branch and
 * workflow (both the raw name and the label the column prints). Not the task prompt, and not a
 * raw `title` hidden behind a summary: matching on text the table never displays makes rows
 * appear for no visible reason.
 */
export function filterRuns(runs: readonly RunRecord[], query: string): RunRecord[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...runs]
  return runs.filter((run) =>
    [runTitle(run), run.branch ?? '', run.workflow, workflowLabel(run)].some((text) =>
      text.toLowerCase().includes(needle),
    ),
  )
}

/** How many active runs "Archive finished" would sweep. The button only exists when this is
 *  nonzero — a broom over an empty floor is noise (legacy showed the same count-gated button). */
export function finishedRunCount(runs: readonly RunRecord[]): number {
  return runs.filter((run) => !run.archived && FINISHED_STATUSES.has(run.status)).length
}

/** A git remote as a GitHub web root (`https://github.com/owner/repo`). No longer the normal
 *  source of `repoBase` — `useProjectRepoBase()` reads the server-computed `repoUrl` off the
 *  project registry (`GET /api/v1/projects`) for that. This is now reached only on that hook's
 *  boot-only fallback path: a boot project the registry has no row for (unregistered), or an
 *  errored/empty registry response, where the caller passes `/api/v1/health`'s `repo.remote`
 *  instead. Handles the scheme forms (`https://`, `ssh://`, credentials, port) and the scp-like
 *  `git@github.com:owner/repo.git`; undefined for every non-github.com host, local path, or absent
 *  remote — the cockpit only knows how to spell GitHub issue URLs. Mirrors the server's
 *  `parseRemote` (`src/server/forge/index.ts`), duplicated rather than imported because that
 *  module is server-only. */
export function githubRepoBase(remote: string | undefined): string | undefined {
  if (!remote) return undefined
  const trimmed = remote.trim().replace(/\/+$/, '')
  const url = /^(?:https?|ssh|git|git\+ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(trimmed)
  // scp-like: [user@]host:owner/repo(.git) — a leading '/' (local path) can't match the host group.
  const scp = url ? null : /^(?:[^@/:]+@)?([^:/]+):(.+)$/.exec(trimmed)
  const match = url ?? scp
  if (!match) return undefined
  const [, host, path] = match
  if (!path || host?.toLowerCase() !== 'github.com') return undefined
  const parts = path.replace(/\.git$/i, '').split('/').filter(Boolean)
  const owner = parts[parts.length - 2]
  const repo = parts[parts.length - 1]
  return owner && repo ? `https://github.com/${owner}/${repo}` : undefined
}

/** The URL a PR *display* chip shows: the PR the task created, else the PR the conversation
 *  is about (#407 — review/continue tasks reference an existing PR instead of opening one).
 *  Action gates (Draft PR, Create PR→View PR) must keep reading `pullRequestUrl` directly:
 *  a task that reviewed PR X must still be able to open its own PR from its branch. */
export function taskPrUrl(run: TaskReferenceInput): string | undefined {
  return prUrls(run)[0]
}

/**
 * Every PR URL a task legitimately points at, strongest first: the PR it CREATED, then the PR the
 * conversation is about (#407). Both are real and can coexist — a review task can open a
 * follow-up PR of its own — which is why this is a list and `taskPrUrl` is merely its head.
 *
 * The one suppression is #526: a run whose declared subject is an ISSUE (CEZ:ISSUE) and that
 * declared no PR must not adopt an incidental transcript PR as "its" PR — an `om-prepare-issue`
 * run linking a stray PR that merely appeared in its output is a false, misleading association.
 * It lives HERE, once, so the singular and plural accessors cannot drift apart on it.
 */
function prUrls(run: TaskReferenceInput): string[] {
  const urls: string[] = []
  if (run.pullRequestUrl) urls.push(run.pullRequestUrl)
  const suppressAboutPr = run.markerRefs?.issue !== undefined && run.markerRefs?.pr === undefined
  if (!suppressAboutPr && run.referencedPullRequestUrl) urls.push(run.referencedPullRequestUrl)
  return urls
}

/**
 * Whether `candidates` — raw URLs scraped from a run's transcript (`referencedIssueCandidates` /
 * `referencedPrCandidates`) — prove that `number` belongs to a DIFFERENT repository than
 * `repoBase`. Design ported, read-only, from `open-mercato/cezar` PRs #840/#864 (a separate
 * repository this workspace has pull-only access to; see spec
 * `.ai/specs/2026-08-22-github-issue-pr-links-multi-project.md`).
 *
 * Evidence-only, in both directions:
 * - With no known `repoBase` there is nothing to compare a candidate against, so the guard is
 *   inert — a project with no resolvable repo behaves exactly as it did before this guard existed
 *   (see the spec's risk note on a bare number with no candidates).
 * - With no candidates there is no evidence either way, so a bare `#N` is never blocked merely for
 *   lacking proof of innocence.
 *
 * The match is a case-insensitive prefix check against `${repoBase}/`, not a bare
 * `startsWith(repoBase)` — `https://github.com/owner/repo` is itself a string-prefix of
 * `https://github.com/owner/repo-two/issues/5`, and without the trailing slash a same-prefix,
 * different-repo candidate would be misread as naming THIS repo instead of another one.
 */
function namesNumberElsewhere(
  candidates: readonly string[] | undefined,
  number: number,
  repoBase: string | undefined,
): boolean {
  if (!repoBase || !candidates?.length) return false
  const ownPrefix = `${repoBase}/`.toLowerCase()
  return candidates.some(
    (url) => prNumber(url) === String(number) && !url.toLowerCase().startsWith(ownPrefix),
  )
}

/** The bare `issueNumber` a chip may safely show, dropped when `referencedIssueCandidates` proves
 *  it names a different repository than `repoBase` (`namesNumberElsewhere`). Deliberately does
 *  NOT read `markerRefs.issue` — that is `taskIssueUrl`'s own source, a DIFFERENT (marker-declared)
 *  reference that can coexist with a distinct scraped `issueNumber`, and folding the two together
 *  here would silently merge two references `taskReferences` must keep separate. */
function chipIssueNumber(run: TaskReferenceInput, repoBase: string | undefined): number | undefined {
  const number = run.issueNumber
  if (number === undefined) return undefined
  return namesNumberElsewhere(run.referencedIssueCandidates, number, repoBase) ? undefined : number
}

/** The PR chip's numeric-only twin of `chipIssueNumber`: `prNumber`, dropped when
 *  `referencedPrCandidates` proves it names a different repository than `repoBase`. */
function chipPrNumber(run: TaskReferenceInput, repoBase: string | undefined): number | undefined {
  const number = run.prNumber
  if (number === undefined) return undefined
  return namesNumberElsewhere(run.referencedPrCandidates, number, repoBase) ? undefined : number
}

/** Display-only issue association. Action gates must continue to use their created-resource
 * fields directly; this accessor exists only for links painted by the cockpit.
 *
 * `repoBase` is the repository of the project on screen (`useProjectRepoBase()`) and is the only
 * authority a *synthesized* link may be built on. Callers without it get today's behavior:
 * a discovered URL or nothing. */
export function taskIssueUrl(run: TaskReferenceInput, repoBase?: string): string | undefined {
  if (run.referencedIssueUrl) return run.referencedIssueUrl
  // #526: an issue-subject run (om-prepare-issue) knows its issue number from the CEZ:ISSUE
  // marker even when no full `…/issues/N` link was ever scanned into referencedIssueUrl.
  // Synthesize the link from the PROJECT's repo only — never from `referenced*Candidates` or
  // `referenced*Url`, which are transcript scrapings that routinely name other repositories:
  // `CEZ:ISSUE=524` beside an incidental `github.com/other/repo/pull/1` would rebuild the exact
  // wrong-link defect #526 exists to kill, just pointing at an issue instead of a PR.
  const number = run.markerRefs?.issue ?? run.issueNumber
  // `namesNumberElsewhere` additionally refuses a number `referencedIssueCandidates` proves
  // belongs to a different repo entirely (foreign-number guard, design ported read-only from
  // `open-mercato/cezar` #840).
  if (!number || !repoBase || namesNumberElsewhere(run.referencedIssueCandidates, number, repoBase)) {
    return undefined
  }
  return `${repoBase}/issues/${number}`
}

/**
 * What deciding a task's tracker chip actually reads.
 *
 * `Pick`ed rather than the whole `RunRecord`, for the same reason `RunTitleInput` and
 * `AttentionInput` are: the cross-project index (`RunIndexEntry`) is a slim row, not a record,
 * and the global Tasks page must resolve a PR/issue chip exactly as every other surface does.
 * Widening this means widening `runIndexEntrySchema` too, or that page silently answers
 * differently — which is the whole failure a shared rule exists to prevent.
 */
export type TaskReferenceInput = Pick<
  RunRecord,
  | 'pullRequestUrl'
  | 'referencedPullRequestUrl'
  | 'prNumber'
  | 'issueNumber'
  | 'referencedIssueUrl'
  | 'markerRefs'
  | 'referencedPrCandidates'
  | 'referencedIssueCandidates'
>

export interface TaskReference {
  kind: 'PR' | 'Issue'
  number: number
  url?: string
}

/**
 * EVERY tracker reference a task knows about, strongest first.
 *
 * A task routinely has more than one, and the count is not capped at two: a review task opened on
 * issue #524 can be ABOUT PR #530 and have created PR #533 of its own, and all three are true at
 * once. Surfaces with room — the global Tasks table — show them all; surfaces with room for one
 * (`taskReference` below) take the first.
 *
 * Built by walking an ordered list of SOURCES rather than by hand-picking a winner, so adding the
 * next kind of reference is one entry here and nothing else — and the PR half is `prUrls`, the
 * same list `taskPrUrl` takes its head from, so the two can never disagree about #407 or #526. Order is strongest-first — the PR a
 * task created, the PR it is about, then the issue — which is also what makes `taskReference`
 * answer exactly what it always answered.
 *
 * `referencedPrCandidates` / `referencedIssueCandidates` are never a SOURCE of a reference here —
 * they are transcript scrapings that routinely name OTHER repositories (#526), so a further
 * reference still has to arrive as a real field before it can be shown. They are read only as
 * EVIDENCE, by `chipPrNumber`/`chipIssueNumber` via `namesNumberElsewhere`, to refuse a
 * numeric-only reference the candidates prove belongs to a different repo than `repoBase`
 * (foreign-number guard, design ported read-only from `open-mercato/cezar` #840/#864).
 * `markerRefs.pr` is the obvious next SOURCE, and is left out only because today it never appears
 * without one of the URLs below already carrying it.
 *
 * Deduped by kind+number, so one reference reached through two fields stays one chip.
 */
export function taskReferences(run: TaskReferenceInput, repoBase?: string): TaskReference[] {
  const sources: { kind: TaskReference['kind']; url?: string; number?: number }[] = [
    ...prUrls(run).map((url) => ({ kind: 'PR' as const, url })),
    // Numeric-only: a reference known by number before any URL was scraped. `repoBase` turns it
    // into a real link — see the synthesis note below. `chipPrNumber`/`chipIssueNumber` additionally
    // refuse a number the run's own `referenced*Candidates` prove belongs to a different repo
    // (foreign-number guard, design ported from open-mercato/cezar #840/#864).
    { kind: 'PR', number: chipPrNumber(run, repoBase) },
    { kind: 'Issue', url: taskIssueUrl(run, repoBase) },
    { kind: 'Issue', number: chipIssueNumber(run, repoBase) },
  ]

  const seen = new Set<string>()
  const references: TaskReference[] = []
  for (const source of sources) {
    const number = source.url ? Number(prNumber(source.url)) : source.number
    if (!number || !Number.isInteger(number)) continue
    const key = `${source.kind}#${number}`
    if (seen.has(key)) continue
    seen.add(key)
    // A number with no URL becomes one from the PROJECT's own repo — the same synthesis rule
    // `taskIssueUrl` already applies, and the same hard limit: only ever the project's repo,
    // never a URL scraped from a transcript, which routinely names another repository (#526).
    // Without a `repoBase` the chip stays inert text rather than linking somewhere invented.
    const url = source.url ?? synthesizeUrl(source.kind, number, repoBase)
    references.push({ kind: source.kind, number, ...(url ? { url } : {}) })
  }
  return references
}

/** `#402` on a known repo → its forge URL. Undefined without a repo to build it from. */
function synthesizeUrl(
  kind: TaskReference['kind'],
  number: number,
  repoBase: string | undefined,
): string | undefined {
  if (!repoBase) return undefined
  return `${repoBase}/${kind === 'PR' ? 'pull' : 'issues'}/${number}`
}

/** The strongest known tracker reference — what a row with space for exactly one shows (the
 *  sidebar row, the per-project table). PRs win once one exists; issue-driven queued runs still
 *  expose their already-known issue immediately.
 *
 *  `repoBase` is the repo of the project the ROW belongs to — the caller resolves it once (never
 *  inside a `useMemo`/`flatMap` callback; see the multi-project spec's Phase 5) and passes it
 *  down, exactly like `taskReferences`. Without it, a numeric-only reference stays inert text and
 *  the foreign-number guard has no evidence to check a number against. */
export function taskReference(run: TaskReferenceInput, repoBase?: string): TaskReference | undefined {
  return taskReferences(run, repoBase)[0]
}

/** The PR chip's `#402`. Null when the URL's last segment is not a number — a forge we don't
 *  recognize still gets a working chip, just without a number we'd be inventing. */
export function prNumber(url: string): string | null {
  const last = url.split('/').pop() ?? ''
  return /^\d+$/.test(last) ? last : null
}

/** One cell of the CPU/Mem pair. `text` is '' when there is nothing true to print. */
export interface UsageCell {
  text: string
  /** live: a current sample, emphasized. peak: a finished run's persisted high-water mark,
   *  dimmed. none: an honest em dash. */
  kind: 'live' | 'peak' | 'none'
  /** Tooltip for the peak cell — says the number is history, not a reading. */
  title?: string
}

/**
 * What the CPU and Mem columns say for one run.
 *
 * A sample is only believed while the run's process tree can exist (`USAGE_LIVE_STATUSES`) — the
 * usage stream is a snapshot broadcast, and a tick that raced the run's exit must not paint a
 * finished row as live.
 *
 * `Pick`ed rather than a whole `RunRecord`, for the same reason `RunTitleInput` and
 * `AttentionInput` are: the cross-project index (`RunIndexEntry`) is a slim row, and the global
 * Tasks table must read usage exactly as the per-project one does rather than inventing a
 * second set of fallbacks. With no live sample, Mem falls back to the persisted `peakRssBytes`
 * (dimmed, labeled `peak`); CPU has no persisted peak, so its cell goes empty rather than
 * inventing one. Exactly the legacy table's fallbacks.
 */
export type UsageCellInput = Pick<RunRecord, 'status' | 'peakRssBytes' | 'peakProcCount'>

export function usageCells(
  run: UsageCellInput,
  sample: ProcessUsage | undefined,
): { cpu: UsageCell; mem: UsageCell } {
  const live = USAGE_LIVE_STATUSES.has(run.status) ? sample : undefined
  if (live) {
    return {
      cpu: { text: `${live.cpuPct.toFixed(0)}%`, kind: 'live' },
      mem: { text: formatMem(live.rssBytes), kind: 'live' },
    }
  }
  const peakMem = formatMem(run.peakRssBytes)
  return {
    cpu: { text: '', kind: 'none' },
    mem: peakMem
      ? {
          text: `peak ${peakMem}`,
          kind: 'peak',
          title: `peak — run finished${run.peakProcCount ? ` · ${run.peakProcCount} procs` : ''}`,
        }
      : { text: '', kind: 'none' },
  }
}

/** One compare-variants strip below the table. */
export interface CompareGroup {
  groupId: string
  /** The shared task title, without the ` (A)` suffix. */
  title: string
  count: number
}

/**
 * The variant groups whose members are all terminal — the ones a Compare link can honestly
 * offer, because every diff it would show is final. Groups still in flight get no strip: a
 * comparison that changes under the reader is worse than none (the mockup's disabled strip is a
 * later refinement; R1 shows only what works).
 *
 * Scoped to the view like everything else on this screen: an archived group belongs to the
 * Archived tab. A `groupId` with one member left in view is a picked winner, not a comparison.
 */
export function compareGroups(runs: readonly RunRecord[], view: ListView): CompareGroup[] {
  const inView = runs.filter((run) => (view === 'archived' ? run.archived : !run.archived))
  const byGroup = new Map<string, RunRecord[]>()
  for (const run of inView) {
    if (!run.groupId) continue
    const members = byGroup.get(run.groupId)
    if (members) members.push(run)
    else byGroup.set(run.groupId, [run])
  }
  return [...byGroup.entries()].flatMap(([groupId, members]) => {
    const first = members[0]
    if (!first || members.length < 2) return []
    if (!members.every((member) => TERMINAL_STATUSES.has(member.status))) return []
    return [{ groupId, title: groupTitle(first), count: members.length }]
  })
}
