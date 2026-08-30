# Land the Backlog composer

**Status:** implemented, QA verified; exact-SHA production deployment and live behavior verification remain pending.
**CORRECTED 2026-08-30:** The Backlog composer is on `origin/main` at `78295445`; the retained
branch is an ancestor and must not be reapplied. Typecheck, three full root test runs, unit,
build, package, and the focused browser E2E passed. Production currently serves `5d59a16f`, so
exact-SHA activation and live behavior verification remain pending for the manual deploy step.
**Status:** implemented, QA needed until the merged-tree gates and runtime E2E pass. Written 2026-08-24 for run `235c9e50-6ac4-4d0b-a96e-55cad81a7908`.
**Supersedes nothing.** It is the landing plan for `.ai/specs/2026-08-22-backlog-add-without-starting.md`,
which stays the design record for the feature itself. Its `Status:` is now implemented, QA needed,
with landed SHA `c406f2fa`; it must not be called deployed until the browser, full-gate, and
production verification criteria below pass.
**Brief:** `.ai/specs/briefs/2026-08-24-backlog-composer-recovery.md` (step 1 of this run).

## TLDR

The Backlog composer is **already written** and lives on retained branch `cez/15ff402b`
(tip `b5bd0d4e`, merge base with `origin/main` = `504ce87f`). It is seven files, no server change,
no contract change. It did not land because workspace settlement failed, and that failure also
**reverted live state in three real checkouts** — including the cezar checkout production is
deployed from. So this is not a feature spec, it is a landing spec, in five ordered phases:

0. **Recover** `/var/lib/cezar/loki-labs`, `/var/lib/cezar/loki-labs/chat` **and
   `/var/lib/cezar/loki-labs/cezar`** — their git *indexes* hold reverts, and tracked files
   (including four source files in the cezar checkout) are gone from disk. That third checkout is
   the tree Phase 5 rsyncs to production, so skipping it turns the deploy into a regression.
1. **Merge** `cez/15ff402b` into current `origin/main` (`b3d3a44c` at the time of writing; re-read
   it at execution time). `git merge-tree` already proves this is textually clean.
2. **Fix catalog C18** with a host-calibrated budget instead of the absolute 40 ms/MiB line, so
   the root gate is genuinely green rather than green-with-a-known-red.
3. **Prove it in a browser** with a new `packages/web/e2e/backlog-composer.e2e.ts`, plus **Phase
   3a**: one attribute, `data-slot="mode-backlog"`, on the Backlog radio in `new-task.tsx`. The
   retained markup gives that button no `data-slot` and no `aria-label`, and `AgentBrowser` drives
   `document.querySelector`, so without 3a the E2E has nothing to click. Phase 3 is therefore not
   test-only.
4. **Gate, commit, push, deploy** the exact landed SHA through the blue-green path and verify it in
   `/api/v1/health` and in the live bundle.

**Two traps this spec adds that nobody has written down yet**, both of which turn the browser proof
into a test that passes without proving anything:

1. **The Filed board cannot see a todo filed into the boot project**, because boot never registers
   its own launch directory — `suppressBootRegistration()` is unconditional
   (`packages/cezar/src/index.ts:535`) — while `GET /workspace/todos` reads the registry only. The
   E2E must be built around a registered non-boot fixture or it asserts against an empty board.
2. **`GET /api/v1/runs` is not "all runs" — it is the boot project's runs.** `resolveProjectScope`
   binds an absent `:projectId` straight to `bootContext` (`server.ts:2095-2100`), and the same
   `v1` app is mounted twice, scoped and unscoped (`:7368-7369`). So the "no run was started"
   assertion has to be `GET /api/v1/p/fixture/runs`; the unscoped spelling reads a different
   project's store and returns `[]` whether or not the composer wrongly started a run.

Both are the same failure mode this repo already shipped once and had to spec its way out of
(`.ai/specs/2026-08-22-deploy-e2e-probe-vacuous-pass.md`), which is why Phase 3 carries an explicit
non-vacuity guard and V5a carries a negative control.

## Problem

### P1 — the feature is written and unshipped

`git diff 504ce87f cez/15ff402b --stat` is exactly seven files:

```
 .ai/specs/2026-08-22-backlog-add-without-starting.md   | 357 +++++
 packages/web/src/api/client.test.ts                    |   8 +
 packages/web/src/api/client.ts                         |  13 +
 packages/web/src/routes/new-task-draft.test.ts         |  40 ++-
 packages/web/src/routes/new-task-draft.ts              |  15 +-
 packages/web/src/routes/new-task.test.tsx              |  66 +++-
 packages/web/src/routes/new-task.tsx                   |  93 ++++--
```

The feature is **absent from `cezar/main`** — `git grep planFirst origin/main -- packages/web`
still finds the two-state toggle at `new-task.tsx:354,542,697,824,852-854,1439-1477`. Nothing of
the retained work is on the mainline.

### P2 — the failed settlement reverted live doctrine

Measured directly, 2026-08-24, in the real checkouts (not a worktree):

**`/var/lib/cezar/loki-labs` (branch `main`, no remote):**

```
MM AGENTS.md
MM CLAUDE.md
D  tools/doctrine-sync
```

The **index** (`git diff --cached`) is a revert of commit `8e69427` *"docs: the box is the record
for workspace doctrine, reconciled by hand"*. It deletes the `THE RECORD FOR THIS FILE IS THE BOX`
banner, deletes the entire `## Project Knowledge & Tasks` production-cutover section, restores the
pre-2026-08-22 *"You are most likely reading this ON the cezar production box"* wording and the
dead *"Authenticated is not deployable"* claim, and deletes `tools/doctrine-sync` (70 lines).
`tools/doctrine-sync` is **also gone from disk** — `ls /var/lib/cezar/loki-labs/tools/` shows only
`notion-export/` and `reports-drain/`.

The **worktree**, by contrast, is HEAD **plus two legitimate 2026-08-24 doctrine corrections** that
must be kept: the `fs.watch`-does-not-index correction (`CORRECTED 2026-08-24`, the
`CEZ_KB=1 cez kb reindex` requirement) in `CLAUDE.md`, and the `No backward compatibility: don't,
and don't ask` scope rewrite in `AGENTS.md`. Both are already loaded into agent context on this
box, so they are current truth, not contamination.

**So the index is wrong and the worktree is right.** A `git checkout .` or `git reset --hard` here
destroys real doctrine; a `git commit` here ships a revert of the record. Neither is safe, which is
why the brief said not to reset blindly.

**`/var/lib/cezar/loki-labs/chat` (branch `main`, level with `origin/main`):**

```
D  .ai/specs/SPEC-531-2026-08-22-shared-agent-instruction-files.md
```

Staged deletion, and the file is gone from disk. It exists at `HEAD`
(`git cat-file -e HEAD:.ai/specs/SPEC-531-...` → 0; added by `137fdb84`, phase-3 note `d2547816`).
That spec is what `CLAUDE.md`, `AGENTS.md` and `tools/doctrine-sync` all cite as the reason the box
is the record — deleting it orphans three live references.

**`/var/lib/cezar/loki-labs/cezar` (branch `main`, HEAD `b3d3a44c` = `origin/main`) — the checkout
Phase 5 deploys from, and the one an earlier measurement of this damage missed entirely:**

`git status --short` shows **38 paths, all fully staged** (`M `/`D ` in column 1, column 2 blank),
`git diff --cached --stat` reads **239 insertions / 4515 deletions**, and `git diff --stat`
(unstaged) is **empty** — so unlike `loki-labs`, the worktree here already matches the reverted
index and the deleted files are gone from disk. This one stages deletion of **source**, not only
docs:

```
D  packages/web/src/routes/task-thread/handoff-card.tsx        (81 lines)
D  packages/web/src/routes/task-thread/handoff-card.test.tsx   (84 lines)
D  packages/cezar/src/workflows/handoff-gate.test.ts
D  packages/cezar/test/e2e/deploy-e2e-probe.test.ts
```

All four verified absent from disk, 2026-08-24. Alongside them it stages reverts of
`packages/cezar/src/server/server.ts`, `workflows/run.ts`, `workflows/types.ts`,
`workflows/postconditions.ts`, `core/codex-approvals.ts`, `runs/store.ts`, `config.ts`,
`packages/contract/src/{runs,workflows,workspace}.ts`, `packages/web/src/api/client.ts`,
`routes/settings/agents-section.tsx`, `routes/task-thread/task-thread.tsx`, plus deletion of four
2026-08-24 specs — one of which, `.ai/specs/2026-08-22-deploy-e2e-probe-measured-assertions.md`, is
cited as precedent by this very spec.

Because the worktree holds **nothing worth preserving** here (the unstaged diff is empty), the safe
recovery verb is `chat`'s, not `loki-labs`'s. See Phase 0 — and note that this checkout is the
`--source=` of the Phase 5 rsync, so recovering it is a *deploy* precondition, not housekeeping.

Nothing in any of the three repos is unrecoverable: every deleted byte is at `HEAD`, and `git
reflog` in `loki-labs` still shows `8e69427` at `HEAD@{0}`.

### P3 — catalog C18 is a standing red on this host

`packages/cezar/src/knowledge/catalog.test.ts:324` asserts:

```ts
expect(bestMs / totalMiB).toBeLessThan(40);
```

`AGENTS.md:338-350` (trap 3) records the measurement: on this EPYC-Rome host the same code reads
**54-65 ms/MiB with the machine idle**, reproduced at clean `HEAD a6c0ba3e` with none of any change
under test present. Todo `d9ebe916-4f0b-4a57-8cb3-608013e8aa60` records the run-`15ff402b` failure
at **73.726 ms/MiB** and pins the acceptance shape:

> "uses a measured per-host baseline while retaining meaningful regression detection"
> "passes on prod-host without skipping C18 or widening an absolute constant"

The test already defends against ambient *load* — CPU time not wall clock, minimum of three warmed
repeats — and that defence works. It cannot defend against a slower **core**, because the numerator
is a real duration and the denominator is bytes. Nothing in the ratio knows how fast this machine
is.

### P4 — the acceptance criteria demand a browser proof that nothing in the repo has ever done

No E2E spec in `packages/web/e2e/` visits the global `/tasks` route or touches
`data-slot="filed-tasks"` (`grep -rn "filed-tasks\|'/tasks'" packages/web/e2e/*.ts` → no hits).
And the naive way to write it fails silently — see "The Filed-board trap" below.

## Solution

### Phase 0 — recover the three real checkouts

Determined entirely by the measurement above; no judgement left at execution time.

**`/var/lib/cezar/loki-labs`:**

```bash
cd /var/lib/cezar/loki-labs
git diff --cached --stat > /tmp/cez-recover-loki-index-before.txt   # evidence, keep
git reset                                    # index -> HEAD. MIXED. Worktree untouched.
git checkout HEAD -- tools/doctrine-sync     # restore the deleted script (index + worktree)
git status --short                           # expect exactly: " M AGENTS.md" and " M CLAUDE.md"
git diff --stat                              # expect ~15 lines AGENTS.md, ~39 lines CLAUDE.md
```

`git reset` with no `--hard` and no paths is the whole recovery for the index: it moves the index to
`HEAD` and does not touch the working tree, so the two legitimate doctrine corrections survive
untouched. `git checkout HEAD -- tools/doctrine-sync` then brings back the one file whose worktree
state was genuinely destroyed rather than improved.

Then **commit the surviving doctrine edits** — they are current truth sitting uncommitted in the
record repo, which is exactly the drift `CLAUDE.md` forbids:

```bash
git add AGENTS.md CLAUDE.md
git commit -m "docs: corpus writes need an explicit reindex; no-backcompat scope is every repo"
```

(No remote exists here — `CLAUDE.md` §"Corrected 2026-08-14" — so there is nothing to push.)

**`/var/lib/cezar/loki-labs/chat`:**

```bash
cd /var/lib/cezar/loki-labs/chat
git checkout HEAD -- .ai/specs/SPEC-531-2026-08-22-shared-agent-instruction-files.md
git status --short        # expect EMPTY
```

One command, because for that path the index *and* the worktree are both wrong and `HEAD` is right.
Do **not** commit in `chat` — after this the tree matches `HEAD` and there is nothing to commit.

**`/var/lib/cezar/loki-labs/cezar` — and this block must run BEFORE Phase 5**, because
`server-deploy --source=/var/lib/cezar/loki-labs/cezar` rsyncs exactly this tree into the next
release:

```bash
cd /var/lib/cezar/loki-labs/cezar
git diff --cached --stat > /tmp/cez-recover-cezar-index-before.txt   # evidence, keep
git checkout HEAD -- .      # index AND worktree back to HEAD
git status --short          # expect EMPTY
```

`git checkout HEAD -- .` — the `chat` verb, **not** `loki-labs`'s `git reset`. `git reset` alone
would move the index back to `HEAD` and leave all 38 files in their reverted state *on disk*,
including the four deleted source files, which is precisely the tree that must never be shipped.
Restoring both sides loses nothing here because the worktree carries no legitimate edits (unstaged
diff empty, measured above).

**Ownership gate**, per `CLAUDE.md` ("write as `cezar` by construction"):

```bash
find /var/lib/cezar -not -user cezar | wc -l     # MUST be 0
```

Phase 0 touches no cezar code and can ship on its own.

### Phase 1 — land the retained branch on current `origin/main`

`git merge-tree --write-tree origin/main cez/15ff402b` exits **0**. Re-measured 2026-08-24 against
the current `origin/main` (`b3d3a44c`) it writes tree `a4f685c4`; an earlier draft of this spec
pinned `24cadf3e` against `587db317`, which is now one docs-only commit behind (`b3d3a44c`
*"docs: record deployed codex approval bypass"*, touching no `packages/` file). **Do not compare
against either hash at execution time** — re-run the merge-tree against whatever `origin/main` then
is, and require only that it exits 0 and emits no `CONFLICT` lines. A pinned tree hash reads as a
mismatch the moment `main` moves again, which it will. The reason the merge is clean, verified by
reading both sides rather than trusting the exit code — `origin/main`'s only edits to the four
merge-sensitive files since `504ce87f` are:

| File | `origin/main` change since `504ce87f` | Overlaps the composer hunks? |
| --- | --- | --- |
| `packages/web/src/api/client.ts` | +52 lines, new functions elsewhere in the file | No. `createTodo` is inserted after `getTodos` (`:794`), untouched by that delta. |
| `packages/web/src/routes/new-task.tsx` | +3: `useEngineAdvisory` import, `const engineAdvisory` at `:289`, `advisory={engineAdvisory}` at `:767` | No. The composer's hunks are at the `runMode` resolution (`:354`), `submit()` (`:532`), the composer props (`:710`), the `AutonomousToggle` (`:846`), `ModeSegment` (`:874`, `:1462+`). |
| `packages/web/src/routes/new-task.test.tsx` | 6 lines | No. Retained edits are the `planFirst` literals and appended cases. |
| the other three | unchanged on `origin/main` | — |

Method: **merge, do not rebase.** `cez/15ff402b` carries two `cezar autosave (run finalize)`
commits; a rebase would rewrite retained history that the brief says must be preserved, and the
merge is clean anyway.

**Two merges, in this order — and the second one is the one that lands the feature.** This worktree
sits on `cez/235c9e50`, which is an *ancestor* of `origin/main` (`git log origin/main..HEAD` is
empty) and does **not** contain the retained work (`git merge-base --is-ancestor cez/15ff402b HEAD`
→ exit 1). So merging `origin/main` alone merely fast-forwards the branch and lands **none** of the
composer:

```bash
cd <this worktree>
git fetch origin
git merge --ff-only origin/main          # brings the branch current. Lands NO feature work.
git merge --no-ff cez/15ff402b           # THIS lands the composer. Still no rebase.
npm ci                                    # see the environment scrub below; NEVER under NODE_ENV=production
```

Phase 1 ends when `git diff origin/main --stat` names exactly the seven retained files plus
whatever Phases 2-4 add, and typecheck is green.

### Phase 2 — make C18 host-relative

**The mechanism: a sibling baseline measured in the same process, on the same corpus, in the same
run.** Replace the absolute `bestMs / totalMiB < 40` with an **overhead ratio**:

```
overhead = catalogCpuMs / baselineCpuMs
```

where `baselineCpuMs` is a fixed reference pass over the *same* generated files doing a strict
**subset** of what `buildCatalog` does per file: `readFile` it, split lines, run one global
`/SPEC-\d+/g` scan and one `/\[\[[^\]]+\]\]/g` scan, and count matches. It deliberately omits YAML
frontmatter parsing, heading extraction and the link-graph resolution pass — those are precisely the
per-file costs the C18 comment itemises as the real work, and they are what the ratio measures.

Why this satisfies the todo's two clauses:

- **Host-relative.** Both numbers are durations produced by the same CPU, the same JIT, the same
  page cache, in the same seconds. A slower core, a loaded box, a different NUMA node raises both
  and cancels out of the quotient. That is the exact failure mode `AGENTS.md` trap 3 describes and
  the absolute constant cannot address.
- **Still a regression detector.** A change that makes the index 20% more expensive per byte raises
  the numerator and not the denominator, so the ratio moves ~20%. The signal the todo says must not
  be destroyed is preserved in full — arguably sharpened, since the denominator also absorbs
  fs-layer noise.

Shape of the replacement, at `catalog.test.ts:250-330`:

```ts
// NOTE: `files` does not exist yet. The current C18 writes each fixture inside a loop with a
// local `path` and accumulates only `totalBytes` (`catalog.test.ts:274-289`), so the first edit
// is to collect the paths — `const files: string[] = []`, pushed in that loop — giving the
// baseline the same corpus to re-read.
// `files` DOES NOT EXIST YET. Today's C18 writes each fixture inside a loop holding only a local
// `path`, accumulating just `totalBytes` (catalog.test.ts:274-289) — collect the paths into a
// `const files: string[] = []` in that same loop first, so the baseline re-reads the same corpus.
// Measured adjacently inside each attempt so ambient load hits both halves equally.
let bestCatalogMs = Number.POSITIVE_INFINITY
let bestBaselineMs = Number.POSITIVE_INFINITY
for (let attempt = 0; attempt < 3; attempt++) {
  const bCpu = process.cpuUsage()
  await referenceScan(files)                       // the subset pass, defined in-file
  const b = process.cpuUsage(bCpu)
  const cCpu = process.cpuUsage()
  const built = await buildCatalog([root('project', dir, { writable: true })])
  const c = process.cpuUsage(cCpu)
  bestBaselineMs = Math.min(bestBaselineMs, (b.user + b.system) / 1_000)
  bestCatalogMs = Math.min(bestCatalogMs, (c.user + c.system) / 1_000)
  documents = built.documents
}
const overhead = bestCatalogMs / bestBaselineMs
expect(documents).toHaveLength(fileCount)
expect(
  overhead,
  // The historical absolute number stays VISIBLE in every failure, so the 2026-08-06 reference
  // (31.7 ms/MiB) and the 2026-08-20 host measurement (54-65) remain comparable forever.
  `index build overhead ${overhead.toFixed(1)}x baseline ` +
    `(absolute: ${(bestCatalogMs / totalMiB).toFixed(1)} ms/MiB, historical line 40)`,
).toBeLessThan(OVERHEAD_MAX)
```

**`OVERHEAD_MAX` is a measured constant and this spec does not invent its value.** No benchmark was
run in the spec step. Phase 2's first task is the measurement, on `prod-host`, at the Phase 1
tree, with the environment scrub applied:

1. Three samples running the file alone: `npx vitest run packages/cezar/src/knowledge/catalog.test.ts`.
2. Three samples inside a full `npm test`.
3. `OVERHEAD_MAX = round_up_to_0.1(max_of_six × 1.15)`.
4. **Accept only if `max_of_six / min_of_six ≤ 1.20`.** If the spread is wider, the ratio is as
   load-dependent as the wall clock was and this mechanism is **rejected**. Do **not** fall back to
   widening a constant or skipping the case — that is the failure the todo exists to forbid.
   The **named second candidate**, to be tried only then: *serialize the measurement instead of
   normalizing it* — move C18 into its own vitest project (or a `describe.sequential` file run with
   `--poolOptions.threads.singleThread`), so the 3x contention swing the C18 comment documents never
   occurs and an absolute per-MiB budget becomes meaningful again, re-baselined on this host against
   the 54-65 ms/MiB idle figure in `AGENTS.md` trap 3. If **both** fail, acceptance criterion 1 is
   reported **unmet**, todo `d9ebe916` stays open, and Phase 2 ships nothing rather than shipping a
   budget that cannot detect a regression.
5. **Negative control, mandatory:** temporarily double the identifier-regex pass inside
   `buildCatalog`, confirm the case goes red, revert. A budget that has never failed on purpose has
   not been shown to detect anything.
6. Record all six samples, the spread, `OVERHEAD_MAX`, and `lscpu | grep 'Model name'` in this
   spec's Verification log and in the todo's closure note.

**Rename the case.** Its title today is `'stays under 40ms CPU and 2MiB resident per MiB of scanned
corpus'` (`catalog.test.ts:270`), which becomes false the moment the budget is a ratio. Rename it to
something like `'index build stays within a measured multiple of a same-process baseline scan'`, so
a failure report cannot quote a budget that no longer exists.

Also update `AGENTS.md:338-350` **in place**, per the workspace correction rule: a bolded
`CORRECTED 2026-08-24` lead-in on trap 3 saying the budget is now a host-relative ratio and a red
C18 is once again a statement about your diff. Leave the original text below it.

**Implementation result for Phase 2, 2026-08-24:** the ratio candidate was rejected after the
first five samples ranged from 4.2x to 5.9x baseline, a max/min spread of 1.39. The fallback is
implemented with `describe.sequential` and the repository's supported `CEZ_VITEST_MAX_WORKERS=1`
measurement mode. Serialized samples were 39.7, 44.7, and 51.4 ms/MiB, producing
`C18_MAX_MS_PER_MIB = 59.2` after 15% headroom. Vitest 4 rejects the documented
`--poolOptions.threads.singleThread` CLI spelling, so it is not used. The required negative control
doubled the catalog parse pass, failed at 81.8 ms/MiB, and was reverted. The current `buildCatalog`
has no identifier-regex pass, so the nearest load-bearing parse pass is the honest control.

Phase 2 is independently shippable, and it touches one test file plus one doctrine paragraph.

### Phase 3 — the browser proof

#### The Filed-board trap (read this before writing the test)

`GET /api/v1/workspace/todos` is served by `packages/cezar/src/server/workspace-todos-routes.ts`,
whose index is built from `listProjects()` — and `listProjects()`
(`packages/cezar/src/workspace/projects.ts:420-428`) returns `config.projects` from the workspace
registry, nothing else. Meanwhile **boot never registers its own launch directory**:

```ts
// packages/cezar/src/index.ts:535 — the second conjunct is unconditionally false
if ((await shouldRegisterProject(repoRoot)) && !suppressBootRegistration()) {
  const entry = await registerAndAdoptProject(repoRoot, { bindHost });
```

`suppressBootRegistration()` is unconditional — its own doc comment (`index.ts:553`, citing D3 /
`.ai/specs/2026-08-07-org-scoped-tasks-knowledge.md`) says so explicitly — so that
`registerAndAdoptProject` call is dead on the boot path and the launch root never reaches
`config.projects`. **That, and not `registerProject`'s boot short-circuit, is the cause.** The
short-circuit at `projects.ts:241-250` only fires when a caller passes `bootProject`, and no boot
path does; an earlier draft of this spec cited it while reaching the right conclusion. No non-test
caller registers the serve root either (`grep -rn registerProject src --include=*.ts | grep -v
'\.test\.ts'` finds only the `POST /projects` route and the CLI seam).

**Beware one stale comment while writing this test:** `packages/web/e2e/agent-browser.ts:50-52`
still claims the opposite — *"booting in an unregistered folder APPENDS it to
`~/.cezar/config.json`"*. It does not, per the gate above. Do not design the fixture around it.

The retained component test encodes the true fact in its fixture: `projects: { projects: [], bootProject:
'default', … }` — an empty list beside a boot project.

**Consequence:** a spec that boots `cezar serve --repo <fixture>`, files a todo into the boot
project and then asserts the Filed board renders it will find an **empty board**, and a test written
as "the row is not absent" would pass vacuously. This repo has already been bitten by exactly that
class of bug — `.ai/specs/2026-08-22-deploy-e2e-probe-vacuous-pass.md` and its follow-up
`2026-08-22-deploy-e2e-probe-measured-assertions.md`.

#### The design

New file `packages/web/e2e/backlog-composer.e2e.ts`, modelled on `new-task.e2e.ts:48-100`'s
`beforeAll` (own free port, own `cezar serve` child, own `AgentBrowser` session, `waitForHealth`).
Its own file rather than an added `it` in `new-task.e2e.ts`, because that file's specs share one
browser and one sticky localStorage draft, and leaving `runMode: 'backlog'` behind would change the
meaning of every later spec in it.

Two fixture roots, not one:

- `hostRoot` — a throwaway git repo the server boots on (`--repo hostRoot`).
- `projectRoot` — the project under test, a real git repo with an initial commit.

Before spawning the server, seed the hermetic registry that `fixtureServeEnv` points at
(`CEZ_HOME = <dataRoot>/.cez-home`, `agent-browser.ts:60-65`):

```ts
mkdirSync(cezHome, { recursive: true })
writeFileSync(join(cezHome, 'config.json'), JSON.stringify({
  projects: [{ id: 'fixture', root: realpathSync(projectRoot), name: 'fixture',
               addedAt: new Date(0).toISOString(), source: 'local' }],
}), 'utf8')
```

`realpathSync` because `registerProject`/`probeRoot` normalise roots and a `/tmp` symlink would make
the registry entry and the request scope disagree. If pre-seeding proves brittle, the fallback is
`POST /api/v1/projects { root: projectRoot }` after boot — which works here **only because
`projectRoot` is not the boot root**, and would silently no-op if it were.

The spec body, in order:

```ts
it('a project-scoped Backlog submit files exactly one unstarted todo and lands on the global Filed board', async () => {
  // 0. NON-VACUITY GUARD. Prove the board can see this project at all, before asserting on it.
  const before = await (await fetch(`${baseUrl}/api/v1/workspace/todos`)).json()
  // `ok` matters as much as `id`. A registered but unreadable project is still LISTED, with
  // `ok: false` and a `reason` (`workspaceProjectHealthSchema`,
  // `packages/contract/src/workspace-runs.ts:76-83` — `{id, name, status, ok, reason?, total}`),
  // so an id-only guard passes for a project whose rows the board can never render.
  expect(before.projects?.some((p) => p.id === 'fixture' && p.ok === true)).toBe(true)
  expect(before.todos).toHaveLength(0)   // and the board starts EMPTY, so step 6 measures this
                                          // submit and not a leftover
  // 1. Compose.
  browser.goto(`${baseUrl}/p/fixture/new`)
  browser.waitForFunction(`document.querySelector('[data-route="new"]') !== null`)
  browser.click('[data-slot="mode-backlog"]')   // attribute ADDED by Phase 3a below — it does not
                                                // exist on cez/15ff402b. See that section.
  browser.waitForFunction(
    `document.querySelector('[data-slot="mode-backlog"]').getAttribute('aria-checked') === 'true'`,
  )
  browser.fill('[data-slot="composer"] textarea', 'File this from the browser, do not start it.')
  browser.screenshot(`${artifactsDir}/backlog-composer-armed.png`)

  // 2. Submit — the button label proves the mode is live, not just painted.
  browser.click('[aria-label="File task"]')

  // 3. Navigation: GLOBAL /tasks, no /p/ prefix. This is the acceptance criterion verbatim.
  browser.waitForFunction(`location.pathname === '/tasks'`)

  // 4. EXACTLY ONE, and UNSTARTED — asserted from the API, not the DOM.
  const todos = await (await fetch(`${baseUrl}/api/v1/p/fixture/todos`)).json()
  expect(todos).toHaveLength(1)
  expect(todos[0].summary).toBe('File this from the browser, do not start it.')
  expect(todos[0].status).toBeUndefined()
  expect(todos[0].startedTaskId).toBeUndefined()
  expect(todos[0].origin).toBe('composer')
  expect(todos[0].author?.via).toBe('todo-create-route')

  // 5. NO RUN STARTED — the other half of "without starting it".
  //    MUST be the SCOPED spelling. `GET /api/v1/runs` (unscoped) does NOT mean "all runs": the
  //    resolver binds an absent `:projectId` straight to `bootContext`
  //    (`packages/cezar/src/server/server.ts:2095-2100`, and both mounts share it at `:7368-7369`),
  //    and `bootContext` is `hostRoot` — NOT `fixture`. A run wrongly started by this submit is
  //    started through `/api/v1/p/fixture/runs`, so it would land in fixture's store and the
  //    unscoped read would report 0 either way. That assertion is vacuous; this one is not.
  expect(await (await fetch(`${baseUrl}/api/v1/p/fixture/runs`)).json()).toHaveLength(0)
  //    Step 4 above is what makes THIS non-vacuous: `/api/v1/p/fixture/todos` returning the row
  //    proves `fixture` resolves to a real, distinct project context rather than 404ing or
  //    silently falling back to boot. Keep the two in this order.
  //    Secondary, and cheap: nothing leaked into the boot project either.
  expect(await (await fetch(`${baseUrl}/api/v1/runs`)).json()).toHaveLength(0)

  // 6. The row actually RENDERS in Filed (this is what step 0 made non-vacuous).
  browser.waitForFunction(
    `document.querySelector('[data-slot="filed-tasks"]')?.textContent.includes('File this from the browser')`,
  )
  expect(browser.count('[data-slot="filed-tasks-empty"]')).toBe(0)
  browser.screenshot(`${artifactsDir}/backlog-filed-row.png`)
}, 90_000)
```

Filed-board selectors read from `packages/web/src/routes/global-tasks.tsx:787+`:
`filed-tasks`, `filed-tasks-count`, `filed-tasks-empty`, `filed-tasks-cards`, `filed-tasks-table`.

**Artifacts: screenshots only.** The retained spec's verification section asks to "retain both a
screenshot of the Filed row and the full video". `AgentBrowser` has `screenshot()`
(`agent-browser.ts:226-237`, which itself fails on a zero-byte file) and **no video or recording
operation at all** — `grep -n 'video\|record' packages/web/e2e/agent-browser.ts` finds nothing. So
the video requirement is **not satisfiable with this harness**; the spec records that plainly rather
than reporting a retained video that does not exist. Two screenshots into
`.ai/qa/artifacts_e2e/` (the directory `new-task.e2e.ts:22` already uses) are the retained evidence.

#### Phase 3a — the one non-test change this phase needs (so Phase 3 is NOT test-only)

**The Backlog radio is unaddressable from a CSS selector as it stands on `cez/15ff402b`.** Read at
`cez/15ff402b:packages/web/src/routes/new-task.tsx:1514-1528`, the third segment is:

```tsx
<button
  type="button"
  role="radio"
  aria-checked={mode === 'backlog'}
  onClick={() => onModeChange('backlog')}
  className={cn(…)}
>
  Backlog
</button>
```

No `data-slot`. No `aria-label`. Its only distinguishing feature is its **text content**, and
`AgentBrowser.click()` / `waitForFunction()` go through `document.querySelector`, which is CSS —
CSS has no accessible-name or text-content selector. So the earlier draft's
`[role="radio"][aria-label="Backlog"]` matches **nothing**, and the E2E would fail at step 1 (or,
worse, a `, …` fallback would silently hit the wrong segment). The sibling `Plan first` segment does
not have this problem precisely because it carries `data-slot="mode-plan"`
(`cez/15ff402b:…new-task.tsx:1501`), which is exactly what `plan-mode.e2e.ts:120-142` drives.

**The change:** add one attribute, `data-slot="mode-backlog"`, to that button, following the
`mode-plan` precedent verbatim. Do **not** add an `aria-label` — the visible text already supplies
the accessible name, and an `aria-label="Backlog"` duplicating it is redundant markup the repo does
not use here.

Two consequences to state plainly rather than discover during implementation:

- **Phase 3 touches `new-task.tsx`, so it is not test-only.** The Phases table records it as such.
  The file is already one of the seven retained files, so V1's expected `git diff --stat` file list
  does not change — but the phase's blast radius does, and a reviewer reading "test-only" would be
  misled.
- **No existing test needs updating.** The retained component tests select this control by role and
  accessible name — `const backlogToggle = () => screen.getByRole('radio', { name: 'Backlog' })` at
  `cez/15ff402b:packages/web/src/routes/new-task.test.tsx:1573`, and
  `screen.queryByRole('radio', { name: 'Backlog' })` at `:1650`. Adding a `data-slot` attribute
  changes neither the role nor the accessible name, so both keep passing unchanged. Verified by
  reading those tests, not assumed.

If for any reason the attribute cannot be added, the fallback is a text scan via
`browser.evaluate` (`[...document.querySelectorAll('[data-slot="mode-seg"] [role="radio"]')].find(b
=> b.textContent.trim() === 'Backlog')`), driven by index rather than by selector. It is strictly
worse — it cannot be handed to `click()` directly and it couples the test to segment order — and is
recorded here only so the implementation does not invent a third option.

#### One risk checked and cleared

A sticky `runMode: 'backlog'` cannot hijack the bookmarklet auto-start path. The `auto=1` effect
(`new-task.tsx`, `origin/main`, the `useEffect` at `:419-467`) calls `createRun(bookmarkletRunBody(…))`
directly and never reads `draft.runMode`. Read, not assumed. `plan-mode.e2e.ts:120-142,262-264`
drives `[data-slot="mode-plan"]`, which the retained diff preserves verbatim including
`aria-busy` and the `bg-contrast` class assertion — so that spec is unaffected too.

### Phase 4 — gates

`.ai/agentic.config.json`'s `validation.commands`, in order, from the repository root, **with the
environment scrub** (`AGENTS.md:265-300` — traps 1, 2 and 4 all fire in a cezar agent worktree and
none of them names its own cause):

```bash
scrub=$(env | sed -n 's/^\(CEZ_[A-Z0-9_]*\)=.*/\1/p' \
        | grep -vxE 'CEZ_(HANDOFF_FILE|TASK_ID)' | sed 's/^/-u /')
tmp=/tmp/cez-gate-$$ && mkdir -p $tmp
run() { env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp "$@"; }
run npm ci
run npm run typecheck        # contract, client, server, web
run npm test                 # vitest run — MUST include a green C18
run npm run test:unit        # node --test; NOT covered by vitest.setup.ts's scrub
run npm run build            # writes packages/cezar/dist/.build-stamp.json — required by deploy
run npm run test:package     # node --test
run npm run test:e2e         # must print TEST_E2E_STATUS=passed
```

Two documented pre-existing failures that are **not** this change and must be reported as such
rather than silently absorbed: `npm run test:package` case 5
(`packages/cezar/test/e2e/package-cli.test.ts:86`, `AGENTS.md:367-370`, reproduces at clean HEAD),
and `test:e2e` printing `TEST_E2E_STATUS=skipped` when the agent-browser provider cannot be
provisioned. **A `skipped` E2E does not satisfy acceptance criterion 2** — `.ai/scripts/e2e.sh:19-33`
says so in its own banner ("This is NOT a pass"). If the browser cannot be provisioned on this host,
say so and leave the criterion open; do not round it up.

Then one commit for the whole feature, and push to **`origin` only** (never `upstream`):

```bash
git commit -m "feat: file a task to the backlog from the composer (2026-08-22-backlog-add-without-starting)"
git push origin HEAD:main
LANDED=$(git rev-parse HEAD)
```

### Phase 5 — deploy the exact landed SHA and verify

Path for `prod-host`, from `AGENTS.md:13` (the corrected bullet — the older `dist`-swap +
`kill -9` recipe above it would corrupt a release here, because `/opt/cezar` is a symlink into
`/opt/cezar-releases/`):

```bash
export XDG_RUNTIME_DIR=/run/user/999 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/999/bus
systemd-run --user --unit=cez-deploy-${LANDED:0:8} --collect --property=Type=oneshot \
  --working-directory=/var/lib/cezar/loki-labs/cezar \
  --setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  /usr/bin/node packages/cezar/dist/index.js server-deploy --strategy=blue-green \
  --source=/var/lib/cezar/loki-labs/cezar --sha=$LANDED --refuse-dirty
```

`--refuse-dirty` is not decoration: it is the only thing that turns "the source checkout is clean"
from a precondition someone has to remember into one the deploy enforces (`release-deploy.ts:428`,
`:612`).

A **user** transient unit, not a system one: `cezar` is correctly denied the root system unit, and
the user slice puts the deploy outside `cezar.service`'s cgroup so `decideReExec` runs it inline.

Preconditions, each of which fails the deploy loudly rather than shipping stale bytes:

- **The real checkout `/var/lib/cezar/loki-labs/cezar` must be clean, at `$LANDED`, and freshly
  built — and the build-stamp gate will NOT catch it if it is not.** `stage` is an rsync, not a
  build. Since `362865ec`, `server-deploy` refuses to stage when `.build-stamp.json` is missing,
  stale against `packages/*/src`, or names a SHA that disagrees with the source checkout's HEAD
  (`release-deploy.ts:90-128`, gated at `:391-405`) — but **dirtiness is not part of that gate by
  default**: `release-deploy.ts:428` fails on `stamp.dirty` only when `options.refuseDirty` is set,
  and `:480` otherwise just logs `WARNING: build stamp records a dirty source tree`. So a rebuild
  performed inside the still-damaged checkout of P2 would stamp `sha == $LANDED`, satisfy every
  gate, and rsync the reverted tree — four deleted source files and all — into production. Run
  these in order and treat each as a hard stop:

  ```bash
  cd /var/lib/cezar/loki-labs/cezar
  git status --short                                     # MUST be EMPTY (Phase 0's third block)
  git fetch origin && git merge --ff-only origin/main    # or: git checkout $LANDED
  test "$(git rev-parse HEAD)" = "$LANDED" || { echo 'source checkout is not at $LANDED'; exit 1; }
  npm ci && npm run build                                # with the Phase 4 environment scrub
  jq -r '.sha, .dirty' packages/cezar/dist/.build-stamp.json   # MUST print $LANDED, then false
  ```

  The stamp is already stale today — it reads `sha 34163544` while HEAD is `b3d3a44c` — so the
  rebuild is required, not optional. Then pass **`--refuse-dirty`** to `server-deploy` so the
  cleanliness precondition is *enforced by the tool* rather than merely requested by a spec.
- If `package.json` / `package-lock.json` changed, a `dist`-only ship is insufficient. This change
  touches neither, but check rather than assume.

Verification, all four required:

```bash
curl -s http://127.0.0.1:<port>/api/v1/health | jq '.ok, .deploy'
#   .deploy.sha        MUST equal $LANDED          (contract: packages/contract/src/health.ts:220)
#   .deploy.releaseId  the new 2026…Z-<sha8> id
#   .deploy.activatedAt within this minute
curl -s .../api/v1/ready                          # readiness, the same probe rollback now uses
```

1. `/api/v1/health` `ok: true` and `deploy.sha == $LANDED` — **string equality against the pushed
   SHA**, not "a recent deploy exists".
2. **The live bundle carries the feature.** Fetch the served web asset and grep the built JS for the
   `Backlog` segment label and the `File task` aria-label. A green health check proves a release
   flipped; it does not prove *this* release contains the composer.
3. **Live behaviour**, once, by hand in the production cockpit: `/p/cezar/new` → Backlog → submit →
   lands on `/tasks` → the row is in Filed with no run started. Then delete the probe todo.
4. `find /var/lib/cezar -not -user cezar | wc -l` → `0`.

Rollback if any of the four fails: `cezar server-deploy --rollback` (bare spelling works since
`.ai/specs/2026-08-23-bare-rollback-argv-trap.md`; `--rollback=` also still works), which since
`2f91de4b` probes `/api/v1/ready` after the restart and reports failure distinctly.

## Architecture

Unchanged from the retained spec — restated here only to make the landing reviewable without
switching branches.

```
/new composer   (draft.runMode: 'start' | 'plan' | 'backlog', localStorage, DRAFT_VERSION 2)
      │
      ├─ 'start'   → createRun(…)                → navigate(startedRunPath(created))   [unchanged]
      ├─ 'plan'    → postPlan(…) → PlanReview    → startPlanned() → createRun(…)       [unchanged]
      └─ 'backlog' → createTodo({summary, origin:'composer'})     ← the only new client call
                          │
                          ▼
              POST /api/v1/p/:projectId/todos        server.ts:6119  (ungated, UNCHANGED)
                          │  createTodoInputSchema + authorOf(c, 'todo-create-route')
                          ▼
              <project>/.ai/cezar/todos.json         status:'todo', no startedTaskId
                          │
        ┌─────────────────┴──────────────────────────────┐
        ▼                                                ▼
  GET /p/:id/todos  → project view              GET /workspace/todos → Filed board
                                                 (registry-scoped — see the trap above)
```

Nothing below `POST /todos` is new; `cezar todo add` has exercised it since
`.ai/specs/2026-08-19-file-tasks-from-a-running-task.md`.

**Correction to the brief:** it cites the create route at `server.ts:6078-6103`. On current
`origin/main` the chain is at `:6101` and `.post('/todos', …)` is at **`:6119`**; `:6105` is the
`GET`. The route is the same route; only the line moved.

## Data models and API contracts

**No wire change, in either direction.** Confirmed by reading the contract, not the brief:

- `createTodoInputSchema` / `createTodoResponseSchema` — `packages/contract/src/skills.ts:138-155`.
  `summary: z.string().min(1)` is the only required key. This feature sends `summary` and `origin`
  and nothing else.
- `origin: z.enum(['agent','composer'])` — `skills.ts:106`. The `'composer'` value already exists
  and is already written by `workspace-reports-routes.ts:322-324`. Provenance, not a unique
  analytics discriminator; `author.via === 'todo-create-route'` is what distinguishes an HTTP-route
  todo from `cli-todo-add`.
- `CreateTodoInput` / `CreateTodoResponse` are already generated into
  `@loki-labs/better-cezar-api-client`.

**One client-only model change**, `packages/web/src/routes/new-task-draft.ts:41-46,140,203-210`:

```ts
- planFirst: boolean
+ runMode: 'start' | 'plan' | 'backlog'
```

with a read-side fallback in `normalize()` — `obj.runMode` when it is one of the three literals,
else legacy `obj.planFirst === true ? 'plan' : 'start'`. No `DRAFT_VERSION` bump: old code could
never have written a value the new reader misreads. A tri-state rather than a second boolean because
two booleans can encode `{planFirst: true, backlog: true}`, which has no meaning.

Naming hazard carried by the retained diff and worth keeping: `resolveComposerRunMode`'s own local
`const runMode` (`new-task.tsx:355`) returns `{autonomous, worktree}` and is **not** the draft's
`runMode`. `ComposerRunModeInput.planFirst` stays a boolean and is fed
`draft.runMode === 'plan'`. The retained code comments this inline at `:358-360`; keep that comment.

## Phases

| # | Phase | Independently shippable? | Done when |
| --- | --- | --- | --- |
| 0 | Recover `loki-labs` + `chat` + `cezar` checkouts | Yes, touches no cezar source | `chat` and `cezar` both `git status --short` EMPTY; `loki-labs` shows only the two intended doctrine edits, then committed; `tools/doctrine-sync`, `SPEC-531`, `handoff-card.tsx`(+test), `handoff-gate.test.ts` and `deploy-e2e-probe.test.ts` back on disk; `find … -not -user cezar` → 0. **Blocks Phase 5** — the `cezar` checkout is the deploy `--source=` |
| 1 | Merge `cez/15ff402b` into `origin/main` | Yes | `git diff origin/main --stat` = the seven retained files; `npm run typecheck` green |
| 2 | C18 host-calibrated budget + `AGENTS.md` trap-3 correction | Yes, unrelated to the composer | ratio rejected by the spread gate, serialized budget measured, negative control trips, `npm test` green |
| 3 | `backlog-composer.e2e.ts` **+ Phase 3a** (`data-slot="mode-backlog"` on `new-task.tsx`) | Yes, but **not test-only** — 3a is a one-attribute component change the E2E cannot be written without | `TEST_E2E_STATUS=passed`, two screenshots retained, `mode-backlog` present in the built bundle |
| 4 | Full gates, one commit, push to `origin` | No — needs 1-3 | all eight commands run, the two known pre-existing failures reported as such, `$LANDED` recorded |
| 5 | Blue-green deploy + verify + close the records | No — needs 4 | `health.deploy.sha == $LANDED`, bundle grep hits, live submit files one todo, records updated |

**Phase 5 record-keeping** (same session as the code, per `CLAUDE.md` §"Project Knowledge & Tasks"):

- Keep `.ai/specs/2026-08-22-backlog-add-without-starting.md`'s `Status:` at implemented, QA needed,
  naming landed SHA `c406f2fa` and the outstanding failed or skipped verification. Change it to
  implemented-and-deployed only after V4 through V6 pass.
- Close todo `d9ebe916-4f0b-4a57-8cb3-608013e8aa60` with the six C18 samples.
- Corpus changelog entry under `notion-export/`, **then**
  `cd /var/lib/cezar/loki-labs && CEZ_KB=1 cez kb reindex` and grep the slug in
  `.ai/cezar/knowledge-index/catalog.ndjson` — a corpus write is not a KB write until it is indexed
  (`CLAUDE.md`, `CORRECTED 2026-08-24`).

## Risks

- **Recovering `loki-labs` with the wrong verb destroys current doctrine.** `git checkout .`,
  `git reset --hard`, or `git stash` all discard the two 2026-08-24 corrections that only exist in
  that worktree. Mitigation: `git reset` (mixed) is the *only* index-clearing command in Phase 0,
  and the phase saves `git diff --cached --stat` to `/tmp` first.
- **C18's ratio could be as noisy as the wall clock was.** Mitigated by the explicit ≤ 1.20 spread
  gate in Phase 2 step 4. That gate failed on this host, so the implementation uses the named
  serialized fallback and a measured 59.2 ms/MiB limit. The negative control proves the limit still
  detects a doubled catalog parse pass.
- **The E2E passes vacuously against an empty Filed board.** The registry trap above is the whole
  reason step 0 of the spec body exists. Precedent for taking it seriously:
  `.ai/specs/2026-08-22-deploy-e2e-probe-vacuous-pass.md`.
- **The E2E passes vacuously on the *no-run* half, for a different reason.** `GET /api/v1/runs`
  answers for the **boot** project, so it is empty no matter what the composer did in `fixture`.
  Mitigated by asserting the scoped `/api/v1/p/fixture/runs` (Phase 3 step 5), and caught by V5a's
  negative control, which is the only check that can distinguish "no run was started" from "this
  assertion cannot fail".
- **Phase 3a is easy to skip because it looks cosmetic.** A missing `data-slot="mode-backlog"` does
  not fail typecheck, lint or any unit test — the retained component tests query by accessible name
  and stay green — it fails only the browser E2E, at a `click` on a selector matching nothing, which
  reads like a flaky harness rather than a missing attribute. V5's `grep` is there so this is
  checked directly rather than diagnosed from a timeout.
- **`TEST_E2E_STATUS=skipped` read as a pass.** `.ai/scripts/e2e.sh` returns exit 0 for `skipped` by
  design, so a pipeline that checks only the exit code cannot tell them apart. Phase 4 greps the
  status line, not `$?`.
- **Deploying a stale `dist`.** Guarded in code since `362865ec`, but the incident that motivated
  that guard happened with the instruction already written down. Phase 5 checks the checkout is at
  `$LANDED` before invoking `server-deploy`.
- **Health green, feature absent.** A blue-green flip succeeds regardless of what is in the bundle.
  Mitigated by verification 2 (grep the served asset) and 3 (a real submit).
- **Scope creep back toward the rejected fan-out.** One Backlog submit must write exactly **one**
  todo, into the **currently scoped** project. `.ai/specs/2026-08-15-knowledge-grounded-task-fanout.md`
  is the design the owner rejected verbatim ("i don't want to have task per each project"), and KB
  `notion-82a85b288169` records that two-composer routing was reverted the day it shipped. The
  retained code already carries a warning comment on the `runMode === 'backlog'` branch — keep it.

## Verification

Concrete and executable, in the order they must run. Every command below is run from
`/var/lib/cezar/loki-labs/cezar` (or the stated checkout) with the Phase 4 scrub applied.

**V0 — recovery.**
```bash
git -C /var/lib/cezar/loki-labs/chat status --short                    # EMPTY
git -C /var/lib/cezar/loki-labs/cezar status --short                   # EMPTY  <- the deploy source
git -C /var/lib/cezar/loki-labs status --short                         # only " M AGENTS.md"/" M CLAUDE.md", then empty after commit
test -x /var/lib/cezar/loki-labs/tools/doctrine-sync && echo OK
test -f /var/lib/cezar/loki-labs/chat/.ai/specs/SPEC-531-2026-08-22-shared-agent-instruction-files.md && echo OK
# the four source files the cezar-checkout revert deleted, back on disk:
cd /var/lib/cezar/loki-labs/cezar &&
  test -f packages/web/src/routes/task-thread/handoff-card.tsx &&
  test -f packages/web/src/routes/task-thread/handoff-card.test.tsx &&
  test -f packages/cezar/src/workflows/handoff-gate.test.ts &&
  test -f packages/cezar/test/e2e/deploy-e2e-probe.test.ts && echo OK
grep -c 'THE RECORD FOR THIS FILE IS THE BOX' /var/lib/cezar/loki-labs/CLAUDE.md   # 1
grep -c 'CORRECTED 2026-08-24' /var/lib/cezar/loki-labs/CLAUDE.md                  # >= 1
find /var/lib/cezar -not -user cezar | wc -l                                        # 0
```

**V1 — merge integrity.** `git diff origin/main --stat` lists the seven retained files plus
`catalog.test.ts`, `AGENTS.md`, `backlog-composer.e2e.ts`, and this spec. Nothing else.

Expect `.ai/specs/2026-08-22-backlog-add-without-starting.md` among them as an **added** file:
it does not exist on `origin/main` (`git cat-file -e origin/main:.ai/specs/2026-08-22-backlog-add-without-starting.md`
→ exit 128, verified 2026-08-24), it arrives with the retained branch. Phase 5's "flip its `Status:`
line" therefore edits a file that exists only *after* the Phase 1 merge — do not go looking for it
before then, and do not recreate it.

**V2 — focused unit suites** (the retained tests, which must still pass against current `main`):
```bash
npx vitest run packages/web/src/api/client.test.ts \
               packages/web/src/routes/new-task-draft.test.ts \
               packages/web/src/routes/new-task.test.tsx
```
Named cases that must be green, all present on `cez/15ff402b`:
- `client.test.ts` request-shape row `createTodo` → `POST /api/v1/todos`, body
  `{summary:'File this', origin:'composer'}`.
- `new-task-draft.test.ts` → *"migrates legacy planFirst drafts and preserves a fresh backlog
  choice"*: `{planFirst:true}` → `'plan'`, `{planFirst:false}` → `'start'`, absent → `'start'`,
  `{runMode:'backlog'}` round-trips.
- `new-task.test.tsx` → *"files one task without starting or planning, invalidates every todo board,
  and navigates globally"*: asserts `location() === '/tasks'`, the POST body, **no** `/api/v1/runs`
  call, **no** `/api/v1/plan` call, `workspaceTodos` query `isInvalidated`, draft text cleared.
- `new-task.test.tsx` → *"hides Backlog for a workspace run…"*: under `?scope=auto` the Backlog radio
  is absent, `Start` is checked, textarea disabled.
- `new-task.test.tsx` provider-gate case: with no provider, Backlog is selectable, the textarea is
  enabled, and the `File task` button is enabled.

**V3 — C18.** The ratio candidate was measured on the AMD EPYC-Genoa host at 4.2x, 5.9x, 4.4x
(focused samples) and 5.9x, 5.3x (full-suite samples before the ratio gate was already disproven),
which is a 1.39 max/min spread and therefore rejected. The implemented serialized fallback was
measured at 39.7, 44.7, and 51.4 ms/MiB with `CEZ_VITEST_MAX_WORKERS=1`, so the constant is 59.2.
The focused fallback run passed with 13 tests. The negative control temporarily duplicated the
catalog parse pass and failed at 81.8 ms/MiB, then the change was reverted and the focused run
passed again. The installed Vitest 4 rejects `--poolOptions.threads.singleThread`, so the supported
worker cap is the recorded serialization mechanism.

**V4 — full gates.** The eight commands in Phase 4. `npm test` green **including C18**. Report the
two known pre-existing failures explicitly if they recur.

**V5 — browser E2E.** `npm run test:e2e` prints `TEST_E2E_STATUS=passed`, `backlog-composer.e2e.ts`
passes, and `.ai/qa/artifacts_e2e/backlog-composer-armed.png` and `backlog-filed-row.png` are
non-empty. If the provider cannot be provisioned, the criterion stays open and is reported open.

Two assertions inside it carry the weight, and a reviewer should check they are spelled as written
rather than trusting a green run (both were defects in an earlier draft of this spec):

```bash
# 3a landed, so the E2E's click target actually exists:
grep -n 'data-slot="mode-backlog"' packages/web/src/routes/new-task.tsx        # exactly 1
# the no-run assertion is SCOPED — an unscoped /api/v1/runs read binds to the boot project
# and is vacuous (server.ts:2095-2100):
grep -n 'api/v1/p/fixture/runs' packages/web/e2e/backlog-composer.e2e.ts       # exactly 1
# and the board-visibility guard checks health, not just presence in the list:
grep -n "p.ok === true" packages/web/e2e/backlog-composer.e2e.ts               # exactly 1
```

**V5a — the E2E fails when the feature is broken (negative control).** A passing E2E proves nothing
about a test that cannot fail; the deploy-probe incident
(`.ai/specs/2026-08-22-deploy-e2e-probe-vacuous-pass.md`) is this repo's own precedent. Before
accepting V5, temporarily change the `runMode === 'backlog'` branch in `new-task.tsx:535` to fall
through to the Start path, re-run `backlog-composer.e2e.ts`, and confirm it goes **red** — it should
fail at step 3 (`location.pathname === '/tasks'` never becomes true) or step 5 (fixture's run list
is no longer empty). Revert the change and confirm green again. Record both outcomes.

**V6 — production.** `health.deploy.sha == $LANDED`; `/api/v1/ready` green; the served bundle
contains the `Backlog` label, the `File task` aria-label **and the `mode-backlog` slot from Phase
3a** (three independent strings, so a partial build cannot read as a pass); one manual submit in the production
cockpit files exactly one todo with no run, lands on `/tasks`, and the row shows in Filed; the probe
todo is then deleted; `find /var/lib/cezar -not -user cezar | wc -l` → 0.

**V7 — the checkouts are still clean at the end, and this is the LAST recorded step.**
```bash
git -C /var/lib/cezar/loki-labs       status --short   # only intended, committed doctrine state
git -C /var/lib/cezar/loki-labs/chat  status --short   # EMPTY
git -C /var/lib/cezar/loki-labs/cezar status --short   # EMPTY
find /var/lib/cezar -not -user cezar | wc -l           # 0
```

This runs *after* V6, not instead of V0, and its result is written into the handoff before the run
is called done. The reason it exists: the settlement that damaged all three checkouts runs at **run
finalize**, i.e. after the last step's own verification, and the previous run recorded itself
**completed** with that damage in place. A clean V0 therefore proves nothing about the state this
run leaves behind. If V7 is dirty, the run is not done regardless of V1-V6 — recover per Phase 0 and
report the damage explicitly rather than closing over it.

## What was read, and what was not

**Read directly for this spec:** `cez/15ff402b` full diff against `504ce87f` (all seven files);
`origin/main` versions of `new-task.tsx`, `client.ts`, `new-task.test.tsx` (read at `587db317`,
re-checked at `b3d3a44c`, which changes no `packages/` file);
`git merge-tree --write-tree origin/main cez/15ff402b`; `catalog.test.ts:225-330`;
`.ai/cezar/todos.json` entry `d9ebe916-…`; `AGENTS.md:7-13,265-370,640-647`;
`packages/cezar/src/server/server.ts:6100-6140`; `workspace-todos-routes.ts` (whole);
`packages/cezar/src/workspace/projects.ts:229-268,420-428`;
`packages/web/e2e/{new-task.e2e.ts,agent-browser.ts,workspace-registry.ts}` and the file listing;
`.ai/scripts/e2e.sh`; `packages/web/src/routes/global-tasks.tsx:500-560,675-850`;
`packages/contract/src/health.ts:220`; root `package.json` scripts; the live git state of
`/var/lib/cezar/loki-labs` and `/var/lib/cezar/loki-labs/chat` including index, worktree and reflog;
`.ai/specs/briefs/2026-08-24-backlog-composer-recovery.md`.

**Read in the second revision, to settle the two Phase 3 defects the review raised** (all re-read
live on 2026-08-24, not carried over from the earlier draft):
`cez/15ff402b:packages/web/src/routes/new-task.tsx:1465-1530` — the whole `RunModeSegment`, which is
where the missing `data-slot` was confirmed: `mode-plan` has one at `:1501`, `Start` and `Backlog`
have none, and neither has an `aria-label`; `cez/15ff402b:…new-task.tsx:700-760` — the `Composer`
`sendAriaLabel` prop, which is what makes `[aria-label="File task"]` a real attribute selector
(same file drives `button[aria-label="Start task"]` through `querySelector` at `:497`, so this is
precedent, not inference); `cez/15ff402b:packages/web/src/routes/new-task.test.tsx:1573,1636-1677` —
the retained tests select by role + accessible name, which is why Phase 3a breaks none of them;
`packages/cezar/src/server/server.ts:2086-2127` (`resolveProjectScope`), `:1610-1625`
(`bootContext`), `:4991` (`GET /runs`), `:6083` (`GET /todos`, a bare array — hence
`toHaveLength`), `:7118` and `:7368-7370` (the two mounts of one `v1` app) — together these are the
proof that an unscoped `/api/v1/runs` reads the BOOT project and not the fixture;
`packages/contract/src/workspace-todos.ts:29-42` and
`packages/contract/src/workspace-runs.ts:73-84` — the `{todos, projects}` response and the
`{id,name,status,ok,reason?,total}` health entry behind the strengthened step-0 guard;
`packages/web/e2e/plan-mode.e2e.ts:110-150` — the existing `data-slot="mode-plan"` drive this
follows; `origin/main:packages/web/src/routes/global-tasks.tsx` Filed selectors re-confirmed at
`:787,790,807,813,840`.

**Not read, and therefore not relied on:** `.ai/agentic.config.json` itself (its `validation.commands`
list is quoted from `AGENTS.md:280-284`, which states the five entries); the full text of
`2026-08-15-knowledge-grounded-task-fanout.md` and `2026-08-19-file-tasks-from-a-running-task.md`
(the brief and the retained spec quote them; the owner's verdict is quoted at second hand and marked
as such).

The implementation step also read `packages/cezar/src/knowledge/catalog.ts` and confirmed that
`buildCatalog` has no identifier-regex pass. This is why the negative control duplicates the catalog
parse pass instead.

**CORRECTED 2026-08-24, implementation step:** the earlier spec-step note below predates this
implementation. The C18 measurements, fallback decision, negative control, recovery, merge, and
focused test are now recorded above. Full merged-tree gates, browser runtime E2E, build, package
gate, commit, push, deploy, and production verification remain for later workflow steps.

**Not measured in the spec step, and stated rather than invented:** no benchmark, build, test,
deploy, recovery or commit was run in the spec step. `OVERHEAD_MAX` had no value in that step. The
31.7 / 54-65 / 73.7 ms/MiB figures below are quoted from the C18 comment, `AGENTS.md:342-345` and
todo `d9ebe916` respectively, not re-measured there.

**Not found:** no KB entry keyed exactly `2026-08-22-backlog-add-without-starting`; no video or
screen-recording capability anywhere in `packages/web/e2e/agent-browser.ts`; no non-test caller of
`registerProject` that would put a serve-boot root into the workspace registry.

## Out of scope

Unchanged from the retained spec, restated so a reviewer does not have to switch branches:
`/workspace/new` (a note→triage pipeline with no file-only state); `startWorkspaceRun`; the Filed
board's own quick-add control (that spec's deferred Phase 4); richer creation fields (`context`,
`acceptanceCriteria`, `priority`) in the human UI; any change to `--start` / `autostart` /
`cezar todo add`.

Added by this spec: **no telemetry sink is built.** `todo.filed` remains the `TODO(analytics)` it is
in `2026-08-19-file-tasks-from-a-running-task.md`; there is no analytics sink in this codebase to
emit into, and inventing one is not this change.
