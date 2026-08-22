# Brief: release staging copies 2.4G of nested task worktrees into every /opt/cezar release

**Task id:** 57f093be-b984-4d3d-9929-e259c6477636
**Step:** 1/8 — Gather the record (this document is a brief, not a spec)

## Problem, in this repo's own terms

`defaultHost().stage()` in `packages/cezar/src/server-install/release-deploy.ts:132-151`
rsyncs the whole source tree into a new release directory with only two excludes:

```
packages/cezar/src/server-install/release-deploy.ts:136-144
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

The comment just above it (line 134-135) states the intended principle directly:
*"git metadata is excluded because a release is an artifact, not a checkout."* The bug is
that the exclude list stops one directory short of that principle — it excludes `.git` and
`.ai/cezar/runs` but not `.ai/cezar/worktrees` (per-task git worktrees, each a full
checkout with its own `node_modules`) or `.ai/cezar/tmp` (per-run scratch space). On
`prod-host`, source = `/var/lib/cezar/loki-labs/cezar`, which has 6 live task
worktrees under `.ai/cezar/worktrees/` — measured 2026-08-21 after deploying `7e8f2938`:
release = 3.0G, of which `.ai/cezar/worktrees` = 2.4G (80%). Staging also picks up
whatever a concurrently-running task happens to be writing into its own worktree or tmp
dir at rsync time — a release built mid-task is not reproducible from a given commit sha
alone.

## What the record already decided (citations)

- **The exclude-list's own stated design principle already covers this case; nothing
  says the list should stay at exactly two entries.** `release-deploy.ts:134-135` (see
  above). Single commit `954c6a55` ("feat: a run now outlives the cockpit that started
  it", 2026-08-21) introduced these lines; `git blame -L 136,145` shows nothing has
  touched them since — this was never revisited, not a deliberate narrow scope.
- **The 500 MB sizing assumption is explicit and load-bearing, and 3.0G already breaks
  it 6x over.** `release-deploy.ts:52-53`:
  ```
  /** Refuse to stage a release when free space is below this. A release is ~500 MB. */
  export const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;  // 2 GiB
  ```
  `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` (P1 section) says the same
  thing independently: *"Keep N=5 releases (490 MB each ≈ 2.5 GB; the box has room, and
  the count is configurable)"* and records `/opt/cezar` measured at 490 MB including
  `node_modules` before this cutover. `DEFAULT_KEEP = 5` lives at
  `packages/cezar/src/server-install/releases.ts:36`. So the current on-disk state
  (9.7G for 5 releases, per the task's own context) is already ~4x the sizing this
  retention math assumed.
- **The same spec already treats `.ai/` contents as build-time cruft that shouldn't
  ride along into a release** — its P1 migration section calls `/opt/cezar/.ai/`
  *"a build-time leftover — `WORKLIST.md`, `runs/`, `analysis/`, `browsers/`, `qa/`,
  `scripts/`; nothing reads it at runtime"* and moves it out before the first
  blue-green flip. That's a one-time migration of the old hand-rsync'd `/opt/cezar`,
  not the `stage()` exclude list itself, but it's the same principle this fix applies
  going forward.
- **No prior decision says to keep the exclude list minimal, and no contradiction was
  found.** Searched `cez kb search` (multiple queries) and `.ai/specs/*.md` — nothing
  discusses this exact bloat, and nothing argues against excluding worktrees/tmp.
- **`.ai/cezar/worktrees` is confirmed pure task-scratch, never consumed by a
  deployed release.** `packages/cezar/src/git-worktree.ts:18`:
  `export const WORKTREES_DIR = '.ai/cezar/worktrees';` — task worktrees
  (`cez/<id8>` checked out per run) exist so agents never touch the main tree; nothing
  downstream expects them inside `/opt/cezar`.
- **`.ai/cezar/tmp` is confirmed pure per-run scratch too.**
  `packages/cezar/src/runs/agent-tmpdir.ts:45-47`:
  `agentTmpDir(dataDir, runId) => join(dataDir, 'tmp', runId)`, keyed by `runId` (==
  `CEZ_TASK_ID`, set at `packages/cezar/src/workflows/run.ts:1042`), set as the spawned
  agent's `TMPDIR`. KB note on `TMPDIR` isolation (`specs-cb279cda3c66` /
  `notion-b2a2f1953d58`) confirms this per-run role. Nothing reads it back from a
  release directory at runtime.
- **A separate, unrelated spec already exists for worktree accumulation in general**:
  `.ai/specs/2026-07-18-worktree-retention.md` (worktrees "tens to hundreds of MB
  each," unbounded growth risk) with its own keep-last-N=10 retention policy on the
  worktree directories themselves. It does not mention or anticipate worktrees leaking
  into deploy releases — the two specs were never cross-checked against each other.
  Not a contradiction, just a gap this task closes on the release side.

## Code actually involved

- `packages/cezar/src/server-install/release-deploy.ts:130-151` — `stage()`, the rsync
  call and its exclude list (the fix site).
- `packages/cezar/src/server-install/release-deploy.ts:52-53` — `MIN_FREE_BYTES` and its
  "~500 MB" comment (acceptance criterion: re-check against measured post-fix size).
- `packages/cezar/src/server-install/release-deploy.ts:359-365` — where `MIN_FREE_BYTES`
  gates staging (`freeBytes()` via `df -kP`, lines 97-107).
- `packages/cezar/src/server-install/releases.ts:36,80` — `DEFAULT_KEEP = 5` and its
  schema default; retention/prune logic in `prunable()` (lines 186-200) — relevant
  context for re-checking the ~15G-of-releases math, not itself expected to change.
- `packages/cezar/src/git-worktree.ts:18` — `WORKTREES_DIR` constant, confirms the path
  string to exclude.
- `packages/cezar/src/runs/agent-tmpdir.ts:45-47` — confirms `.ai/cezar/tmp/<runId>`
  layout for the tmp exclude.
- Tests: `packages/cezar/src/server-install/release-deploy.test.ts` has a fake `stage()`
  recorder (line ~42-44) and a disk-full test (~line 172-178), but **no test currently
  asserts on the real rsync `--exclude` argv** — a spec should decide whether to add one
  (e.g. asserting the exact args array passed to `run('rsync', [...])`) vs. an
  integration-style test that runs real rsync against a fixture tree containing
  `.ai/cezar/worktrees` and `.ai/cezar/tmp` and asserts they're absent from the staged
  output. `releases.test.ts` and `release-cli.test.ts` are adjacent but don't cover
  this.

## Duplicate/in-flight work check

None. `cezar todo list` has exactly one matching item (this task's own todo,
`c11ff282-8609-4bf6-9d0b-08911b938c81`). The only disk-cleanup-adjacent todo,
`4929b86c` ("Clean up the reopen sweep's litter: 107 worktrees / 117 branches /
7.8 GB"), is about sweeping stale worktrees/branches off disk generally — a different
problem from this rsync-exclude bug. Checked all 10 other task worktrees under
`.ai/cezar/worktrees/`: none touch `release-deploy.ts` or rsync/stage logic (all clean
except one with an unrelated untracked spec file). `git log --all` on
`release-deploy.ts` shows only 3 commits total, all merged to `main`, none touching the
exclude list or `.ai/cezar/worktrees`. No branch name suggests this work is already in
flight elsewhere.

## Open questions a spec will have to settle

1. **Exact new exclude entries.** `.ai/cezar/worktrees` is the confirmed must-exclude.
   `.ai/cezar/tmp` looks safe to exclude by the same logic (analogous to
   `.ai/cezar/runs`, already excluded) but the task's acceptance criteria only ask to
   "review" it — the spec should state the decision and why, not just do it silently.
2. **rsync exclude-pattern anchoring.** The existing patterns (`.git`,
   `.ai/cezar/runs`) contain no leading slash but do contain path separators, which
   rsync anchors to the transfer root when a pattern contains `/`. Worth a one-line
   sanity check in the spec/verification that `.ai/cezar/worktrees` and `.ai/cezar/tmp`
   as written exclude correctly and don't accidentally match nested paths of the same
   name elsewhere in the tree (unlikely, but cheap to state explicitly since this is a
   deploy-path change).
3. **Test coverage gap.** Decide whether to test the real rsync argv, a fixture-based
   integration test, or both — current tests only fake `stage()` and never invoke real
   rsync excludes.
4. **MIN_FREE_BYTES / the "~500 MB" comment.** Task explicitly requires re-checking
   this against the *measured* post-fix size, not just trusting the old assumption —
   the spec's verification section needs a real `du -sh` measurement step on a freshly
   staged release, not a computed estimate.
5. **Whether `keep:5` / `DEFAULT_KEEP` should also change** given the corrected release
   size — likely out of scope (task only asks to re-check `MIN_FREE_BYTES`/the comment,
   not retention count), but worth a one-line note in the spec on why it's left alone
   (or isn't).
6. **Not found / could not verify:** no KB entry or spec explicitly discusses this exact
   bug before now; no rationale exists anywhere for the exclude list stopping at two
   entries (reads as oversight, not a decision) — stated here rather than assumed.

## Facts that most constrain the design

- Fix site is exactly `release-deploy.ts:136-144` — two `--exclude` args to add, one
  function, single call site (`stage()`), invoked from `runReleaseDeploy` at line ~376.
- `MIN_FREE_BYTES` (2 GiB, line 53) and its "~500 MB" comment must be re-verified
  against a real measured release size after the fix — this is an explicit acceptance
  criterion, not optional.
- No prior decision conflicts with adding these excludes; the existing design comment
  ("a release is an artifact, not a checkout") already argues for it, and a sibling
  spec's sizing math (490 MB × keep:5) already assumes it.
- Current tests never assert on real rsync exclude args — the spec needs to add
  coverage, not just trust manual verification.
