# One Settings area — the scope split becomes a field, not a place

**Status: IMPLEMENTED 2026-08-21 — all four phases. Shipped as `00f3669f` on `origin/main`
(merged forward as `479f54b5`). QA NEEDED — the live runtime e2e in §Verification has NOT been
run, so the UI is not verified; see §Status log.** Written in the `spec` step of the
`spec-to-deploy` run for task `50ce87f1-3cc6-4934-a66c-d9cb5630248f`, built in the `implement`
step, gated in `run-tests`, shipped in `commit-push`, and recorded in `document` — all of the same
run.

**Divergences from the design below, all deliberate:**

1. **Addressing the selected project.** The Architecture table promised "a thin helper" to build a
   scoped URL from an explicit id. What shipped is smaller: `SettingsSectionRoute` mounts a
   `ProjectScopeProvider` around a `per-project` section's body — the same provider `/p/:projectId`
   already mounts. Every existing hook (`useConfig`, `useRepo`, `useActiveProjectId`, the account
   selector) then addresses `/api/v1/p/<selected>/…` and caches under that project's query keys,
   unchanged. A URL helper would have needed an explicit-id variant of a dozen query hooks; this
   needed none, and it is the seam the codebase already has.
2. **Capabilities are threaded, not re-read.** A consequence of (1): `queryKeys.health` is
   scope-led, so a section calling `useHealth()` from inside the provider would look the MACHINE's
   capabilities up under a PROJECT's cache key. `SettingsSection.component` therefore takes an
   optional `capabilities` prop, which the shell (outside every scope) supplies.
3. **`project` with *All projects*** renders the "pick a project" state — which lists the
   registered projects as pickable rows — rather than the registry table §Solution 4 suggested.
   The registry table already exists as its own section (`projects`); rendering it twice under two
   names is the duplication this spec exists to remove.
4. **`stepBudget` gets the machine tier but no control.** It has no repo-level editor either (it is
   a hand-edited `.ai/cezar/config.json` key), so `projectDefaults.stepBudget` keeps parity: the
   mechanism is complete, the surface is unchanged.
5. **One extra fix, in scope by necessity.** The flat single-project sidebar routed `workspace:
   true` nav items through the project-scoping `Link`. Settings now carries that flag, so the row
   would have minted `/p/<id>/settings`. Those items render through react-router's own `Link` now —
   which also fixes the same latent bug for Notes, whose `/p/<id>/notes` was never a route at all.

**Owner:** Marcin Walendowski
**Reported as:** *"There should be only one global Settings — we don't need to have setting per
project. Right now I can't access some settings or I don't see all settings in
https://cockpit.example.com/settings/global — e.g. I don't see some options that are available in
project settings or workspace settings."*

**Related records read before writing this**

- `.ai/specs/2026-08-14-workspace-level-navigation.md` — the spec that put a workspace band in the
  sidebar and pointed its Settings row at `/settings/global`.
- `BACKWARD_COMPATIBILITY.md` §2 (`:~122`, *"Settings split, old URLs kept"*), §2 (`:~60`, the
  `maxParallel`/`memoryLimitMb` globalization precedent), §3 (`.ai/cezar/` state files), §9
  (`~/.cezar/` shared by every cezar on the machine).
- `AGENTS.md:16` (zero config), `AGENTS.md:52` (*never trade a working default for a knob*),
  `AGENTS.md:12` (deploy mechanics: web-only swaps live, backend needs the restart).
- KB: `notion-bc7bc9a5357f` — *Restructure the cockpit sidebar: workspace-level Tasks / Git /
  Knowledge / Settings above Projects* (Phase 1 shipped `c1f6b1a2`; it is the change that made
  `/settings/global` the sidebar's Settings destination). `notion-629f5ab2b383` — the same work
  from the "two invisible features made reachable" angle. `notion-c35ee5ebdd4d` — *Reports is one
  workspace queue, not one per project*, the closest precedent for moving a surface from project
  scope to workspace scope and the reasoning used to justify it.
- **Not found, stated rather than invented:** no KB entry proposes, forbids, or previously decided
  a single Settings area. Searched `cez kb search` for `"settings scope project global split
  cockpit"` (546 lexical hits), `"global settings page one settings"` (1439), `"config precedence
  project workspace global"` (398), `"settings page UI"` (652) — every top hit is the sidebar
  restructure, the Open Mercato removal, or an unrelated product's settings screen. `cezar todo
  list` → `no todos filed`, so nothing is in flight on this. The spec directory has **no number
  allocator** (`scripts/` holds only `dev.mjs`, `release.mjs`, `release-snapshot.mjs`) and its
  files are date-named, so this one is dated, not numbered.

## TLDR

The cockpit has **two** Settings areas rendered by the same shell and kept apart by exactly one
line of filtering — `visibleSettingsSections(scope, capabilities)` at
`packages/web/src/routes/settings/registry.tsx:261-275`, whose own doc comment admits *"The two
areas are rendered by the same shell, so this filter is the only thing keeping them apart."*
Six sections exist only at `/p/<id>/settings/<section>`; eight exist only at
`/settings/global/<section>`. The sidebar's workspace Settings row points at the global one
(`packages/web/src/components/nav-items.ts:131`, `workspaceTo: '/settings/global'`), so from the
address the report names, six sections are simply not there — including the one that turns
providers on and off.

This spec makes `/settings` the single Settings area holding all fourteen sections. Scope stops
being a **place** (which URL you are at) and becomes a **field** (which projects a value applies
to, chosen in the section header). Nothing is deleted from disk: `.ai/cezar/config.json` remains
the repo's file and `~/.cezar/config.json` remains the machine's, exactly as
`packages/cezar/src/workspace/config.ts:136-141` argues (*"The repo config is the team's; this is
yours"*). What changes is that the one page edits the **machine tier by default** and touches a
repo file only when the user explicitly asks for a per-project override.

## Problem

### 1. Half the settings are unreachable from the Settings the sidebar points at

`SETTINGS_SECTIONS` (`registry.tsx:108-246`) declares fifteen sections with a hard `scope` field
(`registry.tsx:74`: `export type SettingsScope = 'project' | 'global'`). The routes are generated
per scope in two separate blocks of `packages/web/src/routes.tsx` — project at `:648-656`, global
at `:680-687`:

| Only at `/p/<id>/settings/…` | Only at `/settings/global/…` |
|---|---|
| `agents` (`registry.tsx:110`) | `appearance` (`:160`) |
| `agent-config` (`:118`) | `notifications` (`:168`) |
| `worktrees` (`:126`) | `resources` (`:176`) |
| `bookmarklets` (`:134`) | `accounts` (`:184`) |
| `prompt-templates` (`:142`) | `projects` (`:192`) |
| `sources` (`:150`, gated `CEZ_SOURCES=1`) | `teams` (`:200`), `account` (`:210`), `backup` (`:223`) |

Plus a project **General** pane that is not a registry section at all — it is mounted directly by
the shell at `packages/web/src/routes/settings/settings-shell.tsx:232` and holds `Project folder`
(`project-location.tsx:50`), the registry `<dl>` (`project-general.tsx:116`), `Max parallel tasks`
(`project-general.tsx:88`) and `Remove from workspace` (`project-general.tsx:184`).

So from `/settings/global` there is no route, no nav entry and no cross-link to: the system
prompt, per-runner default models, live title updates, the review gate, the base branch, the agent
config-file editor, worktree retention and the on-disk worktree list, bookmarklets, prompt
templates, or sources. The one cross-link that exists points the **wrong way** — project index →
global (`settings-shell.tsx:269`, `data-slot="settings-global-link"`). That is the report,
verbatim.

### 2. Providers is the sharpest case: workspace data behind a project URL

`ProviderSettings` (`packages/web/src/routes/settings/provider-settings.tsx:176-179`, anchor
`#providers`) is mounted **inside the project Agents pane** at `agents-section.tsx:125`. Its data
is not project data: the switch at `provider-settings.tsx:243` drives
`PUT /api/v1/providers/:provider/enabled`, which writes `disabledProviders` in the **workspace**
config (`packages/cezar/src/server/server.ts:2226-2238`), and it reads
`workspaceQueryKeys.providerStatus`. A workspace-wide toggle is therefore reachable only through
one arbitrary project's URL. Two in-app banners already hard-code that arbitrary hop —
`components/provider-banner.tsx:51,92` and `routes/new-task.tsx:842,880` both link
`/settings/agents#providers`, a flat path that `LegacyPathRedirect` (`routes.tsx:270`) rewrites to
the **boot** project.

### 3. The split is already half-abandoned in the data layer

The precedent is in this repo's own compatibility doc. `BACKWARD_COMPATIBILITY.md` §2:

> **Deliberate semantic change (multi-project workspace)**: `maxParallel`/`memoryLimitMb` are
> workspace-global from here on. The per-repo keys in `.ai/cezar/config.json` were imported
> **once** by migration 001 (section 9) and are thereafter ignored by enforcement
> (`packages/cezar/src/workspace/semaphore.ts` consults only the workspace `resources`);
> `GET/PUT /api/v1/config` still parses and writes the per-repo keys so older cezars sharing the
> repo keep working, but the running cap is the workspace's.

`loadConfig()` (`packages/cezar/src/config.ts:198-213`) already reads **both** files on every
call and seeds the repo object from the machine tier — but only for two keys, `defaultRunner` and
`defaultModels` (`withMachineDefaults`, `config.ts:175-189`). `resolveWorktreeRetention`
(`config.ts:289-294`) does the same for a third. Every other project setting has no machine tier
at all, which is why its editor could only ever live under a project URL.

### 4. What is genuinely per-project, and must not be pretended away

Four things cannot become one global value, and a spec that says otherwise would be lying:

- **Where a project lives on disk** (`project-location.tsx:50`) and the registry facts beside it.
- **The agent config-file editor** (`agent-config-section.tsx`, `agent-descriptors.ts:63-107`) —
  it edits real files inside one checkout.
- **The worktree list on disk** (`worktrees-panel.tsx`) — one checkout's worktrees.
- **`baseBranch`** — a branch name is a property of a repository, not of a person.

These stay per-project. They stop being a separate *area*.

## Solution

**One area at `/settings`.** The registry stops carrying a routing `scope` and starts carrying
`appliesTo`. Sections whose value can differ per project render a **project selector in their own
header**, defaulting to *All projects* — the machine tier. Choosing a project switches that
section (and only that section) to editing that project's override.

Concretely:

1. `/settings` and `/settings/<section>` are the only settings URLs the cockpit generates. Every
   non-hidden section appears in one nav, in one order.
2. `/settings/global` and `/settings/global/<section>` **redirect** to their new twins, query and
   hash intact. `/p/<id>/settings` and `/p/<id>/settings/<section>` redirect to
   `/settings/<section>?project=<id>`. Nothing 404s — `BACKWARD_COMPATIBILITY.md`'s *"Settings
   split, old URLs kept"* promise is honoured in the new direction too.
3. `Providers` leaves the Agents pane and becomes its own workspace section. It already writes
   workspace data; it stops needing a project in its URL. The two banners re-point at
   `/settings/providers`.
4. The project **General** pane becomes a real registry section (`project`, `appliesTo:
   'per-project'`) instead of a shell special case, so it is in the nav like everything else. With
   no project selected it shows the registered-projects table it already shares code with
   (`projects-section.tsx:858` `MaxParallelSelect` and `remove-project.tsx` are already imported by
   both).
5. Four project-only settings gain a machine tier so *All projects* is a real answer and not an
   empty pane: `systemPrompt`, `liveTitleUpdates`, `reviewGate`, `stepBudget`. Precedence is
   unchanged in character — **the repo's own value always wins**, and the machine tier is consulted
   only where the repo file is silent, exactly as `workspace/config.ts:131-141` already argues for
   `agentDefaults`.
6. `baseBranch`, the agent config editor, the worktree list and the project folder stay
   per-project. With *All projects* selected they render a short, honest "pick a project" state
   rather than a fake global control.

### What this deliberately does NOT do

- **It does not merge the two files.** `.ai/cezar/config.json` is committed into user repos and
  shared by a team; `~/.cezar/config.json` is one machine's. Collapsing them would be a
  `BACKWARD_COMPATIBILITY.md` §3 break against a published npm CLI whose contract is *"plain JSON
  … you can `cat` and fix by hand"* (`BACKWARD_COMPATIBILITY.md:3`).
- **It ships no migration.** Migration 002 was considered and rejected: importing per-repo values
  into the machine tier requires picking one repo's answer as the global one, and with twelve
  registered projects there is no non-arbitrary choice. `workspace/migrations.ts:14-28` requires a
  migration be additive and idempotent; "pick a winner" is neither. Existing repo values keep
  working untouched, and now render as **Overridden** in the one page — which is the honest
  outcome and also the discoverability the report asked for.
- **It does not touch `agentModelsLocked`** (`packages/cezar/src/core/agent-model-policy.ts:19-39`).
  That resolver is an OR across env, workspace and repo, is the only synchronous `readFileSync`
  settings read, and bypasses both loaders. Removing its repo arm would flip `true` → `false` for
  anyone who set `modelsLocked` repo-locally.
- **It does not globalize `skillsRepos`.** Its *presence* in the raw repo file is a tri-state probe
  (`gatedSkillsRepos`, `config.ts:256-278`): absent means the default skills are gated. Seeding it
  from a machine tier would silently ungate every default skill in every repo.
- **It does not touch knowledge mounts.** `knowledge/paths.ts:82-88,222-268` gives repo mounts and
  workspace mounts *different security rules* in hosted mode. There is no settings UI for them
  today, and collapsing their scopes would move a security boundary, not a lookup.

## Architecture

### Web (`packages/web`)

| File | Change |
|---|---|
| `src/routes/settings/registry.tsx:74` | `SettingsScope` → `SettingsAppliesTo = 'workspace' \| 'per-project'`. Field renamed `scope` → `appliesTo`. |
| `src/routes/settings/registry.tsx:108-246` | One flat list; add `providers` and `project`; `agents` / `agent-config` / `worktrees` / `bookmarklets` / `prompt-templates` / `sources` / `project` marked `per-project`, the rest `workspace`. |
| `src/routes/settings/registry.tsx:261-275` | `visibleSettingsSections(capabilities)` — the `scope` argument and its filter clause go. The `hidden`, `singleProject` and `capability` gates stay untouched. |
| `src/routes/settings/settings-shell.tsx:43-49` | `settingsSectionPath(id)` → `/settings/${id}`; `settingsIndexPath()` → `/settings`. |
| `src/routes/settings/settings-shell.tsx:52-165` | One nav (`SectionNav` / `SectionPills`), plain router links only — the scoped `@/lib/project-router` wrappers at `:52` are no longer needed by the shell. |
| `src/routes/settings/settings-shell.tsx:167-204` | `SettingsSectionRoute` loses `scope`; renders a `<SettingsProjectSelector>` in the header when `section.appliesTo === 'per-project'`. `data-route` becomes `settings-<id>`. |
| `src/routes/settings/settings-shell.tsx:232` | The `ProjectGeneral` special case goes; it is a registry section now. |
| new `src/routes/settings/settings-project.tsx` | `useSettingsProject()` — reads/writes `?project=`; `null` = All projects. Plus the selector component and the shared "pick a project" empty state. |
| `src/routes.tsx:648-667` | The project settings block becomes redirects only. |
| `src/routes.tsx:680-687` | The global block moves to `/settings/*`; `/settings/global/*` becomes redirects. |
| `src/components/nav-items.ts:131` | `{ to: '/settings', label: 'Settings', icon: SettingsIcon, match: ['/settings'], workspace: true, workspaceTo: '/settings' }`. `workspace: true` drops it from the per-project groups (`project-groups.tsx:333` already filters on it). |
| `src/components/provider-banner.tsx:51,92`, `src/routes/new-task.tsx:842,880` | `/settings/agents#providers` → `/settings/providers`. |
| `src/components/tools-menu.tsx:125,169`, `src/components/prompt-template-menu.tsx:149`, `src/components/clone-project-dialog.tsx:174`, `src/routes/settings/resources-section.tsx:157` | Re-point at the flat paths. |
| `src/components/app-shell.tsx:781-800`, `app-shell-container.tsx:126` | `GlobalSettingsLink` → `/settings`; the header's `globalSettings` predicate matches `/settings`. |

**Addressing another project's API without a scope provider.** The one area sits outside
`ProjectScopeRoute`, but the scoped API families are already double-mounted — both
`/api/v1/<path>` and `/api/v1/p/:projectId/<path>` (`server.ts:6748-6751`). So a per-project
section reads `GET /api/v1/p/<selected>/config` directly. The web client needs a way to build a
scoped URL from an explicit id rather than from the provider; that is the one piece of new
plumbing in Phase 1, and it is deliberately a thin helper, not a second client.

### Server (`packages/cezar`) — Phase 3 only

`withMachineDefaults` (`config.ts:175-189`) gains four keys, seeded onto the **raw** object before
parse — which is the existing mechanism and the existing reason (`config.ts:164-174`: *"`defaultRunner`'s
`.default('claude')` materializes the key, so after a parse there is no telling 'the user chose
claude' from 'the user said nothing'"*). `GET /api/v1/config` gains an `inherited` block and an
`overridden` list so the UI can say which tier an effective value came from — the same shape
`composerDefaults` already uses at `server.ts:3858-3872`, and the raw-file presence probe already
exists as `ownWorktreeRetention` (`config.ts:224-241`).

## Data models

New in `packages/cezar/src/workspace/config.ts`, inside `workspaceConfigSchema` (`:178-218`):

```ts
/** The machine's answer for settings a repo may also set. Every key optional with NO default,
 *  for the reason `agentDefaultsSchema` gives above it: an absent value has to stay
 *  distinguishable from a chosen one, or "fall back to the machine default" collapses into
 *  "always the default". A repo's own `.ai/cezar/config.json` still wins key by key. */
const projectDefaultsSchema = z
  .object({
    systemPrompt: z.string().trim().min(1).max(20_000).optional().catch(undefined),
    liveTitleUpdates: z.boolean().optional().catch(undefined),
    reviewGate: z.boolean().optional().catch(undefined),
    stepBudget: z.number().int().min(0).max(1000).optional().catch(undefined),
  })
  .passthrough();

// added to workspaceConfigSchema:
projectDefaults: projectDefaultsSchema.default(() => ({})).catch(() => ({})),
```

`packages/cezar/src/config.ts:175-189`, extended:

```ts
function withMachineDefaults(raw: unknown, machine: MachineTier): unknown {
  // …existing defaultRunner / defaultModels seeding, unchanged…
  return {
    ...own,
    ...(own.systemPrompt      === undefined && d.systemPrompt      !== undefined ? { systemPrompt: d.systemPrompt } : {}),
    ...(own.liveTitleUpdates  === undefined && d.liveTitleUpdates  !== undefined ? { liveTitleUpdates: d.liveTitleUpdates } : {}),
    ...(own.reviewGate        === undefined && d.reviewGate        !== undefined ? { reviewGate: d.reviewGate } : {}),
    ...(own.stepBudget        === undefined && d.stepBudget        !== undefined ? { stepBudget: d.stepBudget } : {}),
  };
}
```

Note the interaction that has to be got right: `liveTitleUpdates` and `reviewGate` are
`z.boolean().optional()` in `configSchema` (`config.ts:62-63`) and are resolved by two mirror-image
functions that treat `undefined` as "consult the env" — `reviewGateEnabled`
(`runs/review-gate.ts:16-22`, default OFF via `CEZ_REVIEW_GATE`) and `liveTitleUpdatesEnabled`
(`runs/auto-name.ts:43-49`, default ON via `CEZ_TITLE_UPDATES`). Seeding happens **above** those,
so the final order is **repo → machine → env → hardcoded**, and an unset machine tier reproduces
today's behaviour byte for byte.

No change to `.ai/cezar/config.json`'s schema, no key removed anywhere.

## API contracts

All additive. No route is added, renamed or removed, so the route-inventory guards
(`packages/cezar/src/server/bc-route-inventory.test.ts`, `route-parity.test.ts`,
`versioned-surface.test.ts`, `contract-parity.workspace.test.ts`) stay green by construction.

**`GET /api/v1/workspace/config`** (`server.ts:3891`, body built by `workspaceConfigBody`,
`server.ts:3855`) — response gains:

```jsonc
"projectDefaults": {
  "systemPrompt": "string | null",
  "liveTitleUpdates": "boolean | null",
  "reviewGate": "boolean | null",
  "stepBudget": "number | null"
}
```

`null` means "the machine has no answer", mirroring how `composerDefaults` reports absence
(`server.ts:3858-3862`).

**`PUT /api/v1/workspace/config`** (`server.ts:3893`) — body accepts the same optional
`projectDefaults` object. Delete semantics follow `PUT /api/v1/config`'s existing convention
(`server.ts:6167-6238`): `null` (and `''` for `systemPrompt`) deletes the key. The existing
all-or-nothing validation contract at `server.ts:3896-3921` is unchanged — a bad `browseRoot` still
persists nothing, `projectDefaults` included.

**`GET /api/v1/config`** (`server.ts:6162`, `configAnswer` at `:6134`) — response gains two
fields, and every existing field keeps its current meaning (still the **effective** value):

```jsonc
"inherited": { "systemPrompt": "…|null", "liveTitleUpdates": true, "reviewGate": null, "stepBudget": null },
"overridden": ["reviewGate", "baseBranch"]   // keys this repo's RAW config.json actually sets
```

`overridden` comes from a raw read of `<repoRoot>/.ai/cezar/config.json`, not from the parsed
config — the same reason `ownWorktreeRetention` (`config.ts:224-241`) re-reads raw.

**`PUT /api/v1/config`** — unchanged.

**Contract package:** `packages/contract/src/workspace.ts:28-67` (`workspaceConfigResponseSchema`),
`:76-111` (`setWorkspaceConfigInputSchema`), `:309-329` (`configResponseSchema`). The hand-written
duplicate DTO at `server.ts:775-802` must be updated in the same change or
`contract-parity.workspace.test.ts` fails.

**Cockpit URL contract (documented, not code):** `/p/<id>/settings/*` stops rendering and starts
redirecting. `BACKWARD_COMPATIBILITY.md`'s *"Settings split, old URLs kept"* bullet (§2, ~line 122)
must be amended in place rather than appended to — it currently states the split as current fact.

## Phases

Each phase is independently shippable and independently verifiable.

### Phase 1 — one area, one nav, one set of URLs *(web-only; no schema, no server)*

- Registry: `scope` → `appliesTo`; `visibleSettingsSections(capabilities)`.
- Shell: one nav, project selector for `per-project` sections, `project` (ex-General) becomes a
  registry section.
- Routes: `/settings/*` is the only generated block; `/settings/global/*` and `/p/:id/settings/*`
  redirect, query + hash preserved.
- Nav + every in-app deep link re-pointed.
- **Ships the reported fix on its own.** With no machine tier yet, a `per-project` section with
  *All projects* selected renders the "pick a project" state — still one page, still every section
  reachable, and honest about what it can answer. Deploy is a `web/dist` swap, no restart
  (`AGENTS.md:12`).

### Phase 2 — Providers becomes a workspace section

- Lift `ProviderSettings` out of `agents-section.tsx:125` into its own `providers` registry entry,
  `appliesTo: 'workspace'`.
- Re-point `provider-banner.tsx:51,92` and `new-task.tsx:842,880` at `/settings/providers`.
- Web-only. Removes the last case of workspace data hiding behind a project URL.

### Phase 3 — a machine tier for the four project settings that need one

- `projectDefaults` in `workspaceConfigSchema`; `withMachineDefaults` extension; `inherited` +
  `overridden` on `GET /api/v1/config`; contract + server DTO.
- UI: with *All projects* selected, Agents edits `projectDefaults`; with a project selected it
  edits that repo and labels each field **Inherited** or **Overridden**, with a "clear override"
  affordance.
- Backend change → needs the deploy restart, which SIGKILLs the deploying session and is expected
  (`AGENTS.md:12`).

### Phase 4 — the record

- `BACKWARD_COMPATIBILITY.md`: amend the *Settings split* bullet in place (the falsehood is in the
  claim itself, so it is a body correction with the original left below it), and extend the
  workspace-settings shape bullet with `projectDefaults`.
- `CHANGELOG.md` entry.
- KB: a new entry recording *scope is a field, not a place*, superseding nothing but cross-linking
  `notion-bc7bc9a5357f`, whose Phase 1 created the `/settings/global` destination this changes.
  Written as a `CEZ_KB_WRITE_FILE` proposal — a proposal is **not** the record until applied.
- The `document` step of `spec-to-deploy` owns this phase.

## Risks

1. **A settings URL that 404s is worse than the split.** Six project URLs and nine global URLs are
   in bookmarks, in the BC doc, and in `MovedSettingsSectionRedirect` chains. Mitigation: both
   redirect families are written before the routes are moved, and `routes.test.tsx` pins them
   including query + hash survival across both hops.
2. **The project selector could make a user think they edited a project when they edited the
   machine.** Mitigation: the selector sits in the section header, always visible, and the save
   control names its target explicitly (*Save for all projects* / *Save for cezar*). This is the
   single highest-value thing for the live e2e to check.
3. **Seeding a key that carries a `.default()` destroys the "did the user choose?" distinction**
   (`config.ts:164-174`). `stepBudget` has `.default(0)`; it is seeded onto the **raw** object
   pre-parse, which is exactly what `withMachineDefaults` already does, and `overridden` is
   computed from a raw read, never from the parsed object.
4. **`liveTitleUpdates` / `reviewGate` have env fallbacks with opposite defaults**
   (`auto-name.ts:43-49` ON, `review-gate.ts:16-22` OFF). An empty `projectDefaults` must be
   indistinguishable from today. Pinned by test, both directions.
5. **`agentModelsLocked`, `skillsRepos` and knowledge mounts are excluded on purpose** (see § What
   this deliberately does NOT do). The risk is a later implementer "finishing the job" and
   tripping one of them; that is why each exclusion carries its reason here.
6. **Zero-config regression** (`AGENTS.md:16`, `AGENTS.md:52`). Every new key is optional, absent by
   default, and absent reproduces current behaviour. No working default is traded for a knob, and
   no user is required to set anything.
7. **`settings.test.tsx` pins the scope split as its central assertion** — its own header says *"The
   scope split is what most of this file now pins."* It gets rewritten, not patched, and the
   rewrite must keep the property that made it good: assert **which store a section writes**, not
   which component rendered. `accounts-defaults.test.tsx` pins the global/project defaults split
   and needs the same treatment.
8. **Three duplicate `Field` chassis** (`settings-field.tsx:11`, `agents-section.tsx:427`,
   `prompt-templates-section.tsx:395`) will look tempting to unify mid-move. Out of scope; a
   refactor mixed into a route move makes the diff unreviewable.
9. **`prompt-templates` writes per-repo `ui-state.json`** (`prompt-templates-section.tsx:79` →
   `putUiState({ promptTemplates })`, schema `contract/src/workspace.ts:171`), while the
   workspace ui-state bag (`:200-238`) has no such key. In Phases 1–3 it stays per-project behind
   the selector. Making templates workspace-wide is a separate decision with its own migration
   question and is **not** in this spec.

## Verification

Gates first, fail closed (`AGENTS.md:11`). Nothing below is optional, and a skipped step gets
named rather than rounded up.

**Automated — run from the repo root**

```bash
npm run typecheck                         # exit 0 (runs contract, client, server, web)
npx vitest run packages/web/src/routes.test.tsx packages/web/src/routes/settings
npx vitest run packages/cezar/src/config.test.ts packages/cezar/src/workspace   # phase 3
npm test                                  # full vitest suite
npm run test:e2e                          # MUST read TEST_E2E_STATUS — see below
```

`.ai/scripts/e2e.sh` exits **0 with `TEST_E2E_STATUS=skipped`** when no browser can be provisioned.
That is not a pass. The verification is complete only on `TEST_E2E_STATUS=passed`; anything else
is reported as "UI not verified".

**Tests to write (named, so their absence is visible)**

- `routes.test.tsx`
  - `/p/cezar/settings/agents?x=1#providers` lands on `/settings/agents?project=cezar&x=1#providers`.
  - `/settings/global/appearance` lands on `/settings/appearance`; `/settings/global` on `/settings`.
  - Every non-hidden section id has exactly one route, and hidden `keyboard` still 404s.
- `settings.test.tsx` (rewrite)
  - One nav renders all fourteen visible sections in one list; `data-scope` is gone.
  - Agents with *All projects*: writes `/api/v1/workspace/config`. With `?project=chat`: writes
    `/api/v1/p/chat/config`. Asserted on the recorded request URL, as today.
  - Appearance still writes `/api/v1/workspace/ui-state`.
  - `singleProject: true` still drops `projects`; `CEZ_SOURCES` off still drops `sources`.
- `provider-settings.test.tsx` — the provider switch issues `PUT /api/v1/providers/claude/enabled`
  from `/settings/providers`, with no project segment in the URL.
- `packages/cezar/src/config.test.ts`
  - repo silent + `projectDefaults.reviewGate = true` → `loadConfig().reviewGate === true`.
  - repo sets `reviewGate: false` + machine `true` → stays `false` (**repo wins**), and stays
    `false` after the machine value changes again.
  - `projectDefaults: {}` → every effective value byte-identical to the pre-change baseline,
    including `liveTitleUpdatesEnabled` ON and `reviewGateEnabled` OFF with no env set.
  - `overridden` lists only keys present in the RAW repo file, never defaulted ones.
- server test — `PUT /api/v1/workspace/config { projectDefaults: { systemPrompt: 'x' } }`
  round-trips through `GET`, an unknown sibling key survives (`.passthrough()`), and a `null`
  deletes.

**Live runtime e2e — required before this is called done, not QA-needed**

On `https://cockpit.example.com`, with a screenshot per step:

1. `/settings` renders **one** nav containing Agents, Agent config, Worktrees, Bookmarklets, Prompt
   templates, Appearance, Notifications, Resources, Agent accounts, Projects, Workspaces, Account,
   Backup, Providers — i.e. the reported gap is closed.
2. `/settings/agents` with *All projects*: set a system prompt, save, reload, value persists;
   confirm `~/.cezar/config.json` now carries `projectDefaults.systemPrompt` and that **no** repo's
   `.ai/cezar/config.json` changed.
3. Switch the selector to a project whose repo sets `reviewGate` — the field reads **Overridden**;
   a project that does not — it reads **Inherited**.
4. `https://cockpit.example.com/p/cezar/settings/agents` redirects to
   `/settings/agents?project=cezar`; `/settings/global/appearance` redirects to
   `/settings/appearance`.
5. Turn a provider off from `/settings/providers`; the composer's provider banner reflects it
   without visiting any project URL.

**Deploy post-condition** — both probes in `.ai/deploy-targets.json` exit 0
(`packages/cezar/dist/index.js` present, `/opt/cezar/.deployed-commit` equal to `git rev-parse
HEAD`, `/api/v1/health` answering, and the served `index.html` naming the built asset). Phases 1–2
are web-only and go live on the next request; Phase 3 touches the backend and needs the restart.

## Status log

**2026-08-21 — Phases 1–4 implemented; deploy and live e2e outstanding.**

| Phase | State | Evidence |
| --- | --- | --- |
| 1 — one area, one nav, one set of URLs | implemented | `registry.tsx` (`scope` → `appliesTo`), `settings-shell.tsx`, `settings-project.tsx`, `routes.tsx` (`GlobalSettingsRedirect`, `ProjectSettingsRedirect`), `routes.test.tsx` |
| 2 — Providers becomes a workspace section | implemented | `provider-settings.tsx` (`appliesTo: 'workspace'`), `provider-banner.tsx`, `new-task.tsx`, `provider-settings.test.tsx` |
| 3 — machine tier for the four project settings | implemented | `workspace/config.ts` (`projectDefaultsSchema`), `config.ts` (`PROJECT_DEFAULT_KEYS`, `withMachineDefaults`), `contract/src/workspace.ts`, `server.ts` (`configAnswer` → `inherited` / `overridden`), `config.test.ts`, `workspace-api.test.ts` |
| 4 — the record | implemented | this status block, `BACKWARD_COMPATIBILITY.md` §2 (*Settings split* corrected in place, the workspace-config bullet extended, a new `inherited`/`overridden` bullet) and §9 (`projectDefaults`), `CHANGELOG.md` (Unreleased → Changed), KB proposal `cezar/one-settings-area-2026-08-21.md` |

**Divergences from the design are listed at the head of this document** — five, all deliberate,
none re-opened by the record step.

**Gates, run with the `AGENTS.md` env scrub** (`/tmp/cez-gate-run/gate.sh`, which strips every
`CEZ_*` except `CEZ_HANDOFF_FILE`/`CEZ_TASK_ID`, unsets `NODE_ENV`, and points `TMPDIR` at
`/tmp/cez-gate-tmp`): `typecheck` 0 · `test:unit` 44/44 · `build` 0 · `test:package` 15/15 ·
`vitest` 9430 passed / 2 failed. Both reds are pre-existing and were reproduced on the pre-change
commit `6c7bca5e`: `knowledge/catalog.test.ts` C18, the documented absolute-time-budget trap
(`AGENTS.md` trap 3, 57.6 ms/MiB here, 59.1 ms/MiB before this change), and the
`add-project-dialog.test.tsx` flake, untouched by this diff and 24/24 in isolation three times.
**Neither is to be "fixed" by widening a budget.**

**NOT done, stated rather than rounded up:**

1. **The live runtime e2e has not run.** §Verification's five browser steps against
   `https://cockpit.example.com/settings` — the one-nav check that closes the reported gap, the
   `projectDefaults` round-trip, the Inherited/Overridden labels, both redirect families, and the
   provider toggle — are all unexecuted. `.ai/scripts/e2e.sh` exits 0 with
   `TEST_E2E_STATUS=skipped` when no browser can be provisioned, and **that is not a pass**. Until
   `TEST_E2E_STATUS=passed`, this spec is *implemented, UI not verified*. Tracked as a `cezar todo`
   filed 2026-08-21.
2. **Deploy is the `deploy` step's, and it needs the restart.** This delta touches `server.ts`,
   `packages/contract` and `config.ts`, so it is not a `web/dist`-only swap: per `AGENTS.md:12` the
   backend half needs the `kill -9` restart, which SIGKILLs the deploying session. Expected and
   survivable. The post-condition is both probes in `.ai/deploy-targets.json` exiting 0.
