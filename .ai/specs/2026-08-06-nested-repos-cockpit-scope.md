# Nested repos (D1 REVERSED 2026-08-14), and what belongs to a project vs the workspace

Status: **Draft, D1/D2/D4 superseded** — extends `2026-07-20-multi-project-workspace`.

> **SUPERSEDED IN PART 2026-08-14 by `2026-08-14-nested-repos-as-projects.md`.** D1 below decided
> that `~/loki-labs` stays ONE project and that registering each nested repo as its own project was
> rejected. **The owner reversed that on 2026-08-14: nested repos DO register as projects.** The
> replacement spec carries the reasoning. What that takes with it: D2's `repos[]` on a project
> context, D4's per-repo forge and the repo selector in the Git/GitHub views are not being built —
> the bounded WALK described in D2 survives verbatim as the replacement's D3, because the walk was
> never the disputed part. D3 (`getRepoInfo`'s `exact` mode) is unbuilt and now unnecessary:
> discovery keys on a `.git` entry, never on `git rev-parse`, so the upward walk it guarded against
> cannot fire. D5–D8 are untouched, and D6 (Notes) was carried out on 2026-08-14 by
> `2026-08-14-remove-notes-capture-inbox.md`.
>
> Nothing in this file was ever implemented except D7 and D8, both marked "Implemented already"
> below. The original text is left unchanged underneath.

## TLDR

A project root may itself contain further git repositories. `~/loki-labs` is the
motivating case: it is a git repo *and* it holds `chat/`, `cezar/`, `bubble-trade/`,
`lokie-chatbox/` and `brand/`, four of which are independent repos with their own
remotes, branches and PRs, and one of which (`brand/`) is not a repo at all.

Today a project has exactly one repo — its root — so the Git and GitHub views show
the outer repo and nothing else. This spec gives a project **N repos with a selector**,
makes **forge availability per-repo instead of per-project**, and settles four smaller
scope questions the running cockpit surfaced: Notes, Skills, Settings, and the `More…`
row.

`~/loki-labs` stays ONE project. Registering each nested repo as its own project was
the alternative and is rejected below.

## Problem

1. **A project shows one repo.** `Git` and `GitHub` read `project.root`, so in a
   workspace-shaped repo every nested repo's branch, diff, commits and PRs are
   invisible. The cockpit shows the outer repo's `AGENTS.md` edits while all the real
   work happens two directories down.

2. **Forge availability is a property of the project, and it should be a property of a
   repo.** `resolveForge(getRepoInfo(root))` maps the project root's remote host to a
   driver — `github.com` → GitHub, anything else (GitLab, self-hosted, **no remote**)
   → `null` — and `visibleNavItems` drops the forge-gated `GitHub` and `Automations`
   items when health reports no driver. That is why a freshly created project has no
   GitHub tab: nothing is broken, the project has no GitHub remote yet. But it is also
   why a project *whose nested repos are all on GitHub* has no GitHub tab if its outer
   root is local-only.

3. **`getRepoInfo` walks upward, and most callers do not want that.**
   `git rev-parse --show-toplevel` run inside a directory that is not a repo returns
   the nearest **ancestor** repo rather than failing — verified directly:

   ```
   $ cd /tmp/probe/outer && git init -q .      # outer is a repo, inner is a plain dir
   $ cd inner && git rev-parse --show-toplevel
   /tmp/probe/outer
   ```

   That behaviour is correct for the one caller that means it (`index.ts:114` resolves a
   repo from the user's `cwd`). It is wrong for the ~15 callers that pass a
   `project.root` or a `repoRoot` and mean "this exact directory". The project registry
   already guards independently with `stat(join(root, '.git'))` → `not-git`
   (`workspace/projects.ts:193`), so registration is safe today; the unguarded sites are
   reachable only for a project whose root is a non-repo inside a repo. Discovery makes
   it reachable everywhere: walking `~/loki-labs` will call this on `brand/`, which has
   no `.git`, and would silently report `brand/` as being the `loki-labs` repo — right
   branch, right remote, wrong repo, no error anywhere.

4. **Four things are scoped wrong in the sidebar.** Notes is a workspace surface nobody
   needs now that a task can carry the same capture; Skills is upstream's, unused here;
   Settings repeats inside every project group though only six of its twelve sections
   are project-scoped; and the `More…` row linked to the URL the `Tasks` item above it
   already pointed at.

## Solution

### D1 — a project has repos; nested repos are not projects — **REVERSED 2026-08-14**

**Superseded by `2026-08-14-nested-repos-as-projects.md` D1: nested repos ARE registered as
projects.** The paragraph below is the rejected alternative that was chosen. Left unedited.

`~/loki-labs` remains one project. Its `Git`/`GitHub` views gain a repo selector.

Rejected: registering `chat/`, `cezar/` etc. as sibling projects. It reads plausible
because each has its own remote and PRs, but a project in cezar owns `.ai/cezar/` —
run store, automation store, launch key, knowledge roots. Splitting one workspace into
five projects splits its run history and knowledge base five ways, and the cross-project
board (`workspace/run-index`) then has to reassemble what never should have been taken
apart. The user's mental model is one workspace; the data model should match it.

### D2 — `repos[]`, discovered and bounded

A project context carries an ordered `repos: RepoRef[]`. Index 0 is the project root
when the root is itself a repo. The rest are discovered by a bounded walk:

- **Depth ≤ 3** from the project root.
- **Pruned directories**, never descended into: `node_modules`, `.git`, `dist`,
  `build`, `out`, `target`, `vendor`, `.venv`, `venv`, `__pycache__`, `.next`,
  `.turbo`, `coverage`, `.cache`, and any directory named in the knowledge base's
  existing exclusion list.
- **Do not descend into a repo.** Once a directory is identified as a repo it is
  recorded and its subtree is not walked further, so a submodule or a vendored checkout
  inside a repo does not multiply into the list.
- **Cap at 25 repos**, and when the cap truncates, say so in the payload
  (`truncated: true`) rather than presenting a partial list as complete.
- Cached behind the existing `probeCache` TTL, keyed on the project root.

### D3 — `getRepoInfo` gets an explicit `exact` mode

```ts
getRepoInfo(dir)                    // unchanged: walks up. For cwd resolution.
getRepoInfo(dir, { exact: true })   // null unless the toplevel IS `dir`.
```

Discovery and per-repo forge resolution use `exact`. The default is left alone so the
`cwd` caller keeps working — an unconditional equality check inside `getRepoInfo` would
have broken it, which is why this is an option rather than a fix in place.

The comparison is on **realpaths**, both sides. `/tmp` is a symlink to `/private/tmp` on
macOS and `--show-toplevel` returns the resolved form, so a lexical compare would report
every repo under `/tmp` as not-a-repo — the same trap `knowledge/paths.ts` documents.

### D4 — forge availability moves to the repo

`RepoRef` carries its own `forge: {kind, available} | null`, from its own remote.

- The `GitHub` nav item is visible when **any** repo in the project has a forge driver.
- The GitHub view's repo selector lists **only** forge-capable repos; a project whose
  outer root is local-only but whose `chat/` is on GitHub gets a GitHub tab scoped to
  `chat/`.
- The `Git` view's selector lists **every** repo, forge or not.
- Health keeps its existing project-level `forge` field, now defined as "the forge of
  repo 0, or of the first forge-capable repo when the root has none". Existing consumers
  keep working; a null there no longer means the project has no GitHub anywhere.

### D5 — Settings renders once

The `Settings` nav item becomes a workspace item (`workspace: true`, like Notes was)
pointing at `/settings/global`. The six genuinely project-scoped sections — agents,
agent config, worktrees, bookmarklets, prompt templates, sources — are **not** made
global; they stay at `/p/<id>/settings/…` and gain an entry point from
Global settings → Projects, one row per project.

Making them actually global was considered and rejected: worktrees live in a specific
repo and sources mirror into a specific project's `.ai/cezar/sources`. "Global only"
read as a request about the *sidebar*, which repeated Settings under every project, not
a request to collapse per-repo configuration into one shared blob.

### D6 — Notes is removed; capture moves into task creation

The Notes surface (`CEZ_NOTES`, `/notes`, `notes-routes.ts`, the contract's
`notes.ts`) is withdrawn from the cockpit. The capability flag and routes stay in the
tree, defaulting off, so the upstream PR is unaffected and nothing has to be deleted
from a fork that wants it.

What replaces it: task creation accepts free text, infers the target project from the
text, and supports dictation. Two properties from the notes work are preserved because
they were the load-bearing ones:

- **The human review gate stays.** An inferred project is a proposal shown before the
  task is created, never applied silently.
- **No variants.** A proposal is one task, not a menu of candidate tasks
  (`noteProposalSchema` deliberately has no `variants` key). Inference picks one project
  and can be corrected; it does not fan out.

### D7 — Skills is opt-out, not deleted

`capabilities.skills`, off via `CEZ_SKILLS=0`. **Implemented already** — recorded here
because it is the one inverted flag in a payload where every other key is `=== '1'`,
and the asymmetry needs a written reason: Skills predates the capability payload, so
absent has to keep meaning on, or the key would remove a surface from every install
that never set it.

### D8 — `More…` shows a count and only when it hides something

**Implemented already.** It rendered unconditionally at
`scopeTo(project.id, '/')`, the same URL as the `Tasks` item above it, so under the
10-row cap it navigated to the page you were already on. Now `N more…`, rendered only
when `N > 0`.

## Architecture

```
project root  ~/loki-labs                       repos[0]  (root is a repo)
├── chat/            git, github.com            repos[1]  forge: github
├── cezar/           git, github.com            repos[2]  forge: github
├── bubble-trade/    git, private remote        repos[3]  forge: github
├── lokie-chatbox/   git, no remote             repos[4]  forge: null
└── brand/           NOT a repo                 — not listed
```

Discovery lives in `workspace/repos.ts` (new), beside the registry rather than in
`server/git.ts`, because it is a workspace concern and `git.ts` is the plumbing it calls.
`ProjectContext` gains `repos`, populated in `activateOptionalStores`' sibling helper so
the boot path and the lazy path share one construction — the divergence that made the
knowledge base invisible on the boot project is the precedent, and it is not repeated.

## Data Models

```ts
export interface RepoRef {
  /** Stable id: the path relative to the project root, or "." for the root repo. */
  id: string
  /** Absolute realpath'd repo root. */
  root: string
  /** Display label: the relative path, or the project name for the root repo. */
  label: string
  branch?: string
  remote?: string
  forge: { kind: 'github'; available: boolean } | null
}

export interface ProjectRepos {
  repos: RepoRef[]
  /** True when the 25-repo cap truncated the walk. Never present a partial list as whole. */
  truncated: boolean
}
```

## API Contracts

| Route | Shape |
|---|---|
| `GET /api/v1/repos` | `ProjectRepos` for the scoped project. Flag-off shape not applicable — this is not flag-gated. |
| `GET /api/v1/git/*` | Gains an optional `?repo=<id>` query. Absent → repo 0, byte-identical to today. |
| `GET /api/v1/github/*` | Same, restricted to forge-capable repos. An unknown or non-forge `repo` is 404. |

`?repo=` is a **query parameter, not a path segment**, deliberately. Every
project-scoped route already answers under three byte-identical spellings (bare,
`/p/<bootId>/`, `/p/default/`) and that three-way parity is a protected surface enforced
by `route-parity.test.ts`. Adding a path segment would multiply the alias set and give
any path-keyed gate a fresh way to be wrong.

## Phases

| # | Work | Verification |
|---|---|---|
| 1 | `getRepoInfo(dir, {exact})` + realpath compare | a plain dir inside a repo returns null under `exact` and the ancestor without it; a symlinked path resolves |
| 2 | `workspace/repos.ts` discovery | depth, prune, no-descend-into-repo, cap+`truncated`, `brand/` absent, cache hit |
| 3 | `ProjectContext.repos` on BOTH paths | boot and lazy contexts return identical `repos` for the same root |
| 4 | `GET /api/v1/repos` + `?repo=` on git routes | three-spelling parity holds; unknown repo 404s; absent `repo` is byte-identical to today |
| 5 | Repo selector in Git + GitHub views | selector lists what the API returned; GitHub lists only forge-capable |
| 6 | Per-repo forge; nav gate on ANY repo | local-only root + GitHub `chat/` ⇒ GitHub tab present, scoped to `chat/` |
| 7 | Settings once (D5) + Projects entry point | project settings still reachable; sidebar shows Settings once |
| 8 | Notes withdrawn, capture in task creation (D6) | review gate present; one proposal, never variants |

## Risks

- **Discovery cost on a large tree.** Bounded by depth, prune list and cap, and cached.
  Measure before widening any of the three; do not raise the cap on a hunch.
- **A false "not a repo".** The realpath compare is the load-bearing line. Its negative
  control is a repo reached through a symlinked path — it must be found, not skipped.
- **`truncated` ignored by the UI.** A silently partial repo list is the failure this
  spec most wants to avoid: it looks exactly like "that repo has no changes". The
  selector must render the truncation, not just carry the flag.
- **Per-repo forge widening the GitHub tab's meaning.** The tab appearing when *any*
  repo has a forge means its contents are now scoped to a selection; a user who had one
  repo will see no change, one with five will. Acceptable, and the alternative (no tab
  unless the root is on GitHub) is the bug being fixed.

## Verification

Automated per phase, above. Runtime E2E, on this machine, with `~/loki-labs` registered
as a project:

1. Repo selector lists `.`, `chat`, `cezar`, `bubble-trade`, `lokie-chatbox` — and
   **not** `brand`, which has no `.git`.
2. Selecting `chat` shows chat's branch and its uncommitted changes, not the outer
   repo's.
3. The GitHub tab is present and lists PRs for the selected repo.
4. `node_modules` appears nowhere, and discovery on this tree completes in < 500 ms warm.

Until 1–4 have actually been run in the browser this ships as **QA Needed**, not Done.
