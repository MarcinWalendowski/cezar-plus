import {
  BellIcon,
  BookmarkIcon,
  BotIcon,
  FileCogIcon,
  FolderGit2Icon,
  FoldersIcon,
  GaugeIcon,
  HardDriveIcon,
  IdCardIcon,
  LogOutIcon,
  KeyboardIcon,
  NetworkIcon,
  NotebookPenIcon,
  PaletteIcon,
  PlugZapIcon,
  SlidersHorizontalIcon,
  UnplugIcon,
  UsersIcon,
} from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

import type { Capabilities } from '@loki-labs/cezar-plus-api-client'
import { CenteredState } from '@/components/centered-state'
import { AccountSection } from './account-section'
import { AccountsSection } from './accounts-section'
import { AgentConfigSection } from './agent-config-section'
import { BackupSection } from './backup-section'
import { AgentsSection } from './agents-section'
import { AppearanceSection } from './appearance'
import { BookmarkletsSection } from './bookmarklets-section'
// Multi-node cluster (`.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, phase 1b): the fleet
// panel. Declared here and nowhere else — see this file's own docblock.
import { ClusterSection } from './cluster-section'
import { NotificationsSection } from './notifications-section'
import { ProjectGeneralSection } from './project-general'
import { ProjectsSection } from './projects-section'
import { PromptTemplatesSection } from './prompt-templates-section'
import { ProvidersSection } from './provider-settings'
import { ResourcesSection } from './resources-section'
// Central-hub scaffold (`.ai/runs/2026-08-06-cezar-central-hub/PLAN.md`, F2): a placeholder the
// scaffold creates so this registry is edited exactly once — see the file's own docblock. W4.8
// takes over and fills it.
import { SourcesSection } from './sources-section'
import { TeamsSection } from './teams-section'
import { WorktreesSection } from './worktrees-section'

/**
 * The Settings section registry (R6 Step 1.3, spec §"Settings"): the ONE place a section is
 * declared. The shell renders the section nav and the routes from this list, so adding a
 * section later is one entry here — no layout work, no route wiring.
 *
 * **Scope is a FIELD now, not a PLACE** (`.ai/specs/2026-08-21-one-settings-area.md`). Between the
 * multi-project split (step 3.5) and that spec there were TWO settings areas — `/p/<id>/settings/*`
 * and `/settings/global/*` — rendered by the same shell and kept apart by one `section.scope ===
 * scope` clause in the filter below. Six sections existed only in one, eight only in the other, and
 * the sidebar's Settings row pointed at the global one, so half of Settings was unreachable from
 * the address a user was sent to. There is one area now, `/settings`, listing every section.
 *
 * What survives of the old split is the honest half of it: `appliesTo` says whether a section's
 * value describes the PERSON/MACHINE (one answer, always) or a PROJECT (one answer per repo). A
 * `per-project` section renders a project selector in its own header and defaults to *All
 * projects* — the machine tier.
 *
 * `hidden` sections are declared but not routed and not listed: keyboard remains a later
 * phase; MCP now lives inside Agent config as a per-agent subsection.
 */

export type SettingsSectionId =
  | 'project'
  | 'bookmarklets'
  | 'appearance'
  | 'account'
  | 'accounts'
  | 'agents'
  | 'agent-config'
  | 'providers'
  | 'resources'
  | 'worktrees'
  | 'projects'
  | 'notifications'
  | 'prompt-templates'
  | 'keyboard'
  | 'sources'
  | 'teams'
  | 'backup'
  | 'cluster'

/**
 * Who a section's value belongs to — and therefore which store it writes.
 *
 * `workspace`: one answer for this machine/person, written to `~/.cezar/*`. No project involved.
 * `per-project`: one answer per repo. The section gets a project selector; *All projects* edits
 * the machine tier where one exists (`machineTier` below) and otherwise asks for a project.
 */
export type SettingsAppliesTo = 'workspace' | 'per-project'

/**
 * What the shell hands every section.
 *
 * `capabilities` is threaded rather than re-read with `useHealth()` inside the section, and that
 * is load-bearing since `.ai/specs/2026-08-21-one-settings-area.md`: a `per-project` section
 * renders under a scope provider, and `queryKeys.health` is scope-led, so a section reading health
 * for itself would look it up under the SELECTED project's cache key. Capabilities are the
 * machine's, not any project's. The shell reads them once, outside every scope.
 *
 * Optional, and every prop optional, so a section that needs none stays a zero-argument component.
 */
export interface SettingsSectionProps {
  capabilities?: SettingsCapabilities
}

export interface SettingsSection {
  id: SettingsSectionId
  title: string
  /** The one-liner under the title — the shell's desktop header and the index cards share it. */
  description: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
  component: ComponentType<SettingsSectionProps>
  /** Whose setting this is. Every section routes at `/settings/<id>` either way. */
  appliesTo: SettingsAppliesTo
  /**
   * `per-project` only: this section can answer for *All projects* too, because the settings it
   * edits have a machine tier (`projectDefaults` in `~/.cezar/config.json`). Without it, *All
   * projects* renders the "pick a project" state instead of a control that would have nothing
   * true to write — `baseBranch`, a checkout's worktrees and an agent's config FILES have no
   * global answer, and pretending otherwise is the one thing this area must not do.
   */
  machineTier?: boolean
  /** Declared but not yet implemented: no nav entry, no route (the URL is honestly a 404). */
  hidden?: boolean
  /** Central-hub scaffold gate (D19): the section drops out of the nav and the route list
   *  exactly like `hidden`, but the condition is a live capability rather than a permanent
   *  build-time flag — flipping `CEZ_SOURCES=1` reveals it without a code change.
   *
   *  `'cluster'` joined it 2026-08-22 (`CEZ_CLUSTER=1`). It drops BOTH the nav entry and the
   *  route, which is the half worth stating: the spec's Verification 12 asserts `/settings/cluster`
   *  is a 404 with the flag off, not merely that the nav is empty — a test that checked only the
   *  nav would pass against a reachable orphan route. */
  capability?: 'sources' | 'cluster'
}

/**
 * Exactly the capability keys the filter below reads, named once so the shell that forwards
 * them cannot fall behind this list — adding a `capability` to a section widens this alias and
 * every prop typed with it, instead of leaving `settings-shell.tsx` passing a narrower `Pick`
 * that no longer satisfies the filter.
 */
export type SettingsCapabilities = Pick<Capabilities, 'singleProject' | 'sources' | 'cluster'>

/** A registry entry whose real section arrives in a later Step — routable, honest about it. */
function comingSoon(title: string, Icon: ComponentType<SVGProps<SVGSVGElement>>): ComponentType {
  return function ComingSoonSection() {
    return (
      <CenteredState
        icon={<Icon />}
        tone="neutral"
        title={title}
        subtitle="This section arrives in a later phase of the redesign."
        heading="h2"
      />
    )
  }
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  // ONE list, one nav, one set of URLs. `appliesTo` is a property of the SETTING, not of the
  // page it is on — see the header comment. Order is the reading order of the single nav:
  // the project and its agents first (what a user came here to change), then the machine.
  {
    // The ex-"General" pane (`project-general.tsx`), promoted from a shell special case to a real
    // registry entry so it is in the nav like everything else. It was mounted directly by
    // `SettingsIndexRoute`, which meant the project folder, the registry facts, `Max parallel
    // tasks` and Remove were reachable only by landing on the project area's index — the one page
    // the sidebar's Settings row did not go to.
    id: 'project',
    title: 'Project',
    description: 'Where this checkout lives, what the registry knows, and how to remove it.',
    icon: SlidersHorizontalIcon,
    component: ProjectGeneralSection,
    appliesTo: 'per-project',
  },
  {
    id: 'agents',
    title: 'Agents',
    description: 'Default runner, models and system prompt.',
    icon: BotIcon,
    component: AgentsSection,
    appliesTo: 'per-project',
    // The four keys `projectDefaults` covers (spec Phase 3): systemPrompt, liveTitleUpdates,
    // reviewGate, stepBudget. `baseBranch` stays repo-only and says so in its own field.
    machineTier: true,
  },
  {
    // Lifted OUT of the Agents pane (spec Phase 2). Its switch drives
    // `PUT /api/v1/providers/:provider/enabled`, which writes `disabledProviders` in the WORKSPACE
    // config — a host-wide toggle that was reachable only through one arbitrary project's URL.
    id: 'providers',
    title: 'Providers',
    description: 'Which coding agents this machine may use, and whether they are signed in.',
    icon: UnplugIcon,
    component: ProvidersSection,
    appliesTo: 'workspace',
  },
  {
    id: 'agent-config',
    title: 'Agent config',
    description: 'Edit the coding agents’ own config files, per scope.',
    icon: FileCogIcon,
    component: AgentConfigSection,
    appliesTo: 'per-project',
  },
  {
    id: 'worktrees',
    title: 'Worktrees',
    description: 'How many finished task worktrees this project keeps on disk.',
    icon: FolderGit2Icon,
    component: WorktreesSection,
    appliesTo: 'per-project',
  },
  {
    id: 'bookmarklets',
    title: 'Bookmarklets',
    description: 'Launch skills from a GitHub PR or issue.',
    icon: BookmarkIcon,
    component: BookmarkletsSection,
    appliesTo: 'per-project',
  },
  {
    id: 'prompt-templates',
    title: 'Prompt templates',
    description: 'Reusable snippets for follow-up instructions.',
    icon: NotebookPenIcon,
    component: PromptTemplatesSection,
    appliesTo: 'per-project',
  },
  {
    id: 'sources',
    title: 'Sources',
    description: 'Mirror an external source — Notion first — into the knowledge base.',
    icon: PlugZapIcon,
    component: SourcesSection,
    appliesTo: 'per-project',
    capability: 'sources',
  },
  // ---- the person and the machine, in mockup order ----------------------------------------
  {
    id: 'appearance',
    title: 'Appearance',
    description: 'Theme, accent and density.',
    icon: PaletteIcon,
    component: AppearanceSection,
    appliesTo: 'workspace',
  },
  {
    id: 'notifications',
    title: 'Notifications',
    description: 'Browser notifications when an agent needs you.',
    icon: BellIcon,
    component: NotificationsSection,
    appliesTo: 'workspace',
  },
  {
    id: 'resources',
    title: 'Resources',
    description: 'Parallel tasks and per-task memory limit, across every project.',
    icon: GaugeIcon,
    component: ResourcesSection,
    appliesTo: 'workspace',
  },
  {
    id: 'accounts',
    title: 'Agent accounts',
    description: 'Second logins, and the agent and models a project uses when it has chosen none.',
    icon: IdCardIcon,
    component: AccountsSection,
    appliesTo: 'workspace',
  },
  {
    id: 'projects',
    title: 'Projects',
    description: 'The workspace registry and where GitHub checkouts land.',
    icon: FoldersIcon,
    component: ProjectsSection,
    appliesTo: 'workspace',
  },
  {
    // D13: the owner's word for this is "Workspace" (UI label only — see `teams-section.tsx`'s
    // own doc comment). `id`/`component` stay `teams`/`TeamsSection`: no identifier renamed.
    id: 'teams',
    title: 'Workspaces',
    description: 'Create and rename the workspaces your projects are grouped under.',
    icon: UsersIcon,
    component: TeamsSection,
    appliesTo: 'workspace',
  },
  {
    // D14 (`.ai/specs/2026-08-06-org-team-auth-onboarding.md`): `POST /auth/logout` has existed
    // since phase 3 with no caller in the cockpit. Declared unconditionally, like `teams` above —
    // see `account-section.tsx`'s own doc comment for why visibility lives in the panel (an async
    // probe against `/auth/me`) rather than a registry-level `capability` gate: `capabilitiesSchema`
    // deliberately has no `auth` key.
    id: 'account',
    title: 'Account',
    description: 'Sign out of this cezar-plus deployment.',
    icon: LogOutIcon,
    component: AccountSection,
    appliesTo: 'workspace',
  },
  {
    // Backup (spec `.ai/specs/2026-08-16-provider-agnostic-platform-backup.md`, `CEZ_BACKUP=1`).
    // Registered UNCONDITIONALLY with no `capability:` field, on the `account` precedent above:
    // `capabilitiesSchema` deliberately carries no `backup` key (byte-identical health), so there
    // is no synchronous signal a registry gate could read. Visibility lives in the PANEL instead —
    // `backup-section.tsx` self-gates on `GET /api/v1/backup`'s `enabled` field, rendering a
    // "backups are off" state when `CEZ_BACKUP` is unset.
    id: 'backup',
    title: 'Backup',
    description: 'Encrypted, incremental backup of the platform corpus to S3 or a local disk.',
    icon: HardDriveIcon,
    component: BackupSection,
    appliesTo: 'workspace',
  },
  {
    // Multi-node cluster (`.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, phase 1b).
    // `workspace`, not `per-project`: a cluster is a property of this machine and the nodes it is
    // linked to, and its pairings are per project only INSIDE the panel — there is one answer to
    // "what is my fleet", never one per repo. Gated on `capability: 'cluster'` rather than
    // declared unconditionally like `backup`, because `capabilitiesSchema` DOES carry a `cluster`
    // key (see `server/capabilities.ts#clusterEnabled` for why that differs from backup's
    // deliberate absence), so there is a synchronous signal this gate can read.
    id: 'cluster',
    title: 'Cluster',
    description: 'The nodes this cockpit is linked to, what they can run, and how to add one.',
    icon: NetworkIcon,
    component: ClusterSection,
    appliesTo: 'workspace',
    capability: 'cluster',
  },
  {
    id: 'keyboard',
    title: 'Keyboard',
    description: 'Shortcuts.',
    icon: KeyboardIcon,
    component: comingSoon('Keyboard', KeyboardIcon),
    appliesTo: 'workspace',
    hidden: true,
  },
]

/**
 * What the Settings nav and route table actually show — hidden sections drop out, and so does
 * anything whose capability is off.
 *
 * There is deliberately no `scope` argument any more. It used to be the first parameter and the
 * only thing keeping two settings areas apart; splitting one registry by it is what made half the
 * sections unreachable from the address the sidebar pointed at
 * (`.ai/specs/2026-08-21-one-settings-area.md`).
 */
export function visibleSettingsSections(capabilities?: SettingsCapabilities): SettingsSection[] {
  return SETTINGS_SECTIONS.filter(
    (section) =>
      !section.hidden &&
      !(capabilities?.singleProject === true && section.id === 'projects') &&
      // Central-hub scaffold (D19): a section naming a capability stays out of the nav and the
      // route list until that capability answers `true` — unknown health (capabilities
      // undefined) reads as off, same as every other gate here.
      (section.capability === undefined || capabilities?.[section.capability] === true),
  )
}
