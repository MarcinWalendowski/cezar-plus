# Nested repos register as projects

Status: **Draft** — **supersedes D1 of `2026-08-06-nested-repos-cockpit-scope.md`.** That spec
decided a workspace-shaped folder stays ONE project with a repo selector, and explicitly rejected
the design below. The owner reversed it on 2026-08-14 (see Problem 2). Everything else in that
spec — D2's bounded walk, D3's `exact` mode, D5–D8 — is unaffected and still the reference for how
the walk behaves.

## TLDR

Adding a folder that contains git repositories offers each nested repo as its own project, in one
reviewable list, and registers the ones you keep checked. `~/loki-labs` becomes `loki-labs`,
`chat`, `cezar`, `bubble-trade`, `aside`, `career-kit` — six registry rows, six run stores.

The discovery walk is bounded (depth ≤ 3, prune list, never descend into a repo, cap 25) and the
result is a **proposal**: nothing is written until the user confirms, and each row can be
unchecked.

## Problem

1. **A folder full of repos registers as one project.** `POST /api/v1/projects` takes one root and
   appends one entry. Add `~/loki-labs` and the cockpit shows the outer repo's branch and diff
   while every piece of real work happens one directory down, invisible.

2. **The repo-selector alternative was tried on paper and rejected by the owner.** The 2026-08-06
   spec argued that splitting a workspace into N projects splits its run history and knowledge base
   N ways. The counter-argument, which won: those repos are *already* independent — separate
   remotes, separate branches, separate PRs, separate agents working in them — and a shared run
   store is not a benefit when the runs have nothing to do with each other. A cross-project board
   already exists (`workspace/run-index`) for the reassembly the old spec worried about.

3. **Nothing regressed; it was never built.** Recorded because the request arrived as a regression
   report. Verified 2026-08-14:

   ```
   git log --all -- packages/cezar/src/workspace/repos.ts   → (no commits)
   git cat-file -e upstream/main:packages/cezar/src/workspace/repos.ts → ABSENT
   git log --all -S"/api/v1/repos"                          → f266d926 (the SPEC text only)
   ```

   `f266d926` wrote the spec and shipped D7/D8 only. There is no `repos.ts`, no `GET
   /api/v1/repos`, no `?repo=` query, and no branch that ever had them.

## Solution

### D1 — one nested repo, one project row

Registering `~/loki-labs` proposes every git repo found inside it, plus the folder itself, and
registers each accepted row through the SAME `registerFolder` guards a single add uses. A project
that comes from a scan is indistinguishable afterwards from one added by hand: same `source:
'local'`, same slug allocation, same `project_teams` claim.

### D2 — discovery is a proposal, never a silent write

The scan route reads; it never registers. The dialog lists what it found with a checkbox per row,
all checked, and the button says how many will be added. Two reasons this is not optional:

- Six registry rows from one click, with no preview, is the write nobody asked for that D15 removed
  from the boot path in the first place.
- The same review-gate rule the withdrawn Notes capture obeyed ("an inferred project is a proposal
  shown before the task is created, never applied silently").

### D3 — the walk, unchanged from the old D2

- **Depth ≤ 3** below the scanned folder.
- **Pruned, never descended into:** `node_modules`, `.git`, `dist`, `build`, `out`, `target`,
  `vendor`, `.venv`, `venv`, `__pycache__`, `.next`, `.turbo`, `coverage`, `.cache`.
- **Never descend into a repo**: a submodule or vendored checkout inside a repo is not a second
  project.
- **Never offer an agent task worktree.** Two markers, and the second was added after the first
  real run:
  - `…/.ai/cezar/worktrees/…` — cezar's own. `registerFolder` refuses these anyway; offering one
    would put a row in the list that cannot be added.
  - **`…/.claude/worktrees/…` — Claude Code's, added 2026-08-14.** Measured on the first folder
    this feature was pointed at (`~/loki-labs`): **ten real repos and six of these**, each a linked
    worktree of a repo already in the list. Nothing downstream catches them — unlike cezar's own,
    `registerFolder` accepts one — and D4's dialog pre-checks every addable row, so accepting the
    proposal wholesale registered six throwaway checkouts of the same project under generated names
    (`sunny-riding-cat`), which vanish when the agent finishes. Matched on the path rather than by
    adding `.claude` to the prune list: that directory also holds skills and settings, and pruning
    all of it to solve one subdirectory is a wider rule than the reason for it. A repo under
    `.claude` that is *not* a worktree is still offered (positive control in the tests).
- **Cap 25**, and say so (`truncated: true`) rather than presenting a partial list as complete.

### D4 — registration is per row, not one batch

The dialog issues one `POST /api/v1/projects` per checked row. Deliberately not a batch endpoint: a
batch write that fails halfway either loses the whole set or leaves an unreportable partial state,
and the per-row loop gives every row its own outcome — including the 409 an already-registered root
answers, which is a success for this flow, not an error.

### D5 — the scan obeys the browse root, exactly

`GET /api/v1/projects/scan` is a directory-structure read, so it answers under the same containment
rule as `GET /api/v1/fs/browse`: lexical check before any syscall, realpath check after, one
message for both. The guard is **extracted from** `browseDirectory` rather than re-written, so the
two cannot drift — a second hand-rolled copy is how one of them ends up permissive.

## Architecture

```
packages/cezar/src/workspace/nested-repos.ts   the bounded walk (new)
packages/cezar/src/server/fs-browse.ts         resolveBrowsableDir() extracted, shared
packages/cezar/src/server/server.ts            GET /api/v1/projects/scan
packages/contract/src/projects.ts              nestedRepoSchema, projectScanResponseSchema
packages/web/src/components/add-project-dialog.tsx   the review list
```

The walk lives in `workspace/`, beside the registry it feeds, not in `server/git.ts` — same
placement argument the superseded spec made, and it still holds.

## Data Models

```ts
export interface NestedRepo {
  /** Absolute path of the repo root. */
  path: string
  /** Path relative to the scanned folder — `chat`, `packages/tool`. The row's label. */
  relPath: string
  /** `basename(path)` — what the project would be NAMED once registered. */
  name: string
  branch?: string
  forge?: ForgeKind
  /** Already in the registry (realpath compare). Rendered checked-and-disabled. */
  registered: boolean
}

export interface ProjectScanResponse {
  /** The realpath'd folder that was scanned. */
  root: string
  /** Whether the scanned folder is ITSELF a repo — the dialog's first row is the folder. */
  rootIsRepo: boolean
  repos: NestedRepo[]
  truncated: boolean
}
```

## API Contracts

| Route | Shape |
|---|---|
| `GET /api/v1/projects/scan?path=<dir>` | `ProjectScanResponse`. `400 path is outside the browsable root` / `404 no such directory` — the same two answers `fs/browse` gives, for the same inputs. `409` under `CEZ_SINGLE_PROJECT`, matching every other project-adding route. |

`POST /api/v1/projects` is unchanged. That is the point of D4: the scan adds a read, not a second
way to write to the registry.

## Phases

| # | Work | Verification |
|---|---|---|
| 1 | `resolveBrowsableDir` extracted from `browseDirectory` | `fs/browse` behaviour byte-identical; the escape cases still 400 |
| 2 | `workspace/nested-repos.ts` walk | depth, prune, no-descend-into-repo, cap+`truncated`, worktrees absent, a non-repo dir absent |
| 3 | `GET /api/v1/projects/scan` + contract | containment answers match `fs/browse`; single-project 409; `registered` reflects the registry |
| 4 | Add-project dialog review list | lists what the API returned, registers exactly the checked rows, one POST each |

## Risks

- **A scan that walks a huge tree.** Bounded by depth, prune list and cap. The cap is a real
  ceiling, not a hint: `truncated` must render, because a silently partial list looks exactly like
  "that folder has no other repos in it".
- **Six projects the user did not want.** The review list is the mitigation, and it is why D2 is a
  decision rather than a UI detail.
- **A registered row silently re-registering.** `POST /api/v1/projects` is idempotent for a known
  root (it bumps `lastOpenedAt`), so a checked-but-already-registered row is harmless — but it is
  rendered disabled anyway, because a checkbox that does nothing is a lie about what the button
  will do.
- **`getRepoInfo` walking upward.** The old D3 trap: run inside a non-repo it returns the nearest
  ANCESTOR repo. This walk only ever calls it on a directory that already has a `.git` entry, so
  the upward walk cannot fire — but that is a property of the caller, and the negative control
  below is what keeps it true.

## Verification

Automated, per phase above, plus these named negative controls:

1. A plain directory inside a repo (`brand/` under a repo root) must NOT appear in `repos[]` — the
   control for `getRepoInfo`'s upward walk. It fails loudly if discovery ever probes by `git
   rev-parse` instead of by `.git`.
2. A repo nested inside a repo (submodule shape) appears once — the outer one — never twice.
3. A `.ai/cezar/worktrees/<id>` repo is never offered, even at depth 2.
3b. A `.claude/worktrees/<name>` repo is never offered, at any depth — **and** a repo under
   `.claude` that is not a worktree still is. The pair is the point: without the second half the
   guard could be satisfied by pruning `.claude` wholesale, which is not what was decided.
4. 26 repos ⇒ 25 rows and `truncated: true`.

Runtime E2E, on this machine:

- Add `~/loki-labs`: the list offers `chat`, `cezar`, `bubble-trade`, `aside`, `career-kit` and the
  folder itself; `brand` (no `.git`) is absent; `node_modules` appears nowhere.
- Unchecking two and confirming registers exactly the rest, and the sidebar shows them as separate
  project groups with their own task lists.

Until that browser pass has run this ships as **QA Needed**, not Done.

### What was actually run — 2026-08-14

`scanNestedRepos('/Users/mw/loki-labs')` against the real filesystem, before the fix:
**16 rows** — the 10 genuine repos (`anymail-mcp`, `aside`, `bubble-trade`, `career`,
`career-kit`, `cezar`, `chat`, `chat-wt-spec-101`, `homebrew-tap`, `mw-site`) and 6
`.claude/worktrees/*`. After the fix, the 6 are gone and the 10 remain. That is the run that
found D3's missing marker; the E2E above is still unrun, so this stays **QA Needed**.

Mutation check on the new guard: removing `${sep}.claude${sep}worktrees${sep}` from
`WORKTREE_MARKERS` fails exactly one test, 12/13 — the suite still collects, so the failure is a
kill and not a broken build.
