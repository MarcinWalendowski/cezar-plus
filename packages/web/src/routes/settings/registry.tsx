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
  NotebookPenIcon,
  PaletteIcon,
  PlugZapIcon,
  UsersIcon,
} from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

import type { Capabilities } from '@loki-labs/better-cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { AccountSection } from './account-section'
import { AccountsSection } from './accounts-section'
import { AgentConfigSection } from './agent-config-section'
import { BackupSection } from './backup-section'
import { AgentsSection } from './agents-section'
import { AppearanceSection } from './appearance'
import { BookmarkletsSection } from './bookmarklets-section'
import { NotificationsSection } from './notifications-section'
import { ProjectsSection } from './projects-section'
import { PromptTemplatesSection } from './prompt-templates-section'
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
 * Since the multi-project split (step 3.5, spec §"Settings split") every entry also declares
 * its `scope`, and that single field decides everything downstream — which URL the section
 * lives at (`/p/<id>/settings/<id>` vs `/settings/global/<id>`), which nav lists it, and which
 * store it writes. The rule of thumb: does the setting describe THIS REPO (agents, worktrees,
 * bookmarklets, prompt templates) or the person/machine (appearance, notifications, host
 * resources, the project registry)?
 *
 * `hidden` sections are declared but not routed and not listed: keyboard remains a later
 * phase; MCP now lives inside Agent config as a per-agent subsection.
 */

export type SettingsSectionId =
  | 'bookmarklets'
  | 'appearance'
  | 'account'
  | 'accounts'
  | 'agents'
  | 'agent-config'
  | 'resources'
  | 'worktrees'
  | 'projects'
  | 'notifications'
  | 'prompt-templates'
  | 'keyboard'
  | 'sources'
  | 'teams'
  | 'backup'

/** Which settings area a section belongs to — and therefore which store it writes. */
export type SettingsScope = 'project' | 'global'

export interface SettingsSection {
  id: SettingsSectionId
  title: string
  /** The one-liner under the title — the shell's desktop header and the index cards share it. */
  description: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
  component: ComponentType
  /** `project` → `/p/<projectId>/settings/<id>`, `global` → `/settings/global/<id>`. */
  scope: SettingsScope
  /** Declared but not yet implemented: no nav entry, no route (the URL is honestly a 404). */
  hidden?: boolean
  /** Central-hub scaffold gate (D19): the section drops out of the nav and the route list
   *  exactly like `hidden`, but the condition is a live capability rather than a permanent
   *  build-time flag — flipping `CEZ_SOURCES=1` reveals it without a code change. */
  capability?: 'sources'
}

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
  // ---- project scope (`/p/<projectId>/settings/…`) — settings that describe THIS repo -------
  {
    id: 'agents',
    title: 'Agents',
    description: 'Default runner, models and system prompt.',
    icon: BotIcon,
    component: AgentsSection,
    scope: 'project',
  },
  {
    id: 'agent-config',
    title: 'Agent config',
    description: 'Edit the coding agents’ own config files, per scope.',
    icon: FileCogIcon,
    component: AgentConfigSection,
    scope: 'project',
  },
  {
    id: 'worktrees',
    title: 'Worktrees',
    description: 'How many finished task worktrees this project keeps on disk.',
    icon: FolderGit2Icon,
    component: WorktreesSection,
    scope: 'project',
  },
  {
    id: 'bookmarklets',
    title: 'Bookmarklets',
    description: 'Launch skills from a GitHub PR or issue.',
    icon: BookmarkIcon,
    component: BookmarkletsSection,
    scope: 'project',
  },
  {
    id: 'prompt-templates',
    title: 'Prompt templates',
    description: 'Reusable snippets for follow-up instructions.',
    icon: NotebookPenIcon,
    component: PromptTemplatesSection,
    scope: 'project',
  },
  {
    id: 'sources',
    title: 'Sources',
    description: 'Mirror an external source — Notion first — into the knowledge base.',
    icon: PlugZapIcon,
    component: SourcesSection,
    scope: 'project',
    capability: 'sources',
  },
  // ---- global scope (`/settings/global/…`) — the user and the machine, in mockup order -----
  {
    id: 'appearance',
    title: 'Appearance',
    description: 'Theme, accent and density.',
    icon: PaletteIcon,
    component: AppearanceSection,
    scope: 'global',
  },
  {
    id: 'notifications',
    title: 'Notifications',
    description: 'Browser notifications when an agent needs you.',
    icon: BellIcon,
    component: NotificationsSection,
    scope: 'global',
  },
  {
    id: 'resources',
    title: 'Resources',
    description: 'Parallel tasks and per-task memory limit, across every project.',
    icon: GaugeIcon,
    component: ResourcesSection,
    scope: 'global',
  },
  {
    id: 'accounts',
    title: 'Agent accounts',
    description: 'Second logins, and the agent and models a project uses when it has chosen none.',
    icon: IdCardIcon,
    component: AccountsSection,
    scope: 'global',
  },
  {
    id: 'projects',
    title: 'Projects',
    description: 'The workspace registry and where GitHub checkouts land.',
    icon: FoldersIcon,
    component: ProjectsSection,
    scope: 'global',
  },
  {
    // D13: the owner's word for this is "Workspace" (UI label only — see `teams-section.tsx`'s
    // own doc comment). `id`/`component` stay `teams`/`TeamsSection`: no identifier renamed.
    id: 'teams',
    title: 'Workspaces',
    description: 'Create and rename the workspaces your projects are grouped under.',
    icon: UsersIcon,
    component: TeamsSection,
    scope: 'global',
  },
  {
    // D14 (`.ai/specs/2026-08-06-org-team-auth-onboarding.md`): `POST /auth/logout` has existed
    // since phase 3 with no caller in the cockpit. Declared unconditionally, like `teams` above —
    // see `account-section.tsx`'s own doc comment for why visibility lives in the panel (an async
    // probe against `/auth/me`) rather than a registry-level `capability` gate: `capabilitiesSchema`
    // deliberately has no `auth` key.
    id: 'account',
    title: 'Account',
    description: 'Sign out of this cezar deployment.',
    icon: LogOutIcon,
    component: AccountSection,
    scope: 'global',
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
    scope: 'global',
  },
  {
    id: 'keyboard',
    title: 'Keyboard',
    description: 'Shortcuts.',
    icon: KeyboardIcon,
    component: comingSoon('Keyboard', KeyboardIcon),
    scope: 'global',
    hidden: true,
  },
]

/**
 * Exactly the capability keys the filter below reads, named once so the shell that forwards
 * them cannot fall behind this list — adding a `capability` to a section widens this alias and
 * every prop typed with it, instead of leaving `settings-shell.tsx` passing a narrower `Pick`
 * that no longer satisfies the filter.
 */
export type SettingsCapabilities = Pick<Capabilities, 'singleProject' | 'sources'>

/**
 * What one settings area's nav and route table actually show — hidden sections drop out
 * entirely, and so does everything belonging to the OTHER scope. The two areas are rendered by
 * the same shell, so this filter is the only thing keeping them apart.
 */
export function visibleSettingsSections(
  scope: SettingsScope,
  capabilities?: SettingsCapabilities,
): SettingsSection[] {
  return SETTINGS_SECTIONS.filter(
    (section) =>
      !section.hidden &&
      section.scope === scope &&
      !(capabilities?.singleProject === true && section.id === 'projects') &&
      // Central-hub scaffold (D19): a section naming a capability stays out of the nav and the
      // route list until that capability answers `true` — unknown health (capabilities
      // undefined) reads as off, same as every other gate here.
      (section.capability === undefined || capabilities?.[section.capability] === true),
  )
}
