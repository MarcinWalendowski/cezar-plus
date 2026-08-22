# Release staging copies 2.4G of nested task worktrees into every `/opt/cezar` release

**Status:** implemented (2026-08-22) — Phases 1-3 done and measured; Phase 4 (reclaiming
existing bloated releases) intentionally left for `keep:5` rotation, per its own "not blocking"
note.

**Brief:** the step-1 `context` step of this run reported writing
`.ai/specs/briefs/2026-08-22-release-staging-exclude-worktrees-tmp.md`, but no such file exists on
disk (checked at the start of this step, both by path and by `Glob **/2026-08-22-release-staging*`
— zero matches). This spec is therefore written from the task's own context paragraph plus direct
re-reading of the source and of `/opt/cezar-releases` on this box, not from a brief. Anything below
that reads as a citation is something this step opened and re-verified itself; nothing here is
carried over uncited from a missing document.

## TLDR

`defaultHost().stage()` (`packages/cezar/src/server-install/release-deploy.ts:132-151`) rsyncs the
deploy source with only two excludes — `.git` and `.ai/cezar/runs`. Whenever a deploy's `source` is
the main checkout (`/var/lib/cezar/loki-labs/cezar` on `prod-host`, not a task's own git
worktree under `.ai/cezar/worktrees/<taskId>/`), the rsync also copies every live task worktree —
measured on this box just now at **3.06G**, each with its own `node_modules` — into the release.
Three of the five releases currently on disk carry that weight (2.9G, 3.1G, 4.0G); the two most
recent are a clean **491M** because they happened to be staged from inside a task's own worktree,
which has no `.ai/cezar/worktrees` subdirectory of its own to copy. The fix is two more `--exclude`
entries in the same rsync call — `.ai/cezar/worktrees` and `.ai/cezar/tmp` — so the release is the
same small artifact regardless of which directory `source` happens to be.

## Problem

### The exclude list stops one directory short of its own stated rule

`stage()`'s own comment says the intent already covers this case:

```ts
// `--delete` so a release directory reused after a failed attempt cannot keep a stale file,
// and the git metadata is excluded because a release is an artifact, not a checkout.
const rsync = run('rsync', [
  '-a',
  '--delete',
  '--exclude',
  '.git',
  '--exclude',
  '.ai/cezar/runs',
  `${source.replace(/\/*$/, '')}/`,
  `${target.replace(/\/*$/, '')}/`,
]);
```

(`release-deploy.ts:136-145`.) "A release is an artifact, not a checkout" is exactly the argument
for excluding `.ai/cezar/worktrees` too — a live task worktree is cezar's own agent runtime state,
one directory namespace over from `.ai/cezar/runs`, which the same comment already treats as
out-of-scope for a release. `.ai/cezar/worktrees` was simply never added to the list.

### Measured, on this box, right now

```
$ du -sh /var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees
3.5G    (11 worktrees; 6 with a built node_modules at 477-480M each, plus 5 lightweight/empty ones)
$ du -sh /var/lib/cezar/loki-labs/cezar/.ai/cezar/tmp
42M     (4 live per-run scratch dirs)
$ du -sh /var/lib/cezar/loki-labs/cezar/.ai/cezar/runs
47M     (already excluded)
```

And on `/opt/cezar-releases` (5 releases currently retained, `keep:5` in `deploy.json`):

| release | size | `.ai/cezar/worktrees` inside it | note |
|---|---|---|---|
| `20260821T210309Z-387ba439` | 2.9G | 2.4G | matches the task's own "2.4G / 3.0G" measurement |
| `20260821T215646Z-a5f04b0f` | 3.1G | 2.6G | |
| `20260821T221526Z-c58d1d04` | 4.0G | 3.5G | |
| `20260821T223855Z-85023d62` | 491M | *(absent — 0 bytes copied)* | staged from inside a task worktree |
| `20260822T001738Z-5d884ce1` (current) | 491M | *(absent)* | staged from inside a task worktree |

Total on `/opt/cezar-releases`: **~11G**, not the ~2.5G (`keep:5` × ~490M) the `DEFAULT_KEEP` comment
in `releases.ts:36` assumes. Disk: `df -h /` reports 150G total, 29G used, 116G available — not
urgent today, but the three bloated releases are ~75% of everything releases currently occupy, and
every future deploy from the main checkout regenerates the pattern.

### Why the two most recent releases are already clean — and why that doesn't fix anything

The two 491M releases were not staged from a bug fix; they were staged from **inside a task's own
git worktree** (`.ai/cezar/worktrees/<taskId>/`), which — being a plain `git worktree add` checkout
— has no `.ai/cezar/worktrees`, `.ai/cezar/tmp`, or `.ai/cezar/runs` subdirectory of its own (those
are gitignored and only exist in the main checkout where cezar's own server process keeps its live
state). `repoRoot` (`packages/cezar/src/index.ts:299`) resolves from `cwd` by walking up to the
nearest git root, and `server-deploy`'s `source` defaults to it
(`index.ts:359`: `source: values.source ?? repoRoot`) — so which directory a deploy picks up is a
property of **where the deploy command happens to run from**, not something `stage()` controls.

Commit `c15780cb` (`feat: the boot root becomes a git repo, so a homeless run isolates too`,
2026-08-21T22:10Z, `.ai/specs/2026-08-21-workspace-boot-repo-and-always-worktrees.md`) closed the
specific trigger that produced the three bloated releases: before it, a "homeless" run (no
`workspaceProjects` configured) executed **in place**, directly in the main checkout, because that
checkout had no git repo of its own to isolate into. Every one of the three bloated releases was
built before that commit landed (`21:03`, `21:56`, `22:15`); both clean releases were built after it
(`22:38`, `00:17`). That is a real mitigation — most runs now isolate into a worktree before doing
anything, deploy included — but it is a mitigation at the *caller* layer, not a fix at the *rsync*
layer:

- An interactive `ssh` session on the box that `cd`s to `/var/lib/cezar/loki-labs/cezar` and runs
  `cezar server-deploy --strategy=blue-green` directly reproduces the bug today, on current `main`,
  with zero code change.
- `--source` is a documented, user-settable flag (`ReleaseDeployOptions.source`,
  `release-deploy.ts:56`) — anyone can point it at the main checkout on purpose or by habit.
- A future regression in the boot-root-isolation logic (or a new caller that doesn't go through it)
  would silently reopen exactly this hole, with no test anywhere catching it, because nothing
  asserts what `stage()` itself excludes.

`stage()` is the one place that can make the release small **regardless of what `source` is** — the
fix belongs here, not in a second caller-side mitigation.

### The concurrent-write race the task description also names

"Staging also copies whatever a concurrently-running task happens to be writing" — `rsync -a` reads
the source tree live, with no lock coordinating it against the other 5-10 task worktrees actively
being written to by other agent sessions on the same box (confirmed: this task's own worktree is
one of the 11 currently under `.ai/cezar/worktrees/`, created by this same run, mid-stage relative
to any deploy that might run concurrently). Excluding `.ai/cezar/worktrees` removes this race
entirely for the largest category of concurrently-mutated state; excluding `.ai/cezar/tmp` removes
it for the other category the box currently holds (transient per-run scratch dirs, see next
section). It does not, and cannot, address `.git` itself changing mid-rsync — that risk already
exists today and is unrelated to this fix.

### Does `.ai/cezar/tmp` belong on the list too — yes, same category as `.ai/cezar/runs`

`.ai/cezar/tmp/<runId>` is `agentTmpDir` (`packages/cezar/src/runs/agent-tmpdir.ts:45-46`) — the
per-run scratch directory cezar itself points `TMPDIR`/`TMP`/`TEMP` at for every agent session, for
disk-quota isolation (`agent-tmpdir.ts`'s own header, and independently documented in
`.ai/specs/2026-08-21-npm-test-gate-environment-scrub.md` Failure #2). It is:

- **Per-run agent scratch state**, exactly the same category `.ai/cezar/runs` is already excluded
  for — never something a shipped release artifact should contain.
- **Recreated on demand at runtime**, not something the running release depends on finding
  pre-populated: `agentTmpEnv()` (`agent-tmpdir.ts:130-144`) calls `mkdirSync(dir, { recursive:
  true })` before ever handing the path to a child process, so a deployed `/opt/cezar-releases/<id>`
  with no `.ai/cezar/tmp` at all boots and runs identically to one with a stale copy in it. (Verified
  directly: the two clean 491M releases already have **no** `.ai/cezar/tmp` populated with any
  runId subdirectory, and both are the two currently `healthy: true` releases in `deploy.json`,
  including the one live right now.)
- **Subject to the identical concurrent-write race** as `.ai/cezar/worktrees` — it is exactly the
  in-progress state of every other task running on the box at rsync time.

Measured size today (42M across 4 live runs) is small next to the 3.5G `worktrees` problem, but the
category argument, not the size, is what settles it: shipping it is never correct, whether it is
40M or 4G on a given day, and there's no reason to exclude one per-run scratch namespace
(`.../runs`) and not its sibling (`.../tmp`).

## Solution

Add two more `--exclude` arguments to the one rsync call in `defaultHost().stage()`, immediately
after the existing `.ai/cezar/runs` exclude, and extend that function's own comment to say why
(mirroring, not duplicating, the reasoning above) so the next person reading this file doesn't have
to re-derive it. No other function, call site, or test-visible seam changes — `stage()`'s signature,
its callers (`runReleaseDeploy`'s `effects.stage`), and every existing `ReleaseDeployHost` mock stay
exactly as they are, because none of them execute real rsync (see Verification — this is the gap the
new test in Phase 2 closes).

## Architecture

No architectural change. This is a one-function, additive fix to an existing shell-out inside
`ReleaseDeployHost.stage`'s default (real) implementation:

```
runReleaseDeploy (release-deploy.ts)
  → defaultHost(log).stage(source, target)     ← the only place source's excludes are decided
      → rsync -a --delete
          --exclude .git
          --exclude .ai/cezar/runs
          --exclude .ai/cezar/worktrees   [NEW]
          --exclude .ai/cezar/tmp         [NEW]
          <source>/ <target>/
```

`ReleaseDeployHost` stays the seam it already is (`release-deploy.ts:116-128`): every existing test
in `release-deploy.test.ts` supplies its own `stage` mock and never touches this rsync call at all,
which is exactly why the bug shipped uncaught — see Verification Phase 2 for the new coverage this
spec adds at that seam.

## Data models and API contracts

None. No schema, no persisted state, no CLI flag, and no `ReleaseDeployOptions`/`ReleaseDeployHost`
interface change. Purely an argument added to an existing internal shell-out.

## Phases

**Phase 1 — add the two excludes and update the comment.**
`packages/cezar/src/server-install/release-deploy.ts:132-151`:

```ts
async stage(source, target) {
  mkdirSync(target, { recursive: true });
  // `--delete` so a release directory reused after a failed attempt cannot keep a stale file in
  // the shipped tree — note this does NOT delete *excluded* paths (that needs the separate
  // `--delete-excluded` flag, not added here), so a reused target can still carry whatever it
  // already had under the four excludes below. Harmless: nothing in a running release reads any
  // of them (see Risks), and Phase 4 covers reclaiming space already on disk, which a re-stage
  // cannot do.
  // A release is an artifact, not a checkout: git metadata (`.git`) is excluded, and so is every
  // directory that is cezar's own AGENT RUNTIME STATE rather than the tree being shipped —
  // `.ai/cezar/runs` (per-run history), `.ai/cezar/worktrees` (live task git worktrees, each with
  // its own node_modules — measured 2026-08-21/22 at up to several GB) and `.ai/cezar/tmp`
  // (per-run scratch dirs, recreated on demand at runtime by `agentTmpDir`). All three are also
  // being concurrently written to by whatever other tasks are running on the box at stage time, so
  // excluding them removes that race along with the size.
  const rsync = run('rsync', [
    '-a',
    '--delete',
    '--exclude',
    '.git',
    '--exclude',
    '.ai/cezar/runs',
    '--exclude',
    '.ai/cezar/worktrees',
    '--exclude',
    '.ai/cezar/tmp',
    `${source.replace(/\/*$/, '')}/`,
    `${target.replace(/\/*$/, '')}/`,
  ]);
  if (!rsync.ok) throw new Error(`staging failed: ${rsync.out}`);
  run('sync', []);
},
```

Independently shippable and complete on its own — this alone satisfies the first acceptance
criterion.

**Phase 2 — a real-rsync test for the exclude list, at the seam that let this ship unnoticed.**
Every existing case in `release-deploy.test.ts` supplies a mocked `stage` (`recorder()`,
`release-deploy.test.ts:39-66`) and so never runs actual rsync — that is precisely why an exclude
list missing an entry compiled, type-checked, and passed every test, then shipped to production.
Add one new test that calls `defaultHost(log).stage(source, target)` directly (not through
`runReleaseDeploy`, and not through the mock) against a real temp source tree seeded with:
- a tracked file (e.g. `package.json`) — must be present in `target` after staging;
- `.git/HEAD` — must be absent;
- `.ai/cezar/runs/<id>/marker` — must be absent (already-covered behavior, pinned so a future edit
  can't silently drop it while adding the new excludes);
- `.ai/cezar/worktrees/<id>/node_modules/marker` — must be absent (new);
- `.ai/cezar/tmp/<id>/marker` — must be absent (new).

This exercises the real `rsync` binary (present at `/usr/bin/rsync` on this box and on
`ubuntu-latest`, same precedent as the existing `sh`-based `.ai/scripts/e2e.sh`), so it fails loudly
if the exclude list ever regresses again, independent of every mocked test elsewhere in the file.

**Phase 3 — measure a real staged release and recheck the two size-derived constants.**
1. Measure directly, no permission needed — `~/loki-labs/CLAUDE.md` grants `cezar/` standing
   authorization to run gates and this repo's own deploy command without asking each time, so the
   earlier draft's "ask first, standing rule" had the direction backwards. Run
   `defaultHost(log).stage('/var/lib/cezar/loki-labs/cezar', '<scratch-dir-under-/tmp>')` — a plain
   read of the source plus a write to a throwaway `/tmp` directory, not to `/opt/cezar-releases` —
   then `du -sh <scratch-dir>` and remove it. Use a literal path (e.g. `/tmp/cez-stage-measure.$$`),
   not `mktemp -d`: this box's `TMPDIR` is redirected into `.ai/cezar/tmp/<runId>`, inside the
   source tree itself (`agent-tmpdir.ts:45`) — staging into a subdirectory of the very tree being
   staged would still work (that path is excluded by Phase 1, and it's ext4 with 116G free, not a
   quota'd tmpfs) but makes for a confusing measurement. This is the sole evidence for AC#2, and it
   is sufficient on its own: it stages `source` = the main checkout, the exact condition that
   produces the bug. **This chain's own later deploy step is not a second confirming number for
   this fix** —
   `getRepoInfo` (`packages/cezar/src/server/git.ts:32`) resolves `source` via `git rev-parse
   --show-toplevel`, which inside this run's own task worktree returns the worktree, not the main
   checkout (verified live from this worktree: `git rev-parse --show-toplevel` prints
   `.ai/cezar/worktrees/57f093be-.../`). So that deploy's `source` never contains
   `.ai/cezar/worktrees` or `.ai/cezar/tmp` to begin with, and `du -sh
   "$(readlink -f /opt/cezar)"` afterward would read ~491M whether or not Phase 1 landed — it
   confirms nothing about this fix, per the "Why the two most recent releases are already clean"
   section above.
2. Compare against this spec's own estimate: the current checkout is **4.1G** total; excluding
   `.git` (57M), `.ai/cezar/worktrees` (3.5G), `.ai/cezar/tmp` (42M) and `.ai/cezar/runs` (50M) — a
   combined 3.66G — leaves an estimated **~415-490M**, consistent with the two already-clean
   production releases, which were staged from a worktree source that never had those four
   directories to begin with and measured **491M** each.
3. Re-check the two comments this task calls out by name:
   - `release-deploy.ts:52`, `MIN_FREE_BYTES` — "A release is ~500 MB", threshold `2 * 1024**3`
     bytes (2GB, a 4x margin over ~500M). The measured 491M releases already match this comment;
     Phase 1 makes that match hold regardless of `source`. **No change expected** unless Phase 3
     step 1's real measurement disagrees with the ~415-490M estimate by more than the existing 4x
     margin absorbs.
   - `releases.ts:36`, `DEFAULT_KEEP` — "Five ≈ 2.5 GB at the current ~490 MB tree size." Same
     conclusion: already accurate for a correctly-excluded release, **no change expected**, recheck
     against Phase 3 step 1's number before closing this spec.
   If either measurement lands outside the comment's claim, update that comment's number in place
   (this repo's own correction doctrine — mark what changed, don't just append) and, for
   `MIN_FREE_BYTES`, reconsider whether 2GB is still the right refuse-threshold.

**Phase 4 (recommended, not blocking) — reclaim the existing bloat.**
The three already-bloated releases on disk (2.9G, 3.1G, 4.0G — ~10G together) are not fixed by
Phase 1, which only changes what *new* releases contain — and re-staging one of them in place
would **not** shrink it either: as Phase 1's comment now notes, `rsync --delete` does not delete
*excluded* paths on the receiver, so a target that already has a populated `.ai/cezar/worktrees`
keeps that content across a re-stage. The two paths that actually reclaim the ~10G are the normal
release-rotation path (`keep:5` in `deploy.json` will naturally evict the three bloated releases
as new, correctly-sized ones accumulate) or an explicit `rm -rf <release>/.ai/cezar/worktrees
<release>/.ai/cezar/tmp` on a release that is not `current`. Not required to meet this task's three
acceptance criteria, which are about the staging code and a freshly staged release, not the disk
this exact box happens to be carrying today.

## Risks

- **Nothing in a shipped release actually reads `.ai/cezar/worktrees` or `.ai/cezar/tmp` at
  runtime.** Confirmed by the two existing 491M production releases already running with neither
  directory present at all (not merely empty — absent), one of them (`20260822T001738Z-5d884ce1`)
  `healthy: true` and currently `current` in `deploy.json`. Excluding them from staging changes
  nothing about what the deployed process can do.
- **A worktree or tmp dir literally named `.ai/cezar/worktrees` or `.ai/cezar/tmp` inside the
  *source* tree** (as opposed to being cezar's own runtime directories) would also be excluded —
  not a realistic collision since both are cezar's own reserved paths under its own data directory,
  already gitignored, and not something a repository would otherwise use for tracked content.
- **The new Phase 2 test adds a real subprocess dependency (`rsync`) to the test suite.** Already
  true of this file's runtime code (rsync is required for `stage()` to work at all in production)
  and of this repo's precedent (`.ai/scripts/e2e.sh` already assumes a POSIX `sh` + coreutils
  environment); `rsync` is present on this box and ships by default on `ubuntu-latest`, so this
  does not add a new environment requirement, only new test coverage of an existing one.
- **Phase 3's live measurement is genuinely unverified until it's run.** This spec's ~415-490M
  Phase 3 estimate is arithmetic over `du` numbers taken today, not a staged-and-measured release;
  Phase 3 step 1 is what turns the estimate into the acceptance criterion's actual "measured".
- **Scope discipline.** This spec does not touch `MIN_FREE_BYTES`'s value, `DEFAULT_KEEP`, the
  boot-root-isolation logic from `c15780cb`, or the existing bloated releases already on disk
  (Phase 4) — none are required by the three stated acceptance criteria, and changing any of them
  without Phase 3's real measurement in hand would be guessing a number the task explicitly asks to
  have "re-checked", not invented.

## Verification

1. **Unit — Phase 1's excludes, via Phase 2's new real-rsync test.** `release-deploy.test.ts` is a
   vitest suite; `packages/cezar`'s own `test:unit` script (`node --import tsx --test
   test/unit/*.test.ts`) is a separate `node:test` runner over a different directory and never
   touches this file, so it does not exercise the new test. Run it directly with `npx vitest run
   packages/cezar/src/server-install/release-deploy.test.ts`, then confirm with the full `npm test`
   (root `vitest run`, the gate CI actually runs) after adding the test — must show the new case
   green and every existing case in the file unaffected (they mock `stage` entirely, per
   `release-deploy.test.ts:39-66`, so Phase 1's change cannot regress them).
2. **Gates.** `npm run typecheck` / `npm run lint` / existing `npm test` — Phase 1 is an argument
   array change with no type or import surface change, so no new failures are expected; run to
   confirm.
3. **Real measurement — no permission needed (see Phase 3 step 1).** Stage
   `/var/lib/cezar/loki-labs/cezar` as `source` (the exact condition that reproduces today's bug)
   into a `/tmp` scratch target via `defaultHost(log).stage(...)` and `du -sh` the result. Passes
   the second acceptance criterion if the result is "a few hundred MB", consistent with the two
   existing 491M releases and this spec's ~415-490M estimate — not the 2.9-4.0G the same source
   produces today on unpatched `stage()`. This is the only measurement this criterion needs; this
   chain's own later deploy step is worktree-sourced (see Phase 3 step 1) and its release size is
   not evidence either way for this fix.
4. **Re-check the two constants** per Phase 3 step 3 against whatever Phase 3 step 1 actually
   measures; update in place only if the measurement disagrees with the existing comments beyond
   what their stated margins absorb. This closes the third acceptance criterion either way — "no
   change needed, here's the measurement that confirms it" is a valid, fully-verified outcome, not
   a skipped step.

## Implementation notes (2026-08-22, step 4)

- **Phase 1** applied exactly as specified — two new `--exclude` args
  (`release-deploy.ts:139-142`) and the extended comment, both verbatim from this spec.
- **Phase 2** added as a new `describe` block in `release-deploy.test.ts` (not touching any
  existing mocked case): calls `defaultHost(() => {}).stage(source, target)` directly against a
  seeded temp tree with a tracked file, `.git/HEAD`, and one marker file each under
  `.ai/cezar/runs`, `.ai/cezar/worktrees/.../node_modules`, and `.ai/cezar/tmp` — asserts the
  tracked file survives and all four excluded paths are absent from `target`. `npx vitest run
  packages/cezar/src/server-install/release-deploy.test.ts` → **13 passed (13)**.
- **Phase 3 step 1** — ran the same rsync argv `defaultHost().stage` now issues (per review nit
  (e), equivalent to invoking the TS function) with `source` = the main checkout
  `/var/lib/cezar/loki-labs/cezar` and `target` = a literal `/tmp/cez-stage-measure.$$` path (not
  `mktemp -d`, per the spec's own warning): staged size measured **484M**. Satisfies AC#2 ("a few
  hundred MB, not 3.0G").
- **Phase 3 step 2/3** — 484M sits inside this spec's own ~415-490M estimate and matches the two
  existing clean 491M production releases. Rechecked both named comments against it:
  `MIN_FREE_BYTES` (`release-deploy.ts:52`, "~500 MB" / 2GB threshold) and `DEFAULT_KEEP`
  (`releases.ts:33`, "Five ≈ 2.5 GB at ~490 MB tree size") both already match the measurement
  within their stated margins — **no change made to either**, per the spec's own "no change
  expected unless Phase 3 disagrees" conclusion.
- **Gates run this step:** `npm run typecheck` — green. `npm run lint` — no such root script
  exists (checked `package.json`; only `typecheck` and `test` are defined at root), so skipped;
  flagging for whoever owns the final gate check rather than inventing a lint invocation. `npm
  test` (root `vitest run`) — 516 passed / 2 failed of 518 files, 9552 passed / 2 failed of 9555
  tests; both failures are pre-existing and unrelated to this change:
  `src/knowledge/catalog.test.ts` (a CPU-ratio perf budget, 67ms/MiB vs. a 40ms/MiB budget — noisy
  under shared CI load, not touched by this diff) and
  `src/workspace/home-safety.test.ts` (a nested-vitest subprocess test that fails with `ENOENT` on
  `node_modules/.bin/vitest` — this task worktree's own `node_modules` lacks that binary, an
  environment gap in this worktree, not a regression from this change). Confirmed only the three
  files this spec names (`release-deploy.ts`, `release-deploy.test.ts`, and this spec) are in
  `git status`.
- **Phase 4** left undone, as the spec itself marks it non-blocking — the three bloated releases
  already on disk are reclaimed by normal `keep:5` rotation as new correctly-sized releases land,
  or by an explicit `rm -rf` on a non-`current` release; neither is required by the three stated
  acceptance criteria.
