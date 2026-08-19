# Tasks page: a Running section on top, and Start that hands over the whole task

- **Status:** Approved — implementing
- **Date:** 2026-08-19
- **Owner instructions (verbatim):** "let's fix cezar production: running tasks section should be
  on the top of tasks tab/page. When I pressed start, only the title of tasks was injected to
  agent - the whole title and content of tasks should be injected into agent. Verify id knowledge
  base is properly fetched/retrieved as well - this is a task I'm talking about:
  https://cockpit.example.com/p/chat/tasks/2f1ae4aa-13ac-4869-8a9b-0d59acde7be7"

## TLDR

Three defects on the production cockpit, all confirmed against live state on `prod-host`:

1. `/tasks` opens on the **Filed** table (49 rows). Work actually in flight is below it, off the
   fold. A **Running** section is pinned to the top of the Active view.
2. **Start throws the task body away.** `todoTaskText()` builds
   `suggestedPrompt ?? summary` (+ `Arguments:`) and nothing else, so `context`, `whatToDo`,
   `acceptanceCriteria` and `knowledgeRefs` never reach the agent. It now emits the whole filed
   spec.
3. **The agent-facing knowledge read path is dead — in three layers, one of them everywhere.**
   `cez` is not on PATH on the box, so the `cez kb search` the system prompt instructs returns
   `command not found`; underneath that, **the `kb` command was never wired into the CLI at all**,
   on any install, so putting the binary on PATH only changes the error to `unknown command: kb`;
   and the 2086-document corpus is mounted on the `loki-labs` project only, so a run in `chat`
   searches 539 spec files and nothing else. All three are fixed here.

## Problem

### The evidence (production, 2026-08-19)

The task the owner named is run `2f1ae4aa-13ac-4869-8a9b-0d59acde7be7` in project `chat`, started
from todo `73c0400a-95a2-4d40-a47b-7a42a9947c11`. The todo on disk carries a full spec:
a 1.6 kB `context`, a six-bullet `whatToDo`, and five `acceptanceCriteria`. The run record carries:

```json
"task": "Alfredo: a cancelled 08:00 daily digest still reported as active — schedule state and the bot's answer disagree"
```

That is the `summary`, verbatim and alone. The handoff file's `## Goal` is the same one line.
Everything the composer wrote into the entry — including the explicit instruction *"Query both
planes before concluding"* and *"do not assign root cause from one side's logs"* — was dropped at
the boundary. The agent then re-derived its own framing and wrote a spec about a different defect
(a routine's time being invisible after creation) than the one the entry describes.

Two lines from that same run's event stream:

```
cez kb search "alfredo digest schedule"   →  /bin/bash: line 1: cez: command not found
grep -rln "digest" /var/lib/cezar/loki-labs/notion-export/reports/   →  (found it by hand)
```

The agent recovered the corpus by guessing an absolute path out of the workspace `CLAUDE.md` it
inherited as a parent-directory memory. That is luck, not a read path.

### 1. Filed sits above the runs

`global-tasks.tsx` renders `<FiledTasks>` before the run groups, on purpose — a 2026-08-15 note in
that file argues the page is "where a user looks after filing something". That reasoning held when
Filed was a short list. After the 2026-08-17 migration it is 49 active rows with its own controls
row, and a running task is now below a screenful of backlog. **This spec supersedes that ordering
decision**; the note is amended in place rather than deleted.

### 2. `todoTaskText` predates the structured spec

```ts
export function todoTaskText(todo: Pick<TodoItem, 'summary' | 'suggestedPrompt' | 'suggestedArgs'>): string {
  let task = (todo.suggestedPrompt ?? todo.summary).trim() || todo.summary;
  if (todo.suggestedArgs) task += `\n\nArguments: ${todo.suggestedArgs}`;
  return task;
}
```

The `Pick` is the bug made visible: the function was written for #374's three-field inbox entry
and never widened when `2026-08-15-knowledge-grounded-task-fanout.md` (D2/D4) added
`context`/`whatToDo`/`acceptanceCriteria`/`knowledgeRefs`. Those fields are stored, validated,
round-tripped through `POST /todos`, and rendered in the Filed detail dialog — every surface
except the one that matters. Nothing failed; the entry simply arrived at the agent as a headline.

The docblock also claims a cockpit twin in `web/app/src/routes/inbox.tsx` that no longer exists —
`inbox.tsx` posts to `/todos/:id/start` and builds no task text. Half of that cross-process drift
guard has been dead for some time, and the fixture's `_comment` still describes it as live.

### 3a. `cez` is not installed on the production box — and `cez kb` does not exist anywhere

`knowledgeSystemPrompt()` tells every agent to run `cez kb search "<query>"` and `cez kb show <id>`.
The package declares the bin (`"cez": "dist/index.js"`), but production runs a raw checkout —
`ExecStart=/usr/bin/node /opt/cezar/packages/cezar/dist/index.js serve` — so no bin was ever
linked, `/usr/local/bin` holds only `cloudflared`, and `dist/index.js` is mode 0644.

The prompt promises a capability the environment does not provide. That is the exact failure shape
the workspace's own knowledge doc *"doctrine that promises a capability the tool surface…"*
describes — and which this very run read, from a corpus it was not supposed to be able to find.

**And installing the binary is not enough**, which only became visible after doing it: `cez kb`
then answers `unknown command: kb`. `runKnowledgeCommand` is implemented and fully unit-tested and
registered nowhere. See D4 — this is the part of the finding that is not specific to this box.

### 3b. The corpus is invisible from every project except `loki-labs`

Indexed roots per project, read off the live manifests:

| project | roots | documents |
| --- | --- | --- |
| `loki-labs` | project, workspace, sources, specs, docs, analysis, **notion** | 2087 (2086 corpus) |
| `chat` | project, workspace, sources, **specs**, docs, analysis | 539 (specs only) |

The corpus is a repo-local mount in `/var/lib/cezar/loki-labs/.ai/cezar/config.json`
(`{"id":"notion","path":"notion-export"}`), and repo-local mounts are resolved relative to that
repo. From `chat`, the corpus is `../notion-export` — outside the repo root — and
`resolveKnowledgeRoots` refuses an external mount whenever `hosted` is true:

```ts
if (isExternal && hosted) { …reason: 'external mount is local only'; continue; }
```

Production is hosted (`GET /health` → `capabilities.localHandoff: false`), so no repo-local config
can ever make this work. The knowledge-first read that CLAUDE.md and AGENTS.md require of every
session is, for every product repo on this box, unreachable by the advertised means.

## Solution

### D1 — A `Running` section, pinned above Filed (web)

New section at the very top of the Active view: every run **in flight**, which is exactly the union
of the two buckets `lib/task-groups.ts` already defines as not-an-outcome — `Needs you`
(`waiting`, `review`) and `Working` (`running`, `queued`, and a `failed` run holding an
`autoResumeAt`). Not a fourth definition of "live": `bucketOf` widens its parameter from
`RunRecord` to the two fields it reads, the same move `RunTitleInput` and `AttentionInput` already
made, so the section and the sidebar can never disagree about what is running.

- Renders on the **Active** view only. On Archived there is no work in flight and a section
  headed "Running" over finished rows would be a lie; it renders nothing.
- Rows reuse `TaskTable` — same columns, same actions, no second row grammar to drift.
- Obeys the page's filters and query like every other section (it is a view over `visible`, not
  over `tasks`), so "Clear" is still the one way back to everything.
- Empty → renders nothing at all, as Filed already does. A page with nothing running looks exactly
  as it does today.

**Three corrections during implementation, each forced by a test rather than by taste. Recorded
here because all three were wrong in the plan above, not in the code.**

1. **Lifted, not duplicated.** This spec first said the rows should *also* stay in the full table
   below, on the reasoning that the bottom list is the complete record. That shipped 39 red DOM
   cases, every one of them `found multiple elements` — the machine saying out loud what a reader
   would have hit: the same task, twice, on one screen. Running rows are now removed from the
   grouped list below. The header's `N of M` still counts `visible` and is still honest, because
   every row is on the page exactly once.
2. **Order is preserved — this is a filter, not a sort.** The plan ranked the section by
   `sortRuns`' status weight (needs-you, running, scheduled, queued). That silently re-ordered
   rows the page renders in index order everywhere else, and a case asserting the page's own row
   order caught it. Pinning answers *where do I look?*; it is not licence to also answer *in what
   order?*. `sortRuns` is untouched and unused here.
3. **An explicit grouping owns the list; the pin steps aside.** With `groupBy: 'tag'` the reader
   has asked for every task under every tag its project carries — lifting the running ones into a
   box above answers a question nobody asked while emptying the boxes they did ask for.
   `inFlightGlobalTasks` takes `groupBy` and returns `[]` for anything but `'none'` (the default,
   and what Clear returns to), which is what kept four grouping cases green.

One placement detail that is not cosmetic: `ReferenceStatusProvider` now wraps **both** sections.
Chips are painted from context, so a section rendered outside it shows neutral chips forever
while the identical row below is coloured — the first cut did exactly that, and three
reference-chip cases caught it.

The 2026-08-15 "Above the runs" comment in `global-tasks.tsx` is amended in place with a
`superseded 2026-08-19` lead-in naming this spec.

### D2 — `todoTaskText` emits the whole filed spec (server)

The headline is unchanged, so every existing case is byte-identical; sections are appended only
when the entry carries them.

```
<suggestedPrompt ?? summary>

Arguments: <suggestedArgs>        ← unchanged, unchanged position

## Context
<context>

## What to do
<whatToDo>

## Acceptance criteria
- [ ] <each>

## Knowledge
- <title> (<project>/<slug>)
```

- **Markdown headings, not prose labels** — the run's `userPrompt` is markdown everywhere else in
  this codebase (`skill-detail`, the handoff file, `HANDOFF_INSTRUCTIONS`), and the detail dialog
  already renders these same four fields through the `Markdown` component.
- **`makeRunTitle` is unaffected**: it reads the first line and truncates at 80 chars, so the run
  title stays the summary it is today. Verified against the shape, not assumed.
- **The handoff file gains the whole spec** for free — `seedHandoffFile` writes `run.task` into
  `## Goal`, so a resumed or continued run now re-reads the full brief instead of the headline.
- **`knowledgeRefs` are emitted as stored text only** — title, project and slug, the three fields
  `todoKnowledgeRefSchema` holds. No document is opened, no path is resolved, no body is lifted:
  the prompt-injection bound `knowledge/prompt.ts` sets (Q12 — "never a body, an excerpt, a title,
  a slug") governs text lifted out of *mounted documents*, and these three strings are the
  composer's own citation as persisted on the todo, already rendered verbatim in the cockpit.
- **Empty/blank fields contribute nothing** — a whitespace-only `context` adds no heading, and an
  `acceptanceCriteria: []` adds no section. A legacy summary-only entry produces exactly the string
  it produces today.

The stale cockpit-twin claim in the docblock, the fixture `_comment`, and the test header are
corrected in place: there is one builder now, and the fixture is the contract for *it*.

### D3 — Workspace-scoped knowledge mounts (server)

A new `knowledge.mounts[]` block in the **workspace** config (`~/.cezar/config.json`), read with
the same tolerant, never-cached, never-throws idiom `readKnowledgeMountConfig` already uses for the
repo-local one. Workspace mounts are appended to every project's root list, after the repo-local
configured mounts.

**Why this is allowed in hosted mode when a repo-local external mount is not.** The hosted rule
exists so a path committed into a *repository* cannot make a hosted deployment index arbitrary host
directories — the repo is shared, and its config travels with a clone. The workspace config is
neither: it is the operator's own file on the operator's own box, and it is already the file that
lists every project root the server will ever open. A mount an operator wrote there is trusted by
exactly the same argument that `projects[].root` is. So:

| mount declared in | outside the repo root | hosted |
| --- | --- | --- |
| `<repo>/.ai/cezar/config.json` | refused (`external mount is local only`) | unchanged |
| `~/.cezar/config.json` | **indexed** | new |

- **Dedupe by resolved real path**, not by id. `loki-labs` already mounts the corpus repo-locally
  as `notion`; without this it would index the same 2086 files twice under two root ids. First
  root to claim a real path wins, and repo-local is resolved first, so `loki-labs` keeps its
  existing root id and manifest unchanged.
- **Id collision** with a repo-local mount: repo-local wins (the more specific scope), workspace
  entry skipped. Same rule, one line above the path dedupe.
- **Order stays deterministic** (`GET /knowledge` must be byte-stable): project, workspace,
  sources, discovered, repo-configured, workspace-configured.
- **Unavailable** workspace mounts render as `indexed: false, reason: 'root is not available'`,
  exactly as a repo-local one does — never silently dropped.
- Upstream purity holds: nothing in the code names Notion, this workspace, or a product.

Cost, since this multiplies by project count: the corpus is 13 MB / 2087 files, and a per-project
catalog is ~2.2 MB. Twelve registered projects is ~26 MB of catalogs and twelve `fs.watch`
registrations on one directory, on a box with 16 GB and 13 GB free. Scans are incremental after the
first (the manifest keys on size + mtime + hash). Affordable; recorded here so the next person
adding a mount does the same arithmetic.

### D4 — Make `cez kb` exist, then put it on PATH

**This was planned as a deployment-only fix and it is not.** Installing the binary revealed the
layer underneath: with `cez` on PATH the command answered

```
unknown command: kb
```

`runKnowledgeCommand` (`knowledge/cli.ts`) is complete, and `knowledge/cli.test.ts` covers its
whole surface — search, show, write, reindex, roots, proposals, the flag-off shape, JSON output.
It is imported by **nothing but that test**. The `kb` command was never registered in `index.ts`.

So `cez kb search "<query>"`, the exact string `knowledgeSystemPrompt` puts in front of every
agent run on every install with `CEZ_KB=1`, has never once been runnable. Not on production, not
locally, not for any user of the published package. The suite was green the entire time, because a
unit test over a function proves the function and says nothing at all about whether an entry point
calls it — and this was found by reading a production run's event stream, not by CI.

Two changes, both required:

1. **Register `kb`** — routed from raw argv *before* the strict top-level `parseArgs`, exactly as
   `backup` is and for exactly the same reason: `kb` owns `--json`, `--type`, `--tag`, `--status`,
   `--root`, `--limit`, `--offset`, `--content`, none of which are top-level options, so a
   `case 'kb':` inside the command switch would be registered and still unusable — `parseArgs`
   throws on the first flag before the switch is ever reached. It joins the top-level `--help` too:
   a command an agent is told to run should be discoverable without reading a spec.
2. **A reachability guard** — `knowledge/cli-wiring.test.ts`, a subprocess through the real entry
   module. Nothing importable can stand in: the wiring under test *is* the entry module's
   dispatch, and an in-process import of `runKnowledgeCommand` would be green again the moment
   someone deletes the dispatch, which is the state that produced this defect. Verified by
   mutation — stubbing the dispatch to `false && …` turns three of its four cases red.

Then the PATH half. `/usr/local/bin/cez` becomes a wrapper, not a symlink:

```sh
#!/bin/sh
exec /usr/bin/node /opt/cezar/packages/cezar/dist/index.js "$@"
```

A symlink would work today and break on the next deploy: `server-deploy` replaces `/opt/cezar`
wholesale (`/opt/cezar.prev` is the previous copy), and a freshly copied `dist/index.js` is mode
0644 again, so a symlink would resolve to a non-executable file. The wrapper depends only on the
path, which is stable.

`cezar` and `cezar-cli` get the same treatment — the package declares all three bins, and an agent
that has read a doc naming `cezar kb show` must not hit a second `command not found`.

**Known gap, recorded not fixed:** the Hetzner installer (`server-install/platforms/`) does not
create these wrappers, so a future box provisioned by it starts with the same dead prompt. Its
`redeploy` only restarts the unit — the code itself reaches `/opt/cezar` by a manual copy, with a
`.deployed-commit` marker no code in this repo writes. That is a separate change against the
installer and is filed as its own todo rather than smuggled in here.

Note this asymmetry, because it decides who is affected: the **wrapper** is specific to this
hand-provisioned box (an `npm install -g` of the published package creates all three bins from the
`bin` field), while the **unwired `kb` command** affected every install of every version.

## Architecture

Unchanged everywhere it matters. `todos.json` gains no field; the todo→run boundary stays one
function; knowledge roots stay a per-project resolution with a new, lower-precedence source; the
Tasks page gains a section, not a route or a query.

```
todo (todos.json)                          knowledge roots, per project
  summary ─────────┐                         project      <repo>/.ai/cezar/knowledge
  suggestedPrompt ─┤                         workspace    ~/.cezar/knowledge
  suggestedArgs ───┤                         sources      <repo>/.ai/cezar/sources
  context ─────────┼─► todoTaskText() ─►     specs/docs/  <repo>/.ai/specs, docs, .ai/analysis
  whatToDo ────────┤     run.task            analysis
  acceptanceCrit ──┤     handoff ## Goal     configured   <repo>/.ai/cezar/config.json  (repo-contained in hosted)
  knowledgeRefs ───┘     userPrompt          ws-configured ~/.cezar/config.json          ◄── NEW
                                                            └─ deduped by real path
```

## Phases

1. **Start hands over the whole task** — `todoTaskText` widened, fixture cases added, stale
   twin-drift comments corrected. Server only.
2. **Running section** — `bucketOf` parameter widened, `inFlightGlobalTasks` pure helper + tests,
   section rendered above Filed, superseded comment amended. Web only.
3. **Workspace knowledge mounts** — workspace mount reader, root resolution + dedupe, hosted rule
   split by declaration scope, tests.
4. **Production** — build, deploy, install the three CLI wrappers, add the corpus as a workspace
   mount, verify a real Start end to end in the browser.

## Data Models

No schema change. `todoItemSchema` is untouched — every field this spec reads already exists and
is already validated. The workspace config gains an optional `knowledge` key, parsed by the
existing `knowledgeConfigSchema`; `workspaceConfigSchema` is `.passthrough()`, so an older cezar
sharing the same home preserves the key rather than dropping it on its next write.

## API Contracts

`POST /api/v1/p/:projectId/todos/:id/start` — request and response shapes unchanged. The `run.task`
it produces is longer. `GET /api/v1/p/:projectId/knowledge` gains root entries for workspace
mounts, in the shape it already serves.

## Risks

- **A long task text reaching a runner's argv limit.** It does not: the task is written into the
  session's `userPrompt`, not a command line, and `whatToDo` is already capped at 100 kB by the
  wire schema — the same bound `createRunInputSchema` uses for text that reaches a spawned process.
- ~~**Duplicated rows on the Tasks page.** A running task appears in both the new section and the
  full table. Accepted and stated in D1; the alternative (removing it from the table below) makes
  the page's own `N of M` counter disagree with the rows under it.~~ **Wrong, corrected during
  implementation (D1, correction 1).** The counter argument was the mistaken half: `N of M` counts
  `visible`, and lifting a row into another section on the same page does not change what is
  visible. The duplication was real and 39 DOM cases refused it.
- **A workspace mount pointing somewhere large or hostile.** Bounded by the same scanner limits
  every other root has, and writable by the operator only. The hosted refusal for *repo-declared*
  external mounts is unchanged — this spec narrows nothing that exists.
- **Double-indexing the corpus on `loki-labs`.** Prevented by the real-path dedupe, which is the
  one part of D3 with a test that fails loudly if it regresses.
- **The `cez` wrapper drifting from the deploy layout.** If `/opt/cezar` ever moves, the wrapper
  breaks silently and the prompt goes back to promising a dead command. Verification step 6 runs
  `cez kb search` as the `cezar` user *after* deploying, so a redeploy that moves the tree fails
  the check rather than the next agent.

## Verification

Automated (must be green before deploy):

1. `todo-task-text.test.ts` — the seven existing fixture cases produce byte-identical output
   (proves the legacy path did not move), plus new cases for context-only, whatToDo-only,
   acceptance-criteria-only, knowledgeRefs-only, all-four-together, and blank/whitespace fields
   contributing nothing.
2. A test asserting `makeRunTitle(todoTaskText(fullTodo), quickTask)` still equals the summary —
   the regression that would otherwise turn every task title into a wall of markdown.
3. `filed-tasks`/`global-tasks` lib tests — `inFlightGlobalTasks` returns waiting/review/running/
   queued/auto-resuming and excludes done/failed/cancelled/archived; ordering matches `sortRuns`;
   the archived view yields nothing.
4. `global-tasks.test.tsx` — the Running section renders above the Filed section in DOM order
   (asserted on document order, not on the presence of both), is absent on Archived, and is absent
   when nothing is in flight.
5. Knowledge root tests — a workspace mount outside every repo root **is** indexed under hosted;
   a repo-declared external mount under hosted is **still** refused (the negative control, without
   which the change reads as "external mounts now work"); a workspace mount whose real path equals
   a repo mount's is dropped, and the repo one keeps its id; root order is stable across two calls.
6. `knowledge/cli-wiring.test.ts` — `cez kb` reached through the REAL entry module in a
   subprocess: usage instead of `unknown command: kb`, `--json` accepted (the flag the strict
   top-level parser rejects), a bogus subcommand still refused, `cezar kb` in `--help`. Its own
   negative control is a mutation: stubbing the dispatch must turn it red, or it is testing
   nothing — run and confirmed.
7. `npm run typecheck` and `npm test` green.

Runtime E2E on production, executed against `cockpit.example.com` (this is the gate — until it has
passed this ships as QA Needed, per AGENTS.md):

8. `sudo -u cezar cez kb search "digest"` on the box returns hits, from a `chat` worktree cwd —
   proves both D4 and D3 in one command, and is the exact invocation the run above failed on.
9. `GET /api/v1/p/chat/knowledge` lists the corpus root with a non-zero document count.
10. In a real browser: `/tasks` opens with Running above Filed; press **Start** on a filed task that
   carries a `context`/`whatToDo`; the resulting run's `task` field contains the `## What to do`
   section, and the thread's first user message shows it.
11. Re-run the owner's own task (`73c0400a-…`) — it is the reason this exists, and its brief
    explicitly asks for cross-plane evidence the first attempt never saw.
