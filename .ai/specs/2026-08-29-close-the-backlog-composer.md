# Close The Backlog Composer

- **Status:** Specified (no code written, no gate run, no deploy performed by this step)
- **Date:** 2026-08-29
- **Task:** `1f02b61d-6f55-4b7f-a6e9-c929ab407eaf`, workflow `spec-to-deploy`, branch `cez/1f02b61d`
- **Brief:** step 1 of this run left `.ai/specs/briefs/2026-08-29-backlog-composer-current-state.md`.
  It is **untracked in the shared checkout and staged-but-uncommitted here**, so it is not a
  durable citation. Every claim below is cited against a primary source that is in the tree or was
  measured on this box during this step, and each measurement names its time.
- **Completes:** `.ai/specs/2026-08-22-backlog-add-without-starting.md` (the design record, still
  `implemented, QA needed`) and `.ai/specs/2026-08-24-land-the-backlog-composer.md` (the landing
  plan, whose Problem section is now factually stale). This document is the **verification and
  closure** record, following the split this repo already uses
  (`.ai/specs/2026-08-25-verify-bulk-start-release.md`,
  `.ai/specs/2026-08-29-verify-active-backlog-e2e.md`,
  `.ai/specs/2026-08-29-verify-logged-out-fallback.md`).
- **Task statement (verbatim):** "CORRECTED 2026-08-24: workspace settlement failed and this work is
  not merged. … The Backlog composer implementation remains preserved on retained branch
  `cez/15ff402b`, and the feature is absent from `cezar/main`. Do not redo or discard the
  implementation. Recover the partially applied real checkouts first, then apply the retained
  feature to current `origin/main`. Remaining work: resolve or correctly rebaseline catalog C18,
  complete browser runtime E2E, run all merged-tree gates, deploy the exact landed SHA through the
  documented blue-green mechanism, and verify health plus live Backlog behavior."

## TLDR

**The task statement's premise is false, and the whole of it was falsified by measurement before
this spec was written.** The Backlog composer is on `origin/main`, its C18 rebaseline is on
`origin/main`, its dedicated browser E2E is on `origin/main`, and **production is already serving
it**: `/api/v1/ready` reports `sha: bb97df43…` activated `2026-08-29T18:23:51.179Z`, `/opt/cezar`
symlinks to `/opt/cezar-releases/20260829T182347Z-bb97df43`, and the live bundle
`/opt/cezar/packages/cezar/web/dist/assets/index-Bgn8T_Ac.js` contains the string `mode-backlog`
(all measured 2026-08-29 during this step).

So this is not a recovery task and not an implementation task. Nothing may be merged from
`cez/15ff402b` — `git diff origin/main...cez/15ff402b` is empty and its tip `b5bd0d4e` is an
ancestor of `origin/main`. What is genuinely unfinished is **four executions and one repair**:

1. the merged-tree gates have never run on this box against the landed tree, and **C18 is the one
   with a real chance of failing here** — the landed budget is 59.2 ms/MiB while `AGENTS.md`
   records this host at 54–65 ms/MiB idle;
2. `packages/web/e2e/backlog-composer.e2e.ts` has never actually executed anywhere — every prior
   run reported `TEST_E2E_STATUS=skipped`, and the fix that makes a browser launch here only
   landed on 2026-08-29;
3. one real checkout still carries residue from the 2026-08-24 failed settlement:
   `/var/lib/cezar/loki-labs` has an unstaged deletion of `tools/doctrine-sync`;
4. the record now contradicts itself in four places (the landing spec's P1, the design spec's
   Status, `AGENTS.md` trap 3, and two todos), and a session reading it today is told the feature
   is unmerged.

Five phases, ordered, and **not equally durable**. Phase 2's test-only change and Phase 4's
in-repository record edits are one commit: they reach `origin/main` together, after every gate is
green, or not at all. Only two kinds of work survive a fail-closed stop, because neither routes
through the commit — the Phase 0 repair of the `/var/lib/cezar/loki-labs` checkout, and Phase 4's
todo and corpus writes, which go to shared state outside this repo. Phase 5 (deployment) is very
likely **already satisfied for the feature** and needs only an activation for this run's own commit
(the record repair plus one test-only line that makes C18 report its number on success — see
Architecture).

## Problem

### P1 — the task statement is stale in every factual clause

Measured 2026-08-29 in this worktree, after `git fetch origin`:

```
origin/main = bb97df43fa2a2c320cc06b9a009fee8af9b75542
```

`git merge-base --is-ancestor <x> origin/main` exits 0 for **every** commit the task statement
treats as unlanded: `cez/15ff402b`, `b5bd0d4e` (its tip), `48f9892c` (the feature commit,
`feat: land the Backlog composer (2026-08-24-land-the-backlog-composer)`), `c406f2fa` (the landing
merge), and the follow-ups `53af6a51`, `d033c5d2`, `33ea5803`. `git diff --stat
origin/main...cez/15ff402b` prints nothing.

The feature is present in current source, read directly on `origin/main`:

| Claim | Evidence |
| --- | --- |
| Third composer mode exists | `packages/web/src/routes/new-task-draft.ts:46` — `runMode: 'start' \| 'plan' \| 'backlog'` |
| Legacy drafts normalize | `new-task-draft.ts:215-218` — `obj.planFirst === true` fallback |
| Backlog submit files a todo | `packages/web/src/routes/new-task.tsx:551-557` — `createTodo({ summary: text, origin: 'composer' })`, toast, then the Filed route |
| The client function exists | `packages/web/src/api/client.ts:807-815` — `cez.api.v1.p[':projectId'].todos.$post` |
| The button says what it does | `new-task.tsx:737-749` — label `File task`, and the provider gate is lifted for Backlog outside workspace scope |
| Project-scoped only | `new-task.tsx:904` — under `workspaceActive` a sticky `backlog` choice is coerced to `start` |
| The E2E has a click target | `new-task.tsx:1578-1583` — `data-slot="mode-backlog"`, `aria-checked` |
| Unit coverage landed | `packages/web/src/routes/new-task.test.tsx:714`, `:1575`, `:1590`, `:1638-1652`, `:1667` |

`.ai/specs/2026-08-24-land-the-backlog-composer.md` P1 still says *"The feature is **absent from
`cezar/main`**"* and prints a `git grep planFirst origin/main` as proof. That sentence was true on
2026-08-24 and is false now; it is the first thing a session reads, and it is what produced this
task's instruction to re-apply a branch that is already merged.

### P2 — what is actually unverified

- **The merged-tree gates have not run here.** This worktree has no `node_modules`
  (`ls -d node_modules` → ENOENT), is 0 commits ahead and 10 behind `origin/main`, and no gate
  output for the landed tree exists in the record.
- **C18 is the live risk, not a solved problem.** `packages/cezar/src/knowledge/catalog.test.ts:268`
  now pins `C18_MAX_MS_PER_MIB = 59.2` with serialized, CPU-time, minimum-of-three sampling
  (`:270-325`), and its own comment says the budget was "calibrated from the serialized host
  samples: 39.7, 44.7, and 51.4 ms/MiB, rounded up by 15%". `AGENTS.md:347-361` (trap 3, the
  retained historical entry) records that on **this** EPYC-Rome host the same code measures
  **54–65 ms/MiB with the machine idle**, reproduced at clean `HEAD` `a6c0ba3e` at **63.7 ms/MiB**.
  59.2 sits inside that band. So C18 may be green, red, or intermittent here, and **nobody has
  measured it on this box since the rebaseline**. `AGENTS.md:341-346` is explicit that a red C18
  after the correction "is again a statement about the diff" — which is exactly the reading this
  spec must not adopt blindly if the failure is host speed rather than a regression.
- **The browser E2E has never executed.** `packages/web/e2e/backlog-composer.e2e.ts` arrived with
  `48f9892c` and no run has produced a pass: `.ai/specs/2026-08-29-verify-active-backlog-e2e.md`
  states outright that `npm run test:e2e` "has never produced a pass on this box", and the most
  recent main-line merge `bb97df43` says of its own E2E, *"The E2E itself did NOT run here: no
  browser provider is provisioned on this Mac, and e2e.sh reports that as skipped, not passed."*
  `.ai/scripts/e2e.sh` exits **0** with `TEST_E2E_STATUS=skipped` in that case, which is why four
  months of green steps prove nothing about the UI.
- **This is now fixable, and only just.** The probe matrix that finds a launchable Chrome
  configuration (`.ai/scripts/test-env-up.sh:393-446`: four candidates over `--no-sandbox` × a short
  scratch `TMPDIR` from `mktemp -d /tmp/cez-e2e.XXXXXX`) and the D8 allowlist env
  (`packages/web/e2e/agent-browser.ts` `fixtureServeEnv`, which drops every inherited `CEZ_*` and
  `NODE_ENV` so `CEZ_PUBLIC_URL` cannot push a fixture boot into hosted mode) are **on
  `origin/main` as of 2026-08-29**. `AGENTS.md:503-561` independently records a working Playwright
  1.62.1 with Chromium on this box. The blocker that made every prior attempt skip is gone.

### P3 — real-checkout residue, and what is *not* ours

Measured 2026-08-29:

- **`/var/lib/cezar/loki-labs`** (branch `main`, no remote): `git status --short` is exactly
  ` D tools/doctrine-sync` — an **unstaged** deletion of a file that *is* tracked in `HEAD`
  (added by `8e69427`, 70 lines, `git diff --stat` → `1 file changed, 70 deletions(-)`). The
  `AGENTS.md`/`CLAUDE.md` dirt the task statement names is **gone**: both are clean, settled by
  `c7e0c7e`, `00fa0f4`, `d2143c7`. One file, fully recoverable from `HEAD`, no content at risk.
- **`/var/lib/cezar/loki-labs/chat`** (branch `main`, no merge in progress): 28 files,
  `217 insertions(+), 4354 deletions(-)` across index and worktree, index mtime
  **2026-08-25 08:52:35Z**. The one file this task's statement names,
  `.ai/specs/SPEC-531-2026-08-22-shared-agent-instruction-files.md`, is **not deleted** — it is
  present on disk as a staged **add** (`A `), absent from `HEAD`. Every staged deletion there
  (`.ai/deploy-targets.json`, `SPEC-532`, `SPEC-533`, `cart-claim-guard.ts`, `shopping-lists.ts`,
  migration `0028`, …) was verified recoverable with `git cat-file -e HEAD:<path>`. **This is a
  different failure, on another product's in-flight Grocey/cart-verify work, dated four days after
  the settlement this task is about.** Touching it is out of scope; leaving it unflagged is not,
  because a `git commit -a` in that checkout would erase 4,354 lines of committed work.
- **`/var/lib/cezar/loki-labs/cezar`** (the shared checkout task worktrees fork from) is at
  `0a46010b` with only untracked briefs — clean, but **10 commits behind `origin/main`**.
- **`/var/lib/cezar/deploy/cezar`** (the activation checkout) is at `bb97df43`, clean.

### P4 — the record contradicts itself

Four places, each read today:

1. `.ai/specs/2026-08-24-land-the-backlog-composer.md` P1: "absent from `cezar/main`" — false.
2. `.ai/specs/2026-08-22-backlog-add-without-starting.md:3` Status: still claims the authoritative
   gates are "red on reproduced shared drift" and that "browser runtime E2E was skipped … and
   production deployment plus live behavior verification remain pending". The deployment half is
   false (measured above); the E2E half is true.
3. `AGENTS.md:341-361` carries the C18 correction *and* its retained historical entry — correct
   practice, but neither has a post-rebaseline measurement **on this host**, which is the only
   number that settles whether C18 can gate here.
4. `/var/lib/cezar/loki-labs/cezar/.ai/cezar/todos.json` — **the shared checkout's store, by
   absolute path**. A worktree resolves its own task-scoped `todos.json` by git toplevel, and this
   worktree's `.ai/cezar/` holds only `knowledge-index/`, so the relative spelling reads a
   different file or none (the same trap
   `.ai/scripts/close-rollback-readiness-todo-2026-08-22.ts` documents in its header).
   `d9ebe916-4f0b-4a57-8cb3-608013e8aa60` ("Make catalog C18 performance budget host-relative",
   status `todo`) has **neither** acceptance clause met, and the landed rebaseline did not meet
   the first one. Clause 1 asks for "a measured per-host baseline while retaining meaningful
   regression detection"; what landed is a **hardcoded absolute constant** measured once on this
   host (`catalog.test.ts:268`), and the runtime per-host approach — the same-process ratio — was
   explicitly evaluated and **rejected** at `:265-267`. Clause 2 asks that root `npm test` pass
   here "without skipping C18 **or widening an absolute constant**", and reaching 59.2 widened one
   from 40. So it is open by design, not merely unmeasured.
   `30d9e835-f15f-4c9b-a0ef-624fbfc61cd4` (this task, status `in-progress`) carries the falsified
   recovery instructions verbatim.

## What bounds the design (read directly, not just cited)

- **The feature's contract is fixed and must not be redesigned.**
  `.ai/specs/2026-08-22-backlog-add-without-starting.md` requires one project-scoped submit to file
  exactly one unstarted todo, as a third mode of one composer, with no server or contract change.
  `.ai/specs/2026-08-25-composer-dispatch-mode.md:134-137` re-affirms it after the fact: the Backlog
  composer is "a single-project, filing-only composer mode. Different control, different scope; not
  repurposed."
- **`e2e.sh`'s skip is not a pass.** `.ai/scripts/e2e.sh` documents its own exit contract:
  `0 + TEST_E2E_STATUS=passed`, `0 + TEST_E2E_STATUS=skipped` ("This is NOT a pass"), and
  `non-zero + TEST_E2E_STATUS=failed`. Any verification claim in this run must quote the status
  line, never the exit code.
- **Two vacuous-pass traps are already guarded in the E2E, and the guards must not be relaxed.**
  `backlog-composer.e2e.ts` registers a non-boot `fixture` project in its own `CEZ_HOME` and asserts
  `before.projects.some(p => p.id === 'fixture' && p.ok === true)` before anything else, because
  boot never registers its own launch directory; and it asserts **both**
  `GET /api/v1/p/fixture/runs` and `GET /api/v1/runs` are empty, because the unscoped spelling binds
  to the boot project and would read `[]` either way. Both traps are written up in
  `.ai/specs/2026-08-24-land-the-backlog-composer.md` TLDR and
  `.ai/specs/2026-08-22-deploy-e2e-probe-vacuous-pass.md`.
- **The gates lie unless the environment is scrubbed.** `AGENTS.md:275-282` gives the exact recipe
  (unset every `CEZ_*` except `CEZ_HANDOFF_FILE`/`CEZ_TASK_ID`, unset `NODE_ENV`, point
  `TMPDIR`/`TMP`/`TEMP` at a directory under real `/tmp`). `AGENTS.md:311-332` records that inside a
  `.ai/cezar/worktrees/` tree an `NODE_ENV=production` install resolves upward into the parent
  checkout's `node_modules` and produces **1,979 plausible failures** naming none of the cause;
  the tell is `ls node_modules/.bin | wc -l` returning 13.
- **Deployment on this box is a manual, owner-gated activation.** `.ai/deploy-targets.json` marks
  **both** targets `"manual": true` (owner decision D6, `.ai/specs/2026-08-24-default-workflow-ten-stages.md`,
  commit `c328ec06`), with `activate: bash /var/lib/cezar/loki-labs/cezar/scripts/activate-main.sh`.
  `.ai/specs/2026-08-29-resolve-runs-the-deployment.md` keeps D6 intact and makes the cockpit's
  Resolve press *be* the person acting. A red deploy step with a manual handoff attached is a
  **park awaiting a human, not a failure** (`.ai/specs/2026-08-24-manual-deploy-not-a-bug.md`).
- **Activate `origin/main`, never a worktree.** The 2026-08-26 correction in
  `.ai/deploy-targets.json` (`.ai/specs/2026-08-26-activate-main-not-worktrees.md`) says the
  activation target is `/var/lib/cezar/deploy/cezar` reset to `origin/main`, not the shared checkout
  and not an unmerged worktree, and that one activation clears every parked run whose HEAD is an
  ancestor of it.
- **A corpus write is not a KB write until reindexed** (workspace `CLAUDE.md`): end any session that
  writes `notion-export/` with `cd /var/lib/cezar/loki-labs && CEZ_KB=1 cez kb reindex`.

## Solution

Do not merge, re-apply, or re-implement anything. Run the four things that were never run, repair
the one real checkout that still carries residue, and correct the record **in place** so the next
session is not sent to recover a branch that landed five days ago.

The only decision this spec has to make that is not already made for it is **what a red C18 means
here**, and it is made in advance, before the number is known, so the outcome cannot be rationalised
after the fact:

> **C18 decision rule.** Classify C18 from **three full root-gate runs** — `npm test` in its
> standard configuration, on the landed tree, under the `AGENTS.md` scrub, with the box otherwise
> quiet — extracting C18's result from each. **Not** from single-file runs. Root `vitest run`
> executes **four projects** (`vitest.config.ts:19-24`), and the `server` project that owns C18 sets
> `maxWorkers = halfParallelism()` (`packages/cezar/vitest.config.ts:14`) — **8 workers on this
> 16-core box** — while `describe.sequential` (`catalog.test.ts:269`) orders only the cases *inside*
> C18's own file, not the suites running beside it. So an isolated run measures a quiet machine and
> the gate measures a loaded one; the test's own comment records that exact gap (14.8 ms/MiB alone
> versus 21, 44 and 61 ms/MiB inside `npm test`), and `AGENTS.md:679-681` records C18 flaking "under
> load 5–7 on 8 cores". The acceptance criterion names root `npm test`, so the root gate is the
> condition that decides. Isolated single-file runs stay in the plan as **diagnostics only** —
> useful for separating host speed from contention once a verdict is in, never the basis of one.
> Then:
>
> - **All three green** → C18 gates on this host and no longer reads red here. Record the three
>   numbers and amend `AGENTS.md` trap 3 with them and with that fact. **Do not close `d9ebe916` on
>   this branch.** A green number satisfies neither of its clauses: 59.2 is a per-*this*-host
>   absolute constant, not the measured per-host baseline clause 1 asks for (the runtime-baseline
>   candidate was rejected at `catalog.test.ts:265-267`), and arriving at it widened an absolute
>   constant from 40, which clause 2 forbids in as many words. It also gives no regression signal on
>   a faster machine — the same code measures 31.7 ms/MiB on the Mac the reference figure came from
>   (`catalog.test.ts:250-262`), which is 47% under the line. Leave the todo open with the
>   measurement attached. Re-scoping or superseding it is a separate argument to make against its
>   clause text; it is not something a green run discharges, and closing it as met would write into
>   the record exactly the kind of falsehood Phase 4 exists to remove.
> - **All three red** → the budget does not fit this host under gate conditions. This is a **host**
>   statement, not a diff statement: the landed tree contains no change to `catalog.ts`, and the
>   negative control in V3 proves it. Do **not** widen the constant to fit (`AGENTS.md:356-361` —
>   that destroys the ~20% regression signal the case exists for). Record the three numbers plus the
>   isolated diagnostics, leave `d9ebe916` open with **both** clauses unmet and the fresh
>   measurement attached, and report root `npm test` as **red**, naming the case and its cause.
>   **Root `npm test` red means Phase 5's fail-closed precondition blocks landing** — nothing is
>   committed, pushed or activated, and the task ends **QA Needed** with the evidence preserved.
> - **Mixed** → the case is a coin flip at this budget and cannot gate anything. Same disposition as
>   all-red, including the landing block, with "intermittent" recorded explicitly, because an
>   intermittent gate is worse than a red one: it will read green for whoever reruns it next and
>   bury the finding.
>
> **Two different dependencies, and only one of them is severed.** *Causally*, the Backlog composer
> cannot move a knowledge-catalog build cost — it touches `packages/web/` only — so a red C18 is
> never evidence against the feature, and V3's negative control proves the direction.
> *Procedurally*, acceptance clause 1 says "Root `npm test` passes, **including catalog C18**, on
> the landed tree", so this task's closure **does** depend on C18 whatever its cause. Those are not
> in tension: the honest report is "the composer is verified; the gate this task was told to pass is
> red on an unrelated host-speed case", and that is a **QA Needed** outcome for the owner to settle,
> not a clause to declare met. What is forbidden in every branch is forcing the number green or
> quietly landing over it.

## Architecture

**One test-only source change, and no product change.** C18 computes `bestMs / totalMiB` and puts it
only in the vitest assertion *message* (`catalog.test.ts:322-325`), which vitest prints on failure
alone — so a **green** gate emits no number at all, and the decision rule above could not be applied
to the very branch it is most likely to hit. Phase 2 therefore adds a small, test-only emission of
that value in `packages/cezar/src/knowledge/catalog.test.ts` so every execution reports it. That is
a real, reviewable diff on the landed tree: **this run is not documentation-only**, and nothing
downstream (the commit message, the record repair, the deploy park) may describe it as such.
Nothing under `packages/web/`, nothing in `catalog.ts` itself, and no contract is touched — so the
negative control in V3 still holds. Otherwise the shape of the work is a verification pipeline over
an existing tree, plus a documentation repair:

```
origin/main (bb97df43)
  │
  ├─ Phase 0  recover /var/lib/cezar/loki-labs  (1 file, git restore)
  │           flag  /var/lib/cezar/loki-labs/chat (28 files, NOT ours)
  │
  ├─ Phase 1  worktree ← origin/main            (0 ahead, 10 behind → fast-forward)
  │           npm ci under the AGENTS.md scrub
  │
  ├─ Phase 2  instrument C18's ms/MiB (test-only diff) · typecheck ·
  │           root `npm test` ×3, C18 extracted from each · test:unit · build · test:package
  │
  ├─ Phase 3  npm run test:e2e  → TEST_E2E_STATUS must read `passed`
  │           artifacts: .ai/qa/artifacts_e2e/{backlog-composer-armed,backlog-filed-row}.png
  │
  ├─ Phase 4  record repair, in place:
  │             landing spec P1 · design spec Status · AGENTS.md trap 3 ·
  │             todos d9ebe916 + 30d9e835 · corpus + `cez kb reindex`
  │
  └─ Phase 5  deployment: already live at bb97df43 (measured).
              This run's own docs commit → land on main → park → Resolve/activate-main.sh
```

The one structural claim worth stating: **the feature's deployment and this run's deployment are
different questions.** Acceptance clause 4 asks that "the live bundle or behavior proves the Backlog
composer is present" — already true at `bb97df43`. This run's own commit still
has to reach production to clear this run's own deploy park, and that is the ordinary
activate-`main` path, not a second feature deployment.

## Data models and API contracts

**Unchanged. Nothing in this spec adds, removes, or reshapes a contract.** Recorded here because
the E2E pins them and a future edit must not drift from what is asserted:

- **`POST /api/v1/p/:projectId/todos`** — `createTodoInputSchema`
  (`packages/contract/src/skills.ts`): `summary: z.string().min(1)` is the only required field;
  `context`, `whatToDo`, `acceptanceCriteria`, `knowledgeRefs`, `priority` and
  `origin: z.enum(['agent', 'composer']).optional()` (`skills.ts:110`) are all optional —
  `origin` included, so the composer's `'composer'` is a value it chooses to send, not one the
  schema extracts from it. The composer sends exactly `{ summary, origin: 'composer' }`
  (`new-task.tsx:554`).
- **What a caller structurally cannot set.** `createTodoInputSchema` is
  `todoItemSchema.omit({ id, ts, taskId, startedTaskId, archivedAt, author, … })`
  (`skills.ts:170-176`). `author` is on that omit list deliberately — "an author a caller can set
  is forgeable, and a forgeable author is not provenance" — which is what makes the E2E's
  `author.via === 'todo-create-route'` assertion meaningful: it pins a **server-derived** value,
  so it cannot pass by the client having sent it.
- **The filed todo's shape, as asserted by `backlog-composer.e2e.ts`:** `summary` equals the typed
  text; `status` is **`undefined`** (absence *is* the unstarted state in the current contract — the
  E2E comments this deliberately); `startedTaskId` is `undefined`; `origin === 'composer'`;
  `author.via === 'todo-create-route'`.
- **`GET /api/v1/p/:projectId/runs` vs `GET /api/v1/runs`** — the scoped and unscoped mounts of the
  same v1 app; the unscoped one resolves to the boot project. Both must read `[]`.
- **`GET /api/v1/ready`** — carries `deploy: { releaseId, version, sha, activatedAt, builtAt,
  dirty }`, uncached by construction, 503 until ready. This is the deploy oracle; `/api/v1/health`
  is cached stale-while-revalidate and is the wrong endpoint for a gate
  (`.ai/deploy-targets.json`, correction of 2026-08-21).

## Phases

The phases are ordered, and each produces a verdict or a repair that a later failure does not
invalidate. But **"produced" is not "landed", and the difference decides what survives a
fail-closed stop in Phase 5** — so it is stated here rather than discovered at the end:

| | Work | Where it lands | Survives a red gate? |
| --- | --- | --- | --- |
| **Durable** | Phase 0 — `git restore tools/doctrine-sync` | the real `/var/lib/cezar/loki-labs` checkout | **Yes** — a separate repo, committed there or already clean |
| **Durable** | Phase 4 step 4 — the two todos | shared `/var/lib/cezar/loki-labs/cezar/.ai/cezar/todos.json`, via the lease | **Yes** — written by a script, not by this commit |
| **Durable** | Phase 4 step 5 — corpus + `cez kb reindex` | `notion-export/` and the KB index | **Yes** — outside this repo entirely |
| **Worktree-local** | Phase 1 — fast-forward, `npm ci` | this worktree | No — setup, nothing to land |
| **Worktree-local** | Phase 2 step 0 — the C18 emission | `catalog.test.ts`, uncommitted | **No** |
| **Worktree-local** | Phase 4 steps 1–3 — landing spec P1, design spec Status, `AGENTS.md` trap 3 | uncommitted files in this worktree | **No** |

The bottom three rows are the ones that matter: they are the corrections that stop the record from
telling the next session the feature is unmerged, and **they only take effect if Phase 5 lands**. A
run that stops fail-closed has not repaired `origin/main`, however complete its worktree looks.

### Phase 0 — recover the one real checkout that still carries residue

1. In `/var/lib/cezar/loki-labs`, as the `cezar` user: `git restore tools/doctrine-sync` (or
   `git checkout -- tools/doctrine-sync`). One tracked file, restored from `HEAD`, no content at
   risk. Confirm with `git -C /var/lib/cezar/loki-labs status --short` printing nothing and
   `test -x tools/doctrine-sync`.
2. **Do not touch `/var/lib/cezar/loki-labs/chat`.** Record its state in the closure note and in
   the handoff, with the measurement from P3, so the next owner of that work sees it: 28 files,
   4,354 staged deletions, index dated 2026-08-25, all recoverable from `HEAD`, `SPEC-531` present
   and staged-add. File it as a follow-up todo against the `Loki` product rather than fixing it
   blind — the deletions belong to Grocey/cart-verify work whose author's intent is unknown here.
3. `find /var/lib/cezar -not -user cezar | wc -l` → must be `0` (workspace `CLAUDE.md`).

Independently shippable: it removes a real, silent hazard from the doctrine repo regardless of
everything below.

### Phase 1 — reconcile the tree and install honestly

1. `git fetch origin && git merge --ff-only origin/main` in this worktree (0 ahead / 10 behind at
   the time of writing, so this is a fast-forward; if it is not, stop and re-read — a divergence
   means a concurrent run landed and the base moved, which
   `.ai/specs/2026-08-29-base-drift-rewinds-to-retest.md` already handles).
2. Install with the scrub, from `AGENTS.md:275-282`:

   ```bash
   scrub=$(env | sed -n 's/^\(CEZ_[A-Z0-9_]*\)=.*/\1/p' \
           | grep -vxE 'CEZ_(HANDOFF_FILE|TASK_ID)' | sed 's/^/-u /')
   tmp=/tmp/cez-gate-$$ && mkdir -p $tmp
   env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm ci
   ```
3. **Prove the install before believing any test result:** `ls node_modules/.bin | wc -l`. Thirteen
   means `NODE_ENV=production` won and the whole run is a lie (`AGENTS.md:311-332`).

### Phase 2 — the merged-tree gates, with C18 measured three times

**Step 0 — make C18 report its number on success.** Today `bestMs / totalMiB` reaches the operator
only through the assertion message (`catalog.test.ts:322-325`), which vitest shows on failure, so
three green runs would leave nothing to record and the decision rule would have no input. Add a
test-only emission immediately before the assertion — one line, in the test file, changing no
production code and no threshold:

```ts
console.log(`C18 index build cost ${(bestMs / totalMiB).toFixed(1)} ms/MiB (budget ${C18_MAX_MS_PER_MIB})`)
```

Keep the existing assertion and its message exactly as they are; this only adds an always-on
readout. It is a real diff and is committed with the rest of the run (see Architecture).

**Step 1 — typecheck**, under the `env -u NODE_ENV $scrub TMPDIR=$tmp …` prefix:
`npm run typecheck`. It runs first because `AGENTS.md` gate order puts it there and because a type
error makes every later measurement worthless.

**Step 2 — the three root-gate runs, which are the *only* `npm test` executions in this plan.**
The classification condition is the loaded one the gate actually creates, not a quiet single-file
run — and these same three runs are what V3 classifies C18 from **and** what V4 quotes as the
`npm test` gate result. Do not run a fourth "gate" pass: a separate `npm test` outside this loop
would be a fourth execution that V3 does not account for, and whichever colour it came out would
disagree with something.

```bash
for i in 1 2 3; do
  env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp \
    npm test 2>&1 | tee /tmp/c18-root-$i.log | grep -E 'C18|Test Files|Tests ' | tail -20
done
grep -h 'C18 index build cost' /tmp/c18-root-[123].log   # the three numbers that decide
```

The gate verdict for `npm test` is **all three green**; any red among them is a red gate, dispositioned
by the C18 decision rule if C18 is the failing case and by ordinary debugging if it is not.

**Step 2a — the remaining gates**, same prefix, in `AGENTS.md` order after `npm test`:
`npm run test:unit`, `npm run build`, `npm run test:package` (the last needs the completed build).

**Step 3 — diagnostics only, after the verdict.** If the verdict is red or mixed, run C18 in
isolation to separate host speed from contention, and label the result as a diagnostic that decides
nothing: `npm test -- packages/cezar/src/knowledge/catalog.test.ts -t 'C18'`.

Apply the **C18 decision rule** from the Solution section to the three **root-gate** numbers. Record
every `ms/MiB` figure verbatim, root and isolated, each labelled with which it is; a verdict without
its numbers is not a verdict, and a verdict from the wrong condition is worse than none.

### Phase 3 — execute the browser E2E for real

1. `env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm run test:e2e 2>&1 | tee /tmp/e2e.log`
2. **Read the status line, not the exit code:** `grep -c 'TEST_E2E_STATUS=passed' /tmp/e2e.log`
   must be 1. A `skipped` is a failure of this phase, and the reason is in
   `.ai/qa/test-env.json`'s `browser.notes`.
3. If the whole suite is too broad or another spec is red for unrelated reasons, narrow to this
   feature and say so explicitly in the report:
   `npx vitest run --config packages/web/e2e/vitest.config.ts backlog-composer` — noting that
   `AGENTS.md` forbids `npx vitest` for the **unit** gate; the e2e config is invoked this way by
   `e2e.sh` itself (`.ai/scripts/e2e.sh` step 3), so it is the sanctioned spelling here, and the
   full-suite result still has to be reported.
4. Retain the artifacts the spec's acceptance depends on:
   `.ai/qa/artifacts_e2e/backlog-composer-armed.png` and
   `.ai/qa/artifacts_e2e/backlog-filed-row.png` — note the second carries **no** `composer-`
   segment; those are the two names the spec actually writes
   (`backlog-composer.e2e.ts:114` and `:142`), and inventing a symmetrical third name is how a
   green run gets recorded as an incomplete one. Missing artifacts leave the feature at
   **QA Needed** (`.ai/specs/2026-08-22-backlog-add-without-starting.md` Verification).

### Phase 4 — correct the record, in place

Every edit below is an **in-place correction with a dated lead-in**, keeping the original text
beneath it (workspace `CLAUDE.md` rule 3a; `AGENTS.md`):

1. `.ai/specs/2026-08-24-land-the-backlog-composer.md` — amend P1's heading and body:
   `**CORRECTED 2026-08-29: the feature IS on `origin/main`.**` with the ancestry evidence, so the
   "absent from `cezar/main`" sentence can no longer be read as current. Set its Status to reflect
   the Phase 2/3 verdicts.
2. `.ai/specs/2026-08-22-backlog-add-without-starting.md:3` — replace the Status line's deployment
   clause with the measured `bb97df43` / `20260829T182347Z-bb97df43` release, and either close the
   E2E clause (Phase 3 green) or restate it precisely.
3. `AGENTS.md` trap 3 — append the post-rebaseline measurement taken in Phase 2, whichever way it
   went. This is the number the correction has been missing since 2026-08-24.
4. **Todos — through the lease, never by hand.** `cezar.service` is running and holds this
   project's todos in memory, so a direct read/write of `todos.json` is silently lost (either
   direction). Use the mechanism this repo already has four precedents for: a one-off script under
   `.ai/scripts/`, importing `readTodos`/`updateTodo` from `packages/cezar/src/todos.ts` so every
   write goes through `updateTodo()` (lease-protected by `withTodosLease`), with

   ```ts
   const dataDir = '/var/lib/cezar/loki-labs/cezar/.ai/cezar'
   ```

   run once from the repo root as `node --experimental-strip-types .ai/scripts/<name>.ts`. Copy the
   shape — and specifically the **preflight** — from
   `.ai/scripts/close-rollback-readiness-todo-2026-08-22.ts`,
   `.ai/scripts/close-deploy-e2e-probe-todo-2026-08-25.ts`,
   `.ai/scripts/close-sse-probe-vacuous-assertions-todo-2026-08-23.ts` or
   `.ai/scripts/consolidate-sse-probe-todos-2026-08-22.ts`: assert exactly one entry matches the
   expected id **and** that its summary is the expected text, and abort having written nothing if
   either disagrees. What to write: `d9ebe916-4f0b-4a57-8cb3-608013e8aa60` stays **open in every
   branch** of the C18 decision rule — update its context with the three fresh numbers and with why
   neither clause is discharged (see the Solution section). `30d9e835-f15f-4c9b-a0ef-624fbfc61cd4`
   gets its falsified recovery context replaced; those instructions are what sent this run at an
   already-merged branch.
5. Corpus: write the closure to `/var/lib/cezar/loki-labs/notion-export/` as the `cezar` user, then
   `cd /var/lib/cezar/loki-labs && CEZ_KB=1 cez kb reindex` and confirm the slug appears in
   `.ai/cezar/knowledge-index/catalog.ndjson`. An unindexed corpus write is not a KB write.

### Phase 5 — deployment

**Precondition — fail closed. Nothing in this phase runs on a red gate.** Do not commit, do not
push, do not land on `main`, and do not activate unless **every** authoritative gate is green on the
landed tree: `npm run typecheck`, **root `npm test` including C18**, `npm run test:unit`,
`npm run build`, `npm run test:package`, and Phase 3's `TEST_E2E_STATUS=passed`. Two independent
reasons, and either alone is sufficient: `AGENTS.md:13` — *"Never commit/push/deploy a red build …
Gates first, fail closed"*, enforced by the `commit-push` step's own post-conditions — and this
task's acceptance clause 1, which names root `npm test` passing *including catalog C18*.

If the C18 rule's **all-red** or **mixed** branch fires, this phase **stops before landing**:
preserve `/tmp/c18-root-{1,2,3}.log` and the isolated diagnostics, report the split verdict plainly
(the composer verified in Phases 2–4; the required gate red on a host-speed case that predates this
work and is causally unrelated to it), leave `d9ebe916` open, mark the task **QA Needed**, and hand
the budget decision to the owner. That is a park, and this repo already treats a park as a legitimate
terminal state (`.ai/specs/2026-08-24-manual-deploy-not-a-bug.md`). It is **not** licence to land
"because the failure is unrelated" — that judgement is exactly what the fail-closed rule removes from
the run's discretion.

**Then say precisely what did and did not persist** (the table at the top of Phases is the
authority; do not round it up). Persisted, because none of it goes through this commit: the Phase 0
`tools/doctrine-sync` restore in `/var/lib/cezar/loki-labs`; the two todo updates written through
the lease into the shared checkout's `todos.json`; and the corpus note plus its `cez kb reindex`.
**Not persisted:** Phase 1 is setup and lands nothing by design, and Phase 2 step 0's C18 emission
together with Phase 4 steps 1–3 (the landing spec's P1 correction, the design spec's Status, the
`AGENTS.md` trap 3 amendment) remain **uncommitted edits in this worktree**. So the mainline record
is still wrong: `.ai/specs/2026-08-24-land-the-backlog-composer.md` on `origin/main` continues to
tell the next session the feature is absent from `main`. Report that as **still pending**, never as
repaired. Preserve the unlanded edits — leave the worktree intact, do not revert it — and write into
the handoff the branch name, the exact files edited, and the three root-gate logs, so the next
session resumes the landing rather than re-deriving it. A worktree that looks finished and a
mainline that still lies is the precise failure this whole task exists to clean up; producing a
second instance of it while reporting success would be worse than the first.

Only with every gate green:

1. **State the already-measured truth first**, with evidence, rather than performing a deployment
   to produce it: live `sha bb97df43…`, `activatedAt 2026-08-29T18:23:51.179Z`, `ready: true`,
   `/opt/cezar → /opt/cezar-releases/20260829T182347Z-bb97df43`, and `mode-backlog` present in the
   served bundle. Re-take all four at closing time, because a concurrent run may have activated a
   later release in the meantime; a later release that still contains `origin/main` is equally
   valid (the deploy probe's ancestor test, `.ai/deploy-targets.json`).
2. Land this run's commit on `main` and push to `origin` (never `upstream`; name the remote). Its
   message must name both halves — the record repair **and** the test-only C18 emission — because a
   commit described as docs-only that carries a source diff is the same class of untruth Phase 4
   exists to remove.
3. The `deploy` step will then park, because both targets are `"manual": true` under D6. That park
   is the correct outcome, not a failure. The activation is one press of **Resolve** in the cockpit,
   or by hand as `cezar`: `bash /var/lib/cezar/loki-labs/cezar/scripts/activate-main.sh`.
4. Verify after activation: `curl -fsS http://127.0.0.1:4321/api/v1/ready` reports a `deploy.sha`
   that contains this run's HEAD as an ancestor, and `grep -l mode-backlog
   /opt/cezar/packages/cezar/web/dist/assets/*.js` still matches.

## Risks

1. **C18 is red on this host and the run is tempted to widen 59.2.** Mitigated by fixing the
   decision rule *before* the measurement, and by V3's negative control. Widening the constant to
   fit the slowest machine destroys the regression signal — `AGENTS.md:356-361` says so, and it is
   the reason the case was deliberately left failing once already.
2. **The E2E "passes" without proving anything.** The two documented vacuous-pass shapes — a boot
   project the Filed board cannot see, and an unscoped `/api/v1/runs` read — are already guarded in
   the spec file. Risk is that a future edit relaxes a guard to make a red go green. V5 pins both
   guards as assertions about the test, not just about the feature.
3. **The E2E skips again.** If the probe matrix finds no launchable Chrome, `e2e.sh` exits 0 with
   `skipped` and an unwary reader records a pass. Mitigated by grepping for
   `TEST_E2E_STATUS=passed` rather than trusting `$?`, and by requiring both PNGs on disk.
4. **A concurrent run moves the base mid-gate.** Handled by the repo's own rewind mechanism
   (`.ai/specs/2026-08-29-base-drift-rewinds-to-retest.md`); this spec's Phase 1 requires a
   fast-forward and stops on divergence rather than merging blind.
5. **Someone "helpfully" cleans up the `chat` checkout.** 4,354 lines of another product's staged
   deletions sit one `git commit -a` away from being erased, and this run's handoff is what makes
   that state visible. Mitigated by flagging with measurements and filing a follow-up rather than
   acting, and by stating explicitly that it is *not* the 2026-08-24 settlement residue.
6. **Doctrine conflict on who deploys.** The workspace `CLAUDE.md` grants standing authorization to
   deploy `cezar/` without asking; `.ai/deploy-targets.json` D6 (2026-08-24, later and repo-local)
   says a **person** activates cezar. This spec follows the repo-local, later rule and parks — and
   surfaces the conflict here rather than picking a side silently, per that same section's closing
   instruction. If the owner wants the agent to run `activate-main.sh` directly, that is a one-line
   answer that changes Phase 5 step 3 and nothing else.
7. **The shared checkout at `/var/lib/cezar/loki-labs/cezar` is 10 commits behind `origin/main`.**
   Task worktrees fork from it, so every new run starts stale. Out of scope to fix here; worth
   naming in the closure note.

## Verification

Concrete and executable. Each step names what it proves and what would falsify it.

- **V1 — the premise is dead.** `git fetch origin && git rev-parse origin/main`, then
  `git merge-base --is-ancestor b5bd0d4e origin/main; echo $?` → `0`, and
  `git diff --stat origin/main...cez/15ff402b` → empty. *Falsified by:* a non-zero exit or a
  non-empty diff, which would mean the ancestry changed and the recovery instruction is live again.
- **V2 — the install is real.** `ls node_modules/.bin | wc -l` after the scrubbed `npm ci`. *Any
  answer near 13 invalidates every later step in this list.*
- **V3 — C18, measured under gate conditions and controlled.** Three **full root `npm test`** runs
  (the same executions V4 quotes, not extra ones), with C18's `ms/MiB` extracted from each:
  `grep -h 'C18 index build cost' /tmp/c18-root-[123].log` must print three lines. *Falsified by:*
  fewer than three lines — which means Phase 2 step 0's emission is missing and no green run can
  ever be recorded — or figures taken from an isolated single-file run, which measures a quieter
  machine than the gate and cannot classify it. Isolated numbers may be reported **only** labelled
  as diagnostics. **Negative control:** `git stash list` empty, and
  `git diff origin/main --stat -- packages/cezar/src/knowledge/` showing **exactly** the test-only
  emission from Phase 2 step 0 and nothing else — no change to `catalog.ts` and no change to
  `C18_MAX_MS_PER_MIB`, which is what makes a red a statement about the host rather than about this
  run. Dispose per the C18 decision rule; a red or mixed verdict triggers Phase 5's fail-closed
  precondition.
- **V4 — the full gates.** `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`,
  `npm run test:package`, each under the scrub, each result quoted with its counts. `test:package`
  requires a completed `build` (`AGENTS.md:240`). The `npm test` line quotes **the three runs from
  Phase 2 step 2 and no others** — all three must be green, and they are the same executions V3
  classifies C18 from. A fourth `npm test` outside that loop means the plan was not followed and the
  two verification steps no longer describe the same evidence.
- **V5 — the browser E2E, non-vacuously.**
  `npm run test:e2e 2>&1 | tee /tmp/e2e.log; grep -c 'TEST_E2E_STATUS=passed' /tmp/e2e.log` → `1`.
  Then confirm from the spec source that the run could not have passed vacuously: the fixture
  registration assertion (`before.projects.some(p => p.id === 'fixture' && p.ok === true)`) and
  **both** run-list assertions (scoped `/api/v1/p/fixture/runs` **and** unscoped `/api/v1/runs`) are
  still present and unskipped. *Falsified by:* `skipped`, a modified guard, or a `.skip`.
- **V6 — the acceptance behavior, in the artifacts.** Both
  `.ai/qa/artifacts_e2e/backlog-composer-armed.png` and `…/backlog-filed-row.png` exist and
  are non-empty; the second shows the filed row on the global Filed board. This is the direct
  evidence for acceptance clause 2 — one submit, exactly one unstarted todo
  (`expect(todos).toHaveLength(1)`, `status` undefined, `startedTaskId` undefined), zero runs, and
  `location.pathname === '/tasks'`.
- **V7 — the doctrine checkout is clean.**
  `git -C /var/lib/cezar/loki-labs status --short` → empty, and `test -x
  /var/lib/cezar/loki-labs/tools/doctrine-sync`. Plus
  `find /var/lib/cezar -not -user cezar | wc -l` → `0`.
- **V8 — production serves the feature.** `curl -fsS http://127.0.0.1:4321/api/v1/ready` →
  `ready: true` and a `deploy.sha` that `git merge-base --is-ancestor <HEAD> <sha>` accepts; and
  `grep -l mode-backlog /opt/cezar/packages/cezar/web/dist/assets/*.js` matches at least one file.
  Both re-taken at closing time, not quoted from this spec.
- **V9 — the record no longer lies.** `grep -n "absent from" .ai/specs/2026-08-24-land-the-backlog-composer.md`
  shows the corrected lead-in above the retained original; the design spec's Status names the live
  release; `CEZ_KB=1 cez kb reindex` has run and
  `grep -c "<closure-slug>" /var/lib/cezar/loki-labs/.ai/cezar/knowledge-index/catalog.ndjson` → `1`
  (grep the **slug or path**, never the document's prose — the catalog stores an excerpt).

## What was read, and what was not

**Read directly in this step (2026-08-29):** `.ai/specs/briefs/2026-08-29-backlog-composer-current-state.md`;
`.ai/specs/2026-08-22-backlog-add-without-starting.md` (TLDR, Problem, Verification, Out of scope);
`.ai/specs/2026-08-24-land-the-backlog-composer.md` (header, TLDR, P1, P2, section index);
`.ai/specs/2026-08-25-composer-dispatch-mode.md:125-145`;
`.ai/specs/2026-08-29-verify-active-backlog-e2e.md` (header, TLDR, browser-provider findings);
`.ai/specs/2026-08-29-resolve-runs-the-deployment.md:1-40`; `AGENTS.md` (Validation, the five
environment traps, the headless-browser section, the blue-green correction); `.ai/deploy-targets.json`
in full; `.ai/scripts/e2e.sh`; `.ai/scripts/test-env-up.sh` (header + the browser probe matrix);
`packages/web/e2e/vitest.config.ts`; `packages/web/e2e/backlog-composer.e2e.ts` in full;
`packages/web/e2e/agent-browser.ts` (`fixtureServeEnv`); and, on `origin/main`,
`packages/web/src/routes/new-task.tsx`, `new-task-draft.ts`, `new-task.test.tsx`,
`packages/web/src/api/client.ts`, `packages/cezar/src/knowledge/catalog.test.ts:250-340`.
**Measured on this box:** the remote tip and full ancestry; `/api/v1/ready` and `/api/v1/health`;
`/opt/cezar` and `/opt/cezar-releases/deploy.json`; the live bundle grep; `git status` in all four
checkouts plus their index mtimes; the two todos in `.ai/cezar/todos.json` (207 entries).

**Not read, and named rather than guessed:**

- **`cez kb search` was not run in this step.** The KB entry the task supplies
  (`2026-08-22-backlog-add-without-starting`) resolves to a file in this repo, which was read
  directly instead. No corpus-wide lexical search was performed, so the absence of a further
  decision on this feature is not proven.
- **No gate was executed** — no `npm ci`, no `npm test`, no `npm run test:e2e`. This worktree has no
  `node_modules`. Every gate verdict in this spec is a *plan*, and Phase 2 and 3 are the only places
  a verdict may be claimed.
- **C18 has not been measured on this host since the rebaseline.** The 54–65 ms/MiB band is quoted
  from `AGENTS.md`'s 2026-08-20 measurement of the *pre-rebaseline* code on this host; whether the
  current serialized, CPU-time, min-of-three estimator lands under 59.2 here is genuinely unknown.
- **The `chat` checkout's 28 dirty files were not attributed.** Their index is dated 2026-08-25 and
  their content is Grocey/cart-verify work; which run left them is not established here.
- **No live production Backlog submit was performed.** Filing a real todo into a real project to
  prove behavior would pollute the workspace's own board; the bundle grep plus the fixture E2E are
  the evidence path this spec chooses instead. If the owner wants a live click-through, say so and
  it becomes a sixth phase with a named throwaway project.

## Out of scope

- **Re-implementing, re-merging or cherry-picking `cez/15ff402b`.** It is an ancestor of
  `origin/main` and its diff against it is empty. Doing so would be a no-op at best and a revert at
  worst.
- **Repairing `/var/lib/cezar/loki-labs/chat`.** Flagged with measurements and filed as a follow-up;
  the deletions belong to another product's in-flight work.
- **Widening or removing the C18 budget**, and any redesign toward a same-process ratio — that
  candidate was measured and rejected (`catalog.test.ts:265-267`: samples ranged 4.2×–5.9×, above
  the 1.20 stability gate).
- **Bringing `/var/lib/cezar/loki-labs/cezar` up to `origin/main`.** Named as a hazard; not this
  task's change.
- **Any product change to the composer** — richer creation fields, a Filed-board quick-add, a
  workspace-scope Backlog mode. All three are explicitly deferred by
  `.ai/specs/2026-08-22-backlog-add-without-starting.md`'s own Out of scope section.
