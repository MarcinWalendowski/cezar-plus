# Org-scoped tasks and knowledge, workspace-grouped sidebar

Status: **Draft** — decisions recorded, implementation not started.

## TLDR

Tasks and the knowledge base become **org-level** surfaces, filterable by
**workspace** and by **project**. The sidebar grows a workspace level above
projects. Boot stops auto-registering the launch directory entirely and offers it
instead. Together these finish the shift that `2026-08-06-org-team-auth-onboarding.md`
started: an org that owns workspaces that own projects, rather than a cockpit that
happens to be pointed at one repo.

## Problem

`2026-08-06-org-team-auth-onboarding.md` (D13/D14/D15) added organizations,
workspaces, and an onboarding gate that requires a first project. It stopped at
the data model and the settings screen. The rest of the cockpit still presents
the pre-org world, and running the finished onboarding flow exposed exactly where:

1. **Workspaces are invisible.** `project-groups.tsx` groups by project and takes
   `projects` + `bootProjectId` and nothing else. `teamId`/`teamName` are already
   on every registry entry (`contract/src/projects.ts:57-64`) and used by nothing
   in the sidebar. A user who creates *Engineering* and *Marketing* during
   onboarding never sees either word again outside Settings.
2. **Tasks are per-project; knowledge is per-project.** `/p/:id/` owns Tasks, and
   `routes.tsx:595` says of the knowledge base: *"project-scoped, like Git"*.
   There IS a cross-project board at `/workspace/tasks` with a working project
   filter (`components/project-filter.tsx`, from
   `2026-08-06-workspace-notes-cross-project.md`), but nothing in the sidebar
   points at it, so in practice it does not exist. The owner's framing: *"tasks
   and knowledge base is across org … with option to filter by workspace or
   project"*, and then, decisively: *"everything is per org, tasks, knowledge
   base, but we can filter everything by project as well."*
3. **The repo chip named the wrong repo.** Fixed already (see D2 below), but it
   is the same root cause: chrome derived from `health` (the launch directory)
   rather than from the project the user is in.
4. **Boot still auto-registers the launch directory.** D15 suppressed this while
   onboarding was incomplete, which deferred the complaint by exactly one launch
   — confirmed live.

## Decisions

### D1 — Tasks and Knowledge are org-scoped, with workspace and project filters

Both become workspace-level (in the routing sense: outside `/p/:projectId`)
surfaces that show the whole org by default and narrow through filters.

- **Filter contract, shared by both and by the URL:** absent means ALL, never
  none. This is not a new rule — `project-filter.tsx` already states it
  (*"Absent means ALL projects, never none"*) and the server query already
  honours it. The workspace filter adopts the same contract rather than
  inventing a second one.
- **The two filters compose as an intersection**, and the workspace filter is
  resolved to a project set client-side from `teamId` on each registry entry. No
  new server-side grouping: a workspace is metadata on a project, and D5 of the
  auth spec deliberately refuses to make a team a URL scope. That decision
  stands — filters are query state, not scope.
- **Knowledge moving out of `/p/:id/` contradicts a recorded decision** —
  `routes.tsx:595`, "project-scoped, like Git", from the central-hub F1 scaffold.
  It is reversed here deliberately, not by accident, and the branch this lands on
  (`feat/knowledge-base-central-hub`) is named for the reason: a knowledge base
  that cannot see across projects is not a central hub.
- **Not decided here, deliberately: Automations, Skills, Workflows and Inbox.**
  The owner named tasks and the knowledge base. Git and GitHub are inherently
  per-repo and stay. The other four are arguable either way, and guessing would
  be exactly the kind of silent scope decision the reported bugs came from. They
  stay project-scoped until asked.

### D2 — chrome describes the project you are in, never the launch directory

**Already fixed** (`app-shell-container.tsx`), recorded here because it is the
same root cause as the rest of this spec. The repo chip read
`repoChipOf(health.data)`, and `health.repo` describes the directory cezar was
launched in. Before D15 that was almost always also a registered project, so the
conflation was invisible; once boot stopped registering it, a cockpit showing
project `black` was captioned `cezar / feat/knowledge-base-central-hub` — naming
a repo not in the registry at all.

The registry entry is the authority (it carries the project's own `name` and
`branch`); health is the fallback only when there is no active project to
describe. `RepoChip.branch` became optional in the same change: a blank project
has an unborn HEAD until its first commit, and the alternative was rendering
`black / undefined`.

### D3 — boot never auto-registers; it offers

Supersedes D15's "only while onboarding is incomplete" bound in
`2026-08-06-org-team-auth-onboarding.md`, which is marked in place there.

`serveCommand` → `initWorkspace` no longer writes to the registry for the launch
directory under any condition. When the launch directory is not already a known
project, the cockpit surfaces a dismissible offer — *"<name> isn't in a workspace
yet"* with a workspace picker and an explicit accept. The registry is unchanged
until the user accepts.

Rationale, in the owner's model: a project is something you deliberately put in a
workspace. Auto-adding whatever directory you happened to `cd` into contradicts
that, and it is the literal complaint that started this work. cezar keeps
*serving* the launch directory (it always has — `shouldRegisterProject` only ever
governed registration, never what the process serves), so nothing about running
`npx cezar` in a repo breaks; what changes is that the sidebar stops gaining
entries nobody asked for.

**This is a behaviour change for a released package**, in the same class as D14's
onboarding wall, and gets the same treatment: stated here rather than discovered
in a changelog diff.

## Architecture

```
org (one, local mode)
 └── workspace (team)          <- new sidebar level
      └── project (repo)       <- existing project group
           └── Git · GitHub · … (repo-bound, stays per project)

org-level surfaces (outside /p/:projectId):
  Tasks      /workspace/tasks   filters: workspace[], project[]
  Knowledge  /knowledge         filters: workspace[], project[]
```

Sidebar shape, per the owner's selection:

```
Tasks                     <- org-wide, filter chips
Knowledge                 <- org-wide, filter chips
──────────────────────────
▾ Engineering
   ▾ black          main
       Git · GitHub · …
   ▸ api-gateway    main
▾ Marketing
   ▸ site           main
```

One workspace and one project collapses to today's flat nav, preserving
`project-groups.tsx`'s existing "the degenerate single-project workspace keeps
the flat sidebar" rule rather than replacing it.

## Phases

1. **D3 — boot never registers.** Smallest, and it directly answers the report.
   `isAwaitingLocalOnboarding` collapses to "never auto-register"; the offer UI
   is its own phase so the write stops immediately.
2. **Sidebar workspace level.** `ProjectGroups` groups by `teamName`; mount
   condition widens from "more than one project" to "more than one project OR
   more than one workspace".
3. **Knowledge to org scope.** Route moves out of `/p/:id/`; the F1 decision is
   corrected in place in `routes.tsx`.
4. **Workspace filter**, as a sibling of `ProjectFilter`, wired into both
   surfaces; Tasks and Knowledge gain the org-level nav entries.
5. **The "not in a workspace yet" offer.**

## Risks

- **An existing user's registry is untouched by D3, but their habits are not.**
  Someone who relies on `cd repo && cezar` seeing that repo in the sidebar now
  meets an offer instead of a fait accompli. That is the intent, and it is one
  click, but it is a real change to a released product's headline flow.
- **Moving Knowledge out of project scope changes URLs.** `/p/:id/knowledge`
  links exist in the wild only as far as `CEZ_KB=1` has been used, which is a
  scaffolded, flag-gated feature — but the redirect is cheap and should be kept
  rather than argued about.
- **Filter state is now two-dimensional.** A workspace filter that resolves to a
  project set can disagree with an explicit project filter (select *Engineering*,
  then deselect a project inside it). Intersection is the stated rule; the UI must
  make the resulting set legible, or users will read an empty board as a bug —
  the same failure mode `project-filter.tsx` already guards with its explicit
  "No projects match this filter" state.
- **`hasProjects` and the onboarding gate are unaffected** and must stay that
  way: D15's gate reads adopted projects, not the sidebar's grouping. A change
  here that made the gate read grouped/filtered state would let a filter
  re-open the onboarding wall.

## Verification

Planned before implementation, per the repo rule. Results recorded in place.

| # | Step | What it would catch | Result |
|---|------|--------------------|--------|
| 1 | Automated: launching in an unregistered repo writes NOTHING to the registry, with and without an org | D3 regressing to D15's deferred behaviour | |
| 2 | Automated **negative control**: launching in an ALREADY-registered repo still bumps `lastOpenedAt` and serves it | A "never register" that also broke re-opening a known project | |
| 3 | Automated: sidebar groups by workspace when >1 workspace exists with 1 project each | The mount condition still keyed on project count alone | |
| 4 | Automated: 1 workspace + 1 project renders today's flat nav | The degenerate case regressing into nested chrome | |
| 5 | Automated: workspace filter ∩ project filter, incl. the disagreement case in Risks | An intersection implemented as a union, which reads as "filter does nothing" | |
| 6 | Automated: absent filter = ALL for both dimensions | The "absent means none" inversion, which empties the board | |
| 7 | Automated: onboarding gate unchanged when filters are active | A filter re-opening the onboarding wall | |
| 8 | Runtime E2E: two workspaces, three projects — group, filter, and navigate | Everything the unit tests cannot: that it is legible | |

Step 8 decides Done vs QA Needed.
