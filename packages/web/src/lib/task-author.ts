import type { TaskAuthor } from '@loki-labs/cezar-plus-api-client'

/**
 * The pure half of the Author column (`.ai/specs/2026-08-21-task-author-provenance.md`, Phase 4):
 * turning a `TaskAuthor` into the two strings a surface paints — a short cell label and the full
 * sentence behind it — plus the facet key the board groups by.
 *
 * It sits beside `lib/global-tasks.ts` and `lib/filed-tasks.ts` rather than inside either, because
 * BOTH task-shaped records carry an author: a run row and a filed-todo row render the same cell
 * from the same object, and neither facet space owns it.
 *
 * Upstream purity, the same rule the two modules beside it keep: nothing here names a product, a
 * deployment or a person. `'local'` is the server's own word for an unauthenticated install (the
 * `approverOf` rule), not a user of this cockpit.
 */

/** What each surface is called in a sentence a human reads. Keyed by `TaskAuthor['via']`; the
 *  index signature keeps a NEWER server's `via` value renderable by an OLDER cockpit — the value
 *  itself is shown rather than a lie, which is the same choice {@link authorLabel} makes for an
 *  absent author. */
const VIA_PHRASE: Record<string, string> = {
  composer: 'the composer',
  'workspace-composer': 'the composer (workspace)',
  'todo-start': '▶ Run on a filed task',
  'todo-autostart': 'autostart',
  'cli-run': 'cezar run',
  'cli-todo-add': 'cezar todo add',
  'todo-create-route': 'the filed-task route',
  automation: 'a GitHub automation',
  'note-approval': 'an approved note',
  'note-continuation': 'the autonomous continuation',
  'report-triage': 'report triage',
}

export function viaPhrase(via: string): string {
  return VIA_PHRASE[via] ?? via
}

/** How the cockpit renders an author with no identity to show. Absent is NOT "system" and not
 *  "unknown user" — it means the record predates the field, and saying so is the whole value. */
export const UNATTRIBUTED_LABEL = '—'

/**
 * A short id for a cell. Run ids are UUIDs and the cockpit already reads them by their first
 * block everywhere else (`cez/<8>` branches, the `232ad6d4` in a worktree path), so this matches
 * what a person is already scanning for.
 */
export function shortTaskId(id: string): string {
  const head = id.split('-')[0] ?? id
  return head.slice(0, 8)
}

/**
 * The cell label. Deliberately short — this column is pinned narrow so the Task column keeps the
 * pixels (the rule the runs table's own header comment states).
 */
export function authorLabel(author: TaskAuthor | undefined): string {
  if (!author) return UNATTRIBUTED_LABEL
  switch (author.kind) {
    case 'user':
      return author.label ?? author.id
    case 'api':
      return 'API'
    case 'agent':
      // The parent task IS the author here, so the id is the label. `parentTaskId` is guaranteed
      // present for this kind by the schema's `.refine`, but an older/hand-edited record can
      // still reach the cockpit, so this does not assume it.
      return author.parentTaskId ? `⤷ ${shortTaskId(author.parentTaskId)}` : 'agent'
    case 'automation':
      return author.label ?? 'automation'
    case 'system':
      return 'cezar-plus'
    default:
      // A `kind` a newer server added. Show it rather than inventing a category for it.
      return author.kind
  }
}

/**
 * The full sentence — the cell's tooltip, and the run header's own line. Always names the surface,
 * because "who" without "through what" is the half of provenance that does not help triage.
 */
export function authorTitle(author: TaskAuthor | undefined): string {
  if (!author) return 'Unattributed — created before tasks recorded an author'
  const via = viaPhrase(author.via)
  switch (author.kind) {
    case 'user':
      return `Started by ${author.label ?? author.id} via ${via}`
    case 'api':
      return `Started by an API client via ${via}`
    case 'agent': {
      const parent = author.parentTaskId ? `task ${shortTaskId(author.parentTaskId)}` : 'another task'
      const session = author.agentSessionId ? `, session ${shortTaskId(author.agentSessionId)}` : ''
      const step = author.parentStepId ? ` (step ${author.parentStepId})` : ''
      return `Started by an agent in ${parent}${session}${step} via ${via}`
    }
    case 'automation':
      return `Started by ${author.label ?? `automation ${author.id}`} via ${via}`
    case 'system':
      return `Started by cezar-plus itself via ${via}`
    default:
      return `Started by ${author.id} via ${via}`
  }
}

/**
 * The key a board groups or filters by. Identity is folded in for the two kinds where distinct
 * actors matter (`user`, `automation`) and dropped for the rest, where the KIND is the answer —
 * grouping agent-spawned tasks by their parent would make one bucket per parent and defeat the
 * question the facet exists to answer ("what made these?").
 */
export function authorFacet(author: TaskAuthor | undefined): string {
  if (!author) return 'unattributed'
  if (author.kind === 'user') return `user:${author.id}`
  if (author.kind === 'automation') return `automation:${author.id}`
  return author.kind
}

/** The facet key rendered for a filter control. */
export function authorFacetLabel(facet: string): string {
  if (facet === 'unattributed') return UNATTRIBUTED_LABEL
  if (facet === 'api') return 'API'
  if (facet === 'agent') return 'Agent'
  if (facet === 'system') return 'cezar-plus'
  const [kind, ...rest] = facet.split(':')
  const id = rest.join(':')
  if (kind === 'user') return id
  if (kind === 'automation') return id
  return facet
}
