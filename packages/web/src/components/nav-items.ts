import {
  BookOpenIcon,
  GitBranchIcon,
  NotebookPenIcon,
  InboxIcon,
  ListChecksIcon,
  SettingsIcon,
  SparklesIcon,
  ZapIcon,
} from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

export type NavItem = {
  /** Where the item navigates. Also its identity — `activeNavPath` returns this. */
  to: string
  label: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
  /** Path prefixes that light this item up. See `activeNavPath` for the longest-prefix rule. */
  match: string[]
  /** Optional trailing status affordance. Rendering/data stay with the shell. */
  badge?: 'inbox-count' | 'tasks-unread'
  /** Forge-gated (R6 Step 1.1): the item exists only while `/api/health` reports the forge
   *  driver available — see `visibleNavItems`. */
  forge?: boolean
  /** Inbox-gated (#471): the item exists only while `/api/health` reports
   *  `capabilities.followups` — the global inbox is opt-in via `CEZ_FOLLOWUPS=1`.
   *  See `visibleNavItems`. */
  inbox?: boolean
  /** Knowledge-gated (central-hub scaffold F1): the item exists only while `/api/health`
   *  reports `capabilities.knowledge` — opt-in via `CEZ_KB=1`. Project-scoped, like Git. */
  knowledge?: boolean
  /** Skills-gated: the item exists unless `/api/health` reports `capabilities.skills === false`
   *  (`CEZ_SKILLS=0`). Note the polarity — every other gate here is opt-IN and this one is
   *  opt-OUT, because Skills predates the capability payload and absent must keep meaning on.
   *  See `visibleNavItems`.
   *
   *  **The Skills item carries it again** — hidden 2026-08-14, RESTORED 2026-08-17 (owner
   *  decision; see `NAV_ITEMS`), so `CEZ_SKILLS=0` once more hides the item on an install that set
   *  the flag. `capabilities.skills` is upstream's, still computed from `CEZ_SKILLS`
   *  (`server/capabilities.ts`), and this gate is the only thing that reads it. */
  skills?: boolean
  /** Notes-gated (`.ai/specs/2026-08-14-note-to-spec-pipeline.md`): the item exists only while
   *  `/api/health` reports `capabilities.notes` — opt-in via `CEZ_NOTES=1`. */
  notes?: boolean
  /** Renders ONCE in the shell's top-level nav rather than inside each project group, and never
   *  receives `scopeTo` (`.ai/specs/2026-08-06-workspace-notes-cross-project.md` "Nav"): a
   *  workspace item has no project to scope into. `ProjectGroups` filters these out of its
   *  per-project loop; the flat single-project sidebar renders every visible item, this one
   *  included, since there is only ever one group to render it in.
   *
   *  Notes carries it, and must: a note is workspace-scoped (PLAN D14) precisely because it has
   *  not been assigned to a repo yet, so rendering it per project would ask the user to pick the
   *  thing the note exists to defer.
   *
   *  Reads as "an item whose workspace destination is its ONLY destination" — the exclusive case
   *  of `workspaceTo` below, which is why an item carrying this must also carry that. */
  workspace?: boolean
  /** Where this item points when rendered in the shell's **workspace-level** nav — the band above
   *  the project groups (`.ai/specs/2026-08-14-workspace-level-navigation.md` D1).
   *
   *  An item appears in that band **iff** it has one, which is the whole gate: `Tasks` answers
   *  across every project at `/tasks` and inside one at `/p/:id/`, so it carries both `to` and
   *  this. `Git` carries both too as of `.ai/specs/2026-08-14-cross-project-git-overview.md`
   *  (Phase 2) — `/workspace/git`, its own cross-project page, not a scoped `/git` reused.
   *  `Knowledge` joined them via `.ai/specs/2026-08-14-knowledge-domains-and-changelog.md`
   *  (Phase 3) — `/workspace/knowledge`, still gated behind `knowledge` below (an item with no
   *  cross-project page at all would carry only `to`, the way this one used to).
   *
   *  Never derived from `to` — `/settings` scoped is a project's settings, and the workspace
   *  answer is `/settings/global`, a different route with a different scope provider. The two
   *  destinations are related by meaning, not by string. */
  workspaceTo?: string
  /** Automations-gated (#801): the item exists only while `/api/health` reports
   *  `capabilities.automations` — GitHub automations are opt-in via `CEZ_AUTOMATIONS=1`.
   *  Independent of `forge`: the Automations item carries BOTH, because the feature needs a
   *  forge to poll AND the operator's opt-in to exist at all. See `visibleNavItems`. */
  automations?: boolean
}

/** The sidebar nav from the spec's "App shell & navigation" section, in mockup order.
 *
 *  `match` exists because a nav item is active for a whole *area*, not just its own URL:
 *  the spec requires Tasks to stay active while a task thread (`/tasks/:id`) or a variant
 *  compare (`/compare/:groupId`) is open.
 *
 *  **GitHub and Workflows are hidden in this fork (owner decision, 2026-08-14).** Nav items only:
 *  `/github` and `/workflows` still render for anyone who types the URL, every route and every
 *  server surface behind them is untouched, and restoring one is putting its line back here — that
 *  is why the `forge` gate below survives with no item carrying it. **Skills was hidden the same
 *  day but RESTORED 2026-08-17** for the self-hosted deployment (workspace-level skills are used
 *  there); it carries the `skills` gate again, so `CEZ_SKILLS=0` hides it — see `NavItem.skills`.
 */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Tasks', icon: ListChecksIcon, match: ['/', '/tasks', '/compare'], badge: 'tasks-unread', workspaceTo: '/tasks' },
  { to: '/inbox', label: 'Inbox', icon: InboxIcon, match: ['/inbox'], badge: 'inbox-count', inbox: true },
  { to: '/git', label: 'Git', icon: GitBranchIcon, match: ['/git'], workspaceTo: '/workspace/git' },
  { to: '/automations', label: 'Automations', icon: ZapIcon, match: ['/automations'], forge: true, automations: true },
  { to: '/knowledge', label: 'Knowledge', icon: BookOpenIcon, match: ['/knowledge'], knowledge: true, workspaceTo: '/workspace/knowledge' },
  // Pinned to the workspace band too (owner request 2026-08-17): `workspaceTo: '/skills'` reuses the
  // flat -> boot-project redirect (`LegacyPathRedirect`, routes.tsx) instead of a dedicated
  // `/workspace/skills` route, so the band row lands on the boot project's skills. Still
  // project-scoped, so it ALSO renders inside each project group via `to` (no `workspace: true`).
  { to: '/skills', label: 'Skills', icon: SparklesIcon, match: ['/skills'], skills: true, workspaceTo: '/skills' },
  { to: '/notes', label: 'Notes', icon: NotebookPenIcon, match: ['/notes'], notes: true, workspace: true, workspaceTo: '/notes' },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, match: ['/settings'], workspaceTo: '/settings/global' },
]

/**
 * The items the shell's **workspace-level** band renders, above the project groups — the gated
 * list filtered to those with a workspace destination (`workspaceTo`, D1).
 *
 * Deliberately the same `visibleNavItems` output the per-project groups and the ⌘K palette read,
 * not a second hand-kept list: two lists over one concept drift, and this nav has already been
 * bitten by one concept enforced in two places. A capability that hides an item hides it in both
 * bands for free.
 *
 * `Git` joined this band in Phase 2 of `.ai/specs/2026-08-14-cross-project-git-overview.md`.
 * `Knowledge` joined it in Phase 3 of `.ai/specs/2026-08-14-knowledge-domains-and-changelog.md` —
 * still gated on `capabilities.knowledge` like its per-project item, so it renders here only when
 * that flag is on, unlike `Git`, which needs nothing turned on. See `NavItem.workspaceTo`.
 */
export function workspaceNavItems(availability: NavAvailability = {}): NavItem[] {
  return visibleNavItems(availability).filter((item) => item.workspaceTo !== undefined)
}

/** What `/api/health` says exists. All default to `false` — see `visibleNavItems`. */
export type NavAvailability = {
  /** `forge.available` (spec §"GitHub tab (forge tab)"). */
  forge?: boolean
  /** `capabilities.followups` — the opt-in global inbox (#471). */
  inbox?: boolean
  /** `capabilities.knowledge` — the opt-in knowledge base (central-hub scaffold F1, `CEZ_KB=1`). */
  knowledge?: boolean
  /** `capabilities.skills` — the opt-OUT Skills surface (`CEZ_SKILLS=0` hides it). Defaults to
   *  `true` here, the opposite of every field above, for the same reason the capability itself is
   *  inverted: Skills predates this key, so an install that has never heard of it must keep the
   *  tab. Defaulting it to `false` would make the tab vanish for the moment before health lands,
   *  which is a visible regression for the majority of installs that never set the flag. */
  skills?: boolean
  /** `capabilities.automations` — the opt-in GitHub automations (#801). */
  automations?: boolean
  /** `capabilities.notes` — the opt-in capture inbox (`CEZ_NOTES=1`). */
  notes?: boolean
}

/**
 * The nav items a surface should actually render: a gated item drops out — nav item AND tab —
 * unless the health payload says its feature is there. The forge-gated GitHub item needs the
 * forge driver (spec §"GitHub tab (forge tab)"); the Inbox item needs `capabilities.followups`,
 * which is off unless `CEZ_FOLLOWUPS=1` (#471); the Automations item needs a forge AND
 * `capabilities.automations`, which is off unless `CEZ_AUTOMATIONS=1` (#801).
 *
 * Gates are ANDed per item, never ORed, which is what lets one item carry two of them: an
 * automations opt-in on a repo with no GitHub remote still has nothing to poll.
 *
 * Everything defaults to absent while health is still unknown, on the shell's honesty rule: the
 * nav must not claim a tab exists before the server has said so (the Tools menu's forge note
 * explains the GitHub absence). Both the sidebar and the ⌘K palette's Views group render through
 * this, so the two can never disagree.
 */
export function visibleNavItems({
  forge = false,
  inbox = false,
  knowledge = false,
  skills = true,
  automations = false,
  notes = false,
}: NavAvailability = {}): NavItem[] {
  return NAV_ITEMS.filter(
    (item) =>
      (item.forge ? forge : true) &&
      (item.inbox ? inbox : true) &&
      (item.knowledge ? knowledge : true) &&
      // `skills` defaults TRUE (see `NavAvailability`), so this line reads the same as the
      // three above while meaning the opposite: it removes the item only on an explicit
      // `skills: false` from health.
      (item.skills ? skills : true) &&
      (item.automations ? automations : true) &&
      (item.notes ? notes : true),
  )
}

/** Does `pathname` sit inside the area rooted at `prefix`?
 *
 *  Segment-aware on purpose: a plain `startsWith` would make `/git` match `/github`, and
 *  would make the `/` root match literally every route.
 */
function inArea(pathname: string, prefix: string): boolean {
  if (prefix === '/') return pathname === '/'
  return pathname === prefix || pathname.startsWith(prefix + '/')
}

/**
 * The `to` of the nav item that owns `pathname`, or null when no item does (e.g. `/new`,
 * which is a full-screen surface with no nav home).
 *
 * Longest matching prefix wins, which is what disambiguates nested areas: the `/` root only
 * matches the exact path (see `inArea`), so every deeper route falls to its own item —
 * `/settings/agents` lights Settings, `/git/commits` lights Git.
 */
export function activeNavPath(pathname: string): string | null {
  let best: { to: string; length: number } | null = null
  for (const item of NAV_ITEMS) {
    for (const prefix of item.match) {
      if (inArea(pathname, prefix) && (best === null || prefix.length > best.length)) {
        best = { to: item.to, length: prefix.length }
      }
    }
  }
  return best?.to ?? null
}

/**
 * The `workspaceTo` of the workspace-level item that owns `pathname`, or null when none does
 * (D5).
 *
 * **Pass the RAW pathname, never `stripProjectPrefix`'d.** That single choice is what makes this
 * scope-aware, and it is the whole mechanism: every workspace route (`/tasks`, `/notes`,
 * `/settings/global`) sits outside `/p/:id` by construction, so a path inside a project scope
 * matches none of them and falls out as null on its own. Hand it the stripped path and
 * `/p/shop/notes` becomes `/notes`, which lights the workspace Notes row while the user is
 * standing inside one project — the exact confusion the two bands exist to avoid.
 *
 * An explicit `startsWith('/p/')` guard was written here first and then removed: with the raw
 * path it can never fire, so it read as the safety net while the argument was doing the work.
 * The test that pins this renders at `/p/shop/notes`.
 *
 * Longest matching prefix wins, as in `activeNavPath`, so `/settings/global/appearance` lights
 * Settings rather than falling through.
 */
export function activeWorkspaceNavPath(pathname: string): string | null {
  let best: { to: string; length: number } | null = null
  for (const item of NAV_ITEMS) {
    const target = item.workspaceTo
    if (target === undefined) continue
    if (inArea(pathname, target) && (best === null || target.length > best.length)) {
      best = { to: target, length: target.length }
    }
  }
  return best?.to ?? null
}

/** The nav item that owns `pathname` — the mobile top bar titles itself from this. */
export function activeNavItem(pathname: string): NavItem | null {
  const to = activeNavPath(pathname)
  return NAV_ITEMS.find((item) => item.to === to) ?? null
}
